# Settings

User settings, shared by every project, window and profile. Search `rojoHub` in VS Code's Settings.

| Setting | Default | Does |
|---|---|---|
| `rojoHub.portRange` | `"34873-35872"` | Range ports are hashed into. See [Ports](/guide/projects#ports). |
| `rojoHub.excludedPorts` | `[]` | Ports never hashed to: `35000` or `"35000-35010"`. A `servePort` still wins. |
| `rojoHub.sourcemaps` | `true` | Keep `sourcemap.json` current in served worktrees. |
| `rojoHub.studioPlugin` | `true` | Keep Rojo-Hub's Studio plugin installed. |
| `rojoHub.studioAutoConnect` | `"remembered"` | `"listed"`: only places a project file lists or you assign connect by themselves. `"remembered"`: also a place's last project. |
| `rojoHub.openPlaces` | `false` | Open, close and reopen places from project cards; lets agents use `open_place`. |
| `rojoHub.agents` | `{ vscode: true, claudeCode: false, codex: false }` | Which agents get the MCP server. Not synced between machines. |
| `rojoHub.notifyOnStudioDisconnect` | `false` | Show a message when Studio disconnects. |

The panel's *Port settings* edits the two port settings. Invalid values are ignored with a warning on
every card.
