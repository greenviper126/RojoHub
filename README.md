# Rojo-Hub

Serve many Rojo projects at once, each on its own fixed port, and switch any of them to another
branch or Orca worktree without Studio's Rojo connection dropping.

- **One port per project, the same everywhere.** A project's port is worked out from its repo's first
  commit (or taken from `servePort` in its project file), so it is the same on every machine and
  never changes. Global exclusions live in the `rojoHub.excludedPorts` setting.
  Connect each Studio place to it once; with the Rojo plugin's *Auto Reconnect* setting on, the
  place reconnects by itself from then on.
- **Live branch switching.** Pick a worktree (listed under Orca's names) or any branch. The same
  `rojo serve` keeps running and Studio receives the difference as one update.
- **Background service.** A small local service owns the Rojo processes, so closing VS Code windows
  does not stop serving. It listens on `127.0.0.1:34870`.

Full description of every feature, setting and file, for users and for writing user docs:
[`docs/how-it-works.md`](docs/how-it-works.md). Why it is built this way, with measurements:
[`specs/001-rojo-hub-foundation.md`](specs/001-rojo-hub-foundation.md).

## Install

```sh
npm install
npm run package
code --install-extension rojo-hub-0.10.2.vsix --force   # repeat with --profile "Roblox" and --profile "Roblox-ScaryPlay"
```

## Develop

```sh
npm run typecheck
npm test            # unit tests plus an end-to-end run against a real rojo (needs rokit's rojo 7.7 on PATH)
npm run build       # dist/extension.js and dist/service.js
```
