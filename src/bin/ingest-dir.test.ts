import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InMemoryBulkProgressStore } from '../canon/bulk-ingest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { DistilInput } from '../canon/ports';
import { InMemorySeenTextStore } from '../canon/seen-text-store';
import { deriveHtmlSourcePathId } from './derive-path-source-id';
import {
  formatDryRunSummary,
  ingestDirectory,
  parseIngestDirArgs,
} from './ingest-dir';

function makeTmpCorpus(): string {
  return mkdtempSync(join(tmpdir(), 'principledb-walker-'));
}

function writeFile(root: string, relPath: string, contents: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, 'utf8');
}

const bodyParagraph = '<p>' + 'sentence one is here. '.repeat(20) + '</p>';
const longHtml = (heading: string) =>
  `<html><head><title>${heading}</title></head><body>` +
  `<h1>${heading}</h1>${bodyParagraph}</body></html>`;

describe('parseIngestDirArgs', () => {
  it('takes the first positional as the directory path', () => {
    expect(parseIngestDirArgs(['corpus/Moon-Books']).path).toBe('corpus/Moon-Books');
  });

  it('parses --kind, --limit, --dry-run, --model flags', () => {
    const args = parseIngestDirArgs([
      'corpus/Moon-Books',
      '--kind',
      'sermon',
      '--limit',
      '5',
      '--dry-run',
      '--model',
      'haiku',
    ]);
    expect(args).toEqual({
      path: 'corpus/Moon-Books',
      kind: 'sermon',
      limit: 5,
      dryRun: true,
      model: 'haiku',
    });
  });

  it('throws when no directory is given', () => {
    expect(() => parseIngestDirArgs([])).toThrow(/usage/);
  });

  it('throws on an unknown --kind', () => {
    expect(() => parseIngestDirArgs(['corpus', '--kind', 'novel'])).toThrow(
      /--kind must be one of/,
    );
  });

  it('throws on an unknown --model', () => {
    expect(() => parseIngestDirArgs(['corpus', '--model', 'gpt'])).toThrow(
      /--model must be one of/,
    );
  });

  it('throws on a non-positive --limit', () => {
    expect(() => parseIngestDirArgs(['corpus', '--limit', '0'])).toThrow(/--limit/);
    expect(() => parseIngestDirArgs(['corpus', '--limit', 'x'])).toThrow(/--limit/);
  });
});

describe('ingestDirectory — dry run', () => {
  it('reports the would-ingest count, skip reasons, and a cost estimate without distilling', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Ahn/Ahn-060721.html', longHtml('On Grace'));
    writeFile(root, 'Ahn/Ahn-070101.html', longHtml('On Service'));
    writeFile(root, 'Ahn/0-Toc.html', longHtml('TOC'));
    writeFile(root, 'Ahn/index.html', longHtml('Index'));
    writeFile(root, 'Ahn/tiny.html', '<html><body><p>short</p></body></html>');
    writeFile(root, 'Ahn/cover.gif', 'fakebytes');
    writeFile(root, 'Ahn/booklet.pdf', 'fakebytes');

    let distilCalls = 0;
    const provider = new FakeIngestProvider((_input: DistilInput) => {
      distilCalls += 1;
      return [];
    });
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository }, { dryRun: true });

    expect(distilCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.plan.jobs).toHaveLength(2);
    expect(result.plan.jobs.map((j) => j.path).every((p) => p.endsWith('.html'))).toBe(true);
    const reasons = result.plan.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['denylist', 'denylist', 'extension', 'extension', 'near-empty']);
    expect(result.bulk).toBeNull();

    const summary = formatDryRunSummary(result.plan);
    expect(summary).toMatch(/would ingest: 2/);
    expect(summary).toMatch(/skipped:/);
    expect(summary).toMatch(/denylist: 2/);
    expect(summary).toMatch(/extension: 2/);
    expect(summary).toMatch(/near-empty: 1/);
    expect(summary).toMatch(/sample:/);
    expect(summary).toMatch(/estimated input chars:/);
  });
});

