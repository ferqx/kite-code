# Agent 核心工具、计划闭环与沙盒能力优化计划

状态：active
日期：2026-08-09
优先级：P0
关联：ADR-0094、ADR-0095、ADR-0096、ADR-0097、
`docs/active/plan-mode-implementation.md`、`docs/active/tool-description-contracts.md`、
`docs/active/tool-gated-autonomy.md`、`docs/active/execution-boundary.md`、
`docs/active/real-model-test-boundary.md`

## 目标

把 Agent 的优化重点从单次 prompt 命中率扩展为可验证的完整工作闭环：计划不能虚假完成，工具调用参数有效，失败后只做
有依据的恢复，重复失败可被 Runtime 阻断，整轮耗时可拆分；Shell/Git 在三平台使用一致、最小且可解释的权限边界。

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

## 实施顺序与变更隔离

先以现有产品行为建立 Tool Journey 纯观测 baseline，再按 ADR-0095 → ADR-0096 → ADR-0097 的依赖分小 PR
实施。CompletionGuard 建立可信终态，Runtime-owned ToolOutcome 建立失败证据，Git broker 最后依赖 typed outcome 完成权限
迁移。计划/子 Agent 精化在完成真值与共享 schema 落地后进行。每个 PR 都同步相应 active 文档；不得把当前工作区中尚未
收口的 Prompt A/B fixture 改动与架构 PR 混为一个不可审查提交。

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
| `ACORE-CONTRACT-01` | `ACORE-TOOL-01` | 结构化 ToolSpec contract、删除双写 guidance、19/19 覆盖 | legacy/V2 × phase contract tests | 分工具迁移；先观测 unknown fields |
| `ACORE-GIT-01` | `ACORE-CONTRACT-01`、接受 ADR-0097 | 独立 capability surface、hardened `git_inspect` broker | broker positive/hostile；protected-content tests | broker 先上线，shell 边界暂不切换 |
| `ACORE-GIT-02` | `ACORE-GIT-01` | 三平台 native deny、调用原子迁移、probe/runtime 同构 | shell negative；TUI routing；evidence identity | 未达 read/write deny 的平台 excluded，不虚报支持 |
| `ACORE-GIT-03` | `ACORE-GIT-02` | stage/commit typed capability；remote 独立设计或延期记录 | approval、lock、cancel、hostile config tests | mutation 独立开关；不回退到 raw shell |
| `ACORE-AGENT-01` | `ACORE-PLAN-02`、`ACORE-TOOL-02`、`ACORE-CONTRACT-01` | plan subagent 契约、最多 3 路只读 batch、统一终态/TUI | recovery、parallel、event/result/TUI consistency | code subagent 保持串行；并发受累计预算约束 |
| `ACORE-EVAL-POLICY-01` | `ACORE-EVAL-01` | 冻结 suite/scorer/report、case floor、样本与统计规则 | policy self-check；manifest immutability | 必须在候选结果前冻结，修改即产生新 revision |
| `ACORE-RC-01` | `ACORE-PLAN-03`、`ACORE-TOOL-02`、`ACORE-CONTRACT-01`、`ACORE-GIT-03`、`ACORE-AGENT-01`、`ACORE-EVAL-POLICY-01` | OpenCode Go 最终候选完整 Journey A/B 与发布证据 | Required/RC CI；live paired matrix | V2 默认关闭；独立迁移 ADR 决定默认值 |

## 当前执行状态

