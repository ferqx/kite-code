# TUI PTY E2E 测试标准

状态：active

读取时机：新增或修改 `tests/tui-system/`、终端交互、mock model server、SessionRuntime 或跨进程恢复场景时。

验证：`bun run test:tui:harness`、`bun run test:tui:system`、`bun run test:tui:system:core`。

## 测试边界

PTY E2E 必须启动真实 TUI 子进程，走生产配置加载、HTTP 模型调用、`runRuntimeAgent()`、Runtime Store、SessionRuntime、AgentEvent reducer 和 Ink 渲染。只允许 mock 模型服务及必要的外部 provider；不得 mock TUI、Kernel 或 reducer 主链路。

## Harness 结构

```text
tests/tui-system/
├── harness/    快速单元测试及 PTY 进程、mock server、输入、screen、workspace 基础设施
├── scenarios/  默认确定性门禁：startup、input、approval、session、recovery 等
└── smoke/      依赖宿主机原生能力的显式 opt-in smoke
```

测试必须使用隔离的临时 HOME、workspace、配置和 Runtime 数据库。禁止读取开发机真实密钥、用户配置或会话数据。
Harness 单元测试属于默认 `unit` 门禁；只有 `scenarios/` 中启动真实 TUI 的文件属于串行
`tui-system` job。两者不得在 system runner 中重复执行。

Prompt Contract 迁移必须有 production-mode PTY scenario：通过正常 layered config 显式开启候选
flag，以 `NODE_ENV=production` 启动真实 TUI composition root，并从本地 mock Provider 收到的实际
HTTP request 验证 stable System（adapter 可合并相邻 System frame）/project/user/runtime 消息顺序、
cacheable context、唯一 Runtime block、phase-stable V2 工具声明和 Runtime-owned phase rejection。该 scenario 是 production TUI
链路证据，但仍是本地确定性 Provider，不能表述为真实模型
A/B、release artifact 或平台资格证据。

权限与隐私状态的可见性必须由真实 PTY scenario 覆盖：无沙箱时 `/permissions` 选择器保留 Full
能力说明并显示环境警告，默认 metadata session logging 不显示普通 mode 状态；测试同时验证 Full
不可选择、content logging 披露没有被普通 metadata 路径误触发。

MCP 管理 scenario 必须以当前中文可见语义等待 route readiness：列表通过“状态 + 选中行 +
添加入口”组合确认数据已加载，详情通过操作区确认已经打开；项目审批与 OAuth 恢复分别等待
“需要审批/稍后决定”和“需要登录/打开浏览器”。不得继续依赖旧英文标签或把题头单独当作
列表数据、选择状态或业务操作已经就绪的回执。

## 编写规则

