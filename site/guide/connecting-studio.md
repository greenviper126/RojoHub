# Connecting Studio

Rojo-Hub installs its own Studio plugin (Rojo 7.7's, changed to connect by itself). Open a place and
it syncs with its project. No port to type, and it reconnects after any Rojo restart.

After installing or updating Rojo-Hub, **reopen open places**: Studio loads a plugin only when a
place opens.

## Which project a place syncs with

Decided in VS Code, in this order:

1. the project you assigned it in the panel's **Studio places**;
2. the project whose `servePlaceIds` lists it;
3. the project whose `placeId` is it;
4. the project it last synced with.

So list your places in the project file:

```json
{
  "name": "MyGame",
  "servePlaceIds": [1234567890, 9876543210],
  "tree": { ... }
}
```

Only a serving project is connected to; start it and the place syncs without reopening.
`blockedPlaceIds` keeps a place away from a project.

The **first sync** of a place with a project asks Accept or Abort, because it can overwrite the place.
Accept once and that pair connects without asking from then on.

## Studio places

The panel section lists every open place, what it syncs with, and a list to assign it a project.
Assign one when the place is unsaved, unlisted, or claimed by two serving projects. A place that does
not connect by itself also shows the serving projects' ports, to connect by hand.

| Status | Do |
|---|---|
| *Synced* | Nothing. |
| *Waiting* | Start its project. |
| *Assign a project* | Pick one in the list. |
| *Rojo too old* | Pin `rojo-rbx/rojo@7.7.0`. |
| *Reopen the place* | Reopen it to load the new plugin. |

Pressing **Disconnect** (or **Abort**) leaves that session alone. Use the green **Connect to
‹project›** button in Studio to reconnect.

## Opening places from VS Code

Turn on `rojoHub.openPlaces`. Each card then lists its places with **Open**, **Close** and
**Reopen**. An open place is never opened twice. Close lets Studio ask about unsaved changes. Agents
can open places but never close them.

## Good to know

- Branch switches never disconnect. When Rojo restarts (a crash, a port move, a stop and start),
  the plugin picks up the new session without showing a disconnect: Studio stays on Connected, with
  no notification, and gets only what changed. It shows the disconnect only if the project does not
  come back.
- Rojo's own plugin can stay, but Studio then shows two Rojo windows; the panel suggests removing it.
- Without Rojo-Hub running, the plugin behaves like Rojo's.
- `rojoHub.studioAutoConnect: "listed"` connects only places a project file lists or you assign.
- `rojoHub.studioPlugin: false` leaves Studio's plugins folder alone.
