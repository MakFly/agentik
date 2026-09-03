# bench/fanout — live witness of the `/ak` fan-out doctrine

`bash bench/fanout/run.sh [--goal "…"] [--keep]` plants a 3-slot goal in a throwaway git repo,
runs `claude -p "/ak <goal>"` headless (stream-json), and reads the stream instead of the
narration: Agent calls grouped by `message.id` (one id with N calls = one parallel wave),
wall clock, cost, `git status`, `bun test`. `--analyze <stream.jsonl>` replays a kept stream.
Exit 0 = first wave ≥2 calls in ONE message. Costs about $1.5 and 5 min per run.

| date | commit | wall | cost | waves | verdict |
|---|---|---|---|---|---|
| 2026-09-03 | 7f81699 | 332 s | $1.58 | Korben+Cornelius+Ruby Rhod → Leeloo | ✓ |
