# MCP TUI 管理中心 RFC

状态：superseded（历史设计；新交互以 ADR-0018 与 2026-07-18 实施计划为准）
审核日期：2026-07-15
批准日期：2026-07-15
代码基线：`mcp` / `41585a14dcf3`
范围：MCP 配置来源、项目审批、连接生命周期、认证、Capability 投影与 TUI 管理
分类：Security + Capability + Control Plane + TUI

相关：

- [`README.md`](README.md)
- [`../active/mcp-runtime-governance.md`](../active/mcp-runtime-governance.md)
- [`../active/capability-progressive-disclosure.md`](../active/capability-progressive-disclosure.md)
- [`../active/authorization.md`](../active/authorization.md)
- [`../active/layer-boundary-enforcement.md`](../active/layer-boundary-enforcement.md)
- [`../active/feature-flags.md`](../active/feature-flags.md)
- [`../book/07-TUI结构.md`](../book/07-TUI结构.md)
- [`../book/08-TUI交互全景.md`](../book/08-TUI交互全景.md)
- [`../book/09-CLI模式与配置.md`](../book/09-CLI模式与配置.md)
- [`../book/11-MCP与Skills扩展.md`](../book/11-MCP与Skills扩展.md)
- [`../adr/0007-capability-bindings.md`](../adr/0007-capability-bindings.md)
- [`2026-07-14-mcp-skills-runtime-governance-rfc.md`](2026-07-14-mcp-skills-runtime-governance-rfc.md)
- [`../space/plans/2026-07-15-mcp-tui-management-center-implementation.md`](../space/plans/2026-07-15-mcp-tui-management-center-implementation.md)
- [`../space/plans/2026-07-15-mcp-project-server-approval-p0.md`](../space/plans/2026-07-15-mcp-project-server-approval-p0.md)

> 本文保留 2026-07-15 的历史设计。2026-07-16 的只读纠偏曾替代其 TUI 结论；2026-07-18 又由 ADR-0018 接受更窄的 Select 管理中心。新的实施依据为 [`../adr/0018-mcp-tui-select-management-center.md`](../adr/0018-mcp-tui-select-management-center.md) 和 [`../space/plans/2026-07-18-mcp-tui-select-management-center.md`](../space/plans/2026-07-18-mcp-tui-select-management-center.md)。

## 一、结论

Kite Code 应将 `/mcp` 从只读状态面板升级为 MCP 管理中心，但不能从扩展 `McpPanel` 和 `useMcpConnection` 开始。可实施顺序必须是：

```text
项目配置执行门禁
→ source-aware 配置模型
→ 可观察 McpSupervisor
→ 只读管理界面
→ 配置编辑
→ OAuth 与 Credential Store
→ Tool 策略
→ Agent 不可用原因与恢复闭环
```

本 RFC 接受以下产品目标：

1. 用户可以在 TUI 查看、添加、启停、重试和删除 MCP Server；
2. 用户可以查看 Tools、Resources、Prompts、认证和错误详情；
3. 项目仓库不能自行批准或启动自己声明的 MCP Server；
4. TUI 展示、Capability Catalog 与 Agent 实际可调用能力保持一致；
5. OAuth、配置热重载和 Tool 策略不能绕过既有 revisioned binding、effect、approval 和 invocation governance。

本 RFC 不接受以下实现方式：

1. 不以新的 `connected: boolean` 或简化状态枚举替换现有 `McpHealthState`；
2. 不让 TUI 组件直接读写 `McpManager` 的可变 Map；
3. 不把全部 MCP control-plane 事件写入任务 Runtime；
4. 不把项目 Server 审批、workspace trust 和 annotation trust 合并为一个 `trust` 字段；
5. 不在 OAuth 后自动重放旧 MCP Tool Call 或复用旧 binding；
6. 不把 Credential Vault、OAuth、三层 scope 和 Agent interrupt 一次性列为单个 P0。

## 二、当前代码事实

### 2.1 已有能力

当前 Core 已经具备以下 MCP 运行能力，不应重复实现：

- `@modelcontextprotocol/sdk` 的 stdio 与 Streamable HTTP transport；
- `connecting`、`discovering`、`ready`、`degraded`、`half_open`、`circuit_open`、`quarantined` 等 health；
- tools、resources、prompts discovery；
- `tools/list_changed`、`resources/list_changed`、`prompts/list_changed` 动态更新；
- HTTP transport 重连参数和 tool-call circuit breaker；
- revisioned `CapabilitySnapshot` 和 turn-scoped binding；
- tool effect、minimum approval、retry 与 idempotency policy；
- 结构化结果、invocation record、verification 和 progressive disclosure。

当前行为权威见 `docs/active/mcp-runtime-governance.md`。本 RFC 只扩展配置、认证、生命周期观测和前端控制面，不建立第二条 MCP 执行路径。

### 2.2 当前主要缺口

