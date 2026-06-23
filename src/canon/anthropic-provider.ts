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
import type { DistilInput, IngestProvider } from './ports';
import type { EmbedFn } from './openai-embedder';

export const DEFAULT_DISTIL_MODEL = 'claude-opus-4-8';
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
  model?: string;
  modelVersion?: string;
  promptVersion?: string;
  maxTokens?: number;
}

interface DistilToolInput {
  principles: ReadonlyArray<{ claim: string; quote: string }>;
}

export class AnthropicIngestProvider implements IngestProvider {
  readonly provenance: DistilProvenance;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly embedFn: EmbedFn;

  constructor(opts: AnthropicIngestProviderOptions) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? DEFAULT_DISTIL_MODEL;
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
        const parsed = block.input as DistilToolInput;
        const items = parsed?.principles ?? [];
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
}
