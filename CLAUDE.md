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

核心流程：`agent_plan` / `agent_build → approval/tools → reflect → agent_*` 主循环。

关键文件：
- `src/harness/graph.ts` — LangGraph 节点组装和主循环拓扑
- `src/harness/routes.ts` — agent / approval / tools / reflect 之间的路由
- `src/harness/tool-runner.ts` — 执行经过审批或允许直通的工具请求
- `src/app/runner.ts` — run / resume 编排与事件流输出
- `src/app/cli.ts` — CLI 参数解析和入口行为
- `src/tools/definitions.ts` — plan/builder 模式下的工具暴露和只读限制
- `src/tools/shell.ts`、`src/tools/file.ts`、`src/tools/apply-patch.ts` — 底层工具实现
- `src/model/context.ts`、`src/model/runtime-context.ts` — 模型上下文整理、压缩和证据注入
- `src/config/index.ts` — 读取本地 `~/.openpx/openpx.jsonc` 配置
- `tests/` — 测试是理解行为约束的重要来源

## 关键行为约束

- **plan 模式必须只读**：不能写文件、改文件、安装依赖、启动服务。
- **不要绕过 plan 模式的只读限制**（除非任务本身就是修改 plan 规则）。
- 工具失败应如实上报，**不要把失败包装成成功**。
- 优先**最小改动**，不要无谓重构图结构。
- 改路由/approval/tool gating 必须同步看 `tests/graph.test.ts`。
- 不要为让测试通过而删除关键断言或降低安全约束。
- 修改行为、路由、工具限制、CLI 参数或上下文拼装时必须补测试或更新现有测试。

> 更多项目约定（文档语言、provider 边界、提交粒度、仓库卫生等）见 [docs/space/execution/active/project-conventions.md](docs/space/execution/active/project-conventions.md)。

## 提交流程

提交信息格式：`<type>: <中文简述>`，type 常用 `feat` / `fix` / `refactor` / `test` / `docs`。

- 先看 `git status` + `git diff` + `git log --oneline -5` 确认范围和风格
- 按变更文件粒度 `git add <file...>`，不 `git add -A`
- 描述聚焦「改了什么、为什么改」，不列举文件清单

## 测试对应关系

| 改动范围 | 验证命令 |
|---------|---------|
| 图路由、审批流 | `bun test tests/graph.test.ts` |
| 工具实现或限制 | `bun test tests/tools.test.ts tests/tool-definitions.test.ts` |
| CLI | `bun test tests/cli.test.ts` |
| 上下文整理 | `bun test tests/context.test.ts` |
| 运行时编排 | `bun test tests/runner.test.ts` |
| 跨模块/不确定 | `bun test` + `bun run typecheck` |
| 真实模型链路 | `bun run test:real` |
