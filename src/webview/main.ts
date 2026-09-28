/*
	The Rojo-Hub sidebar panel. Runs inside a VS Code webview; draws everything
	from the state the extension sends and posts every click back to it
	(src/common/panel.ts). All colours and icons come from VS Code's theme.

	Rendering is one function from (state, ui) to HTML. It redraws on every
	change, keeping the focused input, its caret and the scroll position, so
	typing in a search box survives the 2-second status updates.
*/

import { DEFAULT_PORT_RANGE, type GroupView, type SlotView, type TargetOption } from "../common/api";
import { pathBetween } from "../common/groups";
import type { Candidate, FromPanel, GroupMember, PanelState, ToPanel } from "../common/panel";

declare function acquireVsCodeApi(): { postMessage(message: FromPanel): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const send = (message: FromPanel) => vscode.postMessage(message);

/*
	Fold state the user chose. A key missing from `collapsed` uses its default
	(see folded()). v2 started over once, so everyone got the 0.13 defaults:
	sections open except Port settings, and only the first item in Projects open.
*/
interface Persisted {
	v: 2;
	collapsed: Record<string, boolean>;
	closedGroups: string[];
}
const loaded = vscode.getState() as Partial<Persisted> | undefined;
const saved: Persisted = loaded?.v === 2 ? (loaded as Persisted) : { v: 2, collapsed: {}, closedGroups: [] };

let state: PanelState | null = null;

interface Picker {
	id: string;
	search: string;
	options: TargetOption[] | null;
	error: string | null;
	/** The slot's targetsAt the list was asked for at; a newer one in the state means a newer list is ready. */
	at: number;
	fetching: boolean;
	fetchError: string | null;
	/** The New branch form, while it is open. */
	create: null | { name: string; base: string; error: string | null; busy: boolean };
}
const ui = {
	collapsed: saved.collapsed,
	closedGroups: new Set(saved.closedGroups),
	picker: null as null | Picker,
	/** Each project's last branch-picker list, so the picker opens with it drawn while a newer one is asked for. */
	targets: new Map<string, TargetOption[]>(),
	/** The project whose ⋯ menu is open. */
	menu: null as string | null,
	/** The Projects filter's text while the filter is open, else null. */
	filter: null as string | null,
	adding: null as null | { items: Candidate[] | null },
	newGroup: null as null | { name: string },
	renaming: null as null | { id: string; name: string },
	confirmDelete: null as string | null,
	/** The group whose Singleton is waiting for Yes/No. */
	confirmOnly: null as string | null,
	/** "Stop all" is waiting for Yes/No. */
	confirmStopAll: false,
	/** Resetting the port range is waiting for Yes/No. */
	confirmResetRange: false,
	/** A group member whose ✕ is waiting for Yes/No: "groupId|kind|memberId". */
	confirmRemoveMember: null as string | null,
	settings: null as null | { portRange: string; excluded: string; error: string | null },
	busy: new Set<string>(),
	flash: null as string | null,
	/** A project whose address was just copied: its port chips show a tick for a moment. */
	copied: null as string | null,
	/** A project to unfold (with its workspace) on the next render: after "goto" or a status bar click. */
	reveal: null as string | null,
	/** What is being dragged, while a drag is under way; renders wait until it ends. */
	drag: null as null | { list: string; key: string },
	/** Each drag list's keys in the order last drawn, for turning a drop into a new order. */
	lists: new Map<string, string[]>(),
};

/** Whether a foldable thing is folded: the user's choice if they made one, else its default. */
function folded(key: string, byDefault: boolean): boolean {
	return key in ui.collapsed ? ui.collapsed[key] : byDefault;
}

/** Sorts items by the user's saved order; anything not in it keeps its default place after those that are. */
function arrange<T>(items: T[], keyOf: (item: T) => string, order: string[]): T[] {
	const position = new Map(order.map((key, index) => [key, index]));
	return items
		.map((item, index) => ({ item, index, at: position.get(keyOf(item)) ?? Number.POSITIVE_INFINITY }))
		.sort((a, b) => a.at - b.at || a.index - b.index)
		.map(({ item }) => item);
}

/** The drag handle, and the attributes that make an element a drop target in a list. */
function grip(list: string, key: string): string {
	return `<span class="grip" draggable="true" data-drag-list="${escape(list)}" data-drag-key="${escape(key)}" title="Drag to reorder">${icon("gripper")}</span>`;
}
function dropAttributes(list: string, key: string): string {
	return `data-drop-list="${escape(list)}" data-drop-key="${escape(key)}"`;
}
function remember(list: string, keys: string[]): void {
	ui.lists.set(list, keys);
}

function persist(): void {
	vscode.setState({ v: 2, collapsed: ui.collapsed, closedGroups: [...ui.closedGroups] } satisfies Persisted);
}

const escape = (text: unknown) =>
	String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const icon = (name: string, extra = "") => `<i class="codicon codicon-${name} ${extra}" aria-hidden="true"></i>`;

function button(action: string, label: string, options: { icon?: string; data?: Record<string, string>; kind?: "primary" | "secondary" | "ghost" | "danger"; title?: string; disabled?: boolean } = {}): string {
	const data = Object.entries(options.data ?? {})
		.map(([key, value]) => ` data-${key}="${escape(value)}"`)
		.join("");
	return `<button class="btn ${options.kind ?? "ghost"}" data-action="${action}"${data} title="${escape(options.title ?? label)}"${options.disabled ? " disabled" : ""}>${options.icon ? icon(options.icon) : ""}${label ? `<span>${escape(label)}</span>` : ""}</button>`;
}

function iconButton(action: string, iconName: string, title: string, data: Record<string, string> = {}): string {
	return button(action, "", { icon: iconName, data, title, kind: "ghost" }).replace('class="btn ghost"', 'class="btn ghost icon-only"');
}

/* ---------- pieces ---------- */

function dot(slot: SlotView): string {
	if (slot.state === "starting") return `<span class="dot starting" title="Starting">${icon("loading", "codicon-modifier-spin")}</span>`;
	const kind =
		slot.state === "error" ? "error" : slot.state === "offline" ? "offline" : slot.state !== "running" ? "stopped" : slot.connections > 0 ? "connected" : "serving";
	const title = {
		error: "Error",
		offline: "Unavailable: Rojo-Hub's service is not running",
		stopped: "Stopped",
		connected: "Serving, Studio connected",
		serving: "Serving, no Studio connected",
	}[kind];
	return `<span class="dot ${kind}" title="${title}"></span>`;
}

/** A small coloured pill saying what the project is doing. */
function statusPill(slot: SlotView): string {
	if (slot.state === "running") {
		return slot.connections > 0
			? `<span class="pill ok" title="Serving, and Studio is connected">${icon("plug")}<span class="ellipsis">Connected${slot.connections > 1 ? ` · ${slot.connections}` : ""}</span></span>`
			: `<span class="pill live" title="Serving, waiting for Studio: connect Studio's Rojo plugin to this port">${icon("broadcast")}<span class="ellipsis">Serving</span></span>`;
	}
	if (slot.state === "starting") return `<span class="pill info">${icon("loading", "codicon-modifier-spin")}<span class="ellipsis">Starting…</span></span>`;
	if (slot.state === "error") return `<span class="pill bad">${icon("error")}<span class="ellipsis">Error</span></span>`;
	if (slot.state === "offline") return `<span class="pill">${icon("debug-disconnect")}<span class="ellipsis">Unavailable</span></span>`;
	return `<span class="pill">${icon("circle-slash")}<span class="ellipsis">Stopped</span></span>`;
}

function notices(slot: SlotView): string {
	const rows: string[] = [];
	if (slot.error) {
		// The first line says what went wrong; the rest (Rojo's own log lines) show in a block, last five.
		const [first, ...rest] = slot.error.split(/\r?\n/).filter((line) => line.trim());
		const tail = rest.slice(-5);
		rows.push(`<div class="notice error">${icon("error")}<div class="grow">
			<span>${escape(first)}</span>
			${tail.length ? `<pre class="log-tail">${escape(tail.join("\n"))}</pre><button class="link small" data-action="log" data-id="${escape(slot.id)}">Show full log</button>` : ""}
		</div></div>`);
	}
	for (const warning of slot.warnings) rows.push(`<div class="notice warning">${icon("warning")}<span>${escape(warning)}</span></div>`);
	return rows.join("");
}

/** "3 days ago" for a unix time in seconds. */
function ago(seconds: number): string {
	const minutes = Math.max(0, Math.round((Date.now() / 1000 - seconds) / 60));
	const steps: [number, string][] = [
		[60 * 24 * 365, "year"],
		[60 * 24 * 30, "month"],
		[60 * 24 * 7, "week"],
		[60 * 24, "day"],
		[60, "hour"],
		[1, "minute"],
	];
	for (const [size, unit] of steps) {
		const count = Math.floor(minutes / size);
		if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
	}
	return "just now";
}

/** Branch names to offer as a new branch's base: what the project serves first, then local, then remote. */
function baseChoices(slot: SlotView, options: TargetOption[]): string[] {
	const names = [
		slot.branch,
		...options.filter((option) => option.target.kind === "worktree" || !option.target.ref.startsWith("refs/remotes/")).map((option) => option.branch),
		...options.filter((option) => option.target.kind === "branch" && option.target.ref.startsWith("refs/remotes/")).map((option) => option.branch),
	];
	return [...new Set(names.filter((name): name is string => !!name))];
}

function newBranchForm(slot: SlotView, open: Picker): string {
	const form = open.create!;
	const bases = baseChoices(slot, open.options ?? []);
	return `<div class="create-branch">
		<label>New branch<input data-key="branch-name-${escape(slot.id)}" data-input="branch-name" value="${escape(form.name)}" placeholder="feature/something" spellcheck="false"${form.busy ? " disabled" : ""}></label>
		<label>From<select data-input="branch-base"${form.busy ? " disabled" : ""}>${bases
			.map((name) => `<option value="${escape(name)}"${name === form.base ? " selected" : ""}>${escape(name)}</option>`)
			.join("")}</select></label>
		<p class="muted small">Makes a worktree for it (in Orca when the repo is in Orca, else a folder beside the repo) so you can edit it, and ${escape(slot.projectName)} serves it. Studio stays connected.</p>
		${form.error ? `<div class="notice error">${icon("error")}<span>${escape(form.error)}</span></div>` : ""}
		<div class="row">${button("create-branch", form.busy ? "Creating…" : "Create", { icon: form.busy ? "loading" : "git-branch-create", kind: "primary", disabled: form.busy || !form.name.trim() })}${button("cancel-branch", "Back", { kind: "secondary", disabled: form.busy })}</div>
	</div>`;
}

function picker(slot: SlotView): string {
	const open = ui.picker;
	if (!open || open.id !== slot.id) return "";
	let body: string;
	if (open.create) body = newBranchForm(slot, open);
	else if (open.error) body = `<div class="notice error">${icon("error")}<span>${escape(open.error)}</span></div>`;
	else if (!open.options) body = `<div class="muted pad">${icon("loading", "codicon-modifier-spin")} Loading worktrees and branches…</div>`;
	else {
		const words = open.search.toLowerCase().split(/\s+/).filter(Boolean);
		const matches = open.options
			.map((option, index) => ({ option, index }))
			.filter(({ option }) => words.every((word) => `${option.label} ${option.description} ${option.branch ?? ""}`.toLowerCase().includes(word)));
		const isCurrent = (option: TargetOption) =>
			(option.target.kind === "worktree" && slot.target.kind === "worktree" && option.target.path.toLowerCase() === slot.target.path.toLowerCase()) ||
			(option.target.kind === "branch" && slot.target.kind === "branch" && option.target.ref === slot.target.ref);
		// Like Source Control's branch picker: worktrees, then local branches, then remote ones.
		const sectionOf = (option: TargetOption) =>
			option.target.kind === "worktree" ? "worktree" : option.target.ref.startsWith("refs/remotes/") ? "remote" : "local";
		const list = (section: "worktree" | "local" | "remote", heading: string, iconName: string, title: string) => {
			const rows = matches.filter(({ option }) => sectionOf(option) === section);
			if (rows.length === 0) return "";
			return `<div class="list-heading" title="${escape(title)}">${escape(heading)}<span class="list-count">${rows.length}</span></div>${rows
				.map(({ option, index }) => {
					const sub = section === "worktree" || !option.committedAt ? option.description : `last commit ${ago(option.committedAt)}`;
					return `<button class="list-item${isCurrent(option) ? " current" : ""}" data-action="pick" data-index="${index}">${icon(iconName)}<span class="grow"><span class="label">${escape(option.label)}</span><span class="sub">${escape(sub)}</span></span>${isCurrent(option) ? icon("check") : ""}</button>`;
				})
				.join("")}`;
		};
		// New branch is always last; with a search that names no existing branch, it offers that name.
		const typed = open.search.trim();
		const named = typed && !open.options.some((option) => option.branch === typed || option.label === typed) ? typed : "";
		const create = `<button class="list-item create" data-action="new-branch" data-name="${escape(named)}">${icon("add")}<span class="grow"><span class="label">${named ? `New branch “${escape(named)}”` : "New branch…"}</span><span class="sub">In a worktree of its own, served here</span></span></button>`;
		body =
			(matches.length === 0
				? `<div class="muted pad">Nothing matches “${escape(open.search)}”.</div>`
				: list("worktree", "Worktrees", "folder", "Folders checked out on this repo; served in place") +
					list("local", "Local branches", "git-branch", "Branches on this machine with no worktree; served from a Hub copy") +
					list("remote", "Remote branches", "cloud", "Branches on the remote with no local branch of the same name; served from a Hub copy")) + create;
	}
	const fetchButton = `<button class="btn ghost icon-only${open.fetching ? " spinning" : ""}" data-action="fetch" data-id="${escape(slot.id)}" title="${open.fetching ? "Fetching…" : "Fetch from remotes, for branches pushed since"}"${open.fetching ? " disabled" : ""}>${icon(open.fetching ? "loading" : "sync", open.fetching ? "codicon-modifier-spin" : "")}</button>`;
	return `<div class="picker">
		${
			open.create
				? ""
				: `<div class="search">${icon("search")}<input data-key="search-${escape(slot.id)}" data-input="search" placeholder="Search worktrees and branches" value="${escape(open.search)}" spellcheck="false">${fetchButton}</div>`
		}
		${open.fetchError ? `<div class="notice error picker-notice">${icon("error")}<span>Fetch failed: ${escape(open.fetchError)}</span></div>` : ""}
		<div class="list">${body}</div>
		<p class="hint">Studio stays connected when you switch.</p>
	</div>`;
}

/*
	A project card. Folded, it is one row (light, name, port, start/stop);
	open, the full card. `list` is the drag list it belongs to.
*/
function projectCard(slot: SlotView, list: string, foldedByDefault: boolean): string {
	const serving = slot.state === "running" || slot.state === "starting";
	const busy = ui.busy.has(`slot:${slot.id}`);
	const here = state?.here.includes(slot.id) ? `<span class="badge icon-badge" title="This window's project">${icon("window")}</span>` : "";
	const targetIcon = slot.target.kind === "worktree" ? "folder" : "git-branch";
	const pickerOpen = ui.picker?.id === slot.id;
	const key = `card:${slot.id}`;
	if (ui.reveal === slot.id) ui.collapsed[key] = false;
	const isFolded = folded(key, foldedByDefault) && !pickerOpen;
	const toggle = `<button class="group-toggle card-toggle" data-action="toggle-section" data-id="${escape(key)}" data-default="${foldedByDefault ? 1 : 0}" title="${isFolded ? "Show details" : "Fold"}" aria-expanded="${!isFolded}">${icon(isFolded ? "chevron-right" : "chevron-down")}${dot(slot)}<span class="name" title="${escape(slot.repoPath)}">${escape(slot.projectName)}</span></button>`;
	const port = portChip(slot);
	const attentionClass = slot.error ? " has-error" : slot.warnings.length ? " has-warning" : "";
	if (isFolded) {
		return `<article class="card project compact ${slot.state}${attentionClass}${ui.flash === slot.id ? " flash" : ""}" id="slot-${escape(slot.id)}" ${dropAttributes(list, slot.id)}>
			<div class="row card-head">${grip(list, slot.id)}${toggle}${slot.error ? icon("error", "bad") : slot.warnings.length ? icon("warning", "warn") : ""}${here}<span class="grow"></span>${port}${
				serving
					? iconButton("stop", "debug-stop", `Stop ${slot.projectName}`, { id: slot.id })
					: iconButton("start", "play", `Start ${slot.projectName}`, { id: slot.id })
			}</div>
		</article>`;
	}
	return `<article class="card project ${slot.state}${ui.flash === slot.id ? " flash" : ""}" id="slot-${escape(slot.id)}" ${dropAttributes(list, slot.id)}>
		<div class="row card-head">
			${grip(list, slot.id)}${toggle}${here}
			<span class="grow"></span>
			${port}
		</div>
		<button class="target${pickerOpen ? " open" : ""}" data-action="picker" data-id="${escape(slot.id)}" title="Switch worktree or branch">
			${icon(targetIcon)}<span class="grow ellipsis">${escape(slot.targetLabel || "—")}</span>${icon(pickerOpen ? "chevron-up" : "chevron-down")}
		</button>
		${picker(slot)}
		${notices(slot)}
		<div class="row card-foot">
			${statusPill(slot)}
			<span class="grow"></span>
			${ui.busy.has(`build:${slot.id}`) ? `<span class="btn ghost icon-only" title="Building a place file…">${icon("loading", "codicon-modifier-spin")}</span>` : ""}
			${cardMenu(slot)}
			${
				serving
					? button("stop", "Stop", { icon: "debug-stop", data: { id: slot.id }, kind: "secondary", disabled: busy })
					: button("start", "Start", { icon: "play", data: { id: slot.id }, kind: "primary", disabled: busy })
			}
		</div>
	</article>`;
}

function adder(): string {
	if (!ui.adding) return "";
	const items = ui.adding.items;
	const rows =
		items === null
			? `<div class="muted pad">${icon("loading", "codicon-modifier-spin")} Looking for projects…</div>`
			: items.length === 0
				? `<div class="muted pad">No other open folders or Orca repos found. Browse to pick a folder.</div>`
				: items
						.map(
							(item) =>
								`<button class="list-item" data-action="add" data-path="${escape(item.path)}">${icon(item.source === "orca" ? "repo" : "folder")}<span class="grow"><span class="label">${escape(item.label)}</span><span class="sub">${escape(item.path)}</span></span>${icon("add")}</button>`,
						)
						.join("");
	return `<div class="card adder">
		<div class="row"><strong>Add a project</strong><span class="grow"></span>${iconButton("close-adder", "close", "Cancel")}</div>
		<p class="muted small">Any folder with a <code>default.project.json</code>. It gets its own port.</p>
		<div class="list">${rows}</div>
		<div class="row">${button("browse", "Browse…", { icon: "folder-opened", kind: "secondary" })}</div>
	</div>`;
}

/*
	A row inside a group card. Its ✕ asks first, in place: taking something
	out of a group is easy to do by accident and does not undo itself.
*/
function memberRow(group: GroupView, kind: "project" | "group", memberId: string, name: string, body: string): string {
	const key = `${group.id}|${kind}|${memberId}`;
	if (ui.confirmRemoveMember === key) {
		return `<div class="member confirm-row">
			${icon("warning")}<span class="grow">Take <strong>${escape(name)}</strong> out of ${escape(group.name)}?</span>
			${button("remove-member-yes", "Yes", { kind: "danger", data: { id: group.id, kind, member: memberId }, title: kind === "group" ? "The group itself stays" : "The project stays in Rojo-Hub" })}
			${button("remove-member-no", "No", { kind: "secondary" })}
		</div>`;
	}
	return `<div class="member">${body}${iconButton("remove-member", "close", `Take ${name} out of ${group.name} (asks first)`, { id: group.id, kind, member: memberId })}</div>`;
}

/** The card's ⋯ button and, while it is open, its menu of less frequent actions. */
function cardMenu(slot: SlotView): string {
	const open = ui.menu === slot.id;
	const item = (action: string, iconName: string, label: string, extra = "") =>
		`<button class="menu-item${extra}" role="menuitem" data-action="${action}" data-id="${escape(slot.id)}">${icon(iconName)}<span>${escape(label)}</span></button>`;
	return `<span class="menu-anchor">
		<button class="btn ghost icon-only${open ? " open" : ""}" data-action="menu" data-id="${escape(slot.id)}" title="More actions" aria-haspopup="menu" aria-expanded="${open}">${icon("ellipsis")}</button>
		${
			open
				? `<div class="menu" role="menu">
					${item("build", "package", "Build place file…")}
					${item("log", "output", "Show Rojo log")}
					<div class="menu-separator"></div>
					${item("remove", "trash", "Remove from Rojo-Hub…", " danger")}
				</div>`
				: ""
		}
	</span>`;
}

/** A port chip that copies localhost:<port>; it shows a tick for a moment after a copy. */
function portChip(slot: SlotView, host = false): string {
	const copied = ui.copied === slot.id;
	const title = copied ? "Copied" : `Copy localhost:${slot.port}${slot.portSource === "servePort" ? " (from servePort)" : ""}`;
	return `<button class="port${copied ? " copied" : ""}" data-action="copy" data-id="${escape(slot.id)}" title="${title}"><span>${host ? `<span class="host">localhost</span>` : ""}:${slot.port}</span>${icon(copied ? "check" : "copy", "port-icon")}</button>`;
}

/** Serving projects that Singleton would stop for a group. */
function wouldStop(group: GroupView): SlotView[] {
	return (state?.slots ?? []).filter((slot) => (slot.state === "running" || slot.state === "starting") && !group.projectIds.includes(slot.id));
}

function groupCard(group: GroupView): string {
	const slots = state?.slots ?? [];
	const groups = state?.groups ?? [];
	const members = group.slotIds.map((id) => slots.find((slot) => slot.id === id)).filter((slot): slot is SlotView => !!slot);
	const nested = group.groupIds.map((id) => groups.find((entry) => entry.id === id)).filter((entry): entry is GroupView => !!entry);
	const everyProject = group.projectIds.map((id) => slots.find((slot) => slot.id === id)).filter((slot): slot is SlotView => !!slot);
	const serving = everyProject.filter((slot) => slot.state === "running").length;
	const open = !ui.closedGroups.has(group.id);
	const busy = ui.busy.has(`group:${group.id}`);
	const renaming = ui.renaming?.id === group.id;
	const running = group.active ? `<span class="pill ok dense" title="Started, and not stopped since">Running</span>` : "";
	const head = renaming
		? `<input class="rename" data-key="rename-${escape(group.id)}" data-input="rename" value="${escape(ui.renaming!.name)}" spellcheck="false">
		   ${iconButton("rename-save", "check", "Save name", { id: group.id })}${iconButton("rename-cancel", "close", "Cancel")}`
		: `${grip("groups", group.id)}<button class="group-toggle" data-action="toggle-group" data-id="${escape(group.id)}" title="${open ? "Collapse" : "Expand"}">${icon(open ? "chevron-down" : "chevron-right")}${icon("layers")}<span class="name">${escape(group.name)}</span></button>
		   <span class="count${serving > 0 && serving === everyProject.length ? " all" : ""}" title="${serving} of ${everyProject.length} projects serving">${serving}/${everyProject.length}</span>${running}
		   <span class="grow"></span>
		   <span class="hover-tools">${iconButton("rename", "edit", "Rename group", { id: group.id })}${iconButton("ask-delete", "trash", "Delete group (what's in it stays)", { id: group.id })}</span>`;
	// Deleting asks first, on its own row under the name, the same way taking a member out does.
	const deleteConfirm =
		ui.confirmDelete === group.id
			? `<div class="member confirm-row">${icon("warning")}<span class="grow">Delete <strong>${escape(group.name)}</strong>? What's in it stays.</span>${button("delete-group", "Delete", { data: { id: group.id }, kind: "danger" })}${button("cancel-delete", "No", { kind: "secondary" })}</div>`
			: "";
	if (!open) return `<article class="card group${group.active ? " active" : ""}" id="group-${escape(group.id)}" ${dropAttributes("groups", group.id)}><div class="row head">${head}</div>${deleteConfirm}</article>`;

	const nestedRows = nested
		.map((child) => {
			const childSlots = child.projectIds.map((id) => slots.find((slot) => slot.id === id)).filter((slot): slot is SlotView => !!slot);
			const childServing = childSlots.filter((slot) => slot.state === "running").length;
			return memberRow(
				group,
				"group",
				child.id,
				child.name,
				`${icon("layers")}
				<button class="link grow ellipsis" data-action="goto-group" data-id="${escape(child.id)}" title="Show ${escape(child.name)}">${escape(child.name)}</button>
				<span class="sub ellipsis">group · ${childServing}/${childSlots.length}</span>`,
			);
		})
		.join("");
	const projectRows = members
		.map(
			(slot) =>
				memberRow(
					group,
					"project",
					slot.id,
					slot.projectName,
					`${dot(slot)}
				<button class="link grow ellipsis" data-action="goto" data-id="${escape(slot.id)}" title="Show ${escape(slot.projectName)} (${escape(slot.targetLabel)})">${escape(slot.projectName)}</button>
				${portChip(slot)}`,
				),
		)
		.join("");

	const projectChoices = slots.filter((slot) => !group.slotIds.includes(slot.id));
	const groupChoices = groups
		.filter((other) => other.id !== group.id && !group.groupIds.includes(other.id))
		.map((other) => ({ other, loop: pathBetween(groups, other.id, group.id) }));
	const workspaceChoices = (state?.workspaces ?? [])
		.filter((workspace) => workspace.slotIds.length > 0)
		.map((workspace) => ({ workspace, missing: workspace.slotIds.filter((id) => !group.slotIds.includes(id)) }));
	const nameOf = (id: string) => groups.find((entry) => entry.id === id)?.name ?? id;
	const workspaceOption = ({ workspace, missing }: (typeof workspaceChoices)[number]) => {
		const notAdded = workspace.addable.length ? ` · ${workspace.addable.length} folder${workspace.addable.length === 1 ? "" : "s"} not added to Rojo-Hub yet` : "";
		return missing.length === 0
			? `<option disabled>${escape(workspace.name)}  (all its projects are in this group)</option>`
			: `<option value="workspace:${escape(workspace.file)}" title="${escape(workspace.file)}">${escape(workspace.name)}  (adds ${missing.length} project${missing.length === 1 ? "" : "s"}${notAdded})</option>`;
	};
	const adder =
		projectChoices.length + groupChoices.length + workspaceChoices.filter((choice) => choice.missing.length > 0).length === 0
			? slots.length === 0
				? `<div class="muted small pad">Add projects above first.</div>`
				: `<div class="muted small pad">Everything is already in this group.</div>`
			: `<div class="add-member">${icon("add")}<select data-action="add-member" data-id="${escape(group.id)}" title="Add a project, a group or a workspace's projects to ${escape(group.name)}">
				<option value="">Add a project, group or workspace…</option>
				${workspaceChoices.length ? `<optgroup label="Workspaces · adds each of their projects">${workspaceChoices.map(workspaceOption).join("")}</optgroup>` : ""}
				${projectChoices.length ? `<optgroup label="Projects">${projectChoices.map((slot) => `<option value="project:${escape(slot.id)}">${escape(slot.projectName)}  :${slot.port}</option>`).join("")}</optgroup>` : ""}
				${
					groupChoices.length
						? `<optgroup label="Groups">${groupChoices
								.map(({ other, loop }) =>
									loop
										? `<option disabled title="${escape(loop.map(nameOf).join(" → "))}">${escape(other.name)}  (would loop: it contains ${escape(group.name)})</option>`
										: `<option value="group:${escape(other.id)}">${escape(other.name)}  (${other.projectIds.length} projects)</option>`,
								)
								.join("")}</optgroup>`
						: ""
				}
			</select></div>`;

	const stopping = wouldStop(group);
	const onlyConfirm =
		ui.confirmOnly === group.id
			? `<div class="notice warning confirm-only">${icon("warning")}<span class="grow">${
					stopping.length === 0
						? `Singleton: serve only ${escape(group.name)}? Nothing outside it is serving, so this just starts it.`
						: `Singleton: serve only ${escape(group.name)}? This stops <strong>${stopping.map((slot) => escape(slot.projectName)).join(", ")}</strong>, and Studio places connected to them disconnect.`
				}</span></div>
				<div class="row">${button("solo-group-yes", "Yes, singleton", { icon: "target", data: { id: group.id }, kind: "primary" })}${button("solo-group-no", "Cancel", { kind: "secondary" })}</div>`
			: "";

	return `<article class="card group open${group.active ? " active" : ""}" id="group-${escape(group.id)}" ${dropAttributes("groups", group.id)}>
		<div class="row head">${head}</div>
		${deleteConfirm}
		<div class="members">
			${nestedRows}${projectRows}
			${nested.length + members.length === 0 ? `<div class="muted pad small">Empty. Add projects or other groups below.</div>` : ""}
		</div>
		${adder}
		<div class="row actions">
			${
				group.active
					? button("stop-group", "Stop", { icon: "debug-stop", data: { id: group.id }, kind: "secondary", disabled: busy, title: "Stop this group's projects, except ones another running group uses" })
					: button("start-group", "Start", { icon: "play", data: { id: group.id }, kind: "primary", disabled: busy || everyProject.length === 0, title: `Serve all ${everyProject.length} projects in this group` })
			}
			${button("solo-group", "Singleton", { icon: "target", data: { id: group.id }, kind: "secondary", disabled: busy || everyProject.length === 0, title: "Serve only this group: stop every other project (asks first)" })}
		</div>
		${onlyConfirm}
	</article>`;
}

function newGroupForm(): string {
	if (!ui.newGroup) return "";
	return `<div class="card adder">
		<div class="row"><strong>New group</strong><span class="grow"></span>${iconButton("close-new-group", "close", "Cancel")}</div>
		<div class="row"><input data-key="new-group" data-input="new-group" placeholder="Group name, e.g. Laundry Shift" value="${escape(ui.newGroup.name)}" spellcheck="false"></div>
		<div class="row">${button("create-group", "Create", { icon: "check", kind: "primary", disabled: !ui.newGroup.name.trim() })}<span class="muted small">Then add projects with its dropdown.</span></div>
	</div>`;
}

function settingsBody(): string {
	const current = state!.settings;
	const draft = ui.settings ?? { portRange: current.portRange, excluded: current.excludedPorts.join(", "), error: null };
	const changed = draft.portRange !== current.portRange || draft.excluded !== current.excludedPorts.join(", ");
	const isDefault = current.portRange.replace(/\s+/g, "") === DEFAULT_PORT_RANGE;
	const fromRange = (state?.slots ?? []).filter((slot) => slot.portSource === "hash").length;
	const resetConfirm = ui.confirmResetRange
		? `<div class="notice warning">${icon("warning")}<span class="grow">Reset the port range to <strong>${DEFAULT_PORT_RANGE}</strong>? ${
				fromRange === 0
					? "No project gets its port from the range right now, so no port changes."
					: `${fromRange} project${fromRange === 1 ? " gets its" : "s get their"} port from the range, so ${fromRange === 1 ? "its port" : "their ports"} may change; any that are serving restart on the new port and Studio must reconnect.`
			}</span></div>
			<div class="row">${button("reset-range-yes", "Yes, reset", { icon: "discard", kind: "primary" })}${button("reset-range-no", "Cancel", { kind: "secondary" })}</div>`
		: "";
	return `<div class="card settings">
		<div class="row label-row"><label for="port-range">Port range</label><span class="grow"></span>${button("reset-range", "Reset", { icon: "discard", kind: "ghost", disabled: isDefault || ui.confirmResetRange, title: isDefault ? `Already the default, ${DEFAULT_PORT_RANGE}` : `Back to the default range, ${DEFAULT_PORT_RANGE} (asks first)` })}</div>
		<input id="port-range" data-key="port-range" data-input="port-range" value="${escape(draft.portRange)}" placeholder="${DEFAULT_PORT_RANGE}" spellcheck="false">
		${resetConfirm}
		<p class="muted small">Projects get a port in this range, worked out from their repo's first commit, unless their project file sets <code>servePort</code>.${isDefault ? " This is the default." : ` The default is ${DEFAULT_PORT_RANGE}.`}</p>
		<label>Excluded ports<input data-key="excluded" data-input="excluded" value="${escape(draft.excluded)}" placeholder="35000, 35100-35110" spellcheck="false"></label>
		<p class="muted small">Never given to any project. 34872 (Rojo's default) is always excluded.</p>
		${draft.error ? `<div class="notice error">${icon("error")}<span>${escape(draft.error)}</span></div>` : ""}
		<div class="row">${button("save-settings", "Save", { icon: "check", kind: "primary", disabled: !changed })}${changed ? button("reset-settings", "Undo", { kind: "secondary" }) : ""}</div>
	</div>`;
}

/** Top-level sections are open by default, except Port settings. */
function section(key: string, title: string, iconName: string, count: string, extra: string, body: string): string {
	const byDefault = key === "settings";
	const collapsed = folded(key, byDefault);
	return `<section class="section${collapsed ? " collapsed" : ""}">
		<div class="section-head">
			<button class="section-toggle" data-action="toggle-section" data-id="${key}" data-default="${byDefault ? 1 : 0}" aria-expanded="${!collapsed}">${icon(collapsed ? "chevron-right" : "chevron-down")}${icon(iconName)}<span>${escape(title)}</span>${count ? `<span class="count">${escape(count)}</span>` : ""}</button>
			<span class="grow"></span>${extra}
		</div>
		${collapsed ? "" : `<div class="section-body">${body}</div>`}
	</section>`;
}

/*
	The Projects list, grouped by VS Code workspace when projects belong to
	one. Purely visual: each project is drawn once, under the first workspace
	that lists it (the window's own workspace first); other workspaces that
	also list it show a short row that jumps to its card.
*/
function projectsList(slots: SlotView[], filtering = false): string {
	const order = state?.order?.projects ?? [];
	const workspaces = state?.workspaces ?? [];
	ui.lists.clear();
	if (workspaces.length === 0) {
		const cards = arrange(slots, (slot) => slot.id, order);
		remember("cards:root", cards.map((slot) => slot.id));
		return cards.map((slot, index) => projectCard(slot, "cards:root", index > 0)).join("");
	}
	const home = new Map<string, string>();
	const present = new Set(slots.map((slot) => slot.id));
	for (const workspace of workspaces) for (const id of workspace.slotIds) if (!home.has(id) && present.has(id)) home.set(id, workspace.file);
	const byId = new Map(slots.map((slot) => [slot.id, slot]));

	interface Block {
		key: string;
		draw: (foldedByDefault: boolean) => string;
		holds: string[];
	}
	const blocks: Block[] = workspaces.map((workspace) => {
		const key = `ws:${workspace.file}`;
		const list = `cards:${key}`;
		const own = arrange(
			workspace.slotIds.filter((id) => home.get(id) === workspace.file).map((id) => byId.get(id)).filter((slot): slot is SlotView => !!slot),
			(slot) => slot.id,
			order,
		);
		remember(list, own.map((slot) => slot.id));
		const draw = (foldedByDefault: boolean) => {
			if (ui.reveal && own.some((slot) => slot.id === ui.reveal)) ui.collapsed[key] = false;
			// While filtering, every workspace with a match is open and the rest are hidden.
			const collapsed = !filtering && folded(key, foldedByDefault);
			const elsewhere = workspace.slotIds.filter((id) => home.get(id) !== workspace.file).map((id) => byId.get(id)).filter((slot): slot is SlotView => !!slot);
			if (filtering && own.length + elsewhere.length === 0) return "";
			const serving = workspace.slotIds.map((id) => byId.get(id)).filter((slot) => slot && slot.state === "running").length;
			const head = `<div class="row workspace-head">
				${grip("blocks", key)}
				<button class="group-toggle" data-action="toggle-section" data-id="${escape(key)}" data-default="${foldedByDefault ? 1 : 0}" title="${escape(workspace.file)}">${icon(collapsed ? "chevron-right" : "chevron-down")}${icon("folder-library")}<span class="name">${escape(workspace.name)}</span></button>
				${workspace.slotIds.length ? `<span class="count" title="${serving} of ${workspace.slotIds.length} serving">${serving}/${workspace.slotIds.length}</span>` : ""}
				${workspace.isWindow ? `<span class="badge icon-badge" title="The workspace this window has open">${icon("window")}</span>` : ""}
				<span class="grow"></span>
				${workspace.slotIds.length ? button("group-workspace", "Group", { icon: "layers", kind: "ghost", data: { file: workspace.file }, title: `Make a group of this workspace's ${workspace.slotIds.length} project${workspace.slotIds.length === 1 ? "" : "s"}` }) : ""}
			</div>`;
			if (collapsed) return `<div class="workspace" ${dropAttributes("blocks", key)}>${head}</div>`;
			const elsewhereRows = elsewhere
				.map(
					(slot) => `<div class="member">${dot(slot)}<button class="link grow ellipsis" data-action="goto" data-id="${escape(slot.id)}" title="Show ${escape(slot.projectName)}">${escape(slot.projectName)}</button><span class="sub ellipsis">shown above</span></div>`,
				)
				.join("");
			const addableRows = (filtering ? [] : workspace.addable)
				.map(
					(folder) => `<div class="member addable">${icon("folder")}<span class="grow ellipsis" title="${escape(folder.path)}">${escape(folder.label)}</span><span class="sub">not added</span>${button("add", "Add", { icon: "add", kind: "secondary", data: { path: folder.path }, title: `Add ${folder.label} to Rojo-Hub` })}</div>`,
				)
				.join("");
			const addAll = !filtering && workspace.addable.length > 1 ? `<div class="row">${button("add-workspace", `Add all ${workspace.addable.length}`, { icon: "add", kind: "secondary", data: { file: workspace.file } })}</div>` : "";
			return `<div class="workspace" ${dropAttributes("blocks", key)}>${head}<div class="workspace-body">${own.map((slot) => projectCard(slot, list, false)).join("")}${elsewhereRows}${addableRows}${addAll}</div></div>`;
		};
		return { key, draw, holds: own.map((slot) => slot.id) };
	});

	const loose = arrange(slots.filter((slot) => !home.has(slot.id)), (slot) => slot.id, order);
	if (loose.length > 0) {
		const key = "ws:other";
		const list = "cards:ws:other";
		remember(list, loose.map((slot) => slot.id));
		blocks.push({
			key,
			holds: loose.map((slot) => slot.id),
			draw: (foldedByDefault) => {
				if (ui.reveal && loose.some((slot) => slot.id === ui.reveal)) ui.collapsed[key] = false;
				const collapsed = !filtering && folded(key, foldedByDefault);
				return `<div class="workspace other" ${dropAttributes("blocks", key)}>
					<div class="row workspace-head">${grip("blocks", key)}<button class="group-toggle" data-action="toggle-section" data-id="${key}" data-default="${foldedByDefault ? 1 : 0}">${icon(collapsed ? "chevron-right" : "chevron-down")}${icon("folder")}<span class="name">Other projects</span></button><span class="count">${loose.length}</span></div>
					${collapsed ? "" : `<div class="workspace-body">${loose.map((slot) => projectCard(slot, list, false)).join("")}</div>`}
				</div>`;
			},
		});
	}
	const arranged = arrange(blocks, (block) => block.key, order);
	remember("blocks", arranged.map((block) => block.key));
	// Only the first block starts open; the rest are folded until opened.
	return arranged.map((block, index) => block.draw(index > 0)).join("");
}

/*
	Every project serving right now, with its address to copy: the quickest way
	to get a port into Studio's Rojo plugin.
*/
function activePorts(serving: SlotView[]): string {
	if (serving.length === 0) return `<div class="empty compact">${icon("plug", "empty-icon")}<p class="muted small">Nothing serving. Start a project or a group and its port shows here.</p></div>`;
	const rows = [...serving]
		.sort((a, b) => a.port - b.port)
		.map(
			(slot) => `<div class="member active-port">
				${dot(slot)}
				<span class="grow two-line"><button class="link ellipsis" data-action="goto" data-id="${escape(slot.id)}" title="Show ${escape(slot.projectName)}">${escape(slot.projectName)}</button><span class="sub ellipsis">${escape(slot.targetLabel)}</span></span>
				${portChip(slot, true)}
			</div>`,
		)
		.join("");
	return `<div class="card ports">${rows}</div>`;
}

/* ---------- whole panel ---------- */

function render(): void {
	const app = document.getElementById("app")!;
	if (!state || ui.drag) return;

	const active = document.activeElement as HTMLInputElement | null;
	const focusKey = active?.dataset?.key;
	const selection = focusKey ? [active!.selectionStart, active!.selectionEnd] : null;
	const scrolls = [...app.querySelectorAll<HTMLElement>(".list")].map((list) => list.scrollTop);
	const pageScroll = document.scrollingElement?.scrollTop ?? 0;

	const slots = [...state.slots].sort((a, b) => Number(state!.here.includes(b.id)) - Number(state!.here.includes(a.id)));
	const servingCount = slots.filter((slot) => slot.state === "running").length;

	const filterRow =
		ui.filter === null
			? ""
			: `<div class="filter">${icon("search")}<input data-key="filter" data-input="filter" value="${escape(ui.filter)}" placeholder="Filter by name, branch or port" spellcheck="false">${iconButton("toggle-filter", "close", "Clear and close the filter")}</div>`;
	const words = (ui.filter ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	const shown = words.length ? slots.filter((slot) => words.every((word) => `${slot.projectName} ${slot.targetLabel} ${slot.branch ?? ""} ${slot.port}`.toLowerCase().includes(word))) : slots;
	const projectsBody =
		filterRow +
		adder() +
		(slots.length === 0
			? `<div class="empty">
				${icon("server-environment", "empty-icon")}
				<p class="empty-title">No projects yet</p>
				<p class="muted small">Each project gets its own Rojo port. Switch it to any branch while Studio stays connected.</p>
				${button("open-adder", "Add a project", { icon: "add", kind: "primary" })}
				${button("walkthrough", "Getting started guide", { icon: "book", kind: "ghost" })}
			</div>`
			: shown.length === 0
				? `<div class="empty compact">${icon("search", "empty-icon")}<p class="muted small">No project matches “${escape(ui.filter ?? "")}”.</p></div>`
				: projectsList(shown, words.length > 0));

	const groupsBody =
		newGroupForm() +
		(state.groups.length === 0 && !ui.newGroup
			? `<div class="empty compact">
				${icon("layers", "empty-icon")}
				<p class="muted small">Groups start and stop sets of projects together, like profiles.</p>
				${button("open-new-group", "New group", { icon: "add", kind: "secondary" })}
			</div>`
			: (() => {
					const groups = arrange(state.groups, (group) => group.id, state.order?.groups ?? []);
					remember("groups", groups.map((group) => group.id));
					return groups.map(groupCard).join("");
				})());

	const serving = slots.filter((slot) => slot.state === "running" || slot.state === "starting");
	const footer = ui.confirmStopAll
		? `<div class="notice warning">${icon("warning")}<span class="grow">Stop all ${serving.length} serving project${serving.length === 1 ? "" : "s"}: <strong>${serving
				.map((slot) => escape(slot.projectName))
				.join(", ")}</strong>? Studio places connected to them disconnect.</span></div>
			<div class="row">${button("stop-all-yes", "Yes, stop all", { icon: "debug-stop", kind: "danger" })}${button("stop-all-no", "Cancel", { kind: "secondary" })}</div>`
		: `<div class="row"><span class="summary${serving.length ? " live" : ""}">${serving.length === 0 ? "Nothing serving" : `${serving.length} of ${slots.length} serving`}</span><span class="grow"></span>${button("stop-all", "Stop all", { icon: "debug-stop", kind: "secondary", disabled: serving.length === 0, title: "Stop every serving project (asks first)" })}${iconButton("refresh", "refresh", "Refresh")}</div>`;

	// The service is invisible unless it could not be started at all.
	const banner = state.service.error
		? `<div class="card banner">
			<div class="row">${icon("error")}<strong>Rojo-Hub could not start</strong></div>
			<p class="muted small">${escape(state.service.error)} Your projects and groups are saved and shown below.</p>
			<div class="row">${button("refresh", "Try again", { icon: "refresh", kind: "primary" })}</div>
		</div>`
		: "";

	app.innerHTML = `
		${banner}
		${section("projects", "Projects", "server-environment", slots.length ? `${servingCount}/${slots.length} serving` : "", (slots.length ? iconButton("toggle-filter", ui.filter === null ? "filter" : "filter-filled", ui.filter === null ? "Filter projects" : "Close the filter") : "") + iconButton("open-adder", "add", "Add a project"), projectsBody)}
		${section("groups", "Groups", "layers", state.groups.length ? String(state.groups.length) : "", iconButton("open-new-group", "add", "New group"), groupsBody)}
		${section("ports", "Active ports", "plug", serving.length ? String(serving.length) : "", "", activePorts(serving))}
		${section("settings", "Port settings", "settings-gear", "", "", settingsBody())}
		<footer class="footer">${footer}</footer>`;

	if (focusKey) {
		const again = app.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(focusKey)}"]`);
		if (again) {
			again.focus();
			if (selection && selection[0] !== null) again.setSelectionRange(selection[0], selection[1]);
		}
	}
	app.querySelectorAll<HTMLElement>(".list").forEach((list, index) => (list.scrollTop = scrolls[index] ?? 0));
	if (document.scrollingElement) document.scrollingElement.scrollTop = pageScroll;
	if (ui.reveal) {
		ui.reveal = null;
		persist();
	}
}

/* ---------- events ---------- */

function parseExcluded(text: string): { values: (number | string)[]; bad: string | null } {
	const values: (number | string)[] = [];
	for (const raw of text.split(/[,\s]+/).filter(Boolean)) {
		if (/^\d+$/.test(raw)) values.push(Number(raw));
		else if (/^\d+-\d+$/.test(raw)) values.push(raw);
		else return { values, bad: raw };
	}
	return { values, bad: null };
}

function openPicker(id: string): void {
	if (ui.picker?.id === id) {
		ui.picker = null;
	} else {
		ui.picker = { id, search: "", options: ui.targets.get(id) ?? null, error: null, at: state?.slots.find((slot) => slot.id === id)?.targetsAt ?? 0, fetching: false, fetchError: null, create: null };
		send({ type: "targets", id });
	}
	render();
	if (ui.picker) document.querySelector<HTMLInputElement>(`[data-key="search-${CSS.escape(id)}"]`)?.focus();
}

function pick(index: number): void {
	const open = ui.picker;
	const option = open?.options?.[index];
	if (!open || !option) return;
	send({ type: "switch", id: open.id, target: option.target, label: option.label });
	ui.picker = null;
	render();
}

function createBranch(): void {
	const open = ui.picker;
	const form = open?.create;
	if (!open || !form || form.busy || !form.name.trim()) return;
	form.busy = true;
	form.error = null;
	send({ type: "createBranch", id: open.id, name: form.name.trim(), base: form.base });
	render();
}

function createGroup(): void {
	const name = ui.newGroup?.name.trim();
	if (!name) return;
	send({ type: "newGroup", name });
	ui.newGroup = null;
	render();
}

function saveSettings(): void {
	const draft = ui.settings;
	if (!draft) return;
	if (!/^\s*\d+\s*-\s*\d+\s*$/.test(draft.portRange)) {
		draft.error = "Write the port range as first-last, for example 34873-35872.";
		return render();
	}
	const excluded = parseExcluded(draft.excluded);
	if (excluded.bad) {
		draft.error = `“${excluded.bad}” is not a port or a range like 35000-35010.`;
		return render();
	}
	send({ type: "saveSettings", portRange: draft.portRange.replace(/\s+/g, ""), excludedPorts: excluded.values });
	ui.settings = null;
	render();
}

document.addEventListener("click", (event) => {
	const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
	// Any click closes an open ⋯ menu (a menu item still runs its action).
	if (ui.menu && target?.dataset.action !== "menu") {
		ui.menu = null;
		render();
		if (!target) return;
	}
	if (!target || target.tagName === "SELECT") return;
	const { action, id = "", index, path } = target.dataset;
	switch (action) {
		case "toggle-section":
			ui.collapsed[id] = !folded(id, target.dataset.default === "1");
			persist();
			return render();
		case "toggle-group":
			if (ui.closedGroups.has(id)) ui.closedGroups.delete(id);
			else ui.closedGroups.add(id);
			persist();
			return render();
		case "picker":
			return openPicker(id);
		case "pick":
			return pick(Number(index));
		case "menu":
			ui.menu = ui.menu === id ? null : id;
			render();
			document.querySelector<HTMLElement>(".menu .menu-item")?.focus();
			return;
		case "fetch":
			if (!ui.picker) return;
			ui.picker.fetching = true;
			ui.picker.fetchError = null;
			send({ type: "fetch", id });
			return render();
		case "new-branch": {
			const open = ui.picker;
			const slot = state?.slots.find((entry) => entry.id === open?.id);
			if (!open || !slot) return;
			open.create = { name: target.dataset.name ?? "", base: baseChoices(slot, open.options ?? [])[0] ?? "", error: null, busy: false };
			render();
			document.querySelector<HTMLInputElement>(`[data-key="branch-name-${CSS.escape(slot.id)}"]`)?.focus();
			return;
		}
		case "cancel-branch":
			if (ui.picker) ui.picker.create = null;
			render();
			document.querySelector<HTMLInputElement>(".picker .search input")?.focus();
			return;
		case "create-branch":
			return createBranch();
		case "build":
			ui.busy.add(`build:${id}`);
			send({ type: "build", id });
			return render();
		case "toggle-filter":
			ui.filter = ui.filter === null ? "" : null;
			ui.collapsed.projects = false;
			render();
			document.querySelector<HTMLInputElement>('[data-key="filter"]')?.focus();
			return;
		case "start":
		case "stop":
			ui.busy.add(`slot:${id}`);
			send({ type: action, id });
			return render();
		case "copy":
			send({ type: "copy", id });
			ui.copied = id;
			render();
			setTimeout(() => {
				if (ui.copied === id) {
					ui.copied = null;
					render();
				}
			}, 1400);
			return;
		case "log":
			return send({ type: "log", id });
		case "remove":
			return send({ type: "remove", id });
		case "open-adder":
			ui.collapsed.projects = false;
			ui.adding = { items: null };
			send({ type: "candidates" });
			return render();
		case "close-adder":
			ui.adding = null;
			return render();
		case "add":
			ui.adding = null;
			send({ type: "addProject", path: path ?? "" });
			return render();
		case "browse":
			ui.adding = null;
			send({ type: "browse" });
			return render();
		case "open-new-group":
			ui.collapsed.groups = false;
			ui.newGroup = { name: "" };
			render();
			document.querySelector<HTMLInputElement>('[data-key="new-group"]')?.focus();
			return;
		case "close-new-group":
			ui.newGroup = null;
			return render();
		case "create-group":
			return createGroup();
		case "goto":
			return flash(id);
		case "goto-group":
			ui.closedGroups.delete(id);
			persist();
			render();
			document.getElementById(`group-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
			return;
		case "remove-member":
			ui.confirmRemoveMember = `${id}|${target.dataset.kind === "group" ? "group" : "project"}|${target.dataset.member ?? ""}`;
			return render();
		case "remove-member-no":
			ui.confirmRemoveMember = null;
			return render();
		case "remove-member-yes":
			ui.confirmRemoveMember = null;
			send({ type: "removeFromGroup", id, member: { kind: target.dataset.kind === "group" ? "group" : "project", id: target.dataset.member ?? "" } });
			return render();
		case "start-group":
			ui.busy.add(`group:${id}`);
			send({ type: "startGroup", id, only: false });
			return render();
		case "solo-group":
			ui.confirmOnly = id;
			return render();
		case "solo-group-no":
			ui.confirmOnly = null;
			return render();
		case "solo-group-yes":
			ui.confirmOnly = null;
			ui.busy.add(`group:${id}`);
			send({ type: "startGroup", id, only: true });
			return render();
		case "stop-group":
			ui.busy.add(`group:${id}`);
			send({ type: "stopGroup", id });
			return render();
		case "rename": {
			const group = state?.groups.find((entry) => entry.id === id);
			if (!group) return;
			ui.renaming = { id, name: group.name };
			render();
			const input = document.querySelector<HTMLInputElement>(`[data-key="rename-${CSS.escape(id)}"]`);
			input?.focus();
			input?.select();
			return;
		}
		case "rename-save":
			if (ui.renaming?.name.trim()) send({ type: "renameGroup", id: ui.renaming.id, name: ui.renaming.name.trim() });
			ui.renaming = null;
			return render();
		case "rename-cancel":
			ui.renaming = null;
			return render();
		case "ask-delete":
			ui.confirmDelete = id;
			return render();
		case "cancel-delete":
			ui.confirmDelete = null;
			return render();
		case "delete-group":
			ui.confirmDelete = null;
			send({ type: "deleteGroup", id });
			return render();
		case "save-settings":
			return saveSettings();
		case "reset-range":
			ui.confirmResetRange = true;
			return render();
		case "reset-range-no":
			ui.confirmResetRange = false;
			return render();
		case "reset-range-yes":
			ui.confirmResetRange = false;
			ui.settings = null;
			send({ type: "resetPortRange" });
			return render();
		case "reset-settings":
			ui.settings = null;
			return render();
		case "refresh":
			return send({ type: "refresh" });
		case "add-workspace":
			return send({ type: "addWorkspace", file: target.dataset.file ?? "" });
		case "group-workspace":
			ui.collapsed.groups = false;
			persist();
			return send({ type: "groupWorkspace", file: target.dataset.file ?? "" });
		case "stop-all":
			ui.confirmStopAll = true;
			return render();
		case "stop-all-no":
			ui.confirmStopAll = false;
			return render();
		case "stop-all-yes":
			ui.confirmStopAll = false;
			ui.busy.add("stop-all");
			send({ type: "stopAll" });
			return render();
		case "walkthrough":
			return send({ type: "walkthrough" });
	}
});

document.addEventListener("change", (event) => {
	const select = event.target as HTMLSelectElement;
	if (select.dataset.action !== "add-member" || !select.value) return;
	const separator = select.value.indexOf(":");
	const kind = select.value.slice(0, separator);
	const member: GroupMember = { kind: kind === "group" || kind === "workspace" ? kind : "project", id: select.value.slice(separator + 1) };
	send({ type: "addToGroup", id: select.dataset.id ?? "", member });
	select.value = "";
});

document.addEventListener("input", (event) => {
	const input = event.target as HTMLInputElement;
	const current = state?.settings;
	switch (input.dataset.input) {
		case "search":
			if (ui.picker) ui.picker.search = input.value;
			return render();
		case "new-group":
			if (ui.newGroup) ui.newGroup.name = input.value;
			return render();
		case "branch-name":
			if (ui.picker?.create) {
				ui.picker.create.name = input.value;
				ui.picker.create.error = null;
			}
			return render();
		case "branch-base":
			if (ui.picker?.create) ui.picker.create.base = input.value;
			return;
		case "filter":
			ui.filter = input.value;
			return render();
		case "rename":
			if (ui.renaming) ui.renaming.name = input.value;
			return;
		case "port-range":
		case "excluded":
			if (!current) return;
			ui.settings ??= { portRange: current.portRange, excluded: current.excludedPorts.join(", "), error: null };
			if (input.dataset.input === "port-range") ui.settings.portRange = input.value;
			else ui.settings.excluded = input.value;
			ui.settings.error = null;
			return render();
	}
});

document.addEventListener("keydown", (event) => {
	const input = event.target as HTMLInputElement;
	const kind = input.dataset?.input;
	if (event.key === "Escape") {
		if (ui.menu) ui.menu = null;
		else if (kind === "search") ui.picker = null;
		else if (kind === "branch-name" && ui.picker) ui.picker.create = null;
		else if (kind === "filter") ui.filter = null;
		else if (kind === "new-group") ui.newGroup = null;
		else if (kind === "rename") ui.renaming = null;
		else if (ui.adding) ui.adding = null;
		else return;
		event.preventDefault();
		return render();
	}
	if (event.key !== "Enter") return;
	if (kind === "search") document.querySelector<HTMLElement>(".picker .list-item")?.click();
	else if (kind === "branch-name") createBranch();
	else if (kind === "new-group") createGroup();
	else if (kind === "rename") document.querySelector<HTMLElement>('[data-action="rename-save"]')?.click();
	else if (kind === "port-range" || kind === "excluded") saveSettings();
});

/*
	Collapse All, from the panel's title bar. Projects and Groups stay open;
	inside them only what is running stays open: serving projects (and the
	workspace blocks that hold them) and running groups. Every other section
	folds.
*/
function collapseAll(): void {
	if (!state) return;
	const live = new Set(state.slots.filter((slot) => slot.state === "running" || slot.state === "starting").map((slot) => slot.id));
	ui.collapsed.projects = false;
	ui.collapsed.groups = false;
	ui.collapsed.ports = true;
	ui.collapsed.settings = true;
	for (const slot of state.slots) ui.collapsed[`card:${slot.id}`] = !live.has(slot.id);
	const inWorkspace = new Set<string>();
	for (const workspace of state.workspaces) {
		workspace.slotIds.forEach((id) => inWorkspace.add(id));
		ui.collapsed[`ws:${workspace.file}`] = !workspace.slotIds.some((id) => live.has(id));
	}
	ui.collapsed["ws:other"] = !state.slots.some((slot) => live.has(slot.id) && !inWorkspace.has(slot.id));
	ui.closedGroups = new Set(state.groups.filter((group) => !group.active).map((group) => group.id));
	ui.picker = null;
	persist();
	render();
	document.scrollingElement?.scrollTo({ top: 0 });
}

function flash(id: string): void {
	ui.collapsed.projects = false;
	ui.reveal = id;
	ui.flash = id;
	render();
	document.getElementById(`slot-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
	setTimeout(() => {
		if (ui.flash === id) {
			ui.flash = null;
			render();
		}
	}, 1600);
}

/*
	Reordering by drag and drop. Only the grip starts a drag, and a drop only
	counts inside the same list (groups, workspace blocks, or the cards of one
	block). The drop sends the whole new order of that kind to the extension.
*/
let dropMark: { element: HTMLElement; after: boolean } | null = null;

function clearDropMark(): void {
	dropMark?.element.classList.remove("drop-before", "drop-after");
	dropMark = null;
}

document.addEventListener("dragstart", (event) => {
	const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-drag-key]");
	if (!handle) return;
	ui.drag = { list: handle.dataset.dragList ?? "", key: handle.dataset.dragKey ?? "" };
	event.dataTransfer?.setData("text/plain", ui.drag.key);
	if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	handle.closest("[data-drop-key]")?.classList.add("dragging");
});

document.addEventListener("dragover", (event) => {
	if (!ui.drag) return;
	const target = (event.target as HTMLElement).closest<HTMLElement>("[data-drop-key]");
	if (!target || target.dataset.dropList !== ui.drag.list || target.dataset.dropKey === ui.drag.key) {
		clearDropMark();
		return;
	}
	event.preventDefault();
	const box = target.getBoundingClientRect();
	const after = event.clientY > box.top + box.height / 2;
	if (dropMark?.element !== target || dropMark.after !== after) {
		clearDropMark();
		target.classList.add(after ? "drop-after" : "drop-before");
		dropMark = { element: target, after };
	}
});

document.addEventListener("drop", (event) => {
	if (!ui.drag || !dropMark) return;
	event.preventDefault();
	const { list, key } = ui.drag;
	const targetKey = dropMark.element.dataset.dropKey ?? "";
	const keys = (ui.lists.get(list) ?? []).filter((entry) => entry !== key);
	const at = keys.indexOf(targetKey);
	if (at >= 0) {
		keys.splice(dropMark.after ? at + 1 : at, 0, key);
		ui.lists.set(list, keys);
		if (list === "groups") send({ type: "reorder", groups: keys });
		else {
			// Projects' order holds workspace blocks and every block's cards together.
			const projects = [...(ui.lists.get("blocks") ?? []), ...[...ui.lists.entries()].filter(([name]) => name.startsWith("cards:")).flatMap(([, entries]) => entries)];
			send({ type: "reorder", projects });
		}
		if (state) {
			if (list === "groups") state.order = { ...state.order, groups: keys };
			else state.order = { ...state.order, projects: [...(ui.lists.get("blocks") ?? []), ...[...ui.lists.entries()].filter(([name]) => name.startsWith("cards:")).flatMap(([, entries]) => entries)] };
		}
	}
	clearDropMark();
});

document.addEventListener("dragend", () => {
	clearDropMark();
	document.querySelectorAll(".dragging").forEach((element) => element.classList.remove("dragging"));
	ui.drag = null;
	render();
});

window.addEventListener("message", (event: MessageEvent<ToPanel>) => {
	const message = event.data;
	switch (message.type) {
		case "state":
			state = message.state;
			if (ui.picker && !state.slots.some((slot) => slot.id === ui.picker!.id)) ui.picker = null;
			if (ui.picker) {
				// The service read a newer list (a branch, a fetch, a new worktree): ask for it quietly.
				const stamp = state.slots.find((slot) => slot.id === ui.picker!.id)?.targetsAt ?? 0;
				if (stamp !== ui.picker.at) {
					ui.picker.at = stamp;
					send({ type: "targets", id: ui.picker.id });
				}
			}
			return render();
		case "targets":
			if (message.options) ui.targets.set(message.id, message.options);
			if (ui.picker?.id === message.id) {
				ui.picker.options = message.options ?? ui.picker.options;
				ui.picker.error = message.options || ui.picker.options ? null : (message.error ?? null);
				render();
			}
			return;
		case "fetched":
			if (ui.picker?.id === message.id) {
				ui.picker.fetching = false;
				ui.picker.fetchError = message.error ?? null;
				render();
			}
			return;
		case "branchCreated":
			if (ui.picker?.id === message.id && ui.picker.create) {
				if (message.error) {
					ui.picker.create.busy = false;
					ui.picker.create.error = message.error;
				} else ui.picker = null;
				render();
			}
			return;
		case "candidates":
			if (ui.adding) {
				ui.adding.items = message.items;
				render();
			}
			return;
		case "focus":
			return flash(message.id);
		case "collapse":
			return collapseAll();
		case "busy":
			if (message.busy) ui.busy.add(message.key);
			else ui.busy.delete(message.key);
			return render();
	}
});

send({ type: "ready" });