1. `useMcpConnection` 只在挂载时加载配置、创建 Manager 并执行一次 `connectAll()`；
2. `McpPanel` 直接调用 `manager.getServerStates()`，读取内部可变 Map，没有状态订阅；
3. Manager 缺少单 Server disconnect/retry/reconfigure 的完整公开生命周期；
4. 配置加载返回合并后的 `Record<string, McpServerConfig>`，丢失来源、scope 和遮蔽关系；
5. `.mcp.json` 中的项目 Server 会进入启动集合，没有本地审批门禁；
6. 当前 `trust` 表达的是 annotation trust，不是项目配置执行批准；
7. 没有生产级 OAuth `authProvider`、Credential Store 或认证状态；
8. 错误主要保存为 `String(error)`，缺少结构化分类、用户建议和统一脱敏边界；
9. 配置写入仅有少量用户配置 helper，没有 MCP source-aware、并发安全、原子化 mutation API；
10. TUI `/mcp` SlashAction 只有打开面板一种操作。

### 2.3 当前最优先的安全缺口

当前启动链路是：

```text
读取用户和项目配置
→ 读取项目根目录 .mcp.json
→ new McpManager()
→ connectAll()
→ stdio transport 启动项目声明的命令
```

因此，项目 MCP 审批不是 Phase 2 产品增强，而是 Phase 0 安全门禁。在审批前必须禁止创建 transport、启动 stdio 进程或向远程 Server 发送请求。

## 三、目标与非目标

### 3.1 目标

- 建立 source-aware MCP 配置目录，保留每个 Server 的来源、scope、有效性和遮蔽关系；
- 对所有项目来源的 Server 执行本地、按配置摘要绑定的审批；
- 建立一个前端无关、可订阅、可测试的 `McpSupervisor`；
- 为 TUI 提供不可变、带 revision 的纯数据 snapshot；
- 支持单 Server retry、enable、disable、add、remove 和安全热重载；
- 支持 HTTP OAuth login/logout/refresh/revoke 和安全凭证引用；
- 复用现有 Capability effect、approval、availability 与 binding 机制管理 Tool；
- 让 Agent 区分“能力不存在”和“Provider 已配置但当前不可用”；
- 明确并发调用、配置变更、认证过期和恢复时的 fail-closed 语义。

### 3.2 非目标

- 不重写 Runtime Kernel、Capability Catalog 或 MCP 协议执行链；
- 不引入第二个 MCP SDK 或第二条 MCP client 连接；
- 不在第一阶段实现 MCP Marketplace、自动发现、多账号切换或 Device Code；
- 不实现通用 Server 日志查看器或复杂 JSON Schema 编辑器；
- 不相信远端 Tool annotation 可以单独决定安全级别；
- 不承诺登录后自动恢复任意外部写操作；
- 不把 TUI 路由、选中项、颜色和文案放入 Core；
- 不允许项目配置保存 OAuth token、Bearer token 或 Credential Store 内容。

## 四、设计原则与不变量

### 4.1 安全不变量

1. 项目来源的 MCP 在本地批准前不得创建 transport；
2. 项目配置不能写入或修改自己的批准记录；
3. 配置摘要变化后，旧批准立即失效；
4. 项目配置不能通过 `trust`、Tool annotation 或 policy override 降低本地最低审批要求；
5. Credential 明文不得进入项目配置、Runtime Event、Capability Snapshot、session log 或诊断复制文本；
6. disable/remove/reconfigure 必须先使未来 binding 失效，再断开旧连接；
7. OAuth 成功后必须重新 discovery，并在新 model turn 签发新 binding；
8. 未知、写入和破坏性 Tool 继续遵守单次用户审批，TUI 的“Auto”不能放宽这一规则；
9. 对外部写调用不做未经 retry policy 允许的自动重放；
10. UI 显示 Ready 时，已启用且 schema 有效的 Tool 必须已进入当前 Capability Snapshot。

### 4.2 分层不变量

```text
src/core/mcp/       协议连接、Supervisor、认证协调、Core snapshot
src/core/config/    配置来源、解析、合并、mutation、approval record
src/protocol/       只有确需跨前端或持久化的中立契约
src/app/tui/mcp/    路由、键盘、ViewModel、渲染、确认框
```

- Core 不导入 TUI 类型；
- `McpServerViewModel` 属于 App 层；
- Core diagnostic 使用稳定 code 和原始技术字段，不生成颜色、图标或布局文案；
- TUI 不直接授予 Capability approval，不直接修改 RuntimeState；
- `McpManager` 仍是唯一 MCP 协议 client 路径。

### 4.3 状态权威

不同状态由不同权威拥有：

| 状态 | 权威 | 是否持久化 |
| --- | --- | --- |
| 配置来源、enabled、project approval | Config Repository | 是 |
| OAuth token、refresh token | Credential Store | 是，禁止进入普通配置 |
| auth flow pending | Auth Coordinator | 仅必要的非 secret continuation |
| connection health、retryAt、discovery | McpSupervisor/McpManager | 通常否 |
| Capability descriptor/revision | Capability Catalog | snapshot/Runtime binding 按现有规则 |
| TUI route、selection、search、confirm | TUI reducer | 否 |
| 当前任务的 provider failure/binding failure | Runtime Event | 是，仅任务相关事实 |

## 五、目标架构

