# Space 索引

最后更新：2026-08-02（Agent 生产准入跨平台策略修正）

这是 `docs/space/` 的导航入口。默认不要读取所有记录；应根据下面的范围和“读取时机”只拉取当前任务需要的上下文。

`docs/space/` 不存储每次运行的 Runtime Kernel 计划状态；本索引只跟踪持久项目记录。

状态含义：

- `active`：当前有效规则，会约束其范围内的改动。
- `completed`：历史实现记录和验证证据。
- `understanding`：设计背景或理由。
- `reference`：外部资料摘要。
- `generated`：派生材料，权威性较低。

## 当前规则记录

> 权威文件位于 `docs/active/`，下表使用 `../active/` 相对路径。

| 记录 | 状态 | 范围 | 读取时机 |
| --- | --- | --- | --- |
| `../active/six-concept-runtime-architecture.md` | active | Agent、Runtime Kernel、Capability、Policy、Execution、Verification 总体架构 | 修改跨模块 Runtime 架构、能力治理、执行或完成语义时。 |
| `../active/thought-pre-consolidation.md` | active | TUI 探索工具合并、tool_summary 事件处理、ToolSummaryBlock 渲染、Static/Dynamic 分界 | 修改 `consolidateTools.ts`、`handleEvent.ts`（tool_call/tool_done）、`ToolSummaryBlock.tsx`、`useStaticContent.ts`（tool_summary）、`types.ts`（ConsolidatedToolEntry/tool_summary）、`agentReducer.ts`（cancelRunningBlocks）、`compaction.ts`（折叠引擎）时必读。 |
| `../active/plan-state-reminder.md` | active | Runtime 动态状态投影与缓存敏感消息布局 | 修改 `src/core/model/context.ts`、`runtime-context.ts`、Plan/Mode/Verification 投影时。 |
| `../active/model-provider-boundary.md` | active | AI SDK provider 配置、适配器和专有行为 | 修改 `src/core/config`、`src/core/model` 或 provider 文档时。 |
| `../active/tool-gated-autonomy.md` | active | Capability 执行、审批、授权、sandbox 与完成边界 | 修改 Tool Controller、Runtime Policy、Scheduler 或能力执行测试时。 |
| `../active/real-model-test-boundary.md` | active | 测试发现、真实模型端到端套件、package 脚本 | 修改测试命名、`package.json` 测试脚本或真实模型套件。 |
| `../active/documentation-language.md` | active | 文档语言、Markdown 内容标准、文档测试 | 创建或修改 README、AGENTS、`docs/space` 或其他 Markdown 文档。 |
| `../active/empirical-research-archive.md` | active | 真实模型实验、缓存/性能研究、provider 行为研究、可复用实验归档 | 运行或解释真实 provider 实验、缓存命中率实验、多轮 agent 行为实验，或用户要求研究结论可沉淀。 |
| `../active/tool-description-contracts.md` | active | 工具描述契约、ACI 原则、契约结构与验证测试 | 创建或修改工具定义、工具描述、工具行为实现；新增工具注册。 |
| `../active/project-conventions.md` | active | 文档语言、注释规范、测试纪律、CLI 行为、提交粒度、仓库卫生、TypeScript 类型安全 | 修改 Markdown 文档、测试、CLI、提交规范、仓库布局约束或 TypeScript 类型声明时。 |
| `../active/tui-e2e-standards.md` | active | TUI E2E/PTTY 测试标准、PTY harness、mock model server、真实终端覆盖边界 | 编写或修改 TUI E2E/PTTY 测试、调整 mock server 行为、新增真实终端场景。 |
| `../active/tui-textinput-wrapping-spec.md` | active | `CtrlSafeTextInput` 软换行、光标边界、IME 空格清理、CJK/ASCII 混合输入行为 | 修改 `CtrlSafeTextInput` 软换行、光标移动、IME 处理或 `maxWidth` 传播逻辑时。 |
| `../active/tui-run-status-bar.md` | active | Run Status Bar 3 阶段单向状态行 — Thinking → Working → Finishing 只进不退 + 渐变动画 + arc spinner + timer 性能架构 | 修改 `StatusBar.tsx`、`run-status.ts`、`App.tsx`（shouldShowRunStatus）、Footer.tsx 或相关测试时必读。 |
| `../active/tui-session-startup-card.md` | active | TUI 会话启动卡、Header 品牌信息与主界面就绪边界 | 修改 `Header.tsx`、启动卡布局、主界面 readiness 或相关 PTY 测试时必读。 |
| `../active/tui-footer-resize-stability.md` | active | TUI 终端缩放刷新方案 — resize 事件驱动 + key remount + 输入保留 + DEC 同步输出缓冲 | 修改 TUI resize 逻辑、缩放行为异常时必读。 |
| `../active/tui-dec-synchronized-output.md` | active | TUI DEC 同步输出缓冲 — `\x1B[?2026h/l` 帧刷新，消除 resize/会话切换的空白期和抖动 | 修改 `useStaticContent`、TUI 屏切换逻辑、缓冲/渲染时序时必读。 |
| `../active/cancel-resume-cleanup.md` | active | Cancel/Resume、Effect lease、工具消息对与 Subagent continuation | 修改取消、恢复、消息清理或 continuation 时。 |
| `../active/tui-no-viewport-culling.md` | active | TUI OutputArea 渲染逻辑、App 布局、block 可见性 | 修改 OutputArea.tsx 或 App.tsx 的渲染/overflow 逻辑，讨论视口剔除或虚拟滚动。 |
| `../active/tui-overlay-design-system.md` | active | TUI Overlay 四区骨架、内容 primitive、列表层级与交互词汇 | 修改通用 Overlay、MCP 管理页、选择器、帮助、审批、问答或方案审核表面时。 |
| `../active/tui-reference-stability.md` | active | TUI useStaticContent 引用稳定性 — ref+fingerprint 替代 useMemo 的缓存层，消除 timer/spinner 引发的引用级联和重复渲染 | 修改 `useStaticContent` 缓存逻辑、新增 OutputBlock 类型、怀疑重复渲染/性能问题时必读。 |
| `../active/tui-e2e-testing-limits.md` | active | PTY 能力、平台差异与测试分层边界 | 编写 TUI E2E、处理 PTY flaky 或选择测试层次时。 |
| `../active/layer-boundary-enforcement.md` | active | 三层架构分层边界强制：core 禁止导入 app/tui、禁止展示层格式化、中立数据类型规范 | **修改 `src/core/` 任何文件时必读**。新增 core 模块、添加 import、做文本截断/格式化时。 |
| `../active/plan-mode-implementation.md` | active | Plan Artifact、planning/building、plan_review 与恢复 | 修改 Plan 生命周期、工具、策略或 TUI 审核交互时。 |
| `../active/plan-artifact-lifecycle.md` | active | Plan Artifact 持久化、提交校验、审核交互与 Runtime 恢复边界 | 修改 `write_plan`、Plan review、Task 生命周期、Runtime Context、TUI/CLI 审核展示或会话恢复时必读。 |
| `../active/shell-platform-compatibility.md` | active | Shell 工具 Windows 兼容性、bash 选择策略、WSL 桩排除、vendored MSYS2 DLL 依赖 | 修改 shell.ts/bash-path.ts、调整 bash 选择逻辑、新增/升级 coreutils、排查 Windows shell 异常。 |
| `../active/session-logging-policy.md` | active | Session logger 的 off/metadata/content 组合、metadata allowlist 与正文禁止边界 | 修改 SessionLogCollector、日志事件映射、日志目录创建或 sessionLoggingPolicyV1 时必读。 |
| `../active/execution-platform-support.md` | active | 生产执行平台的原生能力探针、技术结论与治理准入矩阵 | 修改 sandbox backend、process-tree/network 边界、TUI/CLI 入口组合或平台发布支持声明时必读。 |
| `../active/execution-boundary.md` | active | Release-pinned ExecutionBoundaryV1、sealed qualification registry 与 production composition gate | 修改生产执行边界、sandbox capability projection、只读 fallback catalog 或 executionBoundaryV1 flag 时必读。 |
| `../active/windows-shell-sandbox.md` | active | Windows Shell 沙箱 — direct restricted-token、受管 Online 身份与 strict qualification 边界 | 修改 Windows execution backend、native runner、ACL/Job/ledger、受管身份、native 协议或 Windows filesystem/network/Full/fallback 边界时必读。 |
| `../active/file-reading-shared-boundary.md` | active | 文件读取共享边界 — `readTextContent` 单入口、BOM/编码检测、`isTextByte` 字节分类、换行正规化、MSYS2 路径双层转换 | 修改 `file.ts`/`shell.ts`/`path-utils.ts`、二进制检测、编码处理、文件读取失败排查时必读。 |
| `../active/authorization.md` | active | 授权溯源 — AuthorizationSource、ToolGrant.source/grantedAt、modeSource/modeGrantedAt、mode-policy 硬规则 | 修改授权状态类型、full_access 提升逻辑、mode-policy 时必读。 |
| `../active/workspace-trust.md` | active | Workspace 信任门禁 — TUI 启动授权确认、CLI `run` 门禁与 `--trust-workspace`、`~/.kite-code/workspace-trust.jsonc` 信任存储、无 env 旁路安全不变量 | 修改 TUI 启动流程、CLI 入口门禁、workspace 信任存储或测试 harness 信任预写时必读。 |
| `../active/feature-flags.md` | active | Runtime feature flag 注册、配置合并、CLI 临时覆盖和灰度生命周期 | 新增或调整 runtime 开关、auto-review rollout、配置字段时必读。 |
| `../active/failure-classification.md` | active | FailureKind 分类和 `ClassifiedFailure` 恢复策略 | 新增工具/模型失败路径、错误日志或重试策略时必读。 |
| `../active/runtime-resilience-qualification.md` | active | Runtime fault/soak 的固定 case、报告 schema、资源趋势与 qualification fail-closed 规则 | 修改 Runtime 恢复/持久化、故障注入、bounded soak runner 或 release 韧性证据时必读。 |
| `../active/core-entry-criteria.md` | active | 进入 core 的 Capability/Policy/Lifecycle/Engine 准入门槛 | 新增 `src/core/` 功能、状态机或执行引擎改动前必读。 |
| `../active/mcp-runtime-governance.md` | active | MCP/Skill revisioned catalog、Runtime binding、policy、execution record 与恢复边界 | 修改 MCP discovery、动态工具 binding、MCP policy、调用结果或 Skill Runtime 治理时必读。 |
| `../active/mcp-control-plane.md` | active | MCP Supervisor、generation 生命周期、不可变 control snapshot 与 TUI 只读状态视图 | 修改 MCP Manager/Supervisor 生命周期、control snapshot、Runtime provider 边界或 `/mcp` 状态视图时必读。 |
| `../active/mcp-config-management.md` | active | MCP 三层来源、原子 mutation、冲突检测、watch/reconcile 与 TUI 无配置写入边界 | 修改 MCP 配置路径/schema/repository、热重载或 TUI 配置职责时必读。 |
| `../active/mcp-authentication.md` | active | MCP 原生凭据保险库、静态引用、HTTP OAuth 与独立认证恢复提示 | 修改 MCP auth schema、Credential Store、OAuth lifecycle、callback/browser opener 或认证提示时必读。 |
| `../active/mcp-project-approval.md` | active | 项目 MCP 来源、config digest、本地决定、transport 前置门禁与 TUI 审批 | 修改 MCP 配置发现、项目来源、连接启动或 `/mcp` 审批交互时必读。 |
| `../active/verification-governance.md` | active | Runtime 分级验证、VerificationSpec、required 完成门禁、repair/waive/compensation | 修改验证策略、事件、效果、Scheduler 完成语义、Skill/MCP verifier 或 reviewer 时必读。 |
| `../active/capability-progressive-disclosure.md` | active | MCP/Skill 大目录按预算披露、metadata 搜索、下一轮有限 binding 与 fail-closed | 修改 capability catalog、模型工具上下文、`capability_search`、MCP binding 或 Skill activation 可见性时必读。 |
| `../active/release-control.md` | active | Release Profile、canonical artifact/evidence、Gate replay 与 disabled production 边界 | 修改 release manifest/profile、artifact verifier、Gate 或 rollout 时必读。 |
| `../active/open-source-first-release.md` | active | 单维护者开源首发的 G0/G1、候选包、真实 Provider smoke、能力默认关闭与状态权威 | 修改首发 Gate、候选 workflow、安装器、真实 Provider smoke 或 108 Task 状态时必读。 |
| `../active/agent-task-evaluation.md` | active | Agent task suite、oracle、重复运行、dogfood 与产品验收证据 | 修改 Agent task case、fixture、threshold、human review 或 evaluation adapter 时必读。 |
| `../active/observability-privacy-operations.md` | active | 无正文 metric、consent、dashboard/SLO、alert、incident 与单维护者运营 | 修改 observability、telemetry status、SLO/alert 或 incident rehearsal 时必读。 |
| `../active/compaction-release-qualification.md` | active | Compaction 结构/语义/continuation/route qualification 与 no-compaction handoff | 修改 compaction evaluator、route qualification、rollout 或 handoff 时必读。 |
| `../active/capability-release-tracks.md` | active | Verification、MCP write、Skills readonly/effectful profile、admission 与 maturity 边界 | 修改 capability profile、Verification release、MCP write 或 Skill effect 分类时必读。 |

