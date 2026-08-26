# Kite Runtime Server V1 实施方案（审查修订版）

状态：active

日期：2026-08-26

优先级：P1

替代关系：本计划接管 [`SQLite 会话日志 Server/Web 实施方案`](2026-08-23-sqlite-session-log-server-web.md)
LOGWEB-05～09 命中的 listener/auth/App carrier current authority，并关闭这些未实施旧任务；LOGWEB-00～04
已完成 query-only 产出继续有效。HTTP/SSE、Web UI 与 production log listener 不迁入本计划交付范围。

审查基线：`main@7512c7c68965de5fef769141e5d2dbed45f97e9f`

依赖：ADR-0053、ADR-0129、ADR-0137、ADR-0138、ADR-0140、ADR-0141、ADR-0142，以及当前 Runtime
Architecture、Runtime Authority/Resilience、SQLite Log Query、Workspace Trust 与 Execution Platform
current authority。

并行约束：KRSV1-08 与旧 LOGWEB-05～09 命中同一 listener/auth/App current authority，必须串行；
KRSV1-00 已选择本计划作为单一 owner 并关闭旧任务，后续不得恢复双 owner；
KRSV1-06A/06B 命中 Runtime Host/SQLite Store/Authority/Resilience，必须由单一 tranche owner 完成。

方案来源：用户提供的《Kite Runtime Server V1 计划方案》、当前源码与测试、workspace README、
[`Kite Code 六概念 Runtime 架构`](../../active/six-concept-runtime-architecture.md)、
[`Runtime Authority`](../../active/runtime-authority-boundary.md)、
[`Runtime 韧性验证`](../../active/runtime-resilience-qualification.md)、
[`SQLite Runtime Log 只读查询`](../../active/sqlite-runtime-log-query.md) 和已接受 ADR。

## 1. 审查结论

原方案的核心方向合理，可以作为 V1 的架构基础：Runtime Host 继续拥有 RuntimeAccess、Session
mailbox、生命周期与恢复机制，具体业务执行仍由 App/Builtin bridge 注入；新增 transport-neutral Runtime
Server；TUI、未来 Web 与 Desktop 通过统一 Runtime Client 消费同一语义。Server 是逻辑协议边界，不
要求每个客户端都启动独立端口。

但原方案不能按原文直接开工。审查后需要固定以下修订：

| 原方案判断 | 审查结论 | 修订后的裁决 |
| --- | --- | --- |
| Host / Server / Client 三层分离 | 保留 | Server 只消费注入的 `RuntimeAccess` 与 App 提供的 admission policy，不成为第二 Runtime owner |
| Contract 与 wire protocol 分离 | 保留 | Wire V1 必须冻结显式 command/query/event allowlist，新增 Contract discriminant 不得自动扩大远程能力 |
| TUI 先走 in-process Server | 保留 | 先完成无端口的真实 TUI 切换，再开放 stdio/WebSocket；生产路径不保留旧 Host bridge fallback |
| 建立封闭 Client Event union | 保留并提升为 P0 | 当前开放事件与 TUI `any` 是 wire、安全投影和 Schema 生成的共同阻塞项 |
| Contract 已完整覆盖 durable interaction | 更正 | 当前只是类型预留，TUI/CLI bridge 未完整支持 `respond_interaction`，payload 也缺 State 27 generation/grant/plan identity 等精确绑定；先完成 support matrix 与安全交互投影 |
| 增加 `sessions` scope | 保留但补足语义 | 初始列表必须有 reset/begin/end 或等价 ready 边界，重连时原子替换，不能只连续发送无完成标记的 upsert |
| 使用通用 `runtime/command` | 有条件保留 | RPC method 可保持通用，但 payload 必须是 Protocol V1 的封闭 DTO；Workspace、role 等 App-owned authority 不能由客户端任意提供 |
| 持久 command receipt | 保留并收紧 | 当前幂等 key 是 `command scope session + commandId`，持久主键不能只用 `command_id`；receipt 必须与 Runtime commit 原子写入 |
| State 26 / Store 5 为当前基线 | 更正 | 当前 writer 是 State 27 / Store 5 / SAQ epoch；State 26 只是 ADR-0138 的只读历史 source |
| Runtime Server 与 LOGWEB 共享 listener | authority 重叠，交付不合并 | KRSV1-00 接管 listener/auth current authority 并关闭未实施的 LOGWEB-05～09；HTTP/SSE/Web UI 不迁入 V1，禁止恢复双 owner |
| 同 OS 用户内 stdio/InProcess 无需网络认证 | 保留 | 仍需父子进程 ownership、stdout 协议独占、固定 Workspace admission 和最小 transport capability |
| V1 同时交付完整 Web/Desktop 产品 | 收窄 | V1 完成 TUI/CLI 生产切换、stdio conformance 与 browser/WebSocket development smoke；ADR-0053 解除 Web No-Go 前不创建受支持的 Web 生产入口，完整 Web/Desktop UI 是后续任务 |
| 同时新增 RFC、ADR、Plan | 简化 | 本文件已经是 Plan；实施前新增一份 ADR 固定架构与 Store/LOGWEB 决策，不再复制一份内容相同的 RFC |

因此审查时的结论为：**方向通过，按本修订版进入执行；KRSV1-00 的 ADR、LOGWEB owner
协调和 Store receipt 决策关闭前，不得创建生产 listener 或对外协议承诺。** KRSV1-00 当前已完成，
但 ADR-0053 的 production Web No-Go 仍保持不变。

## 2. 当前事实基线

### 2.1 Kite 主干事实

1. `@kite-ai/runtime-contract` 当前明确是私有、进程内客户端边界；`RuntimeContractBoundary`
   固定 `audience='kite-app'`、`transport='in-process'`。
2. `RuntimeAccess` 已提供 `command/query/subscribe`，可以作为 Server 唯一 backend seam。
3. `RuntimeSubscription` 当前直接包含 `AbortSignal`，只能订阅单个 Session。
4. `RuntimeNotificationEvent` 当前是 `{ type: string } & Record<string, unknown>`；TUI 又将其扩为
   `RuntimeNotificationEvent & any`。这不是可验证的 wire vocabulary。
5. Host 当前使用内存 `receipts`、`pendingReceipts` 和 `commandSignatures`；identity 为
   `runtimeCommandSessionId(command) + commandId`。进程重启后 receipt 不存在。
6. Host 当前每个 Session 最多保留 256 条 durable notification，每个 subscriber queue 上限也是
   256；queue 饱和时先移除 ephemeral，无法容纳 durable 时关闭 subscriber。
7. `afterRevision` 连续时 Host 会重放 durable notification；不连续时发送 committed projection
   snapshot。该 history 只适合短断线恢复，不是完整会话历史。
8. 当前 writer 是 State 27、Store 5、epoch `kite-runtime-saq-v1-2026-08-25`。State 26 / Store 5
   只属于明确支持的历史只读 source profile。
9. 在审查基线中，SQLite Runtime Log Query、App-owned safe projector 与 active 文档已经落地；HTTP listener、
   SSE、Web UI 和 CLI listener 尚未落地，LOGWEB-05～09 当时仍是 active 计划范围。KRSV1-00 随后关闭了
   这些旧任务而未将 HTTP/SSE/Web UI 迁入 V1。
10. `apps/kite` 是唯一 concrete composition root；新增 Server 不得创建第二个完整 Runtime assembly。
11. Contract command union 大于当前生产 bridge 的实际支持集：`respond_interaction` 尚未由 TUI/CLI
    bridge 完整处理，部分 compact/rewind/fork/mode command 也存在客户端差异。Protocol freeze 前必须建立
    Contract、Host router、TUI bridge、CLI bridge 的逐项 support matrix。
12. 当前 `RuntimeInteractionProjection` 只有 id/kind/title/summary，不能承载 State 27 approval generation、
    grant、Plan identity/digest 或 provider/verification 精确身份；不能据此宣称断线后可安全 settlement。
