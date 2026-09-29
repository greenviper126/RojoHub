# Your first project

Three steps: add a project, start it, connect Studio.

::: info Before you start
The project must be a git repo with a `*.project.json` in its top folder, and a toolchain file that
pins a Rojo installed by Rokit. See [Requirements](./requirements).
:::

## 1. Add it

Open the **Rojo-Hub** panel from the activity bar and press **+** on the *Projects* header. A list
opens inside the panel with:

- the folders open in this window,
- the repos Orca knows about (if you use Orca),
- **Browse…** for any other folder.

Press **+** next to one. The new project's card is highlighted.

- **Any folder inside the repo works.** Rojo-Hub registers the repo's primary checkout (its main
  folder), even if you picked a worktree.
- **Which project file:** `default.project.json` if there is one; otherwise the only
  `*.project.json`; otherwise Rojo-Hub asks. You can change it later, see
  [Project files](./projects#project-files).
- A new project is **stopped** and serves its primary checkout.

::: warning Project names must be unique
A place remembers the project it last synced with by its `name`, so two repos with the same Rojo
project `name` cannot both be added. Rename one in its project file.
:::

## 2. Start serving

Press **Start** on the project's card. The card shows *Starting…*, then the status light turns into
a green ring once Rojo answers.

| Light | Meaning |
|---|---|
| grey ring | stopped |
| spinner | starting |
| green ring | serving, no Studio connected yet |
| green dot | serving, Studio connected |
| red dot | error (the card shows the message) |

If Rojo does not come up within 30 seconds, the card shows the end of Rojo's log. Common causes
(the pinned Rojo is not installed, the port is taken) are in
[Troubleshooting](/troubleshooting).

## 3. Connect Studio

Rojo-Hub installs its own Studio plugin, so there is no port to type. List the project's places in
its project file:

```json
"servePlaceIds": [1234567890]
```

Then open the place in Studio: it syncs by itself (after installing Rojo-Hub, reopen places that were
already open, so Studio loads the plugin). A place that isn't listed shows up in the panel's
**Studio places** section, where you assign it the project once. [Connecting Studio](./connecting-studio)
has the details.

## What next

- [Switch the project to another branch](./switching) while Studio stays connected.
- [Group projects](./groups) you use together.
- [Tour the panel](./panel).

::: tip The Get Started walkthrough
VS Code's Welcome page has a five-step walkthrough (add, start, connect Studio, switch, group):
*Help → Welcome → Get Started with Rojo-Hub*, or *Getting started guide* in the empty panel.
:::
