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
CLI in-process组合在已完成执行释放coordinator后，也从同一Store只读投影会话；已保存终态仍可查询，不为历史读取重新取得执行权。

两个独立 Service 指向同一 Store 时，观察方的显式投影查询可读取执行方已提交的事实，并刷新本地订阅水位；另一进程的提交本身不会向观察方的进程内订阅主动推送通知。执行冲突仍由持久执行权限拒绝，执行方正常退出后观察方可取得权限继续。真实双进程验证见 [App Server cross-process test](../../../tests/release/app-server-cross-process.test.ts)。
`list_checkpoints`与`get_rewind_preview`也从该Store读取；预览在核对持久Session的Workspace身份后读取文件变化，不要求闲置会话重新建立执行coordinator。

并发 Shell 的 [State runner](../src/bootstrap/runtime/state-runner.ts) 在事务提交后同步把整批事件放入原有发布队列，再让异步消费者逐条读取。不能由各个工具的异步 generator 逐条入队，否则一个事务中间可能插入兄弟工具的更高 revision，导致 Bridge 的顺序校验失败并中断后续模型调用。异步 effect preparation 返回时也重新核对 State revision；后台工具已推进 State 时，丢弃旧决定并重新调度，不能使用旧的 stop 决定退出。确定性回归见 [State runner acknowledgement](../test/runtime/state-runner-ack.test.ts)，包含事务交错、工具收尾期间准备完成与模型继续执行。

[RuntimeSessionCoordinator](../src/bootstrap/runtime/RuntimeSessionCoordinator.ts) 保留每个 canonical event 的确切 post-event State，并由 Bridge 的命令 activation、runner 消费和取消路径共同按 revision 排空原有待发布队列。控制命令不能越过后台已提交、尚未被 generator 读取的事件；generator 之后交出已发布对象时不重复通知。所有 event 都来自 Kernel 接受的 batch，不再以 event type／部分 identity 猜测原始对象的 revision。Provider action 的 `started` 在相同确切 State 上投影当前 interaction availability，不能先发布空事件版本再补发同版本交互。[coordinator 回归](../test/runtime/runtime-session-coordinator.test.ts)同时验证控制命令交错与 canonical 失败事件。

[Turn coordinator](../src/bootstrap/runtime/turn-coordinator.ts) 显式持有 State runner iterator：消费者提前关闭或投影失败时，先提交当前 Turn 的错误取消与 unknown 结果，再中止本地 Provider I/O、关闭 iterator 并等待原有有界清理，最后释放 runner。后台 Shell 用实际执行 Promise 集合承担收尾，不在消费者离开后继续占用失去 owner 的运行状态。日志记录已提交终态；持久提交失败仍停止本地 I/O，不能伪造成功或清理确认。[coordinator 回归](../test/runtime/runtime-session-coordinator.test.ts)覆盖提前关闭与真实 Bridge 投影故障，[并发取消回归](../test/runtime/concurrent-shell-cancel.test.ts)覆盖前台与后台工具的清理等待。

提交 start 或恢复审批回执后，如果 activation 失败，Host 不会 dispatch；Bridge 必须在丢失执行 owner 前持久结束已接受 Turn。审批路径还须按捕获的 broker identity 释放准确 waiter，不能因清空 pending 字段后发布失败而永久挂起。执行前的模型／投影初始化也属于同一故障收尾范围。已恢复审批被拒绝后不再为已经终止的 Turn 准备 resume。提前退出的已分类执行故障与错误取消在同一 batch 提交，保留原始 canonical failure，不能再被通用的消费者关闭错误覆盖。

当前 source/release 默认组合 App Server 多连接 Session Store。默认 stdio child 不创建 HTTP listener；显式 daemon 在同一进程中组合 loopback Web、Agent API 与 static/API Docs，并在 shutdown 时关闭。Coordinator、per-Workspace Worker 与独立 Web Gateway 进程不是普通启动拓扑；不要把 daemon Web 归类为 legacy Service。实际入口见 [daemon owner](../src/app-server-daemon.ts)。

