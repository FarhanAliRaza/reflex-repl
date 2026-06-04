"""Reflex render bridge — runs inside Pyodide, no server.

Compiles the user's app to its real React frontend (the full Radix component
library, cond/foreach, charts) and arms an event backend. Events are driven
through Reflex's real event pipeline; the resulting delta is what a websocket
would carry — here it crosses postMessage instead.
"""

import importlib
import os
import re
import sys

import reflex as rx
from reflex.state import reload_state_module

# Where user files live and what we treat as "the current app". The worker sets
# globals and calls compile_app; keeping the logic in Python keeps the .ts file
# a thin shim and lets the bridge be exercised headless (see ignore/*.mjs).
_APP_DIR = "/app"

# Module names imported from /app on the previous run. Reflex registers State
# subclasses globally by module, so re-importing a user module that defines
# `class X(rx.State)` raises "defined multiple times" on the 2nd run. We purge
# these before each run to make Run/Refresh idempotent.
_user_modules: set[str] = set()


def _write_files(files: dict) -> None:
    """Write each user file under /app, creating parent directories."""
    for path, content in files.items():
        full = os.path.join(_APP_DIR, path)
        os.makedirs(os.path.dirname(full) or _APP_DIR, exist_ok=True)
        with open(full, "w") as fh:
            fh.write(content)


def _ensure_on_path() -> None:
    """Put /app first on sys.path so user files (and imports between them) resolve."""
    if _APP_DIR not in sys.path:
        sys.path.insert(0, _APP_DIR)


def reset_previous() -> None:
    """Purge the previous run's user modules so re-running is collision-free.

    For each user module tracked from the last run, drop its rx.State subclasses
    from Reflex's global registry (reload_state_module) and remove it from
    sys.modules so the next import re-executes the (possibly edited) source.
    """
    global _user_modules
    for name in _user_modules:
        reload_state_module(module=name)
        sys.modules.pop(name, None)
    _user_modules = set()


def _track_user_modules() -> None:
    """Record the set of modules currently loaded from /app, for the next reset."""
    global _user_modules
    _user_modules = {
        name
        for name, mod in list(sys.modules.items())
        if getattr(mod, "__file__", "") and str(mod.__file__).startswith(_APP_DIR + "/")
    }


# ───────────────────────── FULL-PARITY PATH ──────────────────────────────
# Compile the user's app to its REAL React frontend (Radix components,
# cond/foreach, charts) and serve the modules to an iframe that runs Reflex's
# actual client runtime. Events run through Reflex's real event pipeline; deltas
# (StateUpdate) cross postMessage instead of a socket.

_RUNTIME_FILES = [
    "utils/state.js", "utils/react-theme.js",
    "utils/helpers/debounce.js", "utils/helpers/throttle.js",
    "utils/helpers/upload.js", "utils/helpers/range.js", "utils/helpers/paste.js",
]

# Live state tree + hydration flag for the parity event backend.
_root = None
_subs: dict = {}
_hydrated = {"v": False}
_root_full_name = ""


def _patch_compile_for_pyodide():
    """Make Reflex's compiler run under Pyodide (no threads, no bun/npm)."""
    from reflex.compiler import utils as cu
    from reflex.utils import js_runtimes
    from reflex_base.config import get_config

    # compile_state bridges async _resolve_delta via a thread when a loop is
    # running (always, under runPythonAsync); Pyodide has no threads. Resolve
    # synchronously (matters only for async computed vars, which are rare).
    cu.compile_state = lambda state: cu._sorted_keys(
        state(_reflex_internal_init=True).dict(initial=True)
    )
    js_runtimes.install_frontend_packages = lambda *a, **k: None  # esm.sh at runtime
    rx.App._get_frontend_packages = lambda self, *a, **k: None
    get_config().telemetry_enabled = False


