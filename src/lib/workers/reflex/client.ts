/**
 * Builds the sandboxed-iframe document that runs a Reflex app's REAL compiled
 * React frontend (full Radix component library, cond/foreach, charts) with no
 * bundler. npm deps load from esm.sh; the compiled `$/...` modules are served as
 * data-URL ES modules; Reflex's own client runtime (`state.js`) runs unmodified,
 * with `socket.io-client` swapped for a postMessage bridge to the worker.
 */

export interface ReflexBundle {
	files: Record<string, string>; // compiled .web modules (jsx/js/css)
	runtime: Record<string, string>; // shipped reflex client runtime (utils/state.js, helpers, …)
	npm_libs: string[];
	index_route: string; // e.g. "app/routes/_index.jsx"
}

// Pinned versions for the packages where the compiled output is version-sensitive.
const PIN: Record<string, string> = {
	react: '19.0.0',
	'react-dom': '19.0.0',
	'@emotion/react': '11',
	'@radix-ui/themes': '3.3.0',
	'react-router': '7',
	'universal-cookie': '7',
	json5: '2'
};

const dataMod = (src: string) => 'data:text/javascript,' + encodeURIComponent(src);

// Map a bare specifier (possibly with a subpath) to an esm.sh URL, forcing a
// single React/emotion instance via ?external so hooks and context work.
function esmUrl(spec: string): string {
	const m = spec.match(/^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/);
	const pkg = m ? m[1] : spec;
	const sub = m && m[2] ? m[2] : '';
	const ver = PIN[pkg] ? `@${PIN[pkg]}` : '';
	let q = '';
	if (pkg === '@emotion/react') q = '?external=react';
	else if (pkg !== 'react' && pkg !== 'react-dom') q = '?external=react,react-dom,@emotion/react';
	return `https://esm.sh/${pkg}${ver}${sub}${q}`;
}

// socket.io-client replacement: bridge Reflex's socket to the worker via the
// parent window. emit("event", ev) → parent; {type:'rx-recv', update} → "event".
const SOCKET_SHIM = String.raw`
export default function io(url, opts) {
  const handlers = {};
  const fire = (n, ...a) => (handlers[n] || []).forEach((cb) => { try { cb(...a); } catch (e) { console.error(e); } });
  const sock = {
    connected: false,
    io: { engine: {}, encoder: {}, decoder: {}, opts: { query: (opts && opts.query) || {} } },
    on(n, cb) { (handlers[n] = handlers[n] || []).push(cb); return sock; },
    off(n) { delete handlers[n]; return sock; },
    emit(n, payload) {
      if (n !== "event") return sock;
      const replacer = sock.io.encoder.replacer || ((k, v) => v);
      parent.postMessage({ type: "rx-emit", event: JSON.parse(JSON.stringify(payload, replacer)) }, "*");
      return sock;
    },
    connect() { if (!sock.connected) { sock.connected = true; setTimeout(() => fire("connect"), 0); } return sock; },
    disconnect() { sock.connected = false; fire("disconnect", "io client disconnect"); return sock; },
  };
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "rx-recv") fire("event", e.data.update);
  });
  setTimeout(() => sock.connect(), 0);
  return sock;
}
`;

// Replacement for Reflex's upload helper ($/utils/helpers/upload). Reflex uploads
// files over a separate HTTP POST /_upload/ — there's no server, so instead of
// the real XHR we read the file bytes and post them to the worker (rx-upload).
// The handler runs there and the resulting state deltas come back through the
// normal rx-recv → state.js path, so we don't process the response here.
const UPLOAD_SHIM = String.raw`
const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};
export const uploadFiles = async (
  handler, files, upload_id, on_upload_progress, extra_headers,
  socket, refs, getBackendURL, getToken,
) => {
  files = files ?? [];
  const upload_ref_name = "__upload_controllers_" + upload_id;
  if (refs[upload_ref_name]) { console.log("Upload already in progress for ", upload_id); return false; }
  refs[upload_ref_name] = true;
  try {
    const encoded = await Promise.all(files.map(async (file) => ({
      name: file.path || file.name,
      b64: toBase64(await file.arrayBuffer()),
    })));
    // No byte-by-byte transfer here, so report the upload as complete at once.
    if (on_upload_progress) {
      try { on_upload_progress({ loaded: 1, total: 1, progress: 1 }); } catch (e) {}
    }
    parent.postMessage(
      { type: "rx-upload", upload: { name: handler, upload_id, files: encoded } },
      "*",
    );
    return true;
  } catch (e) {
    console.log("Upload error:", e && e.message);
    return false;
  } finally {
    delete refs[upload_ref_name];
  }
};
`;

