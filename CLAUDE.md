# Rojo-Hub

A private VS Code extension plus a background service that serves many Rojo projects at once, one
fixed port each, and switches any of them to another branch or Orca worktree without dropping
Studio's connection. Spec and measurements: `specs/001-rojo-hub-foundation.md`. Read it before
changing how project files are generated or served.

## Commands

```sh
npm run typecheck
npm test              # unit + end-to-end against a real rojo 7.7 (Rokit's, on PATH) and a temp git repo
npm run build         # esbuild -> dist/extension.js, dist/service.js
npm run package       # rojo-hub-<version>.vsix
code --install-extension rojo-hub-0.1.0.vsix
node tools/live-switch-headless.mjs verbatim|plain   # the original measurement
```

The service listens on `127.0.0.1:34870` and keeps state in `%LOCALAPPDATA%\RojoHub\`. Slot ports
are 34873-34899; 34872 is TheLaundryShift's `/JumpTo` port and is never used. Bump
`SERVICE_VERSION` in `src/common/api.ts` with the package version, so an updated extension replaces
the running service.

## Rules that come from measurements (do not "simplify" them away)

- `rojo serve` gets the slot file's verbatim path (`\\?\C:\...`), and the slot file's root `$path` is
  verbatim too. With a plain path, Rojo on Windows ignores every rewrite of the project file.
- Only the root `$path` changes on a switch. The project name and place IDs are read once per session.
- Never delete, or check out into, a folder a running rojo has read. Rojo 7.7 panics when a watched
  folder loses a subfolder (rojo-rbx/rojo#1305) and never unwatches. Views are per commit and are
  collected only while the slot's rojo is stopped.
- Restarting rojo means a new session, so Studio disconnects. Switching must never restart it.

## Working with Viper

- Spec first (`specs/NNN-<slug>.md`: problem, acceptance criteria, non-goals), then measure, then build.
  Keep the spec current.
- Ask design questions as plain numbered text with a default for each, not through the question dialog.
- Batch feedback is logged as a list first and fixed only on the go-ahead.
- Git: never commit to `main`; work on a branch with loose conventional commits
  (`feat(Scope): ...`). Remote is `github.com/greenviper126/RojoHub` (private). Never open or merge a
  pull request unless asked.
- Report plainly what was and was not tried against a real Studio.
