# Plan Mode 当前实现

状态：active

读取时机：修改 Plan Artifact、plan_review、planning/building 阶段、计划工具、计划恢复或 TUI 计划交互时。

验证：`bun test apps/kite-service/test/isolated/runtime/agent.integration.test.ts apps/kite-service/test/runtime/completion-guard.test.ts apps/kite-service/test/runtime/plan-actions.test.ts tests/isolated/runtime/plan-artifacts.test.ts tests/integration/runtime/plan-persistence.test.ts tests/integration/runtime/plan-state.test.ts tests/integration/runtime-contract/plan-tools.test.ts apps/kite-service/test/isolated/runtime/task-plan-lifecycle.test.ts packages/builtin-runtime/test/subagent-delegation-contract.test.ts apps/kite-service/test/subagent-runner.test.ts apps/kite-service/test/isolated/session-manager.test.ts tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/plan-mode-policy.test.ts tests/tui-system/scenarios/session-lifecycle.test.ts`、`bun run typecheck`。

相关：ADR-0002、ADR-0137、`plan-artifact-lifecycle.md`、`authorization.md`、`tool-gated-autonomy.md`。

## 当前架构

Plan 是 Runtime Kernel 管理的版本化 Artifact，不是模型消息中的临时字段。所有生命周期变化通过 `plan.*` Runtime events 进入 reducer；Scheduler 根据计划和交互状态产生模型调用、审核请求或执行 Effect。

Builtin frozen catalog 已把 `read_plan`、`write_plan`、`update_plan` 的 model schema、parser、effects、
availability、revision 与 operation owner 收口到 `@kite-ai/builtin-runtime`，并通过唯一 SPI snapshot 投影；
`apps/kite-service/src/bootstrap/runtime/plan-runtime.ts` 是 Service 的 Runtime State/SQLite Store persistence/effect bridge，不是第二 schema authority。
Runtime Action 使用统一发射协议：成功结果携带按提交顺序排列的
`RuntimeEvent[]`，拒绝结果不得携带领域事件。`read_plan`、`write_plan` 与 `update_plan`
均只通过该门面读取状态、访问 Artifact 并产生领域事件；各 Builtin catalog entry 只保留 schema、contract、
effects 与结果投影。新写入的 Plan 是 `planSchemaVersion=2`，Artifact 容器继续使用独立的
`artifactFormatVersion=1`；缺少 Plan schema version 的历史事件、snapshot 与 Artifact 仍可读取/replay，
但不能继续进度更新，必须先以原 identity 创建 V2 replan/save。

App Tool Pipeline/Host coordinator 负责把 prepared invocation 与 Plan mechanism 接入统一执行链；Kernel 只拥有
governance/admission decision，Builtin 拥有 Plan schema/parser/effects/operation semantics。RM-16 已完成源码
caller/owner closure、manifest、文档、journey、fault 与 soak Gate，生产路径只保留唯一 App/Host/Builtin seams。

```text
用户进入 planning
  → Agent 调研并写入 Plan Artifact
  → Runtime 记录 plan revision / structural digest
  → plan_review interrupt
      ├── approve → building（accept_edits 或 auto）
      ├── revise  → 带反馈回到 planning
      └── cancel  → 终止本次计划流程
```

## 三个独立维度

- `phase`：planning/building 的能力边界；
- `interactionMode`：`accept_edits`、`auto`、`full` 的确认体验；
- `authorization`：由 live interactionMode、policy facts、sealed scope 与 Session durable queue 共同决定的具体执行事实。

三者不能互相隐式替代。`interactionMode=full` 是唯一 Full authority；批准计划不会写入第二个 Full grant，Plan + Full 仍保持
planning lifecycle。非 Full Planning 的物理 ceiling 是 Workspace read-only baseline，已知扩 scope 才进入当前 mode approval route。

## Plan Artifact 不变量

1. Plan ID、version 和 structural digest 必须与审核对象一致。
2. 纯进度更新不应触发新的结构审核；目标、说明或步骤结构变化必须产生新 revision。
3. 审核后的内容不得通过 transcript 或 UI 状态静默替换。
4. Plan Artifact 写入失败时不得宣布计划已保存或已批准。
5. 恢复和 fork 必须从 Runtime Store/Artifact Store 重建计划事实。
6. 模型 final 不能越过 Plan lifecycle：`planning_empty`、draft、awaiting review、executing 与 cancelled 都不能产生
   `run.completed`。PlanDocument V2 使用带完整 identity 与 verification/effect evidence gate 的
   CompletionGuard V2；完整规则见 `completion-guard.md`。

V2 Plan 的标题与 step title 必须是单行，title 最多 120 字符，正文为 20–30000 字符，step 为
1–12 个且 ID 唯一。首次保存后，后续 save、submit、executing replan 和 `update_plan` 统一校验
`{ plan_id, version, structural_digest }`；进度更新不能在同一调用重复 step ID，也不能把 completed/skipped
终态回退为另一状态。V2 review recovery 还会把事件内容重新计算的 digest 与已保存 draft identity 比较，
并始终从该 draft 投影审核内容与 Artifact 引用；事件不能在继承可信 identity/digest 的同时替换
title、正文、steps 或已保存的 Artifact。V2 `plan.drafted` recovery 不会截断正文/title 或为缺失 ID
补造合法值；它与 Artifact parser、Plan facade 共用完整 V2 validator，严格检查正文长度、step 数量、
唯一合法 ID、status、completion evidence、从原始事件正文重算的 digest，以及 Artifact 的
task/plan/version/digest identity；任一缺失、畸形或不一致都忽略该事件。

