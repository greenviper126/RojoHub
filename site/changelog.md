# Changelog

Downloads are on [GitHub Releases](https://github.com/greenviper126/RojoHub/releases).

## 0.22.11

- **New: `ensure` brings everything to the current version.** After an update, tell agents to run
  `ensure` and nothing else. A new `versions` step reopens this project's Studio places that still run
  an older plugin (with `rojoHub.closePlaces` on, never a place whose project another agent claimed,
  and Studio still asks about unsaved changes), waits for them to come back, and then says plainly
  what only you can do: reload a VS Code window when a newer Rojo-Hub is installed than the one
  running, or run `/mcp` to reconnect the chat. With `closePlaces` off it only lists the places. Other
  projects' places are listed and left alone. It never makes `ensure` fail.

## 0.22.10

- **Fixed: accepting the Move question in the agent's chat declined it.** The question's one
  checkbox started unticked and the answer was read from it, so pressing accept without ticking it
  declined. In practice the box could not be ticked. Now the buttons are the answer: accept moves
  the place, decline declines, and the box is ignored. The service log also records what the client
  sent with each answer. Reconnect agent chats (`/mcp`) to get it, since the question is put by the
  chat's own Rojo-Hub connection.

## 0.22.9

- **Fixed: windows never reloaded by themselves after an update** (`rojoHub.reloadOnUpdate`,
  0.22.6 to 0.22.8). They worked out their profile from the extension's storage folder, which VS
  Code shares between all profiles, so a window in a named profile read the default profile's list
  and never saw the update. The profile now comes from VS Code's own record of which profile each
  workspace opens in. This works for updates installed after 0.22.9 is running, so reload once by
  hand to get it.

## 0.22.8

- **Close and Reopen say why Studio did not take the request.** The error used to say only that
  Studio did not take it. It now gives the reason for each Studio process, as Windows reported it:
  its window is not taking input (as while a dialog is open; close the dialog and try again), it
  has no window, it already exited, or asking failed. The service log also lists that process's
  windows.
- A reopen waits only for the Studio that was asked to close, so it no longer runs into its
  5-minute limit because of a Studio that was never asked. A place whose Studio already exited
  counts as closed.
- The plugin's update line now also shows on the Not Connected page. It starts with "Reopen this
  place to update Rojo-Hub", so the Connected page, which cuts the line at its end, keeps the
  instruction.

## 0.22.7

- **Fixed: Rojo's window in Studio did not open with the 0.22.6 plugin.** The plugin's page asked the
  Rojo-Hub part for its "reopen this place to update" line through a method that was never added, so
  drawing the page failed. Syncing went on underneath, but the toolbar button showed nothing. The
  update line works from this plugin on.

## 0.22.6

**Chats opened before an update keep the old Rojo-Hub connection** until they reconnect (`/mcp`, then
reconnect `rojohub`) or start a new chat, so new launcher behaviour (the `request_place` question in
your client, new tools and descriptions) does not reach them. From 0.22.6 on they are told so.

- **A stale connection is announced.** The launcher names its version in `x-rojo-hub-launcher` on every
  call. When it is missing (a launcher before 0.22.6, or a client talking HTTP directly) or older than
  the service, every tool result ends with a note asking you to run `/mcp` and reconnect, or start a
  new chat. `version` reports the chat's own connection (`connection`, `connectionOutdated`),
  separately from the launcher file on disk.
- **Place requests and assignments are in `service.log`.** Requests created, the question put to your
  client, answers (Move or Decline, and where), requests that ended, automatic moves, and every place
  assignment with its source (the panel, Move on a request, `request_place`, an automatic move).
- **A pending handover is shown.** `status` says when a place is assigned to one project but still
  synced with another (`studioPlaces[].assignedTo` in the data), and `request_place` says so after a
  move that has not taken effect yet.
- **The plugin says when it is older than Rojo-Hub.** A plugin loads when a place opens, so an update
  reaches an open place only when it is reopened. A plugin 0.22.6 or newer shows "Rojo-Hub plugin
  0.22.6; 0.22.7 is installed. Reopen this place to update." on both its pages, and the panel's
  Studio places mark such a place **Older plugin: reopen to update**. Older plugins cannot show it
  (the panel, `status` and `version` list their versions). No protocol change.
- **`rojoHub.closePlaces`** (off by default) lets Rojo-Hub close and reopen Studio places: the panel's
  **Close** and **Reopen** (shown only while it is on, even with `rojoHub.openPlaces` off) and the new
  agent tools `close_place` and `reopen_place`, for example to load an updated plugin. Studio is asked
  to close as if you closed its window, so it still asks about unsaved changes; nothing is killed or
  saved. A reopen's open step needs only this setting. Yolo does not turn it on. Agents are refused
  while another agent claims the project (or the one the place is synced with) unless `force`, and
  both are written to `audit.jsonl`.
- **Windows reload themselves after an update.** When a newer Rojo-Hub is installed in a VS Code
  profile, each window of that profile says so and reloads after 10 seconds (**Reload Now** or **Not
  Now** to choose), so the new extension runs and the first window starts the new service. Turn it off
  with `rojoHub.reloadOnUpdate`. It works for updates after 0.22.6 is the version running.
- **`request_place` waits at most 60 seconds** (it was 300): the question comes back at once in a
  client that can ask, and long waits run into clients' tool-call handling.

## 0.22.5

**Open Studio places must be reopened to get the new plugin**: the handoff and the branch line below
are in the plugin, which Studio loads only when a place is opened.

- **Move hands a synced place over.** A place already synced with one project did not move when you
  clicked **Move** (or assigned it in the panel's Studio places, or an agent's `request_place`
  assigned it): the plugin never takes over a live session. Every deliberate assignment now carries
  a one-time handoff, and the plugin disconnects the place from the old project and connects it to
  the new one, once. A place you then connect by hand is left alone. The first sync of a place with
  a project still asks Rojo's confirmation. Older plugins ignore the handoff (no protocol change).
- **`request_place` asks you in the agent's own client.** When the place is held, the question is
  put to you through MCP elicitation (a yes/no form in Claude Code and other clients that support
  it); your answer goes to Rojo-Hub, never through the agent, and is logged as given in chat. A
  client without elicitation is asked in VS Code as before, and whichever answers first wins.
- **`rojoHub.placeMoves`** (`ask` by default, or `auto`). With `auto`, a place an agent asks for
  moves at once, unless another agent has claimed the project holding it; then you are still asked.
  Every automatic move is in `audit.jsonl` (`by`: `placeMoves` or `yolo`). `status` says which.
- **The branch is shown in Studio.** The plugin's Connected page shows the branch (and the worktree's
  name when it differs) under the project name, and follows a live switch.

