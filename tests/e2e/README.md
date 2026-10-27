# E2E 测试入口

当前根 `test:e2e` 显式选择新 Service 与 Client 的 HTTP/SSE、paired 和生命周期测试，准确文件列表由[根 manifest](../../package.json)维护。原 `local/` 的 MCP/Skills 跨进程测试依赖已删除的旧 Runtime 夹具，已随旧闭包删除，不再作为此命令的入口。

[live/model](live/model/README.md)包含显式运行的真实模型验证。实际调用 Provider 的 runner 使用 `*.live.ts`，由对应根脚本或模型套件中的明确命令启动；这类运行会消耗模型配额。旧 `live/mcp`、compaction 和 background runner 已随旧 Runtime 闭包删除，历史结果按其原版本追溯。

`live/model` 中也保留质量回放和对照工具的 `*.test.ts` 辅助测试，可按明确文件路径单独运行。[默认统一计划](../../scripts/unified-test-plan.ts)不选择整个 `tests/e2e/live/`，不能把文件名是否含 `.test` 等同于默认调度范围。

TUI PTY 场景由根 `test:tui:system` 选择 `tests/tui-system/scenarios/` 与当前 CLI owner 测试，再沿原场景 harness 执行；期限、隔离和进程清理由[测试体系](../README.md)及现有调度器负责。
