// HTML ingest core (Phase 0, issue #12 + issue #13).
//
// The thinnest end-to-end path for an HTML file: extract clean body text +
// h1–h3 heading offsets → derive title / author / kind / date from path +
// markup → build a text Source carrying a text-headings structureMap → run
// the existing `ingestText` pipeline so Principles land in the Canon. No
// changes to the ingest core itself; the HTML adapter is layered cleanly on
// top.
//
// All design surface (extractor, deriver, Source assembly, arg parsing) is
// pure and unit-tested with fakes. The impure shell at
// `bin/principledb-ingest-html.ts` reads the file and wires real Postgres +
// Anthropic deps via `buildPrincipleDbDepsFromEnv`.

import type { CanonRepository, IngestProvider } from '../canon/ports';
import type { Source, SourceKind, StructureMap } from '../canon/types';
import { deriveHtmlSourceMetadata } from './derive-html-metadata';
import { htmlToText } from './html-to-text';
import {
  ingestText,
  makeTextSource,
  parseIngestArgs,
  type IngestArgs,
  type IngestTextOutcome,
} from './ingest-text';

export interface HtmlSourceInput {
  html: string;
  // Repo-relative or absolute path. The metadata deriver reads the immediate
  // parent directory (→ author) and the basename (→ date token, fallback title).
  path: string;
  // Explicit overrides; when omitted, derived from path + HTML. The CLI maps
  // `--title/--author/--kind/--date` flags onto these.
  title?: string;
  author?: string;
  kind?: SourceKind;
  date?: string;
  // Override the derived Source id. The single-file CLI lets the
  // `(title, text)` content-hash id stand; the directory walker overrides
  // with a path-based id (issue #15) so a durable progress store can answer
  // "already done?" without re-reading the file.
  id?: string;
}

const HTML_INGEST_USAGE =
  'usage: principledb-ingest-html <file.html> [--title T] [--author A] [--kind K] [--date D]';

// Same argv shape as the text ingest (file + --title/--author/--kind/--date);
// only the usage string differs, so the HTML CLI just rebinds the shared parser.
export function parseIngestHtmlArgs(argv: string[]): IngestArgs {
  return parseIngestArgs(argv, HTML_INGEST_USAGE);
}

export async function ingestHtml(
  input: HtmlSourceInput,
  deps: { provider: IngestProvider; repository: CanonRepository },
): Promise<IngestTextOutcome> {
  const { title, text, author, kind, date, structureMap } = buildHtmlSourceInput(input);
  return ingestText(
    {
      title,
      text,
      author,
      kind,
      ...(date !== undefined ? { date } : {}),
      ...(input.id !== undefined ? { id: input.id } : {}),
      structureMap,
    },
    deps,
  );
}

// Shared source builder — the HTML→Source translation used by both the
// single-file ingest path (`ingestHtml` above, which delegates to `ingestText`)
// and the Phase A directory walker (issue #30). Phase A calls this + `stageSource`
// so it can construct the same Source shape without going through the full
// ingest+persist pipeline. Kept in this file because the HTML-specific derivation
// (title/author/date fallbacks, structureMap from headings) is HTML-adapter
// concern, not a Canon-core concern.
export function buildHtmlSource(input: HtmlSourceInput): Source {
  const built = buildHtmlSourceInput(input);
  return makeTextSource({
    title: built.title,
    text: built.text,
    author: built.author,
    kind: built.kind,
    ...(built.date !== undefined ? { date: built.date } : {}),
    ...(input.id !== undefined ? { id: input.id } : {}),
    structureMap: built.structureMap,
  });
}

interface BuiltHtmlSourceInput {
  title: string;
  text: string;
  author: string;
  kind: SourceKind;
  date: string | undefined;
  structureMap: StructureMap;
}

function buildHtmlSourceInput(input: HtmlSourceInput): BuiltHtmlSourceInput {
  const extracted = htmlToText(input.html);
  const derived = deriveHtmlSourceMetadata({
    path: input.path,
    html: input.html,
    ...(input.kind !== undefined ? { defaultKind: input.kind } : {}),
  });

  const structureMap: StructureMap =
    extracted.headings.length > 0
      ? { kind: 'text-headings', headings: extracted.headings }
      : { kind: 'none' };

  return {
    title: input.title ?? derived.title,
    text: extracted.text,
    author: input.author ?? derived.author,
    kind: derived.kind,
    date: input.date ?? derived.date,
    structureMap,
  };
}
