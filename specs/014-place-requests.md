# 014: Place requests

Status: built (0.22.2, branch `experimental/feedback-2026-10-24`); handoff, asking in the agent's client and `rojoHub.placeMoves` added in 0.22.5; stale-connection note, logs, pending-handover status and a 60 s wait cap in 0.22.6. From `specs/feedback-2026-10-25.md`.

## Problem

A Studio place syncs with exactly one project (spec 007). That rule stays: a place never syncs
with two projects at once, because two owners would overwrite each other. When two projects list
the same place in `servePlaceIds`, the place stays with the one it last synced with. Seen live:
FolderThemes sat at `connections: 0`, and its agent could neither see why nor do anything except
tell the user to open the panel.

Moving a place between projects should be easy and visible, without letting an agent take a place
on its own.

## Design

### Seeing it

- A place that several registered projects list (`servePlaceIds` or `placeId`, minus
  `blockedPlaceIds`) is *shared*.
- `status` (text and `structuredContent`) and `serve_here` / `switch` / `ensure` say, for each of
  the project's places:
  - which project the place is synced with now, when that is another project;
  - which other projects list it;
  - any pending request for it.
  
  For example: "DL Game - Dev (106807032284628) is synced with VluxyBuildingTools, which also lists
  it. Call request_place to ask the user to move it here."
- Each project's `status` also lists requests from other projects for places it holds, so the
  holder's agent knows to finish up or release.
- The panel badges a shared place in Studio places and shows a pending request on it, with Move and
  Decline buttons.

### Asking

A new MCP tool, `request_place(place_id, wait?)`, called from the asking project's worktree.

1. It needs a claim on the asking project, and renews it, like `serve_here`.
2. The place must be one the project lists. Otherwise it is refused, with the same message
   `open_place` gives.
3. If the place already syncs with this project, the answer says so and does nothing.
4. If the place is open and synced with no project, or isn't open, the tool saves the assignment
   straight away. Nothing is taken from anyone.
5. If another project holds the place:
   - Under yolo, when no other agent has claimed the holding project, the move happens at once and
     goes to the audit log.
   - Otherwise a request is recorded and VS Code asks the user.
6. With `wait` (seconds, at most 300), the tool waits for the answer and returns moved, declined or
   still pending. Without it, the tool returns pending at once, and `status` or a later call shows
   the outcome.

A project has at most one pending request per place. A repeat call refreshes that request instead
of adding another notification.

### Approving

- The notification: "Rojo-Hub: FolderThemes asks for DL Game - Dev, now synced with
  VluxyBuildingTools. [Move] [Decline]".
  - If another agent claims the holding project, the notification adds "(an agent is using
    VluxyBuildingTools)".
- It is shown the way `noticeDisconnects` does: only in a window that has the asking or the holding
  project open, else in the focused window. Each request is shown once per window.
- **Move** saves the same assignment the panel makes, through `PlaceMemory.assign`. The place
  reconnects to the asking project within a tick and stays with it across reconnects and restarts.
- **Decline** ends the request. A dismissed notification leaves the request pending, still answerable
  in the panel.
- Answering in one window ends the request everywhere. Other windows' notifications then do nothing
  if clicked.

### Ending

A request ends when:
- it is moved or declined;
- the asking agent calls `release`;
- the asking project's claim lapses;
- the asking or holding project is removed;
- the place stops being listed by the asking project.

Requests live in memory only. A service restart drops them, and an agent asks again.

## Acceptance criteria

1. Two projects listing one place: the losing project's `status` names the holder and suggests
   `request_place`. The holding project's `status` lists the place as shared.
2. `request_place` for a place nobody holds assigns it straight away, without a notification.
3. `request_place` for a held place records one request. The panel and the holder's `status` show
   it, and VS Code shows the notification once.
4. Move: the place syncs with the asking project, the assignment is kept, and the request is gone
   from `status` and the panel.
5. Decline: the asking agent's `wait`, or its next `status`, reports it declined.
6. Yolo with an unclaimed holder: the place moves at once and the move is in `audit.jsonl`. Yolo
   with an agent-claimed holder: the user is still asked.
