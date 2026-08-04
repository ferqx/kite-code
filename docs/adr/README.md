# Architecture decision records

ADRs preserve decisions that alter runtime boundaries, lifecycle, policy, or execution engines. They are historical: do not rewrite an accepted decision; add a newer ADR and mark the old one superseded when necessary.

| ADR                                                    | Status     | Decision                                                                           |
| ------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| [0001](0001-runtime-kernel.md)                         | accepted   | Runtime Kernel is the state-transition authority                                   |
| [0002](0002-plan-lifecycle.md)                         | accepted   | PlanningState replaces the plan-reviewed boolean                                   |
| [0003](0003-auto-review-policy.md)                     | accepted   | Auto-review is policy-gated and feature-flagged                                    |
| [0005](0005-interaction-state.md)                      | accepted   | InteractionState owns waiting UI states                                            |
| [0006](0006-loop-mode-design.md)                       | proposed   | Loop mode requires a separate design decision                                      |
| [0007](0007-capability-bindings.md)                    | accepted   | Dynamic capabilities require revisioned turn bindings                              |
| [0008](0008-verification-completion-semantics.md)      | accepted   | Only required verification gates completion                                        |
| [0009](0009-project-mcp-local-approval.md)             | accepted   | 项目 MCP transport 必须获得绑定配置摘要的本地批准                                  |
| [0010](0010-mcp-supervisor-control-plane.md)           | accepted   | MCP 连接由 Supervisor 统一投影到 control snapshot                                  |
| [0011](0011-mcp-config-scopes-and-mutation.md)         | superseded | MCP 配置使用三层可写作用域、乐观冲突检测与显式 legacy 迁移                         |
| [0012](0012-mcp-tui-readonly-list.md)                  | superseded | TUI `/mcp` 只显示 effective Server 的连接状态与名称                                |
| [0013](0013-mcp-credential-store-and-oauth-session.md) | accepted   | MCP secret 只进入原生系统保险库，OAuth 由独立恢复提示显式启动                      |
| [0014](0014-mcp-tool-visibility-and-policy.md)         | accepted   | MCP Tool filter 与 policy 必须进入同一 revision，并按配置来源限制放宽能力          |
| [0015](0015-mcp-provider-availability-boundary.md)     | accepted   | Supervisor 向 Runtime 提供脱敏 Provider directory 与 typed failure                 |
| [0016](0016-mcp-provider-action-runtime-lifecycle.md)  | accepted   | Provider 恢复使用独立持久交互，成功后强制进入新 turn                               |
| [0017](0017-required-mcp-provider-admission.md)        | accepted   | unavailable required Provider 在首次模型调用前进入可 retry/waive/cancel 的会话门禁 |
| [0018](0018-mcp-tui-select-management-center.md)       | accepted   | MCP TUI 使用可见 Select 完成详情、添加、认证、审批和管理操作                       |
| [0019](0019-mcp-two-config-locations.md)               | accepted   | MCP 默认配置收敛为用户与项目两个规范位置                                           |
| [0020](0020-mcp-stable-on-demand-tool-loading.md)      | accepted   | MCP Tool 使用稳定目录、会话级按需加载与执行时连接检查                              |
| [0021](0021-context-compaction-checkpoint.md)          | accepted   | 上下文压缩采用事件驱动 checkpoint 模型，不直接改写 transcript                      |
| [0022](0022-context-compaction-single-narrative.md)    | accepted   | 上下文压缩采用单次 narrative 总结，不推断通用 Provider 400                         |
| [0023](0023-model-capabilities-no-builtin-catalog.md)  | accepted   | 模型能力不使用内置名称目录，只接受显式或运行时来源                                 |
| [0024](0024-context-compaction-manual-auto-only.md)     | accepted   | 上下文压缩只保留 manual/auto，token 比例不产生会话阻断                              |
| [0025](0025-model-requested-live-emission.md)          | accepted   | model.requested 即时发出（调用时 settle Thought 条款被 0030 取代）                 |
| [0026](0026-thought-text-header-merge.md)              | accepted   | 纯思考块关闭时并入文本题头（文本关闭 Thought 条款被 0030 取代）                    |
| [0027](0027-thought-carryover-non-text-boundary.md)    | accepted   | 思考延续跨过非探索工具边界，阶段边界后新建聚合继承思考标记                         |
| [0028](0028-runtime-action-facades.md)                  | accepted   | Runtime Action facade 模式，统一交互状态与调度控制                                  |
| [0030](0030-exploration-phase-block.md)                | accepted   | 只读探索阶段 = 单一存活块：模型调用不切分、文本吸收为块顶字幕、圆点全程动画        |
| [0031](0031-model-streaming-text-deltas.md)            | accepted   | 模型响应流式化：streamText + text/reasoning delta 事件，回答合成期间逐字可见       |
| [0032](0032-model-stream-reconnect-continuity.md)      | accepted   | 流式模型断线重连保留展示连续性，partial tool call 不进入 Runtime                   |
| [0033](0033-model-stream-reconnect-new-segment.md)      | accepted   | 模型流重连后冻结旧文本并新开一段，重放前缀只保留新增后缀                          |
| [0034](0034-model-streaming-default-on.md)              | accepted   | 模型流式响应默认开启，显式 false 时回退 generateText                              |
| [0035](0035-streamed-reasoning-establishes-thought.md)  | accepted   | 首个 reasoning delta 建立实时 Thought，保证 Thought 在回答之前                    |
| [0036](0036-streamed-text-outside-thought.md)           | accepted   | 流式文本冻结当前 Thought 后作为同级消息渲染                                       |
| [0037](0037-streaming-markdown-component-hierarchy.md)   | accepted   | 流式 Markdown 保持单一文档，并按稳定块级组件增量更新                              |
| [0038](0038-streaming-markdown-paragraph-components.md)  | accepted   | 流式 Markdown 普通文本按逻辑段落组件更新，空行和结构块封闭段落                    |
| [0039](0039-streaming-markdown-structural-child-components.md) | accepted | 表格、代码块、列表与引用按稳定子行组件更新                                  |
| [0040](0040-streaming-markdown-progressive-static-freeze.md) | accepted | 流式 Markdown 在安全组件边界渐进冻结，只保留动态尾段                         |
| [0041](0041-inspect-ls-thought-aggregation.md)        | accepted   | inspect 模式的单一只读 `ls` 纳入 Thought，复合 shell 语法保持独立工具卡          |
| [0042](0042-file-tool-semantics-and-write-safety.md)   | accepted   | 对齐 Claude Code：edit_file 强制先读后改，write_file 移除 append 自由覆写，checkpoint 兜底 |
| [0043](0043-tool-spec-registry-and-strict-edit.md)     | accepted   | 工具单一事实源（ToolSpec Registry）：模型表面全部 schema-only，shell 治理参数收敛，Edit 严格化 |
| [0044](0044-tool-spec-registry-single-path-cutover.md) | accepted   | 六个计算原语以 Registry 单路径收尾，删除从未接线的迁移 flag                         |
| [0045](0045-streaming-render-complete-block-commit.md) | accepted   | Thought 等终态一次展示，文本按完整 Markdown 顶层块提交                              |
| [0046](0046-atomic-streaming-component-progress.md)    | accepted   | 结构组件先闭合外壳，再按完整内部行渐进渲染                                         |
| [0047](0047-thought-label-single-consumption.md)      | accepted   | Thought 标签在阶段边界单次消费，边界后的探索聚合不重复继承                         |
| [0048](0048-durable-user-turn-cancellation.md)         | accepted   | 用户停止 turn 时先原子取消未终结工具，再传播 AbortSignal；task 保持可继续           |
| [0049](0049-effect-aware-read-scheduling.md)           | accepted   | 连续免审只读工具限流并行；TUI 只物化已开始、交互目标或终态失败的调用                |
| [0050](0050-client-specific-session-navigation.md)     | accepted   | TUI 切换会话映射为取消；支持后台运行的客户端切换视图时保留 Runtime 状态             |
| [0051](0051-release-profile-monotonic-composition.md)  | accepted   | Release Profile 使用正交 maturity/rollout 与按字段单调组合                         |
| [0052](0052-release-evidence-and-behavior-identity.md) | accepted   | Manifest、Evidence 与 Gate 绑定同一行为身份                                        |
| [0053](0053-local-single-user-first-topology.md)       | accepted   | 首发仅支持本地单用户拓扑，hosted 形态独立准入                                      |
| [0054](0054-production-execution-isolation.md)         | accepted   | 生产执行统一采用 sandbox、网络、受保护路径与 worktree 隔离                         |
| [0055](0055-cumulative-runtime-resource-governance.md) | accepted   | 父子 Agent 使用累计预算、原子并发许可与统一终态                                    |
| [0056](0056-metadata-first-data-boundaries.md)         | accepted   | 本地日志 metadata-first，telemetry 无正文，远程接收方独立治理                      |
| [0057](0057-compaction-release-qualification.md)       | accepted   | Compaction 发布资格使用结构、语义与 continuation 三层门禁                          |
| [0058](0058-agent-task-product-acceptance.md)          | accepted   | Agent task、diff、test 与 review 是产品验收主证据                                  |
| [0059](0059-optional-disable-only-signed-rollout.md)   | accepted   | 远程 rollout manifest 可选且只能签名降级                                           |
| [0060](0060-single-maintainer-release-governance.md)   | accepted   | 单人维护模式以 external release 前第三方安全评审替代 Phase 0 双人签署               |
| [0061](0061-production-platform-capability-admission.md) | accepted | 生产平台能力必须由原生探针逐项准入，当前支持集合为空                              |
| [0062](0062-keyless-release-signing-and-github-hosting.md) | accepted | 开源发布使用 GitHub OIDC、keyless Sigstore 与 GitHub Releases；private 阶段仅 synthetic |
| [0063](0063-no-content-observability-and-single-maintainer-operations.md) | accepted | 生产遥测无正文且默认关闭；单维护者运营无数据/Owner 不可用时 fail closed |
| [0064](0064-conservative-skill-effects-and-capability-profile-admission.md) | accepted | Skill unknown effect 保守归 effectful；Capability Profile 同时验证 flags、依赖、identity 与 G3–G5 |
| [0065](0065-cross-platform-distribution-and-capability-admission.md) | accepted | Windows/Linux/macOS 发行与 effectful execution capability 分开准入 |
| [0066](0066-deepseek-owner-accepted-provider-data-policy.md) | accepted | 单维护者接受官方 DeepSeek 精确 Route 的已披露数据政策风险 |
| [0067](0067-single-maintainer-candidate-security-review.md) | accepted | 单维护者以 candidate-bound 自审批准发布；第三方评审为可选增强 |
| [0068](0068-single-maintainer-open-source-first-release.md) | accepted | 首个开源版本只使用 G0 本地安全与 G1 普通三平台/真实 Provider Gate；企业认证和长期 maturity 转为发布后可选 |
| [0069](0069-first-release-terminal-scope.md) | accepted | 首发路线以 G0/G1 为终态；取消 cohort/SLO/rollout/promotion 后续资格，108 Task 收敛为 83 completed、25 superseded |
