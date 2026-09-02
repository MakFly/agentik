// Loaded before every test file (bunfig.toml [test] preload). The code index builds itself on
// first use; a test that drives `agentik context` / `run` / `spawn` without an explicit home
// would otherwise write an index of a test workspace — or of a real project named in a fixture —
// into the developer's ~/.agentik. Off by default here; a test that wants the auto-build sets
// process.env.AGENTIK_INDEX_AUTO = "1" (and restores it) or passes `env` / `auto` explicitly.
process.env.AGENTIK_INDEX_AUTO = "0";
