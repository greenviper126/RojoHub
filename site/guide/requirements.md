# Requirements

Rojo-Hub needs a few things on your machine. Nothing else you have installed gets in the way.

| You need | Version | Check with |
|---|---|---|
| Windows | 10 or 11 | |
| [VS Code](https://code.visualstudio.com/) | 1.101 or newer | *Help → About* |
| [Git](https://git-scm.com/downloads) | 2.31 or newer, on your `PATH` | `git --version` |
| Windows PowerShell | built into Windows | |
| [Rokit](https://github.com/rojo-rbx/rokit) | any | `rokit --version` |
| Rojo and its Studio plugin | 7.7 or newer, installed by Rokit | `rojo --version` in the project |

And in each project you serve:

- a **git repo** with a `*.project.json` (normally `default.project.json`) directly in its top folder;
- a toolchain file (`rokit.toml`, `aftman.toml` or `foreman.toml`) that **pins Rojo**, with that
  version **installed by Rokit** (see below).

::: info What you do not need
- **Node.js**: the background service runs on VS Code's own runtime.
- **Orca, Wally, Claude Code, Codex**: all optional (see [below](#optional)).

A `rojo` on your `PATH`, a Rojo installed by Aftman or Foreman, and the Rojo VS Code extension are
all ignored. They are not in the way, but Rojo-Hub does not use them.
:::

::: warning Windows only for now
Live switching depends on a Windows path detail in Rojo. On macOS or Linux the panel says
*Rojo-Hub supports Windows only for now* and starts nothing.
:::

## Set up Rokit and Rojo

::: tip Already using Rokit?
Run `rokit install` in each project and skip to [Install](./install).
:::

**1. Install Rokit.** Download the latest `rokit-…-windows-x86_64.zip` from
[Rokit's releases](https://github.com/rojo-rbx/rokit/releases), unzip it, and run:

```sh
./rokit self-install
```

Restart your terminal so `rokit` is on your `PATH`.

**2. Pin Rojo in your project.** In the project folder:

::: code-group

```sh [New project]
rokit init
rokit add rojo-rbx/rojo
```

```sh [Has rokit.toml / aftman.toml / foreman.toml]
rokit install
```

:::

**3. Install the Studio plugin** that matches that Rojo, from the project folder:

```sh
rojo plugin install
```

### Coming from Aftman or Foreman

Rojo-Hub runs Rojo straight from **Rokit's** tool storage, so a Rojo that Aftman or Foreman
downloaded is not found. You do not have to change your project, though:

- Rokit reads `aftman.toml` and `foreman.toml` as well as its own `rokit.toml`.
- Install Rokit, then run `rokit install` in the project. That downloads exactly the versions those
  files pin, and Rojo-Hub finds them.

Your teammates can keep using Aftman or Foreman with the same files.

## Which Rojo version

Use **Rojo 7.7 or newer** for every project.

::: warning One plugin, one protocol
Studio has one Rojo plugin for every place, and it only connects to a server that speaks the same
protocol. Rojo 7.7 is the first to speak protocol 5, so the 7.7 plugin refuses Rojo 7.0–7.6 with
*"it's using a different protocol version, and is incompatible"*. Rojo-Hub still serves a project
pinned to an older Rojo, with a warning on its card, but keep every project on 7.7 so one plugin
connects to all of them.
:::

### How Rojo-Hub picks the version

It reads the toolchain files the way Rokit does:

1. `rokit.toml`, `aftman.toml` or `foreman.toml` in the project folder,
2. then in each folder above it,
3. then Rokit's global `~/.rokit/rokit.toml`.

The nearest file that pins Rojo wins; within one folder `rokit.toml` comes first. Rojo-Hub then
runs that exact version from `~/.rokit/tool-storage/rojo-rbx/rojo/<version>/rojo.exe`, with no
console, so no terminal window pops up.

If the version is missing or nothing pins Rojo, **Start** says so; see
[Troubleshooting](/troubleshooting#rojo-is-not-installed).

## Optional

| Tool | What it adds |
|---|---|
| Orca | Worktrees listed under Orca's names; *New branch* makes an Orca worktree |
| [Wally](https://wally.run/) | Packages, served natively in each worktree that has run it (see [Packages](./switching#packages-wally)) |
| [luau-lsp](https://github.com/JohnnyMorganz/luau-lsp) | Reads the `sourcemap.json` Rojo-Hub keeps up to date (see [Sourcemaps](./sourcemaps)) |
| Claude Code, Codex, VS Code agents | Agents that serve their own worktree to Studio (see [Agents](./agents)) |

## Remote windows and Restricted Mode

- In a **remote window** (WSL, SSH, Dev Containers) Rojo-Hub runs on the local Windows side, where
  Rokit, Rojo and Studio are.
- It does **not** run in **Restricted Mode**: it runs git and Rojo in your project folders, so the
  workspace has to be trusted.

## One Windows user at a time

The service's port, 34870, is shared by everyone signed in to the PC. If another signed-in Windows
user is running Rojo-Hub, yours cannot start until they sign out. See
[Troubleshooting](/troubleshooting#port-34870-is-used-by-another-windows-user-s-rojo-hub).
