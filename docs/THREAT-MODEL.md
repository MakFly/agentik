# Threat model and verified sources

Untrusted content is **data**, never the instruction channel. High-blast-radius actions are a **state machine gate**.

## Trust boundaries

| Channel | Trust | Becomes a goal? | May run high-blast tools? |
|---|---|---|---|
| Human orchestrator CLI (`run`, `--approve-high-blast`, `--override`) | trusted | yes | only after explicit approval |
| Worker plan / act / synthesize text | untrusted | no | no |
| Fetched page / file body | untrusted | no | no |
| Tool stdout | untrusted | no | no |

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
