# Agent 生产化 Phase 6：可选 Auto Compaction 与 GA 收敛计划

状态：draft
创建：2026-07-29
优先级：P1
依赖：
[`Phase 4 Compaction Qualification`](2026-07-29-agent-production-compaction-qualification.md)、
[`Phase 5 Capability Rollout`](2026-07-29-agent-production-capability-rollout.md) 的 rollout
framework，以及拟进入 GA profile capability 的独立 stable milestone
共同依赖：`MS:LIM-APPROVED`、`MS:LIMITED-SLO`
设计依据：RFC §8、§11.4、§16、§20 Phase 6

## 目标

把 Phase 6 拆成两个解耦轨道：

- **6A Optional Auto Compaction**：在 manual stable 后，从 external shadow 开始评估 auto；
- **6B GA Assembly**：选择实际进入 GA 的 stable capability 并生成 GA profile。

Auto Compaction 未进入 GA selection 时保持 off，不阻塞基础 GA。任何其他可选 MCP/Skill
capability 同理。

## 非目标

- 不保证所有实现过的能力都进入 GA；
- 不把 beta/experimental 重新命名为 stable；
- 不同时扩多个 route/platform/capability；
- 不移除用户 review、sandbox、Workspace Trust 或 Verification；
- 不把白名单 canary 的短窗口数据当成长期稳定；
- 不扩大为 hosted/multi-tenant。

## 共同前置条件

- `MS:LIM-APPROVED` 和 `MS:LIMITED-SLO` 已产生；
- 1A–3 的 P0 没有回归；
- Owner、真实 backup 或显式 `none (single-maintainer)`、on-call/rollback 可用；没有 backup
  时维护者不可联系即阻断发布和扩面；
- 所有 G0/G1 关闭；
- payload/detached manifest/evidence 可重放；
- route/platform/capability identity 与 evidence freshness 可验证。

## 任务执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 6A.1 | `MS:4-MANUAL-STABLE`、`MS:4-INTERNAL-AUTO-FRESH`、`MS:LIM-APPROVED`、`MS:LIMITED-SLO`、`T:3:3.6` | external shadow profile、eligibility report/dashboard | `bun test tests/runtime/context-compaction-shadow-gate.test.ts`；shadow Gate replay | 不调用 summary、不写 checkpoint；失败保持 Auto off |
| 6A.2 | 6A.1、`T:3:3.8` | `release/capability-decisions/auto-compaction-admission.json`、profile diff | `bun test tests/release/auto-compaction-admission.test.ts`；owner approval replay | 前置缺失不进入 live；G0/G1 不可 waiver |
| 6A.3 | 6A.2 | external auto live canary profile、dashboard/evidence | `bun test tests/evals/compaction/auto-live-canary.test.ts`；G3/G4/G5 replay | critical failure cohort=0 + Auto off；manual 独立保留 |
| 6A.4 | 6A.3 | `release/capability-decisions/auto-compaction.json`、beta/stable Gate records | `bun test tests/evals/compaction/auto-maturity-gate.test.ts`；Gate replay | 唯一产生 `MS:6A-AUTO-STABLE`；未达标保持 beta/canary/off |
| 6B.1 | `MS:LIM-APPROVED`、`MS:LIMITED-SLO`、`MS:4-MANUAL-STABLE`、`T:5:5.1`、`T:5:5.2` | `release/ga-selection.json`、selection validator/decision record | `bun test tests/release/ga-selection.test.ts` | selection 只能引用已存在 stable milestone；未选能力强制 off |
| 6B.2 | 6B.1、`MS:2A-RC` | GA profile/payload/detached manifest/evidence/support matrix | `bun run release:build`；`bun run release:verify`；Gate replay | 回滚完整 payload/manifest；不抬高未选或非 stable 能力 |
| 6B.3 | 6B.2 | upgrade/downgrade/schema/session compatibility fixtures | `bun test tests/release/ga-compatibility.test.ts`；rollback rehearsal | 不可逆迁移需备份；不兼容则 No-Go |
| 6B.4 | 6B.2、6B.3、`MS:3-OPS-READY` | post-release observation record、alerts/support | observation window/error-budget review | critical failure 立即 capability/artifact rollback |
| 6B.5 | 6B.1–6B.4 | README/active/book/map/ADR/changelog/completed records | `bun run check:docs-impact`、`bun run check:docs` | 文档或完成证据不收敛则不宣称 GA |

