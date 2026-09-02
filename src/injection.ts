import type { Channel, InjectionFinding } from "./types.ts";

/**
 * Deterministic prompt-injection detector.
 *
 * Patterns and defenses follow:
 * - OWASP LLM Prompt Injection Prevention Cheat Sheet
 *   (direct, indirect, encoding, typoglycemia, agent/tool manipulation)
 * - OWASP LLM Top 10 LLM01 (prompt injection) / LLM06 (excessive agency)
 * - OWASP Top 10 for Agentic Applications 2026 (goal hijack / tool misuse)
 *
 * This is detection + isolation, not a claim of zero false negatives.
 */

export interface InjectionRule {
  id: string;
  severity: "low" | "medium" | "high";
  re: RegExp;
}

export const INJECTION_RULES: InjectionRule[] = [
  {
    id: "ignore_previous_instructions",
    severity: "high",
    re: /\b(ignore|disregard|forget|discard)\s+(all\s+)?(previous|prior|above|preceding)\s+(instructions?|directives?|prompts?|rules?|goals?|context)\b|\b(ignore[sz]?|oublie[sz]?|efface[sz]?|ne\s+tiens\s+plus\s+compte\s+de[s]?)\s+(toutes?\s+)?(les\s+|tes\s+|vos\s+|ces\s+)?(instructions?|consignes?|regles?|directives?)\s+(precedentes?|anterieures?|ci-dessus|d'avant|au-dessus|donnees\s+plus\s+haut)\b|\boublie[sz]?\s+tout\s+ce\s+qui\s+precede\b/i,
  },
  {
    id: "override_system",
    severity: "high",
    re: /\b(system\s+override|override\s+(the\s+)?(system|goal|instructions?)|your\s+new\s+(instructions?|goal|directives?))\b/i,
  },
  {
    id: "goal_hijack",
    severity: "high",
    re: /\bnew\s+goal\s*[:\-]|from\s+now\s+on\s+your\s+goal\b|\breplace\s+(the\s+)?(current\s+)?goal\b|\bnouvel\s+objectif\s*[:\-]|\bnouvelle\s+mission\s*[:\-]|\b(desormais|dorenavant|a\s+partir\s+de\s+maintenant)[,]?\s+(ton|votre)\s+(objectif|but|mission)\b|\bremplace[sz]?\s+(l'|le\s+)?objectif\b/i,
  },
  {
    id: "jailbreak_persona",
    severity: "high",
    re: /\b(you\s+are\s+now\s+(in\s+)?(developer|god|dan|jailbreak|sudo)\s+mode|do\s+anything\s+now|\bDAN\b|jailbreak)\b/i,
  },
  {
    id: "role_hijack",
    severity: "high",
    re: /\b(enter\s+(developer|maintenance|unrestricted)\s+mode|act\s+as\s+if\s+you(?:'re| are) not bound|no\s+restrictions?\s+apply)\b|\btu\s+es\s+maintenant\b|\b(desormais|dorenavant)[,]?\s+tu\s+(es|dois|vas|n'as\s+plus)\b|\bmode\s+sans\s+(restrictions?|limites?)\b|\bpasse\s+en\s+mode\s+(developpeur|maintenance|sans\s+restriction)\b/i,
  },
  {
    id: "reveal_system_prompt",
    severity: "medium",
    re: /\b(reveal|repeat|print|dump|show)\s+(your\s+)?(system\s+)?(prompt|instructions?|hidden\s+rules)\b|\b(revele[sz]?|affiche[sz]?|montre[sz]?|repete[sz]?|devoile[sz]?|donne[sz]?)(-|\s+)?(moi)?\s+(ton|le|tes|les|votre|vos)?\s*(prompt\s+systeme|instructions?\s+(cachees?|systeme|secretes?)|regles?\s+cachees?|consignes?\s+cachees?)\b/i,
  },
  {
    id: "tool_coercion",
    severity: "high",
    re: /\b(call|invoke|run|execute)\s+tool\s+(server_admin|fs_destructive|credential_use)\b|\b(appelle[sz]?|invoque[sz]?|lance[sz]?|execute[sz]?|utilise[sz]?)\s+(l['\u2019]\s*)?outil\s+(server_admin|fs_destructive|credential_use)\b/i,
  },
  {
    id: "destructive_coercion",
    severity: "high",
    re: /\b(wipe|destroy|rm\s+-rf\s+\/|drop\s+database|exfiltrate|send\s+(secrets?|keys?)\s+to)\b|\b(execute[sz]?|lance[sz]?)\s+rm\s+-rf\b|\bsupprime[sz]?\s+(tout|le\s+disque|la\s+base(\s+de\s+donnees)?|toutes?\s+les\s+donnees)\b|\b(envoie[sz]?|transmet[sz]?|exfiltre[sz]?)\s+(les\s+|tes\s+|vos\s+)?(cles?|secrets?|tokens?|mots?\s+de\s+passe)\s+(vers|a)\b/i,
  },
  {
    id: "thought_injection",
    severity: "medium",
    re: /\b(thought|observation|action)\s*:\s*(i\s+should\s+ignore|ignore\s+safety|bypass)\b/i,
  },
  {
    id: "exfil_markup",
    severity: "medium",
    re: /<img[^>]+src=['"]https?:\/\/[^'"]+['"][^>]*>|\bmarkdown\s+image\s+exfil\b/i,
  },
];

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u00AD\u2060]/g;
const TYPO_TARGETS = [
  "ignore",
  "bypass",
  "override",
  "reveal",
  "delete",
  "jailbreak",
  "instructions",
  "prompt",
  // French (folded: no diacritics, see normalizeForScan)
  "oublie",
  "consignes",
  "objectif",
  "revele",
  "supprime",
  "contourne",
  "desormais",
  "precedentes",
];

/**
 * NFKC (compatibility forms), zero-width strip, then NFD + combining-mark strip: the same fold
 * as sessions.ts, so « précédentes », « precedentes » and a decomposed accent all reach the
 * rules as `precedentes`. The French rules are written in that folded form.
 */
export function normalizeForScan(text: string): string {
  let s = text.normalize("NFKC").replace(ZERO_WIDTH, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/\s+/g, " ");
  // Collapse spaced-out letters: "i g n o r e" -> "ignore"
  s = s.replace(/(?:\b[a-zA-Z]\s+){3,}[a-zA-Z]\b/g, (m) => m.replace(/\s+/g, ""));
  return s;
}

function isTypoglycemia(word: string, target: string): boolean {
  if (word.length !== target.length || word.length < 4) return false;
  if (word[0] !== target[0] || word[word.length - 1] !== target[target.length - 1]) {
    return false;
  }
  const middle = word.slice(1, -1);
  const targetMiddle = target.slice(1, -1);
  if (middle === targetMiddle) return false;
  return [...middle].sort().join("") === [...targetMiddle].sort().join("");
}

function decodeSuspiciousPayloads(text: string): string[] {
  const out: string[] = [];
  const b64 = text.match(/[A-Za-z0-9+/]{24,}={0,2}/g) ?? [];
  for (const token of b64) {
    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      if (/^[\x09\x0a\x0d\x20-\x7e]{8,}$/.test(decoded)) out.push(decoded);
    } catch {
      /* ignore */
    }
  }
  const hex = text.match(/\b(?:[0-9a-fA-F]{2}){12,}\b/g) ?? [];
  for (const token of hex) {
    try {
      const decoded = Buffer.from(token, "hex").toString("utf8");
      if (/^[\x09\x0a\x0d\x20-\x7e]{8,}$/.test(decoded)) out.push(decoded);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function excerptAround(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  if (!m || m.index == null) return undefined;
  const start = Math.max(0, m.index - 24);
  const end = Math.min(text.length, m.index + m[0].length + 24);
  return text.slice(start, end).trim();
}

export function detectInjection(
  text: string,
  channel: Channel,
  origin: string,
): InjectionFinding {
  const finding: InjectionFinding = {
    detected: false,
    severity: "none",
    ruleIds: [],
    excerpts: [],
    channel,
    origin,
  };
  if (!text) return finding;

  const variants = [normalizeForScan(text), ...decodeSuspiciousPayloads(text).map(normalizeForScan)];

  const bump = (id: string, severity: InjectionFinding["severity"], excerpt?: string) => {
    if (!finding.ruleIds.includes(id)) finding.ruleIds.push(id);
    if (excerpt && !finding.excerpts.includes(excerpt)) finding.excerpts.push(excerpt);
    finding.detected = true;
    const rank = { none: 0, low: 1, medium: 2, high: 3 };
    if (rank[severity] > rank[finding.severity]) finding.severity = severity;
  };

  for (const variant of variants) {
    for (const rule of INJECTION_RULES) {
      if (rule.re.test(variant)) {
        bump(rule.id, rule.severity, excerptAround(variant, rule.re));
      }
    }

    const words = variant.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [];
    for (const word of words) {
      for (const target of TYPO_TARGETS) {
        if (isTypoglycemia(word, target)) {
          bump("typoglycemia_" + target, "medium", word);
        }
      }
    }
  }

  // Untrusted channels: "new goal" / tool coercion is always high.
  if (channel !== "user_input" && finding.ruleIds.includes("goal_hijack")) {
    finding.severity = "high";
  }

  return finding;
}

export function isGoalHijack(finding: InjectionFinding): boolean {
  if (!finding.detected) return false;
  return (
    finding.severity === "high" &&
    (finding.ruleIds.includes("ignore_previous_instructions") ||
      finding.ruleIds.includes("goal_hijack") ||
      finding.ruleIds.includes("override_system") ||
      finding.ruleIds.includes("jailbreak_persona") ||
      finding.ruleIds.includes("role_hijack") ||
      finding.ruleIds.includes("tool_coercion") ||
      finding.ruleIds.includes("destructive_coercion"))
  );
}

export function scanText(text: string, channel: Channel, origin: string): InjectionFinding {
  return detectInjection(text, channel, origin);
}
