// Pure Source → Work mapping (issue #54, ADR-0017). The one-time backfill
// script is a thin shell over this function; testing the function pins the 7
// rules and asserts the partition is total and disjoint against representative
// rows for the live 615-Source counts (429/59/25/15/13/70/4).
//
// The rules (verified against the live `author` values in ADR-0017):
//   author='SunMyungMoon-CSG'                    → Cheon Seong Gyeong  (429)
//   author='Sang Hun Lee'                        → Unification Thought (70)
//   author='Hak Ja Han Moon'                     → TM Anthology        (4)
//   author='Sun Myung Moon' + title-signature    → WOGW / CBG / PHG    (25/15/13)
//   everything else (DP's ~16 part-slug rows)    → Divine Principle    (59)

import { describe, expect, it } from 'vitest';
import {
  BACKFILL_FIGURES,
  BACKFILL_WORKS,
  WORK_CBG,
  WORK_CSG,
  WORK_DP,
  WORK_PHG,
  WORK_TM,
  WORK_UT,
  WORK_WOGW,
  sourceToWork,
} from './source-to-work';

describe('sourceToWork', () => {
  it('maps SunMyungMoon-CSG slug → Cheon Seong Gyeong', () => {
    expect(sourceToWork({ author: 'SunMyungMoon-CSG', title: 'CSG — book1-01' })).toBe(WORK_CSG);
  });

  it('maps Sang Hun Lee → Unification Thought', () => {
    expect(sourceToWork({ author: 'Sang Hun Lee', title: 'UT — 01' })).toBe(WORK_UT);
  });

  it('maps Hak Ja Han Moon → TM Anthology', () => {
    expect(sourceToWork({ author: 'Hak Ja Han Moon', title: 'TM — 1' })).toBe(WORK_TM);
  });

  it('splits the Sun Myung Moon bucket by title signature (CBG / PHG / WOGW)', () => {
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Cham Bumo Gyeong — ChambumoGyeong-00' })).toBe(WORK_CBG);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Cham Bumo Gyeong — ChambumoGyeong-14' })).toBe(WORK_CBG);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Pyeong Hwa Gyeong — PHG14-01' })).toBe(WORK_PHG);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Pyeong Hwa Gyeong — PHG14-13' })).toBe(WORK_PHG);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: "The Way of God's Will — WOGW-01" })).toBe(WORK_WOGW);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: "The Way of God's Will — WOGW-25" })).toBe(WORK_WOGW);
  });

  it('routes DP part-slugs (the complement) → Divine Principle', () => {
    // Live rows have `author` values like `01-the-principle-of-creation`,
    // `05-the-parallels-between-the-two-ages…`, with the book name nowhere
    // in the row (ADR-0017). Anything not matched by an explicit rule is DP.
    expect(sourceToWork({ author: '01-the-principle-of-creation', title: 'Ch.1' })).toBe(WORK_DP);
    expect(sourceToWork({ author: '05-the-parallels-between-the-two-ages', title: 'Ch.5' })).toBe(WORK_DP);
    expect(sourceToWork({ author: '16-final-restoration', title: 'anything' })).toBe(WORK_DP);
  });

  it('partition is total and disjoint over the live 615 rows (429/59/25/15/13/70/4)', () => {
    // Representative rows drawn from the ADR-verified partition. Each row
    // must map to exactly one Work; the count per Work must match the ADR.
    const rows: Array<{ author: string; title: string; expected: string }> = [];
    for (let i = 0; i < 429; i++) rows.push({ author: 'SunMyungMoon-CSG', title: `CSG chunk ${i}`, expected: WORK_CSG });
    for (let i = 0; i < 70; i++) rows.push({ author: 'Sang Hun Lee', title: `UT chunk ${i}`, expected: WORK_UT });
    for (let i = 0; i < 4; i++) rows.push({ author: 'Hak Ja Han Moon', title: `TM chunk ${i}`, expected: WORK_TM });
    for (let i = 0; i < 25; i++) rows.push({ author: 'Sun Myung Moon', title: `The Way of God's Will — WOGW-${i}`, expected: WORK_WOGW });
    for (let i = 0; i < 15; i++) rows.push({ author: 'Sun Myung Moon', title: `Cham Bumo Gyeong — ChambumoGyeong-${i}`, expected: WORK_CBG });
    for (let i = 0; i < 13; i++) rows.push({ author: 'Sun Myung Moon', title: `Pyeong Hwa Gyeong — PHG14-${i}`, expected: WORK_PHG });
    // DP's 59 shattered across ~16 part-slug values; use ~4 rows per slug for realism.
    // 14 parts × 4 + 1 part × 3 = 59 rows exactly.
    for (let part = 1; part <= 15; part++) {
      const slug = `${String(part).padStart(2, '0')}-dp-part-${part}`;
      const per = part === 15 ? 3 : 4;
      for (let i = 0; i < per; i++) rows.push({ author: slug, title: `DP ${slug}#${i}`, expected: WORK_DP });
    }
    expect(rows.length).toBe(615);

    const counts = new Map<string, number>();
    for (const r of rows) {
      const got = sourceToWork(r);
      expect(got).toBe(r.expected);
      counts.set(got, (counts.get(got) ?? 0) + 1);
    }
    expect(counts.get(WORK_CSG)).toBe(429);
    expect(counts.get(WORK_UT)).toBe(70);
    expect(counts.get(WORK_TM)).toBe(4);
    expect(counts.get(WORK_WOGW)).toBe(25);
    expect(counts.get(WORK_CBG)).toBe(15);
    expect(counts.get(WORK_PHG)).toBe(13);
    expect(counts.get(WORK_DP)).toBe(59);
  });

  it('is deterministic — same input always produces the same Work id', () => {
    const row = { author: 'Sun Myung Moon', title: 'Cham Bumo Gyeong — ChambumoGyeong-00' };
    expect(sourceToWork(row)).toBe(sourceToWork(row));
  });
});

