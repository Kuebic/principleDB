// Admission gate — ADR-0007's load-bearing invariant:
//   "A Principle cannot be persisted to the Canon with zero relocating Quotes."
//
// Each distilled {claim, quote} is routed per-item: located → Principle, no-match →
// ReviewCandidate. Provenance (model + version + prompt version) is stamped on every
// Principle and Quote (ADR-0008), and IDs are deterministic from (sourceId, index)
// so re-ingest under a pinned (model, prompt) is reproducible.

import { relocate } from './relocate';
import type {
  DistilProvenance,
  DistilledItem,
  LocatedQuote,
  Principle,
  ReviewCandidate,
  Source,
} from './types';

export interface AdmissionResult {
  principles: Principle[];
  reviewCandidates: ReviewCandidate[];
}

export function admit(
  source: Source,
  items: DistilledItem[],
  provenance: DistilProvenance,
): AdmissionResult {
  const principles: Principle[] = [];
  const reviewCandidates: ReviewCandidate[] = [];

  for (const [idx, item] of items.entries()) {
    const result = relocate(source.text, item.quote);
    if (!result.located) {
      reviewCandidates.push({
        id: `${source.id}#r${idx}`,
        sourceId: source.id,
        claim: item.claim,
        quoteText: item.quote,
        matchTier: 'no-match',
        dedupState: 'pending',
      });
      continue;
    }
    const principleId = `${source.id}#p${idx}`;
    const quote: LocatedQuote = {
      id: `${source.id}#q${idx}`,
      principleId,
      sourceId: source.id,
      span: result.span,
      located: true,
      matchTier: result.matchTier,
      distilPromptVersion: provenance.distilPromptVersion,
    };
    principles.push({
      id: principleId,
      claim: item.claim,
      embedding: [],
      quotes: [quote],
      distilModel: provenance.distilModel,
      distilModelVersion: provenance.distilModelVersion,
      distilPromptVersion: provenance.distilPromptVersion,
    });
  }

  return { principles, reviewCandidates };
}
