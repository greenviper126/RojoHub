/*
	The panel's Setup commands editor (spec 012): one command per line, a
	program followed by its arguments, double quotes to group a word with spaces
	in it. No escapes, no expansion, no shell: what the line shows after parsing
	is exactly the argv that will run.
*/

export interface SetupLine {
	text: string;
	/** The program and its arguments, or null when the line is invalid. */
	argv: string[] | null;
	error?: string;
	/** For a `#fixed N` line: N. */
	fixed?: number;
}

/** Splits one line; null with a reason when a quote is left open. */
export function splitLine(line: string): { argv: string[] } | { error: string } {
	const argv: string[] = [];
	let current = "";
	let started = false;
	let quoted = false;
	for (const char of line) {
		if (char === '"') {
			quoted = !quoted;
			started = true;
		} else if (!quoted && /\s/.test(char)) {
			if (started) argv.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (quoted) return { error: 'a double quote is not closed' };
	if (started) argv.push(current);
	return { argv };
}

/**
 * A command set in settings.json with a folder, a timeout, or a quote in an
 * argument cannot be written as an editor line, so it appears as `#fixed N` (N
 * counts from 1 in the order they occur) and is kept as it is. The line can be
 * moved or deleted.
 */
export const FIXED_LINE = /^\s*#fixed\s+(\d+)\b/;

/** Every non-blank line of the editor's text, parsed. */
export function parseSetupText(text: string): SetupLine[] {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const fixed = FIXED_LINE.exec(line);
			if (fixed) return { text: line, argv: [], fixed: Number(fixed[1]) };
			const split = splitLine(line);
			return "error" in split ? { text: line, argv: null, error: split.error } : { text: line, argv: split.argv };
		});
}

/** A command as one editor line: parts with spaces (or none) are quoted. */
export function formatSetupLine(command: string, args: string[]): string {
	return [command, ...args].map((part) => (part === "" || /\s/.test(part) ? `"${part}"` : part)).join(" ");
}

export interface RawCommand {
	command: string;
	args?: string[];
	cwd?: string;
	timeoutSeconds?: number;
}

/** A setting's list as the editor's text, with the commands the text cannot hold (see FIXED_LINE) set aside. */
export function toEditor(list: unknown): { text: string; fixed: RawCommand[] } {
	const lines: string[] = [];
	const fixed: RawCommand[] = [];
	if (!Array.isArray(list)) return { text: "", fixed };
	for (const item of list as unknown[]) {
		const entry = item as Partial<RawCommand> | null;
		const plain =
			entry !== null &&
			typeof entry === "object" &&
			typeof entry.command === "string" &&
			!entry.command.includes('"') &&
			entry.cwd === undefined &&
			entry.timeoutSeconds === undefined &&
			(entry.args === undefined || (Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === "string" && !arg.includes('"'))));
		if (plain) {
			lines.push(formatSetupLine(entry.command!, entry.args ?? []));
			continue;
		}
		fixed.push(item as RawCommand);
		const why = entry && typeof entry === "object" ? [entry.cwd !== undefined ? `cwd ${String(entry.cwd)}` : "", entry.timeoutSeconds !== undefined ? `${String(entry.timeoutSeconds)} s` : ""].filter(Boolean).join(", ") : "";
		const shown = entry && typeof entry === "object" && typeof entry.command === "string" ? formatSetupLine(entry.command, Array.isArray(entry.args) ? entry.args.map(String) : []) : JSON.stringify(item);
		lines.push(`#fixed ${fixed.length}  ${shown}${why ? `  (${why})` : "  (set in settings.json)"}`);
	}
	return { text: lines.join("\n"), fixed };
}

/** The editor's text back to a list, `#fixed` lines replaced by the commands set aside. */
export function fromEditor(text: string, fixed: RawCommand[]): { commands: RawCommand[] } | { error: string } {
	const commands: RawCommand[] = [];
	let number = 0;
	for (const line of parseSetupText(text)) {
		number++;
		if (line.fixed !== undefined) {
			const kept = fixed[line.fixed - 1];
			if (!kept) return { error: `Line ${number}: there is no #fixed ${line.fixed}.` };
			commands.push(kept);
		} else if (line.argv === null) return { error: `Line ${number}: ${line.error}.` };
		else commands.push({ command: line.argv[0], ...(line.argv.length > 1 ? { args: line.argv.slice(1) } : {}) });
	}
	return { commands };
}
