# Kite Agent Server API V1 Public Contract Freeze

状态：frozen（KASAPI-00C；production contract输入，不是current behavior authority）

日期：2026-08-29

基线：`docs/kasapi-00c-contract-freeze@b5f3695d`

相关：[`ADR-0149`](../../adr/0149-stable-local-agent-api-facade.md)、
[`ADR-0150`](../../adr/0150-store-8-canonical-runtime-run-index.md)、
[`当前证据矩阵`](2026-08-29-kite-agent-server-api-v1-evidence.md)、
[`实施方案`](../plans/2026-08-29-kite-agent-server-api-v1.md)。

## 1. 冻结结论

本文关闭KASAPI-00C全部Public contract选择。KASAPI-01A/01B必须把本文逐项编码为codec、OpenAPI、JSON Schema、fixtures与tests；
后续实现不能在handler或SDK中另选status、header、cursor、auth或retry语义。若实现证据证明某项不可兑现，必须先修订本文并用新ADR处理
authority变化，不能发布`200|202`、`409|426`或“暂时兼容”的双轨行为。

固定结论：

1. Agent data plane只在canonical Workspace Worker既有loopback listener下注册`/v1`；Web Gateway只拥有静态`/api-docs`；
2. one-shot Worker capability只用于`POST /v1/auth/exchange`，换取60分钟、hash-only、in-memory Agent API context bearer；
3. observer只能读，controller只是endpoint allowlist；existing Session mutation仍逐请求验证Store Controller lease并pin
   `bindingReference`；
4. Public idempotency identity不包含Client、connection、capability或Worker instance；只有applied receipt被持久重放；
5. first-class Run依赖ADR-0150 Store 8，Store 7不开放`runs`capability或partial Run route；
6. 所有mutation response返回`applied_revision`与`stream_consistency = refetch_required`，V1不承诺当前无法证明的
   `applied_through_event_id`；
7. pagination是bounded live keyset；History使用固定`through_sequence`，concurrent delete/rewind使相关cursor显式invalidated；
8. SSE durable cursor为`generation + raw durable sequence + public ordinal + filter fingerprint`；ephemeral和generation drift必须resync；
9. GET不触发recovery；restart后未resume的nonterminal Session/Run只投影unavailable/unknown；
10. Public compatibility由path major、schema tags与capabilities决定，Native exact build identity继续独立验证。

## 2. Transport、media type 与公共headers

### 2.1 固定transport

- Agent API：HTTP/1.1 loopback，JSON REST与SSE；不开放LAN socket、Unix socket public contract、HTTP/2、WebSocket或public `/rpc`；
- JSON request：`Content-Type: application/json`；有body而缺失/错误media type返回`415 unsupported_media_type`；
- JSON response：`application/json; charset=utf-8`；错误为`application/problem+json; charset=utf-8`；
- SSE：request必须接受`text/event-stream`，否则`406 not_acceptable`；response固定`text/event-stream; charset=utf-8`、
  `Cache-Control: no-store`、`X-Accel-Buffering: no`；
- 所有authenticated response固定`Cache-Control: no-store`；不得由Browser cache、Service Worker或Gateway缓存data plane；
- request path、query name、header name、JSON object与discriminant均closed；未知query、重复singleton header或重复JSON key返回
  `400 invalid_request`。

### 2.2 公共headers

| Header | request/response | 规则 |
| --- | --- | --- |
| `Authorization` | request | exchange使用`Kite-Connection <one-shot-token>`；其余`/v1`使用`Bearer <context-token>`；不得进query/cookie/body |
| `Idempotency-Key` | mutation request | exact一份，base64url字符`[A-Za-z0-9_-]`，22～128字符；auth lifecycle与GET例外 |
| `If-Match` | existing Session mutation | exact quoted Session ETag；禁止`*`、weak ETag、多值；缺失返回428 |
| `ETag` | resource/mutation response | exact`"session:<session_id>:rev:<decimal>"`；表达Session revision，不表达HTTP representation hash |
| `Location` | create response | absolute-path-only canonical resource URL，不含host、token或Workspace信息 |
| `Last-Event-ID` | SSE request | 最长1024 bytes的opaque exclusive cursor；query parameter不接受event ID |
| `Retry-After` | 202 wait、429、503 | decimal seconds；wait timeout固定`1`，overload/unavailable为1～30 |
| `X-Request-ID` | response | Server生成base64url opaque ID，最大64字符；Client输入同名header被拒绝，不允许日志注入 |
| `Kite-Agent-API-Version` | response | 固定`v1` |
| `Kite-Agent-API-Schema-Digest` | response | contract-generated lowercase SHA-256 hex；不是Native build handshake |