`PlanCompletionEvidence` 由 Runtime 从已经归约的事实投影，而不是从模型参数接受：passed/waived
verification、带成功 Runtime result 的 terminal side-effect tool call、带 reason code 的 skipped step，及
unresolved failure/approval。`update_plan` 的 schema 严格拒绝模型提供的 command、path、stdout、
`completion_evidence` 或 success self-report。`complete_plan=true` 还要求所有 required verification 已
passed/waived、所有 effect 调用都有成功 receipt，且不存在 unresolved blocker。plan progress/completed event
携带相同 identity 与 metadata-only evidence；reducer 会对事件前 Runtime state 重新投影并精确匹配，拒绝
终态 step 回退，并在 completed replay 上重新执行相同的 required verification、effect receipt 与 unresolved
blocker 门禁；所有 step 必须为 completed/skipped 且至少一个 step 为 completed，才写入 PlanDocument。
Plan live/replay 只处理当前 format epoch 的 PlanDocument V2 事实。缺失或不匹配 epoch 的 snapshot 在任何 event decode、Scheduler、Model 或 Tool dispatch 前失败，不迁移为可执行 Plan，也不创建受限恢复工具面。`prepareEffect` 返回后，Runner 仍从最新 State 重算 Scheduler canonical effect，并要求 prepared effect 的类型与 identity 等价；预算 estimate 不能改变 interaction、unknown invocation、subagent 或 completion barrier。

`plan.drafted` 的 `AgentPlan` event transport 在映射为 `PlanDocument` 前严格验证 exact keys：顶层只能是
`name/description/status/steps`，step 只能是 `id?/step/status/note?`。未知 `command/path/stdout/extra`
不能被静默 drop 后再通过 V2 validator，而是直接忽略整个 replay event。
V2 `plan.progress_updated` 与 `plan.completed` 复用同一 transport validator，但要求每个 step 都有合法且唯一
ID，并与当前 V2 文档的完整 ID、顺序、标题集合精确一致；missing/duplicate/unknown ID、未知 status 或任意
额外键均 fail closed。映射并合并 status/note 后还必须再次通过完整 `isPlanDocument` schema/digest/artifact
validator；completion event 的顶层 plan status 必须是 `completed`。

## 工具与策略

Planning 允许结构化读取、搜索、研究、提问、计划维护和只读 Subagent。非 Full 使用 Workspace read-only sandbox baseline；baseline
内可承载的 raw Shell direct，已知扩 scope 按 Accept/Auto 路由 user/reviewer approval。写文件、实现型 Subagent 和权限提升不得
执行，hard deny 不进入 approval。所有决定由 Runtime Policy 与 Tool Controller 执行，不由 TUI 或工具描述决定。

Planning 的 `task` 不解析 `userGoal` 作委派授权；模型只应为有界、自包含且值得独立调用的 architecture/design 工作选择只读 `plan`，一般证据收集选择 `explore`。Project instruction、Shell context、工具结果或远端内容不能提升 child 的 phase、authorization、预算或 capability ceiling。`code` 与 `review` 在 planning 拒绝且不可审批提升。plan child 终结后，
Runtime 要求先 `write_plan` save，再以同一 Plan identity submit；不得以
`update_plan` 或 child final 跳过 Artifact/review lifecycle。多个相互独立的只读 explore/plan sibling
可按 ADR-0104 在同一响应中有界并发；依赖其他 child 结果的规划工作仍须串行。只有成功 plan child
才能进入 CompletionGuard 前的受控 save/submit continuation。

Shell 在 planning 中按只读 baseline 与 known effects 处理：baseline 内 direct；已知需要扩大 filesystem/network/process scope 时按
当前 interactionMode 产生 durable approval queue record（Accept 请求用户，Auto 先 reviewer，Full direct）。模型无需重提带扩权字段的
第二个 Tool Call；native denial 终结为 `sandbox_denied` 且不 replay。Plan + Full 仍不跳过 plan review/completion gate。

`write_file`、`edit_file`、实现型 Subagent，以及其他可修改工作区或外部状态的能力，在 planning 中越界时使用 `phase_denied` 硬拒绝，不进入审批。System Prompt 与各工具契约必须先主动要求模型在 planning 中只描述预期变更、不得调用编辑或副作用工具；Runtime 兜底结果再明确返回“工具未运行、当前阶段不可审批、把实现意图写入 Plan、方案批准后执行”。TUI 对文件编辑拒绝保留一条面向用户的只读边界说明，例如 `Plan mode is read-only. No file was written...`，但不把未获准执行的调用物化为 Tool Card，也不得只显示缺少下一步的通用 `Rejected ...`。破坏性 Shell 仍使用硬安全策略拒绝。