子Agent在工具审批前挂起时，continuation中的blocked参数必须使用同一次解析得到的`pendingRequest.args`，与Kernel审批绑定和持久工具调用一致。原始模型参数仅保留在模型消息中；被schema移除的字段不能重新进入审批或恢复执行，也不能通过放宽digest校验补救。Shell审批等待时child Driver已清理，已批准的child工具由Host先执行，再恢复child模型循环；取消此窗口必须停止Host工具并保持父Run取消，不能为尚未恢复的Driver制造第二次清理事实。

## Workspace、Trust 与 routing

Store-only Session 投影保留 State 已持久化的 canonicalWorkspaceDigest 为安全的 workspaceDigest；桌面以其与当前 Trust identity 匹配目录，Protocol 仍排除原始 workspace 路径。目录显示名由已有 Session row 经安全文本投影，不另建项目或会话索引。

活动 Bridge 和 Store-only 投影必须从同一持久 State 输出相同 workspaceDigest，避免恢复时产生同 revision 的投影漂移。文件变更事件仅投影已提交工具事实中的有界 path，差异正文复用 tool.finished 的已保存输出；不新增 Git 或 Store 读取入口。

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

本机 App Server 的 `set_interaction_mode` 从同一 Storage owner 读取目标 Session 的持久 workspace、projectId 与 canonicalWorkspaceDigest，重新查询该工作区 Trust 并比对完整身份；不从客户端目录、当前执行项目或显示路径推导授权。通过后进入同一 Host 的权限命令事务，不重启服务或停止其他 Session。未知会话、未信任或身份漂移仍拒绝；目标目录在信任查询时消失、Trust 损坏或不可用使用协议已有的 `internal_error + temporarily_unavailable` 详情。该命令不授予跨项目创建或启动 Turn 的权限。回归见 [App Server process](../test/isolated/app-server-process.test.ts) 与 [Desktop navigation](../../kite-desktop/test/navigation.test.ts)。

权限设置与执行准备分离。本进程已有 coordinator 时，仍由其持有的 State、execution fence 和提交后事件队列更新，运行中的工具继续观察同一份策略。没有本地 coordinator 时，直接用持久 State 构造一次性的 `StateRuntimeSession`，复用 `commitInteractionModeCommand`，不加载 Workspace 配置、模型、MCP 或完整 Runtime，也不调用 recovery。该实例不进入 registry，不取得 Run 写入能力；SQLite 的 `commitUnownedDecision` 在 BEGIN IMMEDIATE 内检查 authority 为 idle 或 recovery_required、Session revision 未变化，再提交同一事件／State／回执事务。active、detached（含尚未显式 fencing 的过期租约）返回 runtime_busy，避免覆盖其他执行者的内存 State。

冷会话的权限事务不修改 execution generation、cleanup、Effect 或 Run 记录。切到 Full 继续复用 Kernel 对尚未 dispatch 且符合条件的审批记录的模式规则，但不会因此启动执行或确认历史副作用；仍需恢复的任务继续走显式恢复。提交后使用决定的确切 State 发布权限事件，再由 Host 刷新 Store 投影。每次设置都读取最新持久 revision，独立进程同时提交同一 commandId 时从已提交回执确认重放，不重试业务写入。若会话在检查后被其他进程删除，返回明确的 session_not_found，不把未执行的修改报告为内部错误或未知结果。回归见 [多工作区集成](../test/isolated/runtime-server-multi-workspace.test.ts)、[Store 原子边界](../../../packages/runtime-storage-sqlite/test/isolated/kite-session-runtime-storage.test.ts)。

