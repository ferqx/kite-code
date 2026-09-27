# Agent Note: Auto-review is policy-gated and feature-flagged

Status: implemented

## Problem

原始记录 未单独记录问题陈述；以下保留原有决定及其条件。

## Decision
Auto mode delegates operations that need review to policy. The new automatic reviewer is gated by `autoReviewV2`; disabled deployments use human approval.

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
Rollout is reversible and cannot use a system source to elevate authorization to `full_access`.
