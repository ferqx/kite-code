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
5. 外部编辑器、真实 MCP、真实模型和平台 sandbox 不属于默认 PTY suite，应使用边界测试或
   显式 opt-in 环境 smoke。平台能力的正向场景必须在测试入口确认真实后端存在；默认门禁只
   保留可固定能力状态的降级路径，不能按 runner 恰好安装的软件改变断言。
6. PTY 测试成本高，不应用来穷举纯 reducer、policy 或 schema 分支。
7. 完整 PTY suite 按文件隔离执行并设置单文件硬超时；因此失败会定位到具体
   scenario，且不会因一个遗留 TUI 子进程无限占用整套测试。
8. suite runner 的 RSS/active-resource/FD 趋势只覆盖协调进程和 scenario 边界资源回收；
   每个 TUI 子进程内部的长期缓慢泄漏仍需要 1C.7 bounded soak。Windows 无通用 `/proc/self/fd`
   时 FD 数显示为 unsupported，由 active-resource 与平台 smoke 补充。
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

## 分层选择

- 纯状态转换：单元/reducer 测试；
- Runtime 恢复与事件语义：Runtime/golden 测试；
- Ink 布局与换行：组件测试；
- 键盘到 Runtime 再到终端输出：PTY E2E。

同一 thread 的多轮继续由 Runtime Store 与 `runRuntimeAgent()` 恢复。
