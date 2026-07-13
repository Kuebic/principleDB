// Public Canon search page — Slice W2 (#47, #40, ADR-0015).
// Server-rendered HTML over `SearchPrinciplesResponse`. LLM-free: hits are
// grounded quote cards (Principle claim + Source's own words + citation).
// The "related principles" expander is DEFERRED — the browser fetches
// /api/related?principleId=... only when the user clicks (map Out-of-scope
// pre-eager rendering, #47).
//
// This module is a pure renderer: takes the query + response and returns HTML.
// The route handler (app.ts) calls the core search directly (ADR-0015).

import type { SearchHitResponse, SearchPrinciplesResponse } from '../mcp/search-principles-tool';

export interface RenderSearchPageOptions {
  query?: string;
  response?: SearchPrinciplesResponse;
}

export function renderSearchPage(options: RenderSearchPageOptions = {}): string {
  const query = options.query?.trim() ?? '';
  const response = options.response;

  const results = renderResults(query, response);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>principleDB — public Canon search</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <div class="brand">principleDB <small>· the public Canon search</small></div>
    <form class="searchbox" method="get" action="/">
      <label for="q" class="visually-hidden">Search the Canon</label>
      <input id="q" name="q" type="search" value="${escapeAttribute(query)}"
        placeholder="Type a thought — e.g. why does love need someone to receive it?"
        autocomplete="off" autofocus />
      <button type="submit">Search</button>
    </form>
  </header>
  ${results}
  <footer class="foot">
    <p>Works are shared for study by readers who already hold these teachings.
    All texts &copy; their respective authors and publishers.
    This page is unlisted and not indexed.</p>
    <p>To request removal of any material, contact
      <a href="mailto:removals@principledb.example">removals@principledb.example</a>.</p>
  </footer>
</div>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

function renderResults(query: string, response: SearchPrinciplesResponse | undefined): string {
  if (query === '' || response === undefined) {
    return `<section class="empty-state">
      <p>Enter a thought above. Results are grounded quotes from the Canon — the Source's
        own words, linked back to the teaching they came from.</p>
    </section>`;
  }
  if (response.hits.length === 0) {
    return `<section class="empty-state">
      <p>No results for &ldquo;${escapeHtml(query)}&rdquo;. Try a different phrasing —
        the Canon is small and speaks in its own words.</p>
    </section>`;
  }
  const cards = response.hits.map(renderHit).join('\n');
  return `<p class="lead">The teachings speak to this in a few places — here is what they
    say, <b>in their own words</b>.</p>
    <div class="cards">${cards}</div>`;
}

function renderHit(hit: SearchHitResponse): string {
  const kindWord = escapeHtml(hit.source.kind);
  return `<article class="hit">
    <p class="claim">${escapeHtml(hit.claim)}</p>
    <blockquote>&ldquo;${escapeHtml(hit.quote.text)}&rdquo;</blockquote>
    <div class="meta">
      <span class="src">${escapeHtml(hit.source.author)} &middot;
        <i>${escapeHtml(hit.source.title)}</i> &middot;
        <span class="kind">${kindWord}</span> &middot;
        ${escapeHtml(hit.quote.label)}</span>
      <a class="open" href="/quote/${encodeURIComponent(hit.quote.id)}">Read in context &rarr;</a>
    </div>
    <button type="button" class="expand"
      data-expander="related"
      data-principle-id="${escapeAttribute(hit.principleId)}"
      aria-expanded="false">&#9662; related principles</button>
    <div class="related" data-related-for="${escapeAttribute(hit.principleId)}" hidden></div>
  </article>`;
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
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--paper); color: var(--ink); font-family: var(--sans); line-height: 1.5; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 880px; margin: 0 auto; padding: 24px 20px 80px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.topbar { display: flex; align-items: center; gap: 14px; padding: 8px 2px 20px; }
.brand { font-weight: 700; font-size: 18px; }
.brand small { color: var(--ink-faint); font-weight: 500; }
.searchbox { flex: 1; display: flex; align-items: center; gap: 10px;
  background: var(--card); border: 1px solid var(--line); border-radius: 999px;
  padding: 6px 6px 6px 16px; }
.searchbox input { border: 0; outline: 0; flex: 1; font-size: 15px; background: transparent; color: var(--ink); }
.searchbox button { border: 0; background: var(--accent); color: white; padding: 8px 14px;
  border-radius: 999px; font-weight: 600; cursor: pointer; }
.lead { font-family: var(--serif); font-size: 20px; color: var(--ink-soft); margin: 6px 2px 18px; }
.lead b { color: var(--ink); font-weight: 600; }
.cards { display: flex; flex-direction: column; gap: 14px; }
.hit { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  padding: 18px 20px; }
.hit .claim { font-weight: 600; font-size: 16px; margin: 0 0 10px; }
.hit blockquote { margin: 0; padding: 10px 14px; border-left: 3px solid var(--accent-soft);
  background: var(--paper-2); border-radius: 0 8px 8px 0; font-family: var(--serif); font-size: 16px; }
.hit .meta { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center;
  margin-top: 12px; font-size: 13px; color: var(--ink-faint); }
.hit .meta .src { color: var(--ink-soft); }
.hit .meta .open { margin-left: auto; }
.hit .expand { margin-top: 12px; cursor: pointer; background: transparent; border: 0;
  color: var(--accent); font-size: 13px; font-weight: 600; padding: 0; }
.related { margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--line); }
.related h4 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase;
  letter-spacing: .06em; color: var(--ink-faint); }
