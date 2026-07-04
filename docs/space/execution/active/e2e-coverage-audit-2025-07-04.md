# E2E 测试覆盖率审计 — 2025-07-04

状态：active
范围：TUI E2E/PTTY 系统测试覆盖率、测试方法论、已知限制
读取时机：规划新一轮 E2E 测试覆盖、评估 PTY 测试体系成熟度、设计 mock server 响应队列

---

## 1. 审计方法论

本次审计采用三层分析框架：

1. **交互路径分析**：从用户键盘输入到 TUI 渲染输出的完整链路覆盖，识别每个交互路径是否被至少一个测试验证。
   - 触发（trigger）：用户发送消息 / 按键
   - 验证（verify）：断言正确的 UI 状态出现
   - 交互（interact）：对出现的 UI 进行二次交互
   - 验证结果（verify result）：断言交互产生了正确效果

2. **数据状态分析**：从 checkpoint 持久化、跨进程恢复、会话切换等数据生命周期角度，检查数据一致性是否被验证。

3. **覆盖率对比**：以前一阶段（`512fa71`，15 文件 ~71 tests）为基线，对比当前 HEAD 覆盖率增量。

## 2. 覆盖率统计

### 整体变化

| 指标 | 之前（HEAD~3） | 现在（HEAD） | 变化 |
|------|---------------|-------------|------|
| 测试文件数 | 15 | 20 | +5 |
| 测试总数 | ~71 | 102 | +31 |
| 新增文件 | — | 5 | — |
| 更新文件 | — | 5 | — |

### 测试文件清单（20 文件，102 测试）

| 文件 | 测试数 | 状态 | 覆盖内容 |
|------|--------|------|---------|
| `startup.test.ts` | 4 | 稳定 | TUI 启动、prompt 渲染、help 面板、退出 |
| `input.test.ts` | 6 | 更新 | 打字输入、空 Enter 拒绝、消息发送、Shift+Enter 换行、历史导航、@file 搜索 |
| `interrupt.test.ts` | 4 | 更新 | 单 Ctrl+C 取消、空闲 Ctrl+C 无害、双 Ctrl+C 退出、响应确认未到达 |
| `resize.test.ts` | 3 | 稳定 | resize 不清理 scrollback、small→large、large→small |
| `approval.test.ts` | 3 | 稳定 | 审批块渲染、d 键拒绝、拒绝后 TUI 恢复 |
| `tool-approve.test.ts` | 4 | 更新 | a 键通过、推理块渲染、file_change 块、same_command 审批范围（s 键）。full_access（f 键）推迟至手动验证 |
| `approval-escape.test.ts` | 3 | 新增 | Esc 取消审批、空状态恢复、取消后继续发消息 |
| `ask-user.test.ts` | 3 | 稳定 | 提问块渲染、回答提交、Agent 继续 |
| `ask-user-esc.test.ts` | 3 | 稳定 | Esc 取消提问、恢复消息区、取消后继续发消息 |
| `error-recovery.test.ts` | 4 | 稳定 | 工具错误非 crash、错误消息展示、重试成功率、总时间上限 |
| `tool-parse-error.test.ts` | 4 | 稳定 | 工具 JSON 解析错误、错误消息展示、恢复提示 |
| `plan-review.test.ts` | 5 | 新增 | PlanReviewBlock 渲染、a 键自动批准、m 键手动批准、t 键进入补充模式、Esc 返回选项模式 |
| `idle-summary.test.ts` | 3 | 稳定 | exit summary 显示、耗时 > 0、0s 显示 |
| `multi-turn.test.ts` | 3 | 稳定 | 多轮对话、上下文保持 |
| `long-message.test.ts` | 3 | 稳定 | 长消息渲染、不截断、markdown 格式 |
| `session-lifecycle.test.ts` | 7 | 更新 | /new 创建会话、会话隔离、D 键删除确认、Esc 取消删除 |
| `session-switch.test.ts` | 7 | 稳定 | /sessions 面板、箭头键导航、Enter 切换、会话内容回放、双向切换 |
| `session-persistence.test.ts` | 7 | 新增 | /exit 退出 → 重启 → /sessions 列历史 → 加载 → 消息恢复 |
| `interrupt-resume.test.ts` | 6 | 新增 | 双 Ctrl+C 退出 → 重启 → 会话列表 → 加载 → 消息恢复 |
| `slash-commands.test.ts` | 22 | 更新 | 12 个斜杠命令、面板 Esc 关闭、Tab 补全、Shift+Tab 退出计划模式 |

### 新增文件详情

