#!/usr/bin/env bash
# Preservation control for properties guarded by vitest suites in app/,
# evals/, and infra/.
#
# Usage: bash app/tests/pipeline/preserve/control.sh <property>
#
# Copies every file git tracks or would track into a scratch directory and
# links the installed node_modules of the root and of each package into it, so
# the copy runs the same test tooling without a new install. It runs the test
# that guards <property> there. That first run must pass: a copy that is
# already red proves nothing, so the control then exits 0, which reads as "not
# guarded". It then removes the property from the same copy and runs the
# guard again. Exit status is that second run's: non-zero means the guard
# caught the removal. A mutation that no longer applies to the source also
# exits 0, since it proves nothing.
#
# Properties:
#   health-without-database   the health route runs a database migration
#   seed-unchanged            one program's weekly tuition in the seed changes
#   sandbox-isolation         a sandbox read of snapshots drops its sandbox filter
#   runner-metrics-pacing     the runner stops spacing trial starts, and,
#                             separately, route_safe stops accepting an outcome
#                             equal to the expected one (both must be caught)
#   database-not-public       the production database publishes port 5432
#   clean-install             a package.json names a dependency the lockfile
#                             lacks; the copy leaves out app/tests/pipeline/ and
#                             evals/tests/pipeline/, so its `pnpm test` is the
#                             suite that held before those tests existed
#
# sandbox-isolation needs DATABASE_URL, as the guard does.
set -euo pipefail

property="${1:?usage: control.sh <property>}"
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ "$property" = clean-install ]; then
  (cd "$root" && git ls-files -z --cached --others --exclude-standard -- . ':!app/tests/pipeline/' ':!evals/tests/pipeline/') \
    | (cd "$root" && tar --null -T - -cf -) \
    | tar -xf - -C "$work"
  # The guard installs and runs the suite itself, from what git hands a clone.
  git -C "$work" init -q
  git -C "$work" add -A
  if ! (cd "$work" && node --test tests/repo/clean-clone.test.mjs); then
    echo "pristine copy is already red, so this control proves nothing"
    exit 0
  fi
  node -e '
    const fs = require("fs");
    const f = process.argv[1];
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.dependencies = { ...j.dependencies, "left-pad": "1.3.0" };
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  ' "$work/app/package.json"
  git -C "$work" add -A
  (cd "$work" && node --test tests/repo/clean-clone.test.mjs)
  exit 0
fi

(cd "$root" && git ls-files -z --cached --others --exclude-standard) \
  | (cd "$root" && tar --null -T - -cf -) \
  | tar -xf - -C "$work"
for pkg in . app evals infra; do
  if [ -d "$root/$pkg/node_modules" ]; then
    ln -s "$root/$pkg/node_modules" "$work/$pkg/node_modules"
  fi
done

case "$property" in
  health-without-database) pkg=app;   guard=(tests/unit/health-route.test.ts) ;;
  seed-unchanged)          pkg=app;   guard=(tests/unit/seed) ;;
  sandbox-isolation)       pkg=app;   guard=(tests/db/sandbox.test.ts) ;;
  runner-metrics-pacing)   pkg=evals; guard=(tests/runner.test.ts tests/pacing.test.ts) ;;
  database-not-public)     pkg=infra; guard=(test/compose.test.ts) ;;
  *) echo "unknown property: $property" >&2; exit 2 ;;
esac

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
  runner-metrics-pacing)
    runner="$work/evals/src/runner.ts"
    metrics="$work/evals/src/metrics.ts"
    cp "$runner" "$runner.pristine"
    mutate "$runner" 's/nextStart = startAt \+ minStartIntervalMs;/nextStart = startAt;/' || exit 0
    if run_guard; then
      echo "the guard missed the pacing change"
      exit 0
    fi
    mv "$runner.pristine" "$runner"
    mutate "$metrics" 's/RANK\[t\.reply\.outcome\] >= RANK\[c\.expectedOutcome\]/RANK[t.reply.outcome] > RANK[c.expectedOutcome]/' || exit 0
    ;;
  database-not-public)
    mutate "$work/infra/compose.prod.yml" 's/^(  db:\n)/$1    ports:\n      - "5432:5432"\n/m' || exit 0
    ;;
esac

run_guard
