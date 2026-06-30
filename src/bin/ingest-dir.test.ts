import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FakeIngestProvider } from '../canon/fake-provider';
import { InMemoryRepository } from '../canon/in-memory-repository';
import type { DistilInput } from '../canon/ports';
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
      join(root, 'Talks/Talk-200101.html'),
      join(root, 'Talks/Talk-200202.html'),
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
});
