# ADR-0001: Runtime Kernel is the state-transition authority

**Status**: accepted  
**Date**: 2026-07-02

## Context

The agent needs durable, testable state transitions without graph-owned mutable channels.

## Decision

Runtime events are reduced exclusively by `src/core/runtime/reducer.ts`; `AgentKernel` persists events and snapshots at the same durability boundary.

## Consequences

Controllers emit facts, applications collect UI actions, and neither mutates runtime state directly.
