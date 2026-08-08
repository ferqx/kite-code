# ADR-0071：TUI 以本地恢复投影处理崩溃遗留的交互

状态：accepted
日期：2026-08-08
决策者：`@chenchao`
关联：ADR-0005、ADR-0016、ADR-0017、ADR-0048、ADR-0050、`docs/active/cancel-resume-cleanup.md`

## 背景

人工交互（`ask_user`、工具审批、Plan review、Provider action/admission 与子 Agent 工具审批）会先
进入 Runtime 的 `awaiting_*` 状态，再等待 App 收集用户操作。进程可能在等待期间强制退出；这时
Runtime event store 的 canonical 事实正确地保留 pending interaction，但 TUI 不能在重启后把已经
失去上下文的旧提示再次展示给用户。

把 TUI 的恢复展示直接写成 `approval.rejected`、`plan.rejected` 或其他用户终态会伪造用户没有做过的
决定，并改变其他客户端看到的 canonical state。反之，自动重新请求或执行旧 interaction 会重复审批，
并可能重试未知的外部副作用。自动审查还必须区分真实的自动拒绝与 Provider/网络/格式等技术异常。

## 决策

1. Runtime canonical event store 只写真实发生的用户操作和执行事实。用户明确回答、批准、拒绝或取消时，
   必须先持久化带 `interactionId` 与关联 `toolCallId` 的终态事件，再清除 UI；Plan review 额外绑定
   `planId`、`version` 与 `structuralDigest`。
2. TUI 回放发现未终结的人工 `awaiting_*` interaction 时，只在客户端生成“用户取消执行（会话恢复时交互
   未完成）”的本地投影。它清除 interrupt、pending tool、Plan `pendingPlan` 与子 Agent
   `awaitingApproval`，但绝不向源 Runtime store 写伪造的 approval/plan/user-input 终态。
3. 本地取消仅适用于尚未跨过执行或副作用边界的工具。已出现 `tool.started`、外部副作用、未知 Capability
   invocation 或 unknown resource reservation 时，Runtime 状态保持 `unknown` 并进入 reconciliation；
   禁止 TUI 自动取消、自动重试或自动执行。
4. 用户在本地恢复投影上首次继续新工作时，TUI 从清理后的 snapshot fork 新恢复会话。源会话及其 pending
   canonical 事实保持不变；fork 清除待交互、临时授权和活动队列，并只排除造成当前 pending 的请求事件，
   以防 fork 的事件回放重新出现旧 prompt。
5. `auto_review` 不是人工审批。`ok: true, approved: false` 是自动明确拒绝；`ok: false` 是技术异常，
   必须转为新的人工 `approval.requested`，绝不默认通过。缺少 `failureType` 的历史失败记录按未完成技术
   异常保守处理，TUI 仅产生本地投影。

## 备选方案

- **回放时写入用户拒绝事件**：拒绝。它将客户端恢复策略伪装为用户真实决定，污染 canonical history，
  也会向其他客户端传播错误事实。
- **再次显示或自动重新请求 pending interaction**：拒绝。原来的 UI 上下文已经丢失；重复提示会造成重复
  审批，且无法安全处理可能已产生副作用的调用。
- **在源会话中原地清除 pending state**：拒绝。它抹掉其他客户端仍可用于恢复或 reconciliation 的真实
  Runtime 事实，违反 Core 与客户端投影的边界。
- **将所有未完成调用标记为 cancelled**：拒绝。执行已开始或结果未知时，`cancelled` 会错误宣称没有副作用；
  这些调用必须保持 unknown。

## 后果

- replay 展示可以安全恢复且不会产生虚假的用户操作；不同客户端仍能以源 canonical state 选择自己的恢复
  策略。
- TUI 继续工作会产生一个可审计的恢复 fork，而不是修改源会话；用户能继续当前界面中的本地投影。
- 所有交互终态需要严格的 identity 校验，旧或重复 terminal event 不得清除新的 interaction。
- Runtime、TUI reducer/replay 与 SessionManager/store 需要覆盖崩溃恢复、延迟终态、unknown side effect、
  auto-review 异常和恢复 fork 的测试。

## 回滚

可关闭或移除 TUI 的本地恢复投影并重新显示 canonical pending interaction；不得以向源 event store 写伪造
用户拒绝作为回滚方式。若移除恢复 fork，TUI 必须拒绝继续新工作，直到用户在仍可见的原客户端中完成或取消
该 interaction。
