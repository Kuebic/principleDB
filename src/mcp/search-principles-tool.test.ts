import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { ingestSource } from '../canon/ingest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { Source } from '../canon/types';
import { searchPrinciplesTool } from './search-principles-tool';

const sermon: Source = {
  id: 'serm1',
  title: 'Grace and obedience',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

// A miniature Canon that mirrors the ADR-0017 core-vs-extra split so scope
// semantics can be exercised without a real corpus. Three Works: two core
// (each with its own Figure), one extra (under the same Figure as the second
// core Work).
async function seedScopedCanon(): Promise<{
  provider: FakeIngestProvider;
  repository: InMemoryRepository;
}> {
  const provider = new FakeIngestProvider((input) => [
    { claim: `Teaching from ${input.title}.`, quote: input.text.trim() },
  ]);
  const repository = new InMemoryRepository();

  await repository.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
  await repository.upsertFigure({ id: 'fig_hjh', slug: 'hak-ja-han', displayName: 'Hak Ja Han' });

  await repository.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
  await repository.upsertWork({ id: 'work_tm', title: 'True Mother Anthology', figureId: 'fig_hjh', tier: 'core' });
  await repository.upsertWork({ id: 'work_extra', title: 'Later Speeches', figureId: 'fig_hjh', tier: 'extra' });

  const mkSource = (id: string, workId: string, workLabel: string): Source => ({
    id,
    title: `${workLabel} chapter`,
    author: 'ingest-slug-should-not-surface',
    kind: 'book',
    date: '2026-01-01',
    text: `Grace shines through ${workLabel}.`,
    r2Key: null,
    structureMap: { kind: 'none' },
    workId,
  });

  const csg = mkSource('s_csg', 'work_csg', 'CSG');
  const tm = mkSource('s_tm', 'work_tm', 'TM Anthology');
  const extra = mkSource('s_extra', 'work_extra', 'Later Speeches');

  for (const s of [csg, tm, extra]) {
    await ingestSource(s, { provider, repository });
  }
  return { provider, repository };
}

describe('searchPrinciplesTool', () => {
  it("golden test: displayed quote is the source's own words at the snapped span", async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    await ingestSource(sermon, { provider, repository });

    const resp = await searchPrinciplesTool({ query: 'grace and obedience' }, { provider, repository });
    expect(resp.hits).toHaveLength(1);
    const hit = resp.hits[0]!;
    expect(hit.principleId).toMatch(/^serm1#[0-9a-f]{8}#p0$/);
    expect(hit.claim).toBe('Grace precedes obedience.');
    expect(hit.quote.text).toBe('Grace precedes obedience.');
    expect(hit.source.title).toBe('Grace and obedience');
    expect(hit.source.author).toBe('Pastor X');
    expect(hit.source.kind).toBe('sermon');
    // #64/PRD #63: every hit carries a quoteCount = number of Quotes on the
    // Principle. A freshly-distilled single-attestation Principle reads 1.
    expect(hit.quoteCount).toBe(1);
  });

  it('returns a well-shaped empty case ({ hits: [] })', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const resp = await searchPrinciplesTool({ query: 'anything' }, { provider, repository });
    expect(resp).toEqual({ hits: [] });
  });

  it('derives a "page N" label for a span on a single page', async () => {
    const pdf: Source = {
      id: 'pdf1',
      title: 'A Book',
      author: 'A',
      kind: 'book',
      date: '2026-01-01',
      text: 'page one content here. and more.',
      r2Key: 'r2://k',
      structureMap: {
        kind: 'pdf-pages',
        pages: [
          { offset: 0, page: 1 },
          { offset: 22, page: 2 },
        ],
      },
    };
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Page one stuff.', quote: 'page one content here.' },
    ]);
    await ingestSource(pdf, { provider, repository });
    const resp = await searchPrinciplesTool({ query: 'page one' }, { provider, repository });
    expect(resp.hits[0]!.quote.label).toBe('page 1');
  });

  it('derives a "pages N–M" label for a span that crosses a page break (ADR-0009: no special case)', async () => {
    const pdf: Source = {
      id: 'pdf2',
      title: 'A Book',
      author: 'A',
      kind: 'book',
      date: '2026-01-01',
      text: 'page one ends here.\npage two begins here.',
      r2Key: 'r2://k',
      structureMap: {
        kind: 'pdf-pages',
        pages: [
          { offset: 0, page: 1 },
          { offset: 20, page: 2 },
        ],
      },
    };
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Spans a break.', quote: 'ends here. page two begins' },
    ]);
    await ingestSource(pdf, { provider, repository });
    const resp = await searchPrinciplesTool({ query: 'spans a break' }, { provider, repository });
    expect(resp.hits[0]!.quote.label).toBe('pages 1–2');
  });

  it('derives a "~NN% in" position fraction for a Source with no structure map', async () => {
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Loved first.', quote: 'We are loved first.' },
    ]);
    await ingestSource(sermon, { provider, repository });
    const resp = await searchPrinciplesTool({ query: 'loved first' }, { provider, repository });
    expect(resp.hits[0]!.quote.label).toMatch(/^~\d+% in$/);
  });

  it('honours the default limit (5) and accepts an override', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({
      claim: `Claim ${i}.`,
      quote: i % 2 === 0 ? 'Grace precedes obedience.' : 'We are loved first.',
    }));
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => items);
    await ingestSource(sermon, { provider, repository });
    const defaultResp = await searchPrinciplesTool({ query: 'grace' }, { provider, repository });
    expect(defaultResp.hits.length).toBeLessThanOrEqual(5);
    const widerResp = await searchPrinciplesTool({ query: 'grace', limit: 10 }, { provider, repository });
    expect(widerResp.hits.length).toBeGreaterThan(defaultResp.hits.length);
  });

  it('unscoped search covers all core Works and never leaks an ingest slug in the citation', async () => {
    const deps = await seedScopedCanon();
    const resp = await searchPrinciplesTool({ query: 'grace shines' }, deps);
    const sourceIds = resp.hits.map((h) => h.source.id);
    expect(sourceIds).toContain('s_csg');
    expect(sourceIds).toContain('s_tm');
    // The `extra` Work must not surface in an unscoped search — even though it
    // exists in the Canon, the default scope is "all core Works" (ADR-0017).
    expect(sourceIds).not.toContain('s_extra');
    for (const hit of resp.hits) {
      // The tool's citation carries the Work title + Figure display name; the
      // ingest-time author slug never surfaces on the new citation fields.
      expect(hit.source.work?.title).toBeTruthy();
      expect(hit.source.figure?.displayName).toBeTruthy();
      expect(hit.source.work?.title).not.toBe('ingest-slug-should-not-surface');
      expect(hit.source.figure?.displayName).not.toBe('ingest-slug-should-not-surface');
    }
    const csg = resp.hits.find((h) => h.source.id === 's_csg')!;
    expect(csg.source.work?.title).toBe('Cheon Seong Gyeong');
    expect(csg.source.figure?.displayName).toBe('Sun Myung Moon');
  });

  it('scoping by a Work id restricts hits to Sources in that Work', async () => {
    const deps = await seedScopedCanon();
    const resp = await searchPrinciplesTool(
      { query: 'grace shines', works: ['work_csg'] },
      deps,
    );
    expect(resp.hits.map((h) => h.source.id)).toEqual(['s_csg']);
  });

  it('scoping by a Figure id expands to every Work under that Figure (including opted-in extras of that Figure)', async () => {
    const deps = await seedScopedCanon();
    const resp = await searchPrinciplesTool(
      { query: 'grace shines', figures: ['fig_hjh'] },
      deps,
    );
    const ids = new Set(resp.hits.map((h) => h.source.id));
    expect(ids).toEqual(new Set(['s_tm', 's_extra']));
  });

  it('scoping by `works` + `figures` unions the two (never intersects)', async () => {
    const deps = await seedScopedCanon();
    const resp = await searchPrinciplesTool(
      { query: 'grace shines', works: ['work_csg'], figures: ['fig_hjh'] },
      deps,
    );
    const ids = new Set(resp.hits.map((h) => h.source.id));
    expect(ids).toEqual(new Set(['s_csg', 's_tm', 's_extra']));
  });

  it('naming an `extra` Work opts it in (reachable only when named)', async () => {
    const deps = await seedScopedCanon();
    const resp = await searchPrinciplesTool(
      { query: 'grace shines', works: ['work_extra'] },
      deps,
    );
    expect(resp.hits.map((h) => h.source.id)).toEqual(['s_extra']);
  });

  it('includeExtras: true searches core + every extra in one shot (no ids named)', async () => {
    const deps = await seedScopedCanon();
    const resp = await searchPrinciplesTool(
      { query: 'grace shines', includeExtras: true },
      deps,
    );
    const ids = new Set(resp.hits.map((h) => h.source.id));
    expect(ids).toEqual(new Set(['s_csg', 's_tm', 's_extra']));
  });

  it('includeExtras unions extras on top of a named Work base (not the rest of core)', async () => {
    const deps = await seedScopedCanon();
    const resp = await searchPrinciplesTool(
      { query: 'grace shines', works: ['work_csg'], includeExtras: true },
      deps,
    );
    const ids = new Set(resp.hits.map((h) => h.source.id));
    expect(ids).toEqual(new Set(['s_csg', 's_extra']));
  });

  it('quoteCount reflects cross-source attestations (dedup-merged Quote counts too, #64)', async () => {
    // Two Sources voicing the same claim; the second's Quote is dedup-merged
    // onto the first Principle. The MCP hit response reports the total count.
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      undefined,
      undefined,
      () => ({ same: true, rationale: 'test — same claim' }),
    );
    const src1: Source = {
      ...sermon,
      id: 's1',
      title: 'First sermon',
      text: 'Grace precedes obedience.',
    };
    const src2: Source = {
      ...sermon,
      id: 's2',
      title: 'Second sermon',
      text: 'Grace precedes obedience.',
    };
    await ingestSource(src1, { provider, repository });
    await ingestSource(src2, { provider, repository });

    const resp = await searchPrinciplesTool({ query: 'grace' }, { provider, repository });
    expect(resp.hits.length).toBe(1);
    expect(resp.hits[0]!.quoteCount).toBe(2);
  });

  it('empty-but-valid scope (unknown ids) returns the same `{ hits: [] }` shape as a no-match', async () => {
    const deps = await seedScopedCanon();
    const resp = await searchPrinciplesTool(
      { query: 'grace shines', works: ['does-not-exist'] },
      deps,
    );
    expect(resp).toEqual({ hits: [] });
  });
});
