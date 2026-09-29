# Upstream

This folder is Rojo's Studio plugin, changed so that Rojo-Hub can connect it by itself (spec 007).

- Source: https://github.com/rojo-rbx/rojo, tag `v7.7.0` (commit
  `bcadc97de27ab3800e915abcb72c6c7a3c30f363`), folder `plugin/`.
- Licence: MPL-2.0 (`LICENSE`, Rojo's `LICENSE.txt`). Every file taken from Rojo stays under it,
  changed or not. Files Rojo-Hub adds are MIT, like the rest of this repository, and say so at the
  top.
- `Packages/` holds the plugin's dependencies, which upstream keeps as git submodules, copied at the
  commits upstream pins, each with its own licence. Only the folder each package's
  `default.project.json` builds is kept. TestEZ is left out: upstream uses it only in dev builds.
- `rbx_dom_lua/LICENSE.txt` is rbx-dom's licence (MIT), added here: upstream copies rbx_dom_lua from
  rbx-dom without it.
- Every package and its licence is credited in the repository's `THIRD-PARTY-NOTICES.md`.
- `default.project.json` is upstream's `plugin.project.json` with paths made relative to this folder,
  `*.spec.lua` left out of the build, and the Creator Store upload details dropped.

## Changes to upstream files

Kept to a minimum so moving to a new Rojo release is a merge. Everything Rojo-Hub adds lives in
`src/RojoHub/`. Each change to an upstream file is listed here.

Each hook is marked `-- Rojo-Hub` in the file.

- `src/App/init.lua`
  - requires `Plugin.RojoHub`;
  - in `App:init` (edit mode), starts the Rojo-Hub link instead of calling `tryAutoReconnect` at once,
    and hands `tryAutoReconnect` + `checkSyncReminder` to it as the fallback when the service does
    not answer;
  - `App:setHubMatch` (new) keeps the service's answer in `state.hubMatch`;
  - `App:checkSyncReminder` returns early while the service answers (the saved address may be stale);
  - `App:willUnmount` stops the link;
  - `App:endSession` and the Confirming page's `onAbort` tell the link the user ended or declined
    that session, so it is not reconnected by itself;
  - `pluginName` is `"Rojo-Hub"` rather than `"Rojo " .. version`: Studio refuses a second dock
    widget with the same id, so the two plugins could not both load;
  - the NotConnected page gets `hubEnabled`, `hubMatch` and `onHubConnect` (the *Connect to
    <project>* button);
  - `App:startSession` takes an optional `{ host, port }` to connect to instead of the address boxes,
    and saves the boxes' values (not that address) as the place's last address, so Rojo-Hub never
    writes the boxes;
  - the confirm callback accepts, before Rojo's own rules, a patch for a project this place has
    synced with before (`hub:accepted`, from the service), unless *Confirmation Behavior* is *Always*:
    the first sync of a place with a project is asked once, not per Studio session.
- `src/App/StatusPages/NotConnected.lua`: renders `RojoHub.ConnectButton` (only while the service
  answers *connect*) and `RojoHub.StatusLine` (read-only; projects are assigned to places in VS Code)
  under the buttons.
- `src/App/StatusPages/Settings/init.lua`: a *Rojo-Hub Auto Connect* row (`hubAutoConnect`).
- `src/Settings.lua`: `hubAutoConnect = true`; `checkForUpdates` defaults to `false`, since Rojo's update
  check points at Rojo's own plugin and this one updates with Rojo-Hub.
- `testez.yml` (Rojo's, for selene's `roblox+testez` std) is copied beside `selene.toml`.

## Moving to a new Rojo release

1. Check out the new tag of rojo-rbx/rojo with its submodules.
2. Diff its `plugin/` against the tag above, and apply that diff here (`src`, `log`, `http`, `fmt`,
   `rbx_dom_lua`, `Version.txt`, and each package at its new submodule commit).
3. Re-apply the changes listed above where the diff touched them.
4. Update the tag and commit here, and the versions in `tools/notices.mjs` (then run it), and check `protocolVersion` in `src/Config.lua`: a new protocol
   means the service must refuse projects pinning older rojo (spec 007).
