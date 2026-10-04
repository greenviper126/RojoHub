# Projects

A project is a git repo plus one `*.project.json` in its top folder. It is named by that file's
`name`, which must be unique (places remember their project by name).

![A project card with its branch picker open](/images/panel-branch-picker.png){.panel-shot}

## Add

Press **+** on *Projects* and pick a folder open in this window, a repo Orca knows, or *Browse…*.

- Any folder in the repo works; Rojo-Hub registers the repo's main checkout.
- It serves `default.project.json`, else the only `*.project.json`, else asks.
- One repo can be added more than once with different project files, if their `name`s differ.

## Start and stop

**Start** runs `rojo serve` with the Rojo the project pins, straight from Rokit (no console window).
If Rojo is not up within 30 seconds, the card shows the end of its log. **Stop** stops only that
project. Use [groups](./groups) or **Stop all** for many at once.

Projects keep serving when VS Code closes; see [the background service](/reference/service).

## Project file

Click the project file row on the card to serve another `*.project.json` from the same folder
(`test.project.json` for a library's tests, say). Only while the project is stopped.

- The project takes the new file's `name`.
- Everything follows the file: what Rojo serves on every branch, `sourcemap.json`, builds.
- A branch without that file shows an error until you switch back or pick another file.

## Ports

A project's port, in order:

1. **`servePort`** in the project file, if set. It wins over every setting.
2. Otherwise a hash of the repo's **first commit**, in `rojoHub.portRange` (default `34873-35872`).
   Same on every machine; renaming changes nothing.
3. If that port is taken or excluded, the next free one. The card says so.

34870 (Rojo-Hub's service) and 34872 (Rojo's default) are never hashed to. A `servePort` of 34870, or
one another project already sets, is refused.

**When a port changes** (a `servePort` edit, a settings change, a project removed), a serving project
restarts on the new port. Places with Rojo-Hub's plugin carry on by themselves, without showing a disconnect.

**Excluding ports**: add them to `rojoHub.excludedPorts`, or use the panel's *Port settings*. If
another program holds a project's port, Start says so; exclude that port and the project moves.

::: tip Pin a port
Commit a `servePort` in the project file: `"servePort": 35100`.
:::

## Build a place file

**Build place file…** (⋯ menu) runs `rojo build` on exactly what the project serves and saves a
`.rbxl` where you choose.

## Remove

**Remove from Rojo-Hub…** (⋯ menu) stops the project, deletes its generated files and removes it
from groups. Your files are never touched.
