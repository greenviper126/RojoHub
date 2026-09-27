/*
	The Rojo-Hub sidebar panel. Runs inside a VS Code webview; draws everything
	from the state the extension sends and posts every click back to it
	(src/common/panel.ts). All colours and icons come from VS Code's theme.

	Rendering is one function from (state, ui) to HTML. It redraws on every
	change, keeping the focused input, its caret and the scroll position, so
	typing in a search box survives the 2-second status updates.
*/

import type { GroupView, SlotView, TargetOption } from "../common/api";
import { pathBetween } from "../common/groups";
import type { Candidate, FromPanel, GroupMember, PanelState, ToPanel } from "../common/panel";

declare function acquireVsCodeApi(): { postMessage(message: FromPanel): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();
const send = (message: FromPanel) => vscode.postMessage(message);

interface Persisted {
	collapsed: Record<string, boolean>;
	closedGroups: string[];
}
const saved = (vscode.getState() as Persisted | undefined) ?? { collapsed: { settings: true }, closedGroups: [] };

let state: PanelState | null = null;
const ui = {
	collapsed: saved.collapsed,
	closedGroups: new Set(saved.closedGroups),
	picker: null as null | { id: string; search: string; options: TargetOption[] | null; error: string | null },
	adding: null as null | { items: Candidate[] | null },
	newGroup: null as null | { name: string },
	renaming: null as null | { id: string; name: string },
	confirmDelete: null as string | null,
	/** The group whose "Only this" is waiting for Yes/No. */
	confirmOnly: null as string | null,
	/** "Stop all" is waiting for Yes/No. */
	confirmStopAll: false,
	settings: null as null | { portRange: string; excluded: string; error: string | null },
	busy: new Set<string>(),
	flash: null as string | null,
};

function persist(): void {
	vscode.setState({ collapsed: ui.collapsed, closedGroups: [...ui.closedGroups] } satisfies Persisted);
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

function statusLine(slot: SlotView): string {
	if (slot.state === "running") {
		return slot.connections > 0
			? `<span class="ok">${icon("plug")} Studio connected${slot.connections > 1 ? ` (${slot.connections})` : ""}</span>`
			: `<span class="muted">Serving · waiting for Studio</span>`;
	}
	if (slot.state === "starting") return `<span class="muted">Starting…</span>`;
	if (slot.state === "error") return `<span class="bad">${icon("error")} Error</span>`;
	if (slot.state === "offline") return `<span class="muted">Unavailable</span>`;
	return `<span class="muted">Stopped</span>`;
}

function notices(slot: SlotView): string {
	const rows: string[] = [];
	if (slot.error) rows.push(`<div class="notice error">${icon("error")}<span>${escape(slot.error.split("\n")[0])}</span></div>`);
	for (const warning of slot.warnings) rows.push(`<div class="notice warning">${icon("warning")}<span>${escape(warning)}</span></div>`);
	return rows.join("");
}

function picker(slot: SlotView): string {
	const open = ui.picker;
	if (!open || open.id !== slot.id) return "";
	let body: string;
	if (open.error) body = `<div class="notice error">${icon("error")}<span>${escape(open.error)}</span></div>`;
	else if (!open.options) body = `<div class="muted pad">${icon("loading", "codicon-modifier-spin")} Loading worktrees and branches…</div>`;
	else {
		const words = open.search.toLowerCase().split(/\s+/).filter(Boolean);
		const matches = open.options
			.map((option, index) => ({ option, index }))
			.filter(({ option }) => words.every((word) => `${option.label} ${option.description} ${option.branch ?? ""}`.toLowerCase().includes(word)));
		const isCurrent = (option: TargetOption) =>
			(option.target.kind === "worktree" && slot.target.kind === "worktree" && option.target.path.toLowerCase() === slot.target.path.toLowerCase()) ||
			(option.target.kind === "branch" && slot.target.kind === "branch" && option.target.ref === slot.target.ref);
		const list = (kind: "worktree" | "branch", heading: string) => {
			const rows = matches.filter(({ option }) => option.target.kind === kind);
			if (rows.length === 0) return "";
			return `<div class="list-heading">${escape(heading)}</div>${rows
				.map(
					({ option, index }) =>
						`<button class="list-item${isCurrent(option) ? " current" : ""}" data-action="pick" data-index="${index}">${icon(kind === "worktree" ? "folder" : "git-branch")}<span class="grow"><span class="label">${escape(option.label)}</span><span class="sub">${escape(option.description)}</span></span>${isCurrent(option) ? icon("check") : ""}</button>`,
				)
				.join("")}`;
		};
		body = matches.length === 0 ? `<div class="muted pad">Nothing matches “${escape(open.search)}”.</div>` : list("worktree", "Worktrees") + list("branch", "Branches · served from a Hub copy");
	}
	return `<div class="picker">
		<div class="search">${icon("search")}<input data-key="search-${escape(slot.id)}" data-input="search" placeholder="Search worktrees and branches" value="${escape(open.search)}" spellcheck="false"></div>
		<div class="list">${body}</div>
		<p class="hint">Studio stays connected when you switch.</p>
	</div>`;
}

function projectCard(slot: SlotView): string {
	const serving = slot.state === "running" || slot.state === "starting";
	const busy = ui.busy.has(`slot:${slot.id}`);
	const here = state?.here.includes(slot.id) ? `<span class="badge" title="This window's project">this window</span>` : "";
	const targetIcon = slot.target.kind === "worktree" ? "folder" : "git-branch";
	const pickerOpen = ui.picker?.id === slot.id;
	return `<article class="card project ${slot.state}${ui.flash === slot.id ? " flash" : ""}" id="slot-${escape(slot.id)}">
		<div class="row">
			${dot(slot)}
			<span class="name" title="${escape(slot.repoPath)}">${escape(slot.projectName)}</span>${here}
			<span class="grow"></span>
			<button class="port" data-action="copy" data-id="${escape(slot.id)}" title="Copy localhost:${slot.port}${slot.portSource === "servePort" ? " (from servePort)" : ""}">:${slot.port}</button>
		</div>
		<button class="target${pickerOpen ? " open" : ""}" data-action="picker" data-id="${escape(slot.id)}" title="Switch worktree or branch">
			${icon(targetIcon)}<span class="grow ellipsis">${escape(slot.targetLabel || "—")}</span>${icon(pickerOpen ? "chevron-up" : "chevron-down")}
		</button>
		${picker(slot)}
		<div class="row status">${statusLine(slot)}</div>
		${notices(slot)}
		<div class="row actions">
			${
				serving
					? button("stop", "Stop", { icon: "debug-stop", data: { id: slot.id }, kind: "secondary", disabled: busy })
					: button("start", "Start", { icon: "play", data: { id: slot.id }, kind: "primary", disabled: busy })
			}
			<span class="grow"></span>
			${iconButton("log", "output", "Show Rojo log", { id: slot.id })}
			${iconButton("copy", "copy", `Copy localhost:${slot.port}`, { id: slot.id })}
			${iconButton("remove", "trash", "Remove from Rojo-Hub", { id: slot.id })}
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

/** Serving projects that "Only this" would stop for a group. */
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
	const running = group.active ? `<span class="badge running" title="Started, and not stopped since">running</span>` : "";
	const head = renaming
		? `<input class="rename" data-key="rename-${escape(group.id)}" data-input="rename" value="${escape(ui.renaming!.name)}" spellcheck="false">
		   ${iconButton("rename-save", "check", "Save name", { id: group.id })}${iconButton("rename-cancel", "close", "Cancel")}`
		: `<button class="group-toggle" data-action="toggle-group" data-id="${escape(group.id)}" title="${open ? "Collapse" : "Expand"}">${icon(open ? "chevron-down" : "chevron-right")}${icon("layers")}<span class="name">${escape(group.name)}</span></button>
		   <span class="count${serving > 0 && serving === everyProject.length ? " all" : ""}" title="${serving} of ${everyProject.length} projects serving">${serving}/${everyProject.length}</span>${running}
		   <span class="grow"></span>
		   ${
				ui.confirmDelete === group.id
					? `<span class="confirm">Delete?</span>${button("delete-group", "Yes", { data: { id: group.id }, kind: "danger" })}${button("cancel-delete", "No", { kind: "secondary" })}`
					: iconButton("rename", "edit", "Rename group", { id: group.id }) + iconButton("ask-delete", "trash", "Delete group (what's in it stays)", { id: group.id })
			}`;
	if (!open) return `<article class="card group${group.active ? " active" : ""}" id="group-${escape(group.id)}"><div class="row head">${head}</div></article>`;

	const nestedRows = nested
		.map((child) => {
			const childSlots = child.projectIds.map((id) => slots.find((slot) => slot.id === id)).filter((slot): slot is SlotView => !!slot);
			const childServing = childSlots.filter((slot) => slot.state === "running").length;
			return `<div class="member">
				${icon("layers")}
				<button class="link grow ellipsis" data-action="goto-group" data-id="${escape(child.id)}" title="Show ${escape(child.name)}">${escape(child.name)}</button>
				<span class="sub ellipsis">group · ${childServing}/${childSlots.length}</span>
				${iconButton("remove-member", "close", `Take ${child.name} out of ${group.name}`, { id: group.id, kind: "group", member: child.id })}
			</div>`;
		})
		.join("");
	const projectRows = members
		.map(
			(slot) => `<div class="member">
				${dot(slot)}
				<button class="link grow ellipsis" data-action="goto" data-id="${escape(slot.id)}" title="Show ${escape(slot.projectName)}">${escape(slot.projectName)}</button>
				<span class="sub ellipsis">:${slot.port} · ${escape(slot.targetLabel)}</span>
				${iconButton("remove-member", "close", `Take ${slot.projectName} out of ${group.name}`, { id: group.id, kind: "project", member: slot.id })}
			</div>`,
		)
		.join("");

	const projectChoices = slots.filter((slot) => !group.slotIds.includes(slot.id));
	const groupChoices = groups
		.filter((other) => other.id !== group.id && !group.groupIds.includes(other.id))
		.map((other) => ({ other, loop: pathBetween(groups, other.id, group.id) }));
	const nameOf = (id: string) => groups.find((entry) => entry.id === id)?.name ?? id;
	const adder =
		projectChoices.length + groupChoices.length === 0
			? slots.length === 0
				? `<div class="muted small pad">Add projects above first.</div>`
				: `<div class="muted small pad">Everything is already in this group.</div>`
			: `<div class="add-member">${icon("add")}<select data-action="add-member" data-id="${escape(group.id)}" title="Add a project or a group to ${escape(group.name)}">
				<option value="">Add a project or group…</option>
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
						? `Serve only ${escape(group.name)}? Nothing outside it is serving, so this just starts it.`
						: `Serve only ${escape(group.name)}? This stops <strong>${stopping.map((slot) => escape(slot.projectName)).join(", ")}</strong>, and Studio places connected to them disconnect.`
				}</span></div>
				<div class="row">${button("solo-group-yes", "Yes, serve only this", { icon: "target", data: { id: group.id }, kind: "primary" })}${button("solo-group-no", "Cancel", { kind: "secondary" })}</div>`
			: "";

	return `<article class="card group open${group.active ? " active" : ""}" id="group-${escape(group.id)}">
		<div class="row head">${head}</div>
		<div class="members">
			${nestedRows}${projectRows}
			${nested.length + members.length === 0 ? `<div class="muted pad small">Empty. Add projects or other groups below.</div>` : ""}
		</div>
		${adder}
		<div class="row actions">
			${button("start-group", "Start", { icon: "play", data: { id: group.id }, kind: "primary", disabled: busy || everyProject.length === 0, title: `Serve all ${everyProject.length} projects in this group` })}
			${button("solo-group", "Only this", { icon: "target", data: { id: group.id }, kind: "secondary", disabled: busy || everyProject.length === 0, title: "Serve this group and stop every other project (asks first)" })}
			${button("stop-group", "Stop", { icon: "debug-stop", data: { id: group.id }, kind: "secondary", disabled: busy || (serving === 0 && !group.active), title: "Stop this group's projects, except ones another running group uses" })}
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
	return `<div class="card settings">
		<label>Port range<input data-key="port-range" data-input="port-range" value="${escape(draft.portRange)}" placeholder="34873-35872" spellcheck="false"></label>
		<p class="muted small">Projects get a port in this range, worked out from their repo's first commit, unless their project file sets <code>servePort</code>.</p>
		<label>Excluded ports<input data-key="excluded" data-input="excluded" value="${escape(draft.excluded)}" placeholder="35000, 35100-35110" spellcheck="false"></label>
		<p class="muted small">Never given to any project. 34872 (Rojo's default) is always excluded.</p>
		${draft.error ? `<div class="notice error">${icon("error")}<span>${escape(draft.error)}</span></div>` : ""}
		<div class="row">${button("save-settings", "Save", { icon: "check", kind: "primary", disabled: !changed })}${changed ? button("reset-settings", "Undo", { kind: "secondary" }) : ""}</div>
	</div>`;
}

function section(key: string, title: string, iconName: string, count: string, extra: string, body: string): string {
	const collapsed = !!ui.collapsed[key];
	return `<section class="section${collapsed ? " collapsed" : ""}">
		<div class="section-head">
			<button class="section-toggle" data-action="toggle-section" data-id="${key}" aria-expanded="${!collapsed}">${icon(collapsed ? "chevron-right" : "chevron-down")}${icon(iconName)}<span>${escape(title)}</span>${count ? `<span class="count">${escape(count)}</span>` : ""}</button>
			<span class="grow"></span>${extra}
		</div>
		${collapsed ? "" : `<div class="section-body">${body}</div>`}
	</section>`;
}

/* ---------- whole panel ---------- */

function render(): void {
	const app = document.getElementById("app")!;
	if (!state) return;

	const active = document.activeElement as HTMLInputElement | null;
	const focusKey = active?.dataset?.key;
	const selection = focusKey ? [active!.selectionStart, active!.selectionEnd] : null;
	const scrolls = [...app.querySelectorAll<HTMLElement>(".list")].map((list) => list.scrollTop);
	const pageScroll = document.scrollingElement?.scrollTop ?? 0;

	const slots = [...state.slots].sort((a, b) => Number(state!.here.includes(b.id)) - Number(state!.here.includes(a.id)));
	const servingCount = slots.filter((slot) => slot.state === "running").length;

	const projectsBody =
		adder() +
		(slots.length === 0
			? `<div class="empty">
				<p>No projects yet.</p>
				<p class="muted small">Each project gets its own Rojo port. Switch it to any branch while Studio stays connected.</p>
				${button("open-adder", "Add a project", { icon: "add", kind: "primary" })}
				${button("walkthrough", "Getting started guide", { icon: "book", kind: "ghost" })}
			</div>`
			: slots.map(projectCard).join(""));

	const groupsBody =
		newGroupForm() +
		(state.groups.length === 0 && !ui.newGroup
			? `<div class="empty">
				<p class="muted small">Groups start and stop sets of projects together, like profiles.</p>
				${button("open-new-group", "New group", { icon: "add", kind: "secondary" })}
			</div>`
			: state.groups.map(groupCard).join(""));

	const serving = slots.filter((slot) => slot.state === "running" || slot.state === "starting");
	const footer = ui.confirmStopAll
		? `<div class="notice warning">${icon("warning")}<span class="grow">Stop all ${serving.length} serving project${serving.length === 1 ? "" : "s"}: <strong>${serving
				.map((slot) => escape(slot.projectName))
				.join(", ")}</strong>? Studio places connected to them disconnect.</span></div>
			<div class="row">${button("stop-all-yes", "Yes, stop all", { icon: "debug-stop", kind: "danger" })}${button("stop-all-no", "Cancel", { kind: "secondary" })}</div>`
		: `<div class="row"><span class="muted small">${serving.length === 0 ? "Nothing serving" : `${serving.length} of ${slots.length} serving`}</span><span class="grow"></span>${button("stop-all", "Stop all", { icon: "debug-stop", kind: "secondary", disabled: serving.length === 0, title: "Stop every serving project (asks first)" })}${iconButton("refresh", "refresh", "Refresh")}</div>`;

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
		${section("projects", "Projects", "server-environment", slots.length ? `${servingCount}/${slots.length} serving` : "", iconButton("open-adder", "add", "Add a project"), projectsBody)}
		${section("groups", "Groups", "layers", state.groups.length ? String(state.groups.length) : "", iconButton("open-new-group", "add", "New group"), groupsBody)}
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
		ui.picker = { id, search: "", options: null, error: null };
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
	if (!target || target.tagName === "SELECT") return;
	const { action, id = "", index, path } = target.dataset;
	switch (action) {
		case "toggle-section":
			ui.collapsed[id] = !ui.collapsed[id];
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
		case "start":
		case "stop":
			ui.busy.add(`slot:${id}`);
			send({ type: action, id });
			return render();
		case "copy":
			return send({ type: "copy", id });
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
			return send({ type: "removeFromGroup", id, member: { kind: target.dataset.kind === "group" ? "group" : "project", id: target.dataset.member ?? "" } });
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
		case "reset-settings":
			ui.settings = null;
			return render();
		case "refresh":
			return send({ type: "refresh" });
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
	const [kind, ...rest] = select.value.split(":");
	const member: GroupMember = { kind: kind === "group" ? "group" : "project", id: rest.join(":") };
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
		if (kind === "search") ui.picker = null;
		else if (kind === "new-group") ui.newGroup = null;
		else if (kind === "rename") ui.renaming = null;
		else if (ui.adding) ui.adding = null;
		else return;
		event.preventDefault();
		return render();
	}
	if (event.key !== "Enter") return;
	if (kind === "search") {
		const first = document.querySelector<HTMLElement>(".picker .list-item");
		if (first) pick(Number(first.dataset.index));
	} else if (kind === "new-group") createGroup();
	else if (kind === "rename") document.querySelector<HTMLElement>('[data-action="rename-save"]')?.click();
	else if (kind === "port-range" || kind === "excluded") saveSettings();
});

function flash(id: string): void {
	ui.collapsed.projects = false;
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

window.addEventListener("message", (event: MessageEvent<ToPanel>) => {
	const message = event.data;
	switch (message.type) {
		case "state":
			state = message.state;
			if (ui.picker && !state.slots.some((slot) => slot.id === ui.picker!.id)) ui.picker = null;
			return render();
		case "targets":
			if (ui.picker?.id === message.id) {
				ui.picker.options = message.options;
				ui.picker.error = message.error ?? null;
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
		case "busy":
			if (message.busy) ui.busy.add(message.key);
			else ui.busy.delete(message.key);
			return render();
	}
});

send({ type: "ready" });
