# E2E 测试分类

E2E 套件按跨越的外部边界分类：

- `local/`：使用隔离本地 fixture 的确定性跨进程测试，属于 `test:e2e`。
- `live/mcp/`：访问公开或外部管理 MCP 服务的显式 opt-in 测试，不使用 Bun 默认测试命名。
- `live/model/`：消耗真实模型 Provider 配额的显式 opt-in 测试。当前维护 context compaction direct/incremental summary runner。

TUI PTY 场景保留在 `tests/tui-system/scenarios/`，因为它们有独立的串行 harness 和测试标准。

`live/` 下的文件必须使用 `*.live.ts`，不能使用 `*.test.ts` 或 `*.spec.ts`；它们必须是由显式 package script 通过 `bun run` 调用的独立 runner。
