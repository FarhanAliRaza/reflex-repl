<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import FileTree from '$lib/components/FileTree.svelte';
	import Editor from '$lib/components/Editor.svelte';
	import Output from '$lib/components/Output.svelte';
	import { workspaceState } from '$lib/stores/workspace.svelte';
	import { executionState, ReplState } from '$lib/stores/execution.svelte';
	import * as Resizable from '$lib/components/ui/resizable/index.js';
	import { Button } from '$lib/components/ui/button';
	import { RefreshCw, Play, Link2, Github, LoaderCircle, CircleCheck, Atom } from '@lucide/svelte';
	import { shareState } from '$lib/stores/share.svelte';
	import type { ReflexBundle } from '$lib/workers/reflex/client';

	let worker: Worker | null = null;

	let bundle = $state<ReflexBundle | null>(null);
	let errorText = $state<string | null>(null);
	let renderId = $state(0); // bumped each render so Output recreates a fresh iframe
	let outputRef: ReturnType<typeof Output> | undefined = $state();

	let showShareToast = $state(false);
	let shareToastMessage = $state('');

	type WorkerMsg =
		| { type: 'log'; message: string }
		| { type: 'ready'; reflex: string }
		| { type: 'render'; bundle?: ReflexBundle; error?: string }
		| { type: 'update'; update?: Record<string, unknown> }
		| { type: 'error'; message: string };

	function handleWorkerMessage(data: WorkerMsg) {
		switch (data.type) {
			case 'log':
				executionState.log('info', data.message);
				break;

			case 'ready': {
				executionState.setWorkerReady();
				executionState.log('success', `Reflex ${data.reflex} ready`);
				// Auto-run fresh projects only. Shared projects (loaded from the URL
				// hash) could contain arbitrary code, so require an explicit Run click.
				const hasUrlHash = browser && window.location.hash.length > 1;
				if (!hasUrlHash) {
					run();
				}
				break;
			}

			case 'render':
				if (data.error) {
					errorText = data.error;
					executionState.log('error', data.error);
				} else {
					bundle = data.bundle ?? null;
					errorText = null;
					renderId++;
				}
				executionState.setReady();
				break;

			case 'update':
				// StateUpdate from a user event → push into the iframe's Reflex runtime.
				outputRef?.applyUpdate(data.update ?? {});
				break;

			case 'error':
				errorText = data.message;
				executionState.log('error', data.message);
				executionState.setReady();
				break;
		}
	}

	function run() {
		if (!worker || !executionState.isWorkerReady) return;
		if (executionState.replState === ReplState.RUNNING) return;

		executionState.startExecution(true);
		worker.postMessage({
			type: 'run',
			payload: { files: workspaceState.getFiles(), entry: 'app.py' }
		});
	}

	// A Reflex event bubbled up from the iframe runtime → run it through the
	// worker's real event pipeline; the resulting StateUpdate comes back as 'update'.
	function onEvent(event: Record<string, unknown>) {
		worker?.postMessage({ type: 'event', payload: { event } });
	}

	// An rx.upload bubbled up from the iframe → run the upload handler in the
	// worker; the resulting StateUpdate(s) come back as 'update' messages.
	function onUpload(upload: Record<string, unknown>) {
		worker?.postMessage({ type: 'upload', payload: { upload } });
	}

	// Load a shared project from the URL hash, if one is present.
	function loadProjectFromHash() {
		shareState.loadFromHash().then((sharedData) => {
			if (sharedData) {
				workspaceState.fromJSON(sharedData);
			}
		});
	}

	onMount(() => {
		loadProjectFromHash();

		// Re-run on save (Ctrl+S / Cmd+S) once the worker is ready.
		const handleEditorSave = () => {
			if (
				executionState.replState === ReplState.READY ||
				executionState.replState === ReplState.IDLE
			) {
				run();
			}
		};

		window.addEventListener('editor-save', handleEditorSave);
		// Reload the workspace when navigating back/forward across shared URLs.
		window.addEventListener('hashchange', loadProjectFromHash);

		if (browser) {
			executionState.resetState();
			worker = new Worker(new URL('../lib/workers/reflex/reflex-worker.ts', import.meta.url), {
				type: 'module'
			});
			worker.onmessage = (e) => handleWorkerMessage(e.data);
			worker.postMessage({ type: 'init' });
		}

		return () => {
			window.removeEventListener('editor-save', handleEditorSave);
			window.removeEventListener('hashchange', loadProjectFromHash);
			worker?.terminate();
		};
	});

	async function handleShare() {
		try {
			const data = workspaceState.toJSON();
			const url = await shareState.generateUrl(data.name, data.files);
			const copied = await shareState.copyToClipboard(url);

			if (copied) {
				shareToastMessage = 'Link copied to clipboard!';
				showShareToast = true;
				setTimeout(() => {
					showShareToast = false;
				}, 3000);
			} else {
				alert('Failed to copy link. Please try again.');
			}
		} catch (error) {
			console.error('Failed to generate share link:', error);
			alert('Failed to generate share link. The project might be too large.');
		}
	}
