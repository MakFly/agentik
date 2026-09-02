/**
 * One source of truth for "what is a dangerous shell command".
 *
 * Two consumers, two shapes:
 *   - the orchestrator gate (`agentik run`) classifies a `run_command` argv with `re` — medium is
 *     executed, high waits for the human (or a session approval), hardline is refused outright
 *     with no ApprovalRequest, so `--yolo` cannot release it;
 *   - the spawn path hands the same rules to the foreign harness as deny globs
 *     (`renderDenyRules`: claude `Bash(rm -rf *)`, grok `--deny Bash(…)`, codex nothing — it has
 *     no deny flag, so B2 detects a posteriori with `re`).
 *
 * Classification runs on every *view* of a command: the raw line, each `&&`/`;`/`|` segment,
 * each segment with wrappers stripped (`env`, `nohup`, `sudo`, `VAR=x`, `xargs`, …) and the body
 * of every `bash -c "…"`. A rule anchored with `^` sees the command in first position; an
 * unanchored rule (`curl … | sh`, fork bomb, `drop database` inside a quoted SQL string) sees the
 * raw line. Quoted arguments are re-quoted in a view so `grep "rm -rf" README.md` stays medium.
 */

import { shellSplit, type ShellToken } from "./argv.ts";

export type CommandLevel = "medium" | "high" | "hardline";

export interface CommandRule {
  id: string;
  /** Applied to each view (see module doc). */
  re: RegExp;
  /** Claude / grok permission globs (`Bash(<glob>)`), prefix matched by the harness. */
  globs: string[];
}

/** Never released, not even by `--yolo`: there is no legitimate agentik task behind these. */
export const HARDLINE_RULES: CommandRule[] = [
  {
    id: "rm_rf_root",
    re: /^rm\b(?=.*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s|$)).*\s(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$\{HOME\}|\$HOME\/|\$HOME\/\*|\/(?:home|etc|usr|var|boot|bin|sbin|lib|lib64|root|opt|srv|dev|proc|sys)(?:\/\*?)?)(?:\s|$)/,
    globs: [],
  },
  {
    id: "mkfs_device",
    re: /^mkfs(?:\.\w+)?\s.*\/dev\/(?:sd|nvme|vd|hd|xvd|mmcblk|mapper|disk)/,
    globs: [],
  },
  {
    id: "dd_device",
    re: /^dd\s.*\bof=\/dev\/(?:sd|nvme|vd|hd|xvd|mmcblk|mapper|disk)/,
    globs: [],
  },
  {
    id: "device_wipe",
    re: /^(?:wipefs|shred|blkdiscard)\s.*\/dev\/(?:sd|nvme|vd|hd|xvd|mmcblk|mapper|disk)/,
    globs: [],
  },
  {
    id: "fork_bomb",
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    globs: [],
  },
  {
    id: "chmod_777_root",
    re: /^chmod\b(?=.*\s-[a-zA-Z]*R[a-zA-Z]*(?:\s|$))(?=.*\s777(?:\s|$)).*\s(?:\/|\/\*|~|~\/|\$HOME|\/(?:home|etc|usr|var|boot|bin|sbin|lib|root)(?:\/\*?)?)(?:\s|$)/,
    globs: [],
  },
];

