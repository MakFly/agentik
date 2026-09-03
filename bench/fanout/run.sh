#!/usr/bin/env bash
# Live witness for the /ak fan-out doctrine. Nothing here trusts the model's narration.
#
#   bash bench/fanout/run.sh [--goal "<text>"] [--keep]
#   bash bench/fanout/run.sh --analyze <stream.jsonl>     # re-read a kept stream, no model call
#
# 1. builds a throwaway git repo in $TMPDIR with a planted 3-slot goal (a bug to reproduce,
#    a fact to research, code to change);
# 2. runs `claude -p "/ak <goal>"` headless with stream-json output;
# 3. reads the stream: how many Agent calls, how many assistant MESSAGES carried them —
#    grouped by `message.id`, because stream-json emits one event per content block, so
#    one turn with 3 Agent calls shows as 3 events sharing one id (1 id with N calls =
#    parallel wave, N ids = sequential) — wall clock, which subagent_types, and
#    `git status --porcelain` of the repo afterwards.
# Exit 0 = the doctrine held (≥2 Agent calls, first wave in ONE message). Exit 1 otherwise.
set -euo pipefail

GOAL='Fix the failing test in tests/sum.test.ts (run `bun test` first to see the failure), and add a `mul(a,b)` function in src/math.ts with a test. In parallel, research whether Bun `test` supports `test.each` and cite the doc URL in NOTES.md. Finish with a verification pass.'
KEEP=0
ANALYZE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --goal) GOAL="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --analyze) ANALYZE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null || { echo "jq not on PATH" >&2; exit 2; }

witness() { # $1 = stream log, $2 = workspace ("" = none), $3 = seconds ("" = unknown)
  local LOG="$1" WS="$2" SECS="$3"
  # One line per assistant MESSAGE (grouped by id): "<n Agent calls>\t<subagent_types>"
  local MSGS
  MSGS="$(jq -r 'select(.type=="assistant") | {id: .message.id, c: (.message.content // [])}
    | .c[] | select(.type=="tool_use" and .name=="Agent") | "\(.input.subagent_type // "?")"' "$LOG" 2>/dev/null \
    | paste -d"\t" <(jq -r 'select(.type=="assistant") | .message.id as $id | (.message.content // [])[] | select(.type=="tool_use" and .name=="Agent") | $id' "$LOG" 2>/dev/null) - \
    | awk -F"\t" '{ if (!($1 in n)) order[++k]=$1; n[$1]++; t[$1]=(t[$1]==""?$2:t[$1]","$2) } END { for (i=1;i<=k;i++) printf "%d\t%s\n", n[order[i]], t[order[i]] }')"
  local TOTAL WAVES FIRST COST TURNS
  TOTAL=$(printf '%s\n' "$MSGS" | awk -F'\t' 'NF{s+=$1} END{print s+0}')
  WAVES=$(printf '%s\n' "$MSGS" | grep -c . || true)
  FIRST=$(printf '%s\n' "$MSGS" | head -1 | cut -f1); FIRST=${FIRST:-0}
  COST=$(jq -r 'select(.type=="result") | .total_cost_usd // empty' "$LOG" | tail -1)
  TURNS=$(jq -r 'select(.type=="result") | .num_turns // empty' "$LOG" | tail -1)
  echo
  echo "── fan-out witness ────────────────────────────────────────"
  echo "wall clock:        ${SECS:-?} s   turns: ${TURNS:-?}   cost: \$${COST:-?}"
  echo "Agent calls:       $TOTAL   in $WAVES assistant message(s)"
  printf '%s\n' "$MSGS" | awk -F'\t' 'NF{printf "  wave %d: %s call(s) in ONE message → %s\n", NR, $1, $2}'
  if [ -n "$WS" ]; then
    echo "git status after:"; ( cd "$WS" && git status --porcelain | grep -v '^?? \.st' | sed 's/^/  /' )
    echo "bun test after:";  ( cd "$WS" && bun test 2>&1 | grep -E "pass|fail" | sed 's/^/  /' ) || true
  fi
  local VERDICT=0
  [ "$TOTAL" -ge 2 ] || { echo "✗ fewer than 2 Agent calls: the conductor did the work itself or spawned one slot"; VERDICT=1; }
  [ "$FIRST" -ge 2 ] || { echo "✗ first wave had $FIRST call in one message: sequential spawning"; VERDICT=1; }
  [ "$VERDICT" = 0 ] && echo "✓ doctrine held: first wave of $FIRST calls in one message, $TOTAL calls total"
  return $VERDICT
}

if [ -n "$ANALYZE" ]; then
  witness "$ANALYZE" "" ""
  exit $?
fi

command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 2; }
command -v bun >/dev/null || { echo "bun not on PATH" >&2; exit 2; }

WS="$(mktemp -d "${TMPDIR:-/tmp}/ak-fanout-XXXXXX")"
LOG="$WS/.stream.jsonl"
[ "$KEEP" = 1 ] || trap 'rm -rf "$WS"' EXIT

# --- 1. the planted repo -----------------------------------------------------------------
( cd "$WS"
  git init -q -b main
  mkdir -p src tests
  cat > src/math.ts <<'TS'
export function sum(a: number, b: number): number {
  return a - b; // planted bug
}
TS
  cat > tests/sum.test.ts <<'TS'
import { expect, test } from "bun:test";
import { sum } from "../src/math.ts";
test("sum adds", () => { expect(sum(2, 3)).toBe(5); });
TS
  printf '{"name":"ak-fanout-fixture","type":"module"}\n' > package.json
  printf '# fixture\n' > README.md
  git add -A && git -c user.name=bench -c user.email=bench@local commit -qm "fixture"
)

# --- 2. the run --------------------------------------------------------------------------
echo "workspace: $WS"
echo "goal:      $GOAL"
START=$(date +%s)
( cd "$WS" && AGENTIK_INDEX_AUTO=0 claude -p "/ak $GOAL" \
    --output-format stream-json --verbose \
    --dangerously-skip-permissions \
    --max-turns 60 \
  > "$LOG" 2> "$WS/.stderr.txt" ) || echo "claude exited $? (see $WS/.stderr.txt)" >&2
END=$(date +%s)

# --- 3. the witnesses --------------------------------------------------------------------
echo "stream:            $LOG$([ "$KEEP" = 1 ] || echo ' (deleted at exit; --keep to retain)')"
witness "$LOG" "$WS" "$((END-START))"
