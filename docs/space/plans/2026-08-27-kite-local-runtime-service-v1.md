# Kite Local Runtime Service V1 实施方案

状态：active（ADR-0144 已接受；KLSV1-00 baseline 已建立）

日期：2026-08-27

优先级：P1

审查基线：`main@9d22b53dee77814e38e6a30d03ed4a1124f051a6`

依赖：ADR-0053、ADR-0129、ADR-0139、ADR-0140、ADR-0141、ADR-0142、ADR-0143、ADR-0144，已归档的
[`Kite Runtime Server V1`](2026-08-26-kite-runtime-server-v1.md)，以及当前 Runtime Architecture、Runtime
Authority、Runtime Resilience、Workspace Trust、SQLite Runtime Log Query、Execution Platform 和 Release
Control authority。

替代关系：本计划不改写 KRSV1 的历史结论；它在已经落地的 Protocol、Server Core、Runtime Client、
InProcess、stdio、development loopback WebSocket 与持久 command receipt 之上，新增 App-owned 的本机服务
进程、发现、生命周期、多 Workspace admission、完整 History transport 和 TUI/foreground CLI 外部连接。

并发约束：本计划命中 `apps/kite` workspace 重命名与拆分、Runtime Server admission、Workspace Trust、SQLite
Store owner、release smoke 与跨 transport qualification。同一 Task 只允许一个 Git owner；KLSV1-01 的 workspace
rename 必须先于所有后续路径改动；KLSV1-02/03 命中同一 App composition 与 client control surface，必须串行；
KLSV1-04/05 命中同一 local carrier/service state，必须串行；KLSV1-06 在前述 Gate 全部通过后才能迁移唯一
Runtime composition root 并切换默认 Store owner。

## 1. 审查结论

主干已经具备逻辑 Runtime Server，但没有真正的用户级本机服务。下一阶段应建立：

```text
Runtime Host      → Runtime 权威
Runtime Server    → 协议网关
Local Carrier     → loopback 消息传输与本机认证
Local Service     → 进程、发现、复用、版本和生命周期
```

架构方向通过，但 V1 必须保持窄范围。KLSV1 只交付默认 Runtime Store 的本机服务化，并让 TUI 与用户在场的
foreground CLI 连接该服务。Desktop、Browser、通用多 Store daemon、OS Service、自动更新和公共 SDK 都不是
前置条件，不进入本计划。

固定以下裁决：

| 议题 | KLSV1 裁决 | 明确不做 |
| --- | --- | --- |
| Service identity | 一个 canonical `userKiteCodeDir()` 的默认 Runtime Store 对应一个 Service | 任意 `--checkpoints` 动态注册、多 Store 路由 |
| 默认 Store owner | Service entrypoint 发布后，默认 Store 只有 Local Service 一个 production owner | Service 与 embedded/stdio/旧 CLI 同时打开默认 Store |
| Workspace | 一个 Service 支持多个 canonical trusted Workspace；create 使用 connection admission，已有 Session 使用持久 identity | Workspace CRUD、Project 数据库、从 `clientInfo` 或 display name 提升 authority |
| Runtime Protocol | 保持 exact Protocol V1；Service lifecycle 和 Workspace 请求不进入 wire command | Protocol V2、`runtime/service/*`、把 token/build/process 信息放入 Runtime Protocol |
| History | 独立 authenticated local History transport，返回现有 client-safe DTO | Server notification history 代替完整历史、TUI 直接读取 SQLite |
| Workspace 拆分 | 当前 `apps/kite` 先机械重命名为 `apps/kite-cli`；新增 `apps/kite-service` 作为最终唯一 Runtime composition root | 让 CLI/Web/Desktop app 彼此源码依赖，或继续把 Service 塞进 CLI workspace |
| Shared contract | 新增 browser-safe `@kite-ai/kite-app-contract`，只承载当前客户端确实需要的 exact DTO/codec | 通用插件协议、动态方法、UI component contract |
| Native substrate | 新增 Bun/Node-only `@kite-ai/kite-local-runtime`，承载本机发现、state/lock、process manager 与 Native connector | 被 Browser/renderer 导入、依赖 Host/Server/Builtin/SQLite |
| Carrier | Native-only、`127.0.0.1:0`、access/control token、WebSocket + exact History HTTP | Browser cookie/ticket、静态 Web、Desktop IPC、TLS、LAN、Unix socket、Named Pipe |
| Process | 按需 detached 用户进程；显式 ensure/status/stop/restart；不注册 OS Service | launchd/systemd/Windows Service、开机自启、自动重启、后台更新器 |
| Stop | 普通 stop 在 active operation 时返回 `service_busy`；signal shutdown 走现有 recovery-safe disposal | `stop --force`、自动 `SIGKILL`、未关闭进程时清理 descriptor/token |
| Store/Kernel | State 27、Store 6、Runtime epoch 和 Kernel 保持不变 | 为服务化增加 Store 表、Host fencing、Kernel service event |

因此本计划的首要任务不是 PID 文件，而是先把 Runtime Application 从 TUI composition 中拆出，并让它可以在
同一 Host 内按 Session Workspace 组合现有 App dependencies。

## 2. 当前事实基线

### 2.1 已完成能力

1. `runtime-protocol`、`runtime-server`、`runtime-client` 已落地，Protocol V1 是 repo-private exact schema。
2. TUI 与 foreground CLI 已经走 `RuntimeClient → RuntimeServer → RuntimeAccess`，当前 carrier 为 InProcess。
3. `kite server --stdio --thread <id> --workspace <path>` 是 parent-owned child，不是 resident daemon。
4. development loopback carrier 已覆盖 `127.0.0.1:0`、bootstrap auth、cookie、Host/Origin、frame limit、
   heartbeat、backpressure 与 binary rejection，但 current authority 明确禁止将其直接改名为 production。
5. Store 6 已持久化 scoped command receipt；commit 后 response 前崩溃时，相同 command ID 可以重放原结果，
   KLSV1 不需要修改 State/Store schema。
6. 完整 durable history 已经通过 `RuntimeHistoryClient → App safe projector → RuntimeLogQueryPort → SQLite
   readonly reader` 提供；Server notification retention 只用于短断线恢复。

### 2.2 当前阻塞事实

1. `createKiteTuiSessionManager()` 同时组装 SQLite、Host、Runtime execution bridge、Model/Tool/Skill/MCP、
   Runtime Client、History 和 TUI facade，不能直接迁入常驻进程。
2. `createKiteRuntimeServerComposition()` 固定 `input.workspace`；当前 Server instance 只允许一个 Workspace。
3. Protocol V1 的 `create_session` 故意不携带 workspace；App mapper 用 admission 决策注入 workspace。多 Workspace
   Service 必须建立 connection-scoped App admission，不能让 wire path 成为 authority。
4. `RuntimeHistoryClient` 当前是 InProcess 注入；外部 TUI 只有 WebSocket 时无法 list/load 完整历史。
5. CLI 支持 `--checkpoints <path>`。若 Service identity 只按 `KITE_CODE_HOME` 字符串判断，可能把多个 Store
   混为一个 owner，或让 path alias 指向默认 Store。
6. TUI、foreground CLI 与 stdio 仍可各自创建 Host/Store；只给 Service 增加 `instance.lock` 不能自动阻止这些
   alternate owner 打开同一默认 Store。
7. Runtime initialize 当前返回 protocol version、server version 与 instance ID，不返回 build ID；build comparison
   属于 Service descriptor/status，不应为此扩大 Runtime Protocol。
8. development local auth 是单 bootstrap bearer、单 cookie session，不能支持 Native 多客户端 production auth。
9. Bun 会在用户代码前加载 cwd 下的 `.env*`。resident Service 不能以任意 Workspace 作为 cwd，也不能无选择地
   继承所有 project-influenced environment 后长期服务其他 Workspace。
10. ADR-0053 和 ADR-0142 当前固定 production consumer、单 Workspace Server 与 Web No-Go。多 Workspace resident
    Service 需要追加 ADR 明确取代对应局部结论；hosted/multi-user/Web No-Go 仍保持。
11. TUI 当前除 Runtime/History 外还直接持有 Config、Workspace Trust、Provider first-run/credential、model
    selection、MCP Supervisor/config/auth 与部分 authoritative status 对象。若只迁移 Runtime WebSocket，Service 仍会
    依赖 TUI 进程，client disconnect 后 Turn 无法独立继续；这些 direct dependencies 必须形成 exact App Control
    boundary，而不能跨进程传 Manager object。

## 3. 目标、成功标准与非目标

### 3.1 目标

1. 建立按需启动、用户级、长生命周期、仅本机可访问的 Kite Local Runtime Service。
2. 让一个 Service 成为同一发布版本受支持入口中默认 Runtime Store 的唯一正常 production owner，并复用一个 Runtime Host 服务多个
   Workspace、Session 和 Client。
3. 让 TUI 与 foreground CLI 通过 Native connector 使用外部 Runtime Client、完整 History Client 与 exact Kite
   App Control Client。
4. 保持 Runtime Server Core、Runtime Host、Kernel、Store 和完整 History 的现有 owner 边界。
5. 提供跨 macOS、Linux、Windows 的发现、并发 ensure、stale recovery、显式 stop/restart 和 installed
   candidate startup evidence。

### 3.2 成功标准

- 同一默认 Store 同时只有一个受支持的 Service owner；TUI/foreground CLI 不再创建默认 Store Host；
- 一个 Service 可创建并恢复两个不同 trusted Workspace 的 Session，配置、Skill、MCP 与 Model composition 不串线；
- 已有 Session 的 Workspace 只从持久 Session State/identity 解析，客户端不能改绑；
- TUI list/load、长历史 replay、interaction recovery 与 live presentation 在 Service 模式下保持等价；
- Workspace Trust、Provider first-run、model selection、MCP 管理/认证与 authoritative status 在 CLI/Service 拆分后
  保持现有 journey，CLI 只消费 exact projection/command；
- TUI/CLI 退出只关闭 connection；Turn、审批等待和 Session 不因 client disconnect 自动取消；
- Service restart/crash 后，Client generation、Session index、subscription 与 history resync 正确收敛；
- concurrent ensure 只产生一个 healthy instance；PID reuse 不会被误判为健康 Service；身份不确定时 fail closed，
  不启动第二个 owner；
