# Rojo-Hub

A private VS Code extension plus a background service that serves many Rojo projects at once, one
fixed port each, and switches any of them to another branch or Orca worktree without dropping
Studio's connection. Spec and measurements: `specs/001-rojo-hub-foundation.md`. Read it before
changing how project files are generated or served.

## Commands

```sh
npm run typecheck
npm test              # build, load the bundles (smoke), unit + end-to-end against a real rojo 7.7 and a temp git repo
npm run build         # esbuild -> dist/extension.js, dist/service.js
npm run package       # rojo-hub-<version>.vsix
code --install-extension rojo-hub-0.11.1.vsix --force   # repeat with --profile "Roblox" and --profile "Roblox-ScaryPlay"
node tools/live-switch-headless.mjs verbatim|plain   # the original measurement
```

The service listens on `127.0.0.1:34870` and keeps state in `%LOCALAPPDATA%\RojoHub\`. Slot ports
are worked out by `src/service/ports.ts` (servePort, else a hash of the repo's first commit into
`rojoHub.portRange`, default 34873-35872, skipping `rojoHub.excludedPorts`); 34872, Rojo's default
port, is always excluded. Bump
`SERVICE_VERSION` in `src/common/api.ts` with the package version, so an updated extension replaces
the running service.

## Rules that come from mistakes

- Test the bundles, not just the sources: `npm run smoke` loads `dist/extension.js` with a stub
  `vscode` and starts `dist/service.js`. 0.10.0 shipped broken because `jsonc-parser`'s UMD build
  cannot be bundled; `build.mjs` prefers ES module builds (`mainFields`) for that reason.

## Rules that come from measurements (do not "simplify" them away)

- `rojo serve` gets the slot file's verbatim path (`\\?\C:\...`), and the slot file's root `$path` is
  verbatim too. With a plain path, Rojo on Windows ignores every rewrite of the project file.
- Only the root `$path` changes on a switch. The project name and place IDs are read once per session.
- Never delete, or check out into, a folder a running rojo has read. Rojo 7.7 panics when a watched
  folder loses a subfolder (rojo-rbx/rojo#1305) and never unwatches. Views are per commit and are
  collected only while the slot's rojo is stopped.
- Restarting rojo means a new session, so Studio disconnects. Switching must never restart it.
- Start the pinned rojo binary from Rokit's tool storage (`src/service/tools.ts`), never Rokit's
  `rojo` shim: the shim launches rojo as a console child, and Windows Terminal then pops a window.

## Documentation

`docs/how-it-works.md` describes every feature, command, setting and file, and is the source for
user documentation. Update it in the same change as any user-visible behaviour, alongside the spec.

## Working with Viper

- Spec first (`specs/NNN-<slug>.md`: problem, acceptance criteria, non-goals), then measure, then build.
  Keep the spec current.
- Ask design questions as plain numbered text with a default for each, not through the question dialog.
- Batch feedback is logged as a list first and fixed only on the go-ahead.
- Git: never commit to `main`; work on a branch with loose conventional commits
  (`feat(Scope): ...`). Remote is `github.com/greenviper126/RojoHub` (private). Never open or merge a
  pull request unless asked.
- Report plainly what was and was not tried against a real Studio.
