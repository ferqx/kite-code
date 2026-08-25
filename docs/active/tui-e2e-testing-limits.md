# TUI PTY E2E 能力与限制

状态：active

读取时机：评估 TUI 测试可覆盖性、处理平台差异、PTY flaky、终端 resize、跨进程会话恢复或选择组件测试与系统测试边界时。

验证：`bun run test:tui:harness`、`bun run test:tui:system`、`bun test tests/tui-layout.test.tsx tests/tui-reducer.test.ts`。

相关：ADR-0137、ADR-0138、`docs/active/tui-e2e-standards.md`、`docs/active/authorization.md`。

## 当前能力

当前系统测试通过 Bun 启动真实终端子进程，并使用 OpenAI-compatible mock server 控制模型响应。
Harness 同时保留原始 PTY transcript，并通过 `@xterm/headless` 维护真实 VT viewport、scrollback 与
逐 chunk 解析后的有界 screen frame 历史。action delta 只发布已完成 VT 解析的字节范围，PTY
退出或 cleanup 会等待解析队列并释放 headless terminal。它能够覆盖键盘输入、Ink 渲染、审批、ask-user、计划审核、
session lifecycle、跨进程 Runtime Store 恢复、错误恢复、streaming 瞬态和 resize。

### SAQ-10 可观测边界

PTY 只能观察 durable approval queue 的 canonical projection，不能把本地焦点或 UI optimistic ack 当作
授权事实。测试必须用 exact interactionId/generation 发送 Enter/Esc；Esc 只拒绝 focused approval，
Ctrl+C 才取消 whole turn，迟到 generation/session event 必须 no-op。多个 pending request 可以并存，但
只有当前可见 `awaiting_user` entry 拥有 Footer；queued_auto/auto_reviewing 只显示自动状态，不夺取人工焦点。

`interactionMode=full` 是唯一 Full authority，Full 选择与受限 sandbox availability 正交；backend unsupported
时受限执行 clean fail closed，不恢复旧 grant 或 host fallback。Human/Auto Subagent PTY 还必须观察 parent
Tool terminal barrier：reviewer/child capability 尚未完成时，外层 Tool 不得提前 terminal，恢复必须沿原
parent/child identity 与 queue generation 进行。

UI 已重新出现输入提示符只证明当前 screen projection 可交互，不能证明 Runtime terminal 或 session summary 已
持久化。涉及审批拒绝、graceful exit、`/resume` 或跨进程恢复的场景必须先用 readonly persistence observer 等待 exact
`turn.aborted`、session name 或其他目标 durable fact，再关闭进程或打开恢复选择器；observer 必须沿既有 bounded
lock/protocol 规则轮询，不能通过初始化第二个 Store 干扰 writer。

Planning read-only sandbox baseline 的 PTY 场景必须在入口读取 production backend availability。backend 可用时断言
baseline direct 且无 approval；不可用时断言 exact mandatory-sandbox failure、零 Workspace execution 与零 host
fallback。后者是确定性的 fail-closed 平台证据，不得 skip，也不得把 hosted runner 恰好缺少 bwrap 解释为产品回归。

## 已知限制

1. Windows 与 Unix PTY/ConPTY 的控制序列、信号和进程树行为不同；断言必须基于归一化 screen 文本。
2. Spinner、耗时和异步事件到达顺序不稳定，不应作为精确快照契约。
3. `<Static>` 已写入物理终端的内容不会像普通 React 节点一样撤回；`/clear` 的 reducer 清理由
   `tests/tui-reducer.test.ts` 覆盖，PTY 场景只验证命令路由与恢复，不能声称已经擦除终端 scrollback。
4. Headless VT parser 能处理当前 Ink 使用的 erase、光标和 wrapping 序列，但不能证明所有终端实现
   一致；DEC synchronized output、ConPTY 差异和宿主终端字体宽度仍需专门平台测试。
5. 外部编辑器、公网 MCP、真实模型和平台 sandbox 不属于默认 PTY suite，应使用边界测试或
   显式 opt-in 环境 smoke。默认 suite 可以连接进程内本地 MCP fixture 走真实 HTTP/stdio
   协议；涉及 HTTP 正文调用时必须显式注入本地 endpoint 与 fixture credential，并经过生产的
   bounded argument/secret inspection。平台能力的正向场景必须在测试入口确认真实后端存在；默认门禁只保留可固定能力
   状态的降级路径，不能按 runner 恰好安装的软件改变断言。
6. PTY 测试成本高，不应用来穷举纯 reducer、policy、schema 或仅由本地组件状态决定的表单/菜单分支。
   provider/form 的静态内容、焦点、遮罩和错误选项应使用 Ink 组件测试；只有真实 TUI、HTTP、持久化或
   跨进程边界进入默认 PTY suite。
