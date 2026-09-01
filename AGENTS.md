# agentik

Human is the supreme orchestrator. Two workers take bounded tasks.

Entry is the harness: `cla`, `grok --yolo`, or `cc`. Slash **`/ak`** dumps the goal; crew adapts 0–5 (Fifth Element / Star Wars / Matrix / Retour vers le futur names, plus `a`–`e`).
Optional gated CLI: `agentik --workers N`.
High-blast without `--yolo` stays `awaiting_approval`. Workers spawn those CLIs with native Bash/Edit denied.

- Loop: `src/loop.ts` (`runLoop`)
- Detector: `src/injection.ts`
- Gate: `src/orchestrator.ts`
- Tools: `src/tools.ts` (blast tags)
- CLI: `src/cli.ts` / `bin/agentik` on PATH
- Tests drive `runLoop` and `bin/agentik`, not a copy of them.
