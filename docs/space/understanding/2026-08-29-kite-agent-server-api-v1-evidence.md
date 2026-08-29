# Kite Agent Server API V1 当前证据矩阵

状态：current evidence（KASAPI-00B 完成输入；不是 current behavior authority）

日期：2026-08-29

基线：`docs/kasapi-00b-evidence@53da4cea`（继承已接受 ADR-0149）

相关：[`ADR-0149`](../../adr/0149-stable-local-agent-api-facade.md)、
[`Kite Agent Server API V1 RFC`](../../design/2026-08-29-kite-agent-server-api-v1-rfc.md)、
[`Kite Agent Server API V1 实施方案`](../plans/2026-08-29-kite-agent-server-api-v1.md)。

后续裁决：KASAPI-00C已由[`Public contract freeze`](2026-08-29-kite-agent-server-api-v1-contract-freeze.md)关闭exact Public选择，并由
[`ADR-0150`](../../adr/0150-store-8-canonical-runtime-run-index.md)与
[`Runtime Run Store V1子计划`](../plans/2026-08-29-kite-runtime-run-store-v1.md)接受State 27 / Store 8迁移；本文仍保留00B源码证据。

## 1. 审计结论

KASAPI-00B 对 current command、State/event、receipt、Store 7、History、subscription、Worker capability 与 Controller/effect chain
完成只读审计。结论如下：

| 领域 | 当前证据是否足够 | KASAPI 裁决 |
| --- | --- | --- |
| start identity | 部分足够 | Public `run_id` 应以current `turnId`为identity；`workId`不稳定，不能作为Run identity |
| applied retry | 足够支撑applied-only replay | 复用Store 7 scoped applied receipt；public idempotency mapper不能依赖transient Client/capability identity |
| first-class Run get/list | 不足 | 需要新的canonical Run persistence/index与Store migration ADR；KASAPI-03A blocked |
| Run status/phase/timestamp | 不足 | current facts只能投影active/部分terminal；queued、historical phase、完整terminal/timestamp不闭合 |
| Session/History read | 部分足够 | raw Store query有bounded page，但现有`RuntimeHistoryClient` rich transcript API会全量物化；需新增Service-owned safe page port |
| revision/event sequence | 足够 | current Store正常event的State revision等于durable sequence；可作为resync的durable watermark |
| public SSE cursor | 部分足够 | 无需Store schema变化，但需`generation + durable sequence + public ordinal`，ephemeral只能同generation |
| HTTP response/SSE ordering | 不足以靠transport顺序 | 必须以receipt revision/public boundary证明或要求refetch；private subscribe ack不能外推到HTTP command response |
| Worker capability | 不足以长期REST/SSE | 30秒one-shot connection capability不是长期每请求bearer；需要session-bound Agent API context |
| Controller binding | 足够复用，尚无HTTP façade | current chain可在每mutation重新读取lease并pin `bindingReference`；Agent API必须复用相同链路 |
| stable client principal | 当前不存在 | default Client instance ID在新connect/process中随机；public idempotency scope不得要求新的持久client principal |
| rejected receipt | 明确不存在 | pre-application rejection不持久；不得承诺sticky rejected replay |

核心阻断裁决：

1. **需要新的 Store migration ADR。** current Store 7不能满足first-class Run的bounded list/get、phase/status/timestamp、delete/fork/rewind
   与late retry语义；不得用日志扫描或adapter Map替代。
2. **KASAPI-01与read-only KASAPI-02可在Store migration前推进。** Contract/OpenAPI、authenticated read-only Session/History/Checkpoint
   façade不依赖Run table，但必须先完成KASAPI-00C contract freeze。
3. **SSE不需要因cursor本身升级Store。** current durable revision/sequence提供watermark；public mapper需为一个raw sequence产生的多个
   client event增加ordinal，并在Worker generation变化或ephemeral cursor后resync。
4. **Public idempotency不引入durable client principal。** Store receipt已经绑定Workspace、scope Session、commandId与request digest；
   current Client identity是connection/process-local。00C应从operation/resource scope/高熵Idempotency-Key确定性派生commandId，credential
   identity只用于admission，不进入durable key。

## 2. Start、Turn、Work 与 Run identity

### 2.1 Current identity分配

证据：

