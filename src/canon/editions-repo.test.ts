// Repository surface for Editions + Recension provenance (ADR-0018, PRD #58).
// Slice 1 (issue #59): schema + repository foundation — no resolution or
// backfill wired yet. Pins the port contract the later slices build on.

import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './in-memory-repository';
import type { Source } from './types';

describe('CanonRepository — Editions (in-memory)', () => {
  it('upsertEdition is idempotent by primary key (re-upsert updates in place)', async () => {
    const repo = new InMemoryRepository();
    await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repo.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });

    await repo.upsertEdition({
      id: 'ed_csg_2013',
      workId: 'work_csg',
      label: '2013 Revised',
      recension: 'ffwpu-post-2012',
      language: 'en',
      publishedDate: null,
      publisher: null,
      notes: null,
    });
    // A re-upsert with an updated label overwrites in place.
    await repo.upsertEdition({
      id: 'ed_csg_2013',
      workId: 'work_csg',
      label: 'Cheon Seong Gyeong — 2013 Revised',
      recension: 'ffwpu-post-2012',
      language: 'en',
      publishedDate: '2013-01-01',
      publisher: 'FFWPU',
      notes: null,
    });

    const fetched = await repo.getEdition('ed_csg_2013');
    expect(fetched).not.toBeNull();
    expect(fetched!.label).toBe('Cheon Seong Gyeong — 2013 Revised');
    expect(fetched!.recension).toBe('ffwpu-post-2012');
    expect(fetched!.publishedDate).toBe('2013-01-01');
    expect(fetched!.publisher).toBe('FFWPU');
    expect(fetched!.language).toBe('en');
  });

  it('getEdition returns null for an unknown id', async () => {
    const repo = new InMemoryRepository();
    expect(await repo.getEdition('nope')).toBeNull();
  });

  it('Source.editionId round-trips through upsertSource + getSource', async () => {
    const repo = new InMemoryRepository();
    await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repo.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
    await repo.upsertEdition({
      id: 'ed_csg_2013',
      workId: 'work_csg',
      label: '2013 Revised',
      recension: 'ffwpu-post-2012',
      language: 'en',
      publishedDate: null,
      publisher: null,
      notes: null,
    });

    const src: Source = {
      id: 's_csg_1',
      title: 'CSG chapter 1',
      author: 'SunMyungMoon-CSG',
      kind: 'book',
      date: '2013-01-01',
      text: 'body',
      r2Key: null,
      structureMap: { kind: 'none' },
      workId: 'work_csg',
      editionId: 'ed_csg_2013',
    };
    await repo.upsertSource(src);
    const fetched = await repo.getSource('s_csg_1');
    expect(fetched?.editionId).toBe('ed_csg_2013');
  });

  it('Source.editionId defaults to null when omitted (backfill window)', async () => {
    // The migration adds the column nullable; existing Sources round-trip
    // as `editionId: null` until the backfill slice (#60) runs.
    const repo = new InMemoryRepository();
    const src: Source = {
      id: 's_orphan',
      title: 'Orphan',
      author: 'x',
      kind: 'sermon',
      date: '2026-01-01',
      text: 'body',
      r2Key: null,
      structureMap: { kind: 'none' },
    };
    await repo.upsertSource(src);
    const fetched = await repo.getSource('s_orphan');
    expect(fetched?.editionId ?? null).toBeNull();
  });
});
