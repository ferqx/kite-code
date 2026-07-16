# MCP Auth Phase 3 完成记录

状态：completed
实施日期：2026-07-16
计划：[`../../plans/2026-07-16-mcp-auth-phase3.md`](../../plans/2026-07-16-mcp-auth-phase3.md)
架构决策：[`../../../adr/0013-mcp-credential-store-and-oauth-session.md`](../../../adr/0013-mcp-credential-store-and-oauth-session.md)、[`../../../adr/0012-mcp-tui-readonly-list.md`](../../../adr/0012-mcp-tui-readonly-list.md)
当前规则：[`../../../active/mcp-authentication.md`](../../../active/mcp-authentication.md)
实现提交：`a2efb01 feat(mcp): add secure HTTP authentication`

## 完成内容

- 生产 Credential Store 只使用 `@napi-rs/keyring` 访问 OS vault；backend 锁定或不可用时 fail closed，不提供文件、CLI 或明文 fallback。
- MCP HTTP 配置支持 environment、credential reference 和 OAuth metadata；secret material 不进入普通 JSONC、Runtime Event、session log、diagnostic 或 TUI projection。
- OAuth provider/coordinator 覆盖 discovery、dynamic registration、PKCE、constant-time state 校验、loopback callback、token resume/refresh/revoke、timeout/cancel 与无 shell browser opener。
- Manager/Supervisor 在真实 401 后投影独立 auth 状态；认证成功后重新 discovery，只影响新 model turn，不更新旧 binding 或重放旧 Tool Call。
- `/mcp` 保持 ADR-0012 的只读列表；Login/Cancel 由 App shell 独立恢复提示承接。
- macOS、Windows、Ubuntu 使用同一原生 write/read/delete smoke；Linux job 在隔离 D-Bus session 中启动 Secret Service。

## 验证证据

- 本地完整非 PTY 测试：`1473 pass, 1 skip, 0 fail`。
- TUI PTY 覆盖 login required、Login、Cancel、opener failure、Esc defer 与输入恢复，全部通过且不访问真实系统保险库。
- 本地 macOS native keyring write/read/delete smoke 通过。
- [GitHub Actions run 29513416626](https://github.com/ferqx/kite-code/actions/runs/29513416626) 成功：Ubuntu job `87672303624`、macOS job `87672303801`、Windows job `87672303658` 均通过。
- `bun run typecheck`、`bun run check:core-boundary`、`bun run format:check`、`bun run check:docs-impact`、`bun run check:docs`、`bun test tests/docs-space.test.ts` 与 `git diff --check` 通过。

## 安全结论

Phase 3 没有以单平台证据替代跨平台退出标准，也没有为 backend 不可用提供较弱降级路径。凭据持久化、OAuth 生命周期、认证状态投影和 TUI 恢复入口已经在既定 Core/App 边界内收敛；后续修改原生依赖或 backend 行为时，三平台 smoke 继续是回归门禁。
