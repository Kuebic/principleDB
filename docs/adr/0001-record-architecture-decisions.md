# 1. Record architecture decisions

Date: 2026-06-16

## Status

Accepted

## Context

We need to record the architectural decisions made on this project, so that the
reasoning behind them is preserved for future contributors — human and agent alike.
Agents driven by Sandcastle read these records to stay consistent with prior decisions.

## Decision

We will use Architecture Decision Records, as described by Michael Nygard, stored as
numbered Markdown files in `docs/adr/`.

## Consequences

Each significant decision is captured with its context and consequences. The records are
immutable once accepted; superseding decisions get a new ADR that references the old one.
