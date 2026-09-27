# Agent Note: PlanningState replaces plan-reviewed boolean

Status: implemented

## Problem

原始记录 未单独记录问题陈述；以下保留原有决定及其条件。

## Decision
Use the discriminated `PlanningState` lifecycle and a versioned `PlanDocument` rather than independent boolean flags. Structural changes require review; progress updates do not.

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
Planning phase is derived from state and plan approval/revision is replayable as runtime events.
