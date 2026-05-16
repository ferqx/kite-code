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
bun test tests/e2e/            # 运行 TUI e2e 套件（mock agent，无需真实模型）
bun run typecheck    # 类型检查
bun run test:real    # 运行真实端到端测试（需先配置 ~/.openpx/openpx.jsonc）
```

## 项目架构

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
- `docs/space/README.md` - space 目录导航和使用说明

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
| TUI reducer 逻辑 | `bun test tests/tui-reducer.test.ts` |
| TUI 布局/渲染 | `bun test tests/tui-layout.test.tsx` |
| TUI e2e（mock agent） | `bun test tests/e2e/` |
| 跨模块/不确定 | `bun test` + `bun run typecheck` |
| 真实模型链路 | `bun run test:real` |

## 测试编写原则

- **测试是为了发现程序问题，不是为了通过而通过**。如果测试断言与实际行为不符，应优先怀疑程序行为是否正确，而不是为了让测试变绿去迁就当前行为
- 测试用例名称应描述验证的**行为**，而非实现细节

## 平台兼容

- 测试用例必须支持 Windows / Unix 双平台
- TUI必须支持 Windows / Unix 双平台
- Shell 工具必须支持 Windows / Unix 双平台
- 文件工具必须支持 Windows / Unix 双平台，且正确处理路径分隔符差异
- 其他工具和核心逻辑应尽量避免平台特定行为，或在文档中明确说明平台限制
- 测试覆盖应包含平台差异相关的边界情况，确保在不同环境下行为一致
- 在开发过程中应使用跨平台工具和库，避免引入仅支持单一平台的依赖
- 在提交前应在至少一个 Windows 和一个 Unix 环境中运行测试，确保没有平台特定的失败

## space 文档更新

- 每次提交前都要检查是否有新的设计决策、行为约束或实现细节需要记录在 `docs/space/` 中，尤其是 `execution/active/` 下的规则记录
