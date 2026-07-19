# MCP TUI 最小配置流程校正完成记录

状态：completed
实施日期：2026-07-16
计划：`../../plans/2026-07-15-mcp-tui-management-center-implementation.md`
当前规则：`../../../active/mcp-config-management.md`

## 完成内容

- 参考 Claude Code 与 Codex 的分层配置方式，将 `/mcp add` 收敛为 name 与 HTTP URL 两个输入，并固定保存为当前 workspace 的 local 配置。
- transport、scope、stdio command/args、cwd、env/header、timeout、required 等高级字段继续由 schema、Repository、JSONC、watch/reconcile 与既有配置兼容路径支持，不进入 TUI 添加流程。
- HTTP URL 仍执行协议校验和脱敏预览；已有 project 配置仍须进入独立摘要审批，不因简化流程绕过 transport 门禁。

## 验证

- MCP component、Repository、reconcile 与 Supervisor 定向测试通过；覆盖 name + URL 的 local HTTP 流程和 URL 脱敏。
- 窄终端 PTY 完成 add、连接、disable、enable、remove 全流程。
- `bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs` 与 `git diff --check` 通过。
