// Admission gate — ADR-0007's load-bearing invariant:
//   "A Principle cannot be persisted to the Canon with zero relocating Quotes."
//
// Each distilled {claim, quote} is routed per-item: located → Principle, no-match →
// ReviewCandidate. Provenance (model + version + prompt version) is stamped on every
// Principle and Quote (ADR-0008), and IDs are deterministic from
// (sourceId, provenance, index): same (model, prompt) re-ingest reproduces the same
// IDs (idempotent), while a different model occupies a distinct ID slot so a
// model-mixed Canon stays additive instead of colliding on the principle PK.

import { relocate } from './relocate';
import type {
  DistilProvenance,
  DistilledItem,
  LocatedQuote,
  Principle,
  ReviewCandidate,
  Source,
} from './types';

export function provenanceTag(p: DistilProvenance): string {
  const s = `${p.distilModel}|${p.distilModelVersion}|${p.distilPromptVersion}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

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
  const tag = provenanceTag(provenance);

  for (const [idx, item] of items.entries()) {
    const result = relocate(source.text, item.quote);
    if (!result.located) {
      reviewCandidates.push({
        id: `${source.id}#${tag}#r${idx}`,
        sourceId: source.id,
        claim: item.claim,
        quoteText: item.quote,
        matchTier: 'no-match',
        dedupState: 'pending',
      });
      continue;
    }
    const principleId = `${source.id}#${tag}#p${idx}`;
    const quote: LocatedQuote = {
      id: `${source.id}#${tag}#q${idx}`,
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
