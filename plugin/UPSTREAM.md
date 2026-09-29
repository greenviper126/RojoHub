# Upstream

This folder is Rojo's Studio plugin, changed so that Rojo-Hub can connect it by itself (spec 007).

- Source: https://github.com/rojo-rbx/rojo, tag `v7.7.0` (commit
  `bcadc97de27ab3800e915abcb72c6c7a3c30f363`), folder `plugin/`.
- Licence: MPL-2.0 (`LICENSE`, Rojo's `LICENSE.txt`). Every file taken from Rojo stays under it,
  changed or not. Files Rojo-Hub adds are MIT, like the rest of this repository, and say so at the
  top.
- `Packages/` holds the plugin's dependencies, which upstream keeps as git submodules, copied at the
  commits upstream pins, each with its own licence. Only the folder each package's
  `default.project.json` builds is kept. TestEZ is left out: upstream uses it only in dev builds.
- `default.project.json` is upstream's `plugin.project.json` with paths made relative to this folder,
  `*.spec.lua` left out of the build, and the Creator Store upload details dropped.

## Changes to upstream files

Kept to a minimum so moving to a new Rojo release is a merge. Everything Rojo-Hub adds lives in
`src/RojoHub/`. Each change to an upstream file is listed here.

(none yet)

## Moving to a new Rojo release

1. Check out the new tag of rojo-rbx/rojo with its submodules.
2. Diff its `plugin/` against the tag above, and apply that diff here (`src`, `log`, `http`, `fmt`,
   `rbx_dom_lua`, `Version.txt`, and each package at its new submodule commit).
3. Re-apply the changes listed above where the diff touched them.
4. Update the tag and commit here, and check `protocolVersion` in `src/Config.lua`: a new protocol
   means the service must refuse projects pinning older rojo (spec 007).
