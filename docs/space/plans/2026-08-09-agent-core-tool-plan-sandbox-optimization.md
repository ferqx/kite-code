# Agent 核心工具、计划闭环与沙盒能力优化计划

状态：superseded
日期：2026-08-09
优先级：P0（可信执行内核）/ P1（Git 与多 Agent 扩展）
替代：剩余执行范围由 `2026-08-11-trustworthy-runtime-closure.md` 接管；本文保留历史设计、已完成 Task 与实现证据，
不再作为当前执行入口。
关联：ADR-0094、ADR-0095、ADR-0096、ADR-0097、
`docs/active/plan-mode-implementation.md`、`docs/active/tool-description-contracts.md`、
`docs/active/tool-gated-autonomy.md`、`docs/active/execution-boundary.md`、
`docs/active/real-model-test-boundary.md`

## 目标

把 Agent 的优化重点从单次 prompt 命中率扩展为可验证的完整工作闭环：计划不能虚假完成，工具调用参数有效，失败后只做
有依据的恢复，重复失败可被 Runtime 阻断，整轮耗时可拆分。产品主张收敛为“可信、可恢复、可审计的本地 Code Agent
Runtime”；Shell/Git 先在一个参考平台形成最小正向闭环，其余平台保持诚实 excluded，不再以同时铺满三平台阻塞可信内核
的候选验证。

本计划先固化架构与验收规则，再实施。Prompt Contract V2 继续遵守 ADR-0094：默认关闭；任何默认值迁移都必须在新的最终
候选上完成真实整轮 A/B，并由独立迁移 ADR 决定。本计划不恢复已取消的十四日时间门禁。

## 已验证的问题边界

1. **计划完成真值缺口（P0）**：final 文本可绕过未提交、待 review 或未执行完成的 PlanningState，并最终把 Task 标为
   completed；现有 PTY fixture 还把这种路径固化为通过。
2. **评测证据缺口（P0）**：当前 Prompt A/B 只调用一次模型、不执行工具；`totalDurationMs` 不是整轮耗时，同一响应按
   工具名统计重复既会误报不同参数调用，也会漏掉跨轮相同失败重试。
3. **失败恢复缺口（P0）**：普通工具失败没有稳定 failure code、retry policy 与 duration，主 Runtime 未接入无进展失败
   journal，最坏只能依赖 30 分钟/60 model requests/250 tool calls 的灾难预算停止。
4. **Git 能力边界分裂（P0）**：macOS/Linux 通用 shell 可触及 `.git`，Windows protected ACL 阻止 mutation；macOS
   qualification probe 与 production runtime profile 还不一致。命令文本扫描不是可靠安全边界。
5. **契约与生命周期漂移（P1）**：V2 首句归一可能丢恢复语义；部分 failure guidance 双写；Plan schema、replan、
   update version binding、subagent 终态及 TUI 投影不完全一致。

## 不在本计划范围

- 不以放宽 ACL、sudo/chmod、绕过 sandbox 或自动扩大 approval 解决工具失败。
- 不在 typed Git capability 中提供任意 argv；remote Git 不与本地 inspect/mutation 一起准入。
- 不把所有重复读取直接视为 doom loop；只有 canonical args、稳定失败原因和相关 revision 均相同且无进展才阻断。
- 不用全局平均成功率掩盖 Plan、Shell/Git、recovery 等关键类别回退。
- 不因本计划直接翻转 `promptContractV2` 默认值。

## 2026-08-11 产品方向收敛

经当前实现与同类 Code Agent 能力对照，本计划不再追求功能数量、Agent 数量或平台矩阵的表面齐全，后续资源按以下顺序投入：

1. **可信执行内核（P0）**：CompletionGuard、Plan evidence、Runtime-owned ToolOutcome、durable recovery journal 与
   full-loop Journey eval 是本计划的核心交付。它们必须证明降低假完成、错误重试或失败放大，而不只证明内部状态机自洽。
2. **受控协作（P1）**：保留最多三路 approval-free 只读 Subagent 和 code 串行边界；本计划不扩展后台 Agent、Agent team、
   嵌套委派或更高并发。只有预注册独立只读任务证明端到端时延或任务成功改善，才另立后续计划扩展。
3. **Typed Git（P1）**：保留已实现的 broker 与 fail-closed 安全资产，资格顺序改为 macOS 参考平台优先。Linux/Windows 在各自
   native read/write deny、production composition 与 probe identity 同构前继续 excluded。若 macOS 也不能在不放宽边界的前提下
   形成正向闭环，则 Git capability 保持默认关闭并冻结扩展，不阻塞可信内核 RC。
4. **模型与 Prompt**：`promptContractV2=false` 保持不变。新的 Prompt、状态版本、恢复分类或并发抽象，必须由冻结 Journey 中
   可复现的用户价值缺口驱动；不得以竞品已有某项功能作为单独实施理由。

本次收敛只调整产品优先级、候选依赖和后续验收，不改变已经落地的 Runtime 行为，也不把 blocked/excluded 改写为 completed；
因此不新增或改写架构 ADR。

## 用户价值计分卡与停止条件