13. 当前 TUI 恢复会话需要完整 durable event history；Runtime projection 与 256 条 notification history
    都不能替代该读取面。TUI cutover 必须同时建立 Runtime History Client seam。
14. 当前 TUI/CLI command ID 生成包含进程内计数/确定性片段；引入跨重启 receipt 前，必须改为“每个
    逻辑 mutation 跨进程唯一、retry 复用同一个 ID”的规则，并支持测试注入 allocator。
15. ADR-0053 将首发支持拓扑限定为本地 TUI 和用户在场的前台 Headless CLI，并把 Web 标为 No-Go。
    本计划不能仅凭 loopback 将 Web 提升为 production-supported。
16. 基线 `bun run check:runtime-packages` 当前覆盖 7 个 workspace、12 条允许依赖边并通过；新增三个
    package 时必须同步 package graph、workspace runner、default/owned tests、build/release 与文档映射。

### 2.2 外部参考的使用边界

外部项目只提供设计参考，不构成 Kite authority，也不作为本计划完成证据。

- 本地核验的 `codex-cli 0.147.0` 提供 app-server `stdio://`、Unix socket、WebSocket、daemon、
  TypeScript/JSON Schema 生成和 WebSocket auth 选项。其生成的 envelope 省略标准 `jsonrpc` 字段，
  且协议包含 Server → Client request。Kite 没有兼容负担，仍采用带 `jsonrpc: "2.0"` 的标准子集，
  V1 不引入 Server-initiated request。
- OpenAI 官方文档在本次审查时未公开足以证明“Codex TUI/exec 一定复用某个 in-process
  app-server client”的稳定契约；本计划不再把该实现细节写成 Kite 的事实依据。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方仓库仍标记为 developer
  preview 并声明会发生兼容性破坏。其
  [Session Projection](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-projection.md)
  文档中“Host 折叠 committed event、Client 接收 schema-validated whole value 和 watermark”的原则
  值得采用；Cordis 动态插件树、slot 系统和动态 Client Bundle 不进入 Kite V1。
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 本身 transport-neutral；V1 对 batch、ID 类型、
  framing 和 method 集做更窄约束。

后续若继续引用 Codex 或 DeepSeek 的具体实现，必须记录核验版本或 commit，不得使用“最新结构”作为
不可复现的架构依据。

### 2.3 本次审查验证

在审查基线运行：

```bash
bun run check:runtime-packages
bun test packages/runtime-contract/test/runtime-contract.test.ts \
  packages/runtime-host/test/notification-projector.test.ts \
  packages/runtime-host/test/runtime-host.test.ts \
  packages/runtime-storage-sqlite/test/log-query.test.ts \
  apps/kite/test/runtime-log-presentation.test.ts
```

结果：Runtime package Gate 通过（7 packages、12 package edges、唯一 composition root 为
`apps/kite/src/bootstrap.ts`）；上述 5 个测试文件共 47 tests 全部通过。该结果只证明第 2.1 节的当前
事实，不证明尚未实现的 Server/Client/Protocol 能力。

## 3. 目标、成功标准与非目标

### 3.1 目标

1. 建立唯一、严格、可生成 Schema 的 Runtime Protocol V1。
2. 建立只依赖 `RuntimeAccess` 与 admission policy 的 Runtime Server Core。
3. 建立 framework-neutral Runtime Client、Runtime History Client seam、reconnect 和 snapshot store。
4. 让 TUI/CLI 的生产 command/query/subscribe 全部经过 Runtime Client + InProcess Server，并保持旧
   Session 的完整历史展示。
5. 在任何可自动重试的进程外 transport 上线前，关闭跨重启 command idempotency 缺口。
6. 提供 stdio conformance 和 development-only loopback WebSocket/reference conformance，为
   Desktop/Web 后续接入提供稳定基础，但不改变首发支持矩阵。
7. 保持 Runtime Log Service 作为完整 durable history 的唯一读取面，不让 Server notification history
   变成第二日志 authority。

### 3.2 V1 成功标准

- TUI/CLI 所有现有 journey 在单一路径 `Client → RuntimeClient → RuntimeServer → RuntimeAccess` 上通过；
- Runtime History Client 能通过 App-owned safe history source 恢复完整旧会话，live/replay 展示等价；
- runtime-protocol、runtime-server、runtime-client 的依赖和环境边界通过静态 Gate；
- Protocol V1 command/query/event 集是封闭 union，unknown/oversized/malformed 输入 fail closed；
- Session 与 Session index 订阅从 subscribe ack 到 ready 无空窗、无通知先于 ack；
- 断线、slow consumer、Server restart 不阻塞 Host，也不取消仍在运行的 Session；
- 同一个已提交 command 在进程重启后重试不会再次 prepare 或 dispatch 外部 effect；
- stdio 与 test/reference WebSocket 使用同一套 Client/Server conformance suite；
- WebSocket 只在 loopback、临时授权、严格 Host/Origin 下通过 development evidence；
- 完整历史仍只从 SQLite Runtime Log Query 读取；
- 文档、ADR、owner README、active authority、文档映射与验证共同收敛。

### 3.3 非目标

- 多用户、租户隔离、云托管、远程账号认证、TLS termination；
- `0.0.0.0`、局域网或公网暴露；
- daemon、Windows Service、远程控制、集群或分布式 Session owner；
- 两个独立 Runtime Host 进程同时拥有同一 live Session；“多客户端”仅指同一 Server/Host 实例的多连接，
  不重新引入 ADR-0127 已删除的进程级 global lock、HMAC 或 authority ledger；
- Server-initiated RPC request、通用插件 ABI、动态 UI 插件；
- 通过 RPC 传输 raw SQLite、raw Runtime Event、Artifact 正文、大文件或 base64 blob；
- 持久化逐 token delta；
- 完整 Web 产品、完整 Desktop 产品或移动端产品；
- 在 ADR-0053 被新 ADR 取代前发布 `kite server --web`、把 Web 写入 production manifest 或宣称
  production-supported；
- 第二 Runtime composition root、第二 Agent Loop 或第二 Session reducer；
- 将协议 V1 宣称为长期公共兼容 API。

## 4. 目标架构与所有权

```text
TUI / CLI              Browser reference           Desktop owner process
    │                         │                            │
    └────────────── @kite-ai/runtime-client ──────────────┘
                              │
                 in-process / WebSocket / stdio
                              │
                    @kite-ai/runtime-server
                   ┌──────────┴──────────┐
                   │ protocol routing   │ transport admission
                   │ subscriptions      │ connection resources
                   └──────────┬──────────┘
                              │ RuntimeAccess
                    @kite-ai/runtime-host
                              │
             Agent Kernel / Builtin Runtime / SQLite Store

完整 durable history（由同一 SDK facade 暴露、保持独立 authority）：

RuntimeClient.history → RuntimeHistoryClient adapter → App exhaustive closed-event projection
                      → RuntimeLogQueryPort → SQLite read-only reader → SQLite Runtime Store
```

### 4.1 Owner 矩阵

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| `runtime-contract` | App 内客户端语义、command/query/projection、封闭 client event、local subscription spec | JSON-RPC envelope、socket、reconnect、Host lifecycle |
| `runtime-protocol` | Wire V1 DTO、codec、method/error map、version、JSON Schema、framing-neutral message | Runtime execution、socket listener、client state、Workspace authority |
| `runtime-server` | Connection 状态机、initialize、routing、subscription multiplex、bounded outbound、shutdown | Runtime Host、Kernel、Builtin、SQLite、Web static UI |
| `runtime-client` | request correlation、reconnect、resubscribe、connection generation、snapshot store、history client interface、transport interfaces | Host、Server implementation、SQLite、React 组件 |
| `runtime-host` | 既有 Session mailbox、revision、execution/recovery mechanism、notification routing、persistent receipt mechanism owner | 具体业务 projection fold、JSON-RPC、WebSocket、TUI 展示、HTTP auth |
| `apps/kite` | 唯一 composition root、具体 Session/client-safe projection、Workspace admission、transport policy、listener、local auth、CLI/TUI/Web 组合 | 复制 Host/Store/Kernel authority |
| Runtime Log Service | durable history query 与 client-safe history projection | Runtime command、实时 execution authority |

