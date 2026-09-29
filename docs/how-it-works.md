# How Rojo-Hub works

The complete description of Rojo-Hub as built: every feature, command and setting, what happens
underneath, where files live, and the known limits. It is written to be the source for user
documentation. Version 0.19.4, 2026-09-28. For why each design choice was made, with the
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
10. [Agents](#10-agents)
11. [The background service](#11-the-background-service)
12. [Files on disk](#12-files-on-disk)
13. [Settings](#13-settings)
14. [Commands](#14-commands)
15. [Known limits and troubleshooting](#15-known-limits-and-troubleshooting)
16. [For developers](#16-for-developers)

---

## 1. What it does

Rojo-Hub is a VS Code extension for Roblox developers who use Rojo and work on several
projects, or several branches of one project, at the same time.

- **Every project gets its own Rojo port**, and several projects can serve at once.
- **Studio connects by itself.** Rojo-Hub installs its own Studio plugin, which syncs each place
  with its project (from `servePlaceIds`, or as assigned in the panel) and reconnects after any Rojo
  restart (see [Connecting Studio](#7-connecting-studio)).
- **Any project can be switched to another branch or worktree while it is serving**, and Studio
  stays connected: it receives the difference as one update instead of disconnecting.
- **Projects can be grouped** so a set of them starts, stops, or takes over as a profile, together.
- **AI agents can serve their own worktree to Studio** through Rojo-Hub's MCP server, taking turns
  when several work in one repo (see [Agents](#10-agents)).

It works with Orca worktrees, showing them under Orca's names, and with plain
git branches and worktrees.

## 2. Concepts

| Term | Meaning |
|---|---|
| **Project** (in code: *slot*) | One registered Rojo project: a git repo and one of the `*.project.json` files directly in it, normally `default.project.json` (see [Project files](#project-files)). Identified by that file's Rojo project `name`. |
| **Port** | The TCP port the project's Rojo listens on, `localhost:<port>`. Fixed per project (see [Ports](#6-ports)). |
| **Target** | What the project is currently serving: a **worktree** (served in place) or a **branch** with no worktree (served from a *view*). |
| **Primary checkout** | The repo's main folder, the one other worktrees belong to. Registration always stores this, whichever worktree you registered from. |
| **View** | A folder Rojo-Hub creates to serve a branch nobody has checked out: a detached git worktree of that branch's commit, under `%LOCALAPPDATA%\RojoHub\views\`. |
| **Group** | A named set of projects started and stopped together, like a profile. |
| **Service** | A small background program that owns the projects and their Rojo processes, separate from VS Code windows. |
| **Session** | One run of `rojo serve`. The Studio plugin stays connected only while the session stays the same; restarting Rojo starts a new one. |

## 3. Install, update, uninstall

Rojo-Hub is distributed as a `.vsix` file on the project's
[GitHub Releases](https://github.com/greenviper126/RojoHub/releases) page. A VS Code Marketplace
release is planned.

**Install it** in VS Code: Extensions view → `…` → **Install from VSIX…**, or

```sh
code --install-extension rojo-hub-<version>.vsix --force
```

**VS Code profiles have separate extension lists.** The command above installs into the Default
profile only. Install into each profile you open Roblox projects in:

```sh
code --install-extension rojo-hub-<version>.vsix --force --profile "<profile name>"
```

**Build it yourself** (from the RojoHub repo), if you prefer:

```sh
npm install
npm run package          # produces rojo-hub-<version>.vsix
```

In a remote window (WSL, SSH, Dev Containers) Rojo-Hub runs on the local Windows side, where Rokit,
Rojo and Studio are. It does not run in Restricted Mode: it runs git and Rojo in your projects'
folders, so the workspace has to be trusted.

Then **reload the window** (`Ctrl+Shift+P` → *Developer: Reload Window*). A window that was open
during the install does not load the new version until it reloads.

**Update**: install the newer `.vsix` the same way and reload **every** window that has Rojo-Hub
(each window runs its own copy of the extension). A window only ever replaces the service with a
newer one, never an older one; a window still on the old version keeps using the newer service and
says so once per new version: *Rojo-Hub ‹new› is running, but this window has ‹old›*, with *Reload
Window*. If that window's VS Code profile still has the old version installed, reloading does not
help: install the update in that profile too. The message is not repeated for the same version, so a
profile you keep on an older version is not nagged. The new extension notices that the
running service is an older version, asks it to exit, and starts its own. Rojo processes keep
running through this, so Studio stays connected, and the new service adopts them.

**Requirements**:

- Windows 10 or 11. On other systems the panel says *Rojo-Hub supports Windows only for now* and
  nothing is started.
- VS Code 1.101 or later.
- git 2.31 or later on `PATH`. A missing or older git is reported when adding a project (and in
  `service.log`), with where to get a newer one.
- Windows PowerShell (built into Windows).
- Rojo installed by [Rokit](https://github.com/rojo-rbx/rokit) specifically. Each project's
  toolchain file picks its Rojo version (see [Projects](#5-projects)); `aftman.toml` and
  `foreman.toml` pins are read too, but a Rojo installed by Aftman or Foreman themselves is not
  found. `rokit install` in the project installs what those files pin.
- Rojo 7.7 or later, for everything to work as described. Rojo-Hub installs its own Studio plugin
  (Rojo 7.7's, see [Connecting Studio](#7-connecting-studio)); Rojo's own plugin is not needed.
- Orca is optional.

**One Windows user at a time.** The service's port, 34870, is shared by everyone signed in to the PC.
If another signed-in Windows user's Rojo-Hub is running, the panel shows *Rojo-Hub could not start*
with *Port 34870 is used by another Windows user's Rojo-Hub (‹their folder›). Only one signed-in user
can run Rojo-Hub at a time.* Rojo-Hub never uses or stops the other user's service; it works again
once that user signs out.

**Uninstall**: uninstall the extension from every profile. The next time VS Code starts, Rojo-Hub's
uninstall step removes its Claude Code and Codex entries (if you ticked them), then stops the
background service and every Rojo it serves (only your own: a service of another Windows user is
left alone). Delete `%LOCALAPPDATA%\RojoHub\` to remove its state and views.

## 4. Where to find it in VS Code

### The Rojo-Hub panel

An icon in the activity bar (a hub: one dot joined to four) opens the Rojo-Hub panel in the
sidebar. It opens by itself the first time Rojo-Hub runs in a VS Code profile. The panel is built
for Rojo-Hub and drawn in VS Code's theme colours and icons. Everything can be done from it; no
menus pop up at the top of the window.

**Always current, and immediate.** After the panel first loads, it follows the background service
as a live stream: a change made anywhere (another window, an agent, a crash restart, Studio
connecting, a branch made in a terminal) shows within a fraction of a second, with no Refresh.
Every click shows its result at once: Start turns the card to *Starting…* (with Stop ready, to
cancel), Stop to *Stopping…*, a branch or project file you pick shows on the card straight away, and
group actions, Stop all, renames, deletes, member changes, new groups, reordering and adding a
project (an *Adding…* row) all draw before the service answers. If the service then says otherwise
(the action failed), the card shows what really happened and the error appears as a notification.
The branch picker, project file list and *Add a project* list are filled ahead of time, so they open
with their contents already there; the service keeps them up to date in the background. Menus,
pickers, rename boxes and confirmations stay open through updates unless what they are about is
gone. If the stream drops (the service restarting or being updated), the panel falls back to asking
every two seconds until it is back.

| The panel (sample data) | Switching branch inside a card |
|---|---|
| ![Rojo-Hub panel with projects, groups and settings](images/panel-overview.png) | ![Branch picker open inside a project card](images/panel-branch-picker.png) |

It has five sections that fold open and closed (Projects, Groups, Studio places, Port settings and
Agent access), and a footer. **Projects, Groups and Studio places start open; Port settings and Agent
access start folded.** Within Projects, **only the first item starts open**: the first workspace
(or, with no workspaces, the first project card); the rest start folded. Whatever you fold or open
is remembered. Opening a project from elsewhere (a group, the status bar) unfolds its
card and its workspace.

**Collapse All** (the icon at the top right of the panel's title bar, as in the Explorer) folds
everything except what is running: Projects and Groups stay open, and inside them the cards of
serving or starting projects, the workspaces that hold them, and running groups stay open. Every
other card and group folds, and Port settings folds. Agent access is left as it was.

**Right-clicking a header** that folds (a section, a workspace, a project card or a group) opens a
menu in place of Cut/Copy/Paste:

- **Expand** (on a folded header) opens just that header, like clicking its chevron;
- **Expand All** opens it and everything inside it: on Projects, every workspace and project card;
  on Groups, every group; on a workspace, its cards. It shows only on headers that hold other
  foldable headers;
- **Collapse** (on an open header) folds it;
- **Collapse Others** folds its neighbours and opens it. Neighbours are the headers in the same list:
  the sections, the workspaces, the cards in one workspace, or the groups.

Right-clicking anywhere else in the panel still shows Copy. Workspace headers have no menu while the
Projects filter is open, since every matching workspace is open then.

The section headers stay at the top while their section scrolls under them, and the footer stays at
the bottom of the panel.

In a narrow sidebar the panel drops things in steps so names stay readable and nothing runs past a
card's edge (the widths are the sidebar's, roughly; the panel measures its own content width):

- below about 320px: a group's *Running* pill and Agent access's status chips hide;
- below about 280px: counts lose their words ("2/5"), the footer reads "3/5", the hand-connect ports in
  Studio places lose their project names, the project file row shows just `default` or `test` without its *project file*
  label, the card's Stop and Start and Agent access's *Copy commands* and *Copy prompt* become icons,
  the window badges, a folded card's error or warning icon (the card stays tinted) and *not
  added*/*shown above* hide, and a group's rename and delete show only on hover;
- below about 270px: the card's status pill shrinks to its icon, and a workspace's *Group* button to
  its icon;
- below about 230px: ports leave project headers and group members (*Copy Port* in a project's menu
  still copies it),
  the footer's Refresh hides and Stop all becomes an icon.

VS Code lets a sidebar be dragged as narrow as you like, so below 170px the panel stops shrinking and
scrolls sideways.

**Your own order.** Project cards, workspace blocks and group cards each have a grip (⋮⋮) that
appears in their left margin when the pointer is on them; drag one onto another to move it before or after it. Cards move within their workspace,
workspaces among workspaces, groups among groups. The order is saved in the service, so every
window shows it, and **it never changes a port**: which project keeps a port when two collide goes by
the order projects were added, which reordering does not touch.

**Projects** (the header shows how many are serving; the filter icon filters the list and `+` adds
a project). Each project is a card:

- a grip to reorder it, a fold arrow, a **status light** and the project's **name** (a window icon
  marks the project this VS Code window is open on). Folded, a project serving a file other than
  `default.project.json` shows that file's name in a small tag after its own (`test` for
  `test.project.json`);
- the **port** (`:35045`) at the top right, which copies the number (`35045`) when clicked; it shows a
  copy icon on hover and a green tick for a moment after copying;
- **what it serves**: a folder icon for a worktree, a branch icon for a branch. Clicking it opens
  the branch picker inside the card: a search box, then, like Source Control's branch picker,
  *Worktrees* (under Orca's names), *Local branches* and *Remote branches* (a cloud icon; only those
  with no local branch of the same name), each with how many it holds. Branches show when they last
  had a commit. The current one is ticked. Clicking one switches; Enter picks the first match,
  Escape closes it. Studio stays connected. The picker opens with its list already drawn (see
  [Switching branches](#8-switching-branches)); its **Fetch** button (⟳, in the search box) and
  **New branch** row are described there too;
- **the project file** it serves (`default.project.json`, `test.project.json`, …), in a row of its
  own under that, since it decides what Studio gets. Clicking it opens a list inside the card, like
  the branch picker; see [Project files](#project-files). In a narrow sidebar it shows just
  `default` or `test`;
- the **agent claim**, while an agent holds one: *Agent in ‹worktree› until 14:05* (see
  [Agents](#10-agents));
- **warnings** (yellow) and **errors** (red), in full. An error from Rojo shows its first line, then
  up to the last five lines Rojo logged about it, with *Show full log*;
- a bottom row: a coloured **status pill** (*Connected* (Studio is connected; *Connected · 2* when
  more than one Studio is), *Serving* (waiting for Studio), *Starting…*, *Stopping…*, *Stopped*,
  *Error*, or *Unavailable* (the service is not running)), a **⋯** menu, and **Start** or **Stop** at
  the right (a project in error has both: Start to try again, Stop to stop it).
  The ⋯ menu has *Update sourcemap.json* with the sourcemap's status (for a project serving a
  worktree; see [Sourcemaps](#sourcemaps)), *Build place file…*, *Show Rojo log* and *Remove from
  Rojo-Hub…* (which asks first). It opens downward or upward, whichever has more room.

**Build place file…** runs the project's pinned `rojo build` on exactly what it serves, so a branch's
borrowed project file and packages match what Studio gets. A save dialog opens on
`<project>-<branch>.rbxl` in the folder you last built into, or your Documents folder the first time
(never inside the repo, where it would be an untracked file); characters Windows does not allow in
file names are replaced with `-`. A spinner shows on the card while it builds, and when it
is done a message gives the size and offers *Reveal in File Explorer*.

**Filter** (the filter icon in the Projects header) opens a box above the cards. Typing narrows
the list to projects whose name, branch or port match every word; workspaces with no match hide
and the rest open. Escape or ✕ clears it. The filter is not remembered.

A **folded** card is one row: grip, arrow, light, name, a warning or error icon if it has one, a
robot icon while an agent holds a claim, the port, and a start or stop button (both for a project
in error).

A thin rail on the card's left edge shows its state: green while serving, blue while starting, red on
an error (an erroring card is also tinted red). In a narrow sidebar the status pill shrinks to its
icon. With no projects, the section explains what Rojo-Hub does and offers *Add a project* and the *Getting started guide*.

**Grouped by workspace.** When projects belong to a VS Code workspace (a `.code-workspace`
file), the Projects list groups them under that workspace's name, with its serving count, a window icon
for the workspace this window has open, and a **Group** button that makes a group
of its projects. Folders the workspace lists that have a `*.project.json` but are not added
yet appear under it as *not added* with an **Add** button (and *Add all* when there are several).
Projects in no workspace are under **Other projects**. See [Workspaces](#workspaces).

**Add a project** (the `+`) opens a list inside the panel of the folders open in this window and the
repos Orca knows about, each with a `+`, and a *Browse…* button for any other folder. The new
project's card is highlighted once it is added.

**Groups** (the header shows how many; `+` makes one). *New group* opens a name box in the panel;
Enter or *Create* makes it. Each group is a card that folds open and closed, showing how many of its
projects are serving (green when all are). Inside:

- the groups inside it, then its projects, each project with its port (click to copy the port
  number) and ✕ to take it out, which asks *Take … out of …?* first (clicking a name
  jumps to its card);
- an **Add a project, group or workspace…** dropdown: workspaces (adding each of their projects),
  projects not in it yet, then groups, with groups that would make a loop greyed out;
- one **Start** / **Stop** button (Start while the group is not running, Stop while it is; Stop
  keeps projects another running group uses), then **Singleton** (serve only this group, stopping
  every other project; asks first, naming what it will stop);
- a green *Running* pill and a green rail on the left edge while the group is running (the pill
  hides when the sidebar is narrow);
- ✎ rename (edit the name in place; Enter saves, Escape cancels) and 🗑 delete (asks *Delete …?* on
  a row under the name; the projects stay). Both show when the pointer is on the card.

**Studio places** (below Groups; the header shows how many): every open Studio place with Rojo-Hub's
plugin, its name (and *unsaved*), what it syncs with or waits for, a status pill (*Synced*,
*Connecting*, *Waiting*, *Assign a project*, *Rojo too old*, *Reopen the place*), and a list to assign
it a project; *Automatic* follows its project files and its last sync (see
[Connecting Studio](#7-connecting-studio)). A place that does not connect by itself (*Assign a
project*) also gets an *or connect by hand:* line with every serving project's port to copy, for
Rojo's own plugin or typing it in. With no place open it says so, and how many projects are serving.
(0.19.3 removed the *Active ports* section this replaced: which projects serve shows on their cards
and the Projects header, and each card's port copies with a click.)

**Agent access** (below Port settings, folded by default; the header shows how many agents can use
Rojo-Hub): a switch per AI agent, with a chip saying where it stands (*Connected*, *Off*, *Not
installed*, *Set up by you*, *Can't read config*), and a folded *Other agents and manual setup* part
with the server's address and buttons to copy setup commands or a setup prompt. See
[Agents](#10-agents).

![Agent access with VS Code agents and Claude Code connected and Codex off](../site/public/images/panel-agent-access.png)

**Agent notice** (above Projects): *Let Claude Code … use Studio*, with *Set up* (opens and scrolls
to Agent access), *Later* and ✕. It shows only while at least one project is registered, Claude Code
or Codex is installed, and neither has a `rojohub` entry of any kind: it hides once one is
*Connected* or *Set up by you*, and while a config *Can't be read*. *Later* hides it for 14 days, ✕
for good; every window and profile agrees (it is kept in `agent-notice.json`).

**Port settings** (folded by default): the port range and excluded ports as text boxes, with
*Save* and *Undo*. Mistakes are pointed out before saving. The port range also has **Reset**, which
puts back the default range (34873–35872) after asking: it says how many projects get their port from
the range, since their ports may change and serving ones restart. Reset is greyed out when the range
is already the default; excluded ports have no reset. These edit the VS Code user settings described
in [Settings](#13-settings).

![Port settings with the default range](../site/public/images/panel-port-settings.png)

**Footer**: how many projects are serving, **Stop all**, and Refresh. *Stop all* stops every
serving, starting or erroring project and marks every group not running; it asks first, on the panel, naming what it will
stop. The background service itself never appears: Rojo-Hub starts it whenever it is needed.

While an action runs, VS Code's progress bar shows at the top of the panel and the button that
started it is disabled.

### Other ways in

- **Rojo-Hub: Open Menu** (command palette, and the list icon in the panel's title bar): the same
  actions as quick-pick menus for keyboard use, like Rojo's own *Rojo: Open Menu*. It lists the
  projects, then the groups, then *Add Project*, *New Group*, *Port Settings* (opens VS Code's
  Settings filtered to Rojo-Hub's settings), *Agent Access* (opens VS Code's Settings on
  `rojoHub.agents`) and *Stop All*.
- **The status bar**: in a window whose folder belongs to a registered project, the bottom bar
  shows `Rojo :<port> · <what it serves>` with its state icon. Clicking it opens the panel and
  highlights that project's card.
- **Get Started walkthrough**: on VS Code's Welcome page (Help → Welcome, then *Get Started with
  Rojo-Hub*), or *Getting started guide* in the empty panel. Five steps: add, start, connect
  Studio, switch, group.

**Status lights**

| Light | Meaning |
|---|---|
| grey ring | stopped |
| spinner | starting |
| green ring | serving, no Studio plugin connected |
| green dot | serving, at least one Studio plugin connected |
| red dot | error (the card shows the message; the log has the rest) |
| dashed grey ring | unavailable: Rojo-Hub's service could not be started |

## 5. Projects

**Add a project** (the `+` on Projects) lists the folders open in the window and the repos Orca
knows about, and offers *Browse…*.
Any folder inside a repo works; the primary checkout is what gets registered. Registration fails
when:

- the primary checkout has no `*.project.json` directly in it, or the chosen one has no `name`;
- the same repo is already registered **with the same project file** (*‹folder› is already
  registered*). One repo can be registered more than once with different `*.project.json` files, as
  long as their `name`s differ;
- another project already uses the same Rojo project `name`. Names must be unique because a
  place remembers the project it last synced with by name (Rojo-Hub's record and the plugin's);
- no port can be given to it: its `servePort` is 34870 or another project's `servePort`, or the port
  range has no free port left (see [Ports](#6-ports));
- git is missing or older than 2.31.

A newly added project points at its primary checkout and is stopped until you start it.

### Project files

A project serves one of the `*.project.json` files directly in its folder. Adding a folder picks it
this way:

- `default.project.json` when the folder has one, without asking;
- otherwise the folder's only `*.project.json` (a library with just a `test.project.json`, say);
- otherwise a list of the folder's project files to choose from.

The **project file row** on the card opens a list inside the card of the folder's `*.project.json`
files, with the current one ticked; clicking one switches to it, and Escape closes the list. The
service keeps each project's list and sends it with every status update (it reads the folder again
at most every two seconds), so the list opens at once and a file added or deleted shows up in it by
itself, even while it is open. At the
bottom, **Browse…** opens a file dialog that starts in the project's folder, for picking the file by
hand; only a `*.project.json` directly in that folder is taken. *Project File…* in the project's menu
lists the same files as a quick pick. The choice is saved with the
project, so it stays after restarts and updates. That is how a library is served with its tests:
pick `test.project.json` (or whatever builds a place with the library and its tests in it).

- The file is changed while the project is **stopped** (or has an error, e.g. a branch without the
  file). While it is **running or starting**, the row is greyed out with a lock and only shows which
  file is served; stop the project to change it. Rojo reads the project name, `servePort` and place
  IDs once per session, so a new file always means a new session.
- The project takes the new file's `name`, which must not be another project's (the same rule as
  adding). A file another project of the same repo already serves is refused (*Another project
  already serves ‹file› from ‹folder›*).
- The port stays the same unless the new file sets `servePort` (or the old one did), since ports
  come from the repo's first commit.
- Everything follows the file: what Rojo serves on every branch, `sourcemap.json` and *Build place
  file…*. A branch or worktree without that file shows an error on the card until you switch back or
  pick another file.

**A project's menu**: Switch Branch…, Start or Stop Serving (both for a project in error), Copy Port
(just the number), Project File… (shown locked, with the file's name, while the project is running
or starting), Show Rojo Log, Remove Project, and All Projects (back to Open Menu). *Show Rojo Log* on
a project that has never been started says *‹project› has no Rojo log yet; it appears once the
project has been started.* The first line of the project's error, or else its first warning, shows
at the top of the menu (only that one; the card shows them all).

**Start Serving** runs `rojo serve` in the primary checkout's folder, with the Rojo version the
project pins. It waits until Rojo answers with the project's name, or reports the end of the Rojo
log if it does not come up within 30 seconds.

**Which Rojo.** Rojo-Hub reads the project's toolchain file the way Rokit does, always from the
**primary checkout** (not from the worktree or branch being served): `rokit.toml`,
`aftman.toml` or `foreman.toml` in the project folder, then in each folder above it, then the global
`~/.rokit/rokit.toml`; the nearest one that pins Rojo wins, and `rokit.toml` before the others in
the same folder. It then runs that version straight from Rokit's tool storage
(`~/.rokit/tool-storage/rojo-rbx/rojo/<version>/rojo.exe`), with no console, so **no window opens**.
(Going through Rokit's `rojo` command instead made Windows open a Terminal window for a moment,
because that command starts the real Rojo as a console program of its own.)

- If the pinned version is not installed, starting fails with, for example: *Rojo 7.3.0 (pinned in
  …\MyLibrary\aftman.toml) is not installed. Run "rokit install" in …\MyLibrary, or pin a Rojo version
  you have.*
- If no toolchain file pins Rojo, starting says so and suggests `rokit add rojo-rbx/rojo`.
- A project pinned to a Rojo older than 7.7 starts, with a warning. **Rojo 7.7 is the first version
  that speaks protocol 5, and the Studio plugin only connects to a server with the same protocol**,
  so a 7.7 plugin refuses Rojo 7.0–7.6 (protocol 4) with *"it's using a different protocol version,
  and is incompatible"*. Rojo-Hub's plugin is Rojo 7.7's, so it does not connect to such a project
  by itself: its Studio places row says *Rojo too old*. Keep every project on Rojo 7.7.
  Live switching itself was measured working on 7.3.0; the Studio-connected light needs 7.7.
  Older Rojo answers Rojo-Hub's status check in JSON rather than MessagePack; both are read.

**Stop Serving** stops that project's Rojo only; other projects and any Rojo you started by hand
are left alone.

**Remove Project** stops its Rojo, deletes its generated files and views, and removes it from every
group. The project's own files are never touched. If removing it frees a port that another project
was pushed off (see [Ports](#6-ports)), that project moves back a few seconds later; the
confirmation names each project
that will move, from which port to which, and says when it is serving and Studio will have to
reconnect.

### Workspaces

A VS Code workspace file (`.code-workspace`) lists folders that open together, like
`MyGame.code-workspace` listing MyGame, MyGameServer and SharedLib. Rojo-Hub uses them
only to arrange the Projects list; nothing about a project changes.

- **Where it looks**: the workspace file this window has open, and the top folder of every added
  project. Comments and trailing commas in the file are fine; remote (`uri`) folders are ignored.
- **Which projects**: each folder the file lists is matched to an added project by its repo's
  primary checkout, so a worktree folder counts as its project.
- **Drawn once**: a project listed by two workspaces is drawn under the first (this window's
  workspace first, then by name); the other shows a short *shown above* row that jumps to it.
- **Adding and removing** stays per project: *Add* (or *Add all*) under a workspace adds its
  folders one by one as ordinary projects, and a project's trash button removes it as usual.
- **Group**: makes a group named after the workspace (or *Name 2*, … if taken) holding its added
  projects. It is an ordinary group from then on; later changes to the workspace file do not
  change it.
- The workspace files are re-read when projects are added or removed, when the window's workspace
  changes, and on Refresh.

## 6. Ports

A project's port is decided by these rules, in order, and is recomputed every few seconds (every
3 seconds, and whenever the project list is read):

1. **`servePort`** in the project's project file, when set. This is Rojo's own field: it is
   committed with the repo, so everyone who clones it agrees, and plain `rojo serve` uses it too.
   The project file wins over the settings: a `servePort` in `rojoHub.excludedPorts`, or 34872, is
   still used, and the card notes *servePort ‹p› is in rojoHub.excludedPorts; the project file
   wins.* Three exceptions:
   - A `servePort` that is not a port (not a whole number from 1 to 65535) is refused: *servePort
     ‹value› is not a port; use a whole number from 1 to 65535.*
   - `servePort` **34870**, Rojo-Hub's own service port, is refused: the card shows the error
     *servePort 34870 is Rojo-Hub's own service port. Pick another port in the project file.* and
     the project cannot start.
   - **Two projects with the same `servePort`**: the one registered first keeps it; the other shows
     the error *servePort ‹p› is also set by ‹name›; two projects cannot share a port. Change one of
     them.* and cannot start.

   Adding a project whose `servePort` is refused in either way fails with that message.
2. **Otherwise a port worked out from the repo's first commit**: a hash of the oldest root commit,
   placed in the port range (default `34873-35872`). Every clone of the repo has the same first
   commit, and renaming the repo, its folder or its project does not change it, so the port is the
   same on every machine and after every reinstall.
3. **Collisions**: a hashed port that is excluded, claimed by a `servePort`, or already taken by a
   project registered earlier moves forward to the next free port, wrapping around to the start of
   the range. The project that moved shows *Its own port ‹p› is taken by ‹name› (or: is excluded),
   so it moved to ‹q›. Set "servePort" in its project file to fix a port.* Rule 1 always wins over
   rule 2: a `servePort` that lands on a hashed project's port moves the hashed project. When the
   range has no free port left, the project shows *No free port left in ‹first›-‹last›.*
4. **Hashing never picks 34872 or 34870.** 34872 is Rojo's default port, used by a plain
   `rojo serve` (and by tools that expect Rojo there); 34870 is Rojo-Hub's own service. Both are
   excluded from rule 2 whatever the port range and `rojoHub.excludedPorts` say (a `servePort` of
   34872 is still honoured, as rule 1 says). A range may be a single port (`35000-35000`).

**A project file that does not parse for a moment** (an auto-save of half-typed JSON, or a file
locked while it is written) keeps the `servePort` last read from it, so the port does not move away
and back.

**Excluding ports** for all projects: the `rojoHub.excludedPorts` setting (see [Settings](#13-settings)).

**When a port changes** (you add, change or remove a `servePort`, exclude the port a project is on or
change the port range, or remove the project that had pushed it off its own port), a serving project
is restarted on its new port. That is a new session: places with Rojo-Hub's Studio plugin reconnect
to the new port by themselves. The project shows *Port moved from A to B. Places with Rojo-Hub's
Studio plugin reconnect by themselves; with Rojo's own plugin, reconnect Studio.* (a stopped project
just *Port moved from A to B.*), and VS Code shows a warning, *Rojo-Hub: ‹project› moved from port A
to B. …*, with **Copy Port** and **Show Project**; the window with the project open says it, or else
the focused window. Rojo's own plugin remembers the last port per place, so with it, set the new one
once.

**A move waits until the new port has held.** A move that comes from a project file (a `servePort`
added, changed or removed) or from removing a project happens only once the new assignment has stayed
the same for 2.5 seconds, so a `servePort` being typed with auto-save on (3, 34, 349…) or a line
deleted and put back does not restart Rojo at every step. With the 3-second recheck, that is a few
seconds in practice. A change of the port settings (`rojoHub.portRange`, `rojoHub.excludedPorts`),
which you save on purpose, moves at once. Changing a project's project file (while it is stopped)
takes the new port at once too.

**If another program already holds a project's port**, starting it fails with a message saying
so; add that port to `rojoHub.excludedPorts` and the project moves.

## 7. Connecting Studio

Rojo-Hub installs its own Studio plugin (spec 007): Rojo 7.7.0's plugin, changed to connect by
itself. With it, a place connects with no port typed and no click.

**Which project a place syncs with** is decided in VS Code, never in Studio. When a place opens, the
plugin tells the service its `PlaceId`, and the service answers, in this order:

1. the project assigned to the place in the panel's **Studio places** section (see below);
2. a project whose `servePlaceIds` lists the place;
3. a project whose `placeId` is the place's;
4. the project this place last synced with. The service records it (`placeSynced` in `registry.json`)
   whenever a place with the plugin syncs; the plugin's own per-place record, like Rojo's, is only the
   fallback, since every open Studio shares that one settings value and overwrites the others' entries.

A project that lists the place in `blockedPlaceIds` never matches. Only a **serving** project is
connected to. If the first step that finds a project finds only stopped ones, the plugin says which
project to start rather than falling back to a later step. One project may serve several places
(`servePlaceIds` is a list); each open place syncs with it on its own.

**Both directions.** The plugin keeps a WebSocket to the service (`ws://127.0.0.1:34870/studio`), so
it connects when the place opens, when its project is started later, and again, with no click, when
the project's Rojo restarts with a new session (a crash, a port move, a project file change). A
branch switch keeps the session, so nothing happens.

**Studio places** (a panel section) lists every open place with the plugin: its name, what it syncs
with or waits for, and a list to assign it a project. *Automatic* (the default) follows the order
above; picking a project assigns it, and the place syncs with it at once. An assignment is kept per
place ID (`placeChoices` in `registry.json`; removing the project forgets it). An unsaved place (`PlaceId`
0, or a Roblox template's ID such as a new Baseplate's) shares its ID with every other unsaved place,
so its assignment is kept only while that Studio window is open. Studio's Rojo window only shows the
service's answer in a line under its buttons; it has no choices of its own.

**When it does not connect by itself**, the Studio places row and the line in Studio say why:

- the place is not saved to Roblox: assign it a project in VS Code;
- no project lists the place and it has never synced: assign it one;
- two serving projects claim it: assign it one. A place keeps to the project it last synced with,
  though, so this only asks for a place that has not synced with either;
- its project runs a Rojo older than 7.7: the plugin speaks only protocol 5. Pin
  `rojo-rbx/rojo@7.7.0`;
- you pressed **Disconnect**, or **Abort** on the first sync: that session is not connected again by
  itself. Connecting by hand, assigning it a project in VS Code, or a new session, lifts it;
- *Rojo-Hub Auto Connect* is off in the plugin's settings.

Rojo's confirmation before a first sync is kept for places the project does not list: the plugin's
*Confirmation Behavior* defaults to *Unlisted PlaceId* (Rojo's own defaults to *Initial*), so a place
in `servePlaceIds` syncs with no click and any other place asks once per project per Studio session,
since syncing writes into the place. A place that last synced with one project waits for that
project while its Rojo restarts; it is never handed to another project that claims the place too. Nothing connects during a
playtest. With the Rojo-Hub service not running, the plugin behaves like Rojo's own, Auto Reconnect
included.

**Install.** The service copies `RojoHub.rbxm` (built from `plugin/` into `dist/`) into Studio's
local plugins folder, `%LOCALAPPDATA%\Roblox\Plugins`, when it starts and when it is updated, and
only when the file there differs. Studio loads a new or changed plugin only when a place is opened,
so an update reaches each open place when it is next opened. Other `RojoHub*.rbxm` or `.rbxmx` files
there (a copy downloaded from a GitHub release) are removed. Rojo's own plugin
(`RojoManagedPlugin.rbxm`, from `rojo plugin install`) is left alone; the panel suggests removing it,
because Studio then shows two Rojo windows. `rojoHub.studioPlugin` set to false stops all of this.
Uninstalling Rojo-Hub removes `RojoHub.rbxm` (unless that setting was off).

**Connecting by hand** still works as with Rojo's plugin: `localhost` and the project's port
(*Copy Port*), then Connect. Project names must be unique and must never change across branch
switches, because a place remembers its project by name.

If the project file lists `servePlaceIds`, Rojo itself refuses places not on the list. Rojo-Hub
passes `servePlaceIds`, `blockedPlaceIds`, `placeId`, `gameId` and `emitLegacyScripts` through from
the primary checkout's project file.

**How Rojo-Hub knows Studio is connected**: Rojo's log records each plugin connection opening and
closing. Rojo-Hub counts them; that count drives the filled/outlined icon and the tooltip. Places
running Rojo-Hub's plugin also report which place they are, so the *Connected* pill's tooltip names
them.

## 8. Switching branches

**Switch Branch…** lists:

- **Worktrees**: every git worktree of the repo (the primary first, then by most recent commit),
  under Orca's display names when Orca is installed. A worktree is served **in place**: edits made
  there, by you or by an agent, reach Studio live.
- **Branches**: every local branch not checked out in a worktree, and remote branches with no
  local counterpart. A branch is served from a **view** (below).

In the panel, local and remote branches are listed separately, as in Source Control.

**The list is kept up to date in the background.** The service keeps each registered repo's list in
memory and watches the repo's `.git` folder: a new or deleted branch, a fetch, a new worktree or a
checkout anywhere updates the list within about a second, whoever made it (a terminal, Source
Control, Orca). Orca's worktree names are read again when the list is more than a minute old. The
picker therefore opens with its list drawn, and if a newer list arrives while it is open, the list
updates in place and keeps what you typed.

**Fetch** (⟳ in the picker's search box) runs `git fetch --all --prune` for the repo, for branches
pushed since you last fetched. It never asks for a password: git's own prompt and Git Credential
Manager's sign-in window are both turned off for it; a failure (offline, no access) shows in the
picker. Rojo-Hub does not fetch by itself.

**New branch.** The last row of the picker is *New branch…*; when what you typed in the search box
is not an existing branch, it reads *New branch "‹what you typed›"*. It opens a small form: the
name and **From** (what the project serves now, then local, then remote branches). *Create* makes
the branch in a folder of its own so you can edit it, and switches the project to it; Studio stays
connected:

- when the repo is in **Orca**, as an Orca worktree (`orca worktree create`, setup skipped). Orca
  names the branch `<your git user>/<name>`;
- otherwise as a git worktree beside the repo, in `<repo>-worktrees/<name>`.

A name git does not allow, a branch that already exists, or a base that does not exist is pointed out
in the form before anything is made. When it is done, a message offers *Open in New Window*.

### Sourcemaps

While a project serves a worktree, Rojo-Hub keeps that worktree's `sourcemap.json` up to date with
the project's pinned `rojo sourcemap --watch`. luau-lsp reads it for Roblox types, and so do tools
such as `wally-package-types`. It works whether or not VS Code, a window on that folder, or the
luau-lsp extension is open, so an Orca agent editing a worktree with no window gets it too.

- **Same file as luau-lsp.** It runs the same command luau-lsp's extension does
  (`sourcemap <project file> --include-non-scripts`, from the worktree), so the two write identical
  files and can both run.
- **Recovers by itself.** Deleting a folder crashes Rojo 7.7's watcher (the same bug as below);
  Rojo-Hub restarts it a second later, and gives up with a note after five crashes in a minute.
  Nothing in Studio is affected.
- **Never adds a file to git.** It writes only where `sourcemap.json` is gitignored or already
  exists. Elsewhere the ⋯ menu says so, and *Update sourcemap.json* writes it once on request.
- **Not for branches** served from a Hub copy: nothing edits those.
- It stops with the project and moves with a switch. `rojoHub.sourcemaps` turns it off everywhere.

**Checking out in a served worktree.** Switching in the picker never touches your folders. If you
check out another branch *inside* a worktree that is being served (in a terminal, Source Control or
Orca), Studio gets that branch, and the card says so: *‹branch› was checked out in ‹folder› while it
was being served*. If the checkout removed a folder, Rojo 7.7 crashes (see
[Known limits](#15-known-limits-and-troubleshooting)); Rojo-Hub restarts it on the same port and the
card says the checkout caused it, and that Studio needs reconnecting.

### What happens on a switch

Rojo-Hub never restarts Rojo to switch. Each project is served from a small generated project
file, `slot.project.json`, whose only content that matters is one pointer to the served tree's own
project file. Switching rewrites that pointer. The running Rojo notices, re-reads the project from
the new tree, and sends Studio the difference as one update over the same session. Studio stays
connected and does not ask for confirmation (the plugin only confirms the initial sync). The card
shows the new branch's name at once, whoever switched (the panel, another window or an agent).

Because Rojo reads the served tree's **own** project file, everything in it applies: its
own folder mappings, `globIgnorePaths` and `syncRules`, and edits to that file sync live.

The project's `name` and place-ID settings always come from the primary checkout and never change
on a switch, because Rojo reads them only when a session starts.

### Packages (Wally)

A worktree that has not run Wally has no `Packages`/`ServerPackages` folders. Rojo-Hub then serves
it in **borrowed** mode: a generated copy of the worktree's project file (`borrowed.project.json`)
with every `$path` made absolute, taking the missing folders from the primary checkout.

**When borrowed mode is used**: whenever the served tree lacks a folder that its project file maps
(a relative `$path`) and the primary checkout has. Only those folders are borrowed; a folder missing
from both is left for Rojo to report. A tree that has every mapped folder is served natively. Wally's
folders are the usual case, so views, which never run Wally, usually use borrowed mode, but a
branch whose packages are committed, or that maps no package folder, is served natively.

The project shows a warning saying so: *Packages, ServerPackages come from the primary checkout (not
present in this tree).* The warning is stronger when the branch changed `wally.toml` and a missing
folder is a package folder (`Packages`, `ServerPackages`, `DevPackages`), because the primary's
packages then do not match the branch: *This branch changed wally.toml but has no ‹folders› of its
own; the primary's copies do not match it. Run Wally in the worktree before trusting what Studio
shows.* In borrowed mode `globIgnorePaths` and `syncRules` do not apply (the copy lives in Rojo-Hub's
folder, so rules relative to the project folder match nothing), and when the tree's project file
uses them the card says so too. Run Wally in the worktree to serve it natively. Edits to the tree's
own project file are carried into the copy while it is served.

### Views

Serving a branch with no worktree creates a view: `git worktree add --detach` of the branch's
current commit into `views\<project id>\<first 12 hex digits of the commit>\` (with `-2`, `-3`, …
added if that folder is already taken). A view of the same commit is reused. A view is never
modified after it is created: a branch that gets new commits gets a new view the next time you
switch to it. Views are deleted only
while the project's Rojo is stopped (when you stop, start or remove the project, or switch it while
it is stopped), because
of the Rojo crash in [Known limits](#15-known-limits-and-troubleshooting). Views do not appear in
the Worktrees list, also when `%LOCALAPPDATA%` is behind a junction or redirected. Making a view
does not run the repo's git hooks (`post-checkout`, husky), and cleaning up views only drops git's
record of Rojo-Hub's own views: your worktrees on a drive that is not plugged in are left alone.

## 9. Groups

A group is a named set of **projects and other groups**, like a profile. A project or group can be
in several groups. Groups live in the **Groups** section of the panel, below Projects.

### Making and filling groups

- **Make one** with the `+` on Groups (or *New Group* in Open Menu): type a name and press Enter
  or *Create*.
- **Add to it** with the group card's **Add a project, group or workspace…** dropdown. It lists:
  - **Workspaces**: picking one adds every project of that VS Code workspace that is not in the
    group yet (for example all three of MyGame's). They are added as ordinary projects, so
    each can be taken out again with its ✕. Folders the workspace lists that are not added to
    Rojo-Hub are not added to the group; the entry says when there are some. A workspace whose
    projects are all in the group already is greyed out.
  - **Projects** not in the group yet.
  - **Groups**, with those that would loop greyed out.

  Pick one to add it; do it again for the next.
- **Take something out** with the ✕ next to it in the group. It asks first, in place (*Take SharedLib
  out of My Game? Yes / No*). Nothing is deleted: a project stays registered, a group stays a
  group.
- **Groups inside groups** are listed first in the card, with a layers icon and how many of their
  projects are serving. Clicking one scrolls to its own card.

### Loops

A group can't contain itself, directly or through other groups. Adding group B to group A is
refused when B already contains A anywhere inside it. In the dropdown such groups are greyed out
and marked *(would loop: it contains A)*, and the service refuses them too with the chain that would
loop, for example *Outer → Middle → Inner*. If a loop gets into `registry.json` some other way,
Rojo-Hub still expands each group only once, so nothing hangs. Deleting a group removes it from
every group that held it.

### Running groups

A group holds every project inside it, through nested groups; its count (for example `2/3`) is
over all of them.

| Action | Effect |
|---|---|
| **Start** / **Stop** | One button: Start while the group is not running, Stop while it is. |
| **Start** | Serves every project the group holds, each on its own port. Projects already serving are left alone, so their Studio sessions continue. |
| **Singleton** | Serves the group and stops every other project (the profile switch). **Asks first**, naming exactly which projects it will stop; Open Menu asks with a dialog. |
| **Stop** | Stops the group's projects, **except any that another running group also holds**: that project is in use elsewhere, so its port keeps serving. Rojo-Hub says which projects it kept and why. |
| ✎ **Rename** | Edit the name in place; Enter saves, Escape cancels. |
| 🗑 **Delete** | Asks *Delete?* in place. Deletes the group only. |

A group is **running** from Start or Singleton until Stop, or until another group's Singleton. The
card then shows a green *running* badge and a green edge. Running is about what you started, not
about whether all its projects happen to be serving, so a group you never started never keeps a
project alive. Stopping a single project from its own card does not change which groups are
running.

If some projects fail to start or stop, the rest still go ahead, and one message lists the
failures. Groups remember what they hold, not branches: each project serves whatever it was last
switched to. Removing a project removes it from every group. Group names are unique, ignoring case.

## 10. Agents

AI agents (Claude Code in a terminal or an Orca worktree, Codex, Copilot and other agents in VS Code)
can use Rojo-Hub themselves: serve their own worktree to Studio before checking their changes there,
start, stop and add projects, run groups, make branches in worktrees of their own, read Rojo's log,
and wait for Studio to sync (see *The tools* below). They get this from an MCP
server that the background service runs at `http://127.0.0.1:34870/mcp`, so the agent needs no
extra files, scripts or instructions: the server tells the agent what it is for when it connects.

**Turning it on.** The panel's **Agent access** section (folded by default) has a switch per agent,
and the `rojoHub.agents` setting a checkbox per agent. Both change the same setting.

| Agent | Default | What turning it on does |
|---|---|---|
| VS Code agents | on | Registers the server with VS Code itself. Nothing is written to disk; it goes with the extension. |
| Claude Code | off | Runs `claude mcp add --scope user --transport http rojohub http://127.0.0.1:34870/mcp` |
| Codex | off | Runs `codex mcp add rojohub --url http://127.0.0.1:34870/mcp` |

Turning it off runs the matching `mcp remove`. The switches show what each agent's own config says,
so an entry removed by hand shows as off:

- Claude Code: the top-level `mcpServers` of `$CLAUDE_CONFIG_DIR/.claude.json` when
  `CLAUDE_CONFIG_DIR` is set **and that file exists**, else `~/.claude.json`;
- Codex: the `mcp_servers` of `config.toml` in `CODEX_HOME` when that is set, else
  `~/.codex/config.toml`.

Each agent's chip says where it stands:

| Chip | Meaning |
|---|---|
| *Connected* | The config has Rojo-Hub's `rojohub` entry. |
| *Off* | Installed, no `rojohub` entry. |
| *Not installed* | Its CLI (`claude`, `codex`) is not on `PATH`; the switch is greyed out. |
| *Set up by you* | The config has an entry named `rojohub` with another URL. Rojo-Hub never changes or removes it; the switch is greyed out. |
| *Can't read config* | The config file exists but cannot be read or parsed (the agent may be writing it at that moment). Rojo-Hub leaves it alone and looks again: it is never taken for "no entry", so nothing is added or removed and no switch is turned off because of it. The switch is greyed out. |

While a switch's change is being applied, its chip reads *Working…*; a failure shows under the row.

Rojo-Hub only changes an agent's config when you change its switch (or answer the first-run
question), never just because VS Code started. **When a window opens** and finds a switch that says
on for an installed agent whose config has no `rojohub` entry, it takes that as the entry removed by
hand and turns the switch off in the setting to match, instead of adding the entry back. Turning the
switch on again adds it. **`rojoHub.agents` is not synced by Settings Sync**: it describes this
machine's agent configs, so another machine's choice never adds or removes entries here. The first
time Rojo-Hub finds Claude Code or Codex installed with no `rojohub` entry and no choice made yet, it
asks once: *Let … use Rojo-Hub's tools?* Yes turns them on; No turns them off and hides the agent
notice above Projects for 14 days.

**Another agent?** Under *Other agents and manual setup*: *Copy commands* (also **Rojo-Hub: Copy Agent Setup Commands**) copies the two
commands and a JSON entry for agents that read a JSON MCP config. *Copy prompt* (**Rojo-Hub: Copy
Agent Setup Prompt**) copies a paragraph to paste into any agent's chat; the agent then adds Rojo-Hub
to its own config.

**The tools.** Agents can do everything the panel does except what is your own setup; Rojo-Hub is
mainly for several agents working at once, so an agent should not have to stop and ask you to click.

| Tool | Does |
|---|---|
| `status` | Every project: port, serving or not, the Studio places synced to it (name, place ID, why, plugin version), what it serves and with which project file, who claimed it, its warnings and `sourcemap.json` state; then the groups and every open Studio place. Given the agent's folder, also whether its worktree is the one served. |
| `serve_here` | Switches the project of the repo the agent is in to the agent's worktree, live, and claims it; says which Studio places show it and any error Rojo logged. `wait` takes it as soon as another worktree's claim ends. |
| `switch` | Switches a project to a branch (served from its worktree if it has one, else from a view) or a worktree, and claims it. Also takes `wait`. |
| `new_branch` | Makes a branch in a worktree of its own (through Orca when Orca manages the repo), switches the project to it and claims it; answers the folder to work in. |
| `branches` | What a project can switch to, newest first (`fetch` runs `git fetch` first). |
| `release` | Drops the agent's claim. The project keeps serving what it serves. |
| `start` | Starts a stopped project. |
| `stop` | Stops a project. Guarded (below). |
| `stop_all` | Stops every project. Needs `force`, always. |
| `add_project` | Registers the repo a folder is in (optionally with another `project_file`). |
| `remove_project` | Unregisters a project; never deletes files. Guarded. |
| `project_files` | The `*.project.json` files in a project's folder, and which it serves. |
| `set_project_file` | Serves another project file; only while the project is stopped. |
| `start_group` / `stop_group` | Starts or stops a group (`only` also stops everything outside it). Stopping is guarded. |
| `create_group` / `edit_group` / `delete_group` | Makes, renames, changes the members of, or deletes a group. |
| `log` | The last lines of a project's Rojo log. |
| `wait_for_studio` | Waits until a Studio place is synced to the project's session, and names it. |
| `build` | `rojo build` of what a project serves into a `.rbxl`/`.rbxlx` the agent names. |
| `sourcemap` | Writes the served worktree's `sourcemap.json` once. |

**Guarded.** `stop`, `stop_group`, `remove_project` and `start_group` with `only` are refused while
another worktree holds the project's claim, or while a Studio place is synced to it and the agent
holds no claim on it; the agent that holds the claim may stop its own project. The refusal says who
or what is affected. `force` goes ahead, and the server tells agents to pass it only when you ask.
Starting, adding and group edits never disturb anyone. `set_project_file` works only on a stopped
project, like the panel. Which project a Studio place syncs with, agent registration and settings
stay yours (spec 008).

**Rojo's errors come back.** After `serve_here`, `switch`, `new_branch` and `start`, the tool waits
about a second (Rojo applies a switch in that time) and adds any error Rojo logged, and the card's
warnings, to its answer.

**Waiting instead of polling.** With `wait` (seconds, up to 600), `serve_here`, `switch` and
`new_branch` wait while another worktree holds the claim and take the project the moment it is
released or runs out. Several agents waiting for one project are served in the order they asked.

**Which Studio to look at.** `status`, `serve_here` and `switch` name the Studio places synced to
the project, with their place IDs (from Rojo-Hub's Studio plugin), and `status` ends with every open
place and what it syncs with. With several Studio windows open for different projects, an agent
using a Roblox Studio tool picks the Studio with that place ID. The server's instructions also tell
agents that Rojo overwrites what it syncs (so they change files, not Studio), that a switch reaches
Studio within about a second, and that they cannot choose which project a place syncs with.

**Claims.** Several agents can work in worktrees of one repo while one Studio shows one of them.
So `serve_here` and `switch` claim the project for what they serve (a worktree, or a branch), for
10 minutes from that call. While another target holds the claim, those tools refuse and say who
holds it and until when (the agent can pass `force`, and is told to only when you say so).

- **Renewing.** A claim on a worktree is renewed, for another 10 minutes, by the `status`, `build`
  and `sourcemap` calls that pass a `path` inside that worktree, and by `serve_here` (or `switch`)
  for it again. `release` does not renew; it drops the claim. A claim that `switch` made for a
  **branch** is never renewed by other calls (no worktree matches it); only switching to that branch
  again sets it for another 10 minutes.
- **`release`** drops the claim. Given a `path` in another worktree than the one holding the claim,
  it refuses and leaves the claim alone; without a `path` it refuses unless the agent passes `force`
  (there is no telling whose claim it is).
- The project's card shows the claim (*Agent in new-ui until 14:05*, the worktree's folder name or
  the branch), and a folded card shows a robot icon.
- **Your own switches always go through** (the panel's picker, Open Menu's *Switch Branch…*, or
  anything else that calls `POST /slots/:id/switch`), and *New branch*, clear the claim. Starting,
  stopping and group actions leave a claim in place.
- Claims are kept in `claims.json` in the service's folder, so a service restarted by an update or a
  crash keeps them until they run out. Claims are per project: agents in different projects never
  block each other. Removing a project drops its
  claim.

**Uninstalling** Rojo-Hub removes its Claude Code and Codex entries (only ones pointing at
Rojo-Hub), the next time VS Code starts after the extension is gone from every profile, and then
stops the background service and its Rojo processes.

## 11. The background service

VS Code extensions stop when their window closes, and you keep several windows open, so Rojo-Hub
runs a separate background service that owns every project and its Rojo.

- **You never manage it.** The panel has no service controls. The extension starts the service
  whenever nothing answers on `127.0.0.1:34870`: when a window opens, when the panel refreshes, and
  before any action. It uses VS Code's own runtime (no separate Node install needed) and keeps
  running after windows close. What serves is decided only by starting and stopping projects and
  groups, and *Stop all*.
- **Rojo processes are independent of the service.** If the service stops or is replaced, Rojo keeps
  serving and Studio stays connected; the next service *adopts* each Rojo that still answers with
  its project's name.
- **Restores on start**: projects that were serving when the service last stopped are adopted, or
  started again.
- **Crash recovery**: if a project's Rojo dies unexpectedly, the service starts it again on the
  same port and shows *Rojo crashed at ‹time› and was restarted on the same port; places with
  Rojo-Hub's Studio plugin reconnect by themselves …*,
  followed by Rojo's own reason (or, right after a checkout in the served worktree, *Checking out
  ‹branch› in ‹folder› removed a folder Rojo was watching, and Rojo 7.7 crashed …*). This is a new
  session. A Rojo the service started itself is known to have exited at once;
  one it adopted is looked for after three status checks in a row go unanswered, so a Rojo that is
  only slow to answer (a big switch, a busy PC) is never restarted. If the restart fails too, the
  project shows the error and can be stopped from its card, *Stop all* or its group.
- **It keeps going.** An unexpected error inside the service (a folder deleted while it is being
  watched, say) is written to `service.log` and the service carries on.
- **It exits when idle**: after 15 minutes with nothing serving, no VS Code window open on it and
  no request, so it does not keep VS Code's program in use (it runs as `Code.exe`, which shows in
  Task Manager as Visual Studio Code). The next window starts it again.
- **Another Windows user's service** on the same PC is never used or stopped; the panel says so
  (see [Install](#3-install-update-uninstall)).
- **If it cannot be started** (a broken install, say), the panel shows *Rojo-Hub could not start*
  with the reason and *Try again*, and still lists projects and groups read from `registry.json`,
  marked unavailable. It is not retried on every refresh, only on *Try again* or the next action,
  so a broken install does not spawn a process every two seconds.
- Projects and groups are never lost when the service stops: they live in `registry.json`, which is
  written to disk before it replaces the old one. If it is ever damaged (a power cut, a hand edit),
  the service keeps it as `registry.corrupt-<time>.json`, starts from the save before it
  (`registry.json.bak`), and says so in `service.log`.
- Only programs on this PC can use it. It listens on `127.0.0.1` only, and answers (with 403
  otherwise) only requests that:
  - are addressed to it: the `Host` header is `127.0.0.1:34870`, `localhost:34870` or
    `[::1]:34870`, so a web page using DNS rebinding (its own name resolving to 127.0.0.1) cannot
    even read it;
  - come from no web page: a request with no `Origin` (the extension, the uninstall step, agents' MCP
    clients) or with a `vscode-…://` `Origin` (VS Code's own windows) is allowed; any browser
    `Origin` (`http://`, `https://`, or `null` from a file or sandboxed page) is refused, pages on
    `localhost` included.

### Local API

JSON over HTTP on `127.0.0.1:34870`. The extension is its only client; listed here for scripts and
debugging.

| Method and path | Body | Does |
|---|---|---|
| `GET /health` | | Service version, pid, state folder |
| `GET /events` | | A stream (`text/event-stream`) of `{ slots, groups, order, studioPlugin, studioPlaces }`: once at once, then on every change, within 150 ms |
| `GET /slots` | | Every project with its state |
| `POST /slots` | `{ path, projectFile? }` | Register the repo containing `path`; without `projectFile`, its `default.project.json` or only `*.project.json` |
| `PUT /slots/:id/project-file` | `{ projectFile }` | Serve another `*.project.json` of the folder; restarts a serving Rojo |
| `DELETE /slots/:id` | | Remove a project |
| `GET /slots/:id/port-moves-on-remove` | | The projects whose port would change if this one were removed: `[{ id, projectName, from, to, serving }]` (for the Remove confirmation) |
| `POST /slots/:id/start`, `/stop` | | Start or stop serving |
| `GET /slots/:id/targets` | | Worktrees and branches it can serve, from the service's cache |
| `POST /slots/:id/fetch` | | `git fetch --all --prune`, then the fresh list |
| `POST /slots/:id/branch` | `{ name, base }` | A new branch in a worktree of its own (Orca's, else beside the repo), and switch to it |
| `POST /slots/:id/build` | `{ output }` | `rojo build` of what the project serves into `output`, an absolute `.rbxl` or `.rbxlx` path |
| `POST /slots/:id/sourcemap` | | Write the served worktree's `sourcemap.json` once |
| `POST /slots/:id/switch` | `{ target }` | `target` is `{kind:"worktree",path}` or `{kind:"branch",ref}`. A user's switch: it also clears an agent's claim |
| `GET /groups` | | Every group |
| `POST /groups` | `{ name, slotIds?, groupIds? }` | Create a group |
| `PUT /groups/:id` | `{ name?, slotIds?, groupIds? }` | Rename or change members; `groupIds` that would loop are refused (409) with the chain |
| `DELETE /groups/:id` | | Delete a group |
| `POST /groups/:id/start` | `{ only? }` | Start; `only` also stops projects outside it and marks other groups stopped |
| `POST /stop-all` | | Stop every serving project and mark every group stopped |
| `GET /order` | | The panel's display order: `{ projects, groups }` |
| `PUT /order` | `{ projects?, groups? }` | Save a new display order (never changes a port) |
| `POST /groups/:id/stop` | | Stop the group; the result lists projects `kept` because another running group holds them |
| `PUT /settings` | `{ portRange?, excludedPorts?, sourcemaps?, studioPlugin? }` | Settings (sent by the extension). Replaces all four: a missing field goes back to its default (`""`, `[]`, `true`, `true`). A port settings change moves ports at once; turning `studioPlugin` on installs the Studio plugin |
| `POST /shutdown` | `{ stopServing? }` | Stop the service, optionally its Rojo processes too |
| `GET /studio` | WebSocket | The Studio plugin's link (spec 007): JSON messages `welcome` → `hello` (place) → `match` (which project, pushed again on every change); `state` (what the place is synced to). Protocol 2. Refused with a browser `Origin`, like every route |
| `PUT /studio/places/:key` | `{ slotId }` | Assign a project to an open Studio place (`key` from the snapshot's `studioPlaces`: a place ID, or `studio:<id>` for an unsaved place's window); `null` goes back to *Automatic*. Answers the new `studioPlaces` |
| `GET /agents` | | Claude Code's and Codex's registration: installed, `connected`/`absent`/`other`/`unknown` (config unreadable), last error |
| `PUT /agents` | `{ claudeCode?, codex? }` | `true` adds Rojo-Hub to that agent's user config, `false` takes it out (only for an installed agent, and never on `other` or `unknown`) |
| `POST /mcp` | JSON-RPC | The MCP server for agents (see [Agents](#10-agents)): one request object per POST, answered with plain JSON; a notification gets 202 with no body. Any other method on `/mcp` gets 405 |

Answers are JSON. Errors are `{ error }` with these statuses:

| Status | Meaning |
|---|---|
| 400 | A missing or wrong field in the body (`path is required`, `target must be …`) |
| 403 | Refused: not addressed to the loopback address and port, or sent from a web page |
| 404 | No such project, group or route (`No route for ‹method› ‹path›`), or a folder or file that does not exist |
| 409 | A conflict: a duplicate name or registration, a group loop, a port problem, a missing Rojo |
| 500 | Anything else, including a body that is not valid JSON, an invalid new branch name and Rojo not coming up |

## 12. Files on disk

Everything lives in `%LOCALAPPDATA%\RojoHub\`:

| Path | Contents |
|---|---|
| `registry.json` | Projects (repo, port, what they serve, whether they should be serving), groups (members, nested groups, whether running), the panel's display order, the project assigned to each Studio place in VS Code (`placeChoices`), and the project each place last synced with (`placeSynced`) |
| `registry.json.bak` | `registry.json` as it was before the last save, to start from if it is damaged |
| `registry.corrupt-<time>.json` | A damaged `registry.json`, kept aside when the service started from the `.bak` instead |
| `settings.json` | The settings last sent by VS Code: port range, excluded ports, `sourcemaps` and `studioPlugin` |
| `claims.json` | Agents' claims on projects (spec 004), so they survive a service restart until they run out |
| `agent-notice.json` | Until when the agent notice above Projects stays hidden (*Later*, ✕) |
| `service.log` | Service start and stop, recovered errors, a damaged registry, git problems, and each Studio place's hello and every change of what it is told to sync with |
| `slots\<id>\slot.project.json` | The generated file Rojo serves; its root points at the served tree's project file |
| `slots\<id>\borrowed.project.json` | The generated copy used in borrowed mode |
| `slots\<id>\rojo.log` | This Rojo's log (*Show Rojo Log*); `rojo.previous.log` is the run before |
| `views\<id>\<commit>\` | Views: detached worktrees for branches with no worktree, named after the first 12 hex digits of the commit |

`<id>` is the project's internal id (made from its name when it was added), not its name.

Outside that folder, Rojo-Hub writes:

- the agent entries you tick in *Agent access*, through Claude Code's and Codex's own CLIs: into
  Claude Code's user config (`$CLAUDE_CONFIG_DIR/.claude.json` if `CLAUDE_CONFIG_DIR` is set and that
  file exists, else `~/.claude.json`) and Codex's (`config.toml` in `CODEX_HOME`, else
  `~/.codex/config.toml`);
- the port settings in VS Code's user `settings.json`, when you press *Save* or *Reset* in Port
  settings, and `rojoHub.agents` when you change a switch;
- `sourcemap.json` in a served worktree, only where it is gitignored or already exists (see
  [Sourcemaps](#sourcemaps)), or once when you ask with *Update sourcemap.json*;
- a new worktree in `<repo>-worktrees/<name>` beside the repo when you make a *New branch* in a repo
  Orca does not know (see [Switching branches](#8-switching-branches));
- place files where you save them with *Build place file…*;
- its Studio plugin, `RojoHub.rbxm`, in Studio's local plugins folder (`%LOCALAPPDATA%RobloxPlugins`),
  taking out other `RojoHub*.rbxm(x)` files there, unless `rojoHub.studioPlugin` is off (see
  [Connecting Studio](#7-connecting-studio)).

It never edits your project files. Git also records the view worktrees it registers (visible in
`git worktree list`) and removes again.

## 13. Settings

All are **user settings that apply to every project and window**; a workspace cannot override them.

| Setting | Default | Meaning |
|---|---|---|
| `rojoHub.portRange` | `"34873-35872"` | Ports picked from, as `first-last` |
| `rojoHub.excludedPorts` | `[]` | Ports never given to a project by hashing: numbers (`35000`) or ranges (`"35000-35010"`). 34872 and 34870 are always excluded. A `servePort` still wins (see [Ports](#6-ports)). An invalid entry is ignored with a warning on every card. |
| `rojoHub.sourcemaps` | `true` | Keep `sourcemap.json` up to date in each serving project's worktree (see [Sourcemaps](#sourcemaps)). |
| `rojoHub.studioPlugin` | `true` | Keep Rojo-Hub's Studio plugin in Studio's plugins folder and remove other `RojoHub*.rbxm` copies (see [Connecting Studio](#7-connecting-studio)). Off: the folder is left alone. |
| `rojoHub.agents` | `{ vscode: true, claudeCode: false, codex: false }` | Which agents can use Rojo-Hub's MCP server (see [Agents](#10-agents)). Shown as checkboxes. Not synced by Settings Sync. |
| `rojoHub.notifyOnStudioDisconnect` | `false` | Show a message when Studio disconnects from a serving project, in the window that has the project open (or else the focused window). |

An invalid `rojoHub.portRange` is ignored with a warning on every card, and the default range is
used.

The panel's **Port settings** section edits the two port settings; *Open Menu → Port Settings* opens
VS Code's Settings on them instead. Changes apply within a few seconds, and a port they move, moves
at once (see [Ports](#6-ports)).

**`rojoHub.agents` is not synced** by VS Code's Settings Sync: it says which agent configs on *this*
machine have Rojo-Hub's entry, so a choice made on another machine never adds or removes entries
here.

**Where they are saved.** The port settings are VS Code user settings, written for you when you press *Save* or
*Reset*. They are marked as applying to every VS Code profile, so VS Code keeps them in the main
user `settings.json` (`%APPDATA%\Code\User\settings.json`) and every profile shares them. *Reset*
removes `rojoHub.portRange` from that file, so the default applies again. The service keeps a copy of
the last values in `%LOCALAPPDATA%\RojoHub\settings.json` so it can start projects with no window open.

## 14. Commands

Everything is in the panel (see [Where to find it](#4-where-to-find-it-in-vs-code)). The command
palette has **Rojo-Hub: Open Menu**, which offers the same actions as menus (including *Port
Settings* and *Agent Access*, which open VS Code's Settings on those settings), and **Rojo-Hub: Copy Agent Setup Commands** / **Copy Agent Setup Prompt** (see
[Agents](#10-agents)). The panel's title
bar has Open Menu, Refresh and Collapse All, and its `…` menu has Add Project, New Group and Stop All. Clicking the status bar item opens the panel on that window's project.

## 15. Known limits and troubleshooting

**Deleting a folder under a served project crashes Rojo 7.7** (a Rojo bug, not Rojo-Hub's: rojo-rbx/rojo#1305,
fix pending in PR #1319). It happens with plain `rojo serve` too. Anything that removes a folder
containing files under a served tree triggers it: deleting it in Explorer, a `git checkout` or
rebase that removes a folder, deleting a worktree the project served earlier in the same session.
Rojo-Hub restarts Rojo on the same port and tells you (naming the checkout when one caused it);
places with Rojo-Hub's plugin reconnect by themselves. Switching with the picker instead of checking out in the served folder avoids it.

**"Port 34870 is used by another Windows user's Rojo-Hub"**: someone else signed in to this PC runs
Rojo-Hub. Only one signed-in user can run it at a time; it works again once they sign out.

**"Rojo-Hub could not start"**: the background service did not come up. The message says why;
`%LOCALAPPDATA%\RojoHub\service.log` has more. Your projects and groups are still saved. Fix the
cause and press *Try again*.

**Nothing shows up after installing**: reload the window, and check the extension is installed
in the VS Code profile you are using (profiles have separate extension lists).

**"Port … is held by another program"**: something outside Rojo-Hub uses that port. Stop it, or
exclude the port in `rojoHub.excludedPorts`.

**"… is already named …"**: two repos have the same Rojo project `name`. Rename one in its project
file.

**"servePort 34870 is Rojo-Hub's own service port"** / **"servePort … is also set by …"**: the
project file's `servePort` cannot be used; pick another port in it (see [Ports](#6-ports)).

**An agent switch shows *Can't read config***: the agent's config file exists but could not be
parsed just now (usually while the agent writes it). Rojo-Hub leaves it alone and looks again; if it
stays, check the file.

**Studio disconnected**: the Rojo session changed. Causes: the project was stopped and started, its
port moved, or Rojo crashed and was restarted (the project says which). Switching branches never
causes it.

**A switch does not appear in Studio**: open *Show Rojo Log*. If the served tree's project file is
invalid, Rojo logs the error and keeps serving the previous tree; the project shows the error.

**Warnings about borrowed packages**: the served worktree has not run Wally. Run it there to serve
the branch's own packages.

**Windows only for now.** The live switch depends on a Windows path detail in Rojo (see the spec).
On other systems the panel says *Rojo-Hub supports Windows only for now* and does not start the
service.

## 16. For developers

Source layout, commands and the rules that must not be simplified away are in
[`CLAUDE.md`](../CLAUDE.md). In short: `src/service` is the background service, `src/extension`
the VS Code front end, `src/common/api.ts` the protocol between them (and with the Studio plugin);
`plugin/` the Studio plugin, Rojo 7.7.0's with Rojo-Hub's changes listed in `plugin/UPSTREAM.md`, built
into `dist/RojoHub.rbxm` by `npm run build` with Rokit's Rojo 7.7.0; `npm test` runs unit tests and
end-to-end tests against a real Rojo; `tools/` holds the original measurement scripts.
