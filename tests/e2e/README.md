# E2E 测试分类

E2E 套件按跨越的外部边界分类：

- `local/`：使用隔离本地 fixture 的确定性跨进程测试，属于 `test:e2e`。
- `live/mcp/`：访问公开或外部管理 MCP 服务的显式 opt-in 测试，不使用 Bun 默认测试命名。
- `live/model/`：为真实模型 Provider 配额保留的显式 opt-in 接口。AQ-8 compatibility 与 AQ-9B 的独立
  auto-compaction success/cancel wrapper 均在此，但当前 `activation=false` 在 caller environment/ledger/resolver/
  credential lease/scratch/child 前零网络阻断，只返回脱敏 blocked run report，不产生 observation、receipt 或 evidence；
  ADR-0071 已接受；只有其 protected-supervisor implementation、Linux native isolation 与 deletion proof 收敛后才可重新审查实际调用。它们始终是
  diagnostic-only，不是 G1 或 release Gate。

TUI PTY 场景保留在 `tests/tui-system/scenarios/`，因为它们有独立的串行 harness 和测试标准。

`live/` 下的文件必须使用 `*.live.ts`，不能使用 `*.test.ts` 或 `*.spec.ts`；它们必须是由显式 package script 通过 `bun run` 调用的独立 runner。
future-only 的 AQ-9B success/cancel 各自要求独立 opt-in 和 caller-owned owner-only ledger root；cancel 只能传递真实
operator `SIGINT`，不能把 injected provider/network failure 当作 live cancel 结果。当前 public wrapper 不读取这些输入。
