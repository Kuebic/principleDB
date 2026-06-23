// FNV-1a 32-bit string hash. Deterministic and dependency-free — used to bucket
// embedding tokens (fake-provider) and to tag provenance into deterministic IDs
// (admission). Returned as an unsigned 32-bit integer so callers can format it
// however they need (modulo, hex, etc.).

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
