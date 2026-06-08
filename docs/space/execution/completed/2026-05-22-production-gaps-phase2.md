# Phase 2: Rewind + MCP Resources 完成记录

状态：archived
日期：2026-05-23（完成），2026-06-08（归档）

## 改动摘要

两个主要交付物：

### Rewind（会话回溯）

- Saver 层：`listCheckpoints()` + `getCheckpointState()`
- Runner 层：`revertToCheckpoint()` / `forkFromCheckpoint()`
- TUI 层：`/rewind` 命令 + `Esc Esc` 触发，CheckpointSelector 覆盖层
- Revert（同 thread 恢复）和 Fork（新 threadId）两种模式

### MCP Resources

- McpManager 扩展：`listResources()` / `readResource()`
- 新增内置工具 `read_mcp_resource`（risk: read）
- McpPanel 展示 Resources 区段

### 改动文件

| 新增 | 修改 |
|------|------|
| `src/app/tui/components/CheckpointSelector.tsx` | `src/core/persistence/checkpoint.ts` |
| `tests/rewind.test.ts` | `src/core/runner.ts` |
| | `src/core/mcp/manager.ts` |
| | `src/core/tools/definitions.ts` |
| | `src/core/harness/tool-policy.ts` |
| | `src/app/tui/components/McpPanel.tsx` |
| | `src/app/tui/hooks/useSlashCommand.ts` |
| | `src/app/tui/App.tsx` |
| | `src/app/tui/index.tsx` |
| | `src/app/tui/types.ts` |

### Commits (2)

```
f256b87 feat: Rewind — checkpoint 回溯 + Revert/Fork + CheckpointSelector + /rewind
5d95bc1 feat: MCP Resources — listResources + readResource + read_mcp_resource 工具 + McpPanel
```

### 设计文档

- `understanding/2026-05-22-rewind-mcp-resources-design.md`
- `plans/2026-05-22-production-gaps-phase2.md`
