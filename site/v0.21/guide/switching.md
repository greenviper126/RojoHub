# Switching branches

Click what a project serves on its card to open the picker. Pick a worktree or branch; Studio stays
connected and gets the difference as one update.

| List | Served |
|---|---|
| **Worktrees** (under Orca's names) | In place: edits reach Studio live. |
| **Local** / **Remote branches** | From a read-only copy of the branch's commit (a *view*). |

- **Fetch** (⟳ in the search box) runs `git fetch --all --prune`. It never prompts for a password.
- **New branch…** (last row) makes a branch in its own worktree (Orca's, or `<repo>-worktrees/<name>`)
  and switches to it.
- The list updates by itself when branches or worktrees change anywhere.

## How it works

Rojo serves a small generated `slot.project.json` that points at the chosen tree's project file.
A switch rewrites that pointer; the running Rojo re-reads and sends Studio the difference. Rojo never
restarts, so the session and Studio's connection stay.

The project's `name` and place IDs always come from the main checkout.

## Packages (Wally)

A worktree that has not run Wally is served with `Packages` borrowed from the main checkout, with a
warning (stronger if the branch changed `wally.toml`). In that mode `globIgnorePaths` and `syncRules`
do not apply. Run Wally in the worktree to serve its own.

## Sourcemaps

While a project serves a worktree, Rojo-Hub keeps its `sourcemap.json` current (the same command
luau-lsp runs), even with no VS Code window open. It only writes where `sourcemap.json` is gitignored
or already exists; elsewhere use *Update sourcemap.json* in the ⋯ menu. Turn off with
`rojoHub.sourcemaps`.

## Checking out inside a served folder

Prefer the picker. A `git checkout` inside a served worktree changes what Studio gets, and if it
deletes a folder, Rojo 7.7 crashes ([rojo#1305](https://github.com/rojo-rbx/rojo/issues/1305)).
Rojo-Hub restarts it on the same port, and the plugin carries on without showing a disconnect.
