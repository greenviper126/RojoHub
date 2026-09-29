# The panel

Everything in Rojo-Hub can be done from its panel. Open it with the Rojo-Hub icon in the activity
bar (a hub: one dot joined to four). It opens by itself the first time Rojo-Hub runs in a VS Code
profile, and it is drawn in your VS Code theme's colours and icons.

![The Rojo-Hub panel in the Dark Modern theme, with sample projects and groups](/images/panel-overview.png){.panel-shot}

## Sections

The panel has five sections that fold open and closed, and a footer.

| Section | What it holds | Starts |
|---|---|---|
| **Projects** | A card per project, grouped by [workspace](./workspaces). Header: how many are serving, a filter and `+` (add a project). | open |
| **Groups** | A card per [group](./groups). Header: how many, and `+` (new group). | open |
| **Studio places** | Every open Studio place with Rojo-Hub's plugin: what it syncs with, and a list to assign it a project (see [Connecting Studio](./connecting-studio#studio-places)). | open |
| **Active ports** | Every project serving right now, lowest port first, with its light, name, branch and `localhost:<port>`. Click the address to copy the port. Says *Nothing serving* when nothing is. | open |
| **Port settings** | The port range and excluded ports, with *Save*, *Undo* and *Reset* (see [Ports](./ports#port-settings-in-the-panel)). | folded |
| **Agent access** | A switch per AI agent (see [Agents](./agents)). | folded |

The **footer** shows how many projects are serving, **Stop all** and Refresh. *Stop all* stops every
serving, starting or erroring project and marks every group not running; it asks first, in the
panel, naming what it will stop.

Section headers stay at the top while their section scrolls under them, and the footer stays at the
bottom.

::: info No service controls
The [background service](./service) never appears in the panel. Rojo-Hub starts it whenever it is
needed; what serves is decided only by starting and stopping projects and groups.
:::

## Project cards

![A project card with its branch picker open](/images/panel-branch-picker.png){.panel-shot}

From top to bottom, an open card shows:

- **Header**: a grip (⋮⋮, for [reordering](#your-own-order)), a fold arrow, the
  [status light](#status-lights) and the project's **name**. A window icon marks the project this
  VS Code window is open on.
- **Port** (`:35045`) at the top right. Click it to copy the number (`35045`); it shows a copy icon
  on hover and a green tick for a moment after copying.
- **What it serves**: a folder icon for a worktree, a branch icon for a branch. Click it to open the
  [branch picker](./switching).
- **Project file** it serves (`default.project.json`, `test.project.json`, …), on its own row. Click
  it to pick another; see [Project files](./projects#project-files). Greyed out with a lock while the
  project is running.
- **Agent claim**, while an agent holds the project: *Agent in ‹worktree› until 14:05* (see
  [Claims](./agents#claims)).
- **Warnings** (yellow) and **errors** (red), in full. An error from Rojo shows its first line, then
  up to the last five lines Rojo logged about it, with *Show full log*.
- **Bottom row**: a status pill, a **⋯** menu, and **Start** or **Stop**. A project in error has
  both: Start to try again, Stop to stop it.

### Status pill

| Pill | Meaning |
|---|---|
| *Connected* | Serving, and Studio is connected (*Connected · 2* with two Studio plugins) |
| *Serving* | Serving, waiting for Studio |
| *Starting…* | Rojo is starting |
| *Stopping…* | Rojo is stopping |
| *Stopped* | Not serving |
| *Error* | Something went wrong; the card says what |
| *Unavailable* | Rojo-Hub's service is not running |

A thin rail on the card's left edge shows the state too: green while serving, blue while starting,
red on an error (an erroring card is also tinted red).

### The ⋯ menu

- **Update sourcemap.json**, with the sourcemap's status (for a project serving a worktree; see
  [Sourcemaps](./sourcemaps)).
- **Build place file…**: see [Build a place file](./projects#build-a-place-file).
- **Show Rojo log**.
- **Remove from Rojo-Hub…** (asks first; see [Remove a project](./projects#remove-a-project)).

It opens downward or upward, whichever has more room.

### Folded cards

A folded card is one row: grip, arrow, light, name, a warning or error icon if it has one, the port,
and a Start or Stop button (both for a project in error). A robot icon shows while an agent holds a
claim. A project serving a file other than `default.project.json` shows that file's name in a small
tag after its own (`test` for `test.project.json`).

## Status lights

| Light | Meaning |
|---|---|
| grey ring | stopped |
| spinner | starting |
| green ring | serving, no Studio plugin connected |
| green dot | serving, at least one Studio plugin connected |
| red dot | error (the card shows the message; the log has the rest) |
| dashed grey ring | unavailable: Rojo-Hub's service could not be started |

## Adding and filtering

- **Add a project** (`+` on Projects) opens a list inside the panel of the folders open in this
  window and the repos Orca knows about, each with a `+`, and *Browse…* for any other folder. An
  *Adding…* row shows at once, and the new card is highlighted once it is added.
- **Filter** (the filter icon on Projects) opens a box above the cards. Typing narrows the list to
  projects whose name, branch or port match every word; workspaces with no match hide and the rest
  open. Escape or ✕ clears it. The filter is not remembered.
- With **no projects**, the section explains what Rojo-Hub does and offers *Add a project* and the
  *Getting started guide*.

## Folding

- **Projects, Groups, Studio places and Active ports start open; Port settings and Agent access start folded.**
- Within Projects, **only the first item starts open**: the first workspace, or with no workspaces,
  the first project card.
- Whatever you fold or open is **remembered**.
- Opening a project from elsewhere (a group, Active ports, the status bar) unfolds its card and its
  workspace.

**Collapse All** (the icon at the top right of the panel's title bar, as in the Explorer) folds
everything except what is running. Projects and Groups stay open, and inside them the cards of
serving or starting projects, the workspaces that hold them, and running groups stay open. Every
other card and group folds, as do Active ports and Port settings. Agent access is left as it was.

### Right-click menu

Right-clicking a header that folds (a section, a workspace, a project card or a group) opens a menu:

| Item | Does |
|---|---|
| **Expand** | Opens just that header (on a folded header). |
| **Expand All** | Opens it and everything inside it: every workspace and card on Projects, every group on Groups, the cards of a workspace. Only on headers that hold other foldable headers. |
| **Collapse** | Folds it (on an open header). |
| **Collapse Others** | Folds its neighbours (the other sections, workspaces, cards in the same workspace, or groups) and opens it. |

Right-clicking anywhere else still shows Copy. Workspace headers have no menu while the Projects
filter is open, since every matching workspace is open then.

## Your own order

Project cards, workspace blocks and group cards each have a **grip** (⋮⋮) that appears in their left
margin when the pointer is on them. Drag one onto another to move it before or after it: cards
within their workspace, workspaces among workspaces, groups among groups.

The order is saved in the service, so every window shows it.

::: tip Reordering never changes a port
When two projects' ports collide, which one keeps its port goes by the order the projects were
*added*. Dragging cards does not touch that.
:::

## Always current, and immediate

After the panel first loads, it follows the background service as a **live stream**. A change made
anywhere (another window, an agent, a crash restart, Studio connecting, a branch made in a terminal)
shows within a fraction of a second, with no Refresh.

Every click shows its result at once:

- **Start** turns the card to *Starting…* (with Stop ready, to cancel); **Stop** to *Stopping…*.
- A branch or project file you pick shows on the card straight away.
- Group actions, *Stop all*, renames, deletes, member changes, new groups, reordering and adding a
  project all draw before the service answers.

If the service then says otherwise (the action failed), the card shows what really happened and the
error appears as a notification. While an action runs, VS Code's progress bar shows at the top of
the panel and the button that started it is disabled.

The branch picker, project file list and *Add a project* list are **filled ahead of time**, so they
open with their contents already there. Menus, pickers, rename boxes and confirmations stay open
through updates unless what they are about is gone.

If the stream drops (the service restarting or being updated), the panel asks the service every two
seconds until it is back.

## Narrow sidebars

In a narrow sidebar the panel drops things in steps so names stay readable and nothing runs past a
card's edge.

| Sidebar width | What changes |
|---|---|
| below about 320px | A group's *Running* pill and Agent access's status chips hide. |
| below about 280px | Counts lose their words (`2/5`) and the footer reads `3/5`. Ports lose `localhost`. Stop, Start and Agent access's *Copy commands* and *Copy prompt* become icons. Window badges, a folded card's error or warning icon (the card stays tinted), *not added* and *shown above* hide. A group's rename and delete show only on hover. The project file row shows just `default` or `test`. |
| below about 270px | The status pill shrinks to its icon, and a workspace's *Group* button to its icon. |
| below about 230px | Ports leave project headers and group members (Active ports still lists them). The footer's Refresh hides and Stop all becomes an icon. |
| below 170px | The panel stops shrinking and scrolls sideways. |

## Other ways in

- **Rojo-Hub: Open Menu** (command palette, and the list icon in the panel's title bar): the same
  actions as quick-pick menus, for keyboard use. See [Commands](/reference/commands).
- **The status bar**: in a window whose folder belongs to a registered project, the bottom bar shows
  `Rojo :<port> · <what it serves>` with its state icon. Click it to open the panel on that
  project's card.
- **Get Started walkthrough**: on VS Code's Welcome page (*Help → Welcome*, then *Get Started with
  Rojo-Hub*), or *Getting started guide* in the empty panel. Five steps: add, start, connect Studio,
  switch, group.

## The agent notice

Above Projects, Rojo-Hub may show *Let Claude Code … use Studio*, with **Set up** (opens Agent
access), **Later** and **✕**. It shows only while at least one project is registered, Claude Code
or Codex is installed, and neither has a `rojohub` entry of any kind (it hides once one is
*Connected* or *Set up by you*, and while a config *Can't be read*). *Later* hides it for 14 days, ✕
for good; every window and profile agrees.
