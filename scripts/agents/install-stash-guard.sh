#!/usr/bin/env sh
# Copies stash-guard.sh to <effective hooks dir>/reference-transaction (the husky dir .husky/_ when
# core.hooksPath points there, which is git-ignored and survives `npm run prepare`). Per worktree:
# core.hooksPath is relative, so each worktree has its own .husky/_. Remove with --uninstall.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
top="$(git rev-parse --show-toplevel)"
hp="$(git config core.hooksPath || true)"
if [ -n "$hp" ]; then
  case "$hp" in /*|[A-Za-z]:*) dir="$hp" ;; *) dir="$top/$hp" ;; esac
else
  dir="$(git rev-parse --git-common-dir)/hooks"
fi
mkdir -p "$dir"
if [ "${1:-}" = --uninstall ]; then rm -f "$dir/reference-transaction"; echo "removed from $dir"; exit 0; fi
cp "$here/stash-guard.sh" "$dir/reference-transaction"
chmod +x "$dir/reference-transaction"
echo "installed stash guard in $dir"
