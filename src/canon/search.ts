// searchPrinciples — the retrieval seam the MCP `search_principles` tool wraps.
// Embed the query through the same provider that distilled the Canon, then ask the
// repository for the top-K by cosine.
//
// `scope` (ADR-0017) resolves — via the shared `resolveScope` helper — to the
// concrete Source-id set the repository pre-filters on. Omitted scope ⇒ all
// `core` Works, so the unscoped call path picks up the core default without any
// existing caller change. An empty resolved set (e.g. all named ids unknown)
// short-circuits to `[]` here so we don't spend an embed round-trip on a query
// that can't match anything.

import type { CanonRepository, IngestProvider, SearchHit } from './ports';
import { resolveScope, type Scope } from './scope';

export interface SearchDeps {
  provider: IngestProvider;
  repository: CanonRepository;
  limit?: number;
  scope?: Scope;
}

export async function searchPrinciples(query: string, deps: SearchDeps): Promise<SearchHit[]> {
  const limit = deps.limit ?? 5;
  const scopedSourceIds = await resolveScopedSourceIds(deps.scope, deps.repository);
  // An explicit scope that resolves to nothing (unknown ids only) short-circuits
  // to [] — no point spending an embed round-trip on a query that can't match.
  if (scopedSourceIds !== undefined && scopedSourceIds.length === 0) return [];
  const [embedding] = await deps.provider.embed([query]);
  if (!embedding) return [];
  return deps.repository.searchByEmbedding(embedding, limit, scopedSourceIds);
}

// Turns a Scope into the concrete Source-id pre-filter, or `undefined` to mean
// "no pre-filter" (search everything the repo has). Semantics:
//   - Explicit `works`/`figures` given ⇒ resolve them; unknown ids fall through
//     as an empty set (which the caller treats as "no matches").
//   - Scope omitted AND the repo has Works ⇒ default to all `core` Works
//     (ADR-0017, dynamic default).
//   - Scope omitted AND the repo has NO Works ⇒ `undefined` — the pre-backfill
//     / test fixture case where no Sources have been assigned a Work yet; the
//     unscoped call path must not vanish here.
async function resolveScopedSourceIds(
  scope: Scope | undefined,
  repository: CanonRepository,
): Promise<string[] | undefined> {
  const explicit = (scope?.works?.length ?? 0) > 0 || (scope?.figures?.length ?? 0) > 0;
  if (explicit) {
    const resolved = await resolveScope(scope!, repository);
    return resolved.sourceIds;
  }
  const listings = await repository.listWorks();
  if (listings.length === 0) return undefined;
  const resolved = await resolveScope({}, repository);
  return resolved.sourceIds;
}
