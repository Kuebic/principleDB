// Public Canon search page renderer — Slice W2 (#47, #40).
// Pure HTML rendering, no side effects, no LLM. Search results are grounded
// quote cards (claim + Source's own words + citation).

import { describe, expect, it } from 'vitest';
import type { WorkWithFigure } from '../canon/ports';
import type { SearchPrinciplesResponse } from '../mcp/search-principles-tool';
import { renderSearchPage } from './render-search-page';

const oneHit: SearchPrinciplesResponse = {
  hits: [
    {
      principleId: 'serm1#opus#p0',
      claim: 'Grace precedes obedience.',
      score: 0.91,
      source: {
        id: 'serm1',
        title: 'Grace and obedience',
        author: 'Pastor X',
        kind: 'sermon',
        work: null,
        figure: null,
        edition: null,
      },
      quote: {
        id: 'serm1#opus#q0',
        text: 'Grace precedes obedience.',
        label: 'page 4',
        span: { start: 0, end: 24 },
      },
      quoteCount: 1,
    },
  ],
};

const oneHitWithWork: SearchPrinciplesResponse = {
  hits: [
    {
      principleId: 'csg#opus#p0',
      claim: 'Grace precedes obedience.',
      score: 0.91,
      source: {
        id: 's_csg',
        title: 'CSG chapter 1',
        author: 'SunMyungMoon-CSG',
        kind: 'book',
        work: { title: 'Cheon Seong Gyeong' },
        figure: { displayName: 'Sun Myung Moon' },
        edition: { label: '2013 Revised' },
      },
      quote: {
        id: 'csg#opus#q0',
        text: 'Grace precedes obedience.',
        label: 'page 4',
        span: { start: 0, end: 24 },
      },
      quoteCount: 1,
    },
  ],
};

