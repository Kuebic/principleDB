// Reader page — Slice W3 (#48, Variant D). Renders the whole Source with the
// target Quote highlighted as `<mark id="quote">` and a sticky outline (scroll-
// spy) alongside the freely-scrollable text. Prototype design lives at
// `prototype/reader-43` (branch); this is the real implementation of the same
// shape wired to the core data.
//
// Pure renderer: takes `QuoteReaderHit` + optional back-link and returns HTML.
// The route handler (app.ts) fetches via getQuoteReader (see quote-in-context.ts).
//
// Sections are derived from the Source's structureMap (ADR-0009):
//   • pdf-pages          → one section per page ("page N")
//   • text-headings      → one section per enclosing heading
//   • transcript-timecodes → one section per timecode block
//   • none               → a single un-titled section
// The quote span is highlighted in place; if it straddles a section boundary
// the mark is closed at the boundary and reopened in the next section so the
// enclosing HTML stays well-formed (a rare case but not one to leave broken).

import type { QuoteReaderHit } from '../canon/quote-in-context';
import type { Span, StructureMap } from '../canon/types';

export interface RenderReaderPageOptions {
  back?: string;
}

interface SectionBoundary {
  offset: number;
  label: string;
}

export function renderReaderPage(
  data: QuoteReaderHit,
  options: RenderReaderPageOptions = {},
): string {
  const sections = deriveSections(data.source.structureMap, data.source.text.length);
  const outline = renderOutline(sections);
  const body = renderBody(data.source.text, sections, data.quote.span);
  const backHref = options.back ?? '/';
  const kindWord = escapeHtml(data.source.kind);
  const pillText = escapeHtml(data.quote.label || data.source.kind);
  const shareHref = buildTextFragmentHref(
    data.source.text.slice(data.quote.span.start, data.quote.span.end),
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(data.source.title)} — principleDB Reader</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <p class="backlink"><a href="${escapeAttribute(backHref)}">&larr; back to results</a></p>
  <div class="grid">
    <aside class="rail" aria-label="Source outline">
      <span class="label-pill">${pillText}</span>
      <nav class="toc">
        <h4>In this source</h4>
        ${outline}
      </nav>
      <div class="quiet">
        <a href="#quote">&uarr; the quote</a>
        <a href="${escapeAttribute(shareHref)}" target="_blank" rel="noopener">share &uarr;</a>
      </div>
    </aside>
    <article class="reader">
      <p class="claim">${escapeHtml(data.principle.claim)}</p>
      <h1 class="title">${escapeHtml(data.source.title)}</h1>
      <div class="byline">${escapeHtml(data.source.author)} &middot;
        <span class="kind">${kindWord}</span></div>
      <div class="prose">${body}</div>
      <footer class="foot">
        <p>Works are shared for study by readers who already hold these teachings.
        All texts &copy; their respective authors and publishers.
        This page is unlisted and not indexed.</p>
        <p>To request removal of any material, contact
          <a href="mailto:removals@principledb.example">removals@principledb.example</a>.</p>
      </footer>
    </article>
  </div>
</div>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

export function renderReaderNotFound(options: RenderReaderPageOptions = {}): string {
  const backHref = options.back ?? '/';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Quote not found — principleDB Reader</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <p class="backlink"><a href="${escapeAttribute(backHref)}">&larr; back to results</a></p>
  <section class="empty-state">
    <p>This quote could not be found. It may have been re-ingested under a new provenance
      or the link may be stale &mdash; try the search above.</p>
  </section>
</div>
</body>
</html>`;
}

function deriveSections(structureMap: StructureMap, textLength: number): SectionBoundary[] {
  if (structureMap.kind === 'pdf-pages') {
    return structureMap.pages.map((p) => ({ offset: p.offset, label: `page ${p.page}` }));
  }
  if (structureMap.kind === 'text-headings') {
    return structureMap.headings.map((h) => ({ offset: h.offset, label: h.heading }));
  }
  if (structureMap.kind === 'transcript-timecodes') {
    return structureMap.codes.map((c) => ({ offset: c.offset, label: c.timecode }));
  }
  return textLength > 0 ? [{ offset: 0, label: 'The source' }] : [];
}

function renderOutline(sections: SectionBoundary[]): string {
  if (sections.length === 0) {
    return '<div class="toc-empty">No outline for this source.</div>';
  }
  return sections
    .map(
      (s, i) =>
        `<a data-spy="sec-${i}" href="#sec-${i}">${escapeHtml(s.label)}</a>`,
    )
    .join('\n        ');
}

function renderBody(text: string, sections: SectionBoundary[], span: Span): string {
  if (sections.length === 0) {
    return `<div class="section" id="sec-0"><div class="section-body">${
      renderPortion(text, 0, text.length, span)
    }</div></div>`;
  }
  const parts: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i]!.offset;
    const end = sections[i + 1]?.offset ?? text.length;
    if (end <= start) continue;
    const label = sections[i]!.label;
    parts.push(
      `<div class="section sectionmark" id="sec-${i}">` +
        `<h3 class="section-title">${escapeHtml(label)}</h3>` +
        `<div class="section-body">${renderPortion(text, start, end, span)}</div>` +
        `</div>`,
    );
  }
  return parts.join('\n');
}

// Renders `text.slice(regionStart, regionEnd)` as escaped paragraphs, inserting
// `<mark id="quote">` around the intersection with `span`. Paragraph breaks are
// preserved on blank lines so continuous prose reads naturally.
function renderPortion(text: string, regionStart: number, regionEnd: number, span: Span): string {
  const region = text.slice(regionStart, regionEnd);
  const localStart = Math.max(0, span.start - regionStart);
  const localEnd = Math.max(0, Math.min(region.length, span.end - regionStart));

  if (localEnd <= localStart) return renderParagraphs(region);

  const before = renderParagraphs(region.slice(0, localStart));
  const inside = escapeHtml(region.slice(localStart, localEnd));
  const after = renderParagraphs(region.slice(localEnd));
  return `${before}<mark id="quote">${inside}</mark>${after}`;
}

function renderParagraphs(text: string): string {
  if (text === '') return '';
  return text
    .split(/\n\s*\n/)
    .map((para) => `<p>${escapeHtml(para.replace(/\n/g, ' '))}</p>`)
    .join('');
}

function buildTextFragmentHref(quoteText: string): string {
  const trimmed = quoteText.trim();
  if (!trimmed) return '#quote';
  const encoded = encodeURIComponent(trimmed.slice(0, 300));
  return `#:~:text=${encoded}`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(input: string): string {
  return escapeHtml(input);
}

const STYLES = `
:root {
  --ink: #23201c; --ink-soft: #5b544a; --ink-faint: #8a8073;
  --paper: #faf7f1; --paper-2: #f2ece1;
  --card: #ffffff; --line: #e4dccd;
  --accent: #9a6a2f; --accent-soft: #f3e3c9;
  --mark: #ffe9a8; --mark-edge: #e8c65a;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--paper); color: var(--ink); font-family: var(--sans); line-height: 1.5; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 24px 20px 80px; }
.backlink { font-size: 14px; margin: 0 0 14px; }
.grid { display: grid; grid-template-columns: 250px 1fr; gap: 44px; align-items: start; }
.rail { position: sticky; top: 20px; max-height: calc(100vh - 40px); overflow: auto; padding-right: 6px; }
.label-pill { display: inline-flex; align-items: center; gap: 7px; font-size: 13px;
  background: var(--accent-soft); color: #7a5220; border-radius: 999px; padding: 4px 12px;
  font-weight: 600; margin-bottom: 16px; }
.toc h4 { margin: 0 0 8px; font-size: 11.5px; letter-spacing: .06em;
  text-transform: uppercase; color: var(--ink-faint); }
.toc a { display: block; padding: 7px 12px; border-radius: 0 8px 8px 0;
  font-size: 13.5px; color: var(--ink-soft);
  border-left: 2px solid var(--line); transition: all .12s; }
.toc a.here { color: #7a5220; font-weight: 600; border-left-color: var(--accent);
  background: var(--accent-soft); }
.toc a:hover { color: var(--accent); text-decoration: none; }
.toc-empty { color: var(--ink-faint); font-size: 13px; font-style: italic; padding: 8px 0; }
.quiet { display: flex; gap: 18px; margin-top: 16px; padding-top: 14px;
  border-top: 1px solid var(--line); font-size: 13px; }
.quiet a { color: var(--ink-faint); }
.quiet a:hover { color: var(--accent); }
.reader { max-width: 64ch; }
.reader .claim { font-family: var(--serif); font-size: 20px; color: var(--ink-soft);
  font-weight: 600; margin: 0 0 12px; }
.reader .title { font-family: var(--serif); font-size: 26px; margin: 0 0 4px; }
.reader .byline { color: var(--ink-faint); margin-bottom: 20px; font-size: 14px; }
.reader .byline .kind { text-transform: capitalize; }
.prose { font-family: var(--serif); font-size: 19px; line-height: 1.7; color: var(--ink); }
.prose p { margin: 0 0 1.15em; }
.section { scroll-margin-top: 20px; }
.section-title { font-family: var(--sans); font-size: 12px; text-transform: uppercase;
  letter-spacing: .08em; color: var(--ink-faint); margin: 28px 0 10px; font-weight: 700; }
.section:first-child .section-title { margin-top: 0; }
mark#quote { background: linear-gradient(transparent 8%, var(--mark) 8% 92%, transparent 92%);
  box-shadow: inset 0 0 0 1px var(--mark-edge); border-radius: 2px; padding: 1px 2px; color: var(--ink); }
.empty-state { color: var(--ink-soft); font-family: var(--serif); font-size: 17px; padding: 24px 2px; }
.foot { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line);
  font-size: 12.5px; color: var(--ink-faint); line-height: 1.6; }
.foot p { margin: 4px 0; }
@media (max-width: 860px) {
  .grid { grid-template-columns: 1fr; gap: 24px; }
  .rail { position: static; max-height: none; order: -1; }
  .reader { max-width: none; }
}
`;

// Scroll-into-view for #quote on load, and scroll-spy: as sections cross the top
// of the viewport, the matching outline link picks up .here. Kept vanilla so the
// public page stays framework-free and cheap under abuse (#49 lives on the same
// process; this JS should not hold state or make requests).
const CLIENT_SCRIPT = `
(function () {
  var quote = document.getElementById('quote');
  if (quote && !location.hash) {
    setTimeout(function () { quote.scrollIntoView({ behavior: 'auto', block: 'center' }); }, 30);
  }
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[data-spy]'));
  if (!links.length || typeof IntersectionObserver === 'undefined') return;
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('data-spy')] = a; });
  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a) { a.classList.remove('here'); });
      var a = byId[e.target.id];
      if (a) a.classList.add('here');
    });
  }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
  document.querySelectorAll('.sectionmark').forEach(function (s) { observer.observe(s); });
})();
`;
