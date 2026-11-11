# Agent worktree scripts

Scripts for agents that work in their own `git worktree`. Node only, no dependencies; tests run
with `node --test "scripts/agents/*.test.mjs"` and need no network (a fake `git`/`gh` seam).

| Script                   | What it does                                                             |
| ------------------------ | ------------------------------------------------------------------------ |
| `checkpoint.sh`          | Commit and push work in progress.                                        |
| `stash-guard.sh`         | Block `git stash` (see `install-stash-guard.sh`).                        |
| `worktree-bootstrap.mjs` | Install only the package sets you need into one worktree.                |
| `worktree-reap.mjs`      | List stale worktrees and remove the safe ones. Dry run unless `--apply`. |

## Why these exist (incidents, week of 2026-11-04)

- Every worktree under `D:/temp/wt-*` carried a full `npm ci`, about 1 GB or more each. `D:` fell
  to 53 MB free and was cleaned by hand to 17 GB.
- Worktrees that pointed `node_modules` at a sibling's install with a junction got stale, empty or
  mismatched dependencies. An `npm ci` run through a junction emptied the other worktree's
  `node_modules`. One junction target had prettier 3.5.3 while CI uses 3.9.10.
- `git worktree remove`, or any recursive delete that follows a junction, can wipe the target.
- `jq` is not installed on the dev machine, so scripts that call it fail there.
- Agents re-sent an identical hand-back after their PR had merged.

## Rules

1. **One install per worktree, and only what you need.** Run
   `node scripts/agents/worktree-bootstrap.mjs <worktree> --only root core` (sets: `root`, `core`,
   `gui`, `cli`, `packages`). It runs `npm ci --ignore-scripts` with the shared npm cache, checks
   prettier and eslint against `package-lock.json`, and prints the disk used.
2. **Never install through a junction or symlink, and never share a `node_modules` by link.** The
   bootstrap refuses a target whose `node_modules` is a link. If you find one, remove the link
   only (`cmd /c rmdir <link>` or `fs.rmdirSync`, never a recursive delete) and install properly.
3. **Delete `node_modules` when you are done** with the worktree. Format with the lockfile's
   prettier (3.9.10), never a sibling's.
4. **Clean up with the reaper, not by hand.** `node scripts/agents/worktree-reap.mjs --root D:/temp`
   prints a table and deletes nothing. A worktree is SAFE only when its branch is fully pushed, its
   PR is merged or closed, the tree is clean and no process mentions its path. `--apply` is a
   separate, explicit decision; it removes links link-only, deletes real `node_modules`, then runs
   `git worktree remove` without `--force`. Without `gh` the PR check is skipped with a warning and
   the branch must instead be merged into `origin/main`.
5. **`jq` is missing: use `gh --jq`** (`gh pr view N --json state --jq .state`). Scripts and notes
   must not assume `jq`.
6. **Report once and stop after your PR merges.** Do not re-send a hand-back that was already
   delivered; check `gh pr view` first.

`scripts/ci/worktree-hygiene.mjs` stays a read-only report (ancestry only); the reaper adds the PR
and push checks and does the removal.