若本进程已丢失执行租约但 registry 中仍有旧 coordinator，权限命令继续沿受 fence 保护的原路径拒绝，不把旧 State 与一次性设置实例并列写入。重新启动服务后才能采用没有本地 coordinator 的设置路径；任务恢复要求仍保留。本轮不引入失效 coordinator 自动淘汰或跨进程命令转发。冷 Full 可以把符合条件的待审批工具改为 authorized_queued，但原 waiting Run 仍保留；resume_session 不自动续跑该队列，新 start_turn 通过既有 eventsForSupersededTurnRecovery 取消被替代的未结束工具。当前不承诺“冷 Full 后自动恢复旧队列并恰好执行一次”，该链路未经过端到端验证。[租约丢失回归](../test/isolated/runtime-server-multi-workspace.test.ts)验证拒绝后 State 与 recovery facts 均不变。

设置交互模式仍校验 Session 与 expectedRevision；目标模式已生效时，在原有命令事务提交 snapshot 回执，不新增模式事件或推进 revision，不能把客户端确认当前权限当作内部故障。实际改变模式才写入 `interaction_mode.changed`。验证见 [coordinator 命令回归](../test/runtime/runtime-session-coordinator.test.ts)。

[计划正文 projector](../src/runtime-client/plan-review.ts)从已保存的计划正文与步骤生成脱敏、有界的 review。实时交互与历史事件复用同一函数；Contract/Protocol 严格校验 text/truncated，交互结算继续绑定计划 identity 与 Session revision。超限明确标记，不暴露 Artifact/Store 句柄。验证见[计划正文测试](../test/runtime-plan-review.test.ts)。

`KiteInProcessAppControlComposition` 只表示Service内部handler composition，不是CLI embedded mode。Workspace Trust、
Provider/model、MCP、Skill、execution/release与Native credential均有exact route/codec；secret只进入Native credential
owner，browser-safe App Contract不携带secret。Trust query另投影Workspace关联的exact external-read roots与digest；
Provider 设置中的显式默认选择即使返回 `already_selected` 也重新读取当前配置；未绑定 route 的 Session 更新默认配置，已绑定 Session 则重新解析自己的 route，避免同名模型替换凭据或地址后继续使用旧配置，也不能借默认选择覆盖其模型。Composer 选择通过 `create_session.model` 或下一次 `start_turn.model` 绑定并原子持久化到对应 Session；恢复优先使用该 route，不能被同一 Workspace 的其他 Session 覆盖。活动执行始终保持开始时捕获的配置。
[Service composition](../src/composition.ts)把 App Control `runtimeInputsFor` 的 `resolveModelConfig` 一并传入 Workspace template，恢复持久 Session 和显式选择模型均通过同一配置 owner 解析完整路由；不能把当前默认配置当成唯一可用模型。[组合回归](../test/composition.test.ts)核对非默认模型创建、重启恢复、后续切换及会话隔离。

[事件投影](../src/runtime-client/event-projector.ts)在 `run.error` 的通用 `blocked` outcome 下保留已分类 failure kind，例如 `provider_auth_required`，同时保留 outcome 的重试与恢复约束；不公开原始错误文本。[事件投影回归](../test/runtime-client-event-projector.test.ts)核对安全分类和策略不被覆盖。

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
Start Turn整批presentation notification以及该accepted Run后续的model/tool/subagent/interaction/terminal通知都携带admission确认的`runId/taskId/turnId`；首条`user.message_appended`不从
`turn.started`之前的predecessor snapshot取Turn，取消事务或Turn终态后的迟到Subagent/Tool cleanup也不从settled snapshot反推Turn。无active/unknown Run的启动hydration分页读取最近settled Run，保持重启后的
`currentRun`与late-stream fence；该读取不写Store或触发recovery。