1. 断言用户可见的稳定语义，不依赖 ANSI 字节、spinner 帧或精确空格快照。
2. 输入和等待使用 harness helper；scenario 禁止直接调用 `sleep()` 或 `setTimeout()` 猜测 UI
   何时就绪。`typeText()` 必须在返回前确认本次输入已由 Ink 回显并做有界重试；每次输入动作
   自己承担 readiness，不允许建立 warmup 测试或 warmup 流程。普通模型消息优先使用
   `submitUserMessage()`，把输入回显、Enter 和“本次提交之后产生的 mock model request”绑定
   为一个同步原语。该 request 必须从显式 baseline 之后查找，并匹配最新真实 user turn 的完整
   归一化文本；历史同文消息和 Kernel 注入的 `<runtime-state ...>` user message 都不能充当回执。
   已通过多步动作组成的输入使用 `submitCurrentInput()`；它必须确认活动字段已经离开提交值，并允许
   调用方提供新 modal、request 或终态的语义 receipt，避免 Enter 重试穿透到刚出现的下一层交互。
   要求语义 receipt 时，只有原字段仍保持原值才允许重试 Enter；字段消失或改变后只能继续等待
   receipt，超时必须失败，不能向未知的新焦点再次发送控制键。命令需要持久事件等强回执时，
   `submitCommand()` 必须把该 receipt 传入同一提交状态机。Enter delivery 的短重试预算与 request、
   持久事件等 semantic receipt 的场景预算必须分离；慢 CI 不能因输入框先清空而把后者缩短到
   delivery budget。跨进程回放场景的 test deadline 还必须覆盖独立的持久事件预算和后续 restart/
   selector replay，不得让外层测试先于其语义阶段超时。
   Bracketed paste 必须使用 `pasteText()` 取得当前活动输入的精确回执；只有整个 PTY
   transaction 丢失且输入仍可证明为空时才能有界重试。部分、变形或 focus 改变后的
   delivery 必须 fail closed，不得重放并冒险重复用户内容。
   需要执行的 slash command 必须使用 `submitCommand()`，由该 helper 等待完整命令帧
   的语义回执后发送 Enter；`typeText()` 只用于不提交的补全或禁用态断言，之后必须通过
   `clearInput()` 清理，不允许在 scenario 中再单独发送 Enter。输入回执必须来自
   VT parser 的当前 input projection，不得把 raw transcript 中已经被 Ink 擦除的历史帧当作输入成功，也不得以整个
   viewport 的任意文本命中代替活动字段。Harness 必须分别提取主 `❯` 输入、session 搜索、slash/file
   query 和 first-run block-cursor 字段，并对完整归一化字段值做等值验证；长输入同样不能退化为历史
   文本或尾部探针命中。共享输入 helper 拥有的动作保持光标位于输入末尾；其主输入 projection 必须
   根据 VT cell 属性剔除 `CtrlSafeTextInput` 绘制的 synthetic inverse-space end cursor，并覆盖 terminal
   auto-wrap 与 Ink continuation row。Ink soft wrap 在英文词边界省略的显示空格必须按可用输入宽度
   恢复，填满宽度的 hard wrap 则直接拼接；不能再通过删除全部内部 whitespace 让 `onehundred` 冒充
   `one hundred` 的成功回执。该 projection 不是任意光标位置的通用编辑器状态解析器。它不能把视觉
   光标当作逻辑空格，也不能因此删除用户真实输入的 leading/trailing blank。显式换行与重复空白可以
   做等价规范化，但逻辑词边界和前导空白不能被删除：它们会把普通消息改义，
   也会把 `/command` 变成普通文本。replacement 输入重试必须按已尝试字符确定性回滚到空基线，并
   额外清除 VT 投影可能裁掉的 bounded whitespace；不能仅因输入投影看起来为空就停止回滚。
   `typeText()` 默认要求空输入语义：主输入或搜索框若已有残留，先恢复为空再
   输入；确实追加到合法非空输入时必须显式传入 `append: true`，例如 Shift+Enter 多行输入。追加重试
   必须逐字符恢复动作前基线，不能按尝试长度过度删除已有内容。输入期间发生 modal focus transfer 时，
   只允许由已识别的新活动字段完成回执；列表项或 ghost suggestion 不能充当输入值。first-run 表单
   可能在逻辑空值时继续显示 configured default placeholder，helper 必须把该 placeholder 与追加基线
   区分。setup helper 在发送第一个控制键前，必须等待完整可交互状态（包括默认 selection）并等待
   该渲染稳定；main readiness 的空输入判断必须使用同一 end-cursor input projection，同时由普通
   `viewport()` 验证品牌、footer、loading/modal 等 chrome。单个标题字节出现不代表 `useInput` 已可
   接收输入。对已空输入
   的防御性清空允许只等待 quiet window，不得强制等待不会产生的 Ink receipt。
