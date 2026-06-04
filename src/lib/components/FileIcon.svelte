<script lang="ts">
	import { FileCode, FileText, File } from '@lucide/svelte';

	let { name, class: className = 'size-4' }: { name: string; class?: string } = $props();
</script>

{#if name.endsWith('.py')}
	<FileCode class="{className} text-blue-400" />
{:else if name.endsWith('.html')}
	<FileText class="{className} text-orange-400" />
{:else if name === '.gitkeep'}
	<File class="{className} text-muted-foreground/50" />
{:else}
	<File class="{className} text-muted-foreground" />
{/if}
