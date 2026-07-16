# MCP TUI 管理中心完整实施计划

状态：superseded（Phase 0–2 为历史完成事实）
优先级：P0–P2
创建日期：2026-07-15
代码基线：`mcp` / `41585a14dcf3`
来源：[`../../design/2026-07-15-mcp-tui-management-center-rfc.md`](../../design/2026-07-15-mcp-tui-management-center-rfc.md)
首个子计划：[`2026-07-15-mcp-project-server-approval-p0.md`](2026-07-15-mcp-project-server-approval-p0.md)
依赖：ADR-0007、ADR-0008、ADR-0009、MCP Runtime Governance、Capability Progressive Disclosure
分类：Security + Capability + Policy + Lifecycle + TUI

> 2026-07-16 产品方向纠偏已完成：`/mcp` 已从配置管理中心收敛为只读连接列表。Phase 0–2 已完成实现保留为历史事实，后续 UI 结论以 [`2026-07-16-mcp-tui-readonly-list.md`](2026-07-16-mcp-tui-readonly-list.md) 和 ADR-0012 为准；本计划不再作为 OAuth、Tool Policy 或 Provider Action TUI 路由的实施依据。

## 一、计划结论

本计划覆盖 MCP TUI 管理中心从安全基线到 Agent 恢复闭环的完整实施，不把全部功能压成一次大改。执行顺序固定为：

```text
Phase 0  项目 Server 审批门禁
  ↓
Phase 1  McpSupervisor + 响应式只读管理页
  ↓
Phase 2  三层配置、热重载、增删启停
  ↓
Phase 3  Credential Store + HTTP OAuth
  ↓
Phase 4  Tool 可见性与既有 Policy 编辑
  ↓
Phase 5  Agent 不可用原因、Provider Action、Required 准入
```

每个 Phase 都必须满足自己的退出标准、文档门禁和回滚条件后，下一阶段才可开始。完整产品验收流程为：

```text
打开 /mcp
→ 查看全部有效和被遮蔽 Server
→ 审批项目配置
→ 用 name + URL 添加 local HTTP Server，或用 JSONC 配置高级 Server
→ 保存 credential reference 或完成 OAuth
→ 后台连接与动态 discovery
→ 查看并配置 Tool
→ Agent 获得与 UI 一致的新 binding
→ 连接或认证失败时获得真实原因
→ 用户修复后进入新 model turn 继续任务
```

## 二、总体交付范围

### 2.1 用户能力

- `/mcp` Server List 与 Detail；
- Tools、Resources、Prompts 浏览；
- Local、Project、User 三层配置；
- 项目 Server 审批和 config digest 失效；
- name + URL 的 local HTTP Add Wizard；
- Enable、Disable、Retry、Reload、Remove；
- HTTP OAuth Login、Logout、Refresh、Revoke；
- Bearer/API key 安全录入和 credential reference；
- Tool enable/disable、effect、minimum approval、retry policy 管理；
- required Server 任务准入；
- Agent 区分 pending approval、login required、failed、quarantined 和不存在；
- 认证恢复后新 turn 重新 binding，无需用户重新描述原任务。

### 2.2 工程能力

- source-aware `McpConfigRepository`；
- `ProjectApprovalStore`；
- 单一 SDK client 路径上的 `McpSupervisor`；
- 不可变 `McpControlSnapshot` 与订阅；
- typed、redacted diagnostic；
- generation-based config reconcile；
- `McpCredentialStore` 与 `McpAuthCoordinator`；
- Core-neutral `McpRuntimeProvider`；
- provider directory 与 unavailable provider search projection；
- 可恢复的 `awaiting_provider_action` Runtime interaction；
- unit、integration、replay/golden、component 和 PTY 测试。

### 2.3 不纳入本计划

- MCP Marketplace；
- 远程 Server 自动发现；
- 多账号同时在线和快速切换；
- Device Code；
- 实时 Server 日志浏览；
- 任意 Tool JSON Schema 可视化编辑器；
- managed/admin MCP 分发系统；
- 通用外部写自动重放；
- SSE 新配置入口；
- 第二个 MCP SDK 或第二条 client 连接。

## 三、全局架构与依赖方向

```text
McpConfigRepository ────── ProjectApprovalStore
        │                          │
        ├──── McpConfigCatalog ────┘
        │
McpCredentialStore ── McpAuthCoordinator
        │                    │
        └─────────┬──────────┘
                  ▼
            McpSupervisor
       config gate / generation / retry
                  │
          唯一 McpManager/SDK 路径
                  │
      ┌───────────┴────────────┐
      ▼                        ▼
McpRuntimeProvider       McpControlSnapshot
      │                        │
Runtime binding/policy      App Controller
      │                        │
Agent execution            TUI reducer/view
```

依赖规则：

1. `app/tui` 可以依赖 Core controller contract；
2. `core/mcp` 可以依赖 `core/config` 的中立配置结果，但不依赖 TUI；
3. Runtime 只依赖 `McpRuntimeProvider`，不依赖 TUI controller；
4. Config Repository 不创建 MCP transport；
5. Auth Coordinator 不直接签发 Runtime binding；
6. Supervisor 不持久化任务状态；
7. TUI 不直接读写 `McpManager` 内部 Map；
8. Runtime Tool 调用继续只经过现有 binding、schema、policy、approval、invocation 和 verification gateway。

## 四、跨阶段不变量

### 4.1 安全

1. 未批准项目 Server 不创建 transport；
2. 项目启动批准不等于 annotation trust；
3. Credential 明文不进入普通配置、Runtime Event、session log 或诊断；
4. disable/remove/reconfigure 先使未来 binding 失效，再关闭旧 client；
5. Tool policy 变化产生新 descriptor/catalog revision；
6. OAuth 完成后重新 discovery，在新 model turn 签发 binding；
7. 认证恢复不自动重放旧 Tool Call；
8. unavailable/quarantined capability 不可绑定；
9. 项目共享配置只能收紧安全策略；
10. feature flag 关闭时 fail closed，不恢复旧执行路径。

### 4.2 状态

| 状态 | 权威 |
| --- | --- |
| source、scope、enabled、required、shadow | Config Repository |
| project approved/rejected | ProjectApprovalStore |
| token、client info、discovery state | Credential Store |
| OAuth flow、callback、auth status | Auth Coordinator |
| health、retry、generation、capability counts | Supervisor/Manager |
| capability revision 与 binding | Capability Catalog/Runtime |
| overlay route、selection、draft、confirm | TUI reducer |
| provider action 与 session waiver | Runtime Event/State |

