# Connecting Studio

Each Studio place connects to its project **once**. After that the Rojo plugin reconnects it by
itself whenever you open the place.

## Connect a place

1. Start the project in Rojo-Hub.
2. Copy its port: click the port on the project's card (`:35045` copies `35045`), or use
   **Active ports** in the panel, or *Copy Port* in the project's menu.
3. Open the place in Studio.
4. In the Rojo plugin, set the address to `localhost` and paste the port.
5. **Connect.** The plugin shows its usual confirmation for the first sync.
6. In the plugin's settings, turn on **Auto Reconnect**.

The project's status light turns into a **green dot** and its pill reads *Connected*.

::: tip Why it keeps working
The plugin remembers, per place, the address and project name it last connected to (for 150 days).
With Auto Reconnect on, opening the place connects it again, as long as the server at that address
reports the same project name. Rojo-Hub keeps both fixed: the [port](./ports) never changes, and the
project name never changes on a branch switch.
:::

## When Studio has to reconnect

Switching branches **never** disconnects Studio. A new Rojo session does, and that happens only when:

- you **stop and start** the project;
- its **port moves** (you added a `servePort`, excluded its port, …); see
  [When a port changes](./ports#when-a-port-changes);
- Rojo **crashed** and Rojo-Hub restarted it; see [Crash recovery](./service#crash-recovery).

The card says which. With Auto Reconnect on, reopening the place (or pressing Connect) is enough,
unless the port moved: then set the new port in the plugin once.

::: tip Get told when Studio disconnects
Turn on [`rojoHub.notifyOnStudioDisconnect`](/reference/settings#rojohub-notifyonstudiodisconnect)
to see a message when Studio disconnects from a serving project.
:::

## Place IDs

If the project file lists `servePlaceIds`, the plugin refuses (or asks about) places not on the
list. Rojo-Hub passes `servePlaceIds`, `blockedPlaceIds`, `placeId`, `gameId` and
`emitLegacyScripts` through from the primary checkout's project file. They are read once per
session, so they never change on a switch.

## How Rojo-Hub knows Studio is connected

Rojo's log records each plugin connection opening and closing. Rojo-Hub counts them; the count
drives the green dot, the *Connected* pill and the tooltip.

::: warning Use the Rojo 7.7 plugin
The 7.7 plugin connects only to Rojo 7.7 or newer (protocol 5). See
[Which Rojo version](./requirements#which-rojo-version).
:::
