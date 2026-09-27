# 001 — Rojo-Hub foundation

Status: **draft**. Live-switch measured headless (passes with one Windows-specific condition); Studio
side not yet confirmed. Design questions open (see end).

## Problem

Viper works on several Roblox projects at once, each through Orca worktrees. Rojo serves one project
per port, and today switching which branch a place sees means restarting `rojo serve` (TheLaundryShift's
`/JumpTo`), which gives Studio a new session and drops the plugin's connection. There is also no way
to keep several projects served side by side without hand-managing ports.

## Goals

1. **One fixed port per project, many projects at once.** A project's port never changes, so each
   Studio place connects to it once by hand and the Rojo plugin's Auto Reconnect does it from then on.
2. **Branch switching on a live port.** Pick any branch or Orca worktree of a project and that port
   starts serving those files without Studio's Rojo connection dropping.

## Acceptance criteria

- [ ] Registering a project gives it a port from the Hub range (never 34872, which `/JumpTo` uses)
      that stays the same across Hub restarts, reboots and branch switches.
- [ ] Two registered projects can serve at the same time, each on its own port, each with its own
      `rojo` binary chosen by that project's `rokit.toml`.
- [ ] Registering refuses a project whose Rojo project name is already used by another slot (the
      plugin auto-connects by name).
- [ ] Switching a slot to another worktree keeps the same `rojo serve` process and session ID; a
      connected Studio receives the difference as one patch and stays connected.
- [ ] After a switch, edits and new files in the newly served worktree reach Studio; edits in the
      previously served worktree do not.
- [ ] The branch picker lists Orca's worktrees under Orca's names, plus every other local branch.
      Choosing a branch with no worktree creates a detached, Hub-owned view worktree outside Orca's
      folders; the Hub removes view worktrees it no longer serves.
- [ ] `Packages`/`ServerPackages` come from the primary checkout when the served worktree has not run
      Wally, with the `/JumpTo` warning when its `wally.toml` differs (ported from
      `ServeWorktree.mjs`).
- [ ] The served project name stays identical across switches (only `$path`s change).
- [ ] A background service owns slots and `rojo serve` processes and survives VS Code windows
      closing; the VS Code extension is a front end to it (sidebar of slots with port, branch,
      connection state; start, stop, switch, view log).
- [ ] Installed locally as a `.vsix`; never published.

## Non-goals

- Forking or patching the Rojo Studio plugin.
- Pre-writing the plugin's `priorEndpoints` setting (location unverified; Studio likely overwrites it).
- Publishing to the VS Code marketplace.
- Replacing `/JumpTo` in TheLaundryShift (open question for Viper; not part of this spec).
- Serving over the network; everything is localhost.

## Live-switch measurement (2026-09-27)

Question: does Rojo 7.7.0 apply a changed `$path` in the served project file live, over the existing
session, and start watching the new folders on Windows?

**Answer: yes, but only when `rojo serve` is given the project file's verbatim path (`\\?\C:\...`).**
With a plain `C:\...` path, Rojo on Windows silently ignores every rewrite of the project file.

### Why (from Rojo 7.7.0 source and `-vv` trace)

- On a change event, `ChangeProcessor::handle_vfs_event` canonicalizes the event path. On Windows
  that yields a verbatim path, `\\?\C:\...\slot.project.json`.
- It then looks up instances whose relevant path equals that canonical path. The project root is
  the only instance whose relevant path is the project file, and `snapshot_project` registers it
  under the path `rojo serve` received (`cli::resolve_path` passes absolute paths through
  untouched). A plain `C:\...` never equals `\\?\C:\...`, so the lookup finds nothing, climbs to
  `C:\` and gives up. The trace shows `affects IDs []` for every rewrite.
- `$path` folders do not have this problem, which is why ordinary file edits sync fine today.
- When the root does match, Rojo re-snapshots the whole project (`snapshot_project` again, with
  the new `$path`s), diffs it against the live tree, and pushes one `AppliedPatchSet` on the same
  message queue. Reading the new folders registers VFS watches on them.

### Consequences for the generated project file

- Serve it as `rojo serve \\?\<absolute path to slot.project.json> --port N`.
- Every `$path` in it must be **absolute** (a verbatim base path gets no `..` processing, so the
  relative paths `ServeWorktree.mjs` writes would not resolve).
- The project name, `servePlaceIds` and anything else read only at startup must not change between
  switches (the server's `projectName` and place-ID lists are fixed when the session starts).

### Results

Headless client (`tools/live-switch-headless.mjs`), which does the plugin's part: `/api/rojo`,
`/api/read`, then the `/api/socket` websocket. Two small trees A and B, one session throughout:

| Step | plain `C:\` path | verbatim `\\?\` path |
|---|---|---|
| switch A → B | 0 packets | 1 patch (B's sources, B-only script added) |
| edit in B after switch | 0 | 1 update |
| new file in B after switch | 0 | 1 add |
| edit in A while serving B | 1 (wrong tree) | 0 |
| switch B → A | 0 | 1 patch (B-only instances removed) |
| edit in A after switching back | 1 | 1 |
| edit in B while serving A | 0 | 0 |
| switch A → B again | 0 | 1 patch |
| edit in B after second switch | 0 | 1 |

In every run the session ID stayed the same and the socket stayed open.

TheLaundryShift's real `default.project.json` (982 instances; primary vs a `git archive` of HEAD~40,
Packages kept on the primary): four alternating switches, each one patch (+14/−41/~532 and back), same
session, socket open, no Rojo warnings. First switch 2.4 s (cold read of the new folders), then about
230 ms each.

### Not yet confirmed

- **Studio side.** That the real plugin applies a switch patch without disconnecting or asking for
  confirmation. Procedure: `node tools/live-switch-probe.mjs serve tiny` (port 34880), connect a
  throwaway Baseplate, then `switch b`, `edit b`, `switch a`, `edit a`, `switch b`; repeat with
  `serve tls` for a patch the size of a real branch switch.
- Old worktree folders stay watched after a switch (Rojo never unwatches). Whether that blocks
  deleting a Hub-owned view worktree on Windows has not been checked.
- Behaviour when the new `$path` does not exist at the moment of the switch (e.g. a worktree being
  removed).

## Design

To be written after the Studio confirmation and the design questions below.
