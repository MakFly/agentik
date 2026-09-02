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
   the lines it drops.

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
