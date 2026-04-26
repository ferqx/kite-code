# Active Rule: Tool-Gated Autonomy

Status: active
Last updated: 2026-04-26
Last verified: 2026-04-26
Scope:

- `src/harness/graph.ts`
- `src/harness/routes.ts`
- `src/harness/tool-runner.ts`
- `tests/graph.test.ts`

Read when:

- Editing graph routing.
- Editing approval behavior.
- Changing plan-mode or builder-mode tool permissions.
- Reintroducing any final-answer guard or non-dangerous confirmation gate.

Related:

- `../completed/2026-04-26-remove-stop-check.md`
- `../completed/2026-04-26-remove-internal-ledgers.md`
- `../../references/opencode-codex-plan-handling.md`

Verification:

- `bun test tests/graph.test.ts`
- `bun run typecheck`

## Rule

The harness should not hard-block model final answers with a stop-check node.
Model completion is governed by prompt constraints and ordinary graph routing.

Human confirmation is reserved for protected tool execution:

- Builder mode routes write/delete/execute-style tool requests through approval.
- Plan mode only allows read-only tools and `update_plan`; write or execute
  attempts are rejected by the tools layer.
- Non-dangerous final answers, plan summaries, and mode completion do not trigger
  approval interrupts.

Reflect logic may inject guidance after tool failures, but it must not become a
final-answer reviewer or progress inference engine.

## Do Not

- Do not reintroduce `stop_check` routing as a hard final-answer guard.
- Do not add a non-dangerous `mode_confirmation` interrupt for plan completion.
- Do not move safety checks out of tool gating into prompt-only instructions for
  protected operations.
- Do not silently weaken plan-mode read-only enforcement.
- Do not reintroduce evidence/progress ledgers or watchdog-style progress
  inference without a concrete tool-boundary need.

## Test Expectations

`tests/graph.test.ts` should assert:

- plan-mode final routes directly to `END`;
- builder final routes directly to `END`;
- plan-mode write attempts go to tools and are rejected;
- protected builder tool calls still route through approval;
- repeated read-only tool calls are not blocked by tool-runner progress state;
- reflect returns to the active agent unless a final is already present.
