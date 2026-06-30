// HTML ingest core (Phase 0 / Slice 1, issue #12).
//
// The thinnest end-to-end path for an HTML file: extract clean body text →
// derive a minimal Source title → build a text Source → run the existing
// `ingestText` pipeline so Principles land in the Canon. No changes to the
// ingest core itself; the HTML adapter is layered cleanly on top.
//
// Pure parts (arg parsing, title derivation, source construction) are
// unit-tested with fakes. The impure shell at `bin/principledb-ingest-html.ts`
// reads the file and wires real Postgres + Anthropic deps via
// `buildPrincipleDbDepsFromEnv`.

import { HTMLElement, parse } from 'node-html-parser';

import type { CanonRepository, IngestProvider } from '../canon/ports';
import type { SourceKind } from '../canon/types';
import { htmlToText } from './html-to-text';
import { ingestText, type IngestTextOutcome } from './ingest-text';

const SOURCE_KINDS: readonly SourceKind[] = ['sermon', 'book', 'article', 'transcript'];

export interface HtmlSourceInput {
  html: string;
  // The file's basename, used as the fallback title when neither <title> nor
  // <h1> is present in the markup. Slice 2 (issue #13) extends this to
  // author/date/kind derivation from the full path.
  filename: string;
  title?: string;
  author?: string;
  kind?: SourceKind;
  date?: string;
}

// Title preference per the slice spec: HTML <title> → first <h1> → humanized
// filename. Empty/whitespace-only matches don't count, so an empty `<title>`
// falls through to <h1>.
export function deriveHtmlTitle(html: string, fallback: string): string {
  const root = parse(html);
  const fromTitle = pickTextFrom(root.querySelector('title'));
  if (fromTitle) return fromTitle;
  const fromH1 = pickTextFrom(root.querySelector('h1'));
  if (fromH1) return fromH1;
  return humanizeFilename(fallback);
}

function pickTextFrom(el: HTMLElement | null): string | null {
  if (!el) return null;
  const text = el.text.trim();
  return text.length > 0 ? text : null;
}

// Drop the trailing extension, then map underscores/hyphens/dots to spaces and
// collapse runs. Pure helper exposed for tests; slice 2 layers date stripping
// and richer humanization on top.
export function humanizeFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface IngestHtmlArgs {
  file: string;
  title?: string;
  author?: string;
  kind?: SourceKind;
  date?: string;
}

// Parse the `principledb-ingest-html` CLI argv (everything after the script name):
//   <file> [--title T] [--author A] [--kind sermon|book|article|transcript] [--date D]
// Pure so flag handling is unit-tested without spawning a process.
export function parseIngestHtmlArgs(argv: string[]): IngestHtmlArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[++i];
      if (value === undefined) throw new Error(`flag --${key} needs a value`);
      flags[key] = value;
    } else {
      positional.push(arg);
    }
  }

  const file = positional[0];
  if (!file) {
    throw new Error(
      'usage: principledb-ingest-html <file.html> [--title T] [--author A] [--kind K] [--date D]',
    );
  }

  const kind = flags.kind;
  if (kind !== undefined && !SOURCE_KINDS.includes(kind as SourceKind)) {
    throw new Error(`--kind must be one of ${SOURCE_KINDS.join(', ')} (got "${kind}")`);
  }

  return {
    file,
    ...(flags.title !== undefined ? { title: flags.title } : {}),
    ...(flags.author !== undefined ? { author: flags.author } : {}),
    ...(kind !== undefined ? { kind: kind as SourceKind } : {}),
    ...(flags.date !== undefined ? { date: flags.date } : {}),
  };
}

export async function ingestHtml(
  input: HtmlSourceInput,
  deps: { provider: IngestProvider; repository: CanonRepository },
): Promise<IngestTextOutcome> {
  const { text } = htmlToText(input.html);
  const title = input.title ?? deriveHtmlTitle(input.html, input.filename);
  return ingestText(
    {
      title,
      text,
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.date !== undefined ? { date: input.date } : {}),
    },
    deps,
  );
}
