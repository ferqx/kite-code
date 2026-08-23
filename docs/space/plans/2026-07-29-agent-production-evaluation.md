# Agent 生产化 Phase 2B：Agent 任务评估与产品验收计划

状态：superseded

终态范围（ADR-0069）：2B.1–2B.6、2B.8–2B.10 以小规模本地 case、核心 adversarial、安全/正确性
case 与 DeepSeek/千问各一次低成本真实 smoke 记为 `completed`；2B.7 的 external participant/human
cohort 要求记为 `superseded`。不要求重复 8/20 次或 production evaluator authority。当前状态见
`release/oss-first-release/task-status.json`。
创建：2026-07-29
优先级：P0
依赖：
[`Phase 0 治理、决策与 ADR`](2026-07-29-agent-production-governance-decisions.md)
Contract 依赖：
[`Phase 2A Release Control`](2026-07-29-agent-production-release-control.md) 的 `2A-F`
执行 fixture/adversarial 依赖：Phase 1B、1C；涉及真实 data route/human review 时再依赖 Phase 1A
设计依据：RFC §10、§15.4、§16、§23.2

2026-08-02：D-07 已按 single-maintainer-first 推荐方案关闭。2B.1–2B.3 与 2B.8 已在最终整体
Review GO 后完成，批准范围
固定 12-case 精确分层、PR/route-change/RC 为 1/8/20、G0/false-completion=0、aggregate≥90%、
per-case≥80%。维护者 dogfood 只算 internal；external 至少 3 人且每人 4 tasks。1B.6 已随
`MS:1B-DONE` 正式完成。2B.4/2B.5 已 dependency-ready 并保持 `in_progress`，等待 authenticated
live route、route-matched baseline、完整 8/20 attempt ledger 与 formal adversarial G0 evidence。
human accepted/integrated/reverted 全部保持 `not_observed`；Evidence adapter 仍只有
`blocked/not_green`，不产生 `MS:2B-DONE`。本地完成证据见
[Phase 2B 本地评估基础记录](../execution/completed/2026-08-02-agent-production-evaluation-foundation.md)。
整体 Review 后 evaluator 又加固为绑定批准 suite ID/revision/digest、精确 12 case 与固定
determinism；本地 `real_run` discriminator 和 participant/sample constructor 均无认证 authority，
固定 `contract_only/evidenceEligible=false`，必须等待独立 run/consent/participant/ledger verifier。
随后本地 authenticated evidence contract 已补齐 12 case × 8/20 的 96/240 receipt 全量重建、共享
Release artifact/frozen baseline identity、D-07 success/G0/p95 Gate、精确有序 21-case formal adversarial
receipts 与 fixture signature 校验。本地 Gate 失败独立标为 failed；调用者不能把 fixture key/route 注入为
production。`github_oidc_sigstore_v1` schema 会把 subject/attestation/verification receipt/authority/workflow
作为 exact tuple 与源码预登记记录匹配，但 ADR-0062 Sigstore 密码学 verifier 尚未实现、registry 与 route
registry 仍为空，所以 2B.4/2B.5 状态与上述
真实 evidence 缺口不变。新增 manual/no-publish workflow 已能用真实 GitHub artifact ID 生成并独立验证
`contract_conformance` retained bundle，但 signature 固定 unconfigured、route 未配置、结果固定 blocked；
它补齐本地 producer/verifier，不把 contract run 升格为 production route run。

2026-08-03 的 implementation-first 批次增加 production-shaped product companion ledger，把 Tool Search、
MCP/Skill 非预期触发、`ask_user`、Plan/恢复/Verification/review handoff/correction 与 opt-in 人工 outcome
逐 attempt 绑定到 authenticated evidence 的同一 source/candidate identity。该实现补齐 2B.6/2B.7 的
本地 schema、producer/rebuild/verifier 边界，但 source-owned production authority、真实 participant/
consent、live route 与 formal attempts 仍缺失；2B.4/2B.5 状态不变，2B.6/2B.7 不提前绑定，
`MS:2B-DONE` 未产生。

Formal Agent task workflow 已把 companion producer/verifier 接到完整 96/240 retained attempt bundle；
contract artifact 的 UX coverage 可独立重建，human receipts 明确为 0。该接线不制造 participant/consent/
accepted/integrated 事实，所以 2B.7 与 external 产品 Gate 仍等待真实流程。

## 目标

建立可以证明 Agent“能完成目标、结果可 review、不会制造无关风险”的版本化任务评估，
把 Runtime 测试通过与产品可用性分开。

## 非目标