最终候选在实现正确性之外，必须报告同一 base、同一模型/Provider、同一任务输入下的 paired 用户价值指标：

- 任务成功、false completion、错误自动 replay、policy/approval rejection 后重试；
- 首次失败后的 model requests、tool invocations、failure amplification 与恢复成功率；
- active turn / wall-clock p50、p95，以及人为 approval wait 分离后的耗时；
- 完成一个任务所需的用户追问、纠正和审批次数；
- 只读 Subagent 相对串行基线的任务成功、总调用量和端到端耗时；
- Git broker 仅对真实 qualified 平台报告 positive capability，excluded/unsupported 不计作通过。

停止和收缩规则：

- correctness Gate 仍要求 false completion、错误 replay、安全违规为零；任何一项失败都不能用速度或平均成功率抵消。
- 若可信内核相对 legacy 没有减少假完成/错误恢复/失败放大，且任务成功无改善，则停止新增 guard/outcome 状态，优先删除或合并
  没有独立决策价值的复杂度。
- 若只读 Subagent 未在冻结任务上改善成功率或端到端耗时，则保持当前上限和串行 code，不扩展后台/团队能力。
- 若参考平台 Git qualification 需要放宽 protected path、恢复 raw shell Git 或依赖 label/hash 冒充原生证据，则保持 feature off，
  记录 excluded 后结束本计划的 Git 扩展，不继续铺设其他平台。
- 同类产品黑盒结果只作为产品定位参照；不同模型、远程环境和权限默认值不能冒充同一实现的因果 A/B，也不成为发布 Gate。

## 实施顺序与变更隔离

先以现有产品行为建立 Tool Journey 纯观测 baseline，再按 ADR-0095 → ADR-0096 的依赖完成可信内核；ADR-0097 的 Git
资格与 Agent 并发作为 P1 lane 独立收口。CompletionGuard 建立可信终态，Runtime-owned ToolOutcome 建立失败证据，随后先冻结
用户价值计分卡并执行完整 Journey 候选验证。Git broker 和 Subagent 的扩展不得反向阻塞已默认关闭或已诚实 excluded 的可信
内核候选。每个 PR 都同步相应 active 文档；不得把当前工作区中尚未收口的 Prompt A/B fixture 改动与架构 PR 混为一个不可审查
提交。

Git broker 可先在不向模型暴露的 shadow profile 中验证；正式切换时，tool disclosure、dispatch 与 shell native deny 必须由
同一 feature revision 原子生效。安全回滚态允许某项操作稳定 unsupported，但不允许重新给予整个 shell `.git` 原生访问。

## 当前执行约束：CI 稳定化与 Plan Evidence tranche

2026-08-10 的执行顺序固定如下：先完成 `ACORE-CI-01`，再执行 `ACORE-PLAN-02`；二者完成并不授权合并当前
PR。PR 只在本总计划全部 Task 与 `ACORE-RC-01` 的最终候选证据收敛、Required CI 全绿且完成 review 后才可合并。

`ACORE-CI-01` 是当前 PR 的前置稳定化 Gate：对 `unit`、`runtime-e2e`、`runtime-fault-soak` 与各 shard 的
`tui-system` 失败逐项复现、读取完整日志、追溯到引入提交或既有环境差异，并以最小回归测试和修复收口。不得把失败
标为 baseline、跳过测试或通过降低断言使 CI 变绿；无法在本地复现时必须保留 CI 证据并以同一环境重新运行。

`ACORE-PLAN-02` 只扩展 Plan 的 canonical schema 与 completion evidence：统一 save/submit/replan 的
plan ID、revision 与 digest transition，拒绝 stale/重复/冲突/terminal 倒退；写入最小的验证命令与退出状态、变更摘要、
skipped 理由及未解决 failure/approval。随后由独立 `ACORE-PLAN-03` 新增单调的 CompletionGuard decision version，在 required verification
或 effect-after-verification 未闭合时拒绝 completion。两者都不引入 ToolOutcome、retry journal、Git broker 或 subagent
并行；这些仍由后续 Task 独立实施。每个行为先通过可重复的失败测试定义，再以最小实现和 replay/PTY 覆盖验证。

