# TUI PTY E2E 测试标准

状态：active

读取时机：新增或修改 `tests/tui-system/`、终端交互、mock model server、SessionRuntime 或跨进程恢复场景时。

验证：`bun run test:tui:system`、`bun run test:tui:system:core`。

## 测试边界

PTY E2E 必须启动真实 TUI 子进程，走生产配置加载、HTTP 模型调用、`runRuntimeAgent()`、Runtime Store、SessionRuntime、AgentEvent reducer 和 Ink 渲染。只允许 mock 模型服务及必要的外部 provider；不得 mock TUI、Kernel 或 reducer 主链路。

## Harness 结构

```text
tests/tui-system/
├── harness/    PTY 进程、mock server、输入辅助、screen 解析、临时 workspace
├── scenarios/  默认确定性门禁：startup、input、approval、session、recovery 等
└── smoke/      依赖宿主机原生能力的显式 opt-in smoke
```

测试必须使用隔离的临时 HOME、workspace、配置和 Runtime 数据库。禁止读取开发机真实密钥、用户配置或会话数据。

## 编写规则

1. 断言用户可见的稳定语义，不依赖 ANSI 字节、spinner 帧或精确空格快照。
2. 输入和等待使用 harness helper；scenario 禁止直接调用 `sleep()` 或 `setTimeout()` 猜测 UI
   何时就绪。`typeText()` 必须在返回前确认本次输入已由 Ink 回显并做有界重试；每次输入动作
   自己承担 readiness，不允许建立 warmup 测试或 warmup 流程。普通模型消息优先使用
   `submitUserMessage()`，把输入回显、Enter 和“本次提交之后产生的 mock model request”绑定
   为一个同步原语。需要执行的 slash command 必须使用 `submitCommand()`，由该 helper 等待完整命令帧
   的语义回执后发送 Enter；`typeText()` 只用于不提交的补全或禁用态断言，之后必须通过
   `clearInput()` 清理，不允许在 scenario 中再单独发送 Enter。输入回执必须来自
   VT parser 的当前
   `viewport()`，不得把 raw transcript 中已经被 Ink 擦除的历史帧当作输入成功，也不得以整个
   viewport 的任意文本命中代替活动字段。Harness 必须分别提取主 `❯` 输入、session 搜索、slash/file
   query 和 first-run block-cursor 字段，并对完整归一化字段值做等值验证；长输入同样不能退化为历史
   文本或尾部探针命中。`typeText()` 默认要求空输入语义：主输入或搜索框若已有残留，先恢复为空再
   输入；确实追加到合法非空输入时必须显式传入 `append: true`，例如 Shift+Enter 多行输入。追加重试
   必须逐字符恢复动作前基线，不能按尝试长度过度删除已有内容。输入期间发生 modal focus transfer 时，
   只允许由已识别的新活动字段完成回执；列表项或 ghost suggestion 不能充当输入值。first-run 表单
   可能在逻辑空值时继续显示 configured default placeholder，helper 必须把该 placeholder 与追加基线
   区分。setup helper 在发送第一个控制键前，必须等待当前 `viewport()` 的完整可交互状态（包括
   默认 selection）并等待该渲染稳定；单个标题字节出现不代表 `useInput` 已可接收输入。对已空输入
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
   可独立通过的测试用例。验证同一设置的双向转换时，如果反向转换不依赖正向转换的业务结果，
   应为两个方向分别建立明确的初始配置与独立 fixture；不得让反向断言依赖前序 suggestion、
   action delta 或重绘历史。
5. 审批、计划和 ask-user 测试必须完成结构化交互闭环，而不只断言卡片出现。
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
   终端提交回执、Runtime event 落盘和重启后 replay 是三个独立证据边界，必须分别等待并报告失败；
   选择待恢复 session 时绑定目标 event 的 thread ID，不得依赖秒级 `updated_at` 排序猜测第一行。
   session 删除确认必须同时验证被选 thread ID 已从 Runtime Store 消失且 active thread 保留；取消
   删除必须验证 thread ID 集合不变，不能只依赖 selector 列表缓存。
7. 改动 Runtime 多轮语义时同时运行 `tests/runtime/agent.integration.test.ts`、`tests/runtime/store.test.ts` 和相应 PTY scenario。
8. PTY suite 必须串行运行，避免终端尺寸、端口和全局环境相互污染。
   完整 suite 由 `scripts/run-tui-system-tests.ts` 先运行 harness 单元测试，再按 scenario
   文件逐个启动独立 `bun test` 进程；每个文件默认硬超时 180 秒，超时后必须终止测试进程及其
   TUI 子进程树。需要诊断慢场景时可通过 `KITE_TUI_TEST_FILE_TIMEOUT_MS`
   调整单文件上限，不得取消硬超时。
