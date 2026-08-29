# Service Agent API

本页是`apps/kite-service/src/agent-api/`的owner-local current authority。当前仅完成KASAPI-02A认证context与read-only route shell；
Session/History/Checkpoint adapter、Run、mutation、SSE与SDK尚未实现。

## 当前路由

Agent API复用canonical Workspace Worker现有`127.0.0.1:0` data listener，不创建第二端口或Coordinator proxy：

| Route | 当前行为 |
| --- | --- |
| `POST /v1/auth/exchange` | 消费purpose为`agent_api_observer|agent_api_controller`的one-shot Worker capability，返回60分钟context |
| `DELETE /v1/auth/session` | 撤销当前Bearer context，固定204 |
| `GET /v1` | 返回ServerInfo、build/schema digest与当前已实现capabilities；02A固定空capability集合 |
| 其他`/v1/**` | authenticated后固定404 Problem；不存在隐藏mutation或501 partial route |

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
absolute expiresAt
```

TTL固定60分钟且不sliding；最多1024个context。explicit logout、TTL、Client generation supersede、对应Native Runtime connection close、
Worker drain/replacement/restart都会删除context。每次Bearer request重新验证current Client generation。context不写Store、descriptor、Catalog、
History、log或DTO，不持有Session Controller lease；`controller`当前只是future endpoint allowlist。

Request带Origin、Cookie或任一`Sec-Fetch-*`固定403，CORS/OPTIONS不开放。Exchange拒绝invalid UTF-8、duplicate field、unknown field、oversized
body与错误media type。request target固定最多4096 UTF-8 bytes、单path segment 128 bytes、单header 8 KiB、全部header 32 KiB且
Authorization最多512 bytes；越界在owner执行前fail closed。随机源重复不能覆盖或alias既有capability/context；Worker drain若先于异步Trust
admission完成，不消费one-shot capability。所有response使用Problem/DTO codec、no-store、CSP、request ID、API version与artifact digest；错误
不包含path、token、binding或raw body。

## 当前非职责

- 不打开Runtime logical connection，不query Session/History/Checkpoint，不触发recovery；
- 不开放create/cancel/respond/rewind/fork/delete或Controller request/release/resume；
- 不向Browser、Gateway cookie或Web launch token签发context；
- 不让Agent API handler直接取得Store/Host/Kernel/SQLite concrete；
- 不把ServerInfo存在解释为`runs`、`sessions`或其他capability ready。

## 验证

```text
bun test apps/kite-service/test/agent-api/context.test.ts
bun test apps/kite-service/test/workspace-worker/process-foreground.test.ts
bun test apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts
bun test packages/kite-local-runtime/test/coordinator.test.ts
bun run check:agent-api-packages
```

后续KASAPI-02B只有在bounded read adapter及其route tests完成后才可增加ServerInfo capability。任何mutation仍等待ADR-0150 Store 8与
KASAPI-03，不得在本shell中用placeholder handler提前开放。
