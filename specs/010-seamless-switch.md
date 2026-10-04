# 010 — Switches that never disconnect Studio, and a plugin that rides on Rojo's

Status: **implemented in 0.21.0** (branch `feat/seamless-switch`; see *Checked*). Asked for by Viper: "seems like when an agent
switches to another branch on rojo-hub it disconnects and connectes again. ideally that just does
not happen and we switch the code no issue", "there is a new version of rojo so you have to update
the plugin", and "make our code for that plugin more like a parisite so we can easily attach onto
new updates more easliy". Builds on 001 (live switch), 007 (Studio plugin) and 008 (agent tools).

## Problem

A switch itself never restarts rojo (001), and the measurement still holds (M1). Yet Studio sees
"disconnected, connected again" after agents switch, because rojo *is* restarted, for two reasons
found in the logs of 2026-10-04:

1. **A switch that did not fully apply, then an agent's stop + start.** Isoliminality, 08:26 UTC:
   an agent called `serve_here` for `feat-character-systems`. That branch's project file adds a
   `StarterCharacterScripts` node (with an `Animate` script) that the branch served before lacks.
   Rojo sent the change over the same session, but the plugin could not apply it: the patch *adds*
   a `StarterCharacterScripts`, `Instance.new("StarterCharacterScripts")` fails (the class is not
   creatable), and `reify` drops the whole subtree into the unapplied patch with only a debug log
   (M3). The agent saw `Animate` missing, called `stop` and `start`, and the new session's first
   sync matched the existing `StarterCharacterScripts` by name (hydrate), so it worked, at the cost
   of a reconnect. Any switch that adds a service-like node (`StarterCharacterScripts`,
   `StarterPlayerScripts`, a service under the DataModel) hits this.
