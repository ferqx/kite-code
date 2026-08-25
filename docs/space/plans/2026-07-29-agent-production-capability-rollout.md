# Agent 生产化 Phase 5：MCP、Skills、Verification 分能力发布计划

状态：superseded

终态范围（ADR-0069）：5.1、5.2、5A.1、5A.2、5.3A、5B.1–5B.3、5.3B、5C.1、5C.2、5.3C、5.4 的
本地 profile/status/conformance/adversarial/security Gate 记为 `completed`；所有 dogfood、canary 与
maturity Task 已被取代。Verification、MCP write 与 Skills 仍受默认关闭、显式用户开启和 embedded
ceiling 约束。当前状态见 `release/oss-first-release/task-status.json`。
创建：2026-07-29
优先级：P1
依赖：
[`Phase 2A Release Control`](2026-07-29-agent-production-release-control.md)、
[`Phase 2B Agent Evaluation`](2026-07-29-agent-production-evaluation.md)、
[`Phase 3 Observability`](2026-07-29-agent-production-observability-operations.md)
安全依赖：Phase 1A、1B、1C 全部完成
架构依赖：MCP/Skills/Verification 现有 accepted ADR 与 active governance
设计依据：RFC §8、§12、§16

## 目标

在 limited 基础能力稳定后，将 MCP write、Skills 和 Verification 作为三个独立 Release
Capability 分别评估、canary、回滚，避免实现存在被误认为生产默认可用。

## 当前本地 Contract 边界

D-10 已由 ADR-0064 关闭；两路最终整体 Review 均为 GO 后，Task 5.1、5.2、5A.1、5A.2、5C.1、
5C.2 与 5.4 的 dependency-ready 本地 foundation 已完成。5.3A/5.3C 等 task evidence 仍等待
`MS:2B-DONE`；5B.1–5B.3 仍受 stable Verification/route 依赖阻塞。本地完成证据见
[Phase 5 Capability Foundation 记录](../execution/completed/2026-08-02-agent-production-capability-foundation.md)。

四个 profile 均为 `under_development/off`，production MCP write route 为空，Skills cohort 为 0；
本地 adapter 固定 `local_contract_only`/blocked。formal Agent task、真实 Provider route、internal
dogfood、external canary、beta/stable maturity 与 candidate-bound maintainer review evidence 均未发生，不产生任何
`MS:5*-STABLE`。

2026-08-03 的 implementation-first 批次将 MCP write admission、intent/receipt、unknown-effect recovery、
compensation 与 route qualification 从测试 fixture 提升为 production core，并增加 strict source-owned
route registry；registry 当前显式为空，实际 MCP dispatch 仍未取得 write admission。统一 capability
rollout admission 也已实现 exact candidate/dependency/G0–G1/effect/Verification/freshness 检查，authority
缺失时固定 off/cohort=0。Capability retained evidence 已支持 production authentication shape、bundle
subject binding 与 source-owned authority lookup，但 registry 仍为空。以上不满足 `MS:5A-STABLE` 或真实 route/evidence 依赖，故 5B.1–5B.3 仍不
提前绑定，所有 capability milestone 不变。

同批增加四轨共用的 manual/no-publish `capability-evaluation.yml`、retained input producer 与 independent
expected-source verifier。该 workflow 没有 OIDC/发布权限并显式要求 blocked，只用于本地/默认分支
contract 接线验证；未运行的 workflow 或其 blocked artifact 不算正式 capability evidence。

## 非目标

- 不同时首次放行三个能力；
- 不恢复旧 MCP adapter；
- 不恢复 Prompt Skill 正文注入；
- 不让远端 MCP annotation 或 Skill manifest 降低授权；
- 不把 Provider action 变成旧 Tool Call 重放；
- 不因 Verification flag 关闭删除已有 required verification；
- 不把 `skills_readonly` 自动升级为 effectful。

## Rollout 原则

每个 capability 独立经过：

```text
off
→ internal experimental
→ single-capability canary
→ beta
→ stable/general
```

同一 cohort 中，MCP write、effectful Skills 和其他尚未 stable 的高风险能力不能同时首次
开启。Verification 可以作为其他写能力的强制依赖先成熟，但仍有独立状态和 evidence。

## 任务执行矩阵