- `packages/runtime-contract/src/commands.ts` 的`StartTurnCommand`只有`commandId/sessionId/expectedRevision/input/phase/initialSkills`；
- `apps/kite-service/src/bootstrap/runtime/turn-command-decision.ts::planStartTurnCommand()`使用
  `SHA-256("kite.runtime.start-turn.v1\0<domain>\0<commandId>")`分别派生`taskId/messageId/turnId`；
- `PrecommittedStartTurnDescriptor`持有`commandId/sessionId/committedRevision/turnId/messageId/phase`；
- `commitStartTurnCommand()`把start events与applied receipt放入同一State/Store transaction；descriptor只在进程内返回给runner；
- `CliRuntimeBridge` fresh activation最初使用`workId = command.commandId`、`activeTurn.turnId = descriptor.turnId`；
- restart projection的`runningWorkFromState()`优先使用active `taskId`作为`workId`，fallback才是commandId；
- `run.completed`与client-safe `run.terminal`使用`event.turnId`作为run identity。

裁决：

- `turnId`是current唯一跨fresh/restart/terminal一致的Run候选identity；
- `workId`可能是commandId或taskId，只用于active presentation，不得成为Public `run_id`；
- `taskId`可以跨多个turn或在Planning flow中复用，也不得成为Run identity；
- Public `run_id`应对外opaque，不暴露其由private command identity派生的算法。

### 2.2 Current receipt不返回Run

`RuntimeAppliedCommandReceipt`与持久`original_receipt_json`只包含：

```text
status = applied
commandId
sessionId
revision
```

`RuntimeStoredCommandReceipt`另保存`scopeSessionId/requestDigest/targetSessionId/committedRevision/committedAt`，但没有`turnId`、`phase`、Run
status或terminal。`idempotent_replay`只返回`commandId/sessionId/originalRevision`。

虽然fresh adapter理论上可以用private command-derived函数重算turnId，但：

- 该函数当前是Service-private，不是Host/Store contract；
- list/get无法从receipt识别哪一条command是start，因为Store不保存command body/type；
- Session delete后receipt保留但event/State删除；
- Public response需要完整Run projection，不只是可重算ID。

因此不能仅扩展HTTP mapper而声称first-class Run已经durable。

## 3. Run State、terminal、query与retention

### 3.1 State只保留current Turn

`packages/agent-kernel/src/state.ts`的`AgentTurnState`只有一个`turnId/turnIndex/status/abortReason/abortCause`。Transcript message保留所属
`turnId`，但State没有historical Run collection、phase、created/started/finished time或terminal outcome index。

`RuntimeSessionProjection.activeWork`只投影当前work/turn。terminal后它可在当前进程内保留completed/failed/cancelled，但Store-only restart
projection从当前State重建，无法给所有historical Run提供资源列表。

Current projection没有独立persisted `queued` fact：start transaction后activation直接标为running并schedule prepared execution。若Public
V1保留`queued`状态，必须由新的canonical Run lifecycle定义；否则00C应从V1 status union删除它。

### 3.2 Durable events提供部分而非完整Run事实

Current Runtime events：

- `turn.started { turnId }`；
- `turn.completed { turnId }`；
- `turn.aborted { turnId, reason, cause? }`；
- `run.completed { turnId, output, outcome? }`；
- `run.error { message, recoverable, failure?, effectId?, turnId?, outcome? }`。

缺口：

- `turn.started`不持久化phase或commandId；
- `run.error.turnId`是optional，current client projector缺失时使用`"runtime-run"` presentation fallback，该值不能进入Public Run；
- terminal outcome不是每个terminal event必填；
- waiting可以从current durable interaction推导，但historicalwaiting区间没有Run index；
- queued没有canonical durable event；
- event row有timestamp，但没有Run row聚合created/started/finished；
- get by run ID需要扫描/解码Session events，current Store没有type/turn identity index。

### 3.3 Store 7没有Run表或Run index

`packages/runtime-storage-sqlite/src/schema.ts` current Store 7有：Runtime events、sessions、snapshots、named snapshots、file preimages、effect
leases、command receipts、Session tombstone与Directory outbox；只有`runtime_events(session_id, sequence)`和file preimage两个非主键index。

`RuntimeLogQueryPort.listEvents()`可以按Session、sequence与eventTypes分页，但eventTypes通过`json_extract(event_json, '$.type')`过滤；没有
run identity/phase/status索引。用它实现Run list/get会产生以下问题：

