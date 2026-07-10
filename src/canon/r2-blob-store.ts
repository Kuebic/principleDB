// R2BlobStore — the production BlobStore (ADR-0005, ADR-0010).
//
// The query store keeps only the Canon distillate; the multi-GB archive of
// original Sources (PDFs) lives in Cloudflare R2, reached through the BlobStore
// port so the shared core never imports an S3 client. R2 speaks the S3 API, so
// requests are signed with aws4fetch (SigV4) and sent over plain fetch:
// path-style URLs (`<endpoint>/<bucket>/<key>`), region "auto", service "s3".
//
// `fetch` is injected so the request shape is unit-testable without network;
// production defaults to the global fetch. Signing itself is delegated to
// aws4fetch (a ~single-file, dependency-free SigV4 implementation) rather than
// hand-rolled here.

import { AwsClient } from 'aws4fetch';

import type { BlobStore } from './blob-store';

export interface R2BlobStoreConfig {
  // Bucket endpoint, e.g. https://<account>.r2.cloudflarestorage.com
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Injected for tests; defaults to the global fetch.
  fetch?: typeof fetch;
}

export class R2BlobStore implements BlobStore {
  private readonly client: AwsClient;
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: R2BlobStoreConfig) {
    this.client = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: 's3',
      region: 'auto',
    });
    // Trim any trailing slash off the endpoint so the join is unambiguous.
    this.base = `${cfg.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(cfg.bucket)}`;
    this.doFetch = cfg.fetch ?? fetch;
  }

  // Encode each path segment but keep the slashes that structure the key, so a
  // key like `sources/src1.pdf` maps to `.../sources/src1.pdf`.
  private url(key: string): string {
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${this.base}/${encoded}`;
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const signed = await this.client.sign(this.url(key), {
      method: 'PUT',
      body,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const res = await this.doFetch(signed);
    if (!res.ok) {
      throw new Error(`R2 put ${key} failed: ${res.status} ${res.statusText}`);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const signed = await this.client.sign(this.url(key), { method: 'GET' });
    const res = await this.doFetch(signed);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`R2 get ${key} failed: ${res.status} ${res.statusText}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

export interface R2Env {
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_ENDPOINT?: string;
}

// Build an R2BlobStore from the standard env vars, or return null when the R2
// config is incomplete — the caller decides whether that is a hard error
// (`--archive`, the default) or a fall-back to a no-archive store
// (`--no-archive`). The endpoint is taken from R2_ENDPOINT, or derived from the
// account id when only that is set.
export function createR2BlobStoreFromEnv(env: R2Env): R2BlobStore | null {
  const endpoint =
    env.R2_ENDPOINT ??
    (env.R2_ACCOUNT_ID
      ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined);
  if (!endpoint || !env.R2_BUCKET || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return null;
  }
  return new R2BlobStore({
    endpoint,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  });
}
