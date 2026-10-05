# Child Session 与根执行组存储

`OperationRequest.kind=agent` 只给出允许的 configurationId 与 input。Core 宿主在 `EnsureOperationInput.childConfiguration` 传入已核实的 id/version/snapshot；普通扩展没有该宿主字段、owner 或 Store。内部 adapter 固定为 `agent/<configurationId>`，绑定 sealed version。完整配置、原 input、父关系、附着取消关系与起源 Store 纳入同 operation key 的请求摘要；不同绑定冲突，不能把旧计划改标当前 Store。

可信宿主的完整配置与 root Run、follow-up 使用同一保存语义，不对 child snapshot 单独施加 1 MiB 上限。配置中的完整来源可以超过该大小，仍须经过原 Worker 队列背压；该调整不改变公开输入、输出或 metadata 的各自限制。同 operation key 的完整摘要和 `activateChildRun` 的配置全等仍核全部字节，包括大正文尾部。实际非 Workflow Store 测试同时验证原配置冷读取、重复回执及变更冲突。

可信 fresh resolver 的 namespace 观察自动保存为 `childConfiguration.recordReads`，最多 64 个唯一 extension/key 与 32 KiB canonical metadata；每项含完整原记录投影 digest、revision 和 origin，absence 同样封存。新 carrier 创建与 `activateChildRun` 最终短事务沿实际 parent Execution 定位原 Run manifest，只允许该 Session 已绑定 namespace，重新核全部投影及缺失事实。普通扩展/Model/HTTP 没有这些字段或读取权限。getter 随 resolver 结束关闭；同 key 的历史回执先返回原关联，不重新解析或授予执行。空数组不扩大任何 namespace，也不要求 runless Action 虚构祖先 Run。真实 [配置读集测试](../../../../test/isolated/child/configuration-reads.test.ts)覆盖 preflight 后变化、最终事务拒绝、missing/namespace/origin 与 resolver lifetime；原普通 runless child 链仍保持。

`ensureOperation` 原子建立 operation Command、planned Job、新 child Session、已应用创建命令及 accepted `child.start` 命令。全部继承原主体、rootWorkCommandId/seq 和父 Job 决策来源，交付目标仍为原创建 Session/contextSelection。父工具响应丢失查回同一个 childSessionId/executionId，不重建。最多 256 个 Session 属于一个 root group；关系深度最多 64，不扫描整个库。

`activateChildRun` 是唯一受控 child.start 激活入口，输入 rootOwner、executionId、configuration、可增加的 requirements、required requirementEvaluations 与 freshness。Job 必须已真实 dispatched 且仍 dispatching/running；configuration 必须等于原 snapshot，freshness.checked 必须是宿主当前重新读取并比较来源后的 true，source 精确等于父 Job 原 decisionSource。Store 不读取磁盘、不调用模型，只复核已封存来源和当前必要记录 revision/evaluation。继承父必要 refs 不可省略；同事务创建原 child Run/用户输入消息/命令回执，重复返回同一 Run，绝不另启模型。

Session 持久 root_id/parent_id 与 Execution.root_session_id 表示归属，不另建 Run Registry 或子状态机。OwnerRef 始终指根 Session；根 OS 锁与 generation 管理整组。child acquire/recover 明确 group_root_required，不能借 child 锁绕过根。主进程 request 检查真实持有的 root owner；Worker 复核 root/child 归属及 generation。child 的模型/工具/部分正文/终态仍保存真实 child Session/Run 关系和来源，model/tool 自动关联原 carrier Job。正常父完成不等于局部取消，已经可靠创建的后台 child 可继续；carrier Job 成功前 child 活 Run、未结算 Model/Tool 与 attached Job 必须收束；已建立的独立 detached Job 保留自己的监督与 owner，不阻已完成 child Run 的 carrier 成功。

最终创建、child 激活与每次派发均检查原 Store、命令撤销、根及每个 Session 祖先的 stop/delete 边界、carrier Job 活性、适用 attached 祖先取消、owner generation、封存来源/定义/输入和必要条件。detached 只切局部父执行取消边，根全停止仍覆盖旧因果后代；child 全停止只覆盖其 Session 子树，父和兄弟保持独立。取消事务跨 Session 沿真实 attached 边传播，标记 child Run 与启动命令；root stop 保存工作边界，不能靠迟到 detached 创建逃过。

根 owner 的 acquire/release 检查整组 active Run、未结算/unknown Execution 与 accepted 命令。显式根 recover fencing 整组：模型失败、partial incomplete 保留；同 Store 未派发工作取消，可能有效果的 Job/tool unknown。原执行 generation/source/origin 不改，不自动再次派发，unknown 继续限制根组执行资格。正常重开仅查询历史。

