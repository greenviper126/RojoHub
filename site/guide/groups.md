# Groups

A group is a named set of projects and other groups, like a profile.

- **Make one**: `+` on *Groups*, or **Group** on a workspace.
- **Fill it**: the card's *Add a project, group or workspace…* list. ✕ takes a member out.
- **Start** serves every project in it (projects already serving are left alone).
- **Stop** stops them, except projects another running group also holds.

Groups remember projects, not branches. A group can't contain itself; such choices are greyed out.

## Workspaces

Projects that belong to a VS Code workspace (`.code-workspace`) are listed under its name. Folders it
lists that aren't added yet show an **Add** button. Workspaces only arrange the list; **Group** turns
one into an ordinary group.

![Projects grouped under a workspace](/images/panel-workspaces-light.png){.panel-shot}
