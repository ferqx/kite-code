# TUI E2E 测试方案与限制

状态：active
范围：`tests/e2e/`、`tests/tui-*.test.tsx`、`tests/mock-model.ts`
读取时机：编写 TUI E2E 测试、调试 TextInput/键盘交互测试、考虑新的终端测试方案时必读。

## 当前方案：ink-testing-library + StreamingMockModel

```
render-tui.tsx                ← 创建 TuiBootstrap + FakeChatModel
  → stdin 按键注入（字符逐个写入）
  → lastFrame() 读取渲染输出
  → 断言文本是否出现/消失
```

**适用场景**：
- 单 session 内的消息发送/回复验证 ✅
- 审批/提问流程 ✅
- Slash 命令面板 ✅
- /new 后旧内容消失（reducer 状态隔离）✅

**不适用场景**：
- 多 session 连续切换后发送消息（Ink remount 导致 TextInput 焦点丢失）
- 涉及终端 resize 的测试
- Scrollback（<Static>）内容捕获

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

在 Bun-only 技术栈下，没有可用的操作系统级 PTY 测试方案。`ink-testing-library` 是最佳选择，其已知限制通过以下方式回避：
- 多 session 消息发送：在 reducer 层测试（`tui-reducer.test.ts`，覆盖 SESSION_ACTIONS 状态转换）
- 手动验证：`bun run tui`

等 Bun runtime 完全支持 `forkpty` 或出现纯 JS 的 PTY 实现后，再启用 PTY E2E 测试。
