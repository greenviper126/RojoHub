<p align="center"><img src="media/logo.png" alt="Rojo-Hub" width="360"></p>

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

Documentation: [greenviper126.github.io/RojoHub](https://greenviper126.github.io/RojoHub/). The
full description of every feature, setting and file is in [`docs/how-it-works.md`](docs/how-it-works.md);
why it is built this way, with measurements, in
[`specs/001-rojo-hub-foundation.md`](specs/001-rojo-hub-foundation.md).

## Requirements

- Windows 10 or 11.
- VS Code 1.101 or later.
- git 2.31 or later on `PATH`.
- [Rokit](https://github.com/rojo-rbx/rokit), with each project's pinned Rojo installed (`rokit install`
  in the project). Rojo-Hub runs the Rojo that Rokit installed; one installed by Aftman or Foreman is
  not found, but `rokit install` reads their `aftman.toml` and `foreman.toml` too.
- Rojo 7.7 or later, and its Studio plugin.

## Install

Download `rojo-hub-<version>.vsix` from the
[GitHub Releases](https://github.com/greenviper126/RojoHub/releases) page and install it, either with
*Extensions: Install from VSIX...* in VS Code or from a terminal:

```sh
code --install-extension rojo-hub-<version>.vsix --force
```

Each VS Code profile has its own extensions, so install it in every profile you use (add
`--profile "<name>"` to the command). A Marketplace release is planned.

To build the .vsix yourself:

```sh
npm install
npm run package
```

## Develop

```sh
npm run typecheck
npm test            # unit tests plus an end-to-end run against a real rojo (needs rokit's rojo 7.7 on PATH)
npm run build       # dist/extension.js and dist/service.js
```
