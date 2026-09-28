# 005 — Project files

Status: **implemented in 0.17.0**. Asked for by Viper: "what if i want to run on a specific rojo json
file? i specifically need this for testing libraries im making which can have muliple. in all cases
those files would be dirrectly under the folder." And: "id like a way to manually set the json to
read and it defaults to the normal json you auto look for but it will remember if i change it to
another json instead."

## Problem

Rojo-Hub always serves `default.project.json`. A library usually has more than one project file:
`default.project.json` builds the library as a model, and a file such as `test.project.json` builds a
place with the library and its tests in it. That second file is the one to serve to Studio while
working on the library, and Rojo-Hub had no way to choose it. A folder with only a
`test.project.json` could not be added at all.

The service already kept a `projectFile` per project (001) and used it everywhere it serves, builds
and writes sourcemaps. Only adding a project assumed `default.project.json`, and nothing could change
it afterwards.

## Acceptance criteria

- [x] Each project has a project file, one of the `*.project.json` files directly in its folder. It
      starts as `default.project.json` and is saved with the project, so a change survives restarts,
      updates and new windows.
- [x] Adding a folder uses `default.project.json` when there is one, without asking. With no
      `default.project.json`, a folder with one `*.project.json` uses that file, and a folder with
      several asks which one. A folder with none is refused, naming what it looked for.
- [x] *Project file…* in the card's ⋯ menu and in the project's quick pick lists the folder's
      `*.project.json` files with the current one marked, and changes it.
- [x] Changing it on a stopped project only saves it. On a serving project it asks first, since Rojo
      reads the project name, `servePort` and place IDs once per session (001): Rojo is restarted on
      the new file, and Studio reconnects. This is the one deliberate exception to "switching never
      restarts rojo", because it is not a switch.
- [x] The project takes the new file's `name`. The change is refused when another project already
      has that name, since Studio auto-connects by name, the same rule as adding.
- [x] The port stays unless the new file sets `servePort` (or the old one did): ports come from the
      repo's first commit, not the file.
- [x] `sourcemap.json`, Build place file and the served tree all follow the chosen file.
- [x] A card whose file is not `default.project.json` shows the file's name (`test` for
      `test.project.json`) beside the project's name.
- [x] A worktree or branch without the chosen file shows the usual "has no test.project.json" error
      on the card. The choice stays.
- [x] The service only accepts a bare `*.project.json` file name, never a path.

## Non-goals

- Project files in subfolders. The request is for files directly in the folder.
- Serving two files of one folder at the same time. The service still accepts that (one project per
  folder and file), but nothing in the UI adds a second one.
- Changing the file without restarting Rojo. A new name or `servePort` needs a new session anyway.
