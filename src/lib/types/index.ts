// File types
export interface FileNode {
	name: string;
	path: string;
	type: 'file' | 'directory';
	content?: string;
	children?: FileNode[];
}

export interface LogEntry {
	timestamp: number;
	type: 'info' | 'warning' | 'error' | 'success';
	message: string;
	category?: 'worker' | 'reflex'; // 'worker' for internal debug logs, 'reflex' for user-facing logs
}

// Shared project structure (for URL sharing)
export interface SharedProject {
	name: string;
	files: Record<string, string>;
}

// Share-related errors
export type ShareError =
	| 'compression_failed'
	| 'decompression_failed'
	| 'invalid_data'
	| 'url_too_long';
