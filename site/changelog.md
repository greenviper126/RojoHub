# Changelog

Downloads are on [GitHub Releases](https://github.com/greenviper126/RojoHub/releases).

## 0.19.0

**Studio connects by itself.** Rojo-Hub now installs its own Studio plugin: Rojo 7.7's plugin,
changed to sync each place with its project without a port typed or a button pressed.
- A place finds its project from the project files: `servePlaceIds`, then `placeId`, then the project
  it last synced with. One project can serve several places at once.
- It connects when the place opens, when its project is started later, and again after Rojo
  restarts (a crash, a port move, a project file change), with no click.
- When it cannot tell (an unsaved place, no match, two projects claiming the place), the Rojo window
  says why and offers every serving project to pick; a pick between two is remembered per place.
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
