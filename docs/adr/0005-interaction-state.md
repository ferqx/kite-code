# ADR-0005: InteractionState owns waiting UI states

**Status**: accepted  
**Date**: 2026-07-02

## Decision

User input, plan review, tool approval, and automatic review are represented by one discriminated `InteractionState` in runtime state.
