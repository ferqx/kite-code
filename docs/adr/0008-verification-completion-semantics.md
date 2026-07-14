# ADR-0008: Risk-tiered verification completion semantics

**Status**: accepted
**Date**: 2026-07-14

## Context

The Runtime must later verify high-risk workflow outcomes without turning ordinary answers into a global stop-check.

## Decision

Future verification uses `not_required`, `best_effort`, and `required`. Only pending required verification blocks terminal completion; a user may explicitly waive it and the result remains marked unverified.

## Consequences

P0 does not alter scheduler completion behavior. Execution receipts, reconciliation, verifier effects, and waiver actions are Phase 2+ work.

## Rollback

No runtime behavior is introduced by this ADR.