章节排列按能力阅读，真正执行顺序以本矩阵为准。`5.3A/B/C` 是三个独立评估交付，不能等到
所有能力都完成后一次补测。

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 5.1 | `MS:2A-F`、`D-10:CLOSED` | `src/core/config/release-capabilities.ts`、`release/capability-profiles/`、Gate fixtures | `bun test tests/release/capability-profile.test.ts` | 只收紧 embedded ceiling；unknown dependency fail closed |
| 5.2 | 5.1、`T:1C:1C.4` | `src/app/release/capability-status.ts`、TUI/CLI projection/tests | `bun test tests/capabilities/status-projection.test.ts tests/tui-system/scenarios/capability-status.test.ts` | UI 可回退，admission 不可绕过；禁止模糊“完成” |
| 5A.1 | 5.1、5.2 | completion semantics mapper/golden fixtures | `bun test tests/verification/completion-semantics.test.ts` | `verificationV1=false`；关闭后已有 required 状态仍保留 |
| 5A.2 | 5A.1、`MS:1C-DONE` | Verification lifecycle/replay/recovery conformance | `bun test tests/verification/required-lifecycle.test.ts` | repair/waive/compensation 状态兼容；禁止删除 required |
| 5.3A | 5A.2、`MS:2B-DONE` | Verification task/adversarial cases/evidence adapter | `bun test tests/evals/capabilities/verification.test.ts` | false pass/bypass 立即 off |
| 5A.3 | 5.2、5.3A、`T:3:3.5`、`T:3:3.6` | internal Verification profile/dashboard/evidence | internal dogfood Gate replay | 仅 internal；关闭新 admission，旧 required 继续 |
| 5A.4 | 5A.3、`MS:LIM-APPROVED`、`MS:LIMITED-SLO` | external single-capability canary profile/evidence | Verification canary G3/G4/G5 replay | cohort 0 + 新 admission off；不删除 required |
| 5A.5 | 5A.4 | `release/capability-decisions/verification.json`、beta/stable Gate records | `bun test tests/release/capability-maturity-gate.test.ts`；Gate replay | 唯一产生 `MS:5A-STABLE`；不允许 canary 直接标 stable |
| 5B.1 | `MS:5A-STABLE`、`T:1A:1A.5`、`T:1A:1A.6`、`T:1B:1B.8`、5.1 | MCP write admission prerequisite checks | `bun test tests/mcp/write-admission.test.ts` | `mcpExecutionRecordV1`、`mcpProviderActionV1` 任一关闭即 fail closed |
| 5B.2 | 5B.1、`MS:1C-DONE` | intent/receipt/idempotency/reconciliation/compensation tests | `bun test tests/mcp/write-recovery.test.ts` | unknown 不重放；回滚保留 intent/receipt |
| 5B.3 | 5B.2 | production server/tool route registry and qualification | `bun test tests/mcp/write-route-matrix.test.ts` | route/revision/policy 变化撤销 qualification |
| 5.3B | 5B.2、5B.3、`MS:2B-DONE` | MCP write task/adversarial cases/evidence adapter | `bun test tests/evals/capabilities/mcp-write.test.ts` | duplicate side effect/data violation 立即 off |
| 5B.4 | 5.2、5.3B、`T:3:3.5`、`T:3:3.6` | internal MCP write single-route profile/evidence | internal MCP write Gate replay | 仅 internal；duplicate/越权立即 off |
| 5B.5 | 5B.4、`MS:LIM-APPROVED`、`MS:LIMITED-SLO` | external MCP write canary profile/evidence | MCP write canary G3/G4/G5 replay | cohort 0 + `mcp_write` off；不重放旧 invocation |
| 5B.6 | 5B.5 | `release/capability-decisions/mcp-write.json`、beta/stable Gate records | `bun test tests/release/capability-maturity-gate.test.ts`；Gate replay | 唯一产生 `MS:5B-STABLE`；未达标保持 beta/canary/off |
| 5C.1 | 5.1、`D-10:CLOSED` | readonly/effectful classifier/schema/property tests | `bun test tests/skills/effect-classification.test.ts` | `skills_readonly/effectful` 默认 off；unknown effect 归 effectful |
| 5C.2 | 5C.1、`MS:1B-DONE`、`MS:1C-DONE` | workflow contract/revision/reference/recovery conformance | `bun test tests/skills/workflow-contract.test.ts` | `skillWorkflowV1`/`skillActivationV2` 关闭即 fail closed |
| 5.3C | 5C.2、`MS:2B-DONE` | readonly/effectful Skill task/adversarial evidence | `bun test tests/evals/capabilities/skills.test.ts` | malicious/drift case 失败撤销 qualification |
| 5C.3 | 5.2、5.3C、`T:3:3.5`、`T:3:3.6` | internal readonly Skill profile/evidence | internal readonly Skill Gate replay | 仅 internal；关闭 activation，不恢复 prompt 注入 |
| 5C.4 | 5C.3、`MS:LIM-APPROVED`、`MS:LIMITED-SLO` | external readonly Skill canary/evidence | readonly Skill canary G3/G4/G5 replay | cohort 0 + readonly Skill off |
| 5C.5 | 5C.4 | `release/capability-decisions/skills-readonly.json`、beta/stable Gate records | `bun test tests/release/capability-maturity-gate.test.ts`；Gate replay | 唯一产生 `MS:5C-READONLY-STABLE` |
| 5C.6 | `MS:5A-STABLE`、`MS:5C-READONLY-STABLE`、5.3C | internal effectful Skill profile/evidence | internal effectful Skill Gate replay | 与 MCP write 分 cohort；关闭后保留 receipt/Verification |
| 5C.7 | 5C.6、`MS:LIM-APPROVED`、`MS:LIMITED-SLO` | external effectful Skill canary/evidence | effectful Skill canary G3/G4/G5 replay | cohort 0 + effectful Skill off；不删除 Verification |
| 5C.8 | 5C.7 | `release/capability-decisions/skills-effectful.json`、beta/stable Gate records | `bun test tests/release/capability-maturity-gate.test.ts`；Gate replay | 唯一产生 `MS:5C-EFFECTFUL-STABLE` |
| 5.4 | 5.1、5.2 | common active/book/map/ADR、framework evidence/完成记录 | `bun run check:docs-impact`、`bun run check:docs` | 每条 maturity Task 自带 capability-specific 文档；未完成轨道保持 off |

