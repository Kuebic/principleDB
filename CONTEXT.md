# CONTEXT — principleDB

This is the bedrock document. Every agent (interactive or Sandcastle-driven) reads it
first. Keep it current: when a decision lands, record the *why* here or in an ADR.

## Purpose

> ⚠️ TODO: What is principleDB? What problem does it solve, for whom, and why now?
> One or two paragraphs. This is the single most important section — fill it before
> running any agent.

## Users

> TODO: Who uses this and what do they need from it?

## Domain language (glossary)

> TODO: Define the core nouns and verbs of the domain. Agents must use these terms
> consistently. Example format:
>
> - **Principle** — TODO
> - **...** — TODO

## Non-goals

> TODO: What this project explicitly will not do. Guards against scope creep.

## Architecture

> TODO: High-level shape once chosen (step 4). Record stack decisions as ADRs in
> `docs/adr/`.

## Conventions

- Plan before code: spec → grill → issues → build.
- Every architectural decision gets an ADR in `docs/adr/`.
- Work is sliced into independently-verifiable vertical slices (tracer bullets).
- Build is executed by Sandcastle; see [WORKFLOW.md](./WORKFLOW.md).
