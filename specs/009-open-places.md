# 009 — Open places in Studio

Status: **draft, measured** (branch `feat/open-places`). Asked for by Viper: "is there a way to auto open place
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
   is kept for good, in `universes.json` in the state folder (a cache: deleting it only costs a
   lookup).
3. Else `GET https://apis.roblox.com/universes/v1/places/<place>/universe` (public, no sign-in, M2),
   and the answer is saved.

Viper: "you think method 1 by itself is good enough? id assume the agent could always try again
anyway". So there is no fallback when the lookup fails (not even the plugin's `GameId`): opening a
cloud place needs the internet anyway, and the error says which place and why, so a retry is the
obvious next step.

The link is handed to Windows without a console window (M3).

**Never opened twice.** Viper: "if a place is already open do not re-open. we only want to open if
its not already open". Studio opens a second copy of a place that is already open (M4), so the
service checks two things first, and opens nothing if either finds the place:

1. The Studio places its plugins report (007). This sees a place however it was opened, once its
   plugin has loaded.
2. The command lines of the running `RobloxStudioBeta` processes (M5). A place opened by the link
   carries `placeId:<place>` in its command line from the moment Studio starts, so this also
   covers the seconds before the plugin connects (a second click on Open, or two agents at once) and
   a Studio whose Rojo-Hub plugin is off.

