// Sequential Reviewer — implement-then-review loop
//
// This template drives a two-phase workflow per issue:
//   Phase 1 (Implement): A sonnet agent picks an open issue, works on it
//                        on a dedicated branch, commits the changes, and signals
//                        completion.
//   Phase 2 (Review):    A second sonnet agent reviews the branch diff and either
//                        approves it or makes corrections directly on the branch.
//
// Both phases share a single sandbox created via createSandbox(), so the
// implementer and reviewer work on the same explicit branch.
//
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration and stopping early once the backlog is exhausted (an implement
// phase that produces no commits). This is a middle-complexity option between
// the simple-loop (no review gate) and the parallel-planner (concurrent
// execution with a planning phase).
//
// Usage:
//   npx tsx .sandcastle/main.ts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.ts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue. Raise this to process more issues per run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

// Counts issues actually merged this run, so the end-of-run push is skipped
// when the backlog was empty (nothing to publish).
let mergedCount = 0;

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Generate a unique branch name for this iteration.
  const branch = `sandcastle/sequential-reviewer/${Date.now()}`;

  // Whether the review phase finished cleanly — gates the merge to main below.
  let reviewed = false;

  // Create a single sandbox that both the implementer and reviewer share.
  // This gives both agents a real, named branch that persists across phases.
  const sandbox = await sandcastle.createSandbox({
    branch,
    sandbox: podman(),
    hooks,
    copyToWorktree,
  });

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Implement
    //
    // A sonnet agent picks the next open issue, writes the
    // implementation (using RGR: Red → Green → Repeat → Refactor), and
    // commits the result.
    //
    // The agent signals completion via <promise>COMPLETE</promise> when done.
    // -----------------------------------------------------------------------
    // One iteration so each outer pass implements a single issue on its own
    // branch, then hands it to the reviewer. A higher value lets the agent
    // drain the whole backlog onto this one branch in a single pass, which
    // defeats the per-issue review.
    const implement = await sandbox.run({
      name: "implementer",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-opus-4-7"),
      promptFile: "./.sandcastle/implement-prompt.md",
    });

    if (!implement.commits.length) {
      // No commits means the backlog is empty or every remaining issue is
      // blocked — there is nothing left to implement or review, so stop.
      console.log("Implementation agent made no commits. Stopping.");
      break;
    }

    console.log(`\nImplementation complete on branch: ${branch}`);
    console.log(`Commits: ${implement.commits.length}`);

    // -----------------------------------------------------------------------
    // Phase 2: Review
    //
    // A second sonnet agent reviews the diff of the branch produced by
    // Phase 1. It uses the {{BRANCH}} prompt argument to inspect the right
    // branch, and either approves or makes corrections directly on the branch.
    // -----------------------------------------------------------------------
    await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: sandcastle.claudeCode("claude-opus-4-7"),
      promptFile: "./.sandcastle/review-prompt.md",
      promptArgs: {
        BRANCH: branch,
      },
    });

    console.log("\nReview complete.");
    reviewed = true;
  } finally {
    await sandbox.close();
  }

  // Land the reviewed work on main and delete the temp branch, so the next
  // iteration forks from the new HEAD and the backlog actually advances.
  // This is merge-to-head semantics layered on the named-branch model — it
  // keeps the reviewer's `git diff main...branch` gate intact, which a raw
  // merge-to-head branchStrategy would erase.
  if (reviewed) {
    console.log(`\nMerging ${branch} into main...`);
    execSync(`git merge --ff-only ${branch}`, { stdio: "inherit" });
    mergedCount++;
    // Branch deletion can fail if the sandbox's worktree hasn't been torn down
    // yet (a race in sandbox.close()): `git branch -D` refuses to delete a
    // branch still checked out by a worktree. Prune stale worktrees first, and
    // never let a cleanup hiccup kill the loop — the work is already merged.
    try {
      execSync("git worktree prune", { stdio: "inherit" });
      execSync(`git branch -D ${branch}`, { stdio: "inherit" });
      console.log(`Merged ${branch} into main and deleted the temp branch.`);
    } catch (err) {
      console.warn(
        `Merged ${branch} into main; temp-branch cleanup failed (safe to ignore, already merged): ${err.message}`,
      );
    }
  }
}

// Final sweep. The per-iteration `git branch -D` above can lose a race with
// worktree teardown and leak a branch (hence the try/catch that swallows it).
// By now every sandbox is closed, so prune worktrees and delete any leftover
// `sandcastle/*` branch that is merged into main. `--merged main` scoping means
// this can never drop unmerged work; `-d` (not `-D`) is a second guard.
try {
  execSync("git worktree prune", { stdio: "inherit" });
  const leftover = execSync("git branch --merged main --format='%(refname:short)'", {
    encoding: "utf8",
  })
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.startsWith("sandcastle/sequential-reviewer/"));
  for (const b of leftover) {
    execSync(`git branch -d ${b}`, { stdio: "inherit" });
    console.log(`Swept leftover branch: ${b}`);
  }
  if (leftover.length) console.log(`Swept ${leftover.length} leftover branch(es).`);
} catch (err) {
  console.warn(`Branch sweep skipped (safe to ignore): ${err.message}`);
}

// Publish. The harness merges to local main only; without this, a run leaves
// its work stranded locally. Push once at the end, guarded on an actual merge,
// and never let a rejected push (e.g. origin moved) fail the run — the work is
// already safe on local main and can be pushed by hand.
if (mergedCount > 0) {
  try {
    console.log(`\nPushing ${mergedCount} merged issue(s) to origin/main...`);
    execSync("git push origin main", { stdio: "inherit" });
    console.log("Pushed to origin/main.");
  } catch (err) {
    console.warn(
      `Push to origin/main failed (work is safe on local main — push by hand): ${err.message}`,
    );
  }
} else {
  console.log("\nNo issues merged this run; nothing to push.");
}

console.log("\nAll done.");
