# MCP Tool Policy Phase 4 完成记录

状态：completed
实施日期：2026-07-17
计划：[`../../plans/2026-07-15-mcp-tui-management-center-implementation.md`](../../plans/2026-07-15-mcp-tui-management-center-implementation.md)
架构决策：[`../../../adr/0014-mcp-tool-visibility-and-policy.md`](../../../adr/0014-mcp-tool-visibility-and-policy.md)、[`../../../adr/0012-mcp-tui-readonly-list.md`](../../../adr/0012-mcp-tui-readonly-list.md)
当前规则：[`../../../active/mcp-runtime-governance.md`](../../../active/mcp-runtime-governance.md)、[`../../../active/mcp-config-management.md`](../../../active/mcp-config-management.md)

## 完成内容

- MCP 配置新增 `enabledTools`、`disabledTools` 和 `tools.<name>.enabled`，按 allowlist → denylist → exact override 解析。
- Manager 保留完整 discovery，只向 capability catalog 发布 enabled 且 schema-valid 的 Tool；直接调用也必须匹配当前 available descriptor。
- Descriptor 区分 remote declared effects 与 local effective effects，policy/filter 变化产生新 revision 并使旧 binding fail closed。
- `safe_read` 仅在 effective effects 全部为 `none|read` 时生效；缺少 key argument 的 `idempotency_key` 降为 `never`。
- project/project_legacy 在 transport 获批后只保留 allowlist、denylist、精确 disable、`minimumApproval: user` 和 `retry: never`，所有放宽项继续被剥离。
- Control snapshot 投影 discovered/enabled/availability、effect、annotation provenance、policy source、minimum approval、retry、schema quarantine 与未 discovery 引用 diagnostic。
- 遵循 ADR-0012，未恢复 `/mcp` Tool List、Detail 或 policy editor；配置入口保持 JSONC/Repository。

## 验证证据

- `tests/mcp-tool-policy.test.ts` 覆盖 filter precedence、annotation trust、catalog filtering、直接调用 fail closed、policy revision 与旧 binding stale。
- `tests/mcp-project-approval.test.ts` 覆盖项目配置保留收紧项并丢弃放宽项。
- `tests/mcp-supervisor.test.ts` 覆盖 control snapshot policy provenance、invalid schema quarantine 和 missing Tool diagnostic。
- `tests/mcp-manager.test.ts` 覆盖 safe-read retry 必须匹配 effective read。
- 完整非 PTY 测试：`1479 pass, 1 skip, 0 fail`；唯一 skip 是需显式环境变量启用的 native keyring platform smoke，Phase 3 已有三平台 CI 证据。
- MCP 阶段定向回归：`214 pass, 0 fail`，覆盖配置、OAuth、Manager、Supervisor、Runtime binding、Approval Policy 与只读面板。
- TUI PTY：`4 pass, 0 fail`，覆盖只读 `/mcp`、项目审批和认证恢复。
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs`、`bun run format:check` 与 `git diff --check` 全部成功；format check 仅报告仓库既有 warning。

## 产品边界

本阶段完成的是 Runtime 与配置权威，不重新引入已被产品纠偏删除的 TUI 管理中心。用户通过配置文件声明 Tool policy；`/mcp` 仍只显示 effective Server 的名称和连接状态。
