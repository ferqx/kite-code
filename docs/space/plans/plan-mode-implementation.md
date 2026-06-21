# Plan Mode 功能实现文档

状态：active
范围：`src/protocol/`、`src/core/`、`src/app/tui/`、`tests/`
读取时机：修改 plan 流程、plan_review 中断、ask_user 多问题、session 持久化时必读。
验证：`bun test tests/graph.test.ts tests/tui-reducer.test.ts tests/tui-layout.test.tsx tests/integration.test.ts`

---

## 概述

Plan Mode 允许 Agent 在执行复杂任务前先提出方案，经用户审批后再执行。整个功能涉及三层架构的全面改造。

## 触发方式

| 触发方式 | 实现 |
|----------|------|
| `/plan <task>` | slash command，进入 planning phase + 立即提交任务 |
| `/plan`（无参数） | 仅切换 phase 为 planning，用户后续输入任务 |
| Shift+Tab | 切换 planning ↔ building，全局快捷键 |
| Agent 自主判断 | system prompt Plan-First Rule，Agent 自行决定是否先出方案 |

## 架构

### 协议层 (protocol)

- **新事件**: `need_plan_review` — `NeedPlanReviewPayload { plan: AgentPlan }`
- **新类型**: `AgentPlan`、`AgentPlanStep`、`PlanStatus`、`UserInputQuestion`
- **新 UserAction**: `approve_plan_auto`、`approve_plan_manual`、`supplement_plan`、`reject_plan`
- **扩展**: `UserInputPayload` 新增 `questions?: UserInputQuestion[]`（多问题模式）

### 核心层 (core)

- **graph.ts**: 新增 `planReview` 节点，首次 `update_plan` 调用 → interrupt 等用户审批。审批通过 → 设置 `state.plan` + `authorization.mode`（auto → full_access，manual → default）
- **routes.ts**: `update_plan` 首次调用路由到 `plan_review`，后续调用路由到 `tools`
- **runner.ts**: 事件提取、中断映射、resume value 转换
- **user-input.ts**: `normalizeUserInputResume` 支持 `answers` map（多问题）
- **sessions.ts**: `ReplayInterrupt` 扩展 `plan_review` 类型，从 checkpoint `channel_values.plan` 提取已批准方案
- **types.ts**: `PlanReviewResumeValue` + `UserInputResumeValue.answers`

### TUI 层 (app/tui)

- **PlanReviewBlock.tsx**: plan_review 中断时的确认操作条（Footer），三个选项：Auto / Manual / Tell。方案内容在 OutputArea 渲染
- **TaskProgressBlock.tsx**: 审批后只读进度列表，显示在 Footer 上方
- **BlockRenderer.tsx**: plan_review 卡片渲染（OutputArea）— `borderStyle="round"` + name + Markdown description + steps，支持 `awaiting review` / `auto mode` / `manual approval` / `supplemented` / `cancelled` / `rejected` 多种状态
- **InputBlock.tsx**: 多问题 Wizard 模式 — 步骤导航、逐题回答、已回答摘要、汇总提交。单问题模式保持原有行为
- **InputLine.tsx**: plan mode 可视化 — `≻◷` prompt + 模式指示条
- **StatusBar.tsx**: idle 时 plan mode 也显示 `○ Planning`
- **replay-blocks.ts**: 从消息历史提取 plan_review 块（`update_plan` AIMessage tool_call args + ToolMessage 结果），支持所有审批状态恢复
- **agentReducer.ts**: `TOGGLE_PLAN_MODE`、plan_review Esc 取消停止 agent、多问题 resolution
- **useGlobalKeys.ts**: Shift+Tab 切换 + supplement 模式 Esc 局部消费

### CLI (app/cli)

- plan_review 中断支持 `a/auto`、`m/manual`、`t/tell`、`r/reject`

## 用户交互流程

```
用户输入任务
  │
  ├─ 需要澄清？→ ask_user (多问题 batch) → 用户回答 → 继续
  │
  └─ Agent 调用 update_plan → plan_review 中断
      │
      ├─ Auto: 审批通过，full_access 执行
      ├─ Manual: 审批通过，per-edit 审批
      ├─ Tell: 补充反馈 → Agent 修订 → 再次 plan_review
      └─ Esc/Ctrl+C: 取消，agent 停止
```

## 设计决策

| 决策 | 结论 |
|------|------|
| PlanReview 选项 | Auto / Manual / Tell 三选项 |
| Pre-plan 澄清 | ask_user questions 数组批量确认 |
| Supplement 后 | 再次触发 plan_review（不设 state.plan） |
| 补充方式 | 纯自由文本，Esc 回退到选项页 |
| free_text | 永远可用，Tab 切换 |
| Plan 展示 | 方案内容 OutputArea（进 Static） + 确认条 Footer（动态） |
| 边框样式 | `borderStyle="round"` + `columns` 响应式宽度 |
| 持久化 | 消息中提取 plan_review 块 + checkpoint state.plan 兜底 |

## 相关文档

- [[layer-boundary-enforcement]] — core 层边界约束
- [[tool-description-contracts]] — 工具 ACI 契约
- [[tui-reference-stability]] — useStaticContent 与 Static/Dynamic 分离
