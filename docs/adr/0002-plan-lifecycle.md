# ADR-0002: PlanningState replaces plan-reviewed boolean

**Status**: accepted  
**Date**: 2026-07-02

## Decision

Use the discriminated `PlanningState` lifecycle and a versioned `PlanDocument` rather than independent boolean flags. Structural changes require review; progress updates do not.

## Consequences

Planning phase is derived from state and plan approval/revision is replayable as runtime events.