```text
McpConfigRepository ─────── ProjectApprovalStore
        │                            │
        └──────── effective configs ─┘
                         │
CredentialStore ── McpAuthCoordinator
                         │
                         ▼
                  McpSupervisor
           config gate / lifecycle / retry
                         │
                单一 McpManager 路径
                         │
             CapabilitySnapshot revision
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
 Runtime binding/policy          McpControlSnapshot
          │                             │
          ▼                             ▼
 Agent execution gateway      App McpController
                                        │
                                        ▼
                              TUI reducer / overlay
```

### 5.1 `McpConfigRepository`

职责：

- 分别读取各配置来源，不在解析阶段丢失 provenance；
- 校验 raw config，保留可诊断的 invalid entry；
- 计算 Server identity、scope、遮蔽关系和 effective config；
- 使用 JSONC edit 保留无关字段和注释；
- 使用临时文件、`fsync`、rename 进行原子写入；
- 写入前校验目标文件未被外部修改，冲突时返回 `config_conflict`；
- 提供 add/update/remove/enable/disable 的 typed command；
- 不读写 credential 明文。

建议接口：

```ts
interface McpConfigRepository {
  load(workspace: string): Promise<McpConfigCatalog>;
  mutate(command: McpConfigCommand): Promise<McpConfigCatalog>;
  subscribe(listener: (catalog: McpConfigCatalog) => void): () => void;
}
```

### 5.2 `ProjectApprovalStore`

批准记录存放在用户控制目录，例如：

```text
~/.kite-code/mcp-project-approvals.jsonc
```

记录结构：

```ts
interface McpProjectApprovalRecord {
  workspaceKey: string;
  serverName: string;
  configDigest: string;
  decision: 'approved' | 'rejected';
  decidedAt: string;
}
```

约束：

- `workspaceKey` 使用 canonical real path 的摘要；不同 worktree 默认分别审批；
- `configDigest` 对规范化 raw config 计算，不保存 raw config；
- digest 包含 transport、command、args、cwd、URL、headers/env 的键和引用表达式、auth 配置与可执行相关字段；
- digest 不包含展开后的 secret 值；
- raw command、args、URL、env/header 引用或 auth 配置变化都会使批准失效；
- 拒绝不是永久黑名单，配置变化后形成新的 pending approval；
- annotation trust 使用独立本地记录或用户配置，不复用此批准。

### 5.3 `McpSupervisor`

Supervisor 是 Core control plane，不是新的 Runtime 总状态机。它协调 Config、Approval、Auth 和现有 Manager：

```ts
interface McpSupervisor {
  start(workspace: string): Promise<void>;
  stop(): Promise<void>;

  getSnapshot(): McpControlSnapshot;
  subscribe(listener: (snapshot: McpControlSnapshot) => void): () => void;

  retry(server: McpServerKey): Promise<void>;
  reload(): Promise<void>;
}
```

Supervisor 不直接包含 add/remove 等配置写命令；这些命令先进入 `McpConfigRepository`，成功产生新 catalog 后由 Supervisor diff/reconcile。这样 CLI、TUI 和未来前端共享同一 mutation 语义。

现有 `McpManager` 继续负责：

- 创建 SDK transport/client；
- connect/disconnect；
- list/call/read 与 notification；
- Capability descriptor 和 snapshot；
- call health、circuit breaker、retry policy。

需要为 Manager 补充单 Server 生命周期和状态通知，但不得再创建一个 SDK client 实现。

### 5.4 `McpAuthCoordinator`

职责：

- 只为 HTTP MCP 处理交互式 OAuth；
- 实现 metadata discovery、PKCE、state 校验、callback timeout、refresh 和 revoke；
- 通过 SDK `authProvider` 边界向 transport 提供 token；
- 对 TUI 提供非 secret 的 auth snapshot；
- login/logout 必须由用户操作触发，Agent 只能产生认证需求；
- callback 监听仅绑定 loopback，使用随机高熵 state，并在完成/取消后关闭；
- 不把 login URL 中可能敏感的 query 全量写入日志。

Credential Store 抽象：

```ts
interface McpCredentialStore {
  get(server: McpServerKey): Promise<McpCredentialMaterial | null>;
  put(server: McpServerKey, value: McpCredentialMaterial): Promise<void>;
  delete(server: McpServerKey): Promise<void>;
}
```

生产 backend 应使用系统凭证设施。不可用时 fail closed，并引导用户使用环境变量引用；不得静默降级为普通 JSON 明文文件。

### 5.5 `McpController` 与 TUI

`McpController` 位于 App 层，负责：

- 订阅 `McpControlSnapshot`；
- 转换为 TUI ViewModel；
- 调用 Config Repository、Approval Store、Auth Coordinator 和 Supervisor 的公开命令；
- 将 Core diagnostic code 映射为用户文案和下一步操作；
- 处理需要确认的 remove/logout/reject/disable；
- 不直接调用 `McpManager.getServerStates()`。

TUI 建议目录：

```text
src/app/tui/mcp/
├── McpOverlay.tsx
├── McpServerList.tsx
├── McpServerDetail.tsx
├── McpToolList.tsx
├── McpResourceList.tsx
├── McpPromptList.tsx
├── McpAddWizard.tsx
├── McpAuthView.tsx
├── McpApprovalView.tsx
├── McpErrorView.tsx
├── McpConfirmDialog.tsx
├── controller.ts
├── reducer.ts
└── types.ts
```

