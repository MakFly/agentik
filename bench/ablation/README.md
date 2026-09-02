# Leave-one-out ablation of the run-cost levers (2026-09-02)

Same frozen target, same goal, same workers as `bench/v2`. Each variant is commit `82ddee6` with
exactly ONE lever reverted, so a difference is that lever. Variants are interleaved round-robin
over the repetitions so backend drift hits all of them equally. `best` is the combination the
first pass pointed at: budget on, toolless synthesis on, effort high everywhere, no batching hint.

| variant | 3 costs, sorted | tool calls | wall clock s |
|---|---|---|---|
| all levers on | 0.314 / 0.415 / 0.444 | 9 / 12 / 15 | 95 / 98 / 105 |
| best (no batching, effort high) | 0.254 / 0.313 / 0.365 | 4 / 7 / 11 | 86 / 91 / 92 |
| − final-message budget | 0.281 / 0.460 / 0.559 | 13 / 13 / 27 | 79 / 104 / 111 |
| − toolless synthesis | 0.310 / 0.345 / 0.390 | 9 / 10 / 15 | 62 / 112 / 115 |
| − per-phase effort (high everywhere) | 0.231 / 0.251 / 0.328 | 6 / 7 / 8 | 77 / 92 / 93 |
| − batch independent calls | 0.153 / 0.186 / 0.287 | 6 / 8 / 8 | 63 / 71 / 88 |

## Reading it honestly

**Cost cannot rank the levers at n=3.** Across the 18 runs the cost spans 0.153 to 0.559, a factor
of 3.7 on an identical goal against an identical frozen workspace. The `opt` reference alone moved
from $0.265 (bench/v2) to $0.415 here on the same commit. Most per-lever deltas sit inside that
noise, and `best` landing between its two components contradicts additivity — a sign the ranking is
not resolvable at this sample size.

**Tool-call count is the stable signal**, and it does separate:

- Removing the final-message budget explodes the calls (13, 13, 27) and the cached input (up to
  217k). This lever helps, in the direction predicted, and it is the one the reference measurement
  already credited.
- Removing the batching hint *lowers* the calls (6-8 vs 9-15). Told to emit every independent call
  at once, the model speculatively fetches what it would otherwise never have asked for, and each
  answer inflates the context of the following turn. **The batching lever looks counterproductive.**
- Restoring effort `high` on act also lowers the calls (6-8). A cheaper per-turn effort seems to be
  paid back, and then some, in extra turns.

## What this does not say

One goal, one backend pair, three repetitions. The two counterproductive readings are suggestive,
not established: both need more repetitions, and ideally a second goal shape (an implement task,
not a read-only diagnostic). Nothing here was committed as a behaviour change.