## 理解记录

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `understanding/space-system-design.md` | understanding | 定义 `docs/space` 如何作为仓库本地记录系统工作。 |
| `understanding/2026-04-26-plan-state-context-projection.md` | understanding | 解释为什么将 `graph.state.plan` 作为运行时状态投影，而不是依赖工具消息历史或 system prompt。 |
| `understanding/2026-05-10-authorization-mode-switch-design.md` | understanding | 授权模式切换（default/full_access）的设计规范，包含 AuthorizationOverride 内存覆盖和 set_authorization_mode 工具的设计决策。 |
| `understanding/2026-05-11-three-layer-architecture-design.md` | understanding | 三层分离架构（protocol/core/app）设计规范，将 Agent 核心重构为纯逻辑库，支持 TUI/Desktop 多前端。 |
| `understanding/2026-05-12-tui-overhaul-design.md` | understanding | TUI 全面重构设计 — 交互式对话循环、流式 markdown 渲染、快捷键体系、slash 命令等 9 维度改版。 |
| `understanding/2026-05-17-sessions-command-design.md` | understanding | /sessions 会话列表、断点续接、智能命名、模型配置持久化设计。 |
| `understanding/2026-05-20-tui-known-issues.md` | understanding | TUI 已知问题清单：死事件类型、compacting 字段、recoverable 标志、手动 compaction 空壳、剩余未修复项。 |

