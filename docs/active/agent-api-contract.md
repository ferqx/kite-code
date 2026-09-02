# Agent API Public Contract 当前边界

状态：active

读取时机：修改`packages/agent-api-contract`、`packages/agent-api-client`、Service Agent API HTTP adapter、Browser `/v1`消费、
OpenAPI/schema生成、Public compatibility或静态`/api-docs` artifact时。

验证：`bun run check:agent-api-packages`、`bun run --cwd packages/agent-api-contract test`、
`bun run --cwd packages/agent-api-contract typecheck`、`bun run --cwd packages/agent-api-contract build`、
`bun run --cwd packages/agent-api-client test`、`bun run --cwd packages/agent-api-client typecheck`、
`bun test apps/kite-service/test/agent-api`、`bun run check:docs-impact`。

相关：ADR-0149、ADR-0150、ADR-0155；owner-local边界见
[`packages/agent-api-contract/README.md`](../../packages/agent-api-contract/README.md)与
[`packages/agent-api-client/README.md`](../../packages/agent-api-client/README.md)。

## 当前实现事实

`@kite-ai/agent-api-contract`是private、browser-safe Public Agent API V1 wire contract owner。它从同一Zod source生成OpenAPI 3.1、JSON
Schema、standalone wire declarations、examples与SHA-256 digest。`@kite-ai/agent-api-client`是唯一production Browser HTTP client，只封装
已实现的Browser auth、Workspace、Session、History、诊断Log、Browser-only Model Context与Checkpoint read，不拥有discovery、重试daemon、offline cache、SSE或业务WebSocket。

当前有两类principal；Browser principal只由显式App Server daemon v2 listener承载，Native/automation principal仍可由内部Worker carrier承载：

- Native/automation one-shot capability换Workspace-scoped Agent bearer context；
- daemon的目录、API Docs与受限Workspace-scoped Session SPA shell创建daemon-scoped、HttpOnly/SameSite Browser cookie；OpenAPI JSON与hashed assets不创建cookie。

两者复用同一read adapter/query authority。Agent context继续绑定exact Workspace、Client/generation与一条private Runtime logical
connection；Browser只读取Store 9 Directory允许投影的Workspace/Session，不能调用全局`GET /v1/sessions`、mutation或SSE。cookie、bearer、
Native header混用fail closed。

当前Browser-ready surface是`GET /v1`、Browser logout、Workspace page、Workspace-scoped Session page、Session get、History/Log/Model Context page、
Checkpoint list/preview。History支持`after_sequence`增量边界；它与cursor互斥。Run、Interaction、mutation、SSE与外部SDK尚未ready，
OpenAPI中存在future contract不等于ServerInfo capability开放。

## Contract与安全规则

- request及嵌套对象closed；unknown/prototype/accessor/cycle/deep/oversize/unsafe number在owner执行前拒绝；
- response允许旧Client忽略新增optional field，但Server encoder拒绝undeclared field；
- schema tag、ID、timestamp、text、page、cursor、array、depth、object key与UTF-8 byte均有hard limit；
- Public DTO不包含Workspace/Store path、Worker/Controller binding、credential、Provider-native options/response或raw Runtime event；唯一模型请求正文
  例外是Browser-only Model Context的provider-neutral system/messages/tools显式诊断投影；
- Browser mutation要求exact Origin；Browser只读GET允许Origin缺失但存在时必须exact，且所有Browser请求都要求same-origin Fetch Metadata、
  cookie principal与无Authorization。Agent请求拒绝Origin/Cookie/Sec-Fetch；
- 所有response带`no-store`、API version、artifact digest与request ID；Problem不泄漏内部binding或path；
- Session direct read在Browser context下先验证Directory membership；不存在的或不可见的identity统一404；
- Browser capability仅发布`checkpoints/history/sessions/workspaces`，不把controller role或contract operation误当ready capability。

## Bounded read与artifact

Workspace来自同一Store 9 Directory，不由Session数组反推；Workspace/Session page使用opaque bounded cursor。Session/History/Log/Checkpoint读取
复用daemon已打开的Runtime/History/`kite-session.sqlite` authority，不创建第二SQLite connection、Browser cache或恢复sidecar。History固定
`through_sequence`并用boundary digest与`sequence/public_ordinal`续页；`after_sequence`只读取更晚durable event，适合可见性敏感轮询。
Checkpoint preview只返回计数，不返回path。

Log page复用同一History读取authority与固定through boundary，但它不是raw Runtime event出口：每个item只包含sequence/time、event type、
category、status、bounded summary及closed detail kind/标量fields/artifact availability。Public DTO不携带event ID、path、credential或任意metadata；
Web只在用户切换到Runtime logs Tab时按需读取，并提供显式刷新，不新增后台同步engine。
History/SSE工具生命周期将`rejected`作为独立terminal状态：它只表示dispatch前拒绝，携带稳定reason code和脱敏摘要，
不能折叠为`failed`或暴露raw Runtime reason。Web据此不显示exit code与`No output`。

Model Context route只接受Browser principal，并以可见Session与exact invocation绑定。Service从prepared event取得private Surface ref，经Builtin reader
完成schema/integrity验证后再交叉验证ref integrity、route fingerprint与purpose；Public响应不含Artifact ref/digest、Provider options、endpoint或Credential。
system prompt、canonical messages与tool declarations使用独立累计byte budget并逐段报告truncated，整体仍受1 MiB response limit。Web只在用户从
`model.invocation_prepared`显式打开Inspector时读取，不做预取、轮询、缓存或持久化。

Workspace Session的`display_name`优先使用Directory中的持久化名称；名称为空时，Service通过同一History authority从首条用户消息派生只读展示名，
不存在用户消息或标题读取不可用时回退Session ID。该展示派生不引入第二份标题状态，也不回写Store。

generated artifact使用canonical key order、无timestamp/absolute path/真实endpoint。OpenAPI security同时描述Worker capability、Agent context
bearer与Browser session cookie；GET resource按principal声明，mutation仍只允许bearer contract。Vite逐字节复制canonical OpenAPI到
`payload/web/api-docs/openapi.json`，candidate manifest checksum绑定该文件。

## 后续边界

后续Run/mutation/SSE/SDK必须消费当前artifact/digest并新增production capability与consumer证据。不得把SSE、通用poll scheduler、fallback BFF、
第二Store connection或Browser bearer custody提前加入当前启动路径。