## Task 执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| `ACORE-DOC-01` | — | 总计划、ADR-0095/0096/0097、三方向 Review 记录 | `bun run check:docs-impact`; `bun run check:docs` | 仅文档；ADR 未接受前不改当前行为 |
| `ACORE-EVAL-00` | `ACORE-DOC-01` | scripted model + 现有 Runtime 的 full-loop baseline harness | deterministic journeys；privacy assertions | 纯观测，不改变产品恢复行为 |
| `ACORE-PLAN-01` | `ACORE-EVAL-00`、接受 ADR-0095 | CompletionGuard V1、draft disposition、correction、legacy replay migration | Runtime/replay/property tests；动态 Plan PTY | 仅使用现有 canonical 证据；不得猜 unresolved failure |
| `ACORE-PLAN-02` | `ACORE-PLAN-01` | Plan schema/evidence、version/digest transition、legacy replay-only migration | schema conformance；stale/conflict/transition tests | 兼容读取旧 artifact；新写仅 V2 |
| `ACORE-PLAN-03` | `ACORE-PLAN-02` | CompletionGuard V2 verification/effect evidence gate | guard/replay/runtime journey tests | 保留 V1 legacy replay；guard decision version 单调增加 |
| `ACORE-TOOL-01` | `ACORE-EVAL-00`、接受 ADR-0096 | Runtime-owned ToolOutcome/Recovery、单 event shadow 投影 | event/replay matrix；metadata-only tests | 同一 terminal event 双字段对照，逐工具切换 |
| `ACORE-TOOL-02` | `ACORE-TOOL-01`、`ACORE-PLAN-01` | durable no-progress journal、retry guard、Guard unresolved-failure upgrade | fault/restart/replay journeys；resource budget tests | 成功重复先只观测；decision version 单调增加 |
| `ACORE-EVAL-01` | `ACORE-PLAN-03`、`ACORE-TOOL-02` | Tool Journey Eval V1 typed-outcome/guard 回归与 first-decision eval 纠名 | deterministic full-loop suite；lineage/timing/privacy | eval 不改变产品行为，可独立回滚 |
| `ACORE-CONTRACT-01` | `ACORE-TOOL-01` | 结构化 ToolSpec contract、删除双写 guidance、20/20 当前覆盖（原计划 22，mutation 两工具已删除） | legacy/V2 × phase contract tests | 分工具迁移；先观测 unknown fields |
| `ACORE-GIT-01` | `ACORE-CONTRACT-01`、接受 ADR-0097 | 独立 capability surface、hardened `git_inspect` broker | broker positive/hostile；protected-content tests | broker 先上线，shell 边界暂不切换 |
| `ACORE-GIT-02` | `ACORE-GIT-01` | macOS 参考平台 native deny、调用原子迁移、probe/runtime 同构；Linux/Windows 保持独立 exclusion | shell negative；TUI routing；evidence identity | 未达 read/write deny 的平台 excluded，不虚报支持 |
| `ACORE-GIT-03` | `ACORE-GIT-02` | stage/commit typed capability；remote 独立设计或延期记录 | approval、lock、cancel、hostile config tests | mutation 独立开关；不回退到 raw shell |
| `ACORE-AGENT-01` | `ACORE-PLAN-02`、`ACORE-TOOL-02`、`ACORE-CONTRACT-01` | plan subagent 契约、最多 3 路只读 batch、统一终态/TUI | recovery、parallel、event/result/TUI consistency | code subagent 保持串行；并发受累计预算约束 |
| `ACORE-EVAL-POLICY-01` | `ACORE-EVAL-01` | 冻结 suite/scorer/report、case floor、样本与统计规则 | policy self-check；manifest immutability | 必须在候选结果前冻结，修改即产生新 revision |
| `ACORE-VALUE-01` | `ACORE-EVAL-01`、`ACORE-GIT-01`、`ACORE-AGENT-01` | 冻结用户价值计分卡、legacy/candidate identity、Git disposition 与 Subagent 串行基线 | policy self-check；paired dry-run；privacy | 指标或 fixture 修改产生新 revision；竞品黑盒仅作参照 |
| `ACORE-RC-01` | `ACORE-PLAN-03`、`ACORE-TOOL-02`、`ACORE-CONTRACT-01`、`ACORE-AGENT-01`、`ACORE-EVAL-POLICY-01`、`ACORE-VALUE-01` | OpenCode Go 最终候选完整 Journey A/B 与发布证据；记录 GIT-02/03 qualified 或 excluded disposition | Required/RC CI；live paired matrix | V2 默认关闭；Git 默认关闭/诚实 excluded 不阻塞可信内核 RC |

## 当前执行状态

