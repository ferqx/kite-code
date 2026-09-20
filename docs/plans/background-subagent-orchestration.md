# 后台子 Agent 编排与受管等待优化

状态：已确认设计，待实施。

本方案解决后台子 Agent 已能独立执行和主动回传，但主 Agent 仍可能以 `sleep` 或高频 `task_read` 维持等待、把“后台执行”误解为“当前 Run 可以提前结束”，以及同轮等待与跨轮回传验收相互替代的问题。产品目标是：独立委派默认异步；本轮是否必须取得结果由结构化结果处置决定；等待由 Runtime 事件驱动，不由模型轮询驱动。

## 1. 已确认语义

`background` 与结果处置是两个正交决定：

| 维度 | 值 | 含义 |
| --- | --- | --- |
| 执行方式 | `background=false` | 父工具调用同步取得子任务终态 |
| 执行方式 | `background=true` | Runtime 接管 child 后立即返回稳定 `task_id`，child 独立执行 |
| 结果处置 | `required` | 当前 Run 的正式交付需要该结果；结果未到时不得完成 Run |
| 结果处置 | `after_turn` | 当前 Run 不需要该结果即可完成；仅在结构化授权、预算和原 deadline 均满足时，结果可触发一次后续 Run |

已经决定采用多 Agent 且子任务相互独立时，主 Agent 应在并发、权限和资源边界内先异步派发所有已就绪任务，再完成不重复的独立工作。普通“探索并在本轮汇总”默认使用 `background=true + result_disposition=required`；用户明确要求稍后回报或专门验证跨轮回传时，才使用已获准的 `after_turn`。后台派发不等于提前完成，`after_turn` 也不等于无限期保活。

有真实依赖的任务按依赖顺序推进；没有有意义的独立工作时直接进入受管等待，不制造重复检查。该策略只规定已经决定委派后的执行方式，不要求简单任务强行拆成多 Agent。

## 2. 当前事实与问题证据

已验证的当前能力包括稳定 task identity、唯一 background watcher、持久 Artifact、required 终态准入和受资格约束的 `after_turn` continuation，分别由 [Builtin subagent runtime](../../packages/builtin-runtime/src/subagent/runtime-module.ts)、[Service background owner](../../apps/kite-service/src/bootstrap/runtime/subagent/background-runtime.ts)、[after-turn continuation](../../apps/kite-service/src/bootstrap/runtime/subagent/after-turn-continuation.ts)及其相邻测试维护。产品手册规定 required child 未完成时保持同一 Run，并明确 `task_read` 不是生命周期完成门禁。无模型调用等待、相同事实抑制、活动 Run 结果仲裁和下述故障窗口是本方案的目标态，不提前视为已交付。

2026-09-20 的真实 DeepSeek 会话 `6651e643-de74-4b02-b29d-1afa1ce36ae8` 暴露了剩余缺口：两个 background child 均被正确并发接管并最终通过 `subagent.background_result_persisted` 主动回传，但主 Agent 在约 51 秒内发起 23 轮模型请求、46 次 `task_read`。相同 task revision 持续返回 `running`，模型仍反复决定“再轮询几次”；结果到达后，排队中的读取又被 `superseded_by_user_input` 取代。

因此问题不在 child 是否真的后台运行，而在父级调度没有稳定进入无模型调用的等待态：

1. 模型提示没有把“独立工作耗尽后必须让出控制权”表达为明确规则；
2. `task_read` 工具说明允许重复读取，却没有说明它不能用作 required 等待驱动器；
3. 普通工具循环把无变化的 `running` 结果再次交给模型，缺少调度级反空转；
4. 当前测试分别证明了部分后台能力，但没有以三个不可互相替代的场景锁定完整语义。

## 3. 目标与非目标

### 3.1 目标

