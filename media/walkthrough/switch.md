# Switch branches live

Click a project and choose **Switch Branch…**. The list shows:

- **Worktrees**: every git worktree of the project, under Orca's names. They're served in place, so edits made there (by you or an agent) reach Studio live.
- **Branches**: every other branch. Rojo-Hub checks it out into a folder of its own and serves that.

Switching doesn't restart Rojo. The same session keeps running and Studio receives just the difference, so it stays connected.

If a worktree hasn't installed its Wally packages, Rojo-Hub borrows `Packages` from the main checkout and shows a warning, especially when the branch changed `wally.toml`.
