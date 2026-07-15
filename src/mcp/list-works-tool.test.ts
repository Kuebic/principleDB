// list_works tool — the new public MCP discovery tool (issue #55, ADR-0017).
// Lets an AI client see what Works exist, grouped by Figure, so it can
// translate "only look through Hak Ja Han" into a concrete `figures` /
// `works` scope on `search_principles`.

import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../canon/in-memory-repository';
import { listWorksTool } from './list-works-tool';

describe('listWorksTool', () => {
  it('returns Works grouped by Figure with title + core/extra tier', async () => {
    const repository = new InMemoryRepository();
    await repository.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repository.upsertFigure({ id: 'fig_hjh', slug: 'hak-ja-han', displayName: 'Hak Ja Han' });
    await repository.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });
    await repository.upsertWork({ id: 'work_dp', title: 'Divine Principle', figureId: 'fig_smm', tier: 'core' });
    await repository.upsertWork({ id: 'work_tm', title: 'True Mother Anthology', figureId: 'fig_hjh', tier: 'core' });
    await repository.upsertWork({ id: 'work_later', title: 'Later Speeches', figureId: 'fig_hjh', tier: 'extra' });

    const resp = await listWorksTool({ repository });

    expect(resp.figures.map((f) => f.id).sort()).toEqual(['fig_hjh', 'fig_smm']);
    const smm = resp.figures.find((f) => f.id === 'fig_smm')!;
    expect(smm.displayName).toBe('Sun Myung Moon');
    expect(smm.works.map((w) => w.id).sort()).toEqual(['work_csg', 'work_dp']);
    for (const w of smm.works) expect(w.tier).toBe('core');

    const hjh = resp.figures.find((f) => f.id === 'fig_hjh')!;
    expect(hjh.works.map((w) => w.title).sort()).toEqual(['Later Speeches', 'True Mother Anthology']);
    const later = hjh.works.find((w) => w.id === 'work_later')!;
    expect(later.tier).toBe('extra');
    const tm = hjh.works.find((w) => w.id === 'work_tm')!;
    expect(tm.tier).toBe('core');
  });

  it('returns a well-shaped empty case ({ figures: [] }) when nothing is registered', async () => {
    const repository = new InMemoryRepository();
    const resp = await listWorksTool({ repository });
    expect(resp).toEqual({ figures: [] });
  });

  it('omits Figures that have no Works (a lone identity is not a discovery signal)', async () => {
    const repository = new InMemoryRepository();
    await repository.upsertFigure({ id: 'fig_smm', slug: 'sun-myung-moon', displayName: 'Sun Myung Moon' });
    await repository.upsertFigure({ id: 'fig_orphan', slug: 'orphan', displayName: 'Nobody' });
    await repository.upsertWork({ id: 'work_csg', title: 'Cheon Seong Gyeong', figureId: 'fig_smm', tier: 'core' });

    const resp = await listWorksTool({ repository });
    expect(resp.figures.map((f) => f.id)).toEqual(['fig_smm']);
  });
});
