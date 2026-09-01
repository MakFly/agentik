# agentik

Agentic development system: the human is the **supreme orchestrator**, up to **5 subagents** take **bounded** tasks (default 2), and high-blast-radius tools are a **state** (approval gate), not a prompt suggestion.

This is a new project under `lab/`. It is not a continuation of `osagentik` (whose V0 forbids multi-agent orchestration).

## Roles

| Role | Who | Authority |
|---|---|---|
| Orchestrator | You | Submit goals, approve / reject / override at any time |
| Subagents (max 5) | `worker_a` … `worker_e` | Bounded tasks. Default 2 (`a` implement, `b` verify). Optional `c` debug, `d` research, `e` final ops. |

Neither worker can outrank the human. Neither worker can execute destructive filesystem, remote/server mutation, or credential use without an explicit orchestrator approval.

## Loop

`plan → delegate → tool-using action → synthesize`

Tools are language-agnostic: write files, run debug commands, record sandbox admin/ops, fetch sources. High-blast tools (`server_admin`, `fs_destructive`, `credential_use`) never run unattended. Even when approved, `server_admin` writes a **sandbox receipt** — it does not SSH into a host.

## Prompt injection

Untrusted text (user input, retrieved pages, tool output, inter-agent messages) is wrapped in nonce-delimited DATA blocks and scanned. Detected injections do not become executable instructions or a goal change.

Defense-in-depth follows OWASP LLM01 / Agentic ASI goal-hijack + tool-misuse, NCSC HITL for high-consequence actions, and structured untrusted wrapping (OWASP cheat sheet, MLflow 2026).

This is detection + isolation + non-execution, not a claim of zero false negatives.

## Verified sources

Retrieved bodies are data. Claims without a recorded origin are marked **unverified**. Hallucinated URLs that were never fetched are unverified.

Design citations: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Harness entry (this is how you run it)

Launch **Claude, Grok, or Codex**. The skill + named agents load in that session. You stay in the harness.

```bash
cla          # then:  /ak  Fais cette feature : …
grok --yolo  # then:  /ak  …
cc           # then:  /ak  …
```

The root model conducts. `/ak` adapts 0–5 slots (never 6). Each slot has names from Fifth Element, Star Wars, Matrix, and Retour vers le futur (Korben/Luke/Neo/Marty …) plus `a`–`e`. Optional gated trace: `agentik --workers 5 --yolo "…"`.

## CLI

Same shape as `cla`, `grok --yolo`, `cc` (`codex --yolo`): prompt first, optional `--yolo`. (Policy engine / gated run, not the daily entry.)

```bash
# on PATH (~/.local/bin/agentik) and alias `agk='agentik --yolo'`
agentik "Create src/greet.txt containing AGENTIK_OK"
agk "fix the failing test"                 # --yolo: live workers + session approval
agentik --workers 5 "fix the failing test" # a–e, hard cap 5
agentik --backend grok "refactor auth"
agentik --worker-a grok --worker-b opus --worker-c cla --worker-d cc --worker-e mock "…"

agentik probe                              # claude / grok / codex
```

`--yolo` is **your** session approval (you launched it the same way as `cla` / `grok --yolo` / `cc`). High-blast tools then get the sandbox receipt path. Without `--yolo` they stay `awaiting_approval`.

Auto-run is in-process for that one goal — not a daemon. After each tool result the same worker is invoked again until it returns no `toolCalls` or `--max-steps` (default 8). Low/medium tools execute immediately. High-blast waits unless `--yolo`.

A step that produces nothing is not a finished task. A refused tool call is fed back to the worker as untrusted `tool_output` so it can correct itself, and an empty or truncated reply is reprompted once before the task is recorded in `stalledTasks` — which makes the run exit **5**, never 0.

Memory is Hermes-style and **automatic**: HOT `~/.agentik/memory/MEMORY.md` (small, always-on), WARM SQLite FTS5, skills as procedural memory. Every completed `agentik` run harvests a session note; non-trivial runs (2+ artifacts or 5+ tools) create or update a skill in `~/.agentik/skills/` and link it into claude/grok/codex. No `--learn`. No approve. `/ak` recalls before work and runs `agentik harvest` after, without asking.