里程碑：

- `MS:5A-STABLE` 只由 5A.5 产生，required bypass/false pass 必须为 0；
- `MS:5C-READONLY-STABLE` 只由 5C.5 产生，effects/revision/reference boundary 必须无漂移；
- MCP write 必须等待 `MS:5A-STABLE`；effectful Skill 必须同时等待
  `MS:5A-STABLE` 与 `MS:5C-READONLY-STABLE`；
- 5B.6/5C.8 分别是 MCP write/effectful Skill 的可选 stable producer；
- Phase 6B 只消费 framework 和拟进入 GA capability 的 stable milestone，不要求所有轨道完成。

所有 maturity promotion Task 使用同一规则：

- canary、beta、stable 是三个不同 Gate decision，不允许一次评审连续跳级；
- beta 与 stable 分别满足预注册样本量、观察窗口、error budget、G3–G5 和人工批准；
- decision record 绑定 payload/profile/route/platform/capability contract/evaluator identity；
- 任一 identity 或安全依赖变化使旧 decision 失效；
- 未通过时保留准确 maturity/rollout，不得为满足 GA 日期改名。

## 子轨道 A：Verification

### Task 5A.1：确认 completion 语义

所有入口区分：

- Agent final；
- Runtime ended；
- Plan completed；
- checks executed；
- Verification passed/failed/inconclusive/waived。

UI/CLI 不显示单一模糊“完成”状态。

### Task 5A.2：required lifecycle conformance

覆盖：

- risk-derived required mode；
- request/evidence/maintainer approver；
- repair/replan；
- structured user waive；
- compensation；
- budget；
- replay/recovery；
- capability rollback 后已有 required 状态继续收敛。

模型无生成 waiver 的入口，maintainer approver 消费 receipt/evidence 而不是模型 final。

### Task 5A.3：Verification internal dogfood

- internal 开启 `verificationV1`；
- task suite 分 write/destructive/unknown；
- 统计 passed/failed/inconclusive/repair/waive；
- false pass 和 bypass 为 G0；
- 验证 rollback 关闭新 admission 但不删除已有 required；
- 不向 external cohort 开放。

### Task 5A.4：Verification external canary

仅在 `MS:LIM-APPROVED` 和 `MS:LIMITED-SLO` 后：

- 单一 capability/cohort 开启；
- canary 用户理解状态；
- 统计 false pass/bypass、repair、waive、inconclusive 和完成文案；
- 独立 rollback 关闭新 admission，但不删除已有 required。

### Task 5A.5：Verification maturity promotion

- 先生成 beta decision，完成独立观察窗口后再评 stable；
- required bypass/false pass 为 0；
- recovery/repair/waive/compensation 与 completion UX 通过 G3–G5；
- stable Gate 唯一产生 `MS:5A-STABLE`。

## 子轨道 B：MCP write

### Task 5B.1：admission prerequisites

同时要求：

- `mcpExecutionRecordV1`；
- `mcpProviderActionV1`；
- `verificationV1`；
- exact provider/server/tool identity；
- current binding/schema/revision；
- Provider Data Policy 和 egress approval；
- Phase 1B network boundary。

任一缺失时 `mcp_write` fail closed。