### 4.2 固定依赖方向

```text
runtime-contract ───────────────→ ∅
runtime-protocol ───────────────→ runtime-contract + browser-safe codec dependency
runtime-client ─────────────────→ runtime-contract + runtime-protocol
runtime-server ─────────────────→ runtime-contract + runtime-protocol
runtime-host ───────────────────→ agent-kernel + runtime-contract + runtime-spi
apps/kite ──────────────────────→ client + server + host + builtin + sqlite
```

约束：

- `runtime-protocol` 不得静态导入 Bun/Node/App；浏览器入口必须可单独构建；
- `runtime-server` core 只消费抽象 duplex logical-message connection；stdio/WebSocket listener、Bun/Node
  stream 和 process signal 位于 App/carrier 层，不能污染 gateway core；
- `runtime-client` 不得依赖 `runtime-server`、Host、Builtin 或 storage；App 通过结构化 transport endpoint
  将两端组合；
- `runtime-server` 不得依赖 Host concrete type；
- protocol 对 contract 的引用只用于显式、exhaustive mapper，不能直接把未来新增 union member 自动暴露为 wire；
- TUI 切换后不得直接取得 Host/SQLite/Builtin/Kernel authority。
- Server 只校验、路由已完成的 projection；当前具体 projection 由 App-owned bridge/projector 产生，
  不能把 DeepSeek 的“Host folds”字面照搬成第二个 Server/Host domain fold。
- Runtime History Client 只依赖 client-safe history DTO/adapter；InProcess 由 App 注入，Web 后续可映射
  HTTP，任何实现都不向 Client 暴露 `RuntimeLogQueryPort` 的 generic decoded event。

### 4.3 Server backend seam

原方案只注入 `RuntimeAccess` 不足以覆盖网络 admission。V1 使用两个正交 port：

```ts
interface RuntimeServerBackend {
  readonly runtime: RuntimeAccess;
  readonly admission: RuntimeServerAdmissionPort;
}

interface RuntimeServerAdmissionPort {
  authorize(input: RuntimeServerAdmissionInput): Promise<RuntimeServerAdmissionDecision>;
}
```

Admission 只决定连接/transport/client role 是否可以调用某个已冻结的 Protocol operation，并注入
App-owned Workspace/Project facts；它不执行 Runtime command、不修改 revision，也不缓存领域状态。
`clientInfo`、请求 body、Session display name 都不能提升 authority。

## 5. Client Contract 与 wire 安全硬化

### 5.1 封闭 RuntimeClientEvent

KRSV1-01 必须建立完整 discriminated union，替代：

```ts
type RuntimeNotificationEvent = Readonly<{ type: string } & Record<string, unknown>>;
type RuntimePresentationEvent = RuntimeNotificationEvent & any;
```

要求：

- 每个 `type` 的 payload 字段、长度、可选性和敏感度显式定义；
- exhaustive projector 从 current RuntimeEvent 生成 client-safe event；
- unknown current event 不透传 raw object，只产生固定 `unavailable` 表示或不发送；
- reasoning 私有正文、credential、header、内部 path/locator、Provider body 不进入 wire；
- 当前 `RuntimeSessionProjection.workspace` 不能原样成为 Web DTO；Protocol mapper 默认省略或使用
  App-owned display label，绝对路径只在已授权的本地 TUI/CLI surface 按明确 policy 展示；
- TUI reducer 只接受封闭 union，生产代码中的上述 `any` 清零；
- `model.text_delta`、`reasoning.activity` 与 `model.responded` 必须保留同一 model `requestId`；缺失 identity
  fail closed，不能靠 block 邻接或到达顺序猜测回答归属；
- live presentation event 是 UI-ready 增量，不是 Kernel/Store event，也不能作为完整历史事实源。

### 5.2 Local subscription 与 wire spec 分离

```ts
type RuntimeSubscriptionSpec =
  | {
      readonly scope: 'session';
      readonly sessionId: string;
      readonly afterRevision?: number;
      readonly includeEphemeral?: boolean;
    }
  | { readonly scope: 'sessions' };

interface RuntimeSubscription {
  readonly spec: RuntimeSubscriptionSpec;
  readonly signal?: AbortSignal;
}
```

Wire 只传 `RuntimeSubscriptionSpec`。`AbortSignal`、iterator、callback 和 transport handle 永不序列化。

### 5.3 Command 与 interaction support matrix

Protocol freeze 前先为每个 Runtime command 建立以下矩阵，并将任何“不支持”视为显式 gap，不能靠
union 存在就宣称可用：

```text
Contract DTO
→ Host router/bridge
→ TUI client journey
→ CLI client journey
→ Protocol mapper/codec
→ admission role
→ durable/retry semantics
```

尤其先补齐 `respond_interaction`。新的 client-safe interaction 必须是封闭 union，并绑定 settlement 所需
精确身份，例如 `interactionId`、Session revision、approval generation/grant、Plan
`planId/version/structuralDigest`、provider/verification revision。具体字段以 State 27 action 与既有 ADR 为准，
不把 cwd、raw command、grant subject、binding digest、child identity 或内部 path 默认透传给浏览器。

同一 interaction 的过期、重复和两个 Client 并发 response 必须由 Host revision/identity fail closed；Server
不得维护临时 waiter 或自行判断领域终态。

### 5.4 跨进程 command ID

持久 receipt 上线前先替换会在进程重启后复用的 TUI/CLI ID 生成方式：

- 每个新的逻辑 mutation 分配高熵、跨进程唯一的 command ID；
- transport timeout/reconnect 只复用原 ID，不生成新 ID；
- allocator 由 App 注入，使测试可确定性控制，不读取 command body 生成 ID；
- command ID 不携带 Workspace、prompt、path、tool 参数或 secret；
- 不同 Session 可以使用相同 ID 的现有语义若继续保留，receipt identity 仍必须带 scope；如果改为全局
  唯一，必须由 ADR 明确替代当前 Host/test contract。

### 5.5 冻结 Protocol V1 command/query allowlist

保留一个 `runtime/command` method 不等于直接接受任意未来 `RuntimeCommand`。Protocol V1 必须逐项固定：

- 可远程调用的 command/query discriminant；
- 每个必填/可选字段的 JSON-safe codec、未知字段拒绝、字符串/数组/对象/depth 上限、safe integer
  与 revision 范围；
- client-owned 与 App-injected 字段；
- transport/client role 可调用范围；
- Runtime receipt 与 JSON-RPC error 的映射。

特别规则：

- Web V1 绑定一个已通过 Workspace trust 的 App composition；客户端不能用
  `create_session.workspace` 选择任意绝对路径；
- Workspace、Project identity、auth role 和 transport ownership 由 App mapper 注入；
- `commandId` 是有界、非空、稳定的幂等 ID；同一逻辑 retry 必须复用它；
- 新增 Runtime command 后，Protocol V1 默认拒绝，只有显式更新 codec、admission matrix、Schema 和
  compatibility fixture 才能暴露；
- Runtime 的 conflict/rejected/not_found receipt 仍是成功 RPC 的 typed result；只有 envelope、codec、
  auth、overload 和内部协议故障使用 JSON-RPC error。
- 当前 `isRuntimeCommand()` 的浅层检查和缺少完整 RuntimeQuery validator 不得作为 wire admission；所有
  codec 必须在 mailbox/Store/effect 之前完整验证，negative fixture 证明 dispatch 次数为零。

## 6. Runtime Protocol V1

### 6.1 JSON-RPC 2.0 子集

```json
{
  "jsonrpc": "2.0",
  "id": "rpc-1",
  "method": "runtime/command",
  "params": {}
}
```

V1 固定：

