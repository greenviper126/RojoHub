# Connecting Studio

Rojo-Hub installs its own Studio plugin: Rojo's plugin, changed to connect **by itself**. Open a
place and it syncs with its project. No port to type, no button to press, and it comes back on its
own when Rojo restarts.

## How a place finds its project

When a place opens, the plugin tells Rojo-Hub which place it is, and Rojo-Hub answers from your
project files, in this order:

1. the project whose **`servePlaceIds`** lists the place;
2. the project whose **`placeId`** is the place's;
3. the project this place **last synced with**.

So the easiest setup is to list your places in the project file, the way Rojo already supports:

```json
{
  "name": "MyGame",
  "servePlaceIds": [1234567890, 9876543210],
  "tree": { ... }
}
```

One project can serve several places: open all of them and each syncs with it. A place listed in
`blockedPlaceIds` never syncs with that project.

Only a **serving** project is connected to. If the place's project is stopped, the Rojo window
says so; start it in Rojo-Hub and the place syncs by itself, without reopening it.

A place listed in `servePlaceIds` syncs without asking. Any other place (one you picked, or that
synced before) shows Rojo's usual confirmation before the first sync of a project in a Studio
session, because syncing writes into the place. Change this with *Confirmation Behavior* in the
plugin's settings.

## It reconnects by itself

Switching branches **never** disconnects Studio. A new Rojo session does, and Rojo-Hub's plugin
reconnects to it with no click:

- you **stop and start** the project;
- its **port moves** (you added a `servePort`, excluded its port, …); see
  [When a port changes](./ports#when-a-port-changes);
- Rojo **crashed** and Rojo-Hub restarted it; see [Crash recovery](./service#crash-recovery).

If you press **Disconnect** (or **Abort** on the first sync), that session is left alone. Connect by
hand, or start the project again, to sync once more.

## When it asks you to pick

Under the Rojo window's buttons, a line says what Rojo-Hub found, with a **Sync with…** list of
every serving project. You pick when:

- **the place isn't saved to Roblox yet** (a new Baseplate, a local file). Once you pick, it is
  remembered after you save the place;
- **no project lists the place**, and it has never synced. Pick once and it is remembered;
- **two serving projects claim the place.** Rojo-Hub remembers your pick for that place.

::: warning Rojo 7.7 or newer
The plugin is Rojo 7.7's and speaks only to Rojo 7.7 or newer. A project pinning an older Rojo says
so in the Rojo window: pin `rojo-rbx/rojo@7.7.0`. See
[Which Rojo version](./requirements#which-rojo-version).
:::

## The plugin itself

- Rojo-Hub puts `RojoHub.rbxm` in Studio's plugins folder (`%LOCALAPPDATA%\Roblox\Plugins`) and
  keeps it up to date. **Studio loads a new or updated plugin when you next open a place**, so after
  installing or updating Rojo-Hub, reopen your places.
- In Studio it shows as **Rojo-Hub** in the Plugins tab, with the same window as Rojo's.
- Rojo's own plugin can stay installed, but Studio then shows two Rojo windows; the Rojo-Hub panel
  suggests removing `RojoManagedPlugin.rbxm`. Rojo-Hub's plugin does everything Rojo's does.
- Without Rojo-Hub running, it behaves exactly like Rojo's plugin.
- *Rojo-Hub Auto Connect* in the plugin's settings turns connecting by itself off.
- To manage the plugin yourself, set
  [`rojoHub.studioPlugin`](/reference/settings#rojohub-studioplugin) to false; Rojo-Hub then leaves
  the plugins folder alone.

## Connecting by hand

It still works like Rojo's plugin: set the address to `localhost` and the project's port (click the
port on the project's card to copy it), then **Connect**. The place remembers that project from
then on.

## How Rojo-Hub knows Studio is connected

Rojo's log records each plugin connection opening and closing. Rojo-Hub counts them; the count
drives the green dot and the *Connected* pill. Places running Rojo-Hub's plugin also say which place
they are: hover the *Connected* pill to see them.

::: tip Get told when Studio disconnects
Turn on [`rojoHub.notifyOnStudioDisconnect`](/reference/settings#rojohub-notifyonstudiodisconnect)
to see a message when Studio disconnects from a serving project.
:::
