# Completed: Remove Internal Ledgers

Date: 2026-04-26
Status: completed
Related active rule: `../active/tool-gated-autonomy.md`
Related references:

- `../../references/opencode-codex-plan-handling.md`

## Change

Removed the internal evidence/progress ledger mechanism.

Implementation shape:

- Removed `src/harness/evidence.ts`.
- Removed `src/harness/progress.ts`.
- Removed `state.evidence` and `state.progress`.
- Removed stagnant watchdog and repeated-tool doom-loop guard logic.
- Removed `AgentEvidence`, `AgentHeartbeat`, and `AgentProgressLedger` types.
- Kept tool result messages as the model-visible record of tool execution.
- Kept approval and plan-mode tool gating as the enforced safety boundary.

## Rationale

After removing the final-answer stop-check, evidence/progress ledgers no longer
serve a clear harness boundary. Their remaining role was progress inference, but
that duplicates model judgment and diverges from the tool-boundary design used
by Codex and Opencode.

The harness should enforce dangerous actions at tool boundaries and otherwise
let model behavior be shaped by instructions, tool results, and graph recursion
limits.

## Verification

Validated with:

```bash
bun test tests/graph.test.ts tests/context.test.ts tests/runtime-context.test.ts
bun run typecheck
```
