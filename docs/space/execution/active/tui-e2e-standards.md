# 当前规则：TUI E2E 测试标准

状态：active
最后更新：2026-05-30（架构重构：reducer 拆分为 6 子 reducer + TuiBootstrap hooks 提取 + E2E spinner 检测 + sendMessage 逐字输入）

范围：

- `tests/e2e/` — 所有 TUI e2e 测试（3 文件，22 tests）
- `tests/e2e/render-tui.tsx` — TuiHarness（含审批流、浮层检测、状态查询方法）
- `tests/e2e/response-plan.ts` — ResponsePlan 响应分配器
- `tests/e2e/startup.test.tsx` — P0 核心回归防护（18 tests）
- `tests/e2e/interaction.test.tsx` — P1 关键用户工作流（~24 tests）
- `tests/e2e/advanced.test.tsx` — P2+P3 高级交互 + 集成场景（18 tests）
- `tests/tui-reducer.test.ts` — reducer 单元测试（100 tests）
- `src/app/tui/reducers/` — 6 子 reducer（handleEvent / ui / session / checkpoint / skill / agent）
- `src/app/tui/hooks/useMcpConnection.ts` — MCP 连接管理 hook
- `src/app/tui/hooks/useSkillsLoader.ts` — Skills 扫描 hook
- `src/app/tui/hooks/useRewindHandler.ts` — Rewind checkpoint + revert/fork hook
- `src/app/tui/hooks/useExternalEditor.ts` — 外部编辑器 hook
- `src/app/tui/index.tsx` — TuiBootstrap 组件
- `src/app/tui/session-manager.ts` — 多会话管理
- `src/app/tui/App.tsx` — 应用布局 + reducer 入口
- `src/app/tui/components/InputLine.tsx` — 输入行
- `src/app/tui/components/CtrlSafeTextInput.tsx` — 文本输入

读取时机：

- 新增或修改 TUI e2e 测试
- 修改 TuiBootstrap、SessionManager、InputLine、App、Sidebar 等 TUI 核心组件
- 修改 handleInput、runTask、dispatchSessionLoad 等关键回调
- 新增 useEffect 或 useCallback 依赖
- 修改终端键盘协议相关代码（Kitty protocol）

验证：

- `bun test tests/e2e/startup.test.tsx` — P0 核心回归（18 tests）
- `bun test tests/e2e/interaction.test.tsx` — P1 交互工作流（24 tests）
- `bun test tests/e2e/advanced.test.tsx` — P2+P3 高级场景（18 tests）
- `bun test tests/tui-reducer.test.ts` — Reducer 单元测试（108 tests）
- **⚠️ e2e 测试文件必须逐个运行**（Bun worker 线程间 render lock 不同步，并行会导致 Ink 冲突）
- **全量快速验证**：`bun test tests/e2e/startup.test.tsx && bun test tests/e2e/interaction.test.tsx && bun test tests/e2e/advanced.test.tsx`

## 规则

### 1. TUI e2e 测试必须覆盖真实的 TuiBootstrap 渲染路径

所有 e2e 测试使用 `createTui()` helper（`tests/e2e/render-tui.tsx`）渲染真实 `TuiBootstrap` 组件。

- **仅 Mock LLM**：只注入 `StreamingMockModel` 替代真实 LLM 调用。其他所有层（handleInput → runTask → SessionManager → SessionRuntime → runAgent → reducer → renderer）均为真实生产路径，绝不允许 mock。
- 不再使用任何简化根组件（`TuiMockRoot` / `TuiRealAgentRoot` 已删除）
- 测试使用 `beforeAll`/`afterAll` 管理单个共享 TUI 实例（Ink 在同一进程中只能被 render 一次，需使用 render lock）

### 2. 使用 `stdin.write` 模拟真实用户输入

标准按键序列（已验证在 `ink-testing-library` 中正确解析）：

```typescript
tui.stdin.write("\t");        // Tab
tui.stdin.write("\r");        // Enter
tui.stdin.write("\x1b");      // Escape
tui.stdin.write("\x18");      // Ctrl+X
tui.stdin.write("\x1b[A");    // UpArrow（CSI 序列，已验证可用）
tui.stdin.write("\x1b[B");    // DownArrow
tui.stdin.write("n");         // 普通字符
```

或使用便捷方法：
```typescript
await tui.sendMessage("hello");         // 逐字写入 + Enter — CtrlSafeTextInput 需要逐字符处理
await tui.waitForText("expected", 5000); // 等待文本出现
await tui.waitForIdle(15000);           // 等待 Agent 完成
```

**`sendMessage` 逐字输入机制**：`CtrlSafeTextInput` 通过 `useInput` 逐字符处理输入事件，不支持一次性写入整串文本。`sendMessage` 内部实现为：warm-up tick(10ms) → 逐字 `stdin.write(ch)` + tick(2ms) → tick(80ms) → `stdin.write("\r")` + tick(150ms)。对于 "hello"（5 字符），总耗时约 10 + 5×2 + 80 + 150 ≈ 250ms。测试中如需要 Ctrl+C 中断 mock 模型，响应延迟必须大于此值。

