# Agent 生产化 Phase 0 治理完成记录

状态：completed
日期：2026-07-30
计划：
[`2026-07-29-agent-production-governance-decisions.md`](../../plans/2026-07-29-agent-production-governance-decisions.md)
实现提交：`4be8735b29ec0fe3951bf7a0876f7b5e722c846a`
执行者：`github:@ferqx`
治理模式：`single-maintainer`（ADR-0060）

## Gate 决策

本记录是 Task 0.5 Phase 0 评审记录，唯一产生 `MS:M0`。

结论：`approved_for_internal_implementation`。

该结论只允许依赖已满足的后续 Task 进入内部实现，不生成 `limited-production` artifact，不允许
external cohort，也不构成 `MS:LIM-APPROVED`。single-maintainer 模式在 external release 前
仍必须取得由不同真人完成、绑定 candidate behavior identity 的第三方安全评审；G0/G1 无普通
waiver。

## Task 0.1：Owner 与决策记录

- artifact：
  `docs/space/plans/2026-07-29-agent-production-decision-register.md`
- commit：`4be8735b29ec0fe3951bf7a0876f7b5e722c846a`
- 结果：D-01–D-14 唯一且字段完整；六类 Owner 均为 `github:@ferqx`，不存在的 backup 显式为
  `none (single-maintainer)`。
- Phase 0 blocking 决策 D-02/D-08/D-09/D-11/D-12/D-13/D-14 已关闭。
- 仍 open 的 D-01/D-03/D-04/D-05/D-06/D-07/D-10 均未到 blocking phase，并保留严格默认：
  capability/telemetry/route/support/artifact/product Gate 维持 off、空集合或 blocked。
- 文档影响：新增规范 decision register；未改变 Runtime 当前行为，无 `docs/active/` 更新。

## Task 0.2：架构 ADR

- artifact：ADR-0051–ADR-0060 与 `docs/adr/README.md`
- commit：`4be8735b29ec0fe3951bf7a0876f7b5e722c846a`
- 结果：Release Profile、behavior identity、本地单用户拓扑、执行隔离、累计资源治理、数据边界、
  compaction qualification、产品验收、disable-only rollout 与 single-maintainer 治理均为
  `accepted`。
- rollback：错误决定只能由新 ADR 替代，不改写本批 accepted ADR 的历史结论。
- 文档影响：RFC §16/§20/§22/§23 与对应子计划已同步。

## Task 0.3：共享 schema ownership

- artifact：Phase 0 schema owner 表及 1A/1B/1C/2A/2B/3/4 计划入口。
- commit：`4be8735b29ec0fe3951bf7a0876f7b5e722c846a`
- 结果：
  - 1A 唯一生产 `ProviderDataPolicyV1`；
  - 1B 唯一生产 `ExecutionBoundaryV1`；
  - 1C 唯一生产 `ResourceBudgetV1`、`RuntimeSchedulingPolicyV1` 和 terminal/failure reason；
  - 2A 唯一生产 `ReleaseProfileV1`、`ReleaseManifestV1`、`ReleaseEvidenceV1`；
  - 2B、3、4 分别拥有 Agent task、metrics allowlist、compaction/route qualification。
- rollback：owner 变化新增审批 revision；consumer 不复制 producer schema。
- 文档影响：只冻结未来实现边界，不改变当前 schema 或持久化数据。

## Task 0.4：计划执行门禁

- artifact：`scripts/check-plan-execution-matrix.ts`、`scripts/check-docs.ts`、全部生产计划与
  `docs/space/plans/README.md`。
- commit：`4be8735b29ec0fe3951bf7a0876f7b5e722c846a`
- 结果：10 个计划、108 个 Task、14 项决策通过 Task/正文映射、依赖语法、跨计划引用、环检测、
  milestone producer、完成记录路径、single-maintainer 和 ADR 状态检查。
- rollback：不得通过删除字段或停用门禁恢复不可解析计划。
- 文档影响：`bun run check:docs` 已包含计划治理门禁。

## Task 0.5：M0 角色评审

single-maintainer 按角色逐项签署：

