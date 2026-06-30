// Domain types for the Canon — the descriptive corpus core (ADR-0006).
//
// Shape mirrors what Drizzle's `schema.ts` will declare when it lands (ADR-0005).
// The honesty guarantee — Quote = relocated Source span, never the AI's string — is
// load-bearing here: a `LocatedQuote` carries an offset span into the Source's
// continuous text, not a stored quote string (ADR-0007).

export type SourceKind = 'sermon' | 'book' | 'article' | 'transcript';

export interface Span {
  start: number;
  end: number;
}

export type MatchTier = 'exact' | 'normalized' | 'alnum' | 'no-match';

export type StructureMap =
  | { kind: 'pdf-pages'; pages: ReadonlyArray<{ offset: number; page: number }> }
  | { kind: 'transcript-timecodes'; codes: ReadonlyArray<{ offset: number; timecode: string }> }
  | { kind: 'text-headings'; headings: ReadonlyArray<{ offset: number; heading: string }> }
  | { kind: 'none' };

export interface Source {
  id: string;
  title: string;
  author: string;
  kind: SourceKind;
  date: string;
  text: string;
  r2Key: string | null;
  structureMap: StructureMap;
}

export interface DistilProvenance {
  distilModel: string;
  distilModelVersion: string;
  distilPromptVersion: string;
}

export interface DistilledItem {
  claim: string;
  quote: string;
}

export interface LocatedQuote {
  id: string;
  principleId: string;
  sourceId: string;
  span: Span;
  located: true;
  matchTier: 'exact' | 'normalized' | 'alnum';
  distilPromptVersion: string;
}

export interface Principle {
  id: string;
  claim: string;
  embedding: number[];
  quotes: LocatedQuote[];
  distilModel: string;
  distilModelVersion: string;
  distilPromptVersion: string;
}

export interface ReviewCandidate {
  id: string;
  sourceId: string;
  claim: string;
  quoteText: string;
  matchTier: 'no-match';
  dedupState: 'pending';
}

// Conservative-dedup audit trail (issue #5, ADR-0006). One row per LLM
// consultation: the AI distilled a new claim, the vector prefilter found a
// near neighbour above threshold, and the model was asked "same claim?".
// Verdict `merged` attached the new Quote to `existingPrincipleId`;
// `kept-separate` recorded that the model said no. No-candidate cases are
// not logged — there is nothing to inspect.
//
// `confirmModel` (issue #24, PRD #21) is the model that produced the verdict
// — separate from the distil provenance because the confirm changes the
// merge decision, not what was said. The slot key is still the distil
// provenance tuple; the confirm model rides along on every row so a
// model-mixed Canon's audit trail stays honest.
export interface DedupDecision {
  id: string;
  sourceId: string;
  candidateClaim: string;
  existingPrincipleId: string | null;
  verdict: 'merged' | 'kept-separate';
  rationale: string;
  similarityScore: number;
  distilModel: string;
  distilModelVersion: string;
  distilPromptVersion: string;
  confirmModel: string;
}
