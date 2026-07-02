// FakeIngestProvider — scripted distil + a real bag-of-words embedding so cosine
// search is meaningful in the golden test. Lets the whole ingest pipeline + MCP tool
// run end-to-end without an API key.

import { fnv1a32 } from './hash';
import { l2Normalize } from './vector';
import type { DistilProvenance, DistilledItem } from './types';
import type { DistilInput, IngestProvider, SameClaimVerdict } from './ports';

const DEFAULT_PROVENANCE: DistilProvenance = {
  distilModel: 'fake-distiller',
  distilModelVersion: '1.0',
  distilPromptVersion: 'test-v1',
};

// Scripted verdict — sync or async. Async support lets dedup tests simulate
// latency (for concurrency-cap assertions) and throw simulated HTTP 429s
// without leaking a Promise dependency into call sites that just return a
// literal verdict.
export type SameClaimScript = (
  a: string,
  b: string,
) => SameClaimVerdict | Promise<SameClaimVerdict>;

// Default dedup verdict: never merge. Tests that exercise dedup pass an
// explicit script.
const DEFAULT_SAME_CLAIM: SameClaimScript = () => ({
  same: false,
  rationale: 'fake provider default — keep separate',
});

function bagOfWordsEmbedding(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    const h = fnv1a32(tok) % dim;
    vec[h] = vec[h]! + 1;
  }
  return l2Normalize(vec);
}

// Distil script — sync or async. Async support lets Phase A concurrency tests
// model per-Source latency (measure how many stage() calls run in parallel)
// without a bespoke IngestProvider implementation.
export type DistilScript = (
  input: DistilInput,
) => DistilledItem[] | Promise<DistilledItem[]>;

export class FakeIngestProvider implements IngestProvider {
  readonly provenance: DistilProvenance;
  readonly confirmModel: string;
  private readonly script: DistilScript;
  private readonly dim: number;
  private readonly sameClaimScript: SameClaimScript;

  constructor(
    script: DistilScript,
    provenance: DistilProvenance = DEFAULT_PROVENANCE,
    dim = 128,
    sameClaimScript: SameClaimScript = DEFAULT_SAME_CLAIM,
    confirmModel = 'fake-confirm-model',
  ) {
    this.script = script;
    this.provenance = provenance;
    this.dim = dim;
    this.sameClaimScript = sameClaimScript;
    this.confirmModel = confirmModel;
  }

  async distil(input: DistilInput): Promise<DistilledItem[]> {
    return this.script(input);
  }

  async embed(claims: string[]): Promise<number[][]> {
    return claims.map((c) => bagOfWordsEmbedding(c, this.dim));
  }

  async confirmSameClaim(a: string, b: string): Promise<SameClaimVerdict> {
    return await this.sameClaimScript(a, b);
  }
}
