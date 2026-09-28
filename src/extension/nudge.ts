import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentStatus } from "../common/api";

/*
	The notice above Projects. It shows while at least one project is
	registered, Claude Code or Codex is installed, and neither can use
	Rojo-Hub. VS Code's own agents do not count: they are on by default, so
	counting them would mean it never shows. Later hides it for 14 days, ✕
	for good. Kept in Rojo-Hub's state folder, so every window and profile
	agrees.
*/
const NUDGE_FILE = "agent-notice.json";
const LATER_MS = 14 * 24 * 60 * 60 * 1000;

export function showAgentNudge(home: string, projects: number, agents: AgentStatus[]): boolean {
	if (projects === 0 || !agents.some((agent) => agent.installed) || agents.some((agent) => agent.state !== "absent")) return false;
	try {
		return Date.now() >= (JSON.parse(readFileSync(join(home, NUDGE_FILE), "utf8")) as { until?: number }).until!;
	} catch {
		return true;
	}
}

export function hideAgentNudge(home: string, action: "later" | "never"): void {
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, NUDGE_FILE), JSON.stringify({ until: action === "never" ? Number.MAX_SAFE_INTEGER : Date.now() + LATER_MS }) + "\n");
}