- `jsonrpc` 必须精确为 `"2.0"`；
- request ID 只接受有界字符串，不接受 number/null；
- params 只使用 object；
- response 精确二选一 `result` / `error`；
- 不支持 batch、client notification、二进制 frame、任意动态 method 或通用 RPC cancel；
- 收到 batch array 返回 invalid request，不部分执行；
- `rpc id` 只关联一次 request/response，不能充当 `commandId`。

### 6.2 方法和通知

Client → Server request：

```text
initialize
runtime/command
runtime/query
runtime/subscribe
runtime/unsubscribe
server/ping
```

Server → Client notification：

```text
runtime/subscription
server/draining
```

`runtime/subscription` 至少携带 `subscriptionId`、subscription generation 和封闭的 subscription
message。`server/shutdown` 如保留，只允许 stdio owner connection 使用，并由 transport capability 固定；
Web 客户端不获得该 method。

### 6.3 初始化握手

```ts
interface InitializeParamsV1 {
  readonly protocolVersion: 1;
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
    readonly instanceId: string;
  };
}

interface InitializeResultV1 {
  readonly protocolVersion: 1;
  readonly protocolSchema: 'kite.runtime-protocol.v1';
  readonly serverInfo: {
    readonly version: string;
    readonly instanceId: string;
  };
  readonly capabilities: RuntimeProtocolCapabilitiesV1;
  readonly limits: RuntimeProtocolLimitsV1;
}
```

规则：

- 连接状态为 `uninitialized → active → draining → closed`；
- 初始化前只接受 `initialize`；一个连接只能成功初始化一次；
- V1 使用 exact version，不做范围协商；版本不匹配返回稳定 typed error 后关闭；
- `serverInfo.instanceId` 每个 Server process 唯一，不能当持久 Session identity；
- capabilities/limits 由 Server 返回，客户端不能声明以获得额外 authority；
- `clientInfo` 只用于低敏感度诊断，不能授权；
- WebSocket 的 Host/Origin/cookie 校验发生在 initialize 之前。

### 6.4 错误分层

保留 JSON-RPC 标准错误：parse error、invalid request、method not found、invalid params、internal
error；实现错误码至少包含：

```text
-32001 overloaded
-32002 not_initialized
-32003 already_initialized
-32004 protocol_version_mismatch
-32005 unauthorized
-32006 subscription_unavailable
-32007 resync_required
```

Error `data` 只允许固定 code、request correlation 和低敏感度 retry hint；不得返回 stack、SQLite path、
Workspace path、token、command body 或内部对象。

### 6.5 Timeout、重试与跨流顺序

- 同一连接不允许重复的未完成 RPC ID；完成或超时清理后才能复用，但 Client 默认单调分配新 RPC ID；
- Client timeout/断线不等于取消 Server command；结果进入 uncertain，自动重试只能使用同一 command ID
  和新的 RPC ID；
- query 可以用新的 RPC ID 重试；unsubscribe、EOF 和 WebSocket close 只释放订阅/连接资源；
- `overloaded` 是 transport error，不写 command receipt，也不能被映射成 `runtime_busy`；
- 只保证同一 subscription 的 FIFO 与 request/response ID correlation。一个 command 引发的
  subscription notification 可能先于该 command response 到达，Client 必须按 revision/identity 幂等处理；
- 唯一特殊顺序是 subscribe response 必须先于该 subscription 的任何 message。

### 6.6 Transport framing

| Transport | Framing | 规则 |
| --- | --- | --- |
| InProcess | 一个已验证 logical message | 经过同一 codec/conformance；不得绕开 initialize、limits 或 subscription ordering |
| stdio | UTF-8，一行一个 JSON object | stdin 可分片；超过 line limit 且未见换行即关闭；stdout 只承载协议，诊断只写 stderr |
| WebSocket | 一个 text frame 一个 JSON object | 拒绝 binary、多 object frame、超限 frame；auth/origin 在 upgrade 时完成 |

初始上限只是待压测候选值，不是当前 Kite 事实：单 frame 1 MiB、单连接 in-flight request 64、
subscription 64、outbound logical message 256。正式默认值必须由容量基线决定，同时定义单连接 queued
bytes、WebSocket `bufferedAmount`、全局 connection/subscription/queued bytes、JSON depth 与 write drain
deadline。Server 在 initialize result 返回实际 per-connection limits；更改默认值不改变 Protocol V1
Schema，但不得放宽安全测试或全局预算。

## 7. 订阅、重连与 Client State

### 7.1 Subscribe 无竞态顺序

Server 必须先取得 Host subscription 并开始缓冲，再写 subscribe response；同一 subscription 的任何
notification 都必须在 response 之后。随后按序输出：

```text
subscribe response
→ initial replay 或 reset/begin
→ initial items
→ ready/end
→ live notifications
```

如果 response 无法入队，Server 必须关闭 Host iterator，不能留下 orphan subscriber。

### 7.2 Session scope

- `afterRevision` 连续且 history 足够：按 revision 顺序 replay durable notification；
- history 不连续、cursor 超前或 Server 判定不能证明连续：发送 authoritative snapshot/reset；
- snapshot/reset 后客户端接受该 subscription generation 的当前值，即使旧连接缓存 revision 更高；
- ready 后同一 generation 内按 revision higher-wins；
- 相同 Session revision 若出现不同 canonical projection digest，Host/Client 都不得静默覆盖，必须关闭该
  subscription 并进入 `resync_required`；
- 任一 gap 或 reset 都将 timeline 标为 `historyResyncRequired`，完整 durable history 通过 Runtime Log
  Query 回填，不能依赖 256 条 Host history。

### 7.3 Sessions scope

Host 新增同一实例内单调的 `indexRevision` 和全局 Session index publisher；Server 不能从经过自己的
command 推测列表状态。`scope='sessions'` 每次连接/重连发送完整 index reset，不把内存 index revision
解释为跨进程持久历史：

```text
index_reset_begin(generation, serverInstanceId, indexRevision)
→ session_upsert(session projection) * N
→ index_reset_end(generation, indexRevision)
→ live session_upsert/session_remove(indexRevision)
```

Client 在 end 时原子替换列表，因此可以移除旧连接留下、但新快照不存在的 Session。初始化期间发生的
Host 更新先缓冲，end 后按 `indexRevision` 释放。close 通常是 projection upsert；真实删除使用 tombstone
`session_remove`。Session projection 仍以 `sessionId + revision + canonical digest` 去重。初始列表的
Session 数和总 bytes 有界；超过单帧时使用同一 generation 的 chunk，而不是生成不完整快照。

### 7.4 Ephemeral

Ephemeral 固定为 best effort：

- 不持久化、不跨连接重放；
- identity 至少包含 session/work/turn/actor/attempt/stream，sequence 在该 identity 内单调；
- queue 饱和时可合并或丢弃；
- reconnect、snapshot/reset、attempt 或 stream 变化时清理本地未完成 delta buffer；
- 后续 durable projection 修正运行状态，但不伪造丢失的 token/tool progress。

### 7.5 Framework-neutral store

`runtime-client` 提供无 React/Ink 依赖的 observable snapshot：

```ts
interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}
```

至少维护：connection generation、status、server instance、Session index、Session projection、pending
interaction、ephemeral stream、last applied revision、subscription readiness、resync state。旧连接的异步
消息必须因 generation 不匹配被忽略；重复 subscribe 需要 dedupe，dispose 必须关闭 transport/iterator，
一个 observer 抛错不能阻止其他 observer 或破坏 store。React 可用 `useSyncExternalStore`，TUI 使用
callback/selector。

### 7.6 Runtime History Client

TUI cutover 不能只替换 live command/subscribe。`runtime-client` 同时定义只读、分页、client-safe 的
history interface；其 adapter 与 control transport 分开注入：

```text
TUI InProcess → App exhaustive closed-event history adapter → RuntimeLogQueryPort
Web follow-up → authenticated HTTP log adapter → App safe log DTO
Desktop follow-up → parent-owned history adapter
```