- 普通 stop 对 active operation 返回 `service_busy`，不存在 check-active 与新 mutation 之间的竞态；
- descriptor/token/lock 不进入 Runtime Store、Session Log、remote observability 或普通正文日志；
- source run 与 installed standalone candidate 在 macOS arm64、Linux x64、Windows x64 的适用 Gate 通过；
- current authority、ADR、owner README、documentation map、release/qualification 文档与实现共同收敛。

### 3.3 非目标

- Browser、Web UI、`kite service open`、cookie/bootstrap fragment、静态 assets；
- Desktop main/renderer IPC、Desktop installer lifecycle 或窗口管理；
- 面向第三方的公共 SDK 或长期兼容 Local Service API；
- 为未来 UI 提前创建 component/design-system package；
- systemd、launchd、Windows Service、登录自启、后台自动更新、自动 crash restart；
- `0.0.0.0`、局域网、公网、TLS、SSH、remote agent、远程 Worker；
- Unix socket、Windows Named Pipe 或新的 native lock helper；
- 多用户、租户、RBAC、跨 OS 用户隔离；
- 任意 custom Store 注册、一个 Service 管理多个 Store、Store migration service；
- Workspace CRUD、Project dashboard、Workspace metadata database；
- Runtime Protocol V2、Service lifecycle RPC、Server-initiated request；
- Store schema、Runtime epoch、Kernel Event、Host fencing 或 persisted Project authority；
- `stop --force`、自动杀死 busy Service、无人值守升级；
- 为未来 Browser/Desktop 提前实现 transport、IPC、cookie、UI、plugin 或 capability negotiation；本计划只冻结
  它们不能依赖 native/process package 的静态边界。

## 4. 目标架构与所有权

```text
apps/kite-cli
CLI / TUI / terminal presentation
         │
         │ @kite-ai/kite-local-runtime/client
         │ discover / ensure / Runtime + History + App Control
         │
         ├──────── Runtime WebSocket ───────────┐
         ├──────── History HTTP ───────────────┤
         └──────── exact App Control HTTP ─────┤
                                               │
┌──────────────────────────────────────────────▼───────────────────────┐
│ apps/kite-service                                                     │
│                                                                      │
│ Service process / neutral env / auth / listener / app-control handler│
│                      │                                               │
│ KiteRuntimeApplication                                                │
│      ├─ Runtime Server → RuntimeAccess                                │
│      ├─ Runtime Host                                                  │
│      ├─ Runtime execution bridge                                      │
│      ├─ per-Workspace config / Model / MCP / Skills / Sandbox         │
│      ├─ Runtime History adapter                                       │
│      └─ SQLite Runtime Store                                          │
└──────────────────────────────────────────────────────────────────────┘

未来 consumer（不在 KLSV1 实现范围）：

apps/kite-web       → runtime-client + kite-app-contract；禁止 native package
apps/kite-app main  → kite-local-runtime/client
apps/kite-app UI    → kite-app-contract + narrow IPC；禁止 native package
```

### 4.1 Target workspace 拓扑

```text
packages/
├─ runtime-contract/          # 已有 Runtime client-safe domain DTO
├─ runtime-protocol/          # 已有 exact Runtime wire
├─ runtime-client/            # 已有 transport-neutral Runtime Client
├─ runtime-server/            # 已有 transport-neutral Server Core
├─ kite-app-contract/         # 新增：browser-safe Kite frontend/service DTO + codec
└─ kite-local-runtime/        # 新增：Bun/Node-only local process/transport substrate

apps/
├─ kite-cli/                  # 当前 apps/kite 重命名；CLI、TUI、terminal presentation
└─ kite-service/              # 新增；唯一 Runtime composition root 与本机 Service executable

未来另立计划：
├─ kite-web/                  # Browser app
└─ kite-app/                  # Desktop main + renderer
```

只新增两个 package：

1. `@kite-ai/kite-app-contract`
   - browser-safe；
   - 依赖 `runtime-contract`，可使用现有 History/Session/client-event DTO；
   - 根出口只拥有无 secret 的 Workspace、Provider/model、MCP/status projection 与当前 frontend use case 的 exact
     request/response codec；
   - 不包含 React/Ink component、Node/Bun I/O、token file、process、Host、Server 或 SQLite type；
   - 不导出 PID、endpoint、build identity、raw API key/OAuth/MCP credential material 或 Native lifecycle command；
   - 不是第三方 public API，只是仓库私有 frontend/service contract。
2. `@kite-ai/kite-local-runtime`
   - 明确是 Bun/Node-only，提供 `./client` 与 `./service` 窄 exports；
   - 拥有 descriptor/token/lock filesystem primitive、discovery/lifecycle manager、Runtime WebSocket transport、
     History/App Control HTTP clients、Service process state primitive，以及只允许 Native client 使用的 descriptor、
     lifecycle 与 secret-bearing credential request codec；
   - 依赖 `kite-app-contract`、`runtime-client`、`runtime-protocol`；
   - 禁止依赖 `runtime-host`、`runtime-server`、`builtin-runtime`、SQLite、React、Ink 或任一 `apps/*`。

`kite-local-runtime/client` 拥有 discovery、ensure/status/stop/restart 与三类 client transport；
`kite-local-runtime/service` 只提供 state root、descriptor、token、lock 的 filesystem primitive。Listener、HTTP/WS
server、Service lifecycle state machine和Runtime composition都留在 `apps/kite-service`，不把 package 扩成通用 daemon
framework。

没有第三个 config/shared-utils package。持久 user/project config、Workspace Trust、credential、MCP supervisor 与
Runtime capability composition 最终由 `apps/kite-service` 拥有；CLI 所需状态通过 exact App Control projection 取得。
只有语言、theme、terminal key binding 等纯 CLI/TUI preference 可以保留在 `apps/kite-cli`。KLSV1-00 必须用逐项
consumer manifest 确定边界，不得按目录名整包搬迁或把所有 `config/` 塞进一个共享包。

### 4.2 Owner 矩阵

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| Runtime Host | Session mailbox、revision、effect、recovery、receipt、Store lifecycle | listener、token、descriptor、PID、Service command |
| Runtime Server | initialize、RPC routing、subscription、bounded delivery、drain | process、HTTP、SQLite history、Workspace Trust、Service lifecycle |
| `kite-app-contract` | frontend-safe、无 secret 的 exact DTO/codec与closed App control use cases | I/O、PID/endpoint、raw credential、manager object、dynamic method、UI component |
| `kite-local-runtime` | Native filesystem/process state、lifecycle/secret codec、manager、Runtime/History/App Control transports | Runtime execution、Host/Server/Builtin/SQLite、Browser runtime |
| `apps/kite-service` | 唯一 Host/Store/Builtin/App execution composition、per-Workspace dependencies、History、App control、listener | Ink/React/TUI reducer、Desktop IPC、Browser UI |
| `apps/kite-cli` | CLI/TUI、terminal presentation、trust/credential prompt、typed clients | RuntimeHost、RuntimeServer、Builtin execution、SQLite、Service implementation |
| Future `apps/kite-web` | Browser UI 与 browser transport | Node/Bun FS、spawn、token file、`kite-local-runtime` |
| Future `apps/kite-app` | main process ensure/connect；renderer narrow IPC | renderer 直接读取 token/descriptor、直接 spawn、直接 SQLite |

### 4.3 Runtime Application 与 App Control 拆分

服务端新增稳定 App-local seam：

```ts
interface KiteRuntimeApplication extends AsyncDisposable {
  readonly runtime: RuntimeAccess;
  readonly server: RuntimeServer;
  readonly history: RuntimeHistoryClient;
  readonly appControl: KiteAppControlService;

  start(): Promise<void>;
  quiesceMutations(): Promise<RuntimeApplicationQuiesceLease>;
  cancelAll(reason: string): Promise<void>;
}

interface RuntimeApplicationQuiesceLease {
  readonly activeOperations: boolean;
  resume(): void;
  commitDrain(): Promise<void>;
}
```

该接口是 `apps/kite-service` 内部 lifecycle，不进入 `runtime-contract`、`runtime-host` 或 public export。
`KiteAppControlService` 的客户端可见值必须经过 `kite-app-contract` exact projection，不能暴露 Manager、Repository、
CredentialBroker 或 callback。`quiesceMutations()` 必须先阻止新的
mutation admission，等待已经 admission 的 command 离开请求临界区，再原子观察 Host active operation；由此关闭
普通 stop 的 TOCTOU。具体实现可以使用更窄的内部对象，不要求照抄命名。

`KiteAppControlService` 只可作为 composition facade；内部按 Workspace Trust、Provider/config、MCP、credential、status
拆成独立 handler/capability。每个 route 使用独立 exact codec，禁止形成不断扩张的 God interface 或通用 route registry。

现有 `TuiRuntimeBridge` 中的 Host execution、Session recovery、Model/Tool coordination 拆为 Service-owned Runtime
execution bridge；TUI facade 只消费 Runtime/History/App Control clients。拆分完成后：

```text
InProcess unit/integration test
  = KiteRuntimeApplication + fake/in-process clients

Local Service
  = apps/kite-service owns KiteRuntimeApplication
  = apps/kite-cli owns client adapter only
```

当前 TUI 除 Runtime/History 外还直接持有 config、Workspace Trust、Provider first-run/credential、model selection、
MCP Supervisor/config/auth、release/execution status 等本机对象。KLSV1-00 必须形成逐项 client dependency manifest，
并为每一项选择且只选择一种归属：

| 分类 | 归属 | 示例 |
| --- | --- | --- |
| 纯 UI state | `apps/kite-cli` | locale、theme、overlay、terminal key handling |
| Runtime Session command/query/event | 现有 Runtime Protocol/Client | create、turn、interaction、rewind、compact、projection |
| 完整 durable history | 现有 History DTO + local History client | list/load transcript |
| 无 secret 产品 control | `kite-app-contract` + Service App Control | Workspace trust、Provider/model projection、MCP snapshot/action、authoritative execution/release status |
| Native secret/lifecycle control | `kite-local-runtime` native-only codec + Service handler | raw Provider credential write、OAuth/MCP credential material、descriptor、stop |
| Runtime-only implementation | `apps/kite-service` | Config repository、CredentialBroker、MCP Supervisor、Model/Tool/Sandbox composition |

