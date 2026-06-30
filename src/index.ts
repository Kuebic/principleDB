// Public entrypoint for the principleDB shared core (Slice 1, issue #2).
// MCP tools (and any later first-party app) are adapters over these.

export { admit } from './canon/admission';
export type { AdmissionResult } from './canon/admission';
export { dedup, DEFAULT_DEDUP_THRESHOLD } from './canon/dedup';
export type { DedupContext, DedupResult } from './canon/dedup';
export {
  AnthropicIngestProvider,
  DEFAULT_DISTIL_MODEL,
  PROMPT_VERSION,
} from './canon/anthropic-provider';
export type { AnthropicIngestProviderOptions } from './canon/anthropic-provider';
export { deriveLabel } from './canon/derive-label';
export { FakeIngestProvider } from './canon/fake-provider';
export type { BlobStore } from './canon/blob-store';
export { InMemoryBlobStore } from './canon/blob-store';
export {
  FakePdfExtractor,
  parseMarkerOutput,
} from './canon/marker';
export type {
  ExtractionTarget,
  ExtractOptions,
  MarkerArtifact,
  ParsedMarkerOutput,
  PdfExtractor,
} from './canon/marker';
export { MarkerCliExtractor } from './canon/marker-cli';
export type { MarkerCliOptions, MarkerProcessRunner } from './canon/marker-cli';
export { ingestPdfSource, r2KeyForPdfSource } from './canon/pdf-ingest';
export type {
  IngestPdfDeps,
  IngestPdfOptions,
  PdfSourceMeta,
} from './canon/pdf-ingest';
export { createOpenAIEmbedder } from './canon/openai-embedder';
export type { EmbedFn, OpenAIEmbedderOptions } from './canon/openai-embedder';
export { InMemoryRepository } from './canon/in-memory-repository';
export { ingestSource } from './canon/ingest';
export type { IngestResult } from './canon/ingest';
export { bulkIngest, InMemoryBulkProgressStore } from './canon/bulk-ingest';
export type {
  BulkIngestFailure,
  BulkIngestJob,
  BulkIngestOptions,
  BulkIngestResult,
  BulkIngestSuccess,
  BulkProgressStore,
} from './canon/bulk-ingest';
export { alnumize, normalize } from './canon/normalize';
export type { NormalizedText, OriginEntry } from './canon/normalize';
export type {
  CanonRepository,
  DistilInput,
  IngestProvider,
  ListReviewCandidatesOptions,
  QuoteWithPrinciple,
  ReplacePrinciplesOptions,
  SameClaimVerdict,
  SearchHit,
} from './canon/ports';
export { getQuoteInContext } from './canon/quote-in-context';
export type {
  GetQuoteInContextDeps,
  GetQuoteInContextResponse,
  QuoteInContextHit,
  QuoteInContextMiss,
} from './canon/quote-in-context';
export { relocate } from './canon/relocate';
export type { RelocateResult } from './canon/relocate';
export { listReviewQueue, resolveReviewItem } from './canon/review-queue';
export type {
  ListReviewQueueDeps,
  ListReviewQueueOptions,
  ResolveReviewItemDeps,
  ResolveReviewItemInput,
  ReviewQueueItem,
  ReviewQueueListing,
  ReviewResolution,
} from './canon/review-queue';
export { searchPrinciples } from './canon/search';
export type {
  DedupDecision,
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
export { getQuoteInContextTool } from './mcp/get-quote-in-context-tool';
export type { GetQuoteInContextRequest } from './mcp/get-quote-in-context-tool';
export { listReviewQueueTool } from './mcp/list-review-queue-tool';
export type { ListReviewQueueRequest } from './mcp/list-review-queue-tool';
export { resolveReviewItemTool } from './mcp/resolve-review-item-tool';
export type { ResolveReviewItemRequest } from './mcp/resolve-review-item-tool';
export { searchPrinciplesTool } from './mcp/search-principles-tool';
export type {
  SearchHitResponse,
  SearchPrinciplesRequest,
  SearchPrinciplesResponse,
} from './mcp/search-principles-tool';
export { createPrincipleDbServer, runStdio } from './mcp/server';
export type { ServerDeps } from './mcp/server';
export { buildPrincipleDbDepsFromEnv } from './bin/build-deps';
export type { BuildDepsEnv, BuiltDeps } from './bin/build-deps';
export { deriveHtmlSourcePathId } from './bin/derive-path-source-id';
export { PostgresBulkProgressStore } from './db/postgres-bulk-progress-store';
export type { PostgresBulkProgressStoreOptions } from './db/postgres-bulk-progress-store';
export { formatReport, REQUIRED_TABLES, runDoctor } from './bin/doctor';
export type {
  CheckStatus,
  DbProbeError,
  DbProbeResult,
  DoctorCheck,
  DoctorEnv,
  DoctorReport,
  ProbeDb,
} from './bin/doctor';
