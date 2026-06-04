"""Reflex render bridge — runs inside Pyodide, no server.

Compiles the user's app to its real React frontend (the full Radix component
library, cond/foreach, charts) and arms an event backend. Events are driven
through Reflex's real event pipeline; the resulting delta is what a websocket
would carry — here it crosses postMessage instead.
"""

import importlib
import json
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
_state_manager = None  # set by compile_app; used to build the event EventContext


def _patch_compile_for_pyodide():
    """Make Reflex's compiler run under Pyodide (no threads, no bun/npm)."""
    from reflex.compiler import utils as cu
    from reflex.utils import js_runtimes
    from reflex_base.config import get_config

    # compile_state bakes the initial (pre-hydrate) state into the frontend; it
    # resolves async @rx.vars by offloading _resolve_delta to a thread (because
    # _compile is sync but runs under a live loop). Pyodide has no threads. Set a
    # sync fallback that skips resolution; compile_app overrides this with the
    # async-resolved values just before compiling (see _resolve_initial_state).
    cu.compile_state = lambda state: cu._sorted_keys(
        state(_reflex_internal_init=True).dict(initial=True)
    )
    js_runtimes.install_frontend_packages = lambda *a, **k: None  # esm.sh at runtime
    rx.App._get_frontend_packages = lambda self, *a, **k: None
    get_config().telemetry_enabled = False


async def _resolve_initial_state(state) -> None:
    """Bake async-resolved initial vars into the compiler (Pyodide has no threads).

    Reflex's `compile_state` would resolve `async @rx.var`s by running
    `_resolve_delta` in a worker thread. We're already in an event loop here, so
    resolve it directly and hand `compile_state` the finished dict — otherwise an
    async var's baked initial value is null until the first hydration delta.
    Must run after the state tree is built (user modules imported) and before
    `app._compile()`.
    """
    from reflex.compiler import utils as cu
    from reflex.state import _resolve_delta

    initial = state(_reflex_internal_init=True).dict(initial=True)
    resolved = cu._sorted_keys(await _resolve_delta(initial))
    cu.compile_state = lambda _state: resolved


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
    global _root, _subs, _hydrated, _root_full_name, _state_manager
    import traceback

    from reflex_base.registry import RegistrationContext
    from reflex.istate.manager import StateManager
    from reflex.istate.manager.token import BaseStateToken
    from reflex.state import OnLoadInternalState

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
        # on_load: the REPL builds add_page itself, so a user's page-load handler
        # is picked up from a module-level `on_load = State.handler` (or list).
        # Without this, app.get_load_events("/") is empty and on_load never fires.
        on_load = getattr(module, "on_load", None)

        # Wipe .web before compiling: Reflex writes per-component files under
        # content-hashed names and never prunes old ones, so editing/re-running
        # leaves stale component modules that reference removed states. Bundling
        # those breaks the iframe (useContext on an undefined StateContexts key).
        import shutil

        from reflex.utils import prerequisites

        shutil.rmtree(str(prerequisites.get_web_dir()), ignore_errors=True)

        app = rx.App()
        app.add_page(page, route="/", on_load=on_load)
        # Resolve async @rx.vars for the baked initial state before compiling
        # (no threads under Pyodide; we're already in a loop here).
        await _resolve_initial_state(rx.State)
        app._compile(use_rich=False)
        # on_load_internal resolves the route's load handlers via this app ref;
        # without it the handler falls back to loading the app from disk (no app
        # on disk under Pyodide) and raises.
        OnLoadInternalState._app_ref = app

        sm = StateManager.create()
        _state_manager = sm
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


def _serialize_events(events) -> list:
    """Serialize Reflex Event objects into the {name, payload} dicts state.js wants.

    Frontend events (name starts with "_": _redirect, _call_function/toast,
    _download, _set_focus, …) are applied client-side; backend events (chained
    handlers) are re-emitted by state.js back to us — the socket-shim round-trip.
    """
    return [
        {"name": e.name, "payload": e.payload, "router_data": e.router_data}
        for e in events
    ]