### 4.3 兼容

- 现有 user MCP 配置在 Phase 0 保持行为；
- legacy project `.kite-code/kite-code.jsonc#mcpServers` 在 Phase 2 前不静默迁移；
- `.mcp.json` 保持共享项目格式；
- `mcp:<server>/<tool>` 稳定身份在有效 Server 唯一时保持；
- effective Server source/config 变化必须进入 provider generation，使 descriptor revision 改变；
- 环境变量 header 认证在 OAuth 上线后继续工作；
- Runtime feature flag 不得重新启用旧 MCP adapter。

## 五、阶段依赖和发布门

| Phase | 优先级 | 前置 | 是否改变安全行为 | 是否需要 ADR | 是否需要 Runtime flag |
| --- | --- | --- | --- | --- | --- |
| 0 项目审批 | P0 | RFC 决策确认 | 是，且不可回滚 | 是 | 否 |
| 1 Supervisor/只读 UI | P0 | Phase 0 | 否 | control-plane 边界写入 Phase 0 ADR 或补充 ADR | 否 |
| 2 配置管理 | P1 | Phase 1 | 是，scope/precedence | 是 | 否，mutation 可按入口逐步开放 |
| 3 Auth | P1 | Phase 2 | 是，credential/OAuth | 是 | App 能力检测；Runtime 尚不加 flag |
| 4 Tool 策略 | P1/P2 | Phase 2，可与 Phase 3 后半并行 | 是，模型可见能力变化 | 更新 policy ADR/active | 否，沿用 catalog flag |
| 5 Agent 闭环 | P2 | Phase 1、3、4 | 是，Runtime lifecycle | 是 | `mcpProviderActionV1` 默认 false |

Phase 3 的 Credential Store backend 必须先完成兼容性 spike；在安全 backend 未达标前，OAuth 阶段保持 blocked，而不是降级为明文文件。

## 六、Phase 0：项目 Server 审批门禁

详细实施以子计划为准：

- [`2026-07-15-mcp-project-server-approval-p0.md`](2026-07-15-mcp-project-server-approval-p0.md)

### 6.1 阶段产出

- 最小 source-aware 配置目录；
- canonical workspace key；
- domain-separated config digest；
- `~/.kite-code/mcp-project-approvals.jsonc`；
- project/project_legacy transport 前置门禁；
- 项目配置保守 Tool policy；
- `/mcp` 最小批准/拒绝入口；
- stdio marker、HTTP request count 和 PTY 安全测试。

### 6.2 阶段退出标准

```text
未批准项目配置无法产生任何 transport 副作用；
批准只允许启动，不授予 annotation trust 或低风险重试；
配置变化后重新 pending；
用户 Server 回归不变。
```

## 七、Phase 1：McpSupervisor 与响应式只读管理页

完成日期：2026-07-15

实现证据：`src/core/mcp/supervisor.ts`、`src/core/mcp/control-types.ts`、`src/core/mcp/diagnostics.ts`、`src/app/tui/mcp/`、`tests/mcp-supervisor.test.ts`、`tests/tui-system/scenarios/mcp-management-readonly.test.ts`。当前行为以 `docs/active/mcp-control-plane.md` 为准。

### 7.1 目标

用不可变、可订阅的 Core control snapshot 取代 TUI 对 Manager 内部 Map 的直接读取，补齐单 Server 生命周期、typed diagnostic 和完整只读界面。

### 7.2 Core 类型

新增或收敛到 `src/core/mcp/control-types.ts`：

```ts
interface McpControlSnapshot {
  revision: string;
  generation: number;
  servers: readonly McpServerControlState[];
}

interface McpServerControlState {
  key: McpServerKey;
  effective: boolean;
  configStatus: McpConfigStatus;
  authStatus: McpAuthStatus;
  health: McpHealthState;
  transport: 'http' | 'stdio';
  source: McpConfigSource;
  capabilityRevision?: string;
  toolCount: number;
  availableToolCount: number;
  resourceCount: number;
  promptCount: number;
  retryAt?: number;
  lastAttemptAt?: string;
  diagnostic?: McpDiagnostic;
}
```

状态数组和嵌套对象不可变；revision 对稳定规范化字段计算，避免每个 React render 产生伪变化。

### 7.3 Manager 生命周期重构

修改 `src/core/mcp/manager.ts`：

1. 增加单 Server `disconnect(name)`；
2. 增加 `reconnect(name, config, generation)`；
3. 连接状态变化时通知订阅者；
4. 为每个连接保存 generation token；
5. late connect/list notification 只有 generation 匹配时才能更新 state；
6. reconnect 前关闭旧 client，并清理 prompt registry；
7. disabled/removed Server 立即从 Capability Snapshot 移除；
8. 保留 `disconnectAll()`；
9. `getServerStates()` 标记为内部/迁移 API，生产 TUI 不再调用；
10. 测试不得通过修改返回 Map 注入状态，改用 fixture/helper。

### 7.4 Supervisor

新增 `src/core/mcp/supervisor.ts`：

```ts
interface McpSupervisor {
  start(workspace: string): Promise<void>;
  stop(): Promise<void>;
  reload(): Promise<void>;
  retry(key: McpServerKey): Promise<void>;
  getSnapshot(): McpControlSnapshot;
  subscribe(listener: () => void): () => void;
  getRuntimeProvider(): McpRuntimeProvider;
}
```

实现顺序：

1. 加载 Phase 0 Config Catalog；
2. 立即发布 configured/pending/disabled 初始 snapshot；
3. 后台连接 connectable Server，不阻塞 TUI mount；
4. Manager 状态变化投影为新 snapshot；
5. list_changed 更新计数和 capability revision；
6. retry 重新经过 config/approval gate；
7. stop 取消订阅并关闭全部 client；
8. 重复 start/stop 必须幂等；
9. 单 Server 失败不拒绝整个 `start()`。

### 7.5 Typed diagnostics

新增 `src/core/mcp/diagnostics.ts`，从 SDK/Node 错误映射：