- get一个late Run可能扫描完整Session journal；
- list需要跨多个event组装start/terminal，page边界与Run边界不一致；
- phase与部分terminal根本无法精确重建；
- current Event type evolution会变成Public Run query ABI；
- Session rewind/fork/delete后难以保证Run resource与receipt retention一致。

因此“不新增Store schema，仅event scan”被审计拒绝。

### 3.4 Delete、fork与rewind影响

- Session delete在一个transaction中写Session tombstone、保留command receipt，然后删除events/snapshot/named snapshots/preimages/effect
  lease/recovery identity/session row；existing start receipt既不含Run projection，也没有Run tombstone。
- fork复制checkpoint以前的events、created_at、snapshots与preimages到target，但不复制source command receipts；只写fork command receipt。
- rewind删除checkpoint以后的events/snapshots/preimages并恢复snapshot revision。

新的Run persistence必须定义：

1. delete是否保留Run tombstone以及late create retry如何返回original Run；
2. fork是否复制checkpoint以前Run row、如何重绑target Session、是否保留source Run ID；
3. rewind如何删除/截断checkpoint以后的Run row和terminal；
4. receipt pruning与Run retention的共同horizon；
5. target Store产生新写后的rollback禁止规则。

### 3.5 Store裁决

KASAPI-03A需要新的Store profile/migration ADR。推荐ADR只冻结需求和唯一authority，不在evidence文档预设最终表名；至少必须提供：

- start transaction原子写Run identity、phase、created/started time、initial status与receipt resource result；
- terminal/recovery transaction原子更新status/finished time/outcome；
- `(session_id, run_id)` get与稳定Session Run page index；
- delete/fork/rewind/tombstone/retention规则；
- Store 7 source → new target offline copy-and-switch、journal/fence与三平台验证。

在该ADR及migration完成前，KASAPI-03A/03B/03C/03D保持blocked。

## 4. Applied receipt与Public idempotency

### 4.1 Current durable receipt边界

证据：

- Host在inspect/recovery前先lookup `(scopeSessionId, commandId)`；
- request digest由完整closed Runtime command canonical JSON计算；
- applied State/events/snapshot/receipt在一个SQLite `BEGIN IMMEDIATE` transaction提交；
- Store 7 receipt另绑定`worker_scope_id/project_id/workspace_digest`；
- create scope为`bootstrapSessionId ?? "create:<commandId>"`，fork scope为source Session，其余为target Session；
- delete receipt与Session tombstone同transaction保留；
- receipt replay不再次inspect/activate/schedule，external effect由recovery owner收敛。

Tests：

- `packages/runtime-host/test/persistent-command-host.test.ts`覆盖lookup-before-recovery、same digest replay、different digest拒绝、non-applied不
  持久与Session scope；
- `packages/runtime-host/test/persistent-command-crash-windows.test.ts`覆盖commit/response/activation/schedule/run crash windows与lost response；
- Store/Workspace authority tests覆盖Workspace binding、delete/fork retention与atomic create+initial Controller。

### 4.2 Rejected receipt不存在

`runtime_busy`、revision conflict、not found、interaction mismatch等在Host transaction前返回。`RuntimeStoredCommandReceipt`只允许exact
`status:'applied'` JSON；tests明确验证terminal non-applied receipt不持久。

裁决：Public API不得承诺original rejected replay。pre-application failure后同key可以在新precondition下重新评估；只有已占用durable
receipt的same key/different digest固定conflict。

### 4.3 Current Client identity不是durable principal

Worker capability绑定`RuntimeClientInfo.instanceId + connectionGeneration`。release connector在调用方未提供`clientInfo`时用random UUID创建
instanceId；同一connector reconnect保留instanceId并推进generation，但新connect或process restart会取得新instanceId。Coordinator peer
client identity同样是process-local random UUID。

因此current系统没有可安全用于跨process idempotency scope的stable authenticated client principal。为Public API新增durable principal会引入
新的identity/storage/lifecycle问题，而且Store receipt已经有Workspace与Session scope。

KASAPI-00C应冻结：

```text
public commandId = deterministic hash(
  agent-api-v1 domain,
  operation,
  canonical resource scope,
  client supplied high-entropy Idempotency-Key
)
```

