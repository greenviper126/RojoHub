# Groups

A group is a named set of **projects and other groups**, like a profile: start, stop or swap a whole
set at once. A project or group can be in several groups. Groups live in the **Groups** section of
the panel, below Projects.

## Make and fill a group

- **Make one** with the `+` on the Groups header (or *New Group* in Open Menu). Type a name and press
  Enter or **Create**. Group names are unique, ignoring case.
- **Make one from a workspace** with the workspace's **Group** button (see
  [Workspaces](./workspaces#make-a-group-from-a-workspace)).
- **Add to it** with the group card's **Add a project, group or workspace…** dropdown. Pick one to
  add it; do it again for the next. It lists:
  - **Workspaces**: adds every project of that VS Code workspace that is not in the group yet, as
    ordinary members you can take out one by one. Folders the workspace lists that are not added to
    Rojo-Hub are skipped (the entry says when there are some). A workspace whose projects are all in
    the group already is greyed out.
  - **Projects** not in the group yet.
  - **Groups**, with those that would [loop](#loops) greyed out.
- **Take something out** with the ✕ next to it. It asks first, in place (*Take SharedLib out of My
  Game? Yes / No*). Nothing is deleted: a project stays registered, a group stays a group.

## What a group card shows

- **Groups inside it** first, with a layers icon and how many of their projects are serving; click
  one to scroll to its own card.
- **Its projects**, each with its port (click to copy the number) and ✕ to take it out. Click a name
  to jump to its card.
- **How many of its projects are serving**, for example `2/3` (green when all are). The count is
  over every project inside it, through nested groups.
- **Start** or **Stop**, then **Singleton**.
- A green *Running* pill and a green rail on the left edge while it is running.
- **✎ Rename** and **🗑 Delete**, shown when the pointer is on the card.

## Running groups

| Action | Effect |
|---|---|
| **Start** | Serves every project the group holds, each on its own port. Projects already serving are left alone, so their Studio sessions continue. |
| **Stop** | Stops the group's projects, **except any another running group also holds**: that project is in use elsewhere, so its port keeps serving. Rojo-Hub says which projects it kept and why. |
| **Singleton** | Serves this group and stops **every other project** (the profile switch). **Asks first**, naming exactly which projects it will stop. |
| **✎ Rename** | Edit the name in place; Enter saves, Escape cancels. |
| **🗑 Delete** | Asks *Delete?* in place. Deletes the group only; its projects stay registered and keep serving. |

The Start / Stop button is one button: Start while the group is not running, Stop while it is.

::: info What "running" means
A group is **running** from Start or Singleton until Stop, or until another group's Singleton. It is
about what you started, not whether all its projects happen to be serving, so a group you never
started never keeps a project alive. Stopping a single project from its own card does not change
which groups are running.
:::

- If some projects fail to start or stop, the rest still go ahead, and one message lists the
  failures.
- Groups remember **what they hold, not branches**: each project serves whatever it was last switched
  to.
- Removing a project removes it from every group. Deleting a group removes it from every group that
  held it.

## Loops

A group can't contain itself, directly or through other groups. Adding group B to group A is refused
when B already contains A anywhere inside it:

- In the dropdown such groups are greyed out and marked *(would loop: it contains A)*.
- The service refuses them too, with the chain that would loop, for example
  *Outer → Middle → Inner*.
- If a loop gets into `registry.json` some other way, Rojo-Hub still expands each group only once,
  so nothing hangs.
