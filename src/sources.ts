import { wrapUntrusted } from "./trust.ts";
import type { Claim, ClaimDraft, FetchImpl, RetrievedSource } from "./types.ts";

/**
 * Retrieved content is untrusted data (OWASP indirect prompt injection).
 * A claim without a recorded origin is unverified, never presented as fact.
 */

export async function retrieveSource(
  url: string,
  fetchImpl: FetchImpl,
): Promise<RetrievedSource> {
  const page = await fetchImpl(url);
  const retrievedAt = new Date().toISOString();
  const envelope = wrapUntrusted(page.body, page.url, "retrieved");
  return { url: page.url, retrievedAt, envelope };
}

export function normalizeClaims(
  drafts: ClaimDraft[],
  sources: RetrievedSource[],
): Claim[] {
  const origins = new Set(sources.map((s) => s.url));
  const byUrl = new Map(sources.map((s) => [s.url, s]));
  return drafts.map((d) => {
    const url = d.sourceUrl?.trim() || undefined;
    if (!url) {
      return { text: d.text, verified: false };
    }
    const src = byUrl.get(url);
    if (!src || !origins.has(url)) {
      return { text: d.text, source: { url, retrievedAt: "" }, verified: false };
    }
    return {
      text: d.text,
      source: { url: src.url, retrievedAt: src.retrievedAt },
      verified: true,
    };
  });
}

export function claimsFromRetrieved(sources: RetrievedSource[]): Claim[] {
  return sources.map((s) => ({
    text: excerpt(s.envelope.body, 240),
    source: { url: s.url, retrievedAt: s.retrievedAt },
    verified: true,
  }));
}

function excerpt(body: string, max: number): string {
  const t = body.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}
