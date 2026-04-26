# Space Index

Last updated: 2026-04-26

This is the navigation point for `docs/space/`. Do not read every record by
default. Use the scope and "read when" notes below to pull only the context
needed for the current task.

`docs/space/` does not store per-run `graph.state.plan` values. Runtime plans
remain checkpoint state; this index tracks durable project records.

Status meanings:

- `active`: current rule that should constrain edits in its scope.
- `completed`: historical implementation record and verification evidence.
- `understanding`: design background or rationale.
- `reference`: external source summary.
- `generated`: derived material with lower authority.

## Active Records

| Record | Status | Scope | Read when |
| --- | --- | --- | --- |
| `execution/active/plan-state-reminder.md` | active | Model context construction, plan projection, cache-sensitive prompt layout | Editing `src/model/context.ts`, `src/model/runtime-context.ts`, or tests for plan/context projection. |
| `execution/active/tool-gated-autonomy.md` | active | Graph routing, approval boundaries, tool gating, final-answer autonomy | Editing `src/harness/graph.ts`, `src/harness/routes.ts`, `src/harness/tool-runner.ts`, or tests for approval/final routing. |

## Understanding Records

| Record | Status | Purpose |
| --- | --- | --- |
| `understanding/space-system-design.md` | understanding | Defines how `docs/space` works as a repository-local record system. |
| `understanding/2026-04-26-plan-state-context-projection.md` | understanding | Explains why `graph.state.plan` is projected as runtime state instead of relying on tool-message history or system prompts. |

## Completed Execution Records

| Record | Status | Purpose |
| --- | --- | --- |
| `execution/completed/2026-04-26-plan-state-reminder.md` | completed | Records the implementation and verification for moving plan state into a trailing synthetic user-side reminder. |
| `execution/completed/2026-04-26-remove-stop-check.md` | completed | Records removal of the final-answer stop-check and non-dangerous mode confirmation gate. |

## References

| Record | Status | Source |
| --- | --- | --- |
| `references/openai-harness-engineering.md` | reference | OpenAI article on Codex harness engineering and repository knowledge systems. |
| `references/opencode-codex-plan-handling.md` | reference | Local comparison of Opencode and Codex plan handling. |

## Generated Boundary

| Record | Status | Purpose |
| --- | --- | --- |
| `generated/README.md` | generated | Defines the lower authority and promotion rules for generated materials. |

## Maintenance Rules

- Keep `AGENTS.md` short and use it as a map to this index.
- Add status, scope, related records, and verification notes to records that can
  affect future implementation.
- Promote a generated or reference note into `execution/active/` only with a
  concrete local rule and, where practical, tests.
- Retire stale active rules by updating the record status, moving the current
  rule out of active if needed, and adding a completed record with rationale.
