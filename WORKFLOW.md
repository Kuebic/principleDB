# Workflow

principleDB is built in two phases: an interactive **plan** phase that produces
specs/issues, and an autonomous **build** phase driven by
[Sandcastle](https://github.com/mattpocock/sandcastle).

## Plan phase (interactive)

Produces the inputs the build phase consumes: issues on the tracker, plus `CONTEXT.md`
and ADRs.

0. `git init` + seed `CONTEXT.md` (purpose, domain language, why).
1. Ideate raw material (`/writing-fragments`) — optional.
2. Draft the PRD onto the tracker (`/to-prd`).
3. Stress-test the plan (`/grill-with-docs`) — writes decisions into `CONTEXT.md` and `docs/adr/`.
4. Design the architecture (Plan mode).
5. Break work into tracer-bullet vertical slices as issues (`/to-issues`).

## Build phase (autonomous — Sandcastle)

Sandcastle runs Claude Code agents in isolated Docker/Podman sandboxes on branches and
merges commits back.

**Prerequisites:** Docker or Podman running; `gh` + issue tracker wired; Anthropic auth
token in `.sandcastle/.env`.

```bash
npm install --save-dev @ai-hero/sandcastle
npx @ai-hero/sandcastle init   # choose Docker/Podman + template; builds the image
```

**Template choice:**

| Template                      | What it does                                            | Use when |
|-------------------------------|---------------------------------------------------------|----------|
| `sequential-reviewer`         | Implement issue → review → next (quality gate). **Default.** | Growing the app carefully |
| `simple-loop`                 | Close issues one-by-one, no review gate                 | Fast, low-risk tasks |
| `parallel-planner[-with-review]` | Decompose independent issues, run concurrent branches, merge | Many independent slices, want speed |

**Branch strategy:** use `"branch"` (named, e.g. `agent/issue-42`) or `"merge-to-head"`
for unattended runs. **Never `"head"`** — it writes straight to the working directory.

**Run:**

```bash
npx tsx .sandcastle/main.ts
```

`.sandcastle/main.ts` orchestrates the agents; `.sandcastle/prompt.md` holds their
instructions (reference `CONTEXT.md` + the issue; inject live issue text with
`` !`gh issue view {{ISSUE}}` ``).

## Close the loop

After Sandcastle merges: `/verify` (drive the real app) + `/code-review`.
`sequential-reviewer` already bakes a review step in.
