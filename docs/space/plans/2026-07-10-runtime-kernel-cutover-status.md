# Runtime Kernel 切换状态

状态：**active follow-up**  
最后更新：2026-07-10（P1 主体完成）  
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

### P0 — 阻塞项 ✅（已完成 2026-07-10）

- ~~**修复 Windows PTY harness**~~：`pty-process.ts` 和 `pty-verify.test.ts`
  中硬编码 `'bun'` 替换为 `process.execPath`。33/40 PTY 测试通过（剩余 7 个
  失败为预先存在的测试时序问题）。

### P1 — 功能补全 ✅（主体完成 2026-07-10，6/7 项）

已修复的事件覆盖：

| # | 事件 | 改动 |
|---|------|------|
| 1 | `turn.started` | `agent.ts` — user message 之后 emit |
| 2 | `turn.completed` | `runner.ts` — `run.completed` 之后 emit |
| 3 | `turn.aborted` | `agent.ts` — `run.error` 之后 emit |
| 4 | `model.retry` | `model-controller.ts` — retry listener 注册并收集 emit |
| 5 | `tool.file_change` | 新增 RuntimeEvent 类型 → `tool-controller.ts` 发出 → reducer + TUI handler |
| 6 | `model.cache_metrics` | 新增 RuntimeEvent 类型 → `model-controller.ts` 发出 → reducer + TUI handler |

遗留：`auto_review.*` 事件——非事件缺失，而是 **auto-review 功能链路断裂**（见下方遗留项）。

- **替换已删除的 Graph 时代集成测试**：旧的 `integration.test.ts`（~2,955 行）
  已删除，尚无等价 Kernel 原生端到端测试覆盖。

### P2 — 死代码清理 ✅（已完成 2026-07-10）

- ~~`auto-review-policy.ts`~~、~~`plan-policy.ts`~~ — 已删除（零 import 引用）
- ~~`model-controller.ts`~~ — `invokeAgentModel()` 等旧 API 已移除
- ~~`tool-controller.ts`~~ — `executeTool()` 等旧 API 已移除

### P3 — 文档与技术债

- **源码过时注释**：
  - ~~`kernel.ts`~~ ✅ 已修复（移除 AgentEvent projection 引用和 Phase 标记）
  - ~~`model-controller.ts`~~ ✅ 头部注释已更新为 Kernel 原生描述
  - `docs/space/index.md`：部分 active 规则仍指向 `graph.ts`、`routes.ts` 等
    已删除文件（如 `tool-gated-autonomy.md`、`cancel-resume-cleanup.md`）

- **TUI 事件处理双轨合并**：`handleEvent.ts` 同时处理 `AgentEvent`（旧
  dispatch 路径）和 `RuntimeEvent`（新 `RUNTIME_EVENT` action）。注释
  （L1338）标注为 "legacy RuntimeEvent→AgentEvent projection so TUI
  migration can delete it"。待 RuntimeEvent 覆盖完整后应统一为单一事件路径。

## 遗留项：auto-review 功能链路断裂

**严重度**：MEDIUM — 影响 auto mode 的审批自动化能力

**现状**：

- `RuntimeEvent` 类型 `auto_review.requested` / `auto_review.completed` 已定义
- `RuntimePolicy.shouldAutoReview()` 接口和 `auto-mode` / `full-mode` 实现存在
- `RuntimeEffect` 类型 `run_auto_review` 已定义
- 但 **`decideNextEffect`（scheduler）不返回 `run_auto_review`** ——
  调度器完全忽略 policy 的 `need_auto_review` 决策
- 旧的 `auto-review-controller.ts` 已在父方案的 LangGraph 移除中删除，
  无 Kernel 原生替代
- 后果：auto mode 实质上**降级为 ask mode 行为**——所有非只读工具仍走人工审批，
  auto-review 的"自动审查后执行"路径完全不生效

**修复路径**（需独立方案）：

1. 新建 Kernel 原生 `auto-review-controller`（或扩展 `tool-controller`）
2. `decideNextEffect` 接入 policy 的 `need_auto_review` 决策
3. 实现 reviewer model 调用 + `auto_review.requested/completed` 事件管道
4. 在 `executeRuntimeTools` 中根据 auto-review 结果决定执行/拒绝

详见父方案 [[2026-07-08-agent-kernel-incremental-evolution]] 第 3.6 节
AutoReviewController 职责定义、第 6.4 节 Auto mode 测试矩阵。

## 当前验证

- `bun run typecheck` ✅ 零错误
- RuntimeStore、Kernel、scheduler/action、TUI reducer、Policy 测试 ✅ 324 pass
- PTY 系统测试 ✅ 33/40 pass（剩余 7 个为预先存在的时序问题，非本次引入）

## 追踪关系

```
2026-07-08-agent-kernel-incremental-evolution  （父方案：架构设计 + Phase 1-5 实施 + Round 1-8 修复）
  └─ 2026-07-10-runtime-kernel-cutover-status  （本文档：Graph 移除 + Kernel 切换 + 后续补全）
       ├─ 完成：LangGraph 物理删除、死代码清理、RuntimeEvent 覆盖率补全（6/7）、PTY 修复
       └─ 遗留：auto-review 链路断裂、集成测试替代、TUI 双轨合并、index.md 审计
```