组件拆分以状态职责为依据，不要求为每一行建立独立文件。实现时应优先保持简单，并复用现有 overlay height、theme 和 Ink 输入模式。

## 六、配置来源与 scope

### 6.1 目标 scope

| Scope | 用途 | 是否共享 | 目标存储 |
| --- | --- | --- | --- |
| `local` | 当前用户、当前 workspace 的私有配置 | 否 | `~/.kite-code/projects/<workspaceKey>/mcp.jsonc` |
| `project` | 团队共享配置 | 是 | `<workspace>/.mcp.json` |
| `user` | 当前用户所有 workspace | 否 | `~/.kite-code/kite-code.jsonc#mcpServers` |

目标优先级：

```text
local > project > user
```

Server 不能只用名称作为内部身份：

```ts
interface McpServerKey {
  workspaceKey: string;
  scope: 'local' | 'project' | 'user';
  name: string;
}
```

另有 `effectiveId = workspaceKey + name` 表示当前生效实例。TUI 应显示有效配置，并能展开查看被遮蔽来源。

### 6.2 现有项目配置兼容

当前 `<workspace>/.kite-code/kite-code.jsonc#mcpServers` 也是项目来源，而且优先级与 `.mcp.json` 不一致。迁移期间：

1. 将其标记为 `project_legacy`，保持当前读取优先级，避免静默切换有效 Server；
2. TUI 只读展示来源，不向 legacy source 写入新 MCP 配置；
3. 提供显式迁移到 `.mcp.json` 的预览和确认；
4. 同名冲突必须显示，而不是静默覆盖；
5. 完成迁移、文档更新和至少一个发布周期后，另行决定是否删除 legacy 读取。

兼容行为必须在实施计划中用 fixture 固化，不允许在同一次重构中无提示改变 precedence。

### 6.3 Enable、Disable 与 Remove

```text
Disable
  保留当前 scope 配置与 credential
  立即从未来 Capability binding 中移除
  断开连接

Remove
  删除指定 source 的配置
  立即从未来 Capability binding 中移除
  断开连接
  可能暴露同名低优先级配置
```

Remove 确认页必须预告低优先级配置是否会重新生效。Credential 删除是单独选择；删除 project 配置不能影响其他用户，也不能修改其他 scope。

## 七、状态模型

### 7.1 配置状态

```ts
type McpConfigStatus =
  | 'configured'
  | 'pending_approval'
  | 'rejected'
  | 'disabled'
  | 'invalid'
  | 'shadowed';
```

`not_configured` 不属于某个已列出 Server 的状态；空列表由 catalog 表达。

### 7.2 认证状态

```ts
type McpAuthStatus =
  | 'not_required'
  | 'login_required'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'reauth_required'
  | 'revoked'
  | 'error';
```

认证状态使用 `authenticated`，避免与 transport `connected/ready` 混淆。

### 7.3 连接状态

直接复用现有 Core `McpHealthState`：

```ts
type McpHealthState =
  | 'disconnected'
  | 'connecting'
  | 'discovering'
  | 'ready'
  | 'degraded'
  | 'half_open'
  | 'circuit_open'
  | 'quarantined';
```

如果后续确需 `reconnecting`，应作为 health 的正式 Core 状态或 retry metadata，而不是只在 TUI 中猜测。

### 7.4 Control snapshot

```ts
interface McpControlSnapshot {
  revision: string;
  servers: ReadonlyArray<McpServerSnapshot>;
}

interface McpServerSnapshot {
  key: McpServerKey;
  effective: boolean;
  sourcePath: string;
  transport: 'http' | 'stdio';
  configStatus: McpConfigStatus;
  authStatus: McpAuthStatus;
  health: McpHealthState;
  capabilityRevision?: string;
  toolCount: number;
  availableToolCount: number;
  resourceCount: number;
  promptCount: number;
  retryAt?: number;
  diagnostic?: McpDiagnostic;
}
```

Snapshot 和内部数组必须不可变。每次影响 UI 或 Capability 的变化都生成新 revision，保证 React 订阅能够稳定更新。

### 7.5 UI 派生状态优先级

TUI 最终主状态按以下优先级派生：

```text
invalid
→ pending approval / rejected
→ disabled / shadowed
→ login or reauth required
→ authorizing / refreshing
→ connection health
```

UI 必须同时显示文字、符号和颜色。避免依赖 emoji 宽度；状态符号优先使用终端宽度稳定的 `●`、`◐`、`○`、`!`、`x` 和明确文本。

## 八、诊断与脱敏

### 8.1 结构化诊断

```ts
interface McpDiagnostic {
  code:
    | 'auth_required'
    | 'invalid_url'
    | 'command_not_found'
    | 'process_exited'
    | 'connection_timeout'
    | 'http_client_error'
    | 'http_server_error'
    | 'discovery_failed'
    | 'schema_invalid'
    | 'project_approval_required'
    | 'workspace_untrusted'
    | 'config_conflict'
    | 'credential_store_unavailable'
    | 'unknown';
  retryable: boolean;
  occurredAt: string;
  httpStatus?: number;
  processExitCode?: number;
  technicalMessage?: string;
}
```

