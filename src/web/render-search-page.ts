// Public Canon search page — Slice W2 (#47, #40, ADR-0015) + Slice W57
// (source-filtering picker + URL-param scope, ADR-0017).
// Server-rendered HTML over `SearchPrinciplesResponse`. LLM-free: hits are
// grounded quote cards (Principle claim + Source's own words + citation).
// The "related principles" expander is DEFERRED — the browser fetches
// /api/related?principleId=... only when the user clicks (map Out-of-scope
// pre-eager rendering, #47).
//
// The Figure-grouped picker (issue #57) lives inside the existing GET form so
// submitting it re-runs the same route with `?work=`/`?figure=` params — no
// cookie, no client state, so a scoped search is bookmarkable/shareable. The
// picker is collapsed by default (a plain <details> element) so the page
// stays simple when a member just wants to search everything.
//
// This module is a pure renderer: takes the query + response + Works listing
// + scope and returns HTML. The route handler (app.ts) parses the URL,
// resolves the scope, and calls the core search directly (ADR-0015).

import type { WorkWithFigure } from '../canon/ports';
import type { Scope } from '../canon/scope';
import type { SearchHitResponse, SearchPrinciplesResponse } from '../mcp/search-principles-tool';

export interface RenderSearchPageOptions {
  query?: string;
  response?: SearchPrinciplesResponse;
  // Every Work + its Figure, so the picker can render the full list of
  // searchable Works grouped by Figure. When omitted, the picker is not
  // rendered (keeps tests that predate the picker green).
  works?: readonly WorkWithFigure[];
  // The current scope decoded from the URL. Absent (or empty) ⇒ picker
  // pre-checks `core` Works; explicit `works` / `figures` pre-checks exactly
  // that set (Figures expand to their Works).
  scope?: Scope;
}