真实 SQLite 测试在 `test/isolated/child/store.test.ts`：稳定 key/配置冲突、SQL 触发器整体回滚、双 Worker 根锁/借用 owner 拒绝、父先完成、child 自有消息与模型事实、必要记录变化及 source 变化拒绝、attached/detached/根边界、nested 子树隔离、根 recover 原组中断与旧 owner 拒绝。Store 不调用模型；统一默认 Loop 的实际模型次数与 HTTP 集成由 Core owner 验证。新增关系字段属于未发布新 Store 基线，不读取或迁移旧用户数据。

Run 最终短事务以持久取消事实收束竞态：未终态 failed 回执遇到 Run 或原 Command 已取消时保存 cancelled，保留实际 reason；已完成的 Run 不被后续取消改写。child Artifact 主体由 child.start、carrier Job、原主体与父/root group 精确关联核实，不能用任意 subject 或父 Session 重绑定引用。


普通 child 在 `activateChildRun` 实际提交时保存 `run.deadline_at = started_at + 1,800,000ms`，Run DTO 的 `deadlineAt` 是有限毫秒值；root Run 为 null，无累计或总时长期限。期限不从输入/configuration snapshot 读取，普通 public snapshot 不能取得 reviewer 私有用途或取消期限。Model/Tool/Job 最终派发在原 Store/owner/来源/取消核实之外检查自身 child 边界与适用 attached 祖先期限；已经激活的 detached 独立 child 保留自身期限，不因旧父期限被扩大取消。根 stop/delete 的较广边界不变。

Runtime 仅以已保存期限安排 OS 计时器，到期先提交准确 `run.cancel` 附着取消域，再 signal 当前执行；SQL 先观察到期限时也走同一收束。取消不推断外部停止，迟到 output/result 可保存，unknown 不改成已停止，partial 保持 incomplete；只读重开不启动计时器或模型，也不续签旧期限。`test/isolated/child/deadline-store.test.ts` 与 `deadline-runtime.test.ts` 用私有临时 SQLite 将激活/期限成对移近当前时间，验证固定生产 30 分钟、最终拒绝/事务回滚、detached 独立期限、macOS 实际模型/Tool 取消及 partial/unknown。macOS 独立 qualification 已真实等待固定生产期限：elapsed 1,800,036ms，child cancelled、partial 保留、attached unknown、detached 仍 running，cleanup 后 process exit 0；跨平台计时资格仍待验证；没有用户短期限配置或新的累计额度。

普通受控 follow-up 可在准确同 child Session 创建新 carrier；原创建血缘 immutable，新 Run 的 originCommandId 固定对应自己的 carrier，不通过 first/last Session row 猜测。执行与取消资格由准确 carrier/Run 关联核实；新 activation 取得自己的固定期限，旧 Ref/Run/来源不重标，公共 child input 仍拒。

Carrier terminal facts are checked again in the final SQLite transaction. An attached descendant outcome_unknown in the exact original Store/root work/parent chain cannot be downgraded to a known failed/cancelled child settlement merely because its Run ended. The carrier becomes outcome_unknown and retains the actual child Run status plus the original outcome in details. Independent detached Jobs/children keep their separate supervision domain and are excluded from this fold. Actual Task Core tests exercise a child ordinary Tool returning unknown, one parent diagnosis request with zero result acceptance, a known failed child that remains acceptably failed, and an independent detached unknown Job that does not block the genuinely completed carrier.

The final attached-domain read is bounded to 32 edges. If that boundary still has attached descendants, it records outcome_unknown with attached_domain_unverifiable rather than treating unenumerated effects as known. This is a fail-closed settlement read, not an added child-depth quota; existing Session/ancestor admission limits remain separate.


有限 `getAgentSummary/listAgentSummaries` 在[child-query-operations.ts](../child-query-operations.ts)只选 child carrier 身份列和准确 reference 对应 Run 的少量字段，避免列表拉取 result/config/history 正文。目录上界为原 Session/namespace/subject 下持久 operation Command seq，Decimal64 keyset 和每页 ≤200；每页读一致 snapshot，但后页状态可随真实工作推进。原 Store、直接 child、准确 Run origin/rootWork 关系不明时不授予资格，查询不 acquire owner、不启动 Provider 或恢复。

