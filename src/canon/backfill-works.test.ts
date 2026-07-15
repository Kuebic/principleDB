// Backfill orchestrator over the pure `sourceToWork` mapping (issue #54,
// ADR-0017). Covers the acceptance-criteria properties: partition assigns
// every representative row to the right Work; re-running is idempotent (no
// duplicate Figures/Works, assignments unchanged).

import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './in-memory-repository';
import { backfillWorks } from './backfill-works';
import {
  BACKFILL_FIGURES,
  BACKFILL_WORKS,
  WORK_CBG,
  WORK_CSG,
  WORK_DD_REVELATIONS,
  WORK_DD_SPECIAL_GRACE,
  WORK_DP,
  WORK_PHG,
  WORK_TM,
  WORK_UT,
  WORK_WOGW,
} from './source-to-work';
import type { Source } from './types';

function src(id: string, author: string, title: string, workId?: string | null): Source {
  return {
    id,
    title,
    author,
    kind: 'sermon',
    date: '2026-01-01',
    text: 'body',
    r2Key: null,
    structureMap: { kind: 'none' },
    workId: workId ?? null,
  };
}

async function seedRepresentative() {
  const repo = new InMemoryRepository();
  await repo.upsertSource(src('s1', 'SunMyungMoon-CSG', 'CSG — book1-01'));
  await repo.upsertSource(src('s2', 'Sang Hun Lee', 'UT — 01'));
  await repo.upsertSource(src('s3', 'Hak Ja Han Moon', 'TM — 1'));
  await repo.upsertSource(src('s4', 'Sun Myung Moon', 'Cham Bumo Gyeong — ChambumoGyeong-00'));
  await repo.upsertSource(src('s5', 'Sun Myung Moon', 'Pyeong Hwa Gyeong — PHG14-01'));
  // Real capitalisation — "The Way *Of* God's Will".
  await repo.upsertSource(src('s6', 'Sun Myung Moon', "The Way Of God's Will — WOGW-01"));
  await repo.upsertSource(src('s7', '01-the-principle-of-creation', 'Ch.1'));
  await repo.upsertSource(src('s8', 'Damien Dunkley', "Discourse on True Mother's Revelations — Part 01"));
  await repo.upsertSource(src('s9', 'Damien Dunkley', 'The Meaning of Special Grace'));
  return repo;
}

describe('backfillWorks', () => {
  it('creates the 4 Figures and 9 Works and assigns every Source to its Work', async () => {
    const repo = await seedRepresentative();
    const result = await backfillWorks(repo);

    expect(result.figuresUpserted).toBe(4);
    expect(result.worksUpserted).toBe(9);
    expect(result.sourcesAssigned).toBe(9);
    expect(result.sourcesUnchanged).toBe(0);

    // Every Work + Figure landed and joined.
    const listings = await repo.listWorks();
    expect(listings).toHaveLength(BACKFILL_WORKS.length);
    for (const w of BACKFILL_WORKS) {
      const l = listings.find((x) => x.work.id === w.id)!;
      expect(l.work.title).toBe(w.title);
      expect(l.work.tier).toBe(w.tier);
      expect(BACKFILL_FIGURES.some((f) => f.id === l.figure.id)).toBe(true);
    }

    // Assignments — the 9 seeded rows land in their Works.
    const byWork = new Map<string, string[]>();
    for (const w of BACKFILL_WORKS) {
      byWork.set(w.id, await repo.listSourceIdsInWorks([w.id]));
    }
    expect(byWork.get(WORK_CSG)).toEqual(['s1']);
    expect(byWork.get(WORK_UT)).toEqual(['s2']);
    expect(byWork.get(WORK_TM)).toEqual(['s3']);
    expect(byWork.get(WORK_CBG)).toEqual(['s4']);
    expect(byWork.get(WORK_PHG)).toEqual(['s5']);
    expect(byWork.get(WORK_WOGW)).toEqual(['s6']);
    expect(byWork.get(WORK_DP)).toEqual(['s7']);
    expect(byWork.get(WORK_DD_REVELATIONS)).toEqual(['s8']);
    expect(byWork.get(WORK_DD_SPECIAL_GRACE)).toEqual(['s9']);
  });

  it('is idempotent — a second run produces no duplicates and no assignment changes', async () => {
    const repo = await seedRepresentative();
    await backfillWorks(repo);

    // Snapshot post-first-run state.
    const worksBefore = (await repo.listWorks()).length;
    const dpBefore = await repo.listSourceIdsInWorks([WORK_DP]);
    const csgBefore = await repo.listSourceIdsInWorks([WORK_CSG]);

    const second = await backfillWorks(repo);

    // Every Source's workId was already set correctly — nothing needed to
    // move. Figures/Works upserts are no-ops on second run (still count as
    // "upserted" because the port doesn't distinguish insert from update;
    // that's fine — the test asserts state didn't multiply).
    expect(second.sourcesUnchanged).toBe(9);
    expect(second.sourcesAssigned).toBe(0);

    // No duplicate Works/Figures crept in.
    expect(await repo.listWorks()).toHaveLength(worksBefore);
    expect(await repo.listSourceIdsInWorks([WORK_DP])).toEqual(dpBefore);
    expect(await repo.listSourceIdsInWorks([WORK_CSG])).toEqual(csgBefore);
  });

  it('re-routes a Source whose workId was wrong (defensive re-run)', async () => {
    const repo = new InMemoryRepository();
    // A CSG chunk mistakenly stamped with DP earlier — the re-run should fix it.
    await repo.upsertSource(src('s_bad', 'SunMyungMoon-CSG', 'CSG — book1-01', WORK_DP));

    const result = await backfillWorks(repo);

    expect(result.sourcesAssigned).toBe(1);
    expect(result.sourcesUnchanged).toBe(0);
    expect(await repo.listSourceIdsInWorks([WORK_CSG])).toEqual(['s_bad']);
    expect(await repo.listSourceIdsInWorks([WORK_DP])).toEqual([]);
  });
});
