"""Install the latest Reflex into Pyodide with no server (run via runPythonAsync).

Installs the reflex packages with deps=False because reflex hard-requires
`granian` (a Rust ASGI server with no wasm wheel); micropip can't resolve that
tree, and it has no "install all but one" flag, so we skip resolution entirely
and hand-install the pure-Python runtime deps ourselves (_LEAF). Reflex's
pydantic>=2.12 pin is satisfied natively now: Pyodide 0.29.4 ships pydantic
2.12.5 / pydantic_core 2.41.5 as prebuilt wheels (loaded from JS beforehand,
alongside ssl/sqlite3/...), so no version pinning is needed. Also stubs `granian`
— reflex_base's deprecation logger does `import granian` for frame inspection,
even though the package is never installed.

Each micropip.install gets a *list*, so all wheels in that batch download
concurrently instead of one serial await per package.
"""

import sys
import types

import micropip

# reflex_base's console deprecation helper does `import granian` to locate
# framework frames; without this stub any deprecation-warning path hard-crashes.
if "granian" not in sys.modules:
    _g = types.ModuleType("granian")
    _g.__file__ = "/granian_stub/__init__.py"
    sys.modules["granian"] = _g

# reflex + its split packages: install WITHOUT deps so micropip never tries to
# resolve `granian` (Rust ASGI server, no wasm wheel). The real pure-Python deps
# are installed via _LEAF below.
_NODEPS = [
    "reflex", "reflex-base",
    "reflex-components-code", "reflex-components-core", "reflex-components-dataeditor",
    "reflex-components-gridjs", "reflex-components-lucide", "reflex-components-markdown",
    "reflex-components-moment", "reflex-components-plotly", "reflex-components-radix",
    "reflex-components-react-player", "reflex-components-recharts", "reflex-components-sonner",
    "reflex-hosting-cli",
]

# Pure-Python leaf deps (granian + win32-only psutil excluded; both unused here).
_LEAF = [
    "click", "httpx", "packaging", "platformdirs", "python-multipart",
    "python-socketio", "redis", "starlette", "alembic", "sqlmodel==0.0.24",
    "lazy-loader", "python-engineio",
    # anyio: rx.App imports starlette, which needs anyio. Required by the parity
    # compile path (full app compile), though not by bare state/event processing.
    "anyio",
]

# Batched installs: passing a list lets micropip download every wheel in the
# batch concurrently. The two batches differ only by deps= (reflex skips
# resolution, leaves resolve their own pure-Python deps).
_fails = []
try:
    await micropip.install(_NODEPS, deps=False)
except Exception as _e:  # noqa: BLE001
    _fails.append(["reflex-packages", str(_e)[:200]])
try:
    await micropip.install(_LEAF, deps=True)
except Exception as _e:  # noqa: BLE001
    _fails.append(["leaf-deps", str(_e)[:200]])

import reflex as rx  # noqa: E402,F401  (warm the import; surfaces failures now)
from importlib.metadata import version  # noqa: E402

import json  # noqa: E402
json.dumps({"reflex": version("reflex"), "fails": _fails})
