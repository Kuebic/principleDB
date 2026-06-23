// getQuoteInContext — open a Quote at its exact spot (issue #4, ADR-0007/0009).
//
// Read-only. Given a Quote id, look up the relocated span, return the SOURCE's own
// words at that span (never the AI's reproduction, per ADR-0007) plus a window of
// surrounding text and the derived human-readable label (page / section / timestamp)
// computed live from the Source's structureMap (ADR-0009).
//
// Response shape is a discriminated union with a `found` boolean so the empty case
// is predictable for AI clients without out-of-band signalling.

import { deriveLabel } from './derive-label';
import type { CanonRepository } from './ports';
import type { LocatedQuote, Span, SourceKind } from './types';

const DEFAULT_CONTEXT_CHARS = 280;

export interface GetQuoteInContextDeps {
  repository: CanonRepository;
  contextChars?: number;
}

export interface QuoteInContextHit {
  found: true;
  source: {
    id: string;
    title: string;
    author: string;
    kind: SourceKind;
  };
  principle: {
    id: string;
    claim: string;
  };
  quote: {
    id: string;
    span: Span;
    label: string;
    text: string;
    contextBefore: string;
    contextAfter: string;
    matchTier: LocatedQuote['matchTier'];
  };
}

export interface QuoteInContextMiss {
  found: false;
}

export type GetQuoteInContextResponse = QuoteInContextHit | QuoteInContextMiss;

export async function getQuoteInContext(
  quoteId: string,
  deps: GetQuoteInContextDeps,
): Promise<GetQuoteInContextResponse> {
  const window = deps.contextChars ?? DEFAULT_CONTEXT_CHARS;

  const record = await deps.repository.getQuoteById(quoteId);
  if (!record) return { found: false };

  const source = await deps.repository.getSource(record.quote.sourceId);
  if (!source) return { found: false };

  const { span } = record.quote;
  const beforeStart = Math.max(0, span.start - window);
  const afterEnd = Math.min(source.text.length, span.end + window);

  return {
    found: true,
    source: {
      id: source.id,
      title: source.title,
      author: source.author,
      kind: source.kind,
    },
    principle: {
      id: record.quote.principleId,
      claim: record.principleClaim,
    },
    quote: {
      id: record.quote.id,
      span,
      label: deriveLabel(source.structureMap, span, source.text.length),
      text: source.text.slice(span.start, span.end),
      contextBefore: source.text.slice(beforeStart, span.start),
      contextAfter: source.text.slice(span.end, afterEnd),
      matchTier: record.quote.matchTier,
    },
  };
}
