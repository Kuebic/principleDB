// Scope resolution for source-filtering (ADR-0017). A shared helper so both
// surfaces — the web search page (URL query params) and the public MCP
// `search_principles` tool — resolve `{works?, figures?}` into the same
// concrete Source-id set before handing it to the retrieval seam.
//
// Semantics (ADR-0017):
//   - Omitted / empty scope ⇒ all `core` Works — dynamic, so a shared link
//     that named nothing keeps meaning "core" after a future core Work joins.
//   - `figures` expand to their Works, `works` are added as-is; both union'd,
//     include-only (no exclude list).
//   - Naming an `extra` Work opts it in; unscoped searches never include
//     extras.
//   - Unknown ids are ignored (defensive — a stale URL/param never crashes
//     the search).

import type { CanonRepository, WorkWithFigure } from './ports';

export interface Scope {
  works?: readonly string[];
  figures?: readonly string[];
}

export interface ResolvedScope {
  workIds: string[];
  sourceIds: string[];
}

export async function resolveScope(
  scope: Scope,
  repository: CanonRepository,
): Promise<ResolvedScope> {
  const listings = await repository.listWorks();
  const workIds = pickWorkIds(scope, listings);
  const sourceIds = await repository.listSourceIdsInWorks(workIds);
  return { workIds, sourceIds };
}

function pickWorkIds(scope: Scope, listings: WorkWithFigure[]): string[] {
  const works = scope.works ?? [];
  const figures = scope.figures ?? [];
  if (works.length === 0 && figures.length === 0) {
    return listings.filter((l) => l.work.tier === 'core').map((l) => l.work.id);
  }
  const chosen = new Set<string>();
  const validWorkIds = new Set(listings.map((l) => l.work.id));
  for (const id of works) {
    if (validWorkIds.has(id)) chosen.add(id);
  }
  if (figures.length > 0) {
    const figureIds = new Set(figures);
    for (const l of listings) {
      if (figureIds.has(l.figure.id) || figureIds.has(l.figure.slug)) {
        chosen.add(l.work.id);
      }
    }
  }
  return [...chosen];
}
