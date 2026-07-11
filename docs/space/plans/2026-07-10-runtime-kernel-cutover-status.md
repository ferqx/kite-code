# Runtime Kernel 切换状态

状态：**completed**
最后更新：2026-07-11（PTY 夹具修复并完成全量验收）
父方案：[[2026-07-08-agent-kernel-incremental-evolution]]（Phase 1-5 + Round 1-8 架构设计与实施）

> 本文档追踪父方案完成后的 **LangGraph 移除与 Runtime Kernel 全面切换** 进度。
> 父方案的 Phase 1-5 建立了 Kernel 基础设施（RuntimeEvent、RuntimeState、Reducer、
> Controller、Policy、Engine），本文档覆盖其后发生的：Graph 代码物理删除、死代码清理、
> RuntimeEvent 覆盖率补全、PTY 修复。

---

## 已完成

- `AgentKernel`、`RuntimeState`、纯函数 reducer、效果调度器和 `RuntimeStore`
  已成为 CLI 和 TUI 的生产执行路径。
- `RuntimeEvent` 是公开的流式传输、日志记录和重放协议。TUI
  重放直接渲染 `RuntimeEvent`。
- `RuntimeStore` 持久化转录、工具调用、交互、授权和滚动快照。
  同时支持会话元数据、命名恢复点、rewind、fork 和重启恢复。
- Rewind 截断后续事件和恢复点。Fork 将快照重新绑定到新线程，
  并清除 exact-command 授权。
- LangGraph 图/路由/引擎/checkpoint 代码、projection/pump 适配器及
  其旧测试已全部删除。相关 npm 依赖也已移除。
- 旧 checkpoint 会话不再支持；调用方必须启动新的 Runtime 会话。

## 剩余工作

### P0 — PTY 验收阻塞项 ✅（关闭 2026-07-11）

- Windows PTY harness 的 `process.execPath` 修复已完成；但“33/40 通过、其余均为预先存在
  时序问题”的结论不能作为完成证据。
- 2026-07-11 根因已确认并修复：`thought-lifecycle.test.ts` 与 `input.test.ts` 的隔离工作区
  未创建其成功路径所读取或搜索的文件，导致实际工具失败而 Thought 正确显示 `部分失败`。
  夹具现显式创建 `CLAUDE.md`、`package.json` 与 `src/index.ts`；这验证的是完成态 UI，而非
  依赖共享终端历史的偶然输出。
- `bun run test:tui:system` ✅ 107/107 通过；P0 关闭。

### P1 — 功能补全 ✅（已完成 2026-07-10，7/7 项）

已修复的事件覆盖：

| # | 事件 | 改动 |
|---|------|------|
| 1 | `turn.started` | `agent.ts` — user message 之后 emit |
| 2 | `turn.completed` | `runner.ts` — `run.completed` 之后 emit |
| 3 | `turn.aborted` | `agent.ts` — `run.error` 之后 emit |
| 4 | `model.retry` | `model-controller.ts` — retry listener 注册并收集 emit |
| 5 | `tool.file_change` | 新增 RuntimeEvent 类型 → `tool-controller.ts` 发出 → reducer + TUI handler |
| 6 | `model.cache_metrics` | 新增 RuntimeEvent 类型 → `model-controller.ts` 发出 → reducer + TUI handler |
| 7 | `auto_review.*` | ✅ 链路修复：`scheduler.ts` → `executor.ts` → `tool-controller.ts` 全链路贯通 |

- **替换已删除的 Graph 时代集成测试**：旧的 `integration.test.ts`（~2,955 行）
  已删除；`tests/runtime/agent.integration.test.ts` 已覆盖直接回答、读工具、规划限制、交互恢复、
  计划审批写入和快照恢复，并已随 P0 PTY 验收共同复核。

### P2 — 死代码清理 ✅（已完成 2026-07-10）

- ~~`auto-review-policy.ts`~~、~~`plan-policy.ts`~~ — 已删除（零 import 引用）
- ~~`model-controller.ts`~~ — `invokeAgentModel()` 等旧 API 已移除
- ~~`tool-controller.ts`~~ — `executeTool()` 等旧 API 已移除

### P3 — 文档与技术债 ✅（主体完成 2026-07-10）

- **源码过时注释**：
  - ~~`kernel.ts`~~ ✅ 已修复（移除 AgentEvent projection 引用和 Phase 标记）
  - ~~`model-controller.ts`~~ ✅ 头部注释已更新为 Kernel 原生描述
  - ~~`docs/space/index.md`~~ ✅ 已审计并修复 L24 过时引用（`graph.ts`/`routes.ts` →
    `scheduler.ts`/`tool-controller.ts`）
  - ~~`docs/space/execution/active/tool-gated-autonomy.md`~~ ✅ 已更新 scope
    （移除已删除的 `graph.ts`、`routes.ts`、`state.ts`，替换为 Kernel 等价文件）
  - ~~`docs/space/execution/active/cancel-resume-cleanup.md`~~ ✅ 已更新 scope + 正文
    引用 + 测试命令（移除已删除的 `graph.ts`、`runner.ts`、`graph.test.ts`、`runner.test.ts`）

