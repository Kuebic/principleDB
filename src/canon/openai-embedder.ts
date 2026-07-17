// OpenAI embeddings adapter. Anthropic doesn't ship an embeddings endpoint
// (ADR-0011), so the embed half of IngestProvider goes through OpenAI's
// /v1/embeddings — small enough to call directly with fetch rather than pull
// in the SDK.
//
// Defaults match the spike-validated and schema-pinned setup:
//   model = 'text-embedding-3-small'
//   dim   = 1536 (EMBEDDING_DIM in src/db/schema.ts)
// Returned vectors are L2-normalized so cosine search degrades to dot product
// — pgvector's <=> operator and the in-memory cosine path both rely on that.

import { l2Normalize } from './vector';

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIM = 1536;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// OpenAI's /embeddings endpoint rejects an input array longer than 2048 with a
// 400 (`array length must be 2048 or less`). A dense book distils to more
// principles than that (WayOfTradition vols 3-4 each blew past it), so embed in
// chunks of at most this many claims and concatenate in request order — the
// caller relies on vectors[i] pairing with claims[i].
const MAX_INPUTS_PER_REQUEST = 2048;

export interface OpenAIEmbedderOptions {
  apiKey?: string;
  model?: string;
  dim?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export type EmbedFn = (claims: string[]) => Promise<number[][]>;

export function createOpenAIEmbedder(opts: OpenAIEmbedderOptions = {}): EmbedFn {
  const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenAI embedder needs an API key. Pass {apiKey} or set OPENAI_API_KEY.',
    );
  }
  const model = opts.model ?? DEFAULT_MODEL;
  const dim = opts.dim ?? DEFAULT_DIM;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const embedBatch = async (batch: string[]): Promise<number[][]> => {
    const res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: batch, dimensions: dim }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `OpenAI /embeddings → ${res.status}: ${body.slice(0, 500)}`,
      );
    }
    const data = (await res.json()) as {
      data: ReadonlyArray<{ embedding: number[]; index: number }>;
    };
    // The OpenAI spec doesn't guarantee response order, but in practice indices
    // are returned in request order. Re-sort by index so we never desync claims
    // and vectors silently. `index` is relative to this batch's input array.
    const ordered = [...data.data].sort((a, b) => a.index - b.index);
    return ordered.map((d) => l2Normalize(d.embedding));
  };

  return async (claims: string[]): Promise<number[][]> => {
    if (claims.length === 0) return [];
    // Single request on the common path; only a >2048-claim source pays the
    // extra round-trips. Batches run in order and are concatenated, so the
    // returned vectors stay aligned with `claims`.
    if (claims.length <= MAX_INPUTS_PER_REQUEST) return embedBatch(claims);
    const out: number[][] = [];
    for (let i = 0; i < claims.length; i += MAX_INPUTS_PER_REQUEST) {
      const batch = await embedBatch(claims.slice(i, i + MAX_INPUTS_PER_REQUEST));
      for (const vec of batch) out.push(vec);
    }
    return out;
  };
}