export function renderSearchPage(options: RenderSearchPageOptions = {}): string {
  const query = options.query?.trim() ?? '';
  const response = options.response;
  const works = options.works ?? [];
  const scope = options.scope ?? {};

  const results = renderResults(query, response);
  const picker = works.length > 0 ? renderPicker(works, scope) : '';

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
      ${picker}
    </form>
    <a class="connect-link" href="/connect">connect your AI &rarr;</a>
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
  // Citation prefers the joined Work + Figure (ADR-0017) so the ingest-time
  // author slug (e.g. `SunMyungMoon-CSG`, DP part-slugs) never surfaces. The
  // Source title is the fallback for the backfill window (a Source not yet
  // assigned a Work); the raw `author` is intentionally never rendered.
  const workTitle = hit.source.work?.title ?? hit.source.title;
  const figureName = hit.source.figure?.displayName ?? '';
  const attribution = figureName
    ? `<i>${escapeHtml(workTitle)}</i> &middot; ${escapeHtml(figureName)}`
    : `<i>${escapeHtml(workTitle)}</i>`;
  return `<article class="hit">
    <p class="claim">${escapeHtml(hit.claim)}</p>
    <blockquote>&ldquo;${escapeHtml(hit.quote.text)}&rdquo;</blockquote>
    <div class="meta">
      <span class="src">${attribution} &middot;
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

// Figure-grouped, collapsible picker (issue #57). Rendered inside the GET
// form so submitting bakes the selection into the URL as repeated `work=` /
// `figure=` params — no cookie, shareable/bookmarkable.
//
// Which boxes start checked (ADR-0017):
//   • no explicit scope ⇒ all `core` Works
//   • `scope.works` present ⇒ exactly those Work ids
//   • `scope.figures` present ⇒ expand to every Work under the named Figure
// Both are unioned. Extras stay unchecked unless explicitly named.
function renderPicker(works: readonly WorkWithFigure[], scope: Scope): string {
  const checkedIds = pickCheckedWorkIds(works, scope);
  const groups = groupByFigure(works);

  const figureBlocks = groups
    .map(({ figure, works: figureWorks }) => {
      const items = figureWorks
        .map((w) => {
          const checked = checkedIds.has(w.id) ? ' checked' : '';
          const tierBadge = w.tier === 'extra'
            ? ` <span class="tier tier-extra">extra</span>`
            : '';
          return `<li><label class="pick">
            <input type="checkbox" name="work" value="${escapeAttribute(w.id)}"${checked} />
            <span class="work-title">${escapeHtml(w.title)}</span>${tierBadge}
          </label></li>`;
        })
        .join('');
      return `<section class="fig-group">
        <header class="fig-head">
          <label class="pick">
            <input type="checkbox" data-select-all-figure="${escapeAttribute(figure.id)}" />
            <span class="fig-name">${escapeHtml(figure.displayName)}</span>
          </label>
        </header>
        <ul class="works">${items}</ul>
      </section>`;
    })
    .join('');

  return `<details class="picker">
    <summary>Choose what to search</summary>
    <div class="picker-body">
      ${figureBlocks}
    </div>
  </details>`;
}

function groupByFigure(
  works: readonly WorkWithFigure[],
): Array<{ figure: WorkWithFigure['figure']; works: WorkWithFigure['work'][] }> {
  const groups = new Map<
    string,
    { figure: WorkWithFigure['figure']; works: WorkWithFigure['work'][] }
  >();
  for (const { work, figure } of works) {
    let g = groups.get(figure.id);
    if (!g) {
      g = { figure, works: [] };
      groups.set(figure.id, g);
    }
    g.works.push(work);
  }
  return [...groups.values()];
}

function pickCheckedWorkIds(
  works: readonly WorkWithFigure[],
  scope: Scope,
): Set<string> {
  const scopedWorks = scope.works ?? [];
  const scopedFigures = scope.figures ?? [];
  if (scopedWorks.length === 0 && scopedFigures.length === 0) {
    return new Set(works.filter((l) => l.work.tier === 'core').map((l) => l.work.id));
  }
  const chosen = new Set<string>();
  const validWorkIds = new Set(works.map((l) => l.work.id));
  for (const id of scopedWorks) {
    if (validWorkIds.has(id)) chosen.add(id);
  }
  if (scopedFigures.length > 0) {
    const wanted = new Set(scopedFigures);
    for (const l of works) {
      if (wanted.has(l.figure.id) || wanted.has(l.figure.slug)) {
        chosen.add(l.work.id);
      }
    }
  }
  return chosen;
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
.connect-link { font-size: 13px; font-weight: 600; white-space: nowrap; }
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
.picker { flex-basis: 100%; margin-top: 10px; background: var(--card); border: 1px solid var(--line);
  border-radius: 10px; font-size: 14px; }
.picker > summary { list-style: none; cursor: pointer; padding: 8px 14px; color: var(--ink-soft);
  font-weight: 600; user-select: none; }
.picker > summary::-webkit-details-marker { display: none; }
.picker > summary::before { content: "\\25B8"; display: inline-block; margin-right: 8px; color: var(--ink-faint); transition: transform 120ms; }
.picker[open] > summary::before { transform: rotate(90deg); }
.picker-body { padding: 4px 14px 12px; display: flex; flex-wrap: wrap; gap: 14px; }
.fig-group { flex: 1 1 220px; min-width: 200px; }
.fig-head { border-bottom: 1px solid var(--paper-2); padding: 4px 0; margin-bottom: 4px; }
.fig-name { font-weight: 600; color: var(--ink); }
.works { list-style: none; margin: 0; padding: 0; }
.works li { padding: 3px 0; }
.pick { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--ink-soft); }
.work-title { line-height: 1.3; }
.tier { display: inline-block; padding: 1px 6px; border-radius: 999px;
  background: var(--paper-2); color: var(--ink-faint); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.tier-extra { background: var(--accent-soft); color: var(--accent); }
.foot { margin-top: 40px; padding-top: 18px; border-top: 1px solid var(--line);
  font-size: 12.5px; color: var(--ink-faint); line-height: 1.6; }
.foot p { margin: 4px 0; }
`;

// On-demand related-principles expander. Fetches /api/related lazily when the
// user clicks; guards against duplicate fetches (loaded flag on the wrapper).
// The picker's per-Figure "select all" checkbox mirrors its state onto every
// Work checkbox inside its `.fig-group` section. No frameworks — a minimal
// script keeps the page LLM-free and JS-lite.
const CLIENT_SCRIPT = `
document.addEventListener('change', function (event) {
  var target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.hasAttribute('data-select-all-figure')) return;
  var group = target.closest('.fig-group');
  if (!group) return;
  var boxes = group.querySelectorAll('input[type="checkbox"][name="work"]');
  for (var i = 0; i < boxes.length; i++) boxes[i].checked = target.checked;
});
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
