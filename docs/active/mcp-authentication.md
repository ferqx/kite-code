# MCP 凭据与 HTTP OAuth

状态：active
读取时机：修改 MCP auth schema、Credential Store、HTTP header 注入、OAuth provider/coordinator、loopback callback、browser opener、认证状态投影或独立认证提示时。
验证：`bun test packages/builtin-runtime/test apps/kite/test/mcp.test.ts tests/integration/mcp-manager.test.ts tests/qualification/mcp-keyring-platform-smoke.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。`.github/workflows/mcp-native-keyring-smoke.yml` 在 macOS、Windows、Ubuntu 三个平台运行同一原生 smoke；其 path filter 与执行命令必须共同指向 `tests/qualification/mcp-keyring-platform-smoke.test.ts`，backend、原生依赖或测试归属变化必须维持三个 job 通过。
相关：ADR-0013、ADR-0018、[`mcp-control-plane.md`](mcp-control-plane.md)、[`mcp-config-management.md`](mcp-config-management.md)、`packages/builtin-runtime/src/mcp/credential-store.ts`、`packages/builtin-runtime/src/mcp/oauth-provider.ts`、`packages/builtin-runtime/src/mcp/auth-coordinator.ts`、`apps/kite/src/tui/mcp/McpOverlay.tsx`。

## 凭据持久化

生产只在一个 `BuiltinCredentialBroker` composition 内构造 `NativeMcpCredentialStore`；Manager、AuthCoordinator 与 OAuth provider 都必须接收同一个 broker，不得各自创建 store。Native store 只调用 `@napi-rs/keyring` 原生 API，不执行 keychain CLI，不保存明文/加密 JSON fallback。backend 状态为 `available`、`locked` 或 `unavailable`；后两者必须 fail closed。测试与 CI 可显式注入 `MemoryMcpCredentialStore`，生产默认构造不得使用 fake。

Credential key 由 canonical workspace key、配置 source、Server 名称和 auth profile 组成，并经过 domain-separated SHA-256 后作为 OS vault account。跨 operation 只传 project/provider/profile/purpose/expiry/revocation 绑定的 opaque `CredentialHandle`；material 可包含静态 secret 或 OAuth tokens、dynamic client information、PKCE verifier、discovery state 与更新时间，但只在 broker-local header materialization 中短暂读取。Runtime control/TUI 只投影是否存在，不投影 material。原生读取返回的缓冲在解析后清零；普通配置、Runtime Event、session log 和诊断不得包含 material。

`disable`、source shadow、reconfigure 或直接 Repository mutation 不删除 credential。TUI Remove 通过 Supervisor 在删除配置后对仍注册的 OAuth target 执行本地 logout/clear；不默认 remote revoke。credential cleanup 失败时配置删除仍已生效，TUI 必须报告部分完成，不能宣称凭据也已清理。其他调用方仍需显式 logout/clear；remote revoke 只有在授权服务器提供 revocation endpoint 且调用方明确请求时执行。

## 配置引用

普通 JSONC 的 `auth` 只适用于 HTTP transport。production 允许 `credential` 与 `oauth` profile reference：

```jsonc
{
  "type": "credential",
  "header": "Authorization",
  "credentialRef": "work-account",
  "scheme": "Bearer"
}
```

```jsonc
{
  "type": "oauth",
  "credentialRef": "work-oauth",
  "scopes": ["mcp:tools"],
  "clientId": "optional-pre-registered-client",
  "clientSecretRef": "optional-client-secret"
}
```

当前 `auth` schema 只接受 `none`、`credential` 与 `oauth`；其他 spelling 在配置解析时直接无效，
不存在旧 auth 名称的 codec、Manager 分支或 ambient `process.env` credential 路径。credential/client
secret 配置只保存 profile reference；inline `clientSecret` 被 schema 拒绝。TUI 不收集或写入这些字段。
未配置 `auth` 的 HTTP Server 可在真实 401 后走 OAuth discovery；显式 `oauth` metadata 只用于
scope、client id 和 profile 覆盖。显式 `none` 或 `credential` 不会被认证恢复流程自动升级为 OAuth。

## OAuth 生命周期

Auth 与 connection health 分离：`not_required`、`login_required`、`authorizing`、`authenticated`、`refreshing`、`reauth_required`、`revoked`、`error` 不能代替 connecting/ready/degraded 等 health。

- 启动时有 token：Coordinator 在不启动 callback listener、不打开浏览器的前提下尝试恢复；成功后重新 discovery，失败进入 `reauth_required`。
- 启动时无 token：Manager 正常连接；401 只产生 `login_required`。
- 显式 Login：先确认 Store 可用，再绑定 `127.0.0.1` 随机端口；SDK discovery/registration 产生 authorization URL 后才调用 platform browser opener。
- Callback：只接受当前 flow 的 `/oauth/callback`、非空 code 和 constant-time 匹配的 state；完成后调用 `finishAuth()` 并以当前 auth generation reconnect/discovery。
- Cancel/timeout：关闭 listener，清除 verifier，不自动重试或打开浏览器。
- Refresh/revoke：SDK 使用持久 token refresh；refresh 失败不能形成浏览器循环。revoke 请求把 token 放在 POST body，不进入 URL。

认证恢复只改变未来 capability snapshot。旧 binding 不更新，旧 Tool Call 不重放；Agent 只能在新 model turn 获得新 binding。

## TUI 边界

`/mcp` 的 Server Detail 在 login/reauth required 或 auth error 时提供“认证”。认证 route 默认选择“打开浏览器”；只有 Enter 确认后才调用 Login，`l` 等字符无业务含义。authorizing 时只提供“取消认证”，Esc 同样取消 callback 并返回 Detail；success/failure 原地刷新。页面不显示 token、authorization code、PKCE、scope、完整 authorization URL/query 或 credential material。

Phase 3 已完成：TUI PTY 的 Login、Cancel、opener failure 和输入恢复场景通过；macOS Keychain、Windows Credential Manager 与 Linux Secret Service 的原生 write/read/delete smoke 均通过。完成证据见 [`../space/execution/completed/2026-07-16-mcp-auth-phase3.md`](../space/execution/completed/2026-07-16-mcp-auth-phase3.md)。
