# ADR-0041: inspect 模式的单一 `ls` 纳入 Thought 聚合

**Status**: accepted
**Date**: 2026-07-26

## Context

ADR-0030 将只读探索工具归入单一 Thought 阶段，但现有 shell 分类只识别 `rg`、`grep`、`find` 等搜索前缀。模型使用 `ls -la` 查看目录结构时，即使工具明确声明 `intent=inspect`，TUI 仍把它当作通用 Bash 工具卡并关闭当前 Thought。这会把连续的代码库探索拆成两个视觉阶段。

简单增加 `ls ` 字符串前缀也不安全：`ls | tee file`、`ls > file`、`ls && command` 和 `ls $(command)` 都可能产生写入或执行额外命令，不能仅凭首个单词视为只读探索。

## Decision

当且仅当以下条件同时满足时，`shell_execute` 的 `ls` 调用纳入 `tool_summary`：

1. 工具参数显式声明 `intent=inspect`；
2. 去除首尾空白后的首个命令为精确的 `ls`；
3. 命令不含管道、重定向、命令串联、换行、反引号或 `$()` 命令替换。

满足条件的调用继续当前 Thought，统计摘要显示 `listed N directories`。不满足任一条件的调用保持独立 `tool_card`，并作为 Thought 阶段边界。

本决策扩展 ADR-0030 的探索工具集合，不改变其阶段生命周期、字幕或 settle 语义。

## Consequences

- `ls`、`ls -la`、`ls path` 等目录读取与 `read_file`、搜索工具保持一致的视觉聚合。
- 复合 shell 语句采取保守分类，即使其首个命令是 `ls` 也不会被隐藏进 Thought。
- 分类仍依赖调用方提供 `intent=inspect`；普通执行意图不会因命令文本被重新解释。

## Verification

Reducer 测试覆盖带参数和路径的 `ls` 聚合，以及管道、重定向、命令串联、命令替换和非 inspect 意图的拒绝路径。
