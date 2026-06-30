import { describe, expect, it } from 'vitest';

import { FakeIngestProvider } from '../canon/fake-provider';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { DistilInput } from '../canon/ports';
import { ingestHtml, parseIngestHtmlArgs } from './ingest-html';

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
  const html =
    '<html><head><title>Grace</title></head><body><h1>On Grace</h1>' +
    '<p>Grace precedes obedience.</p>' +
    '<h2>The Empty Seat</h2>' +
    '<p>The empty seat is the assignment.</p>' +
    '</body></html>';

  const script = (_input: DistilInput) => [
    { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience' },
    { claim: 'The empty seat is the assignment.', quote: 'the empty seat is the assignment' },
  ];

  it('extracts → derives metadata → builds a text Source → ingests through the existing pipeline', async () => {
    const provider = new FakeIngestProvider(script);
    const repository = new InMemoryRepository();

    const { source, result } = await ingestHtml(
      { html, path: 'grace.html' },
      { provider, repository },
    );

    expect(source.title).toBe('Grace');
    expect(source.text).toContain('Grace precedes obedience.');
    expect(source.r2Key).toBeNull();
    expect(result.admitted).toBe(2);
    expect(await repository.getSource(source.id)).not.toBeNull();
  });

  it('captures h1–h3 headings into a text-headings structureMap', async () => {
    const provider = new FakeIngestProvider(script);
    const repository = new InMemoryRepository();

    const { source } = await ingestHtml(
      { html, path: 'grace.html' },
      { provider, repository },
    );

    expect(source.structureMap.kind).toBe('text-headings');
    if (source.structureMap.kind !== 'text-headings') throw new Error('unreachable');
    expect(source.structureMap.headings.map((h) => h.heading)).toEqual([
      'On Grace',
      'The Empty Seat',
    ]);
    // Each heading offset points at its first character in the cleaned text.
    for (const { offset, heading } of source.structureMap.headings) {
      expect(source.text.slice(offset, offset + heading.length)).toBe(heading);
    }
  });

  it('falls back to a "none" structureMap when no h1–h3 are present', async () => {
    const provider = new FakeIngestProvider(() => []);
    const repository = new InMemoryRepository();

    const { source } = await ingestHtml(
      { html: '<html><body><p>just body text</p></body></html>', path: 'plain.html' },
      { provider, repository },
    );

    expect(source.structureMap).toEqual({ kind: 'none' });
  });

  it('derives author/date/kind/title from the path + HTML for a dated, authored canon file', async () => {
    const provider = new FakeIngestProvider(() => []);
    const repository = new InMemoryRepository();

    const { source } = await ingestHtml(
      {
        html: '<html><body><p>body</p></body></html>',
        path: 'corpus/Moon-Books/Ahn/Ahn-060721.html',
        kind: 'sermon',
      },
      { provider, repository },
    );

    expect(source.author).toBe('Ahn');
    expect(source.date).toBe('2006-07-21');
    expect(source.kind).toBe('sermon');
    expect(source.title).toBe('Ahn');
  });

  it('re-ingesting the same HTML is idempotent (no duplicate Principles, ADR-0008)', async () => {
    const provider = new FakeIngestProvider(script);
    const repository = new InMemoryRepository();

    const first = await ingestHtml({ html, path: 'grace.html' }, { provider, repository });
    const second = await ingestHtml({ html, path: 'grace.html' }, { provider, repository });

    expect(first.source.id).toBe(second.source.id);
    expect(second.result.admitted).toBe(2);
    const hits = await repository.searchByEmbedding(
      (await provider.embed(['grace']))[0]!,
      10,
    );
    expect(hits.length).toBe(2);
  });

  it('explicit overrides win over derived metadata', async () => {
    const provider = new FakeIngestProvider(() => []);
    const repository = new InMemoryRepository();

    const { source } = await ingestHtml(
      {
        html,
        path: 'corpus/Moon-Books/Ahn/Ahn-060721.html',
        title: 'Pinned Title',
        author: 'Pinned Author',
        date: '2099-12-31',
        kind: 'article',
      },
      { provider, repository },
    );

    expect(source.title).toBe('Pinned Title');
    expect(source.author).toBe('Pinned Author');
    expect(source.date).toBe('2099-12-31');
    expect(source.kind).toBe('article');
  });
});
