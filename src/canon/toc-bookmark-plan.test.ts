import { describe, expect, it } from 'vitest';
import {
  preparePdfBookmarks,
  type BookmarkApplier,
  type BookmarkPlan,
  type BookmarkPlanReviewer,
  type TocBookmarkPlanner,
} from './toc-bookmark-plan';

const draftPlan: BookmarkPlan = {
  entries: [
    { title: 'Preface', page: 7, depth: 1 },
    { title: 'Chapter 1', page: 12, depth: 1 },
    { title: 'Chapter 2', page: 47, depth: 1 },
  ],
};

class FakePlanner implements TocBookmarkPlanner {
  readonly calls: string[] = [];
  constructor(private readonly draft: BookmarkPlan) {}
  async plan(pdfPath: string): Promise<BookmarkPlan> {
    this.calls.push(pdfPath);
    return this.draft;
  }
}

class FakeApplier implements BookmarkApplier {
  readonly calls: Array<{ pdfPath: string; outPath: string; plan: BookmarkPlan }> = [];
  async apply(pdfPath: string, plan: BookmarkPlan, outPath: string): Promise<void> {
    this.calls.push({ pdfPath, outPath, plan });
  }
}

describe('preparePdfBookmarks', () => {
  it('drafts a plan, hands it to the reviewer, then applies the approved plan', async () => {
    const planner = new FakePlanner(draftPlan);
    const applier = new FakeApplier();
    const review: BookmarkPlanReviewer = async (draft) => {
      // Reviewer approves the draft unchanged.
      return draft;
    };
    const outPath = await preparePdfBookmarks('/in.pdf', '/out.pdf', { planner, applier, review });
    expect(outPath).toBe('/out.pdf');
    expect(planner.calls).toEqual(['/in.pdf']);
    expect(applier.calls).toEqual([{ pdfPath: '/in.pdf', outPath: '/out.pdf', plan: draftPlan }]);
  });

  it('passes the reviewer-edited plan to the applier (the draft is mutable through review)', async () => {
    const planner = new FakePlanner(draftPlan);
    const applier = new FakeApplier();
    const edited: BookmarkPlan = {
      entries: [
        ...draftPlan.entries,
        { title: 'Chapter 3 (added by reviewer)', page: 88, depth: 1 },
      ],
    };
    const review: BookmarkPlanReviewer = async () => edited;
    await preparePdfBookmarks('/in.pdf', '/out.pdf', { planner, applier, review });
    expect(applier.calls).toHaveLength(1);
    expect(applier.calls[0]!.plan).toEqual(edited);
  });

  it('propagates a rejecting reviewer error so the applier is never called', async () => {
    const planner = new FakePlanner(draftPlan);
    const applier = new FakeApplier();
    const review: BookmarkPlanReviewer = async () => {
      throw new Error('reviewer rejected — please re-draft');
    };
    await expect(
      preparePdfBookmarks('/in.pdf', '/out.pdf', { planner, applier, review }),
    ).rejects.toThrow('reviewer rejected');
    expect(applier.calls).toHaveLength(0);
  });
});
