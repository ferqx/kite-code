# Agent API Public Contract 当前边界

状态：active

读取时机：修改`packages/agent-api-contract`、`packages/agent-api-client`、Service Agent API HTTP adapter、Browser `/v1`消费、
OpenAPI/schema生成、Public compatibility或静态`/api-docs` artifact时。

验证：`bun run check:agent-api-packages`、`bun run --cwd packages/agent-api-contract test`、
`bun run --cwd packages/agent-api-contract typecheck`、`bun run --cwd packages/agent-api-contract build`、
`bun run --cwd packages/agent-api-client test`、`bun run --cwd packages/agent-api-client typecheck`、
`bun test apps/kite-service/test/agent-api`、`bun run check:docs-impact`。

相关：[Agent Note 0149（部分已交付的提案）](../../.agents/notes/proposed/feature/2026-08-29-stable-local-agent-api-facade.md)、[Agent Note 0150](../../.agents/notes/implemented/simplification/2026-08-29-store-8-canonical-runtime-run-index.md)；owner-local边界见
[`packages/agent-api-contract/README.md`](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/packages/agent-api-contract/README.md)与
[`packages/agent-api-client/README.md`](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/packages/agent-api-client/README.md)。

2026-10-26 已按用户要求删除除 `apps/kite-cli` 外的旧架构模块。当前实现由[现行 workspace 边界](unified-agent-boundary.md)及各现行 owner 定义；本文指向删除前固定 revision 的源码、旧模块机制和旧测试仅供历史追溯，不再是可运行入口。仍适用的授权、未知结果、恢复、数据保护与发布资格约束继续生效，删除源码不表示这些门禁已经通过。

## 当前 Trajectory 与 Trace 管理

当前同源 [Service schema](../../apps/service/src/http/schema/index.ts)与生成 Client 新增 `trajectory`、`trajectory_evidence`、`trace_extensions` 可选能力，已有 API major、工具定义版本与 Session Logs 合同保持。事件 open 固定 upper，后页携带同范围／filter及排他 after，每页短事务重新准入；返回空匹配页仍可推进 scannedThrough，穷尽不证明完整或终态。Evidence 独立按精确 event/ref/version/atCursor 授权，连续块绑定 view SHA／长度与读取 epoch，取消／撤销停止后续块。

规范事件可选封存原 Model／Context 的有限压缩身份与 automatic／manual 分类，以及 Interaction 的 approval／question／plan_review 分类；缺少这些字段的旧事实仍有效，不追补历史。Desktop 默认四类视图只筛选展示与详情页，不改变底层读取 scope、原父子关系、保存或导出范围；API major、事实格式和 Projector 版本保持。

独立`message`事实封存原消息身份、角色、序号、修订及完成状态，正文经独立`message` Evidence沿原授权与准确版本读取。消息事件和正文分别受Trace grant中的eventKinds与evidenceKinds显式约束，现有授权不会自动包含新类型；第三方messageRef沿安装域和可证原消息出处做opaque映射，不输出原messageId或正文属性。用户消息和Agent回复是默认树的对话上下文，旧事实没有消息身份时不重建历史；各协议版本保持原值。

Trace 管理只提供具名安装／配置／grant／启停／更新／卸载、历史任务／DLQ与用途凭据操作，不接受自报主体、宿主路径或通用 secret resolve。历史 fromSequence／toSequence 均为包含边界，Host 转换为Reader的排他 after；暂停／继续保持首次 upper。安装／配置不自动启用，Full 模式不授予外发，Host ACK 与 OTel 远端结果分别报告。准确当前合同归 [Trace owner](../../apps/service/src/trace-extensions/README.md)与[Client](../../packages/client/README.md)。

同源轨迹索引可包含第一方 `display.outputPresence`，只绑定原事件准确公开输出的正文存在性、工具调用数量与完整性。没有该字段的旧事实保持未知，不从正文预览或加载状态推断为空；原消息、材料与父子关系不删除。生成 schema／Client／离线包同步保留该可选值，第三方 Trace 继续排除 `display`，既有 grant、API major、事件与材料版本均不变。

## 当前实现事实

`@kite-ai/agent-api-contract`是private、browser-safe Public Agent API V1 wire contract owner。它从同一Zod source生成OpenAPI 3.1、JSON
Schema、standalone wire declarations、examples与SHA-256 digest。`@kite-ai/agent-api-client`是唯一production Browser HTTP client，只封装
已实现的Browser auth、Workspace、Session、History、后台执行快照、诊断Log、Browser-only Model Context与Checkpoint read，不拥有discovery、重试daemon、offline cache、SSE或业务WebSocket。

当前有两类principal；Browser principal只由显式App Server daemon v2 listener承载，Native/automation principal仍可由内部Worker carrier承载：

- Native/automation one-shot capability换Workspace-scoped Agent bearer context；
- daemon的目录、API Docs与受限Workspace-scoped Session SPA shell创建daemon-scoped、HttpOnly/SameSite Browser cookie；OpenAPI JSON与hashed assets不创建cookie。

