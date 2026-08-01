# ADR-0055：父子 Agent 使用累计资源预算、原子并发许可与统一终态

状态：accepted
日期：2026-07-30
决策者：`github:@ferqx`（Platform + Release + Runtime，single-maintainer）
补充：ADR-0001、ADR-0048、ADR-0049
关联：D-11、Phase 1C

## 背景

单个 runner 的 `maxEffects` 不能限制父子 Agent 的累计 token、模型、工具、子进程或 artifact
消耗。并行 batch 和 shell overlap 如果不逐 invocation reservation，会绕过预算；无限 permit
等待也会把饱和误报成完成。

## 决策

1. `ResourceBudgetV1` 对整个 run 及全部 Sub-agent 累计 time、turn、model/tool request、token、
   sub-agent、artifact 与 tool/shell concurrency；配置只能收紧。
2. dispatch 前按可执行上界建立持久 reservation，完成后 reconcile；无法预留时零副作用拒绝。
3. 每个 tool/shell invocation 独立占 permit。shell 的 tool+shell permit 原子 all-or-none；
   waiter 按资源 FIFO，截止时间取 `maxConcurrencyWaitMs` 与 run deadline 较早者。
4. process-tree 上限属于 1B `ExecutionBoundaryV1` 平台 enforcement；顶层 shell permit 不等于
   descendant 数量。
5. 1C 拥有唯一 `RuntimeSchedulingPolicyV1` producer，快照覆盖 read batch barrier、shell
   overlap、admission 与 late-event policy。
6. terminal 至少区分 completed/blocked/failed/unknown/cancelled/cancel_incomplete/
   budget_exhausted/resource_saturated/verification_failed/verification_inconclusive。
   final text、Plan completed 或进程零退出码不能单独转为 completed。
7. terminal 后停止新 sibling，运行中 child 有界清理；stale lease/late event 不能覆盖 durable
   terminal。

## 备选方案

- 继续使用 `maxEffects`：拒绝，缺少累计维度和并发 reservation。
- permit 只计 batch：拒绝，单批可绕过 invocation 上限。
- 超时统一记 failed/completed：拒绝，破坏 Gate 与恢复判断。

## 后果

Runtime 需要持久 reservation/waiter、迁移、replay、fault 和 soak tests；具体 internal/limited
数值仍由 D-11 关闭记录批准。

## 回滚

可以收紧预算或关闭相关 capability；不能恢复无限运行、非原子 permit、无限等待、遗留无 owner
进程，或把 budget/cancel/unknown 终态显示为完成的旧路径。