async def dispatch_event(msg, emit=None) -> dict:
    """Run a Reflex Event dict through Reflex's REAL event pipeline.

    Each delta/event the genuine pipeline produces is a StateUpdate
    `{delta, events, final}` — exactly what state.js applies. Where the old
    bridge dropped returned events and only sent the final delta, this drives
    `process_event` so the full pipeline is honored:

    - **Returned / yielded events** (`rx.redirect`, `rx.toast`, `rx.download`,
      `rx.call_script`, `rx.set_clipboard/_focus`, and event *chaining*) flow
      out via `events`; chained backend events round-trip through state.js.
    - **Streaming**: each generator `yield` emits its own delta update, streamed
      via `emit` as it happens (instead of collapsing to the final state).
    - **on_load**: the internal `on_load_internal` handler is allowed to run and
      enqueue the route's load handlers.

    `emit` is a callback the worker supplies (posts each update to the page). It
    is called with a JSON string per update. When omitted (headless harnesses)
    updates are only collected. Returns a small status `{final, n}`.
    """
    collected: list = []

    def _push(update: dict) -> None:
        # Drop no-op updates so streaming doesn't spam empty frames.
        if not update.get("delta") and not update.get("events") and not update.get("error"):
            return
        collected.append(update)
        if emit is not None:
            emit(json.dumps(update, default=str))

    if _root is None:
        _push({"delta": {}, "events": [], "final": True, "error": "no app"})
        return {"final": True, "n": len(collected)}

    from reflex.istate.data import RouterData
    from reflex.state import _resolve_delta
    from reflex_base.event.context import EventContext
    from reflex_base.event.processor.base_state_processor import process_event

    name = msg.get("name", "") if isinstance(msg, dict) else ""
    payload = msg.get("payload") or {}
    router_data = (msg.get("router_data") or {}) if isinstance(msg, dict) else {}
    sfn, _, fn = name.rpartition(".")
    cls = _subs.get(sfn)

    # Apply router_data so handlers reading self.router resolve correctly — and
    # so on_load_internal can look up the current route's on_load handlers.
    if router_data and _root.router_data != router_data:
        _root.router_data = router_data
        _root.router = RouterData.from_router_data(router_data)

    # An EventContext whose emit hooks stream each update as the real pipeline
    # produces it. emit_delta → state delta; emit_event → frontend events;
    # enqueue → chained backend events (forwarded for state.js to re-emit).
    async def _emit_delta(token, delta):
        _push({"delta": dict(delta), "events": [], "final": False})

    async def _emit_event(token, *events):
        _push({"delta": {}, "events": _serialize_events(events), "final": False})

    async def _enqueue(token, *events):
        _push({"delta": {}, "events": _serialize_events(events), "final": False})

    ctx = EventContext(
        token="repl",
        state_manager=_state_manager,
        enqueue_impl=_enqueue,
        emit_delta_impl=_emit_delta,
        emit_event_impl=_emit_event,
    )
    ctx_token = EventContext.set(ctx)
    try:
        # First dispatch hydrates: the client needs the FULL initial state (a
        # delta carries only dirty vars), so send the whole tree + is_hydrated.
        # The first event is the client's `hydrate`; its own handler only sets
        # is_hydrated / client storage (unsupported here), so we skip running it.
        if not _hydrated["v"]:
            _hydrated["v"] = True
            full = await _resolve_delta(_root.dict())
            if _root_full_name in full:
                full[_root_full_name]["is_hydrated_rx_state_"] = True
            _root._clean()
            _push({"delta": full, "events": [], "final": True})
            return {"final": True, "n": len(collected)}

        # Run the handler through the real pipeline. on_load_internal is internal
        # but must run for page-load handlers to fire; other internal handlers
        # (hydrate, client-storage sync) are intentionally left out.
        if cls is not None and fn and (fn == "on_load_internal" or "internal" not in fn):
            handler = cls.event_handlers.get(fn)
            if handler is not None:
                sub = await _root.get_state(cls)
                await process_event(
                    handler=handler, payload=payload, state=sub, root_state=_root
                )
    finally:
        EventContext.reset(ctx_token)

    return {"final": True, "n": len(collected)}
