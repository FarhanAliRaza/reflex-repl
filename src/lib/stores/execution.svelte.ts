import type { LogEntry } from '$lib/types';

export enum ReplState {
	INITIALIZING = 'initializing', // Python environment is loading
	IDLE = 'idle', // Ready but not executed yet
	RUNNING = 'running', // Currently executing Python code
	READY = 'ready' // Has executed at least once, ready for changes/refresh
}

class ExecutionState {
	replState = $state<ReplState>(ReplState.INITIALIZING);
	isExecuting = $state(false);
	logs = $state<LogEntry[]>([]);
	isWorkerReady = $state(false);

	addLog(entry: LogEntry) {
		this.logs = [...this.logs, entry];
	}

	log(type: LogEntry['type'], message: string) {
		this.addLog({ timestamp: Date.now(), type, message });
	}

	clearLogs() {
		this.logs = [];
	}

	setWorkerReady() {
		this.isWorkerReady = true;
		this.replState = ReplState.IDLE;
	}

	setReady() {
		this.replState = ReplState.READY;
		this.isExecuting = false;
	}

	startExecution(clearLogs: boolean = false) {
		this.isExecuting = true;
		this.replState = ReplState.RUNNING;
		if (clearLogs) {
			this.clearLogs();
		}
	}

	resetState() {
		this.replState = ReplState.INITIALIZING;
		this.isExecuting = false;
		this.logs = [];
		this.isWorkerReady = false;
	}
}

export const executionState = new ExecutionState();