7. A request ends on `release`, on claim expiry and on project removal.
8. The Studio protocol is unchanged, so there is no `STUDIO_PROTOCOL` bump.
9. Unit tests cover the matching and request lifecycle; an e2e test covers the tool against the
   service.

## Non-goals

- Syncing one place with two projects at once. This is never planned.
- Agents moving a place without the user, except under yolo.
- Keeping requests across service restarts.

## Built (0.22.2): decisions the spec left open

- **Who holds a place.** The project the open place is synced with, else the one it is connecting to
  (its answer is `connect`). A place that is not open, or that no project answers for, has no holder,
  so `request_place` assigns it at once.
- **The asking claim.** `request_place` refuses without a claim held by the caller's own worktree
  (call `serve_here` first) and refuses when another worktree holds it. A request is tied to that
  claim: if the claim lapses or changes hands, the request ends.
- **Argument names.** `place_id` as the spec says; `placeId` (as `open_place` writes it) is accepted too.
- **Remembered answers.** A move or a decline is kept for 15 minutes for the asking agent's `status`
  and `wait`, and forgotten when it asks again or releases. `wait` ending without an answer because the
  request was released, lapsed or removed returns `ended`.
- **Moved in the panel.** Assigning the place to the asker with the Studio places list also ends the
  request, as moved.
- **Data.** `status`, `serve_here`, `switch` and `ensure` carry `sharedPlaces` and `incomingRequests` on
  each project; `request_place` answers `outcome`, `placeId`, `name`, `project`, `holder`.
- **Audit.** A move made at once under yolo writes `move_place` besides the usual `request_place` entry.

## Update (0.22.5)

Seen live on 0.22.4: a place synced with VluxyBuildingTools did not move after FolderThemes asked and
the user clicked Move: the plugin "never takes over a live session". Three changes.

### 1. A deliberate move hands a synced place over

- Every assignment made on purpose goes through `StudioLinks.assign`: the panel's Studio places
  route, **Move**, `request_place`'s immediate assignment, and a move at once (`placeMoves` auto or
  yolo). It records a *handoff* for the place: a number, new each time (seeded from the clock, so a
  restart never repeats one), sent with the answer as the optional `target.handoff`, while the target is
  the project it was handed to. Clearing an assignment hands nothing over. The Studio protocol is
  unchanged: older plugins skip the field.
- The service logs `studio: <place> (<id>): handing over from X to Y` when a new number reaches a place
  synced with another project.