### Task 5B.2：副作用与恢复 conformance

覆盖：

- intent 在副作用前持久化；
- execution receipt；
- idempotency key；
- at-most-once/安全 replay 分类；
- unknown 不盲目重放；
- read-after-write/reconciliation；
- compensation；
- provider action 只恢复 control plane；
- auth/reconnect/catalog drift；
- cancel/restart；
- required Verification。

第三方不支持幂等时，文档明确不自动 replay。

### Task 5B.3：MCP write route matrix

每个 production server/tool：

- operator/server/endpoint identity；
- Tool schema/revision；
- effects；
- approval；
- Provider Data Policy；
- idempotency/reconciliation；
- rate limit/timeout；
- evidence freshness。

只读白名单与 write 白名单分开。`mcp_read` 的稳定性不能为 write 放行。

### Task 5B.4：MCP write internal dogfood

- 单一 internal server/tool/cohort 开始；
- 所有 write 有 intent/receipt；
- unknown/reconciliation 独立指标；
- duplicate/越权/数据越界立即 off；
- 不向 external cohort 开放。

### Task 5B.5：MCP write external canary

- 只在 `MS:LIM-APPROVED`、`MS:LIMITED-SLO` 和 `MS:5A-STABLE` 后开始；
- 用户看见外部副作用和 Verification；
- 所有 write 有 intent/receipt；
- unknown/reconciliation 独立指标；
- 任何重复副作用、越权、数据越界立即 off；
- rollback 不重放旧 invocation。

### Task 5B.6：MCP write maturity promotion

- canary → beta → stable 使用独立 Gate/窗口；
- route/tool revision、idempotency、reconciliation、Provider Data Policy 和 Verification
  identity 保持 fresh；
- duplicate/unauthorized side effect 为 0；
- stable Gate 唯一产生 `MS:5B-STABLE`；未通过不阻塞不包含 MCP write 的 GA。

## 子轨道 C：Skills

### Task 5C.1：冻结 readonly/effectful 分类

`skills_readonly`：

- effective effects 全部 `none|read`；
- dependency 中 write/destructive/unknown 即转 effectful；
- 内置或管理员 allowlist；
- project Skill 受 Workspace Trust；
- minimum approval/ceiling 保守合并。

`skills_effectful`：

- Verification required；
- provenance/review；
- 对应 effects approval；
- recovery/compensation；
- 独立 canary。

Skill `allowed-tools`/dependencies 只表达 ceiling，不预批准工具。

### Task 5C.2：Workflow Contract conformance

覆盖：

- strict YAML/schema；
- revision/dependency drift；
- inline/fork；
- reference boundary、symlink、size；
- output schema；
- activation/frame close；
- recovery；
- budget exhausted；
- malicious/conflicting instruction；
- invalid shadowing；
- project/user/builtin provenance。

不恢复 `Skill` 工具返回 SKILL.md 正文的旧路径。

### Task 5C.3：Readonly Skill internal dogfood

- 内置/管理员 allowlist；
- 禁止任意项目 Skill 自动进入；
- 记录 disclosure/activation/completion/recovery；
- Tool Search/Skill discovery 误触发指标；
- effects 漂移立即撤销 qualification。

### Task 5C.4：Readonly Skill external canary

- 只在 `MS:LIM-APPROVED` 和 `MS:LIMITED-SLO` 后进入单一 cohort；
- 用户看见 source/revision、effective tool ceiling 和实验退出；
- 任一 dependency/effect/reference drift 立即 off；
- 只产生 canary evidence，不直接标 stable。

### Task 5C.5：Readonly Skill maturity promotion

- canary → beta → stable 使用独立 Gate/窗口；
- effective effects 始终为 none/read；
- discovery、activation、completion、recovery 和用户理解度通过；
- stable Gate 唯一产生 `MS:5C-READONLY-STABLE`。

### Task 5C.6：Effectful Skill internal dogfood

仅在 `MS:5A-STABLE` 和 `MS:5C-READONLY-STABLE` 后：

- 单一 internal Skill/cohort；
- write/destructive effects 明示；
- worktree/Provider Data/资源预算继承；
- required Verification；
- side effect/recovery/compensation evidence；
- 与 MCP write 不在同 cohort 同时首次放行。

### Task 5C.7：Effectful Skill external canary

- 额外等待 `MS:LIM-APPROVED` 和 `MS:LIMITED-SLO`；
- 单一 Skill/cohort，副作用、worktree、data route、Verification 均可见；
- duplicate/unauthorized effect、Verification bypass 或 compensation 失败立即 off；
- rollback 保留 receipt/required Verification。

