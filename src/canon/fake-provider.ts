// FakeIngestProvider — scripted distil + a real bag-of-words embedding so cosine
// search is meaningful in the golden test. Lets the whole ingest pipeline + MCP tool
// run end-to-end without an API key.

import { fnv1a32 } from './hash';
import type { DistilProvenance, DistilledItem } from './types';
import type { DistilInput, IngestProvider } from './ports';

const DEFAULT_PROVENANCE: DistilProvenance = {
  distilModel: 'fake-distiller',
  distilModelVersion: '1.0',
  distilPromptVersion: 'test-v1',
};

function bagOfWordsEmbedding(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const tok of tokens) {
    const h = fnv1a32(tok) % dim;
    vec[h] = vec[h]! + 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export class FakeIngestProvider implements IngestProvider {
  readonly provenance: DistilProvenance;
  private readonly script: (input: DistilInput) => DistilledItem[];
  private readonly dim: number;

  constructor(
    script: (input: DistilInput) => DistilledItem[],
    provenance: DistilProvenance = DEFAULT_PROVENANCE,
    dim = 128,
  ) {
    this.script = script;
    this.provenance = provenance;
    this.dim = dim;
  }

  async distil(input: DistilInput): Promise<DistilledItem[]> {
    return this.script(input);
  }

  async embed(claims: string[]): Promise<number[][]> {
    return claims.map((c) => bagOfWordsEmbedding(c, this.dim));
  }
}
