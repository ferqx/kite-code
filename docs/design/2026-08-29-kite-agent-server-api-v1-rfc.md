# Kite Agent Server API V1 RFC

状态：accepted（方向已由 ADR-0149 接受，不代表当前行为；实施以 KASAPI plan Gate 与 current authority 为准）

日期：2026-08-29

发起：用户直接建议参考 LangGraph Agent Server 的接口设计

基线：`feat/kite-coordinator-workspace-worker-web-v1@e4ab1c374b2fdfa9f9a0958c1ffd38f9ed1cd16b`

相关：[`Runtime Protocol`](../../packages/runtime-protocol/README.md)、
[`Runtime Server`](../../packages/runtime-server/README.md)、
[`Runtime Client`](../../packages/runtime-client/README.md)、
[`Runtime Contract`](../../packages/runtime-contract/README.md)、
[`Service Runtime carriers`](../../apps/kite-service/docs/runtime-server-carrier.md)、
[`Runtime Authority Boundary`](../active/runtime-authority-boundary.md)、
[`Coordinator、Workspace Worker 与 Web Observer 当前边界`](../active/coordinator-workspace-worker-web.md)、
[`Kite Code 六概念 Runtime 架构`](../active/six-concept-runtime-architecture.md)、
[`Kite Agent Server API V1 实施方案`](../space/plans/2026-08-29-kite-agent-server-api-v1.md)、
[`Public contract freeze`](../space/understanding/2026-08-29-kite-agent-server-api-v1-contract-freeze.md)、
[`ADR-0149`](../adr/0149-stable-local-agent-api-facade.md)、
[`ADR-0150`](../adr/0150-store-8-canonical-runtime-run-index.md)、
[`ADR-0142`](../adr/0142-runtime-server-client-protocol-boundary.md)、
[`ADR-0144`](../adr/0144-local-runtime-service-and-multi-workspace-admission.md)、
[`ADR-0147`](../adr/0147-kite-coordinator-workspace-worker-read-only-web.md)、
[`ADR-0148`](../adr/0148-workspace-store-layout-generation-migration.md)。