所有mutation response body使用closed receipt envelope：

```json
{
  "schema": "kite.agent-api.mutation-result.v1",
  "operation": "create_run",
  "mutation_id": "agc_opaque",
  "replayed": false,
  "applied_revision": 42,
  "stream_consistency": "refetch_required",
  "resource": {}
}
```

`mutation_id`是canonical private command identity的opaque Public表示；`replayed`表示本次是否命中durable applied receipt。`resource`由
operation-specific schema替换，不能使用untyped object。V1不返回`applied_through_event_id`：HTTP成功后SDK必须用返回ETag/revision GET
resource，或重新建立SSE resync boundary，不能根据response与event到达顺序去重。

## 3. Agent API context与角色

### 3.1 Exchange

`POST /v1/auth/exchange`消费一个由Coordinator/Worker Native journey签发、purpose为`agent_api_observer`或
`agent_api_controller`的one-shot capability。request：

```json
{
  "schema": "kite.agent-api.exchange.v1",
  "api_version": "v1",
  "required_capabilities": ["sessions", "history"]
}
```

`required_capabilities`最多16项、去重且来自ServerInfo allowlist。major不支持或required capability缺失返回
`426 incompatible`；普通`build_id`不同不触发426。成功固定`201`：

```json
{
  "schema": "kite.agent-api.context.v1",
  "access_token": "opaque-secret",
  "token_type": "Bearer",
  "expires_at": "2026-08-29T10:00:00.000Z",
  "role": "observer",
  "api_version": "v1",
  "capabilities": ["sessions", "history"]
}
```

context token使用32 bytes CSPRNG base64url；Worker内存只保存hash。TTL固定60分钟absolute、不sliding。context绑定exact WorkerScope、
Workspace identity digest、Worker instance、Native Client ID、connection generation、purpose、role与private logical connection ID。以下任一
发生即revoke：explicit logout、TTL、Native generation superseded/disconnect、Worker drain/replacement/restart、Workspace Trust撤销或binding
不一致。raw capability/context token不持久、不记录、不进入descriptor、DTO、Problem或SSE URL。

`DELETE /v1/auth/session`使用Bearer自撤销，固定`204`，重复调用因token已失效返回同一低信息`401`。Exchange/logout是credential
lifecycle，不是Runtime mutation，不使用Idempotency-Key或receipt。

Exchange或data-plane request出现`Origin`，或任一`Sec-Fetch-*` Browser navigation/request header时固定`403 forbidden`；CORS preflight
不开放。该检查是Browser defense-in-depth，不替代capability。Web launch token/cookie、Gateway access token、Provider credential与Native
lifecycle token均不能用于exchange。

### 3.2 角色与Controller

| Operation | observer | controller | 额外authority |
| --- | --- | --- | --- |
| ServerInfo、Session/Run/Interaction read、History、Checkpoint read、SSE | allow | allow | exact Workspace scope |
| Create Session | deny | allow | authenticated Native client tuple；create transaction建立initial Controller |
| Resume/close/delete、create/cancel Run、Interaction response、rewind/fork | deny | allow | target/source Session current Store Controller lease与generation |
| request/release/resume/detach Controller | 不存在 | 不存在 | 只属于Native App Control |

