# Task 子协作叶子

`createTaskExtension({roles})` 显式装配 `task/task_read/task_wait/task_cancel/send_message/followup_task/list_agents/interrupt_agent/wait_agents/wait_agent` ordinary Tools。可信宿主选择 role→已注册 child configuration，模型不能提交新配置、权限或 Provider；构造/import 不执行 I/O。定义继续经过统一 Tool 权限与执行路径，child 使用既有 `operations.ensure(kind:agent)` 和唯一 Loop。

原调用 key/Store/主体/父 execution 由 Host 绑定；leaf 在自己的 namespace 保存 immutable 原 OperationRef。重复原调用只查回原 carrier，同 key 不能更换角色、输入、父关系或取消域。创建回执只表示 accepted，read/wait 返回真实 carrier；timeout 不停止 child，cancel 回执仅为 cancel_requested，停止以持久终态或 unknown 为准。正常 detached child 可在父完成后继续，读取历史不调用模型。

当前 leaf 的角色、同调用去重、共享单模型槽等待、父权限拒绝零 child Model、detached 后台继续及准确取消已由[真实 Core/SQLite 测试](../../../test/isolated/business/task/task.test.ts)验证。默认结果义务与事件驱动等待由 [required.test.ts](../../../test/isolated/business/task/required.test.ts) 的真实 Core/SQLite 场景验证；QueueOnly 邮件的当前边界见下文。

## 通用接口接入状态

[port.ts](port.ts) 给出有限公共合同。Task 使用 `admission=fail_if_full`，Runtime 在 durable ensure 前以原 ChildSlots 预留许可；第四个默认并发 Task 立即失败，零第四 child Session/Provider。成功预留交给同一 Job admission，失败或真实终态幂等释放，没有 query 软检查或第二 manager。

`operations.readAgent` 按原 ref 和准确 carrier 启动命令投影 child Run.deadlineAt/contextSelectionId，重复查询不激活历史。用户 steer 与 Agent 的 QueueOnly 邮件各有准确来源和受理事实；公共 HTTP/Store child 用户输入仍被拒。

`followup_task` 必须指定旧 task、准确 predecessor Run、当前 selection 和新 key。它创建新的 carrier 与 accepted follow-up 命令，保留原 Session 创建血缘与 history；旧 carrier/Run 真正终态后才以当前可信配置、父 catalogue/permission 交集和原容量进入同一 Loop。新 Run 重新取得 activation+30 分钟期限，不续签或重启旧执行。unknown、旧 Store、错关系或 context 不明不能自动接续。根 stop/delete 最后核实仍覆盖迟到 activation；两个 carrier 的最终事务维护唯一前台。只读历史没有 Model 或自动恢复。

`task` 和 `followup_task` 默认 `resultDisposition=required`，只有显式 `background` 才不登记本 Run 的结果义务。Store 在原 ensure 同一事务封存 carrier、不可变结果 metadata 与原父 Run completion ref；原 key 重试不能补加、移除或改变处置。准确已知终态结果由原父 Run/current selection 一次接纳为具名低信任来源，并进入下一 Model 输入后才解除完成等待。child failed/cancelled 保留实际状态，父可如实报告；unknown 只接纳一次状态诊断来源，不能满足义务或伪成功。取消后 suppressed/execution_cancel 的 required Task 仅接纳状态，不导入完整外部结果、不改回 pending；普通 suppressed Job 不消费。

Model 完成候选只剩准确 pending required carrier 时，同一 Run 复用 waiting_execution 与 waitingForResults 范围，通过既有 controls/持久变化水位等待；progress 和第一份 staggered 结果不轮询调用 Model。全部结果准确接纳后才重新请求一次 Model；完成评估期间刚结算的 carrier 也会在该边界重新核实并接纳，未知仍只产生一次状态诊断；新引导、取消和真实 interaction 使安全边界重新处理。`task_wait` 接受 1–64 个去重目标，等待任一真实终态/interaction/新输入，默认最多 30 秒且不超过调用 child Run 的原固定期限。超时或新引导不取消目标。QueueOnly 邮件见下节；idle follow-up 接纳见下节；根父 Task 的 after_turn 见下节；嵌套目标与完整 retry/delivery 尚未实施；默认 Service metadata 与 assembly 由 Service owner 接入。

