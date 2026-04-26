# Reference: Opencode And Codex Plan Handling

Date: 2026-04-26
Status: reference
Related local records:

- `../understanding/2026-04-26-plan-state-context-projection.md`
- `../execution/active/plan-state-reminder.md`

## Opencode

Observed pattern:

- Static provider/agent instructions are assembled as system content.
- Dynamic plan-mode reminders are appended as synthetic text on the latest user
  message, not as tail system content.
- Tool outputs remain ordinary tool/message state; there is no observed pattern
  of injecting an extra evidence or progress heartbeat reminder on every turn.
- Experimental plan mode stores the plan in a plan file, but the useful local
  lesson is the synthetic-message placement, not the file mechanism.
- Plan/build switching is represented through synthetic user messages created by
  the harness.

Relevant upstream areas:

- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/tool/plan.ts`
- `packages/opencode/src/agent/agent.ts`

## OpenAI Codex

Observed pattern:

- `update_plan` is a UI/checklist tool.
- The useful information is the tool input consumed by the harness/client.
- The tool result returned to the model is intentionally minimal (`Plan updated`).
- Prompt guidance tells the model not to repeat the full plan after
  `update_plan` because the harness displays it.
- Progress updates and verification guidance are handled through instructions,
  tool results, and client events rather than a separate injected
  evidence/heartbeat prompt block.

Relevant upstream areas:

- `codex-rs/core/prompt.md`
- `codex-rs/core/src/tools/handlers/plan.rs`
- `codex-rs/protocol/src/plan_tool.rs`
- `codex-rs/core/src/compact.rs`

## Local Takeaway

Do not copy Opencode's plan-file mechanism into this LangGraph checkpoint
architecture. Keep `graph.state.plan` as durable state, but project it to the
model as a trailing harness-generated conversation item.

Do not keep a separate evidence/progress ledger by default. Tool results,
permission boundaries, plan state, and graph recursion limits are enough unless a
concrete tool-boundary need is proven.
