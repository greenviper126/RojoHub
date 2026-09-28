# Requirements

Rojo-Hub needs four things on your machine. Nothing else you have installed matters: other
toolchain managers, a `rojo` on your `PATH` or the Rojo VS Code extension are ignored, not in the way.

| You need | Version | Check with |
|---|---|---|
| Windows | 10 or 11 | |
| [VS Code](https://code.visualstudio.com/) | 1.101 or newer | *Help → About* |
| [Git](https://git-scm.com/downloads) | 2.31 or newer, on your `PATH` | `git --version` |
| [Rokit](https://github.com/rojo-rbx/rokit) | any | `rokit --version` |

And in each project you serve:

- a **git repo** with a `*.project.json` (normally `default.project.json`) directly in it;
- a toolchain file that **pins Rojo**, and that Rojo version **installed by Rokit** (below).

::: info You do not need Node.js
The background service runs on VS Code's own runtime.
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

Rokit reads `aftman.toml` and `foreman.toml` as well as its own `rokit.toml`, so a project that
still uses Aftman needs no changes, just `rokit install`.

**3. Install the Studio plugin** that matches that Rojo:

```sh
rojo plugin install
```

## Which Rojo version

Use **Rojo 7.7 or newer** for every project.

::: warning One plugin, one protocol
Studio has one Rojo plugin for every place, and it only connects to a server that speaks the same
protocol. Rojo 7.7 is the first to speak protocol 5, so the 7.7 plugin refuses Rojo 7.0–7.6.
Rojo-Hub still serves an older pin, with a warning on the project's card.
:::

Rojo-Hub picks the version the way Rokit does: `rokit.toml`, `aftman.toml` or `foreman.toml` in the
project folder, then in each folder above it, then Rokit's global `~/.rokit/rokit.toml`. The nearest
one that pins Rojo wins.

## Optional

| Tool | What it adds |
|---|---|
| [Orca](https://github.com/) | Worktrees listed under Orca's names; new branches made as Orca worktrees |
| [Wally](https://wally.run/) | Packages, served natively in each worktree that has run it |
| Claude Code, Codex | Agents that serve their own worktree to Studio |
