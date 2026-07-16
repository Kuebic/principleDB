import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { InMemoryBlobStore } from '../canon/blob-store';
import { InMemoryBulkProgressStore } from '../canon/bulk-ingest';
import { FakeIngestProvider } from '../canon/fake-provider';
import { InMemoryRepository } from '../canon/in-memory-repository';
import { FakePdfExtractor } from '../canon/marker';
import { r2KeyForPdfSource } from '../canon/pdf-ingest';
import {
  formatPdfDryRunSummary,
  ingestPdfSources,
  parseIngestPdfArgs,
  planPdfSources,
} from './ingest-pdf';

describe('parseIngestPdfArgs', () => {
  it('defaults target=cpu and archive=true from a bare path', () => {
    const a = parseIngestPdfArgs(['book.pdf']);
    expect(a.path).toBe('book.pdf');
    expect(a.target).toBe('cpu');
    expect(a.archive).toBe(true);
    expect(a.dryRun).toBeUndefined();
  });

  it('parses author/title/kind/target and --no-archive', () => {
    const a = parseIngestPdfArgs([
      'dir',
      '--author',
      'Sun Myung Moon',
      '--title',
      'Cham Bumo Gyeong',
      '--kind',
      'book',
      '--target',
      'remote-gpu',
      '--no-archive',
    ]);
    expect(a).toMatchObject({
      path: 'dir',
      author: 'Sun Myung Moon',
      title: 'Cham Bumo Gyeong',
      kind: 'book',
      target: 'remote-gpu',
      archive: false,
    });
  });

  it('parses --edition (ADR-0018 — every ingest declares its Edition)', () => {
    expect(parseIngestPdfArgs(['x', '--edition', 'ed_tfg']).edition).toBe('ed_tfg');
    expect(parseIngestPdfArgs(['x']).edition).toBeUndefined();
  });

  it('parses --model and rejects an unknown one', () => {
    expect(parseIngestPdfArgs(['x', '--model', 'haiku']).model).toBe('haiku');
    expect(parseIngestPdfArgs(['x', '--model', 'opus']).model).toBe('opus');
    expect(parseIngestPdfArgs(['x']).model).toBeUndefined();
    expect(() => parseIngestPdfArgs(['x', '--model', 'sonnet'])).toThrow(/--model/);
  });

  it('rejects an unknown --kind or --target and a missing path', () => {
    expect(() => parseIngestPdfArgs(['x', '--kind', 'scroll'])).toThrow(/--kind/);
    expect(() => parseIngestPdfArgs(['x', '--target', 'tpu'])).toThrow(/--target/);
    expect(() => parseIngestPdfArgs([])).toThrow(/usage/);
  });
});

describe('planPdfSources', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdf-ingest-'));
    // Written out of order to prove the planner sorts into chapter order.
    writeFileSync(join(dir, 'ChambumoGyeong-01.pdf'), '%PDF-1.4 ch1');
    writeFileSync(join(dir, 'ChambumoGyeong-00.pdf'), '%PDF-1.4 ch0');
    writeFileSync(join(dir, '0-Toc.txt'), 'toc'); // ignored — not a .pdf
  });

  it('collects .pdf files in sorted order and stamps author/title/id', () => {
    const plan = planPdfSources(
      parseIngestPdfArgs([dir, '--author', 'Sun Myung Moon', '--title', 'Cham Bumo Gyeong']),
    );
    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[0]!.path).toMatch(/ChambumoGyeong-00\.pdf$/);
    expect(plan.jobs[1]!.path).toMatch(/ChambumoGyeong-01\.pdf$/);
    expect(plan.jobs[0]!.meta.author).toBe('Sun Myung Moon');
    expect(plan.jobs[0]!.meta.title).toBe('Cham Bumo Gyeong — ChambumoGyeong-00');
    expect(plan.jobs[0]!.meta.id).toMatch(/^src-path-/);
    expect(plan.jobs[0]!.meta.id).not.toBe(plan.jobs[1]!.meta.id);
  });

  it('stamps --edition onto every planned Source meta (ADR-0018)', () => {
    const plan = planPdfSources(
      parseIngestPdfArgs([dir, '--author', 'Sun Myung Moon', '--edition', 'ed_tfg']),
    );
    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs[0]!.meta.editionId).toBe('ed_tfg');
    expect(plan.jobs[1]!.meta.editionId).toBe('ed_tfg');
  });

  it('falls back to the parent-dir name for author when --author is omitted', () => {
    const plan = planPdfSources(
      parseIngestPdfArgs([join(dir, 'ChambumoGyeong-00.pdf')]),
    );
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]!.meta.author).toBe(basename(dir));
    // Without --title the title humanizes the filename stem.
    expect(plan.jobs[0]!.meta.title).toBe('ChambumoGyeong 00');
  });

  it('formatPdfDryRunSummary reports the count and a sample', () => {
    const s = formatPdfDryRunSummary(
      planPdfSources(parseIngestPdfArgs([dir, '--author', 'A', '--title', 'T'])),
    );
    expect(s).toContain('would ingest: 2 PDF source(s)');
    expect(s).toContain('author="A"');
  });
});

describe('ingestPdfSources (integration with fakes)', () => {
  const fixture = [
    '{0}------------------------------------------------',
    'Grace precedes obedience. We are loved first, and our obedience flows from being loved.',
    '{1}------------------------------------------------',
    'Service follows from love, never the reverse.',
  ].join('\n');

  function makeDeps() {
    return {
      extractor: new FakePdfExtractor(fixture),
      blobs: new InMemoryBlobStore(),
      provider: new FakeIngestProvider(() => [
        { claim: 'Grace precedes obedience.', quote: 'Grace precedes obedience.' },
      ]),
      repository: new InMemoryRepository(),
    };
  }

  it('ingests every PDF, archives each original, and resumes idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-ingest-e2e-'));
    writeFileSync(join(dir, 'Book-00.pdf'), '%PDF-1.4 a');
    writeFileSync(join(dir, 'Book-01.pdf'), '%PDF-1.4 b');

    const args = parseIngestPdfArgs([dir, '--author', 'Sun Myung Moon']);
    const deps = makeDeps();
    const progress = new InMemoryBulkProgressStore();

    const first = await ingestPdfSources(args, deps, { progress });
    expect(first.bulk.completed).toHaveLength(2);
    expect(first.bulk.failed).toHaveLength(0);
    for (const j of first.plan.jobs) {
      expect(deps.blobs.has(r2KeyForPdfSource(j.sourceId))).toBe(true);
    }

    // Re-running with the same durable progress skips everything.
    const second = await ingestPdfSources(args, deps, { progress });
    expect(second.bulk.completed).toHaveLength(0);
    expect(second.bulk.skipped).toHaveLength(2);
  });
});
