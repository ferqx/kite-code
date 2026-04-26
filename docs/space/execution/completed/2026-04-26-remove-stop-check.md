# Completed: Remove Stop Check

Date: 2026-04-26
Status: completed
Related active rule: `../active/tool-gated-autonomy.md`

## Change

Removed the final-answer stop-check mechanism from the LangGraph loop.

Implementation shape:

- Removed `src/harness/stop-check.ts`.
- Removed the `stop_check` graph node and conditional edges.
- Removed `routeAfterStopCheck`.
- Plan-mode and builder-mode final answers now route directly to `END`.
- Removed non-dangerous `mode_confirmation` interrupts for plan completion.
- Kept approval for protected builder tool execution.
- Kept plan-mode tool-layer rejection for write or execute attempts.

## Rationale

The harness should increasingly trust the model to follow prompt constraints and
should only interrupt the user for dangerous or out-of-policy tool execution.
Final-answer quality constraints belong in the agent contract and tests, not in a
hard-coded post-final reviewer.

This aligns local behavior with the principle that harnesses should enforce
safety at tool boundaries while avoiding unnecessary control-flow gates around
normal model output.

## Verification

Validated with:

```bash
bun test tests/graph.test.ts
bun run typecheck
```
