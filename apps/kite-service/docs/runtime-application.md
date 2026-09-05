# Service Runtime Application 与 App Control

本页是 `apps/kite-service/src/composition.ts`、`src/bootstrap/**`、`src/runtime-application/**` 与
`src/app-control/**` 的 owner-local current authority。它们同时组合default parent-owned App Server与显式daemon；CLI/TUI
只通过typed Runtime/App client seam消费结果。

## 唯一 Host/Store composition

`createKiteServiceRuntimeComposition` 接受一个显式 `checkpointPath`，组合一个 SQLite storage owner、Runtime Host、
Builtin execution、Runtime Server、raw event/history projector、Runtime Application与operation gate。Service executable的default App Server
按installed/source profile使用`kite-session.sqlite`；旧`<kite-home>/kite.sqlite`原样保留但不可见。CLI/TUI不再有Host/Server/SQLite/Builtin依赖或旧
InProcess composition调用点。
composition在打开前以realpath parent + filename建立process-local Store claim；相同路径或canonical alias的第二owner
fail closed，dispose完成后才释放claim。internal/test stdio绕过此default composition时必须使用显式isolated nondefault path。

同一个process owner持有Store writer、coordinator registry与lazy per-Session runtime bridge。Runtime Client close只释放
connection/subscription/broker binding；quiesce、cancel、drain与dispose只能由Service Application lifecycle触发。

当前source/release默认组合App Server多连接Session Store。Coordinator、per-Workspace Worker与独立Web Gateway都不是普通启动拓扑；只有
显式legacy Service仍在发布ready前把Web static surface挂到loopback listener，并与Runtime/API一起随Service关闭。

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

单Workspace Worker的first-run也是该惰性边界：Store 8、Host、Server和App Control可以在Provider未配置时ready，credential/model
mutation仍由同一Worker owner处理；`workspaceTemplateFor`直到配置ready后的首个Runtime context请求才调用`runtimeInputsFor`并等待
MCP readiness。它不创建configuration-only第二Worker或placeholder execution backend，未完成配置的Runtime请求保持unavailable。

## App Control、History 与 mutation

`KiteInProcessAppControlComposition` 只表示Service内部handler composition，不是CLI embedded mode。Workspace Trust、
Provider/model、MCP、Skill、execution/release与Native credential均有exact route/codec；secret只进入Native credential
owner，browser-safe App Contract不携带secret。Trust query另投影Workspace关联的exact external-read roots与digest；
decision经revision/scope CAS后才允许Runtime连接和native sandbox只读投影，scope identity drift会重新阻断admission。
Runtime approval projector保留用户当前要批准的有界原始command；策略summary不能替代command。cwd、binding digest、
grant subject与Host内部payload仍不进入client interaction。
用户拒绝的`approval.rejected`只结算interaction，不投影匿名“command not run”正文；配对`tool.rejected`作为独立durable fact
投影，由terminal presentation复用queued Tool的安全名称与参数渲染未执行卡片。同一interaction command还原子取消当前turn
所有未终结sibling并写入`turn.aborted(cause=user)`，提交后才传播AbortSignal。
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

Store8 capability存在时，start planner把同一个canonical `turnId`交给Host transaction作为Run identity；queued Run、original
resource receipt和State decision共同提交。bridge activation先调用Coordinator的queued→running transition，再发布notification或交给
Host schedule。interaction request/settlement、terminal/cancel/recovery仍穿过State event transaction，并由Host派生同一Run transition。
Start Turn整批presentation notification还携带admission确认的`runId/taskId/turnId`；首条`user.message_appended`不从
`turn.started`之前的predecessor snapshot取Turn。无active/unknown Run的启动hydration分页读取最近settled Run，保持重启后的
`currentRun`与late-stream fence；该读取不写Store或触发recovery。
current Store8 composition提供private canonical Run port，但Public Agent API仍不发布该capability，不能用内存activeWork补写Run或降级为partial查询。

History由Service-owned exhaustive raw-event projector与SQLite log query生成closed session/event/transcript DTO；Plan submit必须从
active PlanDocument携带的exact Artifact ref读取正文，不得伪造空path或零byteLength ref。未持久化名称的Session在
History与Agent API中复用同一safe-text规则，从首条用户消息派生最多80字符的只读展示标题，不写入第二份状态。carrier与
CLI只能取得`RuntimeHistoryClient`，不能取得Store path、writer或raw event。App Control与Runtime mutation共享operation
gate；`outcome_unknown`后只允许exact query与用户显式决定，不自动重放mutation。
Workspace Worker另为每个Agent API context打开一条read-only in-process Runtime Client/Server logical connection；admission只允许
initialize/query，并继续把persisted Session identity与当前Workspace交叉校验。Session page先从同一Store 8 connection取得bounded keyset
IDs，再以最多8并发query做page-local projection join；History只消费bounded safe `RuntimeHistoryClient` page，Checkpoint metadata消费
same-connection keyset port且preview仍走Runtime query。Agent adapter不取得Host/Store/SQLite concrete，也不复用这条connection执行command、
subscribe或recovery。

