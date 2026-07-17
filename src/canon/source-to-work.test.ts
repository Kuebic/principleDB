// Pure Source → Work mapping (issue #54, ADR-0017). The one-time backfill
// script is a thin shell over this function; testing the function pins the
// rules and asserts the partition is total and disjoint against representative
// rows for the live founding counts (429/59/25/15/13/70/4) plus the Damien
// Dunkley `extra` additions (10/1).
//
// The rules (verified against the live `author`/`title` values in ADR-0017):
//   author='SunMyungMoon-CSG'                    → Cheon Seong Gyeong  (429)
//   author='Sang Hun Lee'                        → Unification Thought (70)
//   author='Hak Ja Han Moon'                     → TM Anthology        (4)
//   author='Sun Myung Moon' + title-signature    → WOGW / CBG / PHG / TFG (25/15/13/1)
//   author matches /^\d{2}-/ (DP part-slugs)     → Divine Principle    (59)
//   author='Damien Dunkley' + title-signature    → the two Dunkley Works (10/1)
//   anything else                                → THROWS (guardrail, no silent DP)
//
// NOTE on WOGW: the live titles read "The Way *Of* God's Will" (capital Of).
// The match is case-insensitive; fixtures below use the real capitalisation so
// a regression to a case-sensitive check fails here.

