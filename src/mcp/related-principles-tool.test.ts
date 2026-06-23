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
