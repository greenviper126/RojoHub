# 017: Versioned documentation

## Problem

The docs site describes only the newest Rojo-Hub. Someone still on a released version (0.21.0 today)
reads pages that describe tools, settings and panel items their install does not have. The 0.22 line
changes a lot at once, so the release of it must keep the last release's docs readable.

## Acceptance criteria

1. The docs of the last released version stay on the site under `/v0.21/`: the same pages as v0.21.0
   (home, guide, reference, troubleshooting, changelog), taken from `git show v0.21.0:site/...`, with
   only their links and a notice changed.
2. A version menu in the nav switches between "0.22.13 (latest)" and "0.21.0". Each side keeps its own
   nav and sidebar, so a reader never lands on the other version's page by clicking Guide or Reference.
3. Every page under `/v0.21/` says which version it describes and links to the current docs.
4. The frozen pages are not edited again (only links and the notice differ from the tag). Screenshots
   are shared with the current site (`site/public/images` did not change since v0.21.0).
5. `npm run docs:build` passes, including VitePress's dead-link check.
6. The release steps in `CLAUDE.md` name where the version menu and the frozen copy live, so the
   next release freezes 0.22's docs the same way.

## Non-goals

- Versioning every release: only the last released version is kept, and a later release adds its own
  frozen copy.
- Rewriting the current pages for 0.22 beyond what earlier rounds did (`site/guide/agents.md`,
  `settings.md`, `changelog.md` are current; a full read-through is a separate pass).

## Design

VitePress `locales` give each prefix its own nav, sidebar and title, and put a menu in the nav; the
menu is labelled "Version", and the locale labels are the versions. The version number is the label of
the root locale in `site/.vitepress/config.mts` (bumped with each release, as before).
