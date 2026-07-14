# MCP Runtime Governance P0

状态：completed
优先级：P0
来源：`docs/design/2026-07-14-mcp-skills-runtime-governance-rfc.md`

## 目标

恢复受 Runtime 治理的 MCP 工具垂直链路：revisioned catalog、turn binding、fail-closed schema、policy/approval 和无损结果。

## 实施步骤

1. 注册治理 ADR、feature flags 与当前行为文档，明确 MCP flag 关闭时不保留旧路径。
2. 建立 capability descriptor/snapshot/binding，使用 MCP list notifications 原子刷新 snapshot。
3. 用 AI SDK dynamic tool declaration 替代旧 adapter；动态调用经 Runtime binding、schema 与 policy 校验后才调用 SDK client。
4. 删除 `@ai-sdk/mcp` 与 JSON Schema→Zod fail-open 路径，覆盖 list change、structured result 和审批回归。

## 验证

`bun run typecheck`、目标 MCP/runtime/policy 测试、`bun run check:core-boundary`、`bun run check:docs`。

## 后续

Phase 2 增加 health、intent/receipt、artifact 与 reconciliation；Skill workflow 和 required verification 不属于本计划。
