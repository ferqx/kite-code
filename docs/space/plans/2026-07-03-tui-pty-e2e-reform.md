# TUI E2E 测试体系改造：PTY 终端系统测试

> 状态：active（Phase 0-4 完成；Phase 3.5 全覆盖扩展完成；Phase 5 待推进）

> 关联计划：[2026-05-25-e2e-restructure.md](2026-05-25-e2e-restructure.md)（archived — 原 ink-testing-library 方案，本计划新增 PTY 测试层）

## 目标

将 TUI E2E 测试从旧 `ink-testing-library` harness 迁移到真实 PTY 系统测试：

1. **`tests/tui-system/`** — PTY 终端系统测试（`Bun.spawn({ terminal })`，真实 PTY + mock model server）
2. **`tests/tui-*.test.tsx`** — Ink 组件级单测，保留局部布局/输入覆盖，但不作为 E2E gate

PTY 层验证真实终端行为：`isTTY`、PTY 输入链路、原始模式输入、Ctrl+C 信号，以及 resize 调用后的存活性。Kitty 键盘协议、scrollback、真实 `SIGWINCH` 尺寸传播仍是待覆盖项。

## 实施阶段

### Phase 0：PTY 技术验证 ✅

**产出**：`tests/pty-spike/pty-verify.test.ts`（4 tests, 全部通过）

**结论**：Bun 1.3.14 的 `Bun.spawn({ terminal })` 在 Windows 上可用：
- `isTTY=true`（stdin/stdout/stderr）
- `terminal.write()` 双向通信正常
- `terminal.resize()` 调用不出错，但 Windows ConPTY 不转发 SIGWINCH
- 二进制数据通道正常（ESC 序列被 ConPTY 过滤除外）

### Phase 1：立即止血 ✅

**改动**：`tests/e2e/` 下现有测试的 swallowed assert 修复、弱断言强化、Ink 配置文档化。

**文件变更**：
- `tests/e2e/interaction.test.tsx` — 修复 swallowed error + 删除 `/model` warmup
- `tests/e2e/advanced.test.tsx` — 强化 6 个弱断言
- `tests/e2e/startup.test.tsx` — 强化 2 个弱断言
- `tests/e2e/session-switch.test.tsx` — 修复 2 个 swallowed assert
- `tests/e2e/render-tui.tsx` — 记录 ink-testing-library 配置限制
- `package.json` — 新增 `test:tui:integration` 脚本

### Phase 2：PTY Harness 建设 ✅

**产出**：`tests/tui-system/harness/`（4 个文件 + 2 个场景测试）

| 文件 | 职责 |
|------|------|
| `harness/pty-process.ts` | `spawnTui()` — `Bun.spawn({ terminal })` 子进程管理，暴露 `write()`/`output()`/`setRawMode()`/`resize()`/`kill()`/`waitForExit()` |
| `harness/fixtures.ts` | `createMockModelServer()` — 零依赖 OpenAI-compatible mock HTTP server（Bun.serve），支持 streaming SSE + non-streaming + 工具调用 + 错误注入 |
| `harness/terminal-screen.ts` | `stripAnsi()`/`screenContains()`/`waitForText()` — ANSI 剥离和文本断言工具 |
| `harness/test-workspace.ts` | `createTestWorkspace()` — 临时 HOME + workspace + checkpoint DB 隔离环境 |
| `scenarios/startup.test.ts` | 4 tests：TUI 启动、提示符、Header/Footer 渲染 |
| `scenarios/input.test.ts` | 3 tests：字符输入、空 Enter 拒绝、消息发送→响应 |

### Phase 3：PTY 场景迁移 ✅（核心完成）

**产出**：22 tests / 7 files（含 Phase 2 的 startup + input）

