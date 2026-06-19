// THROWAWAY PROTOTYPE — principleDB core-spine spike. Delete or absorb when answered.
// This is the PORTABLE bit: pure logic + the distillation prompt. No I/O, no terminal
// code here, so the validated pieces can be lifted into the real codebase later.

export type Locator = { raw?: string; heading?: string; page?: number };
export type SourceMeta = { id: string; title: string; path: string; kind: string };
export type Quote = { verbatim: string; sourceId: string; sourceTitle: string; locator: Locator | null };
export type Principle = { id: string; claim: string; embedding: number[]; quotes: Quote[] };
export type Extracted = { claim: string; quote: string; locator_hint?: string | null };

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export type MatchResult = { bestId: string | null; score: number };
// Brute-force nearest neighbour. At spike scale this is EXACT — pgvector's HNSW is an
// approximation for speed at scale, so this is the cleaner test of retrieval quality.
export function bestMatch(candidate: number[], existing: Principle[]): MatchResult {
  let bestId: string | null = null, score = -1;
  for (const p of existing) {
    const s = cosine(candidate, p.embedding);
    if (s > score) { score = s; bestId = p.id; }
  }
  return { bestId, score: existing.length ? score : -1 };
}

export function stripFrontmatter(md: string): { title?: string; body: string } {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = md.slice(3, end);
      const body = md.slice(end + 4);
      const m = fm.match(/^title:\s*"?(.+?)"?\s*$/m);
      return { title: m?.[1], body: body.trim() };
    }
  }
  return { body: md.trim() };
}

// ── The distillation prompt (the keepable artifact — tweak and re-run) ───────────────
export const DISTILL_SYSTEM = `You distil a teaching into ATOMIC PRINCIPLES for a searchable knowledge base. Return JSON.

Rules:
- A Principle is ONE complete idea, stated as a single declarative claim in canonical wording (not a question, not a topic label). If a sentence carries two ideas, split it into two Principles.
- Every Principle MUST be backed by a "quote": a span copied VERBATIM from the source text (exact characters), long enough to stand as evidence. Never paraphrase the quote.
- Extract only what the text actually teaches. Invent nothing. If the text does not support a claim, do not make it.
- Prefer many sharp atomic claims over a few broad summaries.
- locator_hint: copy any nearby structural marker (a heading, section label, or scripture reference) if present, else null.

Return STRICT JSON of the form:
{"principles":[{"claim":"...","quote":"...","locator_hint":"..."|null}]}`;

export function distillUser(title: string, body: string): string {
  return `SOURCE TITLE: ${title}\n\nSOURCE TEXT:\n${body}`;
}

// ── The evolution/conflict detector prompt ──────────────────────────────────────────
export const RELATION_SYSTEM = `You compare two teaching Principles, A (older) and B (newer), and classify how B relates to A. Return JSON.

Return STRICT JSON: {"relation":"<same|related|refines|tempers|supersedes|contradicts|unrelated>","explanation":"<one sentence>"}

Definitions:
- same: identical claim.
- related: same topic, compatible.
- refines: B sharpens or qualifies A.
- tempers: B softens or balances A without rejecting it (e.g. grace tempering strict obedience).
- supersedes: B replaces A.
- contradicts: B asserts the opposite of A.
- unrelated: different topics.`;
