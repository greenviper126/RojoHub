# Files on disk

## Rojo-Hub's own folder

Everything Rojo-Hub keeps lives in `%LOCALAPPDATA%\RojoHub\`:

| Path | Contents |
|---|---|
| `registry.json` | Projects (repo, project file, port, what they serve, whether they should be serving), groups (members, nested groups, whether running), and the panel's display order |
| `registry.json.bak` | `registry.json` as it was before the last save, to start from if it is damaged |
| `registry.corrupt-<time>.json` | A damaged `registry.json`, kept aside when the service recovered from the `.bak` |
| `settings.json` | The settings last sent by VS Code (port range, excluded ports, sourcemaps, Studio settings) |
| `universes.json` | Each opened place's universe ID and name, looked up from Roblox once; safe to delete |
| `agent-notice.json` | Until when the agent notice above Projects stays hidden (*Later*, ✕) |
| `service.log` | Service start and stop, recovered errors, a damaged registry, git problems |
| `slots\<id>\slot.project.json` | The generated file Rojo serves; its root points at the served tree's project file |
| `slots\<id>\borrowed.project.json` | The generated copy used in [borrowed mode](/guide/switching#packages-wally) |
| `slots\<id>\rojo.log` | This project's Rojo log (*Show Rojo Log*); `rojo.previous.log` is the run before |
| `views\<id>\<commit>\` | [Views](/guide/switching#views): detached worktrees for branches with no worktree, named after the first 12 hex digits of the commit |

`<id>` is the project's internal id, not its name.

::: danger Do not edit slot files by hand
`slot.project.json` is rewritten on every switch, and a running Rojo is watching it. Change what a
project serves from the panel instead.
:::

::: tip Starting over
To remove everything, uninstall Rojo-Hub from every profile, let VS Code start once, and delete
`%LOCALAPPDATA%\RojoHub\`. See [Uninstall](/guide/install#uninstall).
:::

## Outside that folder

Rojo-Hub writes only:

- the **agent entries** you switch on in *Agent access*, through Claude Code's and Codex's own CLIs
  (into `~/.claude.json`, or `.claude.json` in `CLAUDE_CONFIG_DIR` when that is set and the file
  exists; and `~/.codex/config.toml`, or `config.toml` in `CODEX_HOME`);
- **`sourcemap.json`** in a served worktree, only where it is gitignored or already exists (see
  [Sourcemaps](/guide/sourcemaps)), or once when you ask with *Update sourcemap.json*;
- a **new worktree** in `<repo>-worktrees/<name>` beside the repo when you make a
  [New branch](/guide/switching#new-branch) in a repo Orca does not know;
- **place files** where you save them with *Build place file…*;
- the **port settings** in VS Code's user `settings.json`, when you press *Save* or *Reset* in Port
  settings, and `rojoHub.agents` when you change an agent's switch.

It **never edits your project files**. Git also records the view worktrees Rojo-Hub registers
(visible in `git worktree list`) and removes again.
