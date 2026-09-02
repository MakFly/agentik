#!/usr/bin/env bash
# Before/after A/B of the agentik conductor itself, with the methodology the first bench lacked:
#   - the measured workspace is a FROZEN worktree at a fixed SHA, outside the repo being edited,
#     so the code under search never moves between runs;
#   - its index is PREBUILT and asserted stable (changed=0), so no build time lands in a run;
#   - order alternates AB / BA / AB across repetitions, to absorb backend drift;
#   - the reports are written into the main checkout, which .agentikignore keeps out of any index.
# Usage: bench/v2/run.sh <baseline-sha> [reps]
# Both conductors are worktrees at <baseline-sha>; the "opt" one carries ONLY the optimization
# patch. The main checkout is never the conductor: it also holds an unrelated feature in progress,
# which would otherwise ride along in the measurement.
set -u
MAIN="$(cd "$(dirname "$0")/../.." && pwd)"
BASE_SHA="${1:?baseline sha required}"
REPS="${2:-3}"
TARGET=/tmp/agentik-bench-target
BASELINE=/tmp/agentik-bench-baseline
OUT="$MAIN/bench/v2/runs"
GOAL="$(cat "$MAIN/bench/index-ab/goal.txt")"

git -C "$MAIN" worktree add --detach "$TARGET" "$BASE_SHA" 2>/dev/null || true
git -C "$MAIN" worktree add --detach "$BASELINE" "$BASE_SHA" 2>/dev/null || true

# Prebuild, then prove the index is stable: a second refresh must change nothing.
bun run "$MAIN/src/cli.ts" index --workspace "$TARGET" >/dev/null 2>&1
bun run "$MAIN/src/cli.ts" index --workspace "$TARGET" --json 2>/dev/null | tee "$OUT/../index-state.json"

run_one() { # variant rep
  local variant="$1" rep="$2" conductor
  [ "$variant" = baseline ] && conductor="$BASELINE" || conductor=/tmp/agentik-bench-opt
  echo "=== $variant rep$rep $(date -u +%FT%TZ)" >> "$OUT/../log.txt"
  bun run "$conductor/src/cli.ts" run "$GOAL" --workspace "$TARGET" \
    --worker-a sonnet --worker-b sonnet --workers 2 --no-review --json \
    > "$OUT/$variant-$rep.json" 2> "$OUT/$variant-$rep.stderr"
  echo "    exit=$? $(date -u +%FT%TZ)" >> "$OUT/../log.txt"
}

for rep in $(seq 1 "$REPS"); do
  if [ $((rep % 2)) -eq 1 ]; then run_one baseline "$rep"; run_one opt "$rep"
  else run_one opt "$rep"; run_one baseline "$rep"; fi
done
echo DONE >> "$OUT/../log.txt"
