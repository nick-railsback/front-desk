#!/usr/bin/env bash
# Preservation controls for what the operator view must leave unchanged.
#
# Usage: bash app/tests/operator/preserve/control.sh <property>
#
# Copies every file git tracks or would track into a scratch directory, makes
# it a git repository with everything staged, and links the installed
# node_modules of the root and of each package into it (or installs the copy
# from the local pnpm store, where a linked node_modules will not do), so the
# copy runs the same test tooling. It runs only the test that guards
# <property> there. That first run must pass: a copy that is already red
# proves nothing, so the control then exits 0, which reads as "not guarded".
# It then removes the property from the same copy and runs the guard again.
# Exit status is that second run's: non-zero means the guard caught the
# removal. A mutation that no longer applies to the source also exits 0.
#
# Properties, in the order the operator view's Preserves list names them:
#   pipeline-unchanged       /api/ask puts the new sandbox's ID in its body
#   health-without-database  the health route runs a database migration
#   seed-unchanged           one program's weekly tuition in the seed changes
#   sandbox-isolation        a sandbox read of snapshots drops its sandbox filter
#   fixture-eval-offline     the fixture model makes a network request
#   copy-only                a parent view component writes a heading inline
#                            instead of taking it from copy.ts
#   parent-page-server       the parent page computes its Today card for two
#                            days from now instead of now
#   clean-install            a package.json names a dependency the lockfile
#                            lacks; the copy leaves out app/tests/operator/
#                            and app/tests/e2e/operator/, so its `pnpm test`
#                            is the suite that held before those tests existed
#
# pipeline-unchanged, sandbox-isolation and parent-page-server need
# DATABASE_URL, as their guards do. fixture-eval-offline and
# parent-page-server install the copy from the local pnpm store with no
# network (the parent page's guard runs `next dev`, which refuses a linked
# node_modules that points outside the copy), and clean-install needs the npm
# registry or a warm pnpm store.
set -euo pipefail

property="${1:?usage: control.sh <property>}"
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

case "$property" in
  pipeline-unchanged)      kind=vitest; pkg=app;   guard=(tests/pipeline) ;;
  health-without-database) kind=vitest; pkg=app;   guard=(tests/unit/health-route.test.ts) ;;
  seed-unchanged)          kind=vitest; pkg=app;   guard=(tests/unit/seed) ;;
  sandbox-isolation)       kind=vitest; pkg=app;   guard=(tests/db/sandbox.test.ts) ;;
  fixture-eval-offline)    kind=vitest; pkg=evals; guard=(tests/pipeline) ;;
  copy-only)               kind=vitest; pkg=app;   guard=(tests/parent/copy-scan.test.ts) ;;
  parent-page-server)      kind=vitest; pkg=app;   guard=(tests/parent/server.test.ts tests/parent/today-card.test.ts) ;;
  clean-install)           kind=node;   guard=(tests/repo/clean-clone.test.mjs) ;;
  *) echo "unknown property: $property" >&2; exit 2 ;;
esac

exclude=()
if [ "$property" = clean-install ]; then
  exclude=(':!app/tests/operator/' ':!app/tests/e2e/operator/')
fi
(cd "$root" && git ls-files -z --cached --others --exclude-standard -- . ${exclude[@]+"${exclude[@]}"}) \
  | (cd "$root" && tar --null -T - -cf -) \
  | tar -xf - -C "$work"
git -C "$work" init -q
git -C "$work" add -A
if [ "$property" = fixture-eval-offline ] || [ "$property" = parent-page-server ]; then
  (cd "$work" && pnpm install --frozen-lockfile --offline --reporter=silent)
elif [ "$kind" = vitest ]; then
  for dir in . app evals infra; do
    if [ -d "$root/$dir/node_modules" ]; then
      ln -s "$root/$dir/node_modules" "$work/$dir/node_modules"
    fi
  done
fi

run_guard() {
  if [ "$kind" = vitest ]; then
    (cd "$work/$pkg" && ./node_modules/.bin/vitest run "${guard[@]}")
  else
    (cd "$work" && node --test "${guard[@]}")
  fi
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
  pipeline-unchanged)
    mutate "$work/app/src/app/api/ask/route.ts" 's/JSON\.stringify\(body\)/JSON.stringify({ ...body, sandboxId })/' || exit 0
    ;;
  health-without-database)
    cat > "$work/app/src/app/api/health/route.ts" <<'EOF'
import { migrate } from '../../../db/sandbox';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  await migrate();
  return Response.json({ status: 'ok' });
}
EOF
    ;;
  seed-unchanged)
    mutate "$work/app/src/seed/center.ts" 's/\$385/\$386/' || exit 0
    ;;
  sandbox-isolation)
    mutate "$work/app/src/db/sandbox.ts" 's/(\.from\(snapshots\))\.where\(eq\(snapshots\.sandboxId, sandboxId\)\)/$1/' || exit 0
    ;;
  fixture-eval-offline)
    mutate "$work/app/src/server/fixture.ts" 's/(export const fixtureModel\b[^\n]*=>\s*\{)/$1\n  await fetch("https:\/\/bedrock.example\/").catch(() => null);/' || exit 0
    ;;
  copy-only)
    mutate "$work/app/src/app/parent/today-card.tsx" 's/<h3>\{PARENT\.menu\}<\/h3>/<h3>Menu<\/h3>/' || exit 0
    ;;
  parent-page-server)
    mutate "$work/app/src/app/page.tsx" 's/todayCard\(structured, new Date\(\)\)/todayCard(structured, new Date(Date.now() + 2 * 86_400_000))/' || exit 0
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
esac
git -C "$work" add -A

run_guard