**Agent 状态检测**：Header 猫脸（`( ^ ^ )` / `( = = )`）渲染在 `<Static>` 中，**不会随状态变化更新**。状态检测改用 StatusBar 的 spinner 字符（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`）：
- `isRunning()` — `hasRunningSpinner(getOutput())`：检查 spinner 字符是否存在
- `waitForRunning()` — 轮询 `hasRunningSpinner(getOutput())`
- `waitForIdle()` — 轮询 `!hasRunningSpinner(out) && !out.includes("Thinking")`
- `isIdle()` — `!hasRunningSpinner(getOutput())`

### 3. 测试环境必须提供合法的 AgentConfig

`createTui` 自动创建临时 HOME 目录并写入合法配置文件。通过 `process.env.OPENPX_HOME` 隔离 checkpoint 数据库。

测试辅助环境变量：
- `process.env.HOME` / `process.env.OPENPX_HOME` — 临时 HOME 目录
- `process.stdout.columns` — 终端宽度（默认 120）
- `process.stdout.rows` — 终端高度（默认 40，用于 Sidebar 虚拟窗口计算）

### 4. 模型响应按顺序消费

`StreamingMockModel._callCount` 通过共享 `{ count: number }` 对象在 `bindTools` 克隆之间传递。每个 `sendMessage` 调用消耗一个响应（错误和工具调用可能消耗多个）。响应数组按测试执行顺序预分配。

### 5. 关键测试覆盖

| 测试点 | 检测的回归 |
|--------|-----------|
| 渲染不崩溃（输出长度 > 10 字符） | TDZ ReferenceError, 导入失败 |
| Auto-create session 显示在 Sidebar | SessionManager 未创建或 getSnapshot 为空 |
| stdin 输入 → 用户消息块出现在输出中 | handleInput 未被调用 |
| 发送消息 → Agent 响应文本出现 | runTask → runAgent 链路完整 |
| 发送消息 → 返回 idle 状态 | Agent 执行完毕后状态正确恢复 |
| 多轮对话 | 多次 runTask 不冲突，_callCount 不重置 |
| 模型错误 → TUI 不挂死 | 错误处理链路完整 |
| 工具调用 | 工具卡片渲染正确 |
| 创建新会话 → Sidebar 计数增加 | NEW_SESSION 链路完整 |
| **Tab → 方向键导航 → Enter 切换会话 → 消息历史加载** | SWITCH_SESSION + SET_SESSIONS merge + activeSessionId 同步 + 键盘事件解析 |

### 6. Bug 修复必须通过 e2e 快照验证（强制性）

任何 TUI 功能修复或新增功能，如果在修复过程中发现 e2e 测试用例没有覆盖，必须在修复的同时补充 e2e 测试。**不允许**认为"e2e 测试跑完了但功能却异常"的情况出现。

**执行流程**：
1. 复现 Bug → 编写最小 e2e 测试来捕获 Bug（测试必须先失败）
2. 通过 `console.log` 捕获 TUI 快照，逐帧分析渲染输出 —— TUI 快照是唯一的真相来源
3. 修复代码 → e2e 测试变绿
4. 运行全量 e2e 测试 → 确认无回归
5. 清理调试日志，保留可维护的测试断言

**快照诊断模式**：当不确定代码行为时，在 e2e 测试中打印 `tui.getOutput()` 的完整内容（或关键部分），分析 Sidebar 的 `●`/`○` 标记、消息区域内容、输入行状态。快照能揭示代码逻辑无法推断的渲染问题。

### 7. 键盘事件必须通过探针测试验证（Kitty 协议专项）

Ink 的键盘事件解析依赖终端协议配置。任何涉及特殊按键（方向键、Tab、Ctrl 组合键等）的功能，必须确认按键序列在测试环境中能正确解析。

**已验证的按键序列**：

| 按键 | 标准序列 | Kitty CSI-u | 测试验证 |
|------|---------|-------------|---------|
| Tab | `\t` | `\x1b[9u` | ✅ 两者均解析为 `key.tab` |
| Enter | `\r` | `\x1b[13u` | ✅ 两者均解析为 `key.return` |
| UpArrow | `\x1b[A` | `\x1b[1u` | ✅ 标准序列可用，Kitty 需 `kittyKeyboard` 选项 |
| DownArrow | `\x1b[B` | `\x1b[2u` | ✅ 标准序列可用，Kitty 需 `kittyKeyboard` 选项 |
| Escape | `\x1b` | — | ✅ |

**关键踩坑**：测试环境中使用标准 CSI 序列（`\x1b[A`），不要使用 Kitty CSI-u 格式（`\x1b[1u`）。标准 CSI 序列在所有环境下均可正确解析。

### 8. 文件对应关系

| 文件 | 范围 |
|------|------|
| `tests/e2e/render-tui.tsx` | createTui helper，渲染真实 TuiBootstrap + StreamingMockModel，含审批流/浮层/状态检测方法（spinner 检测） |
| `tests/e2e/response-plan.ts` | ResponsePlan 响应分配器 + text/modelError/toolCall 快捷辅助 |
| `tests/e2e/startup.test.tsx` | P0 核心回归防护（18 tests）— 启动/消息/多轮/工具/错误/会话切换/中断恢复 |
| `tests/e2e/interaction.test.tsx` | P1 关键用户工作流（~24 tests）— 审批流/提问/Slash 命令/建议下拉/文件搜索 |
| `tests/e2e/advanced.test.tsx` | P2+P3 高级交互与集成（18 tests）— 输入历史/快捷键/集成场景 |
| `tests/mock-model.ts` | StreamingMockModel（响应共享计数器 + public callCount getter + 可配置 delay） |
| `tests/tui-reducer.test.ts` | Reducer 单元测试（100 tests）— 覆盖 42 种 Action |
| `src/app/tui/reducers/` | 6 子 reducer：handleEvent（19 种事件）/ ui（面板显隐）/ session（会话管理）/ checkpoint（revert/fork）/ skill / agent |

**快捷键变更**（2026-05-26 快捷键精简）：以下 Leader Key / Global Shortcut 已移除，改用斜杠命令替代。E2E 测试已同步更新：

| 已移除 | 替代斜杠命令 |
|--------|------------|
| Ctrl+X m (model) | `/model` |
| Ctrl+X l (sessions) | `/sessions` |
| Ctrl+X c (compact) | `/compact` |
| Ctrl+R (auth toggle) | `/auth` |
| Ctrl+L (clear) | `/clear` |
| Ctrl+H (help) | `/help` |

**已知限制**：Ctrl+C abort 后 `CtrlSafeTextInput` 需要额外时间恢复，可能导致 recovery 测试不稳定。debug 验证手动字符输入 + 长延迟后可恢复，但集成测试中时序敏感。

## 关键发现与踩坑记录

### P0：agentLoopActive 时序错误（2026-05-25）
`TuiBootstrap.runTask` 在调用 `rt.runTask()` 之前设置了 `rt.agentLoopActive = true`，而 `SessionRuntime.runTask` 的守卫条件 `if (this.agentLoopActive) return;` 导致 Agent 从未执行。用户消息显示但 Agent 不响应。仅在真实 TuiBootstrap 渲染测试中被发现。

### P0：SET_SESSIONS 覆盖 blocks + activeSessionId 未同步（2026-05-25）
`SessionManager.getSnapshot()` 总是返回 `blocks: []`，而 `SET_SESSIONS` reducer 直接替换整个 sessions 数组，导致 `NEW_SESSION` 和 `SWITCH_SESSION` reducer 保存的 blocks 被覆盖为空。同时 `SET_SESSIONS` 未同步 `activeSessionId`，导致 `NEW_SESSION` 无法匹配活跃会话保存 blocks。

修复：
1. `SET_SESSIONS` 改为 merge：保留已有 `blocks`/`status`，只更新运行时信息（name, running, pendingInterrupt）
2. `SET_SESSIONS` 同步 `activeSessionId`：从传入 snapshot 的 `active` 字段提取活跃会话 ID

此 bug 导致切换会话后消息历史消失——仅通过 TUI 快照诊断发现。

### P0：Kitty 键盘协议导致方向键解析错误（2026-05-25）
TUI 手动调用 `enableKittyKeyboardProtocol()` 发送 `\x1b[>1u` 到终端启用 Kitty 协议，但 `render()` 调用未传递 `kittyKeyboard` 选项给 Ink。导致终端发送 Kitty CSI-u 格式的方向键（`\x1b[1u` = Up、`\x1b[2u` = Down），但 Ink 的 parser 未启用 Kitty 模式，将方向键**错误解析为 Enter 键**。

**错误链路**：
```
用户按 ↑ 键 → 终端发送 \x1b[1u → Ink 错误解析为 key.return
→ Sidebar useInput 执行 onSwitch(selected) 而非 onNavigate("up")
→ 选中当前高亮会话（same-session guard 触发）→ 无任何效果
```

**修复**：
1. 删除手动 `enableKittyKeyboardProtocol()` / `disableKittyKeyboardProtocol()` 函数
2. 在 `render()` 调用中传递 `kittyKeyboard: { mode: 'enabled' }`，由 Ink 统一管理协议生命周期
3. 删除 `process.on('SIGINT/SIGTERM/exit', disableKittyKeyboardProtocol)` — Ink 自动处理

**教训**：终端键盘协议的启用和解析必须由同一个组件（Ink）统一管理。外部手动发送协议命令会导致 parser 状态不一致。任何涉及键盘协议变更都必须通过探针测试（`tests/e2e/kitty-probe.test.tsx` 模式）验证关键按键的解析结果。

### Sidebar 名称换行问题（2026-05-25）
Sidebar 会话名超过可用宽度时，Ink 默认 `wrap="wrap"` 导致换行。修复：对所有 Sidebar 文本元素设置 `wrap="truncate"`，由 Ink 在 Box 边界处截断。`maxNameLen` 字符截断不足以处理 CJK 字符（2 列宽）和 emoji（变宽），必须依赖渲染层的截断。
