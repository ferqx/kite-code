# ADR-0013：MCP 凭据使用原生系统保险库，OAuth 通过独立恢复提示驱动

状态：accepted
日期：2026-07-16
决策者：@chenchao
相关：ADR-0009、ADR-0010、ADR-0012

## 背景

HTTP MCP Server 可以通过静态 Bearer/API key 或 OAuth 2.1 认证。token、client secret、PKCE verifier 和 discovery state 不能进入普通 JSONC、control snapshot、Runtime Event、session log 或命令行参数。Phase 2 后 `/mcp` 已由 ADR-0012 收敛为只读连接列表，因此认证恢复不能重新引入 `/mcp` 详情或管理 route。

仓库此前没有安全 credential backend。明文 JSON、仅依赖文件权限的 token 文件、CLI keychain fallback 或自建加密文件都会产生新的密钥管理问题，也无法满足“backend 不可用时 fail closed”的要求。

## 决策

生产 `McpCredentialStore` 只使用 `@napi-rs/keyring` 直连原生系统保险库：macOS Keychain、Windows Credential Manager 和 Linux Secret Service。credential account 是 workspace key、source、Server 和 profile 的 domain-separated SHA-256 身份；不以 URL 作为唯一键，也不暴露这些字段。实现不提供明文文件、加密文件或 shell command fallback。保险库 locked/unavailable 时返回 typed 状态并停止认证。

普通 MCP 配置只允许环境变量名、credential reference 和 OAuth metadata。inline OAuth client secret 被 schema 拒绝。静态 credential material 只在 HTTP transport 构造期间解析为 header；OAuth token、dynamic client information、PKCE verifier 和 discovery state 由 SDK provider 通过同一 Store 读写。remove/disable/reconfigure 不自动删除 credential。

OAuth 继续使用唯一 `McpManager`/SDK client 路径：

1. 后台无凭据连接遇到 401 时只发布 `login_required`，不打开浏览器；
2. 已有 token 可以在启动时后台恢复或 refresh，失败转 `reauth_required`；
3. 用户在 App shell 的独立认证提示显式登录后，Coordinator 绑定 `127.0.0.1` 随机端口，生成隔离的高熵 state 和 PKCE verifier；
4. browser opener 使用参数数组直接调用系统 opener，不经过 shell 拼接；
5. callback 必须匹配当前 flow/state，完成 code exchange 后以新连接重新 discovery；
6. timeout、cancel 和失败关闭 listener，旧 flow 不能完成新 generation；
7. logout 清除本地 material；Server 支持 revocation endpoint 时可先撤销 token；
8. 认证成功不自动重放旧 Tool Call，只影响后续 model turn 的新 binding。

`/mcp` 继续只读且无操作。独立认证提示只在 effective HTTP Server 真实进入 `login_required`、`reauth_required` 或认证错误时出现；它不是配置管理入口，也不展示 URL、token、scope 或 capability 详情。

## 影响

- 增加原生二进制可选包，发布矩阵必须在 macOS、Windows、Linux 分别运行 keyring write/read/delete smoke；
- CI 与单元测试通过注入 `MemoryMcpCredentialStore` 和 fake callback/browser adapter，不访问测试机真实用户凭据；
- Linux 无 Secret Service、桌面保险库 locked 或 native addon 不可加载时，OAuth/credential reference 不可用，但环境变量 header 与无需认证的 Server 继续工作；
- control snapshot 只公开 auth status、credential 是否存在和安全错误码；authorization URL 只存在于短生命周期 Coordinator 内存；
- callback 使用 HTTP loopback 是 OAuth native app 模式的一部分，listener 不绑定 `0.0.0.0`。

## 回滚

可以移除 OAuth 恢复提示和原生 backend 依赖，使 HTTP 认证退回环境变量引用；不得把已保存 token 导出为普通文件或恢复 shell/明文 fallback。任何新的 `/mcp` 认证管理 route 需要替代 ADR-0012 的新产品决策。