credential/client/connection identity只做admission，不进入durable commandId。完整request仍由private Runtime command digest绑定；同key跨Client
碰撞时same body replay、different body conflict，是比transient principal更稳定的语义。Idempotency-Key必须有长度/字符/熵建议与SDK生成规则。

## 5. Worker capability与Controller binding

### 5.1 Current capability lifecycle

Current Worker capability：

- 32-byte base64url、hash-only、默认30秒TTL；
- 绑定WorkerScope/WorkerInstance/Workspace digest/ClientId/connection generation/purpose；
- `/connect`时one-shot consume；
- handshake/History/App Control route可以在TTL内verify同一record；
- reconnect mint新generation/capability；旧Controller binding被清空，调用方必须显式acquire/resume。

结论：该capability适合建立Native Runtime connection，但不适合作为可能运行数分钟/小时的REST/SSE每请求bearer。Agent API必须建立新的
session-bound in-memory context或等价connection session；其raw credential不持久化、不进入DTO/descriptor/log。exact exchange由00C冻结。

### 5.2 Current Controller→effect链路可复用

Current链路：

1. Worker carrier从已认证capability request提取`clientId/connectionGeneration/workerInstanceId`；若request携带Controller headers，先对
   Store controller lease做exact校验；
2. Runtime admission对每个target Session重新读取current lease，要求active、同Client/generation/Worker，并调用
   `controllerAdapter.native.authorizeMutation()`；
3. `WorkerCommandContextRegistry.pin()`生成短期opaque `bindingReference`，record包含connection/request/session/command/client/connection
   generation/controller generation/Worker；
4. Runtime Server构造in-process-only `RuntimeCommandContext`，只携带connection/request/bindingReference；
5. Host freeze context并固定进prepared execution closure；
6. Worker effect composition用bindingReference取exact record，再由Store Controller/resource/effect authority验证、ack、dispatch与terminal/
   unknown。

关键事实：Controller generation不进入private wire，也不由HTTP body提供；它在App admission时读取并pin。Agent API mutation应复用同样模式，
不能信任public role/header中的generation，也不能在Session外反查旧binding。

### 5.3 Agent API context需要的00C裁决

- context绑定Worker/Workspace/Client/connection generation/purpose/role和absolute expiry；
- controller role不缓存某一Session lease，mutation按target Session重新读取current lease并pin generation；
- context restart失效；Client通过Native journey mint新context并显式resume Controller；
- HTTP request ID成为RuntimeCommandContext requestId；logical Agent API context拥有稳定connectionId；
- query/history可以observer，mutation必须native client + current Controller；
- credential只在Authorization/session exchange seam出现；SSE URL/query不携带token。

## 6. Revision、History与SSE evidence

### 6.1 State revision等于durable event sequence

Current Kernel decision为每个event生成递增revision metadata。SQLite event store使用metadata revision作为`runtime_events.sequence`，snapshot
保存同一State revision/event position；transaction在insert前验证首revision与current snapshot revision连续。fork保留source event revision，
rewind回到checkpoint event position/revision。

因此对current-format正常Session：

```text
durable Runtime event sequence == post-event State revision
```

revision 0是initial State boundary，没有event。并非每个raw event都会生成client-safe event，但每个durable notification仍携带该revision的
authoritative Session projection。

### 6.2 History page与safe projection

Raw `RuntimeLogQueryPort`提供：

- Session page：`updatedAt + sessionId` keyset、limit 1..100；
- Event page：after/before sequence、direction、limit 1..200、observedLastSequence；
- persisted `eventId/sequence/occurredAt/createdAt`与strict current event decode。

现有`RuntimeHistoryClient`存在两个不适合Public page的点：

1. `listSessions()`的Service adapter为合并compatibility/smart name会先`allCurrentSessions()`遍历全部page，再在内存二次分页；Observer client虽无
   compatibility，仍复用该实现；
2. `loadSession()`读取全部event page并物化完整transcript；Web Observer port有4096 records hard limit，但仍返回完整结果，不是cursor page。

同时`RuntimeHistoryClient.listEvents()`返回safe log summary/detail，不是rich `RuntimeClientEvent` transcript。KASAPI-02B需要新增Service-owned
public History page port：直接对bounded raw page做exhaustive safe projection，返回source sequence group与public events；HTTP handler仍不能取得raw
Store port。