只为当前 TUI/CLI 已存在 journey 定义 exact use-case codec；不建立 generic `app/query`、动态 method registry、plugin
command 或 Manager passthrough。secret-bearing credential command 不进入 browser-safe contract，只经
`kite-local-runtime` 的 authenticated Native loopback 进入 Service，并禁止 request body 进入日志、error data 和
observability。future Browser/renderer 即使依赖 `kite-app-contract`，也无法静态构造 raw credential request。

KLSV1-00 还必须把 TUI 当前的 `SessionManager`/`SessionRuntime` 调用逐方法映射到新的 `TuiRuntimeClientFacade`：

```text
create/register/list/load/delete Session  → Runtime + History
runTask/abort/waitForRunCompletion        → Runtime command/subscription projection
setForeground/agentLoopActive             → CLI-local selection + Runtime projection
conversationHistory/token stats/naming    → History/App Control safe projection
rewind/compact/interaction                → Runtime query/command
MCP controller / Skill loader             → exact App Control projection/action
Provider first-run / model selection      → exact App Control + Native secret command
```

`SessionRuntime` object、callback、AbortController、Manager、Store handle 不跨进程。Service transport cutover 前，
fake clients必须跑通该方法清单对应的全部现有 TUI journey；不能把 facade replacement留到最后一个 cutover PR。

#### Service-owned interaction broker

当前 `SessionRuntime`、`TuiRuntimeBridge` 与 `CliRuntimeBridge` 仍把 `SessionUserInputProvider` 和 pending interaction
绑定在 frontend invocation。KLSV1 必须把等待从 UI 进程中移出，但不在 Runtime Server 建立 domain waiter：

```text
Service Runtime execution bridge
  → RuntimeInteractionBroker.publish(durable interaction identity)
  → 等待 (sessionId, interactionId, generation/revision)

Client Runtime subscription
  → 展示 interaction
  → respond_interaction Runtime command
  → Host exact revision/identity commit
  → Service broker resolve
```

规则：

- broker 是 `apps/kite-service` 内部 App execution mechanism，不进入 Protocol/Server/Store schema；
- durable Runtime State/notification 仍是 pending interaction authority，broker 只是当前进程 waiter；
- Client 断开不取消 waiter；Service restart 从 durable Session recovery 重新建立 waiter；
- stale、重复、wrong generation response 继续由 Host command identity 拒绝；
- `SessionUserInputProvider` 只留在 `apps/kite-cli` 作为 UI 输入/展示 adapter，不被 Service import；
- `TuiRuntimeBridge`、`CliRuntimeBridge`、`SessionManager` 不能整体搬迁，relocation manifest 必须逐方法拆成 Service
  execution、Runtime command/query、History 与 CLI presentation。

### 4.4 per-Workspace composition

不建立 Workspace platform。只建立一个 App-local resolver：

```ts
interface RuntimeWorkspaceAdmission {
  admitForCreate(workspace: string): Promise<AdmittedWorkspace>;
  resolveForSession(sessionId: string): Promise<AdmittedWorkspace | undefined>;
}

interface AdmittedWorkspace {
  readonly canonicalPath: string;
  readonly projectId: string;
  readonly workspaceDigest: `sha256:${string}`;
}
```

一个 Runtime Host 仍只注入一个 `RuntimeHostExecutionBridge`。多 Workspace 由 App-owned router 实现，不修改 Host：

```text
Runtime Host
  → RuntimeExecutionBridgeRouter
      → sessionId
          → WorkspaceSessionExecutionBridge
              → RuntimeWorkspaceContext
```

```ts
interface RuntimeWorkspaceContextFactory {
  create(admission: AdmittedWorkspace): Promise<RuntimeWorkspaceContext>;
  resolveForSession(sessionId: string): Promise<RuntimeWorkspaceContext | undefined>;
}
```

router 的 create/recover/inspect/query/shutdown 都按 Session identity 路由；Service close 聚合关闭全部 context/bridge。
Workspace 选择不下沉到 `runtime-host`，也不为每个 Workspace 创建第二 Host/Store。

Service 使用两阶段启动：

```text
ServiceBootApplication
  → state/auth/App Control ready，不要求 Provider API key，不读取 project config
  → Workspace trust/config/credential 可以通过 exact control 完成

RuntimeWorkspaceContextFactory
  → 只有 admitted Session create/resume 时才加载 project config、Skill、MCP 与 execution dependencies
```

Provider 未配置时 Service 仍为 ready，App Control 返回 `provider_not_configured`；需要 Model 的 Runtime operation
按现有 readiness fail closed。所有 project config/MCP/Skill API 必须接收显式 canonical Workspace，禁止回退
`process.cwd()`。

对象生命周期必须在 KLSV1-00 baseline 中机械分类：

| 生命周期 | 对象 |
| --- | --- |
| process-wide | Store、Runtime Host、Runtime Server、user config repository、credential broker、Service auth/state |
| per-Workspace | project config、Skill scan/catalog、MCP supervisor/catalog/watch、sandbox/filesystem、Git broker、model route/context |
| per-Session | Runtime Session、interaction broker waiter、session projection、selected model/mode、recovery identity |

规则：

- create 前执行 native realpath、Workspace Trust、`resolveProjectIdentity()`；
- resume/fork/command 从持久 Session State 恢复 workspace，再验证 path、project ID 与 digest；
- user config 可以 process-wide 复用；project config、Skills、MCP declaration、filesystem runtime 与相关 cache
  必须以 canonical Workspace/Project identity 为 key；
- 不把“当前 Workspace”放入 process-global mutable singleton；
- 沿用现有 config/MCP watch 和 session lifecycle，不新增通用 cache invalidation framework；
- Workspace 被删除、identity drift、trust store 损坏或项目配置无法解析时 fail closed，只隔离对应 Session/Workspace，
  不停止其他 Workspace。

#### History owner relocation

完整 History 的 raw event 与 projector 全部属于 `apps/kite-service`：

- `bootstrap/runtime/state-runtime.ts` 的 raw Runtime Event/State；
- `runtime-client/history-adapter.ts` 的 SQLite log adapter；
- `runtime-client/event-projector.ts` 的 raw-to-safe event projection；
- `logs/runtime-log-presentation.ts` 的 raw log projection；
- `runtime-client/presentation-history.ts` 中依赖 raw event 的部分。

`apps/kite-cli` 只保留 safe `RuntimeClientEvent` 的 TUI reducer/presentation facade。`runtime-contract` 与
`kite-app-contract` 只携带已经 safe-projected 的 DTO；禁止 raw event package 化、Service 导入 CLI source 或复制第二份
projector。KLSV1-00 relocation manifest 必须逐文件确认这一边界。

### 4.5 为什么这不是为未来过度拆包

- `kite-app-contract` 在 KLSV1 当下就有两个真实 consumer：`kite-cli` 与 `kite-service`；
- `kite-local-runtime` 在 KLSV1 当下就有两个真实 consumer：CLI 的 manager/connector 与 Service 的 state primitive；
- 两个 package 都有可以机械验证的环境边界，避免 app-to-app import，而不是按“将来可能复用”创建空抽象；
- future `kite-web`/`kite-app` 只写 forbidden dependency 规则，不创建目录、package、adapter、IPC 或 Browser transport；
- 不创建 `shared`、`common`、`utils`、`kite-config` 或 UI package；不能确定 owner 的代码留在实际 owner app，直到出现
  第二个当前 consumer；
- Runtime Protocol、History DTO 与 Runtime Client 已有 package 继续复用，不再包一层“统一 SDK”。

## 5. 默认 Store owner 与兼容入口

### 5.1 Service identity

V1 的 service root 固定为：

```text
canonical userKiteCodeDir()/runtime-service/v1/
```

它只拥有：

```text
canonical defaultCheckpointPath()
```

`KITE_CODE_HOME` 是 home root override，不直接作为未经解析的 instance key。Service 启动前必须把 state root 与
默认 Store 路径解析为绝对、canonical、非 symlink/reparse identity。

### 5.2 production owner 规则

Service 命令对默认 Store 正式可用的同一发布边界内，必须同时完成：

1. TUI 默认改为 Local Service；
2. foreground `kite run/resume` 默认改为 Local Service；
3. embedded 只允许显式测试/诊断注入的非默认 Store；
4. `server --stdio` 要求父进程显式提供非默认 `--checkpoints`；
5. 所有 custom Store 在打开前与 canonical default Store 比较，相同或 alias 命中时拒绝。

这是一条支持与 composition 规则，不声称抵御同一 OS 用户运行旧 binary、手工打开 SQLite 或恶意删除 lock。
SQLite transaction/revision/lease 继续提供现有 Store correctness；Local Service 负责同一 release 受支持入口的唯一正常
owner。upgrade/rollback 文档必须要求先关闭旧版 foreground CLI/TUI；无法证明旧 owner 已退出时不宣称绝对单 owner，
也不以 process scan 或新 Store fencing 扩大 V1。

### 5.3 迁移期

KLSV1-01～05 不得在普通 production 默认 Store 上形成可误用的第二 owner：

- package/unit/process tests 使用临时 `KITE_CODE_HOME`；
- foreground `service run` 在 KLSV1-06 cutover 前只作为内部/测试入口，或要求显式隔离 home；
- 不发布“连接失败后静默回退 embedded”；
- KLSV1-06 前任一失败都可以整体保持当前 InProcess production behavior。

## 6. Connection-scoped Workspace admission

### 6.1 不修改 Runtime Protocol

Protocol V1 的 create command 继续不携带 workspace。Local Carrier 在 WebSocket 连接前执行：

```text
POST /_kite/connect
Authorization: Kite-Local-Access <access.token>
Body: { "workspace": "<requested path>" }
  ↓
exact body/size validation
  ↓
canonical realpath + Workspace Trust + Project identity
  ↓
返回一次性 connection ticket
  ↓
WS /rpc
Authorization: Kite-Local-Ticket <ticket>
  ↓
ticket 被消费并绑定 AdmittedWorkspace
```

