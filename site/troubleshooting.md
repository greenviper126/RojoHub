# Troubleshooting

## "Rojo … is not installed"

The project pins a Rojo version Rokit has not downloaded. Run this in the project folder:

```sh
rokit install
```

## "No rokit.toml, aftman.toml or foreman.toml pins Rojo"

Pin one: `rokit add rojo-rbx/rojo`. See [Requirements](./guide/requirements#set-up-rokit-and-rojo).

## Studio says the server uses a different protocol version

The project pins Rojo older than 7.7 and your plugin is 7.7. Pin `rojo-rbx/rojo@7.7.0` and run
`rokit install`.

## Nothing shows up after installing

Reload the window, and check the extension is installed in the VS Code **profile** you are using.

## "Rojo-Hub could not start"

The background service did not come up. The message says why; `%LOCALAPPDATA%\RojoHub\service.log`
has more. Your projects and groups are still saved. Fix the cause and press *Try again*.

## "Port … is held by another program"

Something outside Rojo-Hub uses that port. Stop it, or add the port to
[`rojoHub.excludedPorts`](./reference/settings#rojohub-excludedports) and the project moves.

## Studio disconnected

The Rojo session changed: the project was stopped and started, its port moved, or Rojo crashed and
was restarted. The card says which. Switching branches never causes it.
