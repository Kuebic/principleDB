// Anthropic-backed IngestProvider — distil via Claude (default
// claude-opus-4-8 per ADR-0008); embed delegated to a function the caller
// supplies (ADR-0011 — Anthropic has no embeddings endpoint, so the embed half
// is OpenAI/Voyage/etc.).
//
// Distillation uses Claude's tool-use for typed `{principles: [{claim, quote}]}`
// output rather than free-form JSON, so the SDK validates shape before the
// pipeline ever sees the response. The prompt and tool schema are versioned
// (PROMPT_VERSION) so re-ingest under a pinned model+prompt is deterministic
// (ADR-0008 idempotency guarantee).

import Anthropic from '@anthropic-ai/sdk';

import type { DistilProvenance, DistilledItem } from './types';
import type { DistilInput, IngestProvider, SameClaimVerdict } from './ports';
import type { EmbedFn } from './openai-embedder';

export const DEFAULT_DISTIL_MODEL = 'claude-opus-4-8';
// Confirm model (issue #24, PRD #21). Defaults to Haiku — `confirmSameClaim`
// is a narrow binary judgment with a 512-token cap, so it belongs on a
// cheaper, faster model with more rate-limit headroom than the Opus distil.
// Self-hosters who want to trade cost for caution can pin this back to Opus
// via `PRINCIPLEDB_CONFIRM_MODEL` (documented in SELF_HOSTING). The confirm
// model is intentionally NOT part of the distil provenance tuple — it
// changes the merge decision, not what was said.
export const DEFAULT_CONFIRM_MODEL = 'claude-haiku-4-5';
export const PROMPT_VERSION = 'distil/v1';

// The distillation prompt — versioned via PROMPT_VERSION above. Any edit here
// is a deliberate provenance change; re-ingest under the new prompt will be
// additive in the repository (different provenance → distinct ID slot,
// model-mixed Canon honest per ADR-0008).
const DISTIL_SYSTEM = `You distil a teaching into ATOMIC PRINCIPLES for the principleDB Canon — a searchable, descriptive corpus of what was taught.

Rules:
- A Principle is ONE general/normative teaching claim, stated as a single declarative sentence in canonical wording. NOT a question, NOT a topic label, NOT a narrative fact about a specific person/event. Narrative ("the prodigal son came home") supports a Principle ("God receives the repentant"); it never becomes a Principle itself.
- Every Principle MUST be backed by a "quote": a span copied VERBATIM from the source text — exact characters, long enough to stand as evidence. NEVER paraphrase or invent the quote. If you would have to paraphrase to support a claim, drop the claim — the Principle isn't supported.
- Extract only what the text actually teaches. Do not infer beyond it.
- Prefer many sharp atomic claims over a few broad summaries. If a sentence carries two distinct teachings, emit two Principles.
- Granularity is faithful-descriptive only. Do not rank Principles by importance.

Use the extract_principles tool to return your result. Do not respond with prose.`;

// The dedup confirm prompt (issue #5, ADR-0006; hardened per the #25 validation
// spike). The Canon collapses only near-identical claims — different framings of
// a similar idea stay separate, and live relatedness (slice 7) connects them.
//
// The #25 Genesis spike found the prior prompt over-merged at low cosine: Haiku
// would collapse two DISTINCT teachings that merely shared a topic/theme (and in
// one case invented a shared point only one claim stated). A false merge
// permanently deletes a distinct teaching (ADR-0013's costly direction), so the
// prompt now demands subject+assertion identity (not topical overlap), walks the
// model through naming each claim's assertion before deciding, and restates the
// asymmetry hard. On the spike's labeled pairs this removed every false merge
// while merging zero new kept-separate pairs. Not part of the distil provenance
// tuple (it changes the merge decision, not what was said — see ADR-0013).
const SAME_CLAIM_SYSTEM = `You are the conservative-dedup judge for the principleDB Canon.
You are given two atomic teaching claims: A (newly distilled) and B (already in the Canon).
Decide whether they are the SAME teaching, or merely RELATED.

Two claims are the SAME teaching ONLY when they assert the same thing about the same subject — same subject AND same point, differing only in wording, level of detail, or a named example. If the subject differs, or the point asserted differs, they are DISTINCT teachings — even when they share a topic, theme, vocabulary, or theological frame.

Before deciding, do this:
1. State A's core assertion plainly: <subject> — <what A claims about it>.
2. State B's core assertion the same way.
3. They are the SAME only if BOTH the subject AND the assertion match. Shared topic alone ("both about Satan and offerings", "both about the Fall", "both about marriage") is NOT enough. Do not invent a shared point that only one claim actually states.

The asymmetry is the whole point: a wrong merge PERMANENTLY deletes a distinct teaching from the Canon and cannot be undone. A wrong "keep separate" costs nothing — related claims are reconnected at query time. So unless the two assertions are clearly identical, return same=false. When in doubt, keep them separate.

Use the same_claim tool. In the rationale, name A's assertion and B's assertion, then say whether they match.`;

