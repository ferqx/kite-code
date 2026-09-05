# TUI 系统测试规范

本页是 `apps/kite-cli` 的 owner-local current authority，覆盖真实 PTY journey、harness、smoke 与资源清理。

## 套件边界

- `bun run test:tui:harness` 运行 deterministic harness 单元测试。
- `bun run test:tui:system` 按文件启动隔离 PTY scenario；CI 使用 `KITE_TUI_SYSTEM_SHARD=index/count` 分片。
- `bun run test:tui:smoke:native` 只运行显式 native sandbox smoke。
- 默认 `bun run test` 不执行真实 PTY scenario、native smoke、spike 或 live Provider。
- source PTY child从repo-owned `scripts/release/entrypoints/tui.ts`进入parent-owned App Server composition，不再直入
  `apps/kite-cli/src/tui/executable.tsx`绕过release resolver；installed smoke使用standalone executable并解析同candidate Service child。
- PTY harness可用显式`args`启动`--server <endpoint>`场景；参数由scenario固定，不从ambient进程状态发现daemon。

## Runtime client boundary

- TUI system journey使用production-shaped typed projection：terminal facade → RuntimeClient → stdio App Server
  RuntimeServer → RuntimeAccess。测试不得通过 direct Host/SQLite handle、旧 runtime bridge 或本地 Store写入伪造UI state。
- harness可注入显式 `in-process-service-connector` 来稳定测试presentation journey，但它必须组合Service-owned
  application并经过相同 Local Service client seam；fixture不是CLI embedded fallback，也不能重新在CLI创建Host/Store。
- 完整历史断言经Runtime mode connection的client-safe History DTO完成；Server subscription replay、JSONL、trace或
  SQLite raw event不能替代它。
- 历史Session打开只取得Observer；首次run/rewind等mutation才惰性发送`resume_session`。rewind创建的continuation在返回UI前完成该准入与
  subscription readiness，确保连续rewind不会等待一个永远未建立的目标stream。
- reducer 输入保持封闭 `RuntimeClientEvent`/interaction projection；测试应断言 unknown/unavailable 的 fail-closed 投影，而非向 reducer 注入 `any` 或 raw Runtime event。

## 输入 readiness

- Harness 从当前 VT buffer 识别 focused InputLine 的 inverse-cursor marker；marker 不可达时 fail closed。
- 不通过写字符探测 listener；readiness 后只发送一次 bracketed-paste transaction。
- Bun `Terminal.write()` 的同步 byte count 不作为重放依据；缺少应用 projection receipt 时测试失败。

## 隔离与清理

- 每个 scenario 拥有独立 Workspace、HOME、KITE_CODE_HOME、配置与持久目录。KITE_CODE_HOME在写入任何config前
  必须由production `ensureKiteProfileHome`创建；尤其Windows不得用普通`mkdir`继承runner ACL后再要求
  cleanup manager接管不同owner的目录。
- Runner 为每个文件设置 deadline，拥有 child process group/tree，并在成功、失败或 timeout 后回收。
- 场景不得读取开发机 credential、真实配置或 live Provider；live MCP/Model 使用独立显式命令。
- timeout、orphan process、残留 worktree/path 或缺失 terminal evidence 都是硬失败。
- fault-soak nonce下，注入取消可以合法留下未消费的预配置model response；cleanup只放宽该项，仍拒绝额外请求与未闭合
  tool continuation。普通PTY与release smoke继续要求response queue全部消费。
- 默认TUI cleanup先回收PTY process tree；parent pipe/exit coordinator收掉各自App Server，随后才能删除隔离Kite Home。cleanup不调用
  legacy Service manager，也不得把TUI disconnect解释成Session删除或成功cancel。
- test-owned Coordinator/Worker companion只在持久descriptor的PID与OS start token仍精确匹配时接收清理信号；先给SIGTERM
  graceful窗口，超时后再次核验同一identity才可SIGKILL并等待退出。该test-only fallback不进入production manager，也不能仅凭PID执行。

## Journey 规则

- 一个文件内按具名 step 串行执行，不跨文件共享 Session 或进程 authority。
- 断言以可见 VT buffer、canonical Runtime/TUI projection 和持久副作用证据为准，不依赖固定 sleep。
- Thought journey 必须覆盖 durable terminal 与 ephemeral delta 的允许乱序、reasoning completion 的 Server
  presentation route、reasoning delta 完成前不可见、completed 后以 `└─` 原子显示、后续 read/search 活动覆盖
  reasoning，以及流式文本始终作为独立 sibling block；viewport 与原生 scrollback 都不得重复；
  mock Provider 可用 `stream_frame_order: 'content_first'` 构造正文先于 reasoning 的真实 SSE 乱序，
  或用 `stream_frame_sequence` 与 `stream_frame_delays` 精确构造
  `reasoning prefix → content → reasoning suffix → terminal`。后者必须逐帧断言正文出现后不再展示 reasoning
  原文或活动 Thinking 圆点，并验证 settled live 与重启 `/resume` 最终只形成一个题头和一个回答块。
