# Agent 生产化 Phase 0：治理、决策与 ADR 计划

状态：superseded

终态范围（ADR-0069）：本计划的 5 个 Task 均记为 `completed`。旧双人/独立 authority 设计只保留
历史参考；当前权威状态见 `release/oss-first-release/task-status-v2.json`。
创建：2026-07-29
优先级：P0
依赖：
[`Agent 生产就绪实施总路线图`](2026-07-29-agent-production-readiness-roadmap.md)
设计依据：
[`Agent 生产就绪 RFC §16、§22、§24`](../../design/2026-07-29-agent-production-readiness-rfc.md)

## 目标

在修改生产行为前，把 Owner、未决决策、共享 schema、ADR 和验收责任固定下来。Phase 0
不实现 Release Profile 或运行时安全能力；它为所有后续计划提供不会随实现者临时变化的
治理基线。

## 非目标

- 不开启任何新 capability；
- 不生成 `limited-production` artifact；
- 不实现远程 rollout 服务；
- 不把人员角色写入 Runtime 或模型 prompt；
- 不用本计划替代后续技术 ADR。

## 范围

- `docs/adr/`
- `docs/design/2026-07-29-agent-production-readiness-rfc.md`
- `docs/space/plans/2026-07-29-agent-production-*.md`
- `docs/space/plans/index.md`
- 发布决策记录的规范位置和模板
- Owner、backup、升级路径和计划完成责任

## 当前进度

- Task 0.1–0.5 已完成；Phase 0 artifact commit 为
  `4be8735b29ec0fe3951bf7a0876f7b5e722c846a`；
- D-02/D-08/D-09/D-11/D-12/D-13/D-14 已关闭，ADR-0051–0060 已接受；
- [Task 0.5 完成记录](../execution/completed/2026-07-30-agent-production-governance.md)
  唯一产生 `MS:M0`，结论为 `approved_for_internal_implementation`；
- 1A.1/1C.1 已建立 `ready` execution binding；其余非 Phase 0 Task 仍按依赖保持未绑定；
- 本阶段没有改变生产 Runtime 行为，也没有生成 `limited-production` artifact。

## 需要关闭的决策

必须为 RFC §24 的 14 项决策填写具名 Owner、backup、到期 milestone、证据和结论：

1. `D-01` limited manual compaction 策略；
2. `D-02` session metadata 保留和容量；
3. `D-03` 外部 canary telemetry 条件；
4. `D-04` 首批 platform、sandbox backend、入口和 provider route；
5. `D-05` `full` interaction mode 的 GA 边界；
6. `D-06` artifact/evidence 签名、provenance 与托管；
7. `D-07` Agent task benchmark 人群、任务集、重复次数和阈值；
8. `D-08` network allowlist、protected path 和 sandbox fallback；
9. `D-09` Headless CLI 写入限制和 worktree 适用形态；
10. `D-10` `skills_readonly`/`skills_effectful` 分界；
11. `D-11` time/turn/model/tool/token/sub-agent/artifact 预算，以及 tool/shell invocation、
    process-tree 与 permit wait 硬上限；
12. `D-12` behavior digest canonicalization、`RuntimeSchedulingPolicyV1` 和 evidence 失效；
13. `D-13` Owner、事故联系人、通知渠道和演练；
14. `D-14` model/MCP route 的数据策略。

未到对应 blocking phase 的决策可以保留 `open`，但必须有最严格临时默认值。第 13 项和
会改变共享 schema 的决策必须在 Phase 0 结束前关闭。

## 实施步骤

### 任务执行矩阵

本矩阵是 Task 的执行元数据；章节正文描述业务内容，执行顺序以 `dependsOn` 为准。

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 0.1 | — | 新增 `docs/space/plans/2026-07-29-agent-production-decision-register.md`；更新本计划 | `bun run check:docs`；检查 14 个唯一 ID、Owner/backup/default/blockingPhase | 仅文档；回滚为新 revision，不删除历史决定 |
| 0.2 | 0.1 | `docs/adr/` 中按边界新增 ADR；更新 decision register | `bun run check:docs`、`bun run check:docs-impact` | 仅文档；错误决定用新 ADR 替代 |
| 0.3 | 0.2 | 本计划 schema owner 表；各 schema 计划入口 | `rg -n \"首个实现计划\" docs/space/plans/2026-07-29-agent-production-*`；`bun run check:docs` | 仅文档；owner 变化保留审批历史 |
| 0.4 | 0.3 | 全部生产就绪子计划、`docs/space/plans/README.md`、`scripts/check-plan-execution-matrix.ts` | `bun run scripts/check-plan-execution-matrix.ts`；`bun run check:docs` | 仅文档/门禁脚本；不得用删除字段方式回滚 |
| 0.5 | 0.1–0.4 | decision register、计划状态、M0 评审记录（唯一产生 `MS:M0`） | `bun run check:docs-impact`、`bun run check:docs` | 不通过则所有子计划保持 `draft` |

