# Agent Note: Desktop 以原 Shell Job 呈现数字会话的后续执行

Status: implemented

## Problem

普通命令交回数字会话后，原 Job 可独立继续。Desktop 原先只核验字符串回执，已保存的轮询结果因此可能显示为空。环境信息仅接纳显式后台启动，用户也无法从那里查看已交回会话但仍在运行的准确操作。

## Decision

Desktop 把同一原启动 Tool 和 Job 的连续输出补入原命令行。持久结果保留原调用身份。目录只在请求来源事实时，根据原回执投影继续执行，环境卡沿原 Job 检查实际状态和停止资格。此处扩展[原环境卡来源规则](2026-10-20-background-shell-origin-filter.md)的成员条件，其作用域和权限边界继续适用。

## Alternatives considered

- 把所有运行中的 Shell 列入环境信息。首次等待仍占用当前 Tool 的普通命令也会入列，无法证明执行已交回。
- 继续把每次成功读取显示成独立卡片。用户仍要在多个记录之间找命令、输出与最终结果。
- 只按数字会话 ID 合并。消息恢复、切换和重复读取下，原 Job、启动 Tool 与页边界提供更强的归属依据。

## Consequences

同轮已核实并可相接的输出共享一个命令详情。旧记录无法确认后续页相接时保留读取入口。环境卡的停止仍只对当前有资格的实际运行 Job 生效。实现和验证分别归 [Desktop 工具过程](../../../../apps/desktop/README.md#原工具过程与结果阅读)、[Store 目录](../../../../packages/agent/src/storage/README.md#跨会话原-job-目录)。
