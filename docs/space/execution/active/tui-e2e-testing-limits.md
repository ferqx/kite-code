# TUI E2E 测试方案与限制

状态：active
范围：`tests/tui-system/`、`tests/tui-*.test.tsx`、`tests/mock-model.ts`
读取时机：编写 TUI E2E 测试、调试 TextInput/键盘交互测试、考虑新的终端测试方案时必读。
验证：`bun run test:e2e`（了解 PTY 测试限制和替代方案）

## 当前方案

1. `tests/tui-system/` — Bun PTY + mock OpenAI-compatible server，真实终端 E2E/PTTY 系统测试。
2. `tests/tui-*.test.tsx` — ink-testing-library 组件级单测，覆盖局部布局和输入组件行为，不作为 E2E gate。

## 已退役：旧 `tests/tui-integration/` e2e harness

```
render-tui.tsx                ← 创建 TuiBootstrap + FakeChatModel
  → stdin 按键注入（字符逐个写入）
  → lastFrame() 读取渲染输出
  → 断言文本是否出现/消失
```

该层已于 2026-07-03 退役，原因是它仍运行在虚拟 stdin/lastFrame 环境中，无法覆盖真实 PTY、raw mode、Ctrl+C、resize survival 和 scrollback 语义。仍有价值的局部 Ink 测试保留在 `tests/tui-*.test.tsx`。

**曾适用场景**：
- 单 session 内的消息发送/回复验证 ✅
- 审批/提问流程 ✅
- Slash 命令面板 ✅
- /new 后旧内容消失（reducer 状态隔离）✅

**退役原因**：
- 多 session 连续切换后发送消息（Ink remount 导致 TextInput 焦点丢失）
- 涉及终端 resize 的测试
- Scrollback（<Static>）内容捕获
- 和真实终端 raw mode 时序不同，容易形成 false positive / false negative

## 已尝试的替代方案

### Bun.spawn PTY（不可用）

Bun 1.1.0 起支持 `Bun.spawn({ pty: true })`，但子进程 `process.stdin.isTTY` 仍返回 `false`。
原因是 Bun 的 PTY 实现仅创建 PTY 文件描述符，但未将子进程的标准输入连接到 PTY slave 端。
验证日期：2026-06-15，Bun 1.3.11。

### node-pty（不可用）

`node-pty` 是成熟的 PTY 库（VS Code 内置终端使用），但在 Bun runtime 中完全无法工作：
- 原生 addon（`.node` 二进制）的 `forkpty` 系统调用与 Bun 的 NativeModule 实现不兼容
- `onData` 回调从不触发，子进程无任何输出
- 即使简单的 `node` 命令也无法在 node-pty PTY 中运行
验证日期：2026-06-15，Bun 1.3.11，node-pty@1.1.0。

### tmux 脚本（未测试）

理论上可用 `tmux send-keys` + `capture-pane -p`，但引入外部依赖（tmux 必须预装），不适合 CI 环境。

## 结论

### 2026-07-03 更新：Bun.spawn({ terminal }) 验证通过

使用 Bun 1.3.14 重新验证 `Bun.spawn({ terminal })`（与之前测试的 `pty: true` 不同）：

| 能力 | 结果 |
|------|------|
| `isTTY=true`（stdin/stdout/stderr） | ✅ 全部为 true |
| `terminal.write()` → 子进程 stdin | ✅ 数据正确到达 |
| `terminal.resize()` → SIGWINCH | ⚠️ Windows ConPTY 不触发 resize 事件 |
| 键盘输入（CSI 方向键等） | ✅ 标准 CSI 序列正确接收 |
| terminal API（write/resize/setRawMode/close） | ✅ 6 个方法可用 |

**结论变更**：Bun-only 下 PTY 测试**现已可用**。验证脚本在 `tests/pty-spike/pty-verify.test.ts`。

已知限制：
- Windows ConPTY 下 `terminal.resize()` 不触发了进程 resize 事件
- Kitty CSI-u 协议需要进一步验证
- 输出包含 ANSI 转义序列，断言前需过滤

### 原始结论（2026-06-15，Bun 1.3.11）

之前测试的是 `Bun.spawn({ pty: true })`（旧 API），子进程 `isTTY` 返回 false。新的 `Bun.spawn({ terminal })` API 可用。

在 Bun-only 技术栈下，`ink-testing-library` 仍适合作为组件级单测工具；TUI E2E gate 改为 PTY 系统测试。当前 PTY 层已覆盖 resize survival、真实输入、Ctrl+C 信号、审批、ask_user、多轮消息；Kitty 协议、scrollback 和真实 SIGWINCH 尺寸传播仍待补。

### 2026-07-03 更新：PTY 测试落地 + 遗留问题

**PTY 测试架构**：`tests/tui-system/`，harness + 7 个场景测试，22 tests 全部通过。

**3-Test Warmup 模式（关键发现）**：每个需要模型调用的 PTY 测试必须遵循 `typing → empty Enter → real message` 三阶段。原因是 Ink 的 `useFocus` hook 在首次渲染时的 `setRawMode` 初始化 + CtrlSafeTextInput remount（`textKeyRef` 变更）需要 2 次 form submission 才能稳定 raw mode 管道。不经 warmup 的模型调用被静默跳过。

**多消息同 session 阻塞已修复**：
- `runAgent()` 对同一 `threadId` 的后续非 resume 运行会读取已有 checkpoint，通过 `graph.updateState(...)` 追加新 `HumanMessage`，再从更新后的 config 继续 stream
- PTY harness 需要模拟真实输入：逐字发送文本，再单独发送 Enter；不要把 `"message\r"` 一次性写入
- Warmup typing 后必须清空输入，否则后续 Enter 会提交 warmup 文本并消费 mock 响应
- 回归测试：`tests/runner.test.ts` 的 multi-turn checkpoint continuation，以及 `tests/tui-system/scenarios/multi-turn.test.ts`

**验证边界**：
- `bun run test:tui:system`：PTY 层全量验证，当前 22 tests，逐文件串行运行以避免 mock server 并发启动。
- `bun run test:e2e`：默认 E2E 入口，等价于 `bun run test:tui:system`。
- `bun run test:tui:integration`：兼容旧脚本名，当前也指向 PTY system gate。

**详细方案文档**：`docs/space/plans/2026-07-03-tui-pty-e2e-reform.md`
