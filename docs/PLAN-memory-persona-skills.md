# Plan d'évolution — mémoire, persona, skills (« à la Hermes »)

Branche : `develop`. Date : 1er septembre 2026.
Référence auditée : NousResearch/hermes-agent, commit `18a76be`, 239 k★, MIT, release
`v2026.8.31`, commits du jour même — référence vivante. Chaque affirmation « Hermes » ci-dessous
est sourcée dans l'audit Ruby Rhod (`B/` = blob du commit) ; ce plan ne garde que ce qui compte.

---

## 1. État mesuré d'agentik

| Couche | Fichier | Constat mesuré |
|---|---|---|
| HOT | `~/.agentik/memory/MEMORY.md` | **2200 / 2200 — saturée.** Aucune éviction : tout part en WARM depuis. 10 lignes `session: <goal> [completed] artifacts=…`, zéro fait durable. |
| WARM | `notes.sqlite` (FTS5) | 13 notes, toutes des sessions. `tokenize='porter'` = stemmer anglais sur des goals français. |
| Persona | `USER.md` | **Inexistante.** `USER_CAP=1375` et le chemin déclarés (`memory.ts:7`, `home.ts:13`), jamais lus ni écrits. |
| Skills | `~/.agentik/skills/*/SKILL.md` | 15 auto-générées. 13/15 = goal français slugifié coupé à 64 chars en plein mot. Symlinkées dans `~/.claude` (18), `~/.grok` (17), `~/.codex` (18) → dans le contexte de chaque harnais à chaque tour. |
| Rappel | `recall()` | `includes()` littéral sur HOT ; FTS5 anglais sur WARM. Aucun scoping. |
| Seuil skill | `shouldDraftSkill` | ≥5 outils **ou** ≥2 artefacts. `learned-workflow` = repli écrasé à chaque collision. |
| Secrets | `looksLikeSecret` | 6 mots-clés, notes seulement ; les skills écrivent goal + artefacts sans filtre. |
| Qui écrit | `reviewAfterRun` | **Du code**, sans modèle : une ligne de log par run. |

## 2. Ce que Hermes fait réellement, et l'écart

| Sujet | Hermes (sourcé) | agentik | Écart |
|---|---|---|---|
| Qui écrit la mémoire | **Le modèle**, via un tool `memory` `add/replace/remove` (`B/tools/memory_tool.py#L1256-L1300`) | du code, un log par run | structurel |
| Cap atteint | Pas d'auto-compaction. `add` échoue avec « Consolidate now: use replace/remove, then retry — all in this turn », 3 échecs max par tour (`#L446-L465`, `#L170-L215`) | débordement silencieux en WARM | le cap est une **force de consolidation**, pas une limite |
| Contenu attendu | faits déclaratifs, pas d'impératifs ; routage par longévité : < 1 semaine → historique de session, procédure → skill (`B/agent/prompt_builder.py#L210-L241`) | sessions dans HOT | inversé |
| Format | entrées séparées par `\n§\n`, multiligne, dédup exacte (`#L16`, `#L442`) | lignes `- (kind) …` | mineur |
| Recherche | **aucune** sur MEMORY/USER. FTS5 sur les **sessions** (unicode61 + trigram + cjk), tool `session_search` 4 modes, 0 appel LLM (`B/hermes_state_search.py`) | FTS5 porter sur les notes | on cherche au mauvais endroit |
| Injection | snapshot **gelé au démarrage de session**, tier volatile après l'index des skills, jamais rafraîchi en cours de session (prefix cache) (`B/agent/system_prompt.py#L925-L937`) | `recallBeforeRun` par `includes()` | — |
| USER.md | inféré par le modèle : « save proactively when the user states a preference, correction, or personal detail », priorité préférences/corrections > env > procédures (`#L1266-L1270`) ; relu par la review de fond (`B/agent/background_review.py#L465-L474`) | rien | absent |
| Persona de l'agent | `SOUL.md` séparé, première section du prompt | rien | absent (et hors périmètre : agentik n'a pas de modèle propre) |
| Scoping | par **profil** (home séparé), projet via context files (`.hermes.md`/`AGENTS.md`) ; « one agent per home » | un seul store | absent |
| Nommage skill | `^[a-z0-9][a-z0-9._-]*$` ≤64, description ≤60 chars **imposée à la création**, « CLASS-LEVEL… MUST NOT be a PR number, error string, or fix-X / debug-Y session artifact » (`B/agent/background_review.py#L536-L541`) | slug du goal, coupé | c'est exactement l'anti-pattern interdit |
| Création skill | review de fond toutes les 10 itérations d'outil ; ordre imposé : **patcher** une skill chargée > patcher un umbrella > ajouter un fichier support > créer (`#L500-L541`) ; read-before-write | seuil de volume, upsert aveugle | — |
| Découverte | progressive disclosure : index `name: description` (≤57 chars) dans le prompt, corps chargé par `skill_view` à la demande (`B/agent/prompt_builder.py#L2105-L2135`) | symlink complet dans 3 harnais | pollution |
| Anti-pollution | curator : usage → `stale` 30 j → `archived` 90 j, jamais de suppression, snapshot avant passe, rollback ; `write_approval` optionnel (`B/agent/curator.py`) | rien | — |
| Boucle | fin de **tour**, **fork du même agent** rejouant la conversation, outils whitelistés (memory, skill_*, read), 16 itérations max, modèle secondaire optionnel (`B/agent/turn_finalizer.py#L796-L816`) | code, à la fin du run | pas de jugement |
| Secrets | scan `hardcoded_secret` + injection sur chaque écriture ET au chargement, entrée remplacée par `[BLOCKED]` (`B/tools/memory_tool.py#L84-L100`) | 6 mots-clés, notes seulement | — |
| Sous-agents | interdits d'écrire MEMORY.md (`DELEGATE_BLOCKED_TOOLS`) | n/a | à reprendre tel quel |

