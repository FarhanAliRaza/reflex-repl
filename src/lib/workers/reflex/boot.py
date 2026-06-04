"""Install the latest Reflex into Pyodide with no server (run via runPythonAsync).

Forces Pyodide's prebuilt pydantic 2.10.6 / pydantic_core 2.27.2 (Reflex's
>=2.12 pin is conservative and it runs fine on these), installs the reflex
packages with deps=False to skip that pin, and stubs `granian` (a Rust server
binary that won't run here, and which reflex_base's deprecation logger imports).
Binary prebuilts (pydantic*, ssl, sqlite3, ...) are loaded from JS beforehand.
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

_CONSTRAINTS = ["pydantic==2.10.6", "pydantic-core==2.27.2"]

# reflex + its split packages: install WITHOUT deps so the pydantic>=2.12 pin is
# never resolved (it would demand pydantic-core 2.46.4, which has no wasm wheel).
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

_fails = []
for _spec in _NODEPS:
    try:
        await micropip.install(_spec, deps=False)
    except Exception as _e:  # noqa: BLE001
        _fails.append([_spec, str(_e)[:160]])
for _spec in _LEAF:
    try:
        await micropip.install(_spec, deps=True, constraints=_CONSTRAINTS)
    except Exception as _e:  # noqa: BLE001
        _fails.append([_spec, str(_e)[:160]])

import reflex as rx  # noqa: E402,F401  (warm the import; surfaces failures now)
from importlib.metadata import version  # noqa: E402

import json  # noqa: E402
json.dumps({"reflex": version("reflex"), "fails": _fails})
