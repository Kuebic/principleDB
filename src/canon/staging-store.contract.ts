// Shared contract test for the `StagingStore` port. Every implementation
// (in-memory, Postgres, anything we add later) drives this same suite so they
// agree on `stage`/`read`/`listStaged`/`delete` semantics — the round-trip
// and idempotency guarantees Phase A/B of the two-phase seed lean on
// (issue #29, PRD #27, ADR-0014).
//
// Mirrors `bulk-progress-store.contract.ts` / `seen-text-store.contract.ts`:
// the caller passes a factory that returns a fresh store plus an optional
// teardown, the suite is run inside the caller's `describe()`.

import { expect, it } from 'vitest';
import type { StagingPayload, StagingStore } from './staging-store';
import type {
  DistilProvenance,
  LocatedQuote,
  Principle,
  ReviewCandidate,
} from './types';

export interface StagingStoreFactory {
  create: () => Promise<StagingStore> | StagingStore;
  // Optional reset between tests — Postgres impl truncates between tests so
  // assertions can use stable IDs without leaking state across the suite.
  reset?: () => Promise<void>;
}

const PROVENANCE_A: DistilProvenance = {
  distilModel: 'claude-opus-4-8',
  distilModelVersion: 'opus-4-8-2026-01',
  distilPromptVersion: 'v3',
};

const PROVENANCE_B: DistilProvenance = {
  distilModel: 'claude-haiku-4-5',
  distilModelVersion: 'haiku-4-5-2025-10',
  distilPromptVersion: 'v3',
};

function makeQuote(id: string, principleId: string, sourceId: string): LocatedQuote {
  return {
    id,
    principleId,
    sourceId,
    span: { start: 0, end: 10 },
    located: true,
    matchTier: 'exact',
    distilPromptVersion: 'v3',
  };
}

function makePrinciple(
  id: string,
  sourceId: string,
  claim: string,
  embedding: number[],
): Principle {
  return {
    id,
    claim,
    embedding,
    quotes: [makeQuote(`${id}#q`, id, sourceId)],
    distilModel: 'claude-opus-4-8',
    distilModelVersion: 'opus-4-8-2026-01',
    distilPromptVersion: 'v3',
  };
}

function makeReviewCandidate(id: string, sourceId: string): ReviewCandidate {
  return {
    id,
    sourceId,
    claim: `review claim for ${id}`,
    quoteText: 'quote text',
    matchTier: 'no-match',
    dedupState: 'pending',
  };
}

function makePayload(
  sourceId: string,
  provenance: DistilProvenance,
): StagingPayload {
  return {
    provenance,
    principles: [
      makePrinciple(`${sourceId}#p0`, sourceId, 'grace precedes obedience', [
        0.1, 0.2, 0.3,
      ]),
      makePrinciple(`${sourceId}#p1`, sourceId, 'humility is the ground of virtue', [
        0.4, 0.5, 0.6,
      ]),
    ],
    reviewCandidates: [makeReviewCandidate(`${sourceId}#r0`, sourceId)],
  };
}

