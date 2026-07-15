# 第四章 核心层：Agent 与 Runtime Kernel

Kite Code 使用自有事件化 Runtime。`runRuntimeAgent()` 负责模型循环，`AgentKernel` 负责事实、调度和恢复，两者职责分离。

## 4.1 主循环

```text
RuntimeState
  → decideNextEffect()
  → invoke_model / execute_tools / request_approval / run_verification / emit_final
  → RuntimeEffectExecutor
  → RuntimeEvent
  → reduceRuntimeState()
  → 持久化并继续调度
```

| 实现 | 职责 |
| --- | --- |
| `runtime/agent.ts` | 组装并运行 Agent loop |
| `runtime/kernel.ts` | Effect lease、事件提交、状态权威 |
| `runtime/scheduler.ts` | 根据 State 决定下一 Effect |
| `runtime/reducer.ts` | 将 Event 归纳为新 State |
| `runtime/executor.ts` | 把 Effect 路由到模型、工具、验证或交互边界 |
| `runtime/runner.ts` | 驱动 Kernel 直至暂停或完成 |
| `runtime/store.ts` | 事件、快照与恢复点 |

## 4.2 模型边界

Model Controller 只负责模型调用与 transcript 投影。模型获得：

- 静态 system prompt；
- cacheable Runtime context；
- 当前计划、模式和恢复信息；
- 当前轮有限 Capability binding；
- 对应的 transcript messages。

模型输出被转换为 Runtime 事实。它不能直接写文件、批准操作、修改 State、签发 binding 或宣布 required verification 已通过。

## 4.3 Plan 生命周期

计划是 Runtime 管理的版本化 Artifact，而非模型消息中的临时文本。计划创建、更新、审核、批准、执行和恢复均有明确事件；结构摘要用于防止审核后计划被静默替换。

Plan mode 与普通执行共享同一个 Kernel，只通过策略和可用工具边界限制行为，不建立第二套 Agent 引擎。

## 4.4 完成与恢复

Scheduler 只有在没有待执行工具、审批、恢复动作或 required verification 门禁时才可 `emit_final`。失败根据分类进入重试、repair、replan、用户决策或终止；关闭 feature flag 不能绕过已持久化的安全门禁。

## 4.5 上下文与缓存

静态 prompt、稳定工具契约和 cacheable Runtime context 尽量保持前缀稳定；动态状态、Skill disclosure、搜索结果和 turn binding 放在轮次投影中。上下文压缩保留任务事实、计划和工具结果语义，不取代 Runtime Store。
