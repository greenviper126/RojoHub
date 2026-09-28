# Your first project

## 1. Add it

Open the **Rojo-Hub** panel from the activity bar and press **+** on *Projects*. Pick a folder that
is open in this window, a repo Orca knows about, or *Browse…*.

![The Rojo-Hub panel](../../docs/images/panel-overview.png)

Any folder inside the repo works; Rojo-Hub registers the repo's main checkout. It serves
`default.project.json`, or asks which `*.project.json` when there is no default.

::: warning Project names must be unique
The Studio plugin reconnects a place only to a server reporting the name it saved, so two repos with
the same Rojo project `name` cannot both be added. Rename one in its project file.
:::

## 2. Start serving

Press **Start** on the project's card. The status light turns into a green ring when Rojo is up.

| Light | Meaning |
|---|---|
| grey ring | stopped |
| spinner | starting |
| green ring | serving, Studio not connected |
| green dot | serving, Studio connected |
| red dot | error (the card shows it) |

## 3. Connect Studio

1. Open the place in Studio.
2. Click the port on the card to copy it.
3. In the Rojo plugin, set the address to `localhost` and paste the port, then **Connect**.
4. In the plugin's settings, turn on **Auto Reconnect**.

From now on, opening that place connects it by itself. The port never changes, so you set it once.

## Next

- [Switch the project to another branch](./switching) without Studio disconnecting.
- [Learn how ports are picked](./ports).
