# Agent Note: 会话最近时间由对话消息驱动

Status: implemented

## Problem

切换会话的审批模式会产生控制事件。目录原先取任意最后 Core 事件时间，使没有新对话的会话改变时间与排序。用户确认最新变更时间应基于对话消息。

## Decision

在原目录查询中只选择当前 Session 最后 `message.updated` 的封存时间，覆盖消息新增和已保存的流式内容更新。控制事件继续更新原通知水位和状态摘要，但不推进最近消息时间；空会话、旧或坏时间保留 null。部分替代[原目录决定](../architecture/2026-10-08-session-directory-activity-observation.md)的时间事件选择，其他只读、分页、锁观察及格式约束保持。

## Alternatives considered

- 客户端忽略审批刷新：会留下其他控制事件误排序，也可能漏掉真实状态变化；统一修正 Store 的时间来源。
- 新增会话时间列：原消息事件已有封存时间，无需引入迁移和重复时间状态。

## Consequences

历史目录读取立即采用消息时间，不回填数据库。审批模式、改名和运行终态不再推进排序；真实后续消息仍推进。产品规则归[会话手册](../../../../docs/handbook/features/sessions.md)，实现与回归归[Store owner](../../../../packages/agent/src/storage/README.md#目录分页)。SQL/HTTP 回归不替代实际客户端窗口体验验收。
