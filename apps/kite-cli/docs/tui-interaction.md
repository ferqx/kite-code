# TUI 交互规范

本页是 `apps/kite-cli` 的 owner-local current authority，覆盖 Overlay、输入焦点、状态行、Session 导航和用户交互投影。

## Runtime 输入与投影边界

- TUI command/query/subscribe 只消费 typed App Server client surface；生产路径固定为 terminal
  `KiteAppServerConnection/RuntimeClient → paired kite-service RuntimeServer → RuntimeAccess`。TUI 不组合 Server。
- reducer、block replay 与 interaction UI 只接收封闭 `RuntimeClientEvent`/client interaction projection。未知或无法安全投影的事实显示固定 unavailable/error 状态，绝不扩张为 `any` 或 raw Runtime event。
- 每个Session snapshot保存`runtimeAuthority={revision,activeTask,currentRun,interactionQueue}`；connection generation只留在
  RuntimeClient transport，不进入该domain snapshot。`running`是currentRun active/recovery与本地command状态的兼容selector，不能写回
  Server terminal。StartCommand区分reserved/submitting/accepted/failed，CancelCommand区分cancel-after-accept、submitting、accepted与failed。
- TUI本地只缓存`model.responded.messageId → requestId`与tool queue的opaque `presentationGroupId`配对；匹配结果只
  决定Presentation step归属，不参与Runtime command、approval或execution identity。新事件不按“当前block/上一条event”
  猜group；identity缺失或不匹配的工具保持独立neutral group，不得把当前Thought当作wildcard owner。
- 普通prompt在Enter后立即追加带`pendingEcho`标记的live-only本地回显，并同步显示Footer `Working`；该反馈是presentation-only，不等待Session ready、前序cleanup、`start_turn` receipt或durable echo，也不创建Server Run identity。RuntimeClient的durable `user.message`按内容只匹配这一条显式pending记录，将其原位升级为`messageId`身份，不新增副本。未标记的同文消息不得按文本去重。提交失败只移除仍为pending的本地回显并清除本地状态；Server lifecycle和终态仍只由Runtime投影收敛。
- active Run期间输入的新prompt先进入按Session绑定的live-only queued展示层，显示有界原文预览，但不追加到当前
  Turn的blocks，因此并发子Agent/工具仍能原位更新。FIFO轮到该prompt时先移除queued展示，再建立新Turn和pending echo。
  活动Session按FIFO逐条显示浅色背景的单行`↵ 消息内容`，不再附加`Queued`解释行或折叠剩余数量；队列非空时隐藏Run状态行（包括`Working`），首项前与相邻队列行之间各留一行。
  队列由稳定Footer owner持有，queue增减不能重挂载spinner，也不能让OutputArea重算或拆分当前Thought；消息区使用稳定投影引用和浅比较隔离队列专属更新。
  queued chrome不进入消息区动态高度预算，不能因为新增或移除队列项改变Tool、Thought或Delegating的展开、折叠与可见步骤。
  非空prompt提交时，InputLine独占该次Enter；OutputArea在key-dispatch时读取prompt ref并禁止同一次Enter切换最后一个
  Tool/Subagent块。只有空prompt的Enter继续作为动态块展开/折叠入口，不能用队列state到达后的重渲染补救按键双消费。
  FIFO按Session隔离，不同Session的prompt可以独立admit。只有`start_turn` receipt被接受后才能移除queued展示、建立新Turn和
  pending echo；后台Session也必须按稳定prompt identity清理展示。receipt与durable `user.message`可乱序：message先到时按本Session
  FIFO消费对应live-only queued entry，receipt先到时原子把queued entry升级为pending echo；两条路径最终都只保留一个带`messageId`
  的用户块，相同正文的不同durable identity仍不得被合并。若`start_turn`返回`runtime_busy`，说明旧Run的本地completion
  早于Service执行边界；client必须保留队列项、使用新的command identity有界退避重试。若active Subagent持续推进revision并返回
  `revision_conflict`，client必须在同一command identity下等待authoritative remote-idle/cleanup边界，再以最新revision重试。两者在既有Run deadline内都不能报发送失败、取消旧Run或清理队列与Subagent展示。
  等待期间到达的前序Run terminal必须连同其revision暂存；只有terminal revision不早于后继receipt的accepted revision时，
  才能参与该后继Run的identity校验与完成收敛，较早的terminal不得导致伪造的identity mismatch。
  reducer 以 canonical `messageId` 处理重连/回放幂等，不能按文本去重，因此同一消息只显示一次、
  两个不同轮次的相同文本仍保留两条。`LOCAL_COMMAND`只用于不会进入Runtime的本地slash echo，并追加到当前presentation tail；
  它不能创建真实user turn或把仍在动态尾部的上一轮提升进Ink Static，否则终端scrollback会重复写出已有消息。
  异步slash结果还必须绑定发起时的Session与turn count；用户切换Session或提交下一条prompt后，迟到结果不得串入新的presentation tail。
