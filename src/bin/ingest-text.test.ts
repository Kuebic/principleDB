import { describe, expect, it } from 'vitest';

import { FakeIngestProvider } from '../canon/fake-provider';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { DistilInput } from '../canon/ports';
import {
  deriveTextSourceId,
  formatIngestSummary,
  ingestText,
  makeTextSource,
  parseIngestArgs,
} from './ingest-text';

describe('makeTextSource', () => {
  it('fills sensible defaults for a bare title + text', () => {
    const source = makeTextSource({ title: 'On Grace', text: 'Grace precedes obedience.' });
    expect(source.title).toBe('On Grace');
    expect(source.text).toBe('Grace precedes obedience.');
    expect(source.author).toBe('');
    expect(source.kind).toBe('book');
    expect(source.date).toBe('');
    expect(source.r2Key).toBeNull();
    expect(source.structureMap).toEqual({ kind: 'none' });
  });

  it('trims the title before deriving the id so stray whitespace is not identity', () => {
    expect(makeTextSource({ title: '  On Grace  ', text: 'x' }).title).toBe('On Grace');
    expect(makeTextSource({ title: '  On Grace  ', text: 'x' }).id).toBe(
      makeTextSource({ title: 'On Grace', text: 'x' }).id,
    );
  });

  it('derives a deterministic id from (title, text): same input → same id', () => {
    const a = makeTextSource({ title: 'On Grace', text: 'Grace precedes obedience.' });
    const b = makeTextSource({ title: 'On Grace', text: 'Grace precedes obedience.' });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^src-[0-9a-f]{8}$/);
  });

  it('changes the id when the text changes (idempotent slot vs. new Source)', () => {
    const a = makeTextSource({ title: 'On Grace', text: 'Grace precedes obedience.' });
    const b = makeTextSource({ title: 'On Grace', text: 'Obedience precedes grace.' });
    expect(a.id).not.toBe(b.id);
  });

  it('does not collide across a shifted title/text boundary', () => {
    // "ab" + "c" must not hash the same as "a" + "bc".
    expect(deriveTextSourceId('ab', 'c')).not.toBe(deriveTextSourceId('a', 'bc'));
  });

  it('respects explicit overrides', () => {
    const source = makeTextSource({
      title: 'On Grace',
      text: 'x',
      author: 'A. Preacher',
      kind: 'sermon',
      date: '2026-06-23',
      id: 'pinned-id',
    });
    expect(source.author).toBe('A. Preacher');
    expect(source.kind).toBe('sermon');
    expect(source.date).toBe('2026-06-23');
    expect(source.id).toBe('pinned-id');
  });
});

describe('ingestText', () => {
  // Distil script returns claims whose quotes are verbatim substrings of the
  // text, so the admission gate locates them and they are admitted.
  const script = (input: DistilInput) => {
    void input;
    return [
      { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience' },
      { claim: 'The empty seat is the assignment.', quote: 'the empty seat is the assignment' },
    ];
  };

  const text =
    'Grace precedes obedience. We are loved first. And the empty seat is the assignment.';

  it('persists the Source and admits located principles through the real pipeline', async () => {
    const provider = new FakeIngestProvider(script);
    const repository = new InMemoryRepository();

    const { source, result } = await ingestText({ title: 'Grace', text }, { provider, repository });

    expect(result.admitted).toBe(2);
    expect(await repository.getSource(source.id)).not.toBeNull();
  });

  it('the admitted principles are searchable afterwards (the visual-verify loop)', async () => {
    const provider = new FakeIngestProvider(script);
    const repository = new InMemoryRepository();

    await ingestText({ title: 'Grace', text }, { provider, repository });

    const [queryVec] = await provider.embed(['grace and obedience']);
    const hits = await repository.searchByEmbedding(queryVec!, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.principle.claim).toContain('Grace');
  });

  it('routes an unlocatable quote to the review queue instead of admitting it', async () => {
    const provider = new FakeIngestProvider(() => [
      { claim: 'Paraphrased teaching.', quote: 'this span is not in the source text at all' },
    ]);
    const repository = new InMemoryRepository();

    const { result } = await ingestText({ title: 'Grace', text }, { provider, repository });

    expect(result.admitted).toBe(0);
    expect(result.review).toBe(1);
  });
});

describe('parseIngestArgs', () => {
  it('takes the first positional as the file path', () => {
    expect(parseIngestArgs(['book.txt']).file).toBe('book.txt');
  });

  it('parses --title/--author/--kind/--date flags', () => {
    const args = parseIngestArgs([
      'book.txt',
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
      file: 'book.txt',
      title: 'On Grace',
      author: 'A. Preacher',
      kind: 'sermon',
      date: '2026-06-23',
    });
  });

  it('throws when no file is given', () => {
    expect(() => parseIngestArgs([])).toThrow(/usage/);
    expect(() => parseIngestArgs(['--title', 'x'])).toThrow(/usage/);
  });

  it('throws on an unknown --kind', () => {
    expect(() => parseIngestArgs(['book.txt', '--kind', 'novel'])).toThrow(/--kind must be one of/);
  });

  it('throws when a flag is missing its value', () => {
    expect(() => parseIngestArgs(['book.txt', '--title'])).toThrow(/needs a value/);
  });
});

describe('formatIngestSummary', () => {
  it('renders the title, id, and the three outcome counts', () => {
    const source = makeTextSource({ title: 'On Grace', text: 'x', id: 'src-abc' });
    const summary = formatIngestSummary(source, { admitted: 3, merged: 1, review: 2 });
    expect(summary).toContain('On Grace');
    expect(summary).toContain('src-abc');
    expect(summary).toMatch(/admitted principles : 3/);
    expect(summary).toMatch(/merged into existing : 1/);
    expect(summary).toMatch(/sent to review queue : 2/);
  });
});
