# 009 — Open places in Studio

Status: **draft** (branch `feat/open-places`). Asked for by Viper: "is there a way to auto open place
files in roblox studio through commands like power shell?" ("im talking about non-local files"),
then "if we do make it manual if id be a good idea to make this somthing available through the mcp
for agents?", and "settings turns of the option to open a place from vscode through the extension
from both user and mcp". Builds on 007 (Studio plugin, Studio places) and 008 (agent tools).

## Problem

A project file already lists the places a project belongs to (`servePlaceIds`, `placeId`), and the
service knows which of them are open in Studio, because each open place's plugin reports in (007).
Yet to get a place into Studio, someone opens Studio, finds the experience and presses Edit.

- An agent that called `serve_here` to check its work in Studio stops and asks the user to open the
  place; `wait_for_studio` can only wait.
- After a plugin update, a place picks up the new plugin only when reopened (007, M3). The panel says
  which places are behind, but reopening them is done by hand, one Studio window at a time.

## Design

### Opening a place

A place is opened through the `roblox-studio:` link that the website's *Edit in Studio* uses (M1):

```
roblox-studio:1+launchmode:edit+task:EditPlace+placeId:<place>+universeId:<universe>
```

The universe ID is required (M1). The service gets it from the place ID:

1. The project file's `gameId`, when the project sets one (Rojo's name for the universe ID).
2. Else a saved answer from an earlier lookup. A place never moves to another universe, so an answer
   is kept for good, in the state folder.
3. Else `GET https://apis.roblox.com/universes/v1/places/<place>/universe` (public, no sign-in, M2),
   and the answer is saved.

Viper: "you think method 1 by itself is good enough? id assume the agent could always try again
anyway". So there is no fallback when the lookup fails (not even the plugin's `GameId`): opening a
cloud place needs the internet anyway, and the error says which place and why, so a retry is the
obvious next step.

The link is handed to Windows without a console window (M3).

**Already open.** Before opening, the service checks the Studio places its plugins reported (007).
If the place is open, nothing is opened and the answer says so. A place open in a Studio whose
Rojo-Hub plugin is off or missing is not seen, and would be opened a second time (M4 measures what
Studio does then).

Only places a project names can be opened: its `servePlaceIds` and `placeId`, never
`blockedPlaceIds`, never an arbitrary ID.

### Closing and reopening (panel only)

- **Close** asks Studio's window to close, the same as its X, so Studio still asks about unsaved
  changes (or publishing). It never kills the process: losing someone's unsaved work is the worst
  thing this feature could do.
- **Reopen** closes, waits until that Studio process has exited (the user may be answering Studio's
  prompt; the panel shows *closing…*), then opens the place again. It is the answer to "open places
  still run an older plugin".
- Which process has which place is M5. Close and Reopen are only built if M5 finds a reliable way;
  otherwise they are left out and the spec says so.

### The panel

Spec 007 left out a per-project place list (the Studio places section lists open places only). This
feature needs one: each project card lists the places its project file names, each with whether it
is open, and **Open** (or **Close** and **Reopen** while open). The project's menu gets
**Open all places**, which opens every listed place not already open.

### Agents

`open_place` (MCP) opens one of a project's places, through the same service code as the panel.
It takes the project (as the other tools do) and `placeId`, which may be left out when the project
lists one place. It is in 008's *safe* group: it opens a window and disturbs no one, so no claim is
needed. It answers *already open*, *opened* (then the agent calls `wait_for_studio`), or the error.

Agents get no close or reopen: the window may be one the user is working in, an agent cannot answer
Studio's save prompt for them, and another agent may be using the place. `status` says, for each
place a project names, whether it is open, so an agent knows whether to open one.

### The setting