const SAME_CLAIM_TOOL: Anthropic.Tool = {
  name: 'same_claim',
  description: 'Return whether claim A and claim B are the same teaching claim.',
  input_schema: {
    type: 'object',
    properties: {
      same: { type: 'boolean', description: 'true if A and B are the same teaching claim.' },
      rationale: {
        type: 'string',
        description: "A short rationale the Owner can inspect — name A's assertion and B's assertion, then whether they match.",
      },
    },
    required: ['same', 'rationale'],
  },
};

const DISTIL_TOOL: Anthropic.Tool = {
  name: 'extract_principles',
  description:
    'Return the atomic general/normative Principles taught in the source, each with a verbatim backing quote from the source text.',
  input_schema: {
    type: 'object',
    properties: {
      principles: {
        type: 'array',
        description: 'Atomic general/normative teaching claims in the source.',
        items: {
          type: 'object',
          properties: {
            claim: {
              type: 'string',
              description:
                'ONE general/normative teaching claim, stated as a single canonical declarative sentence.',
            },
            quote: {
              type: 'string',
              description:
                'A span copied VERBATIM from the source text that backs this claim. Never paraphrase.',
            },
          },
          required: ['claim', 'quote'],
        },
      },
    },
    required: ['principles'],
  },
};

export interface AnthropicIngestProviderOptions {
  embed: EmbedFn;
  client?: Anthropic;
  apiKey?: string;
  // OAuth bearer token alternative to `apiKey` — e.g. a Claude Code
  // subscription token (CLAUDE_CODE_OAUTH_TOKEN). The SDK sends it as
  // `Authorization: Bearer …` instead of `x-api-key`. Ignored when `apiKey`
  // or an explicit `client` is supplied.
  authToken?: string;
  model?: string;
  modelVersion?: string;
  promptVersion?: string;
  // The model used for `confirmSameClaim` (issue #24, PRD #21). Defaults to
  // `DEFAULT_CONFIRM_MODEL` (Haiku). Decoupled from `model` (distil) so the
  // narrow confirm runs on a cheaper, faster model with more rate-limit
  // headroom while distillation stays on Opus.
  confirmModel?: string;
  maxTokens?: number;
  // How many times the SDK retries a 429 / 5xx / connection error before giving
  // up (exponential backoff, honoring the `retry-after` header). Defaults to the
  // SDK's own default of 2. Surfaced as a knob (PRINCIPLEDB_MAX_RETRIES) because
  // a distil call sharing an Opus rate bucket with a live session can hit
  // transient 429s — more retries ride out the burst. `max_tokens` is
  // deliberately NOT a knob: it does not draw on the OTPM budget, so lowering it
  // would only risk truncating the principle list, not reduce 429s.
  maxRetries?: number;
}

