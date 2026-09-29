---
layout: home

hero:
  name: Rojo-Hub
  text: Every Rojo project, always serving.
  tagline: A VS Code extension that serves many Rojo projects at once, each on its own fixed port, and switches any of them to another branch without Studio disconnecting.
  image:
    src: /logo.png
    alt: Rojo-Hub
  actions:
    - theme: brand
      text: Get started
      link: /guide/requirements
    - theme: alt
      text: How switching works
      link: /guide/switching
    - theme: alt
      text: GitHub
      link: https://github.com/greenviper126/RojoHub

features:
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/></svg>'
    title: One port per project
    details: Worked out from the repo's first commit, so it is the same on every machine.
    link: /guide/ports
    linkText: How ports are picked
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8.5"/></svg>'
    title: Studio connects by itself
    details: Rojo-Hub's Studio plugin syncs each place with its project from servePlaceIds, or as you assign it in VS Code, and reconnects after any Rojo restart.
    link: /guide/connecting-studio
    linkText: Connecting Studio
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>'
    title: Live branch switching
    details: Pick a worktree or any branch. The same Rojo session keeps running and Studio gets the difference as one update.
    link: /guide/switching
    linkText: Switching branches
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></svg>'
    title: Groups
    details: Start, stop or swap a whole set of projects at once, like a profile. Groups can hold other groups.
    link: /guide/groups
    linkText: Using groups
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1M15 13v1M9 17h6"/><circle cx="12" cy="3.5" r="1"/></svg>'
    title: Built for agents
    details: Claude Code, Codex and VS Code agents can serve their own worktree to Studio through an MCP server, taking turns when several share one repo.
    link: /guide/agents
    linkText: Agent access
---

## What it looks like

Rojo-Hub lives in its own panel in the VS Code sidebar. Every project is a card with its port, what
it serves and a Start/Stop button. Click what a project serves to switch it to any worktree or
branch, while Studio stays connected.

![A project card with the branch picker open](/images/panel-branch-picker.png){.panel-shot}

See [the whole panel](/guide/panel).

## Why

If you work on more than one Rojo project, or more than one branch of one project, plain
`rojo serve` gets in the way: every project wants port 34872, switching branches means restarting
Rojo, and restarting Rojo disconnects Studio. Rojo-Hub fixes all three:

- **Many projects at once.** Each gets its own port that never changes, so each Studio place
  reconnects to the right one by itself.
- **Switch without disconnecting.** Rojo keeps running through a switch; Studio just receives the
  changed files.
- **Keeps serving when windows close.** A small background service owns the Rojo processes, so
  closing or reloading VS Code does not stop anything.

::: tip Ready?
Check the [requirements](/guide/requirements), then [install](/guide/install) and
[add your first project](/guide/first-project). It takes a few minutes.
:::
