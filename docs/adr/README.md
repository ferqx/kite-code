# Architecture decision records

ADRs preserve decisions that alter runtime boundaries, lifecycle, policy, or execution engines. They are historical: do not rewrite an accepted decision; add a newer ADR and mark the old one superseded when necessary.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-runtime-kernel.md) | accepted | Runtime Kernel is the state-transition authority |
| [0002](0002-plan-lifecycle.md) | accepted | PlanningState replaces the plan-reviewed boolean |
| [0003](0003-auto-review-policy.md) | accepted | Auto-review is policy-gated and feature-flagged |
| [0005](0005-interaction-state.md) | accepted | InteractionState owns waiting UI states |
| [0006](0006-loop-mode-design.md) | proposed | Loop mode requires a separate design decision |
