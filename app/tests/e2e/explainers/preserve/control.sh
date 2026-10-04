#!/usr/bin/env bash
# Preservation controls for what the demo explainers must leave unchanged.
#
# Usage: bash app/tests/e2e/explainers/preserve/control.sh <property>
#
# Copies every file git tracks or would track into a scratch directory, makes
# it a git repository with everything staged, and links the installed
# node_modules of the root and of each package into it, so the copy runs the
# same test tooling. It runs only the test that guards <property> there. That
# first run must pass: a copy that is already red proves nothing, so the
# control then exits 0, which reads as "not guarded". It then removes the
# property from the same copy and runs the guard again. Exit status is that
# second run's: non-zero means the guard caught the removal. A mutation that
# no longer applies to the source also exits 0. Nothing outside the scratch
# copy is changed.
#
# Properties, in the order the Preserves list names them:
#   copy-only        a parent view component writes a heading inline instead
#                    of taking it from copy.ts
#   operator-routes  the sections route accepts a visibility other than
#                    `parent` or `staff`
#
# operator-routes needs DATABASE_URL, as its guard does.
set -euo pipefail

property="${1:?usage: control.sh <property>}"
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

case "$property" in
  copy-only)       pkg=app; guard=(tests/parent/copy-scan.test.ts) ;;
  operator-routes) pkg=app; guard=(tests/operator) ;;
  *) echo "unknown property: $property" >&2; exit 2 ;;
esac

(cd "$root" && git ls-files -z --cached --others --exclude-standard -- .) \
  | (cd "$root" && tar --null -T - -cf -) \
  | tar -xf - -C "$work"
git -C "$work" init -q
git -C "$work" add -A
for dir in . app evals infra; do
  if [ -d "$root/$dir/node_modules" ]; then
    ln -s "$root/$dir/node_modules" "$work/$dir/node_modules"
  fi
done

run_guard() {
  (cd "$work/$pkg" && ./node_modules/.bin/vitest run "${guard[@]}")
}

# Replaces a file's content with perl and reports whether anything changed.
mutate() {
  local file="$1" expr="$2"
  cp "$file" "$file.orig"
  perl -0pi -e "$expr" "$file"
  if cmp -s "$file" "$file.orig"; then
    echo "mutation did not apply to ${file#"$work"/}, so this control proves nothing"
    rm -f "$file.orig"
    return 1
  fi
  rm -f "$file.orig"
}

if ! run_guard; then
  echo "pristine copy is already red, so this control proves nothing"
  exit 0
fi

case "$property" in
  copy-only)
    mutate "$work/app/src/app/parent/today-card.tsx" 's/<h3>\{PARENT\.menu\}<\/h3>/<h3>Menu<\/h3>/' || exit 0
    ;;
  operator-routes)
    mutate "$work/app/src/app/api/sections/route.ts" "s/visibility: z\\.enum\\(\\['parent', 'staff'\\]\\)/visibility: z.enum(['parent', 'staff', 'public'])/" || exit 0
    ;;
esac
git -C "$work" add -A

run_guard
