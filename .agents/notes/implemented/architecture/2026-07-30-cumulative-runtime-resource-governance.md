# Agent Note: 父子 Agent 使用累计资源预算、原子并发许可与统一终态

Status: implemented

## Problem
单个 runner 的 `maxEffects` 不能限制父子 Agent 的累计 token、模型、工具、子进程或 artifact
消耗。并行 batch 和 shell overlap 如果不逐 invocation reservation，会绕过预算；无限 permit
等待也会把饱和误报成完成。

## Decision
1. `ResourceBudgetV1` 对整个 run 及全部 Sub-agent 累计 time、turn、model/tool request、token、
   sub-agent、artifact 与 tool/shell concurrency；配置只能收紧。
2. dispatch 前按可执行上界建立持久 reservation，完成后 reconcile；无法预留时零副作用拒绝。Model 输入 token 的本地估算使用完整 2 倍上界；剩余额度不足以覆盖该上界时，在 Provider 派发前结束为预算耗尽，不把 reservation 截成剩余额度后继续发送。
3. 当前普通 Tool/Shell 不按活动数量或写者数量占 permit；累计 Tool 次数仍按 Run 的有效预算限制。
   独立 code Sub-agent 的写者额度仍按其子任务 allotment 计。写 Tool 的 Artifact 上界若
   暂被未结算 reservation 占用，使用持久 `artifact_capacity` waiter 等待；截止时间取
   `maxConcurrencyWaitMs` 与 run deadline 较早者。已知上界可同时放进预算的写 Tool
   直接准入。旧 Tool/Shell/writer waiter 仍可读取，重入时按现行类型取消或替换。
   新独立 child 与 v2 followup 的上界也不占 Tool/Shell 数量 gauge；历史非零上界继续按
   原持久事实校验。预算 schema 中的并发数字为旧记录和 writer 约束保留，不参与普通 Tool 派发。
4. process-tree 上限属于 1B `ExecutionBoundaryV1` 平台 enforcement；顶层 shell permit 不等于
   descendant 数量。
5. 1C 拥有唯一 `RuntimeSchedulingPolicyV1` producer，快照覆盖 read batch barrier、shell
   overlap、admission 与 late-event policy。
6. terminal 至少区分 completed/blocked/failed/unknown/cancelled/cancel_incomplete/
   budget_exhausted/resource_saturated/verification_failed/verification_inconclusive。
   final text、Plan completed 或进程零退出码不能单独转为 completed。
7. terminal 后停止新 sibling，运行中 child 有界清理；stale lease/late event 不能覆盖 durable
   terminal。父 Run 受管等待 required 独立 child 时，除了父事件还需观察子任务及执行权租约；未知或失权应终止等待并进入显式恢复，不得无限等待或伪造成功。
8. 未派发 Tool 的 Artifact 等待超时或累计预算拒绝只结算该 Tool；旧式同步 Task 的子并发
   许可超时若已提交为 Task Tool 失败，也不再次升级。模型可在同一 Run 中处理这些失败；
   模型预算、未知外部结果和持久化等 Run 级边界仍可终止 Run。审批尚未派发的 Tool 不按
   Tool 调用次数及产物上界结算实际用量；Shell 缺少可靠文件变更事实时保守结算其上界。
   普通 Tool 的适配异常若由持久 State 证明没有执行尝试，则原子提交 Tool 失败和预留释放；
   已派发或持久化状态不明时保留恢复边界，不能以局部失败掩盖未知外部结果。

## Alternatives considered
- 继续使用 `maxEffects`：拒绝，缺少累计维度和并发 reservation。
- permit 只计 batch：拒绝，单批可绕过 invocation 上限。
- 把暂时占用的 Artifact 上界当作永久预算耗尽并结束 Run：拒绝，并行工具的先后顺序会误伤整个 Agent。
- 在 Shell 缺少文件变更证据时按零产物结算：拒绝，可能漏计未观测到的外部写入。
- 超时统一记 failed/completed：拒绝，破坏 Gate 与恢复判断。

## Consequences
Runtime 需要持久 reservation/waiter、迁移、replay、fault 和 soak tests；具体 internal/limited
数值仍由 D-11 关闭记录批准。

## 回滚
可以收紧预算或关闭相关 capability；不能恢复无限运行、非原子 permit、无限等待、遗留无 owner
进程，或把 budget/cancel/unknown 终态显示为完成的旧路径。

## Historical relationships

决策者：`github:@ferqx`（Platform + Release + Runtime，single-maintainer）

补充：[Agent Note 0001](2026-07-02-runtime-kernel.md)、[Agent Note 0048](../bug-fix/2026-07-29-durable-user-turn-cancellation.md)、[Agent Note 0049](../bug-fix/2026-07-30-effect-aware-read-scheduling.md)

关联：D-11、Phase 1C