| `understanding/2026-05-22-rewind-mcp-resources-design.md` | understanding | Rewind（Revert + Fork）和 MCP Resources 的设计规范。 |
| `understanding/2026-05-23-skills-system-design.md` | understanding | 旧 Skills 设计背景；当前 Skill Workflow 以 `docs/active/mcp-runtime-governance.md` 为准。 |
| `understanding/2026-05-24-multi-session-concurrency-design.md` | understanding | 多会话并发执行设计规范。 |
| `understanding/2026-05-26-tui-claude-code-parity-design.md` | understanding | TUI Claude Code 对标设计 — 布局重构、快捷键精简、功能补全、配置、主题、实施记录。 |
| `understanding/2026-05-30-multi-agent-design.md` | understanding | 多 Agent 架构设计 — Task Tool 模式、3 个内置角色（Explore/Code/Review）、星型拓扑、生命周期、审批策略、TUI 渲染。 |
| `understanding/2026-06-02-ink-rendering-scroll-selection-issue.md` | understanding | Ink 渲染机制导致的滚动和文本选择问题 — 根本原因分析、已尝试方案、可能解决方向。 |
| `understanding/2026-06-03-tui-block-turn-model-design.md` | completed | TUI 消息列表重构 — 引入 Turn 模型替代 flat OutputBlock[]，简化 Static/Dynamic 分割逻辑。 |
| `understanding/2026-06-08-prefix-cache-hit-rate-analysis.md` | understanding | 前缀缓存命中率分析 — DeepSeek KV cache 机制、前缀大小与命中率关系、当前 Kite Code 前缀构成、影响因素和优化方向。 |
| `understanding/2026-06-09-prompt-cache-optimization.md` | understanding | Prompt Cache 优化：合并 SystemMessage、清理死参数、修复 reasoning_content 注入 key 碰撞、TUI 缓存日志、子 agent 缓存震荡根因、对标 Claude Code/Codex/OpenCode 子 agent 结果回传机制。 |
| `understanding/2026-06-09-token-stats-persistence-design.md` | understanding | Token 统计持久化系统：手动统计（不依赖 provider）、SQLite 持久化跨重启保留、useEffect 自动保存消除 stateRef 滞后、getSnapshot 内存缓存消除回车卡顿。 |
| `understanding/2026-06-10-shell-concurrent-execution-design.md` | understanding | Shell 工具并发执行 + 批量审批流程 |
| `understanding/2026-06-28-thought-pre-consolidation-design.md` | understanding | Thought 预整合设计 — 探索工具合并为 tool_summary、ToolSummaryBlock 三态渲染、explorationSummaryIds 映射、与 SubAgentBlock 对齐。 |
| `understanding/2026-06-27-osc4-bold-bright-slot.md` | understanding | OSC 4 高亮调色槽发现：终端 bold 文本使用 slot 8-15，OSC 4 需同时重编程基础槽和高亮槽才能让 bold+color 文本跟随主题 |
| `understanding/2026-07-29-agent-production-feasibility.md` | understanding | 基于源码、默认 feature flags、确定性测试、PTY、本地/公网 MCP 和真实模型压缩实验，给出内部试用、受限灰度与全功能 GA 的可行性结论；并包含 `a316a2d` 合并增量的调度/schema/测试证据复核，路由至生产就绪 RFC。 |

