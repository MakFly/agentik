# Threat model and verified sources

Untrusted content is **data**, never the instruction channel. High-blast-radius actions are a **state machine gate**.

## Trust boundaries

| Channel | Trust | Becomes a goal? | May run high-blast tools? |
|---|---|---|---|
| Human orchestrator CLI (`run`, `--approve-high-blast`, `--override`) | trusted | yes | only after explicit approval |
| Worker plan / act / synthesize text | untrusted | no | no |
| Fetched page / file body | untrusted | no | no |
| Tool stdout | untrusted | no | no |
| Spawned worker (`agentik spawn`, yolo under the floor, `AGENTIK_DEPTH=1`) | untrusted, bounded | no (never spawns, never sets a goal) | denied at the harness; a violation is an incident |
| Reviewer (`agentik review`, same gate, empty context) | trusted tools, untrusted inputs | no | no (memory · skill_manage · incident · read_file · search_code only) |
| Code index (`<home>/index/<slug>.sqlite`, `agentik index` / `search` output) | untrusted cache of workspace files, never sealed | no | no |
| Git hook block (`agentik index --hook`, human-installed, marked, reversible) | trusted: agentik's own static text, runs only `agentik index --quiet --if-present` detached | no | no |

## Controls

1. **Structured wrapping** with a per-envelope nonce. Workers are told UNTRUSTED blocks are data.
2. **Deterministic detector** (direct, indirect, encoded, typoglycemia, tool coercion, goal hijack) on every channel, in English and French under the same rule ids; diacritics are folded before matching.
3. **Tool allowlists** on bounded tasks (least privilege / excessive-agency control).
4. **Blast-radius tags** on the catalog. High = `awaiting_approval` until the human decides.
5. **Fail closed** on unknown tools, path escape, and unattended destructive executors.
6. **Command policy** (`src/command-policy.ts`): one rule set classifies every shell command
   `medium | high | hardline` over all its segments (`&&`, `;`, `|`, `bash -c`, `sudo`, `env`…).
   High needs an approval; hardline (`rm -rf /`, `mkfs`/`dd` on a block device, fork bomb) is
   refused before any ApprovalRequest exists, so a session `--yolo` cannot release it. `run_command`
   runs a single argv with no shell, a scrubbed environment and a bounded capture.
7. **Spawn floor** (`agentik spawn`): the same rules are handed to the foreign harness as deny
   rules (claude `--settings` permissions.deny, grok `--deny`), so a `--yolo` worker still cannot
   `rm -rf`, force-push or `sudo`. Codex has no deny flag: the floor there is a trusted prompt line
   plus after-the-fact detection on the commands the stream reports (an incident, not a lock).
   `--allow-high-blast` is the human's opt-out and is announced on stderr.
8. **Memory seal** (`memory/.seal.json`): sha256 of what agentik last wrote to each memory file.
   A file that no longer matches is shown as `[BLOCKED: modified out of band]`, logged as an
   incident, and frozen for every agentik write until a human runs `agentik memory reseal`, so the
   reviewer's next write cannot launder a foreign entry. Limits: tamper-evident, not tamper-proof —
   no HMAC (the key would live in the same home), a process that can edit MEMORY.md can edit the
   seal. It catches mistakes and unprivileged prompt-injected writes, not a root attacker.
9. **Code index as a cache** (`src/code-index.ts`, `src/code-search.ts`): the index stores line
   ranges, identifiers and a trigram index of the secret-masked body — no source text — and is
   written by whoever runs a refresh (a depth-1 worker included) but **created** only by the
   conductor (depth 0) on first use, under a file cap, or by an explicit `agentik index`; it is
   never a trust source:
   every quoted line is re-read from the live file, secret-scanned and returned as untrusted data.
   Regex patterns come from workers: bounded in length and shape (no backreference, lookbehind or
   nested quantifier), in candidates (≤300 files) and in wall clock (1.5 s), so a pattern cannot
   pin the process. `search_code` hits enter a task context only when the worker asks, scanned
   per call like a `read_file`; the planner and a spawned worker get the repo map (paths and
   exported symbols, never a body line) as DATA, and the spawn hint line is static agentik text
   that interpolates only the human-given root.
