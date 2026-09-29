# Agents

AI agents (Claude Code in a terminal or an Orca worktree, Codex, Copilot and other agents in VS Code)
can use Rojo-Hub themselves: serve their own worktree to Studio before checking their changes there,
switch a project to a branch, build a place file, write `sourcemap.json`.

They get this from an **MCP server** that the background service runs at:

```text
http://127.0.0.1:34870/mcp
```

The agent needs no extra files, scripts or instructions: the server tells the agent what it is for
when it connects.

## Turn it on

![The Agent access section](/images/panel-agent-access.png){.panel-shot}

The panel's **Agent access** section (folded by default) has a switch per agent, with a chip saying
where it stands. The [`rojoHub.agents`](/reference/settings#rojohub-agents) setting has a checkbox
per agent; both change the same setting.

| Chip | Meaning |
|---|---|
| *Connected* | Rojo-Hub is in the agent's config. |
| *Off* | Installed, but Rojo-Hub is not in its config. |
| *Not installed* | Its CLI (`claude`, `codex`) was not found; the switch is greyed out. |
| *Set up by you* | Its config already has an entry named `rojohub` with another URL. Rojo-Hub never changes or removes it. |
| *Can't read config* | The config file exists but could not be read just now (the agent may be writing it). Rojo-Hub leaves it alone and looks again. |

| Agent | Default | What turning it on does |
|---|---|---|
| VS Code agents | on | Registers the server with VS Code itself. Nothing is written to disk; it goes with the extension. |
| Claude Code | off | Runs `claude mcp add --scope user --transport http rojohub http://127.0.0.1:34870/mcp` |
| Codex | off | Runs `codex mcp add rojohub --url http://127.0.0.1:34870/mcp` |

Turning one off runs the matching `mcp remove`.

- **The switches show what each agent's own config says**, so an entry you removed by hand shows
  as off. Claude Code: `.claude.json` in `CLAUDE_CONFIG_DIR` when that is set and the file exists,
  else `~/.claude.json`. Codex: `config.toml` in `CODEX_HOME` when that is set, else
  `~/.codex/config.toml`.
- Rojo-Hub changes an agent's config **only when you change its switch** (or answer the first-run
  question), never just because VS Code started. A window that finds a switch on whose entry you
  removed by hand turns the switch off to match, instead of adding the entry back.
- A config that **can't be read** is never taken for a missing entry: nothing is added or removed,
  and no switch is turned off because of it.
- **`rojoHub.agents` is not synced** by Settings Sync. It describes this machine's agent configs, so
  a choice made on another machine never changes them.

