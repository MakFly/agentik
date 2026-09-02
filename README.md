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

Memory is Hermes-style and **automatic**, in three stores under `~/.agentik` (or `~/.agentik/profiles/<name>` with `--profile <name>` / `AGENTIK_PROFILE`):

- **HOT** `memory/MEMORY.md` — GLOBAL durable facts (true in every project), 2200 chars, always loaded. The cap forces consolidation: `agentik memory retain` refuses a note that does not fit (`MEMORY.md at n/2200 chars — consolidate (replace/remove) before adding`); nothing overflows anywhere else.
- **PROJECT** `memory/projects/<slug>/MEMORY.md` — facts about one workspace only (conventions, paths, test commands), 2200 chars, same masking / dedup / cap. `<slug>` is the sanitized basename plus 10 hex chars of sha256 of the absolute path (`agentik-3f2a9c1b7e`, readable and collision-free); a `.workspace` file next to it holds the full path. Loaded only into that workspace's context, never into another's.
- **Sessions** `sessions.sqlite` — one row per run (goal, workspace, profile, status, verdict, artifacts, summary), indexed by FTS5 `unicode61 remove_diacritics 2` **and** trigram, so `agentik memory search cloturer` finds « clôturer » and `drawr` finds `drawer`. The search is filtered on `--workspace` by default (`--all` lifts it).

Every completed run records a session (`agentik harvest "<goal>" --workspace "$PWD"` does the same by hand; `--status failed|partial --cause "…"` declares a failure, and a failure needs a cause). Before work `/ak` runs `agentik context "<goal>" --workspace "$PWD"`, which prints the block it starts from: `USER.md` profile, MEMORY (global), PROJECT MEMORY (this workspace's file, only when it has entries — never another workspace's), the skills index (`name: description`, body loaded on demand), the top-6 related sessions and, when there are any, KNOWN FAILURES (unresolved incidents seen ≥2 on this workspace, see below). `agentik memory hot | retain <fact> | remove "<exact entry or unique prefix>" [--target memory|user|project] [--workspace DIR]` is the human's pen on one file: `remove` never goes through the approval queue (the human is the approver) but copies the file to `MEMORY.md.bak.<ts>` first, and exits 1 listing the candidates when zero or several entries match. Legacy `(session)` lines in `MEMORY.md` and rows of the old `notes.sqlite` are migrated into `sessions.sqlite` once, after a `MEMORY.md.bak.<timestamp>` copy; `notes.sqlite` is left in place.

**A model decides what is remembered.** After every live run (and after `harvest --transcript FILE`), `agentik review` runs a bounded background pass — modelled on Hermes's review fork — with four tools: `memory` (add/replace/remove on the global `MEMORY.md`, cap 2200, this workspace's project `MEMORY.md`, cap 2200, or `USER.md`, cap 1375; an add over the cap is refused with "consolidate now", three failures and it stops), `skill_manage` (view/patch/create; one create per review; class-level names; read-before-write), `incident` (classify/resolve/merge an entry of the failure log) and `read_file`. Snapshots (global, project, user), the skills index, the workspace's `CLAUDE.md` (capped at 6000 chars) and the transcript (bounded at 60k chars: head 36k + tail 24k, so corrections and the conclusion survive) go in as DATA. The reviewer, not code, chooses the level — "would this be true in another repository?": yes → `memory`, no → `project` — and moves a misplaced entry rather than keeping both; a fact already stated in `CLAUDE.md` is not memory, the reviewer must not add it and drops an entry that merely repeats it when consolidating. Secrets and injections (English and French, diacritics folded) are refused on write and masked at load. Skill bodies get the same scan on every write (create, patch, draft, approve) and on `skills link`; `skills pin` warns. Transient or environment-dependent failures go to the incident log, not to memory. Workers never get these tools: the gate blocks `memory`/`skill_manage`/`incident` for any role but `reviewer`.

