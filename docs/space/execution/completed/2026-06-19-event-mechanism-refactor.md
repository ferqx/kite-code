# Agent 事件机制重构完成记录

状态：archived
日期：2026-06-19（实现完成并归档）

## 改动摘要

事件机制重构（commit `a8b5c3e`），解决 4 个结构性问题，使日志模块可以直接消费结构完整的事件流。

### 解决的 4 个问题

| # | 问题 | 优先级 | 解决方案 |
|---|------|:------:|---------|
| P1 | 无 conversation turn 边界 | P1 | 新增 `turn_begin` / `turn_end` 事件，runner.ts 中 while 循环 emit |
| P1 | 子 Agent 事件走旁路 | P1 | EventSink 统一管道，subagentEventSink 内部调用 `sink.emit()` |
| P2 | 用户输入无事件类型 | P2 | 新增 `user_message` 事件（kind: task/answer/resume_context） |
| P2 | 内部节点无区分标记 | P2 | step_begin 增加 `internal?: boolean`，cleanup 节点标记 internal |

### 变更文件

| 文件 | 变更 |
|------|------|
| `src/protocol/events.ts` | +turn_begin / turn_end / user_message 类型；step_begin/end 加 spanId + internal |
| `src/core/runner.ts` | EventSink 统一管道；turn 边界 emit；用户输入事件化；final/cache_metrics 归属 agent node；provider.onEvent 防御性 try/catch |
| `src/core/harness/graph.ts` | cleanup 节点标记 `internal: true` |
| `src/core/session-logger/collector.ts` | 去掉 recordUserMessage / stateFingerprint / final 去重 / turn span 手动写入 |

### 向后兼容

- TUI reducer 默认忽略不识别事件（switch-case default 已是 no-op）
- step_begin 新字段（spanId/internal）TypeScript 结构解构自动忽略
- 无 break change

### 关联

- [`2026-06-18-session-logger`](2026-06-18-session-logger.md) — 日志模块消费重构后的事件流，与本次重构共同实施