- 输入框在当前Turn运行时提交的普通消息进入本TUI的FIFO，等待authoritative远端run/cleanup idle后再取得prompt
  reservation并发送；不得在`tryReservePrompt()`失败时静默清空。恢复中的active projection即使没有本地run Promise也必须
  等待Service projection变为idle。队列在Enter时固定Session identity，切换前台不能改投目标；单条失败仍对调用方可见且
  不阻塞后续消息。排队会显示明确提示，最终command失败显示可重试的“未发送”错误。
- 主输入可以先于初始Session的React effect取得键盘focus；首次Enter必须同步复用active Session或创建唯一fresh Session，
  再进入同一FIFO。空session ID或缺失Runtime必须转成可见失败，不能以resolved Promise静默清空输入。
- 历史 Session 的完整 durable replay 只通过 `RuntimeClient.history` 的 App-injected `RuntimeHistoryClient`
  向前分页读取 complete closed transcript，并与 live 事件共用 reducer。短期 subscription replay/gap reset
  不是完整 history source。event-free snapshot仍是当前activity/interaction的权威projection：Service投影同revision
  完整interaction queue与active identity，Native adapter和reducer按该集合替换本地interaction Map、pending approvals
  与focus，而不是追加一个focused interaction。它可清除已不存在的旧queue项或停止已经不存在的active work，但不制造
  approval settlement或用户取消事件。
- TUI 不直接 import 或持有 Runtime Host、SQLite/Store、Kernel、Builtin executor、RuntimeLogQueryPort 或 transport/server concrete type；它不自建 mailbox、receipt、recovery 或 SQLite fallback。
- TUI 的 Native client surface 是显式 `TuiRuntimeClientFacade` / `TuiSessionFacade` method 与字段清单；不得从
  Service legacy session-manager 推导类型，也不得使用 Proxy、Reflect fallback、动态 member cache 或 set trap 让
  implementation 新成员自动进入 TUI。新增 surface 必须同时修改interface、adapter与fake/native conformance tests。
- Workspace Trust、Provider/model、MCP、Skill与status逐方法消费exact App Control client，request/response都通过
  browser-safe codec；first-run raw credential只通过Native credential client。TUI不持有Config Repository、
  credential writer、MCP Supervisor、actual Skill manifest、Host或Store；这些 owner与raw Runtime/history projector
  已 clean-relocate 到 `apps/kite-service`。
- MCP mutation的applied/rejected/outcome-unknown提示由controller在消费单次response后写入；后续250ms safe snapshot
  轮询只更新control projection，不得清除尚在展示的mutation结果或据此重放mutation。
- Workspace Trust 是两阶段Runtime admission。启动先 `prepareAppControl()` 并显示Service query/decision结果；只有
  canonical Workspace及Service发现的exact external-read scope均被用户确认后才打开Runtime connection。TUI逐项显示
  safe snapshot中的canonical只读roots并把scope digest绑定到decision，不按命令名自行推断。scope/revision conflict会刷新
  snapshot并回到普通授权选项，用户再次确认即可继续；decline或真实unavailable时不发送Runtime initialize，
  不以cwd或wire path绕过，也不回退embedded。Trust status枚举只用于内部路由，不作为用户可见状态行。
- TUI exit、first-run、Workspace Trust与config error统一调用一个idempotent exit coordinator。确认退出后先同步unmount、归还
  terminal与cursor，再执行有界observability和client connection清理，慢速清理不得让最后一帧继续占用终端。退出只关闭client
  connection，不调用`abortAll`或Runtime Application owner dispose；Ctrl+C取消当前Turn仍通过
  explicit Runtime cancel command。React unmount不得二次fire-and-forget shutdown。

## App Server 状态

默认TUI启动一个配套的parent-owned stdio App Server，不启动HTTP listener或Web assets。`/status`显示transport、source/installed
profile、build、App Server version、client version和initialize已证明的same-build pairing；不显示Service PID、启动时间、Web URL或build drift。
source与installed mismatch都在TUI mount前fail closed，不形成可继续使用的“版本不一致”状态。
启动诊断按已注入pairing区分恢复动作：same-build mismatch表示安装内容可能不完整，提示更新或重新安装；显式daemon的
exact-protocol mismatch提示更新Kite Code或使用matching client，并在升级后关闭旧daemon再启动。该提示只解释既有
`server_mismatch`，不按client版本字符串推断兼容性，也不自动操作daemon。