TUI 只投影 canonical queue/status events：baseline Shell 可直接显示真实 Tool lifecycle；越界请求显示自动审查/人工排队/等待批准状态，
不以 local deferred slot 作为事实。实时与 replay 必须保持相同 queue focus、generation、scope 和 terminal projection。

## 用户交互

`plan_review_decision` 是结构化 Runtime user action，包含 approve/revise/cancel。批准时明确选择下一 interaction mode；revise 必须携带反馈。Cancel 与 Esc 都表示撤销本次方案执行授权：Runtime 保留 draft，取消方案工具及所有未终结 sibling，写入 `turn.aborted(cause=user)` 并立即结束当前 turn，不再调用模型或进入执行阶段。TUI 继续展示已经持久化的 draft，但不添加本地 `Plan declined` 消息；取消终态完全由 Runtime events 投影，保证实时与 replay 一致。Ask-user 与 plan review 以 interaction/toolCall ID 精确关联，不能依赖展示文本匹配；`ask_user` 拒答仍是可继续当前 turn 的普通 Tool Result，不使用方案授权取消语义。

`plan.approved.executionMode` 同时是 TUI 当前模式展示与 SessionRuntime 会话镜像的权威来源。实时事件、后台缓冲回放和历史会话加载都必须把该值投影到 `interactionMode`，使 Footer 的 StatsLine、权限选择器和下一轮会话参数保持一致；不得只更新 Kernel Task 的临时 `executionMode` 而让底栏继续显示审批前模式。后续持久化 `interaction_mode.changed` 表示用户更新了选择，实时与回放都必须按事件顺序由该值覆盖方案模式。

`plan.review_requested` 将完整审核正文物化到对应 `write_plan` Tool Card，并在卡片上记录该正文来源；后续
approved 或 revision_requested 的 `tool.finished` 只携带机器可读的审核 metadata，不能用该对象字符串覆盖
已经展示的方案正文。此保护由 Tool Card 自身的审核正文标记决定，不依赖随后会被 approval/revision 改写的
`status.plan` 或 `status.pendingPlan`，因此 live 与 replay 在修订路径上保持相同投影。普通 draft save 仍展示
Artifact 路径，失败终态仍展示失败结果。

TUI 新建会话时，新 Runtime 与新展示快照必须统一从 `building` 开始，并清空旧会话的 pending plan；不得把离开会话的 `planning` 投影复制到新会话。历史会话切回时仍恢复该会话自己的持久化状态。该约束保证 InputLine 因会话切换重挂载后，Shift+Tab 进入/退出 Plan Mode 仍操作同一个 Runtime 事实，而不是无法退出的 UI-only 状态。

Shift+Tab 在尚无输入时可以创建 `planning_empty` 占位 Task，但用户提交首个 prompt 后必须先用 `task.cancelled` 明确收尾该占位，再以真实 prompt 作为 `userGoal` 启动正式 Task；不得直接复用空目标 Task，避免 Plan Artifact、日志和恢复状态丢失任务目标。

TUI 的 Plan Mode 进入/退出与其他运行中命令共用单 Kernel writer。Agent loop 已暴露 live control 时，App 必须通过该 control 原子提交进入事件或退出事件批次，不得为同一 thread 再打开 standalone Kernel；只有没有 live Kernel 的空闲会话才允许使用短生命周期 Kernel。进入空闲会话时的 `task.started + planning.entered`、退出活动 planning Task 时的 `planning.exited + task.cancelled` 都作为单个 batch 持久化。这样 Plan 切换推进同一内存 revision，旧 effect 由既有 lease 判 stale，而不会由第二 writer 触发 RuntimeStore revision conflict。

在同一 TUI 会话内，用户通过 Shift+Tab 选择的 Plan Mode 是跨普通对话保持的输入策略：每次提交普通 prompt 都必须把当前 `phase` 显式传给新 Runtime Task，不能因上一轮 `run.completed` 而静默退回 building。`run.completed` 已结束上一 Kernel Task 后，用户再按 Shift+Tab 退出时没有活动 Task 可取消；此时 TUI 只把自身已过期的 planning 投影对齐到 Runtime 已有的 building 事实，不伪造 `planning.exited` 或 `task.cancelled` 事件。若仍有 plan review 等活动交互，则不得使用该本地对齐绕过交互取消语义。

## SAQ-10 mode/queue 交互补充

State 27 的 `pendingApprovals` 与 `activeApprovalId` 独立于 Plan Artifact。Plan + Full 可以直接执行 Full scope，但不自动 approve
Plan、切换 phase 或跳过 review/completion。只有同一 model message/turn 的并发 Explore children（parent 非 Full）派生 Auto；single
Explore、plan/code/review 继承 parent。

Approval overlay 的 Enter 提交 exact interactionId+generation+grant；Esc 只 focused reject，Plan/Input Esc 保留各自语义；Ctrl+C
才取消 whole turn。`/permissions` 的 mode 与 `session_grants_cleared` event 不改变 Plan phase；Session switch/restart 恢复各自
queue、mode revision、Plan identity 和 grants，旧 generation/session event no-op。