const listings: WorkWithFigure[] = [
  {
    work: { id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' },
    figure: { id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' },
  },
  {
    work: { id: 'work_dp', title: 'Divine Principle', figureId: 'fig_smm', tier: 'core' },
    figure: { id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' },
  },
  {
    work: { id: 'work_tm', title: 'True Mother Anthology', figureId: 'fig_hjh', tier: 'core' },
    figure: { id: 'fig_hjh', slug: 'hak-ja-han', displayName: 'Hak Ja Han' },
  },
  {
    work: { id: 'work_later', title: 'Later Speeches', figureId: 'fig_hjh', tier: 'extra' },
    figure: { id: 'fig_hjh', slug: 'hak-ja-han', displayName: 'Hak Ja Han' },
  },
];

describe('renderSearchPage', () => {
  it('sets meta robots=noindex on every page (public site, unlisted)', () => {
    const html = renderSearchPage({});
    expect(html).toMatch(/<meta[^>]+name=["']robots["'][^>]+content=["']noindex["']/i);
  });

  it('always renders a search box that submits to itself with the `q` param', () => {
    const html = renderSearchPage({});
    expect(html).toMatch(/<form[^>]*>[\s\S]*name=["']q["']/);
    expect(html).toMatch(/method=["']get["']/i);
  });

  it('when no query, shows landing copy — no cards, no lead-in', () => {
    const html = renderSearchPage({});
    expect(html).not.toMatch(/class=["']hit["']/);
    expect(html).not.toMatch(/class=["']lead["']/);
  });

  it('when query but zero hits, tells the reader nothing was found', () => {
    const html = renderSearchPage({ query: 'nothing', response: { hits: [] } });
    expect(html.toLowerCase()).toContain('no results');
    expect(html).not.toMatch(/class=["']hit["']/);
  });

  it('renders one card per hit — claim, quote text, citation', () => {
    const html = renderSearchPage({ query: 'grace', response: oneHit });
    expect(html).toContain('Grace precedes obedience.');
    expect(html).toContain('Grace and obedience');
    expect(html).toContain('page 4');
  });

  it('shows the answer-shaped lead-in above hits (#40)', () => {
    const html = renderSearchPage({ query: 'grace', response: oneHit });
    expect(html).toMatch(/class=["']lead["']/);
  });

  it('links each hit to the Reader at /quote/{quoteId} (issue #48 target)', () => {
    const html = renderSearchPage({ query: 'grace', response: oneHit });
    // quoteId is percent-encoded so the `#` in `serm1#opus#q0` doesn't get
    // eaten as a URL fragment. The Reader (#48) decodes it back.
    expect(html).toContain(`href="/quote/${encodeURIComponent('serm1#opus#q0')}"`);
    expect(html.toLowerCase()).toContain('read in context');
  });

  it('mounts an on-demand related expander per hit (data attribute keyed to principleId)', () => {
    // The expander must NOT eagerly render related items — it fetches
    // /api/related?principleId=... only when the user clicks (#47 acceptance).
    const html = renderSearchPage({ query: 'grace', response: oneHit });
    expect(html).toContain('data-principle-id="serm1#opus#p0"');
    expect(html).toMatch(/data-expander|data-related/);
    // Client-side fetcher points at /api/related — the endpoint the app exposes.
    expect(html).toContain('/api/related');
  });

  it('has the attribution + removal-contact footer on every page (public-face invariant)', () => {
    const html = renderSearchPage({});
    expect(html.toLowerCase()).toMatch(/shared for study/);
    expect(html.toLowerCase()).toMatch(/removals?@/);
  });

  it('escapes HTML in the rendered query and hit text (no XSS)', () => {
    const evil: SearchPrinciplesResponse = {
      hits: [
        {
          principleId: 'p<script>',
          claim: '<script>alert(1)</script>',
          score: 0.5,
          source: {
            id: 's',
            title: '<b>X</b>',
            author: 'A&B',
            kind: 'sermon',
            work: null,
            figure: null,
            edition: null,
          },
          quote: {
            id: 'q<script>',
            text: '<img onerror=1>',
            label: 'page 1',
            span: { start: 0, end: 1 },
          },
          quoteCount: 1,
        },
      ],
    };
    const html = renderSearchPage({ query: '<script>evil</script>', response: evil });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>evil</script>');
    expect(html).not.toContain('<img onerror=1>');
    expect(html).toContain('&lt;script&gt;');
    // href must be a safe URL — quoteId containing `<` should be percent-encoded.
    expect(html).not.toMatch(/href="\/quote\/q<script>/);
  });

  it('renders a Figure-grouped picker collapsed by default (a <details> without `open`)', () => {
    const html = renderSearchPage({ works: listings });
    const details = /<details\b([^>]*)>/i.exec(html);
    expect(details).not.toBeNull();
    // Default closed — the `open` attribute must be absent from the opener.
    expect(details![1]!.toLowerCase()).not.toMatch(/\bopen\b/);
    // Grouped by Figure — each Figure's display name appears.
    expect(html).toContain('Sun Myung Moon');
    expect(html).toContain('Hak Ja Han');
    // Per-Figure "select all" controls, one per Figure.
    expect(html.match(/data-select-all-figure=/g)?.length).toBe(2);
  });

  it('with no explicit scope: core Works are pre-checked, extra Works listed unchecked', () => {
    const html = renderSearchPage({ works: listings });
    // Each core Work has a checked checkbox with name="work" and its id as value.
    for (const id of ['work_csg', 'work_dp', 'work_tm']) {
      expect(html).toMatch(
        new RegExp(`<input[^>]*name=["']work["'][^>]*value=["']${id}["'][^>]*checked`, 'i'),
      );
    }
    // The extra Work is present but not checked.
    expect(html).toMatch(
      /<input[^>]*name=["']work["'][^>]*value=["']work_later["']/i,
    );
    const laterInput = /<input[^>]*value=["']work_later["'][^>]*>/i.exec(html)?.[0] ?? '';
    expect(laterInput.toLowerCase()).not.toMatch(/\bchecked\b/);
  });

  it('with an explicit scope: only Works in the scope are pre-checked', () => {
    const html = renderSearchPage({
      works: listings,
      scope: { works: ['work_csg', 'work_later'] },
    });
    const inputFor = (id: string): string =>
      new RegExp(`<input[^>]*value=["']${id}["'][^>]*>`, 'i').exec(html)?.[0] ?? '';
    expect(inputFor('work_csg').toLowerCase()).toMatch(/\bchecked\b/);
    expect(inputFor('work_later').toLowerCase()).toMatch(/\bchecked\b/);
    expect(inputFor('work_dp').toLowerCase()).not.toMatch(/\bchecked\b/);
    expect(inputFor('work_tm').toLowerCase()).not.toMatch(/\bchecked\b/);
  });

  it('with a Figure scope: every Work under that Figure is pre-checked (Figure expands)', () => {
    const html = renderSearchPage({
      works: listings,
      scope: { figures: ['fig_hjh'] },
    });
    const inputFor = (id: string): string =>
      new RegExp(`<input[^>]*value=["']${id}["'][^>]*>`, 'i').exec(html)?.[0] ?? '';
    expect(inputFor('work_tm').toLowerCase()).toMatch(/\bchecked\b/);
    expect(inputFor('work_later').toLowerCase()).toMatch(/\bchecked\b/);
    expect(inputFor('work_csg').toLowerCase()).not.toMatch(/\bchecked\b/);
    expect(inputFor('work_dp').toLowerCase()).not.toMatch(/\bchecked\b/);
  });

  it('renders citations as Work title + Figure — the raw author slug does not appear', () => {
    const html = renderSearchPage({ query: 'grace', response: oneHitWithWork });
    expect(html).toContain('Cheon Seong Gyeong');
    expect(html).toContain('Sun Myung Moon');
    // The ingest-time author slug must NOT surface in the rendered citation.
    expect(html).not.toContain('SunMyungMoon-CSG');
  });

  it('names the Edition label alongside the Work title so a contested recension is visible (#62)', () => {
    const html = renderSearchPage({ query: 'grace', response: oneHitWithWork });
    expect(html).toContain('2013 Revised');
    // The Edition label sits with the Work title in the same citation block,
    // BEFORE the Figure name.
    const editionIdx = html.indexOf('2013 Revised');
    const figureIdx = html.indexOf('Sun Myung Moon');
    expect(editionIdx).toBeGreaterThan(-1);
    expect(figureIdx).toBeGreaterThan(-1);
    expect(editionIdx).toBeLessThan(figureIdx);
  });

  it('falls back to the Source title when Work/Figure are unset (backfill window) — no raw slug leak', () => {
    // oneHit uses author "Pastor X" and no Work/Figure. The citation should
    // still avoid surfacing that raw author string once Work/Figure become the
    // canonical citation fields.
    const html = renderSearchPage({ query: 'grace', response: oneHit });
    expect(html).toContain('Grace and obedience');
    expect(html).not.toContain('Pastor X');
  });

  it('renders "+ N more sources" control iff quoteCount > 1, above the related expander (#63/#64)', () => {
    const multi: SearchPrinciplesResponse = {
      hits: [
        {
          principleId: 'p_multi',
          claim: 'Attested many times.',
          score: 0.8,
          source: {
            id: 's1',
            title: 'First Source',
            author: 'x',
            kind: 'book',
            work: { title: 'Cheon Seong Gyeong' },
            figure: { displayName: 'Sun Myung Moon' },
            edition: null,
          },
          quote: {
            id: 'q_lead',
            text: 'Attested many times.',
            label: 'page 1',
            span: { start: 0, end: 20 },
          },
          quoteCount: 4,
        },
      ],
    };
    const html = renderSearchPage({ query: 'grace', response: multi });
    // The button text carries N = quoteCount - 1 (extras beyond the lead).
    expect(html).toMatch(/[+＋]\s*3\s+more\s+sources/i);
    // The extras control sits before the related expander in the DOM.
    const extraIdx = html.search(/[+＋]\s*3\s+more\s+sources/i);
    const relatedIdx = html.indexOf('related principles');
    expect(extraIdx).toBeGreaterThan(-1);
    expect(relatedIdx).toBeGreaterThan(-1);
    expect(extraIdx).toBeLessThan(relatedIdx);
    // The control carries the principle id so the client can fetch its extras.
    expect(html).toContain('data-principle-id="p_multi"');
    // The button records the initial extras count so the client can decrement
    // it as batches load without re-parsing the visible label (#66).
    expect(html).toContain('data-total-extras="3"');
  });

  it('ships the extras-expander busy indicator so the ~5-10s fetch does not read as frozen', () => {
    // Behavioral seam is the embedded CLIENT_SCRIPT (no DOM harness in this
    // suite), so assert the wiring is present: the spinner CSS, the busy
    // attribute the client toggles, and the pending label it swaps in.
    const html = renderSearchPage({ query: 'grace', response: oneHit });
    expect(html).toContain('.more-sources .spin');
    expect(html).toContain("setAttribute('aria-busy', 'true')");
    expect(html).toContain('Collecting sources');
    // The error path must restore the original label so a failed load is retryable.
    expect(html).toContain('trigger.textContent = originalLabel');
  });

  it('renders NO "+ N more sources" control when quoteCount === 1 (#63/#64)', () => {
    const html = renderSearchPage({ query: 'grace', response: oneHit });
    // The rendered button is uniquely identified by its class; both label
    // fragments and data-attribute selectors appear inside the client script
    // as literals, so we assert on the button-only marker.
    expect(html).not.toContain('class="more-sources"');
  });

  it('client script wires the extras expander to /api/quotes with safe DOM (#66)', () => {
    const html = renderSearchPage({});
    // The click handler targets the extras expander control.
    expect(html).toContain('data-expander="quotes"');
    // The fetch URL is /api/quotes (mirrors the related expander wiring).
    expect(html).toContain('/api/quotes?principleId=');
    // Safe DOM construction is used for extras — createElement + textContent,
    // never HTML string concatenation of Source text (#66 acceptance criterion).
    const buildFn = /function buildExtraQuoteNode[\s\S]*?\n\}/.exec(html);
    expect(buildFn).not.toBeNull();
    expect(buildFn![0]).toContain('createElement');
    expect(buildFn![0]).toContain('textContent');
    expect(buildFn![0]).not.toMatch(/\binnerHTML\b/);
  });

  it('does NOT eagerly render "related principles" list items (only the expander control)', () => {
    // If related items were pre-rendered, we would see the actual claim text
    // of neighbours in the HTML. Slice W2's rule: fetch on click, not eager.
    const html = renderSearchPage({ query: 'grace', response: oneHit });
    // We only assert the expander is present and that no pre-rendered related
    // items sit inside a `.related` container. An empty placeholder is fine.
    const relatedOpen = /<[^>]+class=["'][^"']*related[^"']*["'][^>]*>/i.exec(html);
    if (relatedOpen) {
      // slice from the opener forward and confirm the container is empty
      // of `<li>`/`<div class="r">` seed content until its close.
      const rest = html.slice(relatedOpen.index + relatedOpen[0].length);
      const closeIdx = rest.indexOf('</');
      const inside = rest.slice(0, closeIdx);
      expect(inside).not.toMatch(/<li>|<div[^>]*class=["']r["']/);
    }
  });
});
