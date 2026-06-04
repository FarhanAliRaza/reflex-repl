# Reflex Playground

**Run [Reflex](https://reflex.dev) apps entirely in your browser — no server, no install.**

Reflex Playground is a browser-based IDE that runs the real Reflex framework inside
Pyodide (Python compiled to WebAssembly). Write a Reflex app, hit **Run**, and it
renders live in a sandboxed iframe. Button clicks, inputs, and state updates round-trip
through Reflex's actual event pipeline — there's no backend anywhere.

## How is this possible?

Reflex normally splits into a Python backend (state + events, served over a websocket)
and a compiled React frontend. Reflex Playground runs **both halves in the browser**:

- **The Python backend runs in a Web Worker** via Pyodide. Reflex's event handlers,
  state machine, and delta computation execute exactly as they would on a server —
  the websocket transport is just swapped for `postMessage`.
- **The frontend is Reflex's own compiled React output.** When you click Run, Reflex's
  compiler runs in Pyodide and emits the real `.web/` React bundle (Radix components,
  `rx.cond`/`rx.foreach`, charts, and the rest). It's served to the iframe through an
  import map — npm dependencies (`react`, `@radix-ui/themes`, `@emotion/react`) resolve
  from [esm.sh](https://esm.sh), and Reflex's runtime modules load as data/blob URLs.
- **`socket.io-client` is replaced by a `postMessage` shim.** Reflex's unmodified
  client `state.js` thinks it's talking to a server; really, events flow to the worker,
  Reflex computes the state delta, and the delta flows back to patch the React tree.

The upshot: this isn't a partial reimplementation of Reflex's UI. It runs the genuine
framework, so most Reflex apps render the same as they would in production.

## Features

- **Real Reflex** — the actual framework running server-less in WebAssembly
- **Full Radix component library** — `rx.button`, `rx.card`, `rx.vstack`, charts, etc.
- **Live state & events** — `on_click`, `on_change`, `on_input`, … round-trip through Reflex's real event loop
- **Multi-file projects** — split your app across files with inter-file imports
- **Hot reload** — Refresh re-runs your code and resets state cleanly
- **CodeMirror editor** — Python syntax highlighting, autocomplete, search
- **File tree + console + resizable panes** — a familiar IDE shell
- **Shareable** — encode a whole project into a URL to share
- **Zero backend** — everything runs client-side

## Quick start

```bash
pnpm install
pnpm dev
# open http://localhost:5173
```

> **First load takes a moment.** The worker boots Pyodide and installs Reflex and its
> dependencies from PyPI on first run. After that it's fast.

## Commands

```bash
pnpm dev          # Development server
pnpm build        # Production build
pnpm preview      # Preview the production build
pnpm check        # Type-check with svelte-check
pnpm lint         # Prettier + ESLint checks
pnpm format       # Auto-format with Prettier
pnpm test         # Run e2e + unit tests
pnpm test:e2e     # Playwright end-to-end tests
pnpm test:unit    # Vitest unit tests
```

## Tech stack

- **SvelteKit 2 / Svelte 5** — UI shell, built with runes
- **Pyodide 0.29** — Python 3.13 in WebAssembly (runs Reflex's backend + compiler)
- **Reflex** — installed at runtime via micropip
- **React 19 + Radix Themes** — Reflex's compiled frontend, loaded from esm.sh
- **CodeMirror 6** — the code editor
- **Tailwind CSS v4** — styling
- **Web Worker** — isolates Python execution from the UI thread

## How it works (request lifecycle)

1. **Edit** — write a Reflex app across one or more files in the editor.
2. **Run** — files are sent to the Web Worker.
3. **Compile** — Pyodide imports your app and runs Reflex's compiler, producing the
   real `.web/` React bundle plus Reflex's client runtime.
4. **Render** — the bundle loads in a sandboxed iframe via an import map (esm.sh for
   npm packages, data/blob URLs for Reflex modules); React mounts the page.
5. **Interact** — UI events are forwarded over `postMessage` to the worker, where
   Reflex's event loop runs the handler and computes a state delta.
6. **Update** — the delta flows back to the iframe, where Reflex's `state.js` applies
   it and React re-renders.

## Supported subset

Most Reflex apps work, including the full Radix component library, multi-file projects,
inter-file imports, computed vars, and standard event handlers. Some build-time-only
features (those that require a Node/Vite toolchain at runtime) are not available. This
is an experimental project — expect rough edges on advanced or unusual apps.

## Project structure

```
src/
├── routes/                    # SvelteKit pages (the IDE itself)
└── lib/
    ├── components/            # Editor, FileTree, Output, Console, UI
    ├── stores/               # workspace / execution / share state (runes)
    ├── workers/reflex/
    │   ├── reflex-worker.ts   # Web Worker: boots Pyodide, compiles, dispatches events
    │   ├── boot.py            # Pyodide + Reflex install recipe
    │   ├── bridge.py          # compile_app() + dispatch_event() — the Python ↔ JS bridge
    │   └── client.ts          # builds the iframe (import map + postMessage shim)
    └── types/                # TypeScript types
```

## License

MIT

---

Made with ❤️ by [Farhan Ali Raza](https://github.com/FarhanAliRaza)
