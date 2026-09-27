/*
	The shapes the background service and the VS Code extension exchange over
	the service's local HTTP API. Both sides import this file, so a change here
	is a change to the protocol.
*/

export const SERVICE_PORT = 34870;
export const SERVICE_VERSION = "0.1.0";

/*
	Where a slot's files come from. A worktree is served in place, so edits made
	there (by an agent or by hand) reach Studio. A branch that is not checked out
	anywhere is checked out into one of the slot's Hub-owned view folders.
*/
export type Target = { kind: "worktree"; path: string } | { kind: "branch"; ref: string };

export type SlotState = "stopped" | "starting" | "running" | "error";

export interface SlotView {
	id: string;
	projectName: string;
	repoPath: string;
	projectFile: string;
	port: number;
	state: SlotState;
	/** Plugin websocket subscriptions currently open, read from Rojo's own log. */
	connections: number;
	target: Target;
	/** Human label for the target: Orca's worktree name, or the branch. */
	targetLabel: string;
	branch: string | null;
	/** "native" serves the tree's own project file; "borrowed" is a generated copy (see spec 001). */
	mode: "native" | "borrowed" | null;
	warnings: string[];
	error: string | null;
	sessionId: string | null;
	logFile: string;
}

export interface TargetOption {
	target: Target;
	label: string;
	description: string;
	/** Branch name without refs/heads/, or null for a detached worktree. */
	branch: string | null;
	isPrimary: boolean;
	committedAt: number;
}

export interface Health {
	ok: true;
	version: string;
	pid: number;
	home: string;
}

export interface ErrorBody {
	error: string;
}
