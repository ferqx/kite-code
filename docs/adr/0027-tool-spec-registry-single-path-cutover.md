# ADR-0027: ToolSpec Registry 单路径收尾

**Status**: accepted
**Date**: 2026-07-26
**Decision makers**: @chenchao
**Supersedes**: ADR-0026 的双路径灰度与 flag 回滚部分

## Context

ADR-0026 计划用 `toolSpecRegistryV1` 保留旧执行路径至少两周，再切换默认值并清理。然而六个计算原语逐步迁移后，实际代码已经无条件通过 Registry 泛型解析和 `dispatchRegisteredTool` 执行；该 flag 只存在于配置声明与测试，从未接入解析、路由或执行分支。继续保留它会虚构一个不存在的回滚能力，也无法形成真实的双值灰度证据。

## Decision

六个计算原语 `read_file`、`search_content`、`search_files`、`write_file`、`edit_file`、`shell_execute` 以 ToolSpec Registry 为唯一执行事实源：

- 删除未接线的 `toolSpecRegistryV1`；
- 不重建已经退役的旧执行器来制造双路径；
- 回滚以恢复上一提交为单位，不承诺运行时 flag 回切；
- Registry Schema、解析恒等性、effects、dispatch、Policy 决策与结果元数据由一致性和审批链路用例共同守护；
- ADR-0026 的 Schema-only、严格 Edit、shell 治理参数收敛和命令形态审批结论保持有效。

## Alternatives

- 重新实现六套旧执行分支并补做两周灰度：拒绝。它重新引入 ADR-0026 要消除的双事实源，只为满足已经失真的迁移机制。
- 保留未接线 flag：拒绝。配置表面会暗示不存在的行为差异。

## Consequences

- Registry 故障不能通过运行时 flag 回切，必须回滚代码版本。
- 一致性测试必须覆盖模型 Schema、泛型解析、Policy 免审语料、dispatch 上下文传播和派生 action 元数据。
- 阶段 1 收尾不再等待虚构的双值观察期；生产发布仍遵循常规发布与回滚流程。

## Rollback

回滚包含 Registry 清理的提交，恢复其前一代码版本。不得只恢复配置 flag 而不恢复真实旧执行路径。