- 独立子任务默认异步并发派发，依赖任务保持顺序。
- required child 未完成且模型以 final candidate 表达当前独立工作已结束时，同一 Run 进入事件驱动等待；没有可行动新事实时不请求模型。
- child 终态、失败、取消、用户输入或可处理的授权事件到达后，恢复准确的 Run，不改变 task identity。
- `task_read` 保留按需状态／完整报告读取能力，但不能成为完成守卫或等待循环。
- `after_turn` 保持现有结构化资格、预算和 deadline 边界；结果只在合资格时至多触发一次后续 Run。
- `after_turn` 结果到达时若已有新活动 Run，沿 `human_start_preferred` 抑制自动续轮并保留持久结果，不并发创建第二个主 Run。
- Desktop 与 TUI 在 waiting 状态继续允许用户发送引导；等待不是输入锁定。

### 3.2 非目标

- 不删除 `task_read`、`task_cancel` 或稳定 task ID。
- 不把所有多 Agent 请求默认改成 `after_turn`。
- 不用固定退避轮询代替事件唤醒；退避只能用于外部系统诊断，不能成为正常 child 编排。
- 不让普通后台 Shell 完成自动创建后续 Run。
- 不新增第二套后台任务 registry、消息队列、租约或客户端本地权威。
- 不保证宿主退出、崩溃或升级后本地 child 进程继续运行。

## 4. 目标状态机

```text
task(background=true)
  → Runtime 接管成功并返回 task_id
  → result_disposition=required
      → 父级仍有独立工作：继续正常模型/工具循环
      → 父级无独立工作：登记 required obligation，Run 进入 waiting_background
          → 无新事实：不调用模型
          → 用户输入：恢复同一 Run 并处理引导
          → 可行动新事实（终态/失败/取消/需父级处理的交互）：恢复同一 Run
          → 仅进度/心跳/日志 revision：刷新投影，不调用模型
          → 终态 Artifact 已持久化：注入具名结果，完成守卫解除对应义务
  → result_disposition=after_turn
      → 当前 Run 可在其他完成条件满足后正常结束
      → child 终态：持久化 Artifact 与通知
          → Session 已有新活动 Run：按当前 `human_start_preferred` 抑制自动续轮，结果保持持久可读
          → Session 空闲且资格/预算/deadline 有效：至多创建一次后续 Run
          → 不满足：保存结果与稳定抑制原因，不静默重启
```

`waiting_background` 是既有 Run 的调度表现，不新增业务完成状态。其权威事实仍是 required background obligation、child lifecycle、Run identity 和持久事件；客户端可将它投影为“等待后台结果”，但输入框保持可用。

## 5. 模型与工具契约

主 Agent 的模型规则需要明确：

- 对已决定委派的独立任务，优先在同一响应中异步派发；不要启动一个后立即等待，再派发无依赖 sibling。
- 派发后只继续有意义且不重复的独立工作；工作耗尽时让 Runtime 等待。
- 禁止仅为等待 child 调用 `sleep`、空循环或固定间隔 `task_read`。
- 用户主动查询进度、诊断失败／取消、或收到截断终态报告后确需完整 Artifact 时，可以调用一次 `task_read`。
- `task_read` 返回 `running` 且 revision 无变化时，不立即再次读取；required obligation 由 Runtime watcher 唤醒。
- 不把“任务已受理”描述成“任务已完成”；只有获准 `after_turn` 才能在结果到达前结束本轮交付。

`task` 工具说明同步说明 `background=true` 返回句柄、终态会可靠投递，以及 `result_disposition` 的默认值和资格。`task_read` 的 `useWhen` 与 recovery 明确其是按需快照／完整报告读取接口，不是等待 primitive；重复读取非消费性不等于鼓励轮询。

模型提示和工具说明只负责意图引导，不能单独承担正确性。Runtime 必须保证即使模型尝试空转，也不会无界重复请求模型。

## 6. Runtime 调度与反轮询

### 6.1 required 等待

Runtime 不猜测“模型是否还有有意义工作”。受管等待只在以下可机械判定的入口发生：