// Mounts the compiled page through Reflex's real providers (memory router so the
// widget owns its URL space). EventLoopProvider opens the (shimmed) socket.
const BOOT = String.raw`
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { MemoryRouter } from "react-router";
import Page from "$/app/routes/_index";
import { StateProvider, EventLoopProvider } from "$/utils/context";
try {
  const tree = h(MemoryRouter, { initialEntries: ["/"] },
    h(StateProvider, null,
      h(EventLoopProvider, null,
        h(Theme, { appearance: "inherit" }, h(Page)))));
  createRoot(document.getElementById("reflex-root")).render(tree);
} catch (e) {
  document.getElementById("reflex-root").textContent = "Mount error: " + e.message;
  parent.postMessage({ type: "rx-mount-error", message: String(e && e.stack || e) }, "*");
}
`;

export function buildParitySrcdoc(bundle: ReflexBundle): string {
	const env = {
		EVENT: 'http://localhost/_event/',
		UPLOAD: 'http://localhost/_upload/',
		PING: 'http://localhost/_ping/',
		TRANSPORT: 'websocket',
		TEST_MODE: false,
		MOUNT_TARGET: '#reflex-root'
	};

	// $/ specifier → data-URL module.
	const dollar: Record<string, string> = {
		'$/env.json': `export default ${JSON.stringify(env)};`,
		'$/reflex.json': `export default ${JSON.stringify({ version: '0.9.4' })};`,
		'socket.io-client': SOCKET_SHIM
	};
	for (const [rel, src] of Object.entries(bundle.runtime)) {
		dollar['$/' + rel.replace(/\.jsx?$/, '')] = src; // $/utils/state, $/utils/helpers/debounce, …
	}
	for (const [rel, src] of Object.entries(bundle.files)) {
		if (rel.endsWith('.css')) continue; // CSS imports handled via <link>, not modules
		dollar['$/' + rel.replace(/\.jsx?$/, '')] = src; // $/utils/context, $/app/routes/_index, $/utils/components/*
	}
	// Override Reflex's shipped upload helper (added by the runtime loop above)
	// with the postMessage-based one — there's no /_upload/ HTTP endpoint here.
	dollar['$/utils/helpers/upload'] = UPLOAD_SHIM;

	// Every package must import BARE "react"/"react-dom" so the import map routes
	// them to the single pinned instance below. Using esm.sh ?deps= here instead
	// would inline a second React copy → "Cannot read properties of null (useRef)".
	const imports: Record<string, string> = {
		react: `https://esm.sh/react@${PIN.react}`,
		'react/jsx-runtime': `https://esm.sh/react@${PIN.react}/jsx-runtime`,
		'react-dom': `https://esm.sh/react-dom@${PIN['react-dom']}?external=react`,
		'react-dom/client': `https://esm.sh/react-dom@${PIN['react-dom']}/client?external=react`
	};
	// BOOT statically imports these regardless of the user's app, so they must be
	// in the map even when the compiled page never references them directly.
	for (const lib of ['@radix-ui/themes', 'react-router']) imports[lib] = esmUrl(lib);
	for (const lib of bundle.npm_libs) {
		if (lib === 'socket.io-client' || imports[lib]) continue;
		imports[lib] = esmUrl(lib);
	}
	for (const [spec, src] of Object.entries(dollar)) imports[spec] = dataMod(src);

	return `<!doctype html>
<html><head><meta charset="utf-8" />
<link rel="stylesheet" href="https://esm.sh/@radix-ui/themes@${PIN['@radix-ui/themes']}/styles.css" />
<style>:root{color-scheme:light dark}body{margin:0}</style>
<script type="importmap">${JSON.stringify({ imports })}</script>
</head><body>
<div id="reflex-root"></div>
<script type="module">${BOOT}</script>
</body></html>`;
}
