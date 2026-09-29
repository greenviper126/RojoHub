# Switching branches

Any project can be switched to another worktree or branch **while it is serving**, and Studio stays
connected: it receives the difference as one update instead of disconnecting.

## The branch picker

Click what a project serves (the folder or branch row under its name) to open the picker inside the
card.

![Branch picker open inside a project card](/images/panel-branch-picker.png){.panel-shot}

Like Source Control's branch picker, it has a search box and three lists, each with how many it
holds:

| List | What is in it | Served |
|---|---|---|
| **Worktrees** | Every git worktree of the repo: the primary checkout first, then by most recent commit. Shown under Orca's names when Orca is installed. | **In place**: edits made there, by you or an agent, reach Studio live. |
| **Local branches** | Every local branch not checked out in a worktree. | From a [view](#views). |
| **Remote branches** (cloud icon) | Remote branches with no local branch of the same name. | From a [view](#views). |

Branches show when they last had a commit, and the current target is ticked.

- **Click** one to switch. Studio stays connected.
- **Enter** picks the first match; **Escape** closes the picker.
- In *Open Menu*, **Switch Branch…** offers the same list as a quick pick.

::: tip The list is always current
The service keeps each repo's list in memory and watches its `.git` folder. A new or deleted branch,
a fetch, a new worktree or a checkout anywhere (a terminal, Source Control, Orca) updates the list
within about a second. Orca's worktree names are read again when the list is more than a minute
old. If a newer list arrives while the picker is open, it updates in place and keeps what you typed.
:::

## Fetch

**Fetch** (⟳ in the picker's search box) runs `git fetch --all --prune` for the repo, to see
branches pushed since you last fetched.

- It never asks for a password: git's prompt and Git Credential Manager's sign-in window are both
  turned off for it.
- A failure (offline, no access) shows in the picker.
- Rojo-Hub never fetches by itself.

## New branch

The last row of the picker is **New branch…**. When what you typed in the search box is not an
existing branch, it reads **New branch "‹what you typed›"**. It opens a small form:

- **Name** of the new branch;
- **From**: what the project serves now, then local, then remote branches.

**Create** makes the branch in a folder of its own, so you can edit it, and switches the project to
it. Studio stays connected.

::: code-group

```text [Repo in Orca]
An Orca worktree (orca worktree create, setup skipped).
Orca names the branch <your git user>/<name>.
```

```text [Plain git]
A git worktree beside the repo:
<repo>-worktrees/<name>
```

:::

A name git does not allow, a branch that already exists, or a base that does not exist is pointed
out in the form before anything is made. When it is done, a message offers **Open in New Window**.

## What happens on a switch

Rojo-Hub **never restarts Rojo to switch**. Each project is served from a small generated project
file, `slot.project.json`, whose only content that matters is one pointer to the served tree's own
project file:

```text
slot.project.json ──$path──▶ <worktree>/default.project.json
                   (rewritten on a switch)
```

Switching rewrites that pointer. The running Rojo notices, re-reads the project from the new tree,
and sends Studio the difference as one update over the same session. Studio stays connected and does
not ask for confirmation (the plugin only confirms the first sync). The card shows the new branch's
name at once, whoever switched it (you, another window or an agent).

- Because Rojo reads the served tree's **own** project file, everything in it applies: its folder
  mappings, `globIgnorePaths` and `syncRules`. Edits to that file sync live too.
- The project's **`name` and place-ID settings** always come from the primary checkout and never
  change on a switch, because Rojo reads them only when a session starts.
- If the served tree's project file is invalid, Rojo logs the error and keeps serving the previous
  tree; the card shows the error.

## Packages (Wally)

A worktree that has not run Wally has no `Packages` / `ServerPackages` folders. Rojo-Hub then serves
it in **borrowed mode**: a generated copy of the worktree's project file that takes those folders
from the primary checkout. The card shows a warning:

- *Packages, ServerPackages come from the primary checkout (not present in this tree).*
- A stronger one when the branch changed `wally.toml`, because the primary's packages then do not
  match the branch: *This branch changed wally.toml but has no Packages of its own; the primary's
  copies do not match it. Run Wally in the worktree before trusting what Studio shows.*

::: warning In borrowed mode globIgnorePaths and syncRules do not apply
Run Wally in the worktree to serve it natively, with its own packages.
:::

Borrowed mode is used whenever the served tree lacks a folder its project file maps and the primary
checkout has; only those folders are borrowed. So views usually use it (they never run Wally), but a
branch whose packages are committed, or that maps no package folder, is served natively.

## Views

A branch with no worktree is served from a **view**: a detached git worktree of the branch's current
commit, which Rojo-Hub creates under `%LOCALAPPDATA%\RojoHub\views\<project id>\`, named after the
first 12 hex digits of the commit.

- A view is **never modified** after it is created. A branch that gets new commits gets a new view
  the next time you switch to it.
- Nothing edits a view, so it has no [sourcemap](./sourcemaps).
- Views are deleted only **while the project's Rojo is stopped** (when you stop, start or remove the
  project, or switch it while it is stopped), because of the Rojo crash below.
- Views never appear in the Worktrees list, even when `%LOCALAPPDATA%` is behind a junction or
  redirected.
- Making a view does not run the repo's git hooks (`post-checkout`, husky). Cleaning up views only
  drops git's record of Rojo-Hub's own views; your worktrees on a drive that is not plugged in are
  left alone.

Views show up in `git worktree list` while they exist.

## Checking out inside a served folder

Switching in the picker **never touches your folders**. If you check out another branch *inside* a
worktree that is being served (in a terminal, Source Control or Orca), Studio gets that branch, and
the card says so:

*‹branch› was checked out in ‹folder› while it was being served (it was on ‹old›), so Studio now gets
‹branch›. Picking a branch in Rojo-Hub's picker switches without touching the folder.*

::: danger A checkout that removes a folder crashes Rojo 7.7
Rojo 7.7 crashes when a folder it watches is deleted
([rojo-rbx/rojo#1305](https://github.com/rojo-rbx/rojo/issues/1305)). A `git checkout` or rebase
that removes a folder in a served tree triggers it. Rojo-Hub restarts Rojo on the same port and the
card says the checkout caused it. It is a new session: places with Rojo-Hub's Studio plugin reconnect
by themselves, with Rojo's own plugin **Studio has to reconnect**.
Switching with the picker never causes this.
:::