/** Needs an approval (gate) and is denied at the harness level for spawned workers. */
export const HIGH_BLAST_DENY_RULES: CommandRule[] = [
  {
    id: "rm_rf",
    re: /^rm\b(?=.*\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s|$))(?=.*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?:\s|$))/,
    globs: ["rm -rf *", "rm -fr *", "rm -Rf *", "rm -fR *", "rm -r -f *", "rm -f -r *", "rm --recursive --force *", "rm --force --recursive *"],
  },
  {
    id: "git_push_force",
    re: /^git\s+(?:-\S+\s+)*push\b(?=.*(?:^|\s)(?:--force(?:-with-lease)?|-f|--force-if-includes)(?:\s|$))/,
    globs: ["git push --force *", "git push -f *", "git push --force", "git push -f", "git push * --force*", "git push * -f", "git push --force-with-lease*"],
  },
  {
    id: "git_reset_hard",
    re: /^git\s+(?:-\S+\s+)*reset\b(?=.*(?:^|\s)--hard(?:\s|$))/,
    globs: ["git reset --hard*"],
  },
  {
    id: "git_clean",
    re: /^git\s+(?:-\S+\s+)*clean\b(?=.*\s(?:-[a-zA-Z]*[fx][a-zA-Z]*|--force)(?:\s|$))/,
    globs: ["git clean -f*", "git clean -x*", "git clean -d*", "git clean --force*"],
  },
  {
    id: "git_checkout_dot",
    re: /^git\s+(?:-\S+\s+)*(?:checkout|restore)\s+(?:--\s+)?(?:\.|\*|:\/)(?:\s|$)/,
    globs: ["git checkout -- .", "git checkout .", "git restore .", "git restore -- ."],
  },
  {
    id: "find_delete",
    re: /^find\s.*(?:\s-delete(?:\s|$)|\s-exec\s+rm\b)/,
    globs: ["find * -delete*", "find * -exec rm *"],
  },
  {
    id: "sudo",
    re: /^(?:sudo|doas)(?:\s|$)/,
    globs: ["sudo *", "doas *"],
  },
  {
    id: "mkfs",
    re: /^mkfs(?:\.\w+)?(?:\s|$)/,
    globs: ["mkfs *", "mkfs.*"],
  },
  {
    id: "dd_if",
    re: /^dd\s.*\b(?:if|of)=\/dev\//,
    globs: ["dd if=/dev/*", "dd of=/dev/*", "dd * of=/dev/*"],
  },
  {
    id: "shutdown",
    re: /^(?:shutdown|reboot|halt|poweroff|init\s+[06]|systemctl\s+(?:reboot|poweroff|halt|kexec))(?:\s|$)/,
    globs: ["shutdown *", "shutdown", "reboot *", "reboot", "halt *", "halt", "poweroff *", "poweroff", "init 0", "init 6", "systemctl reboot*", "systemctl poweroff*", "systemctl halt*"],
  },
  {
    id: "chmod_777",
    re: /^chmod\s+(?:-\S+\s+)*(?:-R\s+)?777(?:\s|$)/,
    globs: ["chmod 777 *", "chmod -R 777 *", "chmod -R * 777 *"],
  },
  {
    id: "curl_pipe_sh",
    re: /\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh(?:\s|$)/,
    globs: ["curl * | sh*", "curl * | bash*", "curl * | zsh*", "curl * | sudo *", "wget * | sh*", "wget * | bash*", "wget * | sudo *"],
  },
  {
    id: "drop_db",
    re: /\bdrop\s+(?:database|schema|table)\b|\bdropdb(?:\s|$)|\bflushall\b|\bflushdb\b/i,
    globs: ["dropdb *", "psql * drop *", "mysql * drop *", "redis-cli flushall*", "redis-cli flushdb*"],
  },
  {
    id: "shutil_rmtree",
    re: /\brmtree\s*\(|\bshutil\.rmtree\b|\bfs\.rm(?:Sync)?\s*\([^)]*recursive/,
    globs: ["python -c *rmtree*", "python3 -c *rmtree*", "node -e *fs.rm*"],
  },
  {
    id: "kill_all",
    re: /^(?:kill\s+(?:-9\s+|-KILL\s+|-s\s+KILL\s+)?-1(?:\s|$)|killall(?:\s|$)|pkill\s+(?:-9|-KILL)(?:\s|$))/,
    globs: ["kill -9 -1", "kill -1", "killall *", "pkill -9 *"],
  },
  {
    id: "docker_prune",
    re: /^docker\s+(?:system|volume|image|container|network|builder)\s+prune\b|^docker\s+(?:rm|rmi|volume\s+rm)\b(?=.*\s-[a-zA-Z]*f[a-zA-Z]*(?:\s|$))/,
    globs: ["docker system prune*", "docker volume prune*", "docker image prune*", "docker container prune*", "docker network prune*", "docker rm -f *", "docker rmi -f *"],
  },
  {
    id: "terraform_destroy",
    re: /^(?:terraform|tofu|pulumi)\s+destroy\b|^terraform\s+apply\b.*\s-destroy(?:\s|$)/,
    globs: ["terraform destroy*", "tofu destroy*", "pulumi destroy*", "terraform apply * -destroy*"],
  },
  {
    id: "kubectl_delete",
    re: /^kubectl\s+(?:-\S+\s+)*delete\b|^helm\s+(?:uninstall|delete)\b/,
    globs: ["kubectl delete *", "helm uninstall *", "helm delete *"],
  },
  {
    id: "agentik_nested",
    re: /^agentik\s+(?:spawn|run)(?:\s|$)|^agentik\s+--/,
    globs: ["agentik spawn *", "agentik run *", "agentik --*"],
  },
];

/** Everything the policy knows about, hardline first. */
export const COMMAND_RULES: CommandRule[] = [...HARDLINE_RULES, ...HIGH_BLAST_DENY_RULES];

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "busybox"]);
const WRAPPERS_NO_ARG = new Set(["nohup", "time", "command", "exec", "builtin", "stdbuf", "unbuffer", "caffeinate"]);