普通 `operations.wait(ref)` 保留单目标终态等待契约：输入/interaction 事件仅唤醒重新核实，不使已派发的等待 Tool 失败或推断 child 已停止；原绝对 timeout 不重置，真实取消 signal 仍生效。新引导留在 durable input ledger，待该 Tool 返回后的安全边界处理。`waitAny` 的 input/interaction 返回继续用于 Task 的显式等待边界。真实 Desktop paired 测试覆盖等待 child 时 steer 与后续 Run 排队、释放后原 Run 正常完成。


## 当前协作目录与准确 interrupt

`list_agents` 通过普通 Operations 的有限 `listAgents` 读取本 extension/Session/原主体的实际 child operation Commands 与 carrier，而非把自有引用记录当第二权威。每页 1–200 项，Decimal64 `afterSeq/upperSeq/highWaterSeq/nextAfterSeq` 按持久 Command seq 枚举；首屏固定上界，后续新受理对象留到下一次查询。`snapshotCursor` 是该页读时水位，不承诺所有页共享可变状态快照。摘要只含准确身份、status、attempt、创建/执行组关系和原 carrier 对应 Run 的 status/active/deadline；不拉取 Model/Tool 正文、result 或完整 getView。引用缓存缺失时可通过准确受范围限制的 `getAgentRef` 查回已登记 child，不新建、换 key 或恢复。

`interrupt_agent` 必须给出 taskId、准确 targetRunId 和稳定 commandId。Host 验证原 ref；最终 Store 短事务再核真实 sender Tool、namespace/subject/原 Store/root owner、直接 child、carrier 当前引用和活动 Run，并沿原 Run 的 attached 取消域提交请求。回执只表示 `cancel_requested`。原 Run 已结束或换成新 carrier 时拒绝，不追逐当前最新 Run，也不升级 Session owner。同 ID/同原绑定重试返回原回执，无新事件；不同绑定不能改写。`task_cancel` 仍针对原 carrier，二者不混淆。

`wait_agents` 是当前 `task_wait` 去重集合/事件驱动 wait-any 的公开命名，保留 1–64 个准确目标、至多 30 秒及调用 child 原 deadline 边界，input/interaction 可早醒，等待不取消目标或持有 Model 槽。已经存在的 carrier 审批或精确 child ancestry 下的交互也可早醒；只读摘要只投影卡片 ID，不读取正文或授予执行权限。普通单目标 `operations.wait` 不因该卡片提前结束，也不反复查询卡片造成忙轮询。`wait_agent` 带 task 目标时保留上述行为，不带目标时等待调用者邮件事实、输入、交互或超时。

## QueueOnly 邮件

`send_message` 使用准确 taskId 或 `target:parent`，只能在真实直接父子关系内发送。`readAgentMessageTarget` 只读原 carrier 与封存父执行链，给出有限 Session/selection/Run 目标；父原 Run 已结束时返回未绑定目标，不选择后来的人类 Run。活动 child 的准确 Run 可在安全 checkpoint 接纳；idle 或明确未绑定邮件只排队，零新 carrier、Run、Model。调用者提供的旧 Run/selection 不能被自动替换。

正文最多 1MiB，完整 UTF-8 内容只保存于原 sender Execution 的不可变私有 Artifact。`agent.message` Command 封存原 Store、主体、namespace、sender、carrier、目标与原 key；发送 Tool 的终态提交同时登记接收资格。源 Tool failed/cancelled 为拒绝，未知或未确认不形成成功邮件；结算提交失败保留 pending_sender，显式恢复后可呈现原 unknown，不能重新执行发送 Tool。原 id 可查询，重复原绑定不创建第二封。

