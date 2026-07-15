// Pure Source → Work mapping backing the one-time backfill (issue #54,
// ADR-0017). No I/O — takes the row's `author` + `title` and returns a
// stable Work id. The backfill script (scripts/backfill-works.ts) is a thin
// shell that reads every Source, applies this function, and upserts.
//
// Live 615-Source partition (verified in ADR-0017):
//   Cheon Seong Gyeong (CSG)  429  author='SunMyungMoon-CSG'
//   Divine Principle   (DP)    59  ~16 part-slug `author` values (the complement)
//   Unification Thought (UT)   70  author='Sang Hun Lee'
//   The Way of God's Will      25  author='Sun Myung Moon' + title~/Way of God's Will/
//   Cham Bumo Gyeong   (CBG)   15  author='Sun Myung Moon' + title~/Cham Bumo Gyeong/
//   Pyeong Hwa Gyeong  (PHG)   13  author='Sun Myung Moon' + title~/Pyeong Hwa Gyeong/
//   TM Anthology       (TMA)    4  author='Hak Ja Han Moon'
//
// The DP rule is deliberately "the complement" — DP's rows have no book name
// in `author` (part-slugs) or `title` (chapter-only). Freezing it to "anything
// unmatched" is honest for today's 615 rows; a NEW slug-authored book must
// declare its Work at ingest time rather than fall into DP's bucket.
//
// New Works default to `extra` (ADR-0017); the 7 founding Works here are all
// `core` because they are the trusted default corpus a member sees.

import type { Figure, Work } from './types';

export const WORK_CSG = 'work_csg';
export const WORK_DP = 'work_dp';
export const WORK_UT = 'work_ut';
export const WORK_WOGW = 'work_wogw';
export const WORK_CBG = 'work_cbg';
export const WORK_PHG = 'work_phg';
export const WORK_TM = 'work_tm';

const FIGURE_SMM = 'fig_sun-myung-moon';
const FIGURE_SHL = 'fig_sang-hun-lee';
const FIGURE_HJH = 'fig_hak-ja-han';

export const BACKFILL_FIGURES: readonly Figure[] = [
  { id: FIGURE_SMM, slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' },
  { id: FIGURE_SHL, slug: 'sang-hun-lee', displayName: 'Sang Hun Lee' },
  { id: FIGURE_HJH, slug: 'hak-ja-han', displayName: 'Hak Ja Han' },
];

export const BACKFILL_WORKS: readonly Work[] = [
  { id: WORK_CSG, title: 'Cheon Seong Gyeong', figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_DP, title: 'Divine Principle', figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_WOGW, title: "The Way of God's Will", figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_CBG, title: 'Cham Bumo Gyeong', figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_PHG, title: 'Pyeong Hwa Gyeong', figureId: FIGURE_SMM, tier: 'core' },
  { id: WORK_UT, title: 'Unification Thought', figureId: FIGURE_SHL, tier: 'core' },
  { id: WORK_TM, title: 'True Mother Anthology', figureId: FIGURE_HJH, tier: 'core' },
];

export interface SourceRow {
  author: string;
  title: string;
}

export function sourceToWork(row: SourceRow): string {
  if (row.author === 'SunMyungMoon-CSG') return WORK_CSG;
  if (row.author === 'Sang Hun Lee') return WORK_UT;
  if (row.author === 'Hak Ja Han Moon') return WORK_TM;
  if (row.author === 'Sun Myung Moon') {
    const t = row.title;
    if (t.includes('Cham Bumo Gyeong')) return WORK_CBG;
    if (t.includes('Pyeong Hwa Gyeong')) return WORK_PHG;
    if (t.includes("Way of God's Will")) return WORK_WOGW;
    // The `Sun Myung Moon` bucket is exhaustively the three books above;
    // anything else here is a signal that a new SMM Work was ingested
    // without being assigned a Work explicitly. Fall through to DP so the
    // partition remains total — the ingest path is where a new Work should
    // be declared, not the backfill.
    return WORK_DP;
  }
  // The complement: DP's ~16 part-slug `author` values (`01-the-principle-
  // of-creation`, …). Frozen to today's rows — a new slug-authored book
  // must declare its Work at ingest time (ADR-0017).
  return WORK_DP;
}
