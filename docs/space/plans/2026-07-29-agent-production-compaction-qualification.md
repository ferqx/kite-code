# Agent 生产化 Phase 4：压缩质量资格与 Manual Canary 计划

状态：draft
创建：2026-07-29
优先级：P1
依赖：
[`Phase 2A Release Control`](2026-07-29-agent-production-release-control.md)、
[`Phase 2B Agent Evaluation`](2026-07-29-agent-production-evaluation.md)、
[`Phase 3 Observability`](2026-07-29-agent-production-observability-operations.md)
架构依赖：ADR-0021、ADR-0022、ADR-0024
设计依据：RFC §11

## 目标

在不改变单一 Markdown narrative/checkpoint 契约的前提下，证明某个明确 Provider route 的
压缩同时满足结构正确、语义保真和任务 continuation 非劣，先放行 manual canary。

## 非目标

- 本计划不开放 external auto compaction；
- 不在 production checkpoint 增加 fact ledger；
- 不对真实用户 transcript 做远程 semantic review；
- 不按 model name 推断资格；
- 不把 token 缩减等同于语义成功；
- 不把历史单次 live success 作为 release evidence。

## 当前基线

- 结构边界、lease、checkpoint/replay、tool pair 和失败保留原状态已较强；
- 当前 acceptance 检查非空、truncation、tool call、narrative 上限和绝对缩减；
- 真实 Provider 曾出现 `Summary was truncated`；
- 当前 live suite 不验证目标、约束、错误、验证、Plan 和下一步；
- manual 默认 flag 当前为 true，但 limited profile 将由 2A ceiling 关闭。

## 主要改动范围

- 新增 `tests/evals/compaction/`
- 扩展 `tests/e2e/live/model/`
- compaction evaluator/report scripts
- route qualification registry
- Release Evidence/G3
- TUI/CLI route status 与 handoff
- active/ADR/book/map

## 实施步骤

### 任务执行矩阵

Phase 4 中的 internal auto 仅用于内部资格和安全证据；本计划唯一外部扩面是 manual canary。

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| 4.1 | `MS:2A-F`、`T:2B:2B.1` | `tests/evals/compaction/schema.ts`、cases/schema tests | `bun test tests/evals/compaction/schema.test.ts` | fixture schema versioned；旧结果只读保留 |
| 4.2 | 4.1 | structure/replay/lease/tool-pair conformance | `bun test tests/runtime/context-compaction-e2e.test.ts tests/evals/compaction/structure.test.ts` | G0 失败保持 manual/auto off |
| 4.3 | 4.1、4.2 | deterministic fact matcher/golden fixtures | `bun test tests/evals/compaction/fact-matcher.test.ts` | matcher revision 变化使旧 evidence 失效 |
| 4.4 | 4.1、4.3、`T:1A:1A.1` | semantic evaluator/rubric/blind fixtures | `bun test tests/evals/compaction/semantic-evaluator.test.ts` | evaluator 不可靠时 case blocked，不降门槛 |
| 4.5 | 4.2–4.4、`T:2B:2B.4` | control/treatment continuation runner/report | `bun test tests/evals/compaction/continuation.test.ts` | 非劣阈值预注册；失败关闭 route qualification |
| 4.6 | `T:1A:1A.5`、`MS:2A-F`、4.1 | route identity/qualification registry/tests | `bun test tests/evals/compaction/route-qualification.test.ts` | route/digest 变化自动撤销资格 |
| 4.7 | 4.4–4.6 | explicit live runner/matrix/evidence adapter | `bun run test:model:live`；不进入默认 `bun test` | `contextCompactionManualV1`/`AutoV1` 仍受 profile ceiling |
| 4.8 | `T:2A:2A.3`、4.6 | TUI/CLI pressure/handoff、no-compaction task cases | `bun test tests/evals/compaction/handoff.test.ts tests/tui-system/scenarios/compaction-handoff.test.ts` | 无资格 route 保持 manual/auto off；原 transcript 保留 |
| 4.9 | 4.2–4.8、`T:3:3.5`、`T:3:3.6` | internal manual/auto profile、evidence/Gate record；唯一产生 `MS:4-INTERNAL-AUTO-FRESH` | internal rollout Gate replay + G3/G4 | 不向 external cohort 开放；identity/freshness 变化即失效 |
| 4.10 | 4.9、`MS:LIM-APPROVED`、`MS:LIMITED-SLO` | external manual canary profile、dashboard/evidence | external manual canary Gate replay + G3/G4/G5 | critical failure cohort=0 + compaction off；不删除 checkpoint |
| 4.11 | 4.10 | `release/capability-decisions/manual-compaction.json`、maturity Gate record | `bun test tests/evals/compaction/manual-maturity-gate.test.ts`；Gate replay | 唯一产生 `MS:4-MANUAL-STABLE`；不允许 canary 直接标 stable |
| 4.12 | 4.1–4.11 | active/book/map/ADR/完成记录目标 | `bun run check:docs-impact`、`bun run check:docs` | 文档不收敛则 route 不进入 stable |

