# Agent Note: 可配置的子 Agent 即时准入与独立工具执行

Status: implemented

## Problem
固定的调度批次上限、父级子任务并发额度及普通 Tool/Shell 活动数许可曾叠加作用。第三个子任务可能获得已受理的 queued 状态，却在首次模型派发前等待预算位。等待期间子 Session 初始执行租约未登记给本机续约 owner，过期后预派发失败结算也无法取得执行权；父 Run 已解除其他两个子任务时，仍持有该子任务的 required claim 而持续等待。普通工具的活动数许可还可能使同一个子 Agent 发出的并行工具在队列中超时。

## Decision
1. 新 Run 持久化 `resources.maxConcurrentSubagents`，缺省为 3，并在系统提示词中展示当前 Run 的实际值。配置只能是正安全整数；运行中的 Run 不随之后的配置变化改变额度。
2. 同一模型响应中经 traits 与授权检查的兼容 `task` 调用全部尝试派发；Kernel 不使用固定批次大小充当子 Agent 数量上限。Service 在成功的父工具回执前，将已活动 child 与本批尚未提交的受理计入上限。满额时立即返回具名失败，不创建 child intent、Session 或 queued allotment。`code` child 还受已有写者额度约束；写者满额时同样即时失败。
3. 普通 Tool/Shell 不因同时活动的工具数量取得 FIFO 许可，也不因该数量排队。角色、策略、审批、traits 冲突、租约和写者安全边界继续逐次生效。用户审批交互的持久排队及已受理 `followup_task` 新轮的容量等待属于不同生命周期，不由本决策改写。
4. 新建子 Session 在首次派发前登记到执行租约续约 owner。恢复历史 queued 子任务时，若初始租约已过期，必须先隔离旧 generation，证明未发起模型或工具调用，才继续首次派发或结算失败。预派发结算无法提交且 Store 可接纳诊断时，父 required 等待显式要求恢复，不静默无限等待。

## 验证边界
通过三子任务同时启动、错峰完成、上限与写者满额即时失败、普通工具并发准入、租约恢复及父等待回归验证。外部尝试已发生或结果不明时保持原 unknown 规则，不能因恢复预派发路径而重试外部操作。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

原始记录 未单独记录后果；其已记录的取舍与限制保留在上文。

## Historical relationships

决策者：用户确认子 Agent 上限默认 3、超限立即拒绝，并保留 `code` 写者安全限制

现行依据：[执行手册](../../../../docs/handbook/features/execution.md)、[配置手册](../../../../docs/handbook/features/models-and-configuration.md)、[Service owner](../../../../apps/kite-service/docs/runtime-application.md)、[Host owner](../../../../packages/runtime-host/docs/execution-lifecycle.md)、[Kernel owner](../../../../packages/agent-kernel/docs/scheduling-authorization.md)。本决策替代 [Agent Note 0104](../feature/2026-08-13-bounded-concurrent-subagent-dispatch.md) 的固定批次上限和新建子任务等待并发位的范围；保留其兼容任务并发、身份隔离、审批交互与写者安全边界。

现行适用范围修正（2026-09-27）：下文第 1 条的正整数配置在当前固定 30 次父级 turn 预算下限定为 1–28；上限加两份父级余量作为分母时，每个子 Agent 必须获得至少一次 turn。默认值仍为 3。Service 在成功受理前也检查当前预算能否提供正的子份额。这个约束修复了更大数值先受理、随后因零额度结算失败的窗口，不改变即时拒绝与写者安全决定。
