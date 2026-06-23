// Section-boundary normalizer (issue #9, ADR-0010).
//
// When Marker splits a book by bookmark depth, the trailing paragraph(s) of section N
// occasionally bleed into the head of section N+1 — the same prose lands in two files,
// once at the tail (authoritative — it really lives there) and again at the head of the
// next file (the leak). This routine strips the leaked copy from the *next* chunk so
// each paragraph appears exactly once across the book and reading order stays clean.
//
// The match key is the paragraph fingerprint — `alnumize(normalize(text))` — so curly
// quotes, em-dashes, hyphen-wrapped words and whitespace noise don't cause false misses
// (this is the same insensitivity ladder ADR-0007's relocate() uses, reused here so the
// boundary check agrees with downstream quote matching).
//
// Page anchors (`{N}---`) are NEVER considered content paragraphs: they pass through
// unchanged so the unified Source's structureMap still indexes the original PDF pages.
// The strip is from the *head* of the next chunk only — we never modify section N's
// own tail, since that's where the prose authoritatively belongs.
//
// Idempotent: once leaks are gone, a second pass finds nothing more to drop and
// returns the chunks byte-identical with an empty action log.

import { alnumize, normalize } from './normalize';
import type { MarkerChunk } from './marker-sections';

const PAGE_ANCHOR_RE = /^\{(\d+)\}-+$/;

// How many trailing content paragraphs of section N to consider as candidates for
// having leaked into section N+1's head. Larger windows tolerate longer leaks at the
// cost of more accidental matches against a recurring epigraph; five is enough for
// the leaks the zettle pipeline actually produces.
const TAIL_PARAGRAPH_WINDOW = 5;

export interface BoundaryAction {
  // Index pair into the input chunks array; [N, N+1] means the action concerns
  // the boundary between chunk N and chunk N+1.
  betweenChunks: [number, number];
  // The exact text dropped (as it appeared in chunk N+1's head). Logged for
  // operator inspection — boundary normalization is silent otherwise.
  droppedParagraph: string;
  // Which side of the boundary the paragraph was stripped from. Always 'next'
  // for now: we treat the earlier chunk's tail as authoritative. Kept as a
  // tagged union so a future rule (e.g. strip from prev's tail in some shape)
  // remains additive.
  fromChunk: 'next';
}

export interface NormalizeBoundariesResult {
  chunks: MarkerChunk[];
  actions: BoundaryAction[];
}

interface AnchorBlock {
  kind: 'anchor';
  text: string;
}

interface ContentBlock {
  kind: 'content';
  text: string;
  fingerprint: string;
}

type Block = AnchorBlock | ContentBlock;

function fingerprint(text: string): string {
  return alnumize(normalize(text)).text;
}

// Tokenize a chunk's markdown into a flat block list. Page anchors are pulled out
// onto their own blocks regardless of whether a blank line separated them — Marker
// often emits an anchor immediately above the next paragraph, and we want to
// fingerprint that paragraph by its own text, not by "anchor + paragraph".
function tokenize(markdown: string): Block[] {
  const blocks: Block[] = [];
  let contentBuf: string[] = [];

  const flushContent = (): void => {
    while (contentBuf.length > 0 && contentBuf[0]!.trim() === '') contentBuf.shift();
    while (contentBuf.length > 0 && contentBuf[contentBuf.length - 1]!.trim() === '') {
      contentBuf.pop();
    }
    if (contentBuf.length === 0) return;
    const text = contentBuf.join('\n');
    blocks.push({ kind: 'content', text, fingerprint: fingerprint(text) });
    contentBuf = [];
  };

  for (const line of markdown.split('\n')) {
    if (PAGE_ANCHOR_RE.test(line.trim())) {
      flushContent();
      blocks.push({ kind: 'anchor', text: line });
      continue;
    }
    if (line.trim() === '') {
      flushContent();
      continue;
    }
    contentBuf.push(line);
  }
  flushContent();
  return blocks;
}

// Inverse of tokenize, preserving content↔content blank-line separation and the
// single-newline placement around anchor blocks that Marker emits.
function untokenize(blocks: Block[]): string {
  if (blocks.length === 0) return '';
  const parts: string[] = [blocks[0]!.text];
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1]!;
    const cur = blocks[i]!;
    const sep = prev.kind === 'content' && cur.kind === 'content' ? '\n\n' : '\n';
    parts.push(sep, cur.text);
  }
  return parts.join('');
}

export function normalizeSectionBoundaries(input: MarkerChunk[]): NormalizeBoundariesResult {
  const tokens = input.map((c) => tokenize(c.markdown));
  const actions: BoundaryAction[] = [];

  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1]!;
    const cur = tokens[i]!;
    const tailFps = new Set(
      prev
        .filter((b): b is ContentBlock => b.kind === 'content')
        .slice(-TAIL_PARAGRAPH_WINDOW)
        .map((b) => b.fingerprint)
        .filter((fp) => fp.length > 0),
    );

    // Walk cur from the head. Anchor blocks pass through. Content blocks whose
    // fingerprint appears in prev's tail are dropped; the first non-matching
    // content block stops the scan so we never strip past the leak.
    let j = 0;
    while (j < cur.length) {
      const b = cur[j]!;
      if (b.kind === 'anchor') {
        j++;
        continue;
      }
      if (tailFps.has(b.fingerprint)) {
        actions.push({
          betweenChunks: [i - 1, i],
          droppedParagraph: b.text,
          fromChunk: 'next',
        });
        cur.splice(j, 1);
        continue;
      }
      break;
    }
  }

  return {
    chunks: input.map((c, i) => ({ ...c, markdown: untokenize(tokens[i]!) })),
    actions,
  };
}
