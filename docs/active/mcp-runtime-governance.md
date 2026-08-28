# MCP Runtime Governance

状态：active

读取时机：修改 MCP discovery、动态工具绑定、transport、credential、MCP policy、Tool/Resource 调用或结果归一化时。

验证：`bun test apps/kite-service/test/mcp.test.ts tests/integration/mcp-manager.test.ts tests/integration/mcp-stdio-transport.test.ts packages/builtin-runtime/test/mcp-transport-boundary-concurrency.test.ts packages/builtin-runtime/test/mcp-credential-broker.test.ts apps/kite-service/test/mcp/write-admission.test.ts packages/builtin-runtime/test/mcp/write-dispatch-governance.test.ts apps/kite-service/test/isolated/runtime/tool-controller.test.ts tests/tui-system/scenarios/mcp-management-readonly.test.ts`、`bun run test:mcp:live`、`bun run typecheck`、`bun run check:core-boundary`。

相关：ADR-0127、ADR-0131、`mcp-control-plane.md`、`mcp-authentication.md`、`mcp-project-approval.md`。

MCP native keyring 与 LangChain live smoke 使用正式 CI 基线 Bun `1.4.0`，不得与 Required CI
形成第二套 Bun 基线。

## 唯一 owner 与 binding

MCP 的 connect/discovery/read、Manager/Supervisor、auth/credential、transport、write governance 与结果归一化都由 `packages/builtin-runtime/src/mcp/` 拥有。App 只组合配置、execution/network boundary、共享 CredentialBroker 和 neutral Host process port；Host 只拥有 generic process/network mechanism。不存在 Core/SDK direct caller、第二 Manager 或 App-side Tool decision。

动态能力只有在 `capabilityCatalog` 与 `mcpRuntimeBinding` 都开启时才可执行。Model-visible name 必须匹配当前 capability binding、turn、descriptor revision 与 input schema；Runtime 调用 `McpRuntimeProvider.callCapability()`，Supervisor/Manager 在 transport 前再次核对 current generation、availability、revision 和 schema。展示名永远不被解析为执行身份。

Catalog snapshot 是不可变、版本化的。`list_changed`、disable/remove、config/approval drift 或成功 rediscovery 会替换 snapshot；旧 binding 不原地更新并 fail closed。Tool Search/inventory/resource discovery 只读 snapshot，不触发 readiness 或 transport。

## HTTP transport

Remote HTTP connect、discovery、resource、Tool 与 OAuth operation 使用逐 operation admission，绑定 canonical Workspace、execution/network boundary、canonical endpoint/revision 与 invocation/tool-call identity。Custom fetch 每个 redirect hop 都重验 DNS、private destination、exact host allowlist 与 pinned address，不继承 ambient proxy credential。

HTTP Tool dispatch 对最终 arguments 只执行一次深冻结 JSON-safe bounded snapshot。schema validation、secret inspection、argument digest 与 SDK wire 都消费同一 snapshot；accessor、custom `toJSON`、symbol、sparse/extended array、cycle、unsupported prototype、超 depth/node/character 或 credential-shaped content 在 transport 前拒绝。此检查用于阻止 secret 泄漏和 TOCTOU，不签发 DataOrigin、EgressAuthority、permit、receipt 或 nonce ledger。

空或非空合法参数都不需要第二套 content-egress authority。Tool effects approval、execution boundary、HTTP endpoint/TLS 与 credential broker 已分别覆盖真实边界；不得恢复 `RemoteMcpEgressPermit`、`mcp.egress_decided` 或相关 feature flag。

## stdio transport

Builtin Manager 不导入 `StdioClientTransport`、`cross-spawn`，也不展开 `process.env`。它只把 exact server/revision/command/args/cwd 与显式 safe env 交给 `McpStdioProcessPort`；Host-owned wrapper 是唯一 spawn owner。Production composition 未提供合格 process port 时 local stdio fail closed，spawn=0。

Host wrapper 先验证 strict `RuntimeControlFrame`，再启动 exact MCP child；ready/terminal control frame 绑定 domain、peer、invocation 与 monotonic sequence。control channel 不包含 secret/HMAC/bootstrap key，也不传给实际 child。JSON-RPC line/read/write/backpressure 都有固定 bounds；wrong peer/invocation、replay、unknown/truncated/oversized、child pre-ready exit 或 cleanup unknown 都 fail closed。

command、path-like argv 与 cwd 在 Host port 前经过 protected-path/effective Workspace 检查。canonical Workspace
member 无论名称是否为 `.git`、`.env` 或 Agent/MCP 配置都允许进入后续 process/surface gate；Workspace 外
未批准路径、Workspace drift 或 config revision drift 必须保持 Host spawn 为 0。HTTP 不套用 stdio control frame；其真实性来自真实 TLS/OAuth/network boundary。

## Credential

TUI/App composition 只构造一个共享 Builtin CredentialBroker，并注入 Supervisor、Manager、AuthCoordinator 与 OAuth provider。OS keyring/Native store 只是 broker 的私有机制；production consumer 不自行 `new NativeMcpCredentialStore`，不读取 `process.env` secret，不传 raw `material.secret`。

跨 operation 只传 project/provider/profile/purpose/expiry/revocation 的 opaque handle。Broker 仅在构造 HTTP auth header 或 OAuth request 的使用点短暂物化 secret；Event、Snapshot、CapabilityResult、Notification、diagnostic 和日志不得包含 secret。Memory store 只供显式测试。

## Policy 与 result

Execution capability surface 在 disclosure 和 dispatch 前应用 filesystem/network/external-state ceiling；approval 不能扩大该 ceiling。Visibility 顺序为 `enabledTools` allowlist → `disabledTools` denylist → exact per-tool override。Remote annotation 默认不可信；只有显式 trusted source 的 `readOnlyHint` 可把 effective effect 收紧到 read-only，不能降低 local minimum approval。

Project MCP declaration 在 transport construction 前通过 Workspace/source/name/raw-config digest approval。pending/rejected/changed/invalid 项不进入 Manager。Execution approval、annotation trust 和 Tool approval 是三个独立事实。

MCP protocol result 被归一化为 `@kite-ai/runtime-contract` 的唯一 JSON-safe `CapabilityResult`。每个真实 Tool attempt 在协议请求前 durable ack；已知 terminal 写入 private Capability Artifact，并与 Tool terminal 原子提交。write/unknown effect 在 dispatch 后缺可信 terminal 时保持 `execution_unknown`，不因 SDK/provider error 自动重放。Safe-read retry 仍要求新的 Runtime attempt acknowledgement。

`McpSupervisor` 是唯一 App-facing control plane；Runtime 只依赖 `McpRuntimeProvider`，TUI 只依赖 App controller 和 immutable control snapshot。Generation token 阻止 late connect/discovery/list-changed 恢复旧能力。Provider action/required-provider admission 使用持久 Runtime interaction；waiver 只释放当前 admission，不创造 descriptor、binding 或 availability。

## 禁止事项

- production direct SDK stdio spawn、ambient env spread、raw credential config；
- App/Controller 的第二次 MCP Tool decision；
- DataOrigin/EgressAuthority、Remote MCP permit/receipt、egress nonce table；
- 把 MCP initialize、remote annotation、Tool approval 或 HTTP status 当成 transport authenticity；
- transport/Artifact/persistence failure后的自动 fallback、双写或第二 owner。
> 路径同步：live/runtime 验证引用当前无版本命名的 state/store 实现路径。
> Architecture gate: `bun run check:pre-release-architecture` validates production naming and the single App composition root before release-stage changes.
