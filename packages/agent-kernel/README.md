# Agent Kernel

## 定位

`@kite-ai/agent-kernel` 是确定性的 Runtime State transition owner。

## 拥有职责

- 通过 `decide`、`reduceAgentState`、`reduce` 与 `selectPendingEffects` 决定纯状态转换。
- 静态组合 core/domain reducer、scheduler、completion、recovery 与 invariant。
- 接受 Host 已分配的 identity、time 与 canonical `DecisionFacts`。

## 不拥有职责

- 不读 clock、random、filesystem、network、Node/Bun 或 Provider。
- 不分配 ID、不持久化、不执行 Effect。
- 不支持动态 Reducer 注册或 caller 注入 domain。

## 允许依赖

本 package 不依赖任何 workspace、I/O runtime 或 TUI 类型。

## 公开入口

只导出 package 根入口 `@kite-ai/agent-kernel`。

## 关键不变量

- 根 state/event union 和 Reducer 顺序均为编译期固定。
- `turn.started` 可封闭保存本轮显式 `reasoningEffort` 六值覆盖；旧事件没有该字段时仍可读取，Kernel 不解析 Provider 配置。
- 当前 writer 只产生 State 27/SAQ epoch；State 26 只在封闭兼容边界投影为 inert history。
- 新 writer 为每个 Subagent step 固定写入 `stepId + toolCallId`，并为 approval/auto-review settlement 写入完整
  root/child owner；旧事件只由 persistence-order migration reader 合成 `legacy:<subagentId>:<ordinal>` identity。
- 授权、完成、恢复与 verification decision 只有一个 Kernel owner。
- Task 完成只由 `CanonicalTaskCompletionFact` 进入 completion reducer；该 normalization 完整保留 raw
  `run.completed` 的 output、guard、plan identity 与 outcome，供 Host 在同一事务中推进 Run 和 checkpoint。
- Resource Budget限制整轮工具总量、Subagent与writer并发，但不把普通Tool或Shell按活动数量分批；一次模型响应中通过traits冲突检查的调用可直接并行。
- Shell `uncertainEffects`在Auto模式下进入审批模型，其他模式请求真人审批；`risk`只描述风险，不能替代Compiler的
  `allowed/decision/requiresApproval`生成第二个hard deny。
- 子 Session 首轮激活依次写入 adoption、私有 Task Artifact 输入、预算、Turn、`task.started`；Task 的 `userGoal` 仅用固定通用标签，实际委派内容只在私有 Artifact。父 dispatch ACK 前失败时，父级 `subagent.child_creation_failed` 区分不存在、revision 0 未激活、revision 5 已激活三种证明模式；均只结算原 Task claim，不形成子结果的普通用户消息。
- 父级 `backgroundResult` 仅接受旧 Provider 的 `cleanup_completed`，或独立子 Session 的精确 `terminalImport`（确定性子 ID、原 Tool/Run/Turn、结果 Artifact 摘要一致）；两种结果权限不可互相替代。

## 测试

`bun test packages/agent-kernel/test`

## 文档影响

模块局部变化更新本 README；授权或跨包 lifecycle 变化同时更新 [授权规则](../../docs/active/authorization.md) 和 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。

## 产品与修改导航

[共享产品定义](../../docs/handbook/README.md) · [开发地图](../../docs/development/architecture.md)。本模块说明实现，不重新定义客户端操作。

- [src/index.ts](src/index.ts)
- [test](test)

## 深入机制

- [完成、失败与恢复决策](docs/completion-recovery.md)
- [调度、授权与副作用选择](docs/scheduling-authorization.md)
- [State、Event 与确定性转换](docs/state-transitions.md)
