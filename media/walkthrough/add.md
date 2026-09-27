# Add a project

Open the **Rojo-Hub** panel from the activity bar and click **+** on **Projects**.

The panel lists the folders open in this window and the repos Orca knows about; click one to add it. **Browse…** picks any other folder that has a `default.project.json`.

Each project gets its own port:

- the `servePort` in its `default.project.json`, if it sets one;
- otherwise a port worked out from the repo's first commit, so it is the same on every machine.

Two projects can't share a Rojo project `name`, because the Studio plugin reconnects by name.
