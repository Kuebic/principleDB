// getQuoteInContext — open a Quote at its exact spot (issue #4, ADR-0007/0009).
//
// Read-only. Given a Quote id, look up the relocated span, return the SOURCE's own
// words at that span (never the AI's reproduction, per ADR-0007) plus a window of
// surrounding text and the derived human-readable label (page / section / timestamp)
// computed live from the Source's structureMap (ADR-0009).
//
// Response shape is a discriminated union with a `found` boolean so the empty case
// is predictable for AI clients without out-of-band signalling.
//
// Sibling `getQuoteReader` (issue #48) returns the WHOLE Source instead of a
// bounded window — that's the shape the human Reader page needs (#39: no gating,
// full source freely scrollable). Same span-honesty guarantee: the mark position
// is `span`; the highlighted text is `source.text.slice(span.start, span.end)`.

import { deriveLabel } from './derive-label';
import type { CanonRepository } from './ports';
import type { LocatedQuote, Span, SourceKind, StructureMap } from './types';

const DEFAULT_CONTEXT_CHARS = 280;
// Hard cap on the surrounding-context window, in characters on each side of
// the Quote (issue #49). Bounds the amount of Source text a single
// get_quote_in_context call can materialize, so a hostile client can't
// request a multi-MB slice on every hit. Matches the MCP tool schema's
// contextChars.max in `mcp/server.ts`; the clamp here is defense-in-depth
// for the core function itself (called from the Reader page's sibling
// getQuoteReader shares the same repository but returns whole Source text —
// that path has no window, on purpose per #39).
export const MAX_CONTEXT_CHARS = 4000;

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
  const requested = deps.contextChars ?? DEFAULT_CONTEXT_CHARS;
  const window = Math.max(0, Math.min(requested, MAX_CONTEXT_CHARS));

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

// Reader shape (issue #48, Variant D): the FULL source text + structureMap so the
// page can render a sticky outline (scroll-spy) alongside the whole scrollable
// source. No window (#39). AI-client callers should stay on getQuoteInContext —
// this shape is much larger and only makes sense for a human reader page.
export interface QuoteReaderHit {
  found: true;
  source: {
    id: string;
    title: string;
    author: string;
    kind: SourceKind;
    text: string;
    structureMap: StructureMap;
  };
  principle: {
    id: string;
    claim: string;
  };
  quote: {
    id: string;
    span: Span;
    label: string;
    matchTier: LocatedQuote['matchTier'];
  };
}

export interface QuoteReaderMiss {
  found: false;
}

export type GetQuoteReaderResponse = QuoteReaderHit | QuoteReaderMiss;

export async function getQuoteReader(
  quoteId: string,
  deps: { repository: CanonRepository },
): Promise<GetQuoteReaderResponse> {
  const record = await deps.repository.getQuoteById(quoteId);
  if (!record) return { found: false };

  const source = await deps.repository.getSource(record.quote.sourceId);
  if (!source) return { found: false };

  const { span } = record.quote;
  return {
    found: true,
    source: {
      id: source.id,
      title: source.title,
      author: source.author,
      kind: source.kind,
      text: source.text,
      structureMap: source.structureMap,
    },
    principle: {
      id: record.quote.principleId,
      claim: record.principleClaim,
    },
    quote: {
      id: record.quote.id,
      span,
      label: deriveLabel(source.structureMap, span, source.text.length),
      matchTier: record.quote.matchTier,
    },
  };
}