1. 模型提交 final candidate，且 CompletionGuard 的唯一剩余 blocker 是 required background child；或
2. `task_read` 再次观察到同一 owner generation、同一 execution revision 的 `running`；或
3. 后续确有必要时，模型通过单独评审的结构化 wait/yield 动作明确让出控制权。本阶段不预设新增该动作。

上述入口还要求当前没有更高优先级的 pending interaction、普通工具、required Shell、unknown invocation、active Skill、可运行 Plan step、恢复动作或新用户输入。若首次派发后模型仍要进行独立分析，它继续正常工作；独立工作完成后以 final candidate 表达交付候选，Runtime 再把 required blocker 转为等待，而不是让模型纠错或轮询。

等待必须保留原 Run/turn/task identity、原 deadline、资源预算和取消入口。Runtime 使用专门的持久 waiting reason（关联 required background identities）投影等待，不伪造 CompletionGuard 纠错，也不新增第二个任务状态权威。重进从该 reason 与 canonical obligation 恢复。唤醒重新判定可由 background owner watermark、Kernel revision、用户输入、授权或 Runtime 停止触发，但只有终态/失败/取消、需父级处理的交互或用户输入等模型可行动事实才请求模型；进度、心跳和日志变化只更新投影。原 deadline 到期进入既有取消／unknown cleanup 边界，不作为普通时间唤醒。

waiter 同时观察 `ownerKey + ownerGeneration + background watermark`、Kernel revision 和 execution authority。Artifact 已写但 settlement admission 失败、owner generation 更替、authority detached/recovery_required 或 Runtime stop 时不得永久等待或释放 obligation；应持久化 fail-closed 的 unknown/recovery fact，再按现有恢复边界收敛。只有 Kernel 已准入的 `subagent.background_result_persisted` 可以解除 required obligation，内存 terminal snapshot 或 Artifact 单独存在都不能绕过该准入。

### 6.2 相同 revision 的读取抑制

反轮询不新增持久节流表。使用当前 Run 已有的工具结果和 Runtime directory snapshot 判断，比较键固定为 `ownerKey + taskId + ownerGeneration + execution revision`。同一身份最近一次成功读取为 `running` 且 revision 未变化时，再次读取可以返回现有快照，但完成该调用后 Scheduler 必须转入受管等待，不得把相同事实再次作为新模型决策理由。重启导致 generation 更替或 revision 重新投影时必须先走 authority/recovery 判定，不能误认为同一事实。

用户明确查询进度是新输入，可读取最新状态；这不会清除 required obligation。诊断工具仍可直接读取 Store，但普通模型路径不得借诊断接口绕过等待。

### 6.3 结果到达竞争

child 终态通知与排队中的 `task_read` 竞争时，以持久 Artifact 和 background revision 为权威：

- 未派发的旧读取可以按现有 `superseded_by_user_input` 收敛；
- 已派发读取返回的终态与主动通知必须按 task ID/Artifact identity 去重；
- 同一终态只解除一次 required obligation、只注入一次具名结果；
- 收到结果不应导致模型同时处理通知和一个内容相同的读取结果。

### 6.4 完成守卫

required child 未终态时，模型 final 只是 completion candidate。若 required background 是唯一 blocker，CompletionGuard 返回专用 `wait_for_background` 决定，由 Runtime 持久化 waiting reason、清除 candidate 并停止模型调用，不消耗模型纠错次数。存在混合 blocker 时继续遵守 interaction、普通工具、Shell、unknown invocation、Skill 和 Plan 的既有优先级，不能让 background 等待遮蔽它们。child 终态后，只有 Kernel 准入的 canonical background result 解除 blocker；不要求额外 `task_read`。

## 7. 跨轮回传边界

`after_turn` 沿用已有结构化授权，不从自然语言或 `background=true` 推导。主 Run 正常完成后，旧 Run 不再接受定向 steer；结果进入 Session 的后台结果输入通道。Runtime 按以下顺序仲裁：

