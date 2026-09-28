# Install

::: code-group

```text [Marketplace (planned)]
Extensions view → search "Rojo-Hub" → Install
```

```sh [From a .vsix]
code --install-extension rojo-hub-<version>.vsix --force
```

:::

The `.vsix` is attached to each [GitHub release](https://github.com/greenviper126/RojoHub/releases).
You can also use *Extensions view → `…` → Install from VSIX…*.

Then **reload the window**: `Ctrl+Shift+P` → *Developer: Reload Window*.

## VS Code profiles

Each VS Code profile has its own extension list. Install into every profile you open Roblox
projects in:

```sh
code --install-extension rojo-hub-<version>.vsix --force --profile "Roblox"
```

## Update

Install the newer version the same way and reload **every** window that has Rojo-Hub. Rojo keeps
serving through the update, so Studio stays connected.

::: details Why every window?
Each window runs its own copy of the extension. A window only ever replaces the background service
with a newer one, so a window still on the old version keeps using the new service and asks once to
be reloaded.
:::

## Uninstall

1. Press **Stop all** in the panel.
2. Uninstall the extension. Its Claude Code and Codex entries, if you turned them on, are removed the
   next time VS Code starts.
3. End the background service (or sign out):

   ```sh
   curl -X POST http://127.0.0.1:34870/shutdown
   ```

4. Delete `%LOCALAPPDATA%\RojoHub\` to remove its state.