`rojoHub.openPlaces` (on by default, application scope like the other service settings, sent with
them and saved in the service's `settings.json`). Off turns the whole feature off, for the user and
agents alike:

- The panel hides Open, Close, Reopen and *Open all places* (hidden, not greyed out, so nothing looks
  broken).
- `open_place` stays listed, and every call answers that opening places is turned off in Rojo-Hub's
  settings (`rojoHub.openPlaces`). An agent's tool list is usually fixed when it starts, so hiding the
  tool would not reach running agents; the error does, and says why.
- The service's API refuses too, so the panel and the MCP cannot disagree.

## Measurements

Done on 2026-09-29 by Viper, from PowerShell, on TheLaundryShift's first place (`122634966546108`,
universe `9465257577`).

- **M1 The link needs the universe ID.** `roblox-studio:1+launchmode:edit+task:EditPlace+placeId:<place>`
  opened Studio with "We could not open the place [0]. Error fetching latest place version". With
  `+universeId:9465257577` added, the place opened for editing. Studio's executable with
  `-task EditPlace` was not tried: the link does not need the executable's path, which changes with
  every Studio update.
- **M2 The lookup.** `apis.roblox.com/universes/v1/places/<place>/universe` answered
  `{"universeId": 9465257577}` for both of TheLaundryShift's places, without signing in.

Still to measure, before building:

- **M3** Handing the link to Windows from the service (`explorer.exe <link>`, or `spawn` with
  `windowsHide`) opens Studio with no console window flashing.
- **M4** Opening a place that is already open: a second window, the same window brought forward, or a
  question.
- **M5** Telling which `RobloxStudioBeta` process has which place. Candidates: the process's command
  line (a place opened by the link may carry its place ID), the window title (the place's name, not
  unique), or something the plugin can report. Also: whether each place is its own process, and what a
  playtest adds.
- **M6** What a graceful close (`CloseMainWindow`) does for a Team Create place and for a place that
  is not: a prompt, a publish, or nothing.
- **M7** A place's name for the panel's rows before it has ever been opened: a public endpoint, or
  show the place ID until the plugin reports the name.

## Acceptance criteria

- [ ] The panel lists each project's places with whether they are open, and **Open** opens one in
      Studio; **Open all places** opens every one not open.
- [ ] Opening a place that is open (with the plugin) opens nothing and says so.
- [ ] The universe ID comes from `gameId`, a saved answer, or the lookup, in that order; a failed
      lookup says which place and why.
- [ ] `open_place` opens a project's place, refuses a place the project does not name, and answers
      *already open*.
- [ ] `status` says which of a project's places are open.
- [ ] With `rojoHub.openPlaces` off, the panel shows no open, close or reopen actions, and
      `open_place` and the API answer that the feature is off.
- [ ] If M5 allows: **Close** closes gracefully, never killing; **Reopen** waits for the process to
      exit before opening.
- [ ] No console window appears when a place is opened.
- [ ] Unit tests cover the universe lookup and cache, the already-open check and the setting; the
      launch itself is replaced by a stub in tests (tests never open Studio). Checked live in Studio,
      recorded here.
- [ ] `docs/how-it-works.md`, the site and the MCP server's instructions describe it.

## Non-goals

- Opening places automatically (on VS Code start, or when a project starts). Studio is heavy, and
  places opened unasked are intrusive; if asked for later, it would be an opt-in setting.
- Closing or reopening from agents.
- Opening local `.rbxl`/`.rbxlx` files.
- Opening places a project file does not name.
- Force-closing Studio.

## Open questions

1. Should `open_place` be refused while another worktree holds the project's claim? Default: no.
   Opening a window disturbs no one, and the already-open check stops duplicates. (Earlier in the
   discussion this was planned as guarded; 008's rule, guard only what can pull Studio out from under
   someone, says it need not be.)
2. `open_place` without `placeId` on a project that lists several places. Default: refused, with the
   list of its places, rather than opening all of them.
3. Where the saved universe IDs live. Default: a small `universes.json` in the state folder, not
   `registry.json`, since it is a cache that can be deleted at any time.
4. How long Reopen waits for Studio to exit. Default: up to 5 minutes, then it gives up and says the
   place is still open.
