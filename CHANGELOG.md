# Changelog

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

**Requirements** are checked and explained: Windows 10/11, VS Code 1.101+, git 2.31+, and Rojo
installed by Rokit (see the [requirements](https://greenviper126.github.io/RojoHub/guide/requirements)).

**The panel is live and immediate.**
- It follows the background service as a stream, so changes made anywhere (another window, an agent,
  a crash restart, Studio connecting) show within a fraction of a second.
- Every click shows its result at once, and the branch picker, project file list and Add a project
  list open already filled.

**Sturdier.**
- A deleted worktree or any unexpected error no longer stops the background service.
- A slow Rojo is never mistaken for a crashed one and restarted.
- Finding and stopping Rojo no longer holds the service up.
- A half-saved project file no longer moves the port.
- A project in error can be stopped.
- Two adds of one repo register it once.
- A damaged `registry.json` is kept aside and the previous save restored.
- Only Rojo-Hub's own views are pruned from git.
- Fetch never shows a sign-in window.
- A port move waits until the new port has held for a moment, so a `servePort` being typed with
  auto-save does not restart Rojo at every keystroke.
- A `servePort` of 34870 (Rojo-Hub's own port) is refused with an explanation.
- Finding Rojo processes works whatever letters the Windows user name has.
- Works when Windows uses 8.3 short names in your profile or project paths (`C:\Users\JOHNSM~1`):
  a live switch reaches Studio, and views and worktrees are recognised.

**Safer.**
- Only programs on this PC can use the service: web pages, including DNS-rebinding and
  localhost pages, are refused.
- Another signed-in Windows user's service is never used.
- Uninstalling stops the service.
- An idle service exits after 15 minutes.

**Other.**
- Runs on the local machine in remote windows (WSL, SSH, containers).
- Says "Windows only" elsewhere.
- Build place file saves outside the repo by default.
- Agent entries you remove by hand stay removed.
- `CLAUDE_CONFIG_DIR` is honoured.

## 0.1 – 0.17

Private development: fixed ports, live branch switching, groups, sourcemaps, agent access over MCP
and project files. See [docs/how-it-works.md](docs/how-it-works.md).
