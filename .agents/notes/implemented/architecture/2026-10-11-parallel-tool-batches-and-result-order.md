# Agent Note: 并行工具批次的真实顺序与安全接续

Status: implemented

## Problem

V1.3 的 T048 要求同一完整模型回复的工具能够并行、乱序完成，同时下一模型按原工具声明顺序读取正确结果。原唯一 Loop 逐项 await，后一项无法在前项等待审批或执行时完成；恢复检查还把可复用的成功结果限制为前缀。因此 A 尚未派发、B 已成功的真实持久边界无法明确接续。改成并行后，首个业务失败也不能盖住兄弟调用随后真实保存失败，或提前释放其 Run binding。

## Decision

默认产品的原 TUI 迁移另保人工审批等待期间未准入兄弟不执行的行为：Agent 默认 Permissions 声明 `toolDispatchOrder: model`，该标记冻结在实际 Run 配置中。只序列化准入，dispatch 之后执行仍并发；明确拒绝取消真实尚未准入调用，不抹去已合法开始的效果。自定义 Permissions 缺此标记时保本记录的独立并行审批和混合检查点行为；T048 的通用能力继续存在。此限定由用户要求完整迁入原 TUI 行为及其真实终端断言支持，接口、实际机制与最终范围分别见[Agent owner](../../../../packages/agent/README.md#同一-step-的并行工具批次)和[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

Runtime 在任何调用执行前按原声明顺序登记完整 source requests，每个调用冻结自己的输入、来源和 bindings，沿现有权限、freshness、串行键与槽位执行。单一 Loop 并行推进同批工具，首个致命结果取消本批；父 Run 取消仍沿原信号传播。所有已启动调用 settled 后才能继续模型、终结 Run 或释放绑定。不同 rejection 原因用 AggregateError 保留，首因作为 cause；相同 error 身份的 abort 传播去重，独立后发 AgentError 在 Run.reason 保留。

物理 Message/Execution seq 保留真实完成顺序。仅在准备下一 Model 的同一 assistant 工具结果槽位中按原 call ID 配对完整结果，不重排其他消息。显式接续逐项核原 Model、step、定义、输入与终态；可复用已结算 B，同时接续可证明未派发的 A，保原审批和执行身份并核当前权限。dispatching/running/outcome_unknown 继续拒绝接续。

并行批次还在 Store 投递和共享变化唤醒边界背压。保留原 Worker 条数/字节与控制预留，等待后重核 owner/lease，关闭排空此前调用，已投递写入不重试；唤醒活动登记保持 64，额外等待沿原绝对期限和准确取消取得 FIFO 许可。只保存许可元数据，业务参数留在调用方，不额外复制正文或设置 Tool 数量预算。

当前实现、验收与剩余资格分别归[Agent owner](../../../../packages/agent/README.md#同一-step-的并行工具批次)和[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11macos-独立能力与并行工具完整行为)。[审批拒绝决定](../bug-fix/2026-09-04-approval-rejection-terminates-tool-batch.md)中拒绝终止本轮、已开始调用等待真实清理的用户语义继续适用；其旧日志事务和 TUI 类型描述是历史实现，当前具名 Store 与公开投影由本轮 owner 负责。

## Alternatives considered

- 继续逐项 await：不能满足 T048，也无法形成并行的审批等待与兄弟成功边界。
- 用 Promise.all 首错立即结束：后面的调用仍可能执行或清理，会提前释放绑定并丢失后发保存错误。
- 延迟持久化到整个批次完成：将真实乱序完成隐藏成原调用顺序，改变历史事实并扩大丢结果窗口。
- 全局重排历史消息：可能跨模型批次或 steer 改变因果顺序；只调整该 assistant 的配对结果槽位。
- 恢复时重做已成功 B：会重复外部效果，不能以 A 尚未完成推翻 B 的原成功结果。
- 提高数据库容量或活动唤醒上限：掩盖已在原合法有限批次出现的内部容量失败，不能提供背压或保留原资源边界。
- 限制或串行化整个 Tool batch：会阻塞仍可独立完成的调用，把基础设施压力变成隐藏工具额度；应在短投递和唤醒登记边界等待现有容量。

## Consequences

普通工具保持自己的许可、串行资源和最终派发检查；没有新增隐藏工具数量或累计预算。同一批各调用的独立失败可保留多个真实原因，Run.reason 优先呈现独立的后发领域错误。Tool 保存失败时原未提交事实仍可读，不能补成成功。

原调用声明顺序不是执行依赖。同 key 提供互斥和实际许可队列，不承诺模型声明顺序；确需因果先后应先等待登记，再发依赖调用。新 refs 影响未来边界，不倒溯保护登记前已经合法发生的效果。原 requirements 测试在完整回归暴露未声明的串行前提，精确持久化时序证明 effect 派发先于 registration；只为该 case 两个相同准入路径的工具声明同一 Session key，全部原断言和期限保留。Core 不按工具名特判或把全部工具全局串行。

原 context contributions 的两例也依赖写记录完成后才派发效果；精确实际转发显示旧 fixture 的效果 markDispatching 和回调均在记录写入提交之前。只为这两例共享业务记录的工具声明现有 Session key，原更新后来源刷新拒绝与完整来源断言不变。freshness 保持在资源取得后的最终检查，未来写入不倒溯撤销合法效果。

真实 Runtime/SQLite 整例证明并行乱序、原审批拒绝与持有清理、实际 SQL trigger 保存失败；真实所属进程强杀整例证明原 Ask/planned 与兄弟完整 success 的明确接续和冷读零重放。这些证据不证明同步任意扩展可协作取消、完整 Runtime 资源 census、RSS 或其他平台资格。

原未改断言的 201 Tool/101 detached Job 整例先暴露 `storage_queue_full`，Store 背压后又暴露第 65 个 wake 的 `wait_capacity`；当前两个真实缺口在各自 owner 修复，原 selection/rewind 与完整来源通过。生产者排队仍有调用内存和清理成本，不能把有限已投递队列或活动登记上限解释成整个 Runtime RSS 已有界。
