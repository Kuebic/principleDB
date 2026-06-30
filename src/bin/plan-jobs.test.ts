import { describe, expect, it } from 'vitest';

import { planJobs } from './plan-jobs';

// Each test feeds `planJobs` synthetic `{ path, cleanedText }` items so the
// planner stays a pure data-in/data-out function — no filesystem access.

function input(path: string, cleanedText = 'a'.repeat(500)) {
  return { path, cleanedText };
}

describe('planJobs — extension allowlist', () => {
  it('keeps .html and .htm files', () => {
    const plan = planJobs([input('doc.html'), input('doc.htm')]);
    expect(plan.jobs.map((j) => j.path)).toEqual(['doc.htm', 'doc.html']);
    expect(plan.skipped).toEqual([]);
  });

  it('skips non-HTML extensions with reason "extension"', () => {
    const plan = planJobs([
      input('doc.html'),
      input('doc.pdf'),
      input('image.gif'),
      input('style.css'),
      input('script.js'),
    ]);
    expect(plan.jobs.map((j) => j.path)).toEqual(['doc.html']);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { path: 'doc.pdf', reason: 'extension' },
        { path: 'image.gif', reason: 'extension' },
        { path: 'style.css', reason: 'extension' },
        { path: 'script.js', reason: 'extension' },
      ]),
    );
  });

  it('is case-insensitive on the extension itself', () => {
    const plan = planJobs([input('LOUD.HTML'), input('SHOUT.HTM')]);
    expect(plan.jobs).toHaveLength(2);
    expect(plan.skipped).toEqual([]);
  });
});

describe('planJobs — filename denylist (case-insensitive)', () => {
  it.each([
    ['0-Toc.html'],
    ['Default.html'],
    ['favicon.html'],
    ['Lib-foo.html'],
    ['Tp-bar.html'],
    ['some-toc-page.html'],
    ['index.html'],
    ['INDEX.HTML'],
    ['back-button.html'],
    ['CoolButton.html'],
  ])('skips %s as denylisted', (path) => {
    const plan = planJobs([input(path), input('keep.html')]);
    expect(plan.jobs.map((j) => j.path)).toEqual(['keep.html']);
    expect(plan.skipped).toEqual([{ path, reason: 'denylist' }]);
  });

  it('denylist applies regardless of parent dirs (only the basename matters)', () => {
    const plan = planJobs([input('a/b/c/0-Toc.html')]);
    expect(plan.skipped).toEqual([{ path: 'a/b/c/0-Toc.html', reason: 'denylist' }]);
  });
});

describe('planJobs — near-empty guard', () => {
  it('skips a file whose cleaned text is under the 200-char floor', () => {
    const plan = planJobs([{ path: 'tiny.html', cleanedText: 'a'.repeat(100) }]);
    expect(plan.jobs).toEqual([]);
    expect(plan.skipped).toEqual([{ path: 'tiny.html', reason: 'near-empty' }]);
  });

  it('keeps a file whose cleaned text meets the floor', () => {
    const plan = planJobs([{ path: 'ok.html', cleanedText: 'a'.repeat(200) }]);
    expect(plan.jobs).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  it('extension/denylist filters run before near-empty so a denylisted file is reported as denylist, not near-empty', () => {
    const plan = planJobs([{ path: '0-Toc.html', cleanedText: '' }]);
    expect(plan.skipped).toEqual([{ path: '0-Toc.html', reason: 'denylist' }]);
  });
});

describe('planJobs — deterministic order', () => {
  it('sorts jobs lexically by path for a stable, resumable ingest order', () => {
    const plan = planJobs([
      input('zz.html'),
      input('aa.html'),
      input('mm.html'),
    ]);
    expect(plan.jobs.map((j) => j.path)).toEqual(['aa.html', 'mm.html', 'zz.html']);
  });

  it('same inputs in any order produce the same job order', () => {
    const items = [input('b.html'), input('a.html'), input('c.html')];
    const a = planJobs(items).jobs.map((j) => j.path);
    const b = planJobs([items[2]!, items[0]!, items[1]!]).jobs.map((j) => j.path);
    expect(a).toEqual(b);
  });
});
