# Service Runtime Application 与 App Control

本页是 `apps/kite-service/src/composition.ts`、`src/bootstrap/**`、`src/runtime-application/**` 与
`src/app-control/**` 的 owner-local current authority。KLSV1-06 clean cutover 后，它们组成默认Store唯一production
Runtime root；CLI只通过Native client seam消费结果。

## 唯一 Host/Store composition

`createKiteServiceRuntimeComposition` 接受一个显式 `checkpointPath`，组合一个 SQLite storage owner、Runtime Host、
Builtin execution、Runtime Server、raw event/history projector、Runtime Application与operation gate。Service executable
对default canonical home使用 `<kite-home>/checkpoints.sqlite`；CLI/TUI不再有Host/Server/SQLite/Builtin依赖或旧
InProcess composition调用点。
composition在打开前以realpath parent + filename建立process-local Store claim；相同路径或canonical alias的第二owner
fail closed，dispose完成后才释放claim。internal/test stdio绕过此default composition时必须使用显式isolated nondefault path。

同一个process owner持有Store writer、coordinator registry与lazy per-Session runtime bridge。Runtime Client close只释放
connection/subscription/broker binding；quiesce、cancel、drain与dispose只能由Service Application lifecycle触发。

## Workspace、Trust 与 routing

Service neutral boot不解析请求Workspace的config/MCP/Skill或启动Workspace runtime。第一阶段，authenticated App Control
Trust query/decision重新canonicalize path，使用observed revision CAS并返回完整`canonicalPath + projectId +
workspaceDigest`。第二阶段，carrier仅为trusted identity签发one-shot ticket并建立connection admission。

create command中的wire Workspace不可信，由connection admission替换。resume/query/subscribe/fork读取唯一Store中的
persisted Session identity并与connection Workspace交叉校验；lazy `workspaceTemplateFor`只在Trust/admission后解析
Service-owned config、model route、MCP、Skill、Sandbox/Shell与checkpoint inputs。process-wide session list仍来自唯一
Store，不建立第二reader/writer authority。该Store-only list/startup hydration已持有完整Runtime State snapshot，因此直接
投影同revision的完整interaction queue与唯一focus；它不得用空queue占位，也不得为了恢复pending interaction启动
Workspace context、MCP或Skill扫描。

## App Control、History 与 mutation

`KiteInProcessAppControlComposition` 只表示Service内部handler composition，不是CLI embedded mode。Workspace Trust、
Provider/model、MCP、Skill、execution/release与Native credential均有exact route/codec；secret只进入Native credential
owner，browser-safe App Contract不携带secret。Trust query另投影Workspace关联的exact external-read roots与digest；
decision经revision/scope CAS后才允许Runtime连接和native sandbox只读投影，scope identity drift会重新阻断admission。
Runtime approval projector保留用户当前要批准的有界原始command；策略summary不能替代command。cwd、binding digest、
grant subject与Host内部payload仍不进入client interaction。
公开interaction的`sessionRevision`是本次projection的当前Host CAS；`interactionId`及kind-specific
generation/plan digest/provider revision/verification revision/input和有界command组成稳定身份。无关State event推进revision
时，Service可在相同稳定身份上重新投影当前CAS；Client必须先取得该新projection。Host一旦接受
`respond_interaction(expectedRevision=N)`进入inspect，后续commit仍固定使用N；inspect与commit之间State变为N+1时
必须冲突，不能在commit时暗中rebase。activeTurn与queue中的重复interaction字段必须完整身份相等，不只比较ID/revision。

pending interaction的settlement owner不是进程内waiter。Service重启并`resume_session`后，bridge从durable State重建
effect、active work与Turn continuation；合法response与receipt原子提交后，Host把`respond_interaction`作为同一Turn的
single-use prepared execution重新调度。旧broker waiter只服务仍存活进程，disconnect或process death不使持久approval
变成不可执行UI，也不能造成重复grant或重复Tool dispatch。每个durable event notification使用该event revision的真实
post-event State投影完整queue；无法取得exact State时返回unavailable/不发布，绝不制造权威空queue。
该规则同样覆盖manual compaction：command intent与effect terminal都通过Coordinator记录各自post-event State后才发布；
不得直接写Session再让Bridge用batch最终State投影早期revision，否则activation必须fail closed且不能调度compaction。

History由Service-owned exhaustive raw-event projector与SQLite log query生成closed session/event/transcript DTO；carrier与
CLI只能取得`RuntimeHistoryClient`，不能取得Store path、writer或raw event。App Control与Runtime mutation共享operation
gate；`outcome_unknown`后只允许exact query与用户显式决定，不自动重放mutation。
operation gate的quiesce线性化关闭新mutation admission后立即返回lease与`activeOperations`观察值；普通stop据此
立即resume并返回`service_busy`，不会先等待active mutation而退化成manager timeout。只有commit drain与signal owner
shutdown会等待idle后进入draining。
动态MCP的raw `mcp__server__tool_hash`名称不得成为TUI card label；closed projector统一投影为
`mcp:dynamic_tool`，具体工具名只从独立有界safe summary展示。

Live presentation在进入closed `RuntimeClientEvent` projector前统一经过Service-owned 50ms presentation frame。累计
reasoning/text在一帧内只投影最新值并固定按reasoning→text顺序发布，tool progress按`toolCallId + stream`有界合并；
durable事件、reasoning completion与Turn终结前必须先flush。relocated `SessionRuntime` seam与concrete
`CliRuntimeBridge`复用同一实现，因此InProcess/Service或不同carrier只能改变传输，不能改变TUI看到的事件粒度、顺序或
聚合语义。frame是active Turn owner；interaction、cancel、close与shutdown旁路在发布durable notification前也必须先
flush，不能让terminal越过仍在buffer中的reasoning/progress。
tool queue projector另把raw `modelMessageId`收窄为browser-safe `presentationGroupId`，与closed
`model.responded.messageId`配对。它只提供模型步骤聚合因果关系，不携带prompt、Provider handle、Kernel State或
execution authority；Service不得让TUI从事件相邻关系反推该归属。

## Clean-cutover non-goals

没有CLI backend副本、default embedded/stdio fallback、app-to-app import、dual Host/Store、Web/Desktop/public SDK、
generic RPC、OS Service或Store schema迁移。Service-owned stdio仅为parent-owned internal/test且必须显式使用isolated
nondefault checkpoint path；它不是第二default root。Store 6/State 27保持不变。

## 验证

`bun test apps/kite-service/test/composition.test.ts apps/kite-service/test/bootstrap.test.ts apps/kite-service/test/runtime-application apps/kite-service/test/app-control apps/kite-service/test/runtime-history-client.test.ts apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts apps/kite-service/test/isolated/runtime-server-multi-client.test.ts`、
`bun run --cwd apps/kite-service typecheck`。
