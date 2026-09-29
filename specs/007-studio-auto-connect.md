# 007 — Studio auto-connect

Status: **implemented in 0.19.0** (branch `feat/studio-auto-connect`; see *Checked in Studio* for what was tried live). Asked for by Viper: "i want to be able to auto connect from both sides", "make a
custom rojo plugin on the roblox side that just pulls the rojo code but we modify it ... we use that
to auto connect and we listen to vscode on what were connecting too", "put that all in a folder
called plugin", "if rojo disconnects we try to run the port again", and "if its possible just
reading the json file to get alot of the port and connect info would be great since all projects are
expected to have this or some form of this". Builds on 001 (ports, sessions) and 005 (project files).

## Problem

Each Studio place is connected to its project by hand the first time: open the Rojo plugin, type
`localhost` and the port (*Copy Port*), connect, turn on Auto Reconnect. The Rojo plugin then
remembers the address and project name per place and reconnects when the place is opened again.

That breaks, and needs a person at Studio, whenever the session changes:

- Rojo is restarted: after a crash (`restartAfterCrash`, `src/service/hub.ts`), a port move, or a
  project-file change (005). The card says *reconnect Studio*, and someone has to press Connect.
- The project's port changes. The plugin remembers the old port and never finds the new one.
- A project is started while its place is already open. Nothing connects until someone clicks.

The project file already says which places a project belongs to: `servePlaceIds` (and
`placeId`/`gameId`), which Rojo-Hub reads and passes through (`SESSION_FIELDS`,
`src/service/project.ts`). Rojo-Hub knows every project's port. Only Studio does not ask.

## Design

### Where the connect information comes from

The project file is the source. Nothing Rojo-Hub-specific is added to the repo (no TOML), and no
panel setting is needed for projects that already list their places. For a place, the service looks
for running projects in this order and stops at the first step that finds any:

1. **`servePlaceIds`** in the project file includes the place's `PlaceId`.
2. **`placeId`** in the project file equals the place's `PlaceId`. Rojo applies `placeId`/`gameId`
   with `game:SetPlaceId`/`SetUniverseId` when a sync is accepted (M5), so a project naming a place
   ID means that place.
3. **Remembered**: the plugin saved, for this place, the project `name` it last connected to (as the
   Rojo plugin already does). The service looks that name up, so a remembered place follows its
   project to a new port.

A place in the project's `blockedPlaceIds` never matches, and neither does `PlaceId` 0 or a Roblox
template's ID (upstream's `ignorePlaceIds`; see M6): those need the picker every time. The port always comes from the service
(which already honours `servePort`), never from the plugin's memory.

A project with none of the above still works: connect once from the plugin's picker, and step 3
covers it from then on.

### One project, several places

`servePlaceIds` is a list so several places (a lobby, a match place, a test place) can share one
project. Each open Studio window runs its own plugin and makes its own connection, so one rojo serves
all of them the same tree (M1 confirms Rojo 7.7 handles several clients). Places that need different
trees are different projects.

### Overlaps between projects

Branches and worktrees of one repo are one project, so an overlap means two separate projects (two
repos, or two project files in one repo) match the same place.

- Only **running** projects count. If one of the matches is running, it is used.
- If **more than one** running project matches, the plugin does not connect. It shows a picker with
  them; the choice is saved per place in the service's registry and used from then on while that
  project is running. The panel can clear it.
- The panel warns when a project's places overlap another project's, when adding it or when its
  project file changes.

### Both directions

The plugin keeps a WebSocket open to the service (`ws://127.0.0.1:34870/studio`), the same
`HttpService:CreateWebStreamClient` Rojo 7.7's own plugin uses for its server (M4). The service
pushes to it whenever anything that matters to that place changes, and knows the moment a Studio
closes, so the panel can show which places are connected. (Earlier drafts planned a long-poll; Rojo
7.7 moved from long-polling to WebSockets, so the same mechanism is known to work from a plugin.)

- **Studio opens a place** → the plugin asks which project serves it and connects if one matches.
- **A project starts** (from the panel, a window, or on service start) → every open Studio whose place
  matches connects.
- **Rojo restarts on a project** (crash, port move, project-file change) → the plugin sees the session
  end, waits for the service to report the project serving again, and reconnects to its port.
- **A project stops** → the plugin shows it as stopped and waits; it reconnects when it starts again.
- **A switch** keeps the session (001), so the plugin does nothing; the plugin shows the new branch.

Auto-connect runs only in edit mode, never inside a playtest (upstream has its own playtest
setting, kept as it is). It can be turned off in the plugin's settings.

Auto-connect does not skip Rojo's confirmation. Upstream asks before the first non-empty patch per
project per Studio session (`confirmationBehavior`, default *Initial*), and remembers the project for
the rest of the session, so a reconnect after a rojo restart applies without asking but the first
connect of the day still shows the diff. That is kept: connecting writes into the place.

### The plugin

- Lives in this repo in `plugin/`, written in Luau: Rojo's Studio plugin vendored from one Rojo tag,
  with our code in `plugin/src/RojoHub/` and as few hooks into upstream files as possible, listed in
  `plugin/UPSTREAM.md` so moving to a new Rojo release is a merge.
