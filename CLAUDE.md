# **CLAUDE.md**

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
bun run test:e2e    # 运行 TUI E2E/PTTY 系统测试（mock server，无需真实模型）
bun run test:tui:system  # 运行真实 PTY TUI 系统测试（mock server，无需真实模型）
bun run typecheck    # 类型检查
bun run test:real    # 运行真实端到端测试（需先配置 ~/.kite-code/kite-code.jsonc）
```

## 项目架构

三层架构（protocol → core → app）：

**`src/protocol/` — 协议层**：事件类型、action 类型、provider 接口
- `events.ts` — `AgentEvent` 23 种子类型定义
- `actions.ts` — 中断 action、user action 类型
- `provider.ts` — `UserInputProvider` 接口

**`src/core/` — 核心层**：图编排、模型、工具、持久化、配置

> **架构约束**：core 是纯数据逻辑层，**不依赖任何 UI 端**。规则只有一条——`import` 方向：`app → core → protocol`，永不反向。详细边界见 `docs/space/execution/active/layer-boundary-enforcement.md`。

- `harness/graph.ts` — LangGraph 节点组装和主循环拓扑（单 agent 节点）
- `harness/routes.ts` — agent / approval / tools / user_input 之间的路由
- `harness/tool-runner.ts` — 执行经过审批或允许直通的工具请求
- `harness/tool-policy.ts` — 工具安全策略与审批决策
- `runner.ts` — run / resume 编排与事件流输出
- `model/context.ts`、`model/runtime-context.ts` — 模型上下文整理、压缩和证据注入
- `tools/definitions.ts` — 9 个 Agent 工具定义及只读命令分类
- `tools/tool-contracts.ts` — 工具 ACI 契约（一等 UX 文档）
- `tools/shell.ts`、`tools/file.ts`、`tools/apply-patch.ts` — 底层工具实现
- `persistence/checkpoint.ts` — Bun SQLite LangGraph checkpointer
- `persistence/sessions.ts` — 会话列表、加载、命名（返回 `SessionData`，由 TUI 的 `replay-blocks.ts` 转为 `OutputBlock[]`）
- `config/index.ts`、`config/paths.ts` — 配置读取与路径管理

**`src/app/` — 应用层**：TUI 前端、CLI 入口
- `tui/index.tsx` — TUI 入口、agent 生命周期、Kitty 键盘协议
- `tui/App.tsx` — reducer（47 种 Action）、初始状态、App 布局
- `tui/OutputArea.tsx` — Static/dynamic 分割渲染：已完成消息通过 `<Static>` 写入终端 scrollback 后移出 React 树，活跃消息在 dynamic 树实时更新
- `tui/components/` — InputLine、MarkdownBlock、ApprovalBlock、InputBlock、HelpPanel、ModelSelector、SessionSelector、StartupScreen、CtrlSafeTextInput
- `tui/hooks/` — useGlobalKeys、useLeaderKeys、useSlashCommand、useSlashSuggestions、useFileSearch、useSessionList
- `cli/index.ts` — CLI 参数解析和入口行为

**文档**：
- `PRODUCT.md` — 产品定义、核心特性、竞品差异
- `ROADMAP.md` — 路线图：当前阶段、下一步、长期愿景
- `docs/space/` — 设计决策、规则、方案、待办
- `tests/` — 测试是理解行为约束的重要来源

## 提交流程

提交信息格式：`<type>: <中文简述>`，type 常用 `feat` / `fix` / `refactor` / `test` / `docs`。

- 先看 `git status` + `git diff` + `git log --oneline -5` 确认范围和风格
- 按变更文件粒度 `git add <file...>`，不 `git add -A`
- 描述聚焦「改了什么、为什么改」，不列举文件清单
- **禁止**将 `git commit` 输出管道到 `head`/`tail` 截断——必须看到完整输出以确认提交成功
- 每次 `git commit` 后**必须**验证 `git status` 工作区干净、`git log --oneline -3` 确认提交入库
- 多步分批提交时，每批完成后验证 `git status`，确认上一批已提交成功再 `git add` 下一批
- lefthook pre-commit 会运行 format + typecheck，若 typecheck 失败则 commit 被拒绝——需先修好再重试
- 提交前运行 `bun run typecheck` 确保零错误；生产代码（`src/`）中不允许新增 `as any` 或 `: any`（外部 API 约束除外，需注释说明）。详见 `docs/space/execution/active/project-conventions.md` 的「TypeScript 类型安全」章节

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
| TUI reducer 逻辑 | `bun test tests/tui-reducer.test.ts` |
| TUI 布局/渲染 | `bun test tests/tui-layout.test.tsx` |
| TUI E2E/PTTY 系统测试（真实终端） | `bun run test:e2e` 或 `bun run test:tui:system` |
| TUI 启动与基础交互（真实 PTY） | `bun test tests/tui-system/scenarios/startup.test.ts tests/tui-system/scenarios/input.test.ts` |
| TUI 会话切换完整链路 | `bun test tests/tui-session-switch.test.tsx`（组件级）或 `tests/tui-system/scenarios/session-lifecycle.test.ts`（PTY） |
| TUI 工具审批与错误恢复 | `bun test tests/tui-system/scenarios/approval.test.ts tests/tui-system/scenarios/tool-approve.test.ts tests/tui-system/scenarios/ask-user.test.ts tests/tui-system/scenarios/ask-user-esc.test.ts tests/tui-system/scenarios/error-recovery.test.ts` |
| TUI 斜杠命令 | `bun test tests/tui-system/scenarios/slash-commands.test.ts` |
| TUI 长消息 / resize / Ctrl+C / 多轮 | `bun test tests/tui-system/scenarios/long-message.test.ts tests/tui-system/scenarios/resize.test.ts tests/tui-system/scenarios/interrupt.test.ts tests/tui-system/scenarios/multi-turn.test.ts tests/tui-system/scenarios/idle-summary.test.ts` |
| 跨模块/不确定 | `bun test` + `bun run typecheck` |
| 真实模型链路 | `bun run test:real` |

## 测试编写原则

- **测试是为了发现程序问题，不是为了通过而通过**。如果测试断言与实际行为不符，应优先怀疑程序行为是否正确，而不是为了让测试变绿去迁就当前行为
- 测试用例名称应描述验证的**行为**，而非实现细节

## TUI 验证

- Ink 渲染管线（Static/dynamic 分割、Yoga 布局、debug 模式）在
  `ink-testing-library` 和真实终端中行为不同。TUI 布局/交互类改动仅靠
  单元/reducer/layout 测试无法验证正确性
- `src/app/tui/` 下的布局改动和 React `key` 变动有级联影响——改 OutputArea
  可以破坏 Header/Footer 的渲染位置
- 测试全绿 ≠ 功能正确，TUI 布局类改动必须在提交前 `bun run tui` 手动验证

## 平台兼容

- 测试用例必须支持 Windows / Unix 双平台
- TUI必须支持 Windows / Unix 双平台
- Shell 工具必须支持 Windows / Unix 双平台
- 文件工具必须支持 Windows / Unix 双平台，且正确处理路径分隔符差异
- 其他工具和核心逻辑应尽量避免平台特定行为，或在文档中明确说明平台限制
- 测试覆盖应包含平台差异相关的边界情况，确保在不同环境下行为一致
- 在开发过程中应使用跨平台工具和库，避免引入仅支持单一平台的依赖
- 在提交前应在至少一个 Windows 和一个 Unix 环境中运行测试，确保没有平台特定的失败

## 项目顶层文档

- `PRODUCT.md` — 产品定义：定位、核心特性、明确不做的事、架构原则、竞品差异
- `ROADMAP.md` — 路线图：当前阶段、下一步、长期愿景
- `docs/space/` — 设计决策、规则、方案、待办；入口 `docs/space/index.md`
- `docs/space/plans/index.md` — 方案注册表

**读**：
- 每次重要决策应先对照 `PRODUCT.md` 判断是否在产品边界内。规划新功能应查看 `ROADMAP.md`。
- **强制规则**：实现功能前，必须先读取 `docs/space/index.md` 的"读取时机"列，找到对应的设计文档（`plans/` 或 `understanding/`），并严格按照文档中的代码示例和布局规范实现。测试全绿 ≠ 实现正确，必须对照设计文档验证布局、结构、交互是否符合规范。

**写**：每次提交前检查是否有新的设计决策、行为约束或实现细节需要记录在 `docs/space/` 中，尤其是 `execution/active/` 下的规则记录。
