# Troubleshooting

Find your message or symptom below; the headings quote what Rojo-Hub says, so the search box
(`Ctrl+K`) finds them. `‹…›` marks a part that differs each time.

::: tip Where to look first
- The project's card shows the error in full, and **Show Rojo log** (⋯ menu) has the rest.
- `%LOCALAPPDATA%\RojoHub\service.log` records service problems, git problems and recovered errors.
:::

## Installing and starting

### Nothing shows up after installing {#nothing-shows-up}

Reload the window (`Ctrl+Shift+P` → *Developer: Reload Window*), and check Rojo-Hub is installed in
the VS Code **profile** this window uses: profiles have separate extension lists. See
[VS Code profiles](/guide/install#vs-code-profiles).

### "Rojo-Hub supports Windows only for now" {#windows-only}

Rojo-Hub runs on Windows 10 and 11 only. Live switching depends on a Windows path detail in Rojo, so
on other systems the panel shows this and starts nothing.

### "Rojo-Hub could not start" {#rojo-hub-could-not-start}

The background service did not come up. The panel says why (for example *The Rojo-Hub service did
not start. See service.log in %LOCALAPPDATA%\RojoHub.*); `%LOCALAPPDATA%\RojoHub\service.log` has
more. Your projects and groups are still saved and shown, marked unavailable. Fix the cause and press
**Try again**.

### "Port 34870 is used by another Windows user's Rojo-Hub" {#port-34870-is-used-by-another-windows-user-s-rojo-hub}

Someone else signed in to this PC is running Rojo-Hub. Only one signed-in user can run it at a time;
Rojo-Hub never uses or stops the other user's service. It works again once they sign out.

### "Rojo-Hub ‹new› is running, but this window has ‹old›" {#window-has-old-version}

The service was updated by another window. Press **Reload Window**. If the message stays, this
window's VS Code profile still has the old version installed: install the update in this profile
too. See [Update](/guide/install#update).

## Git

### "git was not found" {#git-was-not-found}

*git was not found. Install Git for Windows (https://git-scm.com/downloads), make sure `git` is on
PATH, then restart VS Code.*

Install [Git for Windows](https://git-scm.com/downloads), check `git --version` works in a new
terminal, and restart VS Code.

### "Rojo-Hub needs git 2.31 or newer" {#git-too-old}

*Rojo-Hub needs git 2.31 or newer; ‹version› is installed.* Update Git for Windows and restart VS
Code.

## Adding a project

### "has no default.project.json or other *.project.json" {#no-project-file}

The folder you picked (its repo's top folder) has no `*.project.json` directly in it. Rojo-Hub serves
a project file from the repo's top folder, so every branch has it in the same place. Add one, or pick
the right repo.

### "has no "name"" {#no-name}

The project file has no `name` field. Add one; it must be unique among your projects.

### "is already named" {#already-named}

*Another project (‹folder›) is already named "‹name›". Studio auto-connects by name, so names must be
unique.* Two repos have the same Rojo project `name`. Rename one in its project file.

### "is already registered" {#already-registered}

That repo is already added with that project file. Any folder inside a repo, including a worktree,
counts as the repo. Find it in the Projects list (the filter helps).

## Starting a project

### "Rojo ‹version› (pinned in ‹file›) is not installed" {#rojo-is-not-installed}

The project pins a Rojo version Rokit has not downloaded. Run this in the folder the message names:

```sh
rokit install
```

Or pin a Rojo version you have. See [Set up Rokit and Rojo](/guide/requirements#set-up-rokit-and-rojo).

::: info Coming from Aftman or Foreman?
A Rojo installed by Aftman or Foreman is not found. Install Rokit and run `rokit install`: it reads
`aftman.toml` and `foreman.toml` too. See [Coming from Aftman or Foreman](/guide/requirements#coming-from-aftman-or-foreman).
:::

### "No rokit.toml, aftman.toml or foreman.toml pins Rojo" {#no-pin}

Nothing pins Rojo for the project's folder, the folders above it, or `~/.rokit/rokit.toml`. Pin one
in the project:

```sh
rokit add rojo-rbx/rojo
```

### "Rojo did not come up on port ‹port›" {#did-not-come-up}

Rojo did not answer within 30 seconds. The card shows the end of Rojo's log, which usually says why
(an invalid project file, a missing folder). *Show Rojo log* has the full log.

### "Port ‹port› is held by another program" {#port-held}

Something outside Rojo-Hub uses that port. Stop it, or add the port to
[`rojoHub.excludedPorts`](/reference/settings#rojohub-excludedports) and the project moves to the
next free port.

### "Port ‹port› is held by another Rojo serving "‹name›"" {#port-held-by-rojo}

A Rojo you started yourself (not one of Rojo-Hub's) is on that port. Stop it.

### "has no ‹file›" when starting or switching {#tree-has-no-project-file}

The branch or worktree being served does not have the project's project file. Switch back, or pick
another [project file](/guide/projects#project-files) that exists there.

### Rojo 7.x (older than 7.7) warning {#older-rojo}

*Serving with Rojo ‹version› …, which speaks Rojo protocol 4. The Rojo 7.7 Studio plugin only
connects to Rojo 7.7 (protocol 5) and will refuse this server; pin rojo-rbx/rojo@7.7.0 to use it.*

The project still serves, but Rojo-Hub's Studio plugin (Rojo 7.7's) will not connect, its places
show *Rojo too old*, and the Studio-connected light does not work. Pin Rojo 7.7 and install it:

```sh
rokit add rojo-rbx/rojo@7.7.0
rokit install
```

## Studio

### Studio says the server is "using a different protocol version, and is incompatible" {#protocol-version}

The project runs Rojo older than 7.7 and the Studio plugin is 7.7's (Rojo-Hub's is), or the other way
round. Keep every project on Rojo 7.7; see [the warning above](#older-rojo).

### Studio disconnected {#studio-disconnected}

The Rojo session changed. Causes:

- the project was stopped and started;
- its port moved (the card says *Port moved from A to B*);
- Rojo crashed and was restarted (the card says so).

Switching branches never causes it. Places with Rojo-Hub's Studio plugin reconnect by themselves as
soon as the project serves again. With Rojo's own plugin, reconnect in it.

### "Port moved from ‹A› to ‹B›" {#port-moved}

The project's port changed (a `servePort` was added, changed or removed, its port was excluded or
the range changed, or the project that had pushed it off its own port was removed), so it was
restarted on the new one. Places with Rojo-Hub's Studio plugin reconnect by themselves; with Rojo's
own plugin, set its port to the new one in its places, once. See [When a port changes](/guide/ports#when-a-port-changes).

### "Its own port ‹p› is taken by ‹name›, so it moved to ‹q›" {#port-taken}

Two projects' hashed ports collided and this one was added later, or its port is taken by another
project's `servePort` (or excluded). It works fine on the new port; to
fix a port for good, set `servePort` in its project file. See [Ports](/guide/ports).

### "servePort ‹p› is also set by ‹name›" {#serveport-shared}

Two projects set the same `servePort`. The one added first keeps it; the other cannot start. Change
one of them.

### "servePort 34870 is Rojo-Hub's own service port" {#serveport-service-port}

The project file asks for the port Rojo-Hub's own service listens on. Pick another `servePort` in
the project file (or remove it to get a port worked out from the repo). See
[Ports](/guide/ports#how-a-port-is-picked).

### "servePort … is not a port" {#serveport-not-a-port}

The project file's `servePort` is not a whole number from 1 to 65535. Fix it in the project file,
or remove it to get a port worked out from the repo.

### A place does not sync by itself {#no-auto-reconnect}

Look at the place in the panel's **Studio places** section; it says why:

- *Assign a project*: no project lists the place in `servePlaceIds`, it is not saved to Roblox, or
  two serving projects claim it. Pick its project in the list.
- *Waiting*: its project is not serving. Start it.
- *Rojo too old*: its project pins Rojo older than 7.7. Pin `rojo-rbx/rojo@7.7.0`.
- *Reopen the place*: the place runs an older copy of the plugin. Close and reopen it.
- You pressed **Disconnect** (or **Abort** on the first sync) in Studio: that session is left alone.
  Connect by hand, assign the project again, or restart the project.

If the place is not listed at all, Studio has not loaded Rojo-Hub's plugin: it loads a new or updated
plugin only when a place is opened, so reopen the place. Check that `rojoHub.studioPlugin` is on.

### Studio shows two Rojo windows {#two-rojo-windows}

Rojo's own plugin is installed next to Rojo-Hub's (the panel says so). Rojo-Hub's does everything
Rojo's does; remove `RojoManagedPlugin.rbxm` from `%LOCALAPPDATA%\Roblox\Plugins` (or uninstall Rojo
from Studio's plugin manager) to keep one.

### Studio asks to accept or abort the first sync {#confirm-first-sync}

That is Rojo's confirmation, kept because syncing writes into the place. Rojo-Hub's plugin skips it
for places the project lists in `servePlaceIds` (*Confirmation Behavior: Unlisted PlaceId*). A Studio
that ran an early 0.19.0 build may still have Rojo's *Initial* saved: change it in the plugin's
settings.

### A switch does not appear in Studio {#switch-not-in-studio}

Open *Show Rojo log*. If the served tree's project file is invalid, Rojo logs the error and keeps
serving the previous tree; the card shows the error. Fix the file (edits sync live) or switch back.

## Rojo crashes

### "Rojo crashed at ‹time› and was restarted on the same port" {#rojo-crashed}

Rojo exited unexpectedly and Rojo-Hub started it again on the same port. It is a new session: places
with Rojo-Hub's Studio plugin reconnect by themselves; with Rojo's own plugin, reconnect Studio. The message ends with Rojo's own reason; *Show Rojo log* has the full log. If the
restart fails too, the card shows the error; stop the project from its card.

### Deleting a folder crashes Rojo 7.7 {#deleting-a-folder}

A Rojo bug, not Rojo-Hub's ([rojo-rbx/rojo#1305](https://github.com/rojo-rbx/rojo/issues/1305), fix
pending). It happens with plain `rojo serve` too. Anything that removes a folder containing files
under a served tree triggers it:

- deleting it in Explorer;
- a `git checkout` or rebase that removes a folder;
- deleting a worktree the project served earlier in the same session.

Rojo-Hub restarts Rojo on the same port and tells you; places with Rojo-Hub's plugin reconnect by
themselves. **Switching with the picker
instead of checking out in the served folder avoids it.**

### "Checking out ‹branch› in ‹folder› removed a folder Rojo was watching" {#checkout-crash}

The same crash, caused by a checkout inside the served worktree. Rojo-Hub restarted Rojo; places
with Rojo-Hub's plugin reconnect by themselves. Use the [branch picker](/guide/switching) to switch instead.

### "‹branch› was checked out in ‹folder› while it was being served" {#checked-out-while-served}

Not an error: someone checked out another branch inside the served worktree, so Studio now gets that
branch. See [Checking out inside a served folder](/guide/switching#checking-out-inside-a-served-folder).

## Branches and packages

### Warnings about borrowed packages {#borrowed-packages}

*Packages, ServerPackages come from the primary checkout (not present in this tree).*

The served worktree has not run Wally, so its packages are borrowed from the primary checkout. Run
Wally in the worktree to serve its own. The stronger warning, *This branch changed wally.toml …*,
means the borrowed packages do not match the branch. See [Packages](/guide/switching#packages-wally).

### "globIgnorePaths and syncRules do not apply while folders are borrowed" {#borrowed-rules}

In borrowed mode the tree's `globIgnorePaths` and `syncRules` are not used. Give the tree its own
folders (run Wally there) to serve it natively.

### Fetch fails {#fetch-fails}

The picker shows git's message (offline, no access). Fetch never asks for a password; if the remote
needs you to sign in, run `git fetch` once in a terminal, then try again.

### "is not a valid branch name" / "already exists" {#new-branch-errors}

*New branch* checks the name before making anything. Branch names cannot contain spaces, `..`, `~`,
`^`, `:`, `?`, `*`, `[`, or end in `/` or `.lock`. An existing branch is already in the picker
under *Local branches*.

## Sourcemaps

### "Not kept: sourcemap.json is not gitignored" {#sourcemap-not-gitignored}

Rojo-Hub never adds a file to git, so it keeps `sourcemap.json` up to date only where it is
gitignored or already exists. Add `sourcemap.json` to `.gitignore`, or use *Update sourcemap.json*
in the ⋯ menu to write it once. See [Sourcemaps](/guide/sourcemaps).

### "rojo sourcemap keeps stopping, so it was left off" {#sourcemap-keeps-stopping}

The sourcemap watcher crashed five times in a minute (usually folders being deleted). Nothing in
Studio is affected. It starts again the next time the project starts or switches; *Update
sourcemap.json* writes it once meanwhile.

## Groups

### "would loop" {#group-loop}

A group can't contain itself, directly or through other groups. The message names the chain, for
example *Outer → Middle → Inner*. See [Loops](/guide/groups#loops).

### "There is already a group called ‹name›" {#group-name-taken}

Group names are unique, ignoring case. Pick another name.

## Agents

### An agent says a project "is claimed by an agent working in ‹worktree›" {#claimed}

Another agent's worktree is being shown in Studio, for up to 10 minutes after its last call. Wait,
or tell the agent it may pass `force`. Your own switches in the panel always go through. See
[Claims](/guide/agents#claims).

### An agent says a folder "belongs to a repo Rojo-Hub does not serve" {#repo-not-served}

Agents cannot add projects. Add the repo in the panel (Projects, `+`), and start it if it should
serve.

### An agent switch is off or shows "Set up by you" or "Can't read config" {#agent-switch}

- *Off* after you removed the entry by hand: Rojo-Hub follows the agent's own config. Turn the switch
  on again to add it back.
- *Set up by you*: the agent's config already has an entry named `rojohub` with another URL.
  Rojo-Hub never changes it; remove it yourself if you want Rojo-Hub's.
- *Not installed*: the agent's CLI (`claude` or `codex`) was not found.
- *Can't read config*: the agent's config file exists but could not be parsed just now, usually
  while the agent writes it. Rojo-Hub leaves it alone and looks again; if it stays, check the file
  (see [Agents](/guide/agents#turn-it-on) for where it is).

### "Reload the window, then tick the box again" {#agent-reload}

Rojo-Hub was updated but this window has not loaded its new settings yet. Reload the window and
change the switch again.
