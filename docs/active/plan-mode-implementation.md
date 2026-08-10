# Plan Mode 当前实现

状态：active

读取时机：修改 Plan Artifact、plan_review、planning/building 阶段、计划工具、计划恢复或 TUI 计划交互时。

验证：`bun test tests/runtime/agent.integration.test.ts tests/runtime/completion-guard.test.ts tests/runtime/plan-actions.test.ts tests/runtime/plan-artifacts.test.ts tests/runtime/plan-persistence.test.ts tests/runtime/plan-state.test.ts tests/runtime/plan-tools.test.ts tests/runtime/task-plan-lifecycle.test.ts tests/session-manager.test.ts tests/tui-system/scenarios/plan-review.test.ts tests/tui-system/scenarios/plan-mode-policy.test.ts tests/tui-system/scenarios/session-lifecycle.test.ts`、`bun run typecheck`。

相关：ADR-0002、`plan-artifact-lifecycle.md`、`authorization.md`、`tool-gated-autonomy.md`。

## 当前架构

Plan 是 Runtime Kernel 管理的版本化 Artifact，不是模型消息中的临时字段。所有生命周期变化通过 `plan.*` Runtime events 进入 reducer；Scheduler 根据计划和交互状态产生模型调用、审核请求或执行 Effect。

ToolSpec Registry 阶段 3 已把 Plan 工具收口到
`src/core/runtime/plan-facade.ts`。Runtime Action 使用统一发射协议：成功结果携带按提交顺序排列的
`RuntimeEvent[]`，拒绝结果不得携带领域事件。`read_plan`、`write_plan` 与 `update_plan`
均只通过该门面读取状态、访问 Artifact 并产生领域事件；各 ToolSpec 只保留 Schema、契约、
effects 与结果投影。新写入的 Plan 是 `planSchemaVersion=2`，Artifact 容器继续使用独立的
`artifactFormatVersion=1`；缺少 Plan schema version 的历史事件、snapshot 与 Artifact 仍可读取/replay，
但不能继续进度更新，必须先以原 identity 创建 V2 replan/save。

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
- `authorization`：当前 thread 的具体执行授权。

三者不能互相隐式替代。批准计划不会自动授予 `full_access`；授权也不能绕过 planning 的只读边界。

## Plan Artifact 不变量

1. Plan ID、version 和 structural digest 必须与审核对象一致。
2. 纯进度更新不应触发新的结构审核；目标、说明或步骤结构变化必须产生新 revision。
3. 审核后的内容不得通过 transcript 或 UI 状态静默替换。
4. Plan Artifact 写入失败时不得宣布计划已保存或已批准。
5. 恢复和 fork 必须从 Runtime Store/Artifact Store 重建计划事实。
6. 模型 final 不能越过 Plan lifecycle：`planning_empty`、draft、awaiting review、executing 与 cancelled 都不能产生
   `run.completed`。CompletionGuard V1 的完整规则见 `completion-guard.md`。

V2 Plan 的标题与 step title 必须是单行，title 最多 120 字符，正文为 20–30000 字符，step 为
1–12 个且 ID 唯一。首次保存后，后续 save、submit、executing replan 和 `update_plan` 统一校验
`{ plan_id, version, structural_digest }`；进度更新不能在同一调用重复 step ID，也不能把 completed/skipped
终态回退为另一状态。V2 review replay 还会把事件内容重新计算的 digest 与已保存 draft identity 比较，
并始终从该 draft 投影审核内容与 Artifact 引用；事件不能在继承可信 identity/digest 的同时替换
title、正文、steps 或已保存的 Artifact。V2 `plan.drafted` replay 不会截断正文/title 或为缺失 ID
补造合法值；它与 Artifact parser、Plan facade 共用完整 V2 validator，严格检查正文长度、step 数量、
唯一合法 ID、status、completion evidence、从原始事件正文重算的 digest，以及 Artifact 的
task/plan/version/digest identity；任一缺失、畸形或不一致都忽略该事件。

