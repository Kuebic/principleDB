// Conservative dedup (issue #5, ADR-0006).
//
// Vector prefilter + LLM confirm. A repeated idea across Sources attaches a
// new Quote to the existing Principle instead of duplicating it; a genuinely
// distinct framing stays a separate Principle. No human gate.
//
// Scope: CROSS-source only — the in-batch principles from this same source
// are not candidates for self-merge, and the repository query excludes the
// current sourceId so a re-ingest under a different provenance (ADR-0008
// model-mixed Canon) cannot collapse into itself.
//
// The rationale on every LLM consultation is persisted so the Owner can
// inspect dedup decisions (PRD AC #3).

import { provenanceTag } from './admission';
import type { CanonRepository, IngestProvider, SearchHit } from './ports';
import type {
  DedupDecision,
  DistilProvenance,
  LocatedQuote,
  Principle,
  Source,
} from './types';

// Bag-of-words cosine on a 128-d hash is approximate; the LLM confirm is the
// real authority. Set the prefilter low enough to catch paraphrases ("Grace
// comes before obedience") that share most content tokens.
export const DEFAULT_DEDUP_THRESHOLD = 0.4;

// Top-K candidates pulled per new Principle. 5 is enough to catch near-misses
// without ballooning LLM calls; the loop breaks on the first confirmed merge.
const DEFAULT_TOP_K = 5;

export interface DedupContext {
  provider: IngestProvider;
  repository: CanonRepository;
  threshold?: number;
  topK?: number;
}

export interface DedupResult {
  freshPrinciples: Principle[];
  attachedQuotes: LocatedQuote[];
  decisions: DedupDecision[];
}

export async function dedup(
  principles: Principle[],
  source: Source,
  provenance: DistilProvenance,
  ctx: DedupContext,
): Promise<DedupResult> {
  const threshold = ctx.threshold ?? DEFAULT_DEDUP_THRESHOLD;
  const topK = ctx.topK ?? DEFAULT_TOP_K;
  const tag = provenanceTag(provenance);

  const freshPrinciples: Principle[] = [];
  const attachedQuotes: LocatedQuote[] = [];
  const decisions: DedupDecision[] = [];
  let decisionIdx = 0;

  const buildDecision = (
    candidate: SearchHit,
    candidateClaim: string,
    verdict: DedupDecision['verdict'],
    rationale: string,
  ): DedupDecision => ({
    id: `${source.id}#${tag}#d${decisionIdx++}`,
    sourceId: source.id,
    candidateClaim,
    existingPrincipleId: candidate.principle.id,
    verdict,
    rationale,
    similarityScore: candidate.score,
    distilModel: provenance.distilModel,
    distilModelVersion: provenance.distilModelVersion,
    distilPromptVersion: provenance.distilPromptVersion,
  });

  for (const [idx, principle] of principles.entries()) {
    const candidates = await ctx.repository.findSimilarPrinciplesExcludingSource(
      principle.embedding,
      source.id,
      threshold,
      topK,
    );

    if (candidates.length === 0) {
      freshPrinciples.push(principle);
      continue;
    }

    let merged = false;
    for (const candidate of candidates) {
      const verdict = await ctx.provider.confirmSameClaim(
        principle.claim,
        candidate.principle.claim,
      );
      if (!verdict.same) {
        decisions.push(buildDecision(candidate, principle.claim, 'kept-separate', verdict.rationale));
        continue;
      }
      // Attach this source's Quote to the existing Principle. The Quote ID
      // is provenance-scoped to (sourceId, provenance, idx) so a re-ingest
      // under the same provenance writes the same row again (idempotent),
      // and a re-ingest under a different provenance is additive (distinct
      // ID).
      const original = principle.quotes[0]!;
      attachedQuotes.push({
        ...original,
        id: `${source.id}#${tag}#aq${idx}`,
        principleId: candidate.principle.id,
      });
      decisions.push(buildDecision(candidate, principle.claim, 'merged', verdict.rationale));
      merged = true;
      break;
    }

    if (!merged) freshPrinciples.push(principle);
  }

  return { freshPrinciples, attachedQuotes, decisions };
}
