# Plans 注册表

最后更新：2026-07-08（Agent Runtime Kernel 重构方案）

所有实施计划的统一入口。每个计划文件有独立状态，本注册表提供全局视图和分叉关系。

## 状态说明

| 状态 | 含义 |
|------|------|
| `draft` | 方案初稿，待确认后方可执行 |
| `active` | 执行中 |
| `blocked` | 被依赖项阻塞 |
| `superseded` | 被另一个方案替代（记录替代关系） |
| `completed` | 已完成，尚未归档 |
| `archived` | 已归档，完成记录在 `execution/completed/`，plan 文件保留作为设计参考 |

## 当前计划

| 计划 | 状态 | 优先级 | 依赖 | 替代/分叉 | 阶段产出 |
|------|------|--------|------|-----------|----------|
| [`2026-05-20-tui-production-roadmap.md`](2026-05-20-tui-production-roadmap.md) | archived | P0 | — | — | Step2 感知闭环：流式指示器 + Plan 连线 + Phase 确认<br>Step3 防御纵深：Error Boundary + Checkpoint 关闭 + Temp 清理<br>Step4 功能补齐：手动 Compaction |<!-- replaced by 2026-05-22-production-gaps-closure.md for remaining gaps -->|
| [`2026-05-22-production-gaps-closure.md`](2026-05-22-production-gaps-closure.md) | archived | P0 | — | 替代 2026-05-20 路线图中未完成项 | Phase1 ✅ MCP + 事件闭环<br>Phase2 ✅ Rewind + MCP Resources<br>Phase3 ✅ Skills 系统<br>Hooks + 自定义命令延后 |
| [`2026-05-22-production-gaps-phase1.md`](2026-05-22-production-gaps-phase1.md) | archived | P0 | — | — | Phase 1 详细实施计划（8 tasks, 8 commits）。 |
| [`2026-05-22-production-gaps-phase2.md`](2026-05-22-production-gaps-phase2.md) | archived | P0 | — | — | Phase 2 详细实施计划（7 tasks）。Rewind（Revert+Fork）+ MCP Resources。 |
| [`2026-05-22-skills-system.md`](2026-05-22-skills-system.md) | superseded | P1 | — | 被 [2026-05-23-skills-system-phase3.md](2026-05-23-skills-system-phase3.md) 替代 | — |
| [`2026-05-23-skills-system-phase3.md`](2026-05-23-skills-system-phase3.md) | archived | P0 | Phase 1 + Phase 2 | — | Skills 系统实施计划（11 tasks）。agentskills.io 标准。 |
| [`2026-05-24-multi-session-concurrency.md`](2026-05-24-multi-session-concurrency.md) | archived | P0 | — | — | 多会话并发执行（3 tasks）。 |
| [`2026-05-25-e2e-restructure.md`](2026-05-25-e2e-restructure.md) | archived | P1 | — | — | E2E 测试套件重构（~71 tests，P0-P3 分层）。 |
| [`2026-05-26-tui-claude-code-parity.md`](2026-05-26-tui-claude-code-parity.md) | archived | P0 | — | — | TUI Claude Code 全面对标：布局重构、快捷键精简、功能补全、配置、主题（14 tasks）。 |
| [`2026-06-16-plan-review-interrupt.md`](2026-06-16-plan-review-interrupt.md) | archived | P1 | — | — | 为 update_plan 增加 plan_review 中断。实际实现有偏差，参见 [[plan-mode-implementation]] |
| [`2026-06-17-background-subagent.md`](2026-06-17-background-subagent.md) | draft | P0 | `understanding/2026-05-30-multi-agent-design.md` | — | 后台子 Agent：`background: true` 异步派发、SessionContext 容器、BackgroundTaskManager、跨 run 注入与中止（8 phases）。 |
| [`2026-06-14-p0-gap-closure.md`](2026-06-14-p0-gap-closure.md) | draft | P0 | — | — | P0 缺口补齐：Web Search + Token 展示 + 开箱即用 + 工作空间授权（4 大类 19 tasks）。 |
| [`2026-06-18-opentelemetry-observability.md`](2026-06-18-opentelemetry-observability.md) | draft | P1 | — | — | Agent OpenTelemetry 可观测性：Trace/Span 建模 + OTLP 导出，工具失败分类 → 提示词优化闭环 |
| [`2026-06-18-kite-code-telemetry-collection.md`](2026-06-18-kite-code-telemetry-collection.md) | draft | P2 | `opentelemetry-observability` | — | Kite Code 遥测收集：双通道 opt-in，脱敏工具调用统计，驱动工具契约优化 |
| [`2026-06-18-session-logger.md`](2026-06-18-session-logger.md) | archived | P0 | — | — | 会话日志本地记录：AgentEvent 全量 → OTel 兼容 JSONL + RunSummary，离线回溯与故障诊断 |
| [`2026-06-19-event-mechanism-refactor.md`](2026-06-19-event-mechanism-refactor.md) | archived | P0 | `session-logger` | — | 事件机制重构：turn 边界、用户输入事件化、统一事件管道、子 agent 事件归一 |
| [`2026-06-26-shell-live-output.md`](2026-06-26-shell-live-output.md) | completed | P0 | — | — | Shell 工具实时输出展示：`tool_progress` 事件 + 流式 stdout/stderr 读取 + TUI tail-follow 渲染 |
| [`2026-06-28-context-compaction.md`](2026-06-28-context-compaction.md) | active | P0 | — | — | M0 TUI 预整合 ✅ + M1 Core 工具折叠 ✅ + M2 对话摘要（延后） |
| [`2026-06-27-plan-subagent-role-design.md`](2026-06-27-plan-subagent-role-design.md) | draft | P1 | — | — | Plan 子 Agent 角色：只读架构设计专家，多视角并行设计方案，主 agent 合并后调 `update_plan` |
| [`2026-06-30-approval-execution-sandbox.md`](2026-06-30-approval-execution-sandbox.md) | active | P0 | — | — | 审批层、执行层与沙箱 5 阶段：阶段四 `/mode` 交互模式 ✅、阶段五 执行可靠性 ✅，阶段一~三待实施 |
| [`2026-07-01-web-search-tool.md`](2026-07-01-web-search-tool.md) | draft | P0 | — | — | Web 网络工具：Phase 1 `web_fetch`（fetch → SSRF → readability → turndown 正文提取），Phase 2 `web_search`（搜索发现 URL） |
| [`2026-07-03-tui-pty-e2e-reform.md`](2026-07-03-tui-pty-e2e-reform.md) | active | P1 | — | 扩展 2026-05-25-e2e-restructure | TUI E2E 双层架构：PTY 终端系统测试 + Ink 组件集成测试。Phase 0-4 完成（19 tests / 6 files），多消息阻塞调查中 |
| [`2026-07-08-agent-kernel-incremental-evolution.md`](2026-07-08-agent-kernel-incremental-evolution.md) | draft | P0 | — | — | Agent Runtime Kernel 重构：5 阶段建立事件驱动状态机，LangGraph 降级为执行引擎。Phase 1 RuntimeEvent+Projection → Phase 2 Reducer+Store → Phase 3 Controller 抽取 → Phase 4 Policy 策略化 → Phase 5 LangGraph 适配器化 |

## 计划文件命名规范

```
plans/YYYY-MM-DD-<slug>.md
```

- 日期：计划创建日期
- slug：简短描述，kebab-case

## 计划取代规则

当方案 B 替代方案 A 时：
1. 方案 A 的状态改为 `superseded`
2. 在方案 A 的"替代/分叉"列注明被哪个方案替代
3. 方案 B 的开头注明"替代 [方案 A](path)"

当计划完成后：
1. 状态改为 `completed`（待归档）
2. 完成后改为 `archived`，在 `execution/completed/` 创建完成记录
3. 如有未完成项，在 `backlog/` 中创建条目
4. 更新本注册表
5. Plan 文件保留作为设计参考，不删除

## 方案间依赖

如果一个计划依赖另一个计划的产物，在"依赖"列标注计划文件名。被依赖的计划必须先完成，或与依赖方并行推进时明确划分阶段。
