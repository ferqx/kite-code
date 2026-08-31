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
已实现的Browser auth、Workspace、Session、History与Checkpoint read，不拥有discovery、重试daemon、offline cache、SSE或业务WebSocket。

同一个single-Service listener实现两类principal：

- Native/automation one-shot capability换Workspace-scoped Agent bearer context；
- Service根页面创建service-scoped、HttpOnly/SameSite Browser cookie。

两者复用同一read adapter/query authority。Agent context继续绑定exact Workspace、Client/generation与一条private Runtime logical
connection；Browser只读取Store 9 Directory允许投影的Workspace/Session，不能调用全局`GET /v1/sessions`、mutation或SSE。cookie、bearer、
Native header混用fail closed。

当前Browser-ready surface是`GET /v1`、Browser logout、Workspace page、Workspace-scoped Session page、Session get、History page、
Checkpoint list/preview。History支持`after_sequence`增量边界；它与cursor互斥。Run、Interaction、mutation、SSE与外部SDK尚未ready，
OpenAPI中存在future contract不等于ServerInfo capability开放。

## Contract与安全规则

- request及嵌套对象closed；unknown/prototype/accessor/cycle/deep/oversize/unsafe number在owner执行前拒绝；
- response允许旧Client忽略新增optional field，但Server encoder拒绝undeclared field；
- schema tag、ID、timestamp、text、page、cursor、array、depth、object key与UTF-8 byte均有hard limit；
- Public DTO不包含Workspace/Store path、Worker/Controller binding、credential、Provider正文或raw Runtime event；
- Browser mutation要求exact Origin；Browser只读GET允许Origin缺失但存在时必须exact，且所有Browser请求都要求same-origin Fetch Metadata、
  cookie principal与无Authorization。Agent请求拒绝Origin/Cookie/Sec-Fetch；
- 所有response带`no-store`、API version、artifact digest与request ID；Problem不泄漏内部binding或path；
- Session direct read在Browser context下先验证Directory membership；不存在的或不可见的identity统一404；
- Browser capability仅发布`checkpoints/history/sessions/workspaces`，不把controller role或contract operation误当ready capability。

## Bounded read与artifact

Workspace来自同一Store 9 Directory，不由Session数组反推；Workspace/Session page使用opaque bounded cursor。Session/History/Checkpoint读取
复用single-Service已打开的Runtime/History/Store authority，不创建第二SQLite connection、Browser cache或恢复sidecar。History固定
`through_sequence`并用boundary digest与`sequence/public_ordinal`续页；`after_sequence`只读取更晚durable event，适合可见性敏感轮询。
Checkpoint preview只返回计数，不返回path。

generated artifact使用canonical key order、无timestamp/absolute path/真实endpoint。OpenAPI security同时描述Worker capability、Agent context
bearer与Browser session cookie；GET resource按principal声明，mutation仍只允许bearer contract。Vite逐字节复制canonical OpenAPI到
`payload/web/api-docs/openapi.json`，candidate manifest checksum绑定该文件。

## 后续边界

后续Run/mutation/SSE/SDK必须消费当前artifact/digest并新增production capability与consumer证据。不得把SSE、通用poll scheduler、fallback BFF、
第二Store connection或Browser bearer custody提前加入当前启动路径。