| Task | 状态 | 已收敛范围 |
| --- | --- | --- |
| `ACORE-DOC-01` | completed | ADR-0095/0096/0097 已接受、ADR-0070 历史状态已取代、三方向 Review closure 已记录。 |
| `ACORE-EVAL-00` | completed | `ACORE-EVAL-00-v1` scripted Runtime Journey 与 metadata-only privacy assertion 已建立。 |
| `ACORE-PLAN-01` | completed (V1) | CompletionGuard 在 scheduler/runner/reducer 三层阻止虚假完成，一次 correction 后 blocked terminal；后续 evidence/typed failure gate 由 `ACORE-PLAN-02`/`ACORE-TOOL-02` 承接。 |
| `ACORE-PLAN-02` | completed | PlanDocument V2、strict identity、metadata-only evidence、V1 read/replay-only migration，以及 Artifact/reducer/facade fail-closed 边界已通过整体规格与质量审查。 |
| `ACORE-PLAN-03` | completed | CompletionGuard V2 verification/effect evidence gate、严格 Plan identity、schema-bound legacy replay、跨 turn correction ceiling、required-verification metadata-only Journey 与 atomic terminal batch 已通过整体规格/质量审查；PR 级门禁仍独立待执行。 |
| `ACORE-TOOL-01` | completed | Runtime-owned ToolOutcome V1、同 terminal event shadow、strict legacy replay、metadata-only unknown-field/session/metrics/TUI projection 已落地，并通过整体规格与代码质量审查。 |
| `ACORE-TOOL-02` | completed | Durable parent/subagent recovery journal、private HMAC identity、recoveryOf、一次 correction/retry ceiling、fail-closed restore、quality guard 与 CompletionGuard unresolved gate 已落地，并通过整体规格与代码质量审查。 |
| `ACORE-EVAL-01` | completed | `ToolJourneyEvalV1` 10 条冻结 ID 的 deterministic full-loop case、真实 pre-dispatch retry/sandbox denial/replan/guard、typed terminal/lineage/timing/privacy 报告与 first-decision 纠名已落地，并通过整体规格与代码质量审查；未运行正式十轮 A/B 或真实 Provider。 |
| `ACORE-CONTRACT-01` | completed | 20/20 builtin structured contract（含只读 `git_inspect`）、legacy/V2 × planning/building resolved schema/parse 矩阵、父子 public result/classifier/model-content 同构与 Runner recovery 单一事实源已落地；原 19 工具 closure 已通过审查，Git inspect 扩展随本 tranche 待整体审查。 |
| `ACORE-GIT-01` | implemented / review pending | 只读 gitInspect surface、hardened `git_inspect` broker、hostile repository 与 protected-content fail-closed 已落地；待整体规格/质量审查。 |
| `ACORE-GIT-02` | blocked (reference platform not qualified) / review pending | 精确 feature revision 的 disclosure/dispatch/native deny 代码接线与 Shell typed routing 已落地，但 TUI/CLI 原生资格证据尚未证明任何平台同时满足 metadata read/write deny；后续仅先尝试 macOS 参考平台，未资格平台继续 excluded，不声称 implemented/completed。 |
| `ACORE-GIT-03` | removed by closure plan | 提前实现的 `git_stage`/`git_commit`、mutation 授权/receipt/mutex 已删除；GIT-02 qualified 前不恢复。 |
| `ACORE-AGENT-01` | implemented / review pending | 用户权威委派、planning save→submit、共享预算与 running/suspended/terminal 生命周期已落地；专用三路 batch 与重复恢复完成态已由收口计划删除。 |
| `ACORE-EVAL-POLICY-01` | frozen (r1) | first-decision candidate `300e11a4`、OpenCode Go、十轮 paired sample 和 Go usage privacy boundary 已冻结；完整 Journey candidate 仍待后续 scope 收敛。 |
| `ACORE-VALUE-01` | pending | 待整体审查关闭后冻结可信内核用户价值计分卡、Subagent 串行基线与 Git qualified/excluded disposition。 |
| `ACORE-RC-01` | pending | 等待 `ACORE-VALUE-01` 与整体审查收敛；不再等待默认关闭的 GIT-03 取得跨平台 mutation qualification。 |

## `ACORE-DOC-01`：文档冻结与 Review

1. 总计划说明问题证据、依赖顺序、非目标、指标、平台矩阵和回滚。
2. ADR-0095 定义谁有权声明完成；ADR-0096 定义工具失败与恢复单一事实源；ADR-0097 拟取代 ADR-0070 的 Git 权限结论。
3. Tool/Recovery、Plan/Agent、Sandbox/Git 三方向分别只读 Review；所有 P0/P1 意见必须解决或作为明确 blocker 登记。
4. 三个 ADR 已于 2026-08-09 接受，本计划同步进入 `active`；ADR-0070 已标为 superseded，历史正文保留。各实现 PR
   同步相关 active 文档。

## `ACORE-EVAL-00`：改动前整轮基线

正式 live first-decision 样本先受 `ACORE-EVAL-POLICY-01-r1` 约束：候选固定为 `300e11a4`，在政策与候选 identity
冻结前不运行；该候选不代表后续 CompletionGuard/Journey 候选。

- 使用 scripted model 驱动现有真实 Runtime loop，注入确定性工具结果、故障与延迟；不先依赖待实现的 ToolOutcome。
- fixture 使用隔离 HOME、Kite data root 与 synthetic workspace；报告断言不含 prompt/response、args、path、command、
  stdout/stderr、stack、provider body 或完整 endpoint。
- 记录首次工具选择、实际调用/结果序列、现有失败放大与 queue/model/tool/approval timing，作为后续改动对照；不把 baseline
  缺失字段猜测为 typed 事实。
- live 分支必须闭合严格 route、credential source、model attempt、实际 HTTP dispatch/response、usage/token 与唯一 Provider
  response ID 覆盖；证据不全时非零退出。账户侧 Go usage 可作人工补充证据，但 Zen credit balance 不是订阅调用的必需变化。

2026-08-10 已建立 deterministic `ACORE-EVAL-00-v1`：scripted model 通过真实 Kernel/scheduler/runner 执行
`model → read_file → model → run.completed → turn.completed`，记录两个 model attempt、一个 queue/start/finish 对和
metadata-only event counts。fixture 只断言报告不含 path 或内容，作为 ToolOutcome/Journey 后续改动的基线；它不执行
真实 Provider，也不把 first-decision A/B 冒充整轮 Journey。

## `ACORE-PLAN-01`：CompletionGuard 与完成事件防线