import { describe, expect, it } from 'vitest';
import {
  BACKFILL_FIGURES,
  BACKFILL_WORKS,
  UnmappedSourceError,
  WORK_CBG,
  WORK_CSG,
  WORK_DD_REVELATIONS,
  WORK_DD_SPECIAL_GRACE,
  WORK_DP,
  WORK_PHG,
  WORK_TFG,
  WORK_TM,
  WORK_UT,
  WORK_WOGW,
  WORK_WOT,
  WORK_MOP,
  WORK_PLGC,
  WORK_BR,
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

  it('splits the Hak Ja Han bucket: "Mother of Peace" memoir → its own extra Work', () => {
    expect(
      sourceToWork({ author: 'Hak Ja Han Moon', title: 'Mother of Peace' }),
    ).toBe(WORK_MOP);
    expect(
      sourceToWork({ author: 'Hak Ja Han Moon', title: 'Mother of Peace, the Memoir' }),
    ).toBe(WORK_MOP);
    // The teaching anthology still falls through to TM.
    expect(
      sourceToWork({ author: 'Hak Ja Han Moon', title: "An Anthology of True Mother's Teachings 1" }),
    ).toBe(WORK_TM);
  });

  it('maps the Sun Myung Moon "Peace-Loving Global Citizen" autobiography → its own extra Work', () => {
    expect(
      sourceToWork({ author: 'Sun Myung Moon', title: 'As a Peace-Loving Global Citizen' }),
    ).toBe(WORK_PLGC);
    // The real PDF title carries a "with photos … October 2009" suffix.
    expect(
      sourceToWork({
        author: 'Sun Myung Moon',
        title: 'As A Peace-Loving Global Citizen - with photos - Sun Myung Moon - October 2009',
      }),
    ).toBe(WORK_PLGC);
  });

  it('splits the Sun Myung Moon bucket by title signature (CBG / PHG / WOGW)', () => {
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Cham Bumo Gyeong — ChambumoGyeong-00' })).toBe(WORK_CBG);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Cham Bumo Gyeong — ChambumoGyeong-14' })).toBe(WORK_CBG);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Pyeong Hwa Gyeong — PHG14-01' })).toBe(WORK_PHG);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Pyeong Hwa Gyeong — PHG14-13' })).toBe(WORK_PHG);
    // Real capitalisation — "Way *Of* God's Will". A case-sensitive check regresses here.
    expect(sourceToWork({ author: 'Sun Myung Moon', title: 'Section 1 The Predestination of the Way Of God’s Will'.replace('’', "'") })).toBe(WORK_WOGW);
    expect(sourceToWork({ author: 'Sun Myung Moon', title: "Witnessing - The Way Of God's Will - Sun Myung Moon" })).toBe(WORK_WOGW);
  });

  it('maps the Sun Myung Moon "Gateway to Heaven" textbook → its own core Work', () => {
    expect(
      sourceToWork({ author: 'Sun Myung Moon', title: 'True Families: Gateway to Heaven' }),
    ).toBe(WORK_TFG);
    // The real PDF title carries the translation/date suffix — still matches.
    expect(
      sourceToWork({
        author: 'Sun Myung Moon',
        title: 'True Families: Gateway to Heaven - 2014 translation',
      }),
    ).toBe(WORK_TFG);
  });

  it('matches WOGW regardless of the case of "Of"', () => {
    for (const t of [
      "The Way Of God's Will",
      "the way of god's will",
      "Introduction - The Way OF God's Will",
    ]) {
      expect(sourceToWork({ author: 'Sun Myung Moon', title: t })).toBe(WORK_WOGW);
    }
  });

  it('routes DP part-slugs (matched positively by /^\\d{2}-/) → Divine Principle', () => {
    // Live rows have `author` values like `01-the-principle-of-creation`,
    // `05-the-parallels-between-the-two-ages…`, with the book name nowhere in
    // the row (ADR-0017). DP is now matched POSITIVELY by the part-slug shape,
    // not as a catch-all — so unknown authors throw instead of becoming DP.
    expect(sourceToWork({ author: '01-the-principle-of-creation', title: 'Ch.1' })).toBe(WORK_DP);
    expect(sourceToWork({ author: '05-the-parallels-between-the-two-ages', title: 'Ch.5' })).toBe(WORK_DP);
    expect(sourceToWork({ author: '16-final-restoration', title: 'anything' })).toBe(WORK_DP);
  });

  it('maps the Sun Myung Moon "Way of Tradition" compilation → its own extra Work', () => {
    expect(
      sourceToWork({ author: 'Sun Myung Moon', title: 'The Way of Tradition — WayOfTradition1-800000' }),
    ).toBe(WORK_WOT);
    expect(
      sourceToWork({ author: 'Sun Myung Moon', title: 'The Way of Tradition — WayOfTradition4-800000' }),
    ).toBe(WORK_WOT);
  });

  it('maps Tyler Hendricks "Believers\' Responsibility" → its own extra Work', () => {
    expect(
      sourceToWork({ author: 'Tyler Hendricks', title: "The Believers' Responsibility" }),
    ).toBe(WORK_BR);
    // Real ingest title carries the file-stem suffix — still matches.
    expect(
      sourceToWork({
        author: 'Tyler Hendricks',
        title: "The Believers' Responsibility — BelieversResponsibility",
      }),
    ).toBe(WORK_BR);
    // A future, undeclared Hendricks work must throw rather than land in BR.
    expect(() =>
      sourceToWork({ author: 'Tyler Hendricks', title: 'Some Other Hendricks Talk' }),
    ).toThrow();
  });

  it('maps the two Damien Dunkley discourses to their extra Works', () => {
    expect(
      sourceToWork({ author: 'Damien Dunkley', title: "Discourse on True Mother's Revelations — Part 01" }),
    ).toBe(WORK_DD_REVELATIONS);
    expect(
      sourceToWork({ author: 'Damien Dunkley', title: "Discourse on True Mother's Revelations — Part 10" }),
    ).toBe(WORK_DD_REVELATIONS);
    expect(
      sourceToWork({ author: 'Damien Dunkley', title: 'The Meaning of Special Grace' }),
    ).toBe(WORK_DD_SPECIAL_GRACE);
  });

  it('THROWS on an unknown author instead of silently routing to DP (guardrail)', () => {
    expect(() => sourceToWork({ author: 'Some New Speaker', title: 'A brand new talk' })).toThrow(
      UnmappedSourceError,
    );
    // A Sun Myung Moon row with no recognised book signature is a signal a new
    // SMM Work was ingested without being declared — it must throw, not fall to DP.
    expect(() => sourceToWork({ author: 'Sun Myung Moon', title: 'Some Unrecognised Book' })).toThrow(
      UnmappedSourceError,
    );
    // An unrecognised Dunkley talk likewise throws rather than mis-bucketing.
    expect(() => sourceToWork({ author: 'Damien Dunkley', title: 'An Unlisted Sermon' })).toThrow(
      UnmappedSourceError,
    );
  });

  it('partition is total and disjoint over the live 634 rows (429/59/25/15/13/1/70/4 + 10/1 + 4 + 1 PLGC + 1 MoP + 1 BR)', () => {
    // Representative rows drawn from the live partition. Each row must map to
    // exactly one Work; the count per Work must match what the dry-run reports.
    const rows: Array<{ author: string; title: string; expected: string }> = [];
    for (let i = 0; i < 429; i++) rows.push({ author: 'SunMyungMoon-CSG', title: `CSG chunk ${i}`, expected: WORK_CSG });
    for (let i = 0; i < 70; i++) rows.push({ author: 'Sang Hun Lee', title: `UT chunk ${i}`, expected: WORK_UT });
    for (let i = 0; i < 4; i++) rows.push({ author: 'Hak Ja Han Moon', title: `TM chunk ${i}`, expected: WORK_TM });
    // Real capitalisation — "The Way *Of* God's Will".
    for (let i = 0; i < 25; i++) rows.push({ author: 'Sun Myung Moon', title: `The Way Of God's Will — WOGW-${i}`, expected: WORK_WOGW });
    for (let i = 0; i < 15; i++) rows.push({ author: 'Sun Myung Moon', title: `Cham Bumo Gyeong — ChambumoGyeong-${i}`, expected: WORK_CBG });
    for (let i = 0; i < 13; i++) rows.push({ author: 'Sun Myung Moon', title: `Pyeong Hwa Gyeong — PHG14-${i}`, expected: WORK_PHG });
    // Gateway to Heaven — a single 26-page textbook PDF → one Source.
    rows.push({ author: 'Sun Myung Moon', title: 'True Families: Gateway to Heaven', expected: WORK_TFG });
    // DP's 59 shattered across ~16 part-slug values; use ~4 rows per slug for realism.
    // 14 parts × 4 + 1 part × 3 = 59 rows exactly.
    for (let part = 1; part <= 15; part++) {
      const slug = `${String(part).padStart(2, '0')}-dp-part-${part}`;
      const per = part === 15 ? 3 : 4;
      for (let i = 0; i < per; i++) rows.push({ author: slug, title: `DP ${slug}#${i}`, expected: WORK_DP });
    }
    // Damien Dunkley `extra` additions: 10-part discourse + 1 standalone talk.
    for (let i = 1; i <= 10; i++) {
      rows.push({ author: 'Damien Dunkley', title: `Discourse on True Mother's Revelations — Part ${String(i).padStart(2, '0')}`, expected: WORK_DD_REVELATIONS });
    }
    rows.push({ author: 'Damien Dunkley', title: 'The Meaning of Special Grace', expected: WORK_DD_SPECIAL_GRACE });
    // The Way of Tradition `extra` addition: 4 volume PDFs → one Work.
    for (let i = 1; i <= 4; i++) {
      rows.push({ author: 'Sun Myung Moon', title: `The Way of Tradition — WayOfTradition${i}-800000`, expected: WORK_WOT });
    }
    // The two 2026-07 autobiography/memoir additions — one PDF Source each.
    rows.push({ author: 'Sun Myung Moon', title: 'As a Peace-Loving Global Citizen', expected: WORK_PLGC });
    rows.push({ author: 'Hak Ja Han Moon', title: 'Mother of Peace', expected: WORK_MOP });
    // Tyler Hendricks historical/context layer — one PDF Source.
    rows.push({ author: 'Tyler Hendricks', title: "The Believers' Responsibility", expected: WORK_BR });
    expect(rows.length).toBe(634);

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
    expect(counts.get(WORK_TFG)).toBe(1);
    expect(counts.get(WORK_DP)).toBe(59);
    expect(counts.get(WORK_DD_REVELATIONS)).toBe(10);
    expect(counts.get(WORK_DD_SPECIAL_GRACE)).toBe(1);
    expect(counts.get(WORK_WOT)).toBe(4);
    expect(counts.get(WORK_PLGC)).toBe(1);
    expect(counts.get(WORK_MOP)).toBe(1);
    expect(counts.get(WORK_BR)).toBe(1);
  });

  it('is deterministic — same input always produces the same Work id', () => {
    const row = { author: 'Sun Myung Moon', title: 'Cham Bumo Gyeong — ChambumoGyeong-00' };
    expect(sourceToWork(row)).toBe(sourceToWork(row));
  });
});

