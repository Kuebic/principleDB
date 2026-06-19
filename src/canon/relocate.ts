// Relocate the AI's quote string back to a SOURCE span (ADR-0007).
//
// Four tiers, first-match-wins:
//   exact      — byte-exact substring (rare — 6–15% per the spike)
//   normalized — after normalize() (whitespace, curly quotes, ligatures, hyphen-wrap)
//   alnum      — after also stripping punctuation (recovers bracketed editorial insertion)
//   no-match   — held in Review, NOT admitted to the Canon (ADR-0007 invariant)
//
// The returned span is unconditionally in ORIGINAL-source offsets, so
// `source.slice(span.start, span.end)` yields the source's own words regardless of tier.

import { alnumize, normalize } from './normalize';
import type { Span } from './types';

export type RelocateResult =
  | { located: true; matchTier: 'exact' | 'normalized' | 'alnum'; span: Span }
  | { located: false; matchTier: 'no-match'; span: null };

export function relocate(source: string, quote: string): RelocateResult {
  if (quote.length === 0) {
    return { located: false, matchTier: 'no-match', span: null };
  }

  const exact = source.indexOf(quote);
  if (exact >= 0) {
    return {
      located: true,
      matchTier: 'exact',
      span: { start: exact, end: exact + quote.length },
    };
  }

  const normSource = normalize(source);
  const normQuote = normalize(quote);
  if (normQuote.text.length > 0) {
    const j = normSource.text.indexOf(normQuote.text);
    if (j >= 0) {
      const start = normSource.originMap[j]!.sourceStart;
      const end = normSource.originMap[j + normQuote.text.length - 1]!.sourceEnd;
      return { located: true, matchTier: 'normalized', span: { start, end } };
    }
  }

  const alnumSource = alnumize(normSource);
  const alnumQuote = alnumize(normQuote);
  if (alnumQuote.text.length > 0) {
    const k = alnumSource.text.indexOf(alnumQuote.text);
    if (k >= 0) {
      const start = alnumSource.originMap[k]!.sourceStart;
      const end = alnumSource.originMap[k + alnumQuote.text.length - 1]!.sourceEnd;
      return { located: true, matchTier: 'alnum', span: { start, end } };
    }
  }

  return { located: false, matchTier: 'no-match', span: null };
}