observer命中mutation固定`403 forbidden`。controller context不缓存“已拥有所有Session”：每次existing Session mutation重新读取Store lease，
要求client ID、connection generation、Worker instance与active lease一致，再由`WorkerCommandContextRegistry.pin()`生成request/Session/command
绑定的short-lived `bindingReference`。RuntimeCommandContext只接收private logical connection ID、Server request ID与bindingReference；
Controller generation、token与lease不进入Public body/header。binding缺失、detached或generation drift返回`409 controller_conflict`，且不产生
receipt。cross-Workspace或无权观察的Session统一`404 not_found`，不泄漏存在性。

## 4. Limits与closed input

| 项目 | V1上限 |
| --- | --- |
| request target/path | 4096 bytes；path segment 128 UTF-8 bytes |
| headers | 总计32 KiB；单header 8 KiB；Authorization 512 bytes |
| JSON body | 1 MiB；UTF-8 only；max depth 16；单object 256 properties；单array 256 items |
| create Run `input` | 256 KiB UTF-8 bytes，trim后至少1 code point |
| display/name/reason | 256 UTF-8 bytes |
| IDs/discriminants | 128 ASCII bytes；必须通过各自closed pattern |
| `initial_skills` | 32项；`skill_id` 128 bytes；每项input 32 KiB且仍受整体depth/body限制 |
| page `limit` | default 50；minimum 1；maximum 200 |
| cursor/Last-Event-ID | 1024 bytes |
| History event/page encoded response | 200项且不超过1 MiB；达到byte limit提前结束并返回next cursor |
| wait | `timeout_ms` 0～30000，default 0；每context最多4个并发wait |
| SSE | 每context最多4条；每Session subscription bounded queue 256 public events；heartbeat 15秒 |
| HTTP concurrency | 每context最多16个in-flight非SSE request；超出返回429 |

数字必须是JSON safe integer且非负；NaN/Infinity/string-number拒绝。解析器必须拒绝prototype-shaped key
`__proto__`/`prototype`/`constructor`、duplicate key、invalid surrogate与invalid UTF-8。413只表示传输/body字节上限；结构、字段或值超限用
400。response projector同样受byte/array/text limits；无法安全有界投影时返回503，不截断authorization/interaction identity。

## 5. 资源与restart projection

Public `Session`、`Run`、`Interaction`、`Checkpoint`沿用RFC的snake_case shape，并由KASAPI-01A补齐closed子types。以下语义不可变：

- `run_id`是Store 8中的opaque `turnId`，其authority identity为`(session_id, run_id)`；
- Run status保留`queued/running/waiting/completed/failed/cancelled/unknown`；queued只从Store 8 start commit到activation的durable row产生；
- Run phase只有`planning|building`，在create transaction固定；
- Run timestamp来自Store commit epoch milliseconds，并输出严格`YYYY-MM-DDTHH:mm:ss.SSSZ`；
- Session status由canonical State + Store 8 active Run + recovery availability穷举投影，不从listener/SSE连接猜测；
- Interaction response必须回显完整Server-projected interaction identity，adapter不得只靠`interaction_id`回查并补齐；
- Checkpoint只暴露safe metadata/preview，不暴露raw State/file content。

GET是只读的：Worker restart/replacement后，未由Native journey显式resume的Session query不能调用Host recovery、推进revision、dispatch effect或
settle interaction。此时Session固定投影`lifecycle = unavailable`、`status = unavailable`；其nonterminal Run固定投影
`status = unknown`并携带safe terminal/recovery entry `reconcile`。History仍可从Store读取。`POST .../resume`在Controller binding恢复后才
进入Host recovery；成功200返回新的canonical Session projection。无法证明recovery outcome返回503 `outcome_unknown`，不得返回stale
running。

ADR-0150 coverage boundary以前的private historical turns只进入History，不进入Run list/get。只有Store 8 ready时ServerInfo才包含`runs`；
不存在Store 7上的partial/slow-scan `runs`模式。

## 6. Exact REST surface

除表中列出的success外没有第二成功status。所有Session ETag均来自response中的revision。

