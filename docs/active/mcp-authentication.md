# MCP 凭据与 HTTP OAuth

状态：active
读取时机：修改 MCP auth schema、Credential Store、HTTP header 注入、OAuth provider/coordinator、loopback callback、browser opener、认证状态投影或独立认证提示时。
验证：`bun test tests/mcp-credential-store.test.ts tests/mcp-oauth-provider.test.ts tests/mcp-auth-coordinator.test.ts tests/mcp-oauth-integration.test.ts tests/mcp-manager.test.ts tests/mcp-supervisor.test.ts tests/mcp-config-catalog.test.ts tests/mcp-panel.test.tsx`、`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-authentication.test.ts`、`KITE_RUN_NATIVE_KEYRING_SMOKE=1 bun test tests/mcp-keyring-platform-smoke.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。`.github/workflows/mcp-native-keyring-smoke.yml` 在 macOS、Windows、Ubuntu 三个平台运行同一原生 smoke；Phase 3 完成前必须取得三个 job 的通过证据。
相关：ADR-0013、ADR-0012、[`mcp-control-plane.md`](mcp-control-plane.md)、[`mcp-config-management.md`](mcp-config-management.md)、`src/core/mcp/credential-store.ts`、`src/core/mcp/oauth-provider.ts`、`src/core/mcp/auth-coordinator.ts`、`src/app/tui/mcp/McpAuthPrompt.tsx`。

## 凭据持久化

生产 `NativeMcpCredentialStore` 只调用 `@napi-rs/keyring` 原生 API，不执行 keychain CLI，不保存明文/加密 JSON fallback。backend 状态为 `available`、`locked` 或 `unavailable`；后两者必须 fail closed。测试与 CI 可注入 `MemoryMcpCredentialStore`，生产默认构造不得使用 fake。

Credential key 由 canonical workspace key、配置 source、Server 名称和 auth profile 组成，并经过 domain-separated SHA-256 后作为 OS vault account。material 可包含静态 secret 或 OAuth tokens、dynamic client information、PKCE verifier、discovery state 与更新时间。Core/control/TUI 只投影是否存在，不投影 material。原生读取返回的缓冲在解析后清零；普通配置、Runtime Event、session log 和诊断不得包含 material。

`disable`、`remove`、source shadow 或 reconfigure 不删除 credential。显式 logout/clear 才删除对应 profile；remote revoke 只有在授权服务器提供 revocation endpoint 时执行。

## 配置引用

普通 JSONC 的 `auth` 只适用于 HTTP transport，支持：

```jsonc
{
  "type": "environment",
  "header": "Authorization",
  "env": "MCP_TOKEN",
  "scheme": "Bearer"
}
```

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

环境变量只在 transport 构造时读取。credential/client secret 配置只保存 profile reference；inline `clientSecret` 被 schema 拒绝。TUI 不收集或写入这些字段。未配置 `auth` 的 HTTP Server 可在真实 401 后走 OAuth discovery；显式 `oauth` metadata 只用于 scope、client id 和 profile 覆盖。显式 `none`、`environment` 或 `credential` 不会被认证恢复流程自动升级为 OAuth。

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

`/mcp` 仍是 ADR-0012 的只读 effective Server 列表，不能 Login、Logout、Retry 或进入 auth 详情。真实认证阻塞由 App shell 独立提示：Enter/`l` 显式开始登录，Esc 延后；authorizing 时 Esc 取消 callback。提示不显示 authorization URL、token、scope、transport 或 capability 详情。

当前 Phase 3 尚未结束：macOS 原生 smoke 与 TUI PTY 认证场景已通过；Windows Credential Manager 和 Linux Secret Service 原生 smoke 仍是退出门禁。
