# MCP Runtime Governance P0 完成记录

状态：completed
实施日期：2026-07-14
计划：`../../plans/2026-07-14-mcp-runtime-governance-p0.md`
实现提交：`b470ad0`

## 完成内容

- 建立 revisioned Capability Catalog、turn-scoped MCP binding 和 fail-closed Runtime gateway。
- 删除 `@ai-sdk/mcp` 与 JSON Schema→Zod 降级适配，改用 MCP SDK、AI SDK dynamic tool declaration 和 Ajv Draft-07 校验。
- MCP 结果保留结构化 content blocks、`structuredContent` 与 `isError`；本地 per-tool policy 决定 effect/approval。
- 新增 ADR-0007、ADR-0008、当前行为文档和 stdio MCP fixture。

## 验证

通过 `bun run typecheck`；220 个目标测试通过；`bun run check:core-boundary`、`bun run check:docs` 与 `git diff --check` 通过。

## 后续

Phase 2 负责 execution receipt、artifact、health 与 crash reconciliation；Skill Workflow 与 verification scheduler 不在 P0 范围内。