| Method/path | role | required request | success | response/headers |
| --- | --- | --- | --- | --- |
| `POST /v1/auth/exchange` | one-shot capability | exchange body | `201` | Context；no-store |
| `DELETE /v1/auth/session` | any context | Bearer | `204` | empty |
| `GET /v1` | observer/controller | Bearer | `200` | ServerInfo |
| `POST /v1/sessions` | controller | key；CreateSession body | `201` | mutation(Session)；Location；ETag |
| `GET /v1/sessions` | observer/controller | `lifecycle? status? limit? cursor?` | `200` | SessionPage |
| `GET /v1/sessions/{session_id}` | observer/controller | none | `200` | Session；ETag |
| `POST /v1/sessions/{session_id}/resume` | controller | key；`after_revision` body；无If-Match | `200` | mutation(Session)；ETag |
| `POST /v1/sessions/{session_id}/close` | controller | key；If-Match；schema-only body | `200` | mutation(Session)；ETag |
| `DELETE /v1/sessions/{session_id}` | controller | key；If-Match；无body | `200` | mutation(DeletedSession) |
| `POST /v1/sessions/{session_id}/runs` | controller | key；If-Match；CreateRun body | `202` | mutation(Run)；Location；ETag |
| `GET /v1/sessions/{session_id}/runs` | observer/controller | `status? phase? limit? cursor?` | `200` | RunPage |
| `GET /v1/sessions/{session_id}/runs/{run_id}` | observer/controller | none | `200` | Run；ETag |
| `POST /v1/sessions/{session_id}/runs/{run_id}/cancel` | controller | key；If-Match；schema-only body | `202` | mutation(Run)；ETag |
| `GET /v1/sessions/{session_id}/runs/{run_id}/wait` | observer/controller | `timeout_ms?` | `200` terminal；`202` nonterminal timeout | Run；ETag；202带Retry-After |
| `GET /v1/sessions/{session_id}/events` | observer/controller | channels；Last-Event-ID? | `200` | SSE |
| `GET /v1/sessions/{session_id}/runs/{run_id}/events` | observer/controller | channels；Last-Event-ID? | `200` | 同一Session sequence的filtered SSE |
| `GET /v1/sessions/{session_id}/interactions` | observer/controller | none | `200` | replacement InteractionQueue；ETag |
| `POST /v1/sessions/{session_id}/interactions/{interaction_id}/responses` | controller | key；If-Match；full identity+response | `200` | mutation(InteractionQueue)；ETag |
| `GET /v1/sessions/{session_id}/history` | observer/controller | `limit? cursor?` | `200` | HistoryPage |
| `GET /v1/sessions/{session_id}/checkpoints` | observer/controller | `limit? cursor?` | `200` | CheckpointPage |
| `GET /v1/sessions/{session_id}/checkpoints/{checkpoint_id}/preview` | observer/controller | none | `200` | CheckpointPreview；ETag |
| `POST /v1/sessions/{session_id}/rewinds` | controller | key；If-Match；checkpoint body | `200` | mutation(Session)；ETag |
| `POST /v1/sessions/{session_id}/forks` | controller | key；source If-Match；checkpoint body | `201` | mutation(target Session)；Location；target ETag |

CreateSession只接受`schema`与可选`display_name`；model/provider/Workspace/path/config/metadata不接受。Resume body只接受schema与required
`after_revision`。CreateRun接受RFC的`schema/input/phase/initial_skills`。Cancel/close为schema-only，DELETE无body。Fork/rewind只接受schema、
`checkpoint_id`及fork可选`display_name`。Interaction response使用kind-specific closed discriminant。

`GET /healthz`与`GET /readyz`继续属于Native carrier，不进入Agent API OpenAPI/SDK、无Bearer/role语义，也不能用于发现Workspace、build、Store
或API capability。Web Gateway的`GET /api-docs`和`GET /api-docs/openapi.json`属于静态Web contract，不在Worker Agent API security
scheme下。

## 7. Idempotency与revision

Public command identity固定为：

```text
command_bytes = UTF8(
  "kite.agent-api.command.v1\0" +
  operation + "\0" +
  canonical_scope + "\0" +
  Idempotency-Key
)
command_id = "agc_" + base64url_no_pad(SHA-256(command_bytes))
```