1. 如果用户已经启动新的活动 Run，沿当前 `human_start_preferred` 仲裁抑制自动续轮，结果保持持久可读；本方案不把旧 child 结果无条件注入不相关的新 Run；
2. Session 空闲时校验 continuation identity、一次性资格、正预算预留、原 deadline、停止／取消和 execution authority；
3. 满足时创建一次后续 Run；不满足时持久化结果与稳定抑制原因；
4. 重启或重复通知不得丢失合资格 continuation，也不得再次创建 Run。

若未来要求把迟到结果交给新的活动 Run，必须单独设计 durable Session result inbox、目标 Run/turn admission、与用户输入的线性化、低权限来源、exactly-once 消费及 authority 更替；不在本阶段暗含实现。

该路径与 required 同轮恢复分别验收，不能用其中一个通过证明另一个可用。

## 8. 客户端行为

Desktop 与 TUI 对 required 等待显示为同一 Run 的活动／等待状态，不把它展示成“模型持续思考”。输入框保持可发送；用户输入经现有定向引导进入原 Run。会话切换或重进从持久投影恢复 child 和 Run 状态，不靠客户端轮询修复。

`after_turn` 的父 Run 已完成时，输入框按普通空闲会话工作。合资格后续 Run 使用具名后台结果展示；因新活动 Run 而抑制续轮时，客户端只展示持久结果可用事实，不把它伪装成已注入该活动 Run。Web 保持只读能力，除非另有明确授权，不新增停止或调度 mutation。

## 9. 实施分解与 owner

### 阶段 A：契约与模型行为

- `packages/builtin-runtime`：更新主提示规则、`task`/`task_read` 工具契约和相应 schema hint/contract 测试。
- 不改变 `background`、`result_disposition` 的 wire 值；默认仍为 `required`。

### 阶段 B：受管等待与完成守卫

- `packages/agent-kernel`：让 required background blocker 的 next action 明确为 Runtime wait，不产生重复模型纠错。
- `apps/kite-service`：Scheduler/runner 在可机械判定入口进入持久等待；background owner watermark 触发重新判定，只有模型可行动事实恢复同一 Run。
- `packages/runtime-host`：保持等待的 Run identity、deadline、预算和用户输入唤醒语义。

### 阶段 C：结果竞争与客户端投影

- `apps/kite-service`：按 task/Artifact identity 去重主动通知与读取结果，保留 `superseded_by_user_input` 的真实语义。
- `packages/runtime-contract` / `runtime-protocol`：为持久 waiting reason 增加或复用最小投影，关联 required background identity；不复制 child lifecycle 权威。
- `packages/kite-client-ui`、Desktop/TUI owner：等待状态不锁输入，不显示为模型空转；重进只读投影恢复准确。

### 阶段 D：跨轮资格回归

- 保持 `after_turn` continuation 的一次性资格、预算、deadline 和 `human_start_preferred` 活动 Run 仲裁。
- 不扩大到 Shell，也不为不合资格结果自动创建 Run。

## 10. 验收测试

以下三组是独立门禁，必须使用事件屏障控制时序，不用固定 `sleep` 猜测：

### 10.1 独立任务并行启动

- A 尚未终态时 B 已进入 started/running；证明并发而不只是先后创建。
- 所有无依赖 ready sibling 都在父级进入任何 waiting 状态前取得 accepted/task identity。
- 主 Agent 的独立工作与 child 重叠执行。
- 依赖 sibling 不提前启动，并发写入遵守不重叠 ownership。

### 10.2 required 同轮受管等待

