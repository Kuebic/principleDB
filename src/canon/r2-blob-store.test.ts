import { describe, expect, it } from 'vitest';

import { createR2BlobStoreFromEnv, R2BlobStore } from './r2-blob-store';

const cfg = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'canon',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secretExampleKey',
};

describe('R2BlobStore', () => {
  it('PUTs a signed request to the path-style bucket URL carrying the body', async () => {
    let captured: Request | undefined;
    const store = new R2BlobStore({
      ...cfg,
      fetch: (async (input: Parameters<typeof fetch>[0]) => {
        captured = input as Request;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    const body = new TextEncoder().encode('%PDF-1.4 hi');
    await store.put('sources/src1.pdf', body);

    expect(captured).toBeDefined();
    expect(captured!.method).toBe('PUT');
    expect(captured!.url).toBe(
      'https://acct.r2.cloudflarestorage.com/canon/sources/src1.pdf',
    );
    // The request was actually signed — an SigV4 Authorization header is present.
    expect(captured!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256/);
    const sent = new Uint8Array(await captured!.arrayBuffer());
    expect(sent).toEqual(body);
  });

  it('throws on a non-2xx put response', async () => {
    const store = new R2BlobStore({
      ...cfg,
      fetch: (async () =>
        new Response('denied', { status: 403, statusText: 'Forbidden' })) as typeof fetch,
    });
    await expect(store.put('k', new Uint8Array([1]))).rejects.toThrow(/R2 put k failed: 403/);
  });

  it('GET returns null on 404 and bytes on 200', async () => {
    const missing = new R2BlobStore({
      ...cfg,
      fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
    });
    expect(await missing.get('nope')).toBeNull();

    const bytes = new Uint8Array([1, 2, 3]);
    const present = new R2BlobStore({
      ...cfg,
      fetch: (async () => new Response(bytes, { status: 200 })) as typeof fetch,
    });
    expect(await present.get('sources/src1.pdf')).toEqual(bytes);
  });
});

describe('createR2BlobStoreFromEnv', () => {
  it('returns null when the R2 config is incomplete', () => {
    expect(createR2BlobStoreFromEnv({})).toBeNull();
    expect(
      createR2BlobStoreFromEnv({ R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'a' }),
    ).toBeNull();
  });

  it('derives the endpoint from the account id when R2_ENDPOINT is absent', () => {
    const store = createR2BlobStoreFromEnv({
      R2_ACCOUNT_ID: 'acct',
      R2_BUCKET: 'canon',
      R2_ACCESS_KEY_ID: 'a',
      R2_SECRET_ACCESS_KEY: 's',
    });
    expect(store).toBeInstanceOf(R2BlobStore);
  });
});