Session page还需00C选择稳定语义。current `updatedAt`排序在分页期间发生更新时可能让entry跨页移动；Public V1应选择：

- stable `session_id` keyset；或
- cursor绑定Directory revision/snapshot watermark。

不得把current eventual `updatedAt` page未说明地包装为stable Public cursor。

### 6.3 一个source sequence可投影多个public event

`projectRuntimeHistoryEvents()`通常产生0或1个`RuntimeClientEvent`；对durable `model.responded`会重建reasoning completion、text delta与terminal，
一个raw sequence最多产生3个public event。Live text/reasoning原本是ephemeral，terminal是durable。

因此Public durable event ID不能只有Session revision。00C应使用等价tuple：

```text
worker/stream generation
durable source sequence (== revision)
public event ordinal within that sequence
```

ordinal由同一exhaustive mapper确定；unknown/omitted event仍需要Session snapshot boundary推进durable sequence，避免Client永久等待缺失ID。

### 6.4 Current short replay与ephemeral

`NotificationProjector`：

- 每Session保留最多256条durable notification；
- afterRevision连续则replay，gap或未达到current projection则发送snapshot；
- slow durable subscriber queue饱和时只关闭该subscriber；
- ephemeral不进入history，只在同active work/turn/actor/attempt/stream的monotonic sequence下接受；
- later subscriber不replay ephemeral；connection/Worker generation变化使旧ephemeral失效。

Public裁决：

- same generation内可用opaque cursor恢复durable window；
- cursor指向ephemeral、generation变化、filter/channel变化、gap或partial resync时必须resync；
- heartbeat不推进sequence/revision；
- no Store schema change is required for public cursor本身。

### 6.5 Command response与notification没有跨connection顺序保证

Host顺序为：commit → activation publish notifications → refresh/schedule → return receipt。Runtime Server在backend command返回后才enqueue command
response；subscription ack-before-notification只证明订阅建立顺序，不证明mutation response先于已有subscription notification，更不证明独立HTTP
与SSE connection顺序。

可复用事实：applied receipt含final committed revision，start batch的每个event revision连续。00C必须选择：

- command response返回当前stream generation + applied-through durable sequence/ordinal boundary；或
- 对无法证明的replay/restart case明确要求refetch Session/Run。

不得把private subscribe ack-before-notification描述为HTTP command/event ordering proof。

## 7. Restart、status与timestamp

### 7.1 Restart recovery

Runtime Host启动先hydrate Store projection，但只有`resume_session/start_turn/compact_session`或receipt replay触发`recoverSession()`。App restart
recovery会：

- reconcile Subagent Provider与Sandbox process evidence；
- running Tool收敛为unknown failure，undispatched work取消；
- 有current durable interaction/continuation时保留active Turn并等待resume；
- interrupted且不可resume的active Turn写`turn.aborted(cause='error')`；
- recovery不完整时Session unavailable/fail closed。

Public GET本身不能静默执行recovery mutation。00C必须冻结：未完成explicit resume barrier时，Run/Session read返回`unavailable`或
`unknown`，而不是把Store中stale active State猜成running；`POST resume`完成recovery后再返回authoritative status。

### 7.2 Current status覆盖不足

- running/waiting可由current State/interaction投影；
- completed/cancelled/failed可从turn/run terminal部分投影；
- unknown可由recovery/tool failure分类，但没有统一Run row；
- queued没有persisted canonical fact；
- `run.error`可缺turnId/outcome。

因此Public Run status union与terminal object必须由新Run authority冻结；不能直接把current presentation enum当Store schema。

### 7.3 Timestamp来源

Current可用时间：

- Runtime event envelope `occurredAt`：Host提供ISO时间并持久化到`runtime_events.occurred_at`；
- SQLite `created_at`：writer commit时`unixepoch()`秒精度；fork保留source created_at；
- command receipt `committedAt`：Host `Date.now()`毫秒，持久化但不在public receipt；
- 部分domain event自带`createdAt`，不是所有Turn/Run event都有。

Public Run需要唯一规则。新Run transaction建议使用Host command evidence `committedAt`作为created/started timestamp，terminal transaction使用
persisted event fact time；exact source、precision、ISO normalization与fork/rewind规则由Run Store ADR冻结。HTTP adapter不能使用response time或
当前clock补写历史timestamp。

