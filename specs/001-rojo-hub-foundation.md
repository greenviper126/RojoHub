# 001 — Rojo-Hub foundation

Status: **implemented, awaiting Studio confirmation**. Live switching measured headless and end to
end against real `rojo`; the plugin's handling is confirmed from its source but not yet watched in
Studio. Design defaults accepted by Viper on 2026-09-27.

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
- The project name, `servePlaceIds` and anything else read only at startup must not change between
  switches (the server's `projectName` and place-ID lists are fixed when the session starts).
- Nested is better than copied (measured, `tools/live-switch-nested.mjs`): when the slot file's root
  is a single `$path` to the tree's **own** project file, also by its `\\?\` path, Rojo reads that
  project natively. Switches still apply live, `globIgnorePaths` and `syncRules` keep working
  (they are relative to the project file's folder, so a copy stored elsewhere silently loses
  them), and edits to the branch's own project file sync live, in every switch order.

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

### The Studio plugin's side (from its source, v7.7.0 `plugin/src`)

- Patches arriving on the websocket go straight to `ServeSession:__applyPatch`; the confirmation
  dialog (`setConfirmCallback`) runs only during the initial sync.
- The only check on a websocket packet is that its `sessionId` equals the one the plugin connected
  with (`ApiContext.lua`). A live switch keeps the session, so the plugin applies it silently.

### Rojo 7.7 crashes when a watched folder loses a subfolder

Found while building, reproduced with plain `rojo serve` (no Hub involved): deleting a folder that
contains files under any served path panics at `change_processor.rs:179`
(`self.vfs.canonicalize(parent).unwrap()` on a `Remove` event whose parent is already gone). Upstream:
rojo-rbx/rojo#1305 (closed), #1309 and #1321 (open), fix PR #1319 unmerged as of 2026-09-27. Rojo
also never stops watching a folder it has read, so this includes folders a slot served earlier in
the same process.

Consequences:

- The Hub never deletes or checks out into a folder while that slot's rojo runs. Each branch commit
  gets its own view folder; unused views are removed only when the slot's rojo is stopped or
  restarted.
- When rojo dies anyway (someone deletes a folder, removes an Orca worktree the slot served earlier,
  or checks out a branch that removes a folder), the Hub restarts it on the same port and says so.
  That is a new session, so Studio must be reconnected by hand.

### Not yet confirmed

- **Studio side, watched live.** Procedure: add a project in the Rojo-Hub sidebar, start it,
  connect a throwaway Baseplate to its port, switch between two branches that differ, and check
  Studio shows each switch without disconnecting or prompting.
- Behaviour when the tree's project file is invalid at the moment of a switch: Rojo logs the error
  and keeps the old tree; the Hub shows the logged error on the slot.

## Design

### Pieces

- **Service** (`src/service`, bundled to `dist/service.js`): owns the registry, the generated files
  and one `rojo serve` per slot. HTTP JSON API on `127.0.0.1:34870` (`src/service/server.ts`). Started
  by the extension with VS Code's runtime (`ELECTRON_RUN_AS_NODE`), detached; keeps running when
  windows close. Rojo processes are detached too, so a service restart (or extension update) does
  not drop Studio: the next service adopts a rojo that still answers with the slot's project name.
- **Extension** (`src/extension`): Projects view (port, what is served, Studio connection count,
  warnings), a branch picker, a status bar item for the window's own project, start/stop/remove,
  and the Rojo log. Polls the service every 2 s.
- **State** in `%LOCALAPPDATA%\RojoHub\`: `registry.json`, `service.log`,
  `slots\<id>\{slot.project.json, borrowed.project.json, rojo.log, rojo.previous.log}`, and
  `views\<id>\<commit>\` for branches without a worktree.

### Slots

- Registered from any folder in a repo; the primary checkout is what is stored. Port: the lowest
  free port in 34873-34899 that no slot owns (34872 is never used). Name: the primary's project
  `name`, which must be unique across slots.
- `rojo serve` runs with the primary checkout as its working directory, so that project's
  `rokit.toml` picks the rojo version.
- The slot file (`slot.project.json`) holds the name, the session fields copied from the primary
  (`servePlaceIds`, `blockedPlaceIds`, `placeId`, `gameId`, `emitLegacyScripts`) and one root `$path`.

### Serving a tree

- **Native**: the tree has every folder its project file maps. The root `$path` points at the
  tree's own project file.
- **Borrowed**: the tree lacks a folder its project file maps that the primary has (typically
  `Packages`/`ServerPackages` in a worktree that has not run Wally). The root `$path` points at
  `borrowed.project.json`, a copy of the tree's project file with every `$path` absolute and the
  missing folders taken from the primary. The slot warns, as `/JumpTo` did, when the branch's
  `wally.toml` differs, and says that `globIgnorePaths`/`syncRules` do not apply in this mode. The
  service watches the tree's project file and regenerates the copy when it changes.
- Worktrees are served in place, so edits made there (by agents or by hand) reach Studio.
- A branch with no worktree is served from a Hub view: `git worktree add --detach` of its commit
  into a new folder. Branches already checked out in a worktree are offered only as that worktree.

### Connection state

Rojo's debug log (`-v`) records each plugin websocket: `WebSocket subscription established` when
one opens, and one of `closed by client`, `stream ended`, `WebSocket error`, or `Message queue
disconnected` when it ends (`src/web/api.rs`). The service counts them from the slot's log.

### Tests

`npm test`: unit tests, and `src/test/e2e.test.ts`, which runs the real service against a real
rojo and a throwaway git repo with a websocket client standing in for Studio. It checks one session
across native, borrowed and view switches, edits after switches, a live project-file edit, the
connection count, and the crash restart.