### Task 0.1：建立 Owner 与决策记录

改动：

- 新增一份不含个人敏感联系方式的决策记录，使用可审计团队 identity；
- 为 Capability、Release、Security & Privacy、Platform、Evaluation/Product、
  Incident Commander 指定 primary；没有真实 backup 时显式登记 `none (single-maintainer)`，
  不得伪造第二身份；
- 每项决策记录：
  `id/status/owner/backup/dueMilestone/blockingPhase/decision/evidence/approvedAt`；
- 联系电话、私人邮箱等值保留在组织内部系统，仓库只保存值班入口或团队别名。

验证：

- 14 个决策 ID 唯一且全部有 Owner、blocking phase 和默认值；
- 没有 `TBD owner`；
- roadmap 与 RFC 的编号一致。

检查点：发布负责人可以从一个入口回答“谁在何时决定什么、未决时采用什么默认值”。

### Task 0.2：新增架构 ADR

至少评估并按最终边界拆分 ADR：

1. Release Profile、maturity/rollout 正交和字段单调组合；
2. Release Manifest/Evidence/Gate 与 behavior digest；
3. 本地单用户首发拓扑和 hosted 独立准入；
4. sandbox/network/protected path/worktree 执行隔离；
5. 父子 Agent 累计资源预算、`RuntimeSchedulingPolicyV1`、effect-aware batch/shell
   invocation permit、process-tree 上限与统一 terminal 语义；
6. metadata-first 本地日志、无正文 telemetry 与 Provider Data Policy；
7. compaction 离线质量门禁与 route qualification；
8. Agent task/diff/test/review 作为产品验收结果；
9. 可选 disable-only signed rollout manifest。
10. single-maintainer 角色合并、显式无 backup 和 external release 前 candidate-bound maintainer review；
    第三方评审按 ADR-0067 为可选增强。

实施约束：

- 先检索现有 ADR，覆盖部分只新增补充/替代 ADR；
- 不修改 accepted ADR 的历史结论；
- signed rollout 可以独立延后，不能阻塞首个 limited；
- 每份 ADR 写清 rollback 不能恢复哪条不安全旧路径。

验证：

```bash
bun run check:docs
bun run check:docs-impact
```

### Task 0.3：冻结共享 schema ownership

形成 schema owner 表：

| Schema | Owner | 首个实现计划 |
| --- | --- | --- |
| `ReleaseProfileV1` | Release + Security | 2A |
| `ProviderDataPolicyV1` | Security & Privacy | 1A |
| `ExecutionBoundaryV1` | Platform + Security & Privacy | 1B |
| `ResourceBudgetV1` | Platform | 1C |
| `RuntimeSchedulingPolicyV1` | Runtime | 1C |
| terminal/failure reason | Runtime | 1C |
| `ReleaseManifestV1` / `ReleaseEvidenceV1` | Release | 2A |
| `AgentTaskCaseV1` | Evaluation/Product | 2B |
| `CompactionCaseV1` / Route Qualification | Compaction Capability | 4 |
| metrics allowlist | Security & Privacy + Operations | 3 |

规则：

- schema source 位于 Core 或 release scripts 由对应计划决定；
- 2A 只消费 1A 生成的 `ProviderDataPolicyV1` canonical snapshot/digest，不得复制或扩展该
  schema；
- 2A 只消费 1C 从实际 Runtime 导出的 `RuntimeSchedulingPolicyV1` canonical snapshot；
  release scripts 不得复制 scheduler allowlist、barrier 或 terminal 语义；
- `ReleaseProfileV1` 的资源字段由 2A 定义和组合；1C 只投影累计预算及 tool/shell
  invocation/wait limits，并拥有 Runtime reservation/waiter；1B 只把 process-tree limit
  投影到 `ExecutionBoundaryV1` 并拥有平台 enforcement。不得在三个计划中平行定义默认值
  或 composition 规则；
- App 只加载/展示，不重新定义安全语义；
- 共享字段变更同时更新 producer、consumer、fixture、digest 和 active 文档；
- schema 未知时安全敏感路径 fail closed。

验证：每个 schema 只有一个规范 owner 和一个首个实现计划。

### Task 0.4：建立计划执行模板与完成证据模板

