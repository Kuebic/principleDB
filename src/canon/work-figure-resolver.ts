// Cached Source → Edition → Work + Figure resolver (ADR-0018 slice #61). Both
// the citation-rendering path (`toSearchHitResponses`) and the multi-quote
// paging path (`GET /api/quotes`) hydrate many hits against a small,
// mostly-static Editions + Works pair — one round-trip each, indexed by
// primary key, then O(1) per hit. Hits whose Source has no Edition (test
// fixtures) or whose Edition points at a Work outside the loaded set
// resolve to `null`; callers render the citation without Work/Figure
// attribution rather than dropping the hit.
//
// Post-#62 (PRD #58) `resolve()` also carries the resolved `edition` so the
// citation can name its recension (e.g. "CSG — 2013 Revised") — the reader
// never mistakes a contested Edition for neutral scripture.

import type { CanonRepository, WorkWithFigure } from './ports';
import type { Edition, Source } from './types';

export interface ResolvedCitation extends WorkWithFigure {
  edition: Edition;
}

export interface WorkFigureResolver {
  resolve(source: Pick<Source, 'editionId'>): ResolvedCitation | null;
}

export async function buildWorkFigureResolver(
  repository: CanonRepository,
): Promise<WorkFigureResolver> {
  const [listings, editions] = await Promise.all([
    repository.listWorks(),
    repository.listEditions(),
  ]);
  const worksByWorkId = new Map(listings.map((l) => [l.work.id, l] as const));
  const editionsById = new Map(editions.map((e) => [e.id, e] as const));
  return {
    resolve(source) {
      const edition = source.editionId ? editionsById.get(source.editionId) : undefined;
      if (!edition) return null;
      const wf = worksByWorkId.get(edition.workId);
      if (!wf) return null;
      return { work: wf.work, figure: wf.figure, edition };
    },
  };
}
