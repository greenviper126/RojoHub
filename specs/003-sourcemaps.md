# 003 — Sourcemaps

Status: **implemented in 0.15.1**. Asked for by Viper: "we prob should just have our own version if
it makes it more reliable across extension being used and not used". Builds on 002.

## Problem

`sourcemap.json` maps a Rojo project's instances to files. luau-lsp reads it for Roblox types, and
other tools read it too (`wally-package-types`, which TheLaundryShift pins; `luau-lsp analyze`).
Today only the luau-lsp VS Code extension keeps it current, and only:

- in folders open in a VS Code window, while that window is open. An Orca agent editing a worktree
  with no window open gets no sourcemap updates;
- through Rokit's `rojo` shim on PATH;
- until its watcher hits Rojo 7.7's folder-deletion panic (rojo-rbx/rojo#1305). Then it stops and
  asks the user to *Retry*.

## Acceptance criteria

- [x] While a project serves a worktree in place, the service keeps `<worktree>/sourcemap.json`
      current with the pinned `rojo sourcemap --watch`, whether or not VS Code, a window on that
      folder, or luau-lsp is open.
- [x] The file is the same as luau-lsp's: the same subcommand and arguments (`sourcemap
      <projectFile> --include-non-scripts`), run from the worktree. Measured byte for byte on
      TheLaundryShift, including with an absolute `--output` and `--color never`. So both can run at
      once without fighting.
- [x] A crashed watcher (#1305) restarts after a second, and gives up with an error after 5 crashes
      in a minute. A sourcemap is not a Studio session, so restarting it costs nothing.
- [x] No sourcemap for a branch served from a Hub view: views are snapshots nobody edits.
- [x] It never creates a file git would show. It writes only where `sourcemap.json` is gitignored
      or already exists; elsewhere it says why in the ⋯ menu. *Update sourcemap.json* in the ⋯
      menu writes one once, on request, anywhere a worktree is served.
- [x] Watchers stop with the project, on a switch (then start on the new worktree), and with the
      service. A watcher left behind by a service that died is found by its command line (its
      absolute `--output` path) and stopped. luau-lsp's watchers, which use a relative output, are
      never touched.
- [x] `rojoHub.sourcemaps` (default on) turns it off everywhere.

## Measurements (2026-09-27)

- One-shot `rojo sourcemap` on TheLaundryShift: 276 ms. The output is identical to the existing
  `sourcemap.json` written by luau-lsp.
- `--watch` in a temp project: a new file appears in the sourcemap within ~1 s; about 25 MB of
  memory. Deleting a folder crashed it with exit 1: `Result::unwrap()` on `Canonicalize … NotFound`,
  `change_processor.rs` line 179, the same bug as serve.

## Non-goals

- Sourcemaps for worktrees that are not served. (luau-lsp covers open folders. This could be added
  later as a per-worktree option.)
- Replacing or configuring luau-lsp's own generator.
