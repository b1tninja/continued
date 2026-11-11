#!/usr/bin/env sh
# git `reference-transaction` hook: refuses any update of refs/stash.
# refs/stash is shared by every worktree of the repository and git has no stash hook, but this
# hook runs for every ref update, so a push to refs/stash (git stash, `git stash store`,
# lint-staged's backup stash) aborts in the "prepared" phase and the working tree is left alone.
# Override for one command, only when you own the whole stash list: GIT_ALLOW_STASH=1 git stash ...
# Install into this worktree's effective hooks dir: sh scripts/agents/install-stash-guard.sh
[ "$1" = prepared ] || exit 0
[ "${GIT_ALLOW_STASH:-0}" = 1 ] && exit 0
while read -r _old _new ref; do
  if [ "$ref" = refs/stash ]; then
    echo "stash-guard: refs/stash is shared by all worktrees; commit WIP instead (scripts/agents/checkpoint.sh)." >&2
    exit 1
  fi
done
exit 0
