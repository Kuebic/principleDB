// TOC bookmark planning + review checkpoint (issue #9).
//
// Some books — Unification Thought is the canonical case — ship without a PDF outline,
// so Marker can't split them by `--split-level`. The zettle vault's recipe is:
//   1. Parse the printed Table of Contents pages into a draft bookmark list (title +
//      page + depth).
//   2. Run a review checkpoint — the owner (or an AI proposing on the owner's behalf)
//      reads the draft, fixes mis-parses (titles split across lines, off-by-one pages),
//      approves it.
//   3. Apply the approved entries via pymupdf's `set_toc`, producing a bookmarked PDF
//      that the existing bookmark-split path can consume.
//
// Three ports + an orchestrator separate concerns: the PLANNER produces the draft (any
// algorithm — printed-TOC parse, AI extraction, hand-edited TSV), the REVIEWER gates the
// draft (a callback so callers can be human-in-the-loop or AI-assisted), and the APPLIER
// writes the bookmarks into a copy of the PDF. The orchestrator wires the three with a
// strict ordering: draft → review → apply. A rejecting review aborts before the applier
// runs so a bad plan never lands in the file.
//
// This module owns no I/O — concrete planners/appliers wrap the zettle scripts and live
// behind these interfaces, keeping the orchestrator and its tests deterministic.

export interface BookmarkEntry {
  // Section title as it should appear in the PDF outline.
  title: string;
  // 1-indexed page in the original PDF where the section begins.
  page: number;
  // Bookmark tree depth: 1 = top-level, 2 = nested under the most-recent depth-1, ...
  depth: number;
}

export interface BookmarkPlan {
  entries: BookmarkEntry[];
}

export interface TocBookmarkPlanner {
  plan(pdfPath: string): Promise<BookmarkPlan>;
}

export interface BookmarkApplier {
  apply(pdfPath: string, plan: BookmarkPlan, outPath: string): Promise<void>;
}

// The review checkpoint. Returning the (possibly edited) plan approves it; throwing
// rejects the plan and aborts the orchestration before the applier runs.
export type BookmarkPlanReviewer = (draft: BookmarkPlan) => Promise<BookmarkPlan>;

export interface PreparePdfBookmarksOptions {
  planner: TocBookmarkPlanner;
  applier: BookmarkApplier;
  review: BookmarkPlanReviewer;
}

export async function preparePdfBookmarks(
  pdfPath: string,
  outPath: string,
  opts: PreparePdfBookmarksOptions,
): Promise<string> {
  const draft = await opts.planner.plan(pdfPath);
  const approved = await opts.review(draft);
  await opts.applier.apply(pdfPath, approved, outPath);
  return outPath;
}