- The plugin (`Hub:handOverIfAsked`): in edit mode, with auto connect on, with a live **synced**
  session (not connecting, not on Rojo's confirmation or settings page, not resuming a lost session)
  to a project on a different port, and a handoff number it has not acted on: it ends the session as
  **Disconnect** does (`App:endSession`; the loss is not held, `handingOver`), connects to the new target, and
  remembers the number, so it switches once and never fights a user who connects by hand afterwards.
  A number that arrives when there is no session, or when the session is already the target's, is only
  remembered. Without a number the old rule stands. First sync with a project still asks Rojo's
  confirmation (`accepted`). Logged in Studio's output ("Rojo-Hub: handing over from X to Y").
- Not verified in a real Studio from the build environment; there is no Luau test harness for the
  plugin, so the Lua is kept small and commented, and the service half is unit and e2e tested (the fake
  plugin sees a new number on the panel's assignment and on Move).

### 2. Approving in the agent's own client (MCP elicitation)

No `approved` argument: an argument is the model's to set, and approval must be the user's. Instead,
when a client declares `capabilities.elicitation` in `initialize`, the stdio launcher adds
`x-rojo-hub-elicit: 1` to `request_place` calls. For a held place the service then returns
`_meta["rojo-hub/elicit"]` (`requestId`, `message`, and the `moved`, `declined`, `answered` wording).
The launcher sends `elicitation/create` to the client (one boolean `move`, default true, there only
because a form needs a field), and the buttons are the answer, whatever the field says:

- accept: `POST /studio/requests/:id/move`;
- decline: `POST /studio/requests/:id/decline`;

(0.22.5 to 0.22.9 read the field, default false, and declined an accept with it unticked. In the field
the box could not be ticked in the user's client, so every accept declined. Fixed in 0.22.10.)

- cancel, an error, or ten minutes without an answer: nothing is sent, the request stays pending (VS Code
  can still answer);
- 409 (answered in VS Code first): the agent is told so.

Both POSTs carry `x-rojo-hub-answered-in: chat` and the client's own answer (`x-rojo-hub-elicit-result`,
logged with the answer), and the service writes `move_place` or
`decline_place` to `audit.jsonl` with `approvedIn: "chat"`. The agent gets the outcome as the call's result
(`structuredContent.outcome`). With the header, `wait` is ignored (the question comes back at once). Without
elicitation support nothing changes: VS Code notification and panel. The tool description and the MCP
instructions say the user is asked directly and the agent must not ask in chat. The VS Code
notification stays; whichever answers first wins.

### 3. `rojoHub.placeMoves`

`ask` (default) or `auto`, application scope, pushed to the service like `openPlaces`. `PlaceRequests.ask`
takes one `autoMove` flag, computed by the caller as `placeMoves === "auto" || yolo`. It moves at once only
when the holding project has no claim from another agent; a claimed holder is always asked. Every automatic
move writes `move_place` with `by: "placeMoves"` or `"yolo"`. `status` carries `placeMoves` and says so
in one line when it is `auto`.

### Acceptance (0.22.5)

10. A Move, a panel assignment and `request_place`'s assignment each send a new `target.handoff`.
11. A plugin synced with another project switches once per handoff number; none, no switch.
12. A client that declares elicitation is asked; accept moves (whatever the field says), decline declines,
    cancel leaves pending; a client that does not declare it gets no header and no `_meta`.
13. `placeMoves` auto moves at once from an unclaimed holder (audited), asks for a claimed one; ask asks.

## Update (0.22.6)

Seen live on 0.22.5: the question never appeared because every running launcher predated 0.22.5 (a
launcher keeps its code until the chat reconnects), a Move was "lost" with nothing in the logs to say
who reassigned the place, and `wait: 120` ran into the client's tool-call handling.

1. **Stale connection.** The launcher sends `x-rojo-hub-launcher: <version>` on every /mcp POST. When it
   is missing or older than `SERVICE_VERSION`, every tools/call result's text (not
   `structuredContent`) ends with "Note: this chat's Rojo-Hub connection is older (launcher <v or
   'before 0.22.6'>) than the service (<v>) ... Ask the user to run /mcp and reconnect rojohub, or start
   a new chat." There is no special case for direct-HTTP clients: the advice fits them too. `version`
   reports `connection` and `connectionOutdated`.
2. **Logs.** `service.log` gets `places:` lines for a request created, the question put to the client,
   an answer (move or decline, in VS Code or the agent's chat), an end (released, lapsed, removed,
   unlisted) and an automatic move; and a `studio:` line for every `StudioLinks.assign`, with its source
   (`panel`, `Move on X's request, answered in ...`, `request_place`, `auto move, placeMoves|yolo`).
3. **Pending handover.** `status` says when a place is assigned to A but still synced with B
   (`studioPlaces[].assignedTo`, optional), and `request_place` after a move.
4. **`wait` is capped at 60 s** (was 300).

### Acceptance (0.22.6)

14. A call without the header, or with an older one, carries the note; a current launcher's does not.
15. The log lines above are written (unit tests with a log stub).
16. `assignedTo` and the handover sentence appear only while the assigned project differs from the synced one.

### Also in 0.22.6

- The plugin says when it is older than the service (`Hub:updateNote`, from `match.serviceVersion`; both
  pages), and the panel's Studio places mark such a place. No protocol change.
- `rojoHub.closePlaces` gates Close, Reopen, `close_place` and `reopen_place` (spec 009's Close and
  Reopen no longer need `openPlaces`); yolo does not turn it on; a reopen's open step needs only it.
- Windows reload themselves when a newer Rojo-Hub is installed (`rojoHub.reloadOnUpdate`).