接收事务核 owner/fencing、准确 Run/selection、原父子/carrier、已成功 sender 与原 Artifact、取消和根 stop/delete 边界，再按原 messageId 一次写入低信任接收消息。Model 展开正文只凭这个 Command 与准确 receivedMessageId 的 SQL 证明，不解析普通 user JSON 取得私有引用。`receivedSeq` 仅观察已提交 inbox 消息；列表、等待和接收回执都不证明模型已读。实际后继 Model 的持久原请求/sourceIds 才证明 prepared 输入。

普通 Operations 的有界目录与邮件等待不消费正文或启动历史工作；`wait_agent` 最多 30 秒，仍受当前 child 原 deadline 约束。等待可报告邮件状态变更，但不会把 sender 失败/未知当成可用正文。显式 follow-up 在原 ensure 事务封存原目标 child 的邮件 seq 与成功 sender completed_cursor 双上界，并绑定准确 predecessor carrier、主体和目标 selection。同 key 重试不扩大集合；后来发送或后来确认的邮件继续 QueueOnly。新 Run 分页接收并保存 receivedRunId/receivedContextSelectionId，原 targetRunId=null 的意图不改写。根 Rewind 只改变根 Session 的选择；目标 child 未 Rewind 时，新显式 follow-up 可在全部原绑定核实后接纳旧 root→child 邮件。旧 child→root 邮件仍按目标根 selection 隔离。根父 Task 的 after_turn 自动汇报见下节；嵌套目标、followup_task 的 after_turn 与完整显式 retry/delivery 协议尚未实现。

[mailbox.test.ts](../../../test/isolated/business/task/mailbox.test.ts) 用同一 Loop、实际父子 Tool 和 SQLite 验证十二封超过旧 4KiB 的完整正文、双向消息、只读 scope 目标、接收触发器回滚与原 id 幂等、发送结算故障及显式恢复、取消目标不注入、idle 零启动、列表/等待不推进 prepared，以及后来活动人类 Run 不被旧 parent 查询选中。

[coordination.test.ts](../../../test/isolated/business/task/coordination.test.ts) 用真实 SQLite/Core、同一 Model 槽与固定本机 Model：70 个真实 child 的 32/32/6 页目录没有 64 项截断，缺引用缓存仍能等到原终态，readonly 重开/错误 Store/subject/namespace/ref 查询零 Model 与零 change；真实 interrupt 同 ID不重复写；旧 Run 结束、新 follow-up 激活后迟到 interrupt 最终事务拒绝且新 Run 未取消。默认 Service 的十个 Tool IDs/schema/effect 分类与真实 SDK 链路由 Service fixture 核实。

[mail-adoption.test.ts](../../../test/isolated/business/task/mail-adoption.test.ts) 验证 51 封邮件按封存双上界跨页接纳，完整私有正文与准确唯一 source IDs 进入新 child Model；晚确认/晚发送排除、原 key 重试不扩大集合、错误 Store/carrier/selection 零新 Run、根 Rewind 不跨 Session 改目标，以及新 carrier 权限等待时根 stop 零新 child Model。

## Task 的 after_turn

`TaskOptions.afterTurn={enabled:true}` 开放 `task` 与 `followup_task` 的 `resultDisposition=after_turn` 意图；默认关闭。可信 Run 配置或 Runtime 的 `afterTurn.authorize` 必须分别在原 ensure 与实际汇报前授权，返回准确 revision 和可选 controlReads。Model 参数或配置开关不能自行授予自动续轮。来源必须是实际 run.start/input.follow_up 或 child.start Run 的 task/followup_task Tool。嵌套任务在原发送者 child Session 汇报，追问任务绑定本次新 carrier 与新发送者 Run；报告 Run 本身不能递归授权下一次自动汇报。