connection ticket：

- 32 bytes cryptographic random material，base64url 编码；
- 只保存在 Service 内存；
- 一次性消费；
- 固定短 TTL，初始值 30 秒；
- 只绑定 instance ID 与 AdmittedWorkspace；
- 不写 descriptor、日志、Store 或 history；
- 失败统一返回固定 `unauthorized`/`workspace_untrusted`/`workspace_unavailable`，不泄露 trust store 内容。

30 秒只是本地启动窗口，不建立刷新、长期 session 或 capability negotiation。

### 6.2 Runtime Server admission seam

Runtime Server Core 仍只消费 admission port。为避免 Server 知道 HTTP ticket 或 Workspace object，`open()` 可接受
一个 App-owned per-connection admission override：

```ts
server.open(connection, {
  admission: connectionAdmission,
});
```

等价实现也可以使用受生命周期约束的 opaque admission key。不得让 carrier path 直接调用 Host，也不得把 token、
ticket 或 Workspace path 加入 Runtime Protocol DTO。

operation mapping：

```text
create_session       → connection AdmittedWorkspace
resume/session query → persisted Session Workspace
fork_session         → source Session Workspace
sessions index       → 当前本地用户 Store 的全部 Session
```

客户端断开只释放 ticket binding、connection 和 subscription，不释放 Session runtime。

### 6.3 Trust 交互

Workspace Trust 的持久 owner 随 Runtime composition 一起迁入 `apps/kite-service`。流程固定为：

```text
CLI/TUI ensure neutral Service
  → access-authenticated trust query
  → unknown/corrupt/unavailable 时 CLI/TUI 显示现有 Trust Gate
  → 用户明确决定
  → exact trust decision command
  → Service 原子写 trust store
  → /_kite/connect 再次读取并验证
```

规则：

- Service 可以在没有 admitted Workspace 时以 neutral cwd 启动，但不得加载 project config、扫描 project Skill、
  连接 project MCP 或创建 Session；
- TUI 继续拥有提示文案和默认 Exit UI，CLI 继续拥有 `--trust-workspace` 用户入口；
- `apps/kite-cli` 不直接读写 trust store，不把“已显示确认”当作 authority；
- trust query/decision 是 `kite-app-contract` 的 exact use case，只接受 canonical candidate identity、当前观察结果与
  明确 decision，不能顺带授予 Full、approval 或 credential authority；
- Service 在 connection admission 时重新验证 trust 与 project identity；任何 drift 以 Service fail closed 为准；
- future Web/Desktop 可以复用同一 DTO，但其 UI、browser auth 与 IPC 不在本计划实现。

## 7. Native Local Carrier 与 History

### 7.1 路由

V1 固定路由：

```text
GET  /healthz
GET  /readyz
POST /_kite/connect
WS   /rpc

POST /_kite/history/list-sessions
POST /_kite/history/list-events
POST /_kite/history/load-session

POST /_kite/app/<exact-current-use-case>

POST /_kite/control/stop
```

不提供静态 assets、CORS、Browser cookie、service restart HTTP endpoint 或 generic JSON-RPC control plane。
`/_kite/app/*` 只允许 KLSV1-00 client dependency manifest 登记的 Workspace Trust、Provider/model、MCP、credential
与 authoritative status use case；每个 route 都有 exact codec 和 capability。不得增加 generic Manager call、任意
method string 或动态 payload。`restart` 由 CLI 顺序执行 `stop → ensure`。

App Control mutation 不复用 Runtime command receipt，也不自动重试。V1 固定保守语义：

- request 使用资源现有 revision/digest/CAS；没有现有 revision 的 use case 使用一次用户动作的 bounded mutation ID，
  只做当前进程 correlation，不新增持久 receipt 表；
- HTTP response 丢失或连接中断返回 `outcome_unknown`；Native client 先执行 exact state query；
- query 已证明目标状态生效时按成功展示；仍不确定时由用户显式决定是否再次操作；
- credential、MCP OAuth、trust 与 config mutation绝不自动重放；
- 所有 App Control mutation 进入同一个 Service `OperationGate`，与 Runtime mutation 一起参与 quiesce；
- read-only query 可以在 ready 状态执行，draining 后统一拒绝。

### 7.2 History transport

History handler 只取得 `RuntimeHistoryClient`，不取得 `RuntimeAccess` 或 Store writer：

```text
exact HTTP request
  → existing RuntimeHistoryClient
  → App exhaustive safe projector
  → RuntimeLogQueryPort
  → SQLite readonly reader
  → exact client-safe response
```

V1 直接映射现有三个 `RuntimeHistoryClient` 方法，不新增第二套 DTO。`list-sessions` 和 `list-events` 保持现有
分页限制；`load-session` 保持当前 complete transcript 语义，不为本机 transport 提前设计流式 transcript 协议。
请求、单 event 与 HTTP header/body 使用固定上限；完整 transcript 的现有内存行为由针对长 Session 的 process test
记录，后续只有出现真实容量问题才另立 pagination/streaming 变更。

禁止返回 raw RuntimeEvent、SQL、SQLite path、Artifact locator、credential 或 Store handle。History failure 使用
现有 client-safe error，并把未知异常映射为固定 `temporarily_unavailable`。

### 7.3 Loopback admission

- 只绑定 `127.0.0.1:0`；V1 不增加 IPv6 双 listener；
- request peer 必须是 loopback，Host 必须精确等于 descriptor 发布的 `127.0.0.1:<port>`；
- Native access/ticket 使用 Authorization header，不使用 URL query、fragment、cookie 或 WebSocket subprotocol；
- `/rpc` 若携带 Origin，只接受 exact loopback origin；没有 Origin 只在正确的一次性 Native ticket 下允许；
- 不设置宽松 CORS，OPTIONS 不提供跨站授权；
- 拒绝 binary frame、oversized frame、malformed JSON、wrong Host/token/ticket 与 ticket replay；
- health/readiness 只返回固定 `ok`/`ready`/`unavailable`，不返回版本、Workspace 或 Session；
- 复用 development carrier 已验证的 frame queue、heartbeat、backpressure 与 drain core，抽取共享 primitive，
  不复制两份 socket 状态机；development policy 与 production Native auth policy 保持不同入口。

### 7.4 Token

状态目录包含两种 restart-scoped token：

- `access.token`：Native connect、Runtime WebSocket ticket、History；
- `control.token`：只允许 stop。

两者独立随机生成、每次 Service restart 更换。`status` 只使用 strict descriptor、低敏感度 readyz 与 initialize
handshake，不增加 control status route。control endpoint 拒绝 access token、cookie 和带 Origin 的请求；connector/TUI
connection 不读取 control token，只有独立 lifecycle manager 在显式 stop/restart 时读取。development 单-cookie auth只复用随机数、constant-time compare 和安全清理
primitive，不复用其单 session 状态模型。

## 8. Service state、发现与跨平台锁

### 8.1 状态目录

```text
userKiteCodeDir()/runtime-service/v1/
├─ instance.json
├─ access.token
├─ control.token
├─ instance.lock/
└─ lifecycle.lock/
```

V1 不增加长期 service log、日志轮转或 crash telemetry。启动失败通过 readiness channel 返回；运行期只使用现有
本地固定 diagnostic code，不记录 token、path、command body 或 Session 内容。若真实排障证明缺少本地日志，再以
独立 owner 文档增加有界日志。

POSIX state root 使用 owner-only mode；Windows 使用当前用户专用 ACL。root、descriptor、token 与 lock identity
拒绝 symlink/reparse point、非普通类型和 owner/ACL drift。descriptor 采用同目录临时文件、fsync/flush、原子 rename
后严格回读；token 在 listener 启动前创建，但 descriptor 只在 Host、History 和 listener ready 后发布。

### 8.2 Descriptor

```ts
interface LocalRuntimeServiceDescriptor {
  readonly schema: 'kite.local-runtime-service.v1';
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly endpoint: {
    readonly origin: string;
    readonly websocketUrl: string;
  };
  readonly protocolVersion: 1;
  readonly clientContractRevision: string;
  readonly serverVersion: string;
  readonly buildId: string;
}
```

descriptor 不包含 token、Workspace、Store path、executable path、API credential 或 Session 数据。`instanceId`
是 Service process identity，并与 Runtime Server initialize 的 instance ID 保持一致。`clientContractRevision` 是
`kite-app-contract` + Native local HTTP exact codec 的固定 V1 revision/digest；`buildId` 在 installed candidate 中等于
candidate manifest ID，source/dev run 使用包含 Git commit 的明确 `dev:<commit>` identity。

### 8.3 Lock

为避免引入 POSIX `flock`、Windows `LockFileEx` 和新的 native helper，V1 使用同一 filesystem 上的原子目录创建：

```text
mkdir lifecycle.lock
mkdir instance.lock
```

锁目录内只有 exact identity：

```ts
interface LocalServiceLockIdentity {
  readonly schema: 'kite.local-service-lock.v1';
  readonly nonce: string;
  readonly pid: number;
  readonly operation?: 'ensure' | 'start' | 'status' | 'stop' | 'restart';
  readonly instanceId?: string;
  readonly createdAt: string;
}
```

边界：

- `lifecycle.lock` 串行 ensure/start/stop/restart，持有时间有界；
- `instance.lock` 在 Service 生命周期内存在；
- 目录存在不是健康证明，健康只由 descriptor endpoint initialize 后的 instance ID 相等证明；
- handshake 健康时不得清理 lock；
- handshake 失败且能确认记录 PID 不存在时，可原子隔离并清理 stale state；
- PID 存活、PID identity 无法确认或状态目录发生 identity drift 时，返回 `service_unavailable`，不启动第二个 Service；
- 不因 lock 文件残留永久删除用户 Store，不根据 lock PID 直接 kill；
- 这是 App 进程协调，不是 Host/SQLite correctness proof，也不抵御同一用户恶意篡改。

该设计选择安全的 false negative，而不是为罕见 PID reuse 提前增加跨平台 native lock。若三平台 qualification
证明目录锁无法满足原子创建或 stale recovery，再由追加 ADR 选择 OS primitive，不能在实现中临时分叉。

