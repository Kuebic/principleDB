import { describe, expect, it } from 'vitest';

import { deriveHtmlSourceMetadata } from './derive-html-metadata';

describe('deriveHtmlSourceMetadata — author from immediate parent dir', () => {
  it('takes the immediate parent directory name as author', () => {
    const meta = deriveHtmlSourceMetadata({
      path: 'corpus/Moon-Books/Ahn/Ahn-060721.html',
      html: '<html><body><p>x</p></body></html>',
    });
    expect(meta.author).toBe('Ahn');
  });

  it('returns an empty author string when the file sits at the repo root', () => {
    expect(
      deriveHtmlSourceMetadata({ path: 'lone.html', html: '<html><body></body></html>' }).author,
    ).toBe('');
  });
});

describe('deriveHtmlSourceMetadata — date from trailing filename token', () => {
  it('parses -YYMMDD with century pivot (00–30 → 20xx)', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'corpus/Moon-Books/Ahn/Ahn-060721.html',
        html: '<html><body></body></html>',
      }).date,
    ).toBe('2006-07-21');
  });

  it('parses -YYMMDD with century pivot (31–99 → 19xx)', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'corpus/Sermons/Talk-700415.html',
        html: '<html><body></body></html>',
      }).date,
    ).toBe('1970-04-15');
  });

  it('parses -YYYYMMDD (explicit 4-digit year)', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'corpus/Moon-Books/Recent/Talk-20250206.html',
        html: '<html><body></body></html>',
      }).date,
    ).toBe('2025-02-06');
  });

  it('treats century pivot at the boundaries: 30 → 2030, 31 → 1931', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'x/Talk-300101.html',
        html: '<html><body></body></html>',
      }).date,
    ).toBe('2030-01-01');
    expect(
      deriveHtmlSourceMetadata({
        path: 'x/Talk-310101.html',
        html: '<html><body></body></html>',
      }).date,
    ).toBe('1931-01-01');
  });

  it('omits date entirely when the filename has no recognizable trailing token', () => {
    const meta = deriveHtmlSourceMetadata({
      path: 'corpus/Foo/Introduction.html',
      html: '<html><body></body></html>',
    });
    expect(meta.date).toBeUndefined();
  });

  it('omits date when the trailing digits do not form a valid calendar date', () => {
    // Month 13 — not parseable, must NOT be fabricated.
    expect(
      deriveHtmlSourceMetadata({
        path: 'x/Talk-251301.html',
        html: '<html><body></body></html>',
      }).date,
    ).toBeUndefined();
    // Day 32 — not parseable.
    expect(
      deriveHtmlSourceMetadata({
        path: 'x/Talk-20250232.html',
        html: '<html><body></body></html>',
      }).date,
    ).toBeUndefined();
  });

  it('does not match 4-digit or 5-digit trailing tokens (too short / too long for a date)', () => {
    expect(
      deriveHtmlSourceMetadata({ path: 'x/Talk-2025.html', html: '<html></html>' }).date,
    ).toBeUndefined();
    expect(
      deriveHtmlSourceMetadata({ path: 'x/Talk-12345.html', html: '<html></html>' }).date,
    ).toBeUndefined();
    expect(
      deriveHtmlSourceMetadata({ path: 'x/Talk-1234567.html', html: '<html></html>' }).date,
    ).toBeUndefined();
  });
});

describe('deriveHtmlSourceMetadata — title preference', () => {
  it('prefers the HTML <title> when present', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'corpus/Ahn/Ahn-060721.html',
        html: '<html><head><title>On Grace</title></head><body><h1>Sermon</h1></body></html>',
      }).title,
    ).toBe('On Grace');
  });

  it('falls back to the first <h1> when <title> is missing or empty', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'corpus/Ahn/Ahn-060721.html',
        html: '<html><body><h1>Sermon Title</h1><p>x</p></body></html>',
      }).title,
    ).toBe('Sermon Title');
  });

  it('falls back to a humanized filename WITH the date token stripped', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'corpus/Ahn/Ahn-060721.html',
        html: '<html><body><p>x</p></body></html>',
      }).title,
    ).toBe('Ahn');
    expect(
      deriveHtmlSourceMetadata({
        path: 'corpus/Foo/Chapter_One-20250206.html',
        html: '<html><body></body></html>',
      }).title,
    ).toBe('Chapter One');
  });

  it('falls back to a humanized filename unchanged when there is no date token', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'corpus/Foo/Introduction.html',
        html: '<html><body></body></html>',
      }).title,
    ).toBe('Introduction');
  });
});

describe('deriveHtmlSourceMetadata — kind', () => {
  it('uses defaultKind when provided', () => {
    expect(
      deriveHtmlSourceMetadata({
        path: 'x/Talk-060721.html',
        html: '<html></html>',
        defaultKind: 'sermon',
      }).kind,
    ).toBe('sermon');
  });

  it('defaults kind to "book" when no defaultKind is given', () => {
    expect(deriveHtmlSourceMetadata({ path: 'x/y.html', html: '<html></html>' }).kind).toBe('book');
  });
});
