# 008 — Agents control Rojo-Hub

Status: **implemented in 0.19.2**. Asked for by Viper: "do they have tools to add projects, create
groups, stop and run groups and projects, switch current branches, stop all from running, switch out
the current json being used in the project, check the connection status and if its auto connected",
"would it still be better if agents had all the common things in an mcp for them?", and "aslong as
agents can easily control this extension so this works well with orca it should be good. this
extension is mainly for multitasking with agents." Builds on 004 (agent access) and 007 (Studio
plugin).

## Problem

Agents (spec 004) could switch what a project serves, build and write sourcemaps, but nothing else.
An agent whose project was stopped, or whose repo was not registered, had to stop and ask the user
to click in the panel; an agent refused because another worktree held the project could only poll;
and when a change did not reach Studio, the reason (Rojo's own error) was only on the panel's card.
Rojo-Hub is mainly for several agents working at once (Orca worktrees), so agents should be able to
do everything the panel does that is not the user's own setup.

## Design

The MCP server (`src/service/mcp.ts`) gets a tool for each common panel action, calling the same
service code the panel's API does, so an agent can do nothing the panel cannot.

**Safe for anyone, so allowed:** `start`, `start_group`, `add_project`, `create_group`, `edit_group`,
`delete_group`, `branches`, `new_branch`, `project_files`, `log`, `wait_for_studio`, and the
existing `status`, `serve_here`, `switch`, `release`, `build`, `sourcemap`.

**Could pull Studio out from under someone, so guarded:**

- `stop`, `stop_group`, `remove_project`: refused while another worktree or branch holds the
  project's claim, or while a Studio place is synced to it and the caller does not hold its claim,
  unless `force` (which the server tells agents to pass only when the user asks). An agent that holds
  the claim may stop its own project.
- `stop_all`: only with `force`.
- `set_project_file`: only while the project is stopped (restarting Rojo on a new file is a new
  session), like the panel.

**Stays the user's:** which project a Studio place syncs with (spec 007), agent registration, and
settings.

**Waiting instead of polling.** `serve_here` and `switch` take `wait` (seconds, up to 600): while
another target holds the claim, the call waits and takes the project the moment the claim is
released or runs out. Waiters on one project are served first come, first served.

**Rojo's errors come back.** After `serve_here`, `switch`, `start` and `new_branch`, the answer
includes any Rojo error or warning logged since (Rojo applies a switch within about a second, so the
tool waits that long first). `log` returns a project's last lines.

**Studio.** `wait_for_studio` waits until a Studio place is synced to the project's current session
and returns its name and place ID. `status` shows, per synced place, why it syncs with the project
(`servePlaceIds`, `placeId`, remembered, or assigned in VS Code) and its plugin version, and each
project's warnings and sourcemap state, and the groups.

**Orca.** `new_branch` makes the branch in a worktree of its own (through Orca when Orca manages the
repo, as the panel does), switches the project to it and claims it for that worktree, and returns
the folder so the agent can work there.

## Acceptance criteria

- [x] Every tool above exists, with the guards described; each guarded refusal says why and how to
      proceed.
- [x] `serve_here`/`switch` with `wait` take the project when the claim is released, in order.
- [x] Rojo errors after a switch are in the answer; `log` returns the log's end.
- [x] `wait_for_studio` returns the synced place, or says none synced within the timeout.
- [x] The server's instructions describe what agents may do and when to ask the user.
- [x] Unit and end-to-end tests cover the new tools and guards; docs and spec 004 are updated.

## Non-goals

- Tools to assign Studio places, change settings, or register agents.
- Events pushed to agents (MCP notifications); agents ask, or wait with `wait`/`wait_for_studio`.
