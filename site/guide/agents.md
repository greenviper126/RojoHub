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

::: warning Agents cannot start, stop, add or remove projects
Starting Rojo is a new Studio session, and that stays yours. When a project is not serving, or a
repo is not registered, the agent is told to ask you to do it in the panel.
:::

| Tool | Does |
|---|---|
| `status` | Every project: port, serving or not, Studio connected or not, what it serves, who claimed it. Given the agent's folder, also whether its worktree is the one served. |
| `serve_here` | Switches the project of the repo the agent is in to the agent's worktree, live, and claims it. |
| `switch` | Switches a project to a branch (served from its worktree if it has one, else from a view) or a worktree, and claims it. |
| `release` | Drops the agent's claim. The project keeps serving what it serves. |
| `build` | `rojo build` of what a project serves into a `.rbxl` / `.rbxlx` the agent names (an absolute path). |
| `sourcemap` | Writes the served worktree's `sourcemap.json` once. |

::: details Tool parameters
| Tool | Parameters |
|---|---|
| `status` | `path?` |
| `serve_here` | `path`, `project?`, `force?` |
| `switch` | `target`, `project?`, `path?`, `force?` |
| `release` | `path?`, `project?`, `force?` |
| `build` | `output`, `path?`, `project?` |
| `sourcemap` | `path?`, `project?` |

`path` is the agent's working directory (absolute). `project` is a project name or id, needed only
when a repo has more than one project. With neither, the only project is used when there is exactly
one.
:::

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
  unless the agent passes `force`. Claims are kept in memory, so
  restarting the service forgets them.

## Uninstalling

Uninstalling Rojo-Hub removes its Claude Code and Codex entries (only ones pointing at Rojo-Hub) the
next time VS Code starts after the extension is gone from every profile, and then stops the
background service and its Rojo processes.
