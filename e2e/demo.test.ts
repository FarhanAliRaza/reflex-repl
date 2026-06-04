import { expect, test } from '@playwright/test';

// Fast smoke test: the shell renders without waiting on the Pyodide worker.
test('home page shows the Reflex Playground header', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByText('Reflex Playground')).toBeVisible();
});