History在raw `turn.started`没有匹配`turn.completed/turn.aborted/run terminal`时返回`restart_required`。该标记只触发Client的
显式`resume_session`恢复尝试；若旧effect lease仍fence mutation，History保持只读，不能把本地展示结算冒充Server terminal。
History transcript的每个record还携带对应的Run/Task/Turn identity。持久顺序中先出现user message、后出现
`task.started/turn.started`时，reader只在该后续事实到达后回填此前待关联record；无法关联的旧格式记录使用稳定的
`legacy-*`迁移identity。Native TUI随后按与live notification相同的Accepted envelope校验消费，不能跳过identity fence。
显式daemon Browser的Model Context另从同一Store connection读取prepared event，并通过注入同一Artifact backend的Builtin reader验证
`model_surface`；read adapter只消费App-owned Model Context read port，不取得Artifact ref/backend或通用正文读取authority。
operation gate的quiesce线性化关闭新mutation admission后，Application在同一lease中合并gate临界区与Host
`SessionLifecycleSupervisor`投影的长生命周期Session operation；普通stop发现任一active都立即resume并返回`service_busy`，不会等待active
Turn或退化成manager timeout。只有两者均idle才允许commit drain；signal owner shutdown仍通过cancel/drain进入draining。
动态MCP的raw `mcp__server__tool_hash`名称不得成为TUI card label；closed projector统一保留
`mcp_tool` category/`mcp:dynamic_tool` fallback label。若 admission 时已有 MCP capability descriptor，则其经过
bounded safe-text projection 的 `displayLabel` 可作为 card 的具体工具名；hashed/raw model binding name 仍不得进入 card 或 scrollback。

Live presentation在进入closed `RuntimeClientEvent` projector前统一经过Service-owned 50ms presentation frame。累计
reasoning/text在一帧内只投影最新值并固定按reasoning→text顺序发布，tool progress按`toolCallId + stream`有界合并；
durable事件、reasoning completion与Turn终结前必须先flush。Service-owned presentation frame与concrete
`CliRuntimeBridge`复用同一实现，因此InProcess/Service或不同carrier只能改变传输，不能改变TUI看到的事件粒度、顺序或
聚合语义。frame是active Turn owner；interaction、cancel、close与shutdown旁路在发布durable notification前也必须先
flush，不能让terminal越过仍在buffer中的reasoning/progress。
tool queue projector另把raw `modelMessageId`收窄为browser-safe `presentationGroupId`，与closed
`model.responded.messageId`配对。它只提供模型步骤聚合因果关系，不携带prompt、Provider handle、Kernel State或
execution authority；Service不得让TUI从事件相邻关系反推该归属。queued Shell 只有已携带 Runtime 的
`effectClass=read_only + sideEffect=false` 事实时才发布 `presentation=exploration`；缺失分类、写入或有副作用均保持
`standalone`，terminal event 不重新猜测命令语义。
Runtime已在`subagent.started` payload签发的`concurrencyGroupId`必须由Client Event projector原样收窄并保留，随后由
同一closed Contract与Protocol codec服务live订阅和History回放；不得丢弃该字段后让TUI按相邻child、名称或时间窗口猜测并发组。
`subagent.completed`的Runtime实测`toolCallCount/durationMs`同样必须保留；failed事件可保留这两个计量与
content-free `diagnostic.code/stage`，但必须删除`modelInvocationId`和raw provider/error correlation。
并发Subagent的用户取消可以先发布可见`turn.aborted`，但执行generator仍拥有Session，直到每个durable Provider lifecycle都进入
`cleanup_completed(cleanupConfirmed=true)`。该窗口内Bridge拒绝后继`start_turn`为`runtime_busy`；同进程cleanup只补Provider
cleanup事实并保留取消事务的`capability.reconciliation_resolved(decision=waived)`，不得复用crash语义追加`capability.execution_unknown`。

Native Runtime admission 在 prepared command closure 中固定传递 authenticated `RuntimeCommandContext`（connection、request 与
opaque Controller binding reference）。App Server从每条command的已认证client/connection generation读取当前Session execution authority，
不把Controller Session固定到可能早于Controller创建的socket ticket。Worker application 的 effect composition 只接受已固定context，并由Store authority、Controller
generation 与 OS-user resource lease 共同完成 prepare/acquire/dispatch/terminal 或 `outcome_unknown`；context 不进入 Runtime
Protocol wire frame，也不向Browser REST projection暴露。

## Clean-cutover non-goals

没有CLI backend副本、default embedded/stdio fallback、app-to-app import、dual Host/Store、generic RPC 或 OS Service。private Web是同一
Service `/v1`的只读客户端，不拥有独立BFF、Runtime或Store，也不把Browser变成Controller；remote/LAN Web、Desktop/public SDK仍不属于V1。
Service-owned stdio仅为parent-owned internal/test且必须显式使用isolated nondefault checkpoint path；它不是第二default root。
Store 6/State 27仍是默认 Service authority，Store 6→Store 7 只能由显式 offline migration/admission 进入 Worker path，不能 silent
schema fallback。
Store 7→Store 8只存在于显式offline maintenance：调用方先关闭所有Coordinator/Worker/Gateway admission并证明
Turn/Interaction/effect/external process已收敛，再由source-bound journal/fence、Coordinator-owned Catalog copy与Runtime Store
whole-generation migrator共同切换。普通Runtime Application不调用该入口；fresh home直接初始化Store8，production Worker只接受
committed Store8 evidence，Store7 profile不作为open failure fallback。

## 验证

`bun test apps/kite-service/test/composition.test.ts apps/kite-service/test/bootstrap.test.ts apps/kite-service/test/runtime-application apps/kite-service/test/app-control apps/kite-service/test/runtime-history-client.test.ts apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts apps/kite-service/test/isolated/runtime-server-multi-client.test.ts`、
`bun run --cwd apps/kite-service typecheck`。