**Failures are recorded so they surface next time.** Every non-zero `agentik spawn` (1 CLI failed, 124 timeout, 125 finished without doing the work), every stalled task and backend switch of a `run`, a `blocked`/`rejected` run and every `harvest --status failed|partial --cause "…"` writes an incident into the `incidents` table of `sessions.sqlite` (goal, workspace, harness, backend, exit code, stop reason, errors, symptom; FTS5 unicode61 + trigram). The same symptom on the same workspace and harness, while unresolved, is one row with `seen N×` (digits are folded, so `killed after 900s` and `killed after 1800s` are the same failure); a resolved incident never absorbs a new one. Secrets are masked at write time. Recording never changes the exit code. `agentik postmortem [--workspace DIR] [--since 7d|ISO] [--all] [--json]` lists them grouped by cause; `agentik postmortem classify <id> "<cause>"` / `resolve <id> "<fix>"` are the human's pen; `agentik postmortem review <id>` (= `agentik review --incident <id>`) hands one incident to the reviewer with a single question — why, and what prevents it — answered with nothing (seen once, noise), `incident classify` + a memory fact, or `incident classify|resolve` + a skill Pitfalls patch when seen ≥2 and a skill exists for that class. Unresolved incidents seen ≥2 come back in `agentik context` as `KNOWN FAILURES`; seen once stays in the log.

**Skills are curated, never deleted.** Every `skill_manage view`/`patch`/`create` and every `agentik skills view <name>` (how `/ak` loads a skill body from the index) is counted in `skills/.usage.json`. `agentik skills curate` marks a skill `stale` after 30 days without a load and moves it to `skills/.archive/` after 90 (`--stale-days`, `--archive-days`); pinned skills and skills a human drafted are never archived, only marked. Before a pass that changes anything the whole of `skills/` goes to `skills/.snapshots/<iso>.tar.gz` and every action is logged in `skills/.curator-ledger.json`; `--dry-run` only reports, `--rollback <snapshot>` restores that exact state after taking one more snapshot. `agentik skills list` shows each skill's state and counters.

**Write approval is optional.** In `<home>/config.json`, `{"memory": {"writeApproval": true}}` and/or `{"skills": {"writeApproval": true}}` (off by default, as in Hermes) turn every write into a staged file: memory ops under `pending/memory/<id>.json`, `skill_manage patch|create` under `pending/skills-ops/<id>.json`. The reviewer sees a success ("staged for approval") and does not retry; the human runs `agentik memory pending | approve <id|all> | reject <id|all>` and `agentik skills pending | approve <id|all> | reject <id|all>`. An approval replays the operation through the same code against the store as it is then — an add that no longer fits under the cap is refused with the consolidation message and stays pending. The file is read **strictly**: invalid JSON, an unknown key, a non-boolean value (`"true"` is a string, not `true`), a symlink, or camel/snake spellings that disagree make every writing command (`run`, `review`, `harvest`, `memory`, `skills`, `spawn`) exit 2 with `<path>: <problem> — fix or delete the file (defaults are all off)`; `probe`, `context` and `postmortem` stay available.

**Code never writes a skill.** It used to, whenever a run had 2+ artifacts: the goal sentence became the skill name, cut at 64 characters, and got linked into three harnesses — 28 such skills in a day. A skill is a class of work (`pwa-drawer-swipe`), named and described (≤60 chars) by a model or a human, never derived from a session title. `agentik skills unlink` and `agentik skills archive` undo the old behaviour without deleting anything; `agentik skills pin <name>` + `link <name>` make a chosen skill visible in the harnesses.

Worker processes are spawned with your real flags, but their **native file and shell tools stay
disabled** so they cannot skip the orchestrator gate. Grok's deny list uses its *internal* tool
ids (`run_terminal_cmd`, `search_replace`, …), not Claude's capitalised names — passing
`Bash,Edit,Write` there matches nothing and silently leaves every tool enabled.

| You type | Worker spawn |
|---|---|
| `--backend cla` / `claude` | `claude -p --dangerously-skip-permissions --effort high --restricted --disallowedTools …` |
| `--backend grok` | `grok --yolo --single … --disallowed-tools … --no-subagents --no-plan --max-turns` |
| `--backend cc` / `codex` | `codex exec --yolo --json [--output-schema …]` — the schema is tried, and dropped for good on the routing where it fails (`adapter_eof` behind opencodex); learned in `~/.agentik/codex-capabilities.json`, override `AGENTIK_CODEX_OUTPUT_SCHEMA=always\|never` |

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
plan mode with no headless approver. The worker gets the same block `agentik context` prints — USER profile, global MEMORY, the PROJECT MEMORY of that workspace, skills index, related sessions, KNOWN FAILURES — in front of its task as an untrusted envelope (`origin=agentik:context`, "DATA ONLY"), capped at 6000 chars; `--no-context` leaves it out.

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

