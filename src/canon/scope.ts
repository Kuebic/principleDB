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
//   - `includeExtras` is a one-shot toggle that unions ALL `extra` Works on
//     top of whatever base the works/figures select — so `{}` stays core, but
//     `{ includeExtras: true }` means "core + every extra" (the whole Canon)
//     without having to enumerate each extra id.
//   - Unknown ids are ignored (defensive — a stale URL/param never crashes
//     the search).

import type { CanonRepository, WorkWithFigure } from './ports';

export interface Scope {
  works?: readonly string[];
  figures?: readonly string[];
  // One-shot "include every extra Work" toggle (ADR-0017). Union'd on top of
  // the works/figures base: omitted/false ⇒ extras stay opt-in per-id; true ⇒
  // all extras join the result set.
  includeExtras?: boolean;
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
  const workIds = [...pickWorkIds(scope, listings)];
  const sourceIds = await repository.listSourceIdsInWorks(workIds);
  return { workIds, sourceIds };
}

// Resolves a Scope to the concrete set of Work ids it selects. Shared by the
// server-side resolver (which feeds it into `listSourceIdsInWorks`) and the
// web picker (which uses it to decide which checkboxes start checked). Unknown
// ids are dropped — a stale URL never crashes a page or the search.
export function pickWorkIds(
  scope: Scope,
  listings: readonly WorkWithFigure[],
): Set<string> {
  const works = scope.works ?? [];
  const figures = scope.figures ?? [];
  const includeExtras = scope.includeExtras ?? false;

  const chosen = new Set<string>();
  if (works.length === 0 && figures.length === 0) {
    // Default base: all core Works (dynamic — a new core Work joins for free).
    for (const l of listings) {
      if (l.work.tier === 'core') chosen.add(l.work.id);
    }
  } else {
    // Named base: only the named Works/Figures — no implicit core.
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
  }
  // One-shot opt-in: union every `extra` Work on top of the base above.
  if (includeExtras) {
    for (const l of listings) {
      if (l.work.tier === 'extra') chosen.add(l.work.id);
    }
  }
  return chosen;
}