显式`--server <endpoint>`改用调用者选择的owner-only Unix socket/Windows named pipe；状态显示exact-protocol compatible，而daemon
build只作诊断。daemon固定一个canonical Workspace，连接不同Workspace会在进入TUI前失败。该动作只读取composition注入的已验证identity，
不创建Runtime Session、不发送Runtime command，也不取得writer authority；默认TUI没有`/web`或隐式daemon/Service发现。
KASD-05已删除TUI的legacy `discoverWeb` prop与`serviceStatus.web*`异步分支；无论stdio还是显式daemon，`/status`都只同步展示已注入的
Runtime identity/pairing，不请求HTTP origin。

## 单一交互表面

- Slash command 打开的帮助、模型、权限、推理深度、主题、语言、Session、MCP 与恢复页面共用一个 modal 边界。
- Slash suggestion 只拥有 partial completion；已经精确匹配的命令由主输入的 Enter 路径提交一次。
  Esc 可关闭当前 suggestion，后续输入变化才重新打开，不能由 suggestion 与 TextInput 各提交一次或互相吞掉。
- Modal可见时隐藏主输入提示和slash suggestion，不允许两个交互表面同时取得键盘authority；普通slash modal不改变底层
  Run阶段。Approval、Input、Plan review等Footer交互取得焦点时隐藏Run状态行（包括`Working`），但不得清除或修改底层Run状态。
- 页面只解释展示状态；route、selection、draft、controller command 与 Runtime facts 仍由宿主 owner 管理。
- First-run/setup 使用独立 `FirstRunShell`，不复用普通 Overlay lifecycle。

## Overlay 布局

`OverlayFrame` 唯一拥有标题、正文、可选消息和快捷键四区的外层节奏与水平 inset。页面根节点不得重复
`marginTop` 或 `paddingX`，不存在的消息不渲染占位空行。

- Summary、Section、List、ChoiceList、DetailList、Message、ImpactNotice、EmptyState 与 ShortcutBar 使用共享 primitive。
- 可选择列表把每个可操作行直接交给 ScrollList/VirtualList；heading 不参与编号或 selection。
- 搜索行、问题说明、warning callout 与首个选项之间固定保留一行；组内选项保持紧凑。
- 删除、禁用、重连、认证、配置写入、权限或恢复动作显示“将做什么/不会做什么”的影响边界。
- 危险确认默认选择取消；普通导航和只读查看不显示副作用提示。

## 审批、问答与方案审核

- Approval Overlay 只绑定 durable queue 当前 `activeApprovalId`；后台 pending record 不抢占 Footer 或键盘。
- Enter/Esc 携带 exact `interactionId` 与 generation；Enter 提交当前 grant，Esc拒绝当前焦点并原子取消同turn其余
  queued/awaiting/authorized/running sibling、结束turn；迟到action为no-op。
- Ctrl+C仍是独立的整轮取消输入；审批拒绝保留focused target为rejected、其他调用为cancelled。
- approval、ask_user、Plan review及其Enter/Esc动作在`respond_interaction`获得applied/idempotent receipt前保持可见；
  accepted receipt后才允许本地结束提交态，canonical granted/batch-released/rejected/input/plan event仍拥有durable结果。
  transport/protocol/identity失败不得被吞掉，UI显示可重试错误且不伪造已授权、已回答或已取消事实。
- Esc拒绝提交失败属于当前Footer瞬态，不进入会话消息流；成功拒绝不追加匿名approval notice。approval settlement与其配对的
  pre-dispatch Tool rejection仍分别保留durable facts，presentation只渲染一张带queued安全参数的rejected Tool卡。
- pending interaction的Session CAS随同Session兄弟event推进时，Native client从每个权威projection刷新完整queue；conflict后必须
  重新取得相同稳定identity的最新interaction，并保持`interaction.sessionRevision === expectedRevision`再提交。过期interaction的
  Enter/Esc不得回退作用于当前active Session；迟到query也不得用低revision覆盖较新的subscription projection。
- 不存在interrupt清除后自动补发cancel的旁路。交互只由当前用户动作的一次receipt链路与后续authoritative queue/event
  收敛；否则已接受动作可能被第二个fire-and-forget cancel覆盖。
- 审批receipt已接受后，本地`runTask` Promise收尾不得清理tool queue metadata或改写Runtime运行状态。仅live
  event或authoritative Session projection可以收敛运行与interaction；queued/running Tool、Thought和Subagent只能由明确的
  Runtime terminal进入cancelled。
- Esc/Ctrl+C当下只提交取消请求与管理本地按键状态，不生成Tool、Thought、Subagent或interaction终态；
  同一输入轮立即把固定状态行切换为`Cancelling`，持久terminal或权威idle snapshot到达前当前轮次仍保持active投影。
  同一Session已有取消请求时，后续Esc/Ctrl+C复用同一个Promise，不得发送第二个`cancel_turn`；receipt失败恢复原运行投影并显示错误。
  queued successor继续等待前驱Subagent Provider cleanup的权威边界，不能因用户可见的`turn.aborted`已到达就提前提交新Turn。
