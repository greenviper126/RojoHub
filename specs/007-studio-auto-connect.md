# 007 — Studio auto-connect

Status: **implemented in 0.19.1** (0.19.0 was only a local build) (branch `feat/studio-auto-connect`; see *Checked in Studio* for what was tried live). Asked for by Viper: "i want to be able to auto connect from both sides", "make a
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

### Decided in VS Code, never in Studio

Asked for by Viper after the first live test: "everything should be decided from vscode not roblox",
and "it would be ideal that we only change what we need to so bumping up to newer rojo versions is
fairly easy". So the plugin has no choices of its own: a read-only line under the Rojo window's
buttons shows the service's answer, and the panel's **Studio places** section lists every open place
with a list to assign it a project (`PUT /studio/places/:key`). An assignment comes first, for any
place: saved places keep it by place ID (`placeChoices`), an unsaved place (ID 0 or a template's,
shared by all of them) only while its window is open. This replaced a *Sync with…* picker in the
plugin, which needed a prop and a callback threaded through Rojo's page; the protocol went to 2.

### Where the connect information comes from

The project file is the source. Nothing Rojo-Hub-specific is added to the repo (no TOML), and no
panel setting is needed for projects that already list their places. For a place, the service looks
for running projects in this order and stops at the first step that finds any:

1. **`servePlaceIds`** in the project file includes the place's `PlaceId`.
2. **`placeId`** in the project file equals the place's `PlaceId`. Rojo applies `placeId`/`gameId`
   with `game:SetPlaceId`/`SetUniverseId` when a sync is accepted (M5), so a project naming a place
   ID means that place.
3. **Remembered**: the project `name` the place last synced with. The service records it from the
   plugin's reports (`placeSynced`); the plugin's own per-place record, as in Rojo's plugin, is the
   fallback (see *Checked in Studio* for why the service keeps its own). The service looks that name
   up, so a remembered place follows its project to a new port.

An assignment made in VS Code comes before all three (see *Decided in VS Code*).

A place in the project's `blockedPlaceIds` never matches, and neither does `PlaceId` 0 or a Roblox
template's ID (upstream's `ignorePlaceIds`; see M6): those are assigned in VS Code, per window. The port always comes from the service
(which already honours `servePort`), never from the plugin's memory.

A place with none of the above is assigned a project once in VS Code, or connected by hand once; step
3 covers it from then on.

### One project, several places

`servePlaceIds` is a list so several places (a lobby, a match place, a test place) can share one
project. Each open Studio window runs its own plugin and makes its own connection, so one rojo serves
all of them the same tree (M1 confirms Rojo 7.7 handles several clients). Places that need different
trees are different projects.

### Overlaps between projects

Branches and worktrees of one repo are one project, so an overlap means two separate projects (two
repos, or two project files in one repo) match the same place.

- Only **running** projects count. If one of the matches is running, it is used.
- A place keeps to the project it last synced with: while that one's rojo restarts, the place waits
  for it and is not handed to another claimant that is the only one serving for those seconds (a bug
  seen live; see *Checked in Studio*).
- If **more than one** running project matches a place that has synced with neither, the plugin does
  not connect; the place's row in VS Code's **Studio places** says to assign one, and the assignment
  is kept per place (`placeChoices`). Removing the project forgets it.
- Not built: a panel warning when two projects list the same place. The Studio places row shows the
  conflict when it matters.

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

