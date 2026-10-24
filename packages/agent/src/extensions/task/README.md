# Task 子协作叶子

只读角色的内置文件白名单同时识别原 `files.read@4` 与默认宿主的 `files.read@5`；版本5增加已绑定上传原件和 PDF 读取，仍须准确 Session／来源及原文件权限。未知版本、write/edit 和自定义同名定义不会因此取得只读资格。子会话只获得自己的会话文件清单上下文，不从父路径字符串继承父会话的可写目录或 Plan 批准。

子 Agent 协作 V1.1 的六工具、稳定协作者、普通会话直接输入、可靠结果接纳及运行中审批模式跟随已交付。产品行为归[执行手册](../../../../../docs/handbook/features/execution.md)，80项合同与实际运行证据归[测试 owner](../../../../../tests/README.md#子-agent-协作-v11-验证)，长期取舍归[稳定协作者决定](../../../../../.agents/notes/implemented/architecture/2026-10-18-stable-agent-collaboration-and-human-work-selection.md)。后续普通父轮次的 follow-up/message/interrupt 按当前父 Tool 授权及真实直接父子关系核验；目录 `workRelation` 仅表达技术执行出处，不额外限制同会话协作。以下历史接口说明只适用于实际封存工具和可信内部调用。

普通模型目录只展示 `spawn_agent / send_agent_message / follow_up_agent / wait_agent_events / list_agents / interrupt_agent`。spawn 仅要求 `prompt`，可选显示名称 `task_name`；默认通用 child；只有可信工厂登记的 prompt 预设才出现 `preset`。`task_name` 不参与查找、权限或去重。对应准确内部 Tool ID 为 `task.spawn / task.message / task.follow_up / task.events / task.list / task.interrupt`，均为 v1。旧 `task/task.execute/task_read/task_wait/task_cancel/send_message/followup_task/list_agents/interrupt_agent/wait_agents/wait_agent` 保留可信内部调用及原历史恢复定义，全部隐藏于当前模型目录；没有旧名称 alias。

工厂 `createTaskExtension({roles,defaultRole?,presets?})` 与 Service 可信装配共同解析配置。模型不能传 key、Run、selection、Provider、权限或 detached；普通 Tool invocation 的原 execution 派生受理身份。新 spawn 与 idle follow-up 没有 required completion 义务，而是封存 `agent_completion` 通知意图；通知和自动父轮授权是两份事实，没有自动授权不能启动 idle 父轮。旧显式 `after_turn` 仍必须由原可信策略授权。以下 legacy 章节说明仍有实际使用者的内部合同，不能据此向普通模型重新开放旧表面。

公开 `spawn_agent` 说明实际默认角色，`preset` 参数仅展示可信宿主开放项及其注册说明；未开放角色不进入该说明。默认只读角色明确不提供进程或网络派发，父模型须按任务必需步骤选择可执行角色。自定义角色使用实际注册说明，不按名称猜测能力；说明不替代冻结工具身份、权限或当前工具交集。研究委派要求从当前入口和装配沿可达调用链取证，父核验影响结论的关键来源，文件或符号存在不能证明当前链路。角色说明用于父模型选择，不作为新的子模型权限或单独提示注入入口。

## 稳定身份、准确命令和观察

成功 child 的原结果可携带宿主根据准确本轮 Tool 回执生成的 `details.evidence`；工具统计、来源版本、读取行窗及原文预览用于父级核验，child 自己的总结不能填写或替换该封存字段。它只覆盖选定历史的有界预览，遗漏明确计数，旧 Run 不进入本轮证据；Source、consume、ack、`resultAcceptance` 的含义不变。父级对照原文并独立核对决定结论的连接，不因报告已接纳或 Tool 成功就认定语义正确；也不能从预览缺项推断未发生过动作。完整合同、大小边界及回归归 [Agent owner](../../../README.md)，不新增协作工具或普通客户端诊断展示。

稳定目标邮件在原入队事务重新核准确 carrier、selection、工作关系和真实 Run.isActive；目录保留的已完成历史 Run 不成为活动投递目标。idle 邮件持久保存 targetRunId:null，只排队且不创建 child Run/Model；显式同工作 follow-up 再按原 predecessor 与双水位接纳。六工具回归另核这条 idle 正例的原 carrier、零激活及唯一邮件 Source，真实模型结果归测试 owner。

`agent_id` 即原 child Session ID。`applyAgentCommand` 在一个 Store 写事务内先查原 invocation 回执，再选择其当前唯一 carrier，核准确直接父子、原执行因果、Store、主体、来源、控制与取消关系。运行中/queued 的 follow-up 返回 `mode:steer`；queued 引导绑定原 carrier 并在其实际 activation 后接入，不改写原委派。idle 时在同事务通过原 `ensureAgent` 建唯一 successor，复用 Session 与原配置；后续普通父轮次也可引导其现有直接 child，技术工作关系不额外拒绝。interrupt 取消首次准入选定的 carrier，包含尚无 Run 的 queued carrier，后续新轮不被迟到重试改投。普通消息/中断须有当前父 Tool 授权，不能接管其他父会话的 child。受理响应丢失时 Host 查回原持久证明；受理时 `state` 保留原快照，不用后来状态改写历史。Host 只准备了 queued 引导，而最终事务发现目标已结束时，在新 carrier 写入前返回 `target_changed`，重新观察后的新调用才准备并启动新轮；不会留下无执行绑定的已受理 carrier。首次激活前取消且可证明从未派发的 child 可复用同一 Session：新 carrier 通过真实 `child.start` 建立首次 Run，不伪造前驱 Run，也不修改原取消事实。仅接纳准确 cancelled carrier、未派发证明及原 rejected start 的 `cancelled_before_apply`／`not_activated` 回执；已派发、unknown 或缺少证明仍拒绝。私有证明由 [首次激活 owner](../../storage/sqlite/child-first-activation.ts)封存并核验。

首次激活的同工作复用只把该工作最初原委派作为 `cancelled_agent_assignment_background` 背景消息，再保存本次新指令，明确新指令优先；跨工作不携带旧委派或采用旧工作邮件。被取消 carrier 的 queued 引导不转移到新 carrier。普通已有 Run 的 `input.follow_up` 前驱合同及邮件双水位不变。[首次激活回归](../../../test/isolated/business/task/collaboration-first-activation.test.ts)核实际模型输入、稳定身份与取消历史；[证明回归](../../../test/isolated/child/first-activation-proof.test.ts)核原持久绑定与拒绝边界。

`list_agents` 按首次 `operation.agent` Command 的不可变 seq 每个 child Session 只列一次；当前状态取准确最近 carrier，follow-up 不移动锚点。ID 过滤先整体核直接归属，固定 Decimal64 上界与 limit+1 判断真正后页；恰好 limit 且无后项返回 null。职责、最近引导与结果的完整原文通过本次 Tool 的受验证正文交付，大目录使用当前 Tool scope 的完整 Artifact，模型不必使用私有 OperationRef。目录查询和来源展开不接纳结果、不推进模型已读、不调用 Provider。

`wait_agent_events` 从持久 `change_event` 的已确认邮件与 carrier 真正终态读取有界摘要；`next_seq` 只到实际返回事件。省略/null `wait_ms` 在 Tool 内重复至多30秒的有限等待，显式0只取快照；每段重核输入、期限与取消。根调用者观察普通 steer/follow-up 与控制水位；历史 raw 输入的观察兼容不重新启动分类。通知不充当人类输入。child 的普通邮件遵循原邮箱范围。timeout 保原位置，不取消 child。观察与 Source 接纳、实际 prepared 分开；生命周期 on* 不参与可靠结果或唤醒。超过 replay floor 的缺口明确返回 cursor_expired 和可核实恢复边界。

模型说明明确区分稳定协作者与本次工作：同一 `agent_id` 可以经历多轮，`accepted/state/mode` 是原请求受理时的事实，不是本次工作完成证明。邮箱 `seq/next_seq` 只是观察位置；`after_seq:0` 可返回旧轮事件，follow-up 不重置邮箱，继续观察沿最近已返回的 `next_seq`，但推进游标不代表接纳或已读结果。`completed` 摘要本身不能关联为最新 follow-up 的终态。目录的 `current_work_source/state` 与 `last_outcome/last_result_source` 分开解释，后者可能仍是上一终态结果；须以当前可见工作关系和准确完整结果来源核实本次完成，无法关联时保留未确认，不猜 Run 或私有 carrier。后来收到结果也不倒写较早 Model 输入当时已有的来源。这些仅为现有回执和观察语义的说明，不增加公开字段、宿主状态转换或接纳权限。

错误使用有限 `error.code/message/next_action`；命令受理 true/false/null 区分有证明、已知未受理与不可核实，list/wait 不带 accepted。只读观察的已知取消投影为 `operation_cancelled/none`，不误报回执不可核实；写命令取消时若仍可能已经受理，继续保留未知并查原回执，不推断未受理。未知不自动重放、不换身份。需要父/人类答复的 child 提示只允许一次显式有限30秒观察，无有效答复时正常收束为诚实待决结果；附着 Job/cleanup 或 unknown 仍守原结算门禁。这项提示不等于已验证所有模型都会遵守，也不伪造业务完成。

[六工具真实回归](../../../test/isolated/business/task/collaboration-surface.test.ts)独立核 Model 实际目录、spawn/follow-up提交后响应丢失、稳定职责/最近来源、超过32KiB目录的完整 Artifact 实际模型正文、同 invocation 回执、queued 引导与准确取消、后续普通轮次管理已有直接child与idle复用、raw human 唤醒且不跳邮箱 cursor，以及有限错误/受理三态投影。历史工具测试通过明确隔离的 [legacy fixture](../../../test/fixtures/legacy-task-surface.ts)验证原内部合同，不能折算为六工具全量运行通过。

可信内部旧接口的[默认角色](roles.ts)保留 worker／code，并提供完整 explore／plan／review 只读分析能力；这些 role schema 不向普通六工具目录开放。旧 Task 与前台 Task 的实际说明包含五个角色、实施任务适用条件以及独立兄弟任务并行语义；描述不是权限。三个只读角色只取父调用当前步骤的冻结工具身份与可信角色范围的交集，再由 Agent 纯 `isReadOnlyTaskTool` 核冻结定义的 extension owner、ID 与版本；同名自定义工具、未来版本、文件写入、进程／联网派发及未知 MCP 不能借角色名称进入 child。新增角色不增加默认三个槽位，也不替代父子权限、计划、取消和真实记录核验。[真实默认角色测试](../../../../../apps/service/test/isolated/default-task-roles.test.ts)覆盖 plan／review 的实际 child、读取、Scope、记录与完整结果。

原调用 key/Store/主体/父 execution 由 Host 绑定；leaf 在自己的 namespace 保存 immutable 原 OperationRef。重复原调用只查回原 carrier，同 key 不能更换角色、输入、父关系或取消域。创建回执只表示 accepted，read/wait 返回真实 carrier；timeout 不停止 child，cancel 回执仅为 cancel_requested，停止以持久终态或 unknown 为准。正常 detached child 可在父完成后继续，读取历史不调用模型。

默认 child 的父工具交集先经 Agent 的纯 `isRootOnlyTaskTool` 排除准确 `builtin.ask-user/ask_user@1`，保留根 Agent 的人类澄清入口。父计划阶段自动加入的合法 Planning 工具由 Service 核原父冻结 owner／ID／version 与当前真实注册定义后装配，当前显式禁用仍拒绝；未知工具不取得这项例外。child 的基础合同和自身 Run 状态来源不等于继承父计划意图，原 requirements、parent AND current permission 和独立实际效果许可继续适用。

当前 leaf 的角色、同调用去重、共享单模型槽等待、父权限拒绝零 child Model、detached 后台继续及准确取消已由[真实 Core/SQLite 测试](../../../test/isolated/business/task/task.test.ts)验证。默认结果义务与事件驱动等待由 [required.test.ts](../../../test/isolated/business/task/required.test.ts) 的真实 Core/SQLite 场景验证；QueueOnly 邮件的当前边界见下文。

child Model／Run结束后，原carrier仍须等待该child范围内未结算的Model／Tool与attached Job，包含尚未取得process槽的Job；detached保持独立。Runtime沿准确Store／root owner／carrier调用 `inspectChildSettlement`，同一短读事务取得pending与change cursor，再经原ChangeWaits等待，不持有SQLite事务或额外Model槽。最终 `finishExecution` 原成功门禁仍重新核实；unknown继续交原附着域归并，不伪装已停止。准确持久取消使carrier为cancelled，同时保留已经completed的原child Run；只有本地中断且缺持久取消证据时为unknown。[收敛回归](../../../test/isolated/business/task/attached-job-settlement.test.ts)以一个process槽和两个受控Job核queued／running、detached独立、等待中精确取消、旧cursor先变化及close drain。实际Shell曾暴露Store正确拒绝后carrier永久running的缺口，取舍见[修复决定](../../../../../.agents/notes/implemented/bug-fix/2026-10-15-task-attached-job-settlement.md)，真实压力证据归[Service owner](../../../../../apps/service/README.md#多主子会话流与读取压力)。

## 前台完整结果与后台处置

正式前台 `task.execute` 复用原 role、key、immutable OperationRef 和真实 child carrier，由 [foreground.ts](foreground.ts) 等待该准确 carrier 的实际终态；创建 accepted 不作为完成。原父 Tool call ID 收到完整 child 总结后，父 Model 才继续。同一批多个前台 Task 可以并发创建独立 child，仍服从实际 ChildSlots 和父工具集合／权限交集。大正文核原 carrier 的准确 Artifact scope、完整 UTF-8 和大小，再发布到当前 Tool scope；不截断或复制整个 child 历史。

前台 Tool 内部以 `resultDisposition=background` 创建 carrier，因为该 Tool 已负责等待并返回同一结果，不再登记第二份 required result 来重复续轮。这个内部处置不使前台 Task detached，也不开放 Model 的后台／after_turn 参数。原 `task`、`followup_task` 的 accepted、required、显式 background／after_turn 合同保留，见下文。

普通 child carrier 可以是 `runId=null` 的实际 Job；准确父 Tool、原 Store／Session／root work 和独立 child Session／Run 提供血缘，不能将 carrier 的 null Run 冒认为父 Run。取消沿原 attached 域传播；前台等待只观察原 ref 的真实终态，未确认或 unknown 保原未知，不造 cleanup 成功。明确人类拒绝须由 carrier 保存结果、实际 child Session／Run、终态与同一 resultRevision 证明 `approval_denied`，才向父 Tool 传递该类型，使原父批次停止而不再请求 Model；普通失败、模型文字或 stderr 不取得这项资格。

默认有限角色的准确创建调用可由 [Task request classifier](../../permissions/task-request.ts) 标为纯内部记录能力；只限未覆写的正式角色声明及已注册 `task`／`task.execute`／对应 `agent/<role>` carrier。custom 角色、配置覆写、未知定义和其他 mutation 仍保守。创建许可不批准 child 的真实 Files、Shell 或联网效果，三策略与父子 ceiling 由[权限 owner](../../permissions/README.md)统一解释。

本次 macOS 当前工作树实际运行 `bun test packages/agent/test/isolated/business/task/task.test.ts`：11 项、74 断言通过，含原后台／default-three 拒第四、真实并发前台、完整大正文、取消、人类拒绝，以及父人工 ceiling 与子自动审核相交后仍需实际人工批准。原终端 [subagent-approval](../../../../../tests/tui-system/scenarios/subagent-approval.test.ts) 整文件 9 项、120 断言通过，含真实外部写入、自动审核和四 child 取消后继顺序；四 child 用例显式选择可信测试宿主四槽配置，不改变正式默认三槽。该证据不证明其余 TUI 全集、Win/Linux 原生资格或整体阶段退出。

## 通用接口接入状态

[port.ts](port.ts) 给出有限公共合同。普通 Task 使用原 durable ensure 受理，默认三个 ChildSlots 仅调度同时运行数量；第四个任务保留实际 child Session/carrier 并等待空位，不因固定排队长度或时长失败，激活时才开始自身 30 分钟期限。可信宿主接受正整数并发配置。底层显式 `admission=fail_if_full` 的调用仍表达调用方明确选择的立即拒绝语义，普通 Task 不再隐式选择它。许可由原 Job admission 在真实终态幂等释放，没有第二 manager。

已受理但从未派发的 child carrier 在取得空位后，仍须通过当前准确工作资格。未决输入、暂停或另一个工作被选中使它暂缓时，[执行协调器](../../execution/index.ts)释放刚取得的 child 槽和资源，保留原 planned 身份，通过原 Store change cursor 等待；明确恢复原工作后重新核权限和最终派发，不沿用旧授权。停止、替换、取消、unknown 和 owner fence 仍走原拒绝或取消路径。等待期间没有 child Run/Model，也没有提前开始 30 分钟期限。[真实 Runtime/SQLite 回归](../../../test/isolated/business/task/queued-work-eligibility.test.ts)覆盖继续、停止、替换及恢复前权限拒绝，并用下一条同工作排队 carrier 实际取得已释放的槽作为证据。

`operations.readAgent` 按原 ref 和准确 carrier 启动命令投影 child Run.deadlineAt/contextSelectionId，重复查询不激活历史。用户 steer 与 Agent 的 QueueOnly 邮件各有准确来源和受理事实；公共 HTTP/Store child 用户输入仍被拒。

`followup_task` 必须指定旧 task、准确 predecessor Run、当前 selection 和新 key。它创建新的 carrier 与 accepted follow-up 命令，保留原 Session 创建血缘与 history；旧 carrier/Run 真正终态后才以当前可信配置、父 catalogue/permission 交集和原容量进入同一 Loop。新 Run 重新取得 activation+30 分钟期限，不续签或重启旧执行。unknown、旧 Store、错关系或 context 不明不能自动接续。根 stop/delete 最后核实仍覆盖迟到 activation；两个 carrier 的最终事务维护唯一前台。只读历史没有 Model 或自动恢复。

`task` 和 `followup_task` 默认 `resultDisposition=required`，只有显式 `background` 才不登记本 Run 的结果义务。Store 在原 ensure 同一事务封存 carrier、不可变结果 metadata 与原父 Run completion ref；原 key 重试不能补加、移除或改变处置。Run 义务及完整等待集合不设累计数量或字节额度，真实65个 required child 的同父 Run 等待与结算由上述 required 回归验证。准确已知终态结果由原父 Run/current selection 一次接纳为具名低信任来源，并进入下一 Model 输入后才解除完成等待。child failed/cancelled 保留实际状态，父可如实报告；unknown 只接纳一次状态诊断来源，不能满足义务或伪成功。取消后 suppressed/execution_cancel 的 required Task 仅接纳状态，不导入完整外部结果、不改回 pending；普通 suppressed Job 不消费。

Model 完成候选只剩准确 pending required carrier 时，同一 Run 复用 waiting_execution 与 waitingForResults 范围，通过既有 controls/持久变化水位等待；progress 和第一份 staggered 结果不轮询调用 Model。全部结果准确接纳后才重新请求一次 Model；完成评估期间刚结算的 carrier 也会在该边界重新核实并接纳，未知仍只产生一次状态诊断；新引导、取消和真实 interaction 使安全边界重新处理。`task_wait` 接受 1–64 个去重目标，等待任一真实终态/interaction/新输入，默认最多 30 秒且不超过调用 child Run 的原固定期限。超时或新引导不取消目标。 Host 仅在 `observeUpdates=true` 且存在准确 Run 时，在变更 cursor 后读取该 Run 的 pending steer/result.include 快照；根会话真实 raw 输入另核原 observedRunId、selection、主体与未决事实，不仅依赖旧 command.accepted 事件。无准确 Run 绑定或普通 child 消息不成为人类输入，终态型 operations.wait 保持原合同。QueueOnly 邮件与 idle follow-up 接纳见下节；根父、嵌套 Task 及 followup_task 的 after_turn 见下节。完整 retry/delivery 尚未实施；默认 Service metadata 与 assembly 由 Service owner 接入。

普通 `operations.wait(ref)` 保留单目标终态等待契约：输入/interaction 事件仅唤醒重新核实，不使已派发的等待 Tool 失败或推断 child 已停止；原绝对 timeout 不重置，真实取消 signal 仍生效。新引导留在 durable input ledger，待该 Tool 返回后的安全边界处理。`waitAny` 的 input/interaction 返回继续用于 Task 的显式等待边界。真实 Desktop paired 测试覆盖等待 child 时 steer 与后续 Run 排队、释放后原 Run 正常完成。


## 当前协作目录与准确 interrupt

本节记录仍有实际调用者的内部旧 `list_agents`／`interrupt_agent`／wait-any 定义；其 Tool ID 与普通模型名称不同。当前模型的同名公开入口分别映射准确 `task.list@1`／`task.interrupt@1`，使用本页开头的稳定 Session 合同，不接受下述旧 taskId/targetRunId 参数。

`list_agents` 通过普通 Operations 的有限 `listAgents` 读取本 extension/Session/原主体的实际 child operation Commands 与 carrier，而非把自有引用记录当第二权威。每页 1–200 项，Decimal64 `afterSeq/upperSeq/highWaterSeq/nextAfterSeq` 按持久 Command seq 枚举；首屏固定上界，后续新受理对象留到下一次查询。`snapshotCursor` 是该页读时水位，不承诺所有页共享可变状态快照。摘要只含准确身份、status、attempt、创建/执行组关系和原 carrier 对应 Run 的 status/active/deadline；不拉取 Model/Tool 正文、result 或完整 getView。引用缓存缺失时可通过准确受范围限制的 `getAgentRef` 查回已登记 child，不新建、换 key 或恢复。

`interrupt_agent` 必须给出 taskId、准确 targetRunId 和稳定 commandId。Host 验证原 ref；最终 Store 短事务再核真实 sender Tool、namespace/subject/原 Store/root owner、直接 child、carrier 当前引用和活动 Run，并沿原 Run 的 attached 取消域提交请求。回执只表示 `cancel_requested`。原 Run 已结束或换成新 carrier 时拒绝，不追逐当前最新 Run，也不升级 Session owner。同 ID/同原绑定重试返回原回执，无新事件；不同绑定不能改写。`task_cancel` 仍针对原 carrier，二者不混淆。

`wait_agents` 是当前 `task_wait` 去重集合/事件驱动 wait-any 的公开命名，保留 1–64 个准确目标、至多 30 秒及调用 child 原 deadline 边界，input/interaction 可早醒，等待不取消目标或持有 Model 槽。已经存在的 carrier 审批或精确 child ancestry 下的交互也可早醒；只读摘要只投影卡片 ID，不读取正文或授予执行权限。普通单目标 `operations.wait` 不因该卡片提前结束，也不反复查询卡片造成忙轮询。`wait_agent` 带 task 目标时保留上述行为，不带目标时等待调用者邮件事实、输入、交互或超时。

## QueueOnly 邮件

普通协作邮件与新 `agent_completion` 最终结果共用 Store 邮箱，分别投影为 `kind:message` 和 `kind:result`。前者保原 sender Tool／Artifact，后者保原 carrier／result revision 并发布唯一 Source；结果回执以 `receivedSourceId` 区分普通 `receivedMessageId`，`receivedSeq` 覆盖两者的实际发布序号。用户引导在同一 Runtime 检查点汇合但仍使用原输入入口和权限。结果的条件续跑及旧记录兼容见 [Store owner](../../storage/README.md#统一消息接收)。

`send_message` 使用准确 taskId 或 `target:parent`，只能在真实直接父子关系内发送。`readAgentMessageTarget` 只读原 carrier 与封存父执行链，给出有限 Session/selection/Run 目标；父原 Run 已结束时返回未绑定目标，不选择后来的人类 Run。活动 child 的准确 Run 可在安全 checkpoint 接纳；idle 或明确未绑定邮件只排队，零新 carrier、Run、Model。调用者提供的旧 Run/selection 不能被自动替换。

正文最多 1MiB，完整 UTF-8 内容只保存于原 sender Execution 的不可变私有 Artifact。`agent.message` Command 封存原 Store、主体、namespace、sender、carrier、目标与原 key；发送 Tool 的终态提交同时登记接收资格。源 Tool failed/cancelled 为拒绝，未知或未确认不形成成功邮件；结算提交失败保留 pending_sender，显式恢复后可呈现原 unknown，不能重新执行发送 Tool。原 id 可查询，重复原绑定不创建第二封。

接收事务核 owner/fencing、准确 Run/selection、原父子/carrier、已成功 sender 与原 Artifact、取消和根 stop/delete 边界，再按原 messageId 一次写入低信任接收消息。Model 展开正文只凭这个 Command 与准确 receivedMessageId 的 SQL 证明，不解析普通 user JSON 取得私有引用。`receivedSeq` 仅观察已提交 inbox 消息；列表、等待和接收回执都不证明模型已读。实际后继 Model 的持久原请求/sourceIds 才证明 prepared 输入。

普通 Operations 的有界目录与邮件等待不消费正文或启动历史工作；`wait_agent` 最多 30 秒，仍受当前 child 原 deadline 约束。等待可报告邮件状态变更，但不会把 sender 失败/未知当成可用正文。显式 follow-up 在原 ensure 事务封存原目标 child 的邮件 seq 与成功 sender completed_cursor 双上界，并绑定准确 predecessor carrier、主体和目标 selection。同 key 重试不扩大集合；后来发送或后来确认的邮件继续 QueueOnly。新 Run 分页接收并保存 receivedRunId/receivedContextSelectionId，原 targetRunId=null 的意图不改写。根 Rewind 只改变根 Session 的选择；目标 child 未 Rewind 时，新显式 follow-up 可在全部原绑定核实后接纳旧 root→child 邮件。旧 child→root 邮件仍按目标根 selection 隔离。根父、嵌套 Task 及 followup_task 的 after_turn 自动汇报见下节；完整显式 retry/delivery 协议尚未实现。

[mailbox.test.ts](../../../test/isolated/business/task/mailbox.test.ts) 用同一 Loop、实际父子 Tool 和 SQLite 验证十二封超过旧 4KiB 的完整正文、双向消息、只读 scope 目标、接收触发器回滚与原 id 幂等、发送结算故障及显式恢复、取消目标不注入、idle 零启动、列表/等待不推进 prepared，以及后来活动人类 Run 不被旧 parent 查询选中。

[coordination.test.ts](../../../test/isolated/business/task/coordination.test.ts) 用真实 SQLite/Core、同一 Model 槽与固定本机 Model：70 个真实 child 的 32/32/6 页目录没有 64 项截断，缺引用缓存仍能等到原终态，readonly 重开/错误 Store/subject/namespace/ref 查询零 Model 与零 change；真实 interrupt 同 ID不重复写；旧 Run 结束、新 follow-up 激活后迟到 interrupt 最终事务拒绝且新 Run 未取消。默认 Service 的十个 Tool IDs/schema/effect 分类与真实 SDK 链路由 Service fixture 核实。

[mail-adoption.test.ts](../../../test/isolated/business/task/mail-adoption.test.ts) 验证 51 封邮件按封存双上界跨页接纳，完整私有正文与准确唯一 source IDs 进入新 child Model；晚确认/晚发送排除、原 key 重试不扩大集合、错误 Store/carrier/selection 零新 Run、根 Rewind 不跨 Session 改目标，以及新 carrier 权限等待时根 stop 零新 child Model。

## Task 的 after_turn

`TaskOptions.afterTurn={enabled:true}` 开放 `task` 与 `followup_task` 的 `resultDisposition=after_turn` 意图；默认关闭。可信 Run 配置或 Runtime 的 `afterTurn.authorize` 必须分别在原 ensure 与实际汇报前授权，返回准确 revision 和可选 controlReads。Model 参数或配置开关不能自行授予自动续轮。来源必须是实际 run.start/input.follow_up 或 child.start Run 的 task/followup_task Tool。嵌套任务在原发送者 child Session 汇报，追问任务绑定本次新 carrier 与新发送者 Run；报告 Run 本身不能递归授权下一次自动汇报。

原 carrier 的 after_turn 封存与 ensure 在同一事务；真实终态结算与唯一因果 `job.report` Command 登记在同一事务。汇报申请保留原 Store、主体、父 Run、Tool 定义/输入、配置、rootWork 与目标 context selection。应用时重新核实准确来源成功、已知 carrier 终态、原父已完成、owner、取消/删除、当前策略与控制 revision，再原子创建一个新 Run、接纳原结果源与保存回执。carrier 的 failed 状态保留，父可如实报告；unknown 不续轮。

报告 Run 在该原子应用中继承原父 requirements，不以新 Run 清空原 Planning/验证义务。宿主 initializer 保留 refs 而不重复登记原 Run ref；派发与完成仍核原 sealed record/proof/control read-set。Service 对有限实际 report/source/carrier/config/root work 关系核实后，才沿原批准读取执行方式；同 Session 的无关新 Run 不获得历史例外。当前信息来源仍与历史 receipt 校验分开，inactive 原 Run 不向新任务贡献批准。通用引用规则与实际 SQL 资格由[requirements owner](../../storage/sqlite/requirements/README.md)负责；默认 Task／follow-up 后续汇报策略由[Agent 权限 owner](../../permissions/README.md)核原角色／来源／工作／取消／当前信任，角色装配和可信事实读取由[Service owner](../../../../../apps/service/README.md)提供，原 Task／carrier／Model 授权保持独立。

已经接纳的新人类 start/follow-up 意图优先抑制尚未应用的汇报；先应用的报告占用普通前台，新人类工作按既有 admission 排队。Rewind、根停止或控制撤销抑制旧汇报，不向后来人类 Run 偷渡结果。完整正文沿原 carrier Artifact/低信任具名 source 读取，不复制 child 历史。普通 Model 权限与来源检查仍独立执行。

原父 binding lease 从后台 child 转移到 pending report/实际报告 Run，终态或抑制后释放；不重装当前配置。已暂缓报告被取消或 Rewind 直接结算时，观察者也释放该准确报告持有的 lease，不等待下一次报告调度或 Runtime 关闭；`continuation_admission` 不释放，仍由报告 pump 或活动父 Run 接纳路径转移给准确 successor，再按该报告终态释放。查询和冷只读不会推进报告。冷重开缺少原 binding 时不能自动调用 Provider，执行入口收束为 needs_review，保留原事实。待报告目录以 Command seq 固定上界分页，不依赖可裁剪通知。嵌套报告沿原 root owner 执行，不重新激活已终态的原 carrier；准确持久 job.report 及其封存来源是有限历史祖先例外，普通 child admission 不获得该例外。报告 Run 继承资金 child Run 的原 deadline，不重新获得三十分钟。当前目标的已受理 child.start/follow-up 优先抑制旧报告，活动父 Run 只延后申请，不调用新 Model。完整 retry/delivery 仍待后续切片。

[nested-after-turn.test.ts](../../../test/isolated/business/task/nested-after-turn.test.ts) 验证三层同 Loop 的来源、原 carrier 终态、期限和 lease；结果先到只保留申请，明确追问优先，真实 Run INSERT 故障整体回滚，以及 followup_task 的新 carrier/发送者 Run 汇报。报告与人类新工作仍分别经过普通 Model 权限和最终 Store 事务，不通过 Model 参数自授权。

显式 `resumeJobReport` 为根 Session 的冷报告重建提供独立入口：新 `job.report.resume` 申请绑定准确原 `job.report` 和原父配置，不能提交任意上下文或替换模型。宿主使用专门 `resolveRecoveryRunConfiguration` 恢复原定义，Core 核完整模型/工具/扩展/reviewer manifest；没有该能力时动态配置不能退回普通新 Run resolver，静态宿主也必须精确复现原manifest。恢复工厂前先通过只读Store检查root创建主体、报告主体与合法恢复来源；应用继续复核原策略、取消、selection和来源，允许的新报告仍使用唯一Loop及原来源的新Run，旧父Run不复活。

重复原恢复申请直接查回；不同申请对已应用报告仅记录原事实，不再执行已有Run。`applyJobReport.started` 只表示本次事务新建报告Run，不能以返回了某个历史Run推导应调用模型。恢复准入及模型执行都计入Runtime生命周期；准备可被关闭中止，绑定交给实际Run后由后代lease负责最后释放。准备disposer失败保留cleanup与profile使用锁，shutdown明确未确认，不自动重试失败disposer。原报告suppressed/rejected不作为重新执行资格，备份恢复换Store也不能改标原报告。该有限入口不提供任意Run重试、外部Job reconcile或嵌套child公开恢复。

[冷报告完整恢复文件](../../../test/isolated/recovery/job-report-resume-runtime.test.ts)保原十二模式、断言及5／15秒预算；fixture 只有准确 carrier 真正终态后，才由其固定 `resultRevision` 查原报告 ID。running 的 revision 0 不代表后来报告，`listPendingJobReports` 也不列 needs_review。该时序修正后12项200断言通过，生产恢复／审批／取消合同未改；原完整默认红与集成结果归[当前进度](../../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11默认-task-完整回归的父子时序)。

前台 task.execute 在派发前声明并封存 version 1 continuation。冷恢复调用独立 resume 实现，复用原 key、immutable OperationRef 和 carrier，再观察原子 Run；正常 execute 不会被当成通用外部效果重试。Core 按可信合同及原 manifest/来源匹配，不按工具名称放行。父子同一 root fencing、queued/active/terminal 子状态、原审批、固定 deadline、Host 去重和绑定 lease 的恢复归[统一协议](../../storage/sqlite/run-resume.README.md)。[真实组强杀](../../../test/isolated/recovery/run-resume-group-runtime.test.ts)核前台/后台必需等待、多子、排队、嵌套、激活前、已结束子、审批和超期；SQL 故障另核未知效果和组漂移。
