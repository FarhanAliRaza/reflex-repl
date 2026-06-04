# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this actually is

Despite the directory name (`django-repl`) and the `README.md` ("Django Playground"), the
current application is a **Reflex Playground**: it runs the real [Reflex](https://reflex.dev)
Python framework entirely in the browser via Pyodide (Python in WebAssembly), with **no
server**. The README is stale/aspirational — trust the code, not the README, and don't add
Django anything.

The headline trick: a user's Reflex app is compiled to its *real* React frontend inside
Pyodide, and UI events are driven through Reflex's *real* event pipeline. The state delta a
websocket would normally carry instead crosses `postMessage`. There is no mock — it's the
genuine Reflex runtime with the socket swapped out.

## Commands

Package manager is **pnpm**.

```bash
pnpm install
pnpm dev                 # vite dev server on :5173
pnpm build               # production build
pnpm preview             # preview build on :4173 (what e2e tests hit)
pnpm check               # svelte-check (type checking)
pnpm lint                # prettier --check + eslint
pnpm format              # prettier --write
pnpm test:unit           # vitest (add `-- --run` for one-shot; omit for watch)
pnpm test:e2e            # playwright (SLOW — see below)
pnpm test                # e2e then unit
```

Run a single test:
```bash
pnpm exec playwright test e2e/reflex.spec.ts -g "counter buttons"   # one e2e test by name
pnpm test:unit -- src/routes/page.svelte.spec.ts --run               # one unit file
```

**E2E is expensive and serial by design.** The first run boots Pyodide and installs Reflex +
~20 dependency wheels via micropip *inside the worker* — minutes of work. `playwright.config.ts`
sets `workers: 1`, `fullyParallel: false`, and a 300s timeout so the whole suite pays that cost
**once**: `reflex.spec.ts` warms up in `beforeAll` and every test reuses the same warmed page.
Don't parallelize it or split the warm-up.

## Architecture

SvelteKit 2 + Svelte 5 (runes), Tailwind v4, CodeMirror 6 editor, shadcn-style UI
(`paneforge` resizable panes, `bits-ui` button). Single route. All logic is client-side.

### Layout — one route, three panes
`src/routes/+page.svelte` is the whole app: `FileTree | Editor` on the left, `Output` (iframe +
console) on the right. It owns the worker and brokers all messages between the worker and the
`Output` iframe.

### The execution path (the important part)
1. **Worker** (`src/lib/workers/reflex/reflex-worker.ts`) — thin TS shim over Pyodide. Handles
   `init` / `run` / `event` messages. Keeps logic in Python so it stays headless-testable.
2. **`boot.py`** — installs Reflex into Pyodide. Read its docstring before touching deps: it
   installs reflex with `deps=False` to dodge the `pydantic>=2.12` pin (no wasm wheel exists for
   the `pydantic-core` that pin demands), forces `pydantic==2.10.6` / `pydantic-core==2.27.2`,
   and stubs the `granian` Rust server binary (imported by a deprecation logger). Changing the
   package lists here is the #1 way to break cold boot.
3. **`bridge.py`** — runs inside Pyodide. **Two paths live here:**
   - **FULL-PARITY PATH (live):** `compile_app()` + `dispatch_event()`. This is what the worker
     calls. `compile_app` monkeypatches Reflex's compiler for Pyodide (no threads/bun/npm via
     `_patch_compile_for_pyodide`), wipes `.web` (Reflex never prunes stale content-hashed
     component modules), compiles the app, and returns a bundle of compiled `.web` modules +
     Reflex's shipped client runtime. `dispatch_event` runs an event through the real pipeline
     and returns a serialized `StateUpdate` delta.
   - **Simple HTML-render path (legacy):** `run_app()` / `run_event()` / `ReflexApp` / `_render`.
     **Not wired into the worker** — it renders `rx.el` to plain HTML and exists for the headless
     harnesses. If you're fixing what the app actually shows, edit the parity path, not this one.
4. **`client.ts`** (`buildParitySrcdoc`) — assembles the sandboxed-iframe document with **no
   bundler**: npm deps load from `esm.sh`, compiled `$/...` modules are served as data-URL ES
   modules via an import map, and `socket.io-client` is replaced by `SOCKET_SHIM` that bridges
   Reflex's socket to `postMessage`. React/react-dom/emotion are pinned and forced to a *single*
   instance via the import map + `?external` — a second React copy breaks hooks/context.
5. **`Output.svelte`** — renders the iframe from a **Blob URL, not `srcdoc`** (import maps are
   flaky inside `srcdoc`). Relays events both ways.

### Event round-trip
iframe Reflex runtime emits → `SOCKET_SHIM` posts `rx-emit` to parent → `Output.svelte` →
`+page.svelte` `onEvent` → worker `event` → `dispatch_event` (real Python handler) → `StateUpdate`
delta → back to `+page.svelte` `update` → `Output.applyUpdate` posts `rx-recv` into iframe →
Reflex's `state.js` applies the delta → React re-renders.

### User app conventions
- Entry file is `app.py`; it must define `index()` (or `page()`) returning a component.
- Re-running is made idempotent by purging the previous run's user modules (`reset_previous` →
  `reload_state_module`), because Reflex registers `rx.State` subclasses globally by module and a
  second import would raise "defined multiple times".
- The default multi-file starter project lives in `defaultReflexProject` in
  `src/lib/stores/workspace.svelte.ts`.

### State (Svelte 5 runes, singleton classes in `src/lib/stores/`)
- `workspaceState` — files map + derived file tree, the source of truth for editor content.
- `executionState` — `ReplState` machine (INITIALIZING → IDLE → RUNNING → READY).
- `shareState` — gzip + base64url project encoding into the URL hash (`utils/share.ts`). **Shared
  projects (URL has a hash) do NOT auto-run** — arbitrary code requires an explicit Run click;
  only fresh projects auto-run on worker-ready.

## Conventions & gotchas

- Import alias is **`$lib/*`** (SvelteKit default). A `@/*` → `./src/lib/*` alias also exists in
  `svelte.config.js` but `$lib` is what the codebase uses.
- `.py` files are imported into TS as raw strings via `?raw` (see `src/reflex-raw.d.ts`).
- Reflex client version is pinned to `0.9.4` in `client.ts`'s `$/reflex.json`; the *installed*
  reflex is whatever `boot.py` resolves. Keep these compatible if you bump either.
- `ignore/` is gitignored scratch space and contains (a) a full clone of the Reflex source at
  `ignore/reflex/` for reference and (b) standalone `.mjs` headless harnesses that exercise the
  Python bridge directly (e.g. `test_parity_bridge.mjs`, `test_multifile.mjs`) — code comments in
  `bridge.py` point at these. Use them to debug bridge logic without a browser.
- A Svelte MCP server is configured in `.mcp.json` (`@sveltejs/mcp`); prefer it for Svelte
  documentation and component validation.
