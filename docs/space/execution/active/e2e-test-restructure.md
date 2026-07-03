# 旧方案：E2E 测试用例体系重构

状态：active
最后更新：2026-07-03

读取时机：

- 遇到旧 `tests/tui-integration/`、`render-tui.tsx`、`response-plan.ts`、P0-P3 e2e 分层引用时。
- 需要确认旧 e2e harness 的迁移去向时。

验证：

- `bun run test:e2e`
- `bun run test:tui:system`
- `bun run test:tui:system:core`

本方案原本规划基于 `ink-testing-library` 的 `tests/tui-integration/` e2e harness。该 harness 已退役，旧测试用例已删除，`test:e2e` 和 `test:tui:integration` 现在都指向 PTY system gate。

当前有效规则：

- `docs/space/execution/active/tui-e2e-standards.md`
- `docs/space/execution/active/tui-e2e-testing-limits.md`
- `docs/space/plans/2026-07-03-tui-pty-e2e-reform.md`

历史设计和旧 P0-P3 分层记录见归档方案：

- `docs/space/plans/2026-05-25-e2e-restructure.md`