7. 完整 PTY suite 在单个 runner 内按文件隔离、串行执行并设置单文件硬超时；因此失败会定位到具体
   scenario，且不会因一个遗留 TUI 子进程无限占用整套测试。Required CI 可按稳定索引将默认清单分到
   独立 runner，但每个分片继续保持这一串行和隔离边界。
8. suite runner 只负责编排按文件隔离的功能场景，不从协调进程或跨 scenario child 的 RSS/
   active-resource/FD 差值推导 leak 结论；fault-soak CI fresh child before/after 也只用于冷启动诊断。
   TUI leak 诊断只能在明确拥有的真实 Ink child 内进行：同一 PID 先 warm-up，再重复 8 次
   `InputLine`/`TerminalFocusStore` reporting mount/unmount，并逐次证明 DEC 1004 先开启、随后关闭且没有
   descendant PID。该限定范围的 lifecycle series 只用于本地/CI 诊断，不代表 session switch、tool lifecycle、
   model reconnect 或生产平台 admission；多个 PTY scenario、父 runner 趋势或跨进程差值也不能替代它。Windows
   无通用 `/proc/self/fd` 或平台不能检查 owned descendant PID 时，相关指标标记为 unsupported，不得伪造通过。
   POSIX harness 终止已确认拥有的独立 process group 时，若 Bun 对负 PGID 的 `kill()` 返回 `EPERM`，只可在
   重新验证精确负 PGID 后调用原生 `/bin/kill` 发送同一信号；不得经过 shell、扩大到单 PID/其他进程组，或把
   未确认的清理伪装成成功。
9. PTY 原始输出仍是累积流，因此“原始字节里曾出现 `❯`”不能证明当前输入焦点可用。Harness
   生成带类型的 byte checkpoint；跨 checkpoint 的 UTF-8 code point 不归入动作后输出。每次
   write/resize/raw-mode 动作都更新 checkpoint，输入提交还必须通过本次输入回显与本次 mock
   request baseline 建立确认；最终 UI 语义必须回到 `viewport()`、`scrollback()` 或解析后的 frame。
10. `viewport()` 表示当前终端窗口，`scrollback()` 表示 VT buffer 仍保留的用户可回看历史，
    `screenFramesSince(mark)` 表示 checkpoint 后曾真实出现的瞬态画面；三者不可互换。原始
    `transcript()` 只用于失败诊断，scenario contract 会拒绝用 transcript 或 raw action delta
    完成 UI 断言。frame 历史有容量上限，适合靠近行为建立 action-local mark，不是无限期审计日志；
    读取已超出保留窗口的 mark 会 fail closed，避免不完整历史制造负断言假阳性。
    对“从未泄露/从未错误显示”的断言必须检查 mark 后全部保留 frame；只检查 scrollback 会遗漏
    出现在 viewport 后被 erase、但从未滚入 scrollback 的瞬态。
11. Runtime Store 在 session 首次产生持久事件后才列出该 thread；因此 `/new` 的持久化身份断言
    应绑定新 session 的首个真实动作，而不是要求空 session 立即出现。该断言必须同时保留旧
    thread ID 并观察到一个新 ID，避免把同一 session 的累计 transcript 误判为切换成功。
12. selector 中名称消失只能证明 UI 投影更新，不能单独证明删除持久化成功；confirm/cancel 场景
    还必须分别验证 Runtime Store thread ID 的删除与集合不变。
    Harness 的持久化探针只能通过 readonly SQLite 查询观察已经存在的 schema，并返回显式
    `ready`、`not_created`、`initializing` 或 `transient_lock` 状态；只有数据库尚未创建、schema
    尚未出现和明确的 SQLite busy/locked/protocol contention 可以由 bounded condition 继续轮询；其中
    `SQLITE_PROTOCOL` 只作为同一被测 writer 活跃期间的临时锁竞争，不得掩盖其他 SQLite 错误。目录路径、损坏 DB、
    普通 `SQLITE_IOERR` 和未知错误必须立即抛出，不能被负断言误当成空 Store。
    持续未就绪最终以具名 timeout 失败。在轮询中调用
    production SQLite storage adapter 初始化会重复执行 journal/schema 写入并干扰被测 writer，尤其会在共享 CI runner
    上把真实落盘延迟误报为 TUI 失败。命令回放场景还应查询精确 `user.command_invoked.command` 并
    使用该 event 所属 thread，不能用 JSON substring 或 session recency 代替持久化身份。
13. 有状态 journey 在一个 Bun test 内按 step 执行；首个失败会报告 step 名称并停止后续依赖步骤。
    每个 step 有局部超时，journey 另有早于 Bun test 和单文件硬超时的总 deadline；总预算耗尽时
    当前 step 会收到具名失败，因此局部超时之和不是文件可用总时长。测试报告中的 pass 数表示独立
    测试边界，不表示 journey 内动作数量。需要独立筛选、重跑或并行的行为必须使用新 fixture 写成
    独立 test，不能仅为增加报告粒度拆分共享状态。journey 通过 step-local `AbortSignal` 取消共享
    wait/delay/PTY exit wait，并在独立的有界 settle window 内等待该 step 收敛；忽略取消的 Promise
    会得到具名 non-settling failure，不能无限延长 journey deadline。
