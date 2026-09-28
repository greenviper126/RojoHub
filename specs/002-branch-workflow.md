# 002 — Branch workflow and project tools

Status: **draft, waiting on Viper's answers to the design questions below**. Builds on 001 and on
the 0.14 panel (PR #3).

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
- [ ] The service keeps each registered repo's target list in memory and returns it without running
      git or `orca`. It refreshes the list in the background:
      - when the repo's refs or worktrees change (watching `.git/HEAD`, `.git/refs`,
        `.git/packed-refs` and `.git/worktrees`),
      - after a fetch, a new branch or a new worktree,
      - and at least every 60 s for Orca's names.
- [ ] The picker opens with its list already drawn, with no spinner once the list has loaded once in
      the session. If a refresh finishes while the picker is open, the list updates in place and
      keeps the search text and scroll position.
- [ ] The first request for a repo with no cached list still works. It waits for the list, as today.

### Fetch
- [ ] The picker's search row has a Fetch button. It runs `git fetch --prune` on the repo and shows
      a spinner while fetching. When it finishes, the list refreshes. A failure (offline, auth)
      shows in the picker and does not close it.

### New branch or worktree
- [ ] The picker has a *New branch…* row at the bottom (and *New branch "‹search›"* when the search
      matches nothing). It asks for a name and a base, which defaults to what the project serves
      now. It creates the branch and switches the project to it. (See question 3 for where the
      files live.)
- [ ] Names git refuses (`git check-ref-format --branch`) and names that already exist are pointed
      out before anything is created.

### Checkout in a served worktree
- [ ] When the HEAD of a worktree that a running project serves changes, the card says so plainly,
      e.g. *main was checked out in TheLaundryShift while it was served*. When Rojo crashed because
      of it, the card says so too: *Rojo restarted on the same port; reconnect Studio*. The note
      clears on the next start, stop or switch, like the Hub's other notes.
- [ ] (See question 4) Optionally, when the extension sees a checkout coming from VS Code's own Git
      in a served worktree, it offers to serve that branch from a Hub copy first, so Studio stays
      connected.

### Build a place file
- [ ] Each card has *Build place file…* (in a ⋯ menu, beside log and remove). It runs the pinned
      `rojo build` on exactly what the project serves (the slot file, so borrowed trees and
      Packages from the primary checkout match what Studio gets). A save dialog opens, prefilled
      with `<project>-<branch>.rbxl` in the repo's `build/` folder. On success it offers *Reveal*.

### Filter
- [ ] The Projects header has a filter (search icon). Typing narrows cards by project name, branch
      or port. Workspaces with no match hide. Escape clears it. The filter is not remembered across
      reloads.

### Error detail
- [ ] An error card shows up to the last 5 problem lines from Rojo's log in a monospace block, with
      *Show full log*. A single-line error looks as it does today.

### Studio disconnect notice
- [ ] Optional, off by default (`rojoHub.notifyOnStudioDisconnect`). When a serving project's
      Studio connections go from one or more to zero, one window shows an information message
      naming the project. Other windows stay quiet: the message comes from the window that owns
      the service.

### Sourcemaps (see question 6)
- [ ] Decided by question 6 below: either dropped, or limited to Hub views.

## Measurements to take before building

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

## Design questions (defaults in bold)

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
