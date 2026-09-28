# Install

Rojo-Hub is distributed as a `.vsix` file on the
[GitHub Releases](https://github.com/greenviper126/RojoHub/releases) page.

::: info Marketplace and Open VSX: coming soon
Rojo-Hub is not on the VS Code Marketplace or Open VSX yet. Until it is, install the `.vsix` from
GitHub Releases as below.
:::

## Install the .vsix

1. Download `rojo-hub-<version>.vsix` from the latest
   [release](https://github.com/greenviper126/RojoHub/releases).
2. Install it:

   ::: code-group

   ```text [In VS Code]
   Extensions view → … (top right) → Install from VSIX… → pick the file
   ```

   ```sh [From a terminal]
   code --install-extension rojo-hub-<version>.vsix --force
   ```

   :::

3. **Reload the window**: `Ctrl+Shift+P` → *Developer: Reload Window*. A window that was open during
   the install does not load Rojo-Hub until it reloads.

The Rojo-Hub icon (a hub: one dot joined to four) appears in the activity bar, and the panel opens
by itself the first time.

### VS Code profiles

Each VS Code profile has its own extension list. The command above installs into the **Default**
profile only; install into every profile you open Roblox projects in:

```sh
code --install-extension rojo-hub-<version>.vsix --force --profile "<profile name>"
```

::: tip Nothing showing up?
Reload the window, and check Rojo-Hub is installed in the profile this window uses.
:::

### Build it yourself

If you prefer, build the `.vsix` from the repository:

```sh
git clone https://github.com/greenviper126/RojoHub.git
cd RojoHub
npm install
npm run package          # produces rojo-hub-<version>.vsix
```

## Update

Install the newer `.vsix` the same way, then reload **every** window that has Rojo-Hub.

Rojo keeps serving through the update, so **Studio stays connected**: the new extension asks the old
background service to exit, starts its own, and the new service adopts the running Rojo processes.

::: details Why every window?
Each VS Code window runs its own copy of the extension. A window only ever replaces the background
service with a *newer* one, never an older one. A window still on the old version keeps using the
newer service and says so once per new version:

*Rojo-Hub ‹new› is running, but this window has ‹old›* — with **Reload Window**.

If reloading does not help, that window's profile still has the old version installed: install the
update in that profile too. The message is not repeated for the same version, so a profile you
deliberately keep on an older version is not nagged.
:::

## Uninstall

1. Uninstall the extension from **every** profile.
2. The next time VS Code starts, Rojo-Hub's uninstall step:
   - removes its Claude Code and Codex entries, if you turned them on (only entries pointing at
     Rojo-Hub);
   - stops the background service and every Rojo it serves (only your own; another Windows user's
     service is left alone).
3. To remove its saved state and views too, delete the folder:

   ```text
   %LOCALAPPDATA%\RojoHub\
   ```

Your projects' own files are never touched. See [Files on disk](/reference/files) for everything
Rojo-Hub writes.