10. **Output shaping is a view, not a filter** (`src/shape.ts`): the shorter text a worker sees
   for `git status`, a test run, `tsc`, `rg`… is derived from stdout only; shaping keeps the exit
   line, stderr and every failure line; the raw body is always on disk
   (`.agentik/tool-results/<callId>.txt`) and is what the injection scan, the secret masking,
   the guardrails and the run file work on. A non-zero exit in an unrecognised format is passed
   raw (fail-open), so a shaper can neither hide a failure nor launder an injection padded into
   the lines it drops. A shaper also never *eats* a body it cannot summarise: `git log -p`,
   `git log --stat`, `git log --name-only` and a `--graph` prefix return the raw output rather
   than one `hash subject` line per commit (measured before the fix: 188 609 chars of patch shaped
   into 689 chars of subjects, with no marker — the model would have believed it read the diffs).
   What a shaper does drop in bulk is announced in the shaped text itself: `…[N lines omitted]`,
   `…[N other lines omitted]`, `(+N body lines)`, `(merge)`, `(new file)`, `(deleted)`,
   `(renamed)`, `(binary, differs)`, `…[long format: … omitted]`.

## Egress — what leaves this machine, and what never expires

The controls above are about what comes **in** (untrusted content becoming an instruction). This
section is the other direction: which text leaves the machine, to whom, and how long agentik keeps
it. It reports no vulnerability; it states the paths, each one with the file that implements it, so
the human orchestrator can decide. Nothing here is hypothetical: it is the code at `2d1f3e5`.

### 1. One run can reach three vendors

`--backend auto` is the default (`src/cli.ts`, `const backendSpec = flags.backend ?? "auto"`) and
`autoCycle` (`src/backends.ts`) hands the worker slots, in order, `claude-sonnet`, `codex`,
`claude-opus`, `grok` — whichever the local CLIs are logged into (`agentik probe`). So the tasks of
a single goal are split across Anthropic, OpenAI and xAI accounts, and a backend that dies mid-run
fails over to the next of the cycle (`RunReport.backendSwitches`), which can move a task from one
vendor to another inside the same run. agentik itself holds no API key and opens no HTTPS
connection to a model provider: every call is a `spawnManaged` of the vendor's own CLI with the
user's local credentials (`ClaudeBackend` / `CodexBackend` / `GrokBackend` in `src/backends.ts`;
`agentik spawn` does the same for a foreign harness). What travels is the goal, the plan, each task
instruction, the DATA envelopes and the tool outputs quoted back into the next call.

### 2. Context from one repository reaches another repository's prompt

`buildContext` (`src/context.ts`) always renders, in this order: **USER PROFILE** (`memory/USER.md`),
**MEMORY** (`memory/MEMORY.md`, global by construction — "true in every project"), the **skills
index** (the name and description of every skill in the home), then PROJECT MEMORY (the only
per-repository store), RELATED SESSIONS and KNOWN FAILURES.

- `agentik spawn` prepends that whole block to the task as an untrusted envelope
  (`spawnContextBlock` in `src/cli.ts`, cap 6000 chars) — so the global memory written while
  working on repository A is in the prompt sent to a foreign harness for repository B.
- `agentik run` gives the same block to the **planner** (`runContextBlock`, `src/loop.ts`; task
  contexts are left out for an unrelated reason: the gate rescans every envelope).
