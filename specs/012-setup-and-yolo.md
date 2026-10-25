# 012 — Setup commands for new worktrees, install checks in `ensure`, and yolo mode

Status: **draft** (review group D of `specs/feedback-2026-10-24.md`, items 8, 10 (install checks), 14
(decided: not built) and 22; `specs/feedback-2026-10-24-review.md` sections 3, 3b and 4). Asked for by
Viper's agents in the 2026-10-24 feedback session. Builds on 008 (agent control), 009 (open places,
the pattern for an off-by-default application setting) and 011 (`ensure`). Version bump on release:
0.23.0 if 011 ships as 0.22.0 (the service changes, so it needs a new version).

## Problem

1. **A new worktree is not ready to use.** `new_branch` (and the panel's New branch) runs `git worktree
   add` and then switches the project to it at once (`createBranch` in `hub.ts`). The worktree has no
   `Packages` (Wally), no `node_modules`, so luau-lsp, tests and anything that needs them fail. The
   agent works out the install commands, runs them itself, and does it in the wrong order or the
   wrong folder. Rojo-Hub already serves such a worktree from a borrowed copy that takes `Packages`
   from the main checkout (`planTree`, `PACKAGE_PATHS` in `project.ts`), which hides the problem from
   Studio but not from the tools.
2. **Order matters, and the obvious order crashes Rojo.** `wally install` clears `Packages`. If the
   worktree is already served, deleting a watched subfolder panics Rojo 7.7 (rojo-rbx/rojo#1305), and
   Rojo never unwatches. So installs must finish **before** the slot first switches to the worktree.
3. **Running installs in the main checkout is worse.** Worktrees without their own `Packages` borrow
   the main checkout's, so `wally install` there can crash every Rojo that borrows them.
4. **`ensure` cannot say what is missing** (011 left install checks to this spec), so an agent finds
   out when something fails later.
5. **Agents that must do something Rojo-Hub refuses have no sanctioned path.** Opening places is
   behind a toggle, and `stop`/`remove_project` refuse while a Studio place is synced. A user who
   trusts their agents wants one switch for all of it, clearly marked as dangerous.

## Design

### 1. Per-project setup commands (item 8)

**The setting.** `rojoHub.setupCommands`, `scope: "application"`, `ignoreSync: true` (commands are
not carried to another machine), default `{}`. A repo's `.vscode/settings.json` cannot set an
application-scoped setting, and the service never reads anything from a repo for this.

```jsonc
"rojoHub.setupCommands": {
  "C:\\Users\\me\\games\\TheLaundryShift": [
    { "command": "rokit", "args": ["install"] },
    { "command": "wally", "args": ["install"] },
    { "command": "npm",   "args": ["ci", "--ignore-scripts"], "cwd": "tools", "timeoutSeconds": 300 }
  ]
}
```

- **Key**: the project's repo path (the primary checkout, `slot.repoPath`), compared normalised (case
  insensitive, one slash style, no trailing slash, no `\\?\`). A repo path, not a project ID, because
  IDs are internal and the setup belongs to the checkout: two projects of one repo share it.
- **Value**: at most 10 commands, run in order. Each is `{ command: string, args?: string[], cwd?:
  string, timeoutSeconds?: number }`. `command` is an executable name or absolute path. `cwd` is
  relative to the worktree, with no `..` and no absolute path (default: the worktree root).
  `timeoutSeconds` 1 to 3600, default 600; the whole list is capped at 30 minutes.
- **Argv form, no shell.** The process is started with `spawn(command, args, { shell: false,
  windowsHide: true })`. Nothing an agent sends is put into `command`, `args` or `cwd`. The only
  agent-influenced input is the branch name, passed as the environment variable `ROJO_HUB_BRANCH`
  (already validated by `checkBranchName`); `ROJO_HUB_WORKTREE`, `ROJO_HUB_SETUP=1` are set as well.
- **Windows `.cmd` shims** (`npm`, `npx`, `pnpm`): `npm` is `npm.cmd`, which cannot be spawned without
  a shell. The command is resolved through `PATH` and `PATHEXT`; a `.cmd` or `.bat` result is run as
  `cmd.exe /d /s /c` with the resolved path, and the setting is invalid (reported when saved and when
  the service loads it) if any of its args contain `& | < > ^ % " ` or a newline. Executables run
  directly. The service's `PATH` gets Rokit's tool-storage `bin` folder added in front, so `wally` and
  `rokit`-installed tools resolve however VS Code was started. (Whether a Rokit shim opens a console
  window when started with `windowsHide` from the console-less service is measured when built; the
  CLAUDE.md rule about the shim concerns `rojo serve` only.)

**Opt-in: the commands are the toggle.** There is no separate `enableSetup` switch, and yolo is not
needed. Reasons: the user wrote every argument themselves in their own settings (a human act as
deliberate as ticking a box), an empty setting runs nothing, an agent cannot add or edit a command
(no MCP verb reaches the setting) and cannot make a command do anything but run. A second toggle would
only be a way to forget why nothing happened. The warning a user needs is in the setting's description
("DANGEROUS: runs these programs on your machine whenever Rojo-Hub makes a worktree; `npm ci` runs the
repo's install scripts, so prefer `--ignore-scripts`"). Yolo does not change setup in any way.

The service's `PUT /settings` accepts `setupCommands` from any local program, like every other setting
(web pages are already refused, `allowedRequest` in `server.ts`); a local program could run commands
anyway. The extension sends the user's global value only, never a workspace value.

**When they run.**
- **`new_branch` (MCP) and New branch (panel)**: after the worktree exists (`git worktree add`, or
  Orca's create) and **before** `this.switch(id, { kind: "worktree", path })`. The project keeps
  serving what it served; the new worktree has never been read by a running Rojo, so deleting and
  recreating `Packages` is safe.
- **`ensure`** (design 2): for a worktree that exists but was not made by `new_branch` (an Orca
  worktree, a hand-made one) or whose setup failed, under the conditions in design 2.
- Never in the main checkout (`slot.repoPath`, or any worktree whose `git rev-parse --git-dir` equals
  its `--git-common-dir`), never in a worktree a running Rojo has read (design 2), never from
  `serve_here` or `switch` (they only serve; a worktree with a setup running is refused with
  "setup is still running in <path>; call ensure to wait for it").
- A project with no entry runs nothing, and `new_branch` behaves exactly as today.

**Progress and answers.**
- The panel's New branch shows a progress notification ("Setting up feature-x: wally install (2 of
  3)") and waits for the end; the HTTP call has no short timeout, since each command has its own.
- The MCP `new_branch` waits at most **40 seconds** (below Codex's 60 s default tool timeout). If the
  setup is still running it answers that the worktree exists, setup is running in the background at
  command N, and the agent should call `ensure` from that worktree, which joins the running setup
  (waits for it, up to its own `timeout`) and then serves. Nothing is switched and no claim set until
  setup has succeeded.
- Per-worktree jobs: one setup runs per worktree at a time (a second request joins it), kept in
  memory with `{ state: running | ok | failed, command index, tail }`, shown in `status` (text, and
  `data.setup` entries `{ path, state, step, of }`).
- **Output**: stdout and stderr merged; the answer carries the last 40 lines (at most 4 KB) of each
  failed command and one line per command that succeeded (exit 0, seconds). The full output is not
  kept in memory beyond the tail.

**Failure.** A non-zero exit, a spawn error (`command` not found), or a timeout (the process tree is
killed with `taskkill /T /F`) stops the list. The worktree and branch are **kept** (never deleted:
deleting is outside this feature), the project is **not** switched to it, no claim is taken, the
answer is an error naming the command (`wally install`, step 2 of 3), the exit code or "timed out
after 600 s", the output tail, the worktree path, and what to do: fix the cause and call `ensure`
from the worktree (setup runs again when its checks still fail), or run the command by hand. The panel
shows the same text as an error message with **Open folder** and **Show setup log**. The earlier
commands that succeeded are not undone.

**Audit log.** `audit.jsonl` in the hub home (`%LOCALAPPDATA%\RojoHub\`), one JSON object per line,
rotated at 1 MB to `audit.old.jsonl`. Each setup command writes `{ time, actor: "panel"|"mcp",
action: "setup", project, worktree, argv, cwd, exitCode, seconds, outputTail (2 KB) }`. It is written
under every circumstance, with or without yolo. `Show setup log` opens the file.

### 2. Install checks in `ensure` (item 10)

`ensure` (011) gets a check step that never fails it and a setup step that can.

**Checks** run against the worktree of `path` (`worktreeRoot`) and are listed in the answer's
`data.checks: [{ name, ok, detail }]` and as `warning:` lines in the text; `ensure.warnings` carries the
not-ok ones. They do not change `ready`. The checks:

| name | ok when | not ok says |
| --- | --- | --- |
| `rojo` | `resolveRojo` finds the pinned binary | the error; nothing can be served |
| `packages` | no `wally.toml`; else, for each non-empty section of `wally.toml` (`[dependencies]` to `Packages`, `[server-dependencies]` to `ServerPackages`, `[dev-dependencies]` to `DevPackages`), the folder exists in the worktree | which folder is missing, and "served from the main checkout's copy" when the project serves this worktree borrowed |
| `node_modules` | no `package.json`; else it has no `dependencies` or `devDependencies`, or `node_modules` exists | `node_modules` missing |
| `sourcemap` | `rojoHub.sourcemaps` is off; else the slot's sourcemap watcher state is `watching` and `sourcemap.json` exists in the served worktree | the watcher's `detail` (it already says why), or "sourcemap.json not written yet" |

The `sourcemap` check looks at the served worktree, so before `ensure` has served it, it reports on
whichever worktree is served and says so. All reads are of files, with no side effects.

**Setup step** (new step `setup` in `steps`, between `start` and the claim/serve step, so a long
install does not hold the claim). It runs only when **all** hold:

1. `setupCommands` has an entry for the project's repo.
2. The worktree is a linked worktree (not the main checkout).
3. At least one of the `packages` / `node_modules` checks is not ok. (Setup commands are not required
   to produce exactly those folders; this is the signal that the worktree has not been set up. A
   project whose setup produces neither is set up by `new_branch` only.)
4. **No running Rojo has read the worktree.** For every slot (any project, any session) that is
   `running` or `starting`: the worktree is not its current target and not in the set of targets it
   served since its Rojo started. The hub records that set per slot on every switch and start, and
   empties it when the slot's Rojo stops (a stopped slot has read nothing). If the worktree fails
   this, setup is **not run**: `ensure` reports the missing items as warnings and adds a
   `skipped` setup step whose detail says "worktree is being served; stop the project to install, or
   install by hand" (never offering to stop).

Otherwise it runs the list as in design 1 (joining a job already running for that worktree) and
`ensure` continues to the claim/serve step on success. On failure `ensure` returns `failure.reason =
"setup_failed"` with the command, exit code and tail, having started the project but not served the
worktree. If `ensure`'s `timeout` runs out while the job is still running: `failure.reason =
"setup_running"`, "call ensure again". The `outputSchema` of `ensure` gains the `setup` step name,
`checks`, `warnings`, and the two reasons; they are additive, so older clients ignore them.

Because step 4 refuses a worktree Rojo has read, `ensure` can never repeat the #1305 case, and if
the project is stopped (nothing read), `ensure` may set up any worktree whatever it was served as
before.

### 3. Item 14: stop, checkout/install, start is not built

A `safe` verb that serves a placeholder, runs a command and serves back protects nothing: Rojo never
unwatches a folder it has read, and M2 showed that a folder served earlier in the session still
crashes it. The only guard that works is stop, run, start, which ends Rojo's session and disconnects
Studio. That is bad practice and Rojo-Hub does not offer it. The docs (`docs/how-it-works.md`, the
agents guide) say so, and say what to do instead:

- To get a ready worktree, make it with `new_branch` (or the panel's New branch) with setup commands
  configured: the install runs before Rojo ever reads the worktree.
- To switch to an existing branch, use `switch` or the picker. Never `git checkout` or install inside
  a folder a running Rojo serves or has served; use another worktree.
- Never run installs in the main checkout while other worktrees borrow its `Packages`.
- `stop` followed by `start` is for changing the project file or recovering from an error, not for
  making Studio notice a switch (008, 011).

### 4. Yolo mode (item 22)

One master setting, `rojoHub.yolo`: boolean, `scope: "application"`, `ignoreSync: true`, default
**off**. Its description begins "DANGEROUS:" and says what it lifts. No MCP verb or API call from an
agent can turn it on or off; only the extension pushes it, from the user's global value. A repo's
`.vscode/settings.json` cannot set it.

**What it lifts today, exactly** (and nothing else):

| Where | Without yolo | With yolo |
| --- | --- | --- |
| `hub.openPlacesOn` (`hub.ts`): effective value = `openPlaces \|\| yolo`. Used by `openPlace` / `openAllPlaces` / `warmPlaceNames`, the `ensure` open step, `open_place`, `status` text, the panel's `snapshot.openPlaces` | refused with `OFF_MESSAGE` | behaves as on: agents may open places; the panel shows Open, Close and Reopen and Open all |
| `guardStop` in `mcp.ts`, the synced-place branch (`if (!mine && synced.length > 0) throw`), used by `stop`, `remove_project`, `stop_group`, and `start_group` with `only: true` | refused while a Studio place is synced and the caller holds no claim | not refused; the stop happens and Studio disconnects |
| `guardStop`, the claim branch (`claim && !mine`) | refused | **still refused** (decided) |
| `stop_all` (always needs `force` today) | refused without `force` | proceeds without `force`, but skips every project another agent has a live claim on and says which were kept (so claims hold); with `force` it is as today |
| `force` flags (claims, `wait`) | as today | as today. `force` was decided "not gated" (it is not moved behind any toggle); yolo does not make it default |

Everything else in the review's table (`allowRestart`, `runLuau`, `pluginDevHost`) does not exist yet;
when those groups add their toggles they add a line here, and the status text lists what yolo covers
at that time. Setup commands are **not** gated by yolo (design 1): they run from user-written
settings alone.

**Not covered** (decided): deleting worktrees or branches (Rojo-Hub does not do this for agents), and
playtest/publish (not built). Nothing here changes what a claim protects.

**Turning it on.**
- From the settings UI: when a window sees `rojoHub.yolo` change to true, the focused window shows a
  modal warning ("Turn on Rojo-Hub yolo mode?") listing what the table lets agents do, with **Turn
  on** and **Cancel**. Cancel writes `false` back to the global setting. The service is not told
  `yolo: true` until the prompt is accepted (pushSettings holds the value back while a prompt is
  unanswered, tracked with a flag in `globalState` so other windows do not push it early).
- Editing settings.json directly skips the modal (there is no hook before the file is read); the
  banner and status bar item appear anyway, and the service receives the value at once.
- No auto-off (decided): it stays on until a human turns it off.

**Red where VS Code allows.**
- A status bar item (left, priority 100, text `$(warning) ROJO-HUB YOLO`, `backgroundColor` =
  `ThemeColor("statusBarItem.errorBackground")`, tooltip listing what is lifted), in every window
  while the setting is on. Clicking it offers **Turn yolo mode off** or **Keep it on**. It is shown
  from the setting even when the service is not running.
- A red banner at the top of the panel (`PanelState.yolo`, an error-coloured box: "YOLO MODE IS ON.
  Agents may open Studio places and stop projects Studio is using. Turn off"), with a button that
  writes `false`.
- The setting's description in `package.json` starts with "DANGEROUS:" (the settings UI cannot
  colour it).

**Visible to agents.** `status` begins with "Yolo mode is ON: the user lifted Rojo-Hub's guards. You
may open Studio places and stop or remove projects that Studio places are synced to; other agents'
claims still hold. Everything you do is logged." when on, and `status`'s and `ensure`'s
`structuredContent` carry `yolo: boolean` (additive to 011's `outputSchema`). The server instructions
mention the field. Tool descriptions stay as they are (an agent's tool list is fixed at start).

**Audit.** While yolo is on, every state-changing MCP call (`start`, `stop`, `stop_all`,
`remove_project`, `switch`, `serve_here`, `ensure`, `new_branch`, `open_place`, group verbs, ...) writes
`{ time, actor: "mcp", action, project, args summary, yolo: true, lifted: boolean }` to `audit.jsonl`;
`lifted` is true when yolo is what allowed it (a stop that would have been refused, an open that
`openPlaces` alone would have refused). Turning yolo on or off writes an entry too.

**Individual toggles stay.** `rojoHub.openPlaces` still works alone; yolo is the shortcut.

## Acceptance criteria

1. `rojoHub.setupCommands` is application-scoped, `ignoreSync`, default `{}`; with it empty (or no
   entry for the repo) `new_branch` and the panel's New branch run no process and behave as before.
2. With an entry, `new_branch` runs its commands in order, in the new worktree (or its `cwd`
   subfolder), after the worktree exists and **before** the slot switches to it: a test records that
   `hub.switch` was not called until the last command exited, and that the project's rojo target was
   unchanged meanwhile.
3. Commands are started with `shell: false` from the configured `command`/`args` only. A test with an
   agent-chosen branch name containing shell metacharacters shows it appears nowhere in argv, and only
   in `ROJO_HUB_BRANCH`. `cwd` containing `..` or an absolute path, more than 10 commands, a `.cmd`
   command whose args contain `& | < > ^ % "`, or a non-array `args` is rejected with a message
   naming the entry.
4. A command exiting non-zero, not found, or running past its timeout (default 600 s) stops the
   list, kills the process tree on timeout, keeps the worktree and branch, does not switch, sets no
   claim, and the answer names the command and step, the exit code or timeout, the last 40 lines of
   output (at most 4 KB) and the worktree path. Earlier successful commands are listed.
5. `new_branch` over MCP returns within 45 s whatever the commands do; if setup is still running it
   says so and that `ensure` from the worktree will wait for it. `serve_here` and `switch` to a worktree
   with a running setup are refused with that message.
6. Setup never runs in the main checkout, in a worktree whose git dir equals its common dir, or in a
   worktree a running Rojo has read or is serving (criterion 9), whichever way it is requested.
7. Every setup command writes an `audit.jsonl` line (argv, cwd, exit code, seconds, output tail),
   with yolo off as well as on; the file rotates at 1 MB.
8. `ensure` answers `checks` for `rojo`, `packages`, `node_modules` and `sourcemap` and adds the
   not-ok ones as `warnings`; `packages` follows `wally.toml`'s non-empty sections; none of them
   changes `ready` or fails the call.
9. `ensure` runs the setup commands only when an entry exists, the worktree is linked, a
   packages/node_modules check is not ok, and no running or starting slot targets the worktree or has
   served it since its Rojo started; otherwise it runs nothing and reports the warnings and a skipped
   `setup` step. A stopped project may be set up for any linked worktree.
10. `ensure` after a failed setup runs it again; a second `ensure` once the checks are ok runs nothing.
    Two `ensure` calls for one worktree at once run the setup once.
11. `rojoHub.yolo` is application-scoped, `ignoreSync`, default off, description starts "DANGEROUS:".
    Turning it on from the settings UI shows the modal; Cancel puts the setting back to false and the
    service never receives `true`. Accept pushes it.
12. With yolo on and `openPlaces` off, `open_place`, the `ensure` open step and the panel's open
    actions work; with yolo off they refuse with `OFF_MESSAGE` as in 009.
13. With yolo on, `stop`, `remove_project`, `stop_group` and `start_group only` no longer refuse
    because a Studio place is synced to the project; each still refuses while another agent's claim is
    live (without `force`). `stop_all` without `force` stops the unclaimed projects and names the
    kept ones. With yolo off all of this is exactly as today (existing tests unchanged).
14. While on, a status bar item with `statusBarItem.errorBackground` and the text "ROJO-HUB YOLO" is
    visible in every window (including with the service stopped), and the panel shows the red banner;
    both disappear when it is turned off.
15. `status` text starts with the "yolo mode is ON" line and `structuredContent.yolo` is true; both
    absent/false when off. `ensure`'s data carries `yolo` too.
16. While yolo is on, each state-changing MCP call writes an audit line with `yolo: true` and `lifted`
    set correctly; turning it on and off is logged.
17. No MCP tool or other agent-facing call can change `setupCommands` or `yolo`; a request with a web
    `Origin` is refused as before.
18. `docs/how-it-works.md`, the site, the agents guide and the MCP server instructions describe
    setup commands, the install checks, yolo, and why stop/checkout/install/start is not built.

## Non-goals

- Setup commands from a repo file (`rojo-hub.json`, `.vscode`, `package.json` scripts), or any
  interpolation of agent-supplied text into a command.
- A shell, pipes, environment variable expansion or `&&` in a command (use several commands, or a
  script you wrote and name as the `command`).
- Running setup in the main checkout, in a served or previously served worktree, or on `serve_here` /
  `switch`; stopping a project to make room for it.
- Item 14 (a `safe` verb, or any stop/run/start helper); deleting worktrees or branches after a failed
  setup; a panel "run setup again" button (the agent's or user's `ensure`, or a terminal, does it).
- Orca's own setup hooks: whether Orca runs a script on create is not measured; if it does, both run.
- Gating `stop`/`force` behind a toggle (decided not gated), ignoring claims under yolo, auto-off
  timers, and deleting work, playtest or publish under yolo.
- `allowRestart`, `runLuau`, `pluginDevHost` (their groups add their lines to the yolo table).

## Open questions (a default chosen for each)

1. Key by repo path (default) or also accept a project name? Default: repo path only; the panel
   editor fills it in, so nobody types it.
2. Should `ensure` run setup for a worktree it did not create? Default: yes under the conditions
   above, since otherwise Orca-made worktrees (the common agent case) never get set up.
3. Per-command `env`? Default: no (nothing a user needs yet; avoids secrets in settings).
4. Does the panel need a way to edit commands? Default: yes, a card menu item **Setup commands…**
   (below), because hand-writing JSON with escaped Windows paths in settings.json is the likeliest
   source of mistakes. Editing settings.json stays supported.
5. Should yolo list in `status` which toggles it covers? Default: yes, one sentence naming the lifted
   guards, kept in sync with the table by a unit test.

### The panel editor (default for question 4)

The project card's menu (`menuItems` in `src/webview/main.ts`) gets **Setup commands…** (above
*Build place file…*). It opens an inline editor for the card's repo: a textarea, one command per
line, parsed as a program followed by arguments with only double quotes for grouping (no escapes, no
expansion), and below it the parsed argv for each line so the user sees exactly what will run, with a
warning icon on lines that are invalid. **Save** sends `{ type: "setSetupCommands", id, text }`; the
extension validates and merges this repo's entry into the user's global `rojoHub.setupCommands`
(read `config.inspect("setupCommands").globalValue`, replace the key, `update(..., Global)`) and
tells the user it was saved to their user settings. Per-command `cwd` and `timeoutSeconds` are not
in the editor (settings.json only); lines that settings.json defined with those are shown read-only
with a note rather than rewritten. The editor never appears in the panel for a user with no service
running (the setting is still edited; the service gets it at the next push).

## Test plan

**Unit** (`src/test/unit.test.ts`, node:test):
- Setting validation: entry shapes, limits, `..`/absolute `cwd`, `.cmd` metacharacter rule, key
  normalisation (case, slashes, `\\?\`, trailing slash).
- The runner against small node scripts as `command`: order, exit codes, tail truncation (40 lines /
  4 KB), timeout kills the tree, spawn error for a missing command, `cwd`, environment variables, no
  shell (a branch name `a&b` appears only in env).
- `createBranch` with a stub git and a stub switch: switch is called after the last command and not
  at all on failure; the worktree is kept; no claim set.
- Install checks: `wally.toml` sections to folders, `package.json` dependencies, borrowed wording,
  `sourcemap` states; they never change `ready`.
- `ensure` setup eligibility: main checkout, a worktree that is the slot's target, a worktree in the
  served-since-start set, a stopped slot, concurrent calls (one run), retry after failure.
- Hub served-set bookkeeping: filled on switch and start, emptied when rojo stops.
- Yolo: `openPlacesOn` with each combination of the two settings; `guardStop` for each caller (claim
  mine, claim other, synced only, force); `stop_all` keeping claimed projects; `status` text and
  `structuredContent.yolo`; audit lines (`lifted` right); `outputSchema` of `ensure` and `status`
  still valid; `package.json` settings (scope, default, description prefix).
- Audit log: append, rotate at 1 MB.

**End-to-end** (real rojo 7.7, temp git repo, `npm test`): `new_branch` with a setup that writes a
`Packages/marker.txt` through a node command, asserting the file exists when the slot first serves
the worktree and that rojo never restarted; a failing command keeps the worktree and does not switch;
`ensure` on a hand-made worktree runs setup, and on a served one only warns; yolo on and a synced
(stubbed) Studio place: `stop` succeeds, with a claim by another worktree it still refuses.

**Smoke** (`tools/smoke-bundle.cjs`, throwaway home): the bundle loads with the new settings, `PUT
/settings` with `setupCommands` and `yolo`, `audit.jsonl` is created in the throwaway home and not in
the real one, `dist/uninstall.js` leaves nothing behind that it did not before.

**Needs real VS Code and Studio (to be reported plainly if not done):** the status bar item colour
and the panel banner (looks red in the real theme), the modal on turning yolo on from the settings UI
and Cancel reverting it, with several windows open; the card's Setup commands editor and the New branch
progress notification; `wally install`, `rokit install` and `npm ci` through the real Rokit and
Windows `.cmd` handling, including whether a console window flashes; a real new worktree set up and
then served to Studio without Rojo restarting; Orca's own worktree creation next to setup commands.