## 0.22.4

- **The claim hold is a setting.** `rojoHub.claimMinutes` (default 15, no upper limit, fractions
  allowed) sets how long an agent's claim lasts after its last call. **0 means a claim never runs
  out**: it lasts until the agent calls `release`. Answers, the instructions and `status` say so, and
  the card gets a **Release claim** button (`POST /slots/:id/release`) for a claim whose agent is gone.
- **The MCP launcher notices a new service.** Every answer from the service names its version, so an
  agent chat is told to read the tool list again (`notifications/tools/list_changed`) as soon as a
  new service took over, not only when a call failed.
- **Agents are told not to check out in a served folder.** The instructions, the checkout note and
  `serve_here` from the main checkout say to use `new_branch` instead. The checkout note now stays
  when the same folder is served again.
- **"Already open" says what it saw.** When only a Studio process names the place, not its plugin,
  agents are told it may still be loading or closing, to `wait_for_studio`, and to open again once
  that Studio has exited. The service log records the plugin disconnects and these refused opens.

## 0.22.3

- **A `version` tool for agents.** It says which Rojo-Hub service, Studio plugin and MCP launcher are
  running, which Rojo each serving project uses, and which plugin each open Studio place loaded. A
  place whose plugin is older than the service is marked, with the reminder to reopen it. It claims
  nothing and never disturbs anyone.

## 0.22.2

- **Agents can ask for a Studio place another project holds.** The new `request_place` tool asks the
  user in VS Code to move a shared place to the agent's project. The notification has Move and
  Decline, and so does the panel's Studio places section, which now also marks shared places.
- `status`, `serve_here`, `switch` and `ensure` say which project a place is synced with, which other
  projects list it, and any pending request, on both the asking and the holding side.
- A place nobody holds is assigned at once. Under yolo mode, a place held by a project no other agent
  claimed moves at once and is written to the audit log.

## 0.22.1

- Setup commands run only in worktrees of the project's own repo.
- Changing yolo or setup commands through the service API needs the extension's settings token.
- The record of what a running Rojo has read survives a service restart.
- A race between setup and a switch is closed.
- Setup's PATH and cmd.exe checks are tightened.
- Settings an older extension leaves out are kept.

## 0.22.0

- **Agents connect even when the service is down.** Agent entries now point at a stdio launcher that
  starts the service when needed, so an agent's MCP connection no longer fails because Rojo-Hub is
  not running.