History Client 不暴露 generic decoded RuntimeEvent、SQLite path 或 Artifact reader。若 TUI 所需的 transcript
presentation 与现有 Web log DTO 不同，由 App 拥有一个共享的 exhaustive safe source projector 和明确的
consumer DTO mapper，不能让 TUI 直接读取 Store，也不能让 Web DTO 反向成为 Runtime reducer。

KRSV1-05 必须覆盖：冷启动旧 Session、长于 256 条通知的 Session、live → disconnect → history resync、
approval/plan/tool/subagent 的 live/replay 等价，以及损坏/旧格式 Session 的既有 fail-closed 表现。

## 8. 跨重启 command receipt

### 8.1 必须关闭的故障窗口

```text
Client 发送 commandId=A
→ Runtime transaction 已提交
→ response 尚未送达
→ Server/Host 进程崩溃
→ Client 使用相同 commandId 重试
```

当前内存 Map 在重启后无法判断 A 是否已提交。revision conflict 不能替代 receipt：它不能机械证明
原 command 的 target Session、原 revision 与 body digest，也不能为 create/fork 等命令恢复原结果。
当前 TUI/CLI 若在重启后为新的 mutation 复用旧确定性 ID，还会把新操作误识别成 replay；因此第 5.4
节是本阶段前置条件。

### 8.2 推荐持久事实

逻辑记录至少包含：

```text
scope_session_id
command_id
request_digest
target_session_id
original_receipt_json
committed_revision
committed_at
```

主键必须是 `(scope_session_id, command_id)`，与当前 Host `commandIdentity()` 语义一致；
`target_session_id` 单独记录 create/fork 的结果。command body 不落库，只保存 canonical JSON 的 SHA-256
digest。该记录是 Host command admission metadata，不进入 Kernel State，也不使用 HMAC、installation key
或 authority ledger。

### 8.3 原子性

对 applied command：

1. Host 在 prepare 前查询持久 receipt；同 key 同 digest 返回 `idempotent_replay`，不同 digest 返回
   `invalid_command`；
2. bridge/transaction 将 Runtime events、snapshot、provenance 与 original applied receipt 在同一 SQLite
   transaction 提交；
3. transaction 成功后才允许既有 AuthorizedEffect scheduling；
4. commit 前 crash：没有 receipt、没有已提交决策，也没有 effect dispatch；
5. commit 后 response 前 crash：重启读取 receipt，不再次 prepare/schedule；既有 recovery 负责处理已提交
   execution 状态；
6. crash 发生在 commit 后、schedule 前，或 schedule/dispatch 后但 terminal receipt 前时，必须复用既有
   restart reconciliation：前者恢复已提交 work，后者按 durable attempt/effect evidence 收敛为确定结果或
   unknown，不允许 receipt replay 直接冒充 execution completion；
7. rejected/conflict receipt 是否持久化由 ADR 固定；V1 的 exactly-once Gate 至少要求所有 applied
   mutation 持久化。

### 8.4 Store 格式 Gate

当前 Store 5 的 exact DDL 是 current authority。新增 receipt 表或索引不能静默塞入 Store 5。KRSV1-00
ADR 必须在以下路径中明确选择并给出兼容/回滚：

- Store schema bump（预计 Store 6），State 27 是否保持不变；
- current Store 5 Session 的只读 source/atomic target 导入策略；
- receipt retention 与 Session delete/fork/close 的关联；
- receipt pruning 后旧 command 重试的明确结果；只要仍宣称可自动 retry，就不能用 TTL 静默遗忘；
- exact table/index verifier、format marker 和 fault injection 更新。

禁止 sidecar writable database、非原子双写、response 后补写 receipt 或只靠内存 cache 冒充跨重启幂等。

## 9. Admission、安全、背压与生命周期

### 9.1 固定 Workspace 与能力

- TUI/InProcess 从既有可信 App bootstrap 取得 Workspace；
- stdio child 的 Workspace/配置由父进程 spawn 参数和 App bootstrap 固定，wire client 不覆盖；
- Web V1 一个 Server instance 只服务一个已 admission 的 Workspace/Project；
- query/command/subscription 只允许属于该 canonical Project/Workspace scope 的 Session；unknown、跨
  Workspace、symlink/realpath identity drift 在进入 RuntimeAccess 前拒绝；
- token 对应固定 transport capabilities，不接受 body 中的 role、scope 或 path 提升；
- Client 断开不取消 Session work；取消必须是带 revision/identity 的 Runtime command。

### 9.2 Loopback WebSocket

本节只定义 development/reference carrier 的安全下限，不改变 ADR-0053 的 Web No-Go。创建发布入口、
写入 production manifest 或面向用户宣称支持前，必须另立 RFC/ADR，明确取代 ADR-0053 对本地 Web 的
限制，并补齐入口/platform/native evidence；hosted、多用户和跨设备仍不在本计划范围。

- 仅绑定 `127.0.0.1` / `::1`，拒绝 `0.0.0.0` 与非 loopback address；
- 每次启动生成高熵临时 bootstrap secret，不写 Runtime Store/Session Log/remote observability；
- 一次性 bootstrap 后使用 `HttpOnly + SameSite=Strict` cookie；secret 不进入 URL query、浏览器历史或
  WebSocket subprotocol；
- 严格 Host 与 Origin allowlist、无宽松 CORS、固定 CSP/nosniff；
- cookie、token、header 和 command body 不进入诊断；
- `/healthz` 与 `/readyz` 只返回进程/依赖可用性，不返回 Session、Workspace、path 或版本敏感配置；
- local malicious page、DNS rebinding、错误 Origin、重放 bootstrap、过期 cookie 和慢 WebSocket 均有
  negative tests。

### 9.3 Outbound queue

优先级只用于 admission、合并和丢弃选择，不能破坏同一 subscription 的 durable FIFO 或让
notification 越过 subscribe ack：

```text
不可丢：RPC response、subscribe ack、draining/close
不可静默丢：durable subscription message
可合并/丢弃：ephemeral stream
```

队列饱和时先合并/丢弃 ephemeral，并停止读取新的 request；若仍无法容纳 response/durable，则关闭该
connection、return 所有 Host iterator，并要求 Client reconnect/resync。任何慢 Client 都不得阻塞 Host
mailbox、其他 connection、SQLite transaction、Tool execution 或 Server shutdown。

预算同时按 message count 与 encoded bytes 计算，并受 Server 全局 connection/queue ceiling 约束；
WebSocket carrier 还检查 `bufferedAmount`，stdio carrier 使用有界 drain deadline。Qualification 至少覆盖
N 个慢连接与一个正常连接，证明正常连接、Host mailbox 和 SQLite writer 不被拖慢。

### 9.4 Shutdown

`active → draining` 后拒绝新 command，允许有界完成已有 response，取消 subscription pump 并 flush
close signal。连接 EOF/断开只释放连接资源；App-owned process signal 或 private stdio shutdown 才释放
Server/Host composition。stdout flush、Runtime drain 与 process exit 的先后顺序必须有 child-process tests。

## 10. 与 SQLite Log Server/Web 计划的协调

在审查基线中，[`SQLite 会话日志 Server/Web 实施方案`](2026-08-23-sqlite-session-log-server-web.md) 的
LOGWEB-05～09 声明了 loopback listener、local auth、HTTP/SSE、Web UI 和相关文档范围。本计划的
WebSocket/carrier 与其命中同一 current authority，因此必须先完成串行 owner 裁决。

接受本计划时执行以下协调 Gate：

1. 先停止 LOGWEB-05～09 与 KRSV1-08 的并行写入；
2. 选择一个 Git owner 完成新的 ADR；
3. ADR-0142 已选择本计划接管 listener/auth/App carrier current authority，并将 LOGWEB-05～09 标为
   superseded/closed；旧 HTTP/SSE/Web UI 任务未实施，也未迁入 KRSV1 V1 交付范围；
4. 无论选择哪条路径，LOGWEB-00～04 的 SQLite query-only port 和 safe projector 保持不变；
5. 后续独立计划若取代 ADR-0053 并组合 App local carrier，必须保持独立 capability：