Core 提供稳定 code 和有限技术字段；TUI 决定标题、颜色、建议动作和展示长度。

### 8.2 脱敏边界

在错误进入 snapshot、Runtime Event、session log 或 `Copy diagnostic` 前统一执行结构化脱敏：

- 删除 Authorization、Cookie、token、client secret 和 env value；
- URL 默认删除 query 和 fragment，仅保留 origin/path；
- command/args 中匹配 credential source 的值替换为 `<redacted>`；
- OAuth callback URL 不进入持久日志；
- 原始 SDK error 只允许进入受控 debug sink，且仍执行 secret-aware redaction。

不得依赖 TUI 最后一层字符串替换作为唯一脱敏措施。

## 九、连接、重载与并发语义

### 9.1 启动

```text
TUI 启动
→ 读取 source-aware config
→ 对 project source 执行 approval gate
→ 立即生成 initial control snapshot
→ 主界面可渲染
→ 后台连接 approved + enabled Server
→ 每次状态变化发布新 snapshot
```

`McpSupervisor.start()` 不应等待所有 Server ready 才返回。required 语义除外，但 required 不得让整个 TUI 无诊断退出。

### 9.2 Retry

- HTTP transient failure 按现有 SDK/backoff 机制处理；
- 401、403、404、invalid config、invalid schema 和用户拒绝不自动重试；
- STDIO 初期只支持用户触发 retry，不无限拉起；
- 手动 retry 清除可清除的连接错误，但不绕过 config/auth/approval gate；
- retry 不重放历史 Tool Call。

### 9.3 配置热重载

每次 reload 使用 generation reconcile：

1. 读取并完整校验新 catalog；
2. 计算 added/removed/changed/unchanged；
3. 对 removed、disabled、changed Server 先发布 unavailable revision，使新 binding fail closed；
4. 停止接受该旧 generation 的新调用；
5. 对已在执行的调用允许按原 invocation policy 结束或取消，绝不自动复制执行；
6. 关闭旧 client；
7. 对新配置重新经过 approval/auth gate，再连接和 discovery；
8. 原子发布新的 Capability 与 control snapshot。

若配置文件在 TUI 编辑期间被外部修改，mutation 返回冲突并要求 reload，不覆盖用户改动。

### 9.4 Tool 策略变化

Tool enable/disable 或 policy 更新必须：

- 生成新的 descriptor/catalog revision；
- 使旧 turn binding 失效；
- 不取消已经越过执行门禁的外部副作用；
- 不把旧审批沿用到新 revision；
- 下一次 model turn 才暴露新的工具集合。

## 十、Tool 策略

TUI 不新增独立安全策略系统，直接映射现有能力模型：

| UI 操作 | Core 语义 |
| --- | --- |
| Enabled | descriptor 可进入有效 catalog，仍需 schema/policy 校验 |
| Disabled | availability/filter 移除，模型不可绑定 |
| Global policy | 不设置 per-tool override |
| Always ask | `minimumApproval: 'user'` |
| Auto review | `minimumApproval: 'auto_review'`，仍受 effect 强制边界约束 |

不持久化 `writes` 作为新的 Core approval enum。若 UI 提供“写操作询问”的快捷预设，它必须展开为现有 effect/approval 配置，并把 `unknown` 视为需要用户审批。

Tool Detail 显示：

- Tool name、description、input/output schema 摘要；
- enabled/disabled 和 schema availability；
- declared effects；
- effective effects；
- annotation trust provenance；
- minimum approval；
- retry policy；
- diagnostics。

项目共享配置只能收紧策略，例如 disable Tool 或提高 minimum approval；降低 approval 或允许 annotation trust 必须来自用户或管理员控制的本地配置。

## 十一、Agent 与认证/失败闭环

### 11.1 Provider 不可用不是能力不存在

Supervisor 维护 Server 级 provider directory。Capability Catalog 可以保留上次已知 descriptor 的 `unavailable` 诊断投影，但 unavailable descriptor 绝不能签发可执行 binding。

当 Server 从未完成 discovery 时，只能告诉 Agent“Provider 已配置但当前不可用”，不能虚构 Tool 名称。可通过以下有限方式进入模型上下文：

- `capability_search` 无结果时附带匹配 provider 的 bounded diagnostic；或
- Runtime context 提供受预算限制的 unavailable provider summary。

具体选择应在 Phase 5 计划中基于 context budget 测试决定，不新增裸 `mcp_invoke` 后门。

### 11.2 OAuth 后不恢复旧 binding

```text
Agent 得知 provider login_required
→ 用户显式发起 Login
→ OAuth 完成
→ reconnect + discovery
→ catalog revision 更新
→ 新 model turn
→ 重新 binding、参数校验、policy 和 approval
```

如果已绑定 Tool 在调用时收到认证过期：

