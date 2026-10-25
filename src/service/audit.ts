import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/*
	The audit log (spec 012): one JSON line per entry in audit.jsonl in the hub
	home, rotated to audit.old.jsonl at 1 MB. It must never get in the way of
	what it records, so nothing here throws.
*/
export const AUDIT_FILE = "audit.jsonl";
export const AUDIT_OLD_FILE = "audit.old.jsonl";
export const AUDIT_MAX_BYTES = 1024 * 1024;

export function writeAudit(home: string, entry: Record<string, unknown>): void {
	try {
		const file = join(home, AUDIT_FILE);
		try {
			if (statSync(file).size >= AUDIT_MAX_BYTES) {
				rmSync(join(home, AUDIT_OLD_FILE), { force: true });
				renameSync(file, join(home, AUDIT_OLD_FILE));
			}
		} catch {
			// No file yet, or it could not be rotated: append anyway.
		}
		appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
	} catch {
		// Auditing never fails the action.
	}
}
