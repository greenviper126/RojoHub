# Get started

## Requirements

| Need | Version |
|---|---|
| Windows | 10 or 11 |
| [VS Code](https://code.visualstudio.com/) | 1.101+ |
| [Git](https://git-scm.com/downloads) | 2.31+, on `PATH` |
| [Rokit](https://github.com/rojo-rbx/rokit) | any |
| Rojo | 7.7+, pinned in the project and installed by Rokit |

Each project is a git repo with a `*.project.json` (normally `default.project.json`) in its top
folder, whose `name` no other project uses.

Optional: Orca (worktrees under Orca's names), Wally, luau-lsp, and AI agents.

::: details Setting up Rokit
Install Rokit from its [releases](https://github.com/rojo-rbx/rokit/releases) (`./rokit self-install`),
then in each project:

```sh
rokit add rojo-rbx/rojo   # new project
rokit install             # has rokit.toml, aftman.toml or foreman.toml
```

Rojo-Hub runs Rojo from Rokit's tool storage, so a Rojo installed by Aftman or Foreman is not found;
`rokit install` reads their files and fixes that. The version comes from the nearest toolchain file
that pins Rojo (project folder, then folders above, then `~/.rokit/rokit.toml`).
:::

::: warning Rojo 7.7 or newer
Rojo-Hub's Studio plugin is Rojo 7.7's and does not connect to Rojo 7.0–7.6. Older projects still
serve, with a warning.
:::

## Install

1. Download `rojo-hub-<version>.vsix` from [Releases](https://github.com/greenviper126/RojoHub/releases).
2. Install it into every VS Code profile you use for Roblox:

   ```sh
   code --install-extension rojo-hub-<version>.vsix --force --profile "<profile>"
   ```

3. Reload the window.

The Marketplace listing is in review. The workspace must be trusted (Rojo-Hub runs git and Rojo).
In remote windows it runs on the local Windows side.

## Set up a project

1. Open the **Rojo-Hub** panel in the activity bar and press **+** on *Projects*. Pick any folder
   in the repo.
2. Press **Start**. The light turns green once Rojo is up.
3. List the places in the project file and open them in Studio. They sync by themselves; the first
   sync asks you to accept once.

   ```json
   "servePlaceIds": [1234567890]
   ```

4. Click the branch on the card to switch. Studio stays connected.

| Light | Meaning |
|---|---|
| grey ring | stopped |
| spinner | starting |
| green ring | serving |
| green dot | serving, Studio connected |
| red dot | error (shown on the card) |

## Hand it to your agents

Open **Agent access** in the panel and switch on Claude Code or Codex (VS Code agents are on by
default). Agents then serve their own worktree to Studio, switch branches, start projects and read
Rojo's errors themselves. See [Agents](./agents).

## Update and uninstall

- **Update**: install the new `.vsix`, then reload every window. Rojo keeps serving, so Studio stays
  connected.
- **Uninstall**: uninstall from every profile. On VS Code's next start, Rojo-Hub removes its agent
  entries and stops its service and Rojo. Delete `%LOCALAPPDATA%\RojoHub\` to remove its state.

::: details Build it yourself
```sh
git clone https://github.com/greenviper126/RojoHub.git
cd RojoHub
npm install
npm run package
```
:::