`lifecycle.lock` 同样需要 orphan recovery：获取失败时 strict read owner identity；owner 已确认退出时先原子 rename
到 quarantine，再重取 lock；owner 存活时先做 descriptor/initialize handshake。若 Service healthy 且原 lifecycle owner
已经退出，可以清理 orphan lifecycle lock；PID identity 不确定时保持 fail closed。必须覆盖 parent 在 child ready/descriptor
发布后、释放 lifecycle lock 前崩溃的窗口。

### 8.4 Ensure

```text
1. canonicalize/validate service root 与 default Store identity
2. 获取 lifecycle.lock
3. strict read instance.json
4. 连接 endpoint，完成 Runtime initialize
5. 比较 protocolVersion + clientContractRevision + instanceId
6. healthy：返回 descriptor；build mismatch 只返回诊断
7. unhealthy：按 lock/PID/identity 规则确认 stale；不确定则 fail closed
8. detached spawn 当前 executable 的 `kite service run`
9. child 原子取得 instance.lock
10. child 打开 Store，启动 Runtime Application 和 listener
11. child 原子发布 descriptor
12. child 通过独立 readiness pipe/handle 返回 exact instance ID
13. parent 回读 descriptor 并再次 initialize
14. 释放 lifecycle.lock
```

不通过 stdout 解析 readiness；Service stdout 不承担协议或 lifecycle。startup/stop deadline 固定有界，测试可以注入
clock/spawn，但 production caller 不能修改安全上限。

## 9. Service lifecycle、版本与进程环境

### 9.1 CLI

最终公开 CLI surface 为：

```bash
kite service ensure
kite service status
kite service status --json
kite service stop
kite service restart
kite service run       # 内部前台入口
```

`status --json` 的 stdout 只输出一个 exact JSON object；诊断写 stderr。V1 不提供 install/uninstall/force/open。
KLSV1-03～05 只实现 App-private manager 与 child entry，不在普通 CLI parser 注册这些命令；KLSV1-06 与默认
Store clean cutover 同时公开最终命令，避免可公开启动的 Service 与旧 InProcess owner 并存。

状态：

```text
absent → starting → ready → quiescing → draining → absent
```

`stale` 只是发现诊断，不是 Service 自己发布的稳定状态。

### 9.2 Stop

普通 stop：

```text
control token admission
→ Service OperationGate quiesce Runtime + App Control mutations
→ wait admitted Runtime/App mutation critical sections idle
→ inspect active Runtime operations
```

有 active operation：

```text
resume admission
→ 返回 service_busy
→ Service 保持 ready
```

无 active operation：

```text
commit drain
→ 拒绝新连接
→ Runtime Server drain
→ Runtime Application/Host/Store close
→ listener close
→ 删除 descriptor/token/instance.lock
```

`OperationGate` 必须覆盖 Workspace Trust、Provider/config、MCP config/auth/retry、credential write 等 Service-side
mutation。任一 App resource close 失败或超时都保留 descriptor/lock evidence，不得先清理 state 再报告失败。

进程 `SIGINT`/`SIGTERM` 是 owner shutdown，不等同普通 stop：它停止 admission、调用现有 cancel/recovery-safe Host
disposal、等待有界 settlement 后关闭；超时保留 stale evidence，由下次 ensure 安全判断，不能提前删除 state 并启动
第二个 owner。V1 不实现 `stop --force`。

### 9.3 Version

- Runtime initialize 校验 exact Protocol V1 与 instance ID；
- descriptor 独立校验 exact client contract revision，并暴露 server version/build ID；不修改 initialize schema；
- protocol 不兼容：拒绝连接；
- Runtime protocol 或 client contract 任一不兼容：拒绝连接，要求显式 restart；
- 两者兼容、build 不同：允许连接并返回 `healthy_with_build_mismatch` 诊断；
- ensure 不自动重启 busy/idle Service；用户或 installer 显式 restart；
- restart 先执行普通 stop，`service_busy` 时终止，不隐式取消 work；
- installer 替换 managed binary 前调用普通 stop，失败则不替换当前 candidate；
- release rollback 同样先停止 Service；不实现 daemon 内自动 updater。

### 9.4 Neutral process environment

Service identity 不能直接相信调用者 cwd 已加载后的 ambient `KITE_CODE_HOME`。KLSV1-00 必须冻结一个可信
`KiteHomeIdentity` resolver：production 默认来自 OS user home；custom home 只来自显式 CLI/process argument 并经过
canonical/no-follow 校验，测试通过依赖注入传入。Workspace `.env` 中的同名变量不得改变 Service root、descriptor 或
default Store identity。

Service child 使用 state root 下专用、owner-only、预先验证为空且禁止 `.env*`/`bunfig`/loader 文件的 neutral cwd，
不使用请求 Workspace或普通 `userKiteCodeDir()` 本身作为 cwd。spawn env 由 App 显式构造，不使用
`{ ...process.env }` ambient spread：

- 显式传递 canonical `KITE_CODE_HOME` 与运行时需要的系统变量；
- 只保留当前产品已经支持的 user/provider environment allowlist；
- 删除会改变 loader、runtime injection、debug preload、project-relative config 与 child execution 的未知变量；
- Service 可以由未 admitted Workspace 的 TUI/CLI ensure，但启动期间不得读取调用者 project data；trust decision
  必须随后通过 exact App Control use case 完成；
- process-wide user/provider 配置在 Service start 时确定，改变后通过显式 restart 生效；
- project config、Skills、MCP 与 filesystem authority 只能在 admitted Workspace context 中解析。

KLSV1-00 baseline 必须列出现有 production entry 实际读取的 environment key，不能凭猜测扩大或删除。若现有 Provider
依赖无法在显式 allowlist 下保持行为，KLSV1-06 不得切换默认入口；不得以继承全部环境作为临时 fallback。

## 10. Native Kite Client 与 reconnect

`@kite-ai/kite-local-runtime/client` 组合：

```ts
interface LocalKiteConnection extends AsyncDisposable {
  readonly runtime: RuntimeClient;
  readonly history: RuntimeHistoryClient;
  readonly app: KiteAppControlClient;
  readonly service: LocalRuntimeServiceDescriptor;
}
```

职责：

- ensure/discover、strict descriptor/token decode；
- connection admission 与 WebSocket transport；
- instance ID 校验；
- explicit reconnect/resubscribe；
- History/App Control endpoint 随 instance 更新；
- observable connection status。

不拥有：

- control token、stop/restart；
- Store/SQLite；
- mutation automatic retry；
- Server process handle。

断线语义：

- connection generation 变化立即清空旧 Session readiness 和 ephemeral buffer；
- reconnect 后重新建立 sessions/session subscriptions；
- authoritative index reset 可以建立低于旧内存的当前 revision；
- History resync 使用新的 authenticated History Client；App control snapshot 按各 use case generation/revision
  重新取得，不能复用旧 Manager object；
- mutation response 丢失时原 Promise 返回 `connection_closed`，调用方若重试必须复用原 command ID；
- connector 绝不自动重放 mutation，也不把 disconnect 解释为 cancel。

`apps/kite-cli` 只组合这个 Native client，不读取 descriptor/token file，不实现第二份 discovery/HTTP/WebSocket
transport。future `apps/kite-app` main 可以复用同一 client；future `apps/kite-web` 与 Desktop renderer 在静态 Gate
中禁止导入整个 package。Browser transport 和 Desktop IPC 等真实 consumer 出现后另立计划，不在本 package 预留
空 adapter 或环境分支。

## 11. 分阶段实施

### KLSV1-00：ADR、baseline 与文档 owner（已完成）

完成证据：ADR-0144 已接受，并且只局部取代 ADR-0053 的单 trusted Workspace cardinality 与 ADR-0142 的
单 Workspace Server/App composition 结论；Web/hosted/multi-user No-Go、Protocol V1、State 27/Store 6、History
query-only 与唯一 Runtime authority 均保留。[事实与依赖基线](../understanding/2026-08-27-kite-local-runtime-service-v1-baseline.md)、
[261-file relocation manifest](../understanding/2026-08-27-kite-local-runtime-service-v1-relocation-manifest.md) 和
[workspace/path Gate manifest](../understanding/2026-08-27-kite-local-runtime-service-v1-integration-manifest.md) 已冻结 owner、
client use case、method map、environment、release runner 与 phased documentation-map convergence。该状态只关闭架构与
实施清单 Gate，不表示 listener、Service process、connector、default Store cutover 或平台 qualification 已完成。

交付：

- 新增追加 ADR，明确取代 ADR-0053 的“单 Workspace production topology”和 ADR-0142 的“每 Server instance
  固定一个 Workspace”局部结论；Web/hosted/multi-user No-Go 保持；
- 冻结 `apps/kite-cli`、`apps/kite-service`、`kite-app-contract`、`kite-local-runtime` 的依赖与 public export
  边界，以及 future Web/Desktop 的 forbidden import；
- 冻结默认 Store service-only、custom Store 规则、Native-only auth、History route、目录锁 fail-closed 边界；
- 建立 current `apps/kite/src/**` 逐文件 relocation manifest、TUI direct dependency/use-case manifest、environment
  key、CLI/TUI method-to-client API migration、release internal runner/entrypoint 与 documentation impact baseline；
- 建立完整路径/门禁注册表，至少覆盖 root package/tsconfig/bun.lock、runtime package checker、default/owned test
  runners、pre-release/core/test-ownership/compaction gates、root integration/fixture、release scripts、workflow path filter、
  docs map；
- 冻结 trusted Kite home resolver、neutral cwd、client contract revision、installed/dev build ID、release internal runner
  迁移和现有 standalone keyring `unavailable` 限制；
- 冻结 `docs/documentation-map.json` 的分阶段代表路径与 owner；validator 要求 source base/authority 已存在，因此
  KLSV1-01/02/04 在各 workspace/README 实际建立时原子写入对应规则，不创建 fake empty workspace 或无效 future rule；
- 不创建 listener、CLI command 或 production code。

Gate：ADR accepted；每个现有 App 文件和 TUI direct dependency 有唯一 target owner；默认 Store alternate owner、
History、App Control 与 Workspace admission 无未决 transport；文档检查通过。

回滚：撤回 ADR 接受和三份非权威 baseline 后保持 draft；零代码、零入口。

