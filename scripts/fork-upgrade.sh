#!/usr/bin/env bash
# Rebase the fork's commits on `deploy` onto a new upstream release tag, or onto
# any other upstream ref (e.g. upstream/master) to pick up unreleased fixes.
# Usage: scripts/fork-upgrade.sh v2.10.0
#        scripts/fork-upgrade.sh upstream/master
set -euo pipefail

TARGET="${1:?usage: $0 <upstream-tag|upstream-ref>}"
cd "$(git rev-parse --show-toplevel)"

[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean" >&2; exit 1; }
git fetch upstream --tags --prune
git rev-parse -q --verify "$TARGET^{commit}" >/dev/null || { echo "no such tag or ref: $TARGET" >&2; exit 1; }

git checkout -q deploy
OLD_BASE=$(git merge-base deploy upstream/master)
OLD_TAG=$(git describe --tags --exact-match "$OLD_BASE" 2>/dev/null || echo "${OLD_BASE:0:9}")
BACKUP="backup/deploy-$OLD_TAG"

git branch -f "$BACKUP" deploy
echo "fork commits ($OLD_TAG..deploy), backed up to $BACKUP:"
git log --oneline "$OLD_BASE..deploy"
echo
echo "rebasing onto $TARGET ..."
git rebase --onto "$TARGET" "$OLD_BASE" deploy || {
  echo; echo "conflict — see FORK.md for per-commit resolution notes, then: git rebase --continue" >&2; exit 1; }

# Release tag: <tag>-fork for a release tag, <last tag>-fork.<sha> for anything else.
if git rev-parse -q --verify "refs/tags/$TARGET" >/dev/null; then
  FORK_TAG="${TARGET}-fork"
else
  FORK_TAG="$(git describe --tags --abbrev=0 --exclude '*-fork*' "$TARGET")-fork.$(git rev-parse --short=9 "$TARGET")"
fi
echo
echo "done. deploy = $TARGET + $(git rev-list --count "$TARGET..deploy") fork commits. Now verify (see FORK.md) and:"
echo "  git push --force-with-lease origin deploy && git tag $FORK_TAG && git push origin $FORK_TAG"
