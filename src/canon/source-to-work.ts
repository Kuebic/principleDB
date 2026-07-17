// Pure Source → Work mapping backing the one-time backfill (issue #54,
// ADR-0017). No I/O — takes the row's `author` + `title` and returns a
// stable Work id. The backfill script (scripts/backfill-works.ts) is a thin
// shell that reads every Source, applies this function, and upserts.
//
// Founding-corpus partition (verified in ADR-0017):
//   Cheon Seong Gyeong (CSG)  429  author='SunMyungMoon-CSG'
//   Divine Principle   (DP)    59  author matches the `NN-` part-slug pattern
//   Unification Thought (UT)   70  author='Sang Hun Lee'
//   The Way of God's Will      25  author='Sun Myung Moon' + title~/way of god's will/i
//   Cham Bumo Gyeong   (CBG)   15  author='Sun Myung Moon' + title~/Cham Bumo Gyeong/
//   Pyeong Hwa Gyeong  (PHG)   13  author='Sun Myung Moon' + title~/Pyeong Hwa Gyeong/
//   Gateway to Heaven  (TFG)    1  author='Sun Myung Moon' + title~/Gateway to Heaven/
//   TM Anthology       (TMA)    4  author='Hak Ja Han Moon'
//
// Post-founding `extra` additions already in the Canon (assigned here so their
// citations stop rendering the raw `author` slug):
//   Damien Dunkley — "Discourse on True Mother's Revelations"  10  transcript
//   Damien Dunkley — "The Meaning of Special Grace"             1  transcript
//   Sun Myung Moon — "The Way of Tradition" (vols I–IV, 1980)    4  book (extra)
//
// DP is identified POSITIVELY by its part-slug author (`01-the-principle-of-
// creation`, `07-christology`, …) — NOT as a catch-all "everything else".
// Anything this function cannot place THROWS: the backfill must refuse to
// mislabel unknown data rather than silently sweep it into DP. A new Source
// (a new speaker, a new book) declares its Work at ingest time (ADR-0017); if
// one slips through un-declared, this guardrail is where it surfaces.

import type { Figure, Work } from './types';

export const WORK_CSG = 'work_csg';
export const WORK_DP = 'work_dp';
export const WORK_UT = 'work_ut';
export const WORK_WOGW = 'work_wogw';
export const WORK_CBG = 'work_cbg';
export const WORK_PHG = 'work_phg';
export const WORK_TFG = 'work_tfg';
export const WORK_TM = 'work_tm';
export const WORK_DD_REVELATIONS = 'work_dd_revelations';
export const WORK_DD_SPECIAL_GRACE = 'work_dd_special-grace';
export const WORK_WOT = 'work_wot';
export const WORK_MOP = 'work_mop';
export const WORK_PLGC = 'work_plgc';

const FIGURE_SMM = 'fig_sun-myung-moon';
const FIGURE_SHL = 'fig_sang-hun-lee';
const FIGURE_HJH = 'fig_hak-ja-han';
const FIGURE_DD = 'fig_damien-dunkley';

export const BACKFILL_FIGURES: readonly Figure[] = [
  { id: FIGURE_SMM, slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' },
  { id: FIGURE_SHL, slug: 'sang-hun-lee', displayName: 'Sang Hun Lee' },
  { id: FIGURE_HJH, slug: 'hak-ja-han', displayName: 'Hak Ja Han' },
  { id: FIGURE_DD, slug: 'damien-dunkley', displayName: 'Damien Dunkley' },
];

export const BACKFILL_WORKS: readonly Work[] = [
  { id: WORK_CSG, title: 'Cheon Seong Gyeong', figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_DP, title: 'Divine Principle', figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_WOGW, title: "The Way of God's Will", figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_CBG, title: 'Cham Bumo Gyeong', figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_PHG, title: 'Pyeong Hwa Gyeong', figureId: FIGURE_SMM, tier: 'core' },
  {
    id: WORK_TFG,
    title: 'True Families: Gateway to Heaven',
    figureId: FIGURE_SMM,
    tier: 'core',
  },
  { id: WORK_UT, title: 'Unification Thought', figureId: FIGURE_SHL, tier: 'core' },
  { id: WORK_TM, title: 'True Mother Anthology', figureId: FIGURE_HJH, tier: 'core' },
  {
    id: WORK_DD_REVELATIONS,
    title: "Discourse on True Mother's Revelations",
    figureId: FIGURE_DD,
    tier: 'extra',
  },
  {
    id: WORK_DD_SPECIAL_GRACE,
    title: 'The Meaning of Special Grace',
    figureId: FIGURE_DD,
    tier: 'extra',
  },
  { id: WORK_WOT, title: 'The Way of Tradition', figureId: FIGURE_SMM, tier: 'extra' },
  {
    id: WORK_PLGC,
    title: 'As a Peace-Loving Global Citizen',
    figureId: FIGURE_SMM,
    tier: 'extra',
  },
  { id: WORK_MOP, title: 'Mother of Peace', figureId: FIGURE_HJH, tier: 'extra' },
];

export interface SourceRow {
  author: string;
  title: string;
}

// DP's per-part `author` slugs all start with a two-digit part number and a
// hyphen (`01-…`, `07-…`, `16-…`). No other Work's author matches this shape.
const DP_PART_SLUG = /^\d{2}-/;

export function sourceToWork(row: SourceRow): string {
  if (row.author === 'SunMyungMoon-CSG') return WORK_CSG;
  if (row.author === 'Sang Hun Lee') return WORK_UT;
  if (row.author === 'Hak Ja Han Moon') {
    // Her memoir is a distinct (extra) Work from the teaching anthology; the
    // four Anthology sources carry the anthology title, so they fall through
    // to TM.
    if (row.title.includes('Mother of Peace')) return WORK_MOP;
    return WORK_TM;
  }

  if (row.author === 'Sun Myung Moon') {
    const t = row.title;
    if (t.includes('Cham Bumo Gyeong')) return WORK_CBG;
    if (t.includes('Pyeong Hwa Gyeong')) return WORK_PHG;
    if (t.includes('Gateway to Heaven')) return WORK_TFG;
    // `extra` addition — the 4-volume 1980 compilation. Checked before WOGW;
    // the two titles don't overlap, so order is only for readability.
    if (t.includes('Way of Tradition')) return WORK_WOT;
    // His autobiography (2009) — an extra Work, matched by its distinctive title.
    if (t.includes('Peace-Loving Global Citizen')) return WORK_PLGC;
    // Case-insensitive: the live titles read "The Way *Of* God's Will".
    if (t.toLowerCase().includes("way of god's will")) return WORK_WOGW;
    throw new UnmappedSourceError(row);
  }

  if (row.author === 'Damien Dunkley') {
    const t = row.title;
    if (t.includes("Discourse on True Mother's Revelations")) return WORK_DD_REVELATIONS;
    if (t.includes('The Meaning of Special Grace')) return WORK_DD_SPECIAL_GRACE;
    throw new UnmappedSourceError(row);
  }

  if (DP_PART_SLUG.test(row.author)) return WORK_DP;

  throw new UnmappedSourceError(row);
}

// Thrown when a Source can't be placed in a known Work. The backfill lets this
// propagate so the run aborts loudly instead of stamping unknown data as DP —
// the message tells the operator exactly which row to declare a Work for.
export class UnmappedSourceError extends Error {
  constructor(row: SourceRow) {
    super(
      `Source has no Work rule — declare its Work explicitly (ADR-0017). ` +
        `author=${JSON.stringify(row.author)} title=${JSON.stringify(row.title)}`,
    );
    this.name = 'UnmappedSourceError';
  }
}
