# Before / after the conductor optimizations (2026-09-02)

Answers one question: does the optimization patch lower time and cost of `agentik run`?

## Method (what the first bench got wrong, fixed here)

- The measured workspace is a **frozen worktree** at SHA `cb183ba` (`/tmp/agentik-bench-target`),
  outside the repository being edited, so the code under search never moves between runs.
- Its index is **prebuilt and proven stable**: a second refresh reports `+0 ~0 -0`, so no build
  time or index churn lands inside a measured run.
- **Neither conductor is the main checkout.** Baseline is a worktree at `cb183ba`; "opt" is the
  same SHA plus the optimization patch alone. The main checkout also carries an unrelated feature
  in progress, which would otherwise ride along in the numbers.
- Order alternates **AB / BA / AB** over 3 repetitions, to absorb backend drift.
- Reports live here, and `.agentikignore` keeps `bench/**` out of every index (the first bench
  indexed its own archives: `agentik search checkSeal` returned a run report instead of the code).
- Same goal, same workers both sides: claude-sonnet ×2, `--workers 2`, `--no-review`.

`run.sh <baseline-sha> [reps]` runs it, `report.ts` prints `RESULT.txt`.

## Result — median [min–max] over 3 repetitions

| | baseline | opt |
|---|---|---|
| wall clock | 123.8 s [104–295] | 74.2 s [59–107] |
| cost | $0.5527 [0.39–0.93] | $0.2645 [0.21–0.42] |
| output tokens | 15.8k [15.7–41.2] | 7.4k [7.2–10.7] |
| cached input | 152.1k | 62.1k |
| model invocations | 9 | 7 |
| tasks done | 2/2 | 2/2 |
| phase plan | 22.1 s | 22.4 s |
| phase act (longest task) | 77.8 s | 28.7 s |
| phase synthesis | 27.2 s | 20.4 s |

**Wall clock −40%, cost −52%, output tokens −53%**, with both variants completing 2/2 tasks.

The gain lands where it was predicted: the ACT phase, cut by 63%. The plan phase is unchanged,
which is expected since it keeps `--effort high`. Spread is wide on the baseline (one run took
295 s), so the median is the honest statistic and 3 repetitions are a floor, not a proof.

## What the patch changed

1. The worker is told its final message is truncated at `TASK_SUMMARY_MAX`. Before, the two final
   ACT messages of a run cost 8410 output tokens and both summaries were cut at exactly 2000
   chars: ~47% of the run's output tokens were paid then discarded.
2. The synthesis no longer executes tool calls, which were run after its text was already written.
3. Claude effort per phase: plan `high`, act and synthesis `medium` (`AGENTIK_CLAUDE_EFFORT` overrides).
4. `search_code` is dropped from task allowlists when the run has no index.
5. The act prompt asks for independent tool calls in one message.

Not isolated: the four levers were measured together. Attributing the 52% between them needs one
variant per lever, which is four more pairs of live runs.
