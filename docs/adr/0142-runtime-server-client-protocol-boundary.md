# ADR-0142：Runtime Server、Client 与 Protocol V1 边界

状态：accepted

日期：2026-08-26

决策者：用户直接指令

相关：ADR-0053、ADR-0129、ADR-0137、ADR-0138、ADR-0140、ADR-0141、
[`Kite Runtime Server V1 实施方案`](../space/plans/2026-08-26-kite-runtime-server-v1.md)。

## 背景

现有 `RuntimeAccess` 是 App 内、进程内的 command/query/subscribe seam。它的 Host 实现拥有每个
Session 的 mailbox、revision fence、短期 notification history、attempt/recovery 与当前进程内 receipt。
它不是网络协议；当前 notification event 仍是开放对象，现有 TUI presentation 又使用 `any` 扩张。

另一方面，SQLite 日志查询已经按 ADR-0129 形成只读 `RuntimeLogQueryPort` 与 App safe projector，但还没有
listener、SSE、Web UI 或 CLI listener。不能让一个 Runtime Server 为了 transport 而取得第二份 Host、Store、
Kernel、reducer 或日志写 authority。

## 决策

### 1. 固定分层与唯一 composition

新增的 workspace 采用下列单向关系：

```text
runtime-contract ───────────────────────────────→ ∅
runtime-protocol ───────────────────────────────→ runtime-contract + browser-safe codec
runtime-client ─────────────────────────────────→ runtime-contract + runtime-protocol
runtime-server ─────────────────────────────────→ runtime-contract + runtime-protocol
runtime-host ───────────────────────────────────→ agent-kernel + runtime-contract + runtime-spi
apps/kite ──────────────────────────────────────→ client + server + host + builtin + sqlite
```

`apps/kite/src/bootstrap.ts` 仍是唯一 concrete Runtime composition root。Server 不创建 Runtime Host、
Session reducer、Agent loop、Builtin module、SQLite writer 或完整日志 reader；Client 不依赖 Server concrete
type、Host、Builtin 或 SQLite；TUI/CLI production cutover 后只取得 typed Runtime Client surface 与
App-injected safe history adapter，不能保留 direct Host/SQLite/Builtin/Kernel import、dual execution、fallback
或 catch-new-then-old 路径。

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| `runtime-contract` | App 内 command/query/projection、封闭 client event 与 local subscription spec | wire envelope、socket、reconnect、Host lifecycle |
| `runtime-protocol` | Protocol V1 DTO、codec、method/error map、exact version、JSON Schema、framing-neutral message | Runtime execution、listener、Workspace authority、client state |
| `runtime-server` | connection state、initialize/routing、subscription multiplex、bounded outbound、connection shutdown | Host、Kernel、Builtin、SQLite、HTTP static UI |
| `runtime-client` | request correlation、reconnect/resubscribe、generation/snapshot store、history-client interface、transport interface | Host、Server implementation、SQLite、React/TUI |
| `runtime-host` | mailbox、revision、execution/recovery、notification routing、persistent receipt mechanism | wire、WebSocket、HTTP auth、TUI projection |
| `apps/kite` | composition、concrete client-safe projection、Workspace admission、carrier/listener/local auth、TUI/CLI/reference composition | duplicate Runtime/Store/Kernel authority |
| Runtime Log Service | complete durable history query 与 safe history projection | Runtime command、real-time execution authority |

Server 只能由两个正交 port 驱动：

```ts
interface RuntimeServerBackend {
  readonly runtime: RuntimeAccess;
  readonly admission: RuntimeServerAdmissionPort;
}

interface RuntimeServerAdmissionPort {
  authorize(input: RuntimeServerAdmissionInput): Promise<RuntimeServerAdmissionDecision>;
}
```

`RuntimeAccess` 是唯一 execution backend seam。admission 只判断 connection/transport/role 对冻结 operation
的资格，并注入 App-owned Workspace/Project facts；它不 command、写 revision、缓存领域状态或从
`clientInfo`、请求 body、display name 提升 authority。

stdio、WebSocket、Bun/Node stream、process signal 与 HTTP bootstrap 都属于 App/carrier I/O；Server core
只接受抽象的 duplex logical-message connection。不存在 sidecar Server、第二 listener ownership、第二 Store
writer、dual write 或 alternate transport fallback。

### 2. Protocol V1 是封闭的仓库私有精确版本