### KLSV1-01：机械重命名 `apps/kite` 为 `apps/kite-cli`（已完成）

完成证据：455 个 tracked App 文件已整体移动到 `apps/kite-cli`，package identity 为
`@kite-ai/kite-cli`，workspace-local alias 只保留 `#kite-cli/*`；`./cli`/`./tui` exports、`kite`/`kite-tui`
binary、InProcess composition、Store 与 candidate payload 保持不变。Root manifest/tsconfig/bun.lock、runtime/core/
pre-release/test-ownership/compaction Gate、default/owned runner、root helper/fixture、release resolver、workflow filter、
current docs 与 documentation map 已同步。非历史旧 path/package/alias 只剩显式 retired-alias rejection/negative fixture。
`check:runtime-packages`、`check:pre-release-architecture`、`check:core-boundary`、`check:test-ownership`、
`check:compaction-legacy`、typecheck、10-workspace build、App owner runner（154 parallel + 32 isolated）、stdio/WebSocket/
transport（18 + 24 + 3 tests）、release subset、docs impact/docs 全部通过。按本 Task Gate 未重复完整 PTY、native
candidate 或 release smoke。

交付：

- 机械移动 `apps/kite → apps/kite-cli`，package name 改为 `@kite-ai/kite-cli`；
- 更新 root module/scripts、tsconfig paths、test runner/ownership、runtime package checker、workflow path filters、
  release entrypoint、docs map 和 README link；
- `apps/kite-cli` 使用 workspace-local `#kite-cli/*` alias；后续 `apps/kite-service` 使用 `#kite-service/*`；删除全局
  `#app/*`/`@/app/*`，两个 alias 不得解析到另一个 app；
- 同步更新 `bun.lock`、root integration/fixture、pre-release/core/test-ownership/compaction gate 与 release helper；
- 保持所有源码相对结构、public `./cli`/`./tui` exports、InProcess composition、CLI/TUI behavior、Store 和
  candidate payload不变；
- 同步移动并更新 `apps/kite-cli/README.md` 与 owner-local 文档路径；
- 本 Task 不新增 `apps/kite-service`，不移动 frontend/backend owner，不顺手重构代码。

Gate：旧 `apps/kite/` production/test/workflow/release path 与旧 alias 引用为零（历史文档除外）；package graph、
typecheck、静态 gates、App test discovery 与 release contract tests保持等价。完整 PTY/native candidate smoke留到
KLSV1-06/07，rename阶段不重复重型验证。

回滚：纯路径 rename 整体回滚；零行为和格式变化。

### KLSV1-02：Frontend contract、Native substrate 与 client/server seam（已完成）

完成证据：新增 browser-safe `@kite-ai/kite-app-contract` 与只有 `./client`/`./service` 出口的 Bun/Node-only
`@kite-ai/kite-local-runtime`。App Contract 为 Workspace Trust（含 revision CAS）、Provider/model、MCP、Skill、
execution/release status 提供独立 exact no-secret codec 和 closed `KiteAppControlClient`；Native package 固定 descriptor、
token、lock、state layout、lifecycle/raw credential codec、`LocalKiteConnection`/manager interfaces 与 exact
`kite-local-runtime-contract-v1` revision，但不实现 listener、filesystem mutation、spawn 或 lifecycle state machine。
CLI 的 Runtime/History facade 已删除 `Omit<SessionManager>`、Manager/SessionRuntime Proxy、Reflect fallback、dynamic member
cache 与 set trap；新增 App Control InProcess adapter，让 9 个当前 use case 的 request/response 都经过同一 exact codec。

Package graph 当前为 12 workspaces / 25 edges，唯一 composition root 仍是 `apps/kite-cli/src/bootstrap.ts`；两个新 package
已加入 build/typecheck/default test、standalone resolver 与 documentation-map 互斥 owner。12-workspace typecheck/build、
runtime package/core/pre-release/test-ownership Gate、42 个 package checker tests、12 个 package codec tests、9-use-case
App Control/facade/history tests、release resolver tests、docs impact/docs 与 browser/native build 全部通过。该状态不表示
TUI direct config/MCP/Skill dependency 已迁移、Service/listener/process 已存在或默认 Store 已切换。

交付：

- 新增 browser-safe `packages/kite-app-contract` 与 Bun/Node-only `packages/kite-local-runtime`；
- 把现有 TUI direct dependency manifest 映射为 UI-local、Runtime、History、App Control、Runtime-only 五类；
- 为当前 Workspace Trust、Provider/model、MCP、credential、authoritative status journey 定义最小 exact
  App Control DTO/codec；不实现 future Web/Desktop use case；
- browser-safe 根出口只含无 secret projection/action；descriptor/lifecycle/raw credential codec进入 Native-only出口；
- 固定 App Control mutation 的 CAS、`outcome_unknown → query state → user decision` 和无自动重放语义；
- 定义 Native state/client/service 窄 exports 和 package graph/static forbidden import；
- 在 `apps/kite-cli` 内先以 InProcess adapter 实现 `Runtime + History + App Control` client facade，行为不变；
- 同步新增两个 package README 与 package graph/current owner文档；
- 不创建 listener、service process 或第二 Runtime composition。

Gate：两个新 package 都有 README、manifest、typecheck、consumer test 与 browser/native build boundary；contract
无 I/O/React/Ink，native package 无 Host/Server/Builtin/SQLite；TUI fake facade 覆盖全部 direct dependency manifest，
不存在 Manager/object passthrough。

回滚：移除尚未进程外使用的 package 与 facade；当前 InProcess behavior保持。

### KLSV1-03：Runtime Application、多 Workspace 与 App Control owner 拆分（已完成）

完成证据：`apps/kite-cli`内新增UI-free Runtime Application、共享operation gate、canonical Workspace
context factory/router、shared interaction broker与六类exact App Control handlers/owners；Runtime Server支持
per-connection admission与connection close hook。真实SQLite integration使用一个Storage owner、一个Host和一个
coordinator registry同时运行双Workspace及同Workspace多Session，从唯一Store重启hydrate persisted identity，并让
B→A create/resume/query/subscribe/fork全部fail closed。broker-backed ask_user在原展示client断开后可由另一client
settle，TUI exit/client dispose不再`abortAll`或隐式shutdown owner。Workspace Trust、Provider/model、MCP、Skill、
execution/release与Native first-run credential已经切到exact client；credential lost/throw只query一次且不重放，
取消signal透传discovery。

12-workspace typecheck、runtime package/core/pre-release/test-ownership/compaction Gate、packages=12 / edges=26 /唯一
composition root、144 focused tests / 919 expects、runtime package checker 42 tests、App owner suite 168 parallel files
（1969 tests / 8499 expects）加35 isolated files、first-run真实PTY 3/3、docs-impact/docs均通过。当前仍是
`apps/kite-cli` app-local InProcess owner；没有`apps/kite-service` process、production listener、第二Host/Store、
app-to-app import、silent fallback或默认双owner。raw Runtime event/history projector与concrete bootstrap仍在CLI
app-internal transition path，留待KLSV1-06 relocation；本地结果不冒充KLSV1-07三平台/release evidence。

交付：

- 在 `apps/kite-cli` 当前 InProcess owner 内，从 `createKiteTuiSessionManager()` 抽出可迁移的
  `KiteRuntimeApplication`、Runtime execution bridge 与 `KiteAppControlService`；
- 建立 `RuntimeExecutionBridgeRouter`、`RuntimeWorkspaceContextFactory` 与 Service-owned
  `RuntimeInteractionBroker`，关闭单 Bridge/单 Workspace/UI waiter耦合；
- TUI adapter 只消费 KLSV1-02 client facade，不再持有 Config Repository、CredentialBroker、MCP Supervisor、
  Runtime storage 或 execution manager；
- 按逐方法 manifest 完成 `TuiRuntimeClientFacade` replacement，不把 `SessionRuntime` object 跨 client seam；
- 新增 `RuntimeWorkspaceAdmission`；create canonicalize/trust/project identity，resume/fork 按持久 State identity；
- Runtime Server 支持 App-owned per-connection admission override 或等价 opaque key；
- config/Skill/MCP/model/filesystem composition 按 canonical Workspace 隔离；
- 拆分 Service boot 与 Workspace execution context，保证无 Provider config/API key 仍可启动 App Control；
- 明确迁移 raw Runtime Event/History projector 到 Service side、safe presentation facade 到 CLI side；
- InProcess tests 覆盖两个 connection/Workspace 与全部 current App Control journey，不创建 network listener。
- 同步更新 Runtime architecture/authority、Workspace Trust 与 App owner-local current docs；

Gate：Runtime Application/App Control 无 Ink/React/TUI reducer；CLI/TUI client layer 无 Manager/Store direct access；
两个 Workspace Session 同 Host 并发，跨 Workspace 改绑与 config/MCP/Skill 串线 fail closed；现有 journey 等价。

回滚：整体恢复原 InProcess composition；没有 listener/Store migration。

### KLSV1-04：`apps/kite-service` shell 与 Native Service infrastructure（已完成）

完成证据：新增private `@kite-ai/kite-service`，以required ports组合bounded lifecycle shell、真实
`127.0.0.1:0` Native carrier、Native state/descriptor/token/目录锁、neutral env、internal executable与App-private
manager；另有detached child fd3 readiness与conservative PID probe adapter。carrier固定access/control分离、30秒
hash-only one-shot ticket、per-connection admission、History与10个exact App/Native use case、control stop及bounded
frame/queue/heartbeat；manager串行ensure/status/stop/restart，descriptor/instance lock/PID/Protocol/client-contract/token/
build identity exact，alive/uncertain spawn=0且dead-only stale cleanup，不kill、不从stdout读取readiness。

Service owner suite为23 parallel tests加5个isolated文件（carrier 10、manager 27、Native adapter 2、Native process 1、
infrastructure 2），`kite-local-runtime`为15 pass/1 Windows skip；13-workspace typecheck/build、runtime package graph
（13 packages / 32 edges /唯一concrete composition `apps/kite-cli/src/bootstrap.ts`）、core/pre-release/test-ownership、
docs-impact/docs均通过。当前Runtime/History/App Control仍由fake/in-process ports注入，默认Host/Store/raw History
projector仍在CLI；没有public `kite service *`、KLSV1-05 connector、KLSV1-06 cutover、Web/Desktop/OS Service或
三平台/release evidence。Windows state因缺verified ACL/reparse checker明确`unsupported`，留待KLSV1-07。

