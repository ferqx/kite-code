# MCP 凭据与 HTTP OAuth

状态：active
读取时机：修改 MCP auth schema、共享 CredentialVault、owned OAuth 身份、HTTP header 注入、OAuth Session、callback/browser、认证原结果或来源删除清理时。
验证：`bun run test`、`bun run typecheck`、`bun run check:unified-agent-boundary`。协议、默认装配和取消由 [Session](../../apps/service/test/isolated/mcp-oauth-session.test.ts)、[Actions](../../apps/service/test/isolated/mcp-oauth-actions.test.ts)、[HTTP ownership](../../apps/service/test/isolated/mcp-http-oauth-ownership.test.ts) 和 [Source 集成](../../apps/service/test/isolated/mcp-source-oauth-integration.test.ts)负责；真实平台资格按[进度](../plans/unified-agent-refactor-v1-progress.md)核对。
相关：[当前决定](../../.agents/notes/implemented/architecture/2026-10-05-owned-mcp-oauth-and-original-auth-actions.md)、[原生存储历史理由](../../.agents/notes/implemented/feature/2026-07-16-mcp-credential-store-and-oauth-session.md)、[控制面](mcp-control-plane.md)、[来源配置](mcp-config-management.md)、[Agent MCP](../../packages/agent/src/mcp/README.md)、[Service](../../apps/service/README.md)。

## 一个 Vault 与准确 owned 域

生产沿默认 Service 的同一个 [CredentialVault](../../packages/agent/src/config/credentials.ts) 与 [native backend](../../packages/agent/src/config/os-credentials.ts)，只用 `@napi-rs/keyring`，没有 CLI、明文文件或自建加密 fallback。backend 的 available、locked、unavailable 来自实际操作；不可用时 OAuth 依赖局部拒绝，不阻断无关普通任务和 SQL 历史读取。factory/import 不读取保险库。

手工 secret 继续使用 `credential:<uuid>`。OAuth 使用同 Vault 的闭合 `mcp.oauth` owned scope，account 是 domain-separated SHA-256；普通 UUID 接口不能访问它。Service 从真实 Profile access key、原 Store、Workspace/physical identity、Source identity、Server、raw/transport digest 和 auth profile 导出 owned 身份。同 Workspace 后续 Session 可复用准确材料，Session/Execution/当前权限仍独立核验；新 Store、同路径换根或 Source 漂移不自动承接旧材料。

[OAuth provider](../../packages/agent/src/mcp/oauth-provider.ts) 只把 tokens、dynamic client information、discovery state、时间及 tokenRevision 写入 owned account。PKCE verifier 和随机 state 仅在当前 flow 内存中。完整材料最多 64KiB；保存与读取共同验证实际 HTTP 可消费的 Bearer token，沿已有 Broker 的 8000 字符上限。原生 put 已开始后的取消或错误保持 publication unknown，不能据取消推断零写入。

同一个 [Broker](../../packages/agent/src/mcp/credentials.ts) 发放短期 opaque handle；header materialization 再读准确 scope 和原 tokenRevision。清理后重新登录得到新 revision，旧连接不能借用新 Token。删除失败会阻断本 Vault 当前 authority；其他 Vault 可能仍看到实际残留，不宣称跨进程删除成功。秘密不进 Command、Event、SSE、普通结果、JSONC 或 UI。

## 配置与自动资格

HTTP raw auth 接受 none、有限手工 Bearer credential 或 oauth。OAuth 只保存 profile label `credentialRef`、可选 scopes/clientId 和 opaque `clientSecretRef:credential:<uuid>`；拒绝 inline clientSecret。metadata 私人保留，不成为批准、Vault 或浏览器许可。stdio 不接受 auth。

显式 oauth 的 enabled/admitted Source 可经新的普通 Login Action 请求认证。省略 auth 的 HTTP 是 auto 候选，只有当前进程、同一 owned 域的实际 401 才允许 Login，并可使用响应中经校验的 resource metadata URL/scopes；资格不持久化。显式 none 或 manual credential 不升级。普通 401 只记录有限 login/reauth required，零 browser、callback、DCR 或原 RPC 重发。

## 普通认证 Action 与历史

`builtin.mcp.sources` 注册 `mcp.auth.login/refresh/clear/revoke@1`，输入恰 `{serverId,expectedReadSet}`。每次核真实 Command、subject、Store、Session、原 runless Execution、完整 input digest、当前 Source 和 Workspace；普通执行许可与来源批准分别检查。四动作与后台恢复/刷新共享实际 Service 的 WorkspaceSerialLocks，lease 保持到原 owned 操作结算。

- Login 先确认 Vault 可用，再在 127.0.0.1 随机端口创建 callback。低层 SDK discovery、可选 Login-only DCR 与 PKCE 后，才以固定 argv 调用系统 opener。callback 只接受精确 GET/host/path、两个唯一 code/state、当前 constant-time state 及仍有效 Source。成功只证明 tokens 已保存。
- TLS保持原URL身份与证书验证；IP literal不发送IP-valued SNI，域名保原SNI。单张公开测试证书只在可信host显式loopback选项下接纳，不进入source配置/环境或系统证书库；该测试网络必须在制品构建前固定并计入摘要。
- 连接凭据恢复只读取已有材料；临近过期才主动 refresh。无 callback、browser 或 DCR fallback，失效 refresh 返回有限 reauth required。显式 Refresh 不升级为 Login。
- Clear 只删除准确本地 owned account。Revoke 仅在明确请求且 AS 有 revocation endpoint 时以 POST body 撤销，再本地清理；不支持时保留 tokens/client information 并报告 not supported。
- timeout/cancel 清当前 verifier、listener、owned network sockets 和 opener helper，不重试。native put/remove、远端 revoke 请求已开始，或 helper/lock/network 清理未确认时保留原 outcome unknown；取消不能反推零效果。

