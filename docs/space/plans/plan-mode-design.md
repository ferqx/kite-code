# Plan Mode 方案设计

状态：superseded
被替代：[Plan Mode 重构](2026-07-11-plan-mode-refactor.md) — `update_plan` 单工具设计替换为 `write_plan` + `exit_plan_mode` + `update_plan`(进度版) 三工具职责分离
关联实现：[当前 Plan Mode 实现](../../active/plan-mode-implementation.md)

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

---

## 附录：原始交互原型

> 以下为设计初期的交互 mockup，记录产品思考过程。最终实现中澄清流程改用 `ask_user` 多问题模式，未做独立的 "Review your answers" 汇总页。

### 原型 1：Pre-plan 澄清问答

```
←  ☒ 修订后行为  ☐ 补充方式  ☐ 触发时机  ✔ Submit  →

补充方案时，用户输入应该是纯自由文本，还是应该提供结构化的
补充选项（如：补充某个步骤 / 修改整体方向 / 添加约束条件）？

❯ 1. 纯自由文本 (Recommended)
    一个文本输入框，用户自由输入。简单直接，模型能理解自然语言。
    与 InputBlock 的 free-text 模式一致，复用现有代码。
2. 结构化选项 + 自由文本
    先选补充类别（步骤/方向/约束），再输入文本。
    更结构化但增加交互复杂度，且类别划分可能不准确。
3. Type something.

agent 会给出补充方案的建议，用户可以选择接受或修改。
```

### 原型 2：确认汇总页

```
←  ☒ 修订后行为  ☒ 补充方式  ☒ 触发时机  ✔ Submit  →

Review your answers

● 方案磋商循环中，supplement 后 agent 修订方案再次提交，
  应该再次触发 plan_review 中断让用户审查，还是 agent 修订后直接执行？
→ 再次中断审查 (Recommended)
● 补充方案时，用户输入应该是纯自由文本？
→ 纯自由文本 (Recommended)
● 首次 update_plan 的触发时机？
→ 保持 agent 自主判断 (Recommended)

Ready to submit your answers?

❯ 1. Submit answers
4. Cancel
```

### 原型 3：方案审批页

```
Plan: 优化 TUI 文件变更渲染 — 统一 diff 格式

Context: 当前 TUI 文件变更渲染存在多个格式，导致维护复杂度高。
目标是统一 diff 格式，简化维护。

Step1: 分析现有渲染格式，评估差异和维护成本。
Step2: 设计统一的 diff 格式，确保兼容现有功能。
Step3: 实施新的 diff 格式，并进行测试验证。

测试验证:
1. 单元测试：覆盖所有 diff 格式相关的功能，确保新格式正确渲染。
2. 性能测试：评估新格式对渲染性能的影响，确保没有显著下降。
...
────────────────────────────────────────────────────────────────
Claude has written up a plan and is ready to execute.
Would you like to proceed?

> 1. Yes, and use auto mode
2. Yes, manually approve edits
3. Tell Agent what to change

选择 1 后 agent 直接执行方案步骤，自动处理修改，无需用户干预。
选择 2 后 agent 每步执行前展示修改，等用户批准后才继续。
选择 3 后用户输入修改意见，agent 调整并重新生成方案。
```
