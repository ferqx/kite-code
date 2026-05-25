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

所有 e2e 测试使用 `createTui()` helper（`tests/e2e/render-tui.tsx`）渲染真实 `TuiBootstrap` 组件。

- 不再使用 `TuiMockRoot` / `TuiRealAgentRoot` 等简化根组件（已删除）
- `createTui` 注入 `StreamingMockModel` 替代真实 LLM，其他所有层（handleInput → runTask → SessionManager → SessionRuntime → runAgent → reducer → renderer）均为真实生产路径
- 测试使用 `beforeAll`/`afterAll` 管理单个共享 TUI 实例（Ink 在同一进程中只能被 render 一次）

### 2. 使用 `stdin.write` 模拟真实用户输入

```typescript
tui.stdin.write("hello");   // 输入文字
await tick(100);
tui.stdin.write("\r");       // 按下 Enter（触发 handleSubmit → handleInput → runTask）
```

或使用便捷方法：
```typescript
await tui.sendMessage("hello");  // 自动写入文字 + Enter + 等待
```

### 3. 测试环境必须提供合法的 AgentConfig

`createTui` 自动创建临时 HOME 目录并写入合法配置文件。通过 `process.env.OPENPX_HOME` 隔离 checkpoint 数据库。

### 4. 模型响应按顺序消费

`StreamingMockModel._callCount` 在 `bindTools` 克隆之间共享。每个 `sendMessage` 调用消耗一个响应（错误和工具调用可能消耗多个）。

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

### 6. 文件对应关系

| 文件 | 范围 |
|------|------|
| `tests/e2e/render-tui.tsx` | createTui helper，渲染真实 TuiBootstrap + StreamingMockModel |
| `tests/e2e/startup.test.tsx` | 全部 e2e 测试（单文件，共享 TUI 实例） |
| `tests/e2e/types.ts` | 类型定义 |
| `tests/e2e/freeze.ts` | ANSI 冻结工具 |
| `tests/mock-model.ts` | StreamingMockModel（响应共享计数器） |

## 理由

TUI 通过 React hooks 管理状态，TDZ 错误和闭合变量过时是高频回归。简化根组件的 mock 测试无法发现这些问题，必须通过渲染真实 TuiBootstrap 并模拟真实用户交互来验证。

关键发现（2026-05-25）：`TuiBootstrap.runTask` 在调用 `rt.runTask()` 之前设置了 `rt.agentLoopActive = true`，而 `SessionRuntime.runTask` 的守卫条件 `if (this.agentLoopActive) return;` 导致 Agent 从未执行。这是 P0 级别的无声失败——用户消息显示但 Agent 不响应。此 bug 仅在真实 TuiBootstrap 渲染测试中被发现。
