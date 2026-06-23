import { describe, expect, it } from 'vitest';
import { InMemoryBlobStore } from './blob-store';

describe('InMemoryBlobStore', () => {
  it('round-trips a put then a get', async () => {
    const blobs = new InMemoryBlobStore();
    const body = new Uint8Array([1, 2, 3]);
    await blobs.put('sources/x.pdf', body);
    const got = await blobs.get('sources/x.pdf');
    expect(got).not.toBeNull();
    expect(Array.from(got!)).toEqual([1, 2, 3]);
  });

  it('reports has() for stored keys and false otherwise', async () => {
    const blobs = new InMemoryBlobStore();
    await blobs.put('sources/x.pdf', new Uint8Array());
    expect(blobs.has('sources/x.pdf')).toBe(true);
    expect(blobs.has('sources/missing.pdf')).toBe(false);
  });

  it('get() returns null for an unknown key', async () => {
    const blobs = new InMemoryBlobStore();
    expect(await blobs.get('missing')).toBeNull();
  });
});