// Pick the SDK client options from whichever credential the caller gave. An
// explicit `apiKey` wins; otherwise an `authToken` is used as a bearer token;
// otherwise the SDK falls back to its own env lookup (ANTHROPIC_API_KEY). A
// `maxRetries` override, when set, is merged into whichever shape results.
function anthropicClientOptions(
  opts: AnthropicIngestProviderOptions,
): ConstructorParameters<typeof Anthropic>[0] {
  const base: ConstructorParameters<typeof Anthropic>[0] =
    opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {};
  if (opts.apiKey) return { ...base, apiKey: opts.apiKey };
  if (opts.authToken) return { ...base, authToken: opts.authToken };
  return base;
}

interface DistilToolInput {
  principles: ReadonlyArray<{ claim: string; quote: string }>;
}

export class AnthropicIngestProvider implements IngestProvider {
  readonly provenance: DistilProvenance;
  readonly confirmModel: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly embedFn: EmbedFn;

  constructor(opts: AnthropicIngestProviderOptions) {
    this.client = opts.client ?? new Anthropic(anthropicClientOptions(opts));
    this.model = opts.model ?? DEFAULT_DISTIL_MODEL;
    this.confirmModel = opts.confirmModel ?? DEFAULT_CONFIRM_MODEL;
    this.maxTokens = opts.maxTokens ?? 16000;
    this.embedFn = opts.embed;
    this.provenance = {
      distilModel: this.model,
      // The model ID is the pinned-version identifier — Anthropic model IDs are
      // dated/versioned (`claude-opus-4-8`); a future point-release moves the
      // ID, which is itself a deliberate provenance change.
      distilModelVersion: opts.modelVersion ?? this.model,
      distilPromptVersion: opts.promptVersion ?? PROMPT_VERSION,
    };
  }

  async distil(input: DistilInput): Promise<DistilledItem[]> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: DISTIL_SYSTEM,
      tools: [DISTIL_TOOL],
      tool_choice: { type: 'tool', name: 'extract_principles' },
      messages: [
        {
          role: 'user',
          content: `TITLE: ${input.title}\n\nSOURCE TEXT:\n${input.text}`,
        },
      ],
    });

    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'extract_principles') {
        // A tool call truncated at max_tokens yields incomplete JSON, so the SDK
        // surfaces `principles` as a partial/absent value. Fail loud rather than
        // silently drop the window's Principles (or crash later on `.filter`) —
        // the caller should distil in smaller windows (maxDistilChars).
        if (response.stop_reason === 'max_tokens') {
          throw new Error(
            `distil output truncated at max_tokens=${this.maxTokens} for "${input.title}" — reduce the distil window size`,
          );
        }
        const parsed = block.input as DistilToolInput;
        const items = Array.isArray(parsed?.principles) ? parsed.principles : [];
        return items
          .filter(
            (it): it is { claim: string; quote: string } =>
              typeof it?.claim === 'string' && typeof it?.quote === 'string',
          )
          .map((it) => ({ claim: it.claim.trim(), quote: it.quote.trim() }))
          .filter((it) => it.claim.length > 0 && it.quote.length > 0);
      }
    }
    return [];
  }

  async embed(claims: string[]): Promise<number[][]> {
    return this.embedFn(claims);
  }

  async confirmSameClaim(a: string, b: string): Promise<SameClaimVerdict> {
    const response = await this.client.messages.create({
      model: this.confirmModel,
      max_tokens: 512,
      system: SAME_CLAIM_SYSTEM,
      tools: [SAME_CLAIM_TOOL],
      tool_choice: { type: 'tool', name: 'same_claim' },
      messages: [
        {
          role: 'user',
          content: `Claim A: ${a}\nClaim B: ${b}`,
        },
      ],
    });
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === 'same_claim') {
        const parsed = block.input as { same?: unknown; rationale?: unknown };
        const same = parsed.same === true;
        const rationale =
          typeof parsed.rationale === 'string' ? parsed.rationale : '(no rationale returned)';
        return { same, rationale };
      }
    }
    // Defensive: with forced tool_choice this branch should not fire. If it
    // does, err conservative and keep the two Principles separate.
    return { same: false, rationale: '(no tool_use response; defaulting to keep-separate)' };
  }
}
