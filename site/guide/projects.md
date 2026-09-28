# Projects & project files

A **project** is one registered Rojo project: a git repo plus one of the `*.project.json` files
directly in its top folder, normally `default.project.json`. It is identified by that file's Rojo
project `name`, and it gets its own fixed [port](./ports).

## Add a project

Press **+** on the *Projects* header and pick a folder open in this window, a repo Orca knows about,
or *Browse…*. Workspaces offer an **Add** button for their folders too (see
[Workspaces](./workspaces)).

- **Any folder inside a repo works.** Rojo-Hub registers the repo's **primary checkout** (the main
  folder that other worktrees belong to), whichever worktree you picked.
- A new project serves its primary checkout and is **stopped** until you start it.

Adding fails when:

| Problem | Message (shortened) |
|---|---|
| The folder has no `*.project.json` directly in it | *‹folder› has no default.project.json or other \*.project.json* |
| The project file has no `name` | *‹file› has no "name"* |
| That repo and project file are already added | *‹folder› is already registered* |
| Another project already uses the same `name` | *Another project (‹folder›) is already named "‹name›". Studio auto-connects by name, so names must be unique.* |
| Its `servePort` is 34870 or another project's `servePort` | see [Ports](./ports#how-a-port-is-picked) |
| The port range has no free port left | *No free port left in ‹first›-‹last›.* |
| git is missing or older than 2.31 | see [Troubleshooting](/troubleshooting#git-was-not-found) |

One repo can be added more than once, with different `*.project.json` files, as long as their
`name`s differ.

::: warning Why names must be unique
The Studio plugin reconnects a place only to a server reporting the project name it saved. Rename
one of the projects in its project file.
:::

## Project files

A project serves **one** of the `*.project.json` files directly in its folder. When you add a
folder, Rojo-Hub picks:

1. `default.project.json` when the folder has one, without asking;
2. otherwise the folder's only `*.project.json` (a library with just a `test.project.json`, say);
3. otherwise it shows the folder's project files to choose from.

### Change the project file

Click the **project file row** on the card (under what it serves). A list opens inside the card with
the folder's `*.project.json` files and the current one ticked:

- Click one to switch to it; Escape closes the list.
- **Browse…** at the bottom opens a file dialog in the project's folder. Only a `*.project.json`
  directly in that folder is taken.
- *Project File…* in the project's menu (Open Menu) lists the same files as a quick pick.

The list stays up to date by itself: a file added or deleted in the folder shows up in it, even
while it is open. The choice is saved with the project, so it stays after restarts and updates.

::: tip Serving a library with its tests
Pick `test.project.json` (or whatever builds a place with the library and its tests in it). The
folded card then shows a small `test` tag after the name.
:::

**What to know:**

- **Stop the project first.** While it is running or starting, the row is greyed out with a lock and
  only shows which file is served. Rojo reads the project name, `servePort` and place IDs once per
  session, so a new file always means a new session.
- The project takes the new file's **`name`**, which must not be another project's.
- The **port stays the same** unless the new file sets `servePort` (or the old one did), since ports
  come from the repo's first commit.
- **Everything follows the file**: what Rojo serves on every branch, `sourcemap.json` and *Build
  place file…*. A branch or worktree without that file shows an error on the card until you switch
  back or pick another file.

## Start and stop

**Start** runs `rojo serve` for the project, with the Rojo version the project pins (see
[Which Rojo](./requirements#how-rojo-hub-picks-the-version)). It waits until Rojo answers with the
project's name; if Rojo does not come up within 30 seconds, the card shows the end of Rojo's log.

- No window opens: Rojo runs straight from Rokit's tool storage, without a console.
- The toolchain file is read from the **primary checkout** (and the folders above it), not from the
  worktree being served.
- A project pinned to a Rojo **older than 7.7** starts, with a warning: the 7.7 Studio plugin will
  refuse it (see [Which Rojo version](./requirements#which-rojo-version)).

**Stop** stops that project's Rojo only. Other projects, and any Rojo you started by hand, are left
alone.

Start and stop many at once with [groups](./groups) or the footer's **Stop all**.

## Build a place file

**Build place file…** in the card's ⋯ menu runs the project's pinned `rojo build` on **exactly what
it serves**, so a branch's borrowed project file and packages match what Studio gets.

1. A save dialog opens on `<project>-<branch>.rbxl`, in the folder you last built into (your
   Documents folder the first time; never inside the repo, where it would be an untracked file).
   Characters Windows does not allow in file names are replaced with `-`.
2. A spinner shows on the card while it builds.
3. When it is done, a message gives the size and offers **Reveal in File Explorer**.

## Show the Rojo log

*Show Rojo log* (⋯ menu) opens the project's `rojo.log`. The previous run is kept as
`rojo.previous.log` (see [Files on disk](/reference/files)). A project that has never been started
says *‹project› has no Rojo log yet; it appears once the project has been started.*

## Remove a project

**Remove from Rojo-Hub…** (⋯ menu) asks first, then:

- stops its Rojo;
- deletes its generated files and [views](./switching#views);
- removes it from every group.

The project's own files are never touched.

If removing it frees a port that another project had been pushed off (see
[Collisions](./ports#how-a-port-is-picked)), that project moves back. The confirmation names each
project that will move, from which port to which, and says when it is serving and Studio will have
to reconnect.

## The project menu

*Open Menu* (command palette) lists your projects; picking one shows its menu:

| Item | Does |
|---|---|
| **Switch Branch…** | Opens the branch list (shows what it serves now). |
| **Start Serving** / **Stop Serving** | Start or stop it; a project in error offers both. |
| **Copy Port** | Copies just the number. |
| **Project File…** | Pick another `*.project.json` (locked while running or starting). |
| **Show Rojo Log** | Opens the log. |
| **Remove Project** | Removes it, after asking. |

The project's first warning or error shows at the top of the menu.
