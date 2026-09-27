# Rojo-Hub: brief for the first agent

Written 2026-09-27 by the Claude session in `C:/Users/green/ROBLOX_VSCODE/TheLaundryShift`, after a
design conversation with the user (Viper, Vlux Entertainment). This repo is empty apart from this
file. Read all of it before doing anything.

## What the user wants

A local developer tool for VS Code called **Rojo-Hub**. In the user's words: "a local
extension/tool that allows me to automatically connect roblox places into rojo all on different
ports so i can work on multiple projects at once. I also need it to be able to switch the files on
that port to whatever branch files i want to view without disrupting the port." And later: "as long
as this can work well with orca with the switching branches and i can connect to a place for every
project that will work very well."

So the two hard requirements are:

1. **One Rojo port per project, many projects at once.** Each project gets a fixed port that never
   changes, so every Studio place can connect to its own project and reconnect automatically.
2. **Branch switching on a live port.** Pick any branch or Orca worktree of a project and the port
   starts serving those files, without Studio's Rojo connection dropping.

It is a personal/team tool, not game code. It is private and installed locally (a `.vsix`), never
published to the marketplace.

## Facts already verified (from Rojo's own source, 2026-09-27)

The user's projects use **Rojo 7.7.0**, pinned per project through `rokit.toml`.

- **The Studio plugin remembers an address per place.** `plugin/src/App/init.lua` keeps a
  `priorEndpoints` setting keyed by `tostring(game.PlaceId)`, each entry
  `{ host?, port?, projectName, timestamp }`. It is written on every successful connect. Host and
  port are stored only when they differ from the defaults, so a place on the default port 34872
  stores nil for it. Entries older than 12,960,000 seconds (150 days) are dropped.
- **The plugin can auto-connect.** With the plugin's "Auto Reconnect" setting on
  (`autoReconnect`, off by default), opening a place looks up that place's saved endpoint, asks the
  server there for its info, and connects **only if the server's `projectName` equals the saved
  one**. Consequences for the design:
  - the served project name must stay identical across branch switches, so only `$path`s change;
  - every registered project needs a unique name, or a place could auto-connect to the wrong one.
- **There is no need to fork the Rojo plugin.** The user connects each place by hand once; after
  that the plugin does it. Pre-writing `priorEndpoints` into the plugin's settings file was
  considered and parked: the file location is unverified and Studio likely overwrites it.
- **`servePlaceIds`** in a project file makes the plugin refuse (or confirm) a place not on the list.
  It is a second safety net against a place connecting to the wrong project.
- **Rojo 7.7 answers `GET /api/rojo` in MessagePack only.** `projectName` can be read by finding
  the key bytes and decoding the following str value. Prior art below does exactly this.

## The one thing NOT verified, and it decides the design

Plan: each project slot serves a **generated project file** (a copy of the project's
`default.project.json` with every `$path` rewritten to point into the chosen worktree). Switching
branches rewrites the paths **while the same `rojo serve` process keeps running**. Restarting Rojo
instead gives a new session, and the Studio plugin drops the connection; a proxy in front of the
port does not help, because the plugin notices the session change.

Nobody has yet confirmed that Rojo 7.7 applies a changed `$path` in its project file live, over the
existing session, and starts watching the new folders on Windows. **Measure this before building
on it** (the user's rule: find the deterministic engine observable first, no workarounds or
thresholds). Test: serve a project, connect Studio, rewrite the project file's paths to another
worktree, and check whether Studio receives the change without disconnecting. Also check a second
switch back, and a file edit in the new worktree after the switch. Needs the user and Studio; ask
them to do the Studio side and tell you what they saw, or use the Roblox Studio MCP tools if they
are connected in your session (reading state is fine; do not start play-tests unasked).

If it fails, the fallback is one Rojo process per branch plus some way to move the plugin's
connection, which likely does need a patched plugin. Bring that to the user before building it.

## Prior art: port it, do not reconstruct it

`C:/Users/green/ROBLOX_VSCODE/TheLaundryShift/Commands/ServeWorktree.mjs` (backs that repo's
`/JumpTo` skill) already solves most of the single-project version: it lists git worktrees, writes a
`worktree.project.json` with every `$path` redirected into a worktree using relative paths, keeps
`Packages`/`ServerPackages` pointed at the primary's copies when a worktree has not run Wally (and
warns when the worktree's `wally.toml` differs), stops only its own `rojo serve` (Rokit's shim and
the real binary are both `rojo.exe`), waits for the port to free before restarting, and reads
`/api/rojo`. Read it in full and port that logic; the difference is that Rojo-Hub must switch
without restarting. The user's standing rule: "copy X" means port X's real source and change only
what was named.

The Rojo-Hub default port range must avoid **34872**, which `/JumpTo` uses today. Whether Rojo-Hub
later replaces `/JumpTo` is still an open question for the user.

## Orca

The user runs every project and worktree through **Orca** (`orca.exe` on PATH; `orca --help`,
`orca agent-context` prints the machine-readable schema). Useful, all with `--json`:

- `orca repo list`: registered projects, each with `id`, `path`, `displayName`.
- `orca worktree list`: every Orca worktree, with `path`, `branch` (`refs/heads/...`), `repoId`,
  `displayName`, `comment`, `isMainWorktree`. Orca worktrees are ordinary git worktrees, most under
  `~/orca/workspaces/<Repo>/`, so `git worktree list --porcelain` sees them too.

Rojo-Hub should offer both: the worktrees that already exist (Orca's names are what the user
recognises), and any other branch. A branch with no worktree needs one to serve from; git refuses to
check out a branch already checked out elsewhere, so use a detached, Hub-owned view worktree kept
outside Orca's folders, and clean those up.

## Suggested shape (a proposal, not a decision)

- **A small background service** (Node) owns the registry of slots (project, name, port, place IDs,
  currently served worktree) and the `rojo serve` processes, with a small local HTTP API. It is
  separate because VS Code extensions die with their window and the user keeps several windows open.
- **A VS Code extension** (TypeScript) as the front end: a sidebar of slots showing port, branch and
  connection state, with start, stop, switch branch through a searchable picker, and view log.
- Each project's own `rokit.toml` decides which `rojo` binary serves it.

## How to work with this user

- **Start with a spec**, `specs/001-<slug>.md`: problem, acceptance criteria, non-goals. Then the
  live-switch measurement above. Then the design and code. Keep the spec current.
- **Ask design questions as plain numbered text with a default for each**, not through the question
  dialog; that dialog lost the user's answers once in a worker session.
- **Batch feedback gets logged as a list first** and fixed only on the user's go-ahead.
- **Git**: never commit to `main`. Work on a branch (start with `feat/rojo-hub-foundation` or
  similar), commit freely with loose conventional commits (`feat(Scope): ...`), each ending with the
  `Co-Authored-By` line your session gives you. There is **no GitHub remote yet**; the user decides
  whether and where to create one. Never open or merge a pull request unless the user asks.
- Report outcomes plainly. Green checks mean the code is well-formed, not that it works; say what
  was and was not tried against a real Studio.
- Add a `CLAUDE.md` for this repo once the shape settles, with the commands and rules above.
