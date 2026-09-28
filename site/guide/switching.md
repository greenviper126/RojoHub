# Switching branches

Click what a project serves (the branch or folder under its name) to open the branch picker.

![Branch picker open inside a project card](../../docs/images/panel-branch-picker.png)

It lists, like Source Control's picker:

- **Worktrees**: every git worktree of the repo, under Orca's names when Orca is installed. A
  worktree is served **in place**, so edits there reach Studio live.
- **Local branches** and **Remote branches** not checked out anywhere. A branch is served from a
  *view*, a read-only copy Rojo-Hub makes of that commit.

Click one to switch. **Studio stays connected** and gets the difference as one update.

::: tip Fetch and new branches
⟳ in the search box runs `git fetch --all --prune`. The last row, *New branch…*, makes a branch in
a worktree of its own and switches to it.
:::

## What happens on a switch

Rojo-Hub never restarts Rojo to switch. Each project is served from a small generated project file
whose only job is to point at the served tree's own project file. Switching rewrites that pointer;
the running Rojo re-reads the project and sends Studio the difference over the same session.

```text
slot.project.json ──$path──▶ <worktree>/default.project.json
                    (rewritten on a switch)
```

Because Rojo reads the tree's **own** project file, its folder mappings, `globIgnorePaths` and
`syncRules` all apply.

## Packages (Wally)

A worktree that has not run Wally has no `Packages` folder. Rojo-Hub then serves it in **borrowed**
mode, taking packages from the main checkout, and the card warns you. Run Wally in the worktree to
serve its own packages.

## Checking out inside a served folder

::: danger Rojo 7.7 crashes when a watched folder is deleted
A `git checkout` or rebase that removes a folder in a served tree crashes Rojo
([rojo-rbx/rojo#1305](https://github.com/rojo-rbx/rojo/issues/1305)). Rojo-Hub restarts it on the
same port and tells you, but Studio has to reconnect. Switching with the picker never causes this.
:::
