import { describe, expect, it } from 'vitest';
import type { QuoteReaderHit } from '../canon/quote-in-context';
import { renderReaderNotFound, renderReaderPage } from './render-reader-page';

const HELLO_QUOTE = 'Grace precedes obedience.';

function withSource(overrides: Partial<QuoteReaderHit['source']> = {}): QuoteReaderHit {
  const text = `${HELLO_QUOTE} We are loved first, and our obedience flows from being loved.`;
  return {
    found: true,
    source: {
      id: 'serm1',
      title: 'Grace and obedience',
      author: 'Pastor X',
      kind: 'sermon',
      text,
      structureMap: { kind: 'none' },
      ...overrides,
    },
    principle: {
      id: 'p_001',
      claim: 'Grace precedes obedience.',
    },
    quote: {
      id: 'q_001',
      span: { start: 0, end: HELLO_QUOTE.length },
      label: '~0% in',
      matchTier: 'exact',
    },
  };
}

describe('renderReaderPage (Variant D — sticky outline + full source)', () => {
  it('highlights the target quote as <mark id="quote"> at the located span', () => {
    const html = renderReaderPage(withSource());
    expect(html).toContain(`<mark id="quote">${HELLO_QUOTE}</mark>`);
  });

  it('marks the page noindex and includes the removal-contact footer', () => {
    const html = renderReaderPage(withSource());
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toContain('removals@principledb.example');
    expect(html.toLowerCase()).toContain('shared for study');
  });

  it('renders section links from a text-headings structureMap', () => {
    const html = renderReaderPage(
      withSource({
        text: 'Intro paragraph.\n\nSection: Grace\n\nGrace is unearned. Love comes first.',
        structureMap: {
          kind: 'text-headings',
          headings: [
            { offset: 0, heading: 'Intro' },
            { offset: 18, heading: 'Section: Grace' },
          ],
        },
      }),
    );
    expect(html).toContain('href="#sec-0"');
    expect(html).toContain('href="#sec-1"');
    expect(html).toContain('Section: Grace');
    expect(html).toContain('data-spy="sec-0"');
  });

  it('emits per-page section markers from a pdf-pages structureMap', () => {
    const html = renderReaderPage(
      withSource({
        text: 'page one text here.\nand more on page two now.',
        structureMap: {
          kind: 'pdf-pages',
          pages: [
            { offset: 0, page: 1 },
            { offset: 20, page: 2 },
          ],
        },
      }),
    );
    expect(html).toContain('page 1');
    expect(html).toContain('page 2');
    expect(html).toContain('id="sec-0"');
    expect(html).toContain('id="sec-1"');
  });

  it('provides a text-fragment share link containing the quote text', () => {
    const html = renderReaderPage(withSource());
    expect(html).toContain(`href="#:~:text=${encodeURIComponent(HELLO_QUOTE)}"`);
  });

  it('renders a back-to-results link honouring the back option', () => {
    const html = renderReaderPage(withSource(), { back: '/?q=grace' });
    expect(html).toContain('href="/?q=grace"');
    expect(html.toLowerCase()).toContain('back to results');
  });

  it('escapes quote content so a source with < > &c cannot break out of the mark', () => {
    const evil = 'a<script>alert(1)</script>b';
    const html = renderReaderPage({
      found: true,
      source: {
        id: 's',
        title: 'T',
        author: 'A',
        kind: 'article',
        text: evil,
        structureMap: { kind: 'none' },
      },
      principle: { id: 'p', claim: 'C' },
      quote: {
        id: 'q',
        span: { start: 0, end: evil.length },
        label: '~0% in',
        matchTier: 'exact',
      },
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderReaderNotFound', () => {
  it('is noindex and offers a back link', () => {
    const html = renderReaderNotFound({ back: '/?q=x' });
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toContain('href="/?q=x"');
    expect(html.toLowerCase()).toContain('not be found');
  });
});