- child 被屏障保持运行，父 Run identity 不变，持久 waiting reason 和 required identities 可从重进投影恢复。
- 以 waiting reason 被接纳时的 Provider request count 为 baseline；到下一模型可行动持久事实前计数不变。多次非终态 watermark/revision 前进也不得请求模型。
- 模型/编排工具不调用 `sleep`；测试框架的有界 watchdog 或事件屏障等待不属于违规 sleep。相同读取按 `(runId, ownerGeneration, taskId, executionRevision)` 断言。
- 输入框／协议可发送用户引导；引导恢复同一 Run，不取消 child。处理后 child 仍未终态则再次进入零模型调用等待；引导与终态竞争时二者均按持久顺序处理且不创建第二个 Run。
- success、failed、cancelled 三种 child 终态均唤醒原 Run并产生具名结果；失败／取消解除该 child 的等待义务但不能伪造成成功。父 Run 取消则收敛 watcher 和迟到结果，不再生成 final。
- 双 required child 的混合终态中，一个失败／取消而另一个 running 时不得提前完成。
- Artifact、`cleanup_confirmed`、Kernel admission、result-input identity 和最终回复均按 `sessionId/runId/taskId/artifactId` 断言 cardinality；重复通知及主动通知/终态 `task_read` 竞争只解除、注入、恢复和 final 一次。
- settlement 持久化失败、owner generation 更替、authority recovery_required、deadline/cancel 竞态均进入明确 fail-closed 结果，不永久等待。

### 10.3 `after_turn` 跨轮自动回传

- 父 Run 在 child 完成前先持久化 completed；它可交付其他已完成内容，但对 pending child 只说明已受理和 task ID，不声称结果已完成。
- 屏障释放后，不需要用户发送“继续”，合资格 Session 至多创建一个后续 Run。
- 用户先创建新活动 Run 时，结果按 `human_start_preferred` 抑制自动续轮并保持可读，不创建并发主 Run。
- completed/failed/exhausted child 形成持久终态 Artifact，且 continuation 资格仍有效时，后续 Run 可以报告对应真实终态；cancelled/interrupted/suspended 只保留 Artifact，并以稳定原因抑制续轮。child 取消、continuation 撤销、Session/Runtime stop 分别断言 Artifact、抑制原因和 Run cardinality。
- 预算、deadline、授权、authority 或 continuation 资格不满足时不创建 Run，结果和稳定原因仍可读取。
- 用已持久化终态重放三个 crash window：Artifact 已写但 claim 未提交、continuation Run 已创建但消费标记未提交、消费已提交后通知重放。合资格最终恰好一个 Run；不合资格始终零个；结果输入与 Run creation 均 exactly once。该测试不要求重启后 child 进程续跑。

### 10.4 真实模型回归

使用现有 DeepSeek `deepseek-v4-flash` opt-in suite 分别覆盖 `background + required`、明确获准的 `after_turn` 和多会话切换。先断言结构化调用确实建立目标 disposition，否则标记“场景未建立”，不误判为调度失败；从持久 waiting admission 开始断言没有新增模型请求或重复读取。只断言结构化 identity、事件序列与 cardinality，不断言自然语言全文；保存模型版本、可用 seed 与脱敏 trace，不用无限重试掩盖失败。真实模型只作为端到端证据，确定性屏障测试负责调度不变量。

## 11. 文档同步与完成条件

实施时同步：

- 产品行为：[执行与结果](../handbook/features/execution.md)、Desktop/TUI 会话指南及 `docs/handbook/clients/tui/guides/input-and-queue.md`，统一活动 Run 的 steer 与真正后继队列边界；
- 技术边界：[CompletionGuard](../active/completion-guard.md)、Service Runtime owner、Builtin tool pipeline/contract；
- 若协议投影变化，同步 Runtime Contract/Protocol owner；若无新增字段，记录复用依据而不制造文档 diff。

完成条件：三组确定性验收、真实 DeepSeek required 与 after-turn 回归、相关 workspace typecheck 和文档／核心边界检查全部通过；真实 trace 中 required 等待期间模型请求为零，跨轮路径父 Run 明确先于 child 终态完成。任何一组未通过时方案保持实施中。

## 12. 过度设计边界

Required：复用现有 background watcher、required obligation、Artifact、CompletionGuard、Session result input 和 after-turn qualification；以最小调度修改阻止相同事实反复进入模型。

不实施：第二套任务 registry、持久轮询计时器、通用工作流引擎、客户端本地等待权威、任意后台工具自动续 Run、跨宿主 child 保活。若现有 projection 足以表达等待，不新增协议状态；若必须增加字段，只表达可验证的等待原因和关联 task identity。