- 用 Core-only 类型表达完成 candidate、现有 state 可判定的 blockers、draft disposition、blocked reason 与 next action。
- blocked event 消费 candidate，typed recovery 最多触发一次模型纠正；再次失败进入非成功 blocked terminal，不能循环。
- 新 completion event 绑定 decision version；V1 不猜尚未存在的 recovery/verification 证据。旧 snapshot/event 显式迁移，
  不能因 replay 忽略历史完成而改变 Task 归属。
- PTY response factory 可读取上一 Tool Result 中的动态 plan identity；teardown 校验 call/result 配对。基础 journey 断言
  `plan.drafted < review_requested < approved < progress_updated < plan.completed < run.completed < turn.completed`，并同时检查
  viewport、Runtime Store、Task status 与事件顺序。错误 final 必须证明发生一次纠正请求，而不只是 UI 未显示 Completed。

## `ACORE-PLAN-02`：Plan schema 与进度一致性

- 合并 model、artifact、Runtime 与 contract 的 schema，区分 schema/format/plan revision；锁定 title 120、body min 20、
  1–12 unique steps、step title 160 和单行约束。
- `write_plan` 的 save/submit 与 executing replan 使用一致状态机。
- approval result 暴露完整统一命名的 plan ID/revision/digest；`update_plan` 拒绝 stale、重复 step、冲突和 terminal 倒退。
- `read_plan` 本阶段只承诺 active current version；如需历史读取另立 schema，不让 prompt 要求尚不存在的能力。
- 引入轻量 completion evidence：变更文件摘要、验证命令及退出状态、skipped 理由、未解决失败/审批，不保存不必要正文。
- evidence 落地后升级 CompletionGuard decision version，加入 required verification 与 effect-after-verification gate。

## `ACORE-TOOL-01`：统一 ToolOutcome

- Runtime envelope 统一 status、现有 FailureKind、闭集 detail code、dispatch/effect certainty、recovery lineage 与可信 timing；
  Registry、Policy、Controller、executor 和 ToolSpec 只填写各自权威字段。
- 同一 terminal event 保留 legacy fields + shadow outcome，reducer 只投影一次，保持 tool call/result 一一配对。旧失败 replay
  为 `legacy_unclassified/unknown` 且不自动重试。
- session 与 telemetry 只记录低基数枚举、计数和可信 timing；canonical fingerprint 仅在 canonical private Runtime Store/
  internal journal 持久化或由其重建，不进入诊断 SessionLog、telemetry 或 eval，也不输出 digest、命令、路径、args 或
  stdout/stderr。
- unknown fields 在 strip 前只记录 has/count、tool class 与 schema revision，不记录字段名/值。
- envelope restore 使用 exact-key/semantic matrix；producer/reducer/model/session/metrics/TUI 从同一
  outcome 投影，Shell timeout、human approval wait 与 total active timing 使用 Runtime 结构化边界。

## `ACORE-TOOL-02`：失败 journal 与无进展保护

- 父 Runtime 与 subagent 使用同一 durable/replayable journal、failure instance 与 `recoveryOf` lineage。parsed call 使用 spec
  identity；pre-parse invalid/unknown call 使用 Runtime 保守 fallback identity。只有 tool-owned receipt/content/plan/capability
  revision 可 reset progress；重启不能重置 ceiling。
- approval/policy deny 为零新调用；参数修正允许一次新模型 invocation；Runtime 只在 pre-dispatch 或 safe-read/idempotency
  receipt 明确时自动 retry once。timeout/cancel/unknown external effect 默认不重放。
- Runtime/Policy/dispatch/effect/idempotency 判定优先；ToolSpec 只能收紧。classifier 缺失或冲突时 fail closed 为 unknown/never。
- lineage 可从 canonical private Runtime Store 持久化或重建，但内部 fingerprint 不进入诊断 SessionLog、telemetry 或 eval。
- 区分 disaster resource budget 与 quality guard；后者必须在 250 次工具上限之前阻断无进展循环。
- journal 绑定 task/turn/immediately-next response 并用稳定 resolution 收敛 terminal、skip/replan/user/
  provider progress；safe-read 第二次 dispatch 前必须取得 RuntimeStore durable ack。当前 ToolSpec/MCP
  binding schema defaults+revision 形成 parsed identity，malformed raw equality 只进入私有 HMAC。
- Subagent MCP binding failure 与 legacy exhausted bypass 走同一 terminal/journal/quality/restore/parent
  merge 路径；CompletionGuard 只阻当前 active scope，旧 task 不污染新 task。

## `ACORE-EVAL-01`：Tool Journey Eval V1

确定性 suite 至少覆盖：search → read、read → edit → verify、invalid args → 一次修正、ENOENT → locate → success、
`rg` no-match → stop、approval/policy rejection → no retry、safe pre-dispatch transient → at most once、timeout/unknown effect →
no replay、sandbox/permission denial →
no privilege escalation、重复失败 → replan/finalize。每条完整执行 Runtime loop，并注入可控故障与延迟。

现有 Prompt A/B 重命名为 first-decision eval；重复只在本地运行期使用 internal identity 计算，对外只报固定计数。它继续
作为 prompt 选择证据，不能报告 whole-turn 性能。

