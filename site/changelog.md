# Changelog

Downloads are on [GitHub Releases](https://github.com/greenviper126/RojoHub/releases).

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