function quoteView(tokens: ShellToken[]): string {
  return tokens
    .map((t) => (t.op ? t.text : /[\s'"|&;<>()`$]/.test(t.text) || t.text === "" ? `'${t.text.replace(/'/g, "'\\''")}'` : t.text))
    .join(" ");
}

/** Strip `VAR=x`, `env [-i] [VAR=x…]`, `nohup`, `timeout N`, `nice -n N`, `xargs [flags]`, `sudo|doas [flags]`. */
function stripWrappers(tokens: ShellToken[]): ShellToken[] {
  let t = tokens;
  for (;;) {
    while (t.length && !t[0].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0].text)) t = t.slice(1);
    if (!t.length || t[0].quoted) return t;
    const head = t[0].text;
    if (WRAPPERS_NO_ARG.has(head)) {
      t = t.slice(1);
      continue;
    }
    if (head === "env") {
      t = t.slice(1);
      while (t.length && !t[0].quoted && (t[0].text.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0].text))) t = t.slice(1);
      continue;
    }
    if (head === "timeout" || head === "nice" || head === "ionice" || head === "xargs" || head === "sudo" || head === "doas") {
      t = t.slice(1);
      while (t.length && !t[0].quoted && t[0].text.startsWith("-")) {
        const flag = t[0].text;
        t = t.slice(1);
        // Flags that take a value: `-n 10`, `-u root`, `-s 9`, `-k 5s`.
        if (/^-(?:n|u|g|s|k|I|L|P|d)$/.test(flag) && t.length) t = t.slice(1);
      }
      if (head === "timeout" && t.length && /^\d/.test(t[0].text)) t = t.slice(1);
      continue;
    }
    return t;
  }
}

/**
 * The simple commands of a line: split on `&& || ; | &`, redirections dropped, wrappers
 * stripped, `bash -c STRING` recursed. Returns rendered views (raw segment + stripped segment).
 */
export function commandSegments(input: string | string[]): string[] {
  const tokens: ShellToken[] = Array.isArray(input) ? input.map((a) => ({ text: String(a), quoted: /[\s|&;<>()`$'"]/.test(String(a)) })) : shellSplit(input);
  const views: string[] = [];
  let seg: ShellToken[] = [];
  const flush = () => {
    // Drop redirections (and the target of a `> file`).
    const clean: ShellToken[] = [];
    for (let i = 0; i < seg.length; i++) {
      const tok = seg[i];
      if (tok.op === "redirect") {
        if (!/&\d+$/.test(tok.text) && !tok.text.startsWith("&")) i += 1;
        continue;
      }
      clean.push(tok);
    }
    seg = [];
    if (!clean.length) return;
    views.push(quoteView(clean));
    const stripped = stripWrappers(clean);
    if (stripped.length && stripped !== clean) views.push(quoteView(stripped));
    // `bash -c "…"` / `sh -lc "…"`: the string is a whole new line.
    if (stripped.length >= 3 && SHELLS.has(stripped[0].text)) {
      const cIdx = stripped.findIndex((x, i) => i > 0 && !x.quoted && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x.text));
      if (cIdx > 0 && stripped[cIdx + 1]) {
        const body = stripped[cIdx + 1].text;
        views.push(body, ...commandSegments(body));
      }
    }
  };
  for (const tok of tokens) {
    if (tok.op === "control" && (tok.text === "&&" || tok.text === "||" || tok.text === ";" || tok.text === "|" || tok.text === "&")) {
      flush();
      continue;
    }
    if (tok.op === "control") continue; // ( ) $( ` — boundaries, not commands
    seg.push(tok);
  }
  flush();
  return views;
}

/** Every view a rule may match: the raw line first, then every segment. */
export function commandViews(input: string | string[]): string[] {
  const raw = Array.isArray(input) ? quoteView(input.map((a) => ({ text: String(a), quoted: /[\s|&;<>()`$'"]/.test(String(a)) }))) : input;
  const out = [raw];
  if (typeof input === "string") out.push(quoteView(shellSplit(input)));
  out.push(...commandSegments(input));
  return [...new Set(out.map((v) => v.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

export interface CommandClassification {
  level: CommandLevel;
  /** Ids of the rules that fired, hardline first. */
  rules: string[];
}

export function matchCommandRules(input: string | string[]): CommandClassification {
  const views = commandViews(input);
  const hard = HARDLINE_RULES.filter((r) => views.some((v) => r.re.test(v))).map((r) => r.id);
  const high = HIGH_BLAST_DENY_RULES.filter((r) => views.some((v) => r.re.test(v))).map((r) => r.id);
  const level: CommandLevel = hard.length ? "hardline" : high.length ? "high" : "medium";
  return { level, rules: [...hard, ...high] };
}

export function classifyCommand(input: string | string[]): CommandLevel {
  return matchCommandRules(input).level;
}

export type DenyHarness = "claude" | "grok" | "codex";

/**
 * The floor as the harness understands it. claude: entries for `permissions.deny` (settings /
 * `--disallowedTools`); grok: repeated `--deny Bash(…)` argv pairs; codex: nothing (no deny flag
 * exists — the caller says so and detects after the fact).
 */
export function renderDenyRules(harness: DenyHarness): string[] {
  if (harness === "codex") return [];
  const entries = HIGH_BLAST_DENY_RULES.flatMap((r) => r.globs.map((g) => `Bash(${g})`));
  if (harness === "claude") return entries;
  return entries.flatMap((e) => ["--deny", e]);
}
