# Changelog

Downloads are on [GitHub Releases](https://github.com/greenviper126/RojoHub/releases).

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