| Task | 状态 | 已收敛范围 |
| --- | --- | --- |
| `ACORE-DOC-01` | completed | ADR-0095/0096/0097 已接受、ADR-0070 历史状态已取代、三方向 Review closure 已记录。 |
| `ACORE-EVAL-00` | completed | `ACORE-EVAL-00-v1` scripted Runtime Journey 与 metadata-only privacy assertion 已建立。 |
| `ACORE-PLAN-01` | completed (V1) | CompletionGuard 在 scheduler/runner/reducer 三层阻止虚假完成，一次 correction 后 blocked terminal；后续 evidence/typed failure gate 由 `ACORE-PLAN-02`/`ACORE-TOOL-02` 承接。 |
| `ACORE-PLAN-02` | completed | PlanDocument V2、strict identity、metadata-only evidence、V1 read/replay-only migration，以及 Artifact/reducer/facade fail-closed 边界已通过整体规格与质量审查。 |
| `ACORE-PLAN-03` | completed | CompletionGuard V2 verification/effect evidence gate、严格 Plan identity、schema-bound legacy replay、跨 turn correction ceiling、required-verification metadata-only Journey 与 atomic terminal batch 已通过整体规格/质量审查；PR 级门禁仍独立待执行。 |
| `ACORE-EVAL-POLICY-01` | frozen (r1) | first-decision candidate `300e11a4`、OpenCode Go、十轮 paired sample 和 Go usage privacy boundary 已冻结；完整 Journey candidate 仍待后续 scope 收敛。 |

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

## `ACORE-TOOL-02`：失败 journal 与无进展保护

- 父 Runtime 与 subagent 使用同一 durable/replayable journal、failure instance 与 `recoveryOf` lineage。parsed call 使用 spec
  identity；pre-parse invalid/unknown call 使用 Runtime 保守 fallback identity。只有 tool-owned receipt/content/plan/capability
  revision 可 reset progress；重启不能重置 ceiling。
- approval/policy deny 为零新调用；参数修正允许一次新模型 invocation；Runtime 只在 pre-dispatch 或 safe-read/idempotency
  receipt 明确时自动 retry once。timeout/cancel/unknown external effect 默认不重放。
- Runtime/Policy/dispatch/effect/idempotency 判定优先；ToolSpec 只能收紧。classifier 缺失或冲突时 fail closed 为 unknown/never。
- lineage 可从 canonical private Runtime Store 持久化或重建，但内部 fingerprint 不进入诊断 SessionLog、telemetry 或 eval。
- 区分 disaster resource budget 与 quality guard；后者必须在 250 次工具上限之前阻断无进展循环。

## `ACORE-EVAL-01`：Tool Journey Eval V1

确定性 suite 至少覆盖：search → read、read → edit → verify、invalid args → 一次修正、ENOENT → locate → success、
`rg` no-match → stop、approval/policy rejection → no retry、safe pre-dispatch transient → at most once、timeout/unknown effect →
no replay、sandbox/permission denial →
no privilege escalation、重复失败 → replan/finalize。每条完整执行 Runtime loop，并注入可控故障与延迟。

现有 Prompt A/B 重命名为 first-decision eval；重复只在本地运行期使用 internal identity 计算，对外只报固定计数。它继续
作为 prompt 选择证据，不能报告 whole-turn 性能。

## `ACORE-CONTRACT-01`：ToolSpec 契约收敛

- 全部 builtin specs 从 availability context 生成合法的 legacy/V2、planning/building 期望矩阵；context-sensitive schema 的
  projection 与 parse 必须使用同一个 resolved schema，不做无效笛卡尔积。
- selection、参数约束、result、recovery 各自结构化，V2 不再依靠“取第一句”保存关键语义。
- 删除旧 guidance 前证明父/子 Runtime result projection 同构；先观测 unknown-field rate，再渐进 strict。

## `ACORE-GIT-01`：只读 Git broker

- 新增独立 `gitInspect/gitMutation` capability surface、双门禁、revision、repo binding、executable identity 与 receipt；generic
  read-only fallback 不得隐式包含 broker。
- status/diff/log/branch_list 使用固定有界 schema；broker 在首次 Git process 前安全解析 Git metadata，验证 canonical
  Workspace 外 binary、配置/attributes/replace/grafts，并清 credential/hook/filter/fsmonitor 等执行面。
