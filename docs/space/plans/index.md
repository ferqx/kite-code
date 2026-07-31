# Plans 注册表

最后更新：2026-08-01（完成 Task 1A.6，激活 1A.7）

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
| [`2026-07-29-agent-production-readiness-roadmap.md`](2026-07-29-agent-production-readiness-roadmap.md) | active | P0 | 已批准 Agent 生产就绪 RFC | Phase 0–6 总入口 | `MS:M0` 已完成；首发拓扑、依赖图、后续 Gate、共享证据与回滚规则 |
| [`2026-07-29-agent-production-governance-decisions.md`](2026-07-29-agent-production-governance-decisions.md) | archived | P0 | 生产就绪 roadmap | RFC Phase 0 | single-maintainer 治理与 M0 已完成；[完成记录](../execution/completed/2026-07-30-agent-production-governance.md) |
| [`2026-07-29-agent-production-local-data-privacy.md`](2026-07-29-agent-production-local-data-privacy.md) | active | P0 | `MS:M0` | RFC Phase 1A | Task 1A.1–1A.6 completed；1A.7 in progress |
| [`2026-07-29-agent-production-execution-isolation.md`](2026-07-29-agent-production-execution-isolation.md) | active | P0 | `MS:M0` | RFC Phase 1B | Task 1B.0/1B.1/1B.4 completed，D-04 空支持集；Task 1B.2/1B.3 in progress |
| [`2026-07-29-agent-production-runtime-resilience.md`](2026-07-29-agent-production-runtime-resilience.md) | active | P0 | `MS:M0` | RFC Phase 1C | Task 1C.1–1C.4/1C.6 completed；1C.5/1C.7 仍等待依赖 |
| [`2026-07-29-agent-production-release-control.md`](2026-07-29-agent-production-release-control.md) | draft | P0 | 2A-F 依赖 Phase 0；2A-RC 依赖 1A–1C/2B/3 | RFC Phase 2A | payload/detached manifest、Release Profile、evidence/Gate、平台制品 |
| [`2026-07-29-agent-production-evaluation.md`](2026-07-29-agent-production-evaluation.md) | draft | P0 | Phase 0、2A-F；执行 fixture 依赖 1B/1C | RFC Phase 2B | Agent task suite、oracle、重复运行、人工验收 |
| [`2026-07-29-agent-production-observability-operations.md`](2026-07-29-agent-production-observability-operations.md) | draft | P0 | 1A、1C、`MS:2A-F`、2B metrics contract | 替代两份 2026-06-18 telemetry 草案 | 无正文 metrics、告警、kill switch、事故演练、limited cohort SLO |
| [`2026-07-29-agent-production-compaction-qualification.md`](2026-07-29-agent-production-compaction-qualification.md) | draft | P1 | 2A、2B、3、ADR-0021/22/24；external 等待 LIM/SLO | RFC Phase 4 | 离线资格、internal auto 新鲜度、external manual canary 与 maturity |
| [`2026-07-29-agent-production-capability-rollout.md`](2026-07-29-agent-production-capability-rollout.md) | draft | P1 | 1A–1C、2A、2B、3；external 等待 LIM/SLO | RFC Phase 5 | Verification、MCP write、Skills 分别 internal、external canary、beta/stable maturity |
| [`2026-07-29-agent-production-ga.md`](2026-07-29-agent-production-ga.md) | draft | P1 | `MS:LIM-APPROVED`、`MS:LIMITED-SLO`、manual stable；只等待拟入 GA capability | RFC Phase 6A/6B | 可选 Auto maturity；GA selection、artifact 与发布后观察 |
| [`2026-07-26-tool-spec-registry-phase-2.md`](2026-07-26-tool-spec-registry-phase-2.md) | archived | P0 | ADR-0026、ADR-0027 | 延续已归档阶段 0/1 | coordination、interrupt、runtime_action 工具全部迁入 Registry |
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
| [`2026-06-18-opentelemetry-observability.md`](2026-06-18-opentelemetry-observability.md) | superseded | P1 | — | 被 2026-07-29 无正文可观测性计划替代 | 旧方案允许导出 Workspace、命令、路径和错误正文，不再实施 |
| [`2026-06-18-kite-code-telemetry-collection.md`](2026-06-18-kite-code-telemetry-collection.md) | superseded | P2 | `opentelemetry-observability` | 被 2026-07-29 无正文可观测性计划替代 | 旧双通道 scrub 方案不满足 metadata-only 边界 |
| [`2026-06-18-session-logger.md`](2026-06-18-session-logger.md) | archived | P0 | — | — | 会话日志本地记录：AgentEvent 全量 → OTel 兼容 JSONL + RunSummary，离线回溯与故障诊断 |
| [`2026-06-19-event-mechanism-refactor.md`](2026-06-19-event-mechanism-refactor.md) | archived | P0 | `session-logger` | — | 事件机制重构：turn 边界、用户输入事件化、统一事件管道、子 agent 事件归一 |
| [`2026-06-26-shell-live-output.md`](2026-06-26-shell-live-output.md) | archived | P0 | — | — | Shell 实时输出已实施；计划仅作历史参考。 |
| [`2026-06-28-context-compaction.md`](2026-06-28-context-compaction.md) | archived | P0 | — | — | M0/M1 已实施，M2 未纳入当前执行计划。 |
| [`2026-07-19-context-compaction-v2.md`](2026-07-19-context-compaction-v2.md) | draft | P0 | — | 后续生产化计划的架构来源 | 上下文压缩 V2 原始设计。当前实现事实以源码、ADR-0021 和 2026-07-21 计划为准。 |
| [`2026-07-20-context-compaction-refinement.md`](2026-07-20-context-compaction-refinement.md) | superseded | P0 | 2026-07-19 V2 | 被 2026-07-21 生产化计划替代 | 历史精化方案。 |
| [`2026-07-20-context-compaction-productionization.md`](2026-07-20-context-compaction-productionization.md) | superseded | P0 | 2026-07-20 精化 | 被 2026-07-21 生产化计划替代 | 基于旧提交的历史生产化方案。 |
| [`2026-07-21-context-compaction-production-rollout.md`](2026-07-21-context-compaction-production-rollout.md) | archived | P0 | ADR-0021、真实模型测试边界 | 替代两份 2026-07-20 方案 | PR-0 至 PR-7 已完成；单叙事压缩、恢复、rollout、观测、Required CI 与 live Provider 验证已落地。[完成记录](../execution/completed/2026-07-22-context-compaction-production-rollout.md)。 |
| [`2026-06-27-plan-subagent-role-design.md`](2026-06-27-plan-subagent-role-design.md) | draft | P1 | — | — | Plan 子 Agent 角色：只读架构设计专家，多视角并行设计方案，主 agent 合并后调 `update_plan` |
| [`2026-06-30-approval-execution-sandbox.md`](2026-06-30-approval-execution-sandbox.md) | archived | P0 | — | — | 目标能力已进入当前 Runtime/Policy/Execution/Sandbox。 |
| [`2026-07-01-web-search-tool.md`](2026-07-01-web-search-tool.md) | draft | P0 | — | — | Web 网络工具：Phase 1 `web_fetch`（fetch → SSRF → readability → turndown 正文提取），Phase 2 `web_search`（搜索发现 URL） |
| [`2026-07-03-tui-pty-e2e-reform.md`](2026-07-03-tui-pty-e2e-reform.md) | archived | P1 | — | 扩展 2026-05-25-e2e-restructure | PTY 与 Ink 测试体系已落地；当前标准见 active 规则。 |
| [`2026-07-08-agent-kernel-incremental-evolution.md`](2026-07-08-agent-kernel-incremental-evolution.md) | archived | P0 | — | — | Runtime Kernel 已完成并成为状态转换权威。 |
| [`2026-07-10-langchain-to-ai-sdk-migration.md`](2026-07-10-langchain-to-ai-sdk-migration.md) | completed | P0 | `2026-07-10-runtime-kernel-cutover-status` | — | LangChain → AI SDK 依赖迁移：provider 包 + `@langchain/core` + MCP SDK → `ai` + `@ai-sdk/openai-compatible` + `@ai-sdk/mcp`。2026-07-12 @langchain/core 已完全移除 |
| [`2026-07-11-merge-exit-plan-mode.md`](2026-07-11-merge-exit-plan-mode.md) | archived | P0 | Plan Mode | — | `exit_plan_mode` 合并已实施。 |
| [`2026-07-11-plan-mode-refactor.md`](2026-07-11-plan-mode-refactor.md) | archived | P0 | `2026-07-08-agent-kernel-incremental-evolution.md` | 替代旧 Plan 工具设计 | Plan Artifact 与三类 Plan 工具生命周期已实施。 |
| [`2026-07-12-approval-architecture-refactor.md`](2026-07-12-approval-architecture-refactor.md) | archived | P0 | Runtime Kernel | — | Runtime Policy、审批与执行边界重构已实施。 |
| [`2026-07-12-subagent-approval-continuation.md`](2026-07-12-subagent-approval-continuation.md) | archived | P0 | `2026-07-08-agent-kernel-incremental-evolution.md` | — | Subagent continuation 与审批恢复已实施。 |
| [`2026-07-12-subagent-approval-continuation-implementation.md`](2026-07-12-subagent-approval-continuation-implementation.md) | archived | P0 | `2026-07-12-subagent-approval-continuation.md` | — | 实施完成，保留为历史 TDD 记录。 |
| [`2026-07-12-runtime-engineering-guardrails.md`](2026-07-12-runtime-engineering-guardrails.md) | completed | P0 | `2026-07-08-agent-kernel-incremental-evolution.md` | — | Runtime 工程护栏建设：Feature Flags、Golden Tests、FailureKind、授权溯源、Replay、ADR、准入标准、边界检查、文档分层与 Prompt 契约均已实施。 |
| [`2026-07-13-plan-artifact-lifecycle.md`](2026-07-13-plan-artifact-lifecycle.md) | archived | P0 | Plan Mode | — | Plan Artifact 文件化、版本化审核与 Task 隔离已实施。 |
| [`2026-07-14-mcp-runtime-governance-p0.md`](2026-07-14-mcp-runtime-governance-p0.md) | archived | P0 | ADR-0007 | 落实 MCP/Skills Runtime 治理 RFC 的 Phase 0+1 | Revisioned MCP catalog、turn binding、fail-closed schema、policy 和结构化结果；[完成记录](../execution/completed/2026-07-14-mcp-runtime-governance-p0.md)。 |
| [`2026-07-14-mcp-skills-runtime-governance-followup.md`](2026-07-14-mcp-skills-runtime-governance-followup.md) | archived | P1 | `2026-07-14-mcp-runtime-governance-p0.md`、ADR-0007、ADR-0008 | 延续 MCP/Skills Runtime 治理 RFC | Phase 2 execution record/recovery ✅ → Phase 3 Skill Workflow ✅ → Phase 4 verification ✅ → Phase 5 progressive disclosure ✅；[完成记录](../execution/completed/2026-07-15-mcp-skills-runtime-governance.md)。 |
| [`2026-07-15-mcp-project-server-approval-p0.md`](2026-07-15-mcp-project-server-approval-p0.md) | archived | P0 | ADR-0007、ADR-0009 | MCP TUI 管理中心 RFC 的 Phase 0 | 项目来源识别、config digest、本地批准记录、transport 前置门禁、最小 TUI 审批和真实 transport/PTY 验证；[完成记录](../execution/completed/2026-07-15-mcp-project-server-approval-p0.md)。 |
| [`2026-07-15-mcp-tui-management-center-implementation.md`](2026-07-15-mcp-tui-management-center-implementation.md) | superseded | P0–P2 | MCP Runtime Governance、Phase 0 子计划 | 被 2026-07-16 `/mcp` 只读计划替代 UI 方向 | Phase 0–3 与 Phase 4 Core 为完成事实；Tool policy 不恢复 TUI 管理路由，[Phase 4 完成记录](../execution/completed/2026-07-17-mcp-tool-policy-phase4.md)。 |
| [`2026-07-16-mcp-tui-readonly-list.md`](2026-07-16-mcp-tui-readonly-list.md) | archived | P0 | MCP Phase 0–2、ADR-0009/0010/0011 | 纠偏 2026-07-15 总计划中的 `/mcp` 管理中心 UI | `/mcp` 无参数只读列表、project trust prompt 独立迁移、配置 mutation 退出 TUI；[完成记录](../execution/completed/2026-07-16-mcp-tui-readonly-list.md)。 |
| [`2026-07-16-mcp-auth-phase3.md`](2026-07-16-mcp-auth-phase3.md) | archived | P1 | Phase 2、ADR-0010/0012 | 承接旧总计划 Phase 3 的 Core auth，保留 `/mcp` 只读边界 | OS vault、credential reference、HTTP OAuth、独立恢复提示与三平台 native smoke 已完成；[完成记录](../execution/completed/2026-07-16-mcp-auth-phase3.md)。 |
| [`2026-07-17-mcp-agent-provider-recovery-phase5.md`](2026-07-17-mcp-agent-provider-recovery-phase5.md) | archived | P2 | Phase 1/3/4、ADR-0010/0012/0014 | 替代 superseded 总计划的 Phase 5 实施依据 | Provider directory、typed failure/search、Provider Action/new turn、required admission/session waiver、App/TUI handlers 与 PTY 已完成；[完成记录](../execution/completed/2026-07-17-mcp-agent-provider-recovery-phase5.md)。 |
| [`2026-07-26-tool-spec-registry.md`](2026-07-26-tool-spec-registry.md) | archived | P0 | ADR-0026、ADR-0027 | 落实 [ToolSpec Registry RFC](../../design/2026-07-26-tool-spec-registry-rfc.md) | 阶段 0/1 与六个计算原语单路径迁移完成；[完成记录](../execution/completed/2026-07-26-tool-spec-registry.md)。 |
| [`2026-07-26-tool-spec-registry-phase-3.md`](2026-07-26-tool-spec-registry-phase-3.md) | archived | P0 | ADR-0026、ADR-0027、ADR-0028 | ToolSpec Registry 阶段 3 控制平面收口 | Plan Runtime 门面、Skill 生命周期服务与 Controller 收尾已完成；[完成记录](../execution/completed/2026-07-26-tool-spec-registry-phase-3.md)。 |

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
