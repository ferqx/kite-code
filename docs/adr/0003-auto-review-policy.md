# ADR-0003: Auto-review is policy-gated and feature-flagged

**Status**: accepted  
**Date**: 2026-07-12

## Decision

Auto mode delegates operations that need review to policy. The new automatic reviewer is gated by `autoReviewV2`; disabled deployments use human approval.

## Consequences

Rollout is reversible and cannot use a system source to elevate authorization to `full_access`.
