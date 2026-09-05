# ADR-0173：Server Run 与 TUI 展示使用分层生命周期权威

**Status**: accepted
**Date**: 2026-09-04
**Decision makers**: @chenchao
**Complements**: ADR-0001、ADR-0048、ADR-0095、ADR-0150、ADR-0166、ADR-0167、ADR-0168、ADR-0171、ADR-0172

## Context

当前 Runtime 同时使用四种容易混淆的 Run 语义：Store 中由一次 accepted `start_turn` 创建的执行资源、Kernel
`run.completed` 所表达的 Task 完成接受事实、父子 Agent 共享的 Resource Budget scope，以及 Client completion waiter
观察到的终态。V1 创建时 Store `runId` 等于 initial `turnId`，但 Provider Action continuation 会在同一已接受执行中创建新
Turn。Host 若继续用 final/current `turnId` 查 Run row，会丢失原 accepted Run identity；Client 若用 `activeWork` 缺失、Promise
收尾或 TUI idle 代替 Run terminal，又会让旧投影提前结束后继执行。

TUI 同时把 Server Run 影子状态、本地 prompt/cancel command、Request/Thought 组装、Timeline 完成和 Ink Static owner
压入 `running`、`responsePending` 等共享标量。这样 renderer 或本地交互可能反向影响 Server lifecycle，也无法可靠隔离
reconnect、stale revision 与后台 Session。

当前持久 State/event format、`runtime_runs`、transaction revision、command receipt 和 named turn checkpoint 已经提供足够的
事务边界。本次收敛不应为 Work 新建领域实体、给 Turn 增加持久 `runId`、双写新旧 lifecycle，或在线重写 SQLite history。

## Decision

1. Task、Turn、RuntimeRun、BudgetScope、SessionOperation、Client command、Presentation 和 Render 是互不替代的生命周期。
   Server facts可以推进presentation；presentation、Promise、Footer、Ink flush、unmount与render quiescence不能证明Server terminal。
2. 一个 accepted `start_turn` 创建一个 stable RuntimeRun 和 initial Turn。V1 保留
   `runId === initialTurnId` 的创建兼容；Provider Action continuation 可以在同一 Run 内创建新 Turn，不能创建第二 Run。
3. stable Run identity 只由同 Session 唯一 active Run row、事务 revision 与当前 Turn 的一致提交共同证明。continuation
   transaction 推进该 active row；terminal closure 从该 row 取得 canonical `runId`。旧 history 或恢复状态不能唯一证明映射时，
   fail closed 为 `recovery_required`，不得猜测 final `turnId`。
4. Task completion 继续写 current-format 的完整 `run.completed` payload。State/history 层将其规范化为内部
   `CanonicalTaskCompletionFact(taskId, runId, turnId, output, completionGuardVersion, planIdentity?, outcome)`，并由唯一 Task
   completion reducer 消费。raw event 改名、双发 `task.completed` 或新 format epoch 不属于本决策。
5. Task、Turn 与 RuntimeRun 分别终结。normal、user cancel/approval reject、deadline/fatal 与不确定恢复通过唯一 Host terminal
   closure，在同一 State/Store transaction 决定 Task/Turn facts、Run transition、terminal outcome 与 snapshot；notification 只在
   commit 后发布。每个 Run 最多一个 precise terminal；无法确认 cleanup/outcome 时保持 `recovery_required` 阻塞态。
6. `RuntimeSessionProjection` 的 current vocabulary 分为 `activeTask`、current-or-last `currentRun` 与 canonical
   `interactionQueue`。`Work` 不是领域实体；旧 `activeWork` 已在 v2 客户端迁移完成后删除。
7. Client completion waiter 绑定 `sessionId + runId + commandId + revisionFloor`，只接受 authoritative exact Run query/event
   的 `completed|failed|cancelled`。`recovery_required` 不正常 resolve，也不允许 successor admission。
8. durable notification 必须先由 RuntimeClient generation/revision store 接受再 dispatch；ephemeral presentation 保留
   work/turn/actor/attempt/composition/stream/request/sequence fencing。gap 进入 `presentation_incomplete`，不能提交截断回答。
9. TUI 每 Session 分开保存 Server RunView、本地 Start/Cancel/Prompt command、Request/Thought/Timeline projection 与
   RenderLifecycle。Timeline projector 一次性发布 `LiveItem | SealedItem`；renderer 只提交连续 sealed 前缀，不再解释业务终态。
10. Resource Budget 的 current persistent `runId` 只在 typed view 中称为 `budgetScopeId`，不得用于 RuntimeRun waiter/query/
    terminal correlation。本决策不改变其持久 shape 或新增 scope terminal。
11. 协议切换使用 exact version；同一 connection 只发布一种 vocabulary。禁止 production feature flag、dual Host/Store、dual
    terminal/writer、try-new-catch-old fallback 与数据库自动重写。

## Alternatives

- 给每个 continuation Turn 新建 Run：拒绝；它改变 accepted-command resource 语义，并产生 orphan Run 与错误 waiter identity。
- 给所有 Turn event 增加持久 `runId`：延期；当前唯一 active Run row 与 transaction revision 足以承载 V1，且本次必须保持
  current format 与 rollback 可读性。
- 保留 `activeWork/running` 作为第二终态权威：拒绝；它把兼容 DTO、本地提交和 Server terminal 混为一体。
- 新旧 lifecycle 通过 feature flag 或双发并行：拒绝；会形成 production dual authority，且无法保证同一连接的 exact 语义。
- 让 renderer 从 tool/thought flags 推断 settled：拒绝；业务 projector 与物理 Static owner 会重复决定完成。

## Consequences

- Provider continuation、restart、live/history 与 completion waiter 都保留 accepted receipt 的 stable Run identity。
- 不确定恢复会显式阻塞而不是伪装 idle/failed；调用方需要展示或处理 typed recovery-needed 结果。
- Contract、Service、Native client 与 TUI 必须作为一个 exact-version candidate 收敛；过渡兼容只允许单向 projection，不得参与
  admission、cleanup 或 terminal。
- Request assembly 必须有界。基线固定 transport message 为 1 MiB、单 client text field 为 65,536 code units；新 projector
  采用 1 MiB/request 与最多 64 个同时未决 request 的上限，超限或 gap 进入 `presentation_incomplete`，不静默截断后 seal。

## Rollback

本决策保持 current State/event format，rollback 只能切换完整 same-build candidate，不需要也不得增加 fallback reader 或数据库
重写。LFC-01～03 可在保留 regression tests 的前提下回滚内部 view/state machine；LFC-04 之后 Contract/Protocol/Server/Client
必须整体回滚。若实现证明唯一 active Run row 无法恢复 stable identity，停止当前阶段并另立显式 format/migration ADR。