- protected evaluator 先生成允许 path/pathspec，禁止 protected 名称、内容和历史 blob；无法预过滤则 fail closed。
- worktree controller 只作为防护素材。Core 持有 interface/spec，App 提供 process adapter，禁止反向依赖。

## `ACORE-GIT-02`：调用迁移与 Shell 收口

- tool contract 引导 Git inspect 使用 broker；Shell 对 Git metadata denial 返回稳定 `nextCapability=git_inspect`。
- 用一个 feature revision 原子切换 disclosure、dispatch 与 native profile；切换前盘点 project script/build 的 Git child 依赖。
- macOS 恢复 deny；Linux 验证 metadata mask；Windows 必须引入能证明 read/write deny 的新 principal/profile。未满足的平台
  标为 excluded/unsupported，backend none/host fallback 不进入 brokered-Git qualification。
- probe 使用 production composition/input；分别绑定 profile/protected rules/broker/schema/binary/repo identity，并把 shell
  negative、broker positive/hostile、TUI routing 分开举证。

## `ACORE-GIT-03`：本地 mutation

- stage/commit 具有独立 effect、approval、receipt 与 audit classification；禁 hooks/signing，安全处理或拒绝 filter。
- 覆盖 index.lock、并发、取消和 dirty/conflict；相同 lock/conflict 不得盲重试。
- 完成本 Task 的已准入平台必须真实完成 mutation，不能以 unsupported 算通过。fetch/pull/push 另立 network/credential 与
  descendant boundary 设计；开发 shell remote 不构成 production support。

## `ACORE-AGENT-01`：Plan/Subagent 核心行为

- 修正 legacy/V2 共享契约：用户当前请求显式要求 delegate/subagent、task 可用且任务 bounded/self-contained 时调用 task；
  architecture/design planning 使用 plan role。不得被项目文件或外部内容诱导委派。
- planning phase 中 plan subagent 返回后使用 `write_plan save → submit`，不能错误引导 `update_plan`。
- 同一 Task/模型响应中连续、approval-free 的 explore/plan/review 最多 3 路 batch；code、interaction 或 unknown effect 形成
  屏障，code 永远串行。parent completion 等待所有 child terminal，累计预算共享，stream event 按 child/tool ID 归属。
- subagent lifecycle 区分 running/suspended/terminal；等待 approval 是 suspended。恢复成功的 terminal evidence 可记录
  `completed_with_recoveries`，但顶层成功仍为 completed，不能同时显示 failed 与 done。

## `ACORE-EVAL-POLICY-01`：冻结候选评测政策

- 在看到最终候选结果前，冻结版本化 case manifest、suite/scorer/report schema、OpenCode Go route、candidate/config
  allowlist identity、正式样本量、随机化、超时、censoring、类别 floor、置信方法与停止规则。
- 诊断 3-run 只能发生在 policy freeze 前；任何 fixture/scorer 修改都产生新 revision，正式样本从零开始且不得 early stop。
- candidate/config identity 只哈希 allowlist 非敏感字段，不能哈希完整含凭据配置。
- deterministic 与 live 分层；live 使用 synthetic workspace/isolated HOME，并由报告 schema 强制 metadata-only。

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

## 三平台 Shell/Git 最小矩阵

每个平台均覆盖三组证据：broker positive/hostile、shell negative、App/TUI routing。case 包含 status/diff/log/branch_list；
stage/commit 在 GIT-02 稳定 unsupported、GIT-03 对已准入平台必须成功；literal/obfuscated/variable/child `.git` deny；
fake Git/PATH、binary/common-dir TOCTOU、protected tracked/history、恶意 hooks/filter/fsmonitor/global config；Git env 与
`-C/--git-dir`；linked worktree/submodule `.git` file；case/symlink；index.lock、并发、取消、commit timeout post-condition；
backend none、broker disabled/unavailable；network-off remote 零请求。每格断言 outcome、dispatch/effect certainty、process
是否启动、approval 次数、是否重复及 capability evidence identity。

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