3. `write()`、`resize()` 和 `setRawMode()` 都会记录动作前的原始输出 checkpoint。`outputSinceLastAction()`
   与 `outputSince(mark)` 只证明动作后产生了新 PTY 字节，不能作为当前 UI 语义的最终断言。
   Harness 只有在对应 chunk 完成 VT 解析后才向 action delta 发布该字节范围，避免 byte receipt
   先于 screen state；scenario contract 仍会拒绝任何直接或间接以 raw delta 完成的最终 `expect()`。
   Harness 使用 headless VT parser 应用 ANSI erase、光标移动、换行和 resize：当前可见状态必须断言
   `viewport()`，已经提交且仍可通过终端回看器访问的历史断言 `scrollback()`；短暂 streaming/modal
   阶段使用 `markScreen()` 与 `screenFramesSince(mark)` 证明某个解析后的真实 frame 曾显示。
   “本次动作从未显示敏感/错误文本”同样必须遍历 action-local screen frame，不能用最终 viewport
   或 scrollback 的缺失替代。frame mark 绑定入队操作序号，mark 前已接收但尚未解析的 chunk 不得
   进入 mark 后历史；历史采用有界保留并在 PTY cleanup 时释放，因此 mark 应靠近被验证动作。若
   mark 已早于保留窗口，读取必须失败而不是对不完整历史给出通过结果。
   raw action delta 也不得直接授权下一个 Enter、Escape、方向键等控制输入；必须先从当前
   `viewport()`、row parser、mock request 或持久状态得到与该控件唯一对应的 readiness receipt。
   原始 `transcript()` 只允许进入失败诊断，scenario contract 禁止用它等待或断言语义。等待单一状态使用
   `waitForText()`，多终态使用 `waitForAnyText()`，非终端条件使用 `waitForCondition()`，需要
   settled Ink frame 时使用 `waitForOutputQuiescence()`。静默等待默认必须先观察到 checkpoint
   后的新输出，不能用“动作后没有输出”通过测试；语义结果明确时应先等待该结果，再等待稳定帧。
   prompt `❯` 是常驻 UI，提交请求、错误处理或 interrupt 后的任意中间重绘都可能再次输出它，
   因此不能把 prompt receipt 单独当作动作完成；应先等待该动作唯一的结果，再等待稳定帧或完整
   viewport 组合状态。异步加载列表的 modal 也不能以 title、搜索框或 footer 等静态 chrome
   作为数据就绪 receipt；必须通过 row-specific screen parser 等待当前 `viewport()`
   同时包含预期列表行、selection/active 状态与控件，且 loading 已结束，再执行筛选、
   选择或删除。普通 `screenContains()` 命中 modal 背后的 conversation 文本不能代替 row
   receipt。对有 debounced query 且包含多行的 selector，仅有首帧 rows + `!Loading`
   不足以证明 selection 稳定：依赖非默认行的场景必须先用 receipt-confirmed filter
   驱动一次最终查询并等待唯一目标 row。若 `D` 等动作的产品契约要求空搜索，再使用
   `clearInput()` 清空，等待最终 full-list reload 的 rows/selection/active/`!Loading`
   组合状态后才能导航或操作。连续 resize 的交互探针必须在每次断言后清空，不能让前一次未提交
   输入参与下一次 resize 的 readiness 基线。
   SessionSelector 初始焦点属于首个会话行，scenario 必须通过 `activateSessionSearch()` 取得搜索框的
   活动输入回执后才能调用 `typeText()`；不得把非活动态的 `搜索: —` 当作可编辑输入。过滤完成后焦点仍
   属于搜索框，scenario 必须发送 Down 并取得目标 row 的 selected receipt 后才能提交。Overlay 标题中的
   `数量 / 总数` 属于 frame metadata，file query projection 必须剔除该后缀。choice row 的选中标记以
   当前共享组件输出的 `❯` 为准。验证搜索区布局时直接断言 `搜索: —` 后一行为空；不得用可能同时出现在
   背景对话区的会话名称定位结果列表行。
   确实验证“某文本在时间窗内不出现”时使用 `expectTextAbsentFor()` 明示时间语义。清空输入统一
   使用 `clearInput()` 并等待新渲染稳定；特殊输入组件需要 ASCII Backspace 时通过显式选项声明，
   普通输入使用默认 DEL 编码。只有 `typeText()` 已确认输入片段未完整交付的内部恢复路径可以显式
   选择无 receipt 的 quiet-window 清空；scenario 不能用该选项跳过语义 readiness。
4. 每个 Bun `test()` 必须拥有真实、可单独运行的测试语义。多个 `test()` 不得通过 `beforeAll`
   共享同一个 TUI、mock response 队列或 workspace；真正独立的场景必须使用 `beforeEach/afterEach`
   获得新 fixture。确实需要共享跨动作状态时，该文件应通过 `createTuiSystemJourney()` 暴露一个
   Bun test，并把中间检查点注册为有独立超时和失败名称的 `step()`。step 不是可筛选的测试用例：
   前序失败后依赖步骤不会继续执行，也不会制造级联失败。scenario contract 会拒绝
   `beforeAll` 下注册多个 `test()` 的结构。journey 总 deadline 必须先于 Bun test 与文件级硬超时，
   使慢场景仍由 harness 报告当前 step，而不是先收到匿名外层超时。setup/readiness 不得伪装成
   可独立通过的测试用例。每个 journey 的 Bun test 必须显式使用 harness 导出的
   `TUI_SYSTEM_JOURNEY_TEST_TIMEOUT_MS`（180 秒）作为外层 timeout，不能依赖 Bun 的 5 秒默认值，
   也不能用局部 `TIMEOUT` alias 绕过统一预算。scenario contract 通过 AST 关联
   `createTuiSystemJourney()` 实例、`journey.run()` 与 test 第三参数，守住全部 stateful scenario；
   这也保证裸 `bun test` 发现 scenario 时不会在 harness step timeout 之前误杀。验证同一设置的双向转换时，如果反向转换不依赖正向转换的业务结果，
   应为两个方向分别建立明确的初始配置与独立 fixture；不得让反向断言依赖前序 suggestion、
   action delta 或重绘历史。step timeout 必须中止共享条件等待，并在独立的有界 settle window 内
   等待当前 step 收敛后才进入 fixture teardown；所有 journey 可达的 delay、screen polling 和
   PTY exit wait 都必须消费 step-local `AbortSignal`。忽略取消的自定义 Promise 不能无限突破
   journey deadline，必须以具名的 non-settling failure 返回；禁止超时 Promise 在后台继续访问
   已关闭的 PTY、server 或 workspace。