若进程在 `start_turn` 的 Run 激活后、执行器调度前退出，取得上一代执行的 fencing 与清理证据后，Service 仅在当前 Turn 的完整日志证明没有模型、工具、交互或其他派发事实时补记中断终态，并将 Run 结算为失败。原命令回执保留可查，重放不再次派发；存在旧全局 Provider 准入等待时仍按其独立的可续跑证明处理。
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
`SessionLifecycleSupervisor`投影的长生命周期Session operation；显式 daemon restart 的 if_idle 停止发现任一 active 都立即 resume 并返回 busy，不会等待active
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
`standalone`，terminal event 不重新猜测命令语义。Builtin catalog中`kind=interrupt`或
`executionMechanism=user_input`的能力即使没有外部副作用也必须保持`standalone`；`ask_user`由Footer interaction拥有，不能进入
Thinking只读工具聚合。该判断使用admission时捕获的能力语义，不在TUI按工具名维护白名单。
Runtime已在`subagent.started` payload签发的`concurrencyGroupId`必须由Client Event projector原样收窄并保留，随后由
同一closed Contract与Protocol codec服务live订阅和History回放；不得丢弃该字段后让TUI按相邻child、名称或时间窗口猜测并发组。
正常child启动还须保留父task的`parentToolCallId`。child内部tool lifecycle由Runtime在queued时写入、并在terminal时从canonical tool state延续closed
`presentationOwner { subagentId, parentToolCallId }`；Client只据此隐藏顶层重复并把异常留在所属task过程，terminal-only replay也不得公开或解析
`runtimeToolCallId`的命名格式。旧 History 缺少 owner 时，由 Service 在本次读取的事件上界内，使用 capability invocation、child dispatch intent 的唯一身份关系补齐父工具归属；内部工具再按 subagent.step 与执行侧共用的工具身份计算核对。仅补展示 DTO，不改原事件、不读取上界之后的事实；缺证据或关联歧义时保留独立异常入口，不能按名称去重或隐藏。
`subagent.completed`的Runtime实测`toolCallCount/durationMs`同样必须保留；failed事件可保留这两个计量与
content-free `diagnostic.code/stage`，但必须删除`modelInvocationId`和raw provider/error correlation。
`subagent.tool_result`的可选summary只有非空时才进入closed Client Event；成功但无匹配内容的read/search结果省略该字段，不能
生成Contract拒绝的`summary: ""`、中断subscription，再让后续Esc误报`Invalid AcceptedPresentationEnvelope`。
Service的Subagent adapter必须显式向Builtin模型循环传入12轮工具响应上限。达到上限后下一次Provider请求使用空工具面并要求基于
已收集证据总结；返回正文则按正常child terminal继续父Run，若Provider仍伪造工具调用则按现有失败分类闭合child且不再调用模型。
该边界不依赖可选共享`resourceBudget`，并以continuation保存的`modelInvocationOrdinal`延续，审批暂停/恢复不得重新获得12轮。
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

## 活动执行权续租

Session 写入口在核对当前执行权与有效期后，可使用同一 authority 的 CAS 续租；达到正常续租间隔时随实际写入进度续租，避免连续同步工具提交延后定时器而使活跃执行过期。模型等待等无写入阶段仍由原定时器续租。已过期、失去 generation 或属于其他 owner 的执行权不能借写入重新激活，仍需恢复处理；不延长默认租约或新增后台协调进程。

续租失败时在 Server stderr 记录 Session、失败原因或租约失效时间，便于区分定时器延后与存储/执行权错误；不污染 stdio protocol 的 stdout。

执行权失效由原Storage owner通知同一Host停止本地执行，不另设执行登记或后台协调器。取消监听器即使无法持久化也必须继续传播Provider停止信号；只发布成功提交的终态事件，持久恢复记录不会因本地I/O关闭而被伪装成已完成。

Daemon lifecycle status 直接读取 Application activeOperations（gate 临界区或 Host 活动 Session），不维护额外计数。接受 shutdown 后仍由同一 quiesce lease 管理取消和 drain，状态查询不会取得 lease。

History 可按已观察的 `throughSequence` 重建历史前缀，模式、恢复与展示身份都来自该前缀。stdio carrier 将该只读结果按完整 source record 分页，每页最多 512 条并预留协议封装字节；不拆分事件正文、不持久化分页状态。现有完整历史 owner 仍在每页请求内重建前缀，此处不承诺 Store 扫描或客户端最终 transcript 的恒定内存。