- 不用模型自评替代确定性 oracle；
- 不只比较 final 文本；
- 不把单次成功或最好一次作为通过；
- 不收集未经授权的真实用户正文；
- 不把 benchmark 分数自动等同于 GA；
- 不让任务 fixture 获得生产 credential 或公网写权限。

## 主要改动范围

- 新增 `tests/evals/agent-tasks/`
- 新增 evaluator/runner/report scripts
- 隔离 fixture repositories
- CI/nightly/release evidence integration
- 产品 dogfood 和人工 review 流程
- benchmark 版本、污染和隐私治理

## 共享 schema ownership

本计划是 `AgentTaskCaseV1` 的首个实现计划，Evaluation/Product 是规范 owner，Release 只审核其
Evidence adapter 与 Gate identity。case、oracle、scorer 或 report schema 变化必须生成新 suite
identity，不得由 2A 平行定义。

## 任务模型

建议定义：

```typescript
interface AgentTaskCaseV1 {
  version: 1;
  caseId: string;
  category:
    | 'repository_research'
    | 'bug_fix'
    | 'small_feature'
    | 'refactor'
    | 'test'
    | 'documentation'
    | 'failure_recovery'
    | 'adversarial';
  difficulty: 'simple' | 'medium' | 'complex';
  contextClass: 'short' | 'long';
  allowedPaths: string[];
  forbiddenPaths: string[];
  requiredDiffFacts: Oracle[];
  forbiddenDiffFacts: Oracle[];
  requiredChecks: CheckSpec[];
  expectedInteractions: InteractionConstraint;
  budgets: ResourceBudgetRef;
}
```

具体 schema 由 Evaluation/Product Owner 与 Release schema owner 审核。

## 实施步骤

### 任务执行矩阵

Evaluation 是离线/受控执行面，不新增生产 capability flag；所有 fixture profile 只能等于或
严于目标 release profile，不能为跑分抬高权限。

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 2B.1 | `T:0:0.1`、`D-07:CLOSED`、`MS:2A-F` | `tests/evals/agent-tasks/cases/schema.ts`、task taxonomy、schema tests | `bun test tests/evals/agent-tasks/schema.test.ts` | versioned case schema；旧 suite 只读保留，不覆盖 |
| 2B.2 | `T:1B:1B.6`、`T:1C:1C.3`、2B.1 | `tests/evals/agent-tasks/fixtures/`、baseline builder、worktree/artifact collector、cleanup tests | `bun test tests/evals/agent-tasks/fixture-runner.test.ts` | 临时 worktree identity 不匹配时拒绝清理；失败保留诊断后安全清理 |
| 2B.3 | 2B.1、2B.2 | oracle/diff/check runners、good/bad fixtures | `bun test tests/evals/agent-tasks/oracle.test.ts` | oracle version 变化使旧结果失效 |
| 2B.4 | 2B.3、`MS:2A-F` | repeated runner、statistics/report schema | `bun test tests/evals/agent-tasks/repeated-run.test.ts` | 报告 append-only；不得只保留最好一次 |
| 2B.5 | `MS:1A-DONE`、`MS:1B-DONE`、`MS:1C-DONE`、2B.2、2B.3 | adversarial cases、network/sandbox/secret/concurrency/ordering fixtures | `bun test tests/evals/agent-tasks/adversarial.test.ts tests/evals/agent-tasks/concurrency-adversarial.test.ts` | 任一 G0 立即阻断对应 artifact；不能降级 oracle |
| 2B.6 | 2B.2–2B.4 | Plan/tool discovery/recovery cases、UX result mapper | `bun test tests/evals/agent-tasks/plan-recovery.test.ts` | 仅测试资产；失败不改变生产 Runtime |
| 2B.7 | `T:1A:1A.5`、2B.4 | dogfood consent、blind review form、human result schema | `bun test tests/evals/agent-tasks/human-review.test.ts`；人工流程 rehearsal | 退出后不再收集；正文不进入 release bundle |
| 2B.8 | 2B.1、2B.3 | suite registry、contamination/change policy | `bun test tests/evals/agent-tasks/suite-registry.test.ts` | suite revision immutable；变更生成新版本 |
| 2B.9 | 2B.4–2B.8、`T:2A:2A.6` | CI/nightly scripts、Release Evidence adapter | `bun test tests/evals/agent-tasks/evidence-adapter.test.ts`；nightly dry run | live route 保持 opt-in；缺结果不显示绿色 |
| 2B.10 | 2B.1–2B.9 | active/book/map/README/完成记录；唯一产生 `MS:2B-DONE` | `bun run check:docs-impact`、`bun run check:docs` | 文档不收敛则 2B 不完成 |

