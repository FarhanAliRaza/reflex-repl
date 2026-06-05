<script lang="ts">
	import { onMount } from 'svelte';
	import { buildParitySrcdoc, type ReflexBundle } from '$lib/workers/reflex/client';
	import Console from './Console.svelte';
	import * as Resizable from '$lib/components/ui/resizable/index.js';
	import { Rocket, AlertCircle } from '@lucide/svelte';

	interface Props {
		bundle: ReflexBundle | null; // compiled module bundle from the worker
		error: string | null;
		// Bumped by the parent on every Run/Refresh so the iframe is recreated even
		// when a re-compile produces byte-identical modules.
		renderId: number;
		// A user event bubbled up from Reflex's runtime in the iframe (the dict its
		// socket would have emitted). Parent forwards it to the worker pipeline.
		onEvent: (event: Record<string, unknown>) => void;
		// An rx.upload bubbled up from the iframe (handler name + file bytes). Parent
		// forwards it to the worker, which runs the real upload handler.
		onUpload: (upload: Record<string, unknown>) => void;
	}

	let { bundle, error, renderId, onEvent, onUpload }: Props = $props();

	let iframeElement = $state<HTMLIFrameElement | null>(null);

	let hasApp = $derived(!!bundle);

	// Load the iframe from a Blob URL rather than `srcdoc`: import maps (which the
	// compiled app relies on to resolve react/@radix-ui/themes/…) are applied
	// reliably in a real blob-document origin, but flaky inside `srcdoc`.
	let iframeSrc = $state('');
	$effect(() => {
		void renderId; // rebuild on each Run/Refresh
		if (!bundle) {
			iframeSrc = '';
			return;
		}
		const url = URL.createObjectURL(new Blob([buildParitySrcdoc(bundle)], { type: 'text/html' }));
		iframeSrc = url;
		return () => URL.revokeObjectURL(url);
	});

	// Push a StateUpdate (delta+events) into the iframe, where Reflex's runtime
	// applies it and React re-renders. Called by the parent via `bind:this`.
	export function applyUpdate(update: Record<string, unknown>): void {
		iframeElement?.contentWindow?.postMessage({ type: 'rx-recv', update }, '*');
	}

	// Relay events (and mount errors) bubbling up from the iframe's Reflex runtime.
	onMount(() => {
		const handleMessage = (event: MessageEvent) => {
			const d = event.data;
			if (d?.type === 'rx-emit') onEvent(d.event);
			else if (d?.type === 'rx-upload') onUpload(d.upload);
		};
		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	});
</script>

<div class="h-full w-full bg-background">
	<Resizable.PaneGroup direction="vertical">
		<Resizable.Pane defaultSize={70}>
			<div class="flex h-full w-full flex-col overflow-hidden bg-white">
				<div class="relative flex-1 overflow-hidden">
					{#if hasApp}
						{#key renderId}
							<iframe
								bind:this={iframeElement}
								title="Reflex Output"
								src={iframeSrc}
								sandbox="allow-scripts allow-popups allow-same-origin allow-downloads"
								class="h-full w-full border-none bg-white"
							></iframe>
						{/key}
					{:else if error}
						<div class="h-full overflow-y-auto bg-background p-6 text-destructive">
							<div class="mb-4 flex items-center gap-2">
								<AlertCircle class="size-5" />
								<h3 class="text-base font-semibold">Error</h3>
							</div>
							<pre
								class="overflow-x-auto rounded-md border-l-2 border-destructive bg-card p-4 font-mono text-sm leading-relaxed text-foreground">{error}</pre>
						</div>
					{:else}
						<div
							class="flex h-full flex-col items-center justify-center gap-5 bg-background p-10 text-center"
						>
							<Rocket class="size-12 text-muted-foreground/30" />
							<div>
								<h3 class="mb-2 text-lg font-semibold text-foreground">Ready to Run</h3>
								<p class="text-sm text-muted-foreground">Click Run to render your Reflex app.</p>
							</div>
						</div>
					{/if}
				</div>
			</div>
		</Resizable.Pane>
		<Resizable.Handle withHandle={true} />
		<Resizable.Pane defaultSize={30} minSize={20}>
			<Console />
		</Resizable.Pane>
	</Resizable.PaneGroup>
</div>
