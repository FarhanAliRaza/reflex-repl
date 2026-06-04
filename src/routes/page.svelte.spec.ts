import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Page from './+page.svelte';

describe('/+page.svelte', () => {
	it('renders the Reflex Playground title', async () => {
		render(Page);

		const title = page.getByText('Reflex Playground');
		await expect.element(title).toBeInTheDocument();
	});
});