```text
/rpc        → Runtime Server，只取得 RuntimeAccess + admission
/api/logs/* → Log Handler，只取得 RuntimeLogQueryPort + safe projector
/healthz    → 固定低敏感度 health
/readyz     → 固定低敏感度 readiness
/*          → 可选静态 Web assets
```

共享 listener/auth 不等于共享 authority。RPC handler 不读取 raw SQLite，Log handler 不取得 command、
transaction、effect、checkpoint 或 delete capability。

ADR-0053 尚未被新决策取代，因此本计划只允许测试/开发 carrier，不创建上述日志 HTTP 路由、静态 Web
assets 或 production listener；LOGWEB 的 query-only port 也不能被本计划静默扩成 command server。

## 11. 分阶段实施

### KRSV1-00：ADR、owner 协调与基线（已完成）

完成证据：ADR-0142 已接受；本计划接管 LOGWEB-05～09 的 current authority 并关闭其未实施任务，未把
HTTP/SSE/Web UI 迁入 V1；Store 6 / State 27 / exact epoch 与 receipt
retention 已固定；基线和 workspace integration manifest 位于 `docs/space/understanding/`；`bun run check:docs`
通过。该状态只关闭架构与 owner Gate，不表示后续生产实现已完成。

交付：

- 新 ADR：Host/Server/Client 边界、Protocol V1、Workspace admission、receipt Store 路径、LOGWEB
  carrier owner、V1 产品范围；
- baseline manifest：Runtime command/query/event、TUI journey、package graph、State 27/Store 5、
  当前 LOGWEB 完成边界；
- workspace integration manifest：三个 package README/package.json/tsconfig/exports/tests，以及
  runtime package checker、workspace script runner、default/owned test runner、build/typecheck/release/SBOM、
  test ownership、documentation map 的全部更新点；
- 更新本计划和 plans index 状态；
- architecture checker 的目标规则先以 test fixture 固定，不创建 listener。

Gate：ADR accepted；LOGWEB 串行 owner 已确定；receipt Store 路径无未决项；State/Store 事实已更正。

回滚：保持 draft，零生产代码和零新入口。

### KRSV1-01：Client Contract 网络硬化（已完成）

完成证据：closed command/query/subscription/event/interaction validator、跨进程随机 command ID、唯一 App
安全 projector 与 negative corpus 已落盘；Contract tests、typecheck 与浏览器候选边界通过。

交付：command support matrix、跨进程 command ID allocator、封闭 `RuntimeClientEvent` 与
`RuntimeClientInteraction`、exhaustive App projector、subscription spec/signal 分离、`sessions` scope、
JSON-safe/credential 与 authority 字段 allowlist、本地 presentation detail 保真、TUI `any` 清零。

Gate：

```text
RuntimePresentationEvent & any = 0
wire candidate 中 AbortSignal = 0
wire candidate 中 generic event object = 0
event corpus exhaustive projection = passed
interaction identity/generation/digest settlement = passed
new mutation ID 跨重启不复用，retry 保留原 ID = passed
credential/authority/oversize negative fixtures + ordinary local path positive fixtures = passed
```

回滚：Contract 变化与 TUI adapter 同一 tranche 回滚；不得保留半封闭双事件面。

### KRSV1-02：Runtime Protocol V1（已完成）

完成证据：严格 JSON-RPC V1 codec、显式 allowlist/mappers、初始化与错误表、JSON Schema 及自包含、
method/params 精确配对的 TypeScript declaration 已落盘；Protocol tests、standalone declaration typecheck、
browser build 与生成 digest 漂移检查通过。

交付：`@kite-ai/runtime-protocol`、JSON-RPC envelope、initialize、method/notification/error map、strict
Zod codec、Protocol V1 command/query allowlist、JSON Schema/TS generation、golden fixtures、browser build。

Gate：client/server method set 相等；generated artifacts 无漂移；unknown/new Contract discriminant 默认拒绝；
encode/decode/encode 稳定；malformed/oversized/batch/version mismatch fail closed。

回滚：package 尚未进入生产 composition，可整体移除。

### KRSV1-03：Server Core 与 InProcess endpoint（已完成）

完成证据：Host Session index publisher、线性化 subscription、全请求 task limit、bounded per-connection/global
及 InProcess 双向 logical-message queue、drain 与共享 InProcess hub 已落盘；并发 initialize 只成功一次，
subscription 非正常结束会关闭逻辑连接触发 Client 重连；ack/ready、large reset、gap、slow consumer、cleanup
与 Host integration tests 通过。

交付：Host session-index publisher/indexRevision/tombstone、线性化 subscription 注册、same-revision
projection divergence fail-closed，
`@kite-ai/runtime-server` connection state、admission port、router、subscription pump、bounded queue、
graceful shutdown、in-process endpoint、fake RuntimeAccess conformance、真实 Host integration。

Gate：initialize 顺序、ack/ready ordering、gap snapshot、index atomic reset、slow consumer isolation、iterator
cleanup、package import boundary 全部通过。

回滚：App 尚未切换，Server 不可达。

### KRSV1-04：Runtime Client 与 snapshot store（已完成）

完成证据：RPC correlation、显式 reconnect/resubscribe、generation isolation、bounded subscription queue、atomic
Session/index snapshot store 与 Runtime History Client 已落盘；fake/real Server tests、typecheck 与 browser build 通过。

交付：`@kite-ai/runtime-client`、request correlation、command/query、subscribe/unsubscribe、connection
generation、reconnect/resubscribe、Session/index/stream store、Runtime History Client interface/adapters、
microtask batching、in-process transport client。

Gate：同一 Client conformance suite 覆盖 fake、in-process real Server、disconnect/reconnect、stale old
connection、reset/gap 和 slow notification listener。

回滚：Client 尚未成为生产入口，可整体移除。

### KRSV1-05：TUI/CLI 单路径切换（已完成）

完成证据：App bootstrap 组合唯一 Host + shared Protocol Server + Client；TUI/CLI production surface 到 Host、
SQLite、Kernel 的直接 import 为零；closed local presentation 保留 reasoning/tool arguments/result/cancel cause，
identity-bound interaction、旧 Session history、multiline input、cancel/approval/rewind/session lifecycle 已收敛。
TUI persisted list/load 经 actual `RuntimeClient.history`，对长于 256 条的 history 全量分页，known compatibility
只在选择后导入，durable `model.responded` 合成与 live 等价的 reasoning/text 序列并进入同一 reducer。App
typecheck、真实 CLI/TUI integration、Thought/tool/input/cancel 与 Session persistence/format/switch PTY journeys
通过；正文先于 reasoning、responded/terminal 越过 ephemeral delta 的 identity-ordering 回归只形成一个回答块，
工具阶段与纯 reasoning 的 `Thinking` owner 不重复；production 不含 dual execution 或 fallback。

交付：保留 TUI/CLI 当前 typed surface，内部改为 Runtime Client backed adapter；bootstrap 组合
in-process Server 与 exhaustive local history adapter；删除 Client direct Host/SQLite bridge/import；更新 App/TUI/CLI
owner 文档。

迁移规则：可以在测试中做行为对照，但不得 dual-execute command；cutover 后不保留运行时 fallback 或
catch-new-then-old。

Gate：全部 TUI PTY 与 CLI journey，以及旧 Session history、approval/input/cancel/rewind/compaction/
session switch/restart projection/live-replay 等价通过；TUI/CLI → Host/SQLite/Builtin/Kernel production
import 为零。

回滚：以单个可回滚 tranche 恢复前一已验证版本；不在生产代码中保留双路径开关。

### KRSV1-06A：Receipt Store/transaction slice（已完成）

完成证据：Store 6 / State 27 exact DDL 与 epoch、scoped durable command receipt port、Runtime
event/snapshot/receipt 单事务提交、Store 5 source-only compatibility、delete/close retention、fork 不复制和
fork-with-receipt 原子路径均已落盘；SQLite 39 tests 与 Runtime Host 190 pass / 1 skip 通过。

