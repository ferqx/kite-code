# Service Agent API

本页是`apps/kite-service/src/agent-api/`的owner-local current authority。当前Service在唯一single-Service loopback listener上提供Agent bearer与
Browser cookie两种只读principal；Run/Interaction mutation、SSE与外部SDK尚未实现。

## 当前路由

| Route | 当前行为 |
| --- | --- |
| `POST /v1/auth/exchange` | 消费`agent_api_observer|agent_api_controller` one-shot Worker capability，创建Workspace-scoped bearer context |
| `DELETE /v1/auth/session` | 撤销当前bearer context |
| `DELETE /v1/auth/browser/session` | 撤销当前Browser session |
| `GET /v1` | 返回build/schema digest及当前principal capability |
| `GET /v1/workspaces` | Browser/Agent可见的path-free Workspace page；Browser数据来自Store 9 Directory |
| `GET /v1/workspaces/{workspace_id}/sessions` | 一个可见Workspace的bounded Session page；空持久化标题从首条用户消息派生展示名，无消息时回退Session ID |
| `GET /v1/sessions` | 仅Agent bearer的Workspace-scoped Session page；Browser固定404 |
| `GET /v1/sessions/{session_id}` | closed Session projection与ETag；Browser先验证Directory membership |
| `GET /v1/sessions/{session_id}/history` | 固定through boundary的safe History；可用互斥的`after_sequence`做增量读取 |
| `GET /v1/sessions/{session_id}/logs` | 固定through boundary的safe durable diagnostic Log；只投影closed event type/category/status/summary/detail fields |
| `GET /v1/sessions/{session_id}/model-invocations/{invocation_id}/context` | Browser-only、bounded Model Context；返回exact provider-neutral system/messages/tools与safe settings |
| `GET /v1/sessions/{session_id}/checkpoints` | safe Checkpoint metadata page |
| `GET /v1/sessions/{session_id}/checkpoints/{checkpoint_id}/preview` | 只返回变更/冲突/行数计数，不返回path |
| 其他`/v1/**` | 固定404 Problem；不存在隐藏mutation、SSE或501 partial route |

carrier完成loopback peer与exact Host校验后把整个`/v1`namespace交给同一个handler；Browser auth authority随Service-owned static surface
一起创建，不是第二listener、proxy或可独立启停的lifecycle。health/ready、private Runtime/App Control/Controller与`/rpc`继续原路径。

## Principal与生命周期

Agent exchange在消费capability前重新验证Workspace Trust，创建hash-only、60分钟、最多1024个context，并绑定WorkerScope/instance、Workspace
digest、Client/generation、role与一条query-only private Runtime logical connection。logout、TTL、generation drift、Trust撤销、connection close、
drain/restart关闭context。

`GET /`创建或复用受TTL/容量限制的内存Browser session。cookie不暴露给JavaScript，不写Kite Home。logout、Service close/restart、expiry
撤销session；Browser关闭不停止Service。Browser principal是
service-scoped read-only，但每个Session direct read必须在Store 9 Directory中可见。

真实浏览器的同源GET不保证发送`Origin`：Browser只读GET允许Origin缺失但存在时必须exact；logout要求exact Origin。Browser API请求都
必须带`Sec-Fetch-Site: same-origin`与`cors|same-origin`mode，cross-site保持403。

Agent request携带Origin/Cookie/Sec-Fetch固定403；Browser与bearer/Native header混用同样fail closed。所有request受target、segment、header、body、
media type、并发与response byte上限约束；所有response使用contract codec、`no-store`、request ID、API version与artifact digest。

## Read composition

production executable只打开一个`kite.sqlite`与一个Runtime/History composition。Browser read context直接引用同一Directory、Runtime query、
History client与Checkpoint store；它的close是Service composition的生命周期边界，不建立reader pool、Browser cache或第二DB。

Workspace cursor按Directory稳定identity续页。Workspace Session page只对当前Workspace记录做Runtime projection；展示标题优先使用持久化名称，
名称为空时通过同一History authority读取首条用户消息生成最多80字符的只读展示名，空会话回退Session ID，且不反向写入Store。History cursor携带Session、固定
through sequence、boundary event digest与`sequence/public_ordinal`；`after_sequence`从指定durable sequence之后开始，不能与cursor同时使用。
Log page复用同一History authority和boundary digest，一条durable event对应一个Log item，不暴露event ID、raw Runtime object、path或credential；
detail只允许Runtime log projector的固定kind、标量fields与artifact availability。History与Log达到1 MiB encoded response上限时提前生成cursor。
`tool.rejected`在History中保持独立`rejected`生命周期，使用稳定reason code和脱敏pre-dispatch摘要；不得映射为`failed`，
也不得投影raw拒绝reason、exit code或输出。
Checkpoint cursor按revision/id续页，preview不投影path。

`model.invocation_prepared` Log只公开opaque invocation identity与purpose。Model Context route先要求Browser Directory membership，再从同一Session的
prepared event取得private Surface ref，通过Builtin `ModelArtifactStore`完成schema/integrity readback，并交叉验证ref integrity、route fingerprint与purpose。
响应只投影system prompt、canonical messages、tool declarations和transport/token settings；messages/tools/system各自限界并报告truncated，且整个响应
继续受1 MiB上限。Artifact ID/integrity、Provider options/response、endpoint与Credential固定不进入Public DTO。Agent bearer调用该Browser-only route
统一404。

## 验证

```text
bun test apps/kite-service/test/agent-api/context.test.ts
bun test apps/kite-service/test/agent-api/read-adapter.test.ts
bun test apps/kite-service/test/agent-api/conformance.test.ts
bun test apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts
bun test apps/kite-service/test/single-service-infrastructure.test.ts
bun run check:agent-api-packages
```
