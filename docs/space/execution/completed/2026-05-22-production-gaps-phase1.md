# Phase 1: MCP 核心 + 事件闭环 + 错误分类 完成记录

状态：archived
日期：2026-05-22（完成），2026-06-08（归档）

## 改动摘要

6 个独立任务，按依赖关系排序：

1. **Session 命名修复** — API key 缺失时 fallback 为用户输入截断
2. **Recoverable 错误分类** — `isRecoverableError()` 区分网络超时/速率限制 vs 配置/权限
3. **Retry 事件清理** — 移除死代码 `retry` 事件，统一为 `model_retry`
4. **Compact 事件闭环** — `compact_begin`/`compact_end` 接入 graph → runner → TUI 全链路
5. **Compact UI 消费** — StatusBar 显示 `⏳ Compacting...`
6. **MCP 协议支持** — stdio + streamable HTTP transport，工具命名 `mcp__servername__toolname`，`/mcp` 面板，安全策略集成

### 新增模块

```
src/core/mcp/
  types.ts          — JSON-RPC 2.0 类型
  manager.ts        — McpManager 多 server 生命周期
  tool-adapter.ts   — MCP Tool → LangChain StructuredTool
  index.ts
src/app/tui/components/McpPanel.tsx
tests/mcp.test.ts
```

### Commits (8)

```
60f3de5 fix: session 命名 API key 缺失时不返回空串，改用截断文本
0781233 feat: 按错误类型分类 recoverable 标志
06e53e0 refactor: 移除未使用的 retry 事件类型
268d649 feat: Compact 事件接入生产路径，StatusBar 显示压缩状态指示器
dccf6ee feat: MCP 核心 — 配置解析、McpManager 多 server 生命周期、Tool Adapter
52b812f feat: MCP 工具集成 — tool-policy 新增 mcp 风险类别、definitions 合成 MCP 工具
ecc1fc6 feat: MCP TUI — /mcp 面板、MCP Prompts 斜杠命令集成
6d35d75 fix: MCP 工具执行路径 + mcpRiskOverride 接线 + prompt registry 响应式
```

### 设计文档

- `plans/2026-05-22-production-gaps-phase1.md`
