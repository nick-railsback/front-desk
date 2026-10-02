#!/usr/bin/env bash
# Preservation control for the repository-level guards in tests/repo/.
#
# Usage: bash infra/test/preserve/control.sh <property>
#
# Copies every file git tracks or would track into a scratch directory, makes
# it a git repository with everything staged, and runs the repo test that
# guards <property> there. That first run must pass: a copy that is already red
# proves nothing, so the control then exits 0, which reads as "not guarded".
# It then removes the property from the same copy and runs the test again.
# Exit status is that second run's: non-zero means the guard caught the
# removal.
#
# Properties:
#   action-pins       a workflow references an action by tag, not by full SHA
#   release-age       pnpm-workspace.yaml loses minimumReleaseAge
#   lockfile-tracked  pnpm-lock.yaml is removed from the git index
#   clean-install     a package.json names a dependency the lockfile lacks
#   cases-deny        .claude/settings.json stops denying edits under evals/cases/
set -euo pipefail

property="${1:?usage: control.sh <property>}"
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$root" && git ls-files -z --cached --others --exclude-standard) \
  | (cd "$root" && tar --null -T - -cf -) \
  | tar -xf - -C "$work"
git -C "$work" init -q
git -C "$work" add -A

case "$property" in
  action-pins)      guard=tests/repo/workflows.test.mjs ;;
  release-age)      guard=tests/repo/pnpm-policy.test.mjs ;;
  lockfile-tracked) guard=tests/repo/lockfile.test.mjs ;;
  clean-install)    guard=tests/repo/clean-clone.test.mjs ;;
  cases-deny)       guard=tests/repo/claude-settings.test.mjs ;;
  *) echo "unknown property: $property" >&2; exit 2 ;;
esac

if ! (cd "$work" && node --test "$guard"); then
  echo "pristine copy is already red, so this control proves nothing"
  exit 0
fi

case "$property" in
  action-pins)
    sed -i.bak 's|actions/checkout@[0-9a-f]\{40\}|actions/checkout@v7|' "$work/.github/workflows/ci.yml"
    ;;
  release-age)
    sed -i.bak '/^minimumReleaseAge:/d' "$work/pnpm-workspace.yaml"
    ;;
  lockfile-tracked)
    git -C "$work" rm -q --cached pnpm-lock.yaml
    ;;
  clean-install)
    node -e '
      const fs = require("fs");
      const f = process.argv[1];
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      j.dependencies = { ...j.dependencies, "left-pad": "1.3.0" };
      fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    ' "$work/app/package.json"
    ;;
  cases-deny)
    sed -i.bak '/"Edit(\.\/evals\/cases\/\*\*)",/d' "$work/.claude/settings.json"
    ;;
esac
rm -f "$work"/.github/workflows/*.bak "$work"/*.bak "$work"/.claude/*.bak
# Restaging would undo the lockfile-tracked removal; the others are file edits.
if [ "$property" != lockfile-tracked ]; then
  git -C "$work" add -A
fi

cd "$work" && node --test "$guard"