**Diagnostic de fond.** Ce qui fait la qualité de la mémoire Hermes, c'est qu'un modèle décide
ce qui vaut d'être retenu, sous la contrainte d'un cap qui l'oblige à consolider, avec une
review de fond qui relit la conversation. agentik n'a aucun modèle dans cette boucle : il
journalise. Tout le reste (noms de skills, HOT saturée, USER.md vide) en découle.

**Ce qu'on ne copie pas, et pourquoi.** agentik n'est pas un runtime d'agent : c'est un
conducteur au-dessus de trois harnais (claude / grok / codex). Pas de `SOUL.md`, pas de
compaction de contexte, pas de gateway : ce sont les harnais qui portent ça. On copie la
**discipline** (cap-force-consolidation, review de fond, progressive disclosure, curator), pas
le runtime.

## 3. Cible

```
                     ┌──────────────────────────────────────────────┐
                     │  ~/.agentik/<profil>/                        │
                     │   memory/MEMORY.md   faits, cap 2200, § sep  │
                     │   memory/USER.md     profil, cap 1375        │
                     │   sessions.sqlite    runs + verdicts, FTS5   │
                     │                      unicode61+trigram       │
                     │   skills/<name>/SKILL.md  + .usage.json      │
                     │   skills/.archive/                           │
                     └──────────────────────────────────────────────┘
                              ▲ lit                ▲ écrit (tool memory / skill_manage)
                              │                    │
   ┌──────────────────────────┴────────┐   ┌───────┴──────────────────────────────┐
   │ AVANT la run                      │   │ APRÈS la run : agentik review        │
   │  snapshot MEMORY + USER           │   │  = fork headless (claude -p sonnet   │
   │  index skills  name: desc ≤60     │   │    ou codex) qui reçoit :            │
   │  session_search(goal) top-k       │   │    transcript + verdict + snapshot   │
   │  → bloc CONTEXT pour le           │   │    + index skills                    │
   │    conducteur / les workers       │   │  outils : memory add/replace/remove, │
   └───────────────────────────────────┘   │    skill view/patch/create, read     │
                                           │  bornes : 16 itérations, 1 skill max │
                                           │  cap → « consolidate now », 3 essais │
                                           │  sous-agents : jamais d'écriture     │
                                           └──────────────────────────────────────┘
```

Décisions :

