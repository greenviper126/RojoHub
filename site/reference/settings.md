# Settings

All Rojo-Hub settings are **user settings that apply to every project, window and profile**. A
workspace cannot override them. Open them with *File → Preferences → Settings* and search for
`rojoHub`, or *Open Menu → Port Settings* (and *Open Menu → Agent Access* for `rojoHub.agents`).

| Setting | Default | In short |
|---|---|---|
| [`rojoHub.portRange`](#rojohub-portrange) | `"34873-35872"` | Ports picked from |
| [`rojoHub.excludedPorts`](#rojohub-excludedports) | `[]` | Ports never given to a project |
| [`rojoHub.sourcemaps`](#rojohub-sourcemaps) | `true` | Keep `sourcemap.json` up to date |
| [`rojoHub.studioPlugin`](#rojohub-studioplugin) | `true` | Keep Rojo-Hub's Studio plugin installed |
| [`rojoHub.studioAutoConnect`](#rojohub-studioautoconnect) | `"remembered"` | Which places connect by themselves |
| [`rojoHub.agents`](#rojohub-agents) | `{ "vscode": true, "claudeCode": false, "codex": false }` | Which agents can use Rojo-Hub |
| [`rojoHub.notifyOnStudioDisconnect`](#rojohub-notifyonstudiodisconnect) | `false` | Message when Studio disconnects |

## `rojoHub.portRange`

- **Default:** `"34873-35872"`

Ports picked from, as `first-last`. Each project gets a port worked out from its repo's first commit,
placed in this range, unless its project file sets `servePort`. A range may be a single port
(`"35000-35000"`). An invalid value is ignored with a warning, and the default is used. See
[Ports](/guide/ports).

## `rojoHub.excludedPorts`

- **Default:** `[]`

Ports the hash never gives to a project: numbers (`35000`) or ranges (`"35000-35010"`). 34872 (Rojo's
default) and 34870 (Rojo-Hub's service) are always excluded. A `servePort` in the project file still
wins (see [Ports](/guide/ports#how-a-port-is-picked)). An invalid entry is ignored with a warning. A
serving project whose port changes is restarted on its new port, at once.

```json
"rojoHub.excludedPorts": [35000, "35100-35110"]
```

## `rojoHub.sourcemaps`

- **Default:** `true`

Keep `sourcemap.json` up to date in the worktree each serving project serves, with its pinned
`rojo sourcemap --watch`. Written only where `sourcemap.json` is gitignored or already exists. See
[Sourcemaps](/guide/sourcemaps).

## `rojoHub.studioPlugin`

- **Default:** `true`

Keep Rojo-Hub's Studio plugin (`RojoHub.rbxm`) in Studio's local plugins folder, up to date, and take
out other `RojoHub*.rbxm` copies. Off: Rojo-Hub leaves the plugins folder alone, and uninstalling
Rojo-Hub does not remove the plugin. See [Connecting Studio](/guide/connecting-studio).

## `rojoHub.studioAutoConnect`

- **Default:** `"remembered"`

Which Studio places Rojo-Hub's plugin connects by itself.

- `"listed"`: only a place a project file lists in `servePlaceIds` (or `placeId`), and a place you
  assign in the panel's Studio places. Every other place is connected by hand each time.
- `"remembered"`: those, and also a place that synced with a project before, to that project.

See [Connecting Studio](/guide/connecting-studio).

## `rojoHub.agents`

- **Default:** `{ "vscode": true, "claudeCode": false, "codex": false }`

Which AI agents can use Rojo-Hub's MCP server. Shown as checkboxes here, and as switches in the
panel's *Agent access* section.

| Key | Agent |
|---|---|
| `vscode` | VS Code's own agents (Copilot and others). Registered with VS Code; nothing is written to disk. |
| `claudeCode` | Claude Code: adds `rojohub` to its user config (`claude mcp add --scope user`). |
| `codex` | Codex: adds `rojohub` to `~/.codex/config.toml` (`codex mcp add`). |

This setting is **not synced by Settings Sync**: it describes this machine's agent configs, so a
choice made on another machine never adds or removes entries here. See [Agents](/guide/agents).

## `rojoHub.notifyOnStudioDisconnect`

- **Default:** `false`

Show a message when Studio disconnects from a serving project: *Rojo-Hub: Studio disconnected from
‹project› (:‹port›). Rojo is still serving.* It appears in the window that has the project open, or
else in the focused window.

## Where settings are saved

- The port settings are written for you when you press *Save* or *Reset* in the panel's
  [Port settings](/guide/ports#port-settings-in-the-panel).
- They are marked as applying to every VS Code profile, so VS Code keeps them in the main user
  `settings.json` (`%APPDATA%\Code\User\settings.json`) and every profile shares them.
- *Reset* removes `rojoHub.portRange` from that file, so the default applies again.
- The service keeps a copy of the last values in `%LOCALAPPDATA%\RojoHub\settings.json`, so it can
  start projects with no window open.

Changes apply within a few seconds.
