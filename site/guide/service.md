# The background service

VS Code extensions stop when their window closes, and you probably keep several windows open. So
Rojo-Hub runs a small **background service** that owns every project and its Rojo, separate from
any VS Code window. It listens on `127.0.0.1:34870`.

## You never manage it

- The panel has **no service controls**. The extension starts the service whenever nothing answers
  on port 34870: when a window opens, when the panel refreshes, and before any action.
- It runs on **VS Code's own runtime** (no separate Node.js needed) and keeps running after windows
  close. In Task Manager it shows as `Code.exe` (Visual Studio Code).
- What serves is decided only by starting and stopping projects and groups, and *Stop all*.

## Rojo keeps serving without it

Rojo processes are independent of the service. If the service stops or is replaced (for example by
an [update](./install#update)), Rojo keeps serving and Studio stays connected. The next service
**adopts** each Rojo that still answers with its project's name.

- **Restores on start**: projects that were serving when the service last stopped are adopted, or
  started again.
- **Nothing is lost**: projects and groups live in `registry.json` (see
  [Files on disk](/reference/files)).

## Crash recovery

If a project's Rojo dies unexpectedly, the service starts it again **on the same port** and the card
says so:

*Rojo crashed at ‹time› and was restarted on the same port; places with Rojo-Hub's Studio plugin
reconnect by themselves … ‹Rojo's reason›*

(Right after a checkout inside the served worktree, it says the checkout caused it instead; see
[Checking out inside a served folder](./switching#checking-out-inside-a-served-folder).)

This is a new session. Places with Rojo-Hub's Studio plugin reconnect by themselves within a second;
with Rojo's own plugin, reconnect Studio.

- A Rojo the service started itself is known to have exited at once.
- One it adopted is presumed gone only after **three status checks in a row** go unanswered and no
  Rojo for the project is running, so a Rojo that is just slow to answer (a big switch, a busy PC) is
  never restarted.
- If the restart fails too, the project shows the error and can be stopped from its card, *Stop all*
  or its group.

## It keeps going

- An unexpected error inside the service (a folder deleted while it is being watched, say) is
  written to `service.log`, and the service carries on.
- `registry.json` is written to disk before it replaces the old one. If it is ever damaged (a power
  cut, a hand edit), the service keeps it as `registry.corrupt-<time>.json`, starts from the save
  before it (`registry.json.bak`), and says so in `service.log`.

## It exits when idle

After **15 minutes** with nothing serving, no VS Code window following it and no request, the
service exits, so it does not keep VS Code's program in use. The next window starts it again.

## If it cannot start

The panel shows **Rojo-Hub could not start** with the reason and **Try again**, and still lists your
projects and groups (read from `registry.json`), marked unavailable with a dashed grey light. It is
not retried on every refresh, only on *Try again* or your next action, so a broken install does not
start a process every two seconds. See
[Troubleshooting](/troubleshooting#rojo-hub-could-not-start).

## One Windows user at a time

The service's port is shared by everyone signed in to the PC. Another signed-in Windows user's
service is **never used or stopped**; the panel says *Port 34870 is used by another Windows user's
Rojo-Hub (‹their folder›). Only one signed-in user can run Rojo-Hub at a time.* It works again once
that user signs out.

## Security

Only programs on this PC can use the service:

- It listens on `127.0.0.1` only.
- It answers only requests addressed to `127.0.0.1:34870`, `localhost:34870` or `[::1]:34870`, so a
  web page using DNS rebinding cannot even read it.
- It refuses any request from a web page: a browser `Origin` (`http://`, `https://`, or `null` from
  a file or sandboxed page), pages on `localhost` included. Requests with no `Origin` (the
  extension, agents) or from VS Code's own windows (a `vscode-…://` origin) are allowed.

The [Local API](/reference/api) lists what it answers, for scripts and debugging.