1. **La mémoire est écrite par un modèle, plus par du code.** `agentik review` remplace
   `reviewAfterRun`. C'est un `agentik spawn` interne sur un harnais bon marché, avec un
   contrat d'outils réduit (`memory`, `skill_*`, `read_file`) rendu par le mécanisme de
   `toolCalls` gatés déjà en place. Le fork reçoit le transcript de la run, le verdict
   (`turns/tools/artefacts`), le snapshot MEMORY/USER et l'index des skills.
2. **Le cap force la consolidation.** `memory add` au-dessus du cap échoue avec le message
   Hermes et la liste des entrées ; 3 échecs par review, puis abandon. Plus jamais de
   débordement silencieux. WARM disparaît : une note qui ne tient pas en HOT n'est pas un
   fait durable, elle appartient à la session.
3. **USER.md existe et n'est écrit que sur préférence, correction ou détail personnel
   exprimé par l'utilisateur** — jamais inféré d'un goal. Chargé en tête de bloc CONTEXT.
4. **Les sessions deviennent la mémoire cherchable.** `sessions.sqlite` remplace
   `notes.sqlite` : une ligne par run (goal, workspace, statut, verdict, artefacts, résumé),
   FTS5 `unicode61 remove_diacritics 2` + trigram. `agentik memory search` = `session_search`.
5. **Scoping par profil + projet.** `--profile` (défaut `default`) = home séparé ;
   `workspace` stocké sur chaque session et filtre par défaut du rappel.
6. **Skills : nom de classe, description ≤60, patch avant création.** Validation dure
   (`^[a-z0-9][a-z0-9._-]*$`, ≤40 chars sur mots entiers, refus des motifs
   `fix-…/debug-…/audit-…-today`, refus si la description dépasse 60). Pas de repli : pas de
   nom dérivable = pas de skill. Ordre imposé au fork : patcher une skill chargée > patcher un
   umbrella > créer. Read-before-write.
7. **Progressive disclosure, plus de symlinks par défaut.** Le bloc CONTEXT porte l'index
   `name: description` ; le corps est lu à la demande. `--link-harness` reste possible mais
   opt-in, et ne lie que les skills pinnées.
8. **Curator.** `.usage.json` par skill ; `agentik skills curate` : stale 30 j → archived
   90 j, jamais de suppression, snapshot `tar.gz` avant, rollback.
9. **Secrets et injection scannés à l'écriture ET au chargement**, sur mémoire et skills,
   entrée remplacée par `[BLOCKED: motif]` dans le snapshot, conservée sur disque.
10. **Approbation optionnelle.** `memory.write_approval` / `skills.write_approval` :
    staging `pending/`, `agentik memory pending|approve|reject`. Off par défaut, comme Hermes.

## 4. Diagramme d'évolution

```
 AUJOURD'HUI                                    CIBLE
 ═══════════                                    ═════

 run ──► reviewAfterRun (code)                  run ──► verdict ──► agentik review (modèle)
           │                                                          │  memory add/replace/remove
           ├─ retainNote("session: …")                                │  skill view/patch/create
           │     └─ HOT pleine ──► WARM (silence)                      │  cap → consolidate, 3 essais
           │                                                          │  1 skill max, patch d'abord
           └─ ≥2 artefacts ──► upsertSkill(slug(goal))                 └─ sessions.sqlite ◄─ run+verdict
                 └─ symlink ×3 harnais ──► contexte pollué

 MEMORY.md  = log de sessions, figé            MEMORY.md  = faits durables, consolidé par le modèle
 USER.md    = n'existe pas                     USER.md    = préférences/corrections explicites
 notes.sqlite = sessions, porter EN            sessions.sqlite = runs+verdicts, unicode61+trigram
 skills     = 15 slugs tronqués, 53 symlinks   skills     = classes nommées, index ≤60, curator
 recall     = includes()                       recall     = snapshot gelé + session_search top-k
 scope      = global                           scope      = profil + workspace


 LOTS (ordre = rentabilité / risque)

  L0  stop-the-bleed     L1  sessions+recall       L2  review par modèle     L3  curator+approval
  ────────────────────   ─────────────────────     ────────────────────────  ────────────────────
  • validation nom+desc  • sessions.sqlite         • agentik review          • .usage.json
  • pas de repli         • FTS5 unicode61+trigram  • tool memory (cap force) • stale/archive
  • symlink opt-in       • --profile / workspace   • USER.md écrit/chargé    • pending/approve
  • seuil = 0 skill par  • agentik memory search   • skill patch>create      • agentik skills curate
    le code              • snapshot gelé           • scan écriture+lecture
  • nettoyage 53 liens   • CONTEXT block           • sous-agents read-only
  ~1 j                   ~2 j                      ~3 j                      ~2 j
```