5. 审批、计划和 ask-user 测试必须完成结构化交互闭环，而不只断言卡片出现。fixture 中的
   `ask_user` 选项必须包含显式 `recommended` 布尔值，且恰好一个为 true，避免测试依赖隐式的
   首项推荐。验证内部 sandbox、session logging 或历史会话加载失败时，同时断言用户可见的受控
   恢复文案与原始诊断/存储细节不出现在对话或 Overlay 中。成功计划场景若已经等待并接受审核
   Overlay，则必须在回到 idle 前断言该 Overlay 已关闭；不得保留“未显示审核”的过时断言。
   V2 Plan fixture 的 `write_plan(submit)` 与 `update_plan` 必须从真实前序 Tool Result 解析并回传
   `{plan_id, version, structural_digest}`，不得只复用 `plan_id` 或预测生成 identity。规划期被拒绝、
   延后或取消的 Tool 会形成 unresolved completion blocker；这类负向 scenario 必须验证拒绝事实后
   取消审核或进入明确纠正路径，不能用 canned `plan_completed` 响应伪造成功完成。
6. 持久化测试应跨进程打开同一 Runtime Store，验证 session、snapshot 和 transcript 恢复。
   同一进程内的 `/new` 或 session switch 不能依赖累计 PTY transcript：新 session 首次产生
   Runtime event 后必须校验 Runtime Store 中出现不同 thread ID；切换回放先用 Enter checkpoint
   确认新输出，再等待 `viewport()` 同时满足目标 user/assistant 内容与 prompt 已出现、另一会话
   内容不存在。跨进程加载同样必须等待完整 viewport 组合状态；selector 已经包含的 session title
   不能作为 Enter 后回放完成的 receipt。空 session 尚未产生事件时不要求提前出现在持久化 session
   列表。
   需要证明输入或 slash command 可跨进程恢复时，当前 viewport 只证明渲染，不证明 SQLite 已提交；
   退出进程前必须同时读取隔离 Runtime Store，确认目标 event 已持久化。轮询持久化证据时必须使用
   SQLite readonly 连接和精确 event 字段查询；不得调用会设置 journal mode、执行 schema migration
   或创建索引的生产 `createRuntimeStore()` 初始化路径，否则观察器会与被测 TUI writer 竞争。
   需要证明同一 turn 的 CompletionGuard correction 时，observer 必须先由精确
   `user.message_appended` 定位 session，再以其后的 `turn.started` event ID 为起点，到下一
   `turn.started` 前读取有序 durable window；`model.requested` 没有 `turnId`，不能仅按 JSON
   `turnId` 过滤而遗漏 correction continuation。
   终端提交回执、Runtime event 落盘和重启后 replay 是三个独立证据边界，必须分别等待并报告失败；
   选择待恢复 session 时绑定目标 event 的 thread ID，不得依赖秒级 `updated_at` 排序猜测第一行。
   session 删除确认必须同时验证被选 thread ID 已从 Runtime Store 消失且 active thread 保留；取消
   删除必须验证 thread ID 集合不变，不能只依赖 selector 列表缓存。