| 文件 | 测试数 | 覆盖场景 |
|------|--------|---------|
| `scenarios/startup.test.ts` | 4 | TUI 启动、Prompt、Header、Footer |
| `scenarios/input.test.ts` | 3 | 字符输入、空 Enter 拒绝、消息发送→响应 |
| `scenarios/resize.test.ts` | 3 | 初始尺寸渲染、单次 resize、多次 resize 存活 |
| `scenarios/interrupt.test.ts` | 3 | 单次 Ctrl+C 取消、空闲 Ctrl+C、双 Ctrl+C 退出 |
| `scenarios/approval.test.ts` | 3 | Warmup、空 Enter、工具审批块→deny→恢复 |
| `scenarios/ask-user.test.ts` | 3 | Warmup、空 Enter、ask_user 问题→Enter 确认→恢复 |
| `scenarios/multi-turn.test.ts` | 3 | Warmup、同一 PTY session 连续两条用户消息→两次模型响应 |

### Phase 3.5：全覆盖扩展 ✅（2026-07-03）

**产出**：34 new tests / 7 new files（累计 56 tests / 14 files）

| 文件 | 测试数 | 覆盖场景 |
|------|--------|---------|
| `scenarios/slash-commands.test.ts` | 13 | /help 打开/关闭、/clear 清屏、/theme 切换+去重、/plan 规划模式、Shift+Tab 退出规划、/effort 推理深度、/sessions 打开/关闭、/exit 退出 |
| `scenarios/session-lifecycle.test.ts` | 5 | 会话内发消息、/new 创建新会话（含重热链）、新会话内发消息→响应 |
| `scenarios/error-recovery.test.ts` | 4 | 模型 HTTP 500 错误→TUI 存活→提示符可见、错误后可继续发送新消息 |
| `scenarios/tool-approve.test.ts` | 3 | 工具审批 approve（a）→工具执行→agent 继续→第二次模型调用 |
| `scenarios/ask-user-esc.test.ts` | 3 | ask_user 问题→Esc 取消→TUI 恢复 idle |
| `scenarios/idle-summary.test.ts` | 3 | Agent 完成任务→返回 idle→提示符可见 |
| `scenarios/long-message.test.ts` | 3 | 146 字符长消息输入→TUI 不崩溃→提示符可见 |

**关键发现**：
- `waitForTextGone` 在累计 PTY 输出缓冲区中不可靠——一旦文本写入终端输出，便永久存在于缓冲区中
- `<Static>` 内容跨会话切换时保留在终端 scrollback 中——无法清除
- `generateSessionName` 会消耗 mock 响应队列中的额外槽位
- `ls` 被正确分类为只读命令（不触发审批）
- TUI 在 HTTP 500 模型错误后会自动重试

### Phase 4：旧测试清理与 PTY gate 切换 ✅

**改动**：旧 `tests/tui-integration/` e2e harness 退役，`test:e2e` 和 `test:tui:integration` 均指向新的 PTY system gate。

**文件变更**：
- 删除 `tests/tui-integration/` 旧 e2e harness 和用例
- 删除根部旧 `tests/tui-integration.test.ts` 可选真实模型集成测试
- `tests/helpers/freeze.ts` — 迁移旧 harness 中仍有价值的 freeze helper，供 `tests/freeze.test.ts` 使用
- `package.json` — `test:e2e`、`test:tui:integration`、`test:tui:system` 统一到 PTY system gate
- `CLAUDE.md` — 更新测试对应关系表
- `README.md` — 更新测试运行命令
- `docs/space/execution/active/tui-e2e-standards.md` — 改写为 PTY E2E 标准
- `docs/space/execution/active/tui-e2e-testing-limits.md` — 标记旧 harness 已退役

### Phase 5：跨平台 CI 集成 ⬜（待推进）

- 在 Linux 上验证 PTY 测试
- Windows ConPTY 适配
- CI matrix 构建
- 将 14 个文件整合到单文件 glob pattern（`bun test tests/tui-system/scenarios/*.test.ts`），不再逐文件列举

## 关键技术决策

### Mock Model Server

零依赖 OpenAI-compatible HTTP server（`Bun.serve` + random port）。TUI 子进程通过 `$KITE_CODE_HOME/.kite-code/kite-code.jsonc` 配置连接到 mock server。响应顺序消费，并记录 `/chat/completions` 请求体，供 PTY 测试断言真实用户消息进入模型请求。

**MockResponse 格式**：
```typescript
interface MockResponse {
  message?: {
    content: string;
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  };
  delay?: number;
  error?: string;
}
```

### 3-Test Warmup 模式（关键发现）

**每个需要模型调用的 PTY 测试必须遵循 3-test 模式**：

