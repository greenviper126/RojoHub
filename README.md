<p align="center"><img src="media/logo.png" alt="Rojo-Hub" width="360"></p>

# Rojo-Hub

A VS Code extension that serves many [Rojo](https://rojo.space) projects at once, each on its own
fixed port, and switches any of them to another branch or worktree **without Studio disconnecting**.

**[Documentation](https://greenviper126.github.io/RojoHub/)** ·
[Install](https://greenviper126.github.io/RojoHub/guide/install) ·
[Changelog](CHANGELOG.md)

<p align="center"><img src="site/public/images/panel-branch-picker.png" alt="A project card in the Rojo-Hub panel with the branch picker open" width="360"></p>

## What it does

- **One port per project, the same everywhere.** A project's port is worked out from its repo's
  first commit (or taken from `servePort` in its project file), so it is the same on every machine.
  Connect each Studio place once; with the Rojo plugin's *Auto Reconnect* on, it reconnects by itself.
- **Live branch switching.** Pick a worktree or any branch. The same `rojo serve` keeps running and
  Studio receives the difference as one update.
- **Groups.** Start, stop or swap a whole set of projects at once, like a profile.
- **Built for agents.** Claude Code, Codex and VS Code agents can serve their own worktree to Studio
  through Rojo-Hub's MCP server, taking turns when several share one repo.
- **Always serving.** A small background service owns the Rojo processes, so closing or reloading
  VS Code windows does not stop anything. The panel follows it live.

## Requirements

- Windows 10 or 11.
- VS Code 1.101 or later.
- git 2.31 or later on `PATH`.
- [Rokit](https://github.com/rojo-rbx/rokit), with each project's pinned Rojo installed
  (`rokit install` in the project). Rokit also reads `aftman.toml` and `foreman.toml`.
- Rojo 7.7 or later, and its Studio plugin.

Details and setup steps: [Requirements](https://greenviper126.github.io/RojoHub/guide/requirements).

## Getting started

1. Download `rojo-hub-<version>.vsix` from [Releases](https://github.com/greenviper126/RojoHub/releases)
   and install it: *Extensions view → ⋯ → Install from VSIX…*, or
   `code --install-extension rojo-hub-<version>.vsix`. Each VS Code profile needs its own install.
2. Open the **Rojo-Hub** panel in the activity bar and press **+** to add a project folder.
3. Press **Start**, click the port to copy it, and connect the Rojo plugin in Studio to
   `localhost` and that port.
4. Click the branch on the card to switch. Studio stays connected.

Rojo-Hub has been submitted to the VS Code Marketplace and is waiting for Microsoft's review; an
Open VSX listing will follow. Until then, install the `.vsix` from Releases as above.

## Develop

```sh
npm install
npm run typecheck
npm test              # unit tests, bundle smoke test, end-to-end against a real Rokit-installed Rojo 7.7
npm run package       # rojo-hub-<version>.vsix
npm run docs:dev      # the documentation site (site/)
```

How it works inside, and why: [`docs/how-it-works.md`](docs/how-it-works.md) and
[`specs/`](specs/).

## License

[MIT](LICENSE). Not affiliated with Roblox or the Rojo project.