7. 改动 Runtime 多轮语义时同时运行 `tests/runtime/agent.integration.test.ts`、`tests/runtime/store.test.ts` 和相应 PTY scenario。
8. 在同一 runner 内 PTY suite 必须串行运行，避免终端尺寸、端口和全局环境相互污染。
   Harness 单元测试由默认 `bun run test` 或显式 `bun run test:tui:harness` 执行；
   `scripts/run-tui-system-tests.ts` 只按 scenario 文件逐个启动独立 `bun test` 进程。
   Required CI 可以通过 `KITE_TUI_SYSTEM_SHARD=<zero-based-index>/<count>` 将默认 scenario 清单按
   排序后的稳定索引分配到互相独立的 GitHub-hosted runner；分片不得共享 workspace、HOME、端口或
   进程树，并且每个分片内部仍按文件串行。显式 scenario 参数是本地定向复现入口，不受分片过滤。
   runner 的显式 scenario 参数按完整文件名匹配；未知名称和重复名称必须在启动前失败并列出
   可用文件，不能静默少跑。默认运行会串行完成全部隔离文件并在末尾汇总所有失败，避免首错遮住
   后续不稳定场景；本地只需快速复现首错时可显式设置 `KITE_TUI_TEST_FAIL_FAST=1`。每个文件都输出
   独立耗时，便于定位预算异常。
   唯一例外是 fault-soak 通过 `--with-lifecycle-harness` 显式追加
   `tui-lifecycle-resource.test.ts`；该参数不会发现或运行其他 harness 文件，普通
   `test:tui:system` 也不得隐式包含 harness。这样 terminal taxonomy 的 PTY 场景与
   focus-listener 同进程重复 lifecycle 证据在同一个 bounded probe 中收集，但仍保持独立进程。
   fault-soak runner 必须先验证自身是 outer PGID owner，再让 per-file Bun、实际 TUI 与 lifecycle
   fixture 继承该 group；普通 PTY suite 才为每个 child 创建独立 group。这样 `ps` inspection
   不可用时，outer deadline 仍能通过一个已验证 PGID 回收完整 TUI 树。
   每个文件的本地基础硬超时为 240 秒，并与条件等待、Bun test 和 journey deadline 使用同一
   timeout scale；runner 会把实际 file budget 下传并自动保留 test/teardown 余量。自定义
   `KITE_TUI_TEST_FILE_TIMEOUT_MS` 时，内层 test 与 journey 会按该上限收缩，不能越过文件 deadline；
   小于 16 秒、无法保留最小双层 cleanup margin 的自定义值会在启动前被拒绝。
   超时后 runner
   只向启动时已验证、PGID 等于 child PID 的自有进程组发送信号，终止测试进程及其 TUI 子进程树，
   不得扫描或杀死非本 runner 创建的进程。需要诊断慢场景时可通过 `KITE_TUI_TEST_FILE_TIMEOUT_MS`
   调整单文件上限，不得取消硬超时。
9. `run.completed.output` 是最终回答的权威渲染校准点。TUI 必须在切换到 idle、把当前 turn 移入 Ink `<Static>` 之前，用它补齐可能缺失的尾部并结束所有 streaming text block。MCP/工具调用后的长回答必须断言末段在当前会话中可见，不能依赖重新进入会话后的 replay 才出现。
10. `tool_search` 在对话区按用户可理解的发现过程渲染：运行中显示 `Searching for tools…`，成功后显示 `Searched for tools`，并以 `Provider · Tool` 树列出 names-only 命中项；catalog revision 切换期间返回的 last-known names 使用同一树结构，但不得暗示已签发 Binding。只有当前结果和 last-known names 都为空时才显示 `No matching tools found`，失败使用独立状态文案。真实 MCP 调用仍是独立工具块，名称从协议形式 `mcp__provider__tool` 映射为 `provider · tool`。展示层不得从模型回答或任意参数猜测自然语言动作。
11. 所有 scenario 必须通过 `spawnReadyTui()` 启动；普通场景使用默认 `main` readiness，
    first-run 与 workspace trust 场景分别显式选择 `first-run-provider`、`workspace-trust`。
    仅出现标题或 prompt 不构成可交互就绪。普通场景由 harness
    预写 `source: 'test'` 信任记录，验证门禁本身时使用
    `createTestWorkspace({ enforceWorkspaceTrust: true })`。子进程环境采用 allowlist，只继承平台启动、
    临时目录、locale、时区和 CI 所需变量，再叠加 fixture 显式环境；不得继承开发机密钥、代理、
    Provider 配置或 feature flag。直接调用 Ink `render()` 的 PTY fixture 必须像生产 composition root
    一样，以实际 `stdin/stdout` TTY 能力显式设置 `interactive`；不能让 Ink 因 `CI=true` 转入只在
    unmount 时输出最终帧的非交互模式，否则 semantic readiness 看不到实时 prompt。
    输入重试清理不得以全屏 quiet window 作为完成条件：running status/spinner 可以持续合法刷新；
    清理后必须由调用方读取当前 input viewport，语义确认输入已回到预期 baseline。
