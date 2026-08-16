# MCP Resources 工具闭环

状态：completed
日期：2026-07-19

## 目标

补齐客户端级 MCP Resources 闭环，同时保持 Tool progressive disclosure 与 Resource discovery 分离：

```text
capability_search      → 发现 MCP Tools
list_mcp_resources     → 枚举静态 MCP Resources
read_mcp_resource      → 读取已发现的 Resource
```

本阶段不实现 `@server:uri` 补全、Resource Templates 或订阅式内容更新。

## 实施结果

- Runtime provider 提供稳定、只读、revisioned Resource Directory；只投影当前 effective 且 callable Provider 最近成功 discovery 的静态资源。
- `list_mcp_resources` 支持全部 Provider 或按 `server` 过滤，稳定排序，最多返回 100 条 names-only 元数据，不透传远端 description。
- `read_mcp_resource` 只允许读取当前 discovery snapshot 中存在的 URI；HTTP/SSE 复用执行时恢复，STDIO 失败等待显式 Retry。
- 列表和读取均为无审批只读内置工具，不进入 `capability_search`、session loaded set 或 turn binding。
- `resources/list_changed` 成功时替换目录，失败时保留最近成功结果并将 Provider 标记 degraded。
- TUI 将列表结果展示为 `Provider · URI` 树；读取继续进入只读 Thought 摘要。

## 验收

- `bun test tests/tool-definitions.test.ts tests/tool-runner.test.ts tests/tool-policy.test.ts tests/policies/approval-policy.test.ts`
- `bun test tests/mcp-manager.test.ts tests/mcp-supervisor.test.ts tests/runtime/capability-search.test.ts`
- `bun test tests/tui-layout.test.tsx tests/tui-system/scenarios/mcp-management-readonly.test.ts --timeout 60000`
- `bun run typecheck`
- `bun run check:core-boundary`
- `bun run check:docs-impact`
- `bun run check:docs`
