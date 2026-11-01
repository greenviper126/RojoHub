# Files on disk

Rojo-Hub keeps its state in `%LOCALAPPDATA%\RojoHub\`:

| Path | Contents |
|---|---|
| `registry.json` (+ `.bak`) | Projects, groups, panel order, Studio place assignments |
| `settings.json` | Last settings from VS Code, for starting with no window open |
| `claims.json` | Agents' claims |
| `universes.json` | Places' universe IDs, looked up once; safe to delete |
| `agent-notice.json` | When the agent notice stays hidden |
| `service.log` | Service events and recovered errors |
| `slots\<id>\slot.project.json` | What Rojo serves; points at the served tree. Don't edit. |
| `slots\<id>\borrowed.project.json` | Copy used when packages are borrowed |
| `slots\<id>\rojo.log` | Rojo's log (`rojo.previous.log`: the run before) |
| `views\<id>\<commit>\` | Read-only checkouts of branches with no worktree |

Outside it, Rojo-Hub writes only:

- `RojoHub.rbxm` in `%LOCALAPPDATA%\Roblox\Plugins` (unless `rojoHub.studioPlugin` is off);
- the agent entries you switch on, through Claude Code's and Codex's own CLIs;
- `sourcemap.json` in served worktrees, where gitignored or already there;
- new worktrees in `<repo>-worktrees/<name>` from *New branch* (repos not in Orca);
- place files you build;
- `rojoHub.*` in VS Code's user settings when you change them in the panel.

It never edits your project files.
