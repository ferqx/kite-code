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
| [0041](0041-inspect-ls-thought-aggregation.md) | superseded by ADR-0163 | TUI命令前缀分类已删除；探索展示改由Service投影 |
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
| [0053](0053-local-single-user-first-topology.md)       | partially superseded by ADR-0144/0147/0149 | 保留单本地用户与 hosted/remote No-Go；本地 Web Observer由ADR-0147、stable local Agent API consumer由ADR-0149局部扩展 |
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
| [0070](0070-sandbox-git-access.md) | superseded by ADR-0097 | 历史 seatbelt git allow 决策；brokered Git 迁移前当前行为仍以源码和 active 文档为准 |
| [0071](0071-tui-local-interaction-recovery-projection.md) | accepted | TUI 对崩溃遗留交互使用本地恢复投影，源 Runtime canonical state 保持真实 |
| [0072](0072-windows-shell-appcontainer-sandbox.md) | accepted | Windows Shell 候选采用 Classic AppContainer、Job Object 与 native launcher |
| [0073](0073-windows-shell-private-workspace-staging.md) | accepted | Windows Shell 仅运行于私有 Workspace staging，并以拒绝式差异回写保护动态敏感路径 |
| [0074](0074-windows-10-api-compatibility-baseline.md) | accepted | Windows Shell makes Win10 22H2 an API/build baseline and prioritizes Win11 native evidence |
| [0075](0075-app-shell-availability-downgrade.md) | accepted | App Shell uses host Bash when its native sandbox backend is unavailable |
| [0076](0076-tui-sandbox-startup-and-fail-closed-shell.md) | accepted | TUI preflights native sandbox at startup and never downgrades Shell to host execution |
| [0077](0077-unified-sandbox-startup-downgrade.md) | accepted | TUI and CLI cache one sandbox preflight decision and fall back to Bash/cmd/PowerShell without replaying user scripts |
| [0078](0078-responsive-appcontainer-staging-and-private-bun-runtime.md) | accepted | AppContainer staging runs off the TUI thread and Bun is copied into each private invocation runtime |
| [0079](0079-windows-managed-restricted-token-sandbox.md) | accepted | Windows Shell adopts a managed restricted-token backend while retaining dynamic protected-path safeguards |
| [0080](0080-sandbox-environment-only-host-fallback.md) | accepted | Host Shell fallback is limited to sandbox-environment unavailability, not staging admission rejection |
| [0081](0081-codex-style-unelevated-direct-workspace-backend.md) | accepted | Windows 默认开发 Shell 使用无 UAC restricted-token 直接 Workspace 后端；严格配置仍未获资格 |
| [0082](0082-windows-development-network-authorization-parity.md) | accepted | Windows development Shell 对齐逐调用网络审批，并保持 restricted-token 为低保证后端 |
| [0083](0083-windows-approved-network-managed-logon.md) | accepted | Windows 已审批联网调用切换到专用登录会话，保持 restricted token 并修复 Schannel |
| [0084](0084-windows-sandbox-explicit-onboarding.md) | accepted | Windows 受管联网身份采用显式首次 onboarding；普通 Shell invocation 不触发 UAC |
| [0085](0085-windows-schannel-online-acl-lease.md) | accepted | Windows Schannel 联网调用使用 Online 非管理员令牌、protected-path deny 与临时 ACL lease |
| [0086](0086-windows-managed-online-read-roots.md) | accepted | Windows Online 身份在显式 setup 中配置非敏感 profile read roots，命令期不改写祖先 ACL |
| [0087](0087-tui-silent-startup-prewarm.md) | accepted | TUI 启动期静默沙箱预热：trust/config 解析后即触发，退出可中止、并发无残留 |
| [0088](0088-remove-windows-appcontainer-backend.md) | accepted | 移除 Windows AppContainer、私有仓库 staging 与 reconciliation，只保留 direct restricted-token backend |
| [0089](0089-windows-online-loopback-proxy-inheritance.md) | accepted | Windows 已审批 Online Shell 安全继承发起用户的无凭据 loopback WinINet 代理 |
| [0090](0090-manual-compaction-convergence-and-viability.md) | accepted | 手动压缩在 Provider 前验证最大收益、串行同 session lifecycle，并以 stale 终态收敛 |
| [0091](0091-runtime-store-compaction-ownership.md) | accepted | RuntimeStore effect lease 与 revision CAS 阻止重复压缩、stale 覆盖和删除后复活 |
| [0092](0092-prompt-contract-v2.md) | accepted | 模型上下文分层加载项目指令、投影真实 Runtime 状态，并仅采用可信 Capability 描述 |
| [0093](0093-opencode-go-release-provider-smoke.md) | accepted | G1 第二条真实 Provider smoke 从阿里千问 Token Plan 迁移到固定 OpenCode Go route |
| [0094](0094-prompt-contract-v2-default-migration.md) | superseded by ADR-0098 | 取消固定十四日等待，并因当时最终候选任务成功率回退而保持 Prompt Contract V2 默认关闭 |
| [0095](0095-runtime-completion-truth.md) | accepted | Runtime CompletionGuard 统一任务与计划完成真值，拒绝 final 文本绕过 canonical lifecycle |
| [0096](0096-tool-outcome-recovery-and-journey-evaluation.md) | accepted | Runtime 统一 typed outcome/recovery 权威，并以完整 Journey 评测工具质量 |
| [0097](0097-brokered-git-capability.md) | partially superseded by ADR-0134/0160 | internal Git broker保留；模型Git命令恢复为统一Shell治理入口 |
| [0098](0098-prompt-contract-v2-default-enabled.md) | accepted | 修正后的真实 A/B、项目规则 effect 与 Runtime 纠错 Journey 通过，Prompt Contract V2 默认启用并保留 legacy 回滚 |
| [0099](0099-phase-stable-tool-disclosure.md) | accepted | V2 builtin/MCP 声明跨 Planning/Building 稳定，提示词引导只读行为，Runtime Policy 返回 phase 错误并阻止副作用 |
| [0100](0100-user-approved-external-filesystem-capability.md) | accepted | 用户审批的逐 invocation 外部文件系统能力由原生 sandbox 执行 |
| [0101](0101-approved-invocation-native-guards-and-network-projection.md) | accepted | 审批能力必须可兑现，并保留凭据与持久身份的原生固定保护 |
| [0102](0102-runtime-issued-subagent-execution-context.md) | accepted | Subagent 继承 live mode 与 canonical Workspace，read-before-edit 按 actor 隔离 |
| [0103](0103-model-owned-subagent-orchestration.md) | accepted | Subagent 委派选择归模型，执行权限继续由既有 Runtime Policy 治理 |
| [0104](0104-bounded-concurrent-subagent-dispatch.md) | accepted | 同一模型响应中的独立 Subagent 有界并发，动态审批按 continuation 逐个呈现 |
| [0105](0105-pre-release-runtime-format-and-convergence-boundary.md) | accepted | 预发布 Runtime 只接受当前格式，收敛以删除权威与错误依赖为准 |
| [0106](0106-tool-invocation-boundary-convergence.md) | accepted | Tool execution 收敛到 Registry 与唯一 governed invocation pipeline |
| [0107](0107-runtime-payload-and-recovery-integrity.md) | accepted | 当前 event、snapshot、WAL 与嵌套 continuation 在写入或 dispatch 前严格校验 |
| [0108](0108-residual-runtime-authority-convergence.md) | accepted | 删除严格恢复、Planning、Approval 与 Tool terminal 的残余双轨权威 |
| [0109](0109-model-invocation-evidence-and-replay.md) | accepted | 五类模型调用使用冻结 Model Surface、ack-before-attempt、私有证据与严格无 live fallback Replay |
| [0110](0110-tool-pipeline-commit-boundaries.md) | accepted | Tool execution 使用唯一类型状态 Pipeline、intent/receipt 原子边界与 unknown recovery |
| [0111](0111-governed-local-provider-seams.md) | accepted | Filesystem、Sandbox、Subagent 使用 sealed grant 的受治理 Local Provider seam |
| [0112](0112-keyless-model-replay-evaluation-governance.md) | accepted | Keyless 模型 Replay 使用受审查 synthetic cassette、显式 suite authority 与风险覆盖准入 |
| [0113](0113-descriptor-relative-workspace-mutation-publication.md) | accepted | Workspace mutation 使用 descriptor-relative native 发布；无安全后端的平台 fail closed |
| [0114](0114-stable-subagent-actor-identity-for-strict-replay.md) | accepted | Strict Replay 的 child actor ID 由稳定 parent Model invocation、task tool call、outer Task/capability attempt 与 role 派生；capability identity 仍只用于 sealed grant |
| [0115](0115-ps03-deterministic-synthetic-replay-qualification.md) | accepted | PS-03 propagation qualification 使用确定性 synthetic in-memory record→fresh strict replay；不需要 live record authority、API credential 或持久化/人工 cassette |
| [0116](0116-ps02-github-actions-native-evidence-authority.md) | accepted | PS-02 原生平台资格证据由 GitHub-hosted 原生 OS matrix 与不可变 artifact/Required verifier 提供；本地非目标 OS 不是实现 blocker，不自动提升 production support |
| [0117](0117-production-runtime-format-cutover.md) | accepted | Production Runtime 切换到 v25 新 epoch，并删除迁移期兼容权威与旧 dispatch 入口 |
| [0118](0118-trusted-workspace-unrestricted-file-access.md) | accepted | 文件读取默认不限路径；受信任 Workspace 内文件可直接编辑，外部 mutation 只在批准前受限 |
| [0119](0119-acknowledged-host-shell-availability-fallback.md) | accepted | 已确认 Tool 调用可在 native backend 启动前不可用且 cleanup 已确认时降级 Host Shell；已启动或 cleanup unknown 绝不重放 |
| [0120](0120-windows-strict-appcontainer-profile.md) | accepted | Windows strict Full 候选使用临时 AppContainer profile，不恢复仓库 staging |
| [0121](0121-windows-development-full-mode.md) | accepted | 已选 direct restricted-token backend 可使用开发期 Full，不改变 production 资格 |
| [0122](0122-windows-handle-locked-workspace-mutation.md) | accepted | Windows Workspace mutation 用 directory-handle lock 安全发布 |
| [0123](0123-runtime-modularization-authority-cutover.md) | accepted | Runtime Modularization V1 建立 Client/Host/Kernel/Provider 新权威，现有 ADR 不再作为重构方案审核门槛 |
| [0124](0124-runtime-modularization-staged-delivery.md) | accepted | 将 Runtime 物理模块化与 Authority/Format 升级拆为连续 RMV1/RAV1，并采用 runtime-spi、builtin-runtime 包边界 |
| [0125](0125-accepted-rfc-staged-revision.md) | accepted | 允许将 ADR-0124 的分期事实同步回 accepted RFC，并以新摘要标识当前接受版本 |
| [0126](0126-remove-runtime-installation-authority-key.md) | superseded by ADR-0127 | 删除长期 Runtime installation key；其保留的 ProjectHandle/child material/authority ledger 后续继续删除 |
| [0127](0127-remove-rav1-speculative-authority.md) | accepted | 删除 ProjectHandle/single-Host lock、内部密钥/HMAC、伪 provenance/egress ledger 与固定 Provider policy，仅保留真实边界 |
| [0128](0128-pre-release-clean-cutover-module-boundaries.md) | accepted | 未发布阶段采用无版本命名 clean cutover、领域 subpath 与唯一 composition root；版本只作为 metadata |
| [0129](0129-sqlite-runtime-log-query-boundary.md) | partially superseded by ADR-0147 | 保留 SQLite/query-only/safe projector 边界；本地只读 Gateway 由 ADR-0147 冻结 |
| [0130](0130-source-based-architecture-gates.md) | accepted | 架构门禁直接验证源码，不提交生成快照或迁移清单 |
| [0131](0131-whole-workspace-sandbox-admission.md) | accepted | Sandbox 将 canonical Workspace 作为完整授权身份，不再按内部路径名称拒绝 |
| [0132](0132-sensitive-external-paths-use-exact-approval.md) | accepted | Workspace 外敏感路径进入 exact approval；批准后 native sandbox 不再二次拒绝 |
| [0133](0133-mode-aware-sensitive-external-authorization.md) | accepted | 外部敏感访问按 Full、Auto 与普通模式分别直接授权、模型三态审查或请求用户审批 |
| [0134](0134-closed-read-only-git-shell-grammar.md) | partially superseded by ADR-0136/0160 | status/log grammar恢复可证明只读免审；typed Git不再进入模型工具面 |
| [0135](0135-mode-aware-workspace-authorization-boundary.md) | partially superseded by ADR-0136 | 文件工具边界保留；Shell/Git 的 Workspace grammar 直通已取消 |
| [0136](0136-mode-governed-shell-without-command-allowlists.md) | accepted | Raw Shell 不再由固定命令 grammar 免审；统一按 Accept Edits、Auto、Full 治理 |
| [0137](0137-shell-sandbox-durable-approval-queue.md) | partially superseded by ADR-0160 | durable queue/sandbox保留；未知Shell baseline改为exact真人审批 |
| [0138](0138-silent-session-format-compatibility.md) | accepted | 未知历史格式静默忽略；已知会话按选择懒迁移并剥离旧权限 |
| [0139](0139-session-admission-restart-reconciliation.md) | accepted | Session admission 先完成跨进程 cleanup/recovery，再重载事件尾并投影终态 |
| [0140](0140-workspace-documentation-authority-v2.md) | accepted | Workspace README/本地文档拥有模块规则，active 只拥有跨包当前行为，影响门禁按真实 diff 检查 |
| [0141](0141-test-ownership-and-layered-execution-v2.md) | accepted | 测试按 package、App、integration、qualification 与 isolated 归属，并采用分层并行执行 |
| [0142](0142-runtime-server-client-protocol-boundary.md) | partially superseded by ADR-0144/0147/0149 | 保留private Protocol/Server/Client/receipt边界；Worker/Web拓扑与独立stable local Agent API façade由后续ADR冻结 |
| [0143](0143-local-runtime-presentation-fidelity.md) | accepted | 本地 Client DTO 保留 reasoning、工具参数与结果；完整历史与 live 使用同一 reducer |
| [0144](0144-local-runtime-service-and-multi-workspace-admission.md) | partially superseded by ADR-0147 | 保留 single-user/Trust/capability/recovery 约束；全局 Service/Host/Store topology 由 Coordinator/Worker 分片取代 |
| [0145](0145-workspace-trust-binds-external-read-scope.md) | accepted | Workspace Trust 在 Runtime 连接前绑定并显示关联 external-read roots；授权不依赖命令名 |
| [0146](0146-workspace-scope-reauthorization-convergence.md) | accepted | Workspace scope不匹配时刷新并重新授权，不升级App/Service/manager跨层兼容门禁 |
| [0147](0147-kite-coordinator-workspace-worker-read-only-web.md) | partially superseded by ADR-0152/0155 | 历史Coordinator/Worker拓扑由single-Service取代；Browser保持只读，但独立companion data plane由Web REST client取代 |
| [0148](0148-workspace-store-layout-generation-migration.md) | accepted | Store 7/新 epoch 采用 Workspace binding、deleted-session tombstone 与 offline copy-and-switch；unknown/corrupt/unowned 整体阻断 |
| [0149](0149-stable-local-agent-api-facade.md) | partially superseded by ADR-0155 | Stable local REST/SSE façade与no remote/mutation保留；Browser可通过独立cookie principal消费只读`/v1` |
| [0150](0150-store-8-canonical-runtime-run-index.md) | accepted | Store 8以canonical Run index、receipt resource result与coverage boundary支撑first-class Run；Store 7历史不推断回填 |
| [0151](0151-web-gateway-preflight-and-exact-launch-recovery.md) | accepted | Web Gateway在state/spawn前验证asset，并以PID/start-token绑定launch intent与显式recover |
| [0152](0152-single-service-single-sqlite-kite-home.md) | partially superseded by ADR-0153/0154/0159/0166 | 单SQLite/typed Artifact成果保留；全局单Service/Host ownership由ADR-0166替代为per-Session execution fencing |
| [0153](0153-filesystem-preimage-remains-a-private-artifact-domain.md) | accepted | Filesystem mutation preimage保持独立typed Artifact表，不与Runtime checkpoint preimage或Capability result混用 |
| [0154](0154-pre-release-store9-clean-cutover.md) | accepted | 未发布Store 9采用clean cutover；正式路径不迁移或清理旧布局，Web status保持只读 |
| [0155](0155-single-service-web-rest-client-convergence.md) | partially superseded by ADR-0156/0159/0166 | Browser只读`/v1`与principal保留；default Service Web ownership由ADR-0166取消 |
| [0156](0156-service-owned-web-root.md) | partially superseded by ADR-0157/0166 | root/static配对只保留给显式daemon；default local不再拥有Web listener |
| [0157](0157-canonical-web-root-direct-bootstrap.md) | partially superseded by ADR-0158/0166 | daemon `GET /`与cookie语义保留；default local Web root取消 |
| [0158](0158-local-web-root-session-without-launch-token.md) | partially superseded by ADR-0166 | read-only root cookie保留给显式daemon；不再由每个local App Server提供 |
| [0159](0159-compatible-clients-share-single-service.md) | partially superseded by ADR-0164/0165/0166 | 历史build discovery规则仅用于迁移；default local改为同build App Server |
| [0160](0160-uncertain-shell-requires-exact-approval.md) | accepted | 未知Shell effects请求exact用户审批；模型脚本统一走Shell；执行前拒绝不再折叠为失败 |
| [0161](0161-versioned-shell-semantics-and-read-only-trial.md) | partially superseded by ADR-0162 | 保留revision-bound Shell语义注册表；严格只读试跑grant由ADR-0162删除 |
| [0162](0162-remove-read-only-trial-grant.md) | accepted | 删除严格只读试跑grant；unknown Shell恢复正常exact审批，registry继续演进 |
| [0163](0163-service-owned-exploration-presentation.md) | accepted | Service唯一投影探索展示分类；TUI删除Shell前缀解析与历史重聚合路径 |
| [0164](0164-active-candidate-service-build-convergence.md) | partially superseded by ADR-0165/0166 | 现有换代保护保留至cutover；default local完成后删除build convergence控制面 |
| [0165](0165-source-tui-standalone-service-topology.md) | superseded by ADR-0166 | 临时进程隔离保留为参考；临时Store/History与source/installed拓扑差异被取消 |
| [0166](0166-decouple-app-server-process-from-durable-session-authority.md) | accepted | Client启动同build App Server；Session独立持久并按Session writer fencing；daemon/Web显式化 |
