# Troubleshooting

Headings quote Rojo-Hub's messages, so search (`Ctrl+K`) finds them. First look at the project's
card, **Show Rojo log** (⋯ menu), and `%LOCALAPPDATA%\RojoHub\service.log`.

## Installing and starting

### Nothing shows up after installing {#nothing-shows-up}

Reload the window, and check Rojo-Hub is installed in this window's VS Code profile.

### "Rojo-Hub supports Windows only for now" {#windows-only}

It runs on Windows 10 and 11 only.

### "Rojo-Hub could not start" {#rojo-hub-could-not-start}

The background service did not come up; the panel and `service.log` say why. Fix it and press
**Try again**. Your projects are still saved.

### "Port 34870 is used by another Windows user's Rojo-Hub" {#port-34870-is-used-by-another-windows-user-s-rojo-hub}

Another signed-in user runs Rojo-Hub. It works again once they sign out.

### "Rojo-Hub ‹new› is running, but this window has ‹old›" {#window-has-old-version}

Reload the window. If it stays, install the update in this window's profile too.

### "git was not found" / "needs git 2.31 or newer" {#git-was-not-found}

Install or update [Git for Windows](https://git-scm.com/downloads), then restart VS Code.

## Adding a project

### "has no default.project.json or other *.project.json" {#no-project-file}

The repo's top folder needs a `*.project.json`.

### "has no "name"" {#no-name}

Add a `name` to the project file.

### "is already named" {#already-named}

Two repos share a Rojo project `name`. Rename one.

### "is already registered" {#already-registered}

That repo and project file are already added (worktrees count as the repo).

## Starting a project

### "Rojo ‹version› (pinned in ‹file›) is not installed" {#rojo-is-not-installed}

Run `rokit install` in the folder the message names. A Rojo from Aftman or Foreman is not found; Rokit
reads their files. See [Setting up Rokit](/guide/getting-started#requirements).

### "No rokit.toml, aftman.toml or foreman.toml pins Rojo" {#no-pin}

Run `rokit add rojo-rbx/rojo` in the project.

### "Rojo did not come up on port ‹port›" {#did-not-come-up}

The card shows the end of Rojo's log, usually an invalid project file or missing folder.

### "Port ‹port› is held by another program" {#port-held}

Stop that program, or add the port to `rojoHub.excludedPorts`; the project moves.

### "Port ‹port› is held by another Rojo serving "‹name›"" {#port-held-by-rojo}

A Rojo you started yourself is on that port. Stop it.

### "has no ‹file›" when starting or switching {#tree-has-no-project-file}

The branch lacks the project's project file. Switch back or pick another
[project file](/guide/projects#project-file).

### Rojo older than 7.7 warning {#older-rojo}

It serves, but Rojo-Hub's Studio plugin won't connect. Run `rokit add rojo-rbx/rojo@7.7.0` and
`rokit install`.

## Ports

### "Port moved from ‹A› to ‹B›" {#port-moved}

A `servePort` or port setting changed, so the project restarted on its new port. Rojo-Hub's plugin
reconnects by itself.

### "Its own port ‹p› is taken by ‹name›, so it moved to ‹q›" {#port-taken}

A collision; it works on the new port. Set `servePort` to fix a port for good.

### "servePort ‹p› is also set by ‹name›" {#serveport-shared}

Two projects set the same `servePort`. Change one.

### "servePort 34870 is Rojo-Hub's own service port" / "is not a port" {#serveport-service-port}

Pick another `servePort` (1–65535), or remove it.

## Studio

### A place does not sync by itself {#no-auto-reconnect}

Its row in the panel's **Studio places** says why; see
[Studio places](/guide/connecting-studio#studio-places). Not listed at all? Reopen the place so
Studio loads the plugin, and check `rojoHub.studioPlugin` is on.

### Studio disconnected {#studio-disconnected}

The project was stopped, or Rojo restarted and did not come back within a minute (the project card
says why). Branch switches never cause it, and a restart that comes back is not shown as a
disconnect. With Rojo's own plugin instead of Rojo-Hub's, every restart disconnects.

### Studio says the server is "using a different protocol version" {#protocol-version}

The project runs Rojo older than 7.7. See [above](#older-rojo).

### Studio shows two Rojo windows {#two-rojo-windows}

Remove Rojo's own plugin, `RojoManagedPlugin.rbxm`, from `%LOCALAPPDATA%\Roblox\Plugins`.

### Studio asks to accept every sync {#confirm-first-sync}

It asks once per place and project. If it asks every time, set the plugin's *Confirmation Behavior*
back to *Initial*.

### A switch does not appear in Studio {#switch-not-in-studio}

The served tree's project file is probably invalid; the card and Rojo's log show the error. Rojo
keeps serving the previous tree until it is fixed.

## Rojo crashes

### "Rojo crashed at ‹time› and was restarted on the same port" {#rojo-crashed}

Rojo-Hub restarted it; places with Rojo-Hub's plugin carry on without showing a disconnect. The message ends with Rojo's reason.

### Deleting a folder crashes Rojo 7.7 {#deleting-a-folder}

A Rojo bug ([rojo#1305](https://github.com/rojo-rbx/rojo/issues/1305)): removing a folder under a
served tree (Explorer, `git checkout`, rebase) crashes it. Rojo-Hub restarts it. Switch with the
picker instead of checking out in the served folder.

### "‹branch› was checked out in ‹folder› while it was being served" {#checked-out-while-served}

Not an error: Studio now gets that branch.

## Branches and packages

### Warnings about borrowed packages {#borrowed-packages}

The worktree has not run Wally, so packages come from the main checkout. Run Wally there. See
[Packages](/guide/switching#packages-wally).

### Fetch fails {#fetch-fails}

Fetch never prompts for a password. Run `git fetch` once in a terminal to sign in, then retry.

### "is not a valid branch name" / "already exists" {#new-branch-errors}

Pick another name. Existing branches are already in the picker.

## Sourcemaps

### "Not kept: sourcemap.json is not gitignored" {#sourcemap-not-gitignored}

Add `sourcemap.json` to `.gitignore`, or use *Update sourcemap.json* to write it once.

### "rojo sourcemap keeps stopping, so it was left off" {#sourcemap-keeps-stopping}

It crashed five times in a minute. It restarts on the next start or switch.

## Groups

### "would loop" / "There is already a group called ‹name›" {#group-loop}

A group can't contain itself, and names are unique (ignoring case).

## Agents

### "is claimed by an agent working in ‹worktree›" {#claimed}

Another agent's worktree is in Studio. Wait, or tell the agent it may pass `force`. See
[Claims](/guide/agents#claims-several-agents-one-studio).

### "belongs to a repo Rojo-Hub does not serve" {#repo-not-served}

Add the repo in the panel (or let the agent use `add_project`).

### Agent switch shows "Set up by you", "Not installed" or "Can't read config" {#agent-switch}

- *Set up by you*: the agent already has a `rojohub` entry with another URL; remove it to use Rojo-Hub's.
- *Not installed*: `claude` or `codex` is not on `PATH`.
- *Can't read config*: the config could not be parsed just now; Rojo-Hub retries.

### "Reload the window, then tick the box again" {#agent-reload}

Rojo-Hub was just updated. Reload and flip the switch again.
