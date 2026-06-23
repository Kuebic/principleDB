// Public entrypoint for the principleDB shared core (Slice 1, issue #2).
// MCP tools (and any later first-party app) are adapters over these.

export { admit } from './canon/admission';
export type { AdmissionResult } from './canon/admission';
export {
  AnthropicIngestProvider,
  DEFAULT_DISTIL_MODEL,
  PROMPT_VERSION,
} from './canon/anthropic-provider';
export type { AnthropicIngestProviderOptions } from './canon/anthropic-provider';
export { deriveLabel } from './canon/derive-label';
export { FakeIngestProvider } from './canon/fake-provider';
export { createOpenAIEmbedder } from './canon/openai-embedder';
export type { EmbedFn, OpenAIEmbedderOptions } from './canon/openai-embedder';
export { InMemoryRepository } from './canon/in-memory-repository';
export { ingestSource } from './canon/ingest';
export type { IngestResult } from './canon/ingest';
export { alnumize, normalize } from './canon/normalize';
export type { NormalizedText, OriginEntry } from './canon/normalize';
export type {
  CanonRepository,
  DistilInput,
  IngestProvider,
  SearchHit,
} from './canon/ports';
export { relocate } from './canon/relocate';
export type { RelocateResult } from './canon/relocate';
export { searchPrinciples } from './canon/search';
export type {
  DistilProvenance,
  DistilledItem,
  LocatedQuote,
  MatchTier,
  Principle,
  ReviewCandidate,
  Source,
  SourceKind,
  Span,
  StructureMap,
} from './canon/types';
export { searchPrinciplesTool } from './mcp/search-principles-tool';
export type {
  SearchHitResponse,
  SearchPrinciplesRequest,
  SearchPrinciplesResponse,
} from './mcp/search-principles-tool';
export { createPrincipleDbServer, runStdio } from './mcp/server';
export type { ServerDeps } from './mcp/server';