describe('BACKFILL_FIGURES / BACKFILL_WORKS constants', () => {
  it('declares the 5 Figures: Sun Myung Moon, Sang Hun Lee, Hak Ja Han, Damien Dunkley, Tyler Hendricks', () => {
    const displayNames = BACKFILL_FIGURES.map((f) => f.displayName).sort();
    expect(displayNames).toEqual([
      'Damien Dunkley',
      'Hak Ja Han',
      'Sang Hun Lee',
      'Sun Myung Moon',
      'Tyler Hendricks',
    ]);
  });

  it('declares 14 Works, each pointing at a real Figure id; the 8 founding are core, the 2 Dunkley + Way of Tradition + PLGC + Mother of Peace + Believers\' Responsibility are extra', () => {
    expect(BACKFILL_WORKS).toHaveLength(14);
    const figureIds = new Set(BACKFILL_FIGURES.map((f) => f.id));
    for (const w of BACKFILL_WORKS) {
      expect(figureIds.has(w.figureId)).toBe(true);
    }
    expect(BACKFILL_WORKS.filter((w) => w.tier === 'core')).toHaveLength(8);
    const extras = BACKFILL_WORKS.filter((w) => w.tier === 'extra').map((w) => w.id).sort();
    expect(extras).toEqual(
      [WORK_DD_REVELATIONS, WORK_DD_SPECIAL_GRACE, WORK_WOT, WORK_PLGC, WORK_MOP, WORK_BR].sort(),
    );
  });

  it('attributes Sun Myung Moon to CSG, DP, WOGW, CBG, PHG, TFG + the extra Way of Tradition + PLGC (8 Works)', () => {
    const smm = BACKFILL_FIGURES.find((f) => f.displayName === 'Sun Myung Moon')!;
    const smmWorks = BACKFILL_WORKS.filter((w) => w.figureId === smm.id).map((w) => w.id).sort();
    expect(smmWorks).toEqual([WORK_CBG, WORK_CSG, WORK_DP, WORK_PHG, WORK_PLGC, WORK_TFG, WORK_WOGW, WORK_WOT].sort());
  });

  it('attributes Sang Hun Lee → UT, Hak Ja Han → TM + Mother of Peace, Damien Dunkley → both discourses, Tyler Hendricks → Believers\' Responsibility', () => {
    const shl = BACKFILL_FIGURES.find((f) => f.displayName === 'Sang Hun Lee')!;
    const hjh = BACKFILL_FIGURES.find((f) => f.displayName === 'Hak Ja Han')!;
    const dd = BACKFILL_FIGURES.find((f) => f.displayName === 'Damien Dunkley')!;
    const th = BACKFILL_FIGURES.find((f) => f.displayName === 'Tyler Hendricks')!;
    expect(BACKFILL_WORKS.filter((w) => w.figureId === shl.id).map((w) => w.id)).toEqual([WORK_UT]);
    expect(BACKFILL_WORKS.filter((w) => w.figureId === hjh.id).map((w) => w.id).sort()).toEqual(
      [WORK_TM, WORK_MOP].sort(),
    );
    expect(BACKFILL_WORKS.filter((w) => w.figureId === dd.id).map((w) => w.id).sort()).toEqual(
      [WORK_DD_REVELATIONS, WORK_DD_SPECIAL_GRACE].sort(),
    );
    expect(BACKFILL_WORKS.filter((w) => w.figureId === th.id).map((w) => w.id)).toEqual([WORK_BR]);
  });
});
