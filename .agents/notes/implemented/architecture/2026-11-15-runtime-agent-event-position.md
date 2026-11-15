# Agent Note: Runtime 维护 Agent 事件的续读位置

Status: implemented

## Problem

由模型传递 `wait_agent_events` 的位置要求它跨轮保留内部数据。一个位置用于不同目标会遗漏先到的事件，例如 B 先完成，等 A 时取得较晚的位置，随后等 B 就会跨过它。若在回执提交前保存位置，进程退出可能留下没有对应回执的进度。

## Decision

主 Agent 用等待目标与超时选择观察。Runtime 在同一父会话、上下文选择内区分完整邮箱和准确工作集合，目标顺序不影响位置。Store 从原工具结果及对应消息已提交的回执取得该范围的最大位置。同一逻辑适用于继续运行和重开 SQLite。内置 Task 的权限、准确工作和结果接纳沿现有[协作者边界](2026-10-18-stable-agent-collaboration-and-human-work-selection.md)。

## Alternatives considered

- 由模型传十进制位置。数字简化了解码，模型仍需负责区分工作集合与恢复历史。
- Runtime 保存每个父会话的一个位置。完整邮箱适用这个范围，按目标等待时会越过其他工作的未返回事件。
- 独立更新位置记录。回执和位置必须跨同一个提交边界，现有工具回执已经提供这个边界。

## Consequences

保存过的同一观察范围可以冷续读。旧回执缺少自动位置，首次观察从当前可用记录开始。落出保留窗口时回执报告缺口，并从保留边界继续。不同观察范围可以返回重叠事件，结果的接纳仍使用原邮箱流程。[Task 实现说明](../../../../packages/agent/src/extensions/task/README.md)｜[SQLite 与模型请求回归](../../../../packages/agent/test/isolated/business/task/collaboration-surface.test.ts)