## 8. KASAPI-00C输入与停止条件

### 8.1 00C必须冻结

1. Public `run_id = opaque projection of canonical turn identity`，但Run row/schema由新Store ADR拥有；
2. 新Store migration ADR与subplan，KASAPI-03A～03D在完成前blocked；
3. Public idempotency commandId mapper不含transient principal；
4. Agent API session context exchange/expiry/reconnect与per-target Controller revalidation；
5. Service-owned paginated safe History port与stable Session page cursor；
6. durable SSE cursor的generation/sequence/ordinal、resync boundary与command applied-through/refetch规则；
7. pre-resume read的unknown/unavailable语义；
8. queued status是否从V1删除，或由新Run authority新增canonical lifecycle；
9. timestamp来源、precision、fork/rewind/delete/retention规则；
10. exact endpoint/status/header/error/limit与compatibility表。

### 8.2 可以继续的Task

- KASAPI-00C documentation/contract freeze；
- Store-independent KASAPI-01 contract/OpenAPI（00C完成后）；
- KASAPI-02 authenticated read-only façade/API docs（01完成后），但History必须使用新safe page port。

### 8.3 Blocked Task

- KASAPI-03A～03D：等待Run Store migration ADR/subplan与implementation；
- KASAPI-04A～04D：等待00C cursor/resync freeze和03D Run qualification；
- KASAPI-05：等待04D。

## 9. 已核验证据与命令

关键源码：

```text
packages/runtime-contract/src/commands.ts
packages/runtime-contract/src/notifications.ts
packages/runtime-contract/src/logs.ts
packages/runtime-contract/src/context.ts
packages/runtime-host/src/host/runtime-host.ts
packages/runtime-host/src/host/command-receipt.ts
packages/runtime-host/src/host/notification-projector.ts
packages/runtime-host/src/kernel-adapter/input.ts
packages/runtime-host/src/kernel-adapter/session.ts
packages/runtime-host/src/storage/index.ts
packages/runtime-server/src/server.ts
packages/runtime-storage-sqlite/src/schema.ts
packages/runtime-storage-sqlite/src/event-store.ts
packages/runtime-storage-sqlite/src/transaction.ts
packages/runtime-storage-sqlite/src/command-receipts.ts
packages/runtime-storage-sqlite/src/log-query.ts
packages/runtime-storage-sqlite/src/adapter.ts
apps/kite-service/src/bootstrap/runtime/turn-command-decision.ts
apps/kite-service/src/bootstrap/runtime/CliRuntimeBridge.ts
apps/kite-service/src/bootstrap/runtime/session-restart-recovery.ts
apps/kite-service/src/bootstrap/runtime/state-actions.ts
apps/kite-service/src/runtime-client/event-projector.ts
apps/kite-service/src/runtime-client/history-adapter.ts
apps/kite-service/src/carrier/native-loopback-carrier.ts
apps/kite-service/src/workspace-worker/runtime-composition.ts
apps/kite-service/src/workspace-worker/application.ts
scripts/release/local-workspace-worker-client.ts
```

关键现有tests：

```text
packages/runtime-host/test/persistent-command-host.test.ts
packages/runtime-host/test/persistent-command-crash-windows.test.ts
packages/runtime-host/test/notification-projector.test.ts
packages/runtime-server/test/runtime-server.test.ts
packages/runtime-storage-sqlite/test/authority.test.ts
packages/runtime-storage-sqlite/test/session-creation.test.ts
apps/kite-service/test/runtime-history-client.test.ts
apps/kite-service/test/workspace-worker/worker.test.ts
apps/kite-service/test/workspace-worker/application.test.ts
apps/kite-service/test/workspace-worker/effect-controller.test.ts
```

本Task在baseline执行上述10个focused test文件：75 tests通过、0失败、972 assertions。覆盖applied receipt/crash windows、subscription
replay/gap/ephemeral、Runtime Server admission/ack/backpressure、Store 7 Controller/session create、Worker capability、History source sequence与
effect/controller fence。该结果证明本文记录的current facts，不证明尚未实现的Agent API contract、Run Store或SSE cursor。

KASAPI-00B是只读evidence Task，不以设计文档替代current authority；后续源码变化必须重新运行相应evidence/tests并更新owner README与
`docs/active/`。