摘要的 `waitingInteractionId` 只来自同 Store/rootWork、尚未取消的真实执行：原 carrier 的卡片或持久 ancestry 精确包含目标 child 的后代卡片。它供 wait-any 观测已存在交互，不含请求正文、不替代审批绑定或派发资格；普通终态 wait 不因此提前返回。

`interruptAgent` 在[agent-input-operations.ts](../agent-input-operations.ts)登记准确 child 当前 Run 的停止意图，调用既有取消事务的有限内部 body，复查与取消共享最终事务。实际 sender/namespace/subject/root group 从原 Command/Execution 推导，不能由 payload 自授予；旧 Run 结束或 carrier/reference 已换时拒绝。历史重复 command 返回原回执，无重新选目标或额外派发。附着后代与独立 detached 域保持既有取消语义，停止请求不等于已监督清理确认。

[agent-mail-operations.ts](../agent-mail-operations.ts) 复用 Command 作为 QueueOnly 来源事实，message 作为幂等 inbox，不增加独立邮箱工作流表。基线 Command 的 mail_target_session_id/run_id/selection_id、mail_received_message_id 与 mail_confirmed 保存准确受理、成功 sender 和一次接收关联。源 Tool 终态与 mail_confirmed 在同一原事务结算；接收短事务再次核原 Store/主体/carrier、目标 Run/selection、取消、Artifact 与 owner generation。未来人类 Run 不继承未绑定或旧 Run 邮件。

目录以原目标/主体的实际 Command rowid 做 Decimal64 keyset，每页 ≤100、固定 upperSeq；receivedSeq 来自实际 inbox message seq，与 Model prepared 事实分别表示。只读摘要不会修改接收或模型水位，正文仅在原私有 Artifact。`readAgentMessageTarget` 沿原 sender 的准确 carrier/父执行链读取有限目标，不使用 Session first/last Run 猜测，也不取得 owner、调用 Provider 或重放 operation。

显式 follow-up 的原启动 Command 保存 mail_adoption_upper_seq/cursor 双上界；只允许准确 predecessor carrier 的已成功 sender、原目标 selection 和 seq 范围。接收不会改 mail_target_run_id，而是同事务保存 mail_received_run_id/selection_id 与唯一 inbox message。历史读取由这些实际关联证明，不接受调用者自报的新 Run。mail.seq 在封存前但 sender.completed_cursor 在封存后的邮件仍留 QueueOnly；根 Rewind 不改子 Session 的选择域。

## after_turn 因果汇报

[job-report-operations.ts](../job-report-operations.ts) 复用 execution.after_turn_json 与有限 job.report Command，不增加 scheduler 表。可信原 ensure 授权封存后，finishExecution 与唯一因果申请同事务；applyJobReport 在原 owner 下重新核实 source Tool/parent Run/carrier 的准确 Store、rootWork、配置、定义与输入，检查目标选择、取消及策略控制，再同事务创建报告 Run、接纳原低信任结果 source 和回执。已接纳人类工作优先；unknown、Rewind、停止、来源或控制变化保历史并拒续轮。列表纯读、Decimal64 固定上界，通知裁剪不删除申请权威。原 carrier 终态不改写。嵌套目标与 followup_task 沿原发送者 Session/新 carrier 汇报；root OS owner 仍是唯一 group authority。只有真实 sealed job.report、原资金 Run/child.start/历史 carrier 的准确关系通过最终事务时，报告才使用终态 carrier 作为历史祖先证明；普通 child.start 不放宽。报告继承资金 child Run deadline，普通 activation 仍固定 startedAt+1800000。基线 deadline CHECK 允许较短期限，具名报告事务保存原期限，不续签。

同一 Session 的已受理新 child.start 也参与优先抑制；尚活动的资金 Run 只推迟申请。Runtime 使用现有按 Session 的 pump，并解析该 Session 的 root owner，不另建调度器或取得 child OS owner。SQL 终态先可见时，只有准确原 parentRun 的热 binding lease 可移交；冷重开仍 needs_review。嵌套报告读取原结果由准确 job.report/newRun 关系证明，不将终态原来源命令恢复为 active。

已在同 Store/generation 的准确 carrier 上派发且实际激活的 detached child 是独立执行域：最终祖先验证仍核原 Command、group stop/delete、Store 与 owner，但不再要求已完成的祖父 foreground carrier 保持 running，也不继承该旧父局部取消/期限。子自己的实际 carrier、activation deadline 与 active Run 仍严格核实。未激活、attached 或调用者 snapshot 不能开启这个例外。实际 Service compatible SDK nested after_turn fixture 覆盖父先完成、孙 Model 后最终派发的异步窗口；原 root stop 与期限测试保留。
