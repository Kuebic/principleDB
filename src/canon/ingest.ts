// ingestSource — the Canon ingest pipeline.
//
// distil → admit (relocation + admission gate) → embed admitted claims →
// conservative dedup (issue #5: vector prefilter + LLM "same claim?" confirm,
// cross-Source only) → persist.
//
// Idempotent under a pinned (sourceId, provenance) per ADR-0008: repeated
// runs replace that slot, not append. Attached-quote merges and dedup
// decisions are scoped to the same slot so they too clear on re-ingest.

import { admit } from './admission';
import { dedup } from './dedup';
import type { CanonRepository, IngestProvider } from './ports';
import type { Source } from './types';

export interface IngestResult {
  admitted: number;
  merged: number;
  review: number;
}

export async function ingestSource(
  source: Source,
  deps: { provider: IngestProvider; repository: CanonRepository },
): Promise<IngestResult> {
  const { provider, repository } = deps;
  await repository.upsertSource(source);

  const items = await provider.distil({ title: source.title, text: source.text });
  const { principles, reviewCandidates } = admit(source, items, provider.provenance);

  if (principles.length > 0) {
    const embeddings = await provider.embed(principles.map((p) => p.claim));
    principles.forEach((p, i) => {
      p.embedding = embeddings[i]!;
    });
  }

  const { freshPrinciples, attachedQuotes, decisions } = await dedup(
    principles,
    source,
    provider.provenance,
    { provider, repository },
  );

  await repository.replacePrinciplesForSource(
    source.id,
    provider.provenance,
    freshPrinciples,
    { attachedQuotes, decisions },
  );
  if (reviewCandidates.length > 0) {
    await repository.addReviewCandidates(reviewCandidates);
  }

  return {
    admitted: freshPrinciples.length,
    merged: attachedQuotes.length,
    review: reviewCandidates.length,
  };
}
