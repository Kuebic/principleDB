// resolveScope — shared source-filtering resolver over the CanonRepository
// port (ADR-0017). Covers the semantics both surfaces (web + MCP) share:
// unscoped ⇒ all core Works, Figures expand to Works, extras are opt-in.

import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './in-memory-repository';
import { resolveScope } from './scope';
import type { Source } from './types';

async function seed() {
  const repo = new InMemoryRepository();
  await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
  await repo.upsertFigure({ id: 'fig_hjh', slug: 'hak-ja-han', displayName: 'Hak Ja Han' });
  await repo.upsertFigure({ id: 'fig_shl', slug: 'sang-hun-lee', displayName: 'Sang Hun Lee' });

  await repo.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
  await repo.upsertWork({ id: 'work_dp', title: 'Divine Principle', figureId: 'fig_smm', tier: 'core' });
  await repo.upsertWork({ id: 'work_tm', title: 'True Mother Anthology', figureId: 'fig_hjh', tier: 'core' });
  await repo.upsertWork({ id: 'work_ut', title: 'Unification Thought', figureId: 'fig_shl', tier: 'core' });
  // A future addition — landed as `extra`, so unscoped searches skip it.
  await repo.upsertWork({ id: 'work_extra', title: 'Later Speeches', figureId: 'fig_hjh', tier: 'extra' });

  const src = (id: string, workId: string): Source => ({
    id,
    title: id,
    author: 'x',
    kind: 'sermon',
    date: '2026-01-01',
    text: 'body',
    r2Key: null,
    structureMap: { kind: 'none' },
    workId,
  });
  await repo.upsertSource(src('s_csg_1', 'work_csg'));
  await repo.upsertSource(src('s_csg_2', 'work_csg'));
  await repo.upsertSource(src('s_dp_1', 'work_dp'));
  await repo.upsertSource(src('s_tm_1', 'work_tm'));
  await repo.upsertSource(src('s_ut_1', 'work_ut'));
  await repo.upsertSource(src('s_extra_1', 'work_extra'));
  return repo;
}

describe('resolveScope', () => {
  it('empty scope → all core Works (extras excluded)', async () => {
    const repo = await seed();
    const { workIds, sourceIds } = await resolveScope({}, repo);
    expect(new Set(workIds)).toEqual(new Set(['work_csg', 'work_dp', 'work_tm', 'work_ut']));
    expect(new Set(sourceIds)).toEqual(
      new Set(['s_csg_1', 's_csg_2', 's_dp_1', 's_tm_1', 's_ut_1']),
    );
  });

  it('a Work id restricts to that Work only', async () => {
    const repo = await seed();
    const { workIds, sourceIds } = await resolveScope({ works: ['work_csg'] }, repo);
    expect(workIds).toEqual(['work_csg']);
    expect(new Set(sourceIds)).toEqual(new Set(['s_csg_1', 's_csg_2']));
  });

  it('a Figure id expands to every Work under that Figure (Hak Ja Han → core + extra when the Figure is picked)', async () => {
    const repo = await seed();
    const { workIds, sourceIds } = await resolveScope({ figures: ['fig_hjh'] }, repo);
    expect(new Set(workIds)).toEqual(new Set(['work_tm', 'work_extra']));
    expect(new Set(sourceIds)).toEqual(new Set(['s_tm_1', 's_extra_1']));
  });

  it('a Figure slug expands the same as its id (URL/MCP-friendly)', async () => {
    const repo = await seed();
    const bySlug = await resolveScope({ figures: ['sang-hun-lee'] }, repo);
    const byId = await resolveScope({ figures: ['fig_shl'] }, repo);
    expect(bySlug.sourceIds.sort()).toEqual(byId.sourceIds.sort());
  });

  it('works + figures are unioned (not intersected)', async () => {
    const repo = await seed();
    const { sourceIds } = await resolveScope(
      { works: ['work_dp'], figures: ['fig_shl'] },
      repo,
    );
    expect(new Set(sourceIds)).toEqual(new Set(['s_dp_1', 's_ut_1']));
  });

  it('an `extra` Work is reachable when explicitly named', async () => {
    const repo = await seed();
    const { workIds, sourceIds } = await resolveScope({ works: ['work_extra'] }, repo);
    expect(workIds).toEqual(['work_extra']);
    expect(sourceIds).toEqual(['s_extra_1']);
  });

  it('unknown ids are ignored (stale URL never crashes) — falls back to empty scope, not the core default', async () => {
    const repo = await seed();
    const { workIds, sourceIds } = await resolveScope({ works: ['does-not-exist'] }, repo);
    expect(workIds).toEqual([]);
    expect(sourceIds).toEqual([]);
  });
});
