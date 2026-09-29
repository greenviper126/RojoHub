# Connect Studio

Rojo-Hub installs its own Studio plugin (Rojo's plugin, changed to connect by itself), so there is no port to type.

1. List the project's places in its project file: `"servePlaceIds": [1234567890]`.
2. Open the place in Roblox Studio. If it was already open when Rojo-Hub was installed or updated, reopen it: Studio loads a new plugin when a place opens.
3. It syncs by itself. The first time, Rojo asks you to accept the sync (with the diff); after that the place connects without asking.

A place that isn't listed (or isn't saved to Roblox yet) shows up in the panel's **Studio places** section: assign it the project there, once.

From then on, the place reconnects by itself whenever its project serves again: after a restart, a crash, or a port move.