## 5. Lots, preuves

### L0 — arrêter la casse (avant tout le reste)
- `slugifySkillName` → `skillNameFrom(goal)` : classe ≤40 chars sur mots entiers, refus des
  motifs session (`fix-`, `debug-`, `audit-…`, numéro de ticket), **retourne `null`** au lieu
  de `learned-workflow`.
- `shouldDraftSkill` → toujours `false` côté code : le code n'a plus le droit de créer une
  skill ; seul le lot L2 (modèle) le pourra.
- `linkHarness` opt-in (`--link-harness`), jamais par défaut.
- Nettoyage : suppression des 53 symlinks (réversible), archivage des 15 skills dans
  `~/.agentik/skills/.archive/` — **avec accord explicite avant exécution**.
- Preuve : tests sur le nommage (10 goals réels de HOT → 0 nom tronqué, 0 repli) ;
  `ls ~/.claude/skills | grep -c agentik` = 0 ; ma liste de skills au tour suivant ne montre
  plus les 15 entrées.

### L1 — sessions cherchables, scoping, snapshot
- `sessions.sqlite` (goal, workspace, profile, status, verdict JSON, artifacts, summary,
  created_at) ; FTS5 `unicode61 remove_diacritics 2` + table trigram.
- `agentik memory search "<q>" [--workspace] [--all]` ; `recallBeforeRun` l'utilise, top-6,
  filtre workspace par défaut.
- `--profile` → `~/.agentik/<profile>/` ; `AGENTIK_PROFILE` env.
- `agentik context` : imprime le bloc CONTEXT (USER + MEMORY + index skills + top-k sessions)
  — c'est ce que `/ak` lira au lieu de `memory recall` + `memory hot`.
- Preuve : recherche « tiroir » retrouve la session « drawer PWA » via trigram ; « clôturer »
  et « cloturer » renvoient la même chose ; une session d'un autre workspace n'apparaît pas
  sans `--all`.

### L2 — la review par un modèle
- Tool `memory` (`add/replace/remove`, cible `memory|user`, batch atomique) dans le catalogue
  gaté ; cap → erreur « Consolidate now… », 3 échecs max ; dédup exacte ; scan à l'écriture.
- `agentik review --run <id>` : spawn headless (défaut `claude -p --model sonnet`, sinon codex),
  outils whitelistés, 16 itérations max, prompt = `_MEMORY_REVIEW_PROMPT` + `_SKILL_REVIEW_PROMPT`
  adaptés (critères Hermes : correction utilisateur, workflow non trivial, skill chargée
  fausse ; interdits : échecs d'environnement, erreurs transitoires, narratifs one-off).
- `skill_manage view|patch|create` avec read-before-write et l'ordre patch > create ;
  description ≤60 imposée.
- `reviewAfterRun` supprimé ; `/ak` appelle `agentik review` à la place de `harvest`.
- Preuve : sur 5 runs réels, MEMORY.md contient des faits (pas de `session:`), USER.md n'est
  écrit que sur une correction explicite dans le transcript, 0 skill créée pour un one-shot,
  1 patch sur une skill existante quand la run l'a contredite.

### L3 — curator et approbation
- `.usage.json` incrémenté par `skill view` ; `agentik skills curate` : stale 30 j →
  archived 90 j, snapshot avant, `--rollback`.
- `memory.write_approval` / `skills.write_approval` → `pending/`, `agentik memory pending|approve|reject`.
- Preuve : une skill non vue depuis 31 j passe `stale` ; rollback restaure l'état exact.

## 6. Hors périmètre, assumé
`SOUL.md`, compaction, gateway, sandboxes, providers mémoire externes, Honcho : ce sont des
primitives de runtime d'agent. agentik reste un conducteur ; les harnais les portent.