14. HTTP MCP fixture 的 endpoint 与 credential 仅由单个 `spawnReadyTui()` 调用显式选择。
    它不能通过 workspace `.env` 或 ambient process environment 注入生产组合；默认拒绝与本地允许必须写成不同、隔离的 test 语义。
15. `/effort`、`/theme`、`/model` 与 `/permissions` 都是无参数 selector command：确认命令后直接
    打开各自选择器。选择器打开期间 Footer 不渲染，PTY 场景在写入下一条命令前必须等待该选择器关闭，
    不得将选择列表误判为输入框。
16. Mock server 的 response queue 会在每个 provider attempt 消耗一个响应。HTTP 429/5xx 已走
    production bounded retry；因此单个 transient error 后跟成功响应验证的是 reconnect，不是终态错误。
    response 不会循环复用；队列耗尽、切换阶段时尚有剩余、teardown 时存在剩余都会产生显式
    fixture failure。终态 error-recovery 场景必须耗尽完整 retry budget，并用跨阶段单调请求计数
    证明没有提前终止或无限重试。
17. Mock 模型的成功文字不是工具成功证据。Harness 会按 `tool_call_id` 跨交错的父 Agent/Subagent
    请求跟踪 Tool result，未闭合调用在 teardown 失败；明确取消的调用必须显式标记 aborted。
    每个未取消调用的 continuation 都必须在 canned response 前声明并校验 Tool result 中的唯一
    结果 marker；预期失败同样需要验证其分类或原因，不能只检查成功路径。涉及副作用时还要同时用
    viewport、screen-frame history 或磁盘状态验证用户可见/持久副作用。该机制只能证明测试夹具观察到
    的协议和结果，不能把显式关闭 sandbox 的确定性 Shell 场景解释为 native sandbox 资格证据；
    Seatbelt/bubblewrap 的正向证据仍只来自 opt-in native smoke。
18. 无头 PTY 能稳定验证普通 Enter、方向键、Escape、Tab 和 bracketed paste，但不能保证完成宿主终端
    对 Kitty Shift+Enter 的协议协商。Shift+Enter 到软换行的键解析由 Ink 组件测试覆盖；PTY 默认
    场景用 bracketed paste 验证多行值从输入控件进入真实 model request 的端到端语义。不得发送一个
    未被协商的 CSI-u 序列、只检查两段文本仍可见，就声称已经验证软换行。
    Harness 通过 `pasteText()` 验证完整活动输入回执，并在唯一一次 transport write 前证明 focused
    `InputLine` 已注册键盘 listener：test-owned PTY 必须显式强制 ANSI modifier，只接受反色光标 marker，
    不得通过写入字符、再退格的方式探测 readiness。Bun 1.3 的返回值是同步 flush 计数，不是
    accepted-byte receipt；0 或部分计数同样可能已经 buffer 全部输入，POSIX drain 也不能提供可移植的
    重放边界。因此任意 byte count、缺失 VT 回执或变形交付都不得触发粘贴重发，只能 fail closed。
19. Mock request 回执只在显式 request baseline 之后匹配最新真实 user turn；Kernel 注入的
    `<runtime-state ...>` 消息不属于用户输入。输入提交的 Enter 重试必须在活动字段离开提交值、
    新 request 或新 modal 出现时停止，避免同一个重试跨过焦点边界执行下一层操作。普通模型消息
    必须等待新 request 这一 semantic receipt；输入字段暂时消失或清空不能单独使提交成功，也会
    永久停止该提交动作的 Enter 重试，后续只能等待 receipt 或失败，不能穿透到新焦点。输入
    projection 可忽略内部 wrap whitespace，但必须保留 leading whitespace。`CtrlSafeTextInput` 在
    输入末尾绘制的 inverse-space cursor 是 presentation cell；共享 helper 只在自己拥有且保持 end-cursor
    的输入动作中，通过 cell 属性从专用 input projection 剔除它。该 projection 支持 terminal auto-wrap
    和 Ink continuation row，并用输入宽度区分省略英文词间空格的 soft wrap 与直接拼接的 hard wrap；
    逻辑内部空格必须进入等值回执，不能全量删除。它不声称区分任意光标位置上的真实 inverse blank；
    普通 `viewport()` 仍保留用户实际看到的画面。main readiness 也必须使用该 input projection 判断空输入，并另用普通
    viewport 验证可见 chrome；不能让视觉光标阻止 idle 判定。逐字符 PTY delivery 必须在发送下一个
    非空白字节前观察到当前活动输入可投影的精确 prefix receipt。ordinary multi-word main input 与显式 paste/
    多行输入使用一次 bracketed-paste transaction 和 exact all-or-nothing viewport receipt；在写入前还必须
    从 real prompt 的 inverse cursor 证明 focused main handler ready；测试 PTY 必须强制 ANSI modifier，
    marker 不可达则 fail closed，不能写字符探测，也不能把 overlay 的反色 row 当作 input readiness。Bun 1.3/1.4 对 `Terminal.write()` byte count 的
    定义不同，该返回值和 drain 都不是 transport admission 权威。回显超时不能证明已接受的 transaction
    未交付，因此不得重放。selector/search 继续逐 prefix 验证。
    replacement 重试必须先逐回执清空当前可见输入，
    再有界清理 projection 不可见的尾随空白，不能盲发整段退格与尚未排空的 PTY 字节竞争，否则会把重试文本
    追加到首次部分交付。Enter delivery
    与 semantic receipt 使用独立 timeout；后者继续使用 request/event 场景预算。持久事件加进程重启
    的复合场景还要让 test deadline 覆盖完整 event receipt 与 restart replay，两者不能争用短输入预算。