12. 终端 focus reporting 由进程级 `TerminalFocusStore` 复用：任意数量 React subscriber 只能
    对 stdin 保持一个物理 `data` listener；首个 subscriber 开启 DEC 1004，最后一个
    unsubscribe 必须移除 listener 并关闭 DEC 1004。禁止组件 mount 各自添加 stdin listener。
13. 完整 suite 的协调进程和按文件隔离 scenario 只提供功能、终态和进程退出证据，不将跨进程
    RSS、active resource 或 FD 冷启动差值拼接成 leak 趋势。1C.7 TUI 资格样本必须由专用 child
    在同一进程内完成 warm-up 加 8 次 `InputLine`/`TerminalFocusStore` focus-listener lifecycle，
    并逐次证明 listener 已真实挂载、随后卸载且 descendant 清理。该结论只覆盖输入 focus listener
    生命周期，不覆盖 session switch、tool lifecycle 或 model reconnect 的 PTY 资源斜率。
14. MCP tool failure 与紧随其后的 Provider recovery interaction 必须按同一 Kernel batch
    顺序提交；`run.completed + turn.completed` batch 必须产生命名 rewind 恢复点。
    `SET_EXITED` 不得重写已经交给 Ink `<Static>` 的 streamed text block；最终回答尾段由
    `run.completed.output` 校准。
15. 条件等待在共享 CI runner 上默认使用 1.5 倍预算，本地保持 1 倍；可用
    `KITE_TUI_TEST_TIMEOUT_SCALE` 设为大于 0 的倍数覆盖，超过 3 时按 3 倍处理。增加预算不能
    替代输入回显、请求 baseline 和 modal/命令结果条件。失败诊断必须包含最近 mock request
    与终端输出尾部。
16. 默认 scenario 不得访问公网 provider。first-run 的 `/v1/models` 成功、延迟、错误和模型列表
    必须由本地 `MockModelServer` 固定；真实模型只允许进入独立 live runner。provider/form 的静态显示、
    焦点移动、密码遮罩和错误菜单属于快速 first-run 组件测试；PTY scenario 只保留真实 TUI 与本地 HTTP
    连接、取消、错误路由及配置持久化的边界。
17. 依赖宿主机原生能力的正向场景不得进入默认 PTY 门禁。sandbox、keyring、外部编辑器等
    场景应使用显式 opt-in smoke，并在运行时确认后端存在；默认 suite 只验证可人为固定的
    负向/降级路径。授权、policy 和 reducer 的完整分支必须由注入能力状态的确定性单元或
    Runtime 集成测试覆盖，不能让 GitHub runner 是否预装 `bwrap` 改变默认测试结果。若默认
    scenario 需要验证 Shell 审批或展示链路，必须在隔离 workspace 配置中显式关闭 native sandbox，
    运行只依赖测试 Runtime 的受控命令，并从真实 Tool result 校验唯一 marker；不得让
    `sandbox_apply`/`bwrap` 失败后仍靠模型固定回答通过。
    `sandbox-mode` 中 `/permissions` 无参数场景只证明开发 composition 打开 interaction mode 选择器，
    选择器中的 Full 不可选场景只证明 sandbox 关闭时 Full 不可选；两者都不是 native sandbox、
    release admission 或 production platform qualification 证据。
    同一 scenario 的 `/release` 只证明普通开发入口显示 `artifact_disabled`，不代表 embedded
    profile、Sigstore、artifact attestation、平台制品或任一 production Gate 已通过。
18. 远程 HTTP MCP 正文调用不得沿用旧的隐式外发前置条件。验证默认边界时使用生产 TUI
    组合根，并断言 `remoteMcpEgressPolicyV1=false` 产生零 `tools/call` 请求；验证认证恢复、
    失败隔离等需要成功外发的其他主题时，场景必须在同一个 Bun test 内显式开启该 flag，
    并通过 `remoteMcpEgressPermitResolver: 'allow-each-invocation'` 选择仅测试组合根。该组合根
    为每个 invocation 签发独立短时 permit，不得由全局 harness、环境变量或生产入口自动放行。
    scenario contract 会拒绝只配置 flag 或只注入 permit issuer 的半配置场景。自动重试与
    permit replay 属于 MCP policy/integration 层；不以重试为主题的 PTY 场景应配置 `retry: never`。