::: info The first-run question
The first time Rojo-Hub finds Claude Code or Codex installed, it asks once: *Let … use Rojo-Hub's
tools?* **Yes** turns them on. **No** turns them off and hides the
[agent notice](./panel#the-agent-notice) above Projects for 14 days.
:::

### Another agent

Under *Other agents and manual setup* in Agent access:

- **Copy commands** (also **Rojo-Hub: Copy Agent Setup Commands**) copies the two commands above and
  a JSON entry for agents that read a JSON MCP config.
- **Copy prompt** (**Rojo-Hub: Copy Agent Setup Prompt**) copies a paragraph to paste into any
  agent's chat; the agent then adds Rojo-Hub to its own config.

## The tools

Agents can do everything the panel does, except what is your own setup (which project a Studio
place syncs with, agent registration, settings). Rojo-Hub is mainly for several agents working at
once, in Orca worktrees or plain git ones, so an agent should not have to stop and ask you to click.

| Tool | Does |
|---|---|
| `status` | Every project: port, serving or not, the Studio places synced to it (name, place ID, why, plugin version), what it serves and with which project file, who claimed it, its warnings and `sourcemap.json` state; then the groups and every open Studio place. Given the agent's folder, also whether its worktree is the one served. |
| `serve_here` | Switches the project of the repo the agent is in to the agent's worktree, live, and claims it; says which Studio places show it and any error Rojo logged. `wait` takes it as soon as another worktree's claim ends. |
| `switch` | Switches a project to a branch (served from its worktree if it has one, else from a view) or a worktree, and claims it. Also takes `wait`. |
| `new_branch` | Makes a branch in a worktree of its own (through Orca when Orca manages the repo), switches the project to it and claims it; answers the folder to work in. |
| `branches` | What a project can switch to, newest first (`fetch` runs `git fetch` first). |
| `release` | Drops the agent's claim. The project keeps serving what it serves. |
| `start` | Starts a stopped project. |
| `stop` | Stops a project. Guarded (below). |
| `stop_all` | Stops every project. Needs `force`, always. |
| `add_project` | Registers the repo a folder is in (optionally with another `project_file`). |
| `remove_project` | Unregisters a project; never deletes files. Guarded. |
| `project_files` | The `*.project.json` files in a project's folder, and which it serves. |
| `set_project_file` | Serves another project file; only while the project is stopped. |
| `start_group` / `stop_group` | Starts or stops a group (`only` also stops everything outside it). Stopping is guarded. |
| `create_group` / `edit_group` / `delete_group` | Makes, renames, changes the members of, or deletes a group. |
| `log` | The last lines of a project's Rojo log. |
| `wait_for_studio` | Waits until a Studio place is synced to the project's session, and names it. |
| `open_place` | Opens one of a project's places in Studio, unless it is already open. Only while [`rojoHub.openPlaces`](/reference/settings#rojohub-openplaces) is on; agents cannot close places. |
| `build` | `rojo build` of what a project serves into a `.rbxl`/`.rbxlx` the agent names. |
| `sourcemap` | Writes the served worktree's `sourcemap.json` once. |

**Guarded.** `stop`, `stop_group`, `remove_project` and `start_group` with `only` are refused while
another worktree holds the project's claim, or while a Studio place is synced to it and the agent
holds no claim on it; the agent that holds the claim may stop its own project. The refusal says who
or what is affected. `force` goes ahead, and the server tells agents to pass it only when you ask.
Starting, adding and group edits never disturb anyone. `set_project_file` works only on a stopped
project, like the panel. Which project a Studio place syncs with, agent registration and settings
stay yours (spec 008).

**Rojo's errors come back.** After `serve_here`, `switch`, `new_branch` and `start`, the tool waits
about a second (Rojo applies a switch in that time) and adds any error Rojo logged, and the card's
warnings, to its answer.

**Waiting instead of polling.** With `wait` (seconds, up to 600), `serve_here`, `switch` and
`new_branch` wait while another worktree holds the claim and take the project the moment it is
released or runs out. Several agents waiting for one project are served in the order they asked.

::: details Tool parameters
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
| `open_place` | `placeId?` (needed when the project has several places), `path?`, `project?` |
| `start_group` / `stop_group` | `group`, `only?` (start), `force?` |
| `create_group` | `name`, `projects?`, `groups?` |
| `edit_group` | `group`, `name?`, `add_projects?`, `remove_projects?`, `add_groups?`, `remove_groups?` |
| `delete_group` | `group` |
| `build` | `output`, `path?`, `project?` |

`path` is the agent's working directory (absolute). `project` is a project name or id, needed only
when a repo has more than one project. With neither, the only project is used when there is exactly
one.
:::

## Which Studio an agent looks at

`status`, `serve_here` and `switch` name the Studio places synced to
the project, with their place IDs (from Rojo-Hub's Studio plugin), and `status` ends with every open
place and what it syncs with. With several Studio windows open for different projects, an agent
using a Roblox Studio tool picks the Studio with that place ID. The server's instructions also tell
agents that Rojo overwrites what it syncs (so they change files, not Studio), that a switch reaches
Studio within about a second, and that they cannot choose which project a place syncs with.

## Claims

Several agents can work in worktrees of one repo while one Studio shows one of them. So
`serve_here` and `switch` **claim** the project for what they serve, for **10 minutes**.

- A claim on an agent's worktree is renewed for another 10 minutes by its `status`, `build` and
  `sourcemap` calls that pass a `path` in that worktree, and by `serve_here` again. `release` does
  not renew it.
- A claim `switch` made for a **branch** is not renewed by other calls; switching to that branch
  again sets it for another 10 minutes.
- While another worktree or branch holds the claim, `serve_here` and `switch` refuse and say who
  holds it and until when. The agent can pass `force`, and is told to only when you say so.
- The project's card shows the claim (*Agent in new-ui until 14:05*, with the worktree's folder
  name), and a folded card shows a robot icon.
- **Your own switches always go through** (the picker, Open Menu's *Switch Branch…*) and clear the
  claim, and so does *New branch*.
- `release` drops it. With a `path` in another worktree it refuses; without a `path` it refuses
  unless the agent passes `force`.
- Claims are kept across a service restart (an update, a crash) until they run out.
- Claims are **per project**: agents working in different projects never block each other.

## Uninstalling

Uninstalling Rojo-Hub removes its Claude Code and Codex entries (only ones pointing at Rojo-Hub) the
next time VS Code starts after the extension is gone from every profile, and then stops the
background service and its Rojo processes.