## 6A：Optional Auto Compaction

### Task 6A.1：External auto shadow

Phase 4 已完成 internal auto shadow/live，本任务不重复 internal rollout：

- 只计算 eligibility；
- 不调用 summary model；
- 不写 checkpoint；
- 记录 route、before/after estimate、触发原因和资源；
- 与 manual 真实结果对照；
- 检查 thrash、频繁触发和误触发；
- external telemetry 必须已有独立 consent；无 consent 不发送远程样本；
- 不改变用户上下文。

Gate：

- eligibility 与预期窗口一致；
- 无敏感指标；
- 无性能/资源无界增长；
- false trigger 在批准阈值内。

### Task 6A.2：External auto live admission

在任何真实 external auto 调用前冻结：

- 每次一个 route/platform；
- 固定 cohort 和预算；
- automatic summary 使用 Phase 4 资格；
- internal auto 与 external manual evidence 仍在 freshness window；
- rollback/incident rehearsal、contactable cohort 和独立 kill switch 可用；
- consent、Provider Data Policy、profile/route/payload identity 匹配；
- admission 只产生 profile diff 和 Gate decision，不调用 summary model。

以下 Runtime 不变量作为 Task 6A.3 的硬门槛：

- current turn 保护、lease/stale result 保持；
- auto failure 后同 turn 不继续普通模型请求；
- 用户看到 compaction 终态和恢复；
- critical fact/state/secret G0；
- manual reset/disable 可用。

### Task 6A.3：External auto live canary

- external shadow 观察窗口通过；
- capability 独立 kill switch；
- external telemetry consent；
- contactable cohort；
- rollback/incident rehearsal fresh；
- route → platform → cohort percentage 单维度逐步扩大；
- 每步重新检查 sample/window/error budget；
- generation/truncation/oversized/insufficient reduction/reset 分桶；
- continuation/task success 与未压缩/手动基线对照；
- token/cost/latency 不能无界增长。

任何 critical failure 立即 off，不等待窗口。

### Task 6A.4：Auto compaction maturity promotion

- canary、beta、stable 使用独立 Gate decision 和 observation window；
- manual stable、route qualification、internal evidence 在每次 promotion 时重新验证；
- continuation non-inferiority、false trigger、critical fact/state、用户退出和 rollback 通过；
- identity 变化使旧 decision 失效；
- stable Gate 唯一产生 `MS:6A-AUTO-STABLE`。

## 6B：GA Assembly

### Task 6B.1：冻结 GA capability selection

新增版本化 `GASelectionV1`：

```typescript
interface GASelectionV1 {
  version: 1;
  selectionId: string;
  selectedCapabilities: Array<{
    capability: string;
    stableMilestone: string;
    decisionDigest: string;
  }>;
  forcedOffCapabilities: string[];
  approvedBy: string[];
}
```

规则：

- 每个 selected capability 必须引用路线图注册的 stable milestone 和 fresh decision digest；
- Auto 只有引用 `MS:6A-AUTO-STABLE` 才能选入；未引用时强制 off；
- MCP write、readonly/effectful Skills 同样分别引用自己的 stable milestone；
- 代码存在、flag 默认 true、canary 通过都不能替代 stable milestone；
- selection 变化生成新 GA identity 并使后续 profile/evidence 失效。

### Task 6B.2：生成 GA Profile

GA profile：

- effective capability 只允许 selection 中的 stable/general；
- payload 可以携带被禁用的 beta/experimental 描述元数据，但不得启用；
- `full` 是否开放按 `D-05:CLOSED` 决策；
- Provider/MCP/Skill route allowlist fresh；
- logging metadata、telemetry consent 和 Provider Data Policy 不放宽；
- 资源预算、sandbox/network/worktree 保持；
- Verification completion 文案准确。

生成：