19. selector command（`/permissions`、`/effort`、`/theme`、`/model`）不得通过空格和二级参数
    选择值。PTY 场景以选择器标题为确认回执，在选择器关闭前不得发送下一条命令；场景不得用固定
    sleep 修补命令提交到 Overlay mount 的 React commit 竞争。
20. HTTP 429/5xx 属于模型 transient retry 场景。验证终态错误恢复时，mock 必须连续返回足够次数的
    transient failure 以耗尽 production bounded retry budget，并断言 retry UI、实际请求次数、终态错误
    与下一用户 turn 恢复；不得用一次 500 后的默认成功响应声称已经验证错误终态。只验证“不重试”时
    应使用 401 等明确非 transient 错误，或在模型单元测试中显式注入 `maxAttempts: 1`。
21. Mock response queue 是一次性、按阶段配置的严格队列，不得循环复用响应；队列耗尽必须返回
    fixture error，存在未消费响应时不得切换 response phase，teardown 同时拒绝意外请求和剩余响应。
    请求历史和请求计数跨 `setResponses()` 保持单调，便于证明 retry/auxiliary call 的真实数量；不得
    以重复文本、dummy 或历史 `generateSessionName` 假设填充队列。Mock 发出的每个
    `tool_call_id` 还必须跨父 Agent、Subagent 等交错请求保持未闭合跟踪，直到某个后续模型请求携带
    同 ID 的 Tool result；teardown 时仍未闭合即失败。只有审批拒绝或 Esc 取消等明确终止本轮的
    fixture 才能在该 Mock response 上声明 `toolContinuation: 'aborted'`。每个未取消 Tool call 的
    下一次 continuation response 都必须通过 `expectedRequest.toolResults` 声明并校验真实 Tool
    result 的稳定结果标记，包括预期拒绝、延迟、parse error 和 provider failure；不能只在成功
    文案前选择性校验。缺失或内容不符时 mock server 返回 fixture contract error，不能继续输出
    canned 文案。文件、导出、持久化等副作用还必须以磁盘或 Store observer 验证真实状态，模型文字
    和 Tool result 二者都不能单独替代副作用证据。嵌套
    Subagent 请求可以合法穿插，但不能清除父调用的未闭合状态。
    触发 `task` 的 Subagent scenario 必须给出有界、自包含且值得独立调用的用户任务，请求范围必须与
    fixture 选择的角色一致（例如只读检查使用 `explore`/`review`，实现修改使用 `code`）；项目文档、
    fixture 注释或模型 canned response 不得扩大 phase、authorization、预算或角色能力 ceiling。
    多个 Subagent fixture 必须验证串行 lifecycle，模型可见文案不得声称并行派发；前一 child terminal 或 suspended
    收敛前，后继 `task` 不得被展示为已并行启动。
    当后续 tool call 必须使用前一 Tool result 中运行时生成的标识时，当前 queue slot 可以使用
    test-only `response(request)` resolver 从已记录的 Mock request 生成该 slot 的 response；resolver
    不能读取 queue cursor、未消费 response、Runtime state 或网络。它仍严格消耗一个 slot，且返回值
    必须经过同一 `expectedRequest`、continuation、error、SSE 与 teardown contract 路径。
    Plan lifecycle scenario 必须从真实 `draft_saved` Tool result 读取 identity，随后覆盖 submit、真实审核批准、
    `update_plan(complete_plan=true)` 与 terminal `run.completed`；不得用虚构第二个 final 填充 CompletionGuard correction。
    与这些场景相邻的测试说明和断言必须使用当前 save → submit → review 生命周期，不能保留要求
    `exit_plan_mode` 或声称运行时 Plan identity 不可获得的旧描述。
22. Scenario teardown 必须使用 `cleanupTuiSystemFixtures()`，先等待所有 TUI 自有进程组退出，再停止
    mock/本地服务，最后清理 workspace；任一阶段失败都不能跳过后续资源，最终以 `AggregateError`
    报告。scenario contract 禁止直接调用 server `stop()` 或 workspace `cleanup()`。
23. 终端 scrollback 行数不是命令提交凭据。Ink 在不同 PTY 速度下可以重绘或压缩历史行；若行为会
    产生持久 Runtime fact，scenario 必须用只读 observer 断言精确事件，并只把终端输出用于验证
    用户可见投影。没有持久事实时应等待命令的唯一语义响应，不能用 prompt 行数变化替代。