两者复用同一read adapter/query authority。Agent context继续绑定exact Workspace、Client/generation与一条private Runtime logical
connection；Browser只读取Store 9 Directory允许投影的Workspace/Session，不能调用全局`GET /v1/sessions`、mutation或SSE。cookie、bearer、
Native header混用fail closed。

当前Browser-ready surface是`GET /v1`、Browser session续建与logout、Workspace page、Workspace-scoped Session page、Session get、History/Log/Model Context page、
Checkpoint list/preview，以及Session-scoped后台执行快照。History支持`after_sequence`增量边界；它与cursor互斥。Run、Interaction、mutation、SSE与外部SDK尚未ready，
OpenAPI中存在future contract不等于ServerInfo capability开放。

## Contract与安全规则

- request及嵌套对象closed；unknown/prototype/accessor/cycle/deep/oversize/unsafe number在owner执行前拒绝；
- response允许旧Client忽略新增optional field，但Server encoder拒绝undeclared field；
- schema tag、ID、timestamp、text、page、cursor、array、depth、object key与UTF-8 byte均有hard limit；
- Public DTO不包含Workspace/Store path、Worker/Controller binding、credential、Provider-native options/response或raw Runtime event；唯一模型请求正文
  例外是Browser-only Model Context的provider-neutral system/messages/tools显式诊断投影；
- Browser mutation要求exact Origin；Browser只读GET允许Origin缺失但存在时必须exact，且所有Browser请求都要求same-origin Fetch Metadata与
  无Authorization。唯一不要求有效cookie principal的Browser操作是无body、无query的session续建POST；它只创建同一read-only cookie，
  对仍有效的session不滑动续期。Agent请求拒绝Origin/Cookie/Sec-Fetch；
- 所有response带`no-store`、API version、artifact digest与request ID；Problem不泄漏内部binding或path；
- Session direct read在Browser context下先验证Directory membership；不存在的或不可见的identity统一404；
- Browser capability发布`background_executions/checkpoints/history/sessions/workspaces`，不把controller role或未实现的contract operation误当ready capability。

## Bounded read与artifact

Workspace来自同一Store 9 Directory，不由Session数组反推；Workspace/Session page使用opaque bounded cursor。Session/History/Log/Checkpoint读取
复用daemon已打开的Runtime/History/`kite-session.sqlite` authority，不创建第二SQLite connection、Browser cache或恢复sidecar。History固定
`through_sequence`并用boundary digest与`sequence/public_ordinal`续页；`after_sequence`只读取更晚durable event，适合可见性敏感轮询。
Checkpoint preview只返回计数，不返回path。

后台执行route由同一Runtime query authority读取，但Service必须将private snapshot显式投影并通过Public closed response codec编码；Web只能经`agent-api-client`读取，不能直接fetch或维护第二套decoder。DTO显式区分Session CAS、aggregate generation、execution owner generation/revision，并携带watermark、stale标记与bounded execution items。

Log page复用同一History读取authority与固定through boundary，但它不是raw Runtime event出口：每个item只包含sequence/time、event type、
category、status、bounded summary及closed detail kind/标量fields/artifact availability。Public DTO不携带event ID、path、credential或任意metadata；
Web只在用户切换到Runtime logs Tab时按需读取，并提供显式刷新，不新增后台同步engine。
History/SSE工具生命周期将`rejected`作为独立terminal状态：它只表示dispatch前拒绝，携带稳定reason code和脱敏摘要，
不能折叠为`failed`或暴露raw Runtime reason。Web据此不显示exit code与`No output`。

Model Context route只接受Browser principal，并以可见Session与exact invocation绑定。Service从prepared event取得private Surface ref，经Builtin reader
完成schema/integrity验证后再交叉验证ref integrity、route fingerprint与purpose；Public响应不含Artifact ref/digest、Provider options、endpoint或Credential。
完整的provider-neutral system prompt、canonical messages和tool declarations序列化为Service私有快照，通过受1 MiB单响应保护的分块页传输。页cursor绑定read facade owner、Session、invocation和快照；Client按序核对页身份、offset、总长度及SHA-256后组装完整投影，不用累计内容额度截断。Web只在用户从`model.invocation_prepared`显式打开Inspector时读取，关闭或切换时取消在途请求，不做预取、轮询或持久化。

Workspace Session的`display_name`优先使用Directory中的持久化名称；名称为空时，Service通过同一History authority从首条用户消息派生只读展示名，
不存在用户消息或标题读取不可用时回退Session ID。该展示派生不引入第二份标题状态，也不回写Store。

generated artifact使用canonical key order、无timestamp/absolute path/真实endpoint。OpenAPI security同时描述Worker capability、Agent context
bearer与Browser session cookie；GET resource按principal声明，mutation仍只允许bearer contract。Vite逐字节复制canonical OpenAPI到
`payload/web/api-docs/openapi.json`，candidate manifest checksum绑定该文件。

## 后续边界

后续Run/mutation/SSE/SDK必须消费当前artifact/digest并新增production capability与consumer证据。不得把SSE、通用poll scheduler、fallback BFF、
第二Store connection或Browser bearer custody提前加入当前启动路径。
