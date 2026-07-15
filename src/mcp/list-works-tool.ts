// list_works — the public MCP discovery tool (issue #55, ADR-0017).
//
// Lets an AI client see what Works exist so it can translate a member's
// "only look through Hak Ja Han" into a concrete `figures` / `works` scope
// for `search_principles`. Works are grouped by Figure and each carries the
// core/extra tier — the AI can then explain to the member which Works are
// searched by default and which are opt-in.
//
// Empty case is the well-shaped `{ figures: [] }` so the AI client doesn't
// have to special-case an empty Canon.

import type { CanonRepository } from '../canon/ports';
import type { WorkTier } from '../canon/types';

export interface ListWorksResponse {
  figures: FigureGroup[];
}

export interface FigureGroup {
  id: string;
  slug: string;
  displayName: string;
  works: WorkListing[];
}

export interface WorkListing {
  id: string;
  title: string;
  tier: WorkTier;
}

export async function listWorksTool(
  deps: { repository: CanonRepository },
): Promise<ListWorksResponse> {
  const listings = await deps.repository.listWorks();
  const groups = new Map<string, FigureGroup>();
  for (const { work, figure } of listings) {
    let group = groups.get(figure.id);
    if (!group) {
      group = { id: figure.id, slug: figure.slug, displayName: figure.displayName, works: [] };
      groups.set(figure.id, group);
    }
    group.works.push({ id: work.id, title: work.title, tier: work.tier });
  }
  return { figures: [...groups.values()] };
}
