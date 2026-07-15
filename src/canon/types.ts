// Domain types for the Canon — the descriptive corpus core (ADR-0006).
//
// Shape mirrors what Drizzle's `schema.ts` will declare when it lands (ADR-0005).
// The honesty guarantee — Quote = relocated Source span, never the AI's string — is
// load-bearing here: a `LocatedQuote` carries an offset span into the Source's
// continuous text, not a stored quote string (ADR-0007).

export type SourceKind = 'sermon' | 'book' | 'article' | 'transcript';

// Work tier (ADR-0017). `core` Works are searched by default (the founding
// corpus); `extra` Works are in the Canon but opt-in per search. New Works
// default to `extra` so the trusted default set doesn't silently grow.
export type WorkTier = 'core' | 'extra';

// A canonical teacher identity — many spellings map to one Figure
// ("Hak Ja Han Moon" / "Hakcha Han-Moon" → one Figure). Stored as a table so
// display name and future merges are centralized (ADR-0017).
export interface Figure {
  id: string;
  slug: string;
  displayName: string;
}

// A teaching as published (a book, or a single speech). The unit a member
// selects for source-filtering. Every Source belongs to exactly one Work;
// most future Works are 1-Source (a speech, an article), the scriptures are
// many-Source (Cheon Seong Gyeong = 429 Sources).
export interface Work {
  id: string;
  title: string;
  figureId: string;
  tier: WorkTier;
}

// A specific published recension of a Work (ADR-0018). A Work can carry
// multiple Editions when it has more than one published recension (e.g. CSG
// pre-ascension vs 2013 Revised). Every Source belongs to exactly one Edition;
// citations show the Edition label alongside the Work title + Figure so a
// reader never mistakes a contested recension for neutral scripture.
//
// `recension` is a documented controlled vocabulary (e.g. `ffwpu-post-2012`,
// `pre-ascension-original`, `external-discourse`) — a text tag, not a table
// (mirrors `work.tier`). `language` is stored on the Edition (not per-Quote)
// because a whole published Edition is in one source language; a Quote's
// language derives Source → Edition.
export interface Edition {
  id: string;
  workId: string;
  label: string;
  recension: string;
  language: string;
  publishedDate: string | null;
  publisher: string | null;
  notes: string | null;
}

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
  // Optional/nullable during the backfill window (ADR-0017): a one-time
  // script assigns every existing Source to its Work. New ingest paths
  // assign a Work at write time. Omitted vs `null` mean the same thing —
  // unassigned; the DB column is nullable and the field is optional so
  // existing call sites don't need to thread an explicit `null` through.
  workId?: string | null;
  // Same expand-then-contract posture (ADR-0018): the schema slice (#59)
  // adds `edition_id` nullable, the backfill slice (#60) populates it, and
  // the resolution slice (#61) drops `work_id`, leaving `edition_id` as the
  // single link from Source up the hierarchy.
  editionId?: string | null;
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
