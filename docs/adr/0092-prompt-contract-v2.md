# ADR-0092：Prompt Contract V2 分层、项目指令与可信 Capability 描述

**Status**: accepted
**Date**: 2026-08-08
**Decision makers**: @chenchao

## Context

当前模型上下文在 System Prompt、动态提醒和工具描述中重复规划、审批与恢复规则；部分工具描述与真实结果不一致，统一 Context Projection 丢失实际 sandbox backend，主/子 Agent 仍引用已删除的 `Skill`。系统提示声称 CLAUDE.md 可覆盖系统规则，但生产链没有项目指令加载器。MCP 动态工具则使用同一条泛化描述，安全地避免远端提示注入，却丢失了调用语义。

## Decision

1. 模型上下文分成稳定 System Prompt、cacheable environment、synthetic-user 项目指令、单一动态 Runtime 状态和 ToolSpec 工具契约。Runtime Kernel 继续是 phase、planning、authorization 与 interaction state 权威。
2. 项目指令在 Workspace 内按父到子加载 `CLAUDE.md` 与 `AGENTS.md`；同层 AGENTS 后置。项目内容不进入 System role，不能覆盖安全、审批、sandbox、binding 或 verification。
3. ToolSpec 保存结构化语义事实，legacy 与 V2 formatter 从同一事实生成；V2 只披露当前 phase 相关工具。
4. CapabilityDescriptor 区分原始描述、模型描述和描述 provenance。只有用户/本地/显式配置或已批准项目 Server 的清理后描述可进入模型；其他来源生成确定性摘要。Schema 注释继续剥离。
5. 新增默认关闭的 `promptContractV2`。正确性与安全修复不受该 Flag 控制；双路径至少保留两周，转默认需要真实模型证据和生产 TUI E2E。

## Alternatives

- 只缩短 System Prompt：拒绝，不能修复 Runtime、工具结果、项目指令和 MCP 语义漂移。
- 把 AGENTS/CLAUDE 内容拼入 System Prompt：拒绝，会提升不可信仓库内容的权限并破坏稳定缓存前缀。
- 永不采用 MCP 远端描述：拒绝，复杂 Tool 的发现与参数选择质量不足。
- 无条件透传 MCP 描述：拒绝，扩大提示注入面。
- 长期保留 legacy/v2 profile：拒绝，会形成两套产品行为与维护负担。

## Consequences

- Context Projection 增加 Prompt 版本、ProjectInstructionSnapshot 和真实 sandbox 输入。
- CapabilityDescriptor 增加可选兼容字段，旧 snapshot 使用 generated fallback，无 Runtime state migration。
- Planning 模型工具表与 Building 不再相同；Controller/Policy 仍重复校验。
- 项目指令和 live eval 增加可诊断预算与来源字段，但不得记录模型正文或敏感参数。

## Rollback

设置 `promptContractV2=false` 回到 legacy 排布。回滚不恢复已修复的 sandbox、Skill 或输出契约错误，不删除 capability revision、计划或 Runtime 历史。默认值翻转和 legacy 删除通过后续独立证据与 ADR 完成。
