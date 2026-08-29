# Service Agent API

本页是`apps/kite-service/src/agent-api/`的owner-local current authority。当前已完成KASAPI-02A～02D认证context、bounded read adapter、
release-bundled Web API docs及read-only conformance/fault Gate；Run、Interaction完整路由、mutation、SSE与SDK尚未实现。

## 当前路由

Agent API复用canonical Workspace Worker现有`127.0.0.1:0` data listener，不创建第二端口或Coordinator proxy：

| Route | 当前行为 |
| --- | --- |
| `POST /v1/auth/exchange` | 消费purpose为`agent_api_observer|agent_api_controller`的one-shot Worker capability，返回60分钟context |
| `DELETE /v1/auth/session` | 撤销当前Bearer context，固定204 |
| `GET /v1` | 返回ServerInfo、build/schema digest与`checkpoints/history/sessions`capabilities |
| `GET /v1/sessions` | bounded live keyset page；可按`lifecycle/status`filter，page内做Runtime projection join |
| `GET /v1/sessions/{session_id}` | 通过context-owned private Runtime logical connection读取closed Session projection与ETag |
| `GET /v1/sessions/{session_id}/history` | safe durable History page；首屏固定`through_sequence`，cursor绑定boundary event digest |
| `GET /v1/sessions/{session_id}/checkpoints` | 按`revision ASC + checkpoint_id ASC`分页的safe metadata |
| `GET /v1/sessions/{session_id}/checkpoints/{checkpoint_id}/preview` | 只返回变更/冲突/行数计数与Session ETag，不返回path |
| 其他`/v1/**` | authenticated后固定404 Problem；不存在隐藏Run、Interaction、mutation、SSE或501 partial route |

carrier在完成loopback peer与exact Host校验后把整个`/v1`namespace交给Agent API handler；query、method、media type、Browser signal与
Bearer由handler按Public contract验证。health/ready、private connect/History/App Control/Controller与`/rpc`继续原路径，不接受Agent
context token。

## Capability exchange

Coordinator/Worker capability purpose扩展为`agent_api_observer`与`agent_api_controller`。只有authenticated Native Coordinator peer可mint；
Web Gateway peer仍只能mint`web_observer`。Capability保持32-byte base64url、hash-only、30秒TTL、WorkerScope/instance/Workspace/
Client/generation/purpose bound。

Agent exchange只发送`Authorization: Kite-Connection <capability>`与strict JSON body，不要求Public Client回显private Client/generation
headers。Worker capability owner对有界issued records做constant-time hash匹配，恢复已认证binding并一次性删除record；Native/Browser private
capability不能在该seam消费。高generation mint会fence同Client旧generation及未消费capability，低generation mint fail closed。

在消费capability前，exchange通过现有Workspace admission重新检查canonical path、Trust与Project identity。untrusted返回403，admission
unavailable返回503，两者都不消耗capability。required capability不满足或context capacity overload同样不消耗。

## Context authority

成功exchange生成32-byte CSPRNG context token；response只返回raw token一次，Worker内存只保存SHA-256 digest及：

```text
WorkerScope / Worker instance / Workspace digest
Native Client ID / connection generation
observer | controller role
private Runtime logical connection ID
absolute expiresAt
```

TTL固定60分钟且不sliding；最多1024个context。explicit logout、TTL、Client generation supersede、对应Native Runtime connection close、
Worker drain/replacement/restart都会删除context。每次Bearer request重新验证current Client generation。context不写Store、descriptor、Catalog、
History、log或DTO，不持有Session Controller lease；`controller`当前只是future endpoint allowlist。02B起每个context还拥有一条只允许
initialize/query的private in-process Runtime Client/Server logical connection；logout、Trust撤销、TTL/generation fence与drain都会关闭它。
除logout外，每次Bearer request重新执行canonical Workspace admission：untrusted固定403并撤销context，temporarily unavailable固定503但不把
旧Trust推断为允许。

每context最多16个in-flight非SSE request；第17个固定429/Retry-After。logout、Trust撤销、generation fence与Worker drain先从admission map删除
context、拒绝新请求，等待已经认证且正在重验Trust/读取的请求收敛后只关闭一次private Runtime connection。异步Trust admission返回时还会复核
handler/context仍current；因此drain或replacement不能让迟到admission继续读取。close等待pending connection open与全部in-flight request，
不把正在执行的read遗留给replacement。

