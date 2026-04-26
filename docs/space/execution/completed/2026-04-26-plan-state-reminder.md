# Completed: Plan State Reminder Projection

Date: 2026-04-26
Status: completed
Related active rule: `../active/plan-state-reminder.md`
Related understanding:

- `../../understanding/2026-04-26-plan-state-context-projection.md`
- `../../references/opencode-codex-plan-handling.md`

## Change

Moved `graph.state.plan` out of runtime context and into a trailing synthetic
user-side runtime state reminder.

Implementation shape:

- `src/model/context.ts` appends `HumanMessage(formatPlanStateReminder(plan))`
  after compacted conversation messages.
- `src/model/runtime-context.ts` formats the reminder as
  `<runtime-state source="graph.state.plan">`.
- Evidence/progress ledgers were later removed; tool results and graph state are
  now the durable runtime record.
- `tests/context.test.ts` locks the trailing synthetic user-side message shape.
- `tests/runtime-context.test.ts` locks exclusion of dynamic plan state from
  runtime context.

## Rationale

This preserves provider-agnostic prompt semantics:

- static rules remain in system messages;
- dynamic plan state does not rely on provider-specific system message handling;
- plan state appears after stable context to reduce prefix/KV cache disruption;
- `graph.state.plan` remains the source of truth.

## Verification

Validated with:

```bash
bun test tests/context.test.ts tests/runtime-context.test.ts
bun run typecheck
```
