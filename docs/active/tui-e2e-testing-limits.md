# TUI PTY E2E 能力与限制

状态：active

读取时机：评估 TUI 测试可覆盖性、处理平台差异、PTY flaky、终端 resize、跨进程会话恢复或选择组件测试与系统测试边界时。

验证：`bun run test:tui:system`、`bun test tests/tui-layout.test.tsx tests/tui-reducer.test.ts tests/tui-system/harness/pty-process.test.ts tests/tui-system/harness/terminal-screen.test.ts`。

## 当前能力

当前系统测试通过 Bun 启动真实终端子进程，并使用 OpenAI-compatible mock server 控制模型响应。
Harness 同时保留原始 PTY transcript，并通过 `@xterm/headless` 维护真实 VT viewport、scrollback 与
逐 chunk 解析后的有界 screen frame 历史。action delta 只发布已完成 VT 解析的字节范围，PTY
退出或 cleanup 会等待解析队列并释放 headless terminal。它能够覆盖键盘输入、Ink 渲染、审批、ask-user、计划审核、
session lifecycle、跨进程 Runtime Store 恢复、错误恢复、streaming 瞬态和 resize。

## 已知限制

1. Windows 与 Unix PTY/ConPTY 的控制序列、信号和进程树行为不同；断言必须基于归一化 screen 文本。
2. Spinner、耗时和异步事件到达顺序不稳定，不应作为精确快照契约。
3. `<Static>` 已写入物理终端的内容不会像普通 React 节点一样撤回；`/clear` 的 reducer 清理由
   `tests/tui-reducer.test.ts` 覆盖，PTY 场景只验证命令路由与恢复，不能声称已经擦除终端 scrollback。
4. Headless VT parser 能处理当前 Ink 使用的 erase、光标和 wrapping 序列，但不能证明所有终端实现
   一致；DEC synchronized output、ConPTY 差异和宿主终端字体宽度仍需专门平台测试。
5. 外部编辑器、公网 MCP、真实模型和平台 sandbox 不属于默认 PTY suite，应使用边界测试或
   显式 opt-in 环境 smoke。默认 suite 可以连接进程内本地 MCP fixture 走真实 HTTP/stdio
   协议；涉及 HTTP 正文调用时必须显式注入每 invocation 的测试 permit，生产组合根仍保持
   no-egress。平台能力的正向场景必须在测试入口确认真实后端存在；默认门禁只保留可固定能力
   状态的降级路径，不能按 runner 恰好安装的软件改变断言。
6. PTY 测试成本高，不应用来穷举纯 reducer、policy 或 schema 分支。
7. 完整 PTY suite 按文件隔离执行并设置单文件硬超时；因此失败会定位到具体
   scenario，且不会因一个遗留 TUI 子进程无限占用整套测试。
8. suite runner 的 RSS/active-resource/FD 趋势只覆盖协调进程和 scenario 边界资源回收；
   fault-soak preload 可以采集各 Bun test child 的 before/after，但多个独立 test/TUI 子进程的
   样本不能替代同一 TUI 进程 repeated mount/unmount 证据。该指标缺口必须让正式 1C.7
   qualification 返回 `inconclusive`，不得用父 runner 趋势宣称 child 无泄漏。Windows 无通用
   `/proc/self/fd` 时 FD 和 owned descendant PID 显示为 unsupported。
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
    Harness 的持久化探针只能通过 readonly SQLite 查询观察已经存在的 schema；在轮询中调用
    `createRuntimeStore()` 会重复执行 journal/schema 写入并干扰被测 writer，尤其会在共享 CI runner
    上把真实落盘延迟误报为 TUI 失败。命令回放场景还应查询精确 `user.command_invoked.command` 并
    使用该 event 所属 thread，不能用 JSON substring 或 session recency 代替持久化身份。
13. 有状态 journey 在一个 Bun test 内按 step 执行；首个失败会报告 step 名称并停止后续依赖步骤。
    每个 step 有局部超时，journey 另有早于 Bun test 和单文件硬超时的总 deadline；总预算耗尽时
    当前 step 会收到具名失败，因此局部超时之和不是文件可用总时长。测试报告中的 pass 数表示独立
    测试边界，不表示 journey 内动作数量。需要独立筛选、重跑或并行的行为必须使用新 fixture 写成
    独立 test，不能仅为增加报告粒度拆分共享状态。
14. 测试 permit issuer 位于 `tests/tui-system/fixtures/`，只能由单个 `spawnTui()` 调用显式选择。
    它不是生产授权实现，也不通过可被 workspace `.env` 伪造的环境开关启用；默认拒绝与允许
    外发必须写成不同、隔离的 test 语义。
15. `/model`、`/effort`、`/theme`、`/permissions` 的命令前缀和参数属于两个 React 输入阶段。
    PTY helper 输入分隔空格后必须先观察 argument selector 的语义 frame，再发送首个参数字符；
    只在命令行看到空格或累计 transcript 中出现字符不能证明 selector handler 已完成 focus transfer。
    focus-transfer 回执超时与最终 query 回执超时使用同一完整输入重试和基线恢复语义。
16. Mock server 的 response queue 会在每个 provider attempt 消耗一个响应。HTTP 429/5xx 已走
    production bounded retry；因此单个 transient error 后跟成功响应验证的是 reconnect，不是终态错误。
    终态 error-recovery 场景必须耗尽完整 retry budget，并用请求计数证明没有提前终止或无限重试。

## 分层选择

- 纯状态转换：单元/reducer 测试；
- Runtime 恢复与事件语义：Runtime/golden 测试；
- Ink 布局与换行：组件测试；
- 键盘到 Runtime 再到终端输出：PTY E2E。

同一 thread 的多轮继续由 Runtime Store 与 `runRuntimeAgent()` 恢复。