| 文件 | 测试数 | 新增原因 |
|------|--------|---------|
| `approval-escape.test.ts` | 3 | 审批 Esc 取消路径此前无 PTY 测试覆盖，仅组件级测试 |
| `session-switch.test.ts` | 7 | 会话选择器导航和切换是核心 UX 路径，之前仅有组件级测试 |
| `session-persistence.test.ts` | 7 | 跨进程 checkpoint 持久化是 LangGraph 架构核心保证，之前无 E2E 验证 |
| `interrupt-resume.test.ts` | 6 | 异常退出后数据恢复是数据安全关键路径 |
| `plan-review.test.ts` | 5 | PlanReviewBlock 三模式完整交互链路此前只有组件级测试 |

### 更新文件详情

| 文件 | 新增测试数 | 新增内容 |
|------|-----------|---------|
| `input.test.ts` | +3 | Shift+Enter 软换行、历史导航（Up/Down 箭头）、@file 路径搜索 |
| `interrupt.test.ts` | +1 | 空闲态双 Ctrl+C 退出流程，验证 interrupted 响应确认未到达 |
| `session-lifecycle.test.ts` | +2 | D 键删除确认弹窗、Esc 取消删除流程 |
| `slash-commands.test.ts` | +1 | Tab 键命令自动补全 |
| `tool-approve.test.ts` | +1 | 同一命令重复审批（验证审批去重逻辑） |

## 3. 已知限制

### full_access ('f' 键) — 延迟

以下技术障碍导致 `full_access` 模式测试暂未实现：

1. **Ink 7 PTY useInput 路由**：`f` 键在 raw mode 下需要区分是输入内容的一部分还是审批快捷键。当用户输入包含 'f' 的文本时，`useInput` 无法可靠区分文本输入和快捷键触发。
2. **Scrollback 持久化**：`<Static>` 内容跨审批轮次持久化，导致断言 `full_access` 模式改变后旧审批块消失变得不可靠。
3. **只读命令自动批准**：`full_access` 模式下只读命令（如 `ls`、`cat`、`grep`）自动批准，不渲染 ApprovalBlock，无法用审批块出现/消失来验证模式切换效果。

### interrupt-resume 的限制

- **测试覆盖会话数据恢复，不覆盖完整中断状态恢复**：Ctrl+C 取消活跃中断时，reducer 将中断标记为已解决并调用 `rt.abort()`。checkpoint DB 根据 abort 时机可能保留或不保留待处理中断写入。因此无法可靠测试"加载包含待处理审批/提问中断的会话并解决它"的完整流程。
- **中断处理的单进程覆盖**：`ask-user.test.ts`、`approval.test.ts`、`tool-approve.test.ts` 覆盖了单进程内的中断处理完整链路。

### Ctrl+T / Ctrl+L

- 用户明确决定暂不纳入 E2E 测试范围。`Ctrl+T`（思维模式切换）和 `Ctrl+L`（清屏）属于低频功能，实现复杂度与收益不成比例。

### SetupWizard

- 未覆盖。原因：
  1. 需要自定义 `HOME` 目录设置，模拟首次启动场景
  2. 需要 mock server 提供验证端点（API key 验证）
  3. SetupWizard 是首次用户体验路径，宜在真实环境手动验证

## 4. 关键测试模式总结

### waitForText 与 scrollback 污染

`waitForText` 匹配的是终端全部累积输出（包括 `<Static>` 写入的 scrollback 历史），因此来自前序测试的文本始终可见。每个测试必须使用**唯一文本**（如 `Message in session A`、`Session 1 response`）以避免与 scrollback 历史中的同名文本匹配。

### setResponses 与 fire-and-forget 竞态

`setResponses` 重置 mock server 的响应队列计数器，但**已发送的 fire-and-forget 调用**（如 `generateSessionName`）的响应可能在新队列就位后才到达，从而消耗新队列的槽位。因此必须在队列中提供足够的备用槽位（通常 3-5 个）。

### shell 只读命令自动通过

`shell_execute` 中分类为只读的命令（`ls`、`cat`、`grep`、`find`、`echo`、`head`、`tail` 等）在审批策略中直接通过，不渲染 ApprovalBlock。测试工具审批时必须使用非只读命令（如 `mkdir`）。

### Static 内容跨会话持久化

`<Static>` 写入终端的文本物理上存在于 scrollback 中，不可清除。PTY 测试中 `screenContains` 搜索的是全部累积输出，因此无法验证"旧会话内容在当前会话中不可见"——只能验证当前会话内容正确渲染。

## 5. 关联记录

| 记录 | 关系 |
|------|------|
| `execution/active/tui-e2e-standards.md` | PTY 测试标准、harness 设计 |
| `execution/active/tui-e2e-testing-limits.md` | PTY 测试限制（scrollback、Static、渲染差异） |
| `execution/active/e2e-test-restructure.md` | 旧 e2e harness 退役指针 |
| `plans/2026-05-25-e2e-restructure.md` | 首次 E2E 重构方案（archived） |
| `backlog/tui-issues.md` | TUI 待修复项（影响测试可行性） |
