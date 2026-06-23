// L2-normalize a vector so cosine similarity degrades to a dot product. Used
// by the OpenAI embedder (real vectors from the API) and the fake provider's
// bag-of-words embedding so the pgvector `<=>` operator and the in-memory
// cosine path see consistent unit-magnitude input.
//
// A zero vector is returned unchanged — there is no defined unit direction.

export function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