2026-08-11 已实现 `ToolJourneyEvalV1`：十条冻结 ID case 的 scripted model 不得直接伪造 terminal/retry/rejection/run.error，
工具执行、durable retry、approval/policy 与 CompletionGuard 均经过 production Controller/executor/Kernel；报告从 reducer/store
事实派生固定 case ID、真实 Runtime/boundary/provider dispatch attempt、canonical outcome FailureKind/detail/authority/recovery、lineage 是否存在、稳定 resolution、可信 timing
与 atomic guard terminal。递归 exact-key allowlist privacy test 禁止正文、路径、命令、stdout/stderr 与 private identity/lineage ID，
闭集值复用 production types，计数只接受有限非负整数，`metadataOnly` 来自 schema validator；每条 synthetic workspace、HOME、Kite
data root 与 Kernel 均由最外层 `try/finally` 隔离/恢复/关闭，uncached seam 单独复验环境恢复。safe transient 在真实 MCP readiness
pre-dispatch failure 后 durable ack，再执行唯一 capability dispatch，并保留初始失败与最终成功；sandbox permission case 经过
production fail-closed executor，产生 `sandbox_error/sandbox_denied`；可触发 fallback sentinel 与 persisted authorization-widening
event 证明零底层命令/零放宽/replay，不再报告不可观测的权限提升常量；重复 failure 通过真实 write_plan
replan/review/update_plan finalize 收敛。
canonical live 入口为 `test:first-decision:live` / `scripts/evals/first-decision-eval.ts`，报告 schema 为
`FirstDecisionEvalV1` 且固定 `evaluationScope=first_decision_only`；旧命令/API 仅作兼容别名。本 tranche 未运行正式十轮
A/B、真实 Provider 或 Go usage 核验。

## `ACORE-CONTRACT-01`：ToolSpec 契约收敛

- 全部 builtin specs 从 availability context 生成合法的 legacy/V2、planning/building 期望矩阵；context-sensitive schema 的
  projection 与 parse 必须使用同一个 resolved schema，不做无效笛卡尔积。
- selection、参数约束、result、recovery 各自结构化，V2 不再依靠“取第一句”保存关键语义。
- 删除旧 guidance 前证明父/子 Runtime result projection 同构；先观测 unknown-field rate，再渐进 strict。

2026-08-11 已将原 19 个 builtin 与 brokered Git 新增 3 个 builtin 全部绑定到 `BUILTIN_TOOL_CONTRACTS` 的结构化 selection/use/constraints/result/recovery
事实；Skill runtime 不再保留独立契约，Runner recovery guidance 直接读取 Registry ToolSpec，V2 逐事实投影而非截取旧文案
首句。conformance 覆盖当前 20/20、带合法 Skill catalog/active frame/task adapter 和只读 Git broker surface 的 legacy/V2 × planning/building availability
context，并分别验证 provider JSON Schema 与 Registry parse 的有效/无效/unknown 输入。每个 builtin 的真实
`projectResult/createInterrupt` 还会经过 canonical terminal、reducer 与 provider context，JSON key 必须落在 contract fields，
text 返回不得虚构字段；unknown-field 只保留 metadata-only 低基数观测。旧四段式输入仅供外部/测试 Registry 读取兼容。
父 Runtime reducer/Subagent provider context 复用唯一按 status 分流的 public model-content helper 与 ToolSpec classifier advice：success
使用 `stdout || stderr || ''`，failure 使用 `stderr || stdout || ''`。八组 success/failure × stdout/stderr 空值组合均有真实 parity test，
shell failure 另走 runApprovedTool→Controller terminal→Kernel reducer→provider context 并对照 ToolSpec/returns；child 不再 JSON 化完整 `ToolExecutionResult`；
ENOENT parity journey 同时验证 detail/recovery 一致以及 command/path/resultMeta/private guidance 不进入 Tool Result。

## `ACORE-GIT-01`：只读 Git broker

2026-08-11 实现状态：implemented，整体规格/质量审查 pending；未标记 completed。

- 新增只读 `gitInspect` capability surface、双门禁、revision、repo binding、executable identity 与 receipt；generic
  read-only fallback 不得隐式包含 broker。
- status/diff/log/branch_list 使用固定有界 schema；broker 在首次 Git process 前安全解析 Git metadata，验证 canonical
  Workspace 外 binary、配置/attributes/replace/grafts，并清 credential/hook/filter/fsmonitor 等执行面。
- protected evaluator 先生成允许 path/pathspec，禁止 protected 名称、内容和历史 blob；无法预过滤则 fail closed。
- worktree controller 只作为防护素材。Core 持有 interface/spec，App 提供 process adapter，禁止反向依赖。

## `ACORE-GIT-02`：参考平台调用迁移与 Shell 收口

2026-08-11 状态：production qualification blocked、整体规格/质量审查 pending；当前三平台均 excluded，不能标
implemented/completed。后续资格只先推进 macOS 参考平台；Linux/Windows 不与其组成同时放行 Gate。

