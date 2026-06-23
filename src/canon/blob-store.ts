// BlobStore port + an in-memory reference implementation (ADR-0005, ADR-0010).
//
// The query store keeps only the Canon distillate; the multi-GB archive of
// original Sources lives in Cloudflare R2 — accessed through this port so the
// shared core doesn't depend on the S3 client. InMemoryBlobStore backs the
// integration tests; a real R2BlobStore will land behind the same port without
// touching ingestPdfSource.

export interface BlobStore {
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

export class InMemoryBlobStore implements BlobStore {
  private readonly store = new Map<string, Uint8Array>();

  async put(key: string, body: Uint8Array): Promise<void> {
    this.store.set(key, body);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}
