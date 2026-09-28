# Settings

All are **user settings** that apply to every project, window and profile. A workspace cannot
override them.

## `rojoHub.portRange`

- **Default:** `"34873-35872"`

Ports picked from, as `first-last`. See [Ports](../guide/ports).

## `rojoHub.excludedPorts`

- **Default:** `[]`

Ports never given to any project: numbers (`35000`) or ranges (`"35000-35010"`). 34872 is always
excluded.

## `rojoHub.sourcemaps`

- **Default:** `true`

Keep `sourcemap.json` up to date in each serving project's worktree, for luau-lsp. Written only where
`sourcemap.json` is gitignored or already exists.

## `rojoHub.agents`

- **Default:** `{ "vscode": true, "claudeCode": false, "codex": false }`

Which agents can use Rojo-Hub's MCP server. Shown as checkboxes, and as switches in the panel's
*Agent access* section.

## `rojoHub.notifyOnStudioDisconnect`

- **Default:** `false`

Show a message when Studio disconnects from a serving project.