Protocol V1 使用 JSON-RPC 2.0 的窄子集：`jsonrpc` 精确为 `"2.0"`，request ID 仅为有界 string，params
仅为 object，response 在 `result`/`error` 中二选一。拒绝 batch、client notification、binary frame、动态
method、number/null ID 与通用 RPC cancel。RPC ID 只做一次 request/response correlation，不是 command ID。

V1 仅定义 `initialize`、`runtime/command`、`runtime/query`、`runtime/subscribe`、
`runtime/unsubscribe`、`server/ping`，以及 Server→Client 的 `runtime/subscription`、`server/draining`。
`server/shutdown` 如实现，只给拥有 stdio child 的 transport capability；Web client 不取得它。Server 不发起
Client request。

握手只接受 exact `protocolVersion: 1` 与 `protocolSchema: 'kite.runtime-protocol.v1'`，不做范围协商。每条
connection 依次为 `uninitialized → active → draining → closed`；初始化前只接受 initialize，成功初始化一次。
版本、codec、allowlist、schema、字段/对象/depth/size 上限与 admission 都必须同时显式更新。新增 Contract
discriminant 默认不进入 wire，unknown、malformed、oversized、unsafe 或带未知字段的 input 在 Host mailbox、
Store 和 effect 前 fail closed。

这是 repo-private、预发布的 exact contract，不是公共 SDK 或长期兼容承诺。外部 stdio 使用也不改变该结论。

### 3. Client-safe command、event、subscription 与完整历史

Protocol 的 command/query/event 集必须由明确的 V1 allowlist 和 exhaustive JSON-safe mapper 产生。`AbortSignal`、
iterator、callback、transport handle、raw `RuntimeEvent`、generic object、reasoning、credential、header、internal
path/locator、Provider body、grant subject、binding digest、child identity 与 raw Workspace path 都不得越过 wire。
未知 current event 只产生固定 unavailable projection 或不发送，绝不透传 raw object。Client-safe interaction
必须携带 settlement 所需的 exact identity：至少 interaction ID、Session revision，以及适用的 approval
generation/grant、Plan ID/version/structural digest、provider/verification revision；过期、重复或并发 response
仍由 Host revision/identity 拒绝，Server 不设领域 waiter。

模型展示流同样必须可关联：`model.text_delta`、`reasoning.activity` 与 `model.responded` 携带 exact model
`requestId`，Protocol codec 对缺失/额外字段 fail closed。durable history mapper 从 `model.responded` 的 canonical
invocation identity 重建相同 ID，使 live/replay reducer 在正文、reasoning 与 terminal 乱序时仍只更新一个回答。

wire 仅传 JSON-safe subscription spec。Session subscription 在 ack 前先取得 Host iterator 并缓冲；顺序固定为
`subscribe response → replay/reset → initial items → ready/end → live`，因此 notification 不得先于 ack。
`sessions` scope 由 Host 的同一实例 session-index publisher 产生 reset begin/upsert/end，Client 在 end 原子替换
列表；Server 不从 command 推测 index。Host 的 256 条 durable notification 只用于短断线恢复，gap/reset 必须让
Client 标记 history resync。

完整 durable history 始终走 `RuntimeClient.history → RuntimeHistoryClient adapter → App safe history projection →
RuntimeLogQueryPort → SQLite readonly reader`。Server notification history、Session Logger、JSONL、trace 和 metadata
logging 都不是日志 authority，也不得成为补偿或 fallback。

### 4. Receipt、Store 格式与原子性

State 27 保持当前 State shape。为跨进程 retry 引入 persistent command receipt 时，current target 升级到 **Store 6**，
format epoch 固定为 `kite-runtime-server-v1-2026-08-26`；现有 State 27 / Store 5 /
`kite-runtime-saq-v1-2026-08-25` 是明确的 current-source compatibility profile。App 在选中 exact
session 后将可验证的 Store 5 source 原子导入 Store 6 target；未知 source 静默忽略、损坏仅隔离该 session。
Store 5 source 不被写回、checkpoint、rename 或以兼容 fallback 执行。

receipt identity 是 scoped，至少为 `runtimeCommandSessionId(command) + commandId`，并绑定 command digest、
result/committed revision 与必要的 retention/tombstone facts；不得只以 `command_id` 作主键。不同 digest 的同 scope/key
fail closed。一个 applied Runtime command 的 State/event/snapshot/revision decision 与 receipt 必须在同一 Runtime
transaction 中提交；commit 后 response 前崩溃时，使用同 ID 的 retry 返回同一事实且不得再次 prepare 或 dispatch
external effect。overload、parse、codec、auth 和 transport failure 不创建 receipt。

