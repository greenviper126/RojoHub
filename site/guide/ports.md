# Ports

Each project's port is decided by these rules, in order:

1. **`servePort`** in the project file, when set. It is committed with the repo, so everyone agrees,
   and plain `rojo serve` uses it too.
2. **Otherwise a hash of the repo's first commit**, placed in the port range (default
   `34873-35872`). Every clone has the same first commit, so the port is the same on every machine,
   and renaming the repo or its folder does not change it.
3. **Collisions** move forward to the next free port. The project that moved shows a warning; set
   `servePort` to pin it for good.

Port **34872**, Rojo's default, is never used.

## When a port changes

Adding a `servePort`, excluding a project's port, or removing the project that pushed another off
its own port restarts that project on its new port. That is a new Rojo session:

::: warning Reconnect Studio
The plugin remembers the last port per place. Set it to the new one once; VS Code shows the new
port with a **Copy Port** button.
:::

## Excluding ports

Add ports or ranges to [`rojoHub.excludedPorts`](../reference/settings#rojohub-excludedports), or
use *Port settings* in the panel.

```json
"rojoHub.excludedPorts": [35000, "35100-35110"]
```