def _read_web_and_runtime() -> dict:
    """Collect the compiled .web frontend + Reflex's shipped client runtime."""
    import reflex_base
    from reflex.utils import prerequisites

    web = str(prerequisites.get_web_dir())
    files = {}
    for root, _dirs, fs in os.walk(web):
        if "node_modules" in root:
            continue
        for f in fs:
            rel = os.path.relpath(os.path.join(root, f), web)
            if rel.endswith((".jsx", ".js", ".css")) and not rel.endswith(
                ("vite.config.js", "react-router.config.js")
            ):
                with open(os.path.join(root, f), encoding="utf-8") as fh:
                    files[rel] = fh.read()

    tpl = os.path.join(os.path.dirname(reflex_base.__file__), ".templates", "web")
    runtime = {}
    for rel in _RUNTIME_FILES:
        p = os.path.join(tpl, rel)
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as fh:
                runtime[rel] = fh.read()

    npm = set()
    for txt in list(files.values()) + list(runtime.values()):
        for lib in re.findall(r'from\s*"([^"]+)"', txt):
            if not lib.startswith(("$/", ".")):
                npm.add(lib)
    index_route = next(
        (k for k in files if k.startswith("app/routes/") and "index" in k.lower() and "404" not in k),
        None,
    )
    return {"files": files, "runtime": runtime, "npm_libs": sorted(npm), "index_route": index_route}


async def compile_app(files: dict, entry: str = "app.py") -> dict:
    """Compile the user's app to its real React frontend + arm the event backend.

    Returns the module bundle the iframe needs, or {"error": traceback}.
    """
    global _root, _subs, _hydrated, _root_full_name
    import traceback

    from reflex_base.registry import RegistrationContext
    from reflex.istate.manager import StateManager
    from reflex.istate.manager.token import BaseStateToken

    try:
        # ensure_context FIRST: reset_previous → reload_state_module reads the
        # RegistrationContext, which isn't set on a fresh runPythonAsync task.
        RegistrationContext.ensure_context()
        reset_previous()
        _patch_compile_for_pyodide()

        _write_files(files)
        _ensure_on_path()
        importlib.invalidate_caches()
        entry_mod = entry[:-3].replace("/", ".") if entry.endswith(".py") else entry.replace("/", ".")
        module = importlib.import_module(entry_mod)
        _track_user_modules()

        page = getattr(module, "index", None) or getattr(module, "page", None)
        if page is None:
            return {"error": "Define an index() function that returns a component."}

        # Wipe .web before compiling: Reflex writes per-component files under
        # content-hashed names and never prunes old ones, so editing/re-running
        # leaves stale component modules that reference removed states. Bundling
        # those breaks the iframe (useContext on an undefined StateContexts key).
        import shutil

        from reflex.utils import prerequisites

        shutil.rmtree(str(prerequisites.get_web_dir()), ignore_errors=True)

        app = rx.App()
        app.add_page(page, route="/")
        app._compile(use_rich=False)

        sm = StateManager.create()
        token = BaseStateToken(ident="repl", cls=rx.State)
        _root = await sm.get_state(token)
        _root_full_name = rx.State.get_full_name()
        _subs = {}

        def _walk(c):
            try:
                _subs[c.get_full_name()] = c
            except Exception:
                pass
            for x in c.get_substates():
                _walk(x)

        _walk(rx.State)
        _hydrated = {"v": False}
        return _read_web_and_runtime()
    except Exception:
        return {"error": traceback.format_exc()[-2500:]}


async def dispatch_event(msg) -> dict:
    """Process a Reflex Event dict from the client → a serialized StateUpdate.

    First call hydrates (full state + is_hydrated=true); later calls return the
    changed delta. Keyed by dotted substate names — exactly what state.js applies.
    """
    if _root is None:
        return {"delta": {}, "events": [], "final": True, "error": "no app"}
    from reflex.state import _resolve_delta

    name = msg.get("name", "") if isinstance(msg, dict) else ""
    sfn, _, fn = name.rpartition(".")
    cls = _subs.get(sfn)
    if cls is not None and fn and "internal" not in fn and not fn.startswith("on_load"):
        sub = await _root.get_state(cls)
        handler = getattr(sub, fn, None)
        if handler is not None:
            payload = msg.get("payload") or {}
            result = handler(**payload) if isinstance(payload, dict) and payload else handler()
            if hasattr(result, "__await__"):
                await result
            elif hasattr(result, "__anext__"):
                async for _ in result:
                    pass
            elif hasattr(result, "__next__"):
                for _ in result:
                    pass

    if not _hydrated["v"]:
        _hydrated["v"] = True
        full = await _resolve_delta(_root.dict())
        if _root_full_name in full:
            full[_root_full_name]["is_hydrated_rx_state_"] = True
        _root._clean()
        return {"delta": full, "events": [], "final": True}

    delta = await _root._get_resolved_delta()
    _root._clean()
    return {"delta": delta, "events": [], "final": True}
