# TUI message projection and rendering baseline

状态：已冻结的 TMR-00 基线

日期：2026-09-05

关联：ADR-0174 与 `docs/space/plans/2026-09-05-tui-message-projection-rendering-convergence.md`

This record freezes the failure traces and the executable golden owners used by TMR. It is not a
current-behavior authority; source, owner documentation, and tests remain authoritative. A trace is complete only
when the same identity can be followed through committed Runtime fact, accepted envelope, Timeline adapter, and
PTY-visible frame.

## Trace schema

```text
server: persisted event type + revision + Run/Task/Turn/Tool/Subagent/Interaction identity
client: sessionId + connectionGeneration + durability + revision/stream tuple + source identity
timeline: item identity + live/sealed + canonical visualDigest
adapter: OutputBlock kind + presentationState + renderer-visible fields
pty: ordered marker occurrence count + focused interaction + post-terminal stdout
```

## Frozen counterexamples and golden owners

| Trace | Frozen counterexample | Required converged projection | Executable golden |
| --- | --- | --- | --- |
| reasoning-first | completed reasoning could be emitted as a second owner after answer text | one request assembly; reasoning owner precedes one sealed answer | `apps/kite-cli/test/tui-client-reducer.test.ts`, `tests/tui-system/scenarios/thought-lifecycle.test.ts` |
| content-first | late reasoning could insert before an already displayed answer | late reasoning remains history evidence and never reorders the sealed answer | `apps/kite-cli/test/tui-client-reducer.test.ts`, `tests/tui-system/scenarios/model-streaming.test.ts` |
| tool-bearing response | pending narration and exploration could split into duplicate Thoughts | `presentationGroupId + toolCallId` update one Thought; terminal answer appears once | `apps/kite-cli/test/tui-projector-convergence.test.ts`, `tests/tui-system/scenarios/thought-header-merge.test.ts` |
| repeated reads | adjacent tool names were sufficient to merge unrelated work | only Server-projected exploration items sharing the exact group aggregate | `apps/kite-cli/test/tui-client-reducer.test.ts`, `tests/tui-system/scenarios/tool-lifecycle.test.ts` |
| standalone mutation | queued metadata or progress could imply that execution had started | queued remains hidden; started materializes; one terminal seals | `apps/kite-cli/test/tui-tool-progress.test.ts`, `tests/tui-system/scenarios/tool-approve.test.ts` |
| concurrent Subagents | same-name child steps or interleaved siblings could update the last pending row | `subagentId` identifies a child, `concurrencyGroupId` identifies its group, and `stepId + toolCallId` identifies a step | `apps/kite-cli/test/tui-projector-convergence.test.ts`, `tests/tui-system/scenarios/subagent-approval.test.ts` |
| manual approval | focused approval and `Working` competed, and settlement could target a heuristic child | approval hides Run status and settles only an exact interaction generation and owner | `apps/kite-cli/test/tui-layout.test.tsx`, `tests/tui-system/scenarios/approval-escape.test.ts` |
| automatic review | a transient fixture state could complete the card while durable child continuation failed | phase/review events update the exact child and no manual Footer appears | `tests/integration/runtime/auto-review-parent-lifecycle.test.ts`, `tests/tui-system/scenarios/subagent-approval.test.ts` |
| approval reject/Esc/Ctrl+C | a local acknowledgement could terminalize the wrong child or whole Run | local submission is non-authoritative; durable rejection/cancellation owns settlement | `apps/kite-cli/test/tui-projector-convergence.test.ts`, `tests/tui-system/scenarios/approval-escape.test.ts` |
| queued successor | predecessor terminal or cleanup could resolve the successor | receipt Run identity and revision floor fence the predecessor; queued prompt hides Run status | `apps/kite-cli/test/service-mode/tui-client.test.ts`, `tests/tui-system/scenarios/cancel-successor-render.test.ts` |
| terminal before receipt | an internal waiter completed without replaying presentation | receipt join redispatches the same accepted terminal envelope exactly once to the projector | `apps/kite-cli/test/service-mode/tui-client.test.ts` |
| reconnect/late stream | an old generation or post-terminal ephemeral packet changed visible content | generation, stream sequence, and closed Run fences reject it | `packages/runtime-client/test/runtime-client.test.ts`, `apps/kite-cli/test/tui-projector-convergence.test.ts`, `tests/tui-system/scenarios/model-stream-reconnect.test.ts` |
| history replay | bare events bypassed live identity and produced a different digest | deterministic history envelopes feed the same projector and produce the same sealed digest | `apps/kite-cli/test/tui-replay-blocks.test.ts`, `apps/kite-cli/test/tui-static-content.test.tsx` |
| model switch | Bridge-captured config could change an active Run or remain stale forever | admission freezes active config; saved desired config starts the next real provider request | `apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts`, `tests/tui-system/scenarios/model-streaming.test.ts` |
| theme/language/overlay | App remount duplicated Static history or lost input focus | overlay owns only its subtree; visual selection advances one RenderEpoch and redraws the viewport once | `apps/kite-cli/test/tui-layout.test.tsx`, `apps/kite-cli/test/tui-static-content.test.tsx`, `tests/tui-system/scenarios/slash-commands.test.ts` |
| session switch | background events entered the foreground or lost their connection fence | each Session buffers accepted envelopes and restores its own authority projection | `apps/kite-cli/test/service-mode/tui-client.test.ts`, `tests/tui-system/scenarios/session-switch.test.ts` |
| `/clear` | local block IDs restarted and collided with an Ink commit ledger | RenderEpoch advances while logical block IDs remain monotonic | `apps/kite-cli/test/tui-reducer.test.ts`, `tests/tui-system/scenarios/slash-commands.test.ts` |
| resize | only one resize direction reflowed, or a redraw appended history again | narrow↔wide both perform one synchronized viewport commit with stable Timeline identity | `apps/kite-cli/test/tui-static-content.test.tsx`, `tests/tui-system/scenarios/resize.test.ts` |

## PTY failure captured during TMR-00

The initial serial `subagent-approval` run failed with
`Builtin subagent result projection failed closed.` Although the child card reached `done!`, the parent tool result
was rejected and the final provider response remained unconsumed. The exact cause was a pre-epoch Builtin result
allowlist that rejected the newly required `stepId` and `toolCallId`. This is retained as the cross-layer regression
for the State/Event epoch change; unit-only reducer success is not sufficient evidence.

## Acceptance rule

For each row, a passing lower-layer test proves only its named boundary. TMR-07 requires the repository serial PTY
runner for process-global fixtures, and a terminal frame must contain each stable marker once with no idle stdout.
