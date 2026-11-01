# Review of the 2026-10-24 feedback log (Opus)

Review only. Nothing was changed or fixed. Written by an Opus subagent that read CLAUDE.md, the log
(`specs/feedback-2026-10-24.md`), specs 010 and 008, and `mcp.ts`, `hub.ts`, `sourcemap.ts`,
`project.ts`, `client.ts`, `main.ts`, `plugin/RojoHub/init.lua`, `package.json`. Its code claims have
not been re-checked by a second reader; verify before building on them.

Stance applied: give agents a lot of control; anything dangerous is off by default and turned on by
a human setting.

## 1. Verdict per item

1. **KEEP.** Service starts only from the extension and exits after 15 min idle (`IDLE_EXIT_MS` in
   `main.ts`). Launcher problems: needs a runtime (Node may be absent, so use Code.exe with
   `ELECTRON_RUN_AS_NODE`), must find the newest installed `dist/service.js`, must never start an older
   service. `rojohub.mjs` is not in the repo, so unchecked.
2. **KEEP.** Strings existing calls together. `open_place` inside it stays behind `rojoHub.openPlaces`.
3. **DROP / park.** Studio MCP already has `get_studio_state`. Rojo does not sync into a play
   DataModel, the plugin acts only under `RunService:IsEdit()`, and no job in the log needs a queue.
4. **NEEDS-DECISION, lean DROP.** Duplicates `execute_luau`. Plugins cannot use loadstring, so it would
   write a ModuleScript into the place and require it, leaving instances behind. If kept, toggle it.
5. **KEEP (small).** Claim correct (1 s restart, gives up after 5 crashes in 60 s). `status` already
   prints `sourcemap.json: <detail>` (mcp.ts:860), but only while serving. Add the 30 s retry.
6. **MERGE with 15; mostly done.** Almost certainly rojo#1305 from a checkout in the main checkout.
   `hub.ts` already detects a checkout within 120 s, explains it, restarts rojo (`restartAfterCrash`),
   and the plugin hides the restart (spec 010 design 2). Docs plus a repro, not a fix.
7. **KEEP**, merged with 16.
8. **KEEP, spec first.** The log missed ordering: run setup commands *before* the first switch to the
   new worktree (`createBranch` switches right after `worktree add`). `wally install` clears Packages,
   and deleting a watched subfolder crashes rojo. Missing Packages in a worktree are already borrowed
   from the main checkout (`project.ts` `PACKAGE_PATHS`), so Wally is mostly for luau-lsp and tests.
9. **KEEP.** `new_branch` never fetches. Correction: the default base is the served branch
   (`slot.branch ?? "HEAD"`), not main; stale main only when `base: "main"` is passed. Fetch only that
   remote, short timeout, fall back quietly offline. Use `origin/<base>` only when local is strictly
   behind; if diverged keep local and warn. Orca path passes `base` to Orca; not checked whether Orca fetches.
10. **MERGE with 2 and 8.** `ensure` reports what is missing; checks come from per-project config.
11. **NEEDS-DECISION.** "Renew while synced" lets a dead agent hold a project forever (a place stays
    synced). Default suggestion: flat 30 min plus a release button in the panel.
