// list_review_queue — MCP tool wrapping the listReviewQueue core op (issue #6).
//
// Returns a summary-first view of the no-match ReviewCandidates the admission
// gate surfaces. Empty case is a well-shaped { items: [], total: 0 } so an AI
// client never has to branch on transport-level failures.

import { listReviewQueue } from '../canon/review-queue';
import type { ListReviewQueueOptions, ReviewQueueListing } from '../canon/review-queue';
import type { CanonRepository } from '../canon/ports';

export type { ReviewQueueItem, ReviewQueueListing } from '../canon/review-queue';

export interface ListReviewQueueRequest {
  limit?: number;
  offset?: number;
}

export async function listReviewQueueTool(
  req: ListReviewQueueRequest,
  deps: { repository: CanonRepository },
): Promise<ReviewQueueListing> {
  const opts: ListReviewQueueOptions = {};
  if (req.limit !== undefined) opts.limit = req.limit;
  if (req.offset !== undefined) opts.offset = req.offset;
  return listReviewQueue(opts, deps);
}
