# Connect Studio once

1. Open the place in Roblox Studio.
2. In the Rojo plugin, set the address to `localhost` and the project's port. Clicking the port on the project's card copies it.
3. Click **Connect**.
4. In the plugin's settings, turn on **Auto Reconnect**.

From then on, opening that place reconnects it to its project automatically. The plugin remembers an address for each place, and reconnects only if the server there has the same project name.

If the project's file lists `servePlaceIds`, the plugin refuses places that aren't on the list.