1. 当前调用返回结构化可恢复失败；
2. 对可能已产生副作用的调用不自动重放；
3. 完成登录后进入新 model turn；
4. 只有 `safe_read` 或可信 idempotency policy 允许按现有 Runtime 规则重试。

用户选择 Later 时，Agent 获得明确的 `provider_auth_required` 失败，而不是“能力不存在”。

### 11.3 Required Server

`required` 表示会话任务准入要求，不表示进程必须崩溃退出：

- TUI 始终可以打开并展示诊断；
- required Server 不可用时，新的 Agent run 进入明确的准入提示；
- user/project required 可由用户对当前会话显式 waiver；
- waiver 只对当前会话有效并进入 Runtime 事实；
- 未来 managed/admin policy 可以禁止 waiver，但不在本 RFC 第一阶段实现；
- required 不允许自动重试外部 Tool Call。

## 十二、TUI 交互

### 12.1 路由

```ts
type McpRoute =
  | { name: 'server_list' }
  | { name: 'server_detail'; server: McpServerKey }
  | { name: 'tool_list'; server: McpServerKey }
  | { name: 'tool_detail'; server: McpServerKey; toolName: string }
  | { name: 'resources'; server: McpServerKey }
  | { name: 'prompts'; server: McpServerKey }
  | { name: 'add_server'; draftId: string; step: number }
  | { name: 'auth'; server: McpServerKey }
  | { name: 'approval'; server: McpServerKey }
  | { name: 'error'; server: McpServerKey };
```

Draft 中的 token、secret 和 OAuth material 不进入普通 reducer state；敏感输入应直接交给 Credential Store command，并尽快清理组件内存。

### 12.2 最小快捷键

```text
Server List
  Enter 详情    a 添加    e 启停    r 重试
  l 登录        d 删除    / 搜索    Esc 关闭

Detail
  t Tools       o Resources       p Prompts
  l Login/Logout                  Esc 返回

Tool List
  Space 启停    Enter 详情        / 搜索
```

所有破坏性或持久修改操作必须有确认页。不可用动作应隐藏或明确 disabled，不允许按键静默失败。

### 12.3 Slash Commands

第一阶段只保留：

```text
/mcp
/mcp <server>
/mcp retry <server>
```

配置写操作完成后再开放：

```text
/mcp add
/mcp enable|disable <server>
/mcp remove <server>
/mcp approve|reject <server>
/mcp login|logout <server>
/mcp reload
```

Slash command 只导航到相应 route 或触发非破坏性 retry；add/remove/logout/reject 等仍进入确认或 Wizard，不因命令文本跳过交互门禁。

## 十三、实施阶段

### Phase 0：项目 Server 执行门禁（P0）

范围：

- 配置加载保留最小 source provenance；
- 所有 project/project_legacy Server 默认 pending approval；
- 本地 approval store 与稳定 config digest；
- 未批准前不创建 transport；
- 批准、拒绝、配置变化失效的 Core 测试；
- 最小 TUI 审批提示，可以暂不实现完整管理中心。

退出标准：

```text
打开包含恶意 stdio .mcp.json 的未批准仓库时，fixture 能证明目标进程从未启动。
```

该安全门禁不使用可关闭 feature flag；回滚不得恢复项目 Server 自动执行。

### Phase 1：可观察 Supervisor 与只读管理页（P0）

范围：

- `McpSupervisor`、不可变 control snapshot 和 subscription；
- 单 Server retry/disconnect；
- 完整复用现有 `McpHealthState`；
- 结构化 diagnostic 与 source-level redaction；
- Server List、Detail、Tools/Resources/Prompts 只读页；
- 删除 `McpPanel` 对内部 Map 的直接读取；
- list_changed、retry、circuit state 的 reducer/component 测试。

退出标准：

```text
用户可以实时、准确地知道每个 Server 的来源、审批、连接、能力数量和不可用原因。
```

### Phase 2：配置管理与三层 scope（P1）

范围：

- 完整 `McpConfigRepository`；
- local/project/user source 和明确 precedence；
- legacy project source 兼容及迁移预览；
- enable/disable/add/remove；
- JSONC 原子写、并发冲突和文件变更 reload；
- HTTP/STDIO Add Wizard 与安全预览；
- remove 后低优先级配置重新生效提示。

退出标准：

```text
用户不手改 JSON 即可完成非 OAuth MCP 配置，且不会覆盖外部或无关配置变更。
```

### Phase 3：认证与 Credential Store（P1）

范围：

- Credential Store backend 和环境变量 fallback；
- HTTP OAuth login/logout/refresh/revoke；
- Bearer/API key 的 secret reference；
- auth snapshot、callback cancel/timeout、浏览器失败时复制 URL；
- 登录成功后 reconnect/discovery；
- secret leakage 测试。

退出标准：

```text
用户可在 TUI 完成远程 HTTP MCP 登录，credential 不进入普通配置、事件、日志或诊断。
```

### Phase 4：Tool 策略（P1/P2）

范围：

- Tool enable/disable；
- existing `minimumApproval`、effect 和 retry policy 编辑；
- Tool 搜索、schema/diagnostic 详情；
- declared/effective effect 与 trust provenance 展示；
- policy 变化导致 catalog revision 和旧 binding 失效。