`operation`是contract内closed名称；不能从raw path拼接。`canonical_scope`由authenticated private facts构造：Create Session使用
`workspace:<workspace_identity_digest>`，existing Session mutation和Fork使用`session:<session_id>`。key按ASCII bytes原样处理，Server不
trim/case-fold。Client ID、connection generation、capability、role、Worker instance、build ID、request ID、ETag与body digest都不进入
command identity。

Public body先strict decode并映射为closed Runtime command；canonical Runtime command JSON继续生成Store request digest。同key/body在
capability refresh、reconnect、Worker restart后命中original applied receipt/result；同command identity而digest不同返回409
`idempotency_conflict`。parse/auth/role/Controller/revision/busy/interaction/checkpoint/overload failure发生在applied transaction前，不写
receipt，同key之后按新事实重新评估。SDK对一次logical mutation生成一次32-byte CSPRNG base64url key，并在所有retry保留；SDK不能在409/412
后自动换key。

`If-Match`只接受当前Session exact ETag。缺失为428 `precondition_required`；语法错误/指向其他Session为400 `invalid_request`；同Session
revision不同为412 `revision_conflict`并返回safe `current_revision`。Server不自动fetch/retry。Resume的`after_revision`是recovery/
presentation barrier，缺失或大于可证明revision为400/503，不使用If-Match。

## 8. Pagination

Cursor是base64url编码的canonical JSON + unkeyed corruption checksum；其内容只含schema、collection、filter fingerprint、稳定key与必要
watermark，不含Workspace path、credential、Store locator或raw identity digest。Client必须视为opaque。checksum只发现损坏，不授权；每次
query仍按authenticated Workspace/Session scope验证。cursor version/collection/filter不匹配返回400 `invalid_cursor`。

| Collection | order / cursor key | concurrent semantics |
| --- | --- | --- |
| Sessions | `session_id ASC` / after Session ID | live keyset；新建且key在after之后可出现；更新不重复；删除可省略 |
| Runs | `created_revision ASC, run_id ASC` / after tuple | live keyset；新Run只追加；rewind删除未读row可省略；cursor key大于current revision时409 invalidated |
| History | `sequence ASC, public_ordinal ASC` / through + after tuple | first page固定`through_sequence`；后续新event不出现；rewind/delete越过watermark时409 invalidated |
| Checkpoints | `revision ASC, checkpoint_id ASC` / after tuple | live keyset；删除/rewind可省略；target revision漂移使cursor invalidated |

Page返回`items`、`next_cursor?`，History另返回`through_sequence`。没有total count；handler不得为了count全量物化。Session page必须由
Service-owned bounded directory/page port提供；History page必须由safe projector + bounded readonly Store query提供，不能调用现有会全量
物化的rich transcript convenience API。invalidated cursor要求Client从第一页重新开始，Server不猜测跳点。

## 9. Problem Details

Problem固定字段：`type = urn:kite:agent-api:problem:<code>`、bounded `title`、HTTP `status`、closed `code`、Server request ID、
`retryable`，以及各code允许的safe optional字段。`detail`若存在最多512 bytes且不得含path/token/raw body/Provider正文/Store/stack。

| HTTP | code | retryable | optional safe field |
| --- | --- | --- | --- |
| 400 | `invalid_request`, `invalid_cursor` | false | `field?` |
| 401 | `unauthorized` | false | none；固定低信息title |
| 403 | `forbidden` | false | none |
| 404 | `not_found` | false | none |
| 405 | `method_not_allowed` | false | none；`Allow` header |
| 406 | `not_acceptable` | false | none |
| 409 | `idempotency_conflict`, `session_busy`, `interaction_mismatch`, `controller_conflict`, `run_not_active`, `checkpoint_unavailable`, `cursor_invalidated` | false | `current_revision?` only where proven |
| 412 | `revision_conflict` | false | `current_revision` |
| 413 | `payload_too_large` | false | `limit_bytes` |
| 415 | `unsupported_media_type` | false | none |
| 426 | `incompatible` | false | `supported_api_versions`, `missing_capabilities?` |
| 428 | `precondition_required` | false | `required_header = If-Match` |
| 429 | `overloaded` | true | Retry-After |
| 503 | `temporarily_unavailable`, `outcome_unknown` | true | Retry-After；`recovery_entry?` |

