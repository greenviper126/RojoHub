# 004 — Agent access

Status: **implemented in 0.16.0**. Asked for by Viper: "How can we add better support for AI agents
and orca with RojoHub? ... I just want this to work out of box for the most part", "as long as it
doesnt cause issues and removing the extension removes that", "lets have this in the drop down
settings specifically even if you add it in the actual settings too". Builds on 002 and 003.

## Problem

Agents (Claude Code in Orca worktrees, VS Code's own agents) edit worktrees of registered projects,
but cannot get their worktree into Studio. They would have to know that the service's HTTP API
exists, and work out slot ids and JSON bodies. Several agents in different worktrees of one repo
share one slot and one Studio, so an agent that switches the slot changes what another agent's
playtest shows, without either of them knowing.

## Design

- The service serves MCP (streamable HTTP, JSON responses, no sessions) at
  `http://127.0.0.1:34870/mcp`. MCP carries its own instructions and tool descriptions, so no skill
  file, AGENTS.md note or PATH entry is needed.
- Tools: `status`, `serve_here`, `switch`, `release`, `build`, `sourcemap`. There are no tools to
  start, stop, add or remove projects: starting rojo is a new Studio session, and that stays the
  user's decision.
- **Claims.** `serve_here` and `switch` claim the project for what they serve (a worktree, or a
  branch) for 10 minutes. Any tool call from the same worktree renews it. While another target
  holds the claim, both tools refuse with who holds it and until when, unless `force: true`.
  `release` drops it. A switch by the user (panel, picker, menu) always goes through and clears the
  claim. Claims live in the service's memory: a restarted service forgets them.
- **Registration**, the `rojoHub.agents` setting (application scope, checkboxes) and the panel's
  *Agent access* section, which show and change the same values:
  - *VS Code agents*: on by default. Registered with the provider API
    (`contributes.mcpServerDefinitionProviders`), so VS Code adds and drops it with the extension
    and no file is written.
  - *Claude Code*, *Codex*: off until ticked. The service runs the agent's own CLI
    (`claude mcp add --scope user --transport http rojohub <url>`, `codex mcp add rojohub --url
    <url>`), one at a time, and the matching `remove` when unticked. The service does it rather
    than each window, so several windows never write the same config file at once.
  - Status is read from the agent's own config file (`~/.claude.json`, `~/.codex/config.toml`), so
    an entry removed by hand shows as not connected. An entry named `rojohub` with another URL is
    the user's own and is never changed or removed.
  - First run: one notification, *Let Claude Code and Codex use Rojo-Hub's tools?* (only the agents
    installed), with Yes / No. It sets the setting; it is never asked again once answered.
  - *Copy setup commands* and *Copy setup prompt* (panel and command palette) cover any other agent.
  - The panel shows each agent as a row with a switch and a status chip; the address and copy buttons
    are folded under *Other agents and manual setup*. Asked for by Viper: "make the agents tab look
    nicer its kinda confusing".
  - **Notice above Projects** ("lets have a popup above projects saying you can connect to agents ...
    just occasionally if you have no agents connected"): shown while at least one project is
    registered and Claude Code or Codex is installed but neither is connected (VS Code's agents do not
    count: they are on by default, so it would never show). *Set up* opens Agent access; *Later* hides
    it for 14 days; ✕ for good; *No* on the first-run question counts as *Later*. Kept in
    `%LOCALAPPDATA%\RojoHub\agent-notice.json`, so windows and profiles agree.
- **Uninstall**: `vscode:uninstall` runs `dist/uninstall.js`, which removes the Claude Code and
  Codex entries if, and only if, their URL is Rojo-Hub's.
- The service refuses requests that carry a browser `Origin` other than localhost, on every route
  (the MCP spec requires it for `/mcp`; the rest of the API had the same exposure).

## Acceptance criteria

- [x] `POST /mcp` answers `initialize`, `ping`, `tools/list` and `tools/call`; notifications get
      202; `GET /mcp` gets 405. Unit-tested.
- [x] `serve_here` from any folder inside a worktree of a registered repo switches that repo's
      project to the worktree's root, without restarting rojo, and says whether rojo is serving and
      whether Studio is connected. From a repo that is not registered it says how to add it.
- [x] A second worktree's `serve_here` is refused while the first one's claim runs, and goes
      through with `force`. A user switch clears the claim. End-to-end tested.
- [x] The panel's project card shows who holds the claim and until when.
- [x] Ticking Claude Code in the panel or the setting registers it; unticking removes it; the
      panel shows the state read back from `~/.claude.json`. Same for Codex.
- [x] Claude Code connects to the endpoint and lists the tools (`claude mcp get rojohub`: Connected).
- [x] Uninstalling the extension removes the entries (hook measured, below).
- [x] The notice shows and hides as described. Unit-tested.
- [x] A window that runs the new code before VS Code has registered its settings asks to be reloaded
      instead of failing with "not a registered configuration" (seen once after a CLI install), and a
      refused switch flips back.

## Measurements (2026-09-27)

- `vscode:uninstall`, with a probe extension in a throwaway `--user-data-dir`/`--extensions-dir`:
  after `code --uninstall-extension`, the first start of VS Code marked it obsolete and the second
  ran the hook and deleted the folder. (An uninstall from the Extensions view marks it obsolete at
  once, so one restart is enough.) The hook ran under `Code.exe` as Node, with the user's PATH and
  VS Code's install folder as its working directory. So the hook can run `claude` and `codex`.
- `claude mcp get` performs a health check of every server, so status is read from `~/.claude.json`
  directly (user-scope servers are its top-level `mcpServers`), never by running the CLI on a poll.
- Claude Code 2.1.283 and Codex 0.156.1 both register streamable-HTTP servers by URL.
- Live, against a 0.16.0 service on a spare port: `claude mcp add --scope local --transport http` then
  `claude mcp get` reported *Connected*, and `claude -p` (Haiku) called `status` and returned its text
  unchanged. `codex mcp add rojohub --url …` with a throwaway `CODEX_HOME` wrote
  `[mcp_servers.rojohub] url = …`, which the registrar reads back as connected. Neither the user's
  real Claude Code nor Codex config was touched by these checks.
- Not tried: a VS Code agent (Copilot) using the provider-registered server, and an agent driving a
  real Studio after `serve_here` (the switch itself is the same one the end-to-end tests cover).

## Non-goals

- Agents starting, stopping, adding or removing projects.
- A CLI for agents. MCP covers them; a CLI can come later for scripts.
- Claims that survive a service restart, or that know which agent (rather than which worktree)
  holds them.
- Project-scope `.mcp.json` files in game repos.