退出标准：

```text
TUI 中启用的可用 Tool 与 Agent 下一 turn 实际收到的 binding 完全一致。
```

### Phase 5：Agent 不可用原因与恢复闭环（P2）

范围：

- provider directory 与 unavailable provider summary；
- `capability_search`/Runtime context 的不可用诊断；
- auth required、provider failed 和 required admission 的任务级事件；
- OAuth 后新 turn 重新 binding；
- 不自动重放未知副作用调用；
- required session waiver。

退出标准：

```text
Agent 能区分能力不存在、等待审批、需要登录、连接失败和 schema quarantine；恢复后使用新 binding 继续，而非复用旧调用。
```

## 十四、代码映射

### 新增候选

```text
src/core/config/mcp-repository.ts
src/core/config/mcp-project-approvals.ts
src/core/mcp/supervisor.ts
src/core/mcp/auth-coordinator.ts
src/core/mcp/credential-store.ts
src/core/mcp/diagnostics.ts
src/app/tui/mcp/*
```

### 修改候选

| 文件/目录 | 修改 |
| --- | --- |
| `src/core/mcp/types.ts` | source-neutral config/auth/control snapshot 类型，不加入 TUI 字段 |
| `src/core/mcp/manager.ts` | 单 Server 生命周期、订阅钩子、typed diagnostic；保持唯一 SDK client |
| `src/core/config/index.ts` | 将 MCP 加载委托给 repository，保留现有公共入口迁移层 |
| `src/core/config/paths.ts` | local scope、approval store 路径 |
| `src/core/capabilities/catalog.ts` | 必要时支持 unavailable diagnostic descriptor，仍禁止 binding |
| `src/core/controllers/tool-controller.ts` | Phase 5 provider unavailable/binding failure 语义 |
| `src/app/tui/hooks/useMcpConnection.ts` | 替换为 Supervisor 生命周期与 subscription |
| `src/app/tui/components/McpPanel.tsx` | Phase 1 被路由化 overlay 替换 |
| `src/app/tui/hooks/useSlashCommand.ts` | 结构化 MCP action 与参数校验 |
| `src/app/tui/App.tsx` | 接入 controller/snapshot/overlay |

实施计划必须按阶段缩小文件范围，不能一次创建全部候选文件。

## 十五、测试与验收

### 15.1 单元测试

- raw source 解析、scope、precedence、shadow 和 legacy 兼容；
- canonical workspace key 与 config digest 稳定性；
- command/args/URL/env/header 引用变化使批准失效；
- secret 值不进入 approval record；
- project config 不能降低 minimum approval 或授予 annotation trust；
- typed diagnostic 分类与脱敏；
- auth state reducer、PKCE state、callback timeout/cancel；
- add/update/remove 的 JSONC preservation、atomic write 和 conflict；
- control snapshot immutability 与 revision。

### 15.2 MCP integration

- 未批准 STDIO fixture 绝不启动；
- 批准后启动，config 变化后再次阻止；
- HTTP transient retry 和不可重试 401/403/404；
- STDIO exit 后手动 retry；
- list_changed 更新 Tool/Resource/Prompt 和 snapshot revision；
- disable/remove/reconfigure 使旧 binding fail closed；
- OAuth fake provider 的 login、refresh、logout、revoked；
- 认证过期的写调用不自动重放。

### 15.3 TUI 测试

- reducer route、selection、search、confirm 和 Esc 返回层级；
- narrow terminal、resize、长名称、宽字符和无颜色模式；
- snapshot 更新触发状态、计数和错误详情重渲染；
- 不依赖 emoji 宽度；
- unavailable action 不触发 mutation；
- remove 显示被遮蔽配置将重新生效；
- OAuth cancel 后输入焦点和 terminal 状态恢复。

### 15.4 System/E2E

- 从未信任 workspace 打开到 approve/connect/discover 的完整 PTY 场景；
- Add HTTP/STDIO、disable、reload、remove；
- 外部修改 JSONC 时 TUI mutation 返回冲突且不覆盖；
- login required → 用户登录 → 新 model turn → 新 binding；
- provider failed 时 Agent 得到真实原因；
- required Server 不可用时 TUI 可进入、Agent run 被明确拦截；
- session log、Runtime Store、diagnostic 和配置文件的 credential 扫描全部为空。

### 15.5 每阶段最低验证

每个实施计划除相关定向测试外，至少运行：

```bash
bun run typecheck
bun run check:core-boundary
bun run check:docs-impact
bun run check:docs
```

提交前必须按仓库规则执行 `document-before-commit` Skill。具体 test 文件由各阶段计划根据代码范围列出，不在 RFC 中假装一次性全部通过。

## 十六、文档与 ADR 影响

实施时至少评估并更新：

