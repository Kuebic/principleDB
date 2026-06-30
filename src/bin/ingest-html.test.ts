import { describe, expect, it } from 'vitest';

import { FakeIngestProvider } from '../canon/fake-provider';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { DistilInput } from '../canon/ports';
import {
  deriveHtmlTitle,
  humanizeFilename,
  ingestHtml,
  parseIngestHtmlArgs,
} from './ingest-html';

describe('deriveHtmlTitle', () => {
  it('prefers the <title> element when present', () => {
    const html = '<html><head><title>On Grace</title></head><body><h1>Sermon</h1></body></html>';
    expect(deriveHtmlTitle(html, 'fallback')).toBe('On Grace');
  });

  it('falls back to the first <h1> when <title> is missing or empty', () => {
    expect(
      deriveHtmlTitle('<html><body><h1>Sermon Title</h1><p>x</p></body></html>', 'fb'),
    ).toBe('Sermon Title');
    expect(
      deriveHtmlTitle(
        '<html><head><title></title></head><body><h1>Sermon Title</h1></body></html>',
        'fb',
      ),
    ).toBe('Sermon Title');
  });

  it('falls back to the humanized filename when neither <title> nor <h1> is present', () => {
    expect(deriveHtmlTitle('<html><body><p>x</p></body></html>', 'on-grace_part_1.html')).toBe(
      'on grace part 1',
    );
  });

  it('trims whitespace and entities in the chosen title', () => {
    const html = '<html><head><title>   On &amp; Grace   </title></head><body></body></html>';
    expect(deriveHtmlTitle(html, 'fb')).toBe('On & Grace');
  });
});

describe('humanizeFilename', () => {
  it('drops the extension and turns separators into spaces', () => {
    expect(humanizeFilename('on-grace_part_1.html')).toBe('on grace part 1');
    expect(humanizeFilename('Ahn-060721.htm')).toBe('Ahn 060721');
  });

  it('returns the input unchanged when there is no extension', () => {
    expect(humanizeFilename('Default')).toBe('Default');
  });
});

describe('parseIngestHtmlArgs', () => {
  it('takes the first positional as the file path', () => {
    expect(parseIngestHtmlArgs(['doc.html']).file).toBe('doc.html');
  });

  it('parses --title/--author/--kind/--date flags', () => {
    const args = parseIngestHtmlArgs([
      'doc.html',
      '--title',
      'On Grace',
      '--author',
      'A. Preacher',
      '--kind',
      'sermon',
      '--date',
      '2026-06-23',
    ]);
    expect(args).toEqual({
      file: 'doc.html',
      title: 'On Grace',
      author: 'A. Preacher',
      kind: 'sermon',
      date: '2026-06-23',
    });
  });

  it('throws on a missing file argument', () => {
    expect(() => parseIngestHtmlArgs([])).toThrow(/usage/);
  });

  it('throws on an unknown --kind', () => {
    expect(() => parseIngestHtmlArgs(['doc.html', '--kind', 'novel'])).toThrow(
      /--kind must be one of/,
    );
  });
});

describe('ingestHtml', () => {
  // The HTML extractor produces plain text the FakeIngestProvider can match
  // against; the rest of the pipeline (admit, embed, dedup, persist) is reused
  // through ingestText — this test pins the end-to-end seam.
  const text = 'Grace precedes obedience. The empty seat is the assignment.';
  const html =
    '<html><head><title>Grace</title></head><body><h1>On Grace</h1>' +
    '<p>Grace precedes obedience.</p>' +
    '<p>The empty seat is the assignment.</p>' +
    '</body></html>';

  const script = (_input: DistilInput) => [
    { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience' },
    { claim: 'The empty seat is the assignment.', quote: 'the empty seat is the assignment' },
  ];

  it('extracts → builds a text Source → ingests through the existing pipeline', async () => {
    const provider = new FakeIngestProvider(script);
    const repository = new InMemoryRepository();

    const { source, result } = await ingestHtml(
      { html, filename: 'grace.html' },
      { provider, repository },
    );

    expect(source.title).toBe('Grace');
    expect(source.text).toContain('Grace precedes obedience.');
    expect(source.r2Key).toBeNull();
    expect(source.structureMap).toEqual({ kind: 'none' });
    expect(result.admitted).toBe(2);
    expect(await repository.getSource(source.id)).not.toBeNull();
  });

  it('re-ingesting the same HTML is idempotent (no duplicate Principles, ADR-0008)', async () => {
    const provider = new FakeIngestProvider(script);
    const repository = new InMemoryRepository();

    const first = await ingestHtml({ html, filename: 'grace.html' }, { provider, repository });
    const second = await ingestHtml({ html, filename: 'grace.html' }, { provider, repository });

    expect(first.source.id).toBe(second.source.id);
    // Same Source id + same provenance → the slot is replaced, not appended.
    expect(second.result.admitted).toBe(2);
    const hits = await repository.searchByEmbedding(
      (await provider.embed(['grace']))[0]!,
      10,
    );
    expect(hits.length).toBe(2);
  });

  it('uses the explicit --title override when given', async () => {
    const provider = new FakeIngestProvider(() => []);
    const repository = new InMemoryRepository();

    const { source } = await ingestHtml(
      { html, filename: 'grace.html', title: 'Pinned Title' },
      { provider, repository },
    );

    expect(source.title).toBe('Pinned Title');
  });
});