</script>

<div class="dark flex h-screen flex-col">
	<header
		class="flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-4"
	>
		<div class="flex items-center gap-3">
			<Atom class="size-5 text-emerald-500" />
			<span class="text-sm font-medium text-foreground">Reflex Playground</span>
		</div>

		<a
			class="hidden items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground md:flex"
			href="https://github.com/FarhanAliRaza"
			target="_blank"
			rel="noopener noreferrer"
		>
			<Github class="size-3.5" />
			<span>Farhan Ali Raza</span>
		</a>

		<div class="flex items-center gap-2">
			<div
				class="flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1 text-xs text-muted-foreground"
			>
				{#if executionState.replState === ReplState.INITIALIZING}
					<LoaderCircle class="size-3 animate-spin" />
					<span>Initializing</span>
				{:else if executionState.replState === ReplState.RUNNING}
					<LoaderCircle class="size-3 animate-spin" />
					<span>Running</span>
				{:else}
					<CircleCheck class="size-3 text-emerald-500" />
					<span>Ready</span>
				{/if}
			</div>

			<Button size="sm" variant="outline" onclick={handleShare}>
				<Link2 class="size-3.5" />
				<span class="hidden sm:inline">Share</span>
			</Button>

			{#if executionState.replState === ReplState.READY}
				<Button size="sm" onclick={run}>
					<RefreshCw class="size-3.5" />
					<span class="hidden sm:inline">Refresh</span>
				</Button>
			{:else}
				<Button size="sm" onclick={run} disabled={executionState.replState !== ReplState.IDLE}>
					<Play class="size-3.5" />
					<span class="hidden sm:inline">Run</span>
				</Button>
			{/if}
		</div>
	</header>

	<div class="flex-1 overflow-hidden">
		<Resizable.PaneGroup direction="horizontal">
			<Resizable.Pane defaultSize={50} minSize={30}>
				<div class="h-full w-full">
					<Resizable.PaneGroup direction="horizontal">
						<Resizable.Pane defaultSize={30} minSize={15}>
							<div class="h-full w-full overflow-hidden">
								<FileTree />
							</div>
						</Resizable.Pane>
						<Resizable.Handle withHandle={true} />
						<Resizable.Pane>
							<div class="h-full w-full overflow-hidden">
								<Editor />
							</div>
						</Resizable.Pane>
					</Resizable.PaneGroup>
				</div>
			</Resizable.Pane>
			<Resizable.Handle withHandle={true} />
			<Resizable.Pane defaultSize={50}>
				<div class="h-full w-full overflow-hidden">
					<Output
						{bundle}
						error={errorText}
						{renderId}
						{onEvent}
						{onUpload}
						bind:this={outputRef}
					/>
				</div>
			</Resizable.Pane>
		</Resizable.PaneGroup>
	</div>

	{#if showShareToast}
		<div
			class="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-md bg-emerald-500 px-4 py-2.5 text-sm font-medium text-white shadow-lg"
		>
			<CircleCheck class="size-4" />
			{shareToastMessage}
		</div>
	{/if}
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		overflow: hidden;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	:global(.animate-spin) {
		animation: spin 1s linear infinite;
	}
</style>
