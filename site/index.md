---
layout: home

hero:
  name: Rojo-Hub
  text: Every Rojo project, always serving.
  tagline: Serve many Rojo projects at once, each on a fixed port, and switch any of them to another branch without Studio disconnecting. Built for agents.
  image:
    src: /logo.png
    alt: Rojo-Hub
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Agents
      link: /guide/agents
    - theme: alt
      text: GitHub
      link: https://github.com/greenviper126/RojoHub

features:
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/></svg>'
    title: One port per project
    details: The same on every machine, from servePort or the repo's first commit.
    link: /guide/projects#ports
    linkText: Ports
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8.5"/></svg>'
    title: Studio connects by itself
    details: Each place syncs with its project and reconnects after any Rojo restart. No port to type.
    link: /guide/connecting-studio
    linkText: Connecting Studio
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>'
    title: Live branch switching
    details: Pick a worktree or branch. Rojo keeps running and Studio gets the difference.
    link: /guide/switching
    linkText: Switching branches
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></svg>'
    title: Groups
    details: Start or stop a set of projects together, like a profile.
    link: /guide/groups
    linkText: Groups
  - icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13v1M15 13v1M9 17h6"/><circle cx="12" cy="3.5" r="1"/></svg>'
    title: Built for agents
    details: Claude Code, Codex and VS Code agents serve their own worktree to Studio through an MCP server, taking turns when several share a repo.
    link: /guide/agents
    linkText: Agents
---

![The Rojo-Hub panel](/images/panel-overview.png){.panel-shot}

## Why

Plain `rojo serve` gets in the way with more than one project or branch: every project wants port
34872, switching branches means restarting Rojo, and restarting Rojo disconnects Studio. Rojo-Hub
gives each project its own port, switches without restarting, and keeps serving when VS Code closes.

Set it up once, then let your agents drive it. [Get started](/guide/getting-started).
