# Ports

Every project has its **own port**, and it is the **same on every machine**. That is what lets each
Studio place connect once and reconnect by itself from then on.

## How a port is picked

A project's port is decided by these rules, in order, and checked again every few seconds:

1. **`servePort`** in the project's project file, when set. This is Rojo's own field: it is committed
   with the repo, so everyone who clones it agrees, and plain `rojo serve` uses it too.
2. **Otherwise a port worked out from the repo's first commit**: a hash of the oldest root commit,
   placed in the port range (default `34873-35872`). Every clone has the same first commit, and
   renaming the repo, its folder or its project does not change it.
3. **Collisions**: a hashed port that is excluded, claimed by another project's `servePort`, or
   already taken by a project added earlier moves forward to the next free port (wrapping around to
   the start of the range). The project that moved shows a warning:
   *Its own port ‹p› is taken by ‹name› (or: is excluded), so it moved to ‹q›. Set "servePort" in its
   project file to fix a port.* Rule 1 always wins over rule 2: a `servePort` that lands on another
   project's hashed port moves that project.
4. **The hash never picks 34872 or 34870.** 34872 is Rojo's default port, used by a plain
   `rojo serve` and by tools that expect Rojo there; 34870 is Rojo-Hub's own service. This holds
   whatever the port range and excluded ports say. A range may be a single port (`35000-35000`).

::: tip Pin a port for good
Add `servePort` to the project file and commit it:

```json
{
  "name": "MyGame",
  "servePort": 35100,
  "tree": { "$path": "src" }
}
```
:::

::: warning servePort wins over the settings
A `servePort` is used even if it is excluded, 34872 included: the card notes *servePort ‹p› is in
rojoHub.excludedPorts; the project file wins.* Two exceptions show an error on the card, and the
project cannot start until you change its project file:

- **Not a port** (not a whole number from 1 to 65535): *servePort ‹value› is not a port; use a
  whole number from 1 to 65535.*
- **34870**, Rojo-Hub's own port: *servePort 34870 is Rojo-Hub's own service port. Pick another port
  in the project file.*
- **The same `servePort` in two projects**: the one added first keeps it; the other shows
  *servePort ‹p› is also set by ‹name›; two projects cannot share a port. Change one of them.*

Adding a project whose `servePort` is refused like this fails with the same message.
:::

A project file that briefly does not parse (an auto-save of half-typed JSON) keeps the `servePort`
last read from it, so the port does not move away and back.

## When a port changes

These change a project's port:

- you add, change or remove a `servePort`;
- you exclude the port a project is on, or change the port range;
- you remove the project that had pushed it off its own port.

A **serving** project is then restarted on its new port. That is a new Rojo session, so Studio
disconnects. The card shows *Port moved from A to B; reconnect Studio to the new port.* and VS Code
shows *‹project› moved from port A to B* with **Copy Port** and **Show Project** (in the window that
has the project open, or else the focused window).

::: info A move waits a moment
A move caused by a project file (a `servePort` added, changed or removed) or by removing a project
happens only once the new port has held for 2.5 seconds, a few seconds in practice. So a `servePort`
being typed with auto-save on (3, 34, 349…) does not restart Rojo at every keystroke. Changing the
port settings, which you save on purpose, moves at once.
:::

::: warning Reconnect Studio to the new port
The Rojo plugin remembers the last port per place. Set it to the new one once, and Auto Reconnect
takes over again.
:::

## Excluding ports

To keep Rojo-Hub off ports another program uses, add them to
[`rojoHub.excludedPorts`](/reference/settings#rojohub-excludedports): single ports or ranges.

```json
"rojoHub.excludedPorts": [35000, "35100-35110"]
```

If another program already holds a project's port, starting that project fails with *Port ‹port›
is held by another program.* Exclude the port and the project moves to the next free one.

## Port settings in the panel

![The Port settings section](/images/panel-port-settings.png){.panel-shot}

The panel's **Port settings** section (folded by default) edits both port settings:

- the **port range** and **excluded ports** as text boxes, with *Save* and *Undo*;
- mistakes are pointed out before saving;
- the port range has **Reset**, which puts back the default range (34873–35872) after asking. It
  says how many projects get their port from the range, since their ports may change and serving
  ones restart. Reset is greyed out when the range is already the default; excluded ports have no
  reset.

Changes apply within a few seconds. The settings are shared by every project, window and profile;
see [Settings](/reference/settings#where-settings-are-saved).