### Task 5C.8：Effectful Skill maturity promotion

- canary → beta → stable 使用独立 Gate/窗口；
- dependency revision、worktree、Provider Data Policy、recovery/compensation evidence fresh；
- 与 MCP write 的 cohort 隔离证据通过；
- stable Gate 唯一产生 `MS:5C-EFFECTFUL-STABLE`。

## 共同实施步骤

### Task 5.1：Capability Profile 与 Gate

2A Release Profile 为每条轨道定义：

- maturity；
- max rollout；
- dependencies；
- route/platform allowlist；
- evidence freshness；
- G3/G4/G5；
- rollback。

项目/CLI 不能绕过依赖组合。

### Task 5.2：状态和用户文案

展示：

- capability maturity/rollout；
- disabled reason；
- remote/local boundary；
- expected side effect；
- Verification 状态；
- recovery/retry；
- experimental 退出。

模型不自行解释 maturity 或声称稳定。

### Task 5.3A：Verification Agent task/adversarial evaluation

- representative write/destructive/unknown tasks；
- false completion/false pass/required bypass；
- maintainer/provider outage；
- repair、waive、compensation、cancel 和 resource budget。

### Task 5.3B：MCP write Agent task/adversarial evaluation

- malicious MCP content、stale binding/catalog drift；
- Provider outage、auth/reconnect、recovery/cancel；
- data exfiltration、duplicate side effect、unknown/reconciliation；
- required Verification 和 resource budget。

### Task 5.3C：Skills Agent task/adversarial evaluation

- malicious/conflicting Skill instructions、invalid shadowing、dependency drift；
- readonly/effectful 误分类；
- reference/symlink/size boundary、recovery/cancel；
- data exfiltration、duplicate side effect、false completion 和 resource budget。

### Task 5.4：文档与 Evidence

更新：

- `docs/active/mcp-runtime-governance.md`
- `docs/active/mcp-authentication.md`
- `docs/active/capability-progressive-disclosure.md`
- `docs/active/verification-governance.md`
- `docs/active/tool-gated-autonomy.md`
- `docs/book/11-MCP与Skills扩展.md`
- `docs/book/12-测试体系.md`
- `docs/documentation-map.json`
- capability-specific ADR 和完成记录。

## 验收条件

### Verification

- [ ] required bypass/false pass 为 0；
- [ ] rollback 后已有 required 继续；
- [ ] failed/inconclusive 不显示完成；
- [ ] repair/waive/compensation/recovery 通过。

### MCP write

- [ ] 所有 write 有 intent/receipt；
- [ ] unknown 不盲目 replay；
- [ ] route/data/effects/revision 全绑定；
- [ ] duplicate/unauthorized side effect 为 0；
- [ ] reconciliation/Verification 通过。

### Skills

- [ ] readonly/effectful 分类保守；
- [ ] strict contract/revision/dependency 通过；
- [ ] malicious/symlink/budget/recovery 通过；
- [ ] effectful 继承 worktree/data/Verification。

### 共同

- [ ] 每个 capability 有独立 profile、dashboard、Gate 和 rollback；
- [ ] 首次 canary 不耦合多个高风险能力；
- [ ] Agent task 和人工 review 达预注册阈值；
- [ ] active/book/ADR/map 与实现一致。

## 回滚

- 关闭单 capability；
- cohort 置 0；
- route/Skill qualification 撤销；
- profile/artifact 回退；
- 不恢复旧 adapter/Prompt Skill；
- 不删除 intent/receipt/Verification/frame；
- unknown external effect 保留 reconciliation；
- effectful rollback 不自动关闭已稳定 readonly 能力，除非共享 G0。

## 风险

| 风险 | 控制 |
| --- | --- |
| capability 依赖组合错误 | Release Profile dependency conformance |
| MCP 重连重复副作用 | intent/idempotency/unknown/reconciliation |
| Skill 声称 readonly 实际写入 | dependency effects 保守合并 + runtime policy |
| Verification 增加用户负担 | task/人工评估，不能降低 required 安全门槛 |
| 多能力同时 canary 难归因 | cohort exclusivity |
| remote content prompt injection | 不可信内容 + data/secret egress 分离 |

## 完成证据

目标路径：`docs/space/execution/completed/2026-07-30-agent-production-capability-rollout.md`。
记录内按 Task ID 分节并逐项包含文档影响、实际 commit/artifact、命令结果与偏差。

- per-capability manifest/evidence/Gate；
- Verification lifecycle report；
- MCP write route/recovery matrix；
- Skill contract/effects matrix；
- task/adversarial/canary SLO；
- capability rollback rehearsal；
- 用户状态与 review UX。