- Licence: the vendored files stay MPL-2.0 with their notices (`plugin/LICENSE`); our new files may be
  MIT. The rest of the repo stays MIT.
- Built with the pinned rojo (`rojo build plugin/default.project.json`), checked by `npm test`, and
  shipped inside the `.vsix`. Installed only locally, never through the Creator Store (see
  *Installing the plugin*).
- Must be able to run next to the official plugin: upstream names its dock widget and toolbar
  `"Rojo " .. version`, and Studio refuses a second widget with the same id, so ours is named
  `Rojo-Hub`. Settings are per plugin, so ours has its own saved places (`priorEndpoints`) and
  settings; the Team Create sync lock (`ServerStorage.__Rojo_SessionLock`) stays shared, so the two
  never sync one place at once.
- Keeps Rojo's UI. Adds a Rojo-Hub line (project, branch, port, or "no project for this place") and
  the picker.
- Sends its version; the plugin, extension and service share one version. On a mismatch the plugin
  says which to update and falls back to manual connect.
- The panel warns when the official Rojo plugin is installed as well; it does not remove it.

### Installing the plugin

Asked for: "lets just go with injecting local plugin from extenstion. will we also remove older
versions or duplicates of our plugin".

- **The service installs it, not each window.** The running service is always the newest one any
  window has (`ensureService`, `src/extension/client.ts`), so when the service writes its own plugin,
  the plugin always matches the service. It is never downgraded, and two VS Code profiles on different
  versions cannot take turns overwriting it.
- **One file with a fixed name**, `%LOCALAPPDATA%\Roblox\Plugins\RojoHub.rbxm`. An update overwrites
  it: written to a temporary file in the same folder, then renamed over the old one, so Studio never
  loads a half-written plugin. Studio does not reload a plugin whose file changed (M3): each place
  picks up the new version when it is next opened, and the panel lists open places still on an
  older one.
- **Written only when it differs.** The service keeps the installed version and hash in its state
  folder and compares with the file on disk, so a hand-edited or deleted file is put back and an
  unchanged one is not touched.
- **Other copies of ours are removed.** Files in the plugins folder named `RojoHub*.rbxm` or
  `RojoHub*.rbxmx` other than the managed one (a copy downloaded from a GitHub release, an older
  name) are deleted, and the panel says which were removed. Nothing else in the folder is touched.
- **The official Rojo plugin stays.** The panel warns while it is installed too (two plugins
  connecting to the same port is confusing); removing it is the user's choice.
- **Uninstall** removes `RojoHub.rbxm` along with the rest of Rojo-Hub's files.
- A setting turns the install off, for anyone who manages the plugin themselves; then nothing in the
  plugins folder is written or removed.

### Service API

- `ws://127.0.0.1:34870/studio`: the plugin says hello with its version, `PlaceId`, `GameId` and
  remembered project name; the service answers with the matching running projects (name, port,
  branch, why each matched, or why there are none) and sends that again whenever it changes.
- `PUT /studio/choices/:placeId { project }`, `DELETE ...` → the overlap choice.
- The card shows the places connected to it (from the open sockets), next to the existing count
  from Rojo's log.

## Measurements

Done on 2026-09-28 against Studio 0.740.19 and rojo 7.7.0, before building. The probe scripts
(`ws-probe.mjs`, a WebSocket server with no dependencies; `m1-clients.mjs`; a throwaway plugin
`ZzReloadProbe.rbxmx`) were run from a scratch folder and removed afterwards. Only two new places
made for the purpose ("Rojo-Hub Test1" and "Test2") had anything loaded into them.

