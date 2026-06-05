import { SvelteMap } from 'svelte/reactivity';
import type { FileNode } from '$lib/types';

// Reflex starter template: app.py composes two self-contained widgets, each
// owning its own state in its own file — a real multi-file Reflex app.
const defaultReflexProject: Record<string, string> = {
	'app.py': `import reflex as rx

from counter import counter
from greeting import greeting


def index() -> rx.Component:
    return rx.center(
        rx.vstack(
            rx.badge(
                "🐍 Zero Setup, Reflex in browser", variant="soft", radius="full", size="2"
            ),
            rx.heading(
                "Reflex, running in your browser", size="8", weight="bold", align="center"
            ),
            rx.text(
                "Write a little Python, hit Run, and watch your app spring to life — "
                "no installs, no servers, nothing to set up.",
                size="3",
                color_scheme="gray",
                align="center",
                max_width="34rem",
            ),
            rx.flex(
                counter(),
                greeting(),
                spacing="4",
                wrap="wrap",
                justify="center",
                width="100%",
            ),
            spacing="6",
            align="center",
            width="100%",
            max_width="56rem",
            padding="6",
        ),
        width="100%",
        min_height="100vh",
    )
`,

	'counter.py': `import reflex as rx


class CounterState(rx.State):
    count: int = 0

    def increment(self):
        self.count += 1

    def decrement(self):
        self.count -= 1

    def reset_count(self):
        self.count = 0


def counter() -> rx.Component:
    return rx.card(
        rx.vstack(
            rx.hstack(
                rx.icon("calculator", size=18, color=rx.color("accent", 9)),
                rx.heading("Counter", size="4"),
                align="center",
                spacing="2",
            ),
            rx.text(
                "Tap the buttons and watch the number dance.",
                size="2",
                color_scheme="gray",
            ),
            rx.center(
                rx.heading(CounterState.count, size="9", weight="bold"),
                width="100%",
                padding_y="3",
            ),
            rx.hstack(
                rx.button(
                    rx.icon("minus"), on_click=CounterState.decrement, variant="soft", size="3"
                ),
                rx.button(
                    "Reset",
                    on_click=CounterState.reset_count,
                    variant="surface",
                    color_scheme="gray",
                    size="3",
                ),
                rx.button(rx.icon("plus"), on_click=CounterState.increment, size="3"),
                spacing="3",
                justify="center",
                width="100%",
            ),
            spacing="3",
            align="start",
            width="100%",
        ),
        size="3",
        width="320px",
    )
`,

	'greeting.py': `import reflex as rx


class GreetingState(rx.State):
    name: str = "world"

    @rx.var
    def message(self) -> str:
        return f"Hey {self.name.strip() or 'world'} 👋"

    def set_name(self, value: str):
        self.name = value


def greeting() -> rx.Component:
    return rx.card(
        rx.vstack(
            rx.hstack(
                rx.icon("sparkles", size=18, color=rx.color("accent", 9)),
                rx.heading("Greeting", size="4"),
                align="center",
                spacing="2",
            ),
            rx.text(
                "Type your name and get a friendly hello.",
                size="2",
                color_scheme="gray",
            ),
            rx.heading(GreetingState.message, size="6", padding_y="2"),
            rx.input(placeholder="Type your name…", on_change=GreetingState.set_name, size="3"),
            spacing="3",
            align="start",
            width="100%",
        ),
        size="3",
        width="320px",
    )
`
};

// Workspace state management using Svelte 5 runes
class WorkspaceState {
	files = $state<Record<string, string>>(defaultReflexProject);
	currentFile = $state<string>('app.py');
	projectName = $state<string>('Reflex Playground');
	fileReloadTrigger = $state<number>(0); // Increments when files are bulk loaded

	// Derived file tree structure
	fileTree = $derived.by(() => {
		const tree: FileNode[] = [];
		const pathMap = new SvelteMap<string, FileNode>();

		// Sort files by path
		const sortedPaths = Object.keys(this.files).sort();

		for (const path of sortedPaths) {
			const parts = path.split('/');
			let currentPath = '';

			for (let i = 0; i < parts.length; i++) {
				const part = parts[i];
				const isFile = i === parts.length - 1;
				currentPath += (i > 0 ? '/' : '') + part;

				if (!pathMap.has(currentPath)) {
					const node: FileNode = {
						name: part,
						path: currentPath,
						type: isFile ? 'file' : 'directory',
						content: isFile ? this.files[path] : undefined,
						children: isFile ? undefined : []
					};

					if (i === 0) {
						tree.push(node);
					} else {
						const parentPath = parts.slice(0, i).join('/');
						const parent = pathMap.get(parentPath);
						if (parent?.children) {
							parent.children.push(node);
						}
					}

					pathMap.set(currentPath, node);
				}
			}
		}

		// Sort function: directories first, then files, both alphabetically
		const sortNodes = (nodes: FileNode[]): FileNode[] => {
			return nodes.sort((a, b) => {
				// Directories come before files
				if (a.type === 'directory' && b.type === 'file') return -1;
				if (a.type === 'file' && b.type === 'directory') return 1;
				// Within same type, sort alphabetically by name
				return a.name.localeCompare(b.name);
			});
		};

		// Recursively sort all levels of the tree
		const sortTreeRecursive = (nodes: FileNode[]): FileNode[] => {
			const sorted = sortNodes(nodes);
			for (const node of sorted) {
				if (node.children) {
					node.children = sortTreeRecursive(node.children);
				}
			}
			return sorted;
		};

		return sortTreeRecursive(tree);
	});

	reset() {
		this.files = { ...defaultReflexProject };
	}

	updateFile(path: string, content: string) {
		this.files = { ...this.files, [path]: content };
	}

	addFile(path: string, content: string = '') {
		this.files = { ...this.files, [path]: content };
	}

	deleteFile(path: string) {
		const newFiles = { ...this.files };
		delete newFiles[path];
		this.files = newFiles;
	}

	// Get all files as a plain object (for worker communication)
	getFiles(): Record<string, string> {
		// Defensive check: ensure files is an object
		if (!this.files || typeof this.files !== 'object') {
			console.error('[WorkspaceState] Invalid files state:', this.files);
			return {};
		}

		// Use $state.snapshot() to extract plain values from Svelte reactive state
		// This is the proper Svelte 5 way to remove Proxies
		const snapshot = $state.snapshot(this.files);

		return snapshot;
	}

	// Serialize workspace to JSON for sharing
	toJSON(): { name: string; files: Record<string, string> } {
		return {
			name: this.projectName,
			files: this.getFiles()
		};
	}

	// Load workspace from JSON (for shared projects)
	fromJSON(data: { name: string; files: Record<string, string> }) {
		this.projectName = data.name;
		this.files = { ...data.files };
		this.fileReloadTrigger++; // Trigger editor reload for currently open file

		// Set first Python file as current file if current file doesn't exist
		if (!this.files[this.currentFile]) {
			const pythonFiles = Object.keys(this.files).filter((path) => path.endsWith('.py'));
			if (pythonFiles.length > 0) {
				this.currentFile = pythonFiles[0];
			}
		}
	}

	// Update project name
	setProjectName(name: string) {
		this.projectName = name;
	}
}

export const workspaceState = new WorkspaceState();
