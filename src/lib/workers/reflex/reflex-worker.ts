/**
 * Reflex-in-the-browser worker. Boots the latest Reflex inside Pyodide with no
 * server, renders a user's page to HTML, and drives UI events through Reflex's
 * real event pipeline — the delta a websocket would carry crosses postMessage.
 */
import bootPy from './boot.py?raw';
import bridgePy from './bridge.py?raw';

const PYODIDE_VERSION = '0.29.4';
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

// Prebuilt (incl. native) wheels loaded from Pyodide's repo before installing Reflex.
// pydantic/pydantic_core: 0.29.4 ships 2.12.5 / 2.41.5, which satisfy Reflex's
// pydantic>=2.12 pin natively (no version forcing needed); ssl is required
// (redis touches ssl.VerifyMode at import); sqlite3 backs the DB layer.
const PREBUILT = [
	'micropip',
	'pydantic',
	'pydantic_core',
	'sqlalchemy',
	'typing-extensions',
	'wrapt',
	'rich',
	'pygments',
	'ssl',
	'sqlite3',
	'six'
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pyodide: any = null;

const log = (message: string) => self.postMessage({ type: 'log', message });

async function handleInit() {
	if (pyodide) return { type: 'ready', reflex: 'already-initialized' };
	log('Loading Pyodide…');
	const mod = await import(/* @vite-ignore */ `${CDN}pyodide.mjs`);
	pyodide = await mod.loadPyodide({ indexURL: CDN });

	log('Loading prebuilt wheels…');
	for (const pkg of PREBUILT) {
		try {
			await pyodide.loadPackage(pkg);
		} catch {
			/* optional */
		}
	}

	log('Installing Reflex (this is the slow first-run step)…');
	const report = await pyodide.runPythonAsync(bootPy);
	const parsed = JSON.parse(report);
	if (parsed.fails?.length)
		log(`Some optional installs were skipped: ${JSON.stringify(parsed.fails)}`);

	// Define the render bridge (compile_app, dispatch_event, …) in the interpreter.
	pyodide.runPython(bridgePy);
	log(`Reflex ${parsed.reflex} ready.`);
	return { type: 'ready', reflex: parsed.reflex };
}

async function handleRun(files: Record<string, string>, entry: string = 'app.py') {
	if (!pyodide) throw new Error('worker not initialized');
	pyodide.globals.set('FILES', JSON.stringify(files ?? {}));
	pyodide.globals.set('ENTRY', entry || 'app.py');
	// compile_app (bridge.py) hot-reloads the previous run, writes the files,
	// imports the entry, and compiles the app to its real React frontend,
	// returning the module bundle the iframe needs. Logic lives in Python so it
	// stays testable headless (ignore/test_parity_bridge.mjs).
	const result = await pyodide.runPythonAsync(`
import json, traceback
try:
    _RESULT = json.dumps(await compile_app(json.loads(FILES), ENTRY), default=str)
except Exception:
    _RESULT = json.dumps({"error": traceback.format_exc()})
_RESULT
`);
	const parsed = JSON.parse(result);
	if (parsed.error) return { type: 'render', error: parsed.error };
	return { type: 'render', bundle: parsed };
}

async function handleEvent(eventDict: Record<string, unknown>) {
	if (!pyodide) throw new Error('worker not initialized');
	pyodide.globals.set('EVENT_JSON', JSON.stringify(eventDict ?? {}));
	// dispatch_event runs the event through Reflex's real pipeline and STREAMS
	// each StateUpdate {delta, events, final} via this callback as it is produced
	// — so generator `yield`s, returned events (redirect/toast/chaining) and
	// on_load all surface, instead of collapsing to one final delta. Each update
	// is posted as its own 'update' message; the page applies them in order.
	const emit = (json: string) => self.postMessage({ type: 'update', update: JSON.parse(json) });
	pyodide.globals.set('EMIT_UPDATE', emit);
	await pyodide.runPythonAsync(`
import json, traceback
try:
    await dispatch_event(json.loads(EVENT_JSON), EMIT_UPDATE)
except Exception:
    EMIT_UPDATE(json.dumps({"delta": {}, "events": [], "final": True, "error": traceback.format_exc()}))
`);
	// Updates were already streamed via EMIT_UPDATE; nothing more to post.
	return { type: 'noop' };
}

self.onmessage = async (event: MessageEvent) => {
	const { type, payload, id } = event.data ?? {};
	try {
		let response;
		switch (type) {
			case 'init':
				response = await handleInit();
				break;
			case 'run':
				response = await handleRun(payload.files, payload.entry);
				break;
			case 'event':
				response = await handleEvent(payload.event);
				break;
			default:
				response = { type: 'error', message: `unknown message type ${type}` };
		}
		self.postMessage({ ...response, id });
	} catch (err) {
		self.postMessage({ type: 'error', message: String(err), id });
	}
};
