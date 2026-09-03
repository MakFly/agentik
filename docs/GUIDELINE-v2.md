# agentik v2 — guideline

Source de vérité : opentrack, équipe **AGK**, document « agentik v2 — guideline » et projet
« agentik v2 — remise à plat ». Ce fichier en est la copie de travail ; en cas d'écart, opentrack gagne.

## Les six règles

1. **L'architecte n'implémente jamais.** La session principale écrit des specs, route, relit.
2. **Les tokens se routent par capacité.** Trois lanes : implement, judgment, review. L'effort est dans la spec.
3. **Un writer = un worktree.** Créés en série, mergés `--ff-only` sous verrou depuis le checkout principal.
4. **L'humain relit.** Un diff à relire, pas un résultat à croire.
5. **Toute promesse est un témoin.** `git status`, la commande d'acceptation, l'artefact qui a bougé. Structurel, jamais lexical.
6. **Pas de fallback silencieux.** `unavailable` et stop. Jamais un modèle de remplacement, jamais un mock par défaut.

## Le contrat d'une tâche

```
GOAL:       une phrase, le résultat observable
OWNS:       les fichiers que cette lane peut éditer (un fichier, un owner)
CONTEXT:    3 lignes max, chemins + lignes, jamais un transcript
ACCEPT:     la commande qui prouve et l'artefact attendu
REASONING:  low | medium | high | max
HANDBACK:   ≤ 2000 chars : chemins, commandes, codes de sortie, ce qui reste
```

## Budget

≤ 2 000 lignes `src/` · ≤ 5 fichiers d'agents · CLAUDE.md ≤ 150 lignes · une slash command.
Toute ligne au-delà cite un incident. Toute fonctionnalité sans témoin extérieur n'entre pas.

## Ordre

AGK-1 squelette et plafonds → AGK-2 lanes → AGK-3 /ak → AGK-4 worktrees → AGK-5 témoins →
AGK-6 policy → AGK-7 incidents → AGK-8 spawn → AGK-9 arbitrage mémoire → AGK-10 bench.
