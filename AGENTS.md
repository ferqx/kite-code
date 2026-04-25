# AGENTS.md

## 仓库定位

这是一个基于 Bun + TypeScript + LangGraph.js 的代码代理参考实现，核心目标不是做业务功能，而是稳定维护一个可执行、可中断、可恢复、可验证的 agent 工作流。

当前仓库重点：
- 维护 `agent -> approval/tools -> agent` 的主循环。
- 支持 `plan` / `builder` 两种模式切换。
- 支持基于 `interrupt()` 的人工审批与恢复执行。
- 记录命令、文件变更、验证结果等执行证据。
- 用 `bun test` 保证图路由、工具限制、CLI 和运行逻辑不回退。

## 技术栈

- 运行时：Bun
- 语言：TypeScript（ESM）
- 核心依赖：
  - `@langchain/core`
  - `@langchain/langgraph`
  - `@langchain/deepseek`
  - `@langchain/langgraph-checkpoint-sqlite`
- 持久化：SQLite checkpoint

## 进入仓库后优先看哪里

- `src/graph.ts`
  这是核心文件。包含状态定义、节点、路由、stop check、审批流和工具执行主循环。
- `src/runner.ts`
  负责 run / resume 编排与事件流输出。
- `src/cli.ts`
  负责 CLI 参数解析和入口行为。
- `src/tool-definitions.ts`
  负责 plan 模式下的工具暴露和只读限制。
- `src/tools.ts`
  负责 shell / patch 工具实现。
- `src/context.ts`
  负责模型上下文整理、压缩和证据注入。
- `src/config.ts`
  负责读取本地 `~/.openpx/openpx.jsonc` 配置。
- `tests/`
  测试是理解行为约束的重要来源，不只是回归验证。

## 关键行为约束

- 优先做最小改动，不要无谓重构图结构。
- 除非任务本身就是修改 plan 规则，否则不要绕过 plan 模式的只读限制。
- 如果改了路由、stop check、approval、tool gating，必须同步看 `tests/graph.test.ts`。
- 如果改了 CLI 行为或参数，必须同步更新 `README.md` 和相关测试。
- 如果改了工具行为，必须确认 `state.evidence` 的记录逻辑仍然真实反映执行结果。
- 注释只写在“不看上下文就难以理解”的地方，避免把显而易见的代码翻译成注释。

## 禁止事项

- 不要跳过或弱化 `evaluateStopCheck`，除非任务明确要求重新设计最终答案守卫。
- 不要为了让流程更快结束而清空、伪造或忽略 `state.evidence`。
- 不要让 plan 模式执行写文件、改文件、安装依赖、启动服务等非只读操作。
- 不要把工具失败包装成成功结果；失败应进入 tool result、verification 或最终说明。
- 不要为了让测试通过而删除关键断言或降低原有安全约束。
- 不要在未说明原因的情况下跳过相关测试。
- 不要把真实模型端到端测试当成默认验证手段；只有改动涉及真实模型链路或用户明确要求时再运行。
- 不要提交本地 checkpoint、临时文件、密钥配置或 `tests/.tmp-*` 下的运行产物。

## 特别说明

- `src/graph.ts` 里的 `evaluateStopCheck` 是“收口守卫”，不是业务逻辑。
  它的职责是阻止 agent 过早输出最终答案。
- 当出现以下情况时，它会清空 `state.final`，并注入一条新的消息，让图回到 `agent` 继续执行：
  - `plan` 模式下还没有真正写入 plan，却直接声称完成。
  - `builder` 模式下 plan 还有未完成步骤，却直接结束。
  - 已修改文件，但没有验证记录，也没有明确说明无法验证。
  - 验证记录里已经出现失败，但最终回答没有明确说明失败或阻塞。

## 常用命令

安装依赖：

```bash
bun install
```

启动一次 agent 任务：

```bash
bun run agent run --thread demo --user local --task "Create hello.txt with exact content \"hello\""
```

审批后恢复执行：

```bash
bun run agent resume --thread demo --user local --approve
```

运行全部测试：

```bash
bun test
```

运行单个测试文件：

```bash
bun test tests/graph.test.ts
```

类型检查：

```bash
bun run typecheck
```

运行真实端到端测试：

```bash
bun run test:real
```

## 验证建议

改动完成后，优先跑和改动最接近的测试，不要一开始就全量跑。

常见对应关系：
- 图路由、stop check、审批流改动：`bun test tests/graph.test.ts`
- 工具实现或工具限制改动：`bun test tests/tools.test.ts tests/tool-definitions.test.ts`
- CLI 改动：`bun test tests/cli.test.ts`
- 上下文整理改动：`bun test tests/context.test.ts`
- 运行时编排改动：`bun test tests/runner.test.ts`
- 跨模块改动或不确定影响范围时：`bun test` + `bun run typecheck`

## 提交与变更规范

- 只改完成当前任务所必需的内容，避免顺手重构无关模块。
- 如果只是帮助理解代码而不改变行为，可以只补注释，但不要顺手改写逻辑。
- 只要修改了已有行为、路由、工具限制、CLI 参数或上下文拼装，就应补测试或更新现有测试。
- 如果没有补测试，必须能说明原因，例如：
  - 变更仅限注释或文案，不影响运行行为。
  - 仓库当前没有对应层级的测试入口，且新增测试的成本明显高于本次改动。
- 修改 README、AGENTS.md、注释这类文档文件时，不应夹带功能性代码改动，除非任务明确要求。
- 不要为了让测试通过而改弱约束；优先修正实现，使行为继续满足既有测试语义。
- 如果发现现有测试和实现冲突，先确认哪一边表达的是当前真实规则，再决定修改测试还是实现。

## 完成任务后的汇报模板

任务完成后，建议按下面的顺序汇报，保持简洁，但要把关键事实讲清楚：

1. 改了什么
2. 为什么这么改
3. 验证了什么
4. 还有什么没做或存在什么风险

可参考这个结构：

```text
已完成：
- 调整了……
- 补充了……

原因：
- 之前……
- 现在……

验证：
- 已运行 `bun test ...`
- 结果通过 / 未运行，原因是……

风险或未完成项：
- …
```

如果是很小的改动，也至少应覆盖这 3 点：
- 改动结果
- 验证结果
- 是否存在剩余风险

## 配置说明

- 默认模型配置从当前用户目录读取：

```text
~/.openpx/openpx.jsonc
```

- 如果需要跑真实模型相关流程，先确认本地 DeepSeek 配置可用。

## 对后续 Agent 的提醒

- 不要把 `tests/.tmp-*` 下的文件当成正式源码或稳定夹具。
- 这个仓库很多“真实约束”不是写在 README，而是写在测试里；遇到不确定行为时，优先读测试。
- 如果某个改动涉及“是否允许结束流程”，优先检查 `evaluateStopCheck`、`routeAfter*` 和 evidence 记录链路是否一致。
