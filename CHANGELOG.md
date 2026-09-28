# Changelog

## 0.18.1 — first public release

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
