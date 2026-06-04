/**
 * Return the parent directory of a path, or '' for a top-level path.
 * e.g. 'myapp/views.py' → 'myapp', 'app.py' → ''
 */
export function getParentPath(path: string): string {
	const lastSlash = path.lastIndexOf('/');
	return lastSlash > 0 ? path.slice(0, lastSlash) : '';
}
