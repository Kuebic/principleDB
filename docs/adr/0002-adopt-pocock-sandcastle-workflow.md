# 2. Adopt the spec-driven plan/build workflow with Sandcastle

Date: 2026-06-16

## Status

Accepted

## Context

principleDB is greenfield. We want a repeatable way to take ideas to shipped code that
keeps an agent grounded in durable context, separates planning from execution, and lets
us parallelize and review autonomous work safely.

## Decision

Adopt a two-phase workflow:

- **Plan** (interactive, document-first): `CONTEXT.md` → PRD → grill → architecture →
  vertical-slice issues. Decisions are recorded in `docs/adr/`.
- **Build** (autonomous): [Sandcastle](https://github.com/mattpocock/sandcastle)
  (`@ai-hero/sandcastle`) runs Claude Code agents in isolated Docker/Podman sandboxes,
  on branches, merging commits back. Default template: `sequential-reviewer`. Branch
  strategy: `"branch"` or `"merge-to-head"`, never `"head"`.

The issues produced by the plan phase are the direct input to Sandcastle.

## Consequences

- `CONTEXT.md` and these ADRs become load-bearing — they must be kept current, since
  agents read them as ground truth.
- The build phase requires Docker or Podman and an issue tracker.
- Work must be decomposed into independently-verifiable slices to fit the model.
- See [WORKFLOW.md](../../WORKFLOW.md) for the operational detail.
