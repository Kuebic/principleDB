// dedupStagedSource — Phase B per-Source entry point (issue #31, PRD #27,
// ADR-0014).
//
// Complement to stageSource: read a staged payload, run `dedup()` against the
// Canon-so-far, then persist. Provenance is taken from the payload (ADR-0014
// "Provenance-in-payload"), NOT from the Phase-B provider's config — so a
// differently-configured Phase-B provider cannot mint mismatched ID slots.
//
// Tests here drive dedupStagedSource directly through the fakes; the
// serial-across driver + plan-walk-order wiring lives in bulk-drain.test.ts
// and ingest-dir.test.ts.

import { describe, expect, it } from 'vitest';

import { dedupStagedSource, stageSource } from './ingest';
import { FakeIngestProvider } from './fake-provider';
import { InMemoryRepository } from './in-memory-repository';
import { InMemoryStagingStore } from './staging-store';
import { searchPrinciples } from './search';
import type { DistilProvenance, Source } from './types';

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

describe('dedupStagedSource', () => {
  it('draining a fresh staged Source produces the same Canon as the single-phase pipeline', async () => {
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);

    // Phase A: stage.
    await stageSource(sermonA, { provider, repository, staging });
    // Phase B: read payload → drain.
    const payload = await staging.read(sermonA.id, provider.provenance);
    const result = await dedupStagedSource(sermonA.id, payload!, { provider, repository });

    expect(result).toEqual({ admitted: 1, merged: 0, review: 0 });

    const hits = await searchPrinciples('grace and obedience', {
      provider,
      repository,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.principle.claim).toBe('Grace precedes obedience.');
  });

  it('draining serially reproduces the cross-Source merge (near-identical claims attach)', async () => {
    // Phase A stages both Sources; Phase B drains them in order A then B; the
    // near-identical claim in B attaches to A's Principle.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const providerA = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    const providerB = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' }],
      undefined,
      undefined,
      () => ({ same: true, rationale: 'identical claim wording' }),
    );

    await stageSource(sermonA, { provider: providerA, repository, staging });
    await stageSource(sermonB, { provider: providerB, repository, staging });

    const payloadA = await staging.read(sermonA.id, providerA.provenance);
    await dedupStagedSource(sermonA.id, payloadA!, { provider: providerA, repository });

    const payloadB = await staging.read(sermonB.id, providerB.provenance);
    const resultB = await dedupStagedSource(sermonB.id, payloadB!, { provider: providerB, repository });

    expect(resultB).toEqual({ admitted: 0, merged: 1, review: 0 });

    const hits = await searchPrinciples('grace and obedience', {
      provider: providerA,
      repository,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    const quoteSources = hits[0]!.principle.quotes.map((q) => q.sourceId).sort();
    expect(quoteSources).toEqual(['sermA', 'sermB']);
  });

  it('provenance in the persisted rows comes from the payload, not the Phase-B provider', async () => {
    // ADR-0014's "Provenance-in-payload" guardrail: Phase B's provider might be
    // configured differently from Phase A (e.g. re-run under a different model
    // pin) — the persisted Principle IDs and provenance columns must still
    // match Phase A. Otherwise a Phase-B run under a mismatched config would
    // silently mint a different (sourceId, provenance) ID slot.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const phaseAProvider = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
      { distilModel: 'claude-haiku-4-5', distilModelVersion: '2026-06-19', distilPromptVersion: 'v3' },
    );
    await stageSource(sermonA, { provider: phaseAProvider, repository, staging });

    // Phase B uses a DIFFERENT provider config. dedupStagedSource must use the
    // provenance from the staged payload — its principle IDs (which are
    // derived from `provenanceTag(payload.provenance)`) must match Phase A.
    const phaseBProvider = new FakeIngestProvider(
      () => [],
      { distilModel: 'claude-opus-4-8', distilModelVersion: 'different', distilPromptVersion: 'other' },
    );
    const payload = await staging.read(sermonA.id, phaseAProvider.provenance);
    await dedupStagedSource(sermonA.id, payload!, { provider: phaseBProvider, repository });

    const hits = await searchPrinciples('grace', {
      provider: phaseAProvider,
      repository,
      limit: 10,
    });
    expect(hits).toHaveLength(1);
    // The persisted Principle's provenance is Phase A's, not Phase B's.
    expect(hits[0]!.principle.distilModel).toBe('claude-haiku-4-5');
    expect(hits[0]!.principle.distilPromptVersion).toBe('v3');
  });

  it('a staged zero-Principle payload persists nothing without failing', async () => {
    // Legitimately-empty Sources (marked in Phase A) drain to a no-op in
    // Phase B: no Principles added, no review candidates, no decisions.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => []);

    await stageSource(sermonA, { provider, repository, staging });
    const payload = await staging.read(sermonA.id, provider.provenance);
    const result = await dedupStagedSource(sermonA.id, payload!, { provider, repository });

    expect(result).toEqual({ admitted: 0, merged: 0, review: 0 });
    const hits = await searchPrinciples('grace', { provider, repository, limit: 10 });
    expect(hits).toHaveLength(0);
  });

  it('re-draining the same Source is idempotent (replacePrinciplesForSource semantics survive Phase B)', async () => {
    // Phase B's per-Source safety net: `replacePrinciplesForSource` wipes the
    // slot before writing, so a mid-Phase-B crash between persist and mark
    // (see ADR-0014) is safe to resume — re-draining does not double-write.
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    const provider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);

    await stageSource(sermonA, { provider, repository, staging });
    const payload = await staging.read(sermonA.id, provider.provenance);

    await dedupStagedSource(sermonA.id, payload!, { provider, repository });
    await dedupStagedSource(sermonA.id, payload!, { provider, repository });
    await dedupStagedSource(sermonA.id, payload!, { provider, repository });

    const hits = await searchPrinciples('grace', { provider, repository, limit: 10 });
    expect(hits).toHaveLength(1);
  });

  it('confirmConcurrency knob is forwarded to dedup', async () => {
    // Phase B carries the within-Source confirm pool from ADR-0013 through
    // unchanged. The knob has to be surfaced through dedupStagedSource so the
    // Phase B driver can raise it (the #25 spike wanted room > 32).
    const repository = new InMemoryRepository();
    const staging = new InMemoryStagingStore();
    // Seed A: 3 fresh Principles.
    const providerA = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
    ]);
    await stageSource(sermonA, { provider: providerA, repository, staging });
    const payloadA = await staging.read(sermonA.id, providerA.provenance);
    await dedupStagedSource(sermonA.id, payloadA!, { provider: providerA, repository });

    // B: same claim → attaches. Track high-water mark of in-flight confirms.
    let inFlight = 0;
    let peak = 0;
    const providerB = new FakeIngestProvider(
      () => [
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' },
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' },
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' },
      ],
      undefined,
      undefined,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { same: true, rationale: 'match' };
      },
    );
    await stageSource(sermonB, { provider: providerB, repository, staging });
    const payloadB = await staging.read(sermonB.id, providerB.provenance);

    await dedupStagedSource(sermonB.id, payloadB!, {
      provider: providerB,
      repository,
    }, { confirmConcurrency: 3 });

    // With 3 principles each running one confirm, the pool should peak at 3
    // (not 1, which is what confirmConcurrency=1 would enforce).
    expect(peak).toBe(3);
  });

  it('throws a readable error when the Source was never upserted (Phase A must run first)', async () => {
    // dedup() needs the Source object for its ID; Phase A upserts it before
    // staging. If Phase B is called with a sourceId whose Source is missing,
    // fail loudly rather than silently no-op.
    const repository = new InMemoryRepository();
    const provider = new FakeIngestProvider(() => []);
    const prov: DistilProvenance = provider.provenance;
    await expect(
      dedupStagedSource(
        'nonexistent',
        { provenance: prov, principles: [], reviewCandidates: [] },
        { provider, repository },
      ),
    ).rejects.toThrow(/nonexistent/);
  });
});
