<p align="center"><img src="media/logo.png" alt="Rojo-Hub" width="360"></p>

# Rojo-Hub

Serve many [Rojo](https://rojo.space) projects at once, each on its own fixed port, and switch any of
them to another branch or worktree **without Studio disconnecting**. Built so AI agents can drive it.

**[Documentation](https://greenviper126.github.io/RojoHub/)** ·
[Get started](https://greenviper126.github.io/RojoHub/guide/getting-started) ·
[Changelog](CHANGELOG.md)

<p align="center"><img src="site/public/images/panel-branch-picker.png" alt="A project card in the Rojo-Hub panel with the branch picker open" width="360"></p>

## What it does

- **A fixed port per project**, the same on every machine (from `servePort`, or the repo's first commit).
- **Studio connects by itself.** Rojo-Hub's Studio plugin syncs each place with its project and
  reconnects after any Rojo restart.
- **Live branch switching.** Pick a worktree or branch; Rojo keeps running and Studio gets the diff.
- **Groups** start and stop a set of projects together.
- **Agents** (Claude Code, Codex, VS Code agents) use it through a built-in MCP server: serve their
  own worktree to Studio, make branches, start projects, read Rojo's errors. Several agents take turns.
- **Always serving.** A background service owns Rojo, so closing VS Code windows stops nothing.

## Requirements

Windows 10/11, VS Code 1.101+, git 2.31+, and [Rokit](https://github.com/rojo-rbx/rokit) with each
project's Rojo (7.7+) installed (`rokit install`).

## Get started

1. Download `rojo-hub-<version>.vsix` from [Releases](https://github.com/greenviper126/RojoHub/releases)
   and run `code --install-extension rojo-hub-<version>.vsix` (once per VS Code profile).
2. Open the **Rojo-Hub** panel, press **+** and pick your project folder.
3. Press **Start**. Add your place IDs to `servePlaceIds` in the project file and open the place in
   Studio: it syncs by itself.
4. Click the branch on the card to switch.
5. Optional: turn on your agents under **Agent access**.

The VS Code Marketplace listing is in review; until then, install from Releases.

## Develop

```sh
npm install          # building also needs Rojo 7.7.0 from Rokit, for the Studio plugin
npm test             # unit, bundle smoke and end-to-end tests against a real Rojo 7.7
npm run package      # rojo-hub-<version>.vsix
npm run docs:dev     # the documentation site (site/)
```

Internals: [`docs/how-it-works.md`](docs/how-it-works.md) and [`specs/`](specs/). The Studio plugin
in [`plugin/`](plugin/) is Rojo's, with changes listed in [`plugin/UPSTREAM.md`](plugin/UPSTREAM.md).

## License

[MIT](LICENSE), except [`plugin/`](plugin/), which stays under Rojo's [MPL-2.0](plugin/LICENSE)
(Rojo-Hub's own files in it are MIT). Bundled third-party work is credited in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Not affiliated with Roblox or the Rojo project.
