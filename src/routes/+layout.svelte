<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { injectAnalytics } from '@vercel/analytics/sveltekit';
	import { browser, dev } from '$app/environment';
	let { children } = $props();

	// Vercel serves /_vercel/insights/script.js only on the deployed site; requesting
	// it from localhost (dev, `vite preview`, e2e tests) just 404s. Skip it there.
	if (browser && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
		injectAnalytics({ mode: dev ? 'development' : 'production' });
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