9. `run.completed.output` 是最终回答的权威渲染校准点。TUI 必须在切换到 idle、把当前 turn 移入 Ink `<Static>` 之前，用它补齐可能缺失的尾部并结束所有 streaming text block。MCP/工具调用后的长回答必须断言末段在当前会话中可见，不能依赖重新进入会话后的 replay 才出现。
10. `tool_search` 在对话区按用户可理解的发现过程渲染：运行中显示 `Searching for tools…`，成功后显示 `Searched for tools`，并以 `Provider · Tool` 树列出 names-only 命中项；catalog revision 切换期间返回的 last-known names 使用同一树结构，但不得暗示已签发 Binding。只有当前结果和 last-known names 都为空时才显示 `No matching tools found`，失败使用独立状态文案。真实 MCP 调用仍是独立工具块，名称从协议形式 `mcp__provider__tool` 映射为 `provider · tool`。展示层不得从模型回答或任意参数猜测自然语言动作。
11. workspace 信任门禁默认由 harness 预信任：`spawnTui()` 为启动目录写入 `source: 'test'` 信任记录，新增场景无需关心启动授权。不使用环境变量旁路（Bun 自动注入 `<cwd>/.env*`，env 开关可被 workspace 文件伪造）。验证门禁本身时使用 `createTestWorkspace({ enforceWorkspaceTrust: true })`，参考 `tests/tui-system/scenarios/workspace-trust.test.ts`，门禁行为以 `docs/active/workspace-trust.md` 为准。
12. 终端 focus reporting 由进程级 `TerminalFocusStore` 复用：任意数量 React subscriber 只能
    对 stdin 保持一个物理 `data` listener；首个 subscriber 开启 DEC 1004，最后一个
    unsubscribe 必须移除 listener 并关闭 DEC 1004。禁止组件 mount 各自添加 stdin listener。
13. 完整 suite 每个 scenario 后采集协调进程 RSS、active resource 和可用平台 FD 数；最后
    一个窗口出现持续且超过阈值的正斜率时门禁失败。该趋势门禁用于发现 harness 泄漏，不替代
    1C.7 的长会话 soak。
14. MCP tool failure 与紧随其后的 Provider recovery interaction 必须按同一 Kernel batch
    顺序提交；`run.completed + turn.completed` batch 必须产生命名 rewind 恢复点。
    `SET_EXITED` 不得重写已经交给 Ink `<Static>` 的 streamed text block；最终回答尾段由
    `run.completed.output` 校准。
15. 条件等待在共享 CI runner 上默认使用 1.5 倍预算，本地保持 1 倍；可用
    `KITE_TUI_TEST_TIMEOUT_SCALE` 设为大于 0 的倍数覆盖，超过 3 时按 3 倍处理。增加预算不能
    替代输入回显、请求 baseline 和 modal/命令结果条件。失败诊断必须包含最近 mock request
    与终端输出尾部。
16. 默认 scenario 不得访问公网 provider。first-run 的 `/v1/models` 成功、延迟、错误和模型列表
    必须由本地 `MockModelServer` 固定；真实模型只允许进入独立 live runner。
17. 依赖宿主机原生能力的正向场景不得进入默认 PTY 门禁。sandbox、keyring、外部编辑器等
    场景应使用显式 opt-in smoke，并在运行时确认后端存在；默认 suite 只验证可人为固定的
    负向/降级路径。授权、policy 和 reducer 的完整分支必须由注入能力状态的确定性单元或
    Runtime 集成测试覆盖，不能让 GitHub runner 是否预装 `bwrap` 改变默认测试结果。
18. 远程 HTTP MCP 正文调用不得沿用旧的隐式外发前置条件。验证默认边界时使用生产 TUI
    组合根，并断言 `remoteMcpEgressPolicyV1=false` 产生零 `tools/call` 请求；验证认证恢复、
    失败隔离等需要成功外发的其他主题时，场景必须在同一个 Bun test 内显式开启该 flag，
    并通过 `remoteMcpEgressPermitResolver: 'allow-each-invocation'` 选择仅测试组合根。该组合根
    为每个 invocation 签发独立短时 permit，不得由全局 harness、环境变量或生产入口自动放行。
    scenario contract 会拒绝只配置 flag 或只注入 permit issuer 的半配置场景。自动重试与
    permit replay 属于 MCP policy/integration 层；不以重试为主题的 PTY 场景应配置 `retry: never`。
19. selector 型 slash command（`/model`、`/effort`、`/theme`、`/permissions`）输入空格后，
    共享输入 helper 必须等待 argument selector 的语义 frame，再发送第一个参数字符；随后仍需
    等待完整 query frame 才能按 Enter。场景不得用固定 sleep 修补 command selector 到 argument
    selector 的 React commit 竞争。argument focus 回执失败必须进入与字符交付相同的有界重试事务，
    先恢复动作前输入基线再重送完整命令，不能在重试边界外直接超时。
20. HTTP 429/5xx 属于模型 transient retry 场景。验证终态错误恢复时，mock 必须连续返回足够次数的
    transient failure 以耗尽 production bounded retry budget，并断言 retry UI、实际请求次数、终态错误
    与下一用户 turn 恢复；不得用一次 500 后的默认成功响应声称已经验证错误终态。只验证“不重试”时
    应使用 401 等明确非 transient 错误，或在模型单元测试中显式注入 `maxAttempts: 1`。

组件级 Ink 测试适合布局和 reducer 细节，但不能替代 PTY E2E 的真实终端覆盖。

## 运行入口

- `bun run test`：默认快速门禁，排除 PTY 与 spike，适合日常修改。
- `bun run test:tui:system`：按文件串行执行完整 PTY suite。
- `bun run test:tui:smoke:native`：
  在已安装 `sandbox-exec` 或 `bwrap` 的宿主机上显式验证 Full 模式真实 PTY 链路。
- `bun run test:all`：先运行默认门禁，再运行完整 PTY suite。
- 裸 `bun test` 会按 Bun 默认发现规则包含高成本 PTY 文件，不是仓库规范的全量入口。