describe('ingestDirectory — real ingest', () => {
  it('ingests every kept HTML file end-to-end via FakeIngestProvider + InMemoryRepository', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Talk-200101.html', longHtml('Talk A'));
    writeFile(root, 'Talks/Talk-200202.html', longHtml('Talk B'));
    writeFile(root, 'Talks/Talk-200303.html', longHtml('Talk C'));
    writeFile(root, 'Talks/0-Toc.html', longHtml('TOC'));

    const provider = new FakeIngestProvider((input: DistilInput) => [
      { claim: `claim for ${input.title}.`, quote: 'sentence one is here' },
    ]);
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository });

    expect(result.dryRun).toBe(false);
    expect(result.plan.jobs).toHaveLength(3);
    expect(result.bulk).not.toBeNull();
    expect(result.bulk!.completed).toHaveLength(3);
    expect(result.bulk!.failed).toEqual([]);
    expect(result.bulk!.aborted).toBe(false);

    // All 3 Principles land in the Canon and are searchable.
    const [vec] = await provider.embed(['claim']);
    const hits = await repository.searchByEmbedding(vec!, 10);
    expect(hits).toHaveLength(3);
  });

  it('respects --limit by capping how many jobs are ingested', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Talk-200101.html', longHtml('Talk A'));
    writeFile(root, 'Talks/Talk-200202.html', longHtml('Talk B'));
    writeFile(root, 'Talks/Talk-200303.html', longHtml('Talk C'));
    writeFile(root, 'Talks/Talk-200404.html', longHtml('Talk D'));
    writeFile(root, 'Talks/Talk-200505.html', longHtml('Talk E'));

    const provider = new FakeIngestProvider((input: DistilInput) => [
      { claim: `claim for ${input.title}.`, quote: 'sentence one is here' },
    ]);
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository }, { limit: 2 });

    // --limit caps the batch at the first N jobs in the lexical order planJobs returns.
    expect(result.bulk!.completed).toHaveLength(2);
    expect(result.bulk!.completed.map((c) => c.sourceId)).toEqual([
      deriveHtmlSourcePathId('Talks/Talk-200101.html'),
      deriveHtmlSourcePathId('Talks/Talk-200202.html'),
    ]);
  });

  it('walks subdirectories recursively', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Tier-A/Author-X/Doc-200101.html', longHtml('A'));
    writeFile(root, 'Tier-A/Author-Y/Doc-200202.html', longHtml('B'));
    writeFile(root, 'Tier-B/Author-Z/Doc-200303.html', longHtml('C'));

    const provider = new FakeIngestProvider(() => []);
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository }, { dryRun: true });
    expect(result.plan.jobs).toHaveLength(3);
  });

  it('uses the path-based deterministic Source id (issue #15), not the content-hash id', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Talk-200101.html', longHtml('Talk A'));

    const provider = new FakeIngestProvider((input: DistilInput) => [
      { claim: `claim for ${input.title}.`, quote: 'sentence one is here' },
    ]);
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository });
    const expected = deriveHtmlSourcePathId('Talks/Talk-200101.html');
    expect(result.bulk!.completed.map((c) => c.sourceId)).toEqual([expected]);
    expect(await repository.getSource(expected)).not.toBeNull();
  });
});