| 角色 | Identity | 结论 |
| --- | --- | --- |
| Release Owner | `github:@ferqx` | artifact/decision/ADR/计划索引完整；M0 只授权内部实现 |
| Security & Privacy Owner | `github:@ferqx` | G0 不可自我 waiver；默认 network/telemetry/route fail closed |
| Platform Owner | `github:@ferqx` | support matrix 仍为空；未通过 native probe 不声明平台支持 |
| Runtime/Capability Owner | `github:@ferqx` | 预算、调度、终态由 1C 唯一实现；未实现时 production run 拒绝 |
| Evaluation/Product Owner | `github:@ferqx` | D-07 未关闭前产品 Gate 为 unknown/blocked |

评审确认：

- execution baseline 从 `a316a2df63e511f839d08aa72a20275afa8e3366` 增量复核到
  `9a94379afec288394abcf8f36a076789102b1066`，该区间只包含 RFC、计划、理解和索引文档；
- Phase 0 artifact commit 是 `4be8735b29ec0fe3951bf7a0876f7b5e722c846a`；
- 旧 live evidence 已降为历史结果；schema v17、调度策略、system/tool contract 和默认 runner
  identity 已进入 1C/2A/2B/3 的 evidence 失效边界；
- 首发拓扑仍为本地单用户 TUI 与用户在场的前台 Headless CLI，没有扩大到 Web/hosted/
  multi-tenant；
- P0、G0、G1 不可普通 waiver；
- 10 个计划、108 个 Task 的依赖图无环；
- milestone producer/consumer 可解析，M0 只由本记录产生；
- 旧 telemetry 草案保持 superseded；
- Phase 1A–1C 的 rollback 都收紧为 off/fail-closed，不恢复不安全默认。

## 验证命令与结果

以下命令在 artifact commit 前和 pre-commit hook 中通过：

- `bun run scripts/check-plan-execution-matrix.ts`：
  10 plans、108 tasks、14 decisions passed；
- `bun run check:docs`：passed；
- `bun run check:docs-impact`：passed；
- 工作区级 documentation-map 影响检查：28 changed files，passed；
- `bun run check:core-boundary`：passed；
- `bun run typecheck`：passed；
- `bunx biome check scripts/check-plan-execution-matrix.ts scripts/check-docs.ts`：passed；
- `git diff --check`：passed；
- pre-commit golden：10 passed、0 failed。

## 未运行项

- 未运行完整 `bun run test`、TUI system、live Provider/MCP、native sandbox smoke、soak 和 artifact
  build。
- 原因：Phase 0 只交付文档、ADR 和计划门禁，不修改 Runtime/production behavior；上述验证由
  1A–3、2A/2B 的实际实现 Task 按 matrix 执行。
- 未运行项不被表述为绿色 evidence，也不用于任何 production/canary Gate。

## 风险与限制

- 当前没有 production-qualified platform/backend/provider route，support set 为空。
- D-04/D-06/D-07 等后续决策仍会阻塞相应 Task。
- single-maintainer 没有运营 backup；维护者不可联系时发布、扩面和恢复批准 fail closed。
- external release 前第三方安全评审尚未发生，`MS:LIM-APPROVED` 不存在。
- 本记录不证明 Runtime 已实现 Release Profile、sandbox、metadata logging 或资源预算。

## 与计划偏差

- 原计划假设存在可独立签署的常驻 Release/Security owner；用户确认单人维护后，以 ADR-0060
  改为 M0 单人角色签署、external 前第三方安全评审。
- 为防止计划字段回退，`check:docs` 额外集成了机器可解析 execution-matrix 门禁。
- D-11 在 Phase 0 直接冻结 internal/limited 的初始数值；后续 baseline 只能通过新 decision
  revision 调整，配置层只能收紧。

## Active 文档与 ADR 收敛

本 Phase 不改变当前 Runtime、App、配置或用户行为，因此没有制造 `docs/active/` 修改。新的架构
边界已进入 accepted ADR-0051–ADR-0060；实际行为落地时由 1A/1B/1C/2A 等计划在同一改动中更新
对应 active、book、README、documentation map、tests 和完成记录。