- `docs/active/mcp-runtime-governance.md`：approval gate、auth、health 与 binding 语义；
- 新增 `docs/active/mcp-project-approval.md`：项目配置执行门禁和 digest；
- 新增或更新 TUI active 规则：overlay route、键盘和 snapshot 边界；
- `docs/book/08-TUI交互全景.md`：MCP 管理中心交互；
- `docs/book/09-CLI模式与配置.md`：scope、precedence、mutation 和 credential；
- `docs/book/11-MCP与Skills扩展.md`：Supervisor、auth 和 unavailable provider；
- `README.md`：用户可见配置与命令；
- `docs/documentation-map.json`：覆盖新增 config/auth/supervisor/TUI 文件；
- ADR：source precedence、项目审批存储、control-plane 与 Runtime event 边界属于架构决策，实施前新增 ADR，不改写 ADR-0007。

Phase 0 改变当前项目 MCP 自动启动行为，必须与实现同批更新 active 文档，不得只提交安全代码或只提交设计文档。

## 十七、迁移与回滚

### 17.1 迁移

1. Phase 0 首次运行时，现有 project/project_legacy Server 进入 pending approval；
2. user source Server 保持原有效行为，但继续受现有 Runtime policy；
3. legacy project source 不自动改写，TUI 只提供显式迁移；
4. 新 `enabled`、scope 和 auth 字段必须保持旧配置可解析；
5. Capability stable identity 继续使用 `mcp:<effective-server>/<tool>`，如 scope collision 需要改变 identity，必须新增 ADR 和迁移测试；
6. OAuth 上线前，现有环境变量 header 认证继续工作。

### 17.2 回滚

- 可以回滚路由化管理 UI，恢复只读 UI；
- 可以关闭配置 mutation、OAuth 或 Tool policy 的入口；
- 可以回滚 unavailable provider 的模型提示；
- 不得回滚项目 MCP 审批门禁；
- 不得回滚 revisioned binding、effect/approval policy 或 invocation governance；
- 回滚不得重新启用旧 binding 或自动重放外部调用。

## 十八、风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 配置来源迁移改变 precedence | 连接到错误 Server | source catalog、shadow UI、legacy fixture、显式迁移 |
| TUI 与 Capability Catalog 漂移 | 用户看到 Ready 但 Agent 不可调用 | 单一 Supervisor snapshot + catalog revision 验收 |
| OAuth token 泄漏 | 账户安全事件 | Credential Store、source redaction、泄漏扫描 |
| 配置热重载竞态 | 旧配置继续执行或重复副作用 | generation、先失效 binding、禁止隐式 replay |
| 项目配置自我放权 | 仓库绕过审批 | 执行批准与 annotation trust 分离，project 只能收紧 |
| Manager/Supervisor 双生命周期 | 双连接与状态漂移 | Manager 保持唯一 SDK client，Supervisor 只编排 |
| 过大的 P0 | 长期无法交付 | Phase 0–5 独立退出标准，逐阶段计划与完成记录 |
| TUI 路由影响终端稳定性 | 闪烁、焦点丢失、宽字符错位 | 复用现有 overlay 规则并增加 PTY/resize 测试 |

## 十九、明确拒绝的替代方案

### 19.1 直接扩展 `McpPanel`

拒绝。现有组件直接读取 Manager 可变 Map，没有订阅、命令边界、配置 provenance 或认证状态。继续堆叠表单会把业务生命周期放进渲染层。

### 19.2 用一个综合 status enum 表达所有状态

拒绝。配置、认证和连接状态可独立变化；综合 enum 会产生组合爆炸并丢失 circuit/quarantine 语义。UI 可以派生主状态，但 Core 必须保留正交事实。

### 19.3 把所有 `mcp.*` 事件加入 Runtime Event

拒绝。配置编辑和后台连接是应用 control plane，不属于某个任务的持久事实。只有影响当前任务决策和恢复的 provider/binding/auth 事实进入 Runtime。

### 19.4 登录后继续原 Tool Call

拒绝。OAuth 和 discovery 会改变 catalog revision；旧 binding、参数审批和 execution intent 不能自动沿用。必须进入新 model turn 重新签发。

### 19.5 把 token 写入 JSONC

拒绝。即使文件 mode 为 `0600`，普通配置仍可能进入备份、日志、复制和项目文件。生产模式只保存 credential reference。

### 19.6 让 `required` Server 失败时直接退出 TUI

拒绝。用户必须能进入诊断和修复界面。required 应阻止受影响的 Agent run，而不是消灭修复入口。

## 二十、外部参考

- [Claude Code：Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp)
- [OpenAI Codex：MCP 配置 Schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)
- [Model Context Protocol：Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## 二十一、批准条件

本文进入 `approved` 并转化为实施计划前，必须明确确认以下决策：

1. 接受 Phase 0 项目 MCP 本地审批为不可关闭的安全行为；
2. 接受 target scope precedence 为 `local > project > user`；
3. 接受 legacy project source 的显式迁移而非静默改写；
4. 接受 project approval 与 annotation trust 完全分离；
5. 接受 OAuth 后新 turn 重新 binding、禁止自动恢复旧 Tool Call；
6. 接受 Credential Store 不可用时 fail closed；
7. 接受 control-plane snapshot 与任务 Runtime Event 分层；
8. 为上述架构决策新增 ADR，并在每个阶段建立独立 plan、验证和完成记录。

满足批准条件后，第一份实施计划只覆盖 Phase 0，不得顺带实现 OAuth、完整 Add Wizard 或 Tool policy。
