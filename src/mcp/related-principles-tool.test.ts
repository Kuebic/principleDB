// related_principles tool — MCP-level wiring around the relatedPrinciples
// core op (issue #7). Mirrors the search_principles response shape so each
// related hit comes with citation-ready fields (Source title/author/kind and
// the Source's own words at the snapped span).

import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { Source } from '../canon/types';
import { relatedPrinciplesTool } from './related-principles-tool';

const graceSermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first. Obedience flows from being loved.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

describe('relatedPrinciplesTool', () => {
  it("hits each carry the Source's own words at the snapped span and a derived label", async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Obedience flows from grace.', quote: 'Obedience flows from being loved.' },
    ]);
    await ingestSource(graceSermon, { provider, repository });

    const hits = await repository.searchByEmbedding(
      (await provider.embed(['grace precedes obedience']))[0]!,
      1,
    );
    const seedId = hits[0]!.principle.id;

    const resp = await relatedPrinciplesTool({ principleId: seedId }, { repository });
    expect(resp.related.length).toBeGreaterThan(0);
    const first = resp.related[0]!;
    expect(first.claim).toBe('Obedience flows from grace.');
    expect(first.quote.text).toBe('Obedience flows from being loved.');
    expect(first.source.title).toBe('Grace and obedience');
    expect(first.source.kind).toBe('sermon');
    expect(first.quote.label).toMatch(/^~\d+% in$/);
  });

  // A miniature core-vs-extra Canon (ADR-0017) where the `extra` Principle is a
  // genuine cosine neighbour of the core seed — so it WOULD ride into an
  // unscoped related stack if the tier gate weren't applied. Claims share
  // tokens ("grace"/"precedes"/"obedience") so all three clear the 0.3 floor.
  async function seedScopedCanon(): Promise<{
    repository: InMemoryRepository;
    seedId: string;
  }> {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider((input) =>
      input.title === 'The Meaning of Special Grace'
        ? [{ claim: 'Grace precedes cleanse', quote: 'Grace precedes cleanse.' }]
        : [
            { claim: 'Grace precedes obedience', quote: 'Grace precedes obedience.' },
            { claim: 'Obedience flows from grace', quote: 'Obedience flows from grace.' },
          ],
    );

    await repository.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repository.upsertFigure({ id: 'fig_dd', slug: 'damien-dunkley', displayName: 'Damien Dunkley' });
    await repository.upsertWork({ id: 'work_core', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
    await repository.upsertWork({ id: 'work_extra', title: 'The Meaning of Special Grace', figureId: 'fig_dd', tier: 'extra' });

    const core: Source = {
      id: 's_core',
      title: 'Core teaching',
      author: 'slug',
      kind: 'book',
      date: '2026-01-01',
      text: 'Grace precedes obedience. Obedience flows from grace.',
      r2Key: null,
      structureMap: { kind: 'none' },
      workId: 'work_core',
    };
    const extra: Source = {
      id: 's_extra',
      title: 'The Meaning of Special Grace',
      author: 'Damien Dunkley',
      kind: 'transcript',
      date: '2026-02-26',
      text: 'Grace precedes cleanse.',
      r2Key: null,
      structureMap: { kind: 'none' },
      workId: 'work_extra',
    };
    await ingestSource(core, { provider, repository });
    await ingestSource(extra, { provider, repository });

    const hits = await repository.searchByEmbedding(
      (await provider.embed(['grace precedes obedience']))[0]!,
      10,
      ['s_core'],
    );
    const seedId = hits.find((h) => h.principle.claim === 'Grace precedes obedience')!.principle.id;
    return { repository, seedId };
  }

  it('unscoped: an `extra` neighbour never leaks into the related stack; the core sibling does', async () => {
    const { repository, seedId } = await seedScopedCanon();
    const resp = await relatedPrinciplesTool({ principleId: seedId }, { repository });
    const claims = resp.related.map((h) => h.claim);
    // The core sibling surfaces...
    expect(claims).toContain('Obedience flows from grace');
    // ...but the `extra` Principle (a real cosine neighbour) does NOT, because
    // the default scope is core-only (ADR-0017). This is the regression: before
    // the tier gate on related_principles, 'Grace precedes cleanse' leaked here.
    expect(claims).not.toContain('Grace precedes cleanse');
    expect(resp.related.some((h) => h.source.id === 's_extra')).toBe(false);
  });

  it('naming the `extra` Work/Figure opts its neighbours in', async () => {
    const { repository, seedId } = await seedScopedCanon();

    const byFigure = await relatedPrinciplesTool(
      { principleId: seedId, figures: ['damien-dunkley'] },
      { repository },
    );
    expect(byFigure.related.map((h) => h.claim)).toContain('Grace precedes cleanse');

    const byWork = await relatedPrinciplesTool(
      { principleId: seedId, works: ['work_extra'] },
      { repository },
    );
    expect(byWork.related.map((h) => h.claim)).toContain('Grace precedes cleanse');
  });

  it('includeExtras: true draws relatives from core + every extra at once', async () => {
    const { repository, seedId } = await seedScopedCanon();
    const resp = await relatedPrinciplesTool(
      { principleId: seedId, includeExtras: true },
      { repository },
    );
    const claims = resp.related.map((h) => h.claim);
    // Both the core sibling AND the extra neighbour surface together.
    expect(claims).toContain('Obedience flows from grace');
    expect(claims).toContain('Grace precedes cleanse');
  });

  it('returns the well-shaped empty case ({ related: [] }) for an unknown id', async () => {
    const repository = new InMemoryRepository();
    const resp = await relatedPrinciplesTool({ principleId: 'nope' }, { repository });
    expect(resp).toEqual({ related: [] });
  });

  it('returns the well-shaped empty case ({ related: [] }) for a singleton Canon', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    await ingestSource(graceSermon, { provider, repository });
    const hits = await repository.searchByEmbedding(
      (await provider.embed(['grace']))[0]!,
      1,
    );
    const seedId = hits[0]!.principle.id;

    const resp = await relatedPrinciplesTool({ principleId: seedId }, { repository });
    expect(resp).toEqual({ related: [] });
  });
});
