# A/B live — code index on vs off (2026-09-02)

Same goal (`goal.txt`, a read-only diagnostic on memory sealing), same workers (claude-sonnet ×2,
`--no-review`), this checkout as workspace. `run.sh` runs `--no-index` then default; `compare.ts`
prints `RESULT.txt`; `*.json` = `--json` reports, `*.stderr` = CLI stderr. Three rounds, kept whole:

| round | folder | what was wrong |
|---|---|---|
| 1 | `before-fix/` | gated claude worker explored the repo through native Grep/Glob (10–17 turns, 0 gated calls): `CLAUDE_DISALLOWED_TOOLS` was a deny LIST. Fix: `--tools ""`. |
| 2 | `after-fix1/` | `--no-index` still served `search_code` from the on-disk index (8 calls); one index task deadlocked: 3× `{pattern}` refused, then `no_progress` refused every corrected call. Fixes: `ToolHost.codeIndex=false`, `pattern` alias, guard scoped to the streak. |
| 3 | top level (final) | clean: every read goes through the gate, `--no-index` really means no index. |

## Final result (round 3)

| | no-index | index |
|---|---|---|
| duration | 224 s | 116 s |
| cached input tokens | 152k | 91k |
| output tokens | 38.0k | 15.6k |
| cost | $1.35 | $0.32 |
| model invocations | 17 | 7 |
| gated tool calls | 27 (21 `read_file`) | 6 (4 `search_code`, 2 `read_file`) |
| tasks | 2/2 done | 2/2 done |

With the index a worker finds `src/memory-seal.ts` and its consumers in 4 `search_code` calls
(≤6000 chars each) and reads 2 files; without it, it reads 21 files whole. Cost ÷4, wall clock ÷2,
output tokens ÷2.4. One run each, sonnet, one goal: an order of magnitude, not a benchmark.

Residual: under `--no-index` the planner still lists `search_code`, so each worker wastes 1–4 calls
learning it is off (readable refusal, then `read_file`).