export function runStagingStoreContract(factory: StagingStoreFactory): void {
  it('returns null for a (sourceId, provenance) that was never staged', async () => {
    await factory.reset?.();
    const store = await factory.create();
    expect(await store.read('never-staged', PROVENANCE_A)).toBeNull();
  });

  it('round-trips a staged payload losslessly', async () => {
    await factory.reset?.();
    const store = await factory.create();
    const payload = makePayload('src-1', PROVENANCE_A);
    await store.stage('src-1', PROVENANCE_A, payload);

    const read = await store.read('src-1', PROVENANCE_A);
    expect(read).not.toBeNull();
    expect(read!.provenance).toEqual(PROVENANCE_A);
    expect(read!.principles).toEqual(payload.principles);
    expect(read!.reviewCandidates).toEqual(payload.reviewCandidates);
  });

  it('preserves embeddings as ordered arrays of numbers (no lossy coercion)', async () => {
    await factory.reset?.();
    const store = await factory.create();
    const embedding = [0.123456789, -0.987654321, 1e-9, 0, 42];
    const payload: StagingPayload = {
      provenance: PROVENANCE_A,
      principles: [makePrinciple('src-2#p0', 'src-2', 'claim', embedding)],
      reviewCandidates: [],
    };
    await store.stage('src-2', PROVENANCE_A, payload);
    const read = await store.read('src-2', PROVENANCE_A);
    expect(read!.principles[0]!.embedding).toEqual(embedding);
  });

  it('re-staging the same (sourceId, provenance) replaces, not appends', async () => {
    await factory.reset?.();
    const store = await factory.create();
    const first = makePayload('src-3', PROVENANCE_A);
    await store.stage('src-3', PROVENANCE_A, first);

    const second: StagingPayload = {
      provenance: PROVENANCE_A,
      principles: [makePrinciple('src-3#p0', 'src-3', 'replaced claim', [1, 2, 3])],
      reviewCandidates: [],
    };
    await store.stage('src-3', PROVENANCE_A, second);

    const read = await store.read('src-3', PROVENANCE_A);
    expect(read!.principles).toHaveLength(1);
    expect(read!.principles[0]!.claim).toBe('replaced claim');
    expect(read!.reviewCandidates).toHaveLength(0);
  });

  it('staged rows are independent across sourceIds', async () => {
    await factory.reset?.();
    const store = await factory.create();
    await store.stage('src-a', PROVENANCE_A, makePayload('src-a', PROVENANCE_A));
    await store.stage('src-b', PROVENANCE_A, makePayload('src-b', PROVENANCE_A));

    expect((await store.read('src-a', PROVENANCE_A))!.principles[0]!.id).toBe('src-a#p0');
    expect((await store.read('src-b', PROVENANCE_A))!.principles[0]!.id).toBe('src-b#p0');
  });

  it('staged rows are independent across provenances for the same Source', async () => {
    // The same Source under two distinct provenance tuples occupies two
    // distinct staging slots — mirroring the ADR-0008 model-mixed Canon
    // guarantee at the staging layer.
    await factory.reset?.();
    const store = await factory.create();
    await store.stage('src-c', PROVENANCE_A, makePayload('src-c', PROVENANCE_A));
    await store.stage('src-c', PROVENANCE_B, makePayload('src-c', PROVENANCE_B));

    const a = await store.read('src-c', PROVENANCE_A);
    const b = await store.read('src-c', PROVENANCE_B);
    expect(a!.provenance).toEqual(PROVENANCE_A);
    expect(b!.provenance).toEqual(PROVENANCE_B);
  });

  it('listStaged returns every staged (sourceId, provenance)', async () => {
    await factory.reset?.();
    const store = await factory.create();
    await store.stage('src-x', PROVENANCE_A, makePayload('src-x', PROVENANCE_A));
    await store.stage('src-y', PROVENANCE_A, makePayload('src-y', PROVENANCE_A));
    await store.stage('src-x', PROVENANCE_B, makePayload('src-x', PROVENANCE_B));

    const listed = await store.listStaged();
    expect(listed).toHaveLength(3);
    const keys = listed.map((e) => `${e.sourceId}|${e.provenance.distilModel}`);
    expect(keys.sort()).toEqual(
      [
        'src-x|claude-opus-4-8',
        'src-y|claude-opus-4-8',
        'src-x|claude-haiku-4-5',
      ].sort(),
    );
  });

  it('legitimately-empty payloads round-trip (Phase A distinguishes empty from failure via mark, not row count)', async () => {
    // A zero-Principle doc is not a distil failure — the ADR marks it with
    // an empty payload so it is not retried. The store must accept and
    // return an empty payload cleanly.
    await factory.reset?.();
    const store = await factory.create();
    await store.stage('src-empty', PROVENANCE_A, {
      provenance: PROVENANCE_A,
      principles: [],
      reviewCandidates: [],
    });
    const read = await store.read('src-empty', PROVENANCE_A);
    expect(read).not.toBeNull();
    expect(read!.principles).toHaveLength(0);
    expect(read!.reviewCandidates).toHaveLength(0);
    expect((await store.listStaged()).map((e) => e.sourceId)).toContain('src-empty');
  });

  it('delete removes only the targeted (sourceId, provenance)', async () => {
    await factory.reset?.();
    const store = await factory.create();
    await store.stage('src-d', PROVENANCE_A, makePayload('src-d', PROVENANCE_A));
    await store.stage('src-d', PROVENANCE_B, makePayload('src-d', PROVENANCE_B));
    await store.stage('src-e', PROVENANCE_A, makePayload('src-e', PROVENANCE_A));

    await store.delete('src-d', PROVENANCE_A);

    expect(await store.read('src-d', PROVENANCE_A)).toBeNull();
    expect(await store.read('src-d', PROVENANCE_B)).not.toBeNull();
    expect(await store.read('src-e', PROVENANCE_A)).not.toBeNull();
  });

  it('deleting a never-staged (sourceId, provenance) is a no-op', async () => {
    await factory.reset?.();
    const store = await factory.create();
    await expect(store.delete('never-staged', PROVENANCE_A)).resolves.not.toThrow();
  });

  it('read isolation: mutating a returned payload does not leak into the store', async () => {
    // Phase B stamps decisions on Principles as it dedups — the store must
    // hand back a copy so a downstream mutation cannot silently rewrite the
    // staged row. (The Postgres impl gets this free via jsonb round-trip;
    // the in-memory impl clones explicitly to match.)
    await factory.reset?.();
    const store = await factory.create();
    await store.stage('src-iso', PROVENANCE_A, makePayload('src-iso', PROVENANCE_A));

    const first = await store.read('src-iso', PROVENANCE_A);
    first!.principles[0]!.claim = 'MUTATED';
    first!.principles[0]!.embedding[0] = 999;

    const second = await store.read('src-iso', PROVENANCE_A);
    expect(second!.principles[0]!.claim).not.toBe('MUTATED');
    expect(second!.principles[0]!.embedding[0]).not.toBe(999);
  });
}
