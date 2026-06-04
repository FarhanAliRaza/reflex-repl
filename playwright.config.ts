import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'npm run build && npm run preview',
		port: 4173,
		// Reuse a server you already have running locally; always start fresh in CI.
		reuseExistingServer: !process.env.CI,
		timeout: 180_000 // build + preview boot
	},
	testDir: 'e2e',
	use: {
		baseURL: 'http://localhost:4173',
		trace: 'retain-on-failure'
	},
	// One worker so the whole run shares a SINGLE Pyodide + Reflex install instead of
	// installing once per parallel process. The Reflex spec warms up once in its
	// beforeAll and every test reuses that page.
	workers: 1,
	fullyParallel: false,
	// The first-run Reflex install (in reflex.spec.ts beforeAll) can take minutes;
	// this ceiling covers it. Other tests finish in seconds, so it never hurts them.
	timeout: 300_000,
	expect: {
		// Event round-trips and recompiles cross postMessage into the worker and back.
		timeout: 20_000
	}
});
