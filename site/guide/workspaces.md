# Workspaces

A VS Code workspace file (`.code-workspace`) lists folders that open together, like
`MyGame.code-workspace` listing *MyGame*, *MyGameServer* and *SharedLib*. Rojo-Hub uses workspace
files **only to arrange the Projects list**. Nothing about a project changes.

![Projects grouped under a workspace, with a folder not added yet (Light Modern theme)](/images/panel-workspaces-light.png){.panel-shot}

## What you see

When projects belong to a workspace, the Projects list groups them under the workspace's name,
with:

- how many of its projects are serving;
- a window icon if it is the workspace this window has open;
- a **Group** button that [makes a group](#make-a-group-from-a-workspace) of its projects;
- folders the workspace lists that have a `*.project.json` but are **not added** yet, each with an
  **Add** button (and **Add all** when there are several).

Projects in no workspace are under **Other projects**.

## How workspaces are found

- **Where it looks**: the workspace file this window has open, and the top folder of every added
  project. Comments and trailing commas in the file are fine; remote (`uri`) folders are ignored.
- **Which projects**: each folder the file lists is matched to an added project by its repo's
  primary checkout, so a worktree folder counts as its project.
- **Drawn once**: a project listed by two workspaces is drawn under the first (this window's
  workspace first, then by name). The other shows a short *shown above* row that jumps to it.
- **When**: workspace files are read again when projects are added or removed, when the window's
  workspace changes, and on Refresh.

## Adding and removing

Adding and removing stay per project. *Add* (or *Add all*) under a workspace adds its folders one by
one as ordinary projects, and a project is removed from its own card as usual.

## Make a group from a workspace

The workspace's **Group** button makes a group named after the workspace (or *Name 2*, … if that
name is taken) holding its added projects. From then on it is an ordinary [group](./groups): later
changes to the workspace file do not change it.

You can also add a whole workspace to an existing group from the group's
*Add a project, group or workspace…* dropdown; see [Groups](./groups#make-and-fill-a-group).
