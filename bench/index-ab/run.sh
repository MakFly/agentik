#!/usr/bin/env bash
# A/B live: same goal, same workers (claude-sonnet ×2), --no-index vs default (code index on).
set -u
cd "$(dirname "$0")/../.."
OUT=bench/index-ab
GOAL='Diagnostic only, modify no file: explain how memory sealing works in this repository. Name the module that writes memory/.seal.json, the function that detects an out-of-band modification, and every operation that refuses on a diverged seal. Cite file paths with line ranges for each claim.'
printf '%s\n' "$GOAL" > "$OUT/goal.txt"
for variant in no-index index; do
  flag=""; [ "$variant" = no-index ] && flag="--no-index"
  echo "=== $variant $(date -u +%FT%TZ) ===" | tee -a "$OUT/log.txt"
  bun run src/cli.ts run "$GOAL" --workspace "$PWD" --worker-a sonnet --worker-b sonnet \
    --workers 2 --no-review $flag --json > "$OUT/$variant.json" 2> "$OUT/$variant.stderr"
  echo "exit=$? $(date -u +%FT%TZ)" | tee -a "$OUT/log.txt"
done
echo DONE >> "$OUT/log.txt"