交付：Host receipt port、transaction input/bridge contract、Store schema/epoch/compatibility slice、exact DDL
verifier、atomic event/snapshot/receipt conformance、retention/delete/fork/close 规则。本 Task 不开放进程外
transport。

Gate：receipt 与 Runtime decision/ack 在同一 transaction；不同 digest unique conflict fail closed；
Store5 source/new target、rollback 和 fault injection 全部通过。

### KRSV1-06B：Restart replay 与多连接（已完成）

完成证据：真实 Store reopen receipt replay、同 key 不同 digest 拒绝、终态 retry 零额外 dispatch、六个
commit/response/activation/schedule/run crash window 已通过；两个真实 Protocol Client 的同 command start、
revision race、并发 interaction response 与慢订阅隔离 Gate 均通过，模型 continuation 只 dispatch 一次。

交付：startup receipt lookup/hydration、two-client revision/interaction tests、restart replay，以及
commit/schedule/dispatch/terminal 各 crash window 与既有 recovery 的组合验证。

Gate：

```text
commit 前 kill
commit 后 response 前 kill
response 后相同 command retry
同 scope/key 不同 body
两个 Client 并发 start_turn
两个 Client 同时 respond_interaction
慢 Client + 正常 Client
```

所有 case 必须证明同一 command 在 restart 后不再次 prepare 或 dispatch effect。

回滚：按 ADR 的 Store profile 回滚；禁止用忽略 receipt table 或非原子兼容读降级。

### KRSV1-07：stdio transport（实现完成；三平台 CI 待 PR）

完成证据：`kite server --stdio` 已从 App 唯一 Host/Server composition 启动；carrier 覆盖 fatal UTF-8
JSONL、fragment/multiple/CRLF、parse recovery、raw byte limit、串行 stdout、stderr redaction、有界
drain/flush、EOF connection-only 与 owner signal shutdown。真实 child 覆盖 Workspace 固定、stdout purity、
EOF lease、进程重启与 Store receipt replay；本地 18 tests 通过，并已增加 macOS/Linux/Windows CI matrix。
三平台结果在 PR checks 返回前仍作为最终 qualification 待办，不提前记录为已通过。

交付：`kite server --stdio`（最终命令由 ADR 固定）、JSONL decoder、stdout/stderr 分离、owner-only
shutdown、EOF/signal lifecycle、child process conformance。

Gate：fragmented write、multiple lines、invalid JSON、overlong line、output backpressure、child crash、
parent EOF、restart/reconnect、Windows/macOS/Linux smoke。

V1 只支持 Desktop/test 等父进程拥有的 stdio child；第三方通用自动化 SDK 不作为默认支持面。
外部消费 Gate：KRSV1-06B 未通过时，stdio 不得宣称支持 crash 后自动 retry。

### KRSV1-08：App local carrier 与 loopback WebSocket（已完成）

完成证据：development/reference-only carrier 固定 `127.0.0.1`，一次性 bootstrap bearer 与短期
HttpOnly cookie 绑定 exact Host/Origin；non-loopback、错误 Host/Origin/cookie、bootstrap replay、query/body
token、binary/oversize/malformed、heartbeat 与慢连接均 fail closed 且仅影响所属 connection。真实
RuntimeClient WebSocket 测试覆盖 ack/ready、Server restart 后 dynamic endpoint/cookie reconnect、generation
隔离、Session index 原子 reset、session resubscribe 与 stale old socket 拒绝。未新增 `server --web`、release
export 或 production Web 支持声明，ADR-0053 保持有效。

依赖：KRSV1-06B、KRSV1-07，以及第 10 节 LOGWEB owner Gate 已关闭。

交付：test/development App-owned listener、`/rpc` WebSocket、bootstrap/cookie、Host/Origin/CSP、heartbeat、
browser transport、固定 Workspace admission、独立 handler capability injection。ADR-0053 未被取代时不
新增受支持的 `kite server --web` release entrypoint。

Gate：non-loopback/unauthorized/wrong-origin/replayed-token 拒绝；Server restart 后 Client 原子重建
Session list 和订阅；慢 socket 只影响所属 connection；token/path/body 不进入日志。

回滚：移除显式 Web entrypoint/listener；InProcess/stdin Server 与 Runtime 不受影响。

### KRSV1-09：Reference consumer 与跨 transport qualification（实现完成；三平台 CI 待 PR）

完成证据：App-local Desktop stdio parent transport 与 headless browser reference 均复用 RuntimeClient，
没有第二协议/reducer；reference bootstrap 只走 header/cookie，hostile text 只作为数据，完整历史缺少显式
History Client 时 fail closed。相同 raw JSON-RPC 矩阵已在 InProcess、真实 stdio child、真实 development
WebSocket 上覆盖 initialize/allowlist、Workspace admission、subscribe ack/reset/ready、unsubscribe、close/drain
与 128-ping bounded mini-soak；本地分别 18、24、3 tests（transport matrix 852 assertions）通过。三平台
qualification 由 PR workflow 返回后写入完成记录。

交付：最小 browser reference consumer/headless development smoke、Desktop child-lifecycle reference（不交付完整 UI）、
跨 transport conformance/fault/soak、资源边界报告。

Gate：同一行为矩阵在 in-process、stdio、test WebSocket 上通过；TUI/CLI 仍为真实生产 consumer；
完整历史读取明确走 History Client/Log Query；没有 transport-specific command 语义分叉；结果不提升
Web production support set。

### KRSV1-10：文档与发布边界收敛（进行中）

本地收敛证据（2026-08-26）：`check:docs-impact`（all scope，278 changed）、`check:docs`、format、
typecheck/build、core/pre-release/package/test-ownership/compaction 静态 Gate 均通过；默认测试完成
269 个 workspace files、94 个 integration/golden/release/harness files 与 46 个 isolated files；TUI system
40 个隔离 PTY scenario files 全部通过。Runtime fault contract 为 35 pass / 1 platform-conditional skip，CI
profile soak 为 7/7 cases；stdio、development WebSocket 与跨 transport conformance 分别为 18、24、3 tests；
release tests 161 pass，当前平台 candidate build/verify/smoke 通过。PR 的 macOS/Linux/Windows stdio 与
transport qualification 尚未返回，因此本 Task 仍保持进行中，尚不创建完成记录或归档本计划。

交付：五个 Runtime workspace README、App README/本地文档、相关 active 架构/authority/resilience/log server
文档、documentation map、CLI/help、ADR 状态、完成记录和 plans index。

Gate：文档影响 Skill、docs-impact/docs、typecheck/build、package boundary、test ownership、owned tests、
TUI system、fault/soak 与三平台 smoke 全部通过；任一 authority 未同步则 blocked。

## 12. Task 依赖矩阵

| Task | dependsOn | 主要产出 | 停止条件 |
| --- | --- | --- | --- |
| KRSV1-00 | 用户审查、本计划 draft | ADR、owner/Store 决策、baseline | ADR 或 LOGWEB owner 未决 |
| KRSV1-01 | KRSV1-00 | closed client contract | event vocabulary 无法 exhaustive/safe projection |
| KRSV1-02 | KRSV1-01 | protocol/schema/codecs | Contract member 自动泄漏到 wire |
| KRSV1-03 | KRSV1-02 | server core/in-process | ack/ready、slow consumer 或 cleanup 不可证明 |
| KRSV1-04 | KRSV1-03 | client/history/store/reconnect | stale connection、reset 或旧 Session history 无确定语义 |
| KRSV1-05 | KRSV1-04 | TUI/CLI production cutover | 任一核心 Client journey/live-replay 不等价 |
| KRSV1-06A | KRSV1-05 | receipt Store/transaction | receipt 无法与 Runtime commit 原子化 |
| KRSV1-06B | KRSV1-06A | restart replay/multi-client | 任一 crash window 会漏执行或重复 dispatch |
| KRSV1-07 | KRSV1-06B | parent-owned stdio child transport | child lifecycle/stdout/backpressure 不闭合 |
| KRSV1-08 | KRSV1-06B、KRSV1-07、LOGWEB Gate | development WebSocket/local carrier | auth/Workspace/owner 任一未闭合，或误提升 Web support |
| KRSV1-09 | KRSV1-07、KRSV1-08 | reference/qualification | transport 行为分叉或资源无界 |
| KRSV1-10 | KRSV1-09 | current docs/release closure | docs-impact 或任一 Required Gate 失败 |