.related .r { font-size: 14px; padding: 6px 0; border-bottom: 1px solid var(--paper-2); }
.related .r:last-child { border-bottom: 0; }
.related .r a { color: var(--accent); }
.empty-state { color: var(--ink-soft); font-family: var(--serif); font-size: 17px; padding: 12px 2px; }
.foot { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line);
  font-size: 12.5px; color: var(--ink-faint); line-height: 1.6; }
.foot p { margin: 4px 0; }
`;

// On-demand related-principles expander. Fetches /api/related lazily when the
// user clicks; guards against duplicate fetches (loaded flag on the wrapper).
// No frameworks — a minimal script keeps the page LLM-free and JS-lite.
const CLIENT_SCRIPT = `
document.addEventListener('click', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLElement)) return;
  var trigger = target.closest('[data-expander="related"]');
  if (!trigger) return;
  var principleId = trigger.getAttribute('data-principle-id');
  if (!principleId) return;
  var panel = document.querySelector('[data-related-for="' + CSS.escape(principleId) + '"]');
  if (!panel) return;
  var expanded = trigger.getAttribute('aria-expanded') === 'true';
  if (expanded) {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    return;
  }
  trigger.setAttribute('aria-expanded', 'true');
  panel.hidden = false;
  if (panel.dataset.loaded === 'true') return;
  panel.dataset.loaded = 'true';
  panel.innerHTML = '<div class="r">Loading&hellip;</div>';
  fetch('/api/related?principleId=' + encodeURIComponent(principleId))
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('fetch failed')); })
    .then(function (body) {
      var related = (body && Array.isArray(body.related)) ? body.related : [];
      if (related.length === 0) {
        panel.innerHTML = '<div class="r">No related principles.</div>';
        return;
      }
      panel.innerHTML = '<h4>Live relatedness</h4>' + related.map(function (h) {
        var claim = document.createTextNode(h.claim || '');
        var wrap = document.createElement('div');
        wrap.className = 'r';
        var a = document.createElement('a');
        a.href = '/quote/' + encodeURIComponent(h.quote && h.quote.id || '');
        a.appendChild(claim);
        wrap.appendChild(a);
        return wrap.outerHTML;
      }).join('');
    })
    .catch(function () {
      panel.innerHTML = '<div class="r">Could not load related principles.</div>';
      panel.dataset.loaded = 'false';
    });
});
`;