- 最终回复journey必须分别覆盖无Thought归属歧义的组件级流式提交，以及active Thought下的分类等待。前者的首个完整Markdown
  组件应在最后组件前进入真实VT/scrollback并由Static拥有；后者的待分类正文必须留在`RequestAssembly`且不创建OutputBlock，直到
  `model.responded(toolCallCount=0)`才发布，若`toolCallCount>0`则删除buffer并继续同一活动Thought。最终各组件在scrollback中
  各出现一次，工具型多轮项目探索只能留下一个聚合Thinking标题；在最终模型调用期间加入queued successor后，Thinking数量和
  工具统计必须保持不变，且后继prompt仍能正常执行。Headless terminal harness通过
  `scrollViewport()`与`viewportPosition()`模拟原生滚动；回答完成后向上滚动并等待空闲渲染窗口，距`baseY`的偏移必须保持，
  不得因Footer、焦点或长dynamic tree重绘回到默认位置。场景还必须在滚动后分别注入DEC FocusOut/FocusIn，并证明
  两次报告不产生任何新PTY stdout；同一TUI进程必须在连续两个完成Turn后重复该断言，避免只覆盖首次回答的Static初始化窗口。
  独立终态工具与全组终态Subagent也必须各有一条长回答journey，证明前置卡片不会阻塞后续组件Static、终态摘要只出现一次，
  且完成后的原生滚动在焦点报告前后仍保持零stdout与原偏移。
  仅验证headless `scrollLines()`后的buffer位置不足以覆盖真实滚动条交互。
- `model.requested`不是可见边界；没有正文、standalone tool或interaction打断时，相邻read/search与服务端判定为read-only的shell继续聚合在
  同一个Thought。TUI只消费Service给出的`presentation`分类，不根据原始command重新推断工具风险或展示类别。
- 取消、审批、Session 切换、恢复、resize 和 streaming 测试必须等待各自 exact receipt/readiness，不放宽 identity 或 lifecycle。
- Presentation收尾场景必须覆盖terminal-before-receipt、terminal后的late text/reasoning/tool事件、`/clear`后的marker唯一与零空闲stdout；
  active-stream场景必须用真实provider request同时证明当前Run模型冻结、下一Run模型生效，以及主题/语言切换不新增Run或重复正文。
- POSIX resize场景验证长文本窄→宽与宽→窄reflow、scrollback marker唯一和输入恢复；Windows不依赖ConPTY转发SIGWINCH，
  由可注入columns的组件测试证明相同逻辑reflow规则。
- 并发Subagent取消回归必须在真实PTY中同时验证child identity、Esc后1秒内`Cancelling`、重复Esc去重、queued successor
  的模型响应、入队前后完全相同的`Delegating`投影，以及durable Provider cleanup全部早于successor message且不产生
  `capability.execution_unknown`。
- 普通消息输入必须覆盖当前 Turn 运行期间的连续 Enter：第二条消息先显示本地排队回执，再以提交时的 Session identity
  等待 Service 权威 idle projection；遇到明确 `revision_conflict` 只使用同一 commandId 与 Service 返回的 current revision
  有界重试，最终两条模型请求和渲染各一次，不得清空后静默丢失或因切换 Session 改投目标。
- Harness 不得用“模型请求已经出现”替代排队输入的即时语义回执；deferred-delivery helper必须分别等待本地queue receipt
  与后续Runtime request。Native fake默认校验`start_turn.expectedRevision`，并可显式调度terminal projection先于command
  receipt；无条件applied或同调用栈固定顺序不能作为client时序证据。
- Workspace Trust journey必须覆盖App Control prepare/query/decision先于Runtime mutation；decline不得发Runtime command，trusted restart才可
  跳过prompt。PTY exit必须证明child退出但durable Session仍可由新TUI读取。

## 当前 evidence 边界

KASD-03新增真实双TUI journey：两个parent-owned App Server同时打开同一source profile，第二个读取第一个的Session，两边普通
`/status`都没有Service PID/Web URL/build drift。startup与exit/reopen journey使用持久`kite-session.sqlite`；installed macOS candidate
也通过真实PTY startup。完整三平台release/platform qualification仍在KASD-06，当前POSIX结果不能替代Windows/Linux证据。

KASD-04新增显式daemon journey：真实`server start`后两个TUI通过同一Unix socket读取durable History，单个TUI退出不停止daemon；
`server stop`取消active Turn、drain连接并清理endpoint。模拟旧build但同exact protocol的client可连接，要求未知capability的future client
必须fail closed；Windows named-pipe与完整三平台证据仍由KASD-06拥有。

KASD-05把daemon exact identity提升到v2并增加Web，但TUI场景仍只通过owner-only Runtime endpoint连接；`/status`不请求或显示Web origin。
完整42-file PTY再次通过，证明默认stdio与显式daemon交互未因Web listener改变。Browser/Native共享Store证据由release daemon test拥有。

## 验证

`bun run test:tui:harness`、`bun run test:tui:system:core`、完整 `bun run test:tui:system`。
