# Plan Mode 方案设计

状态：active
关联实现：[[plan-mode-implementation]]

---

## 触发方式

| 触发方式 | 行为 |
|----------|------|
| `/plan <task>` | 进入 planning phase + 立即提交任务 |
| `/plan`（无参数） | 仅切换 phase，用户后续输入即任务 |
| `Shift+Tab` | 切换 planning ↔ building，全局快捷键 |
| Agent 自主判断 | system prompt Plan-First Rule 触发，复杂任务自动先出方案 |

planning phase 下 tool-policy 限制：只允许 `update_plan`、`ask_user`、只读 shell_execute、read_file。

---

## 交互流程

```
用户输入任务
  │
  ├─ 需求模糊？→ ask_user（多问题 batch）→ 用户回答
  │
  └─ Agent 调用 update_plan → plan_review 中断
      │
      ├─ Yes, auto mode       → 审批通过，full_access 执行
      ├─ Yes, manual approve  → 审批通过，per-edit 审批
      ├─ Tell Agent to change → 补充反馈 → Agent 修订 → 再次 plan_review
      └─ Esc / Ctrl+C         → 取消方案，agent 停止等新指令
```

---

## 设计决策

| 决策 | 结论 |
|------|------|
| PlanReview 选项 | Auto / Manual / Tell 三选项，Auto 为推荐 |
| Pre-plan 澄清 | `ask_user` 扩展 `questions` 数组，一次批量确认所有不确定点 |
| Supplement 后行为 | 再次触发 plan_review 中断审查 |
| Supplement 输入 | 纯自由文本，Esc 回退到选项页 |
| free_text | 永远可用（Tab 切换），不依赖 `allow_free_text` |
| Plan 内容展示 | 方案卡片进 OutputArea（Static 冻结），Footer 仅渲染确认操作条 |
| Plan 边框 | `borderStyle="round"`，响应式宽度 `columns - 6` |
| 持久化 | 从消息历史（AIMessage tool_calls）恢复 plan_review 块 + checkpoint `state.plan` 兜底 |

---

## Plan 结构

Agent 通过 `update_plan` 工具提交方案，字段含义：

| 字段 | 说明 |
|------|------|
| `name` | 方案标题（一行） |
| `description` | 完整方案详情（Markdown）：架构、设计决策、文件结构、数据流、依赖、权衡。这是用户审查的主内容 |
| `steps` | 进度标记（3-6 字），只表示阶段，不放架构细节 |
| `status` | 首次提交始终 `pending`，后续更新 `in_progress` → `completed` |

---

## 撤销/驳回/补充行为

| 操作 | 结果 |
|------|------|
| Esc 取消方案 | agent 停止，`running: false`，等用户重新输入 |
| 驳回（无 feedback） | `rejectedToolMessage("plan rejected by user")`，agent 自行决定下一步 |
| 补充（有 feedback） | `rejectedToolMessage("Plan needs revision. User feedback: ...")`，agent 修订后重新 `update_plan` → 再次 plan_review |
| 方案卡片 | 取消/驳回/补充后卡片仍留 scrollback，标签标示状态 |