所有子计划的任务矩阵必须补齐：

- 明确的 Task ID 与 `dependsOn`；
- 代码、测试和文档文件落点；
- 定向测试命令；
- 文档影响；
- feature flag/迁移策略；
- rollback；
- 完成记录目标路径。

子计划可以用紧邻“实施步骤”的任务执行矩阵统一承载上述字段；矩阵中的每一行必须唯一映射
到一个 Task。字段不得只在计划级概述中出现。`N/A` 必须说明原因，不能留空。

具体执行人、baseline commit、branch 和运行状态属于 execution binding，只为下一批实际
准备启动的 Task 创建。M0 不要求为 Phase 4–6 预写未来 binding，也不得使用占位 identity。
新增 `scripts/check-plan-execution-matrix.ts` 验证 Task/矩阵一一对应、依赖引用语法和稳定
milestone producer。

完成记录必须包含：

- 实际 commit/artifact；
- 执行过的命令和结果；
- 未运行项；
- 风险与限制；
- Gate 决策；
- 与计划偏差；
- active 文档和 ADR 收敛。

### Task 0.5：Phase 0 评审

评审参与：

- Release Owner；
- Security & Privacy Owner；
- Platform Owner；
- Runtime/Capability Owner；
- Evaluation/Product Owner。

ADR-0060 的 single-maintainer 模式允许上述角色由 `github:@ferqx` 同一人承担；签署必须按角色
逐项留下结论，不能把一次笼统批准复制成五份。M0 只允许内部实现。ADR-0067 后，
`MS:LIM-APPROVED` 使用绑定不可变 candidate 的具名 maintainer security review；独立第三方评审为
可选增强，不再是 external release 的硬门禁。

必须逐项确认：

- 当前 execution binding 基线是
  `a316a2df63e511f839d08aa72a20275afa8e3366` 或已单独完成增量复核的后继提交；
- 旧基线 live evidence 已标记为历史结果，schema v17、调度策略、system/tool contract 和
  默认测试 runner 的证据失效边界已进入 1C/2A/2B；
- 首发拓扑没有扩大；
- P0 不能被普通 waiver；
- 计划依赖图没有循环；
- 各 Gate 有 evidence producer 和 consumer；
- 旧 telemetry 草案已明确 superseded；
- Phase 1A–1C 可以独立回滚且不会恢复不安全默认。

全部检查通过并由具名评审角色签署后，本任务唯一产生 `MS:M0`；任一项未通过时不得写入该
milestone，也不得为非 Phase 0 Task 创建 execution binding。

## 验收条件

- [x] 六类 Owner 已具名；不存在的 backup 已显式登记为 `none (single-maintainer)`；
- [x] RFC §24 的 14 项决策全部登记；
- [x] Phase 0 blocking 决策已关闭；
- [x] 必要 ADR 已接受；
- [x] 共享 schema ownership 无冲突；
- [x] 所有子计划有可解析依赖、验证、rollback 和完成记录入口；
- [x] execution binding 与合并增量复核基线一致；
- [x] 下一批即将启动的 Task 有真实 execution binding，远期 Task 不要求预绑定；
- [x] `bun run check:docs` 通过；
- [x] 工作区级 documentation-map 影响检查与 `bun run check:docs-impact` 通过。

## 回滚

Phase 0 只改文档和决策，不改生产行为。若某项决策被后续证据推翻：

1. 新增 ADR 替代旧 ADR；
2. 更新决策记录状态与依据；
3. 重新评估受影响子计划和已生成 evidence；
4. 使不再匹配的 evidence 失效；
5. 不改写历史批准记录。

## 风险

| 风险 | 控制 |
| --- | --- |
| 角色有名字但无实际权限 | 记录可执行的批准、kill switch 和发布权限 |
| 决策长时间 open | 到期使用最严格默认值；blocking phase 不允许越过 |
| ADR 粒度过大 | 按可独立替代和回滚的边界拆分 |
| schema ownership 重叠 | 每个 schema 只有一个规范 producer |
| 联系方式进入公开仓库 | 只保存团队 identity/值班入口，不保存私人联系方式 |

## 完成后的文档动作

- 在 `docs/space/execution/completed/2026-07-30-agent-production-governance.md` 创建 Phase 0
  完成记录；记录内按 Task ID 分节，逐项填写 commit/artifact、命令结果、未运行项、文档影响、
  风险、Gate 和计划偏差；
- 更新本计划和 `plans/index.md` 为 `archived`；
- 在 roadmap 标记 M0 完成；
- 后续当前行为变化由对应子计划更新 active 文档，本计划不提前修改 active 事实。