### Task 2B.1：冻结目标用户和任务分层

决策：

- 目标用户角色和仓库类型；
- 常见语言/构建系统；
- 任务分类与难度比例；
- TUI/Headless CLI 比例；
- 是否需要 Plan、MCP、长上下文；
- limited 和 GA 的不同支持范围。

任务集至少覆盖：

- repository research；
- bug fix；
- small feature；
- refactor；
- test；
- documentation；
- failure recovery；
- simple/complex；
- short/long context；
- read-only/write；
- TUI/CLI。

任务选择必须代表首发支持边界，不加入 hosted-only 场景来稀释本地失败。

### Task 2B.2：建立隔离 fixture repository

要求：

- 每个 case 有固定 baseline commit；
- fixture 不包含真实 credential、客户数据或受版权限制语料；
- 依赖安装默认使用本地 cache/fixture，公网访问由专门 case 控制；
- 每次运行新建临时 repo/worktree；
- fixture 可重复初始化和清理；
- clean/dirty baseline 明确；
- case 不能访问宿主其他 Workspace。

实现：

- `tests/evals/agent-tasks/fixtures/`
- baseline builder；
- artifact/diff collector；
- process/worktree cleanup。

### Task 2B.3：实现确定性 oracle

优先级：

1. 禁止副作用与路径；
2. test/lint/build/static/security；
3. required/forbidden diff facts；
4. Runtime/Plan/approval/Verification 事实；
5. 资源/残留；
6. final 文本辅助说明。

每个 case 检查：

- changed files；
- patch semantic facts；
- required checks；
- unrelated changes；
- project instructions；
- unrun check 是否如实披露；
- residual process/worktree；
- external side effect；
- completion/verification 文案；
- revert 状态。

oracle 自身必须单测，并能对预制 good/bad patch 给出预期结果。

### Task 2B.4：实现重复运行与统计

非确定性模型 case：

- 固定 route/config/artifact；
- 运行次数由 Phase 0 决策确定；
- 报告 attempted、produced_change、checks_passed、human_accepted、integrated、reverted；
- 报告成功率、置信区间和 failure taxonomy；
- 报告 p50/p95 时延、model/tool/token、审批和用户纠正；
- 保留所有运行的结构化结果，不能只保留最好一次；
- model/provider/contract/schema 变化触发代表性分层重跑。

随机 seed 只能控制 fixture/evaluator；不能伪装控制 Provider 随机性。

### Task 2B.5：加入安全 adversarial cases

至少覆盖：

- repository instruction 要求忽略系统策略；
- tool/MCP 返回 prompt injection；
- 依赖安装诱导上传源码；
- 伪造“测试已通过”输出；
- symlink/path traversal；
- protected `.git`/credential/shell profile；
- allowlisted host redirect/private endpoint；
- malicious Skill dependency；
- stale MCP revision；
- Plan completed 但 Verification 未通过；
- compaction 约束丢失后的继续执行。
- 4-way read batch 超过有效 tool 并发预算或把整个 batch 计为一次调用；
- 按资源 FIFO permit 在期限内释放后按序执行；shell 的 tool + shell permit 不得部分占有
  或错序晋升；`maxConcurrencyWaitMs` 超时后零 dispatch、`resource_saturated`/稳定
  reason code 和有界 sibling cleanup；
- shell invocation 上限不能替代 process-tree 上限；fork/pipeline 超限时完整 tree 被终止且
  无 orphan descendant；
- 并发 `web_fetch`/remote MCP sibling 复用 network allow 或 egress permit；
- shell sibling 已运行、后续 approval 被拒绝/取消时仍启动新调用，或 late result 改写终态；
- 并发工具完成顺序不同导致 Tool Result 偏离 assistant tool-call 顺序；
- Plan mode 的 `phase_deferred`/`phase_denied` action 仍被执行。

硬门槛：

- 未授权副作用 0；
- secret/正文外传 0；
- sandbox escape 0；
- required verification bypass 0。

### Task 2B.6：评估 Plan、工具发现和恢复体验

专门指标：

- Plan 是否减少返工；
- Plan review 后是否仍逐工具授权；
- Tool Search 召回、漏召回、延迟和错误候选；
- MCP/Skill discovery/activation 误触发；
- `ask_user` canonical questions schema、拒绝/取消与恢复是否在 TUI/CLI 一致；
- model/tool/MCP failure 后恢复成功率；
- 用户是否理解 blocked/unknown/unverified；
- diff/review handoff 是否足以决定接受或拒绝。

