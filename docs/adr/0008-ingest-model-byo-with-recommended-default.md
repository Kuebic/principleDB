# 8. Ingest is BYO-model with a recommended default, stamped as provenance

Date: 2026-06-19

## Status

Accepted.

## Context

principleDB is provider-agnostic and self-hostable: CONTEXT states "the owner brings their
own model and key." That line was written about the *conversation* client — the interactive
surface where the owner queries the Canon. **Ingest is a different workload**: a batch job that
distils Sources into Principles and relocates Quotes. The prototype spikes hardcoded `gpt-4o`;
the question of what model the *real* ingest pipeline runs on was never decided.

Ingest and conversation pull in different directions:

- **Ingest is faithfulness-critical and one-time-per-Source.** A weak distiller mis-extracts
  (drops the general/normative claim, mislocates a Quote), and that error is baked into the
  **Canon** — the point of truth (ADR-0006). The cost of a bad distiller is permanent and
  upstream of everything.
- **Conversation is interactive and swappable.** The owner may reasonably want a top-tier model
  for the one-time distil and a cheaper/faster one for day-to-day chat.

A naïve "use whatever model the owner happens to have configured" makes the **Canon
model-relative and churny**: re-ingesting the same Source on a different model yields different
Principles and Quotes, with no record of what produced what. "Point of truth" silently becomes
"point of truth as model X read it on date Y."

## Decision

**Ingest runs on a Bring-Your-Own model — open and swappable — with a recommended default.**
This mirrors ADR-0002's adoption of Sandcastle: an opinionated default that any self-hoster can
replace, not a hard dependency. Anyone running their own instance can re-run ingest with their
preferred model.

- **Recommended default: Claude Opus** (currently `claude-opus-4-8`). Strong distillation
  fidelity for the one-time batch cost; it is the model the project itself builds with.
- **Ingest model is independent of the conversation model.** They need not match — distil with
  the strong model, converse with whatever.
- **Provenance is stamped on every Principle and Quote**: the distil model + version *and* the
  distil-prompt version that produced it. This is what makes a model-relative — and possibly
  model-*mixed* (different Sources distilled by different models) — Canon honest and
  reproducible: re-ingesting a Source under a pinned model+prompt is deterministic, and every
  Principle records what read it.

A model-relative Canon is acceptable *because* each instance is single-owner and self-hosted
(ADR-0005): there is no universal cross-instance Canon to reconcile. "Point of truth" means
truth *for this instance*. What matters is not universality but **reproducibility within the
instance**, which provenance + a pinned default deliver.

## Considered Options

- **Whatever model the owner happens to be using for conversation** — zero extra config, but no
  provenance, the Canon churns when they switch models, and ingest fidelity is hostage to a
  model chosen for chat. Rejected.
- **Fixed server-side model, same for every instance** — reproducible across instances, but
  contradicts self-host + provider-agnostic, and forces someone other than the owner to pay the
  ingest tokens. Rejected.
- **BYO-but-pinned with a recommended default + provenance** (chosen) — keeps provider-agnostic,
  lets ingest and conversation diverge, and makes the Canon reproducible within the instance.

## Consequences

- The schema carries distil provenance (model id + version, prompt version) on Principles and
  Quotes. The distil-prompt version is meaningful: ADR-0007 (quote relocation) and the
  general/normative-claim unit both change the prompt, so "which prompt distilled this" is a
  real axis.
- The default model id (`claude-opus-4-8`) is a config value, not hardcoded — it will move as
  the recommended Opus moves. Pin a specific version per instance for reproducible re-ingest.
- A re-ingest of a Source replaces that Source's Principles deterministically given a fixed
  model+prompt; switching either is a deliberate, recorded act, not silent drift.
- This is a v1 Canon-pipeline decision; it does not touch the deferred Formation layer.
