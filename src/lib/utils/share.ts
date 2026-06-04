/**
 * Share utilities for compressing and encoding Reflex project files
 * Based on Svelte REPL's approach: gzip + base64-URL-safe encoding
 */

/**
 * Compress and encode text for URL sharing
 * Uses gzip compression and base64 URL-safe encoding
 */
export async function compressAndEncode(input: string): Promise<string> {
	try {
		// gzip the input, then read the whole compressed stream at once.
		const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
		const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

		// Build a binary string in chunks — avoids both the call-stack limit of a
		// single spread and the O(n²) cost of appending byte-by-byte.
		let binary = '';
		const CHUNK_SIZE = 0x8000;
		for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
			binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
		}

		// base64, made URL-safe: + → -, / → _, trailing = stripped.
		return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
	} catch (error) {
		console.error('Failed to compress and encode:', error);
		throw new Error(`Compression failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
}

/**
 * Decode and decompress text from URL hash
 * Reverses the URL-safe base64 encoding and gzip decompression
 */
export async function decodeAndDecompress(input: string): Promise<string> {
	try {
		// Reverse URL-safe base64, then decode to bytes.
		const base64 = input.replaceAll('-', '+').replaceAll('_', '/');
		const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

		// gunzip and read back as text.
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
		return await new Response(stream).text();
	} catch (error) {
		console.error('Failed to decode and decompress:', error);
		throw new Error(
			`Decompression failed: ${error instanceof Error ? error.message : 'Unknown error'}`
		);
	}
}

/**
 * Generate a shareable URL from project data
 */
export async function generateShareableUrl(
	projectName: string,
	files: Record<string, string>
): Promise<string> {
	const data = JSON.stringify({ name: projectName, files });
	const encoded = await compressAndEncode(data);

	// Return URL with hash
	return `${window.location.origin}${window.location.pathname}#${encoded}`;
}

/**
 * Parse shareable URL and extract project data
 */
export async function parseShareableUrl(
	hash: string
): Promise<{ name: string; files: Record<string, string> }> {
	// Remove leading # if present
	const encoded = hash.startsWith('#') ? hash.slice(1) : hash;

	if (!encoded) {
		throw new Error('No share data found in URL');
	}

	// Decode and parse
	const json = await decodeAndDecompress(encoded);
	const data = JSON.parse(json);

	// Validate structure
	if (!data.name || typeof data.name !== 'string') {
		throw new Error('Invalid share data: missing project name');
	}

	if (!data.files || typeof data.files !== 'object') {
		throw new Error('Invalid share data: missing files');
	}

	return data;
}

/**
 * Estimate the URL length for a given project
 * Useful for warning users about long URLs
 */
export async function estimateUrlLength(
	projectName: string,
	files: Record<string, string>
): Promise<number> {
	const url = await generateShareableUrl(projectName, files);
	return url.length;
}

/**
 * Check if URL is within safe limits (most browsers support ~2000 chars comfortably)
 */
export function isUrlSafe(urlLength: number): boolean {
	return urlLength < 2000;
}
