# ToolSpec Registry 阶段 2 完成记录

状态：completed
日期：2026-07-26
计划：[`2026-07-26-tool-spec-registry-phase-2.md`](../../plans/2026-07-26-tool-spec-registry-phase-2.md)
决策：ADR-0026、ADR-0027

## 已完成

- `web_fetch` 与 MCP inventory/resource 三件迁入 Registry；
- `task`、`tool_search` 与 Skill 三件迁入 coordination specs；
- `ask_user` 以 interrupt spec 注册；
- Plan 三件以 runtime action specs 注册，状态机语义不变；
- 事件型 spec 通过 `ProjectedToolResult.runtimeEvents` 原子投影 Runtime 事件；
- definitions 模型表面 schema-only，手写请求解析与对应旧执行器删除；
- disclosure、approval、mode policy、MCP binding 与 provider adapter 治理边界保持在 dispatch 前后既有位置。

## 验证

- `bun run typecheck`
- Registry、controller、capability search、subagent、Plan Artifact 与 definition 定向测试通过
- `bun run test`：1766 pass、2 skip；阶段 2 新增的 `ask_user` Runtime Kernel
  恢复用例通过。全仓仍有 5 个与本阶段无关的既有 Windows/TUI/ACL/延迟取消失败，
  与阶段 1 完成记录中的失败集合一致
- `bun run check:core-boundary`
- `bun run check:docs`
- `bun run check:docs-impact`
- `git diff --check`

阶段 3 的 plan 门面化、Skill 生命周期事件化方向项仍需独立 RFC，不属于本阶段。