Opens of the same place are also serialized in the service, so two requests in the same instant
cannot both pass the check. The answer is *already open* (with the place's name), never an error.

Not covered: a place opened another way (Studio's start page, a local copy) whose plugin is off or
not loaded yet; its command line may not carry the place ID (not measured).

Only places a project names can be opened: its `servePlaceIds` and `placeId`, never
`blockedPlaceIds`, never an arbitrary ID.

### Closing and reopening (panel only)

- **Close** asks Studio's window to close, the same as its X, so Studio still asks about unsaved
  changes (or publishing). It never kills the process: losing someone's unsaved work is the worst
  thing this feature could do.
- **Reopen** closes, waits until that Studio process has exited (the user may be answering Studio's
  prompt; the panel shows *closing…*), then opens the place again. It waits up to 5 minutes, then
  gives up and says the place is still open. It is the answer to "open places
  still run an older plugin".
- Which process has which place comes from its command line (M5). Only such a process is closed. A
  place that is open but not found that way (opened from Studio's start page, say) shows no Close or
  Reopen; its row says to close it in Studio. The window title is never used: two places can share a
  name.

### The panel

Spec 007 left out a per-project place list (the Studio places section lists open places only). This
feature needs one: each project card lists the places its project file names, each with whether it
is open, and **Open** (or **Close** and **Reopen** while open). The project's menu gets
**Open all places**, which opens every listed place not already open.

### Agents

`open_place` (MCP) opens one of a project's places, through the same service code as the panel.
It takes the project (as the other tools do) and `placeId`, which may be left out when the project
lists one place; with several, the call is refused and lists them. It is in 008's *safe* group: it
opens a window and disturbs no one (never a second copy), so no claim is needed. It answers *already open*, *opened* (then the agent calls `wait_for_studio`), or the error.

Agents get no close or reopen: the window may be one the user is working in, an agent cannot answer
Studio's save prompt for them, and another agent may be using the place. `status` says, for each
place a project names, whether it is open, so an agent knows whether to open one.

### The setting

`rojoHub.openPlaces`, **off by default**. Viper: "lets also be default not allow this to do anything
and then you need to turn a setting on so the user and mcp can auto open places." Application scope
like the other service settings, sent with them and saved in the service's `settings.json`. Until it
is turned on, the feature does nothing, for the user and agents alike:

- The panel hides Open, Close, Reopen and *Open all places* (hidden, not greyed out, so nothing looks
  broken).
- `open_place` stays listed, and every call answers that opening places is turned off in Rojo-Hub's
  settings (`rojoHub.openPlaces`). An agent's tool list is usually fixed when it starts, so hiding the
  tool would not reach running agents; the error does, and says why.
- The service's API refuses too, so the panel and the MCP cannot disagree.

## Measurements

Done on 2026-09-29. M1 and M2 by Viper from PowerShell, on TheLaundryShift's first place
(`122634966546108`, universe `9465257577`). M3 to M7 from this branch's session on "Rojo-Hub Test1"
(`108404263554868`, universe `10768528004`), a place made for testing (007), in Studio
version-6b0e880a1a144428 with the 0.19.7 plugin installed.

- **M1 The link needs the universe ID.** `roblox-studio:1+launchmode:edit+task:EditPlace+placeId:<place>`
  opened Studio with "We could not open the place [0]. Error fetching latest place version". With
  `+universeId:9465257577` added, the place opened for editing. Studio's executable with
  `-task EditPlace` was not tried: the link does not need the executable's path, which changes with
  every Studio update.
- **M2 The lookup.** `apis.roblox.com/universes/v1/places/<place>/universe` answered
  `{"universeId": 9465257577}` for both of TheLaundryShift's places, and `10768528004` for Test1,
  without signing in.
- **M3 Launching.** `explorer.exe <link>` from PowerShell opened Test1 for editing. Whether a console
  window flashes when the service (which has no console) does the same is checked when built.
- **M4 Already open: Studio opens a second copy.** Launching Test1's link while it was open started a
  second `RobloxStudioBeta` process with the same title. Hence the check before opening.
- **M5 Each place is its own process, and the link is in its command line.** The process's command
  line was `"...\RobloxStudioBeta.exe" roblox-studio:1+launchmode:edit+task:EditPlace+placeId:108404263554868+universeId:10768528004`,
  its window title `Rojo-Hub Test1 - Roblox Studio`. The service's `studioPlaces` listed Test1
  (plugin 0.19.7) although no project names it. Not measured: the command line of a place opened from
  Studio's start page, and what a playtest adds.
- **M6 A graceful close.** `CloseMainWindow` on the duplicate (nothing changed in it) closed it with
  no prompt, in under 10 s; the other copy stayed open. Not measured: a place with unsaved changes,
  and Team Create.
- **M7 A place's name.** `economy.roblox.com/v2/assets/<place>/details` answered `Name: Rojo-Hub Test1`
  without signing in (`games.roblox.com/v1/games` gave `[TITLE UNAVAILABLE]`). The panel shows the
  name the plugin reported when there is one, else this lookup's (saved with the universe ID), else
  the place ID.

## Acceptance criteria

- [ ] `rojoHub.openPlaces` is off by default. While off, the panel shows no open, close or reopen
      actions, and `open_place` and the API answer that the feature is off and name the setting.
- [ ] The panel lists each project's places with whether they are open, and **Open** opens one in
      Studio; **Open all places** opens every one not open.
- [ ] A place that is open, found by its plugin or by a Studio command line, is never opened again;
      the answer is *already open*. Two opens of one place at once open it once.
- [ ] The universe ID comes from `gameId`, a saved answer, or the lookup, in that order; a failed
      lookup says which place and why.
- [ ] `open_place` opens a project's place, refuses a place the project does not name, and refuses a
      missing `placeId` on a project with several places, listing them.
- [ ] `status` says which of a project's places are open.
- [ ] **Close** closes gracefully, never killing, and only a process whose command line names the
      place; **Reopen** waits for it to exit (up to 5 minutes) before opening.
- [ ] No console window appears when a place is opened.
- [ ] Unit tests cover the universe lookup and cache, both already-open checks and the setting; the
      launch and the process list are stubbed in tests (tests never open Studio). Checked live in
      Studio, recorded here.
- [ ] `docs/how-it-works.md`, the site and the MCP server's instructions describe it.

## Non-goals

- Opening places automatically (on VS Code start, or when a project starts). Studio is heavy, and
  places opened unasked are intrusive; if asked for later, it would be an opt-in setting.
- Closing or reopening from agents.
- Opening local `.rbxl`/`.rbxlx` files.
- Opening places a project file does not name.
- Force-closing Studio.

## Decided

Viper: "just do whatever makes the most sense".

1. `open_place` needs no claim: it opens a window and never a second copy, so it disturbs no one
   (008's rule: guard only what can pull Studio out from under someone).
2. `open_place` without `placeId` on a project with several places is refused, listing them.
3. Saved universe IDs (and names) live in `universes.json` in the state folder, a cache.
4. Reopen waits up to 5 minutes for Studio to exit.
