#!/usr/bin/env sh
# Commit all work in progress in THIS worktree and push the current branch to origin.
# Call it every few minutes: a session restart then loses nothing. Never uses `git stash`.
#   scripts/agents/checkpoint.sh [message]      (default message: "wip: checkpoint <UTC time>")
#   CHECKPOINT_REMOTE=origin   remote to push to
#   CHECKPOINT_NO_PUSH=1       commit only (used by the tests)
# Refuses on main/master and on a detached HEAD. The WIP commit skips the husky pre-commit
# (prettier) so a formatter failure can never cost the checkpoint; run prettier before the real
# commit or let CI tell you. Squash `wip:` commits before the PR is merged.
set -eu

remote="${CHECKPOINT_REMOTE:-origin}"
branch="$(git symbolic-ref --quiet --short HEAD || true)"
case "$branch" in
  "") echo "checkpoint: detached HEAD, refusing (create a branch first)" >&2; exit 2 ;;
  main|master) echo "checkpoint: refusing on $branch (use a feature branch)" >&2; exit 2 ;;
esac

msg="${1:-wip: checkpoint $(date -u +%Y-%m-%dT%H:%M:%SZ)}"
case "$msg" in wip:*) ;; *) msg="wip: $msg" ;; esac

git add -A
if git diff --cached --quiet; then
  echo "checkpoint: nothing new to commit on $branch"
else
  HUSKY=0 git commit -q --no-verify -m "$msg"
  echo "checkpoint: committed $(git rev-parse --short HEAD) on $branch"
fi

if [ "${CHECKPOINT_NO_PUSH:-0}" = 1 ]; then exit 0; fi
git push -q -u "$remote" "HEAD:refs/heads/$branch"
echo "checkpoint: pushed $branch to $remote"