1. **Test 1 — Warmup typing**：输入几个字符（不按 Enter），确保 Ink 的 `useFocus`/`setRawMode` 初始化完成
2. **Test 2 — Empty Enter**：发送 `\r`（空输入），被 TUI 拒绝，但触发 `handleSubmit` → `textKeyRef++` → CtrlSafeTextInput remount → raw mode 最终稳定
3. **Test 3 — Real message**：发送实际消息 + Enter → agent 运行 → 模型调用成功

**不遵循此模式时**：模型调用被静默跳过（mock server 收到 0 请求）。根因与 Ink 的 `useFocus` hook 在首次渲染时的 `setRawMode` 初始化时序有关。

### PTY Raw Mode

- `setRawMode(true)` 由 harness 在 `beforeAll` 中调用（PTY master 侧）
- Ink 的 `useFocus` 也会调用 `setRawMode(true)`（child stdin 侧）
- 首次 raw mode 过渡需 ~300ms 延迟（首字符可能丢失）
- CtrlSafeTextInput remount 时（`textKeyRef` 变更）会触发 `useFocus` 的 `setRawMode(false)` → `setRawMode(true)` 循环，导致第一个字符再次丢失

## 遗留问题

### 1. 多消息同 session 失败（已澄清）

**原现象**：同一 PTY TUI session 中，第一条消息正常触发模型调用，第二条消息后模型调用次数不增加（mock server `callCount` 不变）。

**2026-07-03 复核结论**：`runAgent()` 已改为显式处理已完成 checkpoint 的新用户输入。同一 `threadId` 的非 resume 后续运行会先读取最新 checkpoint，再通过 `graph.updateState(...)` 追加新的 `HumanMessage`，并从更新后的 config 继续 stream。由于当前图的入口路由是 `START → cleanup → agent`，注入节点使用 `cleanup`；使用 `agent` 会让后续路由直接走 `agent → END`，无法再次调用模型。

新增 core 回归测试证明同一 `threadId` 连续两次 `runAgent()` 会触发两次模型调用，并且 checkpoint 保留完整消息历史：`Human(first) → AI(first) → Human(second) → AI(second)`。

**真实测试问题**：PTY harness 若把 `"message\r"` 一次性写入，Ink 可能把 `\r` 当作输入内容的一部分或与 stale value 时序交错；早期 warmup 还会把 `hello` 留在输入框中，使下一次 Enter 消费第一条 mock 响应。真实用户路径应逐字输入，然后单独发送 Enter，并在 warmup typing 后清空输入。

**落地回归**：
- `tests/runner.test.ts` — `runAgent multi-turn checkpoint continuation`，断言同一 checkpoint 保留 `Human → AI → Human → AI` 消息链
- `tests/tui-system/scenarios/multi-turn.test.ts` — 同一 PTY session 两条真实逐字输入消息均进入 mock server 请求体并触发模型响应

**影响范围**：连续多轮对话 PTY 测试已解锁；Session 切换测试仍需单独实现真实按键路径。

### 2. Kitty 键盘协议测试（待实现）

**阻塞原因**：需研究 Ink 的 `kittyKeyboard: { mode: 'enabled' }` 在 PTY 中的行为——当 Ink 向终端发送 `\x1b[>1u` 后，PTY driver 是否会将按键编码为 Kitty 序列？还是测试 harness 需要手动发送 Kitty 编码的字节？

**影响范围**：方向键导航测试、Kitty 特有功能测试。

### 3. Windows ConPTY resize 限制（已知平台限制）

**现象**：`terminal.resize()` 调用成功，但子进程看不到尺寸变化（`process.stdout.columns`/`rows` 不变，`SIGWINCH` 不触发）。已在 `tests/pty-spike/pty-verify.test.ts` test 3 中验证。

**当前处理**：resize 测试聚焦"TUI 在 resize 调用后不崩溃"，不验证实际尺寸变化。Linux/macOS 上 resize 应正常工作。

## 测试架构总览