- RELATED SESSIONS are workspace-filtered, with one deliberate hole: a session row whose workspace
  is `""` is never hidden (`src/sessions.ts`, "a session of unknown workspace … is never hidden by
  the filter"). Those rows are the ones imported from the legacy stores and any `agentik harvest`
  run without `--workspace`; their goal and summary — another project's — are searchable from every
  workspace.
- The **repo map** (`src/repo-map.ts`) goes to the planner and to a spawned worker: paths, exported
  symbols and hot spots of the current checkout, never a body line.

### 3. Nothing expires by itself

The stores that feed those prompts have no retention policy:

- **Sessions and incidents** (`sessions.sqlite`): no expiry and no delete path at all — the single
  `DELETE FROM incidents` in the tree is `incident merge` (`src/incidents.ts`). Every goal, summary,
  verdict, cause and fix is kept for ever, and `searchSessions` / `searchIncidents` put them back
  into the next `agentik context` (RELATED SESSIONS, KNOWN FAILURES).
- **Runs** (`<home>/runs/<id>.json`): the whole report — task summaries, executed tools, inline tool
  output. A sweeper exists (`gcRuns`, `keepDays` 30 / `keepLast`, and `removeRun` in `src/runs.ts`)
  but it runs only when a human calls it: nothing purges at the end of a run, on a timer, or on a
  size cap.
- **Spilled tool output** (`<workspace>/.agentik/tool-results/<nonce>-<callId>.txt`,
  `src/tool-results.ts`): the raw stdout of every large tool call, written into the workspace and
  never deleted by agentik.
- The **code index** is the exception: `gcIndexes` (90 days unused, `agentik index gc`) is wired.

Every string that lands in those files goes through the secret/injection scan first (`src/runs.ts`
masks every string leaf, `recordIncident` masks goal, symptom, cause and fix, `spillToolResult`
masks line by line), so what persists should hold no raw token. That is a filter on known secret
shapes, not a proof that nothing sensitive was written.

### 4. What the human can do today, with what already exists

- `agentik spawn --no-context` builds no context envelope at all (`src/cli.ts`): the task runs
  without USER, MEMORY, skills, sessions or known failures. `agentik run` has no such flag today —
  the switch exists as a library option (`LoopConfig.memoryContext`, `src/loop.ts`).
- **Separate homes**: `--profile P` (→ `~/.agentik/profiles/P`), `--agentik-home DIR`, or
  `AGENTIK_HOME` (`agentikHome` in `src/home.ts`) give a client, a repository or an experiment its
  own memory, sessions, incidents, runs and index. Two homes never see each other; this is the only
  hard partition of the global memory.
- **Pin the vendor**: `--backend claude|codex|grok` instead of the three-vendor rotation;
  `--no-index` removes the repo map from `context`, `run` and `spawn` (and turns `search_code` off).
- **Keep the fact local**: the reviewer's `project` target writes to
  `memory/projects/<slug>/MEMORY.md`, which is never mixed into another repository's context; and
  `agentik memory remove "<text>"` is the human's pen on the global file (with a `.bak` first).

## Sources (retrieved and attributed)

| Claim in this design | Source |
|---|---|
| Prompt injection is LLM01; instructions and data share one channel | [OWASP LLM Prompt Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) |
| Direct, indirect, encoding, typoglycemia, agent/tool manipulation are in-scope attack classes | same cheat sheet |
| Wrap untrusted content with delimiters; least-privilege tools; human approval for high-risk actions | [MLflow, How to Build a Strong Prompt Injection Defense in 2026](https://mlflow.org/articles/prompt-injection-defense/) |
| Human-in-the-loop for high-consequence / hard-to-reverse actions; sandbox and blast-radius restriction | [NCSC, Managing the cyber risk of agentic AI](https://www.ncsc.gov.uk/blogs/managing-the-cyber-risk-of-agentic-ai) |
| Agentic Top 10 adds goal hijack, tool misuse, identity/propagation (2026) | [OWASP Top 10 for Agentic Applications 2026](https://owasp.org/) (secondary write-ups: DeepInspect mapping 2026-08-18, Fidelis 2026-08-27) |
| Dual-LLM / privileged vs quarantined reader | [Simon Willison, The dual LLM pattern](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) |
| Excessive agency (LLM06) as the agent-specific amplifier | OWASP LLM Top 10 2025 |

A sentence in a run report with no recorded origin is marked **unverified**. That rule is enforced by `normalizeClaims` in `src/sources.ts`.