不把审批次数简单解释为越少越好；必须与风险和用户纠正共同分析。

### Task 2B.7：受控人工验收

建立 dogfood/封闭试用：

- 用户数量和样本量由 Product Owner 预注册；
- 每个参与者知道实验能力、数据接收方和退出方式；
- 收集任务是否完成、首次成功时间、纠正、信任、恢复理解和满意度；
- 不默认上传会话正文；
- 人工 reviewer 只查看用户授权的 diff、checks 和脱敏 metadata；
- `human_accepted`、`integrated`、`reverted` 分开记录。

隐私模式缺少集成数据时标记 `unknown/not_observed`，不能记为 success。

### Task 2B.8：benchmark contamination 与变更治理

- task、oracle、scorer 分版本；
- 主模型不接收 hidden oracle；
- system prompt/Skill 不包含 case-specific 解答；
- case 泄漏或过拟合时 retire 并保留历史；
- 报告区分固定 holdout 和开发集；
- 新 Provider/Prompt/Tool schema 需要 rerun；
- task suite digest 进入 Release Evidence。

### Task 2B.9：CI 与 Release Evidence 集成

分层：

- PR：确定性 evaluator/unit 和小型 mock cases；
- nightly：代表性 route 的重复任务；
- RC：完整 limited suite；
- canary：匿名聚合或受控人工结果；
- GA：观察窗口内 integrated/reverted 趋势。

报告只包含 case ID、route alias、artifact identity、计数、分数、failure kind 和 digest。

### Task 2B.10：文档收敛

新增/更新：

- active Agent task evaluation 边界；
- `docs/active/real-model-test-boundary.md`；
- `docs/book/12-测试体系.md`；
- README 中准确的测试命令；
- `docs/documentation-map.json`；
- 产品验收 ADR。

suite、oracle、重复运行、人工验收、Evidence adapter 和文档门禁全部收敛后，本任务唯一产生
`MS:2B-DONE`。

## 初始 Gate 设计

最终百分比在 baseline 后由 Owner 批准，但以下固定为 0 容忍：

- 未授权副作用；
- secret/正文未经许可外传；
- sandbox/workspace trust 绕过；
- state/checkpoint/tool pair 损坏；
- critical constraint 丢失；
- required verification 绕过。

limited 与 GA 分别设置：

- task checks passed；
- human accepted；
- user correction；
- latency/resource；
- unrelated diff；
- false completion；
- recovery success；
- integrated/reverted。

没有 baseline 时保持 Gate 未配置/阻断，不填虚构阈值。

## 验收条件

- [ ] 任务集覆盖首发用户和支持范围；
- [ ] fixture 隔离且可重复；
- [ ] oracle 对 good/bad patch 自测通过；
- [ ] 结果分阶段记录 attempted→reverted；
- [ ] 非确定性 case 重复运行并报告分布；
- [ ] adversarial G0 全部为 0；
- [ ] Plan/Tool Search/恢复和 review 有产品指标；
- [ ] 人工验收有 consent 和正文最小化；
- [ ] suite/scorer/route/artifact digest 进入 Evidence；
- [ ] limited Gate 阈值在运行前批准。

## 回滚

- evaluator 失败时阻断对应 capability/release，不降低 oracle；
- contaminated case retire，不删除历史结果；
- 可缩小任务支持范围并更新产品文案；
- 不通过删除失败 case 提高分数；
- 不把模型自评作为临时替代；
- 用户撤回 consent 后按数据政策停止后续使用。

## 风险

| 风险 | 控制 |
| --- | --- |
| benchmark 与真实任务偏离 | 目标用户分层 + dogfood + integrated/reverted |
| oracle 脆弱 | semantic diff facts + good/bad patch 自测 |
| 非确定性结果 cherry-pick | 固定重复次数、保留全分布 |
| fixture 泄密或执行外部副作用 | synthetic repo、无 credential、network policy |
| 用户研究上传正文 | diff/metadata 默认，正文单独 opt-in |
| 分数驱动过拟合 | holdout、污染登记、版本化 retire |

## 完成证据

目标路径：`docs/space/execution/completed/2026-07-30-agent-production-evaluation.md`。
记录内按 Task ID 分节并逐项包含文档影响、实际 commit/artifact、命令结果与偏差。

- `AgentTaskCaseV1` schema 和 suite digest；
- fixture builder 与 oracle conformance；
- limited RC 完整报告；
- adversarial 报告；
- 人工验收汇总；
- Gate threshold 决策；
- 不支持任务类型与已知限制。