外部参考：
[LangGraph Agent Server API](https://docs.langchain.com/langsmith/server-api-ref)、
[LangGraph Agent Server 架构](https://docs.langchain.com/langsmith/agent-server)、
[Agent Protocol](https://langchain-ai.github.io/agent-protocol/)、
[Agent Streaming Protocol](https://langchain-ai.github.io/agent-protocol/streaming/)、
[LangGraph Streaming API](https://docs.langchain.com/langsmith/streaming)。

> 本 RFC 只提出未来稳定 Agent API 的产品和架构方向。当前生产事实仍是 repo-private Runtime Protocol、Native
> client/carrier、Coordinator/Workspace Worker 与只读 Web Observer。本文不授权公网监听、多用户托管、Browser mutation、
> 第二 Runtime/Store owner、raw Runtime/SQLite 访问或绕过现有 Native admission。

> 本文第7～11节保留accepted design草案与当时待裁决项。KASAPI-00C之后，exact status/header/auth/pagination/error/SSE/compatibility以
> [`Public contract freeze`](../space/understanding/2026-08-29-kite-agent-server-api-v1-contract-freeze.md)为实现输入；冲突处以后者为准。

## 1. 执行摘要

Kite 已经拥有严格的 Runtime command/query/subscription、持久 command receipt、Session revision fencing、完整 History、
断线不取消执行、重启恢复和 client-safe projection。当前缺口不是“没有 Server 接口”，而是现有接口被刻意定位为仓库私有、
transport-neutral 的 JSON-RPC V1；它没有为第三方 SDK、Desktop 或 headless automation 提供稳定的资源模型、HTTP 生命周期、
Run 查询、Run stream rejoin、OpenAPI 或兼容性承诺。

本 RFC 提议新增 **Kite Agent Server API V1**：

1. 以 `Session`、`Run`、`Interaction`、`Checkpoint` 为稳定资源；
2. 使用 REST 表达资源创建、查询和显式 mutation，使用 SSE 表达可恢复的 Session/Run 事件流；
3. 不直接公开现有 `/rpc` JSON-RPC，也不把 LangGraph 的任意 graph state/config/debug 能力带入 Kite；
4. Public API adapter 必须复用现有 Runtime command、persistent receipt、revision CAS、admission、History projector 与
   client-safe event，不创建第二 execution path 或第二事实源；
5. V1 的“public”表示有版本和兼容承诺的 SDK contract，首期 transport 仍只服务本机 loopback、同一 OS 用户、已 admission
   的一个 Workspace；remote/LAN、multi-user、hosted 与 Browser control 继续需要独立 ADR；
6. 最大的新增领域能力是把 `Run` 提升为可持久查询、取消、等待和重新加入事件流的一等资源，而不是只通过 Session projection
   或 terminal event 间接观察；
7. 只读 Web 页面新增 `/api-docs` 路由，展示由 Agent API contract 同源生成、随 release 打包的 OpenAPI 文档；该页面不取得
   controller capability，不注入真实 endpoint/token，也不提供可发送 mutation 的 “Try it” 功能。

推荐架构：

```text
Native SDK / Desktop / headless client
  -> Coordinator discovery + Workspace admission + short-lived Worker capability
  -> Workspace Worker Agent API carrier (REST + SSE, loopback only in V1)
  -> Agent API application adapter
  -> in-process Runtime Client / Runtime Server logical connection
  -> RuntimeAccess
  -> Runtime Host + canonical Workspace Store

History endpoint
  -> existing RuntimeHistoryClient
  -> Service-owned safe History projector
  -> readonly RuntimeLogQueryPort
```

Coordinator 只负责 discovery、routing mirror、lifecycle 与 capability relay，不代理 Agent data plane；客户端在 admission 后直连
目标 Workspace Worker。Agent API adapter 只做 public resource 与现有 typed Runtime contract 的转换，不持久化第二份 Session/Run
状态，不从 HTTP metadata 提升 Workspace authority。

## 2. 当前事实与缺口

### 2.1 已有接口设计

当前 Runtime Protocol V1 已冻结以下 request method：

- `initialize`；
- `runtime/command`；
- `runtime/query`；
- `runtime/subscribe`；
- `runtime/unsubscribe`；
- `server/ping`。

Runtime command 已覆盖：

- Session create/resume/close/delete；
- Turn start/cancel；
- Interaction response 与 interaction mode；
- context compact/reset；
- checkpoint rewind 与 Session fork；
- command grant clear。

Runtime query 已覆盖 Session 列表、Session projection、context status、checkpoint 列表与 rewind preview。Subscription 已覆盖
单 Session 与进程/Worker Session index，并具备 `afterRevision`、短期 replay、reset、ready 和 generation 语义。

Native carrier 已拥有：

- health/readiness 与 authenticated instance handshake；
- Workspace Trust 后的一次性 Runtime ticket；
- WebSocket `/rpc`；
- 三个 closed History use case；
- exact App Control/credential/control route；
- 消息大小、HTTP body、queue、backpressure、heartbeat 与 draining hard limits。

这些设计应被复用，不应被新的 HTTP façade 替换或旁路。

### 2.2 当前产品/API 缺口

| 缺口 | 当前表现 | V1 目标 |
| --- | --- | --- |
| 稳定资源模型 | command/query discriminant 是私有 wire vocabulary | Session/Run/Interaction/Checkpoint 成为公共资源 |
| 一等 Run | `start_turn`、active projection 与 `run.terminal` 提供事实，但没有完整 Run CRUD/query/join | 创建即返回 durable `run_id`，可 get/list/cancel/wait/stream |
| HTTP 生命周期 | mutation 通过一个 JSON-RPC method envelope | REST endpoint、状态码、Problem Details、ETag、Idempotency-Key |
| 流恢复 | Runtime subscription 使用 revision/generation 和短期 replay | SSE `Last-Event-ID`、exclusive resume、gap/resync contract |
| SDK 兼容 | exact repo-private protocol，不承诺兼容 | `/v1`、OpenAPI 3.1、请求严格/响应前向兼容策略 |
| 能力发现 | initialize/server descriptor 面向 Native client | public server info/capabilities，不泄漏 Worker/Store authority |
| 分页/检索 | exact use-case query | opaque cursor、bounded page、closed filters |
| 消费者隔离 | Native TUI 是主要 controller；Web 永久 observer-only | Native SDK/Desktop/headless 可作为 controller；Browser 仍被拒绝 |

## 3. LangGraph 参考裁决

### 3.1 借鉴内容

LangGraph/Agent Protocol 的以下设计适合 Kite：

1. **Thread/Run 分离。** 持久对话容器与单次原子执行分开，Run 可以后台执行并独立查询；
2. **连接不是执行 owner。** 创建 Run 后断线不必取消；客户端可以稍后查询、等待或重新加入 stream；
3. **资源 API 与事件协议并存。** REST 负责 CRUD/lifecycle，SSE 或 WebSocket 负责持续事件；
4. **Thread-centric replay。** durable identity 是 Session/Thread，连接只是临时 subscription scope；
5. **显式 stream lifecycle。** 客户端不从 token/tool 相邻关系猜测 Run/Message/Tool 的开始与结束；
6. **OpenAPI 与 SDK。** 稳定 schema 先于多语言 client；
7. **后台队列与同 Thread 串行。** 同一持久容器的执行需要明确并发策略，不由 HTTP 并发偶然决定。

### 3.2 不照搬内容

Kite V1 不复制以下 LangGraph surface：

- 任意 graph `input`、`config`、`metadata`、`goto` 或 state patch；
- raw graph state、node、task、checkpoint/debug stream；
- 任意 Assistant CRUD、用户提交 system prompt/model/tool 配置；
- public KV/vector Store；
- Browser 可直接使用的 mutation API；
- 默认 stateless Run；
- disconnect 自动取消；
- dynamic method registry 或 opaque raw event passthrough。

原因是 Kite 是具有 Workspace filesystem、Shell、Git、MCP、approval、receipt 和 recovery authority 的编码 Agent。任意 state/config
写入会绕过 Kernel/Host 事实边界；raw debug/state 又可能泄漏 path、credential、Provider payload、grant subject、sandbox evidence
或内部 recovery identity。

### 3.3 术语映射

| LangGraph / Agent Protocol | Kite | V1 裁决 |
| --- | --- | --- |
| Assistant / Agent | 当前 Service-owned Agent、model route、Skill/MCP composition | V1 不建立可写 Assistant；只保留将来只读 introspection 扩展点 |
| Thread | Session | 对外继续使用 `Session`，不为了外部相似性做全仓重命名 |
| Run | 当前 Turn/Run execution facts | 新增一等 `Run` public projection，内部 identity 必须有 canonical durable owner |
| Interrupt/Input | `RuntimeClientInteraction` queue | 继续使用 exact interaction identity + Session revision settlement |
| Thread State | `RuntimeSessionProjection` | 只暴露 closed projection，不暴露 Kernel State |
| Thread History | `RuntimeHistorySessionTranscript`、checkpoint | 拆为 safe History 与 Checkpoint use case，不允许任意 state update |
| Stream | Runtime subscription | 对外增加 SSE envelope/replay；内部仍使用 Runtime subscription |
| Store | SQLite Runtime Store | 永不成为 Agent API resource |

如果未来产品目标是直接兼容 LangGraph SDK，必须另开 compatibility RFC。V1 不提供 `/threads` alias，也不声称实现 LangGraph
Agent Protocol；相似之处只属于资源和生命周期设计借鉴。

## 4. 目标与非目标

### 4.1 目标

1. 为本机 Native SDK、Desktop 和 headless automation 提供稳定、可生成客户端的 Agent API；
2. 让 Session/Run 生命周期、交互、History、Checkpoint 与流恢复无需理解 Kite 内部 JSON-RPC；
3. 保持唯一 Runtime Host/Store/receipt/revision/recovery authority；
4. 让请求丢失、响应丢失、客户端断线、Worker restart 和 slow consumer 都有可验证结果；
5. 让所有返回值只包含 closed、bounded、client-safe DTO；
6. 为未来 remote/hosted 设计留下 adapter seam，但不在 V1 授权或实现；
7. 为 OpenAPI、TypeScript SDK 与 conformance suite 建立单一 schema source；
8. 让本地 Web Observer 可以通过只读 `/api-docs` 页面查看与当前 release build 匹配的 API 文档，而不获得 Agent API
   controller 或 data-plane 权限。

### 4.2 非目标

- 不替换或公开 `kite.runtime-protocol.v1`；
- 不让 REST handler 直接打开 SQLite、调用 Kernel 或构造 Runtime event；
- 不让 Coordinator 成为 Runtime data-plane proxy；
- 不新增第二 Store、Run sidecar database、dual write 或 fallback；
- 不扩大 Web Observer 的只读能力；
- 不支持公网、LAN、跨设备、多用户、服务端 credential custody 或 OS daemon；
- 不提供 arbitrary Assistant/config/state/debug/store API；
- 不承诺 Python/Go SDK 在首个 tranche 同时交付；
- 不在本 RFC 中决定付费、quota、组织/租户、webhook、cron、A2A 或 MCP server 产品面；
- 不因为新增 HTTP API 改变 Shell/Sandbox/MCP/Workspace Trust 的授权规则；
- 不把 Web API 文档页面变成在线 API console，不允许它保存/读取 capability、自动发现 Worker endpoint、发送 mutation 或
  绕过 Native Workspace Trust journey。

## 5. 设计原则

### 5.1 Public façade，不是第二 Runtime

Agent API adapter 只允许：

1. strict decode public request；
2. 根据 authenticated connection binding 建立 request context；
3. 把资源操作映射为现有 Runtime command/query/subscription 或 History use case；
4. 把 typed receipt/projection/event 映射为 public DTO；
5. 维护 HTTP/SSE request、cursor、backpressure 与 connection lifecycle。

它不允许：

- 写 Runtime State 或 Store；
- 生成 Runtime event；
- 缓存一份可与 Host diverge 的 Session/Run 状态；
- 因 connection close 取消 Run；
- 从 URL、header、body、display name 或 metadata 选择/改绑 Workspace；
- 把 HTTP 成功等同于 Runtime applied。

### 5.2 Workspace capability 先于 data plane

V1 每个 Agent API client context 精确绑定一个 admitted Workspace Worker：

1. Native client 通过 Coordinator/manager 完成 Workspace canonicalization、Trust 与 Worker resolve；
2. Worker 继续签发短期、hash-only、一次性 connection capability；它只用于建立 authenticated Agent API client
   context，不能直接作为可被每个 REST/SSE request 重放的长期 bearer。connection exchange 与后续 session-bound context 的
   exact carrier 机制由 KASAPI-00 冻结；
3. REST/SSE request 只能命中该 client context 绑定的 Worker/Workspace、client identity 与 connection generation；
4. `controller` role 只表示 public endpoint allowlist，不替代 Store 7 的 Session Controller lease。所有 effectful mutation
   必须复用现有 Native Controller acquisition/resume、exact Controller session/generation 与 authenticated
   `bindingReference`；V1 Agent API 不新增 request/release/resume/detach Controller endpoint；
5. Session create 不接受 Workspace path；
6. Session resume/query/run/history/checkpoint 必须把持久 Session identity 与 capability Workspace 交叉校验；
7. capability、Worker endpoint、Workspace path、Store path、Controller lease 或 binding reference 不出现在 public DTO。

Remote gateway、browser cookie、API key 与多租户 subject 不属于 V1。未来引入时必须保持同一 Workspace binding，不得把 bearer token
本身解释为 filesystem authority。

### 5.3 Mutation 必须可安全重试

所有产生 Runtime mutation 的 `POST`/`DELETE` 必须携带 `Idempotency-Key`：

- adapter 将其映射为现有 scoped `commandId` 或由新 public command identity mapper 产生稳定等价值；该映射不能依赖短期
  capability、connection generation、Worker instance 或进程内随机 secret，必须在 capability refresh、reconnect 与 Worker restart
  后命中同一 canonical command identity；
- key 的 scope 至少包含稳定的 authenticated client identity、operation、Session scope 与 canonical request digest；具体编码由
  KASAPI-00 冻结，但不能把瞬时 credential identity 当成 client principal；
- 对已经进入 canonical Runtime transaction 并持久化的 mutation，同 key + 同 digest 返回 original applied receipt；
- 对已持久占用的同 key 使用不同 digest 返回 `409 idempotency_conflict`；
- parse/auth/admission/overload、revision conflict、session busy、interaction mismatch 等 applied transaction 前失败不产生 durable
  receipt，也不承诺重放 original rejected response；后续同 key 请求可以在重新通过前置条件后再次评估；
- 若未来要求某类 rejected outcome 具有 sticky replay 语义，必须先扩展 canonical Host/Store receipt authority 并完成相应
  migration/retention ADR；adapter 不得以内存 Map 或 sidecar 保存第二份 rejected receipt；
- client/SDK 不得为一次 retry 自动生成新 key。

Create Session、Fork 与 Delete 同样受该规则约束。不得用 HTTP retry middleware 隐式重放 mutation。

### 5.4 Session mutation 使用 ETag/revision fence

Session response 返回：

```http
ETag: "session:<opaque-session-id>:rev:<revision>"
```

除 `resume` recovery barrier 外，修改现有 Session 的请求必须携带 exact `If-Match`。`start`、`cancel`、interaction
response、`close`、`delete` 与 `rewind` 将 revision 映射到现有 `expectedRevision`；`fork` 映射为
`sourceRevision`。缺少必需 `If-Match` 的固定状态码由 KASAPI-00 在 OpenAPI freeze 前裁决。不匹配返回：

```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json
```

body 中携带 stable `code = "revision_conflict"` 与可安全公开的 `current_revision`。Server 不自动替换为最新 revision并重放；SDK
只有在操作本身定义为 safe reconcile 时才能先 query 再由调用方显式决定。

`POST /v1/sessions/{session_id}/resume` 继续映射当前 `resume_session.afterRevision` 语义：它是 recovery/presentation
admission barrier，可能在恢复过程中推进 revision，不伪装成现有 `expectedRevision` command。若未来要求 resume 使用新的 CAS，必须先
修改 Runtime Contract/Host authority，而不是由 HTTP adapter 本地比较后放行。

### 5.5 请求严格，响应可前向读取

- request object、query parameter 和 mutation body 使用 closed schema，unknown field 返回 `400 invalid_request`；
- response/event 只能由 closed App projector 产生，raw Runtime/Provider/Store object 永不透传；
- public client parser 必须忽略 envelope 中未知的可选 response field，但不得把未知字段用于授权、settlement 或 mutation；
- 新增 required field、改变含义、移除 field 或新增必须理解的 discriminant，需要新的 API major version；
- 新增可选展示字段可在 V1 内演进，但 schema/client compatibility tests 必须证明旧 client 仍安全；
- Runtime Protocol 的 exact decoder 策略保持不变，不能以 Public API 的兼容策略放宽内部 wire。

Public JSON wire field V1 统一使用 `snake_case`。本 RFC 中 DTO 示例均表示 wire shape；TypeScript SDK 可以提供显式、可测试的
camelCase convenience mapping，但 OpenAPI、runtime codec、JSON Schema 与原始 HTTP/SSE body 不得混用两种 casing。

## 6. Public 资源模型

### 6.1 ServerInfo

`ServerInfo` 提供无 secret、无 path 的版本与能力发现：

```ts
interface AgentApiServerInfoV1 {
  readonly schema: 'kite.agent-api.server-info.v1';
  readonly api_version: 'v1';
  readonly server_version: string;
  readonly build_id: string;
  readonly capabilities: readonly (
    | 'sessions'
    | 'runs'
    | 'session_stream'
    | 'interactions'
    | 'history'
    | 'checkpoints'
  )[];
}
```

该对象不是 authentication proof；Native manager 仍负责 exact instance/build/descriptor handshake。Native companion 的 exact build
matching 与 Public API compatibility 是两个边界：Public client 以 `/v1`、schema 与 capabilities 判断兼容，普通 `build_id`
差异不使一个满足 V1 contract 的第三方 SDK 自动 incompatible；`build_id` 只承担 instance/release/diagnostic identity。

### 6.2 Session

`Session` 是 durable conversation/workspace execution container：

```ts
interface AgentApiSessionV1 {
  readonly schema: 'kite.agent-api.session.v1';
  readonly session_id: string;
  readonly revision: number;
  readonly display_name?: string;
  readonly lifecycle: 'open' | 'closed' | 'unavailable';
  readonly status: 'idle' | 'queued' | 'running' | 'waiting' | 'error' | 'unavailable';
  readonly active_run_id?: string;
  readonly active_interaction?: AgentApiInteractionSummaryV1;
  readonly model?: {
    readonly provider: string;
    readonly name: string;
    readonly reasoning_enabled?: boolean;
  };
  readonly created_at?: string;
  readonly updated_at?: string;
}
```

不包含 Workspace absolute path、Project digest、Worker identity、Store locator、command grant subject 或 controller capability。
`status` 是 canonical closed projection，不由 HTTP adapter 根据连接状态猜测。

### 6.3 Run

`Run` 是一次可独立观察的 Agent execution：

```ts
interface AgentApiRunV1 {
  readonly schema: 'kite.agent-api.run.v1';
  readonly run_id: string;
  readonly session_id: string;
  readonly status:
    | 'queued'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown';
  readonly phase: 'planning' | 'building';
  readonly created_at: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly terminal?: {
    readonly reason_code: string;
    readonly safe_retry: boolean;
    readonly recovery_entry: 'none' | 'retry' | 'reconcile' | 'new_run' | 'operator_action';
  };
}
```

实现前必须证明 canonical `runId` 在 start command applied transaction 中分配/持久化并由 receipt 返回。若当前 State/event/receipt
无法无歧义地重建 list/get Run，则需要独立 Store schema/migration ADR；不得建立 sidecar Run database 或从日志文本猜测状态。

同一 Session 默认最多一个 active Run。并发创建策略 V1 固定为：

- Session idle：创建并进入 `queued|running`；
- Session 有 active Run：返回 `409 session_busy`；
- 不提供 `enqueue`、`interrupt`、`rollback` 或并发 Run 策略参数。

后续若产品确需 queue policy，必须作为显式版本化能力，而不是从请求到达顺序隐式推导。

### 6.4 Interaction

Interaction 复用现有 closed `RuntimeClientInteraction` 语义。public response 必须保留：

- `interaction_id`；
- 当前 `session_revision`；
- kind-specific generation/plan/provider/verification/input identity；
- approval 可知情决定所需的 bounded command；
- response 的 exact kind。

Interaction response endpoint 的 body 必须回显 Server 投影的完整 `interaction` identity，再携带 `response`。只传
`interaction_id` 会丢失 settlement fence，禁止 adapter 从可变内存 snapshot 补齐。

### 6.5 Checkpoint

Checkpoint 是 safe rewind/fork use case，不是 raw Kernel state：

- list 返回 bounded checkpoint metadata；
- preview 返回 bounded file statistics/conflict summary；
- rewind/fork 继续走 Runtime command、revision fence 与 persistent receipt；
- API 不提供 arbitrary checkpoint values、state patch、node jump 或 raw file snapshot download。

### 6.6 Agent/Assistant

V1 不建立可写 Agent/Assistant resource。Run 使用 Worker 当前已 admission 的 Service-owned Agent composition、model route、Skill/MCP
与 policy。`assistant_id`、arbitrary model/config/system prompt/tool list 不进入 create Run body。

如果后续出现多个持久 Agent Profile 的明确产品需求，新增只读 `GET /v1/agents`/`GET /v1/agents/{id}/schemas` 可以借鉴
LangGraph introspection；Profile create/update/version、credential binding 与 policy override 必须独立 RFC/ADR。

## 7. REST API 草案

### 7.1 System

| Method | Path | 语义 |
| --- | --- | --- |
| `GET` | `/v1` | 返回 `ServerInfo`；需要 authenticated API capability |
| `GET` | `/healthz` | 仅 liveness，保持低信息；不属于 Agent API contract |
| `GET` | `/readyz` | 仅 Native manager readiness precheck；不证明 identity |

### 7.2 Sessions

| Method | Path | 成功 | 语义 |
| --- | --- | --- | --- |
| `POST` | `/v1/sessions` | `201` | 创建 Session；不接受 Workspace path；必须有 `Idempotency-Key` |
| `GET` | `/v1/sessions` | `200` | cursor 分页列出 capability Workspace 内 Session |
| `GET` | `/v1/sessions/{session_id}` | `200` | 获取 closed Session projection 与 `ETag` |
| `POST` | `/v1/sessions/{session_id}/resume` | `200|202` | 显式 recovery/presentation admission barrier；需要 idempotency key，不使用 `If-Match` |
| `POST` | `/v1/sessions/{session_id}/close` | `200` | 关闭 Session；需要 `If-Match` 与 idempotency key |
| `DELETE` | `/v1/sessions/{session_id}` | `204` | 永久删除已允许删除的 Session；需要 `If-Match` 与 idempotency key，保留 receipt 语义 |

`GET /v1/sessions` 只接受 closed filters，例如 `lifecycle`、`status`、`limit` 与 opaque `cursor`。V1 不允许任意 metadata/value
JSON query，不允许按 Workspace path 或 Store field 检索。

### 7.3 Runs

| Method | Path | 成功 | 语义 |
| --- | --- | --- | --- |
| `POST` | `/v1/sessions/{session_id}/runs` | `202` | 创建后台 Run；需要 `If-Match` 与 idempotency key，立即返回 durable Run projection |
| `GET` | `/v1/sessions/{session_id}/runs` | `200` | cursor 分页列出 Run |
| `GET` | `/v1/sessions/{session_id}/runs/{run_id}` | `200` | 查询状态/terminal outcome |
| `POST` | `/v1/sessions/{session_id}/runs/{run_id}/cancel` | `202|200` | 需要 `If-Match` 与 idempotency key；提交 durable cancel command，不等待进程内 AbortController |
| `GET` | `/v1/sessions/{session_id}/runs/{run_id}/wait` | `200|202` | 有界等待；超时返回当前 Run，不取消执行 |
| `GET` | `/v1/sessions/{session_id}/runs/{run_id}/events` | `200` SSE | 同一 Session stream 的 run-filtered view |

Create Run body 是 closed DTO：

```json
{
  "schema": "kite.agent-api.create-run.v1",
  "input": "Implement the approved change",
  "phase": "building",
  "initial_skills": [
    {
      "skill_id": "example",
      "input": {}
    }
  ]
}
```

不接受 `workspace`、`assistant_id`、arbitrary config、metadata、webhook、on-disconnect policy 或 raw provider options。
V1 disconnect policy 固定为 `continue`；取消只能通过显式 cancel command。

### 7.4 Interactions

| Method | Path | 成功 | 语义 |
| --- | --- | --- | --- |
| `GET` | `/v1/sessions/{session_id}/interactions` | `200` | 返回当前 revision 的完整有序 replacement queue |
| `POST` | `/v1/sessions/{session_id}/interactions/{interaction_id}/responses` | `200` | exact identity settlement |

Response 必须有 `Idempotency-Key`、`If-Match`，并提交完整 interaction identity。空字符串不能代替 input cancel；approval、plan、
provider action 与 verification 使用各自 closed response discriminant。

### 7.5 History 与 Checkpoints

| Method | Path | 成功 | 语义 |
| --- | --- | --- | --- |
| `GET` | `/v1/sessions/{session_id}/history` | `200` | cursor 分页的 durable client-safe transcript |
| `GET` | `/v1/sessions/{session_id}/checkpoints` | `200` | safe checkpoint metadata |
| `GET` | `/v1/sessions/{session_id}/checkpoints/{checkpoint_id}/preview` | `200` | bounded rewind preview |
| `POST` | `/v1/sessions/{session_id}/rewinds` | `202|200` | 需要 `If-Match` 与 idempotency key；receipt-bearing rewind |
| `POST` | `/v1/sessions/{session_id}/forks` | `201|202` | 需要 source `If-Match` 与 idempotency key；receipt-bearing fork，返回新 Session |

History 始终来自现有 exhaustive safe projector + readonly Store query。SSE buffer、Session Logger、trace、JSONL、Catalog 与
compatibility source 都不能补写或取代 History。

### 7.6 Web API 文档页面

本地只读 Web 页面新增固定路由：

| Method | Path | 成功 | 语义 |
| --- | --- | --- | --- |
| `GET` | `/api-docs` | `200` HTML | 展示当前 release 内置的 Kite Agent Server API V1 文档 |
| `GET` | `/api-docs/openapi.json` | `200` JSON | 返回由 Agent API contract 生成并随 release 打包的 OpenAPI 3.1 artifact |

该路由属于 Web Gateway/static presentation contract，不是 Agent data-plane endpoint，也不改变 Web Observer 的永久只读角色：

1. OpenAPI artifact 必须由 `agent-api-contract` 的 codec/schema source 生成，并在 build/release gate 中绑定 contract digest、
   API version 与 build identity；Web 页面不得在运行时从 Worker handler、源码反射或远端 URL拼接另一份 spec；
2. 页面只渲染文档、schema、请求/响应示例、错误码、认证流程说明和复制用的占位命令；示例中的地址与 credential 固定使用
   `<AGENT_API_URL>`、`<API_CAPABILITY>` 等 placeholder；
3. 默认且 V1 固定关闭 Swagger/Scalar 等 renderer 的 “Try it”/execute 功能，不创建可写表单，不把 Browser request 转发到
   Worker，不把 launch token、cookie、Native access token 或 controller capability 注入页面；
4. 页面可显示 release-bundled `api_version`、`server_version`、`build_id` 与 schema digest，但不得显示 Worker endpoint、Workspace
   path、Store path、descriptor、capability、credential 或 raw diagnostic；
5. 页面资源必须随现有 immutable Web assets 打包，遵守 loopback、CSP、no remote CDN/script、Fetch Metadata、cache identity 与
   build mismatch fail-closed 规则；深链接刷新 `/api-docs` 仍由 Gateway 返回同一 release 的文档入口；
6. Agent API capability 未启用、Worker 离线或当前用户没有 controller role 时，静态文档仍可查看，但页面必须明确标记 API
   availability 未确认，不得把 spec 存在解释为 listener ready 或授权成功；
7. 未来若要增加交互式 API console，必须新增 superseding ADR，重新定义 Browser controller、credential custody、CSRF/Origin、
   destructive action、audit 与 Workspace Trust；不能通过打开 renderer 配置开关绕过本节。

## 8. SSE 事件协议

### 8.1 Endpoint

```http
GET /v1/sessions/{session_id}/events?channels=lifecycle,messages,tools,interactions,session
Accept: text/event-stream
Last-Event-ID: <opaque-event-id>
```

`channels` 是 closed allowlist：

- `lifecycle`：Run/Turn terminal 与 status；
- `messages`：user/model/reasoning closed presentation；
- `tools`：safe tool lifecycle/result/progress；
- `interactions`：request/settlement 与 replacement queue boundary；
- `session`：Session projection/reset/resync；
- `checkpoints`：仅在后续明确需要时增加，不在 V1 MVP 默认开放。

不提供 `raw`、`debug`、`state`、`provider`、`kernel` 或 `sqlite` channel。

### 8.2 Envelope

```text
id: evt_opaque
event: kite.session.event
data: {
  "schema": "kite.agent-api.event.v1",
  "session_id": "ses_opaque",
  "run_id": "run_opaque",
  "channel": "messages",
  "durability": "durable",
  "session_revision": 42,
  "event": {
    "type": "model.responded",
    "request_id": "req_opaque",
    "message_id": "msg_opaque",
    "tool_call_count": 0
  }
}
```

外层 ID、Session identity、channel、durability 与 revision 由 Agent API adapter 添加；`run_id` 是可选字段，只有 canonical
Runtime notification/projection 能证明事件归属某一 Run 时才能添加。Session snapshot、reset、resync、create/close 等无 Run 事实的
事件必须省略该字段，adapter 不得用当前 active Run 猜测。run-specific endpoint 过滤掉无归属的 data event，但仍可发送不携带
`run_id` 的 transport/resync control boundary。内层 event 必须来自现有 closed `RuntimeClientEvent` 或另一个同等严格、可穷举验证的
public projector；若复用 `RuntimeClientEvent`，必须通过 exhaustive public mapper 转为 V1 `snake_case` wire DTO，不能 raw passthrough
其 repo-private camelCase shape。

### 8.3 Replay 与 gap

1. `Last-Event-ID` 是 opaque exclusive cursor：恢复时只返回其后的事件；
2. durable event 在现有 Runtime replay window 内重放；完整历史仍走 History endpoint；
3. ephemeral token/progress 只保证当前 stream generation，除非未来明确持久化 bounded stream buffer；
4. cursor 过旧、Worker replacement、buffer gap、codec evolution、filter/channel 改变、`Last-Event-ID` 只指向无法恢复的
   ephemeral event，或任何无法证明连续性的情况，都进入 `kite.stream.resync_required` semantic boundary；
5. resync boundary 必须携带或原子绑定 authoritative Session snapshot，并提供 `stream_generation`、
   `history_through_sequence`、`snapshot_revision`、`resume_after_event_id` 或等价的完整重建证据。exact DTO 与编码由
   KASAPI-00 冻结，但在该裁决完成前不得冻结 SSE/OpenAPI contract；
6. 若 carrier 把 resync control 与 snapshot 分成多个 frame，而连接在完整 boundary 交付前中断，下次连接必须重新 resync，不能把
   已送达的半个 boundary 当成合法 `Last-Event-ID`；
7. Client 收到完整 resync 后清理旧 ephemeral stream，只读取 boundary 指定范围的 History、应用 exact snapshot，再从返回的 live
   event boundary 继续；
8. Server 不制造空 History 或把当前 snapshot 冒充缺失的 durable events；
9. slow consumer 只关闭该 SSE connection，不取消 Run/Session；Client 可以 reconnect/resync；
10. heartbeat 只维持 transport，不推进 event cursor 或 Session revision。

Run-specific events endpoint 是相同 Session event sequence 的 filter，不建立第二套 sequence、buffer 或 History authority。

### 8.4 Command/event ordering

Create Run 或 Interaction response 成功响应必须携带一个 `applied_through_event_id` 或等价 opaque boundary。SSE 客户端据此判断：

- boundary 之前的事实已经包含在 command receipt 中；
- boundary 之后的事件由 stream 消费；
- response 与 notification 竞态不需要通过时间戳或到达顺序猜测。

具体实现可以复用 Runtime Server 的 ack-before-notification 语义，但 public contract 必须对 HTTP response 与已有 SSE connection
做同样的因果证明。若无法原子获得该 boundary，V1 不得声称无缝 command/stream ordering，而应要求 command 后显式 refetch Session。

## 9. HTTP 错误模型

错误使用 `application/problem+json`，body 最少包含：

```ts
interface AgentApiProblemV1 {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code:
    | 'invalid_request'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'revision_conflict'
    | 'idempotency_conflict'
    | 'session_busy'
    | 'interaction_mismatch'
    | 'checkpoint_unavailable'
    | 'overloaded'
    | 'temporarily_unavailable'
    | 'outcome_unknown'
    | 'incompatible';
  readonly request_id: string;
  readonly retryable: boolean;
  readonly current_revision?: number;
}
```

建议映射：

| HTTP | code | 说明 |
| --- | --- | --- |
| `400` | `invalid_request` | malformed/unknown/oversized input |
| `401` | `unauthorized` | capability 缺失、过期或无效 |
| `403` | `forbidden` | role/use case 被明确拒绝；不泄漏目标存在性时可统一 404 |
| `404` | `not_found` | capability scope 内资源不存在 |
| `409` | `idempotency_conflict`、`session_busy`、`interaction_mismatch` | 领域冲突 |
| `412` | `revision_conflict` | `If-Match` 失败 |
| `413` | `invalid_request` | body/message 超限 |
| `429` | `overloaded` | 有界 admission/backpressure 拒绝 |
| `503` | `temporarily_unavailable`、`outcome_unknown` | Worker/Runtime/Store 无法证明结果 |
| `426` 或 `409` | `incompatible` | API major/schema/capability 不兼容；普通 `build_id` 差异不单独触发，最终状态码由 ADR 冻结 |

错误 detail 不包含 Workspace/Store path、token、credential、raw request body、Provider body、sandbox evidence 或内部 diagnostic。
`retryable=true` 只表示 transport/application 可以重新尝试同一 idempotency key，绝不授权生成新 mutation identity。

## 10. API schema、版本与 SDK

### 10.1 单一 schema source

建议新增 browser-safe workspace（最终包名由实施计划确认）：

```text
packages/agent-api-contract/
  src/dto/
  src/codecs/
  src/openapi/
  fixtures/
  test/
```

它只能依赖中立 schema/validation library 与必要的 closed Runtime Contract type mapper，不依赖 Bun、Node、Host、Store、Service、
CLI、React 或 transport。OpenAPI 3.1、TypeScript types、JSON Schema/fixtures 必须从同一 codec source 生成并做 digest test。
生成的只读文档 artifact 同时进入 Web release assets，并由 `/api-docs/openapi.json` 提供；Web renderer 不维护手写 schema 副本，
也不在运行时从 Agent API listener 拉取或合并 spec。

可选 TypeScript SDK 作为后续独立 workspace：

```text
packages/agent-api-client/
```

SDK 负责 HTTP/SSE、cursor、ETag、idempotency key preservation、abort 仅取消本地 wait/stream，不隐式取消 Run。SDK 不读取 Native
descriptor/credential；Native discovery/capability bootstrap 继续由 `kite-local-runtime/client` 组合。

### 10.2 版本策略

- path major：`/v1`；
- DTO 自带 exact schema tag，例如 `kite.agent-api.run.v1`；
- ServerInfo 返回 capabilities，而不是客户端试错 mutation endpoint；
- V1 只承诺本 RFC 冻结并由 conformance tests 覆盖的 surface；
- experimental endpoint 必须位于独立 namespace 且不进入稳定 SDK；
- 不使用请求 header 隐式切换语义相同路径下的多个协议版本；
- deprecation 必须先增加 replacement、SDK warning 与文档，再在新 major 删除。

## 11. Auth、角色与消费者

### 11.1 V1 消费者

允许：

- Kite Native TypeScript SDK；
- Desktop/native renderer 的受信 backend；
- 用户在场的本机 headless automation；
- 仓库内 conformance/test client。

不允许：

- Browser 直接调用 mutation API；
- 当前只读 Web Gateway 把 Agent API 透明代理给 Browser；
- remote/LAN client；
- 多用户 shared Worker；
- 第三方未经 Native Workspace Trust journey 的 bearer token client。

Browser 允许访问 Web Gateway 的 `/api-docs` 只读文档页及其 release-bundled OpenAPI artifact。查看文档不建立 Agent API
connection、不证明 Worker/API readiness，也不授予 observer 或 controller data-plane capability。

### 11.2 角色

V1 最少区分：

- `controller`：在 capability Workspace 与 exact Session Controller lease/generation 同时有效时，可以创建/恢复 Session、创建/取消
  Run、响应 Interaction、rewind/fork；role 本身不授予、恢复或接管 Controller lease；
- `observer`：只可 list/get/history/stream；
- `lifecycle`：仅 Native manager 的 Worker/Service lifecycle，不进入 Agent API；
- `credential`：Provider credential write 的独立 capability，不进入 Agent API。

Web Observer 永远只取得 observer-safe companion contract，不因 Agent API 存在而获得 controller token。隐藏按钮、CORS 或 cookie
不是 role enforcement；Worker API admission 必须按 endpoint 和 operation closed allowlist 拒绝。

V1 Agent API 不提供 Controller request/release/resume/detach endpoint。Native SDK、Desktop backend 与用户在场的 headless
automation 必须先经现有 Native App Control journey 取得或恢复 Controller binding，再建立 controller Agent API context；binding
缺失、detached 或 generation 漂移时 mutation fail closed。若未来要让纯 Agent API client 自主取得 Controller，必须新增
superseding RFC/ADR，而不是扩大 `controller` role 的解释。

## 12. 持久化与恢复影响

### 12.1 不新增第二事实源

Session、Run、Interaction、Checkpoint 的 public projection 必须来自 canonical Runtime Store/Host facts。以下方案禁止：

- Agent API 独立数据库保存 authoritative Run status；
- HTTP handler 内存 Map 作为重启后的 Run owner；
- 从 Session Logger/trace/JSONL 拼接 Run 状态；
- Coordinator Catalog 保存 Run 内容或 terminal outcome；
- History reader 写回 projection；
- response 丢失后以新 command ID重放。

### 12.2 可能需要的 Store 变更

Run 成为一等资源前必须完成 evidence audit：

1. `runId` 是否在 create/start command applied transaction 内唯一分配并持久化；
2. command receipt 是否返回并保留 original `runId`；
3. list/get Run 是否可从 bounded index 或 event/state projection 高效、无歧义地恢复；
4. Session delete 后需要保留哪些 Run/receipt tombstone；
5. Worker crash/restart 时 queued/running/waiting/unknown 如何收敛；
6. fork/rewind 是否复制或引用 Run history；
7. retention/pruning 对迟到 idempotent retry 与 stream replay 的影响。

若任一项需要 schema/table/epoch 变化，必须先新增 Store migration ADR，定义 source/target、maintenance barrier、copy-and-switch、
tombstone、receipt retention、rollback 与 qualification。不得把 DDL 藏在 Agent API tranche。

## 13. 备选方案

### 13.1 直接公开现有 JSON-RPC `/rpc`

拒绝。它是 repo-private exact contract，method 以 command/query/subscribe 聚合，缺少资源 URL、HTTP cache/concurrency、Run CRUD、
OpenAPI 和公共兼容策略。公开它会把内部 discriminant、Native initialization 与 Worker connection model 固化为长期 SDK ABI。

### 13.2 完整复制 LangGraph Agent Server

拒绝。Assistant/config/state/store/debug 等通用 graph surface 与 Kite 的 Workspace authority、closed event、approval、receipt、Sandbox
和 recovery 模型冲突，也会引入没有产品需求的通用平台能力。

### 13.3 REST handler 直接调用 RuntimeAccess

拒绝作为默认设计。它容易绕过 Runtime Server 的 initialize/admission/ordering/limits，并形成 TUI/SDK 两条行为不等价路径。推荐由
Agent API adapter 组合 in-process Runtime Client/Server logical connection；若实施证明该路径无法满足 HTTP/SSE 因果和资源成本，必须先
以新 ADR 抽取一个被 Runtime Server 与 Agent API 共同消费的 application service port，仍不得复制 Host authority。

### 13.4 只增加 A2A 或 MCP endpoint

拒绝作为主 API。A2A/MCP 可以是未来互操作 adapter，但不能替代 Session/Run/Interaction/History/Checkpoint 的 Kite product contract，
也不能成为绕过 Workspace Trust 和 controller role 的入口。

### 13.5 首期支持 stateless Run

延期。编码 Agent 会修改 Workspace并产生approval、receipt、History和recovery evidence，“临时”不能等价于无持久状态。若未来有纯
read-only extraction/research use case，应建立受限 capability profile 和显式 retention，而不是创建后静默删除审计事实。

## 14. 分阶段交付建议

本 RFC 接受后仍必须先新增 ADR 和实施 plan。建议阶段如下：

### KASAPI-00：决策、baseline 与 contract freeze

- 接受/修订本 RFC；
- 新增 ADR，明确它局部替代 `repo-private/public SDK No-Go` 的范围，但不替代 remote/multi-user/Web Observer No-Go；
- 完成 current command/query/event/receipt/Run identity evidence matrix；
- 冻结 Agent API context 与现有 Controller lease/generation/bindingReference 的组合方式，不新增隐式 Controller authority；
- 冻结不依赖短期 capability/connection/Worker instance 的 public idempotency identity mapper，并明确 applied receipt 与
  pre-application rejection 的不同 replay 语义；
- 冻结 History sequence、Session snapshot revision、SSE event ID/generation 与 partial-resync recovery 的单一重建边界；
- 冻结资源、endpoint、error、version、role 与 compatibility policy；
- 决定是否需要 Store migration ADR；
- 建立 documentation-map owner 与 representative path tests。

### KASAPI-01：Agent API Contract 与 OpenAPI

- 新增 browser-safe contract workspace；
- 实现 DTO/codec/OpenAPI/schema/fixture digest；
- 生成 release-bundled API 文档 artifact，并冻结无 “Try it” 的 Web renderer 配置；
- 仅生成 artifacts，不建立 production listener；
- 加入 strict request、forward-compatible response、boundedness 与 secret/path negative tests。

### KASAPI-02：只读 Session/History façade

- Worker 内建立 authenticated loopback Agent API carrier；
- 实现 ServerInfo、Session list/get、History、Checkpoint list/preview；
- Web Gateway/Web App 增加 `/api-docs` deep-link route 与 `/api-docs/openapi.json` 静态 artifact route；
- 验证 observer/controller role、Workspace/Controller binding、pagination、Native identity/build drift 与 Public API
  schema/capability compatibility；
- 不实现 Run mutation或Interaction response。

### KASAPI-03：一等 Run 与 mutation receipt

- 按 ADR 冻结的 canonical Run identity/store方案实现 Run create/list/get/cancel/wait；
- Idempotency-Key、If-Match、response-loss retry 与 crash recovery 同 tranche；
- 证明同 Session 单 active Run 和跨 Session/Workspace isolation；
- 不引入 sidecar state。

### KASAPI-04：SSE、Interaction 与 Checkpoint mutation

- 实现 Session canonical event sequence、run filter、Last-Event-ID、gap/resync、slow consumer；
- 实现 Interaction exact identity response；
- 实现 close/delete/rewind/fork；
- History/live/client reducer 等价验证。

### KASAPI-05：SDK、journey 与 release qualification

- TypeScript SDK；
- Native bootstrap + REST/SSE end-to-end journey；
- fault/soak/restart/upgrade/rollback/platform qualification；
- 更新 owner README、`docs/active/`、book、runbook、release manifest 与 completion evidence；
- 只有当前平台真实 evidence 通过后才能升级支持结论。

各阶段必须使用独立 branch/worktree、唯一 Git owner，并在 stage/commit/push/PR 前执行项目
`document-before-commit` Skill 与 docs-impact gate。

## 15. 验收与负向门禁

### 15.1 Contract

- OpenAPI、JSON Schema、TypeScript types 与 runtime codec 同源且 digest 固定；
- unknown/oversized/deep/prototype-shaped request fail closed；
- response optional evolution 不破坏旧 SDK；
- error/status/code 映射 exhaustive；
- cursor、ID、header、body 与 SSE frame 全部有 hard limits；
- `/api-docs/openapi.json` 与 contract-generated OpenAPI digest、API version、release build identity 精确匹配；
- `/api-docs` deep-link、刷新、静态 asset CSP 与无 remote CDN/script 通过 Web route tests。

### 15.2 Authority/Security

- Session create body 无 Workspace path；
- capability Workspace 与 persisted Session identity drift fail closed；
- observer 对全部 mutation endpoint 被 Worker 拒绝；
- controller role 不能替代 Store 7 Controller lease；binding 缺失、detached 或 generation drift 的 mutation fail closed；
- Browser cookie/launch token不能调用 controller endpoint；
- `/api-docs` 无 “Try it”/execute、无真实 endpoint/token注入、无 Worker proxy 或 mutation network request；
- DTO/diagnostic 无 credential、token、Store path、Worker endpoint、binding reference、raw Provider/Runtime payload；
- Coordinator 不代理 Run/History/SSE data plane，不保存 Run authority；
- API adapter 无 Host/Store/Kernel concrete import，除已批准 composition seam 外无 direct RuntimeAccess bypass。

### 15.3 Idempotency/Concurrency

- applied response 丢失后，同 key + 同 digest 跨 capability refresh/reconnect/Worker restart 返回 original receipt/Run；
- 已持久占用的同 key + 不同 digest 固定冲突；
- applied transaction 前的 auth/admission/revision/busy/interaction rejection 不制造 durable rejected receipt，后续同 key 按当前
  precondition 重新评估；
- revision conflict 不自动换 revision重放；
- 同 Session 并发 create Run 只有一个 applied；
- 跨 Session/Workspace 的 key、revision、Run/Interaction identity 不能互相命中；
- delete/close/fork/rewind 后的迟到 retry 保持既定 receipt retention。

### 15.4 Streaming/Recovery

- HTTP response 与 SSE notification ordering 有可证明 boundary；
- Last-Event-ID exclusive resume 无重复/遗漏，或明确触发 resync；
- resync control/snapshot partial delivery 后重连必定重新建立完整 History/snapshot/live boundary；
- ephemeral gap 不伪装成 durable completeness；
- slow consumer 只关闭连接，不取消 Run；
- Worker restart/replacement 使旧 generation/cursor/capability fail closed；
- History + snapshot + live reducer 结果与未断线 reducer 等价；
- terminal 前 flush reasoning/text/tool progress 的当前 presentation语义不回归。

### 15.5 Fault/Platform

- create Run commit 前/后、response 前/后 crash matrix；
- cancel/interaction/rewind/fork 的 lost-response matrix；
- listener drain、HTTP in-flight、SSE disconnect、backpressure 与 malformed frame；
- Coordinator/Worker/Gateway restart 和 dead/alive/uncertain identity；
- macOS/Linux/Windows 只能由真实 hosted candidate evidence升级支持结论。

### 15.6 文档与静态 Gate

- `bun run check:docs-impact`；
- `bun run check:docs`；
- `bun run check:runtime-packages`；
- `bun run check:pre-release-architecture`；
- Agent API package/client/Service owner tests；
- Runtime transport/fault/soak 与 TUI/Web negative regression tests。

## 16. 风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| Public façade 形成第二 Runtime path | SDK 与 TUI 行为漂移 | 默认经 in-process Client/Server；必要的共用 service port 必须先 ADR |
| Run 一等化建立 sidecar authority | crash 后状态分裂 | canonical Store evidence audit；schema 变化先 migration ADR |
| REST 重试重复 effect | 文件/命令重复执行 | required Idempotency-Key + persistent receipt + exact digest |
| controller role 被误作 Controller authority | 绕过 lease/generation 或 effect gate 全部拒绝 | role 只做 endpoint allowlist；mutation 必须携带现有 exact Controller binding |
| transient rejected response 被伪装成 durable receipt | 重试结果与 Store 事实漂移 | 只承诺 applied receipt replay；sticky rejection 必须先扩展 canonical Host/Store authority |
| SSE 被误认为完整历史 | 断线后消息缺失 | explicit durability、gap/resync、History authority分离 |
| Public兼容放宽 internal codec | 未知字段进入 Host | internal protocol保持 exact；只在public response parser前向兼容 |
| Assistant/config surface扩大权限 | 绕过模型/MCP/Skill policy | V1无可写Assistant和arbitrary config |
| Web借用 API 获得控制权 | 违反永久只读Observer边界 | consumer/role negative gate；新 Web control 必须 superseding ADR |
| API 文档 renderer 打开在线执行 | Browser 间接获得 mutation/credential surface | V1 固定禁用 “Try it”；只提供 release-bundled static spec 与 placeholder 示例 |
| Coordinator成为data-plane瓶颈 | authority与故障域扩大 | client直连Worker，Coordinator只resolve/mint |
| cursor/event retention无界 | memory/Store增长 | bounded window；gap时resync；retention另行ADR |
| “public”被解释为公网支持 | 安全/运维承诺失真 | V1明确定义为stable local SDK contract，remote独立决策 |

## 17. 回滚

在 production listener/cutover 前，Agent API contract、OpenAPI、SDK 与 reference adapter 可以整体删除，不影响现有 Runtime Protocol、
Native TUI/CLI、Web Observer 或 Store。

production 接入后回滚必须满足：

1. 停止接受新的 Agent API mutation；
2. 已 applied Run/Interaction/Checkpoint command 继续由 canonical Runtime/Store 恢复，不因 listener移除而取消；
3. 不删除 persistent receipt、Run/Session facts 或迁移 target；
4. SDK/manifest/descriptor/capability 同 tranche 撤回，不能留下可发现但不可用的 endpoint；
5. 若发生 Store schema migration，只能按对应 migration ADR 回滚；target 出现新写入后不得自动切回 source；
6. 不以恢复直接公开 `/rpc`、embedded Runtime fallback、第二 Store owner 或 Web mutation 作为回滚手段。

## 18. 已接受方向

ADR-0149 已接受以下方向；这些是后续实施边界，不表示对应production behavior已经落地：

1. Kite 建立稳定的本机 Agent Server API V1；
2. 资源名使用 `Session`/`Run`，不复制 `/threads`；
3. REST + SSE 是 public façade，现有 JSON-RPC 继续是 private runtime transport；
4. Public adapter 默认经 in-process Runtime Client/Server，不能直接建立第二 RuntimeAccess path；
5. Run 成为 durable first-class resource；
6. V1 固定同 Session 单 active Run、disconnect continue、显式 cancel；
7. Idempotency-Key 是 mutation contract 的必需部分，只承诺 canonical applied receipt 的 durable replay；pre-application rejection
   不伪装成 durable receipt；
8. 除 resume recovery barrier 外，现有 Session mutation 使用 If-Match/revision fence；resume 继续使用当前 afterRevision 语义；
9. controller role 不替代现有 Store 7 Controller lease/generation，V1 不新增 Controller lifecycle endpoint；
10. V1 无可写 Assistant、raw State/Debug/Store、stateless Run、Browser mutation 或 remote support；
11. SSE 以 opaque Last-Event-ID + bounded replay + explicit resync 提供恢复，exact History/snapshot/live reconstruction boundary
    由 KASAPI-00 在 contract freeze 前裁决；
12. Web Observer 增加只读 `/api-docs` 与 `/api-docs/openapi.json`，文档随 release 打包且 V1 固定无 “Try it”/execute；
13. Store 是否变化必须由 evidence audit决定，任何变化先新增 migration ADR。

接受本文不等于完成实现。KASAPI-00A 已由 ADR-0149 关闭架构方向Gate；下一步是 KASAPI-00B current evidence matrix与
KASAPI-00C Store/contract freeze。在这些门禁及后续Task完成前，现有 Runtime/Service/Web current authority 不变。
