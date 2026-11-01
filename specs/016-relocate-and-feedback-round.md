# 016: relocate a moved project, and the 2026-10-27 feedback round

Status: built (0.22.13, branch `experimental/feedback-2026-10-24`). From `feedback-2026-10-27.md`,
findings 2-6, 8, 10, 11 and 14, after a read-only design review of every proposed fix against the code
(the review's verdicts are folded in below). Findings 1, 7 and 9 are not here: see "Not in this round".

## Problem

14. Moving a project's folder left it unservable. `SlotRecord.repoPath`, a worktree target's path and
    the Hub's views all live in `registry.json`; nothing re-pointed them. Removing and adding the project
    kept its port (hashed from the repo's first commit) but lost its place assignments, group membership,
    claims and order. Viper: if a moved project cannot be re-pointed, that is a bug.
2-6, 8, 10, 11. Answers that were noisy, ambiguous or too large (see the feedback log).

## Acceptance criteria

1. `relocate_project` (MCP), `POST /slots/:id/relocate { path }` and the panel's "Locate folder…" point a
   **stopped** project at a new folder. They keep its id, port, groups, order, place assignments,
   confirmations and sync history. A serving project is refused (a new folder is a new Rojo session).
2. The new folder must be a checkout of the same repo (same seed: first commit) with the same
   `projectFile` and the same project name; otherwise it is refused and says to add it as a new project.
3. A worktree target under the old folder moves with it; one that is gone falls back to the primary
   checkout; a branch target is kept. Views are collected (their `.git` files point into the old folder).
4. A project whose `repoPath` does not exist shows `error: Folder missing: ... locate it or remove it`.
5. `ensure`'s versions step: outcome `done` or `already`; needs-you only in its lines and
   `versions.needsUser`; the outdated-connection note only in the answer footer.
6. After a reopen, `ensure` and `reopen_place` say Roblox Studio tools give the place a new studio id (list
   the Studios again); `ensure` says how long the reopen took.
7. A place being reopened is listed as "reopening" (`version`, `status`, project place lists), from the
   `Places` busy record (the plugin's socket is gone while it reopens).
8. `status` with `project`, or `path` and `mine: true`, answers for that project only (projects, groups
   containing it, its places, its setup jobs).
9. `log` omits `[DEBUG`/`[TRACE` lines unless `verbose: true`, and says how many it hid.
10. The "checked out in the served folder" note says "Info:", is shown in the next `serve_here` answer
    from that folder, then cleared.
11. A claim refusal for a worktree claim names `release` with `path` = that worktree.

## Design notes

- `relocate` is `setProjectFile`'s kind of operation: queued per slot, stopped-only. It never touches a
  running rojo, so the measured rules (no restart on switch, never delete a folder a running rojo read)
  hold. Views are removed only while the slot is stopped, as `collectViews` always does.
- No protocol change: everything is service-side or text. `SERVICE_VERSION` 0.22.13 only.

## Not in this round

- 1 (chats need `/mcp` after updates): `tools/list` already goes to the service on every call and the
  launcher already sends `tools/list_changed`; whether Claude Code re-lists on it is unmeasured. Measure
  that before building a launcher hot reload (a never-changing shim that loads the launcher by versioned
  file name is the sturdier shape if it is needed).
- 7 (`syncedWith: null` while connected): best hypothesis is a leftover plugin socket; the service has no
  idle timeout for silent sockets. Check `service.log` "said hello" and "disconnected" for that place.
- 9 (worktree Packages still borrowed): a repeat `serve_here` already re-plans; ask whether one was made
  after the install; if not, re-check borrowing from the 1 s poller (root `$path` only).
- 12, 13: logged only / already fixed in 0.22.8.
- `remove_project` keeping place assignments (offered by the review, not asked for).

## Non-goals

- Relocating a serving project, or a project to a different repo.
