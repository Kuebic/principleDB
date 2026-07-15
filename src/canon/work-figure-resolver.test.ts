// Resolver contract (ADR-0018 slice #61): Source → Edition → Work + Figure,
// with graceful degradation when the Edition/Work chain doesn't resolve.
// Both citation-rendering callers depend on the null-fallback so a stale
// Edition (or a test fixture without one) still renders a hit — just
// without Work/Figure attribution.

import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './in-memory-repository';
import type { Edition, Source } from './types';
import { buildWorkFigureResolver } from './work-figure-resolver';

function mkEdition(id: string, workId: string): Edition {
  return {
    id,
    workId,
    label: id,
    recension: 'ffwpu-post-2012',
    language: 'en',
    publishedDate: null,
    publisher: null,
    notes: null,
  };
}

async function seed() {
  const repo = new InMemoryRepository();
  await repo.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
  await repo.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
  await repo.upsertEdition(mkEdition('ed_csg', 'work_csg'));
  return repo;
}

function src(editionId?: string | null): Pick<Source, 'editionId'> {
  return { editionId: editionId ?? null };
}

describe('buildWorkFigureResolver', () => {
  it('resolves Source → Edition → Work + Figure', async () => {
    const resolver = await buildWorkFigureResolver(await seed());
    const wf = resolver.resolve(src('ed_csg'));
    expect(wf?.work.title).toBe('Cheon Seong Gyeong');
    expect(wf?.figure.displayName).toBe('Sun Myung Moon');
  });

  it('returns null when the Source has no editionId', async () => {
    const resolver = await buildWorkFigureResolver(await seed());
    expect(resolver.resolve(src(null))).toBeNull();
  });

  it('returns null for an unknown editionId (stale citation renders without attribution)', async () => {
    const resolver = await buildWorkFigureResolver(await seed());
    expect(resolver.resolve(src('does-not-exist'))).toBeNull();
  });
});