describe('ingestDirectory — resume', () => {
  it('on resume, skips already-completed Sources by id WITHOUT re-reading the files', async () => {
    // First pass: ingest two files, populate the in-memory progress store.
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Talk-200101.html', longHtml('Talk A'));
    writeFile(root, 'Talks/Talk-200202.html', longHtml('Talk B'));

    const provider = new FakeIngestProvider((input: DistilInput) => [
      { claim: `claim for ${input.title}.`, quote: 'sentence one is here' },
    ]);
    const repository = new InMemoryRepository();
    const progress = new InMemoryBulkProgressStore();

    const first = await ingestDirectory(root, { provider, repository }, { progress });
    expect(first.bulk!.completed).toHaveLength(2);
    const aId = deriveHtmlSourcePathId(relative(root, join(root, 'Talks/Talk-200101.html')));
    const bId = deriveHtmlSourcePathId(relative(root, join(root, 'Talks/Talk-200202.html')));
    expect(await progress.has(aId)).toBe(true);
    expect(await progress.has(bId)).toBe(true);

    // Replace the files with near-empty content. If the walker re-read them
    // on resume, `planJobs` would categorize them as `near-empty` skips and
    // `plan.skipped` would be non-empty. The correct behaviour is: progress
    // consulted FIRST, no read happens, `plan.skipped` stays empty.
    writeFile(root, 'Talks/Talk-200101.html', '<html><body>x</body></html>');
    writeFile(root, 'Talks/Talk-200202.html', '<html><body>x</body></html>');

    const second = await ingestDirectory(root, { provider, repository }, { progress });
    expect(second.plan.jobs).toHaveLength(0);
    expect(second.plan.skipped).toHaveLength(0);
    expect(second.bulk!.completed).toHaveLength(0);
    expect(second.bulk!.skipped.sort()).toEqual([aId, bId].sort());
  });

  it('uses the in-memory progress store by default (re-run from a fresh store re-ingests)', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Talk-200101.html', longHtml('Talk A'));

    const provider = new FakeIngestProvider((input: DistilInput) => [
      { claim: `claim for ${input.title}.`, quote: 'sentence one is here' },
    ]);
    const repository = new InMemoryRepository();

    // No `progress` option → a new in-memory store per call → no resume.
    const first = await ingestDirectory(root, { provider, repository });
    const second = await ingestDirectory(root, { provider, repository });
    expect(first.bulk!.completed).toHaveLength(1);
    expect(second.bulk!.completed).toHaveLength(1);
  });
});

// Whitespace-variant captures of the same document differ only in markup
// formatting. The PRD-defined dedup pre-pass collapses them onto a single
// normalized hash so the second capture skips distil entirely. Partial-vs-full
// captures (genuinely different text) must still BOTH ingest — semantic
// dedup runs at admission, not here.
const wsVariantA = (heading: string): string =>
  `<html><head><title>${heading}</title></head><body>` +
  `<h1>${heading}</h1><p>` +
  'this teaching is the foundation of all that follows in the divine plan. '.repeat(20) +
  `</p></body></html>`;
const wsVariantB = (heading: string): string =>
  `<html><body><h1>${heading}</h1>\n\n   <p>\n  ` +
  'this teaching is the foundation of all that follows in the divine plan.  '.repeat(20) +
  `\n  </p>\n</body></html>`;

// Real-world cause: some .html files in the tparents.org mirror are actually
// JPEG scans saved with the wrong extension. The walker must skip such files
// cleanly (reason `binary`), not fail the run — and must do so by magic-byte
// detection so legacy-encoded text files with a high byte in the head aren't
// false-positive-dropped (issue #20, fixing the over-skip from issue #18).
describe('ingestDirectory — binary-content guard (issues #18 / #20)', () => {
  const jfifBytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  ]);
  const gifBytes = Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
  ]);
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
  ]);
  const pdfBytes = Buffer.from('%PDF-1.4\n%\xff\xff\xff\n');

  it('skips a binary .html file with reason `binary` instead of failing the run', async () => {
    const root = makeTmpCorpus();
    writeFileSync(join(root, 'Genesis-01A.html'), jfifBytes);
    writeFile(root, 'Genesis-01B.html', longHtml('Genesis 1B'));

    let distilCalls = 0;
    const provider = new FakeIngestProvider((input: DistilInput) => {
      distilCalls += 1;
      return [{ claim: `claim for ${input.title}.`, quote: 'sentence one is here' }];
    });
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository });

    expect(result.bulk!.failed).toEqual([]);
    expect(result.bulk!.completed).toHaveLength(1);
    expect(distilCalls).toBe(1);

    const binarySkips = result.plan.skipped.filter((s) => s.reason === 'binary');
    expect(binarySkips).toHaveLength(1);
    expect(binarySkips[0]!.path).toMatch(/Genesis-01A\.html$/);
  });

  it('reports `binary` in the dry-run skip breakdown', async () => {
    const root = makeTmpCorpus();
    writeFileSync(join(root, 'scanned.html'), jfifBytes);
    writeFile(root, 'real.html', longHtml('Real'));

    const provider = new FakeIngestProvider(() => []);
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository }, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.plan.jobs).toHaveLength(1);
    expect(
      result.plan.skipped.filter((s) => s.reason === 'binary'),
    ).toHaveLength(1);
    expect(formatDryRunSummary(result.plan)).toMatch(/binary: 1/);
  });

  it('also skips GIF/PNG/PDF magic-byte content saved with a .html suffix', async () => {
    const root = makeTmpCorpus();
    writeFileSync(join(root, 'figure-gif.html'), gifBytes);
    writeFileSync(join(root, 'figure-png.html'), pngBytes);
    writeFileSync(join(root, 'figure-pdf.html'), pdfBytes);
    writeFile(root, 'real.html', longHtml('Real'));

    const provider = new FakeIngestProvider((input: DistilInput) => [
      { claim: `claim for ${input.title}.`, quote: 'sentence one is here' },
    ]);
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository });

    expect(result.bulk!.failed).toEqual([]);
    expect(result.bulk!.completed).toHaveLength(1);
    expect(
      result.plan.skipped.filter((s) => s.reason === 'binary'),
    ).toHaveLength(3);
  });
});