- tool contract 引导 Git inspect 使用 broker；Shell 对 Git metadata denial 返回稳定 `nextCapability=git_inspect`。
- 用一个 feature revision 原子切换 disclosure、dispatch 与 native profile；切换前盘点 project script/build 的 Git child 依赖。
- macOS 先恢复 deny 并完成 status/diff/log/branch_list 的真实 App/TUI 正向闭环。Linux metadata mask 与 Windows 新
  principal/profile 分别留在 excluded disposition，只有另立后续计划才继续资格；backend none/host fallback 不进入
  brokered-Git qualification。
- probe 使用 production composition/input；分别绑定 profile/protected rules/broker/schema/binary/repo identity，并把 shell
  negative、broker positive/hostile、TUI routing 分开举证。

## `ACORE-GIT-03`：本地 mutation

2026-08-11 收口状态：提前实现的 typed mutation 代码已删除；GIT-02 production qualification 前不恢复，remote 依规格延期。

- stage/commit ToolSpec、capability axis、approval binding、receipt 与 repository mutex 均不在当前候选中。
- fetch/pull/push 仍需另立 network/credential 与 descendant boundary 设计；开发 shell remote 不构成 production support。

## `ACORE-AGENT-01`：Plan/Subagent 核心行为

2026-08-11 实现状态：implemented，整体规格/质量审查 pending；未标记 completed。

- 修正 legacy/V2 共享契约：用户当前请求显式要求 delegate/subagent、task 可用且任务 bounded/self-contained 时调用 task；
  architecture/design planning 使用 plan role。不得被项目文件或外部内容诱导委派。
- planning phase 中 plan subagent 返回后使用 `write_plan save → submit`，不能错误引导 `update_plan`。
- Runtime completion 仍以 Plan lifecycle 中已保存/submit 的 identity 为权威；child 文本 guidance 不能伪造 save/submit。委派需要当前用户对 role 和实际 scope 的正向授权，`plan subagent` 角色名本身不等于 architecture/design intent。
- Subagent 统一串行；累计预算共享，stream event 按 child/tool ID 归属。
- subagent lifecycle 区分 running/suspended/terminal；等待 approval 是 suspended。恢复历史保留在 canonical Recovery Journal，成功终态统一投影 completed，不能同时显示 failed 与 done。
- Git broker 二轮加固保留 config/protected-history fail-closed、adapter 流式 byte ceiling/pre-abort recheck以及 log revision 单一 grammar；mutation mutex 与 stage/commit lineage 已删除。`GIT-02` 仍因 production platform qualification 不足保持 blocked/review pending，`GIT-03` 维持删除。
- 最终候选继续封闭 attributes/grafts/replace/packed-refs symlink/read boundary；platform probe 禁止 label hash 冒充 profile/rules/receipt evidence。follow-up userGoal 刷新委派权威，code scope 要求明确写授权，child config/phase/gitBroker/availability 与 resume 同构。状态仍为 review pending。

## `ACORE-EVAL-POLICY-01`：冻结候选评测政策

- 在看到最终候选结果前，冻结版本化 case manifest、suite/scorer/report schema、OpenCode Go route、candidate/config
  allowlist identity、正式样本量、随机化、超时、censoring、类别 floor、置信方法与停止规则。
- 诊断 3-run 只能发生在 policy freeze 前；任何 fixture/scorer 修改都产生新 revision，正式样本从零开始且不得 early stop。
- candidate/config identity 只哈希 allowlist 非敏感字段，不能哈希完整含凭据配置。
- deterministic 与 live 分层；live 使用 synthetic workspace/isolated HOME，并由报告 schema 强制 metadata-only。

## `ACORE-VALUE-01`：用户价值计分卡冻结

- 在整体规格/质量审查关闭后、任何最终候选结果产生前，冻结 legacy/candidate commit、Journey case、模型/Provider、样本量、
  task success、false completion、failure amplification、用户介入、调用量、active/wall timing 与 privacy scorer。
- Subagent case 必须同时运行当前最多三路只读 batch 与串行基线；不以并发数、child 数或模型自报完成作为价值指标。
- Git case 只把真实 native deny + broker positive + App/TUI routing 三者同构的平台记为 qualified；其他平台只记录
  excluded reason，不把 unsupported 计入成功率。
- 可在同一 base/task 上人工记录 Claude Code、Codex、Gemini CLI、OpenCode 或 Cursor 的公开产品结果作为方向性参照，但必须
  同时记录模型、环境、权限默认值与人工介入差异，不进入 Kite legacy/candidate 的因果 A/B Gate。
- 任一 scorer、fixture 或 stop rule 修改都产生新 policy revision，正式样本从零开始。

## `ACORE-RC-01`：候选验证与迁移边界

最终候选在精确 commit 和冻结 policy revision 上运行 OpenCode Go 完整 Journey A/B。下列第一组是不随 baseline 改变的
正确性门禁：

- false completion = 0；Plan lifecycle deterministic pass = 100%；非法 transition 拒绝 = 100%；
- safety violation = 0；policy/approval rejected retry = 0；tool call/result pairing = 100%；
- avoidable repeat after `never`/exhausted = 0；timeout/unknown external effect 自动 replay = 0；
- `contentLogged=false`，报告不含内部 fingerprint 或任何正文/参数/路径/命令/provider body。