- auth required；
- URL invalid；
- command not found；
- process exited；
- connect/discovery timeout；
- HTTP 4xx/5xx；
- discovery failed；
- invalid schema；
- approval required/rejected；
- circuit open；
- config conflict；
- unknown。

Core diagnostic 只包含 code、retryable、technical fields 和脱敏 message；展示标题、建议操作和截断属于 App。

### 7.6 TUI 重构

新增：

```text
src/app/tui/mcp/
├── McpOverlay.tsx
├── McpServerList.tsx
├── McpServerDetail.tsx
├── McpToolList.tsx
├── McpResourceList.tsx
├── McpPromptList.tsx
├── McpErrorView.tsx
├── controller.ts
├── reducer.ts
└── types.ts
```

实现：

1. `useMcpConnection` 替换为 `useMcpController`；
2. 使用 `useSyncExternalStore` 或等价稳定订阅消费 snapshot；
3. `AppProps` 不再接收 `McpManager`，改接收纯 ViewModel/controller commands；
4. route 覆盖 list/detail/tools/resources/prompts/error/approval；
5. list 按 effective、status、name 稳定排序；
6. 搜索和 selection 只在 TUI reducer；
7. 不依赖 emoji 宽度；
8. Esc 逐层返回，最后关闭 overlay；
9. `r` 只对 retryable Server 生效；
10. Phase 0 临时审批 UI 合并到 route，不保留双入口。

Slash command：

```text
/mcp
/mcp <server>
/mcp retry <server>
```

### 7.7 Phase 1 文件范围

- 新增 `src/core/mcp/control-types.ts`
- 新增 `src/core/mcp/supervisor.ts`
- 新增 `src/core/mcp/diagnostics.ts`
- 修改 `src/core/mcp/manager.ts`
- 修改 `src/core/mcp/types.ts`、`index.ts`
- 修改 `src/app/tui/hooks/useMcpConnection.ts`，完成后重命名/删除
- 新增 `src/app/tui/mcp/*`
- 修改 `src/app/tui/App.tsx`、`index.tsx`、reducers/actions/types
- 修改 `src/app/tui/session-manager.ts`、`run-agent.ts`
- 新增 `tests/mcp-supervisor.test.ts`
- 修改 `tests/mcp-manager.test.ts`
- 新增 MCP overlay component/reducer tests
- 新增 `tests/tui-system/scenarios/mcp-management-readonly.test.ts`

### 7.8 Phase 1 验证

```bash
bun test tests/mcp-manager.test.ts tests/mcp-supervisor.test.ts
bun test tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/tui-slash-command.test.ts
bun test --parallel=1 --max-concurrency=1 tests/tui-system/scenarios/mcp-management-readonly.test.ts
bun run typecheck
bun run check:core-boundary
```

退出标准：任何 Manager health/list change/retry 变化都通过 snapshot 驱动 TUI；TUI 不再调用 `getServerStates()`。

## 八、Phase 2：三层配置、热重载与增删启停

### 8.1 目标配置模型

| Scope | 存储 | 共享 | 优先级 |
| --- | --- | --- | --- |
| local | `~/.kite-code/projects/<workspaceKey>/mcp.jsonc` | 否 | 1 |
| project | `<workspace>/.mcp.json` | 是 | 2 |
| user | `~/.kite-code/kite-code.jsonc#mcpServers` | 否 | 3 |

legacy `<workspace>/.kite-code/kite-code.jsonc#mcpServers` 作为 `project_legacy` 保持兼容读取，优先级在迁移前保持现状，不接受新 TUI 写入。

### 8.2 Config Repository

将 Phase 0 `mcp-config.ts` 演进为：

```ts
interface McpConfigRepository {
  load(workspace: string): Promise<McpConfigCatalog>;
  mutate(command: McpConfigCommand): Promise<McpConfigCatalog>;
  watch(workspace: string, listener: () => void): () => void;
}

type McpConfigCommand =
  | { type: 'add'; scope: McpWritableScope; name: string; config: McpServerConfigInput }
  | { type: 'update'; key: McpServerKey; expectedRevision: string; patch: McpConfigPatch }
  | { type: 'remove'; key: McpServerKey; expectedRevision: string }
  | { type: 'set_enabled'; key: McpServerKey; expectedRevision: string; enabled: boolean }
  | { type: 'migrate_legacy'; key: McpServerKey; target: 'project' };
```

要求：

1. 每次 mutation 带 expected revision；
2. 重新读取文件后才修改；
3. 使用 `jsonc-parser` 保留无关配置和注释；
4. 临时文件与目标同目录；
5. flush、mode、rename 原子替换；
6. 外部修改产生 `config_conflict`，不覆盖；
7. 文件 watcher 只触发 reload，不直接信任 event payload；
8. debounce 后完整重读全部 source；
9. watcher 不可用时 `/mcp reload` 仍可工作；
10. legacy 迁移必须展示 diff 并显式确认。

### 8.3 Schema 扩展

在 `McpServerConfig` 和 Zod schema 增加：

```ts
interface McpServerConfig {
  enabled?: boolean;
  required?: boolean;
  cwd?: string;
  // Phase 3
  auth?: McpAuthConfig;
  // Phase 4
  enabledTools?: string[];
  disabledTools?: string[];
}
```

Phase 2 只启用 `enabled`、`required`、`cwd`。后续字段先进入 schema 设计，不提前开放 UI。

### 8.4 Server stable identity 与 generation

内部 key 使用 scope/source/name；模型暴露名继续使用 effective name。每次 effective source、transport、command、URL 或 auth/policy 变化：

1. 生成新的 provider config digest；
2. 写入 descriptor `provider.version` 或等价 revision 输入；
3. Capability descriptor revision 必须变化；
4. 当前 turn 旧 binding fail closed；
5. 不因为 Tool schema 相同而复用旧 Server binding。

### 8.5 Supervisor reconcile

```text
新 catalog
→ diff added/removed/changed/unchanged
→ changed/removed/disabled 先标 unavailable 并发布新 catalog revision
→ 阻止旧 generation 新调用
→ 允许已登记 invocation 按原 policy 结束或取消
→ close old client
→ approval/auth gate
→ connect new generation
→ discovery
→ 原子发布 capability/control snapshot
```

不自动重放正在执行或结果未知的外部写。

### 8.6 Add Wizard