主工具的自动审批请求与完成通过 [event projector](../src/runtime-client/event-projector.ts) 映射为 `tool.review`，只保留 tool/review 身份、封闭状态及现有 safe-text 处理过的原因；人工批准携带明确 grant。审查异常或显式升级转人工，不投影成拒绝。Contract 与 Protocol codec/mapper 必须同时允许这些展示字段，历史与订阅使用同一投影；不改变 Kernel 的授权、调度或模型结果。

## 按需恢复与多空间宿主

同一本机 App Server 对已有会话按持久 canonical workspace identity 核对信任并路由；新会话请求显式 workspace，由服务规范化和验证授权。App Control 按请求所属的已验证 workspace 选择配置引用，不以进程启动目录代表全部空间。Electron 重接仅替换连接代次；一个 Service、Store、Host 持续管理所有空间，不增加进程池。

Service 提供只读 get_session_recovery，摘要来自 authority/effect facts，最多返回 20 个待核对 effect identity。recover_session 绑定业务与 authority revision；有效执行者、未确认清理或未决/未知 effect 不能被接管。仅确认安全时原子保存恢复回执并回到 idle。get_command_receipt 查询原命令结果，不重放操作。失权而仍有本地 coordinator 时，权限设置返回 session_cleanup_pending，不能调用正在关闭的 Runtime。验证见[多空间与恢复](../test/isolated/runtime-server-multi-workspace.test.ts)、[原生 Service 进程](../test/isolated/app-server-process.test.ts)。

Ask 的实时交互与请求历史都投影 toolCallId；回答事件将现有 answers 映射为有界脱敏文本。客户端据问题选项恢复文案，不把执行结果包装 JSON 作为问答历史。


## 可选能力与旧全局准入

模型调用前不再枚举并阻塞全部 required MCP。真实 MCP 工具、资源和 Provider Action 仍在实际使用时检查绑定、认证、项目批准及权限；`mcpProviderAction` 保留这些操作消费者，不再产生全局 admission。

`resume_session` 在已持有合法执行 scope、Coordinator 空闲且原 Run 为 waiting 时，可读取完整 journal，确认同一活动 Turn 的等待来自支持的 State26/State27 全局准入写入路径。当前 Turn 已有模型准备、工具、未知 capability/effect、未决审批或清理时不结算。真实 `awaiting_provider_action` 不属于该路径。

匹配时，Service 通过 Coordinator 的 `commitObsoleteAdmissionResumeCommand` 记录事件对应的 revision/State，再由 `commitCommandBatch` 结算 `provider.admission_cancelled`，原 State、Run waiting→running 与 command receipt 由 Host/Store 一次提交；随后沿原交互 continuation 执行，不重新发送用户消息，不写用户 waiver。查询和历史订阅不触发该修复。

结算已提交但派发前崩溃时，同 commandId 的回执重放先取得 Session execution owner，再经 Bridge 的 `recoverCommittedResume` 重新核对完整 journal、当前 revision 与原 Run 身份；只有无模型准备、尝试、工具或其他副作用证据且无本地活动执行时，Host 才调度同一 Turn。模型网关在出站前持久记录 `model.invocation_prepared`、`model.invocation_attempt_started` 和 `model.requested`，因此一旦出现这些事实，回执只重放结果，不重做模型调用。不同 commandId 也必须通过相同分类条件。真实 Store 8 与 Host 的崩溃、并发和拒绝重放验证见[Coordinator 测试](../test/runtime/runtime-session-coordinator.test.ts)；恢复的权限边界见 [ADR 0188](../../../docs/adr/0188-on-demand-capabilities-and-filesystem-owner.md)。

恢复派发使用本次请求经认证并冻结的 `commandContext`，沿 Host replay、Service wrapper 和 continuation 传递到工具执行。并发同 commandId 的请求各自持有自己的上下文，不从旧回执恢复连接绑定，也不把上下文写入持久回执。Worker 工具组合仍重新核验本次 binding 与有效控制权；缺失或失效时拒绝执行。

### 执行命令时的失效执行收尾