12. **KEEP (tiny).** Correct: `claimOf` deletes expired claims, so release says "was not claimed".
13. **KEEP, later.** Log partly wrong: the queue exists (`queues`, `wait`, "Waiters are served in
    order"). Only `then_return` is new.
14. **NEEDS-DECISION. The log's design is wrong.** "Serve a placeholder, run, serve back" protects
    nothing: rojo never unwatches, and M2 shows a folder served earlier in the session still crashes it.
    The only working guard is stop, run, start (a restart, hidden by the plugin's hold of up to 60 s
    while the service reports `restarting`). That makes it dangerous. Better to avoid the case via
    item 8's ordering and by switching with `new_branch` or the picker.
15. **MERGE into 6.** Auto-restart and hidden reconnect exist. Left: `serve_here`/`switch` should say
    when a crash and restart happened during their settle time, then `wait_for_studio`.
16. **MERGE into 7.**
17. **MERGE into 1.** Launcher beats a CLI.
18. **MERGE into 2.**
19. **NEEDS-DECISION, park.** Runs repo code at plugin security; riskiest item. Some value given the
    rule that Studio loads a changed local plugin only when a place opens.
20. **MERGE into 2.** Smoke and screenshot stay with the Studio MCP.
21. **KEEP as a policy, not a feature.** Rojo-Hub cannot gate the Studio MCP's `start_stop_play`.

## 2. Proposed order

- **A, 0.21.x small and sure:** 12, 9, 5, plus the crash note from 15 in `serve_here`'s answer.
- **B, agent ergonomics, one spec:** 1+17, 2+18+20+10 (no install checks yet), 7+16. JSON goes in MCP
  `structuredContent`.
- **C, claims:** 11, then 13 (`then_return`).
- **D, per-project setup config, one spec:** 8, install checks for 10, and 14 only if you want the restart toggle.
- **E, Studio-side, only if wanted:** 19, and 4 if not dropped, with 21 as the rule. Drop 3.

## 3. Dangerous capabilities

Every toggle: off by default, `scope: "application"` (as `rojoHub.openPlaces` already is), so a repo's
`.vscode/settings.json` cannot turn it on.

| Capability | Why dangerous | Toggle (default off) | Extra guards |
|---|---|---|---|
| Setup/install commands (8) | Runs any shell command | `rojoHub.setupCommands` (per repo path, user settings or service home, never read from the repo) | Runs before first serve; argv form, no agent text interpolated; timeout; output tail in answer; audit log in `%LOCALAPPDATA%\RojoHub` |
| Stop, run, start guard (14) | Restarts rojo, new session | `rojoHub.agents.allowRestart` | Only setup commands and git; sets `restarting` so plugin holds; 60 s ceiling |
| run_in_studio (4) | Arbitrary Luau in user's Studio | `rojoHub.agents.runLuau` | Per-place allowlist; Edit mode only; timeout; audit log; feature detection (old plugins lack it) |
| Plugin dev host (19) | Repo code at plugin security | `rojoHub.pluginDevHost` (project list) | Per project; unload on stop; errors contained |
| Open places | Opens Studio windows | `rojoHub.openPlaces` (exists) | none |
| Playtest/publish | Changes live state | Don't build | none |
| Launcher auto-start (1) | Low risk | none | Never start an older service version |

### 3b. Yolo mode (item 22, from Viper, not reviewed by Opus)

One master switch, `rojoHub.yolo`, that turns on every agent capability in the table above at once
and lifts the existing guards, so an agent can do everything the extension can. Labelled
**DANGEROUS** and shown red wherever VS Code allows it.

Proposed shape (defaults in brackets, for Viper to change):
- **Setting:** `rojoHub.yolo`, boolean, default off, `scope: "application"`. No MCP verb can turn it
  on or off, and a repo's `.vscode/settings.json` cannot. Only a human, in VS Code.
- **Covers:** `setupCommands`, `allowRestart`, `runLuau`, `pluginDevHost`, `openPlaces`, and the
  guards that exist today: `stop`/`stop_all`/`remove_project` stop refusing when Studio is synced
  (as if `force` were always passed). **Claims still hold** (decided): yolo lifts the toggles, not
  other agents' protection, so a stop or remove of a project another agent claimed is still refused.
- **Does not cover** (decided): things that destroy work outside Rojo-Hub's own state: deleting
  worktrees or branches with uncommitted changes, and playtest/publish (still not built).
- **Red:** a status bar item with `statusBarItem.errorBackground` and the text "ROJO-HUB YOLO"; a
  red banner at the top of the panel; the setting's description starts "DANGEROUS:". VS Code
  settings UI cannot colour a setting, so the banner and status bar carry the red.
- **Turning it on:** a modal confirmation listing what it allows [yes]. Editing settings.json
  directly skips the modal, so the status bar and banner appear either way.
- **No auto-off** (decided): yolo stays on until a human switches it off. The red status bar item
  and panel banner are the reminder.
- **Visible to agents:** `status` says "yolo mode is ON" so an agent knows what it may do; every
  action taken under yolo is written to the audit log.
- **Individual toggles stay.** Yolo is the shortcut, not a replacement, so a user can enable just
  `setupCommands`.

Decided by Viper (2026-10-25):
6. Yolo does not ignore claims; they still hold.
7. No auto-off.
8. Worktree/branch deletion stays outside yolo.

## 4. What the log missed or got wrong

- Item 14's placeholder idea conflicts with the measurement rules (M2, "never unwatches"). Item 8
  conflicts too unless commands run before the switch.
- Running installs in the main checkout is a hazard: worktrees borrow its Packages, so `wally install`
  there can crash every rojo that borrows them.
- Items 6 and 15 are largely implemented already; the log treats them as open.
- The queue for 13 already exists.
- **Stance conflict with tools that exist today:** `stop`, `start`, `stop_all` and `remove_project`
  already restart or disconnect Studio with no toggle, guarded only by claims, the synced-place check,
  and an honour-system `force`. Decide whether stop/force move behind `allowRestart`.
- "An optional message needs no protocol bump" is true but not enough: open places keep the old plugin
  until reopened, so any new Studio-side verb needs a capability flag in `hello`.

## Questions for Viper

1. Item 11: flat 30 min plus a panel release button (suggested), or something else?
2. Item 14: drop it, or build it behind `allowRestart`?
3. Existing `stop`/`stop_all`/`force`: gate them behind a toggle?
4. Items 4 and 19: drop, or keep behind toggles for a later spec?
5. Item 3: drop (suggested)?

### Answers from Viper (2026-10-25)

- Item 4: drop; agents use the Roblox Studio MCP for running Luau.
- Item 11: do it; hold 15 minutes, agents must keep re-requesting (open: whether any Rojo-Hub call
  from the worktree renews it, as today, or only serve_here/switch).
- Item 14: do not build. Document that stop, checkout and install, then start is bad practice.
- Item 19: do it, off by default (`rojoHub.pluginDevHost`, application scope, per-project list),
  labelled potentially dangerous in the setting description and the panel. Needs its own spec
  (group E); covered by yolo.
- Items 3 (drop) and the `stop`/`force` gating: not yet answered.

### Decided 2026-10-25 (Viper: "do what makes the most sense for user experience")

- Item 3: dropped. The Studio MCP's `get_studio_state` covers play state; no job needs a queue.
- `stop`/`force`: not gated. Claims and the synced-place refusal already protect other agents and
  Studio; another toggle would only add friction. Yolo still lifts the synced-place refusal.
- Spec 011's open questions: all defaults kept.
- Rojo-Hub's own URL entry is rewritten to the stdio launcher at every service start. Someone who
  wants the URL form keeps it under another name (documented); a `rojohub` URL entry is taken as
  an older install.
- Next: group D (per-project setup commands, install checks in `ensure`) with yolo (item 22), since
  D adds the first toggle; group C's `then_return` alongside. Group E (plugin dev host) after.
