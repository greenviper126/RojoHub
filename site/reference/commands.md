# Commands

Everything is in the [panel](/guide/panel). For keyboard use, the command palette
(`Ctrl+Shift+P`) has three Rojo-Hub commands.

| Command | Does |
|---|---|
| **Rojo-Hub: Open Menu** | The panel's actions as quick-pick menus, like Rojo's own *Rojo: Open Menu*. |
| **Rojo-Hub: Copy Agent Setup Commands** | Copies the `claude mcp add` and `codex mcp add` commands and a JSON entry for other agents. See [Agents](/guide/agents#another-agent). |
| **Rojo-Hub: Copy Agent Setup Prompt** | Copies a paragraph to paste into any agent's chat, so it adds Rojo-Hub to its own config. |

## Open Menu

Open Menu lists your projects, then your groups, then:

| Item | Does |
|---|---|
| **Add Project** | Pick a folder to add. |
| **New Group** | Make a group. |
| **Port Settings** | Opens VS Code's Settings on Rojo-Hub's settings. |
| **Agent Access** | Opens VS Code's Settings on `rojoHub.agents`. |
| **Stop All** | Stops every serving project, after asking. |

### Project menu

Pick a project in Open Menu:

| Item | Does |
|---|---|
| **Switch Branch…** | Lists worktrees and branches to serve. Studio stays connected. |
| **Start Serving** / **Stop Serving** | Start or stop it; a project in error offers both. |
| **Copy Port** | Copies the port number. |
| **Project File…** | Pick another `*.project.json` (locked while running or starting). |
| **Show Rojo Log** | Opens the project's Rojo log. |
| **Remove Project** | Removes it from Rojo-Hub, after asking. |
| **All Projects** | Back to Open Menu. |

The project's first warning or error shows at the top.

### Group menu

Pick a group in Open Menu:

| Item | Does |
|---|---|
| **Start Group** | Serves every project in it. |
| **Stop Group** | Stops its projects, except those another running group holds. |
| **Add Project to Group** | Adds a project or group. |
| **Rename Group** | Renames it. |
| **Delete Group** | Deletes the group (its projects stay). |

Below them, the group's projects; pick one for its project menu.

## Panel title bar

| Button | Does |
|---|---|
| List icon | **Open Menu** |
| Refresh | Reloads the panel's state and re-reads workspace files. |
| Collapse All | Folds everything except what is running (see [Folding](/guide/panel#folding)). |
| `…` menu | **Add Project**, **New Group**, **Stop All** |

## Status bar

In a window whose folder belongs to a registered project, the status bar shows
`Rojo :<port> · <what it serves>` with its state icon. Click it to open the panel on that project's
card.