describe('BACKFILL_FIGURES / BACKFILL_WORKS constants', () => {
  it('declares the 3 Figures: Sun Myung Moon, Sang Hun Lee, Hak Ja Han', () => {
    const displayNames = BACKFILL_FIGURES.map((f) => f.displayName).sort();
    expect(displayNames).toEqual(['Hak Ja Han', 'Sang Hun Lee', 'Sun Myung Moon']);
  });

  it('declares 7 Works, all tier=core, each pointing at a real Figure id', () => {
    expect(BACKFILL_WORKS).toHaveLength(7);
    const figureIds = new Set(BACKFILL_FIGURES.map((f) => f.id));
    for (const w of BACKFILL_WORKS) {
      expect(w.tier).toBe('core');
      expect(figureIds.has(w.figureId)).toBe(true);
    }
  });

  it('attributes Sun Myung Moon to CSG, DP, WOGW, CBG, PHG (5 Works)', () => {
    const smm = BACKFILL_FIGURES.find((f) => f.displayName === 'Sun Myung Moon')!;
    const smmWorks = BACKFILL_WORKS.filter((w) => w.figureId === smm.id).map((w) => w.id).sort();
    expect(smmWorks).toEqual([WORK_CBG, WORK_CSG, WORK_DP, WORK_PHG, WORK_WOGW].sort());
  });

  it('attributes Sang Hun Lee to UT and Hak Ja Han to TM Anthology', () => {
    const shl = BACKFILL_FIGURES.find((f) => f.displayName === 'Sang Hun Lee')!;
    const hjh = BACKFILL_FIGURES.find((f) => f.displayName === 'Hak Ja Han')!;
    expect(BACKFILL_WORKS.filter((w) => w.figureId === shl.id).map((w) => w.id)).toEqual([WORK_UT]);
    expect(BACKFILL_WORKS.filter((w) => w.figureId === hjh.id).map((w) => w.id)).toEqual([WORK_TM]);
  });
});