### Task 4.1：定义 `CompactionCaseV1`

case 至少包含：

- case ID/version；
- synthetic transcript；
- 1–5 轮增量；
- critical/important facts；
- category：goal、hard constraint、decision、artifact、failure、approval、
  verification、plan state、pending、next step；
- exact/normalized/semantic matcher；
- forbidden claims；
- optional continuation。

fixture fact ledger 只存在于测试，不进入 Runtime。

### Task 4.2：扩充结构 conformance

覆盖：

- safe settled turn；
- tool call/result pairing；
- transcript 不变；
- checkpoint digest/revision/replay；
- stale lease/environment drift；
- empty/truncated/tool call/oversized/insufficient reduction；
- direct/incremental/reset；
- 多次增量；
- 失败后原状态继续可用；
- system/tool schema/Plan/Verification 由权威状态重新注入。

任何 invalid checkpoint、orphan tool result 或状态损坏为 G0。

### Task 4.3：实现确定性事实 matcher

优先使用 exact/normalized：

- path；
- ID；
- error code；
- command；
- version；
- approval；
- verification result；
- Plan step/state。

要求：

- exact marker 的转义/大小写/路径规范化明确；
- critical 丢失 0；
- forbidden claim 0；
- approval/verification/Plan 反转 0；
- 多轮后旧 hard constraint 保留。

### Task 4.4：实现 semantic evaluator

仅用于不能确定性匹配的自然语言目标/约束：

- 固定 rubric/version；
- 不读取主模型自评；
- synthetic transcript，不使用真实用户内容；
- blind 输入，隐藏 control/treatment 标签；
- 报告独立分数和 uncertainty；
- semantic 分数不能覆盖 critical exact failure；
- evaluator route/config/digest 进入 Evidence。

若无法建立可靠 semantic evaluator，相关 case 保持 blocked，不降低为“人工感觉”。

### Task 4.5：Continuation 对照

每个 case：

- control：未压缩历史；
- treatment：summary + live tail；
- 相同 Provider route、model config、tool fixture、预算和 seed policy；
- 以 artifact/checks/Verification 评分；
- 必要时盲评；
- 记录 tool/token/time/cost。

Gate：

- treatment 相对 control 的非劣阈值；
- safety violation 0；
- 无无界资源增长；
- failure taxonomy 可解释；
- final 文本相似度不作为主结果。

阈值、样本量和置信区间在 baseline 后预注册。

### Task 4.6：Route Qualification identity

绑定：

- provider type；
- endpoint class/deployment route；
- model identity；
- resolved capability sources；
- summary/token/narrative limits；
- prompt/policy digest；
- estimator kind/version；
- Tool schema/active Skill environment digest；
- Provider Data Policy digest；
- evaluator/suite/scorer digest；
- artifact identity。

任何一项变化产生新 qualification。自定义 endpoint 无资格时 limited manual/auto 都关闭。

### Task 4.7：真实 Provider matrix

扩展显式 opt-in live runner：

- direct；
- incremental；
- multi-round；
- tool pair；
- Plan/Verification；
- long input/oversized；
- empty/truncated/tool call；
- Provider error；
- adversarial summary；
- route configuration change。

输出只包含 case/route alias、计数、分数、failure kind 和 digest，不输出 transcript/summary。

保持：

- `*.live.ts`；
- `bun run test:model:live` 或新增明确 script；
- 不进入默认 `bun test`；
- evidence 有 freshness/window。