原 carrier 的 after_turn 封存与 ensure 在同一事务；真实终态结算与唯一因果 `job.report` Command 登记在同一事务。汇报申请保留原 Store、主体、父 Run、Tool 定义/输入、配置、rootWork 与目标 context selection。应用时重新核实准确来源成功、已知 carrier 终态、原父已完成、owner、取消/删除、当前策略与控制 revision，再原子创建一个新 Run、接纳原结果源与保存回执。carrier 的 failed 状态保留，父可如实报告；unknown 不续轮。

报告 Run 在该原子应用中继承原父 requirements，不以新 Run 清空原 Planning/验证义务。宿主 initializer 保留 refs 而不重复登记原 Run ref；派发与完成仍核原 sealed record/proof/control read-set。Service 对有限实际 report/source/carrier/config/root work 关系核实后，才沿原批准读取执行方式；同 Session 的无关新 Run 不获得历史例外。当前信息来源仍与历史 receipt 校验分开，inactive 原 Run 不向新任务贡献批准。通用引用规则与实际 SQL 资格由[requirements owner](../../storage/sqlite/requirements/README.md)负责，默认可信角色/afterTurn 策略由[Service owner](../../../../../apps/service/README.md)负责。

已经接纳的新人类 start/follow-up 意图优先抑制尚未应用的汇报；先应用的报告占用普通前台，新人类工作按既有 admission 排队。Rewind、根停止或控制撤销抑制旧汇报，不向后来人类 Run 偷渡结果。完整正文沿原 carrier Artifact/低信任具名 source 读取，不复制 child 历史。普通 Model 权限与来源检查仍独立执行。

原父 binding lease 从后台 child 转移到 pending report/实际报告 Run，终态或抑制后释放；不重装当前配置。查询和冷只读不会推进报告。冷重开缺少原 binding 时不能自动调用 Provider，执行入口收束为 needs_review，保留原事实。待报告目录以 Command seq 固定上界分页，不依赖可裁剪通知。嵌套报告沿原 root owner 执行，不重新激活已终态的原 carrier；准确持久 job.report 及其封存来源是有限历史祖先例外，普通 child admission 不获得该例外。报告 Run 继承资金 child Run 的原 deadline，不重新获得三十分钟。当前目标的已受理 child.start/follow-up 优先抑制旧报告，活动父 Run 只延后申请，不调用新 Model。完整 retry/delivery 仍待后续切片。

[nested-after-turn.test.ts](../../../test/isolated/business/task/nested-after-turn.test.ts) 验证三层同 Loop 的来源、原 carrier 终态、期限和 lease；结果先到只保留申请，明确追问优先，真实 Run INSERT 故障整体回滚，以及 followup_task 的新 carrier/发送者 Run 汇报。报告与人类新工作仍分别经过普通 Model 权限和最终 Store 事务，不通过 Model 参数自授权。

显式 `resumeJobReport` 为根 Session 的冷报告重建提供独立入口：新 `job.report.resume` 申请绑定准确原 `job.report` 和原父配置，不能提交任意上下文或替换模型。宿主使用专门 `resolveRecoveryRunConfiguration` 恢复原定义，Core 核完整模型/工具/扩展/reviewer manifest；没有该能力时动态配置不能退回普通新 Run resolver，静态宿主也必须精确复现原manifest。恢复工厂前先通过只读Store检查root创建主体、报告主体与合法恢复来源；应用继续复核原策略、取消、selection和来源，允许的新报告仍使用唯一Loop及原来源的新Run，旧父Run不复活。

重复原恢复申请直接查回；不同申请对已应用报告仅记录原事实，不再执行已有Run。`applyJobReport.started` 只表示本次事务新建报告Run，不能以返回了某个历史Run推导应调用模型。恢复准入及模型执行都计入Runtime生命周期；准备可被关闭中止，绑定交给实际Run后由后代lease负责最后释放。准备disposer失败保留cleanup与profile使用锁，shutdown明确未确认，不自动重试失败disposer。原报告suppressed/rejected不作为重新执行资格，备份恢复换Store也不能改标原报告。该有限入口不提供任意Run重试、外部Job reconcile或嵌套child公开恢复。
