# MCP Control Plane 与 TUI 状态视图

状态：active
读取时机：修改 `McpManager` 生命周期、`McpSupervisor`、MCP control snapshot、TUI `/mcp` 路由或 Runtime MCP provider 边界时。
验证：`bun test tests/mcp-manager.test.ts tests/mcp-supervisor.test.ts tests/mcp-config-reconcile.test.ts tests/mcp-credential-store.test.ts tests/mcp-auth-coordinator.test.ts tests/mcp-oauth-integration.test.ts tests/mcp-panel.test.tsx tests/tui-slash-command.test.ts tests/slash-suggestions.test.ts`、`bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-management-readonly.test.ts tests/tui-system/scenarios/mcp-project-approval.test.ts tests/tui-system/scenarios/slash-commands.test.ts`、`bun run typecheck`、`bun run check:core-boundary`。
相关：ADR-0010、ADR-0011、ADR-0012、ADR-0013、ADR-0014、ADR-0015、ADR-0016、ADR-0017、[`mcp-config-management.md`](mcp-config-management.md)、[`mcp-authentication.md`](mcp-authentication.md)、`src/core/mcp/supervisor.ts`、`src/core/mcp/control-types.ts`、`src/app/tui/mcp/`。

## 权威与依赖

`McpSupervisor` 是 MCP 连接 control plane 的唯一 App 入口。它通过 `McpConfigRepository` 加载 source-aware config catalog，立即发布 configured、disabled、pending、rejected、invalid 和 shadowed 条目，再在后台通过唯一的 `McpManager`/SDK client 路径连接可连接 Server。单个 Server 失败不阻塞 TUI mount 或其他 Server。

Runtime 只接收 `McpRuntimeProvider`，不依赖 Supervisor control API 或 TUI controller。`DefaultMcpSupervisor` 实现该中立接口并把真实 discovery/call/resource 委托给 Manager，因此 Runtime 能同时读取 capability snapshot 和脱敏 provider directory；它不能调用 reload、retry、login 或配置 mutation。TUI 只接收 `McpController` 和不可变 `McpControlSnapshot`，不得持有 `McpManager`，也不得调用 `getServerStates()`。Manager 的该方法只保留为 Core control-plane 迁移 API，并返回隔离副本。

## 生命周期与 generation

- `disconnect(name)` 先从 capability snapshot 和 prompt registry 移除 Server，再 best-effort 关闭 client；
- `reconnect(name, config, generation)` 先完成上述失效，再创建替代连接；
- connect、discovery 和 list-changed 回调只有在 client 与 generation 仍匹配时才能发布状态；
- 迟到的旧 generation 必须关闭自身，不能覆盖新状态或恢复旧 capability；
- `disconnectAll()` 先原子清空 Manager 可见状态，再并行关闭 transport；
- Supervisor 的 `start()`/`stop()` 幂等；Core reload、retry 和 mutation 进入同一串行 reconcile 队列并再次经过项目审批门禁；
- catalog diff 中 changed、removed、disabled 先撤销能力再关闭旧 client；unchanged 保留现有连接；
- provider config version 变化必须改变 capability descriptor revision，旧 turn binding fail closed。

Manager health、discovery、list-changed、call circuit 和 retry 变化均触发订阅。Supervisor 将其与 config catalog 投影为新的稳定 snapshot；snapshot revision 对规范化的可见字段计算，同一内容不会因 React render 产生伪 revision。

## Snapshot 与诊断

Control snapshot 包含全部有效和被遮蔽的 Server，并提供 source/revision、enabled/required、shadow/fallback、transport、config/auth/health、generation、capability revision、Tools/Resources/Prompts 只读投影、计数、retry 时间和 typed diagnostic。每个 Tool 投影区分 discovered、enabled、available/unavailable/quarantined，并包含 declared/effective effects、annotation provenance、policy source、minimum approval、retry 和 schema diagnostic；配置引用但 discovery 未返回的名称以 `tool_not_discovered` 投影。`toolCount` 只统计真实 discovery，`availableToolCount` 只统计进入 Runtime catalog 的 enabled 且 schema-valid Tool。

Auth 只投影状态、credential 是否存在、短生命周期 flow id 和安全错误码，不投影 authorization URL 或 material。数组、key、审批 review 与嵌套 capability 数据均不可变。

Core diagnostic 只表达 code、retryable、脱敏 message 和有限 technical fields。Core 不提供展示标题或操作文案。URL 只保留 origin，authorization、token、secret 和 query credential 必须脱敏；TUI 决定标题、颜色、截断和建议动作。

Runtime-facing provider directory 只包含 effective Provider 的名称、归一化 availability、required/source、有限 diagnostic code、retryable 和安全截断的 last-known Tool 名称。它不包含 URL、command、raw error、credential、description、schema、capability ID 或 executable handle。首次 discovery 前名称列表为空；同一 effective Provider 暂时不可用时可保留最近一次 discovery 名称，remove/stop 后清除。

## TUI 行为

`/mcp` 只接受无参数形式并打开只读 Server list。列表过滤为 effective Server，每行只显示 `[status] server-name`；不显示 shadowed 来源、transport、source/scope、capability 数量、Tools、Resources、Prompts、配置摘要或诊断详情。配置门禁阻止连接时，状态行显示 pending-approval、rejected、invalid 等门禁状态；允许连接但当前 health 为 disconnected 时显示 disconnected。

Overlay 不存在 selection、搜索、详情或操作 route，只允许 Up/Down 滚动超长列表并用 Esc 关闭。带参数的 `/mcp ...` 作为 unknown command 处理，不触发任何副作用。动态 `/mcp__<server>__<prompt>` 命令不受影响。

TUI controller 不暴露 add、enable/disable、remove、legacy migrate、reload 或 retry。项目 config-digest 决定由 App shell 的独立信任提示调用 `decide()`，不属于 `/mcp`；approve/reject 继续二次确认，Esc 只延后。revision conflict、原子写入、source 权威与 reconcile 仍属于 Core，可供非 TUI 调用方使用。完整配置规则见 [`mcp-config-management.md`](mcp-config-management.md)。

HTTP 401 产生的 `login_required` 由 App shell 的独立认证提示恢复，不进入 `/mcp` route。只有用户显式 Login 后才创建 loopback callback 和打开浏览器；stored token resume 不打开浏览器。完成 code exchange 后 Manager 通过新连接重新 discovery，旧 binding 与旧 Tool Call 不更新或重放。完整认证规则见 [`mcp-authentication.md`](mcp-authentication.md)。

Core Runtime 已在默认关闭的 `mcpProviderActionV1` 后提供持久 Provider Action lifecycle。它只向 App shell 请求固定 `login`、`approve` 或 `retry`，不获得 control mutation API。TUI 使用既有 foreground/background interrupt routing 收集显式决定，再由 `TuiMcpController` 调用 Supervisor 的 login、project approval 或 retry；完成后返回新的 directory revision，Runtime 以新 turn 重新进入模型边界。CLI 没有该 App controller 时安全 defer。不得因为 flag 打开而在 `/mcp` 增加操作。

同一 flag 还在新 Agent run 的首次模型调用前检查 effective required Provider。`ready`/`degraded` 直接准入，其他状态进入 Runtime gate；TUI interrupt 提供 Retry、Session Waive 或 Cancel Run。Waive 只写 Runtime session 事实，不修改 control snapshot 或 capability 可见性。