- **M1 Several places on one rojo: works.** Three clients speaking the plugin's protocol 5 (`GET
  /api/rojo`, `GET /api/read/<root>`, WebSocket `/api/socket/<cursor>`) against one `rojo serve`:
  all three got the same session ID and every file change. After one closed its socket, the next
  change still reached the other two. Measured with Node clients, not three Studio windows, but the
  plugin does nothing per client beyond this protocol.
- **M2 A plugin's WebSocket to 127.0.0.1: works, with HttpEnabled off.** A real local plugin in both
  test places (HttpEnabled false, the default for a new place) opened
  `HttpService:CreateWebStreamClient(WebSocket, { Url = "ws://127.0.0.1:34999/plugin" })`, sent, and
  received the server's pushes every 30 s for 7.5 minutes, until the server was stopped. Stopping the
  server raised `Error` (`400 Failed ws recv ... forcibly closed`), then `Closed`, so the plugin
  sees the service go away at once. One socket opened from `execute_luau` rather than a plugin was cut
  after exactly 300 s (`ECONNABORTED`); the plugin sockets outlived that, so it is put down to how
  `execute_luau` runs, but the plugin reconnects on any close anyway and the service sends a message
  at least every 30 s. Hours of idle were not measured.
- **M3 Plugin updates wait for the next place: Studio does not reload local plugins.** A new file in
  `%LOCALAPPDATA%RobloxPlugins` was not loaded by an open place (30 s), and changing a loaded
  plugin's file did not reload it (15 s), whether the file was replaced by a rename or rewritten in
  place. Every place opened afterwards loaded it. So an install or update reaches each place when it is
  next opened; the plugin reports its version, and the panel says which open places still run an
  older one.
- **M6 Unsaved places.** Rojo's `ignorePlaceIds` lists 0 (a local file) and the IDs of Roblox's 18
  templates (Baseplate 95206881, Classic Baseplate 6560363541, ...), which an unsaved place made from a
  template may report. In this Studio, two plugin loads before the test places were published reported
  `PlaceId` 0. All of these are treated alike: never matched, never remembered.

Found while measuring: `rojo plugin install` had put the official plugin in the plugins folder as
`RojoManagedPlugin.rbxm`. That is the file the panel's "official plugin also installed" warning looks
for, along with Creator Store installs (M8, to find where Studio keeps those).

Answered from Rojo 7.7.0's source (2026-09-28, `plugin/` at tag `v7.7.0`):

- **M4** Hooks. Everything goes through `App` (`plugin/src/App/init.lua`): `getHostAndPort` and the
  `host`/`port` bindings decide where `startSession` connects; `tryAutoReconnect` runs once, at
  `App:init` in edit mode, and only when *Auto Reconnect* is on and the saved project name matches;
  `onStatusChanged(Disconnected)` is where a lost session ends, and nothing reconnects after it.
  `priorEndpoints` (plugin setting, per `PlaceId`, 150 days) holds host, port and project name;
  `ignorePlaceIds` lists IDs never saved (0 and Roblox's templates). So our hooks are: set host and
  port from the service before `startSession`, start a session when the service says so, and on
  *Disconnected* hand back to the service instead of stopping. Upstream's `tryAutoReconnect` and
  sync reminder stay, but are skipped while the service is reachable.
- **M5** `placeId`/`gameId` (since 7.0.0-alpha.4) are applied as `game:SetPlaceId`/`SetUniverseId`,
  after the initial sync is accepted (fixed in 7.6.0). Matching on `placeId` is kept.
- **M7** Rojo 7.7.0 speaks protocol **5** over WebSockets; every 7.x before it (7.3.0 to 7.6.1
  checked) speaks protocol **4** over long-polling. The plugin refuses a server of another protocol
  (`rejectWrongProtocolVersion`). A plugin vendored from 7.7.0 therefore cannot sync a project that
  pins an older rojo. Of the five registered projects on 2026-09-28, two pin 7.7.0, one pins 7.3.0
  (VluxySF, `aftman.toml`) and two pin none. See open question 4.

## Acceptance criteria

- [ ] Opening a place whose `PlaceId` is in a running project's `servePlaceIds` connects it with no
      click and no port typed.
- [ ] Starting a project connects every open Studio whose place matches it.
- [ ] After rojo restarts on a project (crash, port move, project-file change), Studio reconnects by
      itself; the card's *reconnect Studio* notes change to say it reconnected.
- [ ] A remembered place follows its project to a new port.
- [ ] Three places listed in one project's `servePlaceIds`, open at once, are all connected to the one
      rojo and all receive changes.
- [ ] Two running projects matching one place: no auto-connect, a picker, the choice remembered and
      clearable in the panel. The panel warns about overlapping places.
- [ ] `blockedPlaceIds`, a `PlaceId` of 0 and no match never auto-connect.
- [ ] No auto-connect during a playtest; a plugin setting turns auto-connect off.
- [ ] The service installs `RojoHub.rbxm` into Studio's local plugins folder, updates it in place
      (never to an older version), removes other `RojoHub*.rbxm(x)` copies, and uninstall removes it.
      A setting turns this off.
- [ ] A version mismatch between the plugin and the service is reported in Studio and falls back to
      manual connect.
- [ ] `npm test` builds the plugin; the service's lookup, wait, overlap and choice rules have unit and
      end-to-end tests. The Studio side is checked by hand, and what was checked is recorded here.
- [ ] `docs/how-it-works.md` and the site's *Connecting Studio* page describe it.

## Non-goals

- Switching branches, or starting and stopping projects, from Studio. The plugin connects; the panel
  and agents decide what is served.
- A Creator Store release of the plugin. Local install only, so plugin and service versions match.
- A per-project place setting in the panel. The project file and the remembered name cover it; revisit
  if a real project needs it.
- Group-level place overrides.
- Changing Rojo's sync behaviour or UI beyond the Rojo-Hub line and the picker.

## Open questions

1. Is dropping the panel place setting right (the project file plus "connect once and it's
   remembered")? Default: yes.
2. Should auto-connect be on by default for a new install? Default: yes, exact matches only.
3. Which Rojo tag to vendor? Default: v7.7.0, the newest release.
4. ~~Projects pinning rojo older than 7.7?~~ Decided by Viper: "were just gonna do 7.7.0 and
   after". Only protocol-5 servers are supported. For an older one, the service answers "this
   project pins rojo X; Rojo-Hub's plugin needs 7.7 or newer", and the plugin shows that instead of
   connecting.
