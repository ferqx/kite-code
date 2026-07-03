# TUI E2E 测试体系改造：PTY 终端系统测试

> 状态：active（Phase 0-4 完成，Phase 5 待推进）

> 关联计划：[2026-05-25-e2e-restructure.md](2026-05-25-e2e-restructure.md)（archived — 原 ink-testing-library 方案，本计划新增 PTY 测试层）

## 目标

将 TUI E2E 测试从单一的 `ink-testing-library` 层拆分为两层：

1. **`tests/tui-integration/`** — Ink 组件集成测试（ink-testing-library，虚拟 stdin）
2. **`tests/tui-system/`** — PTY 终端系统测试（`Bun.spawn({ terminal })`，真实 PTY + mock model server）

PTY 层验证真实终端行为：`isTTY`、`SIGWINCH`、Kitty 键盘协议、原始模式输入、Ctrl+C 信号。

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

**产出**：19 tests / 6 files（含 Phase 2 的 startup + input）

| 文件 | 测试数 | 覆盖场景 |
|------|--------|---------|
| `scenarios/startup.test.ts` | 4 | TUI 启动、Prompt、Header、Footer |
| `scenarios/input.test.ts` | 3 | 字符输入、空 Enter 拒绝、消息发送→响应 |
| `scenarios/resize.test.ts` | 3 | 初始尺寸渲染、单次 resize、多次 resize 存活 |
| `scenarios/interrupt.test.ts` | 3 | 单次 Ctrl+C 取消、空闲 Ctrl+C、双 Ctrl+C 退出 |
| `scenarios/approval.test.ts` | 3 | Warmup、空 Enter、工具审批块→deny→恢复 |
| `scenarios/ask-user.test.ts` | 3 | Warmup、空 Enter、ask_user 问题→Enter 确认→恢复 |

### Phase 4：旧测试清理与分层 ✅

**改动**：`tests/e2e/` → `tests/tui-integration/`（目录重命名 + 全部引用更新）

**文件变更**：
- `tests/e2e/` → `tests/tui-integration/`（目录重命名）
- `package.json` — 保留 `test:e2e` 别名，新增 `test:tui:integration`
- `CLAUDE.md` — 更新测试对应关系表
- `README.md` — 更新测试运行命令
- `docs/space/execution/active/tui-e2e-standards.md` — 更新 17 处路径引用
- `docs/space/execution/active/e2e-test-restructure.md` — 更新 8 处路径引用
- 其他 4 个文档引用更新

### Phase 5：跨平台 CI 集成 ⬜（待推进）

- 在 Linux 上验证 PTY 测试
- Windows ConPTY 适配
- CI matrix 构建

## 关键技术决策

### Mock Model Server

零依赖 OpenAI-compatible HTTP server（`Bun.serve` + random port）。TUI 子进程通过 `$KITE_CODE_HOME/.kite-code/kite-code.jsonc` 配置连接到 mock server。响应顺序消费，支持 `% length` wrap-around。

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

### 1. 多消息同 session 失败（阻塞）

**现象**：同一 PTY TUI session 中，第一条消息正常触发模型调用，第二条消息后模型调用次数不增加（mock server `callCount` 不变）。

**根因定位**：LangGraph 1.4.7 在已完成 thread（checkpoint 有 END 标记）上再次调用 `graph.stream(initialState, config)` 时短路返回空流。`for await (const _ of generator)` 迭代 0 次，`SET_EXITED` 立即派发，模型从未被调用。

**尝试过的修复**（全部失败）：
1. `Command({ update: initialState })` — graph.stream 返回 0 chunks
2. `Command({ update: { messages } })` — 同上
3. `graph.updateState(config, values)` + `graph.stream(null, config)` — 不触发执行
4. `graph.updateState(config, values)` + `graph.stream(null, updatedConfig)` — 不触发执行

**当前 workaround**：每个需要模型调用的测试使用独立 describe block + 全新 TUI 实例，避免在同一 session 中发送第二条消息。

