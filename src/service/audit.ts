import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/*
	The audit log (spec 012): one JSON object per line in the hub home, rotated
	at 1 MB to audit.old.jsonl (the older rotation is replaced). Setup commands
	write to it always; yolo mode writes its entries here too. Writing never
	throws: a log that cannot be written must not fail what it records.
*/

export const AUDIT_FILE = "audit.jsonl";
export const AUDIT_OLD_FILE = "audit.old.jsonl";
export const AUDIT_LIMIT = 1024 * 1024;

export function writeAudit(home: string, entry: Record<string, unknown>): void {
	try {
		const file = join(home, AUDIT_FILE);
		if (existsSync(file) && statSync(file).size >= AUDIT_LIMIT) renameSync(file, join(home, AUDIT_OLD_FILE));
		appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
	} catch {
		// Deliberately silent.
	}
}