`PlanCompletionEvidenceV1` 由 Runtime 从已经归约的事实投影，而不是从模型参数接受：passed/waived
verification、带成功 Runtime result 的 terminal side-effect tool call、带 reason code 的 skipped step，及
unresolved failure/approval。`update_plan` 的 schema 严格拒绝模型提供的 command、path、stdout、
`completion_evidence` 或 success self-report。`complete_plan=true` 还要求所有 required verification 已
passed/waived、所有 effect 调用都有成功 receipt，且不存在 unresolved blocker。plan progress/completed event
携带相同 identity 与 metadata-only evidence；reducer 会对事件前 Runtime state 重新投影并精确匹配，拒绝
终态 step 回退，并在 completed replay 上重新执行相同的 required verification、effect receipt 与 unresolved
blocker 门禁；所有 step 必须为 completed/skipped 且至少一个 step 为 completed，才写入 PlanDocument。
V1 replay 仍可读取并归约历史进度/完成事件，但会确定性忽略事件中夹带的 completion evidence；历史
`plan.approved` 事件继续 replay，新 `plan_review_decision(approve)` 则引导 revise 并保存 V2 Plan 后再审核。
恢复到 V1 executing snapshot/event-tail 时，历史 reducer replay 保持不变，但实时 continuation fail closed：
Scheduler 只直接运行 `read_plan` 与携带原 identity 的 `write_plan` V2 replan/save；没有这类 queued call 时，
它产生显式 `legacy_plan_recovery` model effect，使普通恢复不会永久 blocked。该 effect 的模型工具面和 token
preflight 都只包含 `read_plan`/`write_plan`，动态 Runtime block 明确要求 V2 save；历史 queued 或模型伪造的
Shell/write/MCP/effect 会形成稳定 `legacy_plan_replan_required` rejection。Runner 在 effect preparation 后重复
检查 surface，Tool Controller 也拒绝绕过调度器的直达调用。若受限 model preflight 已产生 pending context
compaction，只允许执行 identity 匹配的内部 `compact_context` 后再重试 recovery，不开放任务 effect。该门禁
必须排在 unknown external invocation 与所有 awaiting interaction barrier 之后。受限模型未产生合法 replan、
返回错误 final 或伪造非白名单工具时继续复用 CompletionGuard V1 的单次 correction 上限；第二次失败以
`turn.aborted + run.error` 收敛，绝不产生 `run.completed` 或跑到 effect limit。malformed 非白名单 Tool Call
优先按 surface policy 写入 `legacy_plan_replan_required` rejection；只有 `read_plan`/`write_plan` 的参数错误
才分类为 `model_invalid_tool_args`，但该 terminal failure 同样消费 correction。只有成功 `read_plan` 可继续
受限 recovery；`write_plan` 必须成功产生 V2 draft 才算收敛。Runner 以实际 effect lease 为权威，为 executor
返回、emit 或 persist 的最终 `model.responded` 统一绑定并校验 surface marker，不能信任 adapter 自行标注。
若同时存在历史 subagent approval recovery，scheduler 的 canonical `subagent.recovery_unavailable` 仍先闭环，
runner guard 不得把它改写为 generic recovery block。`prepareEffect` 返回后，Runner 必须从最新 state 重新调用
Scheduler，并要求 prepared effect 与 canonical effect 语义等价；只带正确 recovery marker 或白名单工具名不够。
因此 adapter 不能用 recovery call/run_tools 替换 awaiting interaction、unknown invocation、subagent recovery 或
`completion.blocked` correction。`call_model` 只允许附加预算 estimate，不得改变 canonical surface。

`plan.drafted` 的 `AgentPlan` event transport 在映射为 `PlanDocument` 前严格验证 exact keys：顶层只能是
`name/description/status/steps`，step 只能是 `id?/step/status/note?`。未知 `command/path/stdout/extra`
不能被静默 drop 后再通过 V2 validator，而是直接忽略整个 replay event。
V2 `plan.progress_updated` 与 `plan.completed` 复用同一 transport validator，但要求每个 step 都有合法且唯一
ID，并与当前 V2 文档的完整 ID、顺序、标题集合精确一致；missing/duplicate/unknown ID、未知 status 或任意
额外键均 fail closed。映射并合并 status/note 后还必须再次通过完整 `isPlanDocumentV2` schema/digest/artifact
validator；completion event 的顶层 plan status 必须是 `completed`。

## 工具与策略