2026-07-16 根据 Phase 2 实际 TUI 使用反馈校正交互。参考 [Claude Code MCP](https://code.claude.com/docs/en/mcp) 与 [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp) 的分层方式：`/mcp` 聚焦状态、诊断与认证，常规新增只收集建立连接所需的最小信息；高级字段留在配置文件，不逐项阻塞 Wizard。

HTTP：

1. name；
2. URL；
3. 安全预览并保存到当前 workspace 的 local scope。

TUI Add 不提供 transport 或 scope 选择。stdio command/args、project/user scope、`cwd`、env/header、timeout、required 等字段继续由 schema、Repository、watch/reconcile 和详情展示支持，但只通过高级 JSONC 配置。HTTP OAuth 不作为新增配置字段；Phase 3 应在 URL 保存并收到认证需求后，从 `/mcp` 状态页启动登录。静态 header/env reference 同样属于高级 JSONC 配置。已有 project 配置仍须独立审批。

Server name 使用稳定可验证规则，禁止与内置 slash command 或暴露 tool name 产生不可解析冲突。

### 8.7 Enable/Disable/Remove

- Enable：写配置后重新经过 project approval/auth gate；
- Disable：立即撤销未来 binding、关闭 client，保留 credential；
- Remove：删除指定 source，预览低优先级配置是否重新生效；
- Remove credential 不在 Phase 2 执行，只记录 Phase 3 可选动作；
- project remove 只修改 `.mcp.json`，不操作其他用户凭证。

Slash command：

```text
/mcp add
/mcp enable <server>
/mcp disable <server>
/mcp remove <server>
/mcp approve <server>
/mcp reject <server>
/mcp reload
```

破坏性命令只导航到确认页，不跳过确认。

### 8.8 Phase 2 文件范围

- 重构 `src/core/config/mcp-config.ts` 为 repository
- 新增 `src/core/config/mcp-mutations.ts` 或同模块内 typed commands
- 修改 `src/core/config/index.ts`、`paths.ts`、schema
- 修改 `src/core/mcp/supervisor.ts`、`manager.ts`、descriptor revision
- 新增 `src/app/tui/mcp/McpAddWizard.tsx`
- 新增 `McpConfirmDialog.tsx`、配置 source/shadow view
- 修改 slash parser/suggestions/help
- 新增 `tests/mcp-config-repository.test.ts`
- 新增 `tests/mcp-config-reconcile.test.ts`
- 新增 `tests/tui-system/scenarios/mcp-config-management.test.ts`

### 8.9 Phase 2 验证

- 三 scope precedence 与 shadow；
- remove 后低优先级重新生效；
- JSONC comment preservation；
- mutation conflict；
- watcher/reload；
- changed generation 使 binding 失效；
- project 配置不自批；
- disable 不删除 credential placeholder；
- Add Wizard 只询问 name 与 HTTP URL，并固定写入 local scope；
- stdio、其他 scope、cwd、env/header、timeout、required 不进入 TUI 添加流程；
- narrow terminal Wizard；
- 高级 JSONC 仍覆盖 Windows path/cwd。

退出标准：用户只需 name 与 URL 即可在 TUI 添加当前 workspace 的 local HTTP MCP；外部配置修改不会被覆盖，热重载不会复用旧 binding。stdio、其他 scope 与高级字段不扩大 TUI 基本流程。

## 九、Phase 3：Credential Store 与 HTTP OAuth

### 9.1 Credential Store 前置 spike

当前仓库没有 credential backend 依赖。先建立 `docs/space/plans/` 内的短 spike 记录或在本 Phase 第一任务完成以下验证：

1. Bun 在 macOS、Windows、Linux 的安全存储 backend 可构建、安装、读写、删除；
2. secret 不出现在 argv、stdout/stderr 或 crash log；
3. backend 支持 CI 注入 fake implementation；
4. 打包尺寸、native ABI 和发布流程可接受；
5. backend 不可用时返回明确错误；
6. 禁止以普通 JSON 明文作为 fallback。

若没有跨平台 backend 达标，Phase 3 状态改为 blocked；Phase 0–2 继续可交付，认证只允许环境变量引用。

### 9.2 Credential contract

```ts
interface McpCredentialStore {
  get(key: McpCredentialKey): Promise<McpCredentialMaterial | null>;
  put(key: McpCredentialKey, value: McpCredentialMaterial): Promise<void>;
  delete(key: McpCredentialKey): Promise<void>;
  status(): Promise<'available' | 'locked' | 'unavailable'>;
}
```

Credential key 包含 workspace/scope/server/auth profile，不使用 URL 作为唯一 key。material 包含：

- bearer/API key；
- OAuth tokens；
- client information；
- PKCE verifier；
- discovery state；
- token expiry metadata。

Control snapshot 只暴露 credential 是否存在、类型和账户显示信息，不暴露 material。

### 9.3 Auth config

普通配置只保存引用：

```ts
type McpAuthConfig =
  | { type: 'none' }
  | { type: 'environment'; header: string; env: string; scheme?: string }
  | { type: 'credential'; header: string; credentialRef: string; scheme?: string }
  | {
      type: 'oauth';
      credentialRef: string;
      scopes?: string[];
      clientId?: string;
      clientSecretRef?: string;
      callbackPort?: number;
      metadataUrl?: string;
    };
```

project scope 只能提交 env/reference 名称和 OAuth metadata，不能提交 secret。client secret 必须进入 Credential Store。

### 9.4 SDK OAuth provider

安装的 `@modelcontextprotocol/sdk@1.29.0` 已提供 `OAuthClientProvider`、`auth()`、`UnauthorizedError` 和 `StreamableHTTPClientTransport.finishAuth()`。实现：

```ts
class KiteMcpOAuthProvider implements OAuthClientProvider {
  // redirectUrl/clientMetadata/state/clientInformation/tokens/saveTokens
  // redirectToAuthorization/saveCodeVerifier/codeVerifier
  // invalidateCredentials/saveDiscoveryState/discoveryState
}
```

约束：

1. 每个 Server/Auth session 隔离 token、state 和 verifier；
2. callback 仅绑定 `127.0.0.1`/`::1`；
3. state 使用高熵随机值并 constant-time 比较；
4. PKCE verifier 不进入普通日志；
5. callback timeout/cancel 后关闭 listener；
6. background connect 检测 auth required 时不自动打开浏览器；
7. 用户按 Login 后才调用 `redirectToAuthorization`/open browser；
8. callback 获得 code 后调用 `finishAuth()`；
9. 成功后 reconnect/discovery；
10. refresh 失败转 `reauth_required`，不循环打开浏览器。

### 9.5 Auth Coordinator

新增 `src/core/mcp/auth-coordinator.ts`：

```ts
interface McpAuthCoordinator {
  login(key: McpServerKey): Promise<McpAuthResult>;
  completeCallback(flowId: string, url: URL): Promise<McpAuthResult>;
  cancel(flowId: string): Promise<void>;
  logout(key: McpServerKey, revoke: boolean): Promise<void>;
  getSnapshot(key: McpServerKey): McpAuthSnapshot;
}
```

同时新增 platform-neutral browser opener adapter，生产实现按平台调用，测试使用 fake。不得用 shell 拼接 URL。

### 9.6 Auth 状态

```text
not_required
login_required
authorizing
authenticated
refreshing
reauth_required
revoked
error
```

Auth 和 connection health 分离。authenticated 不等于 ready；ready 也不能掩盖 token 即将过期/refreshing。

### 9.7 TUI Auth

新增：

- `McpAuthView.tsx`；
- secret input 组件，禁止普通历史/复制回显；
- Open Browser、Copy URL、Cancel；
- callback 失败时安全的 URL 粘贴入口；
- Login、Logout、Clear credential、Revoke；
- Credential Store locked/unavailable 修复提示。

敏感 draft 不进入通用 TUI reducer、Session snapshot 或 debug output；组件卸载后清理引用。

### 9.8 Phase 3 测试

- Credential fake contract；
- 各平台 backend smoke；
- SDK fake OAuth metadata、PKCE、state、code exchange、refresh；
- invalid state、timeout、cancel、revoke；
- login required 不自动开浏览器；
- auth success 后新 discovery revision；
- token 不出现在 config、snapshot、Runtime Store、session log、stdout/stderr；
- PTY Login/Cancel/Logout；
- 浏览器 opener failure 与 Copy URL。

退出标准：用户可在 TUI 完成 HTTP MCP 登录，所有 credential material 只存在于安全 backend/短生命周期内存，登录成功后重新 discovery。

## 十、Phase 4：Tool 可见性与既有 Policy 管理

### 10.1 配置模型

扩展 `McpServerConfig`：

```ts
interface McpServerConfig {
  enabledTools?: string[];
  disabledTools?: string[];
  tools?: Record<
    string,
    {
      enabled?: boolean;
      effects?: Partial<EffectProfile>;
      minimumApproval?: CapabilityApproval;
      retry?: 'never' | 'safe_read' | 'idempotency_key';
      idempotencyKeyArgument?: string;
    }
  >;
}
```

语义：

1. `enabledTools` 存在时是 allowlist；
2. `disabledTools` 在 allowlist 后应用；
3. `tools.<name>.enabled` 作为单 Tool 精确 override；
4. filter 只决定 catalog 可见性，不授予执行权限；
5. remote annotations 仍不可信；
6. project source 只能 disable、提高 minimum approval 或提高 effect 风险；
7. 只有 user/local/admin 来源可以降低 minimum approval、设置可信 read-only effect 或允许 retry；
8. 引用不存在的 Tool 产生 diagnostic，不导致整个 Server 失败。

### 10.2 Catalog 与 UI snapshot

Manager 保留 discovery 的全部原始 Tool；Capability Snapshot 只包含 enabled 且 schema valid 的 descriptor。Control snapshot 为每个 Tool 提供：

- discovered；
- enabled；
- available/quarantined；
- declared effects；
- effective effects；
- policy provenance；
- minimum approval；
- retry；
- schema diagnostic。

每次 filter/policy 更新：

1. 重新生成 descriptor；
2. catalog revision 改变；
3. 旧 binding 失效；
4. 旧 approval 不沿用；
5. 下一 model turn 才暴露新工具集；
6. 已进入 provider 的外部调用不倒退为未执行。

### 10.3 TUI Tool 管理

Tool List：

- search；
- enabled/disabled；
- schema status；
- declared/effective risk 摘要；
- approval mode；
- policy source。

Tool Detail：

- name/description；
- input/output schema 摘要；
- declared vs effective effects；
- annotation trust provenance；
- minimum approval；
- retry/idempotency；
- diagnostic；
- reset local override。

UI 选项映射：

| UI | Core |
| --- | --- |
| Global policy | 删除 local minimum override |
| Always ask | `minimumApproval: user` |
| Auto review | `minimumApproval: auto_review`，仍受强制 effect 边界 |
| Disabled | Tool filter/`enabled: false` |

不新增 `auto|writes|prompt|disabled` 平行安全枚举。若提供“写操作询问”快捷预设，必须展开成现有字段，并把 unknown 当作写入。

### 10.4 Phase 4 文件范围

- 修改 `src/core/mcp/types.ts`、`manager.ts`
- 修改 `src/core/config` schema/repository/mutation
- 修改 capability descriptor/filter/revision 逻辑
- 修改 `src/app/tui/mcp/McpToolList.tsx`、新增 Detail/policy editor
- 新增 `tests/mcp-tool-policy.test.ts`
- 修改 `tests/mcp-manager.test.ts`
- 新增 `tests/tui-system/scenarios/mcp-tool-policy.test.ts`

### 10.5 Phase 4 验证

- allowlist/denylist/override precedence；
- project policy 不能放宽；
- invalid schema quarantine；
- policy revision 变化；
- active binding stale；
- tool disabled 后 model 下一 turn 不可见；
- TUI/Agent 工具数量一致；
- unknown effects 强制审批；
- retry 不被 UI Auto 放宽。

退出标准：TUI 中 enabled + available Tool 集合与 Runtime 下一 model turn 实际 binding 集合完全一致。

## 十一、Phase 5：Agent 不可用原因、Provider Action 与 Required 准入

### 11.1 Runtime provider 接口

将 Runtime 从具体 `McpManager` 收敛到中立接口：

```ts
interface McpRuntimeProvider {
  getCapabilitySnapshot(): CapabilitySnapshot;
  getProviderDirectorySnapshot(): McpProviderDirectorySnapshot;
  findCapability(capabilityId: string): CapabilityDescriptor | undefined;
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
  readResource(server: string, uri: string): Promise<string>;
}
```

Supervisor 实现该接口并委托 Manager。修改：

- `RunRuntimeAgentInput`；
- model/tool controller params；
- effect executor；
- TUI SessionManager/SessionRuntime；
- tests/mock provider。

### 11.2 Provider directory

```ts
interface McpProviderDirectoryEntry {
  providerId: string;
  status:
    | 'pending_approval'
    | 'rejected'
    | 'disabled'
    | 'login_required'
    | 'connecting'
    | 'ready'
    | 'degraded'
    | 'failed'
    | 'quarantined';
  lastKnownCapabilityNames: readonly string[];
  diagnosticCode?: string;
}
```

directory 不包含 URL、command、secret 或 raw error。未完成首次 discovery 的 Server 不虚构 Tool 名称。

### 11.3 Progressive disclosure 集成

扩展 `capability_search`：

1. available capability 搜索保持现有候选语义；
2. query 命中 provider name/last-known capability 但 provider unavailable 时，公共结果增加 bounded provider diagnostic；
3. diagnostic 不包含 executable handle、schema 或 capability ID；
4. unavailable candidate 绝不生成 disclosure/binding；
5. catalog drift 仍 fail closed；
6. context budget 计入 provider summary；
7. 大量失败 Provider 有硬上限和稳定排序。

公共结果示例：

```json
{
  "candidate_count": 0,
  "providers": [
    {
      "name": "github",
      "status": "login_required",
      "next_action": "Open /mcp and sign in"
    }
  ]
}
```

### 11.4 Typed provider failures

新增 narrow failure kinds，只有恢复策略确实不同才拆分：

- `provider_auth_required`：需要用户登录，不自动 retry；
- `provider_approval_required`：需要项目审批，不自动 retry；
- `provider_unavailable`：连接/health 失败，按 diagnostic 决定 retryable；
- `provider_capability_changed`：旧 binding 失效，model 可在新 turn 修复。

Manager/Supervisor 抛 typed `McpProviderError`；Tool Controller 映射到 `ClassifiedFailure`，不再靠错误字符串正则判断。

### 11.5 Provider Action Runtime lifecycle

新增 feature flag：

```text
mcpProviderActionV1=false
```

关闭时：保持 typed tool failure，要求用户通过 `/mcp` 修复；不恢复旧调用。

开启时，为当前任务增加正式 interaction：

```ts
type InteractionState =
  | ExistingInteractions
  | {
      kind: 'awaiting_provider_action';
      interactionId: string;
      providerId: string;
      action: 'login' | 'approve' | 'retry';
      originatingToolCallId?: string;
      capabilityRevision?: string;
    };
```

事件/效果：

```text
provider.action_required
provider.action_started
provider.action_completed
provider.action_deferred
provider.action_failed
```

```text
request_provider_action
```

流程：

```text
MCP 调用返回 typed auth failure
→ tool.failed，旧调用终结
→ provider.action_required，Runtime 暂停
→ TUI 调用 Supervisor/Auth Coordinator
   ├─ success → provider.action_completed
   ├─ later   → provider.action_deferred
   └─ failure → provider.action_failed
→ 清除 interaction
→ 开始新 model turn
→ 读取新 provider/catalog revision
→ 模型决定是否重新调用
```

硬约束：

- interaction 不保存 token、URL、authorization code 或原 Tool raw args；
- success 不把旧 Tool 标回 queued/approved；
- 不复用旧 binding 或 Tool Approval；
- 新 turn 重新参数校验、policy、approval 和 invocation；
- restart 后 pending provider action 可重新发起，但不能恢复旧 OAuth callback socket；
- background session 的 provider action 使用现有 foreground routing，切回会话后处理。

这属于 Lifecycle/Engine 边界，必须新增 ADR、Runtime schema migration、replay/golden 和 flag 双路径测试。

### 11.6 Required Server 准入

Phase 2 已解析 `required`，Phase 5 实现语义：

1. TUI 始终可以打开；
2. 新 Agent run 前查询 required effective Server；
3. ready/degraded/half_open 可准入，其他状态打开 Required Gate；
4. Gate 支持 Retry、Open Details、Session Waive、Cancel Run；
5. user/project required 可当前 session waiver；
6. waiver 写入 Runtime 初始事实，包含 provider、来源、理由、时间，不含 secret；
7. project config 不能禁止用户 waiver；
8. managed/admin no-waiver 留待未来；
9. Server 在 run 中途失败时按 provider failure 处理，不终止 TUI 进程；
10. waiver 不使 capability 可见，只允许任务在缺少它时继续。

### 11.7 Phase 5 文件范围

- 新增/修改 `src/core/mcp/runtime-provider.ts`、provider directory/errors
- 修改 `src/core/runtime/state.ts`、events.ts、effects.ts、actions.ts、reducer.ts、scheduler.ts、executor.ts、invariants.ts
- 修改 `src/core/runtime/agent.ts`
- 修改 `src/core/controllers/model-controller.ts`、`tool-controller.ts`
- 修改 `src/core/capabilities/search.ts`
- 修改 `src/protocol/capabilities.ts` 和必要的中立 action/event contract
- 修改 `src/app/tui/provider.ts`、session-manager.ts、run-agent.ts
- 新增 `src/app/tui/mcp/McpRequiredGate.tsx`
- 新增 provider action TUI projection
- 新增 Runtime migration/replay tests
- 新增 `tests/tui-system/scenarios/mcp-provider-action.test.ts`
- 新增 `tests/tui-system/scenarios/mcp-required-gate.test.ts`

### 11.8 Phase 5 验证

- provider directory budget/redaction；
- search 区分 absent/unavailable；
- auth expired tool call 终结且不重放；
- provider action success → 新 turn/new binding；
- Later → Agent 获得明确失败事实；
- restart pending action；
- background session foreground routing；
- required gate retry/waive/cancel；
- flag false/true 都 fail closed；
- old Runtime snapshot migration；
- stale binding 与 approval 继续拒绝。

退出标准：Agent 能准确解释 Provider 不可用原因；用户修复后任务在新 turn 继续；任何路径都不复用旧调用或绕过治理。

## 十二、完整 TUI 路由与操作矩阵

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
  | { name: 'error'; server: McpServerKey }
  | { name: 'confirm'; action: McpPendingAction };
```

### 12.2 状态到操作

| 主状态 | 可用操作 |
| --- | --- |
| pending approval | Review、Approve、Reject |
| rejected | Review、Reset on config change、Remove |
| disabled | Enable、Remove |
| login required | Login、Edit、Remove |
| authorizing | Cancel、Copy URL |
| connecting/discovering | Details、Cancel/Disable |
| ready | Tools、Resources、Prompts、Reconnect、Disable、Remove |
| degraded | Details、Retry、Tools（仅仍 available） |
| circuit open | Error、等待 retryAt、Manual Retry 条件检查 |
| failed | Error、Retry/Edit/Login 取决于 diagnostic |
| quarantined | Schema Diagnostic、Disable/Remove |
| shadowed | View Source、Remove higher source guidance |

### 12.3 响应式与终端规则

- 窄终端隐藏次要列，不截断状态和 Server name 到不可辨认；
- 宽字符使用现有 wrapping/width helper；
- 状态文字与符号同时存在；
- spinner 基于纯 elapsed time，不让状态逻辑依赖动画；
- overlay 不进入 viewport culling；
- resize 保持 route、selection、search 和非敏感 draft；
- secret draft 在 resize/remount 时不进入全局 state，必要时要求重新输入；
- Esc 含义由当前 route 决定，不把审批关闭误判为批准。

## 十三、Slash Commands 完整契约

```text
/mcp
/mcp list
/mcp get <server>
/mcp add
/mcp login <server>
/mcp logout <server>
/mcp enable <server>
/mcp disable <server>
/mcp retry <server>
/mcp remove <server>
/mcp approve <server>
/mcp reject <server>
/mcp reload
```

解析要求：

- `parseSlashCommand` 返回结构化 discriminated union；
- server 参数支持精确名称，不做模糊副作用操作；
- 找不到/重名时打开 list 并显示诊断；
- add/remove/logout/reject/disable 进入 route/confirm，不直接 mutation；
- retry/reload 也必须经过 Supervisor gate；
- help/suggestion 与 README 同步；
- command 是 App 控制入口，不创建 Runtime Tool Approval。

## 十四、测试总矩阵

### 14.1 Config/Approval

- source、scope、precedence、shadow、legacy；
- canonical path/digest；
- approval approve/reject/stale/corrupt；
- atomic JSONC mutation/conflict/watch；
- project policy only-tighten；
- remove reveal fallback；
- cross-platform path。

### 14.2 Manager/Supervisor

- connect/disconnect/retry/reconnect；
- generation late completion rejection；
- list_changed；
- HTTP backoff 与 non-retryable；
- stdio exit；
- circuit open/half open；
- immutable snapshot/revision；
- graceful stop/idempotence；
- config reconcile/in-flight call。

### 14.3 Auth

- Credential Store contract/platform smoke；
- OAuth discovery/PKCE/state/code/refresh/revoke；
- callback timeout/cancel/manual URL；
- no auto browser；
- secret leakage；
- logout credential options；
- auth expiry during call。

### 14.4 Tool Policy

- allowlist/denylist/per-tool；
- declared/effective/provenance；
- project cannot loosen；
- schema quarantine；
- stale binding/approval；
- retry/idempotency；
- TUI/runtime equality。

### 14.5 Runtime/Agent

- provider directory budget；
- search absent vs unavailable；
- provider action state/replay/migration；
- success new turn/new binding；
- Later/failure/cancel；
- required gate/waiver；
- background session；
- feature flag fail-closed。

### 14.6 TUI/PTTY

- route/keyboard/confirm/search；
- narrow/resize/wide character/no color；
- approval/add/auth/tool policy；
- config conflict；
- provider action；
- required gate；
- cleanup、focus 和 terminal echo；
- semantic assertion，不依赖 ANSI 精确快照。

## 十五、每阶段验证门禁

定向测试由各 Phase 列出；共同门禁：

```bash
bun run typecheck
bun run check:core-boundary
bun run format:check
bun run check:docs-impact
bun run check:docs
bun test tests/docs-space.test.ts
git diff --check
```

涉及 Runtime lifecycle 的 Phase 5 额外运行：

```bash
bun test tests/runtime
bun test tests/runtime/agent.integration.test.ts tests/runtime/store.test.ts
bun run test:tui:system:core
```

真实模型测试不作为默认验收；真实 MCP 使用本地隔离 transport fixture。Credential backend 需要显式平台 smoke，不用测试机真实用户凭证。

## 十六、文档与 ADR 路线

### Phase 0

- 新 ADR：项目 Server 审批、digest、trust 分离；
- 新 active：`mcp-project-approval.md`；
- 更新 MCP governance、README、book 08/09/11、documentation map。

### Phase 1

- active：Supervisor/control snapshot/diagnostic；
- book 07/08：TUI controller 与 route；
- 更新 TUI 测试 active 读取时机。

### Phase 2

- 新 ADR：MCP scope/precedence/legacy migration；
- active：配置来源、mutation、hot reload；
- README 与 book 09：配置格式和 slash commands。

### Phase 3

- 新 ADR：Credential Store backend 与 OAuth session；
- active：MCP auth/secret persistence；
- README：环境变量、OAuth、logout；
- documentation map 覆盖 auth/credential 文件。

### Phase 4

- 更新 MCP governance 和 authorization；
- book 05/11：Tool filter/effect/minimum approval；
- 配置 reference。

### Phase 5

- 新 ADR：Provider Action Runtime lifecycle；
- active：failure classification、Runtime interaction、progressive disclosure、required admission；
- Runtime schema/replay 文档；
- book 04/08/10/11。

每阶段完成后创建独立 `execution/completed/` 记录，更新本总计划的阶段状态和 plans index。不得等到 Phase 5 才补前面阶段的 active 文档。

## 十七、建议提交切片

### Phase 0

使用现有子计划的 8 个切片。

### Phase 1

1. control types + Manager subscription/lifecycle；
2. Supervisor + diagnostic；
3. Session/TUI controller injection；
4. route 化只读 UI；
5. component/PTY/docs。

### Phase 2

1. scope repository + characterization；
2. atomic mutation/conflict/watch；
3. generation reconcile + descriptor version；
4. Add Wizard；
5. enable/disable/remove/migrate；
6. slash/PTY/docs。

### Phase 3

1. backend spike + ADR；
2. Credential Store interface/backend；
3. SDK OAuth provider/coordinator；
4. Manager auth integration；
5. TUI auth/secret input；
6. fake OAuth/PTY/leak scan/docs。

### Phase 4

1. config filter schema；
2. catalog filtering/revision；
3. policy provenance/only-tighten；
4. Tool List/Detail editor；
5. binding/policy/PTY/docs。

### Phase 5

1. Runtime provider interface/directory；
2. search unavailable diagnostics；
3. typed provider failures；
4. Provider Action ADR/flag/state/events/effects；
5. TUI action integration/new-turn recovery；
6. required gate/waiver；
7. replay/golden/PTY/docs。

每个切片只在自身实现、测试和相关文档共同收敛后提交。提交前执行 `document-before-commit` Skill。

## 十八、阶段状态追踪

| Phase | 状态 | 完成记录 | 备注 |
| --- | --- | --- | --- |
| 0 项目 Server 审批 | completed | [`../execution/completed/2026-07-15-mcp-project-server-approval-p0.md`](../execution/completed/2026-07-15-mcp-project-server-approval-p0.md) | transport 前置门禁、TUI 审批与真实 stdio/HTTP/PTY 证据已收敛 |
| 1 Supervisor/只读 UI | completed | [`../execution/completed/2026-07-15-mcp-tui-management-center-phase1.md`](../execution/completed/2026-07-15-mcp-tui-management-center-phase1.md) | 单一 SDK client、可订阅 control snapshot、typed diagnostics 与只读管理中心已验证 |
| 2 配置管理 | completed（含 TUI 简化校正） | [`Phase 2`](../execution/completed/2026-07-15-mcp-tui-management-center-phase2.md)、[`UX 校正`](../execution/completed/2026-07-16-mcp-tui-config-simplification.md) | 三层 repository、原子 mutation、watch/reconcile 与 name + URL 的 local HTTP TUI 流程已验证 |
| 2R `/mcp` 只读纠偏 | completed | [`完成记录`](../execution/completed/2026-07-16-mcp-tui-readonly-list.md) | 配置 mutation 退出 TUI，project trust 独立，只保留 effective Server 名称与连接状态 |
| 3 Auth | completed | [`完成记录`](../execution/completed/2026-07-16-mcp-auth-phase3.md) | OS vault-only credential、HTTP OAuth、独立认证提示、PTY 场景与 macOS/Windows/Ubuntu 原生 smoke 全部通过；遵循 ADR-0012，不恢复 `/mcp` 管理 route |
| 4 Tool 策略 | pending | — | 依赖 Phase 2，后半与 Phase 3 集成 |
| 5 Agent 闭环 | pending | — | 依赖 Phase 1/3/4，需 Runtime flag/ADR |

执行时一次最多将一个 Phase 标为 active；Phase 内按任务进度更新，不把未验证阶段提前标为完成。

## 十九、总体风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 一次改动跨越所有 Phase | 无法验证和回滚 | 独立 Phase、退出标准、完成记录 |
| Manager/Supervisor 双 client | 状态漂移/双副作用 | Supervisor 只编排，Manager 保持唯一 SDK client |
| scope 迁移改变有效 Server | 调错后端 | characterization、shadow UI、显式 legacy migration |
| Credential backend 不可用 | OAuth 无法安全交付 | 前置 spike，失败则 Phase 3 blocked，禁止明文 fallback |
| OAuth callback/secret 泄漏 | 账户安全事件 | loopback/state/PKCE、安全 backend、全链路 redaction |
| policy UI 成为放权后门 | 绕过强制审批 | 复用现有 enum/effect，project only-tighten |
| config reload 与调用竞态 | 旧 Server 继续执行或重复写 | generation、先失效 binding、不重放 invocation |
| Agent 自动恢复旧调用 | 重复外部副作用 | tool.failed 终结旧调用，新 turn/new binding |
| provider summary 占用上下文 | progressive disclosure 退化 | bounded metadata、预算、稳定排序 |
| Runtime Provider Action 破坏恢复 | 卡死或错误续跑 | flag、ADR、schema migration、replay/golden |
| TUI route 影响终端稳定性 | 闪烁/焦点/resize 回归 | component + PTY 分层验证，复用 active 规则 |

## 二十、回滚策略

### 可回滚

- 只读 UI 到简化 UI；
- 配置 mutation 入口；
- OAuth 登录入口；
- Tool policy 编辑器；
- provider unavailable 模型提示；
- `mcpProviderActionV1` 到 typed failure 路径。

### 不可回滚

- 项目 transport 前置审批；
- config digest 变化使审批失效；
- secret 不进入普通配置/事件/日志；
- revisioned binding；
- project policy 不能放宽；
- unavailable capability 不可绑定；
- 外部写不自动重放；
- Provider Action 成功后不复用旧 Tool Call。

任何回滚都必须保持用户可以进入 `/mcp` 查看错误和修复；required Server 失败不得让 TUI 直接退出。

## 二十一、完整完成定义

只有同时满足以下条件，本总计划才能标记完成：

1. Phase 0–5 全部达到各自退出标准；
2. 项目配置未批准时 transport 零副作用；
3. TUI Server/Tool 状态与 Runtime catalog/binding 一致；
4. 三 scope、shadow、legacy migration 和 hot reload 有完整验证；
5. Add/Enable/Disable/Retry/Remove 全部可在 TUI 完成；
6. HTTP OAuth 和 static credential reference 可用且无明文泄漏；
7. Tool filter/effect/approval/retry 不绕过现有治理；
8. Agent 能区分不存在、审批、认证、连接、schema 错误；
9. Provider Action 在成功后进入新 turn，旧调用不重放；
10. Required Gate 和 session waiver 可恢复、可审计；
11. Runtime flag false/true、旧 snapshot migration 和 replay/golden 通过；
12. 所有定向 unit/integration/component/PTY 测试通过；
13. typecheck、core boundary、format、docs-impact、docs 和 diff 门禁通过；
14. 每个 Phase 有完成记录，active/book/README/ADR/documentation map 同步；
15. `document-before-commit` Skill 在每次 stage/commit/push/PR 前完整执行；
16. 未交付的非目标明确进入 backlog，不伪装成完成。

本计划完成后，Kite Code 的 `/mcp` 才能被称为完整 MCP 管理中心，而不是连接状态列表。
