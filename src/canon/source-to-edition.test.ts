// Pure Source → Edition mapping (issue #60, PRD #58, ADR-0018). Each founding
// Work has exactly one Edition in this slice — a Source's Edition is uniquely
// determined by its Work. The mapping composes on top of `sourceToWork` so the
// two backfills share their author/title guardrails: an unknown row throws
// with the same `UnmappedSourceError` rather than silently bucketing.
//
// Labels/recensions were chosen against the real corpus (`source.date` +
// `source.title`), not derived from the slug — this test pins each Work's
// Edition tuple so a slug-only shortcut would regress here.

import { describe, expect, it } from 'vitest';
import {
  BACKFILL_EDITIONS,
  EDITION_CBG,
  EDITION_CSG,
  EDITION_DD_REVELATIONS,
  EDITION_DD_SPECIAL_GRACE,
  EDITION_DP,
  EDITION_PHG,
  EDITION_TM,
  EDITION_UT,
  EDITION_WOGW,
  sourceToEdition,
} from './source-to-edition';
import { BACKFILL_WORKS, UnmappedSourceError } from './source-to-work';

describe('sourceToEdition', () => {
  it('routes the CSG author slug → CSG Edition (2013 Revised, ffwpu-post-2012)', () => {
    expect(sourceToEdition({ author: 'SunMyungMoon-CSG', title: 'CSG chunk' })).toBe(EDITION_CSG);
  });

  it('routes Sang Hun Lee → UT Edition (pre-ascension-original)', () => {
    expect(sourceToEdition({ author: 'Sang Hun Lee', title: 'UT — 01' })).toBe(EDITION_UT);
  });

  it('routes Hak Ja Han Moon → TM Anthology Edition (2017, ffwpu-post-2012)', () => {
    expect(sourceToEdition({ author: 'Hak Ja Han Moon', title: 'TM chunk' })).toBe(EDITION_TM);
  });

  it('splits the Sun Myung Moon bucket into CBG / PHG / WOGW Editions by title', () => {
    expect(
      sourceToEdition({ author: 'Sun Myung Moon', title: 'Cham Bumo Gyeong — CBG-00' }),
    ).toBe(EDITION_CBG);
    expect(
      sourceToEdition({ author: 'Sun Myung Moon', title: 'Pyeong Hwa Gyeong — PHG14-01' }),
    ).toBe(EDITION_PHG);
    expect(
      sourceToEdition({ author: 'Sun Myung Moon', title: "The Way Of God's Will — WOGW-01" }),
    ).toBe(EDITION_WOGW);
  });

  it('routes DP part-slug authors (matched by /^\\d{2}-/) → DP Edition (Exposition)', () => {
    expect(sourceToEdition({ author: '01-the-principle-of-creation', title: 'Ch.1' })).toBe(
      EDITION_DP,
    );
    expect(sourceToEdition({ author: '16-final-restoration', title: 'anything' })).toBe(
      EDITION_DP,
    );
  });

  it('routes the two Damien Dunkley discourses to their external-discourse Editions', () => {
    expect(
      sourceToEdition({
        author: 'Damien Dunkley',
        title: "Discourse on True Mother's Revelations — Part 01",
      }),
    ).toBe(EDITION_DD_REVELATIONS);
    expect(
      sourceToEdition({ author: 'Damien Dunkley', title: 'The Meaning of Special Grace' }),
    ).toBe(EDITION_DD_SPECIAL_GRACE);
  });

  it('THROWS on an unknown author (shares the UnmappedSourceError guardrail with sourceToWork)', () => {
    expect(() =>
      sourceToEdition({ author: 'Some New Speaker', title: 'A new talk' }),
    ).toThrow(UnmappedSourceError);
    // Sun Myung Moon row with no recognised book signature — same guardrail
    // that ADR-0017 relies on so unknown data doesn't silently bucket.
    expect(() =>
      sourceToEdition({ author: 'Sun Myung Moon', title: 'Some Unrecognised Book' }),
    ).toThrow(UnmappedSourceError);
  });

  it('is deterministic — same input always produces the same Edition id', () => {
    const row = { author: 'SunMyungMoon-CSG', title: 'CSG chunk' };
    expect(sourceToEdition(row)).toBe(sourceToEdition(row));
  });

  it('partition is total over the live 626 rows — every representative row maps', () => {
    const rows: Array<{ author: string; title: string; expected: string }> = [];
    for (let i = 0; i < 429; i++)
      rows.push({ author: 'SunMyungMoon-CSG', title: `CSG chunk ${i}`, expected: EDITION_CSG });
    for (let i = 0; i < 70; i++)
      rows.push({ author: 'Sang Hun Lee', title: `UT chunk ${i}`, expected: EDITION_UT });
    for (let i = 0; i < 4; i++)
      rows.push({ author: 'Hak Ja Han Moon', title: `TM chunk ${i}`, expected: EDITION_TM });
    for (let i = 0; i < 25; i++)
      rows.push({
        author: 'Sun Myung Moon',
        title: `The Way Of God's Will — WOGW-${i}`,
        expected: EDITION_WOGW,
      });
    for (let i = 0; i < 15; i++)
      rows.push({
        author: 'Sun Myung Moon',
        title: `Cham Bumo Gyeong — CBG-${i}`,
        expected: EDITION_CBG,
      });
    for (let i = 0; i < 13; i++)
      rows.push({
        author: 'Sun Myung Moon',
        title: `Pyeong Hwa Gyeong — PHG14-${i}`,
        expected: EDITION_PHG,
      });
    for (let part = 1; part <= 15; part++) {
      const slug = `${String(part).padStart(2, '0')}-dp-part-${part}`;
      const per = part === 15 ? 3 : 4;
      for (let i = 0; i < per; i++)
        rows.push({ author: slug, title: `DP ${slug}#${i}`, expected: EDITION_DP });
    }
    for (let i = 1; i <= 10; i++) {
      rows.push({
        author: 'Damien Dunkley',
        title: `Discourse on True Mother's Revelations — Part ${String(i).padStart(2, '0')}`,
        expected: EDITION_DD_REVELATIONS,
      });
    }
    rows.push({
      author: 'Damien Dunkley',
      title: 'The Meaning of Special Grace',
      expected: EDITION_DD_SPECIAL_GRACE,
    });
    expect(rows.length).toBe(626);

    const counts = new Map<string, number>();
    for (const r of rows) {
      const got = sourceToEdition(r);
      expect(got).toBe(r.expected);
      counts.set(got, (counts.get(got) ?? 0) + 1);
    }
    expect(counts.get(EDITION_CSG)).toBe(429);
    expect(counts.get(EDITION_UT)).toBe(70);
    expect(counts.get(EDITION_TM)).toBe(4);
    expect(counts.get(EDITION_WOGW)).toBe(25);
    expect(counts.get(EDITION_CBG)).toBe(15);
    expect(counts.get(EDITION_PHG)).toBe(13);
    expect(counts.get(EDITION_DP)).toBe(59);
    expect(counts.get(EDITION_DD_REVELATIONS)).toBe(10);
    expect(counts.get(EDITION_DD_SPECIAL_GRACE)).toBe(1);
  });
});

