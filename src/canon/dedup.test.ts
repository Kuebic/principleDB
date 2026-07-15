// Conservative dedup at ingest (issue #5, ADR-0006).
//
// A vector prefilter finds candidates near the new claim's embedding; an LLM
// "same claim?" confirm step decides per-pair. Near-identical → attach a new
// Quote to the existing Principle; ambiguous → keep separate (the live
// relatedness in slice 7 connects them). Each consultation records an
// inspectable rationale. No human gate.

import { describe, expect, it } from 'vitest';
import { dedup } from './dedup';
import { admit } from './admission';
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
  editionId: 'ed_seed',
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
  editionId: 'ed_seed',
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

  it('mints dedup_decision IDs from (principleIndex, candidateIndex) so re-ingest is byte-identical (#22, ADR-0008)', async () => {
    // Two claims in Source B both hit Source A's seeded Principle above the
    // prefilter threshold — one is confirmed `same` (merge), one is `kept-separate`.
    // Re-ingesting Source B under the same provenance must produce the exact
    // same decision rows: same IDs, same order, same verdicts. The IDs must be
    // derivable from (principleIdx, candidateIdx) alone — no shared counter.
    const repository = new InMemoryRepository();
    const seed = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
    );
    await ingestSource(sermonA, { provider: seed, repository });

    const verdictScript = (a: string, _b: string) =>
      a.startsWith('keep:')
        ? { same: false, rationale: 'distinct framing' as const }
        : { same: true, rationale: 'identical claim wording' as const };

    const mkProviderB = () =>
      new FakeIngestProvider(
        () => [
          { claim: 'keep: Grace and obedience are linked.', quote: 'Distinct framing about grace and obedience comes next.' },
          { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' },
        ],
        undefined,
        undefined,
        verdictScript,
      );

    await ingestSource(sermonB, { provider: mkProviderB(), repository });
    const first = [...repository.dedupDecisions()].filter((d) => d.sourceId === 'sermB');

    // IDs are derived purely from (principleIdx, candidateIdx) — no shared
    // mutable counter. The first principle's first (and only) candidate gets
    // d0_0 (`kept-separate`); the second principle's first candidate gets
    // d1_0 (`merged`).
    expect(first).toHaveLength(2);
    expect(first[0]!.id).toMatch(/#d0_0$/);
    expect(first[1]!.id).toMatch(/#d1_0$/);
    expect(first.map((d) => d.verdict)).toEqual(['kept-separate', 'merged']);

    // Re-ingest under the same provenance — slot is replaced, decisions rewritten.
    await ingestSource(sermonB, { provider: mkProviderB(), repository });
    const second = [...repository.dedupDecisions()].filter((d) => d.sourceId === 'sermB');

    expect(second).toHaveLength(first.length);
    expect(second.map((d) => d.id)).toEqual(first.map((d) => d.id));
    expect(second.map((d) => d.verdict)).toEqual(first.map((d) => d.verdict));
    expect(second.map((d) => d.rationale)).toEqual(first.map((d) => d.rationale));
  });

  it('parallel confirms across distinct Principles produce byte-identical output to the serial loop (#23, PRD AC: provably equivalent)', async () => {
    // Seed Source A with three distinct Principles. Source B then ingests four
    // Principles whose embeddings hit Source A's candidates above the prefilter
    // threshold with a fixed scripted verdict pattern that exercises both
    // verdicts. Running the same Source B through `dedup()` with concurrency=1
    // and concurrency=8 must produce byte-identical {freshPrinciples,
    // attachedQuotes, decisions}: same IDs, same order, same verdicts. Ordering
    // is keyed on principle index, not completion order — so parallel
    // scheduling never surfaces in the output.
    const seedSource: Source = {
      id: 'seedA',
      title: 'Grace and faith and love',
      author: 'Pastor X',
      kind: 'sermon',
      date: '2026-05-15',
      text: 'Grace precedes obedience. Faith without works is dead. Love your neighbor as yourself.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const testSource: Source = {
      id: 'testB',
      title: 'Source B repeats A',
      author: 'Pastor Y',
      kind: 'sermon',
      date: '2026-05-22',
      text: 'Grace precedes obedience. Faith without works is dead. Love your neighbor as yourself. Grace precedes obedience again here too.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const seedRepo = async () => {
      const repo = new InMemoryRepository();
      const seed = new FakeIngestProvider(() => [
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
        { claim: 'Faith without works is dead.', quote: 'Faith without works is dead.' },
        { claim: 'Love your neighbor as yourself.', quote: 'Love your neighbor as yourself.' },
      ]);
      await ingestSource(seedSource, { provider: seed, repository: repo });
      return repo;
    };

    const claimsB = [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Faith without works is dead keep.', quote: 'Faith without works is dead.' },
      { claim: 'Love your neighbor as yourself.', quote: 'Love your neighbor as yourself.' },
      { claim: 'Grace precedes obedience again.', quote: 'Grace precedes obedience again here too.' },
    ];
    const verdictScript = (a: string, _b: string) =>
      a.includes('keep') || a.includes('again')
        ? { same: false, rationale: 'distinct framing' as const }
        : { same: true, rationale: 'identical claim wording' as const };

    const runDedup = async (concurrency: number) => {
      const repo = await seedRepo();
      const provider = new FakeIngestProvider(() => claimsB, undefined, undefined, verdictScript);
      const items = await provider.distil({ title: testSource.title, text: testSource.text });
      const { principles } = admit(testSource, items, provider.provenance);
      const embeddings = await provider.embed(principles.map((p) => p.claim));
      principles.forEach((p, i) => (p.embedding = embeddings[i]!));
      return dedup(principles, testSource, provider.provenance, {
        provider,
        repository: repo,
        confirmConcurrency: concurrency,
      });
    };

    const serial = await runDedup(1);
    const parallel = await runDedup(8);

    expect(parallel).toEqual(serial);
    // Sanity: the fixture actually exercises both verdicts.
    const verdicts = serial.decisions.map((d) => d.verdict);
    expect(verdicts).toContain('merged');
    expect(verdicts).toContain('kept-separate');
  });

  it('retries confirmSameClaim with exponential backoff on HTTP 429 — the run completes (#23, PRD AC: backoff)', async () => {
    // The dedup loop must survive transient 429s without aborting. A confirm
    // call that throws once with `status: 429` and succeeds on retry should
    // produce the same merge outcome as if it had succeeded on the first call.
    const seedSource: Source = {
      id: 'backoffA',
      title: 'Grace first',
      author: 'Pastor X',
      kind: 'sermon',
      date: '2026-05-15',
      text: 'Grace precedes obedience.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const bSource: Source = {
      id: 'backoffB',
      title: 'Grace too',
      author: 'Pastor Y',
      kind: 'sermon',
      date: '2026-05-22',
      text: 'Grace precedes obedience here too.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const repository = new InMemoryRepository();
    const providerA = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
    );
    await ingestSource(seedSource, { provider: providerA, repository });

    let throws = 0;
    const flaky = (_a: string, _b: string) => {
      if (throws === 0) {
        throws++;
        const err: Error & { status?: number } = new Error('rate_limit_error');
        err.status = 429;
        throw err;
      }
      return { same: true, rationale: 'identical claim wording' as const };
    };

    const providerB = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' }],
      undefined,
      undefined,
      flaky,
    );
    const items = await providerB.distil({ title: bSource.title, text: bSource.text });
    const { principles } = admit(bSource, items, providerB.provenance);
    const embeddings = await providerB.embed(principles.map((p) => p.claim));
    principles.forEach((p, i) => (p.embedding = embeddings[i]!));
    const result = await dedup(principles, bSource, providerB.provenance, {
      provider: providerB,
      repository,
      confirmRetryInitialDelayMs: 1,
    });

    expect(throws).toBe(1);
    expect(result.freshPrinciples).toHaveLength(0);
    expect(result.attachedQuotes).toHaveLength(1);
    expect(result.decisions.map((d) => d.verdict)).toEqual(['merged']);
  });

  it('bounds live concurrency to the configured pool size (#23, PRD AC: pool cap)', async () => {
    // Seed many Source A Principles, then feed Source B many Principles that
    // each find a candidate. The fake confirm script tracks in-flight count;
    // we assert max-observed ≤ pool size while still allowing >1 concurrent
    // call to prove parallelism is real.
    const seedText = Array.from({ length: 6 }, (_, i) => `Grace precedes obedience number ${i}.`).join(' ');
    const seedSource: Source = {
      id: 'poolSeedA',
      title: 'Seed pool',
      author: 'Pastor X',
      kind: 'sermon',
      date: '2026-05-15',
      text: seedText,
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const bSource: Source = {
      id: 'poolB',
      title: 'B pool',
      author: 'Pastor Y',
      kind: 'sermon',
      date: '2026-05-22',
      text: seedText,
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const repository = new InMemoryRepository();
    const seedClaims = Array.from({ length: 6 }, (_, i) => ({
      claim: `Grace precedes obedience number ${i}.`,
      quote: `Grace precedes obedience number ${i}.`,
    }));
    const seed = new FakeIngestProvider(() => seedClaims);
    await ingestSource(seedSource, { provider: seed, repository });

    let inflight = 0;
    let maxInflight = 0;
    const slowVerdict = async (_a: string, _b: string) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight--;
      return { same: false, rationale: 'keep separate' as const };
    };

    const providerB = new FakeIngestProvider(() => seedClaims, undefined, undefined, slowVerdict);
    const items = await providerB.distil({ title: bSource.title, text: bSource.text });
    const { principles } = admit(bSource, items, providerB.provenance);
    const embeddings = await providerB.embed(principles.map((p) => p.claim));
    principles.forEach((p, i) => (p.embedding = embeddings[i]!));

    await dedup(principles, bSource, providerB.provenance, {
      provider: providerB,
      repository,
      confirmConcurrency: 3,
    });

    expect(maxInflight).toBeGreaterThan(1);
    expect(maxInflight).toBeLessThanOrEqual(3);
  });

  it('preserves the serial break-on-first-`same` short-circuit within a single Principle (#23, PRD AC)', async () => {
    // Two candidates above the prefilter; first verdict is `same` → merge, the
    // second candidate's confirm must NEVER be called. Parallelism is at the
    // outer (per-Principle) level, not within one Principle's candidate walk.
    const seedSourceA1: Source = {
      id: 'breakA1',
      title: 'Grace first',
      author: 'Pastor X',
      kind: 'sermon',
      date: '2026-05-15',
      text: 'Grace precedes obedience first.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const seedSourceA2: Source = {
      id: 'breakA2',
      title: 'Grace second',
      author: 'Pastor Y',
      kind: 'sermon',
      date: '2026-05-16',
      text: 'Grace precedes obedience second.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const bSource: Source = {
      id: 'breakB',
      title: 'Grace again',
      author: 'Pastor Z',
      kind: 'sermon',
      date: '2026-05-22',
      text: 'Grace precedes obedience again.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const repository = new InMemoryRepository();
    const seedA1 = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience first.', quote: 'Grace precedes obedience first.' }],
    );
    await ingestSource(seedSourceA1, { provider: seedA1, repository });
    const seedA2 = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience second.', quote: 'Grace precedes obedience second.' }],
    );
    await ingestSource(seedSourceA2, { provider: seedA2, repository });

    let calls = 0;
    const verdict = (_a: string, _b: string) => {
      calls++;
      return { same: true, rationale: 'identical' as const };
    };
    const providerB = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience again.', quote: 'Grace precedes obedience again.' }],
      undefined,
      undefined,
      verdict,
    );

    await ingestSource(bSource, { provider: providerB, repository });

    expect(calls).toBe(1);
  });

  it('stamps the provider-configured confirmModel on every dedup_decision row (#24, PRD #21)', async () => {
    // Two candidates above the prefilter threshold → one verdict each → two
    // dedup_decision rows. Every row must carry the provider's configured
    // confirm model, decoupled from the distil provenance tuple. The
    // confirm model is the model that produced the verdict; the audit trail
    // stays honest in a model-mixed Canon.
    const repository = new InMemoryRepository();
    const providerA = new FakeIngestProvider(
      () => [{ claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' }],
    );
    await ingestSource(sermonA, { provider: providerA, repository });

    const verdictScript = (a: string, _b: string) =>
      a.startsWith('keep:')
        ? { same: false, rationale: 'distinct framing' as const }
        : { same: true, rationale: 'identical claim wording' as const };
    const providerB = new FakeIngestProvider(
      () => [
        { claim: 'keep: Grace and obedience are linked.', quote: 'Distinct framing about grace and obedience comes next.' },
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience here too.' },
      ],
      undefined,
      undefined,
      verdictScript,
      'claude-haiku-4-5',
    );

    await ingestSource(sermonB, { provider: providerB, repository });
    const decisions = [...repository.dedupDecisions()].filter((d) => d.sourceId === 'sermB');

    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.confirmModel)).toEqual(['claude-haiku-4-5', 'claude-haiku-4-5']);
    // Decoupling: confirmModel must NOT appear inside the distil provenance
    // tuple — it changes the merge decision, not what was said.
    for (const d of decisions) {
      expect(d.distilModel).not.toBe(d.confirmModel);
    }
  });

  it('fetches candidates for the whole Source in ONE prefilter round-trip (#34, PRD #27)', async () => {
    // Phase B's real wall is DB latency, not the LLM (#33 spike): one vector
    // prefilter per Principle × ~13k Sources drains the pooler. The fix is a
    // batched fetch — dedup asks the repo for candidates across every
    // Principle in the Source in one call. Assert that: (a) the batched entry
    // point runs exactly once per Source; (b) the per-Principle entry point
    // is NOT called from dedup's hot path; (c) merge outcomes are unchanged.
    const repository = new InMemoryRepository();
    const seedSource: Source = {
      id: 'batchSeedA',
      title: 'Seed batch',
      author: 'Pastor X',
      kind: 'sermon',
      date: '2026-05-15',
      text: 'Grace precedes obedience. Faith without works is dead. Love your neighbor as yourself.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const seedProvider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Faith without works is dead.', quote: 'Faith without works is dead.' },
      { claim: 'Love your neighbor as yourself.', quote: 'Love your neighbor as yourself.' },
    ]);
    await ingestSource(seedSource, { provider: seedProvider, repository });

    let batchCalls = 0;
    let perPrincipleCalls = 0;
    const batchTracker: typeof repository = Object.create(repository);
    batchTracker.findSimilarPrinciplesForBatch = async (...args) => {
      batchCalls++;
      return repository.findSimilarPrinciplesForBatch(...args);
    };
    batchTracker.findSimilarPrinciplesExcludingSource = async (...args) => {
      perPrincipleCalls++;
      return repository.findSimilarPrinciplesExcludingSource(...args);
    };

    const bSource: Source = {
      id: 'batchB',
      title: 'B batch',
      author: 'Pastor Y',
      kind: 'sermon',
      date: '2026-05-22',
      text: 'Grace precedes obedience. Faith without works is dead. Love your neighbor as yourself.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    const providerB = new FakeIngestProvider(
      () => [
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
        { claim: 'Faith without works is dead.', quote: 'Faith without works is dead.' },
        { claim: 'Love your neighbor as yourself.', quote: 'Love your neighbor as yourself.' },
      ],
      undefined,
      undefined,
      () => ({ same: true, rationale: 'identical claim wording' }),
    );
    const items = await providerB.distil({ title: bSource.title, text: bSource.text });
    const { principles } = admit(bSource, items, providerB.provenance);
    const embeddings = await providerB.embed(principles.map((p) => p.claim));
    principles.forEach((p, i) => (p.embedding = embeddings[i]!));

    const result = await dedup(principles, bSource, providerB.provenance, {
      provider: providerB,
      repository: batchTracker,
    });

    expect(batchCalls).toBe(1);
    expect(perPrincipleCalls).toBe(0);
    // Sanity: the merge outcomes still match — the batched fetch changes
    // WHERE the candidates come from, not WHICH candidates dedup walks.
    expect(result.attachedQuotes).toHaveLength(3);
    expect(result.freshPrinciples).toHaveLength(0);
  });

  it('batched-prefilter output is byte-identical to the per-principle path (#34, PRD #27)', async () => {
    // The `findSimilarPrinciplesForBatch` contract: for embeddings[i], its
    // result must equal `findSimilarPrinciplesExcludingSource(embeddings[i], …)`
    // — same order, same score, same rows. This is the load-bearing property
    // that lets dedup swap in the batched call without changing merge
    // semantics (`dedup ≡ dedup` under either impl → the equivalence test
    // for #32 stays green).
    const repository = new InMemoryRepository();
    const seedProvider = new FakeIngestProvider(() => [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      { claim: 'Faith without works is dead.', quote: 'Faith without works is dead.' },
      { claim: 'Love your neighbor as yourself.', quote: 'Love your neighbor as yourself.' },
    ]);
    const seed: Source = {
      id: 'contractSeed',
      title: 'Contract seed',
      author: 'Pastor X',
      kind: 'sermon',
      date: '2026-05-15',
      text: 'Grace precedes obedience. Faith without works is dead. Love your neighbor as yourself.',
      r2Key: null,
      structureMap: { kind: 'none' },
      editionId: 'ed_seed',
    };
    await ingestSource(seed, { provider: seedProvider, repository });

    // Three query embeddings drawn from claims OTHER than the ones seeded, so
    // the prefilter returns non-trivial results per row. The distances differ
    // per query, exercising the "each query gets its own top-K in its own
    // order" contract.
    const queryProvider = new FakeIngestProvider(() => []);
    const queries = [
      'Grace precedes obedience.',
      'Faith without works is dead.',
      'Love your neighbor as yourself.',
    ];
    const embeddings = await queryProvider.embed(queries);
    const perQuery = await Promise.all(
      embeddings.map((e) =>
        repository.findSimilarPrinciplesExcludingSource(e, 'unrelated-source', 0.3, 3),
      ),
    );
    const batched = await repository.findSimilarPrinciplesForBatch(
      embeddings,
      'unrelated-source',
      0.3,
      3,
    );

    expect(batched).toEqual(perQuery);
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
