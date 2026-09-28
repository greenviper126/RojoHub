# 002 — Branch workflow and project tools

Status: **implemented in 0.15.0**. Viper asked for whatever helps a user most, so the defaults
below were taken, and the card's less frequent actions moved into a ⋯ menu to make room for Build.
Tested end to end against a real Rojo 7.7 and temp git repos (not Orca, not Studio; see Testing).
Builds on 001 and on the 0.14 panel (PR #3).

## Problem

Choosing what a project serves is the thing done most often in Rojo-Hub, and it still has gaps
that Source Control does not:

- The branch picker loads every time it opens. The service runs `git worktree list`,
  `git for-each-ref` and `orca worktree list` on each request: about 0.25–0.35 s measured on
  TheLaundryShift and VluxyAI (2026-09-27), 0.22 s of which is the `orca` CLI. Then the panel
  redraws. Source Control shows its branches at once because it keeps them in memory.
- Remote branches are only as fresh as the last `git fetch`, and nothing in the panel fetches.
- A new branch or worktree has to be made elsewhere (Orca, the terminal) before it can be served.
- A `git checkout` inside a worktree that is being served can remove a folder Rojo watches. Rojo
  7.7 then panics (rojo-rbx/rojo#1305, measured in 001). The Hub already restarts it on the same
  port (`restartAfterCrash`), but the card only says *Rojo stopped unexpectedly*, and Studio has to
  reconnect.

Smaller gaps: there is no way to build a place file of the branch a project is on, no way to
filter a long project list, an error card shows only the first line of the error, and nothing says
when Studio drops its connection.

## Acceptance criteria

### Instant branch picker
- [x] The service keeps each registered repo's target list in memory and returns it without running
      git or `orca`. It refreshes the list in the background:
      - when the repo's refs or worktrees change (watching `.git/HEAD`, `.git/refs`,
        `.git/packed-refs` and `.git/worktrees`),
      - after a fetch, a new branch or a new worktree,
      - and at least every 60 s for Orca's names.
- [x] The picker opens with its list already drawn, with no spinner once the list has loaded once in
      the session. If a refresh finishes while the picker is open, the list updates in place and
      keeps the search text and scroll position.
- [x] The first request for a repo with no cached list still works. It waits for the list, as today.

### Fetch
- [x] The picker's search row has a Fetch button. It runs `git fetch --prune` on the repo and shows
      a spinner while fetching. When it finishes, the list refreshes. A failure (offline, auth)
      shows in the picker and does not close it.

### New branch or worktree
- [x] The picker has a *New branch…* row at the bottom (and *New branch "‹search›"* when the search
      matches nothing). It asks for a name and a base, which defaults to what the project serves
      now. It creates the branch and switches the project to it. (See question 3 for where the
      files live.)
- [x] Names git refuses (`git check-ref-format --branch`) and names that already exist are pointed
      out before anything is created.

### Checkout in a served worktree
- [x] When the HEAD of a worktree that a running project serves changes, the card says so plainly,
      e.g. *main was checked out in TheLaundryShift while it was served*. When Rojo crashed because
      of it, the card says so too: *Rojo restarted on the same port; reconnect Studio*. The note
      clears on the next start, stop or switch, like the Hub's other notes.
- [x] (See question 4) Optionally, when the extension sees a checkout coming from VS Code's own Git
      in a served worktree, it offers to serve that branch from a Hub copy first, so Studio stays
      connected.

### Build a place file
- [x] Each card has *Build place file…* (in a ⋯ menu, beside log and remove). It runs the pinned
      `rojo build` on exactly what the project serves (the slot file, so borrowed trees and
      Packages from the primary checkout match what Studio gets). A save dialog opens, prefilled
      with `<project>-<branch>.rbxl` in the repo's `build/` folder. On success it offers *Reveal*.

### Filter
- [x] The Projects header has a filter (search icon). Typing narrows cards by project name, branch
      or port. Workspaces with no match hide. Escape clears it. The filter is not remembered across
      reloads.

### Error detail
- [x] An error card shows up to the last 5 problem lines from Rojo's log in a monospace block, with
      *Show full log*. A single-line error looks as it does today.

### Studio disconnect notice
- [x] Optional, off by default (`rojoHub.notifyOnStudioDisconnect`). When a serving project's
      Studio connections go from one or more to zero, one window shows an information message
      naming the project. Other windows stay quiet: the message comes from the window that owns
      the service.

### Sourcemaps (see question 6)
- [x] Decided by question 6 below: either dropped, or limited to Hub views.

## Measurements (2026-09-27)

- **Picker latency, before**: `GET /slots/:id/targets` took 0.25–0.35 s on TheLaundryShift and
  VluxyAI, 0.22 s of it `orca worktree list`. **After**: served from memory; the e2e test asserts
  under 200 ms including HTTP, and the panel draws its last list before the answer arrives. On the
  live 0.15.0 service: about 1 ms for TheLaundryShift, VluxyAI and VluxySF.
- **Watching .git on Windows**: a recursive `fs.watch` on a clone's `.git` reported a new branch,
  `git fetch`, `git pack-refs`, `git worktree add` and a checkout in a linked worktree, each within
  ~30 ms. Relevant names: `HEAD`, `packed-refs`, `refs/…`, `worktrees/<name>[/HEAD]`; everything else
  (`index`, `logs/`, `objects/`, `*.lock`, `FETCH_HEAD`, `ORIG_HEAD`, `AUTO_MERGE`) is ignored,
  because VS Code's own `git status` rewrites the index constantly.
- **VS Code's Git API**: not measured in a running VS Code. Its API has no event before a checkout
  (only `onDidChange` after state changes), and git itself updates the working tree before HEAD,
  so "offer first" was not built. The after-the-fact note is.
- **`orca worktree create`**: probed on RojoHub's own repo (then removed with `orca worktree rm`):
  1.6 s with `--setup skip`; the answer's `result.worktree.path` is where it went, and the branch
  is `refs/heads/<git user>/<name>`, not `<name>`. Orca's CLI cannot remove a repo, so no throwaway
  repo was registered in Orca.

## Measurements planned before building

1. Picker latency before and after, from click to list drawn (panel timing plus service timing).
2. How big a `.git/refs` watch is on Windows for TheLaundryShift (count of refs and worktrees),
   and whether `fs.watch` with `recursive` fires for packed-refs rewrites and for `git fetch`.
3. Whether VS Code's Git extension API (`vscode.git`, `getAPI(1)`) reports a checkout *before* the
   working tree changes. If it only reports after, question 4's "offer first" cannot work, and only
   the after-the-fact note is built.
4. `orca worktree create --json` output shape, and how long it takes with `--setup skip`.

## Non-goals

- Automatic background `git fetch` (Source Control's `git.autofetch`), unless question 2 says
  otherwise.
- Deleting or renaming branches from the panel.
- Merging, pulling or pushing from the panel.
- Anything that restarts a running rojo during a switch (001's rule stands).

## Testing

- `npm test`: 30 tests. The new e2e test drives the real service: the list is read in the
  background after registering and comes back in under 200 ms; a branch made with plain git shows
  up by itself; Fetch lists a branch pushed to the remote since; New branch refuses a bad name, an
  existing branch and a missing base, then makes `<repo>-worktrees/feat-new-thing` on
  `feat/new-thing` and switches to it; Build writes a place file while stopped; a checkout in the
  served worktree is noted, the label follows it, and Rojo keeps running.
- Unit tests for the `.git` change filter and for reading a primary and a linked worktree's HEAD.
- The panel (picker with Fetch, New branch form, ⋯ menu, filter, error detail) was screenshot in
  headless Chrome with `tools/panel-preview.html`.
- **Not tried**: New branch through Orca end to end (only the CLI probe above), a fetch that needs
  credentials, the disconnect notice with a real Studio, anything in a real Studio.

## Design questions (answered: defaults taken)

1. **Picker cache scope.** **The service holds the cache**, so every window shares it and it
   survives window reloads. The panel also redraws its last list at once while asking for a fresh
   one.
2. **Fetching.** **A manual Fetch button only.** Alternative: also fetch in the background every
   N minutes, behind a setting that is off by default.
3. **Where a new branch lives.** **A new Orca worktree** (`orca worktree create --repo path:<repo>
   --name <name> --base-branch <base> --setup skip`), so it is editable and shows up in Orca, and
   the project then serves it in place. When Orca is not installed, fall back to a plain local
   branch served from a Hub copy (read-only). Alternative: always a plain local branch.
4. **Checkout in a served worktree.** **Only the clearer note after the fact.** The offer-first
   version is added only if measurement 3 shows VS Code's Git API reports checkouts in time.
5. **Build output.** **A save dialog prefilled with `build/<project>-<branch>.rbxl`.** Alternative:
   write there without asking, and offer *Reveal*.
6. **Sourcemaps.** I suggested this earlier, but looking closer it is weaker than I made it sound.
   luau-lsp maps the folder you have open and edit, not the branch Studio is served. TheLaundryShift
   already has a `sourcemap.json` (gitignored), and the luau-lsp extension can autogenerate one.
   A Hub view is a read-only snapshot you don't edit. **Drop it from this spec.**
7. **Disconnect notice.** **Off by default**, as a setting. Alternative: on by default.
8. **Order of work.** **Picker cache and Fetch first (one release), then New branch, then the
   checkout note, then Build, Filter, error detail and the notice.**