404用于authenticated scope内不存在或不得泄漏的cross-scope resource。405/406/413/415也返回同一Problem schema。Unexpected internal error
映射503 `temporarily_unavailable`，不暴露exception class。`retryable=true`只授权保留同一key/ETag按documented reconcile重试，不授权生成新
mutation identity。

## 10. SSE cursor、resync与filter

`channels`是逗号分隔、去重、canonical排序后的closed集合：`lifecycle,messages,tools,interactions,session`；缺省为全部五项。
Run endpoint使用同一Session sequence和buffer，只过滤可证明`run_id`相等的data event；transport/resync control event可以无run ID。

Public durable event cursor概念字段固定为：

```text
schema = kite.agent-api.event-cursor.v1
session_id
stream_generation
filter_fingerprint
durability = durable
durable_sequence
public_ordinal
```

一个raw durable sequence投影0～N个Public event，ordinal从0开始；event ID指向exact投影，resume为exclusive。ephemeral cursor另含当前
generation内单调`ephemeral_sequence`，不得跨连接generation恢复。event mapper/codecs/filter digest变化、Last-Event-ID Session/filter不匹配、
generation drift、ephemeral resume、buffer gap或unknown cursor统一发送一个完整的`kite.stream.resync_required` frame。

每条新stream在没有Last-Event-ID时也先发送完整resync frame。该单一SSE frame原子携带：

```text
reason
stream_generation
history_through_sequence
snapshot_revision
Session snapshot
complete Interaction replacement queue
resume_after_event_id
```

Client收到完整frame后丢弃旧ephemeral/presentation state，以History endpoint读取到`history_through_sequence`，应用Session与Interaction
replacement，再以`resume_after_event_id`继续live。frame中断则没有合法boundary，下次必须重新resync。`resume_after_event_id`排除所有
`<= history_through_sequence`的Public durable projection；Server不能发送半个snapshot后让cursor前进。

durable event携带Session revision与可选run ID；只有canonical event/projector证明Run关联才添加。ephemeral event必须标记durability且只在
current generation使用。heartbeat固定为SSE comment `: keepalive`，无ID、不推进cursor/revision。queue达到256时关闭单个stream；不cancel
Run/Session。context到期或Worker drain关闭stream，Client重新exchange/reconnect/resync。

## 11. Compatibility与deprecation

- `/v1`与每个exact schema tag共同定义major；required field移除/新增、既有含义改变、必须理解的discriminant新增需要`/v2`；
- response envelope可以增加optional presentation field；旧Client必须忽略未知optional response field，但request仍fail closed；
- unknown event `event.type`不能被旧Client静默用于state mutation；Server只能在已协商capability/channel下发送必须理解的event；
- ServerInfo capabilities按canonical lexical order去重；缺少Client declared required capability在exchange时426；
- schema digest用于artifact/drift诊断，不要求不同build精确相等；Native manager仍独立验证descriptor/instance/protocol/build companion；
- V1 endpoint弃用使用standard `Deprecation: true`与`Sunset` response header并先提供replacement；V1内不得删除，破坏性删除只在新major；
- OpenAPI artifact、runtime codec、SDK wire types、fixtures与Web静态spec必须共享同一digest；artifact不含真实endpoint/token/path；
- 当前V1不协商minor header、不按User-Agent切换行为、不提供legacy alias、compat fallback或experimental field flag。

## 12. 00C Gate结果

以下原未决项已关闭：auth context、stable idempotency mapper、Controller binding、Run authority、pagination、HTTP status/header、SSE
resync、restart read、compatibility与limits。唯一implementation blocker是ADR-0150 Store 8 tranche；它只阻断KASAPI-03 Run/mutation，
不阻断KASAPI-01 contract/OpenAPI和KASAPI-02 authenticated read-only façade。

本文仍不宣称任何endpoint已运行。KASAPI-01开始后，codec/OpenAPI若不能逐项表达本文，Gate应失败并回到contract review；不得由implementation
自行放宽。
