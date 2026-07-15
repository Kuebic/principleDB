// Repository-level Work/Figure surface (ADR-0017). Pins the port contract
// the search page + `list_works` MCP tool + scope resolver read from.

import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from './fake-provider';
import { ingestSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import type { Source } from './types';

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

  it('listSourceIdsInWorks returns the Sources belonging to the requested Works only', async () => {
    const repo = new InMemoryRepository();
    await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repo.upsertWork({ id: 'work_a', title: 'A', figureId: 'fig_smm', tier: 'core' });
    await repo.upsertWork({ id: 'work_b', title: 'B', figureId: 'fig_smm', tier: 'core' });
    const mk = (id: string, workId: string | null): Source => ({
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
    await repo.upsertSource(mk('s1', 'work_a'));
    await repo.upsertSource(mk('s2', 'work_a'));
    await repo.upsertSource(mk('s3', 'work_b'));
    await repo.upsertSource(mk('s_orphan', null));

    expect(new Set(await repo.listSourceIdsInWorks(['work_a']))).toEqual(new Set(['s1', 's2']));
    expect(new Set(await repo.listSourceIdsInWorks(['work_a', 'work_b']))).toEqual(
      new Set(['s1', 's2', 's3']),
    );
    expect(await repo.listSourceIdsInWorks([])).toEqual([]);
    // Orphan Sources (workId null) never leak into a scoped set.
    expect(await repo.listSourceIdsInWorks(['work_a'])).not.toContain('s_orphan');
  });

  it('searchByEmbedding without a scope returns hits from every Source (unchanged behavior)', async () => {
    const repo = new InMemoryRepository();
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
    };
    await ingestSource(src, { provider, repository: repo });
    const [embedding] = await provider.embed(['grace']);
    expect(await repo.searchByEmbedding(embedding!, 10, [])).toEqual([]);
  });
});
