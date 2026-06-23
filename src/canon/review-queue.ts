// Review queue — list & resolve the `no-match` ReviewCandidates the admission
// gate surfaces (slice 6, issue #6).
//
// Two ops, one question: *is this a faithful atomic extraction?* Review does
// NOT adjudicate doctrine — two contradictory teachings can both be admitted
// here (ADR-0003 as refined by 0006/0007). The honesty guarantee still holds:
// confirm/correct re-relocate against the Source's continuous text before
// admitting, enforcing the ≥1-relocating-Quote invariant (ADR-0007).
//
// `listReviewQueue` returns a summary-first view (progressive disclosure) so
// the AI client can render the queue without piping the full quote text.
//
// `resolveReviewItem`:
//   • confirm — the candidate as-is; re-relocate; admit if it now locates,
//     decline (and keep the row) if not
//   • correct — the Owner supplies a corrected quote (and optionally a claim);
//     relocate the corrected quote; admit on success
//   • reject — drop the candidate; no Principle written

import { relocate } from './relocate';
import type { CanonRepository, IngestProvider } from './ports';
import type { LocatedQuote, MatchTier, Principle, ReviewCandidate } from './types';

const DEFAULT_QUOTE_PREVIEW_CHARS = 160;
const DEFAULT_LIST_LIMIT = 25;

export interface ListReviewQueueOptions {
  limit?: number;
  offset?: number;
}

export interface ReviewQueueItem {
  id: string;
  sourceId: string;
  sourceTitle: string;
  claim: string;
  quoteTextPreview: string;
  quoteTextLength: number;
  matchTier: ReviewCandidate['matchTier'];
}

export interface ReviewQueueListing {
  items: ReviewQueueItem[];
  total: number;
}

export interface ListReviewQueueDeps {
  repository: CanonRepository;
}

export async function listReviewQueue(
  opts: ListReviewQueueOptions,
  deps: ListReviewQueueDeps,
): Promise<ReviewQueueListing> {
  const limit = opts.limit ?? DEFAULT_LIST_LIMIT;
  const offset = opts.offset ?? 0;
  const [candidates, total] = await Promise.all([
    deps.repository.listReviewCandidates({ limit, offset }),
    deps.repository.countReviewCandidates(),
  ]);
  const sourceTitleCache = new Map<string, string>();
  const items: ReviewQueueItem[] = [];
  for (const candidate of candidates) {
    let title = sourceTitleCache.get(candidate.sourceId);
    if (title === undefined) {
      const source = await deps.repository.getSource(candidate.sourceId);
      if (!source) continue;
      title = source.title;
      sourceTitleCache.set(candidate.sourceId, title);
    }
    items.push({
      id: candidate.id,
      sourceId: candidate.sourceId,
      sourceTitle: title,
      claim: candidate.claim,
      quoteTextPreview: previewOf(candidate.quoteText),
      quoteTextLength: candidate.quoteText.length,
      matchTier: candidate.matchTier,
    });
  }
  return { items, total };
}

function previewOf(text: string): string {
  if (text.length <= DEFAULT_QUOTE_PREVIEW_CHARS) return text;
  return `${text.slice(0, DEFAULT_QUOTE_PREVIEW_CHARS - 1)}…`;
}

export type ResolveReviewItemInput =
  | { itemId: string; action: 'confirm' }
  | { itemId: string; action: 'correct'; quoteText: string; claim?: string }
  | { itemId: string; action: 'reject' };

export type ReviewResolution =
  | {
      resolved: true;
      outcome: 'admitted';
      principleId: string;
      quoteId: string;
      matchTier: Exclude<MatchTier, 'no-match'>;
    }
  | { resolved: true; outcome: 'rejected' }
  | { resolved: false; reason: 'unknown-item' }
  | { resolved: false; reason: 'still-no-match' };

export interface ResolveReviewItemDeps {
  provider: IngestProvider;
  repository: CanonRepository;
}

export async function resolveReviewItem(
  input: ResolveReviewItemInput,
  deps: ResolveReviewItemDeps,
): Promise<ReviewResolution> {
  const { provider, repository } = deps;
  const candidate = await repository.getReviewCandidate(input.itemId);
  if (!candidate) return { resolved: false, reason: 'unknown-item' };

  if (input.action === 'reject') {
    await repository.removeReviewCandidate(candidate.id);
    return { resolved: true, outcome: 'rejected' };
  }

  const source = await repository.getSource(candidate.sourceId);
  // Defensive: a candidate whose Source was deleted is unreachable — treat as
  // unknown so the queue can be cleaned up by a future op without crashing here.
  if (!source) return { resolved: false, reason: 'unknown-item' };

  const quoteText = input.action === 'correct' ? input.quoteText : candidate.quoteText;
  const claim =
    input.action === 'correct' && input.claim !== undefined ? input.claim : candidate.claim;

  const result = relocate(source.text, quoteText);
  if (!result.located) {
    return { resolved: false, reason: 'still-no-match' };
  }

  const [embedding] = await provider.embed([claim]);
  if (!embedding) {
    // Embedder returned nothing — keep the candidate; the Owner can retry.
    return { resolved: false, reason: 'still-no-match' };
  }

  const principleId = `${candidate.id}#admitted`;
  const quoteId = `${candidate.id}#admitted-q`;
  const quote: LocatedQuote = {
    id: quoteId,
    principleId,
    sourceId: source.id,
    span: result.span,
    located: true,
    matchTier: result.matchTier,
    distilPromptVersion: provider.provenance.distilPromptVersion,
  };
  const principle: Principle = {
    id: principleId,
    claim,
    embedding,
    quotes: [quote],
    distilModel: provider.provenance.distilModel,
    distilModelVersion: provider.provenance.distilModelVersion,
    distilPromptVersion: provider.provenance.distilPromptVersion,
  };

  await repository.insertReviewAdmittedPrinciple(principle, source.id);
  await repository.removeReviewCandidate(candidate.id);

  return {
    resolved: true,
    outcome: 'admitted',
    principleId,
    quoteId,
    matchTier: result.matchTier,
  };
}
