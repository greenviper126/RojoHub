# Rojo-Hub

A public (MIT) VS Code extension plus a background service that serves many Rojo projects at once, one
fixed port each, and switches any of them to another branch or Orca worktree without dropping
Studio's connection. Spec and measurements: `specs/001-rojo-hub-foundation.md`. Read it before
changing how project files are generated or served.

## Commands

```sh
npm run typecheck
npm test              # build, load the bundles (smoke), unit + end-to-end against a real rojo 7.7 and a temp git repo
npm run build         # esbuild -> dist/extension.js, dist/service.js; rojo 7.7.0 (Rokit) -> dist/RojoHub.rbxm
npm run package       # rojo-hub-<version>.vsix
code --install-extension rojo-hub-0.21.0.vsix --force   # repeat with --profile "Roblox" and --profile "Roblox-ScaryPlay"
node tools/live-switch-headless.mjs verbatim|plain   # the original measurement
```

The service listens on `127.0.0.1:34870` and keeps state in `%LOCALAPPDATA%\RojoHub\`. Slot ports
are worked out by `src/service/ports.ts` (servePort, else a hash of the repo's first commit into
`rojoHub.portRange`, default 34873-35872, skipping `rojoHub.excludedPorts`); 34872, Rojo's default
port, is always excluded. Bump
`SERVICE_VERSION` in `src/common/api.ts` with the package version, so an updated extension replaces
the running service, and `plugin/src/RojoHub/Version.lua` with it (a unit test checks).

`plugin/` is Rojo 7.7.0's Studio plugin (MPL-2.0) with Rojo-Hub's changes (spec 007). Keep changes
to Rojo's own files to small hooks marked `-- Rojo-Hub`, list every one in `plugin/UPSTREAM.md`, and
put the rest in `plugin/src/RojoHub/`, so moving to a newer Rojo stays a merge. Which project a
Studio place syncs with is decided in VS Code (the panel's Studio places); the plugin only connects
and shows the answer. Bump `STUDIO_PROTOCOL` (and `PROTOCOL` in the plugin) whenever the messages
between them change.

## Releasing

- Bump the version in every place at once: `package.json`, `package-lock.json` (its first two
  `version` fields), `SERVICE_VERSION` in `src/common/api.ts`, the install line above, the version
  line at the top of `docs/how-it-works.md`, the version menu in `site/.vitepress/config.mts`, and a
  new entry in both `CHANGELOG.md` and `site/changelog.md`.
- Merge to `main`, then push a tag `vX.Y.Z` on `main`. The Release workflow checks the tag matches
  `package.json`, packages the `.vsix` and makes the GitHub release. It also publishes to the VS Code
  Marketplace and Open VSX when the `VSCE_PAT` / `OVSX_PAT` secrets are set.
- The documentation site (`site/`, VitePress) deploys to GitHub Pages from `main` by the Docs
  workflow. Built pages are never committed.
- Marketplace versions only go up; never reuse or lower a published version.

## Rules that come from mistakes

- Test the bundles, not just the sources: `npm run smoke` loads `dist/extension.js` with a stub
  `vscode`, starts `dist/service.js`, and runs `dist/uninstall.js` against a throwaway home (never the
  real one: it removes agent config entries). 0.10.0 shipped broken because `jsonc-parser`'s UMD build
  cannot be bundled; `build.mjs` prefers ES module builds (`mainFields`) for that reason.
- Every installed build that changes the service gets a new version, even mid-branch. The extension
  keeps a running service of the same version, so reinstalling 0.17.0 over 0.17.0 left the old
  service up without `projectFiles`, and the panel's file list did nothing.

## Rules that come from measurements (do not "simplify" them away)

- `rojo serve` gets the slot file's verbatim path (`\\?\C:\...`), and the slot file's root `$path` is
  verbatim too. With a plain path, Rojo on Windows ignores every rewrite of the project file.
- Only the root `$path` changes on a switch. The project name and place IDs are read once per session.
- Never delete, or check out into, a folder a running rojo has read. Rojo 7.7 panics when a watched
  folder loses a subfolder (rojo-rbx/rojo#1305) and never unwatches. Views are per commit and are
  collected only while the slot's rojo is stopped.
- Restarting rojo means a new session, so Studio disconnects. Switching must never restart it.
  Changing a project's project file (spec 005) is not a switch; the panel only allows it while stopped.
- Start the pinned rojo binary from Rokit's tool storage (`src/service/tools.ts`), never Rokit's
  `rojo` shim: the shim launches rojo as a console child, and Windows Terminal then pops a window.
- Studio loads a new or changed local plugin only when a place is opened (spec 007, M3). An installed
  plugin update reaches open places only after they are reopened, so the service must keep talking
  to older plugins of the same `STUDIO_PROTOCOL`.
- A plugin setting is one value shared by every Studio process, and each process writes back the
  whole value it loaded: places open at once overwrite each other's entries (spec 007). Anything per
  place that must last (the last synced project, assignments) is kept by the service.
- Tests never touch the real Studio plugins folder: the service takes it from
  `ROJO_HUB_STUDIO_PLUGINS` when set, and the smoke and end-to-end tests set it.

## Licences

`THIRD-PARTY-NOTICES.md` credits everything of others' that ships (the Rojo plugin and its packages,
bundled npm packages, the codicon font). Adding or updating any of them means updating
`tools/notices.mjs` and running it; `npm test` fails otherwise. Keep upstream licence and copyright
notices intact.

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
