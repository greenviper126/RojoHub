/*
	Optimistic state: what the panel expects an action to do, drawn before the
	extension confirms it. A click would otherwise show nothing until the
	service had done the work and the next state came back, which for a Start
	is the whole time Rojo takes to come up.

	Each expectation is drawn over every state that arrives (on a copy; the
	extension's state is never changed) until one of these ends it:
	- the real state shows it happened (`done`);
	- the extension says the action is over (busy:false for its key) and the
	  state after that arrives: that state is the answer, success or not;
	- its time runs out, so an action that failed without a word, or never
	  reached the service, falls back to the real state.

	Expectations are keyed by what they change ("run:<slot>", "name:<group>"…),
	so a later click on the same thing replaces an earlier one: Stop while a
	Start is still on its way shows stopping, not starting.
*/

import type { SlotView } from "../common/api";
import { expandGroup } from "../common/groups";
import type { Candidate, PanelState } from "../common/panel";

/** What the panel draws: the state with every expectation applied, plus what the state has no field for. */
export interface View {
	state: PanelState;
	/** Projects shown as stopping: Stop was pressed and the service has not said stopped yet. */
	stopping: Set<string>;
	/** Folders picked in Add a project that are not in the state yet. */
	adding: Candidate[];
}

export interface Expectation {
	/** The busy key whose busy:false says the action is over ("slot:<id>", "group:<id>"…); null when none comes. */
	busy: string | null;
	/** Draws the expected result on the view. Replace objects (see patchSlot), never change the ones in the state. */
	apply(view: View): void;
	/** Whether the real state already shows it. */
	done(real: PanelState): boolean;
	/** How long it may stand without an answer, in ms. */
	ttl: number;
}

interface Entry extends Expectation {
	until: number;
	/** Its busy:false arrived; the next state ends it. */
	settled: boolean;
}

const entries = new Map<string, Entry>();

/*
	Actions under way per busy key, as the times they are given up on. Two
	actions can share a key (Start, then Stop before Start finished), and only
	the last one's busy:false says the key is idle; the first must not end the
	second's expectation. Times, not a count, so an action whose busy:false
	never comes (the extension returned early) stops counting after a while.
*/
const inflight = new Map<string, number[]>();

export function expect(subject: string, expectation: Expectation): void {
	entries.set(subject, { ...expectation, until: Date.now() + expectation.ttl, settled: false });
}

/** Forgets an expectation (a placeholder cancelled on the panel side). */
export function forget(subject: string): void {
	entries.delete(subject);
}

/** An action that will answer with busy:false for `key` was sent. */
export function sent(key: string): void {
	const now = Date.now();
	inflight.set(key, [...(inflight.get(key) ?? []).filter((until) => until > now), now + 60_000]);
}

/*
	busy:false for `key`. Returns whether the key is idle now (no other action
	with it under way); its expectations then end with the next state.
*/
export function settle(key: string): boolean {
	const now = Date.now();
	const left = (inflight.get(key) ?? []).filter((until) => until > now).slice(1);
	if (left.length > 0) {
		inflight.set(key, left);
		return false;
	}
	inflight.delete(key);
	for (const entry of entries.values()) if (entry.busy === key) entry.settled = true;
	return true;
}

/** A new real state arrived: drops what it confirms, what was waiting for it, and what ran out of time. */
export function confirm(real: PanelState): void {
	const now = Date.now();
	for (const [subject, entry] of entries) if (entry.settled || entry.until <= now || entry.done(real)) entries.delete(subject);
}

/** Drops settled expectations when no state followed their busy:false (the state did not change). */
export function dropSettled(): boolean {
	let dropped = false;
	for (const [subject, entry] of entries) {
		if (entry.settled) {
			entries.delete(subject);
			dropped = true;
		}
	}
	return dropped;
}

/** Drops expectations whose time ran out; returns whether any did. */
export function expire(): boolean {
	const now = Date.now();
	let dropped = false;
	for (const [subject, entry] of entries) {
		if (entry.until <= now) {
			entries.delete(subject);
			dropped = true;
		}
	}
	return dropped;
}

/** When the next expectation runs out (ms since the epoch), or null when none is waiting. */
export function nextDeadline(): number | null {
	let next: number | null = null;
	for (const entry of entries.values()) if (next === null || entry.until < next) next = entry.until;
	return next;
}

export function has(subject: string): boolean {
	return entries.has(subject);
}

/*
	The state to draw. Copies only the arrays and objects that expectations
	replace entries of; a render does this each time, which for tens of
	projects is a few hundred property copies.
*/
export function view(real: PanelState): View {
	const now = Date.now();
	const result: View = {
		state: {
			...real,
			slots: [...real.slots],
			groups: [...real.groups],
			order: { ...real.order },
			settings: { ...real.settings },
			agents: { ...real.agents, list: [...real.agents.list] },
		},
		stopping: new Set(),
		adding: [],
	};
	let touched = false;
	for (const entry of entries.values()) {
		if (entry.until <= now) continue;
		entry.apply(result);
		touched = true;
	}
	// Membership changes move projects in and out of groups, and so of every group holding those groups.
	if (touched) result.state.groups = result.state.groups.map((group) => ({ ...group, projectIds: expandGroup(result.state.groups, group.id) }));
	return result;
}

/* ---------- helpers for apply() ---------- */

export function patchSlot(view: View, id: string, changes: Partial<SlotView>): void {
	const index = view.state.slots.findIndex((slot) => slot.id === id);
	if (index >= 0) view.state.slots[index] = { ...view.state.slots[index], ...changes };
}

export function patchGroup(view: View, id: string, changes: Partial<PanelState["groups"][number]>): void {
	const index = view.state.groups.findIndex((group) => group.id === id);
	if (index >= 0) view.state.groups[index] = { ...view.state.groups[index], ...changes };
}

export const isServing = (slot: SlotView | undefined) => !!slot && (slot.state === "running" || slot.state === "starting");

/* ---------- the expectations the panel's actions make ---------- */

const START_TTL = 15_000;

/** Start: the card shows starting at once. Done once the service says starting or running. */
export function starting(id: string, busy: string): void {
	expect(`run:${id}`, {
		busy,
		ttl: START_TTL,
		apply: (view) => {
			view.stopping.delete(id);
			patchSlot(view, id, { state: "starting", error: null });
		},
		done: (real) => isServing(real.slots.find((slot) => slot.id === id)),
	});
}

/** Stop: the card shows stopping at once. Done once the service says stopped (or the project is gone). */
export function stopping(id: string, busy: string): void {
	expect(`run:${id}`, {
		busy,
		ttl: START_TTL,
		apply: (view) => {
			// A project whose optimistic start is being cancelled is still "stopped" in the state; nothing to show stopping.
			const slot = view.state.slots.find((entry) => entry.id === id);
			if (slot && (isServing(slot) || slot.state === "error")) view.stopping.add(id);
		},
		done: (real) => {
			const slot = real.slots.find((entry) => entry.id === id);
			return !slot || slot.state === "stopped" || slot.state === "offline";
		},
	});
}

/** A group is Running (Start) or not (Stop, Stop all, another group's start with only). */
export function groupActive(id: string, active: boolean, busy: string): void {
	expect(`active:${id}`, {
		busy,
		ttl: START_TTL,
		apply: (view) => patchGroup(view, id, { active }),
		done: (real) => (real.groups.find((group) => group.id === id)?.active ?? active) === active,
	});
}
