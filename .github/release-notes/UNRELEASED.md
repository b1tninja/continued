# Unreleased

Staging note for the next release. Fold it into that release's `<tag>.md` (the release job reads `.github/release-notes/<tag>.md`) and delete this file.

## New

- **Fork a session.** **Fork from here**, under each response, and **Fork session**, in a session tab's new "..." menu, copy the conversation into a new session and open it (in a new tab when session tabs are on); the original is unchanged and stays in the history. The fork keeps the history up to that point byte for byte, the mode, the model, the task list and the prompt cache record, so its first message can read the cache the original built; it does not take the plan file, Loop state, checkpoints, queued messages or the original's cost. Permission levels stay as they are in the window, IDGAF included. Before you fork, the action's tooltip (and its screen reader description) says what the fork's first message re-reads: "Fork re-reads 210k tokens ≈ $1.05; within the cache window (4 min left) ≈ $0.09"; for an earlier message the cached figure is marked as an estimate until it is measured. In the CLI, `/fork` now forks and continues in the fork instead of printing a command, and `--fork <id>` keeps the mode, model, task list and cache record instead of only the history.

## Behaviour changes

## Fixes
