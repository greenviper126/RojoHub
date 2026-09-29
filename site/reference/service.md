# The background service

A small service owns every project and its Rojo, so closing VS Code windows stops nothing. It listens
on `127.0.0.1:34870` and runs on VS Code's own runtime. You never manage it: the extension starts it
when needed.

- **Updates and restarts**: Rojo keeps running; the next service adopts it, so Studio stays connected.
- **Restores**: projects that were serving come back.
- **Crash recovery**: a Rojo that dies is restarted on the same port. Rojo-Hub's plugin reconnects.
- **Idle exit**: after 15 minutes with nothing serving and no window open.
- **Nothing is lost**: projects and groups live in `registry.json`, with a backup.
- **One Windows user at a time**: another signed-in user's service is never used or stopped.

## Security

Only programs on this PC can use it. It listens on `127.0.0.1`, answers only requests addressed to
`127.0.0.1:34870`, `localhost:34870` or `[::1]:34870`, and refuses any request from a web page
(a browser `Origin`). See the [Local API](./api).
