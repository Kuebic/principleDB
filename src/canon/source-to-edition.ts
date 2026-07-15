// Pure Source → Edition mapping backing the one-time backfill (issue #60,
// PRD #58, ADR-0018). Composes on top of `sourceToWork` — each founding Work
// has exactly one Edition in this slice, so a Source's Edition is uniquely
// determined by its Work. The `UnmappedSourceError` guardrail from #54 carries
// through: unknown rows throw rather than silently bucketing.
//
// Labels and recensions here were chosen against the real corpus (source date
// + title), not derived from the slug. Fixing them in code makes them
// reviewable and testable:
//   CSG   → "2013 Revised" / `ffwpu-post-2012`
//   PHG   → "2014"         / `ffwpu-post-2012`
//   CBG   → "2015"         / `ffwpu-post-2012`
//   TM    → "2017"         / `ffwpu-post-2012`
//   DP    → "Exposition"   / `pre-ascension-original`
//   WOGW  → "1980"         / `pre-ascension-original`
//   UT    → "Original"     / `pre-ascension-original`
//   Dunkley (both)         / `external-discourse`
//
// The backfill script (scripts/backfill-editions.ts) is a thin shell that
// upserts these Editions, then reassigns every Source through the pure
// mapping — mirroring the ADR-0017 backfill shape.

import type { Edition } from './types';
import {
  UnmappedSourceError,
  WORK_CBG,
  WORK_CSG,
  WORK_DD_REVELATIONS,
  WORK_DD_SPECIAL_GRACE,
  WORK_DP,
  WORK_PHG,
  WORK_TM,
  WORK_UT,
  WORK_WOGW,
  sourceToWork,
  type SourceRow,
} from './source-to-work';

export const EDITION_CSG = 'ed_csg';
export const EDITION_DP = 'ed_dp';
export const EDITION_UT = 'ed_ut';
export const EDITION_WOGW = 'ed_wogw';
export const EDITION_CBG = 'ed_cbg';
export const EDITION_PHG = 'ed_phg';
export const EDITION_TM = 'ed_tm';
export const EDITION_DD_REVELATIONS = 'ed_dd_revelations';
export const EDITION_DD_SPECIAL_GRACE = 'ed_dd_special-grace';

export const BACKFILL_EDITIONS: readonly Edition[] = [
  {
    id: EDITION_CSG,
    workId: WORK_CSG,
    label: '2013 Revised',
    recension: 'ffwpu-post-2012',
    language: 'en',
    publishedDate: '2013-01-01',
    publisher: null,
    notes: null,
  },
  {
    id: EDITION_DP,
    workId: WORK_DP,
    label: 'Exposition',
    recension: 'pre-ascension-original',
    language: 'en',
    publishedDate: null,
    publisher: null,
    notes: null,
  },
  {
    id: EDITION_UT,
    workId: WORK_UT,
    label: 'Original',
    recension: 'pre-ascension-original',
    language: 'en',
    publishedDate: null,
    publisher: null,
    notes: null,
  },
  {
    id: EDITION_WOGW,
    workId: WORK_WOGW,
    label: '1980',
    recension: 'pre-ascension-original',
    language: 'en',
    publishedDate: '1980-01-01',
    publisher: null,
    notes: null,
  },
  {
    id: EDITION_CBG,
    workId: WORK_CBG,
    label: '2015',
    recension: 'ffwpu-post-2012',
    language: 'en',
    publishedDate: '2015-01-01',
    publisher: null,
    notes: null,
  },
  {
    id: EDITION_PHG,
    workId: WORK_PHG,
    label: '2014',
    recension: 'ffwpu-post-2012',
    language: 'en',
    publishedDate: '2014-01-01',
    publisher: null,
    notes: null,
  },
  {
    id: EDITION_TM,
    workId: WORK_TM,
    label: '2017',
    recension: 'ffwpu-post-2012',
    language: 'en',
    publishedDate: '2017-01-01',
    publisher: null,
    notes: null,
  },
  {
    id: EDITION_DD_REVELATIONS,
    workId: WORK_DD_REVELATIONS,
    label: "Discourse on True Mother's Revelations",
    recension: 'external-discourse',
    language: 'en',
    publishedDate: null,
    publisher: null,
    notes: null,
  },
  {
    id: EDITION_DD_SPECIAL_GRACE,
    workId: WORK_DD_SPECIAL_GRACE,
    label: 'The Meaning of Special Grace',
    recension: 'external-discourse',
    language: 'en',
    publishedDate: null,
    publisher: null,
    notes: null,
  },
];

const WORK_TO_EDITION = new Map<string, string>([
  [WORK_CSG, EDITION_CSG],
  [WORK_DP, EDITION_DP],
  [WORK_UT, EDITION_UT],
  [WORK_WOGW, EDITION_WOGW],
  [WORK_CBG, EDITION_CBG],
  [WORK_PHG, EDITION_PHG],
  [WORK_TM, EDITION_TM],
  [WORK_DD_REVELATIONS, EDITION_DD_REVELATIONS],
  [WORK_DD_SPECIAL_GRACE, EDITION_DD_SPECIAL_GRACE],
]);

export function sourceToEdition(row: SourceRow): string {
  const workId = sourceToWork(row);
  const editionId = WORK_TO_EDITION.get(workId);
  // Guardrail: if a new Work is declared without a paired Edition seed,
  // fail loudly rather than mapping to an arbitrary default.
  if (!editionId) throw new UnmappedSourceError(row);
  return editionId;
}
