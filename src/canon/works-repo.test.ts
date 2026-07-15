// Repository-level Work/Figure surface (ADR-0017/ADR-0018). Pins the port
// contract the search page + `list_works` MCP tool + scope resolver read
// from. Post-#61 `listSourceIdsInWorks` resolves through Editions —
// Work → Editions → Sources — while the port's Work-ids-in → Source-ids-out
// contract stays unchanged.

import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from './fake-provider';
import { ingestSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import type { Edition, Source } from './types';

function mkEdition(id: string, workId: string, label = id): Edition {
  return {
    id,
    workId,
    label,
    recension: 'ffwpu-post-2012',
    language: 'en',
    publishedDate: null,
    publisher: null,
    notes: null,
  };
}

describe('CanonRepository — Works/Figures (in-memory)', () => {
  it('listWorks joins each Work to its Figure and carries the tier', async () => {
    const repo = new InMemoryRepository();
    await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repo.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
    await repo.upsertWork({ id: 'work_extra', title: 'Later Speeches', figureId: 'fig_smm', tier: 'extra' });

    const listings = await repo.listWorks();
    expect(listings).toHaveLength(2);
    const csg = listings.find((l) => l.work.id === 'work_csg')!;
    expect(csg.work.tier).toBe('core');
    expect(csg.figure.displayName).toBe('Sun Myung Moon');
    const extra = listings.find((l) => l.work.id === 'work_extra')!;
    expect(extra.work.tier).toBe('extra');
  });

  it('listSourceIdsInWorks resolves through Editions and returns the Sources of the requested Works', async () => {
    const repo = new InMemoryRepository();
    await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repo.upsertWork({ id: 'work_a', title: 'A', figureId: 'fig_smm', tier: 'core' });
    await repo.upsertWork({ id: 'work_b', title: 'B', figureId: 'fig_smm', tier: 'core' });
    await repo.upsertEdition(mkEdition('ed_a', 'work_a'));
    await repo.upsertEdition(mkEdition('ed_b', 'work_b'));

    const mk = (id: string, editionId: string): Source => ({
      id,
      title: id,
      author: 'x',
      kind: 'sermon',
      date: '2026-01-01',
      text: 'body',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId,
    });
    await repo.upsertSource(mk('s1', 'ed_a'));
    await repo.upsertSource(mk('s2', 'ed_a'));
    await repo.upsertSource(mk('s3', 'ed_b'));

    expect(new Set(await repo.listSourceIdsInWorks(['work_a']))).toEqual(new Set(['s1', 's2']));
    expect(new Set(await repo.listSourceIdsInWorks(['work_a', 'work_b']))).toEqual(
      new Set(['s1', 's2', 's3']),
    );
    expect(await repo.listSourceIdsInWorks([])).toEqual([]);
  });

  it('a Work with two Editions unions both Editions Sources (ADR-0018 AC)', async () => {
    const repo = new InMemoryRepository();
    await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repo.upsertWork({ id: 'work_csg', title: 'CSG', figureId: 'fig_smm', tier: 'core' });
    // Two Editions of one Work — the pre-ascension original and the 2013
    // revised. A Work-scoped search must see Sources from BOTH.
    await repo.upsertEdition(mkEdition('ed_csg_pre', 'work_csg', 'pre-ascension'));
    await repo.upsertEdition(mkEdition('ed_csg_2013', 'work_csg', '2013 Revised'));

    const mk = (id: string, editionId: string): Source => ({
      id,
      title: id,
      author: 'x',
      kind: 'sermon',
      date: '2026-01-01',
      text: 'body',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId,
    });
    await repo.upsertSource(mk('s_pre_1', 'ed_csg_pre'));
    await repo.upsertSource(mk('s_pre_2', 'ed_csg_pre'));
    await repo.upsertSource(mk('s_2013_1', 'ed_csg_2013'));

    expect(new Set(await repo.listSourceIdsInWorks(['work_csg']))).toEqual(
      new Set(['s_pre_1', 's_pre_2', 's_2013_1']),
    );
  });

  it('searchByEmbedding without a scope returns hits from every Source (unchanged behavior)', async () => {
    const repo = new InMemoryRepository();
    await seedFoundingWorkAndEdition(repo);
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    const src = (id: string): Source => ({
      id,
      title: id,
      author: 'x',
      kind: 'sermon',
      date: '2026-01-01',
      text: 'Grace precedes obedience.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    });
    await ingestSource(src('sA'), { provider, repository: repo });
    await ingestSource(src('sB'), { provider, repository: repo });
    const [embedding] = await provider.embed(['grace']);
    const hits = await repo.searchByEmbedding(embedding!, 10);
    // Both admitted (default dedup script keeps them separate).
    expect(hits).toHaveLength(2);
  });

  it('searchByEmbedding with a scope filters Principles by home Source id — pre-filter behavior', async () => {
    const repo = new InMemoryRepository();
    await seedFoundingWorkAndEdition(repo);
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    const src = (id: string): Source => ({
      id,
      title: id,
      author: 'x',
      kind: 'sermon',
      date: '2026-01-01',
      text: 'Grace precedes obedience.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    });
    await ingestSource(src('sA'), { provider, repository: repo });
    await ingestSource(src('sB'), { provider, repository: repo });
    const [embedding] = await provider.embed(['grace']);
    const hits = await repo.searchByEmbedding(embedding!, 10, ['sA']);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.principle.quotes[0]!.sourceId).toBe('sA');
  });

  it('searchByEmbedding with an empty scope returns [] (deliberate "nothing selected")', async () => {
    const repo = new InMemoryRepository();
    await seedFoundingWorkAndEdition(repo);
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    const src: Source = {
      id: 'sA',
      title: 'sA',
      author: 'x',
      kind: 'sermon',
      date: '2026-01-01',
      text: 'Grace precedes obedience.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    await ingestSource(src, { provider, repository: repo });
    const [embedding] = await provider.embed(['grace']);
    expect(await repo.searchByEmbedding(embedding!, 10, [])).toEqual([]);
  });
});

async function seedFoundingWorkAndEdition(repo: InMemoryRepository): Promise<void> {
  await repo.upsertFigure({ id: 'fig_seed', slug: 'seed', displayName: 'Seed' });
  await repo.upsertWork({ id: 'work_seed', title: 'Seed', figureId: 'fig_seed', tier: 'core' });
  await repo.upsertEdition(mkEdition('ed_seed', 'work_seed'));
}