- start receipt前取消时，未取得accepted identity的已发送command进入cancel-after-accept；迟到receipt到达后使用其canonical
  runId与activeTurnId发送一次cancel。已建立Run的cancel command必须携带两者，projection暂时不可见时可直接使用receipt identity。
- `ask_user` 单题把问题放入标题，多题使用 `n / total` meta；自定义输入留在原列表，已完成回答不得在恢复时重开。
- Plan review、MCP recovery/admission 与其他交互同样只由 canonical terminal event 清除。
- Plan approval 由单个 `plan.approved.executionMode` 同时固定本次 Task 执行模式与 Session/TUI 镜像；不得
  在它之前插入 `interaction_mode.changed`，否则会先清除 awaiting-review interaction，令随后 approval identity
  fail closed。用户后续独立切换全局模式时才产生 `interaction_mode.changed`。
- Provider recovery/admission 与 verification 只显示 provider ID、封闭 action、verification ID/revision
  和固定选项。Provider body、credential、directory 内容、verification evidence/path/stdout 不进入 TUI；
  retry 必须绑定 directory revision，waive/defer/cancel 不伪造一个 revision。

## 选择器与 Session

- 模型 identity 是 `provider + model name`；不同 provider 的同名模型保持独立 key 和 route。
- `/model`、`/permissions`、`/effort`、`/theme`、`/language` 不接受选择参数，必须打开选择器并显式确认。
- `/permissions`确认当前已经生效的同一mode只关闭选择器，不再次发送Runtime command或制造无意义revision；真实mode变化仍可在active Turn中提交，并由Host的exact invocation并发边界保证已经dispatch的Model evidence不因该控制事实丢失。
- `full` 是唯一 unrestricted interaction mode；restricted backend 不可兑现 scope 时 fail closed。
- Session 切换恢复各自模型 route、interaction mode、context 与 Runtime projection，不继承上一 Session 的瞬时状态。
- 历史 Session 先等待 typed Runtime readiness/recovery，再通过 HistoryClient 读取 persisted head 并提交 navigation；迟到 load 不覆盖新选择。
  `restart_required`会在订阅前请求显式Server恢复；如果恢复被遗留effect lease暂时拒绝，TUI以只读模式提交durable replay、显示
  本地诊断并保持Run状态行隐藏，不合成lifecycle terminal。
- `/rewind`的checkpoint list/preview绑定Reducer当前`activeSessionId`，只读query不依赖subscription ready；执行rewind仍等待exact
  Session readiness与Controller。连续fork后必须等待新Session durable identity，不能用旧viewport文本冒充第二次完成。
- TUI干净退出前重读权威projection：idle且无pending interaction的本client Controller执行release，active/pending/unknown执行detach；
  所以后续进程可直接取得已完成Session的Controller，而未完成Turn仍保留detached recovery边界。
- Session 删除是带 scoped command receipt 的 Runtime command；Host/Store 在单一事务边界删除 Session
  facts 并保留 receipt。TUI 不直接删除 SQLite 行，也不能在 close snapshot 之后把已删 Session 复活。

## 主输入与状态行

- `InputLine` 在首次 Ink effect flush 注册 `useInput` 后立即可编辑；注册前不显示假焦点，不使用固定延时作为门禁。
- 内部状态阶段仍单向推进 `Thinking → Working → Finishing`；进入 Working 后不因模型/工具交替回退。Footer在普通执行期显示不参与本地化的英文`Working`；已完成的无工具模型正文进入Static、但权威Run终态尚未到达时显示`Finishing`。任一权威完成或失败终态到达后都立即隐藏状态行。
- Retry、Approval、Input、Compaction与slash modal都是覆盖态，不改变底层阶段。Approval、Input与Plan review取得Footer焦点时隐藏
  active Run状态行；普通slash modal、Retry和自动compaction仍可与底层Run状态并存。手动compaction使用消息区动画。
- 工具卡可乐观显示 running，但执行耗时从 durable `tool.started` 开始；迟到 started 不复活终态卡片。
- 工具 policy/formatter 只使用封闭 canonical category；动态 MCP/Provider 工具另携带 App 投影的有界
  `displayLabel`，所以本地界面保留具体名称而不把任意字符串提升成 capability。不得用通用 `tool` 占位
  覆盖已经投影的具体名称。
- queued 工具只缓存 call ID、category、display label 与完整有界 arguments；started 才物化。普通本地
  path/pattern/command/result 可显示，明显 credential 仍在 App projector 过滤。
- TUI 只根据结构化 terminal outcome、safeRetry 与 canonical events 决定完成/错误，不从本地化文本反推。

## 验证

`bun test apps/kite-cli/test`、`bun run test:tui:system:core`、`bun run typecheck`。
