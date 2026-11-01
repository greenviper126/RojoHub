# Agents

Rojo-Hub is meant to be driven by agents. Claude Code, Codex, Copilot and other VS Code agents use it
through an MCP server the background service runs at `http://127.0.0.1:34870/mcp`. The server tells
the agent what it is for when it connects; no extra files or prompts are needed.

## Turn it on

![The Agent access section](/images/panel-agent-access.png){.panel-shot}

Switch agents on in the panel's **Agent access** section (or `rojoHub.agents`).

| Agent | Default | Turning it on runs |
|---|---|---|
| VS Code agents | on | nothing; registered with VS Code |
| Claude Code | off | `claude mcp add --scope user --transport http rojohub http://127.0.0.1:34870/mcp` |
| Codex | off | `codex mcp add rojohub --url http://127.0.0.1:34870/mcp` |

Other agents: *Copy commands* or *Copy prompt* under *Other agents and manual setup*.

The switches follow each agent's own config. *Set up by you* means a `rojohub` entry with another URL
exists; Rojo-Hub leaves it alone.

## What agents can do

Everything the panel does, except your own setup: which project a Studio place syncs with, agent
registration and settings.

| Tool | Does |
|---|---|
| `status` | Every project, what it serves, who claims it, its Studio places and warnings; open places |
| `serve_here` | Serve the agent's own worktree to Studio, live, and claim the project |
| `switch` | Serve a branch or worktree, and claim the project |
| `new_branch` | Make a branch in its own worktree, serve it, and claim the project |
| `branches` | What a project can switch to (`fetch` to fetch first) |
| `release` | Drop the agent's claim |
| `start` / `stop` / `stop_all` | Start or stop projects |
| `add_project` / `remove_project` | Register or unregister a repo (never deletes files) |
| `project_files` / `set_project_file` | List or change the project file (while stopped) |
| `start_group` / `stop_group` | Start or stop a group (`only` also stops everything else) |
| `create_group` / `edit_group` / `delete_group` | Manage groups |
| `log` | The last lines of Rojo's log |
| `wait_for_studio` | Wait until a Studio place has synced |
| `open_place` | Open a project's place in Studio (needs `rojoHub.openPlaces`) |
| `build` | `rojo build` what a project serves |
| `sourcemap` | Write the served worktree's `sourcemap.json` |

After `serve_here`, `switch`, `new_branch` and `start`, the answer includes any error Rojo logged.
Answers name the Studio places showing the project, with place IDs, so an agent with a Studio tool
picks the right Studio.

::: details Parameters
`path` is the agent's working directory. `project` (name or id) is needed only when a repo has more
than one project.

| Tool | Parameters |
|---|---|
| `status` | `path?` |
| `serve_here` | `path`, `project?`, `wait?`, `force?` |
| `switch` | `target`, `project?`, `path?`, `wait?`, `force?` |
| `new_branch` | `name`, `base?`, `path?`, `project?`, `wait?`, `force?` |
| `branches` | `path?`, `project?`, `fetch?` |
| `release` | `path?`, `project?`, `force?` |
| `start` / `project_files` / `log` / `sourcemap` | `path?`, `project?` (`log`: `lines?`) |
| `stop` / `remove_project` | `path?`, `project?`, `force?` |
| `stop_all` | `force` |
| `add_project` | `path`, `project_file?` |
| `set_project_file` | `file`, `path?`, `project?` |
| `wait_for_studio` | `path?`, `project?`, `timeout?` |
| `open_place` | `placeId?`, `path?`, `project?` |
| `start_group` / `stop_group` | `group`, `only?`, `force?` |
| `create_group` | `name`, `projects?`, `groups?` |
| `edit_group` | `group`, `name?`, `add_projects?`, `remove_projects?`, `add_groups?`, `remove_groups?` |
| `delete_group` | `group` |
| `build` | `output`, `path?`, `project?` |
:::

## Claims: several agents, one Studio

`serve_here`, `switch` and `new_branch` claim the project for 10 minutes, renewed by the agent's
further calls from that worktree. While another worktree holds the claim, they refuse and say who
holds it; with `wait` (up to 600 seconds) they queue and take over when it ends. `release` hands it
back.

- `stop`, `stop_group`, `remove_project` and `start_group only` are refused while someone else holds
  the claim or a Studio place is synced. `stop_all` always needs `force`.
- Agents pass `force` only when you tell them to.
- Your own switches in the panel always go through and clear the claim.
- The card shows the claim (*Agent in ‹worktree› until 14:05*).
- Claims are per project and survive a service restart.