describe('BACKFILL_EDITIONS constants', () => {
  it('declares one Edition per founding + extra Work (9 total, matches BACKFILL_WORKS)', () => {
    expect(BACKFILL_EDITIONS).toHaveLength(9);
  });

  it('pins CSG / PHG / CBG / TM to `ffwpu-post-2012` with the specified labels', () => {
    const byId = new Map(BACKFILL_EDITIONS.map((e) => [e.id, e] as const));
    expect(byId.get(EDITION_CSG)).toMatchObject({ label: '2013 Revised', recension: 'ffwpu-post-2012' });
    expect(byId.get(EDITION_PHG)).toMatchObject({ label: '2014', recension: 'ffwpu-post-2012' });
    expect(byId.get(EDITION_CBG)).toMatchObject({ label: '2015', recension: 'ffwpu-post-2012' });
    expect(byId.get(EDITION_TM)).toMatchObject({ label: '2017', recension: 'ffwpu-post-2012' });
  });

  it('pins DP / WOGW / UT to `pre-ascension-original`; DP → Exposition, WOGW → 1980', () => {
    const byId = new Map(BACKFILL_EDITIONS.map((e) => [e.id, e] as const));
    expect(byId.get(EDITION_DP)).toMatchObject({ label: 'Exposition', recension: 'pre-ascension-original' });
    expect(byId.get(EDITION_WOGW)).toMatchObject({ label: '1980', recension: 'pre-ascension-original' });
    expect(byId.get(EDITION_UT)?.recension).toBe('pre-ascension-original');
  });

  it('pins the two Dunkley discourses to `external-discourse`', () => {
    const byId = new Map(BACKFILL_EDITIONS.map((e) => [e.id, e] as const));
    expect(byId.get(EDITION_DD_REVELATIONS)?.recension).toBe('external-discourse');
    expect(byId.get(EDITION_DD_SPECIAL_GRACE)?.recension).toBe('external-discourse');
  });

  it('every Edition points at a real Work id from the ADR-0017 backfill', () => {
    const workIds = new Set(BACKFILL_WORKS.map((w) => w.id));
    for (const e of BACKFILL_EDITIONS) {
      expect(workIds.has(e.workId)).toBe(true);
    }
  });

  it('language defaults to `en` on every seeded Edition', () => {
    for (const e of BACKFILL_EDITIONS) {
      expect(e.language).toBe('en');
    }
  });
});
