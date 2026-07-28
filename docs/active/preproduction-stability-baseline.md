# 预生产稳定性基线

状态：active

读取时机：实施 `2026-07-28-preproduction-stability-hardening.md`、修改稳定性 feature
flag、资源预算、测试 runner 或 PR0 技术 Spike 时。

验证：`bun run typecheck`、`bun test tests/config/resource-budgets.test.ts
tests/runtime/primitives.test.ts tests/runtime/failures.test.ts tests/mcp-panel.test.tsx
tests/test-discovery.test.ts`、`bun run test:tui:system startup`。

相关：`docs/space/plans/2026-07-28-preproduction-stability-hardening.md`、ADR-0045～0048。

## Source 基线

- 分支：`featrue/0.1.0-stability`
- 实施起点：`a30faecc0220d77b4d2f5c4b8eb25d58adab7d4d`
- Bun：`1.3.14`
- PR0 Windows 验证机：Windows 11 Pro Insider Preview `10.0.26220`、AMD Ryzen 9 5950X、
  32 logical processors、34,263,244,800 bytes RAM
- Store journal mode：Windows `delete`，Linux/macOS `wal`
- 稳定性 flags：`boundedExecutionV1=false`、`durableEventIdentityV2=false`、
  `transactionalRewindV1=false`

本记录的最终 Source SHA 只能在计划、RFC、ADR-0045～0048 与 PR0 实现进入同一不可变
commit 后填写；在此之前不得把实施起点误称为 PR0 Source SHA。

## PR0 技术 Spike 状态

| Spike | 当前结论 | 发布 fallback |
| --- | --- | --- |
| Windows tree-kill | `shellTool` delayed-abort fixture 启动 Bash 下的 `sleep 60`，取消后以 `taskkill /t /f` 清理树并在约 0.25 秒内关闭继承 pipe、返回 `130`；完整 unit gate 通过，状态 `pass` | 不需要 deny fallback；PR1 仍需执行 admission matrix |
| DNS connect-time pinning | 当前 `web_fetch` 使用标准 `fetch` hostname 连接，尚无把已验证 IP 绑定到实际 socket 的可验证 adapter，状态 `fail` | 预生产禁用 `web_fetch` |
| SQLite fault injection | 尚缺覆盖 busy、unique、disk-full/IO 与 transaction interruption 的统一确定性 adapter，状态 `pending` | Store 故障 gate 不通过 |

Spike 只有在可重复测试输出绑定同一 Source SHA 后才能改为 `pass`。DNS 不允许以解析前 hostname
检查、解析后再次按 hostname 连接或仅检查 redirect URL 代替 connect-time pinning。

压力 gate 在上述验证机上以 process RSS、event-loop lag、wall-clock duration、artifact/data-root
bytes 为采样项；每秒采样一次，记录峰值与 p50/p95/p99。跨平台结果必须同时记录 OS、CPU、
logical processors、RAM、Bun 和 Source SHA。阈值以本文件和资源预算 schema 为准，压力结果
产生后不得反向放宽；需要调整时必须单独评审并重跑完整压力矩阵。

## 固定资源预算

默认值的单一事实来源是 `src/core/config/resource-budgets.ts`，数值与实施计划“一点五、初始配置
基线”一致。PR0 只注册 schema 和默认关闭的切换，不把生产调用路径切换到新预算。