交付：

- 新增 `apps/kite-service` workspace、internal executable 和注入式 Runtime Application port；
- `kite-local-runtime/service` 提供 state/descriptor/token/目录锁 primitive；
- `127.0.0.1:0` production carrier、connect ticket、Runtime WebSocket、History HTTP、exact App Control HTTP、
  control stop handler；
- Service-level `OperationGate` 同时包住 Runtime 与 App Control mutation；
- neutral cwd/env、signal shutdown、readiness channel；
- App-private `ensure/status/stop/restart` manager 与 machine-readable result；
- detached spawn、lifecycle/instance directory locks、strict stale recovery、instance ID handshake；
- startup/stop deadline 与 machine-readable stable error；
- source executable 与 installed standalone executable resolution；
- build mismatch diagnostics，不自动 restart；
- client contract revision/build ID exact identity 与不兼容拒绝；
- lifecycle lock owner crash/orphan recovery；
- development/production carrier 共享 socket/backpressure primitive但使用不同 auth policy；
- process tests 注入 fake Runtime/History/App Control application，所有 state 使用隔离 home。
- 同步新增 `apps/kite-service/README.md` 和 carrier/state/auth/resilience current docs；

普通 CLI parser 暂不注册最终 `kite service *` 命令；process tests 直接调用 manager 或隔离的 internal child entry。

Gate：wrong Host/token/origin、ticket replay、symlink/reparse、permission drift、oversized/binary/malformed input fail
closed；并发 ensure、crash publish windows、stale/PID race、stop/restart、stdout purity、startup timeout 全部通过；
`apps/kite-service` 无 CLI/TUI import，仍未拥有真实 default Store。

回滚：删除未公开 Service workspace 与两个未 cutover package consumer；当前 InProcess production 不变。

### KLSV1-05：Native Connector 与 Service transport integration（已完成）

完成证据（2026-08-27）：`kite-local-runtime/client`已组合exact descriptor/access discovery、one-shot ticket、
Runtime WebSocket、三个History route、exact App Control与Native credential；HTTP响应绑定Service instance/identity
generation，reconnect后旧instance迟到响应拒绝，History transcript复用closed `RuntimeClientEvent` validator。CLI新增
opt-in typed connection view，client close不发Session cancel或Host dispose，close fault保持可观察且不重复不确定清理。
未公开process harness以真实detached child、Native state/listener、Runtime/History/App Control socket验证restart identity、
generation reset、完整History与client disconnect后Session继续可读；credential lost response单元与真实carrier证据均无
自动重放。定向结果为connector 6 pass/27 expects、CLI adapter 4 pass/20 expects、process harness 5 pass/37 expects；
完整`kite-local-runtime`为21 pass/1 Windows skip，Service owner suite为70 pass。stage前docs-impact/docs、13 workspace
typecheck、runtime package 13 workspaces/32 edges、core/pre-release/test ownership与Biome均通过，唯一composition root仍是
`apps/kite-cli/src/bootstrap.ts`。本Task没有default Service owner、真实Host/Store relocation、process-restart fake Session
持久恢复、PTY release journey或三平台qualification；这些分别留给KLSV1-06/07。

交付：

- `kite-local-runtime/client` 的 Runtime + History + App Control connector；
- `apps/kite-cli` Service-mode adapter 与 process/PTY harness；
- 通过 `apps/kite-service` 的 injected fake application 验证真实 child process、Runtime/History/App Control transport；
  actual Runtime Application owner 在 KLSV1-06 一次性移动，KLSV1-05 不允许任何 app-to-app import 或 backend 复制；
- reconnect/resubscribe/history/app-control resync；
- lost response 使用原 command ID 的显式 retry seam；
- PTY/process harness 可选择 Service mode，但普通默认仍未切换。

Gate：instance mismatch 拒绝；service restart 后 index 重建；ephemeral 清空；完整历史恢复；Turn/approval 在 client
关闭后继续；没有 silent embedded fallback。

回滚：删除 opt-in harness；production 仍是 InProcess。

### KLSV1-06：唯一 composition root 迁移与默认 Store clean cutover

这是唯一 release-blocking atomic cutover，不把它描述为普通小 Task。交付必须在同一 tranche 完成：

- 注册最终 `kite service ensure/status/stop/restart` CLI surface；
- 按 KLSV1-00 relocation manifest 把 Runtime Application、bootstrap/runtime、Runtime session/tool、carrier、History、
  service-owned config/credential/MCP/sandbox/git/session logging 移入 `apps/kite-service`；
- `apps/kite-service` 成为唯一 production RuntimeHost/RuntimeServer/SQLite/Builtin composition root；
- `apps/kite-cli` 只保留 CLI/TUI/presentation、UI-local preference 和 `kite-local-runtime/client` composition；
- TUI 默认 Local Service；
- foreground `kite run/resume` 默认 Local Service；
- embedded 只接受显式隔离的非默认 Store；
- stdio 要求父进程显式非默认 `--checkpoints`；
- custom path 与 default canonical alias 检查；
- TUI exit 不再 `abortAll()` 或 dispose Service Host，只关闭自身 connection；Ctrl+C 仍发 Runtime cancel command；
- 删除 `apps/kite-cli` 的 Host/Server/SQLite/Builtin execution dependency 和旧 composition 调用点，不保留
  app-to-app import、try-new-catch-old 或复制 backend 文件；
- CLI help、README、TUI 系统场景和 release profile 同步。
- 同步更新 Runtime owner、Workspace Trust、release/control、open-source release、execution platform 与 CLI/TUI
  current authority；

Gate：package graph 只报告 `apps/kite-service` 一个 concrete Runtime composition root；`apps/kite-cli` 不依赖
runtime-host/server/storage-sqlite 或 Runtime execution export；真实 TUI/CLI、Workspace Trust、first-run credential、
model selection、MCP management/auth、history、approval、rewind/fork/compact、双 Client/Workspace 与 PTY exit/reopen
全部通过。

切换默认入口前必须先完成 relocated application compile/build、Service process smoke、TUI fake-client全 journey、
companion candidate layout/manifest/install preflight；只有这些通过才改变 default owner。MCP stdio wrapper、POSIX
supervisor child与内部 RuntimeHost entrypoint必须在同一 checklist中指向 managed `kite-service`。

回滚：只在 Service idle 且普通 stop 成功后执行；busy 时保持当前 candidate/current owner，不强制回滚。stop 后验证
descriptor/token/lock 已由原 Service正常清理，再整体回滚该 tranche 到原 InProcess owner；失败 evidence留存时不得
手工删除 state 后启动旧 owner。Store 6/State 27 未变化，不需要数据迁移；不得在同一 release 中同时保留两个默认 owner。

### KLSV1-07：故障、安全、平台与 release qualification

交付：

- process fault matrix：concurrent ensure、kill、stale state、restart、disconnect、slow client、busy stop；
- Runtime matrix：lost response receipt replay、unknown effect recovery、approval wait、multi-client conflict；
- security negative matrix 与 state-root permission/ACL tests；
- 扩展现有 runtime transport workflow，不新建重复 workflow；
- release candidate 输出 `kite`、`kite-tui` 与 companion `kite-service`；CLI 从 managed manifest 解析 companion，
  installer upgrade/rollback 前执行普通 stop；
- MCP wrapper、POSIX supervisor child mode 与其他 RuntimeHost-owned internal entrypoint 一并迁入 companion
  `kite-service`；CLI/TUI release entrypoint 不再直接 import RuntimeHost；
- standalone candidate延续当前 keyring limitation：需要 native keyring 的 credential/MCP OAuth operation 返回 exact
  `unavailable`，不列为 installed success Gate；source conformance验证 contract，installed smoke验证已知限制仍
  fail closed。KLSV1 不顺带建立新的 keyring qualification；
- `release:smoke` 覆盖 installed ensure/connect/status/stop，三平台返回真实 artifact evidence。

Gate：macOS 15、Ubuntu 24.04、Windows 2025 的 runtime transport、candidate build/verify/smoke 全部成功；本地
fault/soak、TUI PTY、docs/static Gate 全部通过。workflow 定义或本地测试不能冒充三平台结果。

回滚：未取得三平台结果时保持 unsupported/pending，不写入 production support matrix；不以 force stop 绕过 busy。

### KLSV1-08：最终 evidence 与完成记录

交付：

- 审计各阶段已经同步的 owner/current docs，不把行为文档推迟到本 Task；
- 更新 plans/completion index与最终 documentation map representative matrix；
- 记录 implementation SHA、PR checks、三平台 run、已知限制和实际偏差；
- 将本计划标为 `archived`，新增 completion record。

Gate：`document-before-commit`、docs-impact(all/staged)、docs、typecheck、runtime packages、core boundary、pre-release
architecture、test ownership、compaction legacy、相关 test/qualification、release smoke 全部通过；实现与文档未收敛
时保持 active/blocked，不能宣称完成。

回滚：完成记录只登记真实结果；缺失 evidence 保持未完成，不以计划文字补齐事实。