- `ensure` gets a project ready for Studio in one call. `status`, `serve_here`, `switch` and `ensure`
  return structured answers next to their text.
- **Setup commands.** A project can run setup commands (for example an install) before a new worktree
  is first served. `ensure` also runs install checks and reports what is missing.
- **Yolo mode** (`rojoHub.yolo`, off by default, dangerous). Lifts the guards that refuse agents' actions,
  such as opening Studio places. The status bar and panel show when it is on.
- **Handoff.** `then_return` on `serve_here`, `switch` and `ensure` hands the project back to the
  previous worktree when the claim is released or runs out.
- `new_branch` fetches its base first and starts from the remote when local is behind.
- Claims last 15 minutes. `release` says when a claim ran out instead of failing silently.
- `serve_here` and `switch` say when Rojo crashed and restarted meanwhile.
- The sourcemap watcher retries every 30 seconds after it gives up, and `status` says so.

## 0.21.0

- **Switching no longer drops Studio's connection.** A switch to a branch whose project file adds a
  node Studio cannot create but already has (such as `StarterCharacterScripts`) now syncs it and
  everything under it. Before, the plugin dropped the whole node, and agents restarted the project
  to get it, which disconnected Studio.
- **Restarts you do not see.** When a project's Rojo restarts (it crashed because a worktree it served
  was deleted, its port moved, or someone stopped and started it), places synced to it stay on
  Connected, with no notifications or sounds, and pick up the new session by themselves. The
  disconnect is shown only if the project does not come back.
- Agents: `serve_here` and `switch` say what a Studio place could not apply, and agents are told not
  to stop and start a project to refresh Studio.
- The Studio plugin is Rojo 7.7.1's. Rojo's plugin is now kept unedited in the repository, with
  Rojo-Hub's changes as small patches applied at build time, so moving to a new Rojo is one command.
  Projects pinned to Rojo 7.7.0 keep working.

## 0.20.2

- Shorter documentation: the README and the documentation site were rewritten to be brief, and the
  site's guide merged into six pages (Get started, Projects, Connecting Studio, Switching branches,
  Groups, Agents). No change in behaviour.

## 0.20.1

- Credits the open-source work Rojo-Hub ships: `THIRD-PARTY-NOTICES.md` (in the extension and
  linked from each release) lists Rojo's Studio plugin (MPL-2.0, with where to get its source), the
  Roact, Flipper, Promise, t, Highlighter, msgpack-luau and rbx-dom code in it, the bundled npm
  packages (smol-toml, jsonc-parser, @msgpack/msgpack) and the codicon font, each with its licence.
  No change in behaviour.

## 0.20.0

- **Open places from VS Code** (off by default; turn on `rojoHub.openPlaces`). Each project card
  lists the places its project file names, with whether each is open in Studio, and **Open**, or
  **Close** and **Reopen**. A place that is already open is never opened a second time. Close asks
  Studio to close, so it still asks about unsaved changes; Reopen waits for Studio to exit, then opens
  the place again, which is how an open place picks up a new plugin.
- Agents get `open_place`, which opens one of a project's places unless it is open. Agents cannot
  close places. `status` lists each project's places and whether they are open.

## 0.19.7

- Studio: a green **Connect to `<project>`** button under Rojo's Connect shows while the place's
  project is serving, and connects to its port whatever is in the address boxes. Rojo-Hub no longer
  types its port into those boxes, so clearing them no longer breaks connecting. Reopen open places
  to get the new plugin.

## 0.19.6

- New setting `rojoHub.studioAutoConnect`: set it to `listed` and a Studio place connects by itself
  only when a project file lists it (`servePlaceIds`, `placeId`) or you assign it in Studio places;
  other places are connected by hand. The default, `remembered`, also reconnects a place to the
  project it last synced with.

## 0.19.5

- Rojo's confirmation is asked **once per place and project**: the first time a place syncs with a
  project, whether its `servePlaceIds` lists the place or not, since that sync can overwrite what was
  in the place. After you accept, that place and project connect without asking, across Studio
  sessions and Rojo restarts. *Always* and *Never* in the plugin's settings still work.
- The panel and agents say when a place is waiting for you to accept.
- Groups: the **Singleton** button (and its menu item and command) is gone. Start / Stop sits at the
  bottom right like a project's, and a folded group has it as a small ▶ / ■ in its header.

## 0.19.4

