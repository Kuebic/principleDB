// ingestSource — the v1 walking-skeleton pipeline (issue #2).
//
// distil → admit (relocation + admission gate) → embed admitted claims → persist.
//
// Idempotent under a pinned (sourceId, provenance) per ADR-0008: repeated
// runs replace that slot, not append.

import { admit } from './admission';
import type { CanonRepository, IngestProvider } from './ports';
import type { Source } from './types';

export interface IngestResult {
  admitted: number;
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

  await repository.replacePrinciplesForSource(source.id, provider.provenance, principles);
  if (reviewCandidates.length > 0) {
    await repository.addReviewCandidates(reviewCandidates);
  }

  return { admitted: principles.length, review: reviewCandidates.length };
}
