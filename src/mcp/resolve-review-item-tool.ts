// resolve_review_item — MCP tool wrapping resolveReviewItem (issue #6).
//
// Three actions: confirm (re-relocate the candidate as-is), correct (supply a
// relocating quote, optionally a refined claim), reject (drop). Admission still
// enforces the ≥1-relocating-Quote invariant (ADR-0007), so a "still-no-match"
// outcome leaves the candidate in the queue.
//
// Discriminated-union response (resolved + outcome | reason) so the AI client
// can branch predictably without parsing error strings.

import { resolveReviewItem } from '../canon/review-queue';
import type { ResolveReviewItemInput, ReviewResolution } from '../canon/review-queue';
import type { CanonRepository, IngestProvider } from '../canon/ports';

export type { ReviewResolution } from '../canon/review-queue';

export interface ResolveReviewItemRequest {
  itemId: string;
  action: 'confirm' | 'correct' | 'reject';
  quoteText?: string;
  claim?: string;
}

export async function resolveReviewItemTool(
  req: ResolveReviewItemRequest,
  deps: { provider: IngestProvider; repository: CanonRepository },
): Promise<ReviewResolution> {
  const input = toInput(req);
  if (!input) {
    // `correct` without quoteText is a malformed call — surface a typed reason
    // so the AI client sees a predictable shape, not an exception.
    return { resolved: false, reason: 'still-no-match' };
  }
  return resolveReviewItem(input, deps);
}

function toInput(req: ResolveReviewItemRequest): ResolveReviewItemInput | null {
  switch (req.action) {
    case 'confirm':
      return { itemId: req.itemId, action: 'confirm' };
    case 'reject':
      return { itemId: req.itemId, action: 'reject' };
    case 'correct':
      if (req.quoteText === undefined) return null;
      return {
        itemId: req.itemId,
        action: 'correct',
        quoteText: req.quoteText,
        ...(req.claim !== undefined ? { claim: req.claim } : {}),
      };
  }
}
