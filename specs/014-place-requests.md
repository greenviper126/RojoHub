# 014: Place requests

Status: built (0.22.2, branch `experimental/feedback-2026-10-24`). From `specs/feedback-2026-10-25.md`.

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
