#!/usr/bin/env bash
# Leave-one-out ablation: which of the four levers of 82ddee6 carries the measured gain?
# Every variant is the SAME commit with exactly one lever reverted, so a difference is that lever.
#   opt   : all levers on (reference)
#   noL1  : the act prompt no longer names the final-message budget
#   noL5  : the act prompt no longer asks to batch independent calls
#   noL2  : the synthesis executes its toolCalls again
#   noL3  : AGENTIK_CLAUDE_EFFORT=high, i.e. the old effort on every phase
# Variants are interleaved round-robin so backend drift hits all of them equally.
set -u
MAIN="$(cd "$(dirname "$0")/../.." && pwd)"
REPS="${1:-3}"
TARGET=/tmp/agentik-bench-target
OUT="$MAIN/bench/ablation/runs"
GOAL="$(cat "$MAIN/bench/index-ab/goal.txt")"

run_one() { # variant rep
  local variant="$1" rep="$2" tree=/tmp/ak-abl-opt effort=""
  case "$variant" in
    noL1|noL5|noL2) tree=/tmp/ak-abl-$variant ;;
    noL3) effort=high ;;
  esac
  echo "=== $variant rep$rep $(date -u +%FT%TZ)" >> "$OUT/../log.txt"
  AGENTIK_CLAUDE_EFFORT="$effort" bun run "$tree/src/cli.ts" run "$GOAL" --workspace "$TARGET" \
    --worker-a sonnet --worker-b sonnet --workers 2 --no-review --json \
    > "$OUT/$variant-$rep.json" 2> "$OUT/$variant-$rep.stderr"
  echo "    exit=$? $(date -u +%FT%TZ)" >> "$OUT/../log.txt"
}

for rep in $(seq 1 "$REPS"); do
  for v in opt noL1 noL5 noL2 noL3; do run_one "$v" "$rep"; done
done
echo DONE >> "$OUT/../log.txt"
