# ToolSpec Registry 阶段 2 实施计划

状态：archived
创建：2026-07-26
优先级：P0
依赖：ADR-0043、ADR-0044
设计依据：[`docs/design/2026-07-26-tool-spec-registry-rfc.md`](../../design/2026-07-26-tool-spec-registry-rfc.md)

## 目标

把剩余静态工具迁入 ToolSpec Registry，保持模型可见名称、状态机语义、MCP binding 校验链和回放形状不变；controller/runner 内联执行分支随迁随删。

## 顺序与状态

- [x] `web_fetch`
- [x] `list_mcp_resources` / `list_mcp_tools` / `read_mcp_resource`
- [x] `task`
- [x] `activate_skill` / `complete_skill` / `read_skill_reference`
- [x] `tool_search`
- [x] `ask_user`（`kind: interrupt`）
- [x] `read_plan` / `write_plan` / `update_plan`（仅接入 Registry，语义不变）

## 完成定义

上述工具全部迁移，controller/runner 对应旧执行器删除；active 文档、conformance 测试与文档门禁共同收敛后归档。

完成记录：[`docs/space/execution/completed/2026-07-26-tool-spec-registry-phase-2.md`](../execution/completed/2026-07-26-tool-spec-registry-phase-2.md)。

## 事件型工具约束

`tool_search`、Skill 与 Plan 工具产生的状态事件由 `ProjectedToolResult.runtimeEvents` 从 spec 结构化投影，controller 只负责持久化和追加，禁止在 controller 重算候选、activation 或 Plan 状态结果。
