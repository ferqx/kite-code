# 当前规则：TUI E2E 测试标准

状态：active
最后更新：2026-05-25
范围：

- `tests/e2e/` — 所有 TUI e2e 测试
- `src/app/tui/index.tsx` — TuiBootstrap 组件
- `src/app/tui/session-manager.ts` — 多会话管理

读取时机：

- 新增或修改 TUI e2e 测试
- 修改 TuiBootstrap、SessionManager、InputLine、App 等 TUI 核心组件
- 修改 handleInput、runTask、dispatchSessionLoad 等关键回调
- 新增 useEffect 或 useCallback 依赖

验证：

- `bun test tests/e2e/` — 运行全部 TUI e2e 测试

## 规则

### 1. TUI e2e 测试必须覆盖真实的 TuiBootstrap 渲染路径

现有 `mock-agent.test.tsx` 和 `real-agent.tsx` 使用 `TuiMockRoot` / `TuiRealAgentRoot` 等简化根组件。这些组件直接使用 `useTuiState()` 和手动事件 dispatch，不经过真实的 `TuiBootstrap` → `handleInput` → `runTask` → `SessionManager` → `SessionRuntime` → `runAgent` 完整路径。

**要求**：`startup.test.tsx` 渲染真实的 `TuiBootstrap` 组件，覆盖以下关键点：

| 测试点 | 检测的回归 |
|--------|-----------|
| 渲染不崩溃（输出长度 > 10 字符） | TDZ ReferenceError, 导入失败 |
| Auto-create session 显示在 Sidebar | SessionManager 未创建或 getSnapshot 为空 |
| stdin 输入 → handleInput → runTask 链路 | handleInput 未被调用或 runTask 静默返回 |

### 2. 使用 `ink-testing-library` 的 `render` + `stdin.write` 模拟真实用户输入

```typescript
const { stdin, lastFrame, unmount } = render(React.createElement(TuiBootstrap));
stdin.write("hello");   // 输入文字
stdin.write("\r");       // 按下 Enter
```

这触发 Ink 的 `useInput` hook，调用 `InputLine` 的 `onSubmit`，进而触发 `handleInput` → `runTask`。这是唯一能抓到 handleInput/runTask 链路中断的测试方式。

### 3. 测试环境必须提供合法的 AgentConfig

TuiBootstrap 调用 `loadAgentConfig()`，需要 `~/.openpx/openpx.jsonc` 文件。测试中通过设置 `process.env.HOME` 指向 temp 目录并提供合法配置文件。

注意：测试中使用 mock API key，agent 可能无法实际调用模型 API，但 handleInput → runTask → dispatch 的链路仍应正常执行。

### 4. 不要 mock McpManager（除非绝对必要）

`mock.module` 是进程级全局 mock，会影响同进程中的其他测试。只在必要时使用，且必须被 mock 的类需提供 MCP e2e 测试所需的完整接口（`connect`, `getServerStates` 等）。

### 5. 测试文件对应关系

| 测试文件 | 测试范围 |
|---------|---------|
| `tests/e2e/startup.test.tsx` | TuiBootstrap 渲染、auto-create session、handleInput → runTask 链路 |
| `tests/e2e/mock-agent.test.tsx` | App 组件状态管理（dispatch/reducer），使用 TuiMockRoot |
| `tests/e2e/real-agent.tsx` | runAgent 执行流程（mock model），使用 TuiRealAgentRoot |

## 理由

TUI 通过 React hooks 管理状态，TDZ（暂时性死区）错误和闭合变量过时是高频回归。简化根组件的 mock 测试无法发现这些问题，必须通过渲染真实 TuiBootstrap 并模拟真实用户交互来验证。
