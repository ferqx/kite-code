# Agent Note: Risk-tiered verification completion semantics

Status: implemented

## Problem
The Runtime must later verify high-risk workflow outcomes without turning ordinary answers into a global stop-check.

## Decision
Future verification uses `not_required`, `best_effort`, and `required`. Only pending required verification blocks terminal completion; a user may explicitly waive it and the result remains marked unverified.

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
P0 does not alter scheduler completion behavior. Execution receipts, reconciliation, verifier effects, and waiver actions are Phase 2+ work.

## Rollback
No runtime behavior is introduced by this Agent Note.