```
tests/
├── tui-system/             # PTY 终端系统测试 (真实终端)
│   ├── harness/
│   │   ├── pty-process.ts       # PTY 子进程管理
│   │   ├── fixtures.ts          # Mock model HTTP server
│   │   ├── input-helpers.ts     # 逐字输入 + 请求体等待
│   │   ├── terminal-screen.ts   # ANSI 剥离 + 文本断言
│   │   └── test-workspace.ts    # 临时隔离环境
│   └── scenarios/
│       ├── startup.test.ts      # 启动烟雾 (4)
│       ├── input.test.ts        # 输入+消息 (3)
│       ├── resize.test.ts       # 终端 resize (3)
│       ├── interrupt.test.ts    # Ctrl+C 中断 (3)
│       ├── approval.test.ts     # 工具审批 deny (3)
│       ├── ask-user.test.ts     # ask_user Enter (3)
│       ├── multi-turn.test.ts   # 同 session 多轮消息 (3)
│       ├── slash-commands.test.ts   # 斜杠命令 13 项 (13)
│       ├── session-lifecycle.test.ts # 会话生命周期 /new (5)
│       ├── error-recovery.test.ts    # 模型错误恢复 (4)
│       ├── tool-approve.test.ts      # 审批通过 (A) 流程 (3)
│       ├── ask-user-esc.test.ts      # ask_user Esc 取消 (3)
│       ├── idle-summary.test.ts      # idle 恢复验证 (3)
│       └── long-message.test.ts      # 长消息输入 (3)
│
├── helpers/
│   └── freeze.ts               # ANSI/state freeze helper
│
└── pty-spike/
    └── pty-verify.test.ts      # Phase 0 PTY 能力验证 (4)
```

## 待实现场景

| 场景 | 优先级 | 阻塞因素 |
|------|--------|---------|
| **Session 切换（跨会话选择器）** | P1 | 需要 SessionSelector 键盘导航（真实按键路径），当前 `/new` 已覆盖 |
| Kitty 协议方向键 | P2 | PTY 中 Kitty 编码研究，传统 CSI 箭头键可能与 Kitty 模式不兼容 |
| 审批通过 + 工具执行结果渲染（shell output 显示） | P2 | 工具执行后的详细输出验证（当前仅验证 agent 继续 + 第二次模型调用） |
| Session 命名 | P3 | 需要 mock 处理，优先级低 |
| Slash 建议下拉框 / @ 文件搜索 | P3 | PTY 中 Ink overlay 渲染在终端输出中不易区分 |
| 光标导航 / 历史导航（Up/Down 箭头） | P3 | Kitty 协议兼容性问题；`CtrlSafeTextInput` remount 后 raw mode 时序 |
| Leader 键（Ctrl+X 序列） | P3 | 需要特定 leader key 绑定验证 |
| Tool parse error（malformed tool calls） | P3 | Mock server 不直接支持 `invalid_tool_calls`，需单元测试层覆盖 |

## 下一步

1. **Phase 5：跨平台 CI** — Linux/macOS 验证 + CI matrix
2. **Kitty 协议调研** — 确定 PTY 中按键编码方式
3. **Session 切换测试** — 基于真实逐字输入 + 单独 Enter 的 PTY helper 实现
4. **审批通过 + 工具执行 + agent 继续** — 在 PTY 层覆盖第二次模型调用链路

## 当前验证边界

- `bun run test:e2e`：PTY scenarios 全量 gate（当前 56 tests / 14 files，逐文件串行运行，避免多个 mock server 并发启动）。
- `bun run test:tui:system`：等价于 `bun run test:e2e`。
- `bun run test:tui:integration`：兼容旧脚本名，当前也指向 PTY system gate。
- `bun run test:tui:system:core`：Windows/ConPTY 默认 gate（不含 resize 场景）；resize 场景保留 survival 断言，不声明真实 SIGWINCH 覆盖。

## 参考文档

- `docs/space/execution/active/tui-e2e-testing-limits.md` — PTY 技术验证详细记录
- `docs/space/execution/active/tui-e2e-standards.md` — E2E 测试标准
- `docs/space/execution/active/e2e-test-restructure.md` — 原 E2E 重构方案
- `tests/pty-spike/pty-verify.test.ts` — Phase 0 PTY 能力验证
- [2026-05-25-e2e-restructure.md](2026-05-25-e2e-restructure.md) — 原 ink-testing-library 方案（archived）
