# Sourcemaps

While a project serves a **worktree**, Rojo-Hub keeps that worktree's `sourcemap.json` up to date
with the project's pinned `rojo sourcemap --watch`. [luau-lsp](https://github.com/JohnnyMorganz/luau-lsp)
reads it for Roblox types, and so do tools such as `wally-package-types`.

It works whether or not VS Code, a window on that folder, or the luau-lsp extension is open, so an
agent editing a worktree with no window gets it too.

## How it behaves

- **Same file as luau-lsp.** It runs the same command luau-lsp's extension does
  (`sourcemap <project file> --include-non-scripts`, from the worktree), so the two write identical
  files and can both run.
- **Recovers by itself.** Deleting a folder crashes Rojo 7.7's watcher (the same bug as in
  [Checking out inside a served folder](./switching#checking-out-inside-a-served-folder)). Rojo-Hub
  restarts it a second later, and gives up with a note after five crashes in a minute. Nothing in
  Studio is affected.
- **Never adds a file to git.** It writes only where `sourcemap.json` is gitignored or already
  exists.
- **Not for branches** served from a [view](./switching#views): nothing edits those.
- It stops with the project and moves with a switch.

## Status and writing it by hand

The card's **⋯** menu shows *Update sourcemap.json* with the sourcemap's status, for example:

| Status | Meaning |
|---|---|
| *Kept up to date in ‹folder›* | Watching. |
| *Kept up to date while the project is serving* | The project is stopped. |
| *Not kept: sourcemap.json is not gitignored in ‹folder›, so it would show up in git* | Add it to `.gitignore`, or write it once by hand. |
| *Not kept for a branch served from a Hub copy, which nothing edits* | The project serves a view. |
| *Turned off (rojoHub.sourcemaps)* | The setting is off. |
| *rojo sourcemap keeps stopping, so it was left off: ‹reason›* | It crashed five times in a minute. |

Click **Update sourcemap.json** to write it once, now, even where it is not kept up to date (for
example where it is not gitignored). It works for a project serving a worktree; a project serving a
view has none.

## Turn it off

Set [`rojoHub.sourcemaps`](/reference/settings#rojohub-sourcemaps) to `false` to turn it off
everywhere.
