#!/usr/bin/env bash
# Rebase the fork's commits on `deploy` onto a new upstream release tag.
# Usage: scripts/fork-upgrade.sh v2.9.0
set -euo pipefail

TAG="${1:?usage: $0 <upstream-tag>}"
cd "$(git rev-parse --show-toplevel)"

[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean" >&2; exit 1; }
git fetch upstream --tags --prune
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "no such tag: $TAG" >&2; exit 1; }

git checkout -q deploy
OLD_BASE=$(git merge-base deploy upstream/master)
OLD_TAG=$(git describe --tags --exact-match "$OLD_BASE" 2>/dev/null || echo "${OLD_BASE:0:8}")
BACKUP="backup/deploy-$OLD_TAG"

git branch -f "$BACKUP" deploy
echo "fork commits ($OLD_TAG..deploy), backed up to $BACKUP:"
git log --oneline "$OLD_BASE..deploy"
echo
echo "rebasing onto $TAG ..."
git rebase --onto "$TAG" "$OLD_BASE" deploy || {
  echo; echo "conflict — see FORK.md for per-commit resolution notes, then: git rebase --continue" >&2; exit 1; }
echo
echo "done. deploy = $TAG + $(git rev-list --count "$TAG..deploy") fork commits. Now verify (see FORK.md) and:"
echo "  git push --force-with-lease origin deploy && git tag ${TAG}-fork && git push origin ${TAG}-fork"
