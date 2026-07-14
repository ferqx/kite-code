# ADR-0007: Capability identity and turn-scoped bindings

**Status**: accepted
**Date**: 2026-07-14

## Context

MCP discovery is dynamic. A tool name alone cannot establish that the model saw the current schema or that an approval applies after a server changes its catalog.

## Decision

The Runtime derives immutable capability descriptors and SHA-256 revisions from normalized contracts. Every model call receives only Runtime-issued, turn-scoped bindings. A dynamic MCP call must resolve its binding and the current descriptor revision before policy or provider execution.

`capabilityCatalogV1` and `mcpRuntimeBindingV1` default to disabled. When either is disabled, MCP calls fail closed; there is no legacy execution route or checkpoint compatibility.

## Consequences

Tool-count caches and server-level `risk: read` are removed. MCP schemas are object-root Draft-07 only in P0 and are validated before binding and execution. A catalog change invalidates existing bindings instead of silently changing what a model call means.

## Rollback

Disable either P0 flag. MCP becomes unavailable rather than reverting to the removed direct adapter.