### Task 4.8：Limited 无压缩体验

在 route 未资格时：

- auto/manual 按 profile 关闭；
- 提前显示 context pressure；
- 不 silent compact；
- 提供保存 diff、Plan、checks、pending 和新 session handoff；
- 原 transcript 保留；
- `/clear`/新 session 不显示为成功压缩；
- limited task suite 证明支持范围内任务可在无压缩预算完成；
- 超长任务明确 unsupported。

### Task 4.9：Internal compaction rollout qualification

顺序：

```text
off
→ internal manual
→ internal auto shadow
→ internal auto live
```

全部步骤只在 internal profile 验证 eligibility、自动调用、失败终态与 kill switch，不向
外部用户开放。通过后本任务唯一产生带 freshness 的 `MS:4-INTERNAL-AUTO-FRESH`。

### Task 4.10：External manual canary

仅在 `MS:LIM-APPROVED`、`MS:LIMITED-SLO` 和 fresh internal evidence 同时满足后：

- 每次一个 route/platform/cohort；
- 用户明确 experimental、指标和退出；
- 独立 capability kill switch；
- critical fact loss/checkpoint corruption/敏感泄露立即 off；
- generation/truncation/oversized/insufficient reduction/reset 分桶；
- canary 结果进入 G3/G4/G5；
- 本任务只产生 canary evidence，不得直接把 manual 标记 stable。

### Task 4.11：Manual compaction maturity promotion

消费 external manual canary 的预注册样本量、观察窗口、error budget、continuation
non-inferiority、G3–G5、用户理解度和 rollback rehearsal：

- maturity 按 `experimental → beta → stable` 分阶段写 decision record；
- beta 与 stable 使用不同 observation window，不得在一次 Gate 中连续跳级；
- route/prompt/policy/evaluator/artifact 任一 identity 变化使 decision 失效；
- 只有 stable Gate 通过才产生 `MS:4-MANUAL-STABLE`；
- 未通过时保持准确 maturity/canary/off，不阻塞不包含 manual 的其他能力。

### Task 4.12：文档收敛

更新：

- `docs/active/model-provider-boundary.md`
- `docs/active/real-model-test-boundary.md`
- `docs/active/plan-state-reminder.md`
- `docs/active/feature-flags.md`
- `docs/book/04-Agent引擎.md`
- `docs/book/12-测试体系.md`
- `docs/documentation-map.json`
- compaction quality/qualification ADR。

旧 archived rollout 计划保留历史，不改写。

## 验收条件

- [ ] structural G0 为 0；
- [ ] critical fact loss 为 0；
- [ ] forbidden/approval/verification/Plan 反转为 0；
- [ ] continuation 达预注册非劣阈值；
- [ ] route identity 覆盖 prompt/limits/estimator/data/tool/artifact；
- [ ] live matrix 有 fresh evidence；
- [ ] limited 无压缩 handoff 可用；
- [ ] manual canary 可独立关闭；
- [ ] manual stable 有独立 maturity producer、decision record 和 Gate replay；
- [ ] production checkpoint schema 未增加第二正文；
- [ ] 真实用户正文未进入 evaluator。

## 回滚

- manual capability 置 off；
- cohort 置 0；
- route qualification 撤销；
- profile/artifact 回退；
- 不删除 transcript/checkpoint；
- 不把失败 candidate 写入 checkpoint；
- 不回滚为按 model name allowlist；
- 不以 `/clear` 伪装压缩成功。

## 风险

| 风险 | 控制 |
| --- | --- |
| semantic evaluator 与主模型同偏差 | exact 优先、独立 route/rubric、continuation oracle |
| benchmark 只覆盖短文本 | multi-round/long/adversarial |
| route 配置漂移沿用旧资格 | 完整 identity/digest |
| manual canary 误扩为 auto | 独立 capability/profile/gate |
| 用户长任务在 limited 中断 | context pressure + handoff + 支持范围 |
| live cost 无界 | Phase 1C budget + 固定 suite/sample |

## 完成证据

- CompactionCase suite/scorer digest；
- structural/semantic/continuation 报告；
- route qualification registry；
- live matrix；
- limited handoff UX；
- external manual canary SLO；
- capability rollback 演练。