// The corpus is 1990s/2000s Windows-1252 / Latin-1. A single legacy byte (0x85,
// 0x92, 0xA0…) used to flag a complete scripture chapter as `binary` and drop
// it. The new contract: detect binary by magic bytes, transcode legacy text
// to UTF-8 via Windows-1252 fallback, then ingest. Genesis-01/05/10/11 are no
// longer dropped, and the verdict no longer depends on where the first high
// byte falls inside the 8 KiB sample window.
describe('ingestDirectory — encoding-aware ingest (issue #20)', () => {
  function legacyHtml(heading: string, bodyPrefix = ''): Buffer {
    // Windows-1252 bytes only: 0x85 (curly ellipsis), 0x92 (curly apostrophe),
    // 0xA0 (nbsp). Wrapped in long enough prose to clear the near-empty guard.
    const ascii = `<html><head><title>${heading}</title></head><body>`
      + `<h1>${heading}</h1><p>${bodyPrefix}`;
    const legacyBody = 'so they said it would happen ' // ASCII
      .repeat(20);
    const tail = '</p></body></html>';
    return Buffer.concat([
      Buffer.from(ascii, 'utf8'),
      Buffer.from(legacyBody, 'utf8'),
      // Windows-1252 punctuation: …, ’, nbsp
      Buffer.from([0x85, 0x20, 0x74, 0x68, 0x65, 0x79, 0x92, 0x76, 0x65, 0xa0, 0x67, 0x6f, 0x6e, 0x65, 0x2e]),
      Buffer.from(tail, 'utf8'),
    ]);
  }

  it('ingests a Windows-1252 chapter instead of dropping it as binary', async () => {
    const root = makeTmpCorpus();
    writeFileSync(join(root, 'Genesis-01.html'), legacyHtml('Genesis 1'));

    const distilInputs: DistilInput[] = [];
    const provider = new FakeIngestProvider((input: DistilInput) => {
      distilInputs.push(input);
      return [{ claim: `claim for ${input.title}.`, quote: 'so they said it would happen' }];
    });
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository });

    expect(result.bulk!.failed).toEqual([]);
    expect(result.bulk!.completed).toHaveLength(1);
    expect(result.plan.skipped.filter((s) => s.reason === 'binary')).toEqual([]);

    // Distil saw clean UTF-8: the curly ellipsis, curly apostrophe, and nbsp
    // are properly decoded rather than appearing as U+FFFD replacements.
    expect(distilInputs).toHaveLength(1);
    expect(distilInputs[0]!.text).toContain('…');
    expect(distilInputs[0]!.text).toContain('’');
    expect(distilInputs[0]!.text.includes('�')).toBe(false);
  });

  it("verdict does not depend on where the first high byte lands (no 8 KiB-window inconsistency)", async () => {
    // Genesis-01 had its first 0x85 inside 8 KiB → dropped under the old
    // rule. Genesis-08 had its first 0x85 past 8 KiB → silently slipped
    // through and was later mojibaked. The fix: both ingest cleanly.
    const root = makeTmpCorpus();
    writeFileSync(join(root, 'Genesis-01.html'), legacyHtml('Genesis 1'));
    // Pad with a long ASCII prefix so the first high byte lands well past 8 KiB.
    const longPrefix = 'verse goes here. '.repeat(600);
    writeFileSync(join(root, 'Genesis-08.html'), legacyHtml('Genesis 8', longPrefix));

    const provider = new FakeIngestProvider((input: DistilInput) => [
      { claim: `claim for ${input.title}.`, quote: 'so they said it would happen' },
    ]);
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository });

    expect(result.bulk!.failed).toEqual([]);
    expect(result.bulk!.completed).toHaveLength(2);
    expect(result.plan.skipped.filter((s) => s.reason === 'binary')).toEqual([]);
  });

  it('still skips magic-byte image content even when the .html duplicate sits next to legacy text', async () => {
    // Corpus pattern: `Image404.gif` saved alongside an `Image404.html`
    // duplicate of the same JFIF bytes. The image must skip; the real
    // legacy chapter must ingest. Both decisions are independent of the
    // 8 KiB sample position.
    const jfif = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
    ]);
    const root = makeTmpCorpus();
    writeFileSync(join(root, 'Image404.html'), jfif);
    writeFileSync(join(root, 'Genesis-05.html'), legacyHtml('Genesis 5'));

    const provider = new FakeIngestProvider((input: DistilInput) => [
      { claim: `claim for ${input.title}.`, quote: 'so they said it would happen' },
    ]);
    const repository = new InMemoryRepository();

    const result = await ingestDirectory(root, { provider, repository });

    expect(result.bulk!.failed).toEqual([]);
    expect(result.bulk!.completed).toHaveLength(1);
    const binarySkips = result.plan.skipped.filter((s) => s.reason === 'binary');
    expect(binarySkips).toHaveLength(1);
    expect(binarySkips[0]!.path).toMatch(/Image404\.html$/);
  });
});