Store 6 的新增表固定为：

```sql
CREATE TABLE runtime_command_receipts (
  scope_session_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  original_receipt_json TEXT NOT NULL,
  committed_revision INTEGER NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY (scope_session_id, command_id)
)
```

V1 不设置 TTL 或容量裁剪；close、Session delete 与 target delete 都保留 receipt，fork 不复制 source receipt 到 target。
这样已删除 Session 的迟到 retry 仍只能重放原事实，不能重新 prepare/fork/create。只有删除整个 Store 才同时删除这些
metadata。后续若要 pruning，必须先以新 ADR 定义 retry horizon 与稳定的 `receipt_expired` 结果，不能静默遗忘。

不得用 sidecar receipt database、内存/SQLite 双写、hidden DDL drift、Store 5 current writer、忽略 receipt 表、
try-new-catch-old 或 alternate driver 来规避该变更。schema/epoch、DDL、Store 5 source/Store 6 target preflight、
atomic import、delete/fork/close retention 与 crash verifier 同 tranche 交付。

### 5. 单 Workspace admission 与 transport 边界

每个 Runtime Server instance 只服务一个已经通过 App Workspace Trust 的 canonical Workspace。Workspace、Project
identity、role、transport ownership 与本地 auth 均由 App bootstrap/admission 注入；客户端不能凭
`create_session.workspace` 或任意绝对路径选择 Workspace。该限制不创建 persisted Project authority，不改变 Host
`resolveProjectIdentity()` 的 canonical owner，也不把 Workspace trust 变成 Full 或 approval grant。

InProcess 仍经过同一 protocol codec、initialize、limit 和 subscription ordering。stdio 仅面向 Desktop/test 等拥有
child lifecycle 的父进程：stdin 是有界 UTF-8 JSONL，stdout 只承载 protocol，诊断只写 stderr，EOF 只释放连接；
只有 owner capability 可 shutdown composition。loopback WebSocket 仅为 test/development evidence，必须是 App-owned
carrier，bind loopback，完成 bootstrap 的临时 local auth、Host/Origin/CSP/no-CORS/frame/heartbeat checks。它不读取
raw SQLite，也不扩大 Runtime Log query handler 的 query-only capability。

### 6. 产品范围、LOGWEB 与 ADR-0053

TUI 与 foreground CLI 是 V1 的唯一 production consumers；它们先完成 InProcess Server + Runtime Client 单路径
切换。Web 与 Desktop 仅交付 transport/reference/conformance smoke，不交付完整 UI，不加入 release manifest，也不
成为 production-supported entrypoint。

KRSV1 接管 LOGWEB-05～09 命中的 listener/auth/App carrier **current authority**，并关闭这些尚未实施的旧任务；
HTTP/SSE、Web UI、query-only production listener 与相应发布工作不迁入 KRSV1 V1 交付范围。LOGWEB-00～04
已完成的 SQLite query-only port 与 safe projector 保持原 owner/authority。未来计划若在新决策下组合 App local
carrier，capability 仍须隔离为 `/rpc → RuntimeAccess + admission`、日志 handler → `RuntimeLogQueryPort + safe
projector`、health/readiness → 低敏感度状态；共享 listener/auth 不表示 RPC 获得 SQLite 或 Log handler 获得
command/transaction/effect。

ADR-0053 的 Web No-Go 继续有效。没有后续独立 RFC/ADR 和 native support evidence，不发布 `kite server --web` 或
任何 production Web entrypoint，也不以 loopback、localhost、reference smoke 或 query-only service 作为支持升级依据。

## 后果

- 新 protocol/server/client 可以独立做 codec 与 transport conformance，但永远不复制 Runtime authority。
- TUI/CLI cutover、Store 6 receipt 和 external transports 必须串行经过其依赖 Gate；不以兼容双路径换取渐进上线。
- Store 5 到 Store 6 是明确的 source/target migration，而非当前 writer 的隐式 schema 漂移。
- LOGWEB 的已完成只读查询继续可用；尚未完成的 carrier 不再有两个计划/owner 竞争。

## 回滚

在 production cutover 前，可整体移除未接入的 Protocol/Server/Client tranche。已经切换 Store 6 或 TUI/CLI 单路径后，
回滚必须由新的追加 ADR 定义 Store 6 source 的安全读取、receipt 保留和等价的单路径运行方案；不得恢复 Store 5
writer、sidecar、dual write、第二 Runtime owner、旧 Host bridge fallback 或 production Web 宣称。
