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

Memory is Hermes-style and **automatic**, in two stores under `~/.agentik` (or `~/.agentik/profiles/<name>` with `--profile <name>` / `AGENTIK_PROFILE`):

- **HOT** `memory/MEMORY.md` — durable facts, 2200 chars, always loaded. The cap forces consolidation: `agentik memory retain` refuses a note that does not fit (`MEMORY.md at n/2200 chars — consolidate (replace/remove) before adding`); nothing overflows anywhere else.
- **Sessions** `sessions.sqlite` — one row per run (goal, workspace, profile, status, verdict, artifacts, summary), indexed by FTS5 `unicode61 remove_diacritics 2` **and** trigram, so `agentik memory search cloturer` finds « clôturer » and `drawr` finds `drawer`. The search is filtered on `--workspace` by default (`--all` lifts it).

Every completed run records a session (`agentik harvest "<goal>" --workspace "$PWD"` does the same by hand). Before work `/ak` runs `agentik context "<goal>" --workspace "$PWD"`, which prints the block it starts from: `USER.md` profile, MEMORY, the skills index (`name: description`, body loaded on demand) and the top-6 related sessions. Legacy `(session)` lines in `MEMORY.md` and rows of the old `notes.sqlite` are migrated into `sessions.sqlite` once, after a `MEMORY.md.bak.<timestamp>` copy; `notes.sqlite` is left in place.

**A model decides what is remembered.** After every live run (and after `harvest --transcript FILE`), `agentik review` runs a bounded background pass — modelled on Hermes's review fork — with three tools: `memory` (add/replace/remove on `MEMORY.md`, cap 2200, and `USER.md`, cap 1375; an add over the cap is refused with "consolidate now", three failures and it stops), `skill_manage` (view/patch/create; one create per review; class-level names; read-before-write) and `read_file`. Snapshots and transcripts go in as DATA. Secrets and injections are refused on write and masked at load. Workers never get these tools: the gate blocks `memory`/`skill_manage` for any role but `reviewer`.

**Skills are curated, never deleted.** Every `skill_manage view`/`patch`/`create` and every `agentik skills view <name>` (how `/ak` loads a skill body from the index) is counted in `skills/.usage.json`. `agentik skills curate` marks a skill `stale` after 30 days without a load and moves it to `skills/.archive/` after 90 (`--stale-days`, `--archive-days`); pinned skills and skills a human drafted are never archived, only marked. Before a pass that changes anything the whole of `skills/` goes to `skills/.snapshots/<iso>.tar.gz` and every action is logged in `skills/.curator-ledger.json`; `--dry-run` only reports, `--rollback <snapshot>` restores that exact state after taking one more snapshot. `agentik skills list` shows each skill's state and counters.

**Write approval is optional.** In `<home>/config.json`, `{"memory": {"writeApproval": true}}` and/or `{"skills": {"writeApproval": true}}` (off by default, as in Hermes) turn every write into a staged file: memory ops under `pending/memory/<id>.json`, `skill_manage patch|create` under `pending/skills-ops/<id>.json`. The reviewer sees a success ("staged for approval") and does not retry; the human runs `agentik memory pending | approve <id|all> | reject <id|all>` and `agentik skills pending | approve <id|all> | reject <id|all>`. An approval replays the operation through the same code against the store as it is then — an add that no longer fits under the cap is refused with the consolidation message and stays pending.

**Code never writes a skill.** It used to, whenever a run had 2+ artifacts: the goal sentence became the skill name, cut at 64 characters, and got linked into three harnesses — 28 such skills in a day. A skill is a class of work (`pwa-drawer-swipe`), named and described (≤60 chars) by a model or a human, never derived from a session title. `agentik skills unlink` and `agentik skills archive` undo the old behaviour without deleting anything; `agentik skills pin <name>` + `link <name>` make a chosen skill visible in the harnesses.

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
