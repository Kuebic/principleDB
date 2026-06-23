// get_quote_in_context — the MCP tool the AI client calls to open a Quote at its
// exact spot in the Source (issue #4, ADR-0007/0009).
//
// Thin adapter over getQuoteInContext(): forwards optional contextChars, returns
// a response shape mirroring the core type so the same union is documented in one
// place. Read-only. Not-found is signalled by `{ found: false }`, not an error,
// so callers don't have to branch on transport-level failures.

import { getQuoteInContext } from '../canon/quote-in-context';
import type { GetQuoteInContextResponse } from '../canon/quote-in-context';
import type { CanonRepository } from '../canon/ports';

export type { GetQuoteInContextResponse } from '../canon/quote-in-context';

export interface GetQuoteInContextRequest {
  quoteId: string;
  contextChars?: number;
}

export async function getQuoteInContextTool(
  req: GetQuoteInContextRequest,
  deps: { repository: CanonRepository },
): Promise<GetQuoteInContextResponse> {
  return getQuoteInContext(req.quoteId, {
    repository: deps.repository,
    contextChars: req.contextChars,
  });
}