## 12. Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| KLSV1-00 | KRSV1 complete | 新 ADR、relocation/client-dependency/env baseline、plan/index、docs owner | `bun run check:docs-impact`、`bun run check:docs`、docs integration tests | 文档先行；未 accepted 不写生产代码 |
| KLSV1-01 | KLSV1-00 | `apps/kite → apps/kite-cli` 机械 rename 及所有静态/构建路径 | App/TUI/transport/release 等价 Gate | 纯路径整体回滚，零行为变化 |
| KLSV1-02 | KLSV1-01 | `kite-app-contract`、`kite-local-runtime`、InProcess client facade | package graph、browser/native build、fake facade journey | 未进程外使用，可整体移除 |
| KLSV1-03 | KLSV1-02 | Runtime Application/App Control、多 Workspace、per-connection admission | multi-Workspace、control journey、workspace trust、typecheck | 保持 InProcess；恢复原 composition |
| KLSV1-04 | KLSV1-03 | `apps/kite-service` shell、carrier/history/app-control、manager/state/process | security/process/concurrent lifecycle、fake application tests | 隔离 home；删除未公开 workspace |
| KLSV1-05 | KLSV1-04 | Native connector、Service-mode adapters、真实 process integration | Runtime/History/App Control integration、PTY opt-in、restart/lost-response | 删除 opt-in；production InProcess 不变 |
| KLSV1-06 | KLSV1-05 | Runtime owner relocation、CLI/TUI default cutover、companion packaging | full client journey、package root Gate、TUI PTY、CLI/release smoke | stop Service 后整 tranche 回滚；不保留双 owner |
| KLSV1-07 | KLSV1-06 | fault/security/platform/release qualification | `bun run test:runtime:transport`、`bun run test:runtime:fault`、`bun run test:runtime:soak`、`bun run test:tui:system`、`bun run release:verify`、`bun run release:smoke` | 三平台缺失则不升级支持结论 |
| KLSV1-08 | KLSV1-07 | staged current-doc audit、completion record、index、final evidence | docs/static gates、`bun run typecheck`、相关全量 Gate | 只登记真实结果；不完整则不归档 |

## 13. 测试与资格矩阵

### 13.1 App/package tests

```text
Runtime Application 无 TUI import
TUI/CLI adapter 使用 fake Runtime/History/App Control Client
kite-app-contract browser build 无 Node/Bun I/O
kite-local-runtime native build 无 Host/Server/Builtin/SQLite
apps/kite-cli 无 app-to-app import
apps/kite-service 无 Ink/React/TUI import
RuntimeExecutionBridgeRouter 按 Session/Workspace 路由
RuntimeInteractionBroker disconnect/recovery/identity
raw History projector 只存在于 kite-service
无 Provider config/API key 时 ServiceBootApplication 仍 ready
create/resume/fork Workspace identity
两个 Workspace config/Skill/MCP isolation
per-connection admission cleanup
History exact request/response/error
access/control/ticket separation
descriptor/lock strict codec
```

### 13.2 Process integration

```text
20 concurrent ensure → 1 healthy instance
crash before lock / before ready / before descriptor / after descriptor
parent 在 child ready 后、释放 lifecycle lock 前 crash
dead PID stale cleanup
PID alive + handshake fail → unavailable，spawn=0
PID reuse 不误判 healthy
two stop / stop+restart / ensure+stop race
neutral cwd 与 explicit env
恶意 Workspace .env 不能改变 Service root/default Store
stdout JSON purity
installed executable spawn/readiness
```

### 13.3 Runtime/Client integration

```text
two TUI clients
TUI + foreground CLI
two Workspace sessions
Workspace Trust query/decision through App Control
Provider first-run credential write and model selection through App Control
MCP list/config/approval/auth/retry through App Control
App Control mutation response lost → query state → explicit decision，无自动重放
Runtime protocol compatible 但 client contract incompatible → 拒绝连接
disconnect while model/tool runs
disconnect while approval waits
reconnect index reset + session resubscribe
long complete history load
lost command response + same commandId replay
Service restart durable receipt replay
forced process crash unknown effect recovery
slow client does not block normal client
```

### 13.4 安全负向测试

```text
0.0.0.0 bind attempt
non-loopback peer
wrong Host / Origin / access token / control token / ticket
expired/replayed ticket
access token calls control stop
cookie/browser-style request calls control stop
symlink/reparse descriptor/token/lock/root
world-readable POSIX token / permissive Windows ACL
descriptor 原子发布故障窗口
oversized HTTP/body/header/WebSocket frame
binary frame / malformed JSON-RPC
Workspace realpath/project digest drift
custom Store alias equals default Store
token/path/command absence in diagnostic and observability
```

### 13.5 平台与 release

- 本地开发可做当前平台预检，但 production support 必须来自 GitHub-hosted macOS 15、Ubuntu 24.04、Windows
  2025 的实际 candidate；
- 扩展现有 Runtime transport qualification matrix，不创建含义重复的新 workflow；
- release smoke 必须从安装后的 managed binary 启动 Service，不能只以源码 `bun` 进程代替；
- installer upgrade/rollback 的 busy Service 失败必须保持原 candidate/current pointer 不变；
- KLSV1 不扩大 effectful execution platform support set，Service 可发布不等于 Sandbox/Shell 获得生产资格。

## 14. 文档影响

实施期间按实际行为更新，不提前把计划写成 current fact：

- `apps/kite-cli/README.md`：CLI/TUI、Native client、UI-local preference 与 terminal release entry；
- `apps/kite-service/README.md`、`apps/kite-service/docs/runtime-server-carrier.md`：唯一 Runtime composition、
  Native carrier、App Control、History 和 Service executable；
- `packages/kite-app-contract/README.md`：browser-safe DTO/codec 与 exact use-case 边界；
- `packages/kite-local-runtime/README.md`：Native-only process/state/connector 与 Browser/renderer 禁止依赖；
- `packages/runtime-server/README.md`：per-connection App admission seam，Server 仍不拥有 listener/process；
- `packages/runtime-client/README.md`：Runtime Client 保持 transport-neutral；Native connector 位于独立 native package，
  Client 自动重连/重试边界不变；
- `docs/active/six-concept-runtime-architecture.md`：Local Service 层与唯一 default Store owner；
- `docs/active/runtime-authority-boundary.md`：多 Workspace admission、token/descriptor 真实边界、非 Host fencing；
- `docs/active/runtime-resilience-qualification.md`：Service crash/discovery/reconnect qualification；
- `docs/active/workspace-trust.md`：client UI 与 Service revalidation 顺序、neutral cwd/env；
- `docs/active/sqlite-runtime-log-query.md`：authenticated local History handler 仍为 query-only；
- `docs/active/execution-platform-support.md`：Service release 与 effectful capability 资格分离；
- `docs/active/release-control.md`、`open-source-first-release.md`：candidate entry、upgrade/rollback stop、三平台 smoke；
- `README.md`/`README.zh-CN.md`：只有用户可见默认行为和 CLI 确实改变时同步；
- `docs/documentation-map.json`：新增 local service、carrier、connector、process/release 代表路径的唯一 owner。

架构改变通过新 ADR，不改写 ADR-0053/0142 历史。完成后新增 `docs/space/execution/completed/` 记录，不把计划
中的预期 Gate 当作已通过 evidence。

## 15. 风险、停止条件与回滚

| 风险 | 控制 | 停止条件 |
| --- | --- | --- |
| CLI/Service 再次耦合 | 两个 pure/native package + 禁止 app-to-app import | 任一 app 需要 import 另一个 app 的 production source |
| 浏览器误入 native authority | browser-safe contract 与 Native package 分离 + static forbidden import | `kite-web`/renderer build 需要 FS、spawn、token 或 native package |
| TUI 仍持有 Service manager object | direct dependency manifest + exact App Control projection | Config/Credential/MCP/Store Manager 继续传入 TUI adapter |
| 默认 Store 出现第二 Host | KLSV1-06 同 tranche 切换 TUI/CLI 并禁止 default embedded/stdio | 任一受支持入口仍能创建默认 Store Host |
| Workspace config 串线 | canonical identity keyed composition + 两 Workspace integration | 任一 singleton 依赖当前 cwd/最后一个 Workspace |
| stop TOCTOU | admission quiesce lease + in-flight barrier + Host active check | busy stop 能与新 start/create 并发穿透 |
| stale lock 误启第二 Service | instance handshake；不确定即 fail closed | PID/identity 不确定时仍 spawn |
| History 不完整 | independent exact History transport + long session tests | TUI 需要直接 SQLite 或 notification fallback |
| 启动环境污染其他 Workspace | neutral cwd + explicit env allowlist + 启动前零 project read | 必须 ambient spread 才能保持现有 Provider 行为且无可审计 allowlist |
| 跨平台行为分叉 | 目录锁 + 同一 App 实现 + 三平台 process tests | 必须新增某平台专属 daemon/lock architecture |
| 实现为未来 Web 过度抽象 | 只实现当前 exact App use case 与 Native connector | 当前 Task 引入 cookie/static UI/public SDK 或 future-only adapter |
| 升级中断 active work | 普通 stop busy fail；installer 不 force | 替换 binary 需要静默 cancel/kill |

每个 Task 独立回滚，禁止通过兼容双路径规避问题。KLSV1-06 前，production 保持当前 InProcess；KLSV1-06 后，
回滚必须先停止 Service，再整体恢复旧 composition。因为 State/Store/epoch 不变，不需要数据回迁。

## 16. 第一批提交/PR 边界

建议最多九个可审查 tranche，与 Task 一一对应：

```text
01 docs(local-service): accept KLSV1 boundaries and baseline
02 refactor(workspace): rename kite to kite-cli
03 feat(client): add Kite App contract and Native local runtime substrate
04 refactor(service): split Runtime Application, App Control, and Workspace admission
05 feat(service): add kite-service process, Native carrier, and lifecycle manager
06 feat(client): add Runtime, History, and App Control connector
07 refactor(app): move Runtime owner to kite-service and cut over kite-cli
08 test(local-service): qualify process, security, platform, and release
09 docs(local-service): close current authority and record evidence
```

不得把 Runtime Application 拆分、多 Workspace、detached spawn 和默认 cutover 合进一个 PR。也不得为了缩短 PR 数量
恢复 dual path、silent fallback 或同时打开默认 Store。提交、push 或 PR 前必须按仓库规则执行
`document-before-commit`，并以 staged scope 验证实际提交边界。

## 17. 最终交付定义

KLSV1 完成时，只应新增以下产品事实：

> Kite 的默认 Runtime Store 由 `apps/kite-service` 中一个按需启动、用户级、仅 loopback 可访问的 Local Runtime
> Service 拥有；`apps/kite-cli` 的 TUI 与 foreground CLI 通过 Native Runtime/History/App Control Client 共享该
> Service。一个 Service 可以安全承载多个 trusted Workspace 的 Session，Client 断开不终止 Runtime work。

除此之外，不得宣称已经交付 Web、Desktop、remote access、OS daemon framework、通用多 Store 平台、自动升级或
公共 Local Service SDK。