认证完成、连接 ready 和 Tool 权限分别证明。认证不自动 reconnect/discovery，不重放旧 Tool 或 Task；新连接由现有普通 connect/reconnect 入口独立申请。普通 connect 首次失败留下的隔离，仅在原 parent/Job 全身份、真实终态及同一 owned transport 已停止后允许新的普通申请；reconnect 的未知 stop/publication fence 不因此解除。

`mcp.auth.status@1` 读当前安全 policy、backend status 和 presence，零 OAuth network/browser。`mcp.auth.result@1 {commandId}` 只读原 SQL Command/Execution/Session 与完整最终回执，保原 binding、authStatus、effectAttempted 和有限 reason；零当前 Source、physical Workspace、Vault、transport、Model 或补写。Command applied 单独不足以证明认证成功。原 Login 可在这份原最终结果中携 `ownedLauncher`：closed v1 固定完整 Auth binding、实际 owner／launcher PPID／Darwin birth，以及原 Bun `exited`／signal／reap 和 kernel 状态；覆盖 `oauth-launcher-only`，浏览器本体是 external。只有真实所属 child 的 exit 生成 reap，不把 null／error／listener close 当作退出。无 launcher 的原结果保持旧六字段，严格新字段继续进入完整 finalization digest；公开 Auth Query 九字段 payload 保持，完整 proof 沿原 Execution GET 读取；查询只读历史、不重新观察内核、不执行登录或恢复。URL／state／code／PKCE／token／argv／env 不进入这份有限事实，观察不可用不改变已发生认证效果。实际实现归[Service owner](../../apps/service/README.md)。

## 来源删除与客户端

Remove 对准确 owned 域先检查后端可用性，声明发布后才本地清理。文件发布与删除凭据不是事务：`mcp.source.mutation.result` 的 saved 只证明声明发布，独立 credentialCleanup 区分未尝试、无需清理、completed、failed 和 outcome unknown。清理失败保留已删声明与原证明，不回滚文件、不默认 remote revoke。manual shared Bearer 保留；disable、shadow、手工改配置不删除凭据，已有请求和已解析 header 无法撤回。

共享 TUI 的 HTTP Source 详情提供 Authentication；四动作先 Review，再独立 Enter Confirm。只显示安全状态和原 IDs，成功提示另行申请重连。原申请复用 `ui/caller-intents.json`，冷列表和选择零 GET，明确 Check 才查原 Caller 与有限结果；未知先核原申请，不重 POST。关闭、Esc、Ctrl+C 和切 Session 仅结束 Reader，取消业务需准确原 execution.cancel 独立申请。

Native MCP 设置通过有限 Main manager封存完整非秘密原申请；四Auth先Review/Confirm再走独立普通Job Ask，原结果沿正式Query核C/E/binding，连接另行申请。冷列表零GET/POST、明确Check只查原ID；未知在当前Store阻止另一次写入。Native来源发表已确认但cleanup失败/未知时保原声明证据和总体unknown。[Desktop owner](../../apps/desktop/README.md#native-mcp-完整设置)负责实际窗口资格，DB7/manifest15原字节备份恢复由独立maintenance codec验证。

现有 Caller 资产实际含 Auth 请求时选择 closed backup v13，没有新增认证 journal。旧 v2–v12 请求语法和物理白名单保持；恢复保原字节、Store/subject/Session/phase，不能授予新 POST、审批或 Vault 权限。[维护 owner](../../packages/agent/src/maintenance/README.md)负责准确格式。

## 资格范围

本机[源码外 Auth PTY](../../apps/cli/test/isolated/tui-mcp-auth-pty.test.ts)已核真实键盘五次 Review/Confirm、受控 AS 的实际 OAuth wire，以及移除 Source/physical Workspace 后的冷原结果读取；普通 Ask 由 observer SDK 回答。完整范围归[CLI owner](../../apps/cli/README.md#tui-mcp-http-认证与原申请)。受控 AS、fetch callback opener、临时 Vault 与 Ink/Host 不建立真实外部 AS、系统浏览器、原生 OAuth Vault 组合、异常 PTY 清理或三平台资格。实际 macOS synthetic native owned CRUD 与 fresh-Vault 删除确认有独立进度证据；Windows/Linux owned 路径仍需实际验证。

现行 [workflow](../../.github/workflows/mcp-native-keyring-smoke.yml)以 CI-only [native credential test](../../tests/isolated/unified-agent/native-credential-platform.test.ts)检查新正式候选的普通凭据，不能从其存在推导本轮 OAuth 资格。旧 Phase 3 的[历史证据](https://github.com/ferqx/kite-code/blob/8aa02d4ca07350f37d3805c17ac9f10bf828e6a9/docs/space/execution/completed/2026-07-16-mcp-auth-phase3.md)只属旧 Manager/Store/TUI，不承接为当前实现证明。


[Native人工系统浏览器入口](../../apps/desktop/scripts/qualify-native-mcp-browser.ts)已取得本机macOS默认Chrome与默认OS vault组合资格：四项Auth、准确原Login取消、真实document导航/PKCE、fresh Service复用、冷原GET零POST和清理后fresh absence全部通过最终passed及原wire/report。自有HTTPS准备页到达后才启动原Login的默认opener与120秒callback；若出现浏览器证书提示仍由用户处理，没有fetch callback替代或系统信任修改。本机固定loopback/测试证书不代表生产默认网络、外部AS/账号或其他平台；完整边界归[Desktop owner](../../apps/desktop/README.md#native-mcp-完整设置)，准确运行证据归[进度](../plans/unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-chrome-与默认-vault-验收)。