Planning 允许读取、搜索、研究、提问、计划维护和只读 Subagent；写文件、非只读 Shell、实现型 Subagent 和权限提升不得执行。所有决定由 Runtime Policy 与 Tool Controller 执行，不由 TUI 或工具描述决定，也不能通过用户审批提升权限绕过 phase 边界。

非只读 Shell 在 planning 中仍按 fail-closed 终结该 Tool Call，但 Runtime 将这类结果分类为 `phase_deferred`，而不是通用 `policy_denied`。模型收到的成对 Tool Result 明确包含 `deferred=true`、`until_phase=building`、原始参数和下一步约束：当前阶段不得重试或请求审批，应把命令保留到方案的执行/验证部分，待方案批准进入 building 后重新调用。

`write_file`、`edit_file`、实现型 Subagent，以及其他可修改工作区或外部状态的能力，在 planning 中越界时使用 `phase_denied` 硬拒绝，不进入审批。System Prompt 与各工具契约必须先主动要求模型在 planning 中只描述预期变更、不得调用编辑或副作用工具；Runtime 兜底结果再明确返回“工具未运行、当前阶段不可审批、把实现意图写入 Plan、方案批准后执行”。TUI 对文件编辑拒绝保留一条面向用户的只读边界说明，例如 `Plan mode is read-only. No file was written...`，但不把未获准执行的调用物化为 Tool Card，也不得只显示缺少下一步的通用 `Rejected ...`。破坏性 Shell 仍使用硬安全策略拒绝。

TUI 不把 `phase_deferred` 物化为 Bash 工具卡、失败提示或 deferred command 行；它只消费并清除对应的离屏 `tool.queued` 元数据。该调用属于模型在错误阶段产生并由 Runtime 内部纠正的无效意图，不是面向用户的执行事实，也不是可恢复执行队列。需要执行的命令应由模型写入 Plan 的执行/验证章节；批准进入 building 后再重新发起，并经过正常策略与审批。实时与 replay 必须保持同样的无展示结果。

## 用户交互

`plan_review_decision` 是结构化 UserAction，包含 approve/revise/cancel。批准时明确选择下一 interaction mode；revise 必须携带反馈。Cancel 与 Esc 都表示撤销本次方案执行授权：Runtime 保留 draft，取消方案工具及所有未终结 sibling，写入 `turn.aborted(cause=user)` 并立即结束当前 turn，不再调用模型或进入执行阶段。TUI 继续展示已经持久化的 draft，但不添加本地 `Plan declined` 消息；取消终态完全由 Runtime events 投影，保证实时与 replay 一致。Ask-user 与 plan review 以 interaction/toolCall ID 精确关联，不能依赖展示文本匹配；`ask_user` 拒答仍是可继续当前 turn 的普通 Tool Result，不使用方案授权取消语义。

TUI 新建会话时，新 Runtime 与新展示快照必须统一从 `building` 开始，并清空旧会话的 pending plan；不得把离开会话的 `planning` 投影复制到新会话。历史会话切回时仍恢复该会话自己的持久化状态。该约束保证 InputLine 因会话切换重挂载后，Shift+Tab 进入/退出 Plan Mode 仍操作同一个 Runtime 事实，而不是无法退出的 UI-only 状态。

Shift+Tab 在尚无输入时可以创建 `planning_empty` 占位 Task，但用户提交首个 prompt 后必须先用 `task.cancelled` 明确收尾该占位，再以真实 prompt 作为 `userGoal` 启动正式 Task；不得直接复用空目标 Task，避免 Plan Artifact、日志和恢复状态丢失任务目标。

在同一 TUI 会话内，用户通过 Shift+Tab 选择的 Plan Mode 是跨普通对话保持的输入策略：每次提交普通 prompt 都必须把当前 `phase` 显式传给新 Runtime Task，不能因上一轮 `run.completed` 而静默退回 building。`run.completed` 已结束上一 Core Task 后，用户再按 Shift+Tab 退出时没有活动 Task 可取消；此时 TUI 只把自身已过期的 planning 投影对齐到 Runtime 已有的 building 事实，不伪造 `planning.exited` 或 `task.cancelled` 事件。若仍有 plan review 等活动交互，则不得使用该本地对齐绕过交互取消语义。
