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

// Default dedup verdict: never merge. Tests that exercise dedup pass an
// explicit script.
const DEFAULT_SAME_CLAIM: (a: string, b: string) => SameClaimVerdict = () => ({
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

export class FakeIngestProvider implements IngestProvider {
  readonly provenance: DistilProvenance;
  private readonly script: (input: DistilInput) => DistilledItem[];
  private readonly dim: number;
  private readonly sameClaimScript: (a: string, b: string) => SameClaimVerdict;

  constructor(
    script: (input: DistilInput) => DistilledItem[],
    provenance: DistilProvenance = DEFAULT_PROVENANCE,
    dim = 128,
    sameClaimScript: (a: string, b: string) => SameClaimVerdict = DEFAULT_SAME_CLAIM,
  ) {
    this.script = script;
    this.provenance = provenance;
    this.dim = dim;
    this.sameClaimScript = sameClaimScript;
  }

  async distil(input: DistilInput): Promise<DistilledItem[]> {
    return this.script(input);
  }

  async embed(claims: string[]): Promise<number[][]> {
    return claims.map((c) => bagOfWordsEmbedding(c, this.dim));
  }

  async confirmSameClaim(a: string, b: string): Promise<SameClaimVerdict> {
    return this.sameClaimScript(a, b);
  }
}
