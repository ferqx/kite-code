# ADR-0123：Runtime Modularization V1 建立新的架构权威

状态：accepted

日期：2026-08-20

决策者：用户直接指令

相关：Runtime Modularization V1 RFC、ADR-0105、ADR-0110、ADR-0111、ADR-0117、ADR-0119

## 背景

Kite 当前 Runtime 已形成 Runtime Kernel、Tool Pipeline、Model Gateway、受治理 Provider seam、SQLite Store、MCP、Skill、Subagent、Verification 与 TUI SessionRuntime，但这些权威仍位于单 package 和多处组合根中。Runtime Modularization V1 将进行跨 Client、Host、Kernel、Provider、Storage 与 Builtin 的整体边界重构，不是对现有物理结构的小范围演进。

三方独立评测使用现有 ADR 检查目标方案时，把 ADR-0110、ADR-0111 与 ADR-0119 的当前 ownership 和 fallback 结论视为接受阻塞。用户明确决定：本轮大重构不需要人工审阅，也不以现有 ADR 是否兼容作为方案审核门槛。现有 ADR 继续记录当前实现历史与迁移前行为，但不能否决新的目标架构。

仓库仍需保留架构决策历史。因此本 ADR 不改写既有 ADR，而是建立 Runtime Modularization V1 的新权威，并明确替代范围。

## 决策

1. `docs/design/2026-08-19-kite-runtime-modularization-v1-rfc.md` 由用户直接指令接受。三方评测 finding 转为实施契约、负向测试和阶段 Gate，不再要求额外人工 reviewer 签署。
2. 现有 ADR 不是该 RFC 的接受门槛。它们只约束尚未迁移的当前 production path；当某个 operation 按实施计划切换到目标 owner 后，以本 ADR、accepted RFC 和该阶段同步更新的 active 文档为准。
3. Governed Invocation Pipeline 是跨边界生命周期：
   - Agent Kernel 拥有纯 validate、classify、Policy、approval、intent、grant、recovery、verification 与 completion decision；
   - Runtime Host 拥有 binding arbitration、canonical projection、事务、grant exact materialization、Effect supervision、Receipt normalization 与 Notification projection；
   - Capability Provider 只执行已密封的 request + grant，并返回 receipt。
4. 上一条替代 ADR-0110 / ADR-0111 中把 Policy、approval 与 sealed grant 的物理 authority 固定在现有 Tool Pipeline / Local Provider seam 的部分；single pipeline、intent-before-dispatch、attempt acknowledgement、sealed grant、receipt-before-terminal、unknown recovery 与 Provider no-state-authority 继续作为目标不变量。
5. Execution environment 必须在 approval 前投影。选择 `native` 后发生 unavailable 时返回 typed failure，不在 approval 后自动切换 `host_shell`；`host_shell` 如被选择，必须是独立展示、独立 ceiling 和独立 grant 的 environment。本条替代 ADR-0119 的 post-approval availability fallback。
6. Project identity 由 bootstrap / Runtime Host 根据 canonical Workspace 和安装级 ProjectIdentityStore 生成并验证。Client 不能选择或伪造 `projectId`。V1 不支持 Runtime composition rebind。
7. PlatformCapabilityFacts 只能来自 sealed execution-boundary qualification projection；Kernel 只消费 versioned、canonical、digest-bound facts。Host 不能自行声明平台能力或扩大 grant。
8. ContextSource 是对静态 registration 或已授权 Observation / Artifact 的有界、无外部 I/O 投影。Filesystem、network、MCP、credential 或其他新数据 acquisition 必须先进入 Observation Intent / Grant / Receipt。Context Compiler 可选择内容，但 Egress authority 仍由 Kernel 决定，Host 只物化和执行。
9. Fork / Rewind 的 Session/storage orchestration 归 Host，Agent State transformation 归 Kernel。Source 存在 unknown effect、未确认 cleanup 或 writer fence 时，同一 Workspace 的 Fork、Rewind 或 successor 必须 fail closed。
10. RuntimeCompositionIdentity 覆盖 Runtime/Store schema、Project/Workspace、Kernel/Policy、Platform/execution boundary、Provider/Capability/Context、MCP、Model route/data policy、Credential broker 与 Artifact namespace identity。
11. 目标精确格式为 Runtime State schema `26`、Runtime Store schema `5`、epoch `kite-runtime-modularization-v1-2026-08-19`。新 Store 使用独立数据库路径；旧 Store 不修改、不双写、不在线迁移。
12. 实施以 `docs/space/plans/2026-08-19-kite-runtime-modularization-v1-implementation.md` 为入口。每个 operation 必须只有一个 production owner；Legacy Adapter 是显式阶段 owner，不是失败 fallback。自动化 contract、dependency、authority、journey、replay、fault、soak 与文档门禁替代人工审阅 Gate。

## 替代范围

- ADR-0110：仅替代 Policy/approval/grant 必须由当前 Tool Pipeline 物理对象拥有的解释；其提交顺序和恢复不变量保留。
- ADR-0111：仅替代 sealed grant 必须由当前 Tool Pipeline seam 签发的物理 ownership；sealed、single-use、bounded receipt 与 Provider no-state-authority 保留。
- ADR-0119：替代 approval 后 native unavailable 可切换 Host Shell 的决定；迁移前当前路径仍按 active 文档运行，RMV1-14 切换时同步更新 active 文档和测试。

其余既有 ADR 不是该目标设计的审核前置；其中仍需保留的行为必须由实施阶段的 parity、negative test 与 active 文档明确承接，不能仅因历史 ADR 存在而自动进入新架构。

## 后果

- RFC 可以标记为 `accepted`，实施计划可以标记为 `active`，无需等待额外人工 reviewer 或旧 ADR 逐项兼容确认。
- 三方评测发现的 substantive security / storage / recovery 问题仍是必须实现和自动验证的契约；取消人工审阅不等于取消安全边界。
- 当前 production 行为不会因文档状态立即改变。每个垂直 slice 切换时必须同步更新对应 active 文档，且不得保留旧/new runtime fallback。
- 若实现需要改变本 ADR 冻结的四边界、environment projection、identity 或 format 决定，必须新增后续 ADR，而不是在代码中静默偏离。
