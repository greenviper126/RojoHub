# Connecting Studio

Rojo-Hub installs its own Studio plugin: Rojo's plugin, changed to connect **by itself**. Open a
place and it syncs with its project. No port to type, no button to press, and it comes back on its
own when Rojo restarts.

## How a place finds its project

Everything is decided in VS Code; Studio only shows what Rojo-Hub decided. When a place opens, the
plugin tells Rojo-Hub which place it is, and Rojo-Hub answers, in this order:

1. the project you **assigned** to the place in the panel's **Studio places** section;
2. the project whose **`servePlaceIds`** lists the place;
3. the project whose **`placeId`** is the place's;
4. the project this place **last synced with**.

::: tip Only listed places
Set [`rojoHub.studioAutoConnect`](/reference/settings#rojohub-studioautoconnect) to `listed` and a
place connects by itself only when a project file lists it (or you assign it in Studio places). Any
other place you connect by hand each time: type the project's port into the Rojo window.
:::

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

Only a **serving** project is connected to. If the place's project is stopped, Studio places and
the Rojo window say so; start it in Rojo-Hub and the place syncs by itself, without reopening it.

**The first sync asks, once.** The first time a place syncs with a project, Rojo shows its usual
confirmation with the diff (Accept or Abort), because that sync can overwrite what was in the place.
Accept it once and Rojo-Hub remembers: from then on that place and project connect without asking,
when you reopen the place and after any Rojo restart. *Confirmation Behavior* in the plugin's
settings still works: *Always* asks every time, *Never* never asks.

## It reconnects by itself

Switching branches **never** disconnects Studio. A new Rojo session does, and Rojo-Hub's plugin
reconnects to it with no click:

- you **stop and start** the project;
- its **port moves** (you added a `servePort`, excluded its port, …); see
  [When a port changes](./ports#when-a-port-changes);
- Rojo **crashed** and Rojo-Hub restarted it; see [Crash recovery](./service#crash-recovery).

If you press **Disconnect** (or **Abort** on the first sync), that session is left alone. Connect by
hand, assign the project in VS Code, or start the project again, to sync once more.

## Studio places

The panel's **Studio places** section lists every open place with Rojo-Hub's plugin, what it syncs
with (or waits for), and a list to **assign** it a project. *Automatic* follows the order above; pick
a project and the place syncs with it at once. Assign a project when:

- **the place isn't saved to Roblox yet** (a new Baseplate, a local file). It shares its ID with
  every other unsaved place, so the assignment lasts while that Studio window is open;
- **no project lists the place**, and it has never synced. After one sync it is remembered;
- **two serving projects claim the place** and it has not synced with either. Your assignment is
  kept for that place.

A place that doesn't connect by itself also shows every serving project's port under its row, to
copy and connect by hand. In Studio, a line under the Rojo window's buttons shows the same answer;
the choices are all in VS Code.

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
port on the project's card to copy it), then **Connect**. Rojo-Hub remembers that project for the
place from then on.

## How Rojo-Hub knows Studio is connected

Rojo's log records each plugin connection opening and closing. Rojo-Hub counts them; the count
drives the green dot and the *Connected* pill. Places running Rojo-Hub's plugin also say which place
they are: hover the *Connected* pill to see them.

::: tip Get told when Studio disconnects
Turn on [`rojoHub.notifyOnStudioDisconnect`](/reference/settings#rojohub-notifyonstudiodisconnect)
to see a message when Studio disconnects from a serving project.
:::