## 13. 验证矩阵

| 范围 | 必测不变量 |
| --- | --- |
| Codec | unknown field/type、unsafe integer、oversized string/array/object、prototype-shaped key、invalid Unicode/UTF-8 |
| JSON-RPC | exact 2.0、string ID correlation、result/error 互斥、batch 拒绝、parse/params/method errors |
| Initialize | pre-init 拒绝、重复 init、version mismatch、capability/limit 固定、auth 先于 init |
| Command | rpcId/commandId 分离、allowlist、Workspace 注入、same/different digest replay、revision conflict |
| Interaction | safe payload、generation/revision/Plan digest、过期/重复 settlement、两个 Client 同时 response |
| Subscription | ack-before-notification、index watermark/tombstone/atomic reset、gap snapshot、same-revision divergence、iterator return、stale generation |
| Backpressure | ephemeral drop、durable 不静默丢、connection isolation、Host mailbox 不阻塞、bounded shutdown |
| Client | reconnect/resubscribe、old connection 消息隔离、ephemeral reset、history resync marker |
| Persistence | atomic receipt、Store format verifier、crash points、delete/fork/close retention、restart no redispatch |
| stdio | fragmentation、line limit、stdout purity、stderr redaction、EOF/signal/flush/process tree |
| WebSocket | loopback、Host/Origin/cookie、bootstrap replay、frame limit、heartbeat、DNS rebinding negative |
| Product | TUI PTY/CLI 全旅程、长旧 Session history、headless browser development smoke、Desktop child reference |
| Static | package graph/workspace runner/default tests/release manifest、browser entry、core boundary、App unique composition、Client direct Host import 为零 |

## 14. 风险与控制

| 风险 | 控制 |
| --- | --- |
| Server 变成第二 Runtime owner | 只注入 RuntimeAccess；无 Session reducer/Agent Loop/SQLite concrete import；fake backend conformance |
| 通用 command 随 Contract 增长自动扩大攻击面 | Protocol V1 封闭 allowlist、App admission、unknown discriminant default deny |
| Contract union 存在但 bridge 实际不支持 | command support matrix、interaction conformance、每项 journey/codec/admission Gate |
| Web 客户端选择任意 Workspace | Workspace 在 App bootstrap 固定并由 mapper 注入，wire 不接受任意 path authority |
| 新 mutation 在重启后复用旧确定性 command ID | 跨进程唯一 allocator；只有同一逻辑 retry 复用 ID；scoped receipt digest 校验 |
| response 丢失造成重复 effect | 原子 persistent receipt、same commandId retry、crash fault tests |
| receipt 表破坏 current Store | ADR + Store schema/epoch/compatibility Gate，禁止隐藏 DDL 漂移或 sidecar 双写 |
| sessions 初始列表与 live update 竞态 | Host 全局 scope、buffer、reset begin/end/ready、Client 原子 replace |
| snapshot gap 丢失消息历史 | Client 标记 history resync，SQLite Log Query 回填，Host 256 history 不冒充完整日志 |
| priority queue 破坏消息因果顺序 | priority 只用于 admission/drop，不跨越 ack 或重排同 subscription durable FIFO |
| localhost 被恶意网页或本地进程访问 | 临时 secret/cookie、Host/Origin、无 CORS、CSP、loopback bind、negative tests |
| TUI 切换隐藏协议缺口 | TUI 先作为真实 in-process consumer，全部 PTY journey 后才开放外部 transport |
| LOGWEB 与 Runtime Server 争夺 listener/current authority | KRSV1-00 串行 owner Gate、单 ADR、rebase 后重新运行 docs impact |
| V1 范围膨胀为完整跨端产品 | V1 只交付 TUI/CLI production、transport/reference/conformance；产品 UI 单独计划 |
| Web development evidence 被误写为生产支持 | ADR-0053 保持 No-Go；独立 RFC/ADR 与 native support evidence 前不发布 Web entrypoint/manifest |
| 外部参考快速变化 | 版本/commit pin；Codex/DeepSeek 不作为本地 completion authority |

## 15. 已接受决策

用户已授权按推荐默认裁决执行，以下决策于 2026-08-26 全部接受；实施不得再隐式改写：

1. **D-01 Store receipt**：确认 Store schema bump、State 27 保持与现有 current Session 兼容路径；
2. **D-02 LOGWEB carrier**：KRSV1 接管 listener/auth/App carrier current authority，LOGWEB-05～09
   标记 superseded/closed；旧 HTTP/SSE/Web UI 与 production log listener 未实施且不迁入 V1；
3. **D-03 Web Workspace admission**：接受“一实例一已信任 Workspace”的 V1 边界；
4. **D-04 V1 产品范围**：接受 TUI/CLI 为生产 cutover，Web/Desktop 只要求 transport/reference smoke；
5. **D-05 Protocol commitment**：Protocol V1 是仓库内预发布契约，exact version、无公共长期兼容承诺；
6. **D-06 Web support**：ADR-0053 保持有效；V1 的 WebSocket 只形成 development evidence。任何生产 Web
   入口由后续独立 RFC/ADR 和 native support evidence 决定；
7. **D-07 本地展示保真**：本地 Session 数据不因泛化隐私策略删除普通 reasoning、tool label、path、
   pattern、command 或 result。Protocol 仍使用封闭 DTO、严格上限并过滤明显 credential/authority material；
   完整 history 与 live 事件使用同一 TUI reducer。该修订由 ADR-0143 固定，不扩大 ADR-0053 的产品范围。

若任一项后续需要改变，必须先由追加 ADR 修订本计划，不得在实现中隐式决定。

## 16. 推荐开工顺序与完成定义

```text
KRSV1-00 ADR/协调
→ KRSV1-01 closed client contract
→ KRSV1-02 protocol
→ KRSV1-03 in-process server
→ KRSV1-04 client/history/store
→ KRSV1-05 TUI/CLI cutover
→ KRSV1-06A receipt Store/transaction
→ KRSV1-06B restart replay/multi-client
→ KRSV1-07 stdio
→ KRSV1-08 development WebSocket/carrier
→ KRSV1-09 qualification
→ KRSV1-10 docs/release closure
```

每个可写 Task 使用独立 branch/worktree 和唯一 Git owner；命中同一 workspace/current authority 的 Task
串行合并、后续 rebase 后重新执行文档影响 Gate。任何阶段出现以下情况立即停止，而不是增加 fallback：

- Server 需要直接读取 Host concrete state、Kernel、Builtin 或 SQLite 才能实现；
- Wire 需要透传 raw RuntimeEvent/generic object 才能满足 TUI；
- 现有 interaction/command support gap 只能靠 wire 旁路或临时 RPC waiter 补齐；
- TUI/CLI 旧 Session history 只能靠 direct Store/Host import 才能恢复；
- receipt 无法与 Runtime commit 原子化；
- Web auth、Workspace admission 或 LOGWEB owner 无法明确；
- Web development carrier 被要求直接进入 production support set、但 ADR-0053 尚未被取代；
- TUI journey 只能靠双执行或旧路径 fallback 通过；
- slow consumer 能阻塞 Host/其他连接或 durable message 被静默丢弃；
- docs-impact、current authority 或 Store format verifier 未共同收敛。

V1 只有在 KRSV1-00～10（含 06A/06B）全部 Gate 通过、TUI/CLI 单路径生产切换完成、stdio 与
development WebSocket conformance 通过、跨重启 command 不重复 dispatch、LOGWEB authority 无冲突、
文档与验证完成记录齐备时，才可标记 `completed`。该状态不改变 ADR-0053 的 Web No-Go；完整或受支持的
Web/Desktop 产品仍需后续独立计划。