## Backlog（工作待办）

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `backlog/README.md` | active | 定义 backlog 目录用途和使用规范。 |
| `backlog/tui-issues.md` | active | TUI 待修复项清单：已知缺口、清理方向、依赖项。 |
| `backlog/2026-06-01-deep-user-audit.md` | active | B14-B26 工程债务清单：死代码、缓存竞态、schema 臃肿、语言一致性等。 |
| `backlog/2026-06-08-product-experience-gaps.md` | active | B27-B33 产品体验缺口：跨会话记忆、Web Search、默认模型、Diff 渲染、Token 展示等。 |

## Plans（实施计划）

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `plans/README.md` | active | 定义 plans 目录用途、格式规范和生命周期。 |
| `plans/index.md` | active | 所有计划的全局注册表：状态、优先级、依赖、分叉关系。 |
| `plans/2026-07-29-agent-production-readiness-roadmap.md` | archived | ADR-0069 首发路线图已收口：G0/G1、83 completed、25 superseded、0 optional。 |
| `plans/2026-08-04-tui-overlay-design-system.md` | archived | Overlay contract、MCP、通用选择页、交互页及文档验证已完成。 |
| `plans/2026-05-20-tui-production-roadmap.md` | archived | TUI 生产就绪四步路线图：感知闭环 → 防御纵深 → 功能补齐。 |
| `plans/2026-05-22-production-gaps-closure.md` | archived | 生产就绪补齐 3 阶段方案。Phase1 ✅，Phase2 ✅，Phase3 ✅。 |
| `plans/2026-05-22-production-gaps-phase1.md` | archived | Phase 1 实施记录（8 commits）。MCP + 事件闭环 + 错误分类。 |
| `plans/2026-05-22-production-gaps-phase2.md` | archived | Phase 2 实施计划（7 tasks）。Rewind + MCP Resources。 |
| `plans/2026-05-22-skills-system.md` | superseded | 被 [`understanding/2026-05-23-skills-system-design.md`](../understanding/2026-05-23-skills-system-design.md) 替代。 |
| `plans/2026-05-23-skills-system-phase3.md` | archived | Phase 3 实施计划（Skills 系统，11 tasks）。 |
| `plans/2026-05-24-multi-session-concurrency.md` | archived | 多会话并发执行（3 tasks）。 |
| `plans/2026-05-25-e2e-restructure.md` | archived | E2E 测试套件重构（~71 tests，P0-P3 分层）。 |
| `plans/2026-05-26-tui-claude-code-parity.md` | archived | TUI Claude Code 全面对标（14 tasks）：布局、快捷键、功能、配置、主题。 |
| `plans/2026-06-17-background-subagent.md` | draft | 后台子 Agent — `background: true` 异步派发、SessionContext 容器、BackgroundTaskManager、跨 run 并发模型（8 phases）。 |
| `plans/2026-06-18-opentelemetry-observability.md` | superseded | 旧方案允许导出路径、命令和错误正文；被 2026-07-29 无正文可观测性计划替代。 |
| `plans/2026-06-18-kite-code-telemetry-collection.md` | superseded | 旧双通道 scrub 方案不满足 metadata-only 边界；被 2026-07-29 无正文可观测性计划替代。 |
| `plans/2026-06-18-session-logger.md` | archived | 会话日志当前实现的历史计划；生产 metadata/权限/保留迁移由 2026-07-29 Phase 1A 接管。 |
| `plans/2026-06-19-event-mechanism-refactor.md` | draft | 事件机制重构 — turn 边界、用户输入事件化、统一事件管道、子 agent 事件归一。 |
| `plans/2026-06-28-context-compaction.md` | active | 上下文压缩方案 — M0 TUI 预整合 + M1 Core 工具折叠 + M2 对话摘要（延后）。 |
| `plans/2026-07-14-mcp-runtime-governance-p0.md` | archived | MCP Runtime 治理 Phase 0 + 1：revisioned catalog、turn binding、fail-closed schema、policy 与结构化结果。 |
| `plans/2026-07-14-mcp-skills-runtime-governance-followup.md` | archived | MCP/Skills Runtime 治理 Phase 2–5：执行恢复、Workflow Contract、分级验证与 progressive disclosure。 |
| `plans/2026-07-15-mcp-project-server-approval-p0.md` | archived | MCP TUI 管理中心 Phase 0：项目来源识别、config digest、本地审批、transport 启动门禁与最小 TUI 审批入口。 |
| `plans/2026-07-15-mcp-tui-management-center-implementation.md` | superseded | MCP TUI 管理中心 Phase 0–2 保留为历史；UI 方向由只读计划替代。 |
| `plans/2026-07-16-mcp-tui-readonly-list.md` | archived | `/mcp` 只展示 effective MCP Server 名称与连接状态；配置和 project trust 移出该命令。 |
| `plans/2026-07-16-mcp-auth-phase3.md` | archived | MCP 原生凭据保险库、静态 credential reference、HTTP OAuth 与独立认证恢复提示。 |
| `plans/2026-07-26-tool-spec-registry.md` | archived | 工具单一事实源阶段 0/1 已完成；六个计算原语以 Registry 单路径运行，见完成记录。 |