- A Studio place its project does not list in `servePlaceIds` asks to accept its first sync once per
  project per Studio session, as documented. Before, it asked again on every reconnect that had
  changes to apply (Rojo's *Unlisted PlaceId* ignores what was already accepted).

## 0.19.3

- The panel's **Active ports** section is gone: which projects serve shows on their cards and the
  Projects header, and each card's port copies with a click. **Studio places** took over the one
  thing left: a place that doesn't connect by itself lists the serving projects' ports to connect by
  hand, and with no place open it says how many projects are serving.

## 0.19.2

**Agents control Rojo-Hub.** Rojo-Hub is mainly for several agents working at once, so agents now
have every common panel action over MCP: start and stop projects and groups, add and remove
projects, make, edit and delete groups, list branches, make a branch in a worktree of its own
(through Orca when it manages the repo), list and change project files, read Rojo's log, and wait
for Studio to sync.
- What could pull Studio out from under someone is guarded: stopping or removing a project another
  agent claimed, or that a Studio place is synced to, needs `force`; stopping everything always does.
- `serve_here` and `switch` take `wait`: take the project as soon as another agent's claim ends, in
  order, instead of being refused.
- Answers include Rojo's own errors after a switch, which Studio places show the project (with place
  IDs and why they sync), and warnings.
- Claims survive a service restart.

## 0.19.1

**Studio connects by itself.** Rojo-Hub now installs its own Studio plugin: Rojo 7.7's plugin,
changed to sync each place with its project without a port typed or a button pressed.
- A place finds its project from the project files: `servePlaceIds`, then `placeId`, then the project
  it last synced with. One project can serve several places at once.
- It connects when the place opens, when its project is started later, and again after Rojo
  restarts (a crash, a port move, a project file change), with no click.
- Everything is decided in VS Code: a new **Studio places** section lists each open place, what it
  syncs with, and a list to assign it a project (an unsaved place, one no project lists, or one two
  projects claim). Studio only shows the answer.
- A place keeps to the project it syncs with while that project's Rojo restarts.
- Disconnect and Abort are respected: that session is not reconnected by itself.
- The plugin is kept up to date in Studio's plugins folder and removed on uninstall; the new
  `rojoHub.studioPlugin` setting turns that off. Studio loads an update when a place is next opened.
- Rojo 7.7 or newer only; a project pinning older Rojo says so in the Rojo window.

## 0.18.3

- Listing details reworded for the VS Code Marketplace: a clearer description and keywords
  (`roblox-studio`, `git-worktree`). No change to how Rojo-Hub works.

## 0.18.2 — first public release

The first public release. Rojo-Hub was made ready for other people's machines: every requirement is
stated and checked, it survives what other setups do to it, and the panel feels instant.

**Live panel**

- The panel follows the service as a live stream: changes from other windows, agents, crash
  restarts, Studio connecting or a branch made in a terminal show within a fraction of a second, with
  no Refresh.
- Every click draws its result at once, and the service's answer confirms or corrects it.
- The branch picker, project file list and *Add a project* list open with their contents already
  there.

**Robustness**

- Requirements are checked plainly: Windows only, git 2.31 or newer, the pinned Rojo installed by
  Rokit, with a message saying what to install.
- The service never ends on an unexpected error; it logs it and carries on.
- A slow Rojo is never mistaken for a crashed one (three missed status checks and no process first).
- A half-saved project file no longer moves a port away and back, and a port move waits until the
  new port has held for a moment, so a `servePort` typed with auto-save does not restart Rojo at
  every keystroke.
- A `servePort` of 34870 (Rojo-Hub's own port) is refused with an explanation.
- An agent config that cannot be read for a moment shows *Can't read config* and is left alone.
- After a branch switch the card shows the new branch's name at once.
- Finding Rojo processes works whatever letters the Windows user name has.
- Works when Windows uses 8.3 short names in your profile or project paths (`C:\Users\JOHNSM~1`):
  a live switch reaches Studio, and views and worktrees are recognised.
- A damaged `registry.json` is set aside and the previous save restored.
- Fetch never shows a sign-in window; making a view no longer runs git hooks; your own worktrees
  on an unplugged drive are left alone.
- The service exits after 15 minutes idle, and never uses another Windows user's service.

**Security**

- The service answers only requests addressed to `127.0.0.1` / `localhost` on its own port, and
  refuses every request from a web page, closing DNS-rebinding and browser access.

**Agents**

- Agent entries you remove by hand stay removed, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured,
  and `rojoHub.agents` is not synced between machines.

**Licence**

- Rojo-Hub is released under the MIT License.

## 0.1 – 0.17

Private development.
