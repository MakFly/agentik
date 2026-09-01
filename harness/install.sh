#!/usr/bin/env bash
# Install agentik into Claude, Grok, and Codex user harness paths (symlinks).
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SKILL="$ROOT/harness/skill"
AGENTS="$ROOT/harness/agents"

link() {
  local src="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  ln -sfn "$src" "$dest"
}

link "$SKILL" "$HOME/.claude/skills/agentik"
link "$SKILL" "$HOME/.grok/skills/agentik"
link "$SKILL" "$HOME/.codex/skills/agentik"
link "$ROOT/harness/ak" "$HOME/.claude/skills/ak"
link "$ROOT/harness/ak" "$HOME/.grok/skills/ak"
link "$ROOT/harness/ak" "$HOME/.codex/skills/ak"

for letter in a b c d e; do
  src="$AGENTS/agentik-worker-${letter}.md"
  link "$src" "$HOME/.claude/agents/agentik-worker-${letter}.md"
  link "$src" "$HOME/.grok/agents/agentik-worker-${letter}.md"
  link "$src" "$HOME/.codex/agents/agentik-worker-${letter}.md"
done

# Themed spawn names (same 5 slots: Fifth Element, Star Wars, Matrix, Retour vers le futur)
themed=(
  Korben.md Luke.md Neo.md Marty.md
  Leeloo.md Leia.md Trinity.md Doc.md
  Cornelius.md Han.md Morpheus.md Biff.md
  Ruby-Rhod.md Yoda.md Oracle.md George.md
  Zorg.md Vader.md Agent-Smith.md Lorraine.md
)
for f in "${themed[@]}"; do
  src="$AGENTS/$f"
  link "$src" "$HOME/.claude/agents/$f"
  link "$src" "$HOME/.grok/agents/$f"
  link "$src" "$HOME/.codex/agents/$f"
done

mkdir -p "$HOME/.grok/rules"
link "$ROOT/harness/rules/agentik.md" "$HOME/.grok/rules/agentik.md"

echo "agentik harness installed:"
echo "  skill  ~/.claude/skills/agentik + /ak   (claude/grok/codex)"
echo "  agents agentik-worker-a … e (claude/grok/codex)"
echo "  rules  ~/.grok/rules/agentik.md"
