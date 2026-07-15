// Public Canon search page renderer — Slice W2 (#47, #40).
// Pure HTML rendering, no side effects, no LLM. Search results are grounded
// quote cards (claim + Source's own words + citation).

import { describe, expect, it } from 'vitest';
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
      },
      quote: {
        id: 'serm1#opus#q0',
        text: 'Grace precedes obedience.',
        label: 'page 4',
        span: { start: 0, end: 24 },
      },
    },
  ],
};

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
    expect(html).toContain('Pastor X');
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
          },
          quote: {
            id: 'q<script>',
            text: '<img onerror=1>',
            label: 'page 1',
            span: { start: 0, end: 1 },
          },
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
