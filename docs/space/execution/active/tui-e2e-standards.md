# 当前规则：TUI E2E/PTTY 测试标准

状态：active
读取时机：编写或修改 TUI E2E/PTTY 测试、调整 mock server 行为、新增真实终端场景。
验证：`bun run test:e2e`
最后更新：2026-07-03（旧 `tests/tui-integration/` e2e harness 已退役，PTY system 为默认 gate）

## 范围

- `tests/tui-system/scenarios/` — TUI E2E/PTTY 系统测试（真实 PTY + mock model server，22 tests）
- `tests/tui-system/harness/` — PTY 子进程、mock server、输入 helper、ANSI 文本断言、临时 HOME/workspace
- `tests/pty-spike/pty-verify.test.ts` — Bun PTY 能力验证
- `tests/tui-*.test.tsx` — Ink 组件级单测；这些不是 E2E gate，但仍可覆盖布局和局部输入行为
- `src/app/tui/index.tsx`、`src/app/tui/App.tsx`、`src/app/tui/components/InputLine.tsx`、`src/app/tui/components/CtrlSafeTextInput.tsx`
- `src/app/tui/session-manager.ts`、`src/core/runner.ts`、`src/core/harness/graph.ts`

## 验证命令

- `bun run test:e2e` — TUI E2E 默认入口，等价于 `bun run test:tui:system`
- `bun run test:tui:system` — PTY scenarios 全量 gate，逐文件串行运行
- `bun run test:tui:system:core` — PTY 核心场景，适合作为 Windows/ConPTY 默认 gate，排除 resize
- `bun test tests/runner.test.ts` — core runner 多轮 checkpoint continuation 回归
- `bun test tests/tui-reducer.test.ts` — reducer 单元测试

## 核心原则

1. **E2E 必须跑真实 TUI 进程。** 新的 TUI E2E 用 `Bun.spawn({ terminal })` 启动 `src/app/tui/index.tsx`，通过 PTY master 写入字节并读取真实终端输出。
2. **只 mock 模型服务，不 mock TUI 或 LangGraph。** 测试通过临时 `$KITE_CODE_HOME/.kite-code/kite-code.jsonc` 指向 OpenAI-compatible mock server；生产路径仍包含配置加载、HTTP 请求、`runAgent()`、checkpoint、reducer 和 Ink 渲染。
3. **真实输入必须逐字发送。** 不要把 `"message\r"` 一次性写入 PTY。使用 `typeText()` 逐字符输入，再单独写入 Enter。
4. **需要模型调用的场景遵循 warmup 模式。** 先 typing warmup 并清空输入，再验证空 Enter 不提交，最后发送真实消息。
5. **断言模型请求体，而不只断言屏幕文本。** 对消息提交类场景，使用 mock server 记录的 request body 确认用户消息确实进入 `/v1/chat/completions`。
6. **平台限制要写进断言边界。** Resize 场景只断言 TUI 在 resize 后仍存活；Windows ConPTY 不保证 `SIGWINCH` 或 child rows/columns 更新。

## PTY Harness 文件对应关系

| 文件 | 范围 |
|------|------|
| `tests/tui-system/harness/pty-process.ts` | `spawnTui()`、PTY 写入/读取、raw mode、resize、kill/exit |
| `tests/tui-system/harness/fixtures.ts` | OpenAI-compatible mock server、响应队列、request body 记录 |
| `tests/tui-system/harness/input-helpers.ts` | `typeText()`、`clearInput()`、`waitForRequestMessage()` |
| `tests/tui-system/harness/terminal-screen.ts` | ANSI 剥离、文本出现/消失轮询 |
| `tests/tui-system/harness/test-workspace.ts` | 临时 HOME、workspace、checkpoint DB、mock config 写入 |

## 当前 E2E 场景

| 场景 | 覆盖 |
|------|------|
| `startup.test.ts` | TUI 启动、Prompt、Header/Footer、非空输出 |
| `input.test.ts` | 逐字输入、空 Enter 拒绝、消息发送到模型并渲染响应 |
| `resize.test.ts` | 初始尺寸、单次 resize、多次 resize 后存活 |
| `interrupt.test.ts` | 单次 Ctrl+C 取消、idle Ctrl+C、双 Ctrl+C 退出 |
| `approval.test.ts` | 工具调用触发审批块、deny 后恢复 |
| `ask-user.test.ts` | `ask_user` 问题渲染、Enter 默认确认后恢复 |
| `multi-turn.test.ts` | 同一 PTY session 连续两条用户消息触发两次模型请求 |

## 新增或修改 E2E 的流程

1. 在 `tests/tui-system/scenarios/` 添加或修改场景。
2. 若场景会触发模型调用，使用 `createMockModelServer()` 并断言 request body。
3. 使用 `typeText()` + 单独 Enter，避免一次性写入整条消息。
4. 先运行目标文件，再运行 `bun run test:tui:system`。
5. 若改动影响 `runAgent()` checkpoint 或多轮语义，同时运行 `bun test tests/runner.test.ts`。

## 已知边界

- Kitty 键盘协议方向键在 PTY 中的编码方式仍待专项验证。
- Session selector 的真实方向键导航尚未迁移到 PTY 层。
- 工具 approval approve + 工具执行 + agent 继续链路仍待补充 PTY 场景。
- Ink 组件级单测仍使用 `ink-testing-library`，但它们不再承担 E2E gate。
