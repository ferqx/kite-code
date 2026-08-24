# CLAUDE.md

本文件是仓库入口摘要。修改前先阅读 [`docs/AGENTS.md`](docs/AGENTS.md) 和与任务匹配的 `docs/active/` 规则。

## 仓库 Agent 规则

项目事实的权威顺序为：用户直接指令、源码与测试、`docs/active/` 当前规则、已接受的 ADR、其他历史或设计文档。

1. `packages/agent-kernel/` 不得依赖其他 workspace、I/O runtime 或 TUI 展示类型。
2. 当前行为发生变化时，必须在同一改动中更新相关 `docs/active/` 文档。
3. `docs/design/`、`docs/space/plans/`、`docs/space/execution/completed/` 和 `docs/deprecated/` 不是当前实现依据。
4. 架构决策需要新增 ADR，不得改写已接受 ADR 的历史结论。
5. 不得覆盖或清理与当前任务无关的用户改动。

### 提交前文档门禁

在暂存已完成的功能实现、创建提交、推送代码或创建 Pull Request 前，必须读取 `.agents/skills/document-before-commit/SKILL.md`，并按其中定义显式执行项目 Skill `document-before-commit`。Claude Code 即使未将 `.agents/skills` 展示为原生 Skill，也必须通过本条仓库指令加载并执行同一文件。

该 Skill 必须检查已暂存、未暂存和未跟踪的改动，根据 `docs/documentation-map.json` 更新受影响的当前文档，并运行：

```bash
bun run check:docs-impact
bun run check:docs
bun run check:core-boundary
```

TypeScript 发生变化时还必须运行 `bun run typecheck` 和相关测试。文档与实现未共同收敛时，不得宣称任务完成、提交、推送或创建 Pull Request。

行为无变化的内部重构不要求制造无意义文档修改。如果映射范围不准确，应修正 `docs/documentation-map.json`，不得跳过检查。禁止使用 `--no-verify` 绕过仓库钩子。

## 技术栈

- Bun、TypeScript ESM；
- AI SDK 与 `@ai-sdk/openai-compatible`；
- `@modelcontextprotocol/sdk`；
- React 19、Ink 7；
- Bun SQLite、Zod、AJV、YAML、JSONC。

## 架构

```text
packages/runtime-contract/       client-facing in-process contract
packages/runtime-spi/            provider-neutral ports
packages/agent-kernel/           state/event/reducer/scheduler authority
packages/runtime-host/           lifecycle、execution 与 storage ports
packages/builtin-runtime/        builtin domain modules
packages/runtime-storage-sqlite/ SQLite storage adapter
apps/kite/                       concrete composition、CLI 与 TUI
```

核心入口：

- `packages/agent-kernel/src/kernel.ts`：状态转换权威；
- `packages/agent-kernel/src/state.ts`、`events.ts` 与 `reducer.ts`：Kernel persisted projection；
- `packages/runtime-host/src/execution/`：通用 Tool Pipeline lifecycle；
- `packages/builtin-runtime/src/`：Capability catalog 与领域执行模块；
- `packages/runtime-storage-sqlite/src/adapter.ts`：SQLite 生命周期与持久化 adapter；
- `apps/kite/src/bootstrap.ts`：唯一 concrete composition root；
- `apps/kite/src/cli/` 与 `apps/kite/src/tui/`：CLI/TUI 输入输出适配。

## 不变量

1. Core 不得依赖 App/TUI。
2. RuntimeState 只通过 RuntimeEvent 改变。
3. Capability discovery 不授予执行权限。
4. 动态调用必须校验 binding、turn、revision 和 schema。
5. 外部写入先持久化 intent，未知终态不盲重放。
6. Tool success 不等于任务完成。
7. Required Verification 不能被 final 或 feature flag 绕过。
8. 不得恢复已删除的 LangGraph、Prompt Skill 或旧 MCP adapter 路径。

## 验证

```bash
bun run test:all
bun run typecheck
bun run check:core-boundary
bun run check:docs
```

全量测试必须使用 `bun run test:all`（默认集合 + TUI 系统测试）。不要运行裸 `bun test`：它未经 `package.json` 的忽略配置，会误跑 `tests/tui-system/`、`tests/pty-spike/` 等非默认集合。定向回归可运行 `bun test <路径>`。

TUI 端到端测试使用 `bun run test:e2e`。仓库当前没有默认真实模型测试脚本。