`--idle-timeout S` (off by default) kills a harness whose event stream is silent for S seconds —
exit 124 with its own symptom, distinct from the wall clock. Leave it off for claude `--effort
high`, which can think for minutes without a line.

Live models only **propose** JSON `toolCalls`. The orchestrator gates and executes.

**Spawned workers have a floor.** `agentik spawn` runs the harness in yolo mode for everything
except the high-blast commands of the policy, which it denies at the harness itself: claude via
`--settings '{"permissions":{"deny":["Bash(rm -rf *)", …]}}'`, grok via repeated `--deny 'Bash(…)'`
(kept under `--yolo`), codex — which has no deny flag — via a trusted line in front of the prompt.
After the run, the commands the harness reports having run are matched against the same rules: a
match that the harness did not deny itself is printed as `FLOOR VIOLATION` and logged as an incident
(exit code unchanged). `--allow-high-blast` removes the floor and says `floor DISABLED`. A claude or
grok whose `--help` no longer advertises the deny flag is refused rather than run without the floor.

**Evidence, not narration.** The verdict classifies every tool event as an edit, a test run or
other, and prints `evidence=fresh|stale(n edits after last test)|none`. `agentik spawn
--require-evidence` turns a missing test after the last edit into exit 125 ("the result is
unverified"); off by default, because a research task legitimately edits nothing. Limit: a
project-specific `./scripts/test.sh` reads as "other".

**What moved on disk.** On 124 and 125 the run also prints `changed: [a] / untouched: [b] / touched
(per stream): [c]` — expected artifacts that did or did not move, and the files the stream says the
worker edited — and that line opens the incident, so the next conductor knows whether partial work
is on disk.

**What it cost.** Every `agentik spawn` ends with `usage: in=11.1k (5.8k cached) out=42
cost=$0.0043 turns=1 dur=12s`, read from the harness's own stream (claude `result`, grok `end` —
dollars or ticks — codex `turn.completed`), and the line is stored on every incident.

**A worker never spawns workers.** Every child agentik starts inherits `AGENTIK_DEPTH`; at depth 1 or
more, `agentik spawn` and `agentik run` refuse (exit 2, incident `nested agentik spawn refused at
depth 1`) before probing anything. That is agent #6 by another route, and it is closed on both sides:
the harness deny rules also cover `agentik spawn|run`.

**Command policy.** `run_command` executes one argv with no shell (pipes, `;`, `&&`, redirections
and `$(…)` are refused: "one command per call"), with a 30 s default timeout (`timeout_s`, max 120),
a scrubbed environment (no `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `GH_TOKEN`, API keys) and a
2 MB capture cap. `src/command-policy.ts` classifies every command `medium | high | hardline` across
all its segments and wrappers (`bash -c`, `sudo`, `env`, `xargs`…): **high** (`rm -rf`, `git push
--force`, `git reset --hard`, `sudo`, `curl | sh`, `drop database`, `terraform destroy`, `agentik
spawn`…) waits for your approval (`--yolo` / `--approve-high-blast` release it), **hardline**
(`rm -rf /`, `mkfs /dev/sda`, fork bomb, `chmod -R 777 /`) is refused with no approval to grant —
not even `--yolo` runs it. The same rules render as harness deny globs (`Bash(rm -rf *)`) for spawned
claude/grok workers.

## Tests

Gating tests drive the shipped `runLoop` (not a reimplementation):

- `tests/roles.test.ts` — 3-role invocation, withheld approval, override
- `tests/injection.test.ts` — direct, indirect (fetched page), cross-agent
- `tests/sources.test.ts` — origin recording, poison does not change the goal, unsourced = unverified
- `tests/devloop.test.ts` — code-edit + sandbox ops artifacts