Service 的会话投影查询、历史读取及订阅只读取持久事实并刷新 Host 观察水位，不调用 `reconcileInterruptedSession`。执行命令在 mutation admission 内对目标会话触发该恢复：先保留有效租约的执行；失效执行经 Store CAS 隔离后取得受控恢复 scope，调用 `reconcileRuntimeSessionAfterRestart` 核对 Provider／沙箱资源，在持有当前代际时追加工具、子 Agent、Turn 的收尾事实，由同一 State 事务更新 Run。未知外部结果保留，调度与完成门禁按当前轮归属判断，不能因 Task 跨轮复用而阻塞新消息。

恢复事件在创建后继 Run 前按旧 Run 身份完成投影；不能延迟到新轮激活时给旧 revision 配上新 runId。同一会话的恢复请求共享进行中的 Promise，重复执行命令访问已收尾会话不追加相同事件。清理失败后仍返回可读历史及持久恢复状态；执行请求保留明确失败，不能把检查失败当作清理成功。回归见[重新进入故障测试](../test/isolated/session-reentry-recovery.test.ts)。

终态会话同样核对有持久证据的历史子 Agent 悬挂卡片：先从 State 筛选失败终态父工具与已确认清理的 Provider lifecycle，再读取事件验证唯一 childInvocationId 的 started 尚无 terminal。存在候选时不走 idle／settled authority 的提前返回，而进入相同恢复 writer 追加终态；已失败的旧 Task 不受当前 Task 过滤。成功父工具还必须同时匹配同一 invocation 的 completed observation、attempt／dispatch digest 一致的 cleanup、execution_succeeded 和成功 tool.finished，才补记 subagent.completed；子执行已有 completed observation 但父工具随后失败／取消、完整成功证据不足时保持待核验，不补写失败；身份歧义、未确认子执行清理及有效 owner 不被此规则改写。子 Agent 已有确证的终态在 Provider 核对后即提交，不因其他沙箱清理失败而延后；最终恢复仍保留清理失败，并使用已追加事实避免重复终态。

并行子 Agent 每个 sibling 返回时，Service 即等待其尚未提交的子任务／父工具终态持久化，再等待整批结束；成功写入的事实不重复返回给聚合提交。持久化失败向执行 owner 传播，不能合成为工具执行失败。验证见[并行终态提交测试](../test/isolated/runtime/sibling-terminal-persistence.test.ts)。

会话投影查询统一经过 Host 发布最新持久投影，包括执行命令恢复失败后从 Store 读取的结果。订阅注册后，初始边界查询及后续只读查询得到的新 revision 必须同时进入该订阅，避免 Store 水位已经推进、客户端却永远收不到对应 ready。该发布只同步观察状态，不取得执行权。


主执行停止原因沿 AbortSignal 显式传递：只有主动取消命令使用 user，Host 关闭、租约丢失、执行错误及截止时间使用 error；未分类信号按中断处理，不通过错误文案猜测用户意图。Provider observation 保留 interrupted，避免丢失子终态后恢复时将中断误判为失败。取消收尾覆盖已暂停的子任务；同一子执行已有终态不重复追加，清理未确认不伪造取消成功。

子 Agent 生命周期沿现有持久事件传递：派发意图与带 `status: creating` 的 `subagent.started` 在同一批次保存，实际开始／恢复的 started 为 running。`subagent.failed` 的可选 status 区分 failed、interrupted、cancelled，旧 payload 仍可读取；服务投影把旧的明确 aborted／timed_out 诊断分类为 interrupted，不猜测取消。创建失败也在确认准备资源收尾后提供子任务终态，避免卡在 creating。

`auto_review.requested` 表示进入自动审批队列；执行器选中该审批并验证输入后，必须先确认 `auto_review.started` 持久化，再调用 reviewer。该事实只记录阶段，不授予权限或改变审批结果。审批模型请求必须接入当前主执行的停止信号；停止后不再派发请求或提交迟到的审批完成事件。客户端 review queued 对应等待，reviewing 对应自动审批中；审批返回之后仍须等真正的子任务恢复事实才能显示运行中。父工具状态与子任务状态分别维护，不能用父工具取消推断子任务已经停止。
