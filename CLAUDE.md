# CLAUDE.md

## 技术栈

- 运行时：Bun
- 语言：TypeScript（ESM）
- 核心依赖：`@langchain/core`、`@langchain/langgraph`、`@langchain/deepseek`、`@langchain/openai`、`@langchain/langgraph-checkpoint-sqlite`
- 持久化：SQLite checkpoint

## 常用命令

```bash
bun install          # 安装依赖
bun test             # 运行默认测试（不含真实模型/网络端到端测试）
bun test tests/graph.test.ts  # 运行单个测试文件
bun run typecheck    # 类型检查
bun run test:real    # 运行真实端到端测试（需先配置 ~/.openpx/openpx.jsonc）
```

启动 agent 任务：

```bash
bun run agent run --thread demo --user local --task "Create hello.txt with exact content \"hello\""
bun run agent resume --thread demo --user local --approve  # 审批后恢复执行
```

## 项目架构

核心流程：单一 `agent` 节点，条件路由到 `approval` / `tools` / `user_input`，完成后回到 `agent` 继续循环，无工具调用时结束。

关键文件：
- `src/harness/graph.ts` — LangGraph 节点组装和主循环拓扑（单 agent 节点）
- `src/harness/routes.ts` — agent / approval / tools / user_input 之间的路由
- `src/harness/tool-runner.ts` — 执行经过审批或允许直通的工具请求
- `src/harness/tool-policy.ts` — 工具安全策略与审批决策
- `src/app/runner.ts` — run / resume 编排与事件流输出
- `src/app/cli.ts` — CLI 参数解析和入口行为
- `src/tools/definitions.ts` — 6 个 Agent 工具定义及只读命令分类
- `src/tools/tool-contracts.ts` — 工具 ACI 契约（一等 UX 文档）
- `src/tools/shell.ts`、`src/tools/file.ts`、`src/tools/apply-patch.ts` — 底层工具实现
- `src/model/context.ts`、`src/model/runtime-context.ts` — 模型上下文整理、压缩和证据注入
- `src/config/index.ts` — 读取本地 `~/.openpx/openpx.jsonc` 配置
- `tests/` — 测试是理解行为约束的重要来源
- `docs/` — 设计文档、决策记录和未来规划

## TUI 组件规范（Ink 7 + React 19）

TUI 位于 `src/app/tui/`，基于 Ink 7（终端 React 渲染器）。

### React.memo 约束

`React.memo` **禁止**用于含有 `useInput` 的组件。Ink 7 的 `useInput` 通过 `useEffectEvent` 追踪最新回调，但 `React.memo` 阻止重渲染会导致 `useEffectEvent` 内部 ref 无法更新，引发 stale closure。

| 状态 | 组件 |
|------|------|
| ✅ 已移除 | `ApprovalBlock`、`InputBlock`、`HelpPanel`、`ModelSelector` |
| ✅ 保留（ref 保护） | `OutputArea` |
| ✅ 保留（无 useInput） | `StatusBar` |

如需给 `useInput` 组件加回 `React.memo`，必须先确保所有 `useInput` 闭包内被读取的本地 state 都有对应的 ref 保护。

### useInput 闭包内读取本地 state 必须通过 ref

Ink 7 的 `useEffectEvent` 在 `React.memo` 拦截重渲染时无法更新内部回调引用。**任何在 `useInput` 回调中按名称读取的本地 state，必须改为从 `useRef` 读取。**

```typescript
// ❌ 错误：闭包中的 selected 可能陈旧
const [selected, setSelected] = useState(0);
useInput((_, key) => {
  if (key.return) doSomething(GRANTS[selected]);
});

// ✅ 正确：ref 始终是最新值
const [selected, setSelected] = useState(0);
const selectedRef = useRef(selected);
selectedRef.current = selected;  // 每次 render 同步
useInput((_, key) => {
  if (key.return) doSomething(GRANTS[selectedRef.current]);
});
```

- 仅 `setState(updaterFn)` 形式的更新不受影响（React 保证 updater 拿到最新值）
- 从 props 读取的 callback（如 `onClose`、`onSelect`）也可能陈旧，但通常由父组件的 `useCallback` 稳定引用保证

### 除以上规则外

- `useGlobalKeys`、`useLeaderKeys` 是 hook，在非 memo 组件（`App`）中调用，其 `dispatch` 来自 `useReducer` 稳定引用，无陈旧风险
- `useFileSearch`、`useSlashCommand` 是纯 hook，不涉及 `useInput` 闭包问题

## 提交流程

提交信息格式：`<type>: <中文简述>`，type 常用 `feat` / `fix` / `refactor` / `test` / `docs`。

- 先看 `git status` + `git diff` + `git log --oneline -5` 确认范围和风格
- 按变更文件粒度 `git add <file...>`，不 `git add -A`
- 描述聚焦「改了什么、为什么改」，不列举文件清单

## 测试对应关系

| 改动范围 | 验证命令 |
|---------|---------|
| 图路由、审批流 | `bun test tests/graph.test.ts` |
| 全图集成（mock 模型） | `bun test tests/integration.test.ts` |
| 工具实现或限制 | `bun test tests/tools.test.ts tests/tool-definitions.test.ts` |
| 工具安全策略 | `bun test tests/tool-policy.test.ts` |
| CLI | `bun test tests/cli.test.ts` |
| 上下文整理 | `bun test tests/context.test.ts` |
| 运行时编排 | `bun test tests/runner.test.ts` |
| checkpoint 持久化 | `bun test tests/checkpoint.test.ts tests/integration.test.ts` |
| 跨模块/不确定 | `bun test` + `bun run typecheck` |
| 真实模型链路 | `bun run test:real` |