Worker processes are spawned with your real flags, but their **native file and shell tools stay
disabled** so they cannot skip the orchestrator gate. Grok's deny list uses its *internal* tool
ids (`run_terminal_cmd`, `search_replace`, …), not Claude's capitalised names — passing
`Bash,Edit,Write` there matches nothing and silently leaves every tool enabled.

| You type | Worker spawn |
|---|---|
| `--backend cla` / `claude` | `claude -p --dangerously-skip-permissions --effort high --restricted --disallowedTools …` |
| `--backend grok` | `grok --yolo --single … --disallowed-tools … --no-subagents --no-plan --max-turns` |
| `--backend cc` / `codex` | `codex exec --yolo --json --output-schema …` |

### Availability

`--backend auto` only routes to a harness whose **authenticated** probe passes
(`claude auth status`, `codex login status`, `grok models` — no model tokens spent), cached
15 min in `~/.agentik/backends.json`. `<bin> --version` is not a probe: it succeeds on an
expired or logged-out CLI. The rotation puts the always-on harnesses on `worker_a`
(implement) and `worker_b` (verify); anything with an expiry lands on `worker_c` and later and
drops out of the cycle the day its probe stops saying "logged in". A backend that dies
*mid-run* is marked dead, its work is handed to a live one, and the report prints the switch.
An unknown backend name is an error — it used to become a mock that fabricated a successful
run.

```
agentik probe --json      # absent / present but not authenticated / ok, per harness
```

### spawn

`agentik spawn --harness grok\|codex\|claude` (headless worker, tools ON, used by `/ak` for
foreign-harness fan-out) runs the same three CLIs to natural completion in one process — no
flag limits any of them to a single tool call. `--single` is what puts Grok into headless mode
at all (otherwise it opens a TUI with no TTY attached and hangs); once there, it already runs
the full agentic tool loop for that one prompt. `--no-plan` keeps it out of an approval-gated
plan mode with no headless approver.

agentik reads each harness's **own event stream** (`grok --output-format streaming-json`,
`claude --output-format stream-json`, `codex exec --json`), renders it live, and reports what
the worker actually did:

```
  ⟩ read_file {"target_file":"/tmp/a.txt"}
  ⟩ write {"file_path":"/tmp/b.txt","content":"HELLO WORLD\n"}
agentik spawn: completed · stop=end_turn · turns=4 · tools=5
```

That matters because a worker which narrates an intention and stops exits 0 exactly like one
that finished the job. `--require-tools` turns "finished without calling a single tool" into
**exit 125** — pass it for implement/fix tasks, omit it for diagnostics, where a prose-only
answer is legitimate. A stop reason of `max_turns`, `refusal` or `cancelled`, or a claude
`is_error`, is a failure regardless. `--raw` opts out and gives you the harness's own output.

Two independent checks, because they catch different lies:

| Check | Answers | Misses |
|---|---|---|
| `--require-tools` | did it *do* anything? | work that touched the wrong files |
| `--expect-artifact PATH` | did *this deliverable* move? | needs you to name the file |

`--expect-artifact` is repeatable and compares existence, mtime and size around the run, so a
created, rewritten **or deleted** file all count as done — only "nothing about it is different"
fails.

```
$ agentik spawn --harness grok --require-tools \
    --expect-artifact migrations/0021_sessions.sql "add the sessions migration"
agentik spawn: completed · stop=end_turn · turns=2 · tools=1
agentik spawn: the expected artifact migrations/0021_sessions.sql was not created or
modified — treating this as unfinished, not as success
$ echo $?
125
```

The wall clock is `--timeout` seconds (default 1800, `0` = unbounded).
**A timeout exits 124**, distinct from the generic 1: the old 300s bound killed the CLI and
returned a bare failure with nothing saying the work had been cut off mid-task. Treat 124 as
"the task did not finish, partial work may be on disk".

Live models only **propose** JSON `toolCalls`. The orchestrator gates and executes.

## Tests

Gating tests drive the shipped `runLoop` (not a reimplementation):

- `tests/roles.test.ts` — 3-role invocation, withheld approval, override
- `tests/injection.test.ts` — direct, indirect (fetched page), cross-agent
- `tests/sources.test.ts` — origin recording, poison does not change the goal, unsourced = unverified
- `tests/devloop.test.ts` — code-edit + sandbox ops artifacts
