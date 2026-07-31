# TUI PTY E2E 能力与限制

状态：active

读取时机：评估 TUI 测试可覆盖性、处理平台差异、PTY flaky、终端 resize、跨进程会话恢复或选择组件测试与系统测试边界时。

验证：`bun run test:tui:system`、`bun test tests/tui-layout.test.tsx tests/tui-reducer.test.ts tests/tui-system/harness/pty-process.test.ts`。

## 当前能力

当前系统测试通过 Bun 启动真实终端子进程，并使用 OpenAI-compatible mock server 控制模型响应。它能够覆盖键盘输入、Ink 渲染、审批、ask-user、计划审核、session lifecycle、跨进程 Runtime Store 恢复、错误恢复和 resize。

## 已知限制

1. Windows 与 Unix PTY/ConPTY 的控制序列、信号和进程树行为不同；断言必须基于归一化 screen 文本。
2. Spinner、耗时和异步事件到达顺序不稳定，不应作为精确快照契约。
3. `<Static>` scrollback 已提交内容不会像普通 React 节点一样撤回；测试应验证最终语义而非旧块消失。
4. Screen parser 不能证明所有 ANSI 状态正确；DEC synchronized output、光标和 wrapping 仍需专门测试。
5. 外部编辑器、真实 MCP、真实模型和平台 sandbox 不属于默认 PTY suite，应使用边界测试或
   显式 opt-in 环境 smoke。平台能力的正向场景必须在测试入口确认真实后端存在；默认门禁只
   保留可固定能力状态的降级路径，不能按 runner 恰好安装的软件改变断言。
6. PTY 测试成本高，不应用来穷举纯 reducer、policy 或 schema 分支。
7. 完整 PTY suite 按文件隔离执行并设置单文件硬超时；因此失败会定位到具体
   scenario，且不会因一个遗留 TUI 子进程无限占用整套测试。
8. suite runner 的 RSS/active-resource/FD 趋势只覆盖协调进程和 scenario 边界资源回收；
   每个 TUI 子进程内部的长期缓慢泄漏仍需要 1C.7 bounded soak。Windows 无通用 `/proc/self/fd`
   时 FD 数显示为 unsupported，由 active-resource 与平台 smoke 补充。
9. PTY 原始输出仍是累积流，历史 prompt、卡片和回答会保留，因此“曾出现 `❯`”不能证明
   当前输入焦点可用。Harness 保留原始 PTY 字节并生成带类型的 byte checkpoint；跨 checkpoint
   的 UTF-8 code point 不归入动作后输出。每次 write/resize/raw-mode 动作都更新 checkpoint，条件
   等待只读取它之后的新输出，静默等待也默认要求至少出现一次新输出。输入提交还必须通过本次
   输入回显与本次 mock request baseline 建立确认；复杂 modal 仍需等待其独有状态。
10. `stripAnsi()` 仍不是完整终端模拟器；`outputSinceLastAction()` 证明的是动作后的新输出，不是
    当前物理屏幕像素。需要验证跨动作的 transcript 顺序时应显式 `markOutput()`，布局、光标和
    wrapping 则继续由 Ink 组件测试或专门终端测试负责。
11. Runtime Store 在 session 首次产生持久事件后才列出该 thread；因此 `/new` 的持久化身份断言
    应绑定新 session 的首个真实动作，而不是要求空 session 立即出现。该断言必须同时保留旧
    thread ID 并观察到一个新 ID，避免把同一 session 的累计 transcript 误判为切换成功。

## 分层选择

- 纯状态转换：单元/reducer 测试；
- Runtime 恢复与事件语义：Runtime/golden 测试；
- Ink 布局与换行：组件测试；
- 键盘到 Runtime 再到终端输出：PTY E2E。

同一 thread 的多轮继续由 Runtime Store 与 `runRuntimeAgent()` 恢复。