2. **A folder rojo served earlier is deleted.** TheLaundryShift, 15:09: the worktree the project
   served was removed (Orca cleans up a finished worktree), and rojo panicked (`Canonicalize`
   `NotFound`, rojo-rbx/rojo#1305); the Hub restarted it, a new session. Rojo never unwatches, so
   this also happens for a worktree switched *away* from earlier in the session (M2). Still so in
   Rojo 7.7.1 (M2).

Separately, Rojo 7.7.1 is out (2026-10-02). Its plugin changes are small (M4). The plugin here is
Rojo's, edited in place with `-- Rojo-Hub` hooks in four files; moving to 7.7.1 is a hand merge.

## Design

### 1. Adds that meet an existing instance are adopted, not dropped

When a patch adds an instance that cannot be created, and its parent already has a child with the
same `Name` and `ClassName` that no Rojo ID owns, that child takes the ID (as hydrate does in a
first sync), its properties are applied, and its children are reified under it. Under an adopted
instance, an existing unowned child of the same name and class is adopted before anything is
created, so a script already there is not duplicated. Only where creating fails: a creatable add is
created as before (Viper: "do what makes the most sense"). `plugin/RojoHub/Adopt.lua`, one hook in
`reify.lua`. Not handled: removing an adopted service-like node later leaves it (and so its
children) in place, as Rojo does for hydrated services.

### 2. A restart Studio does not notice

Some restarts cannot be avoided (reason 2, a crash, a port move, stop + start). When the session a
place is synced to ends and the user did not end it, the plugin holds the loss: the page stays on
Connected, Rojo's notifications (and so their sound) are not shown, and the new session of the same
project (same port, or same slot after a port move) is connected to as soon as the service names
it. Its first sync applies only the differences (hydrate + diff, as now), without the confirmation
page for a place that accepted the project before (007).

- The service adds `restarting: true` to a *stopped* answer while it restarts the project itself
  (crash restart, port move; `Runtime.restarting`). The hold lasts while that is so, up to 60 s;
  otherwise 5 s, which covers an agent's stop + start (about 4 s, measured 2026-10-04).
- No new session in time, or the service names another project: the disconnect is shown as Rojo
  would have (error page and notification, or *Disconnected from session.*).
- **Disconnect** during a hold ends it, and nothing connects by itself for 60 s.
- An optional field (older plugins ignore it), so no `STUDIO_PROTOCOL` bump, as with `confirming`
  in 0.19.5.
- Rojo's changes viewer follows the current session (the page is not remounted).

### 3. Fewer restarts

- Agents: `stop` and `start` say in their descriptions, and the server instructions say, that
  stopping disconnects Studio and a switch never needs it. The plugin reports what each patch left
  unapplied (`{ type: "unapplied", sessionId, total, items }`, from `ServeSession:hookPostcommit`,
  no Rojo patch needed); `serve_here` and `switch` add the reports that came in since the call
  began.
- Worktree removal: nothing the Hub can do stops rojo crashing when a watched folder loses a
  subfolder. Design 2 is what keeps Studio connected through it.

### 4. The plugin rides on Rojo's (Viper's "parasite")

- `plugin/upstream/` is Rojo's `plugin/` folder at a tag, with its submodules, **unedited**.
  `plugin/upstream.json` records the tag, commit, submodule commits, and a hash of every file;
  a unit test fails on any edit.
- Rojo-Hub's changes to Rojo's files are a short series of patches in `plugin/patches/`, each a
  few lines that call into `plugin/RojoHub/` (all of Rojo-Hub's own code). The build assembles
  upstream + patches + `RojoHub/` into a staging folder and builds `dist/RojoHub.rbxm` from it.
- `node tools/plugin.mjs update v7.7.2` fetches the tag, replaces `plugin/upstream/`, rewrites
  `upstream.json`, applies the patches with a three-way merge, and lists any that conflict. That is
  the whole move to a new Rojo when no hook point changed.
- `UPSTREAM.md` keeps the licence notes and lists each patch and why.
- Viper: "for 3 lets not do it at runtime": the patches are applied at build time, never by
  replacing Rojo's functions while the plugin runs.
- `tools/plugin.mjs`: `stage` (the build), `check` (the unit test), `save` (patches from an
  edited stage), `update <tag>`. Patches are applied by the tool itself (exact context, moved hunks
  allowed, no fuzz), so building needs no git; `save` and `update` use git for diffs and
  `git merge-file`.
- The move itself: `init v7.7.0` made patches from the edited files (the staged result matched the
  old `plugin/` file for file), then `update v7.7.1` carried all four over with no conflict.
- 7.7.1's settings page calls `Version.isApiBlocked()`, which asks api.github.com (Studio prompts
  for the domain). A patch skips that while *Check For Updates* is off, Rojo-Hub's default.

### 5. Rojo 7.7.1

The plugin moves to 7.7.1 (through design 4), and the build pins rojo 7.7.1. Slots keep using each
repo's pinned rojo; the slot file stays verbatim, which both versions apply (M1).

## Measurements

- **M1 — live switch, 7.7.0 vs 7.7.1** (`node tools/live-switch-headless.mjs <verbatim|plain>
  <version>`, 2026-10-04). 7.7.0 verbatim: every switch and edit arrives over one session. 7.7.0
  plain: switches are dropped (as in 001). 7.7.1: switches apply with both verbatim and plain
  paths (its "myriad of `\\?\` problems" fix, rojo-rbx/rojo#1295). The verbatim rule stays while
  7.7.0 is supported.
- **M2 — deleting a subfolder of a worktree served earlier** (same tool, last step): rojo 7.7.0
  and 7.7.1 both exit (`Result::unwrap()` on `NotFound`).
- **M3 — the plugin's handling of an add it cannot create**: `Reconciler/reify.lua`, `pcall(
  Instance.new, ClassName)`; on failure the instance and its subtree go to the unapplied patch and
  `applyPatch` logs at debug level only. Not yet reproduced in Studio.
- **M4 — Rojo 7.7.0 → 7.7.1, `plugin/`**: `Version.txt`, `rbx_dom_lua/database.json`,
  `src/Version.lua` (`isApiBlocked`), `src/App/StatusPages/Settings/init.lua` (locks *Check For
  Updates* when api.github.com is blocked). Submodules unchanged.

- **M5 — Adopt.lua under Lune** (`@lune/roblox` DOM, `Instance.new` refusing
  `StarterCharacterScripts` as Studio does): a creatable add is created; `StarterCharacterScripts` is
  adopted; under it an existing `LocalScript` of the same name is adopted and a new one created; an
  owned instance is never adopted twice; with nothing to adopt it fails as before.
- **M6 — the agent's stop + start, 2026-10-04 08:26:43–47 UTC**: `stop` returned in 1 s, `start`
  4 s later answered with the new session.

## Checked

- `npm test` (64 tests): the service's `restarting` answer (unit, and end-to-end through a real
  crash of rojo 7.7.0 with a WebSocket playing the plugin), `unapplied` reports, `plugin.mjs
  check`. selene and StyLua are clean on the staged plugin.
- **In Studio (Viper, 2026-10-04)**: 0.21.0 installed in every profile, places reopened; Viper: "seems to work". Which of the cases (adopt on a live switch, resume through a crash and through stop + start, Disconnect during a hold, the unapplied report) were exercised one by one was not recorded.

## Acceptance criteria

- Switching a serving project to a branch whose project file adds `StarterCharacterScripts`
  (or another non-creatable node that exists in the place) shows its children in Studio, with no
  new session.
- Deleting a worktree the project served earlier (rojo crashes, the Hub restarts it) leaves Studio
  showing Connected throughout, with no notification, and the place matches the served tree after.
- Stopping and starting a project from the panel or an agent does the same for places synced to it.
- A session the user disconnected or declined is still never reconnected by itself (007).
- `plugin/upstream/` matches `upstream.json`; the build from upstream + patches gives a working
  plugin; `tools/plugin.mjs update` moves 7.7.0 → 7.7.1 with no manual step.
- The plugin and the build use Rojo 7.7.1. Checked in a real Studio.

## Non-goals

- Fixing rojo-rbx/rojo#1305 in Rojo or shipping a patched rojo.
- Keeping one rojo session across a restart (a restart is always a new session; design 2 hides it).

## Decisions (2026-10-04)

Asked as five questions; Viper: "for 3 lets not do it at runtime. for all the other questions just
do what makes the most sense for this project." So: adopt only where creating fails; hold 5 s, or
up to 60 s while the service says it is restarting; patches at build time; the plugin reports what
it could not apply and agents are told not to restart; plugin and build on 7.7.1, 7.7.0 projects
still supported (the tests serve with 7.7.0).