下列数值是进入 baseline 的 provisional engineering targets，不是可直接用于放行的最终门禁：invalid args ≤ 2%、
model-fixable next-response repair ≥ 90%、p95 failure amplification ≤ 1、V2 paired task success 非劣界 -5 个百分点、V2 active
whole-turn p95 不劣于 legacy 超过 10%。`ACORE-EVAL-POLICY-01` 必须根据 baseline 在候选前冻结样本量、置信区间和各核心
类别 floor；候选后不得修改。

指标定义固定为：invalid args 分子包含 provider invalid JSON 与 Registry invalid args，分母为全部 proposed calls，并按
tool/category 报告；repair 通过 `recoveryOf` 配对下一次 eligible model response，用户取消/外部 provider outage 按预注册
规则 censor；failure amplification 是首个失败后到首次 tool-owned progress 或 terminal 之间新增的 failed invocations，
小于 policy 规定的 induced-failure 样本不作 p95 gate；timing 分 model、queue、tool execution、approval wait、active turn 与
wall，性能比较排除人为 approval wait。比例与 p95 使用预注册 paired confidence/bootstrap 规则，证据不足只报告 inconclusive。

若样本规模不足以支持默认值迁移，结果仅作为诊断，不以“更快但成功率更低”推出默认开启。V2 继续默认关闭，直到新的迁移
ADR 接受最终候选证据。

## 参考平台与 excluded 平台 Shell/Git 最小矩阵

macOS 参考平台必须覆盖三组证据：broker positive/hostile、shell negative、App/TUI routing。case 包含
status/diff/log/branch_list；stage/commit 在 GIT-02 稳定 unsupported、GIT-03 对已准入平台必须成功；
literal/obfuscated/variable/child `.git` deny；
fake Git/PATH、binary/common-dir TOCTOU、protected tracked/history、恶意 hooks/filter/fsmonitor/global config；Git env 与
`-C/--git-dir`；linked worktree/submodule `.git` file；case/symlink；index.lock、并发、取消、commit timeout post-condition；
backend none、broker disabled/unavailable；network-off remote 零请求。每格断言 outcome、dispatch/effect certainty、process
是否启动、approval 次数、是否重复及 capability evidence identity。Linux/Windows 在本计划中只维护已有 negative/exclusion
证据；未另立计划前不要求复制 macOS 的正向矩阵，也不据此声称支持。

## 文档影响

实现时至少同步：

- Plan/Completion：`docs/active/plan-mode-implementation.md`、相关 book 与 ADR 索引；
- Tool/Recovery/Eval：`docs/active/tool-description-contracts.md`、`docs/active/tool-gated-autonomy.md`、
  `docs/active/real-model-test-boundary.md`；
- Sandbox/Git：`docs/active/execution-boundary.md`、`docs/active/windows-shell-sandbox.md`、平台资格与发布文档；
- 若 `docs/documentation-map.json` 未覆盖真实代码边界，在同一 PR 修正映射，不能绕过 docs-impact gate。

## 风险与回滚总则

- **误阻断完成**：先 shadow 对照 completion decision，保留 deterministic replay；安全侧以不虚假完成为默认。
- **typed failure 分类错误**：双写旧结果和新 outcome，逐工具切换；不重新开放无限重试。
- **strict schema 提高失败率**：先观测 unknown fields，再分风险等级迁移。
- **Git broker 功能缺口**：允许单项 typed unsupported；切换前必须保持 inspect 可用，切换后 shell `.git` 不回开。
- **评测污染实现**：deterministic fixture 与 live provider 分层；真实模型结果只绑定精确 candidate identity。

## 文档 Review 记录

2026-08-09 完成三方向只读交叉 Review，并在修订后进行 P0 closure 复审：

| Review 方向 | 首轮主要阻塞 | 回写结果 | Closure |
| --- | --- | --- | --- |
| Tool/Recovery | outcome owner、未知副作用重试、lineage durability、pre-parse identity、隐私、eval 顺序与指标冻结 | 改为 Runtime-owned envelope；加入 dispatch/effect certainty、durable journal、fail-closed precedence、EVAL-00/01 与候选前 policy freeze | no remaining P0 |
| Plan/Agent | final candidate 循环、draft next action、legacy replay、cancelled 误完成、evidence 依赖与并行上限 | 加入一次 correction、draft disposition、decision-version migration、非成功 cancel、Guard 单调升级与最多 3 路只读 batch | no remaining P0 |
| Sandbox/Git | Windows read deny 不成立、broker admission 缺失、protected history 泄露、host fallback 与 probe 不同构 | 未达平台 excluded；新增 Git capability axis、执行前 path/history 约束、brokered profile fail closed 与三组独立证据 | no remaining P0 |

首轮 P1 也已进入正文约束，包括：Plan schema/revision 区分、完整 digest 传递、progress transition、动态 PTY harness、
ToolSpec 合法 availability matrix、unknown-field 低基数观测、可信 timing、Git executable/preflight/schema、project-script inventory、
atomic cutover 与安全 rollback artifact。

文档技术 Review 已通过，`ACORE-DOC-01` 于 2026-08-09 随 ADR-0095/0096/0097 的接受完成；本计划已激活。文档门禁结果
记录于交付说明和后续执行记录。
