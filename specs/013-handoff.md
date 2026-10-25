# 013 — Handoff: `then_return`

Status: **built** (item 13 of `specs/feedback-2026-10-24.md`; the queue it needs, `wait`, exists from 008).
Builds on 004 (claims), 008 (agent control) and 011 (`ensure`). Version bump on release: with the
rest of the 0.22.0 changes (the service changes).

## Problem

An agent that wants to check its changes in Studio takes the project with `serve_here`. If the project
was serving the user's worktree (or another agent's, after that agent's claim ran out), the agent's
`release` leaves Studio showing the agent's worktree. The user comes back to Studio showing something
they did not choose, and has to switch back by hand. The agent cannot do it either: it does not know
what the project served before, and it must not switch to a worktree it does not own.

## Design

1. **`then_return: true`** on `serve_here`, `switch` and `ensure` (which composes the same take).
   The claim then remembers `returnTo`: the target the project served at the moment this agent took
   it, with its label. `returnTo` is kept in `claims.json` with the claim.
2. **When it returns.** On `release`, before the claim is dropped (so an agent queued with `wait`
   cannot interleave), and when the claim runs out. Expiry was lazy (`claimOf` drops expired
   claims), so the service now checks once a second (`returnLapsed`, on the poller that already
   exists) and `release` also handles a claim that lapsed a moment ago.
3. **Where it is decided.** `Hub.handBack`, inside the slot's queue, so it cannot race another
   switch. It switches back only if all of these hold, else it leaves the project alone and says why:
   - the project is running (a stopped slot is not touched),
   - it still serves the claim's target (a switch by the user or anyone else since means "no"),
   - no other claim is held: on release the claim is this agent's own; on expiry any unexpired claim
     belongs to someone who took the project since,
   - a worktree target's folder still exists. A branch target is tried; a failed switch is reported.
4. **It is an ordinary switch** (`switchLocked`, the body of `switch`): only the root `$path`
   changes, Rojo is never restarted, Studio stays connected.
5. **What is remembered.** The first `then_return` wins: a later `serve_here` from the same worktree
   (renewing the claim) keeps the original `returnTo` rather than returning to itself, even without
   `then_return`. If the project already serves the agent's worktree and nothing was remembered, there
   is nothing to return to and the answer says so.
6. **The answers.** `serve_here`, `switch` and `ensure` say what it will switch back to. `release`
   says "switched back to X, which it served before you took it", or "keeps serving Y (not switched
   back: <why>)". `status` and the structured project state show `claim.thenReturn` (label or null).
   A `release` after the claim lapsed reports the same.
7. A service restart keeps `returnTo`, and a claim that ran out while the service was down still
   returns when the service is back.

## Default: opt-in

Return-on-release is **not** the default. Many agents release to say "I am done with Studio" and
expect their work to stay visible for the user to review; switching away would hide it. An agent that
borrows a project it knows someone is using asks for `then_return` explicitly. Revisit if agents
nearly always pass it.

## Acceptance criteria

- `serve_here`/`switch`/`ensure` accept `then_return`; without it, behaviour is unchanged.
- Release returns to the earlier target; the claim ending by expiry does too, within about a second.
- No return when another agent has taken the project since, when the project serves something else,
  when it is stopped, or when the old worktree folder is gone; the answer says why.
- The return is a live switch; no rojo restart.
- Unit tests in `src/test/unit.test.ts` cover release, expiry, taken-since, a missing folder, a
  stopped slot, a restart, and the tool answers.

## Non-goals

- A stack of nested handoffs (the claim keeps one `returnTo`; a waiter that takes the project after a
  returning agent returns to what it finds then).
- Returning to a worktree the project did not serve (no "return to main" by name).
- Making the return the default.