describe('ingestDirectory — normalized-text dedup pre-pass (issue #16)', () => {
  it('distils only the first of two whitespace-variant captures (intra-batch)', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Doc-200101.html', wsVariantA('On Grace'));
    writeFile(root, 'Talks/Doc-200101-mirror.html', wsVariantB('On Grace'));

    let distilCalls = 0;
    const provider = new FakeIngestProvider((input: DistilInput) => {
      distilCalls += 1;
      return [{ claim: `claim for ${input.title}.`, quote: 'this teaching is the foundation' }];
    });
    const repository = new InMemoryRepository();
    const seenText = new InMemorySeenTextStore();

    const result = await ingestDirectory(
      root,
      { provider, repository },
      { seenText },
    );

    expect(distilCalls).toBe(1);
    expect(result.bulk!.completed).toHaveLength(1);
    const skipReasons = result.plan.skipped.map((s) => s.reason);
    expect(skipReasons).toContain('normalized-duplicate');
    expect(skipReasons.filter((r) => r === 'normalized-duplicate')).toHaveLength(1);
  });

  it('skips whitespace-variant captures across runs via a persistent SeenTextStore', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Doc-200101.html', wsVariantA('On Grace'));

    let distilCalls = 0;
    const provider = new FakeIngestProvider((input: DistilInput) => {
      distilCalls += 1;
      return [{ claim: `claim for ${input.title}.`, quote: 'this teaching is the foundation' }];
    });
    const repository = new InMemoryRepository();
    const seenText = new InMemorySeenTextStore();

    // First run ingests and records the hash.
    const first = await ingestDirectory(
      root,
      { provider, repository },
      { seenText },
    );
    expect(first.bulk!.completed).toHaveLength(1);
    expect(distilCalls).toBe(1);

    // Second run on a NEW path with whitespace-variant text — the SeenTextStore
    // carries the hash forward, so distil is not called again.
    writeFile(root, 'Talks/Doc-200101-mirror.html', wsVariantB('On Grace'));
    const second = await ingestDirectory(
      root,
      { provider, repository },
      { seenText },
    );

    expect(distilCalls).toBe(1);
    expect(second.bulk!.completed).toHaveLength(0);
    expect(second.plan.skipped.some((s) => s.reason === 'normalized-duplicate')).toBe(true);
  });

  it('ingests BOTH a partial and a full capture (different text → different hash)', async () => {
    const root = makeTmpCorpus();
    const fullHtml =
      `<html><body><h1>Full</h1><p>` +
      'this teaching is the foundation of all that follows in the divine plan. '.repeat(20) +
      `</p></body></html>`;
    const partialHtml =
      `<html><body><h1>Partial</h1><p>` +
      'this teaching is the foundation of all that follows. '.repeat(20) +
      `</p></body></html>`;
    writeFile(root, 'Talks/Doc-full.html', fullHtml);
    writeFile(root, 'Talks/Doc-partial.html', partialHtml);

    let distilCalls = 0;
    const provider = new FakeIngestProvider((input: DistilInput) => {
      distilCalls += 1;
      return [{ claim: `claim for ${input.title}.`, quote: 'this teaching is the foundation' }];
    });
    const repository = new InMemoryRepository();
    const seenText = new InMemorySeenTextStore();

    const result = await ingestDirectory(
      root,
      { provider, repository },
      { seenText },
    );

    expect(distilCalls).toBe(2);
    expect(result.bulk!.completed).toHaveLength(2);
    expect(result.plan.skipped.some((s) => s.reason === 'normalized-duplicate')).toBe(false);
  });

  it('dry-run reports the normalized-duplicate skip count (intra-batch)', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Doc-200101.html', wsVariantA('On Grace'));
    writeFile(root, 'Talks/Doc-200101-mirror.html', wsVariantB('On Grace'));

    let distilCalls = 0;
    const provider = new FakeIngestProvider((input: DistilInput) => {
      distilCalls += 1;
      return [];
    });
    const repository = new InMemoryRepository();
    const seenText = new InMemorySeenTextStore();

    const result = await ingestDirectory(
      root,
      { provider, repository },
      { dryRun: true, seenText },
    );

    expect(distilCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.plan.jobs).toHaveLength(1);
    expect(
      result.plan.skipped.filter((s) => s.reason === 'normalized-duplicate'),
    ).toHaveLength(1);

    const summary = formatDryRunSummary(result.plan);
    expect(summary).toMatch(/normalized-duplicate: 1/);
  });

  it('does not record hashes for failed ingests (a later re-run still attempts the file)', async () => {
    const root = makeTmpCorpus();
    writeFile(root, 'Talks/Doc-200101.html', wsVariantA('On Grace'));

    let distilCalls = 0;
    let shouldFail = true;
    const provider = new FakeIngestProvider((input: DistilInput) => {
      distilCalls += 1;
      if (shouldFail) throw new Error('simulated distil failure');
      return [{ claim: `claim for ${input.title}.`, quote: 'this teaching is the foundation' }];
    });
    const repository = new InMemoryRepository();
    const seenText = new InMemorySeenTextStore();

    const first = await ingestDirectory(
      root,
      { provider, repository },
      { seenText },
    );
    expect(first.bulk!.completed).toHaveLength(0);
    expect(first.bulk!.failed).toHaveLength(1);

    // Same file, retried — hash was NOT recorded after the failure, so distil
    // runs again. (Sanity-checks: missing the optimization on failure means
    // we never silently swallow a file that never reached the Canon.)
    shouldFail = false;
    const second = await ingestDirectory(
      root,
      { provider, repository },
      { seenText },
    );
    expect(distilCalls).toBe(2);
    expect(second.bulk!.completed).toHaveLength(1);
  });
});