Rojo's confirmation before a first sync is kept, but only for places the project does not list: the
plugin's `confirmationBehavior` defaults to *Unlisted PlaceId* instead of upstream's *Initial*, so a
place in `servePlaceIds` syncs with no click (asked for live: "its asking me to accept or abort from
the plugin so that will prob have to change"), and any other place still asks once per project per
Studio session, since connecting writes into the place.

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
- Keeps Rojo's UI. Adds one read-only Rojo-Hub line under the Not Connected page's buttons with the
  service's answer; no choices in Studio.
- Sends its version and a protocol number (`STUDIO_PROTOCOL`, now 2). The service answers a plugin on
  another protocol with *incompatible* ("close and reopen the place"); the panel shows each place's
  plugin version. Across ordinary updates the protocol stays, so older plugins in open places keep
  working until reopened.
- The panel warns when the official Rojo plugin is installed as well; it does not remove it. The
  service looks at the plugins folder again every 5 s, so the warning clears once it is removed (it
  first only looked at start, and kept warning after the user deleted the file), and a deleted
  `RojoHub.rbxm` is put back.

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

- `ws://127.0.0.1:34870/studio`: the service says `welcome`; the plugin says `hello` with its version,
  protocol, `PlaceId`, `GameId` (as strings: JSONEncode may round them), name, whether it is unsaved,
  and its remembered project; the service answers `match` (status, message, the target project) and
  sends it again whenever it changes. The plugin reports `state` (what it is synced to).
- `PUT /studio/places/:key { slotId }`: assign a project to an open place (`key`: a place ID, or
  `studio:<id>` for an unsaved place's window); `null` goes back to automatic.
- The snapshot (`GET /events`) carries `studioPlaces` for the panel's Studio places section, and
  `studioPlugin` (the install); each card's `places` lists the places synced to it.

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
  `%LOCALAPPDATA%\Roblox\Plugins` was not loaded by an open place (30 s), and changing a loaded
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
for. Creator Store installs are kept elsewhere and are not detected (not measured).

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

## Checked in Studio (2026-09-28)

Studio 0.740.19, two published test places ("Rojo-Hub Test1" 108404263554868, "Test2"
89386659316315), a throwaway project listing both in `servePlaceIds`, served by rojo 7.7.0 through
this branch's service on 34870. Checked with the Studio MCP (`execute_luau`, console output) and the
service's `/slots`.

- **Opening the places** with the plugin installed connected each one by itself ("Rojo-Hub:
  connecting to RojoHubStudioTest on port 35272"); `ReplicatedStorage.RojoHubTest.Hello` synced in
  both, and the card listed both places (`connections 2`).
- **Stop, change a file, start** (a new session): both places reconnected by themselves in the second
  the new session came up, with the changed file. Test2 first tried the dying session once ("Couldn't
  connect"), which the plugin now avoids by counting a just-lost session as tried.
- **A crash** (rojo killed by PID): the service restarted it on the same port and both places
  reconnected by themselves in the same second.
- **The service replaced** (0.18.3 build by 0.19.0): the plugins re-linked by themselves; rojo and
  the synced places were not disturbed (same session).
- Found: once synced, a place's `game.Name` is the project's name (Rojo sets the DataModel name), so
  the plugin reports the name from `MarketplaceService:GetProductInfo` instead.

- **Two projects claiming both places** (a second project with the same `servePlaceIds`): with both
  serving and nothing picked, neither place connected. A pick sent over the WebSocket was stored and
  the place connected to the picked project.
- **Bug found and fixed:** a place synced with project A was handed to project B when A restarted,
  because for those seconds B was the only serving claimant (Rojo's first-sync confirmation stopped
  it; with *Never* it would have synced B into the place). Now a place keeps to the project picked
  for it, else the one it syncs with, and waits while that one restarts. Checked again live: A
  restarted, both places waited 5 s and went back to A; B got no connection.
- **Abort** on that confirmation was respected: the plugin did not connect to B's session again.
- The first-sync confirmation got in the way of connecting by itself ("its asking me to accept or
  abort"), so the plugin's *Confirmation Behavior* now defaults to *Unlisted PlaceId*: listed places
  sync without asking, others still ask. Rojo saves each setting's default the first time the plugin
  runs, so a Studio that already ran an earlier build of this plugin keeps *Initial* until changed.

- **Disconnect** in Test1, then *Sync with…* → RojoHubStudioTest2: stayed disconnected until the pick,
  then synced (after Rojo's confirmation, since that Studio had *Initial* saved from an earlier build).
- **A new unsaved Baseplate** (`PlaceId` 0): answered "unsaved"; not connected.
- **Bug found and fixed:** after reopening, Test2 had forgotten it last synced with project 1 and was
  asked to choose. The plugin's per-place record (`priorEndpoints`, as in Rojo's plugin) is one
  settings value shared by every Studio process; each process loads the whole table at start and
  writes it all back, so Test1's save overwrote Test2's entry. The service now records each place's
  last synced project (`placeSynced` in `registry.json`) from the plugin's reports and uses it
  first.

- **The design changed** after this ("everything should be decided from vscode not roblox"): the
  *Sync with…* picker left Studio for the panel's Studio places section. Checked live through the
  service's API (the one the panel calls): Test2, waiting for a pick, was assigned project 1 with
  `PUT /studio/places/89386659316315` and connected.
- **Found:** the places still ran the previous plugin build, whose status line crashed on the new
  answer's shape (no `projects`). The protocol went to 2 so such a plugin is told to reopen the
  place, and a drawing error in the plugin can no longer stop it from connecting.

Not yet checked live: the panel's Studio places section by hand (0.19.0 was installed in the VS Code
profiles for that), the plugin's read-only line after reopening the places, and Team Create.

## Acceptance criteria

- [x] Opening a place whose `PlaceId` is in a running project's `servePlaceIds` connects it with no
      click and no port typed. *(live; no confirmation with Unlisted PlaceId)*
- [x] Starting a project connects every open Studio whose place matches it. *(live)*
- [x] After rojo restarts on a project (crash, port move, project-file change), Studio reconnects by
      itself; the card's notes say places with the plugin reconnect by themselves. *(live: stop and
      start, and a crash; port move by unit and end-to-end tests of the move itself)*
- [x] A remembered place follows its project to a new port. *(the port always comes from the service)*
- [x] Two places listed in one project's `servePlaceIds`, open at once, are both connected to the one
      rojo and both receive changes. *(live with two; three clients measured in M1)*
- [x] Two running projects matching one place: no auto-connect, and the place is assigned in VS Code;
      the assignment is kept and can be set back to Automatic. A place keeps to its own project while
      that one restarts. *(live and unit tests)* Not built: a warning about overlapping places.
- [x] `blockedPlaceIds`, an unsaved place and no match never auto-connect. *(unit tests; unsaved live)*
- [x] No auto-connect during a playtest; a plugin setting turns auto-connect off. *(by the code:
      the link starts only in edit mode; not tried in a playtest)*
- [x] The service installs `RojoHub.rbxm` into Studio's local plugins folder, updates it in place
      (never to an older version), removes other `RojoHub*.rbxm(x)` copies, and uninstall removes it.
      A setting turns this off. *(unit and smoke tests; install live)*
- [x] A plugin on another protocol is told to reopen the place. *(unit test; seen live)*
- [x] `npm test` builds the plugin; the matching, assignment and WebSocket rules have unit tests. The
      Studio side was checked by hand, recorded above.
- [x] `docs/how-it-works.md`, the site (Connecting Studio, Studio places, troubleshooting) and the
      README describe it.

## Non-goals

- Switching branches, or starting and stopping projects, from Studio. The plugin connects; the panel
  and agents decide what is served.
- A Creator Store release of the plugin. Local install only, so plugin and service versions match.
- A per-project place list in the panel. The project file lists places; the panel assigns open places.
- Group-level place overrides.
- Choices in Studio, or changing Rojo's sync behaviour or UI beyond the read-only Rojo-Hub line.

## Open questions

1. ~~A panel place setting?~~ Replaced by assigning open places in VS Code.
2. ~~Auto-connect on by default?~~ Yes.
3. ~~Which Rojo tag?~~ v7.7.0, the newest release.
4. ~~Projects pinning rojo older than 7.7?~~ Decided by Viper: "were just gonna do 7.7.0 and
   after". Only protocol-5 servers are supported. For an older one, the service answers "this
   project pins rojo X; Rojo-Hub's plugin needs 7.7 or newer", and the plugin shows that instead of
   connecting.