24. Tool Card 中先出现的问题、标题或第一个选项不代表 interrupt/modal 已可交互；PTY 分块解析可能
    观察到尚未完成的 incremental render。审批场景必须在同一 current viewport 同时确认标题、默认
    选中项、全部选项和 footer，其他场景至少等待该交互独有的最后一个选项或操作，再发送方向键、
    Enter 或 Escape；后续 canned continuation 还必须校验同
    `tool_call_id` 的实际选择或取消结果，不能只因问题文本可见就判定交互就绪。
    `/mcp` 面板必须在同一 viewport 同时出现当前本地化的 `MCP 服务器` 标题和
    `添加 MCP 服务器` 操作项后，才能发送 Escape 或继续断言面板行为。共享 Overlay footer
    的 readiness 断言必须使用当前词汇（例如列表移动为“导航”），不得保留过时文案。
    `/mcp` select 管理只读场景断言精简后的操作标签（`禁用`、`移除`），随 Overlay 文案收敛保持一致。
25. 最终回答文本可见不等于上一轮已回到稳定 idle。跨轮发送新消息、slash command 或 `/exit` 前，
    场景必须等待完整 main readiness（空输入、无 loading/modal 且输出稳定）；不得把回答尾部文本
    当作下一次键盘输入已可接受的信号。
26. 同时包含本地模式切换和模型任务的复合 slash 输入不得作为 PTY 场景的同步捷径。规划场景应先
    提交 `/plan`，等待规划提示和 main readiness，再以普通用户消息提交任务；这样分别证明模式切换
    与模型请求，避免 slash ref commit 和 Enter 竞争。
27. `submitCommand()` 不得以“命令字符已回显”作为提交完成。共享 helper 必须在发送 Enter 后确认
    active input 已离开该命令或进程已退出；若输入仍由原命令占有，只能在固定次数内重送 Enter，
    耗尽后明确失败。场景不得自行用 sleep 或无回执的单次 `write('\\r')` 替代。
28. 共享 choice overlay 的场景必须验证当前 viewport 中的完整标题、全部可见选项、默认选中项和
    footer，再发送导航或确认键。删除等破坏性确认必须覆盖安全默认项，先等待目标选中 marker 再
    提交；Enter 选择安全默认和 Esc 都要证明持久状态未变。具有 browse/confirm 两层的 overlay
    必须证明 Esc 先返回内层而不是关闭整个面板。`/rewind` 的状态化 journey 还要同时验证文件内容、
    fork 后的 Runtime Store session 数和新会话继续回退的恢复点链，不能只依赖成功提示文本。
29. 只为观察 selector 或补全结果而调用 `typeText()` 的场景，若不提交该输入，必须在测试结束前
    用 `clearInput()` 显式清空并等待输入投影收敛。不得依赖 afterAll 关闭 PTY 来掩盖未收敛的
    typed-input lifecycle；scenario contract 必须在静态扫描中拒绝这类场景。

组件级 Ink 测试适合布局和 reducer 细节，但不能替代 PTY E2E 的真实终端覆盖。

## 运行入口

- `bun run test`：默认快速门禁，包含 harness 单元测试，排除真实 PTY scenarios、smoke 与 spike。
- `bun run test:tui:harness`：只运行快速 TUI harness 单元测试。
- `bun run test:tui:system`：按文件串行执行完整 PTY suite。
- `bun run scripts/run-tui-system-tests.ts --with-lifecycle-harness session-switch tool-lifecycle model-stream-reconnect`：
  fault-soak 专用组合，显式追加一个 lifecycle harness；不是常规 PTY suite 入口。
- `bun run test:tui:smoke:native`：
  在已安装 `sandbox-exec` 或 `bwrap` 的宿主机上显式验证 Full 模式真实 PTY 链路。
- `bun run release:smoke`：在隔离 managed prefix 中直接以真实 PTY 启动已安装的 standalone
  `kite-tui`；不得用源码入口 startup 或单独 `--version` 代替候选 executable 的启动证据。
- `bun run test:all`：先运行默认门禁，再运行完整 PTY suite。
- 裸 `bun test` 会按 Bun 默认发现规则包含高成本 PTY 文件，不是仓库规范的全量入口；scenario 仍须
  具备显式外层 timeout 并可直接运行，不能因默认 5 秒上限产生伪失败。
