# How Rojo-Hub works

The complete description of Rojo-Hub as built: every feature, command and setting, what happens
underneath, where files live, and the known limits. It is written to be the source for user
documentation. Version 0.4.0, 2026-09-27. For why each design choice was made, with the
measurements behind it, see [`specs/001-rojo-hub-foundation.md`](../specs/001-rojo-hub-foundation.md).

## Contents

1. [What it does](#1-what-it-does)
2. [Concepts](#2-concepts)
3. [Install, update, uninstall](#3-install-update-uninstall)
4. [Where to find it in VS Code](#4-where-to-find-it-in-vs-code)
5. [Projects](#5-projects)
6. [Ports](#6-ports)
7. [Connecting Studio](#7-connecting-studio)
8. [Switching branches](#8-switching-branches)
9. [Groups](#9-groups)
10. [The background service](#10-the-background-service)
11. [Files on disk](#11-files-on-disk)
12. [Settings](#12-settings)
13. [Commands](#13-commands)
14. [Known limits and troubleshooting](#14-known-limits-and-troubleshooting)
15. [For developers](#15-for-developers)

---

## 1. What it does

Rojo-Hub is a private VS Code extension for Roblox developers who use Rojo and work on several
projects, or several branches of one project, at the same time.

- **Every project gets its own Rojo port**, and several projects can serve at once. Each Studio
  place connects to its project once; after that the Rojo plugin reconnects it by itself.
- **Any project can be switched to another branch or worktree while it is serving**, and Studio
  stays connected: it receives the difference as one update instead of disconnecting.
- **Projects can be grouped** so a set of them starts, stops, or takes over as a profile, together.

It works with Orca worktrees, showing them under Orca's names, and with plain
git branches and worktrees.

## 2. Concepts

| Term | Meaning |
|---|---|
| **Project** (in code: *slot*) | One registered Rojo project: a git repo with a project file, normally `default.project.json`. Identified by its Rojo project `name`. |
| **Port** | The TCP port the project's Rojo listens on, `localhost:<port>`. Fixed per project (see [Ports](#6-ports)). |
| **Target** | What the project is currently serving: a **worktree** (served in place) or a **branch** with no worktree (served from a *view*). |
| **Primary checkout** | The repo's main folder, the one other worktrees belong to. Registration always stores this, whichever worktree you registered from. |
| **View** | A folder Rojo-Hub creates to serve a branch nobody has checked out: a detached git worktree of that branch's commit, under `%LOCALAPPDATA%\RojoHub\views\`. |
| **Group** | A named set of projects started and stopped together, like a profile. |
| **Service** | A small background program that owns the projects and their Rojo processes, separate from VS Code windows. |
| **Session** | One run of `rojo serve`. The Studio plugin stays connected only while the session stays the same; restarting Rojo starts a new one. |

## 3. Install, update, uninstall

Rojo-Hub is distributed as a `.vsix` file, never through the marketplace.

**Build it** (from the RojoHub repo):

```sh
npm install
npm run package          # produces rojo-hub-<version>.vsix
```

**Install it** in VS Code: Extensions view → `…` → **Install from VSIX…**, or

```sh
code --install-extension rojo-hub-<version>.vsix --force
```

**VS Code profiles have separate extension lists.** The command above installs into the Default
profile only. Install into each profile you open Roblox projects in:

```sh
code --install-extension rojo-hub-<version>.vsix --force --profile "Roblox"
```

Then **reload the window** (`Ctrl+Shift+P` → *Developer: Reload Window*). A window that was open
during the install does not load the new version until it reloads.

**Update**: install the newer `.vsix` the same way and reload. The new extension notices that the
running service is an older version, asks it to exit, and starts its own. Rojo processes keep
running through this, so Studio stays connected, and the new service adopts them.

**Requirements**: Windows; git on `PATH`; `rojo` on `PATH` through [Rokit](https://github.com/rojo-rbx/rokit)
(each project's `rokit.toml` picks its Rojo version); Rojo 7.7. Orca is optional.

**Uninstall**: stop the service first (*Stop Background Service → Stop Service and Rojo*), then
uninstall the extension. Delete `%LOCALAPPDATA%\RojoHub\` to remove its state and views.

## 4. Where to find it in VS Code

- **The Rojo-Hub sidebar**: an icon in the activity bar (a hub: one dot joined to four). It opens
  by itself the first time Rojo-Hub runs in a VS Code profile. It lists groups as folders with
  their projects inside, then the projects in no group. Each project row shows its port and what
  it serves; warnings and errors appear as rows under it. Buttons at the top: Open Menu, Add
  Project, New Group, Refresh; the `…` menu has Stop Background Service. Hovering a row shows the
  full details. Right-clicking a project or group lists its actions; the ▶/■ buttons on a row start
  and stop it.
- **Rojo-Hub: Open Menu** (command palette): the one command that reaches everything, like Rojo's
  own *Rojo: Open Menu*. Lists projects, then groups, then Add Project, New Group, Port Settings,
  Reconnect to Service, Stop Background Service. Picking a project or group opens its own menu.
- **The status bar**: in a window whose folder belongs to a registered project, the bottom bar
  shows `Rojo :<port> · <what it serves>` with its state icon. Clicking it opens that project's
  menu.
- **Get Started walkthrough**: on VS Code's Welcome page, or the *Get Started* link in the empty
  sidebar. Five steps: add, start, connect Studio, switch, group.

**State icons**

| Icon | Meaning |
|---|---|
| ⊘ circle-slash | stopped |
| spinning | starting |
| ○ green outline | serving, no Studio plugin connected |
| ● green filled | serving, at least one Studio plugin connected |
| ✖ red | error (hover for the message, or Show Rojo Log) |
| ⧉ layers (green when all serving) | a group; the description says how many of its projects serve |

## 5. Projects

**Add Project** offers the folders open in the window, the repos Orca knows about, and *Browse…*.
Any folder inside a repo works; the primary checkout is what gets registered. Registration fails
when:

- the primary checkout has no `default.project.json`, or it has no `name`;
- the repo is already registered;
- another project already uses the same Rojo project `name`. Names must be unique because the
  Studio plugin reconnects a place only to a server reporting the name it saved.

A newly added project points at its primary checkout and is stopped until you start it.

**A project's menu**: Switch Branch…, Start or Stop Serving, Copy Address (`localhost:<port>`),
Show Rojo Log, Remove Project. Any warning shows at the top of the menu.

**Start Serving** runs `rojo serve` in the primary checkout's folder, so the Rojo version comes from
that project's `rokit.toml`. It waits until Rojo answers with the project's name, or reports the
end of the Rojo log if it does not come up within 30 seconds.

**Stop Serving** stops that project's Rojo only; other projects and any Rojo you started by hand
are left alone.

**Remove Project** stops its Rojo, deletes its generated files and views, and removes it from every
group. The project's own files are never touched.

## 6. Ports

A project's port is decided by these rules, in order, and is recomputed every few seconds:

1. **`servePort`** in the project's `default.project.json`, when set. This is Rojo's own field: it is
   committed with the repo, so everyone who clones it agrees, and plain `rojo serve` uses it too.
2. **Otherwise a port worked out from the repo's first commit**: a hash of the oldest root commit,
   placed in the port range (default `34873-35872`). Every clone of the repo has the same first
   commit, and renaming the repo, its folder or its project does not change it, so the port is the
   same on every machine and after every reinstall.
3. **Collisions**: a hashed port that is excluded, claimed by a `servePort`, or already taken by a
   project registered earlier moves forward to the next free port. The project that moved shows a
   warning; set `servePort` in its project file to fix its port for good. Rule 1 always wins over
   rule 2.
4. **34872 is never used.** It is Rojo's default port, used by a plain `rojo serve` (and by
   TheLaundryShift's `/JumpTo`).

**Excluding ports** for all projects: the `rojoHub.excludedPorts` setting (see [Settings](#12-settings)).

**When a port changes** (you add a `servePort`, or exclude the port a project is on), a serving
project is restarted on its new port. That is a new session: reconnect Studio to the new port. The
project shows *Port moved from A to B*.

**If another program already holds a project's port**, starting it fails with a message saying
so; add that port to `rojoHub.excludedPorts` and the project moves.

## 7. Connecting Studio

1. Open the place in Studio.
2. In the Rojo plugin, set the address to `localhost` and the project's port (*Copy Address*).
3. Connect.
4. In the plugin's settings, turn on **Auto Reconnect**.

The plugin remembers, per place, the address and project name it last connected to (for 150
days). With Auto Reconnect on, opening the place connects it again, but only if the server at that
address reports the same project name. This is why project names must be unique and must never
change across branch switches.

If the project file lists `servePlaceIds`, the plugin refuses (or asks about) places not on the
list. Rojo-Hub passes `servePlaceIds`, `blockedPlaceIds`, `placeId`, `gameId` and
`emitLegacyScripts` through from the primary checkout's project file.

**How Rojo-Hub knows Studio is connected**: Rojo's log records each plugin connection opening and
closing. Rojo-Hub counts them; that count drives the filled/outlined icon and the tooltip.

## 8. Switching branches

**Switch Branch…** lists:

- **Worktrees**: every git worktree of the repo (the primary first, then by most recent commit),
  under Orca's display names when Orca is installed. A worktree is served **in place**: edits made
  there, by you or by an agent, reach Studio live.
- **Branches**: every local branch not checked out in a worktree, and remote branches with no
  local counterpart. A branch is served from a **view** (below).

### What happens on a switch

Rojo-Hub never restarts Rojo to switch. Each project is served from a small generated project
file, `slot.project.json`, whose only content that matters is one pointer to the served tree's own
project file. Switching rewrites that pointer. The running Rojo notices, re-reads the project from
the new tree, and sends Studio the difference as one update over the same session. Studio stays
connected and does not ask for confirmation (the plugin only confirms the initial sync).

Because Rojo reads the served tree's **own** `default.project.json`, everything in it applies: its
own folder mappings, `globIgnorePaths` and `syncRules`, and edits to that file sync live.

The project's `name` and place-ID settings always come from the primary checkout and never change
on a switch, because Rojo reads them only when a session starts.

### Packages (Wally)

A worktree that has not run Wally has no `Packages`/`ServerPackages` folders. Rojo-Hub then serves
it in **borrowed** mode: a generated copy of the worktree's project file that takes those folders
from the primary checkout. The project shows a warning saying so. The warning is stronger when the
branch changed `wally.toml`, because the primary's packages then do not match the branch. In
borrowed mode `globIgnorePaths` and `syncRules` do not apply; run Wally in the worktree to serve it
natively. Views are always served in borrowed mode (they never run Wally).

### Views

Serving a branch with no worktree creates a view: `git worktree add --detach` of the branch's
current commit into `views\<project>\<commit>\`. A view is never modified after it is created: a
branch that gets new commits gets a new view the next time you switch to it. Views are deleted only
while the project's Rojo is stopped (when you stop it, restart it, or remove the project), because
of the Rojo crash in [Known limits](#14-known-limits-and-troubleshooting). Views do not appear in
the Worktrees list.

## 9. Groups

A group is a named set of projects; a project can be in several groups. Make one with **New
Group** (name, then tick projects). A group's menu (click it in Open Menu, or right-click it in the
sidebar):

| Action | Effect |
|---|---|
| **Start Group** | Starts every project in the group that is not already serving. |
| **Serve Only This Group** | Starts the group, and stops every serving project outside it. The profile switch. |
| **Stop Group** | Stops every project in the group. |
| **Edit Group** | Change its projects, or rename it. |
| **Delete Group** | Deletes the group only; its projects stay registered and keep their state. |

Projects that are already serving are left alone, so their Studio sessions continue. If some
projects fail to start, the others still start and one message lists the failures. A group
remembers which projects it holds, not their branches: each project serves whatever it was last
switched to. Removing a project removes it from every group. Group names are unique, ignoring case.

## 10. The background service

VS Code extensions stop when their window closes, and you keep several windows open, so Rojo-Hub
runs a separate background service that owns every project and its Rojo.

- **Started by the extension** when nothing answers on `127.0.0.1:34870`, using VS Code's own
  runtime (no separate Node install needed). It keeps running after windows close.
- **Rojo processes are independent of the service.** If the service stops or is replaced, Rojo keeps
  serving and Studio stays connected; the next service *adopts* each Rojo that still answers with
  its project's name.
- **Restores on start**: projects that were serving when the service last stopped are adopted, or
  started again.
- **Crash recovery**: if a project's Rojo dies unexpectedly, the service starts it again on the
  same port and shows *Rojo crashed at … and was restarted; reconnect Studio*, with Rojo's own
  reason. This is a new session.
- **Stop Background Service** asks whether to keep Rojo running (Studio stays connected) or stop
  everything.
- Only listens on `127.0.0.1`; nothing is reachable from other machines.

### Local API

JSON over HTTP on `127.0.0.1:34870`. The extension is its only client; listed here for scripts and
debugging.

| Method and path | Body | Does |
|---|---|---|
| `GET /health` | | Service version, pid, state folder |
| `GET /slots` | | Every project with its state |
| `POST /slots` | `{ path, projectFile? }` | Register the repo containing `path` |
| `DELETE /slots/:id` | | Remove a project |
| `POST /slots/:id/start`, `/stop` | | Start or stop serving |
| `GET /slots/:id/targets` | | Worktrees and branches it can serve |
| `POST /slots/:id/switch` | `{ target }` | `target` is `{kind:"worktree",path}` or `{kind:"branch",ref}` |
| `GET /groups` | | Every group |
| `POST /groups` | `{ name, slotIds }` | Create a group |
| `PUT /groups/:id` | `{ name?, slotIds? }` | Rename or change members |
| `DELETE /groups/:id` | | Delete a group |
| `POST /groups/:id/start` | `{ only? }` | Start; `only` also stops projects outside it |
| `POST /groups/:id/stop` | | Stop the group |
| `PUT /settings` | `{ portRange?, excludedPorts? }` | Port settings (sent by the extension) |
| `POST /shutdown` | `{ stopServing? }` | Stop the service, optionally its Rojo processes too |

## 11. Files on disk

Everything lives in `%LOCALAPPDATA%\RojoHub\`:

| Path | Contents |
|---|---|
| `registry.json` | Projects (repo, port, what they serve, whether they should be serving) and groups |
| `settings.json` | The port settings last sent by VS Code |
| `service.log` | Service start, stop and fatal errors |
| `slots\<id>\slot.project.json` | The generated file Rojo serves; its root points at the served tree's project file |
| `slots\<id>\borrowed.project.json` | The generated copy used in borrowed mode |
| `slots\<id>\rojo.log` | This Rojo's log (*Show Rojo Log*); `rojo.previous.log` is the run before |
| `views\<id>\<commit>\` | Views: detached worktrees for branches with no worktree |

Rojo-Hub writes nothing into your projects or worktrees. The only change to a repo is the
view worktrees it registers with git (visible in `git worktree list`) and removes again.

## 12. Settings

Both are **user settings that apply to every project and window**; a workspace cannot override them.

| Setting | Default | Meaning |
|---|---|---|
| `rojoHub.portRange` | `"34873-35872"` | Ports picked from, as `first-last` |
| `rojoHub.excludedPorts` | `[]` | Ports never given to any project: numbers (`35000`) or ranges (`"35000-35010"`). 34872 is always excluded. |

*Open Menu → Port Settings* opens them. Changes apply within a few seconds.

## 13. Commands

Only **Rojo-Hub: Open Menu** appears in the command palette. The others are reached through the
menu, the sidebar, and the status bar.

| Command | Where |
|---|---|
| Open Menu | Palette, sidebar title |
| Add Project, New Group, Refresh | Sidebar title, menu |
| Stop Background Service | Sidebar `…`, menu |
| Switch Branch, Start/Stop Serving, Copy Address, Show Rojo Log, Remove Project | Project menu, right-click a project, ▶/■ on its row, clicking its row |
| Start Group, Serve Only This Group, Stop Group, Edit Group, Delete Group | Group menu, right-click a group, ▶/■ on its row |

## 14. Known limits and troubleshooting

**Deleting a folder under a served project crashes Rojo 7.7** (a Rojo bug, not Rojo-Hub's: rojo-rbx/rojo#1305,
fix pending in PR #1319). It happens with plain `rojo serve` too. Anything that removes a folder
containing files under a served tree triggers it: deleting it in Explorer, a `git checkout` or
rebase that removes a folder, deleting a worktree the project served earlier in the same session.
Rojo-Hub restarts Rojo on the same port and tells you; reconnect Studio.

**Nothing shows up after installing**: reload the window, and check the extension is installed
in the VS Code profile you are using (profiles have separate extension lists).

**"Port … is held by another program"**: something outside Rojo-Hub uses that port. Stop it, or
exclude the port in `rojoHub.excludedPorts`.

**"… is already named …"**: two repos have the same Rojo project `name`. Rename one in its project
file.

**Studio disconnected**: the Rojo session changed. Causes: the project was stopped and started, its
port moved, or Rojo crashed and was restarted (the project says which). Switching branches never
causes it.

**A switch does not appear in Studio**: open *Show Rojo Log*. If the served tree's project file is
invalid, Rojo logs the error and keeps serving the previous tree; the project shows the error.

**Warnings about borrowed packages**: the served worktree has not run Wally. Run it there to serve
the branch's own packages.

**Windows only for now.** The live switch depends on a Windows path detail in Rojo (see the spec);
other platforms are untested.

## 15. For developers

Source layout, commands and the rules that must not be simplified away are in
[`CLAUDE.md`](../CLAUDE.md). In short: `src/service` is the background service, `src/extension`
the VS Code front end, `src/common/api.ts` the protocol between them; `npm test` runs unit tests and
end-to-end tests against a real Rojo; `tools/` holds the original measurement scripts.
