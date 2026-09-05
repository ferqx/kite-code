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
- 当前 writer 只产生 State 27/SAQ epoch；State 26 只在封闭兼容边界投影为 inert history。
- 新 writer 为每个 Subagent step 固定写入 `stepId + toolCallId`，并为 approval/auto-review settlement 写入完整
  root/child owner；旧事件只由 persistence-order migration reader 合成 `legacy:<subagentId>:<ordinal>` identity。
- 授权、完成、恢复与 verification decision 只有一个 Kernel owner。
- Task 完成只由 `CanonicalTaskCompletionFact` 进入 completion reducer；该 normalization 完整保留 raw
  `run.completed` 的 output、guard、plan identity 与 outcome，供 Host 在同一事务中推进 Run 和 checkpoint。
- Resource Budget限制整轮工具总量、Subagent与writer并发，但不把普通Tool或Shell按活动数量分批；一次模型响应中通过traits冲突检查的调用可直接并行。
- Shell `uncertainEffects`在未持有exact approval时始终投影为真人审批；`risk`只描述风险，不能替代Compiler的
  `allowed/decision/requiresApproval`生成第二个hard deny。

## 测试

`bun test packages/agent-kernel/test`

## 文档影响

模块局部变化更新本 README；授权或跨包 lifecycle 变化同时更新 [授权规则](../../docs/active/authorization.md) 和 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
