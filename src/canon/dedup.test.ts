// Conservative dedup at ingest (issue #5, ADR-0006).
//
// A vector prefilter finds candidates near the new claim's embedding; an LLM
// "same claim?" confirm step decides per-pair. Near-identical → attach a new
// Quote to the existing Principle; ambiguous → keep separate (the live
// relatedness in slice 7 connects them). Each consultation records an
// inspectable rationale. No human gate.

import { describe, expect, it } from 'vitest';
import { FakeIngestProvider } from './fake-provider';
import { ingestSource } from './ingest';
import { InMemoryRepository } from './in-memory-repository';
import { searchPrinciples } from './search';
import type { Source } from './types';

const sermonA: Source = {
  id: 'sermA',
  title: 'Grace first',
  author: 'Pastor X',
  kind: 'sermon',
  date: '2026-05-15',
  text: 'Grace precedes obedience. We are loved first.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

const sermonB: Source = {
  id: 'sermB',
  title: 'Grace before obedience',
  author: 'Pastor Y',
  kind: 'sermon',
  date: '2026-05-22',
  text: 'Grace precedes obedience here too. Distinct framing about grace and obedience comes next.',
  r2Key: null,
  structureMap: { kind: 'none' },
};

describe('conservative dedup at ingest', () => {
  it('attaches a Quote to the existing Principle when a near-identical claim arrives from another Source', async () => {
    const repository = new InMemoryRepository();

    // Seed Source A with the original claim.
    const providerA = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
    );
    await ingestSource(sermonA, { provider: providerA, repository });

    // Source B says the same thing nearly verbatim. The fake LLM confirms.
    const providerB = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' }],
      undefined,
      undefined,
      () => ({ same: true, rationale: 'identical claim wording' }),
    );
    const result = await ingestSource(sermonB, { provider: providerB, repository });

    expect(result).toEqual({ admitted: 0, merged: 1, review: 0 });

    // Canon holds ONE Principle now, with two Quotes (one from each Source).
    const hits = await searchPrinciples('grace and obedience', {
      provider: providerA,
      repository,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.principle.quotes).toHaveLength(2);
    const quoteSources = hits[0]!.principle.quotes.map((q) => q.sourceId).sort();
    expect(quoteSources).toEqual(['sermA', 'sermB']);
  });

  it('keeps an ambiguous-but-similar claim as a separate Principle (no over-merge)', async () => {
    const repository = new InMemoryRepository();

    const providerA = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
    );
    await ingestSource(sermonA, { provider: providerA, repository });

    // Similar enough to trip the vector prefilter — different enough that the
    // LLM should say "not the same".
    const providerB = new FakeIngestProvider(
      () => [
        {
          claim: 'Grace and obedience are linked.',
          quote: 'Distinct framing about grace and obedience comes next.',
        },
      ],
      undefined,
      undefined,
      () => ({ same: false, rationale: 'different framing — relation, not ordering' }),
    );
    const result = await ingestSource(sermonB, { provider: providerB, repository });

    expect(result).toEqual({ admitted: 1, merged: 0, review: 0 });

    const hits = await searchPrinciples('grace and obedience', {
      provider: providerA,
      repository,
      limit: 10,
    });
    expect(hits).toHaveLength(2);
  });

  it('records an inspectable rationale for each LLM-consulted dedup decision', async () => {
    const repository = new InMemoryRepository();

    const providerA = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
    );
    await ingestSource(sermonA, { provider: providerA, repository });

    const providerB = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' }],
      undefined,
      undefined,
      () => ({ same: true, rationale: 'identical claim wording' }),
    );
    await ingestSource(sermonB, { provider: providerB, repository });

    const decisions = repository.dedupDecisions();
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.sourceId).toBe('sermB');
    expect(d.verdict).toBe('merged');
    expect(d.rationale).toBe('identical claim wording');
    expect(d.existingPrincipleId).not.toBeNull();
    expect(d.similarityScore).toBeGreaterThan(0);
  });

  it('does NOT dedup within the same (sourceId, provenance) slot — re-ingest stays idempotent (ADR-0008)', async () => {
    const repository = new InMemoryRepository();

    // Two identical claims in one batch from the same source — confirmSameClaim
    // is wired to "same: true" but the dedup pass MUST skip self-source so the
    // batch is preserved as-distilled (intra-source dedup is out of scope).
    let consulted = 0;
    const provider = new FakeIngestProvider(
      () => [
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      ],
      undefined,
      undefined,
      () => {
        consulted++;
        return { same: true, rationale: 'identical' };
      },
    );
    const r1 = await ingestSource(sermonA, { provider, repository });
    expect(r1.admitted).toBe(2);
    expect(consulted).toBe(0);

    // Re-ingest under same provenance → idempotent, no merges into self.
    const r2 = await ingestSource(sermonA, { provider, repository });
    expect(r2.admitted).toBe(2);
    expect(consulted).toBe(0);
  });

  it('does not consult the LLM when nothing in the Canon is above the prefilter threshold', async () => {
    const repository = new InMemoryRepository();
    let consulted = 0;

    const provider = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      undefined,
      undefined,
      () => {
        consulted++;
        return { same: false, rationale: 'unused' };
      },
    );
    await ingestSource(sermonA, { provider, repository });
    expect(consulted).toBe(0);
  });
});