20. suite runner 默认在进程隔离和单 runner 串行顺序不变的前提下运行所有选中 scenario，末尾一次性汇总失败；
    Required 可通过 `KITE_TUI_SYSTEM_SHARD=<index>/<count>` 在独立 runner 间稳定分片，所有分片通过后
    才能使汇总 `tui-system` 门禁成功。`KITE_TUI_TEST_FAIL_FAST=1` 只用于本地快速复现，不属于 Required
    的默认证据模式。
21. Runtime format compatibility 必须分三条真实 TUI 证据：未知 source 静默忽略且不阻止新会话；已知历史会话在
    `/resume` 中无迁移标签、选中前 target 无该 session、选中后 exactly-once 可读；fixture 必须包含同时存在 WAL+SHM
    的真实 sidecar 形态，并证明源 database/WAL/SHM 的 identity、mtime 与字节始终不改。
    未知 source 的后台发现可以在初始 `spawnReadyTui()` receipt 后再触发一次当前帧投影；startup 场景必须在该
    投影后通过一次 action-scoped 输入回执及其产品语义结果（例如 `/resume` 的正常空 selector）证明 fresh session
    仍可交互，不能重复消费一次性 input focus marker、要求有限行 Windows viewport 同帧保留 header 与 prompt，
    也不能用累积 PTY 输出里的旧 prompt 作为证明。
    已知历史 fixture 的持久 Workspace 必须与启动 TUI 的 worktree 不同，并断言选中后仍恢复消息且不显示 session-scoped
    failure；这证明 App 使用完整 persisted Workspace/Project identity，而不是偶然依赖相同路径。
    单个损坏会话只能显示脱敏 session-scoped failure，健康历史会话与普通输入继续可用。当前 target 使用 canonical
    Workspace identity 和 epoch 派生路径，`runtime-authority.key` 仍不得创建。
22. 跨进程非终态恢复必须让 fixture 在退出前观察到 exact queued/started/approval/continuation facts，再模拟正常退出或
    hard interruption。重开 target 后必须等待 Host readiness 与 post-recovery Store revision，分别断言未 dispatch work
    cancelled、dispatched work unknown/no replay、Subagent/sandbox cleanup receipt、有效 durable queue 保留，以及 Tool/
    Subagent/模型流不再显示 running spinner。同一进程 Session switch 的后台运行对照必须保持 live，避免把 navigation
    错测成 restart。恢复等待期间切换到另一个已注册 Session、重复选择同 target 和迟到失败还要验证 navigation token：旧
    结果不得覆盖 active turns/context，也不得清理较新 load 正在使用的 dormant Runtime。

## 分层选择

- 纯状态转换：单元/reducer 测试；
- Runtime 恢复与事件语义：Runtime/golden 测试；
- Ink 布局与换行：组件测试；
- 键盘到 Runtime 再到终端输出：PTY E2E。

同一 thread 的多轮继续由 Runtime State/SQLite Store 与 App `RuntimeSessionCoordinator` 注入所需 Kernel、effect
coordinator 和 concrete Model 后调用 `executeRuntimeTurn()` 恢复；App turn entry 不自行打开第二 Kernel、
创建第二 coordinator 或选择第二 Model。
TUI persistence observers、startup fixtures 与 file-rewind probes 使用 production epoch-derived current target path；历史
canonical path 只作为 readonly source fixture。Harness 必须从 production path helper 取得 current target，不能硬编码旧路径，
也不能通过初始化第二个 writer 干扰被测进程。
> 路径同步：TUI system 场景引用 production runtime store path helper。