**待尝试方向**：
- 每次 `runTask` 使用新 `thread_id`（需在 session-manager 层面管理 thread_id 继承）
- 升级 LangGraph 版本（检查是否有相关修复）
- 使用 `graph.invoke()` 替代 `graph.stream()` 处理已完成 thread
- 在 checkpointer 层面清理 END 标记

**影响范围**：Session 切换测试、连续多轮对话测试。

### 2. Kitty 键盘协议测试（待实现）

**阻塞原因**：需研究 Ink 的 `kittyKeyboard: { mode: 'enabled' }` 在 PTY 中的行为——当 Ink 向终端发送 `\x1b[>1u` 后，PTY driver 是否会将按键编码为 Kitty 序列？还是测试 harness 需要手动发送 Kitty 编码的字节？

**影响范围**：方向键导航测试、Kitty 特有功能测试。

### 3. Windows ConPTY resize 限制（已知平台限制）

**现象**：`terminal.resize()` 调用成功，但子进程看不到尺寸变化（`process.stdout.columns`/`rows` 不变，`SIGWINCH` 不触发）。已在 `tests/pty-spike/pty-verify.test.ts` test 3 中验证。

**当前处理**：resize 测试聚焦"TUI 在 resize 调用后不崩溃"，不验证实际尺寸变化。Linux/macOS 上 resize 应正常工作。

## 测试架构总览

```
tests/
├── tui-integration/        # Ink 组件集成测试 (ink-testing-library)
│   ├── render-tui.tsx      # Harness
│   ├── startup.test.tsx    # P0 启动
│   ├── interaction.test.tsx # P1 交互
│   ├── advanced.test.tsx   # P2+P3 高级
│   ├── cursor.test.tsx     # 光标
│   ├── session-switch.test.tsx # 会话切换
│   └── tool-parse-error.test.tsx # 工具解析错误
│
├── tui-system/             # PTY 终端系统测试 (真实终端)
│   ├── harness/
│   │   ├── pty-process.ts       # PTY 子进程管理
│   │   ├── fixtures.ts          # Mock model HTTP server
│   │   ├── terminal-screen.ts   # ANSI 剥离 + 文本断言
│   │   └── test-workspace.ts    # 临时隔离环境
│   └── scenarios/
│       ├── startup.test.ts      # 启动烟雾 (4)
│       ├── input.test.ts        # 输入+消息 (3)
│       ├── resize.test.ts       # 终端 resize (3)
│       ├── interrupt.test.ts    # Ctrl+C 中断 (3)
│       ├── approval.test.ts     # 工具审批 (3)
│       └── ask-user.test.ts     # ask_user 提问 (3)
│
└── pty-spike/
    └── pty-verify.test.ts      # Phase 0 PTY 能力验证 (4)
```

## 待实现场景（Phase 3 遗留）

| 场景 | 优先级 | 阻塞因素 |
|------|--------|---------|
| Session 切换 | P1 | 多消息同 session 失败 |
| 连续多轮对话 | P1 | 同上 |
| Kitty 协议方向键 | P2 | PTY 中 Kitty 编码研究 |
| 审批通过 (A 键) + 工具执行 + agent 继续 | P2 | 同上（agent 继续需第二次模型调用） |
| Session 命名 | P3 | 需要 mock 处理，优先级低 |
| Error recovery | P3 | 需要 mock error 注入 |

## 下一步

1. **修复多消息阻塞**（最高优先级）— 需要 LangGraph 层面的改动或 thread_id 管理改造
2. **Phase 5：跨平台 CI** — Linux/macOS 验证 + CI matrix
3. **Kitty 协议调研** — 确定 PTY 中按键编码方式
4. **Session 切换 + 多轮对话测试** — 依赖 #1 修复

## 参考文档

- `docs/space/execution/active/tui-e2e-testing-limits.md` — PTY 技术验证详细记录
- `docs/space/execution/active/tui-e2e-standards.md` — E2E 测试标准
- `docs/space/execution/active/e2e-test-restructure.md` — 原 E2E 重构方案
- `tests/pty-spike/pty-verify.test.ts` — Phase 0 PTY 能力验证
- [2026-05-25-e2e-restructure.md](2026-05-25-e2e-restructure.md) — 原 ink-testing-library 方案（archived）
