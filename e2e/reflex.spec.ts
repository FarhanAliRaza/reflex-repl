import { test, expect, type Page, type FrameLocator } from '@playwright/test';

/**
 * End-to-end test for the Reflex-in-the-browser playground.
 *
 * The expensive part of this app is the FIRST run: Pyodide boots and Reflex (plus
 * ~20 dependency wheels) is installed via micropip inside the Web Worker — minutes
 * of work. We pay it EXACTLY ONCE for the whole file. `beforeAll` opens the page,
 * lets the worker install and auto-render, and every test then reuses that same
 * warmed page and its already-initialized worker.
 *
 * Why this never re-installs: the worker only installs on the 'init' message, which
 * fires once in the page's onMount. Run/Refresh send 'run', and handleInit()
 * early-returns when Pyodide already exists — so the live Pyodide+Reflex instance is
 * reused. Combined with `workers: 1` (playwright.config.ts) the suite installs once,
 * not once-per-test and not once-per-process. The final test proves this by showing
 * a Refresh re-renders within seconds.
 */

const OUTPUT_IFRAME = 'iframe[title="Reflex Output"]';
const INSTALL_TIMEOUT = 240_000; // first-run Pyodide boot + Reflex install
const TITLE = /Reflex, running in your browser/i;
// The count is the only pure-numeric heading in the default app.
const COUNT = /^-?\d+$/;

test.describe.configure({ mode: 'serial' });

let page: Page;
let app: FrameLocator;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	page.on('pageerror', (e) => pageErrors.push(String(e.stack || e)));
	page.on('console', (m) => {
		if (m.type() === 'error') pageErrors.push('console.error: ' + m.text());
	});

	await page.goto('/');
	app = page.frameLocator(OUTPUT_IFRAME);

	// The page auto-runs once the worker is ready, so the app rendering inside the
	// sandboxed iframe is our single signal that install + compile + render all
	// succeeded. If the app errored instead, surface the traceback rather than
	// timing out blindly.
	try {
		await app.getByRole('heading', { name: TITLE }).waitFor({
			state: 'visible',
			timeout: INSTALL_TIMEOUT
		});
	} catch (err) {
		const errorPanel = page.getByRole('heading', { name: 'Error' });
		if (await errorPanel.isVisible().catch(() => false)) {
			const detail = await page.locator('pre').first().textContent();
			throw new Error(`Reflex app failed to compile:\n${detail}`);
		}
		if (pageErrors.length) {
			throw new Error(`Reflex app did not render. Page errors:\n${pageErrors.join('\n')}`);
		}
		throw err;
	}
});

test.afterAll(async () => {
	await page?.close();
});

test('renders the default Reflex app inside the sandboxed iframe', async () => {
	await expect(app.getByText('🐍 Zero Setup, Reflex in browser')).toBeVisible();
	await expect(app.getByRole('heading', { name: COUNT })).toHaveText('0');
	await expect(app.getByText('Hey world 👋')).toBeVisible();
});

test('counter buttons round-trip through the real Python event pipeline', async () => {
	const count = app.getByRole('heading', { name: COUNT });
	const buttons = app.getByRole('button');
	// Default app: [ − (minus), Reset, + (plus) ]. Assert the shape so the
	// first/last positional lookups below stay honest.
	await expect(buttons).toHaveCount(3);
	const minus = buttons.first();
	const plus = buttons.last();
	const reset = app.getByRole('button', { name: 'Reset' });

	await expect(count).toHaveText('0');

	// Each click crosses postMessage → worker → Reflex handler → delta → iframe.
	await plus.click();
	await expect(count).toHaveText('1');
	await plus.click();
	await expect(count).toHaveText('2');

	await minus.click();
	await expect(count).toHaveText('1');

	// Leave the shared state back at 0 for any later test.
	await reset.click();
	await expect(count).toHaveText('0');
});

test('text input two-way binds to a computed var', async () => {
	const input = app.getByPlaceholder('Type your name…');
	await input.fill('Reflex');
	// greeting is an @rx.var computed from `name`; the recomputed value comes back
	// in the delta, proving computed vars resolve over the bridge.
	await expect(app.getByText('Hey Reflex 👋')).toBeVisible();
});

test('Refresh recompiles using the cached install — no re-install', async () => {
	// If Reflex were reinstalled here it would take minutes. Because the worker's
	// Pyodide+Reflex install is cached, Refresh only recompiles, so a fresh render
	// must appear well within a budget far shorter than a cold install.
	await page.getByRole('button', { name: 'Refresh' }).click();

	// Output recreates the iframe on each run (renderId key); wait for the fresh
	// mount and confirm state reset to its defaults.
	await expect(app.getByRole('heading', { name: TITLE })).toBeVisible({ timeout: 45_000 });
	await expect(app.getByRole('heading', { name: COUNT })).toHaveText('0');
	await expect(app.getByText('Hey world 👋')).toBeVisible();
});