Request带Origin、Cookie或任一`Sec-Fetch-*`固定403，CORS/OPTIONS不开放。Exchange拒绝invalid UTF-8、duplicate field、unknown field、oversized
body与错误media type。request target固定最多4096 UTF-8 bytes、单path segment 128 bytes、单header 8 KiB、全部header 32 KiB且
Authorization最多512 bytes；越界在owner执行前fail closed。随机源重复不能覆盖或alias既有capability/context；Worker drain若先于异步Trust
admission完成，不消费one-shot capability。所有response使用Problem/DTO codec、no-store、CSP、request ID、API version与artifact digest；错误
不包含path、token、binding或raw body。

## 当前非职责

- 不直接取得RuntimeAccess/Host/Store/Kernel/SQLite concrete；private logical connection只允许Runtime query，不允许command/subscribe；
- 不开放create/cancel/respond/rewind/fork/delete或Controller request/release/resume；
- 不向Browser、Gateway cookie或Web launch token签发context；
- 不调用complete transcript convenience或先物化全Workspace Session/History/Checkpoint再分页；
- 不把已发布的三个read capability解释为`runs`、`interactions`、`session_stream`或mutation ready。

## Bounded read与cursor

Session page source在Store 7已打开的同一SQLite connection执行bounded keyset query，不新开reader/writer、不加DDL/index；adapter只对该页最多100个
ID以并发上限8执行in-process Runtime query join。History page使用同connection的bounded event sequence window，经既有Service safe projector
投影user/model/tool closed fields；cursor携带public Session scope、固定through sequence、boundary event digest与`sequence + public_ordinal`，
支持同一durable model event展开reasoning/message后精确续页。rewind/delete导致boundary缺失或替换返回409 `cursor_invalidated`。
History projector按Public codec的1 MiB encoded message上限逐项计算；达到上限时保留最后已返回`sequence/public_ordinal`并提前生成next cursor，
而不是构造超限body后返回503。单个bounded Public item若仍无法容纳才视为temporarily unavailable。

Checkpoint metadata port同样绑定现有Store connection，单页最多200项，选中snapshot逐个验证current schema/epoch/checksum；preview再通过
Runtime query验证checkpoint并只投影计数。cursor是canonical JSON的base64url opaque value并带domain-separated unkeyed checksum；它只发现
损坏，不授权，每次请求仍重新验证context Workspace/Session scope。missing返回404，checkpoint失效返回409，corrupt/unavailable返回503；
legacy-only不触发import或fallback。

## KASAPI-02D conformance Gate

`test/agent-api/reference-client.ts`是test-only contract-driven client：每个success/Problem都经
`@kite-ai/agent-api-contract` response decoder，并复核API version、artifact digest、request ID、no-store、nosniff与media type。它同时驱动
in-memory handler与真实Workspace Worker HTTP listener，覆盖observer/controller read等价、mutation/SSE固定404、capability缺失/重放、
Session/Checkpoint keyset pagination、并发新Session、History固定through sequence、1 MiB body/response、Worker close/replacement、16-request
overload/drain及path/token/Workspace/binding non-disclosure。static assertion继续禁止Agent adapter导入direct `RuntimeAccess`、Agent Kernel、
Runtime Host或SQLite concrete。Gateway restart由独立Gateway process/carrier suite验证，且Gateway从不代理`/v1`。

## 验证

```text
bun test apps/kite-service/test/agent-api/context.test.ts
bun test apps/kite-service/test/agent-api/read-adapter.test.ts
bun test apps/kite-service/test/agent-api/conformance.test.ts
bun test apps/kite-service/test/workspace-worker/application.test.ts
bun test apps/kite-service/test/workspace-worker/process-foreground.test.ts
bun test apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts
bun test packages/kite-local-runtime/test/coordinator.test.ts
bun run check:agent-api-packages
```

KASAPI-02D已关闭read-only Gate，但不会自动发布`runs`。任何Run/mutation仍等待ADR-0150 Store 8子计划与KASAPI-03，
不得在Store 7或read adapter中用placeholder、event scan或sidecar事实提前开放。
