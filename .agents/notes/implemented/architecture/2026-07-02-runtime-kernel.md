# Agent Note: Runtime Kernel is the state-transition authority

Status: implemented

## Problem
The agent needs durable, testable state transitions without graph-owned mutable channels.

## Decision
Runtime events are reduced exclusively by `src/core/runtime/reducer.ts`; `AgentKernel` persists events and snapshots at the same durability boundary.

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences
Controllers emit facts, applications collect UI actions, and neither mutates runtime state directly.