## 完成执行记录

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `execution/completed/2026-08-04-single-maintainer-open-source-first-release.md` | completed | 记录单维护者开源首发路线图 G0/G1、统一 Review、真实 Provider、三平台候选与 83/25/0 终态收口。 |
| `execution/completed/2026-08-05-tui-overlay-design-system.md` | completed | 记录统一 Overlay primitives、MCP 视图拆分、选择器迁移和 component/PTY 验证。 |
| `execution/completed/2026-08-02-agent-production-admission-strategy-correction.md` | completed | 记录三平台发行与 effectful capability 正交准入、D-03 关闭和 DeepSeek blocked candidate；不提升 Task/milestone。 |
| `execution/completed/2026-04-26-plan-state-reminder.md` | completed | 记录把计划状态移动到尾部合成用户侧提醒的实现和验证。 |
| `execution/completed/2026-04-26-remove-stop-check.md` | completed | 记录移除最终答案 stop-check 和非危险模式确认门。 |
| `execution/completed/2026-04-26-remove-internal-ledgers.md` | completed | 记录移除 evidence/progress 账本和 watchdog 式进度推断。 |
| `execution/completed/2026-04-26-real-model-test-boundary.md` | completed | 记录真实模型测试从 Bun 默认发现中隔离，以及显式真实测试脚本修复。 |
| `execution/completed/2026-04-27-harness-engineering-doc-hygiene.md` | completed | 记录 `docs/space` 索引和生成文档边界的默认测试覆盖。 |
| `execution/completed/2026-04-27-documentation-language-standard.md` | completed | 记录仓库 Markdown 文档以中文为标准，并增加中文元数据检查。 |
| `execution/completed/2026-05-01-prompt-cache-runtime-state-research.md` | completed | 归档 DeepSeek prompt cache 标准、运行时状态投影实验、失败反例和最终消息布局结论。 |
| `execution/completed/2026-05-06-tool-description-contracts.md` | completed | 记录工具描述从功能字符串升级为结构化 ACI 契约的实现和验证。 |
| `execution/completed/2026-05-10-authorization-mode-switch.md` | completed | 记录授权模式切换功能的实现，包括 AuthorizationOverride、set_authorization_mode 工具、CLI --authorization-mode 标志和测试覆盖。 |
| `execution/completed/2026-05-16-remove-viewport-culling.md` | completed | 记录移除 TUI 视口剔除逻辑，让终端原生 scrollback 处理溢出；补齐 e2e 验证体系（88 个 e2e 测试、6 种严格断言类型、真实 agent 运行器）。 |
| `execution/completed/2026-05-17-sessions-command-implementation.md` | completed | /sessions 功能的完整实现记录 — 23 文件变更、SessionSelector 覆盖层、checkpoint 消息加载、中断恢复、智能命名、模型配置持久化。 |
| `execution/completed/2026-05-20-tui-production-roadmap.md` | archived | TUI 生产就绪四步路线图：感知闭环、防御纵深、手动 Compaction。 |
| `execution/completed/2026-05-22-production-gaps-closure.md` | archived | 生产就绪补齐 3 阶段统筹方案，Phase 1/2/3 全部完成。 |
| `execution/completed/2026-05-22-production-gaps-phase1.md` | archived | Phase 1: MCP 核心 + 事件闭环 + 错误分类（8 commits）。 |
| `execution/completed/2026-05-22-production-gaps-phase2.md` | archived | Phase 2: Rewind + MCP Resources（2 commits）。 |
| `execution/completed/2026-05-23-skills-system-phase3.md` | archived | Phase 3: Skills 系统，agentskills.io 标准（11 commits）。 |
| `execution/completed/2026-05-24-multi-session-concurrency.md` | archived | 多会话并发执行：SessionManager + SessionRuntime + Sidebar。 |
| `execution/completed/2026-05-25-e2e-restructure.md` | archived | E2E 测试套件重构：3 文件 ~71 tests，P0-P3 分层。 |
| `execution/completed/2026-05-26-tui-claude-code-parity.md` | archived | TUI Claude Code 全面对标：布局、快捷键、功能、配置、主题（14 commits）。 |
| `execution/completed/2026-05-28-static-header-ordering-fix.md` | completed | 修复 Ink `<Static>` 与 Header 顺序冲突，Header 注入 Static items 保持四层布局。（已被 2026-06-02 方案替代） |
| `execution/completed/2026-06-02-remove-static-react-memo.md` | completed | 移除 Ink `<Static>`，改用 React.memo block 组件 + 引用稳定 reducer。（已被 2026-06-03 方案替代） |
| `execution/completed/2026-06-03-restore-static-height-zero.md` | completed | 恢复 `<Static>` 渲染架构解决 Windows 输入卡顿，用 `<Box height={0}>` 消除布局空白。 |
| `execution/completed/2026-06-04-turn-model-refactor.md` | completed | Turn 模型重构 — 引入 `Turn` 替代 flat `OutputBlock[]`，将 Static/Dynamic 分割退化为 `slice(-1)`。 |
| `execution/completed/2026-06-23-agent-architecture-optimizations.md` | completed | edit_file 三级自动回退 + shell 输出截断 + sanitizeToolCallPairs 热路径移除（3 项优化，1 commit）。 |
| `execution/completed/2026-06-09-sqlite-reliability-optimization.md` | completed | SQLite 连接管理、写入可靠性、WAL 清理、会话列表索引优化。 |
| `execution/completed/2026-07-02-interaction-mode-slash-command.md` | completed | 阶段四：`/permissions` 交互模式快捷指令 + 审批面板重设计 + 命名重构 `interactive/auto_review/unattended` → `ask/auto/full`。 |
| `execution/completed/2026-07-02-execution-reliability.md` | completed | 阶段五：连续失败计数修复、耗尽信号 ToolMessage 注入、Gateway 预检拦截、写操作串行化、子 Agent Journal 集成。 |
| `execution/completed/2026-07-14-mcp-runtime-governance-p0.md` | completed | MCP Runtime 治理 Phase 0 + 1 完成记录：catalog、binding、schema、policy 与结构化结果。 |
| `execution/completed/2026-07-15-mcp-skills-runtime-governance.md` | completed | MCP/Skills Runtime 治理 Phase 2–5 完成记录：恢复、Skill Workflow、verification 与 progressive disclosure。 |
| `execution/completed/2026-07-15-mcp-project-server-approval-p0.md` | completed | MCP TUI 管理中心 Phase 0 完成记录：项目配置摘要审批、transport 门禁、保守 policy 与 TUI/PTY 闭环。 |
| `execution/completed/2026-07-15-mcp-tui-management-center-phase1.md` | completed | MCP TUI 管理中心 Phase 1 完成记录：Supervisor、generation 生命周期、不可变 control snapshot、typed diagnostics 与只读 TUI 管理中心。 |
| `execution/completed/2026-07-15-mcp-tui-management-center-phase2.md` | completed | MCP TUI 管理中心 Phase 2 完成记录：三层配置 repository、原子 mutation、热重载、增量 reconcile 与配置管理交互。 |
| `execution/completed/2026-07-16-mcp-tui-config-simplification.md` | completed | MCP TUI 配置体验校正：name + URL 的 local HTTP Wizard 与高级 JSONC 边界。 |
| `execution/completed/2026-07-16-mcp-tui-readonly-list.md` | completed | `/mcp` 收敛为无参数只读状态列表，项目配置摘要决定迁移为独立信任提示。 |
| `execution/completed/2026-07-16-mcp-auth-phase3.md` | completed | MCP Auth Phase 3：OS vault-only credential、HTTP OAuth、独立恢复提示与三平台原生 smoke。 |

## 参考资料

| 记录 | 状态 | 来源 |
| --- | --- | --- |
| `references/openai-harness-engineering.md` | reference | OpenAI 关于 Codex harness engineering 和仓库知识系统的文章。 |
| `references/opencode-codex-plan-handling.md` | reference | Opencode 与 Codex 计划处理方式的本地对比。 |
| `references/claude-code-codex-architecture-research.md` | reference | Claude Code 与 OpenAI Codex 多端架构对比调研 — 入口分离 vs App Server，对 Kite Code 的建议。 |

## 生成材料边界

| 记录 | 状态 | 用途 |
| --- | --- | --- |
| `generated/README.md` | generated | 定义生成材料的较低权威性和晋升规则。 |

## 维护规则

- 保持 `AGENTS.md` 简短，把它作为指向本索引的地图。
- 可能影响未来实现的记录必须包含状态、范围、相关记录和验证说明。
- 只有在形成具体本地规则，并且可行时配套测试后，才能把 generated 或 reference 记录晋升到 `../active/`。
- 退役过期 active 规则时，应更新记录状态，必要时移出 active，并补充说明理由的 completed 记录。
