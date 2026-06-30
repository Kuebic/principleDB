// Pure HTML → clean text extractor (Phase 0 / Slice 1, issue #12).
//
// Walks the parsed DOM, drops chrome (script/style/head/nav/comments), inserts
// newlines at block boundaries, decodes entities, and collapses whitespace so
// the distil model sees readable prose instead of markup. The `node-html-parser`
// dependency is isolated behind this one function — nothing else in the repo
// imports it directly.
//
// Heading capture (`{ offset, heading }[]`) is part of the return shape so the
// metadata slice (issue #13) can fill it in without touching callers; this
// slice returns an empty array.

import { HTMLElement, NodeType, parse, type Node } from 'node-html-parser';

export interface ExtractedHeading {
  offset: number;
  heading: string;
}

export interface ExtractedHtml {
  text: string;
  headings: ExtractedHeading[];
}

// Tags whose contents are markup/chrome rather than body prose — dropped wholesale.
const SKIP_TAGS = new Set([
  'script',
  'style',
  'head',
  'title',
  'meta',
  'link',
  'nav',
  'noscript',
]);

// Tags that imply a line break in plain text. <br> and the block elements
// listed in the PRD; a handful of other obvious block tags (hr, blockquote,
// pre, section, article, header, footer, table) so a real-world page renders
// with sensible paragraphing.
const BLOCK_TAGS = new Set([
  'p',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'div',
  'hr',
  'blockquote',
  'pre',
  'section',
  'article',
  'header',
  'footer',
  'table',
]);

// Tags that introduce a paragraph break (two newlines) rather than a single
// line break — keeps real paragraphs visually distinct in the extracted text.
// Structural containers (div/section/article/header/footer/table) only get a
// single newline; they wrap content rather than being paragraphs themselves.
const PARAGRAPH_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'hr',
]);

export function htmlToText(html: string): ExtractedHtml {
  if (html.length === 0) {
    return { text: '', headings: [] };
  }
  const root = parse(html, { comment: false });
  const parts: string[] = [];
  walk(root, parts);
  const text = collapseWhitespace(parts.join(''));
  return { text, headings: [] };
}

function walk(node: Node, parts: string[]): void {
  if (node.nodeType === NodeType.COMMENT_NODE) return;
  if (node.nodeType === NodeType.TEXT_NODE) {
    parts.push(node.text);
    return;
  }
  if (!(node instanceof HTMLElement)) return;

  const tag = node.tagName?.toLowerCase() ?? '';
  if (SKIP_TAGS.has(tag)) return;

  // Emit only on the OPENING side. A closing-side emit collides with the next
  // sibling's opening — `<br><br>` would read as a paragraph break instead of
  // two line breaks. Two sibling <p>s share their boundary on the second's
  // opener; that single emit is the full paragraph break.
  if (BLOCK_TAGS.has(tag)) parts.push(PARAGRAPH_TAGS.has(tag) ? '\n\n' : '\n');

  for (const child of node.childNodes) walk(child, parts);
}

// Squash horizontal whitespace runs, collapse 3+ blank lines down to a single
// paragraph break, trim leading/trailing whitespace per line, then trim the
// document. Two passes are needed because horizontal collapse can expose
// formerly-content lines as empty.
function collapseWhitespace(raw: string): string {
  const lines = raw
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((l) => l.trim());
  const out: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line === '') {
      blankRun++;
      continue;
    }
    if (out.length > 0 && blankRun > 0) out.push('');
    out.push(line);
    blankRun = 0;
  }
  return out.join('\n').trim();
}
