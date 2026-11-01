# Settings

User settings, shared by every project, window and profile. Search `rojoHub` in VS Code's Settings.

| Setting | Default | Does |
|---|---|---|
| `rojoHub.portRange` | `"34873-35872"` | Range ports are hashed into. See [Ports](/guide/projects#ports). |
| `rojoHub.excludedPorts` | `[]` | Ports never hashed to: `35000` or `"35000-35010"`. A `servePort` still wins. |
| `rojoHub.sourcemaps` | `true` | Keep `sourcemap.json` current in served worktrees. |
| `rojoHub.studioPlugin` | `true` | Keep Rojo-Hub's Studio plugin installed. |
| `rojoHub.studioAutoConnect` | `"remembered"` | `"listed"`: only places a project file lists or you assign connect by themselves. `"remembered"`: also a place's last project. |
| `rojoHub.openPlaces` | `false` | **Open** on project cards and agents' `open_place`. An open place is never opened twice. |
| `rojoHub.closePlaces` | `false` | **Close** and **Reopen** on project cards and agents' `close_place` and `reopen_place`, for example to load an updated plugin. Studio is asked to close as if you closed its window, so it still asks about unsaved changes. A reopen needs only this setting, not `openPlaces`. |
| `rojoHub.claimMinutes` | `15` | How long an agent's claim lasts after its last Rojo-Hub call. `0`: until the agent calls `release` or you press **Release claim** on the card. |
| `rojoHub.reloadOnUpdate` | `true` | Reload this window by itself, 10 seconds after a notification (**Reload Now** / **Not Now**), when a newer Rojo-Hub is installed in this VS Code profile. |
| `rojoHub.placeMoves` | `"ask"` | When an agent asks for a Studio place another project holds: `"ask"` asks you (in the agent's client, else in VS Code); `"auto"` moves it at once unless another agent claimed the holding project. |
| `rojoHub.yolo` | `false` | **Dangerous.** Lets agents open Studio places and stop projects Studio is using, and `stop_all` without `force`. Claims still hold, and `closePlaces` stays off. Asks you to confirm; every agent action is logged to `audit.jsonl`. See [Yolo mode](/guide/agents#yolo-mode). |
| `rojoHub.setupCommands` | `{}` | **Dangerous.** Per repo path, programs that run in a new worktree before it is first served (`rokit install`, `wally install`). Edit in the panel (⋯ → *Setup commands…*). Only you can set it; not synced. See [Agents](/guide/agents#setup-commands). |
| `rojoHub.agents` | `{ vscode: true, claudeCode: false, codex: false }` | Which agents get the MCP server. Not synced between machines. |
| `rojoHub.notifyOnStudioDisconnect` | `false` | Show a message when Studio disconnects. |

The panel's *Port settings* edits the two port settings. Invalid values are ignored with a warning on
every card.
