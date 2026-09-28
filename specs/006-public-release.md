# 006 — Public release

Status: **implemented on `chore/public-release` in 0.18.0**; not yet tried against a real Studio. Asked for by Viper: "we need to get this
ready for a public release so this needs to be compatiable out of the box for other people too. so we
need to know what is required to use it and make sure you only need those things for it to run." Then:
"fix all of the issues found and make sure everything is robust", and "we just want the inital page
load to take up time and then after that everything feels fast to the user and auto update."

## Problem

Rojo-Hub was built for one machine. Before other people install it, three things have to hold:

1. What it needs is known, stated, and checked: a missing or too-old requirement says so plainly
   instead of failing somewhere later.
2. It survives what other machines and other habits do to it: deleted worktrees, half-saved project
   files, two windows clicking at once, a damaged state file, locked-down PowerShell, junctioned
   folders, other signed-in users, web pages probing localhost.
3. The panel feels immediate: after the first load, every click shows its result at once, and
   changes made anywhere (another window, an agent, a crash, a checkout) appear without a refresh.

## Requirements (what a user needs)

| Needed | Why | Checked |
|---|---|---|
| Windows 10/11 | Process control and the verbatim-path live switch are Windows-specific (001) | Activation says so on other platforms |
| VS Code 1.101+ | `engines` | VS Code |
| git 2.31+ on PATH | worktrees, branches, the port seed; `rev-parse --path-format=absolute` is 2.31 | Service start and every Add |
| Rokit, with the project's pinned Rojo installed | Rojo is run from Rokit's tool storage (001, "no console window") | Start says which version to `rokit install` |
| A toolchain file pinning Rojo (`rokit.toml`, `aftman.toml` or `foreman.toml`) | picks the version | Start |
| Rojo 7.7+ and its Studio plugin | protocol 5, the Studio-connected light | Warning on older pins |

Not needed: Node.js (the service runs on VS Code's runtime), Orca, Wally, Claude Code or Codex (all
optional). Aftman or Foreman installs, a `rojo` on PATH and the Rojo VS Code extension are ignored.
Supporting them is a non-goal for this release; the docs say Rokit is required and how to switch.

## Acceptance criteria

### Robustness (service)

- [x] A file watcher error (the served worktree deleted in borrowed mode) never ends the service; any
      uncaught error is logged to `service.log` and the service carries on.
- [x] A rojo is treated as crashed only after 3 unanswered status checks in a row **and** no rojo for
      the slot is running. One slow answer never restarts a healthy rojo.
- [x] Finding and stopping rojo processes no longer blocks the service (asynchronous PowerShell), and
      the command-line match works under Constrained Language Mode.
- [x] A project file that briefly fails to parse (auto-save mid-edit) keeps its last `servePort`; the
      port does not move and back.
- [x] A project in error counts as serving for Stop, a group's Stop and Stop all.
- [x] Two adds of the same repo at once register it once.
- [x] Work queued behind a Remove (a Start, a Switch) is refused instead of acting on the removed
      project.
- [x] Only Rojo-Hub's own views are pruned from git's worktree list; the user's worktrees on an
      unplugged drive are left alone.
- [x] A damaged `registry.json` is kept as `registry.corrupt-<time>.json`, the previous save
      (`registry.json.bak`) is restored, and the service starts. Saves are flushed to disk.
- [x] Fetch never shows Git Credential Manager's sign-in window.
- [x] The branch picker's background watch recovers after a watch error.
- [x] Reading a rojo log that is being renamed never throws.
- [x] The service port (34870) is never given to a project; a one-port range is accepted.
- [x] `/build` over HTTP takes only an absolute `.rbxl`/`.rbxlx` path, like the agent tool.
- [x] Creating a view does not run the repo's git hooks.
- [x] Missing or old git is reported once, clearly, on Add and in `service.log`.
- [x] Views are recognised behind junctions or redirected folders.
- [x] The service exits after 15 minutes with nothing serving, no window subscribed and no request,
      so it does not keep `Code.exe` in use for nothing.

### Security

- [x] The service answers only requests whose Host is the loopback address and its port (no DNS
      rebinding, not even reads) and with no browser Origin (localhost pages included).
- [x] A window never uses another Windows user's service.

### Extension, packaging, docs

See the list in the change; each item from the pre-release audit is fixed or explicitly deferred
below.

### Responsiveness

- [x] The service pushes the panel's whole state (`GET /events`, server-sent events) on every change,
      within 150 ms; windows stop polling while subscribed and fall back to polling if the stream
      drops.
- [x] Clicks update the panel at once (optimistic state), and the service's answer confirms or
      corrects it.
- [x] Dropdowns (branch picker, project files, group add, menus) open from data already in the panel,
      with no request in the way.

## Non-goals

- macOS/Linux. The Unix code paths stay but are untested; activation says Windows only.
- Rojo installed by Aftman, Foreman, cargo or the Rojo extension.
- Rewriting git history. It holds no secrets (checked for keys, tokens and passwords; the author address is GitHub's noreply one), only local paths and project names, so it is kept as is.