- **TUI 事件处理双轨合并**：
  - ~~`session-manager.ts` catch 块~~ ✅ 已修复：错误处理路径从 `AgentEvent` 迁移到 `RuntimeEvent`
    （`model.retry` / `run.error`）
  - ~~`handleEvent.ts` 双轨残留~~ ✅ 已完成 2026-07-11：删除 TUI reducer 的旧 `EVENT` action
    和分发分支；生产流式输入仅接受 `RUNTIME_EVENT`。内部 render-event reducer 仍复用于
    RuntimeEvent 到 UI block 的归约，测试直接覆盖该内部职责，不再将旧 action 作为公共 API。

### P4 — LangChain 依赖剥离（已拆分，后续处理）

> 详细方案：[[2026-07-10-langchain-to-ai-sdk-migration]]

父方案已删除了 LangGraph 相关的 12 个 npm 包，但仍有 4 个 `@langchain/*` 运行时依赖
+ 1 个 `@modelcontextprotocol/sdk` 依赖保留，需统一迁移到 Vercel AI SDK 体系：

| 包 | 替换目标 | 优先级 |
|---|---|---|
| `@langchain/openai` + `@langchain/deepseek` + `@langchain/ollama` | `@ai-sdk/openai-compatible`（统一 provider，middleware 注入 retry + reasoning passback） | P0 |
| `@langchain/core` | `ai` SDK（`ModelMessage` 类型 + `tool()` + `generateText()`） | P0 |
| `@modelcontextprotocol/sdk` | `@ai-sdk/mcp`（统一 MCP client + 工具适配，通知监听需另选方案） | P1 |

涉及文件约 18 个（`src/core/model/`、`controllers/`、`execution/`、`harness/`、`subagent/`、`mcp/`）。
`ai@7.0.19`、`@ai-sdk/openai-compatible@3.0.7`、`@ai-sdk/mcp@2.0.10` 已安装。该工作已明确
移交至 [[2026-07-10-langchain-to-ai-sdk-migration]]，不再阻塞本文 Runtime Kernel 切换的完成状态。

## 遗留项：auto-review 功能链路断裂 ✅（已修复 2026-07-10）

**严重度**：MEDIUM → RESOLVED

**修复内容**（7 处改动）：

1. **`state.ts`**：新增 `awaiting_auto_review` 到 `InteractionState` + `ToolCallStatus`
2. **`events.ts`**：`AutoReviewRequestedEvent` 新增 `toolName`、`reason`、`approval` 字段
3. **`reducer.ts`**：`auto_review.requested` 设置 `awaiting_auto_review` 交互状态；
   `auto_review.completed` 根据结果 approve/reject 工具并恢复 `idle`
4. **`scheduler.ts`**：`awaiting_auto_review` → `run_auto_review` 效果
5. **`executor.ts`**：新增 `executeAutoReview()` — 创建 reviewer 模型、调用 `reviewToolApproval`、
   发出 `auto_review.completed`
6. **`tool-controller.ts`**：auto 模式下需审批的非破坏性工具 → 发出 `auto_review.requested`
   （跳过用户审批）；destructive 或断路器跳闸时回退到常规审批
7. **`actions.ts`**：`approve_plan` 守卫增加 `interaction.kind` 检查（类型收窄）

**设计要点**：`run_auto_review` 是处理效果（非中断效果）——它执行后循环继续，
下一轮调度器自动运行已审批的工具或调用模型处理被拒绝的工具。

详见父方案 [[2026-07-08-agent-kernel-incremental-evolution]] 第 3.6 节
AutoReviewController 职责定义、第 6.4 节 Auto mode 测试矩阵。

## 当前验证

- `bun run typecheck` ✅ 零错误（2026-07-11）
- Kernel 集成测试 ✅ 6/6 通过（2026-07-11）
- 全量 `bun test` ✅ 1251/1251 通过（2026-07-11）
- PTY 系统测试 `bun run test:tui:system` ✅ 107/107 通过（2026-07-11）

## 完成门槛

本文档仅在以下条件同时满足时可标记为 `completed`：

1. `bun run typecheck` 通过；
2. 非 PTY 全量 `bun test` 通过；
3. `bun test tests/tui-system/` 通过，或每个被隔离的失败均有可复现根因、独立 issue/owner、
   明确的风险接受记录；
4. RuntimeEvent 是 TUI 唯一的生产流式 action；
5. LangChain/MCP 迁移继续作为独立方案，不影响以上 Runtime cutover 门槛。

## 追踪关系

```
2026-07-08-agent-kernel-incremental-evolution  （父方案：架构设计 + Phase 1-5 实施 + Round 1-8 修复）
  └─ 2026-07-10-runtime-kernel-cutover-status  （本文档：Graph 移除 + Kernel 切换 + 后续补全）
       ├─ 完成：LangGraph 物理删除、死代码清理、RuntimeEvent 覆盖率补全（7/7）、
       │        auto-review 链路修复、文档审计（index.md + 3 篇 active rule）
       ├─ 完成：PTY Thought Lifecycle 验收、替代集成测试、TUI 双轨完全合并、
       │        subagent RuntimeEvent 类型
       └─ 2026-07-10-langchain-to-ai-sdk-migration  （独立后续方案：LangChain → AI SDK / MCP 迁移）
```
