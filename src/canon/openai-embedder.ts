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

  return async (claims: string[]): Promise<number[][]> => {
    if (claims.length === 0) return [];
    const res = await fetchImpl(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: claims, dimensions: dim }),
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
    // and vectors silently.
    const ordered = [...data.data].sort((a, b) => a.index - b.index);
    return ordered.map((d) => l2Normalize(d.embedding));
  };
}