- GA payload 与 detached manifest；
- evidence、SBOM、provenance、signature；
- support matrix；
- changelog/security notes；
- upgrade/rollback instructions。

### Task 6B.3：升级、降级与兼容演练

覆盖：

- 前一 stable → GA；
- GA → 前一 stable；
- feature/capability off 后已有状态继续；
- Runtime schema fixture；
- session log migration；
- Plan/Verification/checkpoint/replay；
- MCP/Skill revision；
- worktree/change handoff；
- manifest/profile mismatch。

不可逆迁移必须在发布前有备份和明确 rollback limit。

### Task 6B.4：发布后观察

定义：

- 发布后冻结/观察窗口；
- error budget burn；
- G0/G1 escalation；
- capability/route rollback；
- user support/known issue；
- integrated/reverted 趋势；
- Provider policy/route 变化；
- dependency/security update。

观察期内不同时引入无关高风险功能。发布后证据写入完成记录，不能只保存在 dashboard。

### Task 6B.5：文档最终收敛

更新 README、正式支持范围、active、book、documentation map、ADR、changelog、安全/隐私
说明、各子计划完成记录、roadmap M4 与 plans index。

RFC 保持 accepted 历史设计；当前行为只由源码、测试、active 和 ADR 表达。

## GA Gate

### 不可协商

- 未授权副作用 0；
- sandbox/Workspace Trust 绕过 0；
- credential/正文越界 0；
- Runtime/checkpoint/tool pair 损坏 0；
- selected capability 的 required Verification bypass 0；
- G0/G1 未关闭项 0；
- Owner 空缺 0。

### 需要批准阈值

- task checks/human accepted/integrated/reverted；
- run/tool/MCP success/recovery；
- p50/p95/p99 latency；
- model retry/resource growth；
- selected compaction capability 的 continuation non-inferiority；
- user correction/approval burden；
- sample/window/error budget。

阈值必须在 GA 数据读取前预注册。

## 验收条件

- [ ] 6A 从 external shadow 开始，不重复 internal rollout；
- [ ] 6A 每步只扩一个 route/platform/cohort 维度；
- [ ] manual stable 是 Auto external 前置；
- [ ] 6B 可以在 Auto 强制 off 时生成基础 GA；
- [ ] 每个 selected capability 引用唯一 stable producer；
- [ ] GA profile 不含伪装成 stable 的 experimental/beta；
- [ ] payload/evidence/Gate identity 完整；
- [ ] 升级/降级/rollback 演练通过；
- [ ] 发布说明与真实支持矩阵一致；
- [ ] 发布后观察和 on-call 就绪；
- [ ] 计划/active/ADR/completed 记录收敛。

## 回滚

按影响最小优先：

1. 单 capability off；
2. route/platform/cohort 收缩；
3. profile 回退；
4. payload 回退；
5. schema 数据恢复。

回滚不：

- 删除 transcript、Plan、Receipt、Verification 或 checkpoint；
- 重放 unknown external effect；
- 恢复旧 MCP/Skill/工具路径；
- 降低 sandbox/network/data/logging 边界；
- 把失败状态改成完成。

## 风险

| 风险 | 控制 |
| --- | --- |
| Auto 失败阻塞无 Auto 的 GA | 6A/6B 拆分；GASelection 未选即强制 off |
| canary 成功后一次全量扩面 | route/platform/cohort 单维度 |
| maturity 受发布时间驱动 | stable milestone 与产品日期分离 |
| Provider 更新导致资格失效 | route/data/prompt digest 与 freshness |
| beta 被营销为 GA | GASelection validator 只接受 stable milestone |
| 回滚删除历史状态 | profile 只影响新 admission，原始事实保留 |

## 完成证据

目标路径：`docs/space/execution/completed/2026-07-30-agent-production-ga.md`。
记录内按 Task ID 分节并逐项包含文档影响、实际 commit/artifact、命令结果与偏差。

- optional Auto shadow/live/maturity 报告（仅在实施 6A 时）；
- GASelection decision；
- selected capability maturity records；
- GA payload/detached manifest/evidence；
- upgrade/downgrade/rollback rehearsal；
- support matrix/changelog/security/privacy；
- post-release observation 与完成记录。
