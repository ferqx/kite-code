# Service Runtime Application 与 App Control

本页是 `apps/kite-service/src/composition.ts`、`src/bootstrap/**`、`src/runtime-application/**` 与
`src/app-control/**` 的 owner-local current authority。它们同时组合default parent-owned App Server与显式daemon；CLI/TUI
只通过typed Runtime/App client seam消费结果。

独立子 Session 的 `task_read`／`task_wait` 先核父任务意图、父子血缘与结果封存证明，再从子 Session 已提交事件投影有限的模型重试信息。显式 `task_wait` 同时监听父与当前本机子 Session 的 revision；重试可唤醒这一次等待，但不成为子终态或 required 结算事实。父侧终态结果携带 Kernel 的稳定原因码，已接纳终态快照另给出 `safeRetry`、`recoveryEntry` 和外部效果确定性。原始 Provider 错误和子任务正文不作为诊断字段。子任务失败是读取到的结果，`task_read`／`task_wait` 的 Tool 仍可成功返回结构化 JSON；外部效果未知时保留原恢复限制。

## 唯一 Host/Store composition

`app/workspace/remove` 由当前 Service/Store owner 执行。请求的规范路径与持久 digest、projectId、workspaceId 重新交叉核对；删除门禁在 Store writer 中与新 Session 插入互斥，同空间活跃删除不能重入。Service 用准确 Run 身份提交取消，等待本地执行收尾，再通过 Host 的 `delete_session` 删除顶层及其内部子会话树。被删 Session 的订阅关闭，迟到通知被丢弃；HTTP 服务商请求若已发出，不把远端停止确认作为本地删除条件。顶层历史归零后，Service 将持久门禁标记为已完成；客户端再用 token 调用 `finalize` 释放门禁，然后移除本机项目登记。`finalize` 不接受仍在运行或 token 不符的删除，失败时项目登记保留供重试。旧 Service 退出后，新 owner 可接管未完成删除；已完成的门禁可由新 token 接续收尾。回归见 [App Server process](../test/isolated/app-server-process.test.ts)、[Store 原子边界](../../../packages/runtime-storage-sqlite/test/isolated/kite-session-runtime-storage.test.ts)与[Desktop navigation](../../kite-desktop/test/navigation.test.ts)。

`createKiteServiceRuntimeComposition` 接受一个显式 `checkpointPath`，组合一个 SQLite storage owner、Runtime Host、
Builtin execution、Runtime Server、raw event/history projector、Runtime Application与operation gate。Service executable的default App Server
按installed/source profile使用`kite-session.sqlite`；旧`<kite-home>/kite.sqlite`原样保留但不可见。CLI/TUI不再有Host/Server/SQLite/Builtin依赖或旧
InProcess composition调用点。
composition在打开前以realpath parent + filename建立process-local Store claim；相同路径或canonical alias的第二owner
fail closed，dispose完成后才释放claim。internal/test stdio绕过此default composition时必须使用显式isolated nondefault path。

同一个process owner持有Store writer、coordinator registry与lazy per-Session runtime bridge。Runtime Client close只释放
connection/subscription/broker binding；quiesce、cancel、drain与dispose只能由Service Application lifecycle触发。
CLI in-process组合在已完成执行释放coordinator后，也从同一Store只读投影会话；已保存终态仍可查询，不为历史读取重新取得执行权。
只读投影在没有活动 Run 时按创建 revision 选择最新 Run；旧 Run 的 `unknown` 不覆盖更新的已结算 Run。仅最新候选仍为 `unknown` 且来源无歧义时，才投影为 `recovery_required`。多 Session 后台结算与重新访问的回归覆盖同一 Session revision 下的当前 Run 身份一致性。

两个独立 Service 指向同一 Store 时，观察方的显式投影查询可读取执行方已提交的事实，并刷新本地订阅水位；另一进程的提交本身不会向观察方的进程内订阅主动推送通知。执行冲突仍由持久执行权限拒绝，执行方正常退出后观察方可取得权限继续。真实双进程验证见 [App Server cross-process test](../../../tests/release/app-server-cross-process.test.ts)。
`list_checkpoints`与`get_rewind_preview`也从该Store读取；预览在核对持久Session的Workspace身份后读取文件变化，不要求闲置会话重新建立执行coordinator。

并发 Shell 的 [State runner](../src/bootstrap/runtime/state-runner.ts) 在事务提交后同步把整批事件放入原有发布队列，再让异步消费者逐条读取。不能由各个工具的异步 generator 逐条入队，否则一个事务中间可能插入兄弟工具的更高 revision，导致 Bridge 的顺序校验失败并中断后续模型调用。异步 effect preparation 返回时也重新核对 State revision；后台工具已推进 State 时，丢弃旧决定并重新调度，不能使用旧的 stop 决定退出。确定性回归见 [State runner acknowledgement](../test/runtime/state-runner-ack.test.ts)，包含事务交错、工具收尾期间准备完成与模型继续执行。

[RuntimeSessionCoordinator](../src/bootstrap/runtime/RuntimeSessionCoordinator.ts) 保留每个 canonical event 的确切 post-event State，并由 Bridge 的命令 activation、runner 消费和取消路径共同按 revision 排空原有待发布队列。控制命令不能越过后台已提交、尚未被 generator 读取的事件；generator 之后交出已发布对象时不重复通知。所有 event 都来自 Kernel 接受的 batch，不再以 event type／部分 identity 猜测原始对象的 revision。Provider action 的 `started` 在相同确切 State 上投影当前 interaction availability，不能先发布空事件版本再补发同版本交互。[coordinator 回归](../test/runtime/runtime-session-coordinator.test.ts)同时验证控制命令交错与 canonical 失败事件。

运行中引导沿相同 coordinator/mailbox 提交 `user.message_appended` 与持久回执。主模型 invocation 的 prepared State revision 是输入消费水位；队列最多保留 8 条未消费引导，subagent 自己的模型 invocation 不推进该水位。新输入不会中止已派发工作，但会使旧模型响应中尚未派发的工具和根审批确定性失效。`shell_read` 的等待器订阅同一输入水位，因此可返回 `new_input` 后把决定权交回模型。

[Managed Shell](../src/bootstrap/runtime/managed-shell.ts)持有有限 Shell/service 的活句柄、总期限、256 KiB 有界输出、多读取者游标和进程树清理；持久 State 只保存可恢复事实，不尝试在宿主重启后接管旧 pid。[Background subagent Runtime](../src/bootstrap/runtime/subagent/background-runtime.ts)独占 child observe，先保存 immutable Artifact，再向 Kernel 提交具名低权限结果并写 settlement proof；在回调和 proof 完成之前，活任务快照与 `task_read`／`task_wait` 仍保持非终态，不能因 Artifact 已写就向等待器投影 `unavailable`。确实无法结算时，先保存可枚举的 recovery claim，再发布 unavailable watermark。[After-turn continuation](../src/bootstrap/runtime/subagent/after-turn-continuation.ts)只消费已持久化的授权、预算 reservation 与稳定 wakeKey，通过现有 Host `start_turn` 创建至多一个后续 Run；它不是第二套 scheduler。observe、Artifact、具名结果持久化、通知或 Host wake 任一环节失败时，统一的 settlement failure 回调幂等释放该 reservation；不能因报告链路失败永久占用原 Run 预算。

[后台 Agent 与 Shell 会话协调方案](../../../docs/plans/background-agent-shell-conversation-coordination.md)的 A–C 等待修复已有受控 Service/Host 回归：三个 required child 错峰结算、双有限 Shell、Shell 与 child 两种先后顺序、显式 `task_wait` 均核对同一 Run 的零纠错等待与单次恢复。[三 child／Shell 回归](../test/isolated/runtime-server-required-background-three-child-barrier.test.ts)和[结果提交间隙回归](../test/background-subagent-runtime.test.ts)分别验证部分完成和 Artifact 已写但未接纳的窗口。Builtin 与 Service 已具备私有 checkpoint 生成、结果绑定和崩溃后 proof 修复的内部路径；Store11 首次提供生产 checkpoint backend，现行 Store14 延续该路径。独立父子 Session 的 `send_message` QueueOnly 邮箱、`list_agents`、`wait_agent`、`followup_task` 和 `interrupt_agent` 已开放；`current_turn` 仍受下述精确授权条件限制，旧结果事件不会因此重发。真实 DeepSeek `deepseek-flash` 的隔离多 Session 测试另验证了 required child、单次 `task_wait`、会话隔离和 after-turn 恰好一个续行 Run。

显式 `task_wait` 复用 Background subagent Runtime 已有的 owner watermark 与 waiter，对 1–8 个目标执行单次有界 wait-any；目标终态、超时、Run abort 或当前 Turn 的新用户输入结束该工具调用。无关 State revision 和非目标 owner 变化只触发重新判定，不直接驱动模型；超时与 steer 不取消 child。它不建立持久 deadline、第二个 scheduler 或新的终态存储，宿主重启后的单次等待由普通 safe-read 重入重新开始。

普通写 Tool 不占 `activeWriters` 数量额度。Host 只在未结算的 Artifact 上界暂时占满预算时创建持久 `artifact_capacity` waiter，Service 等现有工具结算后再核对预算与执行权；已知上界能同时放进预算的写 Tool 可并行准入。未派发 Tool 的 waiter 超时或累计预算拒绝只生成该 Tool 的失败结果，Service 继续同一 Run；旧式同步 Task 的子并发许可等待超时已在 Task Pipeline 提交为 `tool.failed` 后不再次抛给父 Run。普通工具在持久 State 确认尚无执行尝试时发生适配异常，也在同批提交预算释放与该工具的 `tool.failed`，同一 Run 可继续；已派发结果不明、模型准入及持久化失败仍按 Run 级安全出口处理。自动审批尚未派发的 Tool 不消耗 Tool 调用次数及 Artifact 实际额度；已派发 Shell 缺少可靠文件变更事实时仍保守结算其预留上界。

Tool 准入重入先按同一 invocation 查持久 reservation：`reserved` 只续用原身份完成派发，`dispatch_started` 或 `unknown` 进入结果核对，不产生第二个预留，也不把重复预留失败伪装成未派发 Tool 的预算拒绝。此前已结算的同一 invocation 也不能被再次派发；审批后另一次明确授权使用独立的 invocation 身份。

background task 返回“已接受”时，父工具 reservation 随工具终态结算；派发时已经创建的 descendant admission 仍引用同一 Run 内未释放的父 reservation，为 child 的后续模型轮次和工具调用逐项保留、派发并核销预算。独立子 Session 的新委派使用标记的 `child-allotment` 上界：父 Run 在受理时必须有效，子 Run 激活时才开始自身完整的 30 分钟期限；父 Run 已耗时间不缩短它。父账本将并发 elapsedRunMs 按最大值核算，不再把时间按子任务数平分。模型请求、turn、token 和 Artifact bytes 等累计 counters 按配置的子并发上限加两份父级余量分配；默认 Limited 的 120 次模型请求在上限 3 时每个 child 最多预留 24 次。带新标记的委派不设累计工具调用次数上界，新的独立子 Session 与 v2 followup 资金上界不再占用 Tool/Shell 数量 gauge；普通 Tool/Shell 不取得活动数量或写者数量许可，但角色、策略、审批、traits 冲突和 Artifact 预算仍生效。旧委派缺少该标记时继续按原 deadline 与有限工具上界激活，已有非零 Tool/Shell gauge 的历史委派继续按其持久上界恢复。Service 不在父工具结算后重建 admission，也不把该血缘扩展到其他 Run。

新委派的 required child 成为 CompletionGuard 唯一 blocker 时，Service 在进入受管等待后为原父 Run 写入 `resource_budget.required_child_wait_started`；准确子结果接纳并解除等待后写入 `resource_budget.required_child_wait_ended`，补回实际等待时长。等待期间父 Run 不派发新的资源 reservation。旧委派不启用该暂停，原 Run 身份、取消和结果接纳规则均保持原样。相关代码入口为 [State runner](../src/bootstrap/runtime/state-runner.ts) 与 [Kernel budget reducer](../../../packages/agent-kernel/src/core/lease/reducer.ts)。

required child 是 CompletionGuard 唯一 blocker 时，State runner 接纳 `wait_for_background` 并停止 Provider 循环；Kernel State 持久保存进入等待时的 required task ID，Bridge 将其投影到同一 Run。混合有限 Shell 命中 `wait_for_tool` 时同样不消耗纠错，Service 按准确 owner 快照等待所有必需 Shell 清理完成与 child 结果接纳；用户引导单独唤醒模型。background owner 只有在具名结果已被 Kernel 接纳并写入 settlement proof，或 settlement failure 的 durable recovery claim 已可枚举后，才发布对应 terminal／unavailable watermark；若 Kernel revision 与 owner watermark 同时到达，waiter 基于最新 State 重算 required 集合，不用旧快照把已接纳结果误判为缺失。background owner watermark、Kernel revision 与 execution authority 只触发重新判定：只有已接纳终态／失败／取消、需父级处理的交互或用户输入等可行动事实才恢复模型，进度、心跳或日志 revision 只更新投影。相同 owner generation、task ID 与 execution revision 的 `running` 读取不会再次成为模型决策输入。owner generation 更替、authority detached／recovery_required、真实缺少 recovery claim 的 settlement admission 失败、deadline 或 Runtime stop 按既有 fail-closed recovery／unknown／取消边界收敛，不释放未被 Kernel 接纳的义务。

主动终态通知与已派发 `task_read` 的结果按 task／Artifact identity 去重；同一终态至多解除一次义务、注入一次具名结果并恢复一次 Run。after-turn 结果到达时若 Session 已有用户开始的新活动 Run，Host 的 `human_start_preferred` 抑制自动 continuation；结果保持持久可读，不注入该活动 Run，也不创建并发主 Run。

`after_turn` 独立子 Session 在原父 Run 完成后继续使用原 child intent、委派预算及 deadline，子终态按原父 Tool 身份一次导入并保存后台结果。Service 将自动汇报交给 Host；若后续人类 Run 已优先启动，Host 抑制自动汇报并释放预留。显式 `followup_task` 不依赖该自动汇报：正式 App Server 验收验证新受理 v2 请求在子原 Run 终态后启动 `new_turn`，并验证第二个人类 Run 只收到其明确 submission 的唯一回复；历史 v1 的 `current_turn` 只读路由由存储与 Host 定向用例验证。[当前轮用例](../test/isolated/runtime-server-after-turn-current-turn-reply.test.ts)与[新轮用例](../test/isolated/runtime-server-after-turn-independent-followup.test.ts)均核对父子终态只导入一次和汇报预算最终释放。

Bridge 把 Shell 与 child 快照合并为带 Session revision、aggregate generation 与 owner-local generation 的 typed background projection，并通过 Agent API 提供只读列表。精确停止命令先提交 requested fact 和回执，activation/recovery 再驱动对应活 owner；实际完成回调回到 mailbox 提交 settled，句柄遗失提交 unknown。Session close/delete 调用同一 `shutdownSession` 清理，Fork/Rewind 在 live background 存在时拒绝。验证见 [managed shell](../test/runtime/managed-shell.test.ts)、[background subagent](../test/background-subagent-runtime.test.ts)、[after-turn](../test/after-turn-continuation.test.ts) 与 [coordinator](../test/runtime/runtime-session-coordinator.test.ts)。

[Turn coordinator](../src/bootstrap/runtime/turn-coordinator.ts) 显式持有 State runner iterator：消费者提前关闭或投影失败时，先提交当前 Turn 的错误取消与 unknown 结果，再中止本地 Provider I/O、关闭 iterator 并等待原有有界清理，最后释放 runner。后台 Shell 用实际执行 Promise 集合承担收尾，不在消费者离开后继续占用失去 owner 的运行状态。日志记录已提交终态；持久提交失败仍停止本地 I/O，不能伪造成功或清理确认。[coordinator 回归](../test/runtime/runtime-session-coordinator.test.ts)覆盖提前关闭与真实 Bridge 投影故障，[并发取消回归](../test/runtime/concurrent-shell-cancel.test.ts)覆盖前台与后台工具的清理等待。

提交 start 或恢复审批回执后，如果 activation 失败，Host 不会 dispatch；Bridge 必须在丢失执行 owner 前持久结束已接受 Turn。审批路径还须按捕获的 broker identity 释放准确 waiter，不能因清空 pending 字段后发布失败而永久挂起。执行前的模型／投影初始化也属于同一故障收尾范围。已恢复审批被拒绝后不再为已经终止的 Turn 准备 resume。提前退出的已分类执行故障与错误取消在同一 batch 提交，保留原始 canonical failure，不能再被通用的消费者关闭错误覆盖。

当前 source/release 默认组合 App Server 多连接 Session Store。默认 stdio child 不创建 HTTP listener；显式 daemon 在同一进程中组合 loopback Web、Agent API 与 static/API Docs，并在 shutdown 时关闭。Coordinator、per-Workspace Worker 与独立 Web Gateway 进程不是普通启动拓扑；不要把 daemon Web 归类为 legacy Service。实际入口见 [daemon owner](../src/app-server-daemon.ts)。

子Agent在工具审批前挂起时，continuation中的blocked参数必须使用同一次解析得到的`pendingRequest.args`，与Kernel审批绑定和持久工具调用一致。原始模型参数仅保留在模型消息中；被schema移除的字段不能重新进入审批或恢复执行，也不能通过放宽digest校验补救。Shell审批等待时child Driver已清理，已批准的child工具由Host先执行，再恢复child模型循环；取消此窗口必须停止Host工具并保持父Run取消，不能为尚未恢复的Driver制造第二次清理事实。

上述审批 continuation 适用于既有 Provider 子任务路径。独立子 Session 的人工工具审批增加了私有父作用域代理：子 Session 保留真实审批 State，Store12 在同一 canonical 请求事务保存父／子身份与 grant 绑定；父 Session 的交互队列只投影代理 ID、父 revision 与现有 `subagent_tool` owner，不公开可执行的子 Session ID。父 `respond_interaction` 的决定与命令回执在同一 Store 事务提交，子工具仅在独立子 Session 接纳对应 `approval.granted` 后继续；拒绝同样按子审批事实结算。Service 从精确 Store 代理行提交仅表示代理状态变化的 `subagent.child_approval_proxy_changed` 父 State 事件，推进父 revision 并把待审批与结算队列送入订阅投影；不在父 Kernel 写 `approval.requested`，也不把父 Task Tool 重置为待审批。正式 App Server 在线回归已验证父查询、父命令、订阅待审批／结算通知、子工具批准后执行及原父 Run 结果接纳。其他类型的隐藏子交互仍失败封闭。已派发或证据不完整的子 Tool 在崩溃后不得因父批准而重放；待答与父决定已持久化两个窗口已通过真实 SIGKILL 重启验收：准确父命令回执核验后，子原 Run 续轮、Tool 恰好一次派发、父结果一次接纳，并在 required-background barrier 解除后完成原父 Run；缺少请求、回执、模型 Artifact 或 Tool 派发证据时仍保留明确的 `recovery_required`，不重放外部尝试。

默认 Store14 独立父子 Session 的 Agent 通信向模型暴露 `send_message`、`list_agents`、`wait_agent`、`followup_task` 和 `interrupt_agent`。`send_message` 对直接父／子只做 QueueOnly 持久受理，不启动空闲目标 Run；目标 Event／inbox 在单独目标事务接收，仅绑定目标当前 Run 的消息在下一次模型 admission 作为低信任 `<agent_message>` 输入。列表按父子血缘读取有界 Agent 树、当前 Run 未读计数和最近一次续轮终态；等待复查未读、Agent 终态水位、用户引导或超时，不消费邮件或取消子 Run。终态 ACK 即使不推进父 State revision，也通过来源当前 Run 的收据计数触发 `agent_update`；首轮子结果仍独立展示。正式 App Server 回归已验证 `followup_task` 的来源 Tool 受理、空成功回执、目标 checkpoint 新轮、终态 ACK，以及 `interrupt_agent` 对准确直接子任务的停止结算与错误目标拒绝。旧同 Session mailbox 不作为该独立路径入口。原模型 `model.responded`／`tool.queued` transcript 保留 Tool 参数中的发送正文；邮箱专用 body 只在来源私有存储保留一份，目标 Event／History 不含正文。冷启动扫描对待投递来源按 DB 分页去重，重复恢复依目标事务回执恰好一次。

阶段 D3 将 `followup_task` 的准确 Tool attempt 绑定到已准备的 policy digest，并在来源同一 Tool command 中受理有界备付 reservation、邮件事实、私有 admission Artifact 和回执；缺少可信 Workspace 策略、目标 checkpoint 或执行证据时拒绝。零 Tool `new_turn` 的真实 Pipeline／Host／Store／Provider 回归覆盖目标独立收件、新 grant、新 Run、准确首模型 Surface、逐字段有界资金替换、一次派发、目标 checkpoint 和来源终态回执；source auto revision 1／child auto revision 0 的权限证明和目标目录／mode 漂移拒绝也已验证。历史 v1 `current_turn` 仅在原 D0 child Run 已激活且父派发 ACK、原本地模型预算与准确邮件 Surface 尚未派发、来源策略与目标安全边界可核时复用旧 Run；来源受理冻结旧 Run，final 先结算则改走 `new_turn`。目标须为 `explore`／`plan`／`review`、旧 sealed grant 有有限工具列表且无 binding；Model Surface 将旧 grant 与静态 `read_file`／`search_content`／`search_files` 求交，路由后的 Tool 派发沿同一上界检查，不能借消息扩大原 Run 工具权限。内部真实链路已验证零 Tool 当前轮首模型一次派发，route-only 与已释放备付两种真实 SIGKILL 窗口均沿原 invocation／Surface 恢复一次；旧版定向回归曾验证带只读 Surface 的下一次 Model 在原 Run 消费消息；现行正式入口新受理 v2 请求只在子原 Run 结束后启动独立新 Run。父子 Session 的 mode revision 独立递增；Store 分别核验来源政策与来源 revision，并要求目标初始 mode／revision 0，不把两个 Session 的 revision 数值当作相同策略证明。`new_turn` 的真实 SIGKILL 回归还覆盖准备前不派发、激活后同 ID 恢复恰好一次、尝试后目标 `task.failed`／Run unknown 与来源资金 unknown ACK。已受理但来源 Tool 确定失败时，备付释放收据与原 outbox 同事务保存；证据不足仍保留需恢复状态。

首轮 required 子结果由原父 Run 一次导入和具名结果帧交付。若它在原 Run 消费了 `current_turn` 邮件，child owner 于原任务封存后记录准确 submission 的低信息量终态；Store 核对 route、输入准备、原任务 seal 与来源后备释放，再向发送方派生一封确定性的状态回复，不复制原结果正文。已完成的 `new_turn` 续轮凭目标 settlement、不可变 checkpoint 与来源资金 ACK 派生确定性 `reply` 邮箱；派发前失败或取消另要求零模型尝试、目标终态与来源两笔 `local_pre_dispatch_failure` 释放。已尝试或用量未知时不发送确定性终态回复。目标 Model 已准备而未派发时若原期限到期，目标先以固定理由封存失败、释放本地预留，再由来源释放未替换的后备并生成一封未派发通知；历史 Run 的可读证明同时核对这一终态。Service 在续轮终态后投递，并在冷启动扫描漏写或待投递回复；父 Run 已结束时 inbox 不绑定后来人类 Run。正式 App Server 独立新轮回归核对原 Run 结果只导入一次、准确 submission 的状态回复与一次来源模型输入；Store 验证幂等及缺失证明拒绝。

2026-09-26 的[合成隔离真实 DeepSeek D3 用例](../../../tests/e2e/live/model/background-agent-followup.live.ts)使用固定官方 `https://api.deepseek.com/v1` 端点和 `deepseek-flash`，从正式 Service/Host 入口创建一个独立子 Session；父第二 Run 的一次 `followup_task` 触发目标 `new_turn`，目标结算后来源只收到一封跨 Run `reply`。用例核对目标两次模型尝试、一次邮件输入准备与父子零 `run.error`；测试环境只含新建合成任务，没有使用旧会话数据。另一个[独立的合成隔离真实 DeepSeek `current_turn` 用例](../../../tests/e2e/live/model/background-agent-current-turn.live.ts)验证 required review 子首模型在 FIFO Shell 等待时，父同一 Run 受理一次 `followup_task`；释放 Shell 后子路由为 `current_turn`，唯一邮件输入准备绑定准确第二次真实模型调用，子仍以原 Run 结算，父 required 结果只导入一次。用例断言持久事件身份和次数，没有断言模型回显提示词标记；带工具 grant 的其他崩溃窗口仍由本地受控 Provider 和进程级测试界定。

新 `independent_turn_v2` 的 `followup_task` 在来源 Run 有效时受理，来源事务为目标新 turn 预留有限模型请求、输入／输出 token、Artifact、turn 和并发资金；Tool 次数以明确标记排除累计数值上界。目标 Run 从实际启动独立计时 30 分钟，并用原角色 grant 与现行 Policy／Catalog 交集构造可用工具，不能从邮件或父级授权扩大工具面。来源 Run 完成不撤销已受理的备付和目标执行资格；目标终态、来源资金结算与一次性 reply 仍按准确 submission 链接。缺少 v2 标记的既有 `followup_task` 继续按旧单模型、零 Tool、原期限的 v1 grant 恢复。上文提及的零 Tool Surface、首模型替换与“原期限到期”窗口仅描述该 v1 路径；v2 在目标新 Run 的有限预留内逐次派发模型与角色允许的工具。

恢复时，v2 只有在来源备付、目标 Run／grant、已提交的派发事实与原角色上界均可核时继续；确定未派发的失败从来源事务释放备付，已尝试而结果不明的模型或工具保持 unknown，不以恢复重派。初始 child 首轮若已持久激活且父派发 ACK 已提交，Service 经 Store 执行权隔离旧 owner 后，核对原 grant 身份与激活时有效性、父 `dispatch_started` 预留、子 Run 自身期限及零模型／工具尝试，才沿同一 Run 继续首模型；历史 grant 不进入新的 Provider start 或重新消费。未激活的受理仍要求原启动 grant 在 5 分钟内有效。定向验证见 [首轮恢复分类](../test/child-first-turn-recovery.test.ts)、[恢复规划](../test/child-session-recovery.test.ts) 与 [真实 Store／Host 组合](../test/isolated/child-session-orchestrator-integration.test.ts)；真实 SIGKILL 跨过 5 分钟的窗口尚未单独实跑。

已受理的 TriggerTurn 若仍无目标路由、Run 或模型派发，可由来源资金事务按持久 admission 与当前状态证据释放后备预算，并记录 `tool_failed`、`expired`、`context_unavailable`、`authorization_changed`、`capacity_timeout` 或原 Run 用户取消的 `source_cancelled`；重复恢复读取原结算事实。用户取消的释放原因与原取消事务一起提交，不重复释放预算；正式入口在取消命令提交后调度未通知回执扫描，投递失败仍由持久索引在启动时恢复。Store 验证各原因，Service 回归验证来源授权变化、取消和准备后过期均未派发目标模型。容量不足时，来源备付先以 `queued` 锁定有限计数但不占活动子位；Service 等待原资金 Run 的持久 revision，取得执行位后提交 `resource_budget.child_slot_acquired`，才启动目标新轮。`capacity_timeout` 只在原受理时间加有界等待已到、槽仍满、备付仍 queued 且无目标路由或派发时同事务释放；正式 App Server 定向回归覆盖有位后启动一个续轮和满位超时零目标 Provider 请求。已派发或结果未知的路径不得使用预派发释放。

`list_agents` 和 `wait_agent` 从直接子 Session 血缘、当前 Run 邮箱水位及已有续轮的来源资金终态收据提供只读观察。正式 App Server 回归已验证模型 Surface、未读立即唤醒、超时不取消及非直系目标拒绝；续轮终态的来源只读端口另验证 completed／unknown 不会被误当成首轮结果，ACK 不推进父 State revision 时仍通过收据计数让等待返回 `agent_update`。这两个工具不消费邮件、不开启目标 Run。

正式 `start_turn` 在命令事务保存实际准入的模型 provider/name，包括未显式传 `model` 而采用当前默认配置的情况。来源续轮策略从当前 Run 的配置取上下文与输出上界，并核对该持久路由；下一轮显式切换模型不能沿用建桥时旧模型的上界。旧会话不因只读回放被补写模型路由，缺少可信路由的旧活动 Run 不能取得 D3 续轮授权。

主模型首次准备时，即使 Workspace 的可搜索 MCP／Skill 目录为空，Service 仍从该次可信目录快照计算确定 revision，并通过已有 `capability.bindings_issued` 的空 bindings／disclosures／loadedCapabilities 事实保存它；后续相同目录不重复提交。旧 State 的空 revision 仍可原样回放，只有再次准备模型并观察真实目录后才取得新的目录证据；D3 来源授权继续要求非空且与当前 State 相符的 revision。

## Workspace、Trust 与 routing

Store-only Session 投影保留 State 已持久化的 canonicalWorkspaceDigest 为安全的 workspaceDigest；桌面以其与当前 Trust identity 匹配目录，Protocol 仍排除原始 workspace 路径。目录显示名由已有 Session row 经安全文本投影，不另建项目或会话索引。

活动 Bridge 和 Store-only 投影必须从同一持久 State 输出相同 workspaceDigest，避免恢复时产生同 revision 的投影漂移。文件变更事件仅投影已提交工具事实中的有界 path，差异正文复用 tool.finished 的已保存输出；不新增 Git 或 Store 读取入口。

Service neutral boot不解析请求Workspace的config/MCP/Skill或启动Workspace runtime。第一阶段，authenticated App Control
Trust query/decision重新canonicalize path，使用observed revision CAS并返回完整`canonicalPath + projectId +
workspaceDigest`。第二阶段，carrier仅为trusted identity签发one-shot ticket并建立connection admission。

create command中的wire Workspace不可信，由connection admission替换。resume/query/subscribe/fork读取唯一Store中的
persisted Session identity并与connection Workspace交叉校验；lazy `workspaceTemplateFor`只在Trust/admission后解析
Service-owned config、model route、MCP、Skill、Sandbox/Shell与checkpoint inputs。process-wide session list仍来自唯一
Store，不建立第二reader/writer authority。该Store-only list/startup hydration已持有完整Runtime State snapshot，因此直接
投影同revision的完整interaction queue与唯一focus；它不得用空queue占位，也不得为了恢复pending interaction启动
Workspace context、MCP或Skill扫描。

独立子 Session 的实时详情只接受 `child_session` 父作用域订阅：Service 用持久父子血缘和当前 connection 的工作区身份核验两个 ID，Server 再映射到内部子 Session 事件流。普通子 ID 的 query、History 与 `session` 订阅继续拒绝。父作用域订阅的初始投影和后续通知只读，不取得子 Session 的执行或交互权。

Store-only批量投影按Session隔离当前格式的不兼容snapshot：单个`invalid_configuration`会话保持原Store与History可读，
但不进入Host预热列表，不能阻断其他会话投影或新会话创建；非该类Store错误仍整体失败。已知的旧后台结果若缺少后来新增的
admission revision，State codec只丢弃这条无法验证的background authority，不补造revision，其他会话State与历史保持不变。
回归见[多工作区集成](../test/isolated/runtime-server-multi-workspace.test.ts)与
[Kernel codec](../../../packages/agent-kernel/test/agent-kernel.test.ts)。

当前默认 App Server 的首轮惰性准入由同一 Service composition 持有：Store、Host、Server 和 App Control 可在 Provider 未配置时就绪；`workspaceTemplateFor` 直到首个需要 Runtime context 的请求才调用 `runtimeInputsFor` 并等待 MCP readiness。它不创建第二个配置专用执行 owner 或占位 executor，未完成配置的 Runtime 请求保持 unavailable。旧单 Workspace Worker 只属于非默认保留布局。

## App Control、History 与 mutation

本机 App Server 的 `set_interaction_mode` 从同一 Storage owner 读取目标 Session 的持久 workspace、projectId 与 canonicalWorkspaceDigest，重新查询该工作区 Trust 并比对完整身份；不从客户端目录、当前执行项目或显示路径推导授权。通过后进入同一 Host 的权限命令事务，不重启服务或停止其他 Session。未知会话、未信任或身份漂移仍拒绝；目标目录在信任查询时消失、Trust 损坏或不可用使用协议已有的 `internal_error + temporarily_unavailable` 详情。该命令不授予跨项目创建或启动 Turn 的权限。回归见 [App Server process](../test/isolated/app-server-process.test.ts) 与 [Desktop navigation](../../kite-desktop/test/navigation.test.ts)。

权限设置与执行准备分离。本进程已有 coordinator 时，仍由其持有的 State、execution fence 和提交后事件队列更新，运行中的工具继续观察同一份策略。没有本地 coordinator 时，直接用持久 State 构造一次性的 `StateRuntimeSession`，复用 `commitInteractionModeCommand`，不加载 Workspace 配置、模型、MCP 或完整 Runtime，也不调用 recovery。该实例不进入 registry，不取得 Run 写入能力；SQLite 的 `commitUnownedDecision` 在 BEGIN IMMEDIATE 内检查 authority 为 idle 或 recovery_required、Session revision 未变化，再提交同一事件／State／回执事务。active、detached（含尚未显式 fencing 的过期租约）返回 runtime_busy，避免覆盖其他执行者的内存 State。

冷会话的权限事务不修改 execution generation、cleanup、Effect 或 Run 记录。切到 Full 继续复用 Kernel 对尚未 dispatch 且符合条件的审批记录的模式规则，但不会因此启动执行或确认历史副作用；仍需恢复的任务继续走显式恢复。提交后使用决定的确切 State 发布权限事件，再由 Host 刷新 Store 投影。每次设置都读取最新持久 revision，独立进程同时提交同一 commandId 时从已提交回执确认重放，不重试业务写入。若会话在检查后被其他进程删除，返回明确的 session_not_found，不把未执行的修改报告为内部错误或未知结果。回归见 [多工作区集成](../test/isolated/runtime-server-multi-workspace.test.ts)、[Store 原子边界](../../../packages/runtime-storage-sqlite/test/isolated/kite-session-runtime-storage.test.ts)。

若本进程已丢失执行租约但 registry 中仍有旧 coordinator，权限命令继续沿受 fence 保护的原路径拒绝，不把旧 State 与一次性设置实例并列写入。重新启动服务后才能采用没有本地 coordinator 的设置路径；任务恢复要求仍保留。本轮不引入失效 coordinator 自动淘汰或跨进程命令转发。冷 Full 可以把符合条件的待审批工具改为 authorized_queued，但原 waiting Run 仍保留；resume_session 不自动续跑该队列，新 start_turn 通过既有 eventsForSupersededTurnRecovery 取消被替代的未结束工具。当前不承诺“冷 Full 后自动恢复旧队列并恰好执行一次”，该链路未经过端到端验证。[租约丢失回归](../test/isolated/runtime-server-multi-workspace.test.ts)验证拒绝后 State 与 recovery facts 均不变。

设置交互模式仍校验 Session 与 expectedRevision；目标模式已生效时，在原有命令事务提交 snapshot 回执，不新增模式事件或推进 revision，不能把客户端确认当前权限当作内部故障。实际改变模式才写入 `interaction_mode.changed`。验证见 [coordinator 命令回归](../test/runtime/runtime-session-coordinator.test.ts)。

[计划正文 projector](../src/runtime-client/plan-review.ts)从已保存的计划正文与步骤生成脱敏、有界的 review。实时交互与历史事件复用同一函数；Contract/Protocol 严格校验 text/truncated，交互结算继续绑定计划 identity 与 Session revision。超限明确标记，不暴露 Artifact/Store 句柄。验证见[计划正文测试](../test/runtime-plan-review.test.ts)。

`KiteInProcessAppControlComposition` 只表示Service内部handler composition，不是CLI embedded mode。Workspace Trust、
Provider/model、MCP、Skill、execution/release与Native credential均有exact route/codec；secret只进入Native credential
owner，browser-safe App Contract不携带secret。Trust query另投影Workspace关联的历史exact external-read roots与digest；开发期Native Shell读取可见性由Service composition选择的broad read scope决定，封存生产仍使用这些exact roots；
Provider 设置中的显式默认选择即使返回 `already_selected` 也重新读取当前配置；未绑定 route 的 Session 更新默认配置，已绑定 Session 则重新解析自己的 route，避免同名模型替换凭据或地址后继续使用旧配置，也不能借默认选择覆盖其模型。Composer 选择通过 `create_session.model` 或下一次 `start_turn.model` 绑定并原子持久化到对应 Session；恢复优先使用该 route，不能被同一 Workspace 的其他 Session 覆盖。活动执行始终保持开始时捕获的配置。
[Service composition](../src/composition.ts)把 App Control `runtimeInputsFor` 的 `resolveModelConfig` 一并传入 Workspace template，恢复持久 Session 和显式选择模型均通过同一配置 owner 解析完整路由；不能把当前默认配置当成唯一可用模型。[组合回归](../test/composition.test.ts)核对非默认模型创建、重启恢复、后续切换及会话隔离。

[事件投影](../src/runtime-client/event-projector.ts)在 `run.error` 的通用 `blocked` outcome 下保留已分类 failure kind，例如 `provider_auth_required`，同时保留 outcome 的重试与恢复约束；不公开原始错误文本。[事件投影回归](../test/runtime-client-event-projector.test.ts)核对安全分类和策略不被覆盖。

decision经revision/scope CAS后才允许Runtime连接；封存生产native sandbox的exact只读投影仍核对scope identity drift。开发期Native Shell的broad read不由Workspace Trust生成新的外部root或Full authority。
Runtime approval projector保留用户当前要批准的有界原始command；策略summary不能替代command。cwd、binding digest、
grant subject与Host内部payload仍不进入client interaction。
用户拒绝的`approval.rejected`只结算interaction，不投影匿名“command not run”正文；配对`tool.rejected`作为独立durable fact
投影，由terminal presentation复用queued Tool的安全名称与参数渲染未执行卡片。同一interaction command还原子取消当前turn
所有未终结sibling并写入`turn.aborted(cause=user)`，提交后才传播AbortSignal。
公开interaction的`sessionRevision`是本次projection的当前Host CAS；`interactionId`及kind-specific
generation/plan digest/provider revision/verification revision/input和有界command组成稳定身份。无关State event推进revision
时，Service可在相同稳定身份上重新投影当前CAS；Client必须先取得该新projection。Host一旦接受
`respond_interaction(expectedRevision=N)`进入inspect，后续commit仍固定使用N；inspect与commit之间State变为N+1时
必须冲突，不能在commit时暗中rebase。activeTurn与queue中的重复interaction字段必须完整身份相等，不只比较ID/revision。

pending interaction的settlement owner不是进程内waiter。Service重启并`resume_session`后，bridge从durable State重建
effect、active work与Turn continuation；合法response与receipt原子提交后，Host把`respond_interaction`作为同一Turn的
single-use prepared execution重新调度。旧broker waiter只服务仍存活进程，disconnect或process death不使持久approval
变成不可执行UI，也不能造成重复grant或重复Tool dispatch。每个durable event notification使用该event revision的真实
post-event State投影完整queue；无法取得exact State时返回unavailable/不发布，绝不制造权威空queue。
该规则同样覆盖manual compaction：command intent与effect terminal都通过Coordinator记录各自post-event State后才发布；
不得直接写Session再让Bridge用batch最终State投影早期revision，否则activation必须fail closed且不能调度compaction。

保留的 Store8 Run capability 被实际组合时，start planner把同一个canonical `turnId`交给Host transaction作为Run identity；queued Run、original
resource receipt和State decision共同提交。bridge activation先调用Coordinator的queued→running transition，再发布notification或交给
Host schedule。interaction request/settlement、terminal/cancel/recovery仍穿过State event transaction，并由Host派生同一Run transition。
Start Turn整批presentation notification以及该accepted Run后续的model/tool/subagent/interaction/terminal通知都携带admission确认的`runId/taskId/turnId`；首条`user.message_appended`不从
`turn.started`之前的predecessor snapshot取Turn，取消事务或Turn终态后的迟到Subagent/Tool cleanup也不从settled snapshot反推Turn。无active/unknown Run的启动hydration分页读取最近settled Run，保持重启后的
`currentRun`与late-stream fence；该读取不写Store或触发recovery。

若进程在 `start_turn` 的 Run 激活后、执行器调度前退出，取得上一代执行的 fencing 与清理证据后，Service 仅在当前 Turn 的完整日志证明没有模型、工具、交互或其他派发事实时补记中断终态，并将 Run 结算为失败。原命令回执保留可查，重放不再次派发；存在旧全局 Provider 准入等待时仍按其独立的可续跑证明处理。
保留的 Store8 composition 提供 private canonical Run port；当前默认 App Server 的 Run 查询以 Session Store owner 为准。Public Agent API 不因旧 capability 存在而发布该能力，不能用内存activeWork补写Run或降级为partial查询。

History由Service-owned exhaustive raw-event projector与SQLite log query生成closed session/event/transcript DTO；Plan submit必须从
active PlanDocument携带的exact Artifact ref读取正文，不得伪造空path或零byteLength ref。未持久化名称的Session在
History与Agent API中复用同一safe-text规则，从首条用户消息派生最多80字符的只读展示标题，不写入第二份状态。carrier与
CLI只能取得`RuntimeHistoryClient`，不能取得Store path、writer或raw event。App Control与Runtime mutation共享operation
gate；`outcome_unknown`后只允许exact query与用户显式决定，不自动重放mutation。
当前格式且无需兼容发现的普通 History 列表直接读取 Store keyset 的请求页，仅为该页补齐展示标题；搜索按游标逐页筛选标题、Session ID 和完整首条消息，收齐请求页后停止，不持有全部候选结果。默认 App Server 将搜索投影交给固定只读子进程池；旧格式兼容发现仍按原语义合并。
保留的非默认 Workspace Worker 为每个旧 Agent API context 打开一条 read-only in-process Runtime Client/Server logical connection；该路径的 admission 只允许
initialize/query，并继续把persisted Session identity与当前Workspace交叉校验。Session page先从同一Store 8 connection取得bounded keyset
IDs，再以最多8并发query做page-local projection join；History只消费bounded safe `RuntimeHistoryClient` page，Checkpoint metadata消费
same-connection keyset port且preview仍走Runtime query。Agent adapter不取得Host/Store/SQLite concrete，也不复用这条connection执行command、
subscribe或recovery。

History在raw `turn.started`没有匹配`turn.completed/turn.aborted/run terminal`时返回`restart_required`。该标记只触发Client的
显式`resume_session`恢复尝试；若旧effect lease仍fence mutation，History保持只读，不能把本地展示结算冒充Server terminal。
History transcript的每个record还携带对应的Run/Task/Turn identity。持久顺序中先出现user message、后出现
`task.started/turn.started`时，reader只在该后续事实到达后回填此前待关联record；无法关联的旧格式记录使用稳定的
`legacy-*`迁移identity。Native TUI随后按与live notification相同的Accepted envelope校验消费，不能跳过identity fence。
显式daemon Browser的Model Context另从同一Store connection读取prepared event，并通过注入同一Artifact backend的Builtin reader验证
`model_surface`；read adapter只消费App-owned Model Context read port，不取得Artifact ref/backend或通用正文读取authority。
operation gate的quiesce线性化关闭新mutation admission后，Application在同一lease中合并gate临界区与Host
`SessionLifecycleSupervisor`投影的长生命周期Session operation；显式 daemon restart 的 if_idle 停止发现任一 active 都立即 resume 并返回 busy，不会等待active
Turn或退化成manager timeout。只有两者均idle才允许commit drain；signal owner shutdown仍通过cancel/drain进入draining。
动态MCP的raw `mcp__server__tool_hash`名称不得成为TUI card label；closed projector统一保留
`mcp_tool` category/`mcp:dynamic_tool` fallback label。若 admission 时已有 MCP capability descriptor，则其经过
bounded safe-text projection 的 `displayLabel` 可作为 card 的具体工具名；hashed/raw model binding name 仍不得进入 card 或 scrollback。

Live presentation在进入closed `RuntimeClientEvent` projector前统一经过Service-owned 50ms presentation frame。累计
reasoning/text在一帧内只投影最新值并固定按reasoning→text顺序发布，tool progress按`toolCallId + stream`有界合并；
durable事件、reasoning completion与Turn终结前必须先flush。Service-owned presentation frame与concrete
`CliRuntimeBridge`复用同一实现，因此InProcess/Service或不同carrier只能改变传输，不能改变TUI看到的事件粒度、顺序或
聚合语义。frame是active Turn owner；interaction、cancel、close与shutdown旁路在发布durable notification前也必须先
flush，不能让terminal越过仍在buffer中的reasoning/progress。
tool queue projector另把raw `modelMessageId`收窄为browser-safe `presentationGroupId`，与closed
`model.responded.messageId`配对。它只提供模型步骤聚合因果关系，不携带prompt、Provider handle、Kernel State或
execution authority；Service不得让TUI从事件相邻关系反推该归属。queued Shell 只有已携带 Runtime 的
`effectClass=read_only + sideEffect=false` 事实时才发布 `presentation=exploration`；缺失分类、写入或有副作用均保持
`standalone`，terminal event 不重新猜测命令语义。Builtin catalog中`kind=interrupt`或
`executionMechanism=user_input`的能力即使没有外部副作用也必须保持`standalone`；`ask_user`由Footer interaction拥有，不能进入
Thinking只读工具聚合。该判断使用admission时捕获的能力语义，不在TUI按工具名维护白名单。
Runtime已在`subagent.started` payload签发的`concurrencyGroupId`必须由Client Event projector原样收窄并保留，随后由
同一closed Contract与Protocol codec服务live订阅和History回放；不得丢弃该字段后让TUI按相邻child、名称或时间窗口猜测并发组。
正常child启动还须保留父task的`parentToolCallId`。child内部tool lifecycle由Runtime在queued时写入、并在terminal时从canonical tool state延续closed
`presentationOwner { subagentId, parentToolCallId }`；Client只据此隐藏顶层重复并把异常留在所属task过程，terminal-only replay也不得公开或解析
`runtimeToolCallId`的命名格式。旧 History 缺少 owner 时，由 Service 在本次读取的事件上界内，使用 capability invocation、child dispatch intent 的唯一身份关系补齐父工具归属；内部工具再按 subagent.step 与执行侧共用的工具身份计算核对。仅补展示 DTO，不改原事件、不读取上界之后的事实；缺证据或关联歧义时保留独立异常入口，不能按名称去重或隐藏。
`subagent.completed`的Runtime实测`toolCallCount/durationMs`同样必须保留；failed事件可保留这两个计量与
content-free `diagnostic.code/stage`，但必须删除`modelInvocationId`和raw provider/error correlation。
`subagent.tool_result`的可选summary只有非空时才进入closed Client Event；成功但无匹配内容的read/search结果省略该字段，不能
生成Contract拒绝的`summary: ""`、中断subscription，再让后续Esc误报`Invalid AcceptedPresentationEnvelope`。
Service的Subagent adapter必须显式向Builtin模型循环传入12轮工具响应上限。达到上限后下一次Provider请求使用空工具面并要求基于
已收集证据总结；返回正文则按正常child terminal继续父Run，若Provider仍伪造工具调用则按现有失败分类闭合child且不再调用模型。
该边界不依赖可选共享`resourceBudget`，并以continuation保存的`modelInvocationOrdinal`延续，审批暂停/恢复不得重新获得12轮。
并发Subagent的用户取消可以先发布可见`turn.aborted`，但执行generator仍拥有Session，直到每个durable Provider lifecycle都进入
`cleanup_completed(cleanupConfirmed=true)`。该窗口内Bridge拒绝后继`start_turn`为`runtime_busy`；同进程cleanup只补Provider
cleanup事实并保留取消事务的`capability.reconciliation_resolved(decision=waived)`，不得复用crash语义追加`capability.execution_unknown`。

Native Runtime admission 在 prepared command closure 中固定传递 authenticated `RuntimeCommandContext`（connection、request 与
opaque Controller binding reference）。App Server从每条command的已认证client/connection generation读取当前Session execution authority，
不把Controller Session固定到可能早于Controller创建的socket ticket。Worker application 的 effect composition 只接受已固定context，并由Store authority、Controller
generation 与 OS-user resource lease 共同完成 prepare/acquire/dispatch/terminal 或 `outcome_unknown`；context 不进入 Runtime
Protocol wire frame，也不向Browser REST projection暴露。

## 当前默认与非默认布局

默认 TUI/CLI 使用 parent-owned stdio App Server，显式 daemon 在同一 Service composition 上增加本机 endpoint 与只读 Browser `/v1`；二者使用 canonical Kite Home 的 Store14 Session 库。没有 CLI backend 副本、embedded fallback、双 Host/Store、通用 RPC 或独立 Browser Runtime。Browser 不取得 Controller 或 Runtime mutation 权限；remote/LAN 仍不支持。

Store6/7/8 的 adapter、旧 Workspace Worker 与离线迁移 primitive 只供明确选择的非默认布局及维护调用者使用，不是默认打开路径。Store6→7、Store7→8 仍要求相应的 source-bound fence、完整 generation 收敛和可核对布局；普通 Runtime Application 不静默回退或自动切换到旧 Store。旧布局的安全准入不能从默认 Store14 的存在推断为可省略。

## 验证

`bun test apps/kite-service/test/composition.test.ts apps/kite-service/test/bootstrap.test.ts apps/kite-service/test/runtime-application apps/kite-service/test/app-control apps/kite-service/test/runtime-history-client.test.ts apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts apps/kite-service/test/isolated/runtime-server-multi-client.test.ts`、
`bun run --cwd apps/kite-service typecheck`。

## 活动执行权续租

Session 写入口在核对当前执行权与有效期后，可使用同一 authority 的 CAS 续租；达到正常续租间隔时随实际写入进度续租，避免连续同步工具提交延后定时器而使活跃执行过期。模型等待等无写入阶段仍由原定时器续租。已过期、失去 generation 或属于其他 owner 的执行权不能借写入重新激活，仍需恢复处理；不延长默认租约或新增后台协调进程。

续租失败时在 Server stderr 记录 Session、失败原因或租约失效时间，便于区分定时器延后与存储/执行权错误；不污染 stdio protocol 的 stdout。

执行权失效由原Storage owner通知同一Host停止本地执行，不另设执行登记或后台协调器。取消监听器即使无法持久化也必须继续传播Provider停止信号；只发布成功提交的终态事件，持久恢复记录不会因本地I/O关闭而被伪装成已完成。

Daemon lifecycle status 直接读取 Application activeOperations（gate 临界区或 Host 活动 Session），不维护额外计数。接受 shutdown 后仍由同一 quiesce lease 管理取消和 drain，状态查询不会取得 lease。

History 可按已观察的 `throughSequence` 重建历史前缀，模式、恢复与展示身份都来自该前缀。stdio carrier 将该只读结果按完整 source record 分页，每页最多 512 条并预留协议封装字节；不拆分事件正文、不持久化分页状态。默认 App Server 由固定子进程池读取并在内容代次不变时复用有界投影；非默认或注入的完整历史 owner 仍可能在每页请求内重建前缀。客户端最终 transcript 也受独立记录数和字节预算约束。


主工具的自动审批请求与完成通过 [event projector](../src/runtime-client/event-projector.ts) 映射为 `tool.review`，只保留 tool/review 身份、封闭状态及现有 safe-text 处理过的原因；人工批准携带明确 grant。审查异常或显式升级转人工，不投影成拒绝。Contract 与 Protocol codec/mapper 必须同时允许这些展示字段，历史与订阅使用同一投影；不改变 Kernel 的授权、调度或模型结果。

## 按需恢复与多空间宿主

同一本机 App Server 对已有会话按持久 canonical workspace identity 核对信任并路由；新会话请求显式 workspace，由服务规范化和验证授权。App Control 按请求所属的已验证 workspace 选择配置引用，不以进程启动目录代表全部空间。Electron 重接仅替换连接代次；一个 Service、Store、Host 持续管理所有空间，不增加进程池。

Service 提供只读 get_session_recovery，摘要来自 authority/effect facts，最多返回 20 个待核对 effect identity。recover_session 绑定业务与 authority revision；有效执行者、未确认清理或未决/未知 effect 不能被接管。仅确认安全时原子保存恢复回执并回到 idle。get_command_receipt 查询原命令结果，不重放操作。失权而仍有本地 coordinator 时，权限设置返回 session_cleanup_pending，不能调用正在关闭的 Runtime。验证见[多空间与恢复](../test/isolated/runtime-server-multi-workspace.test.ts)、[原生 Service 进程](../test/isolated/app-server-process.test.ts)。

Ask 的实时交互与请求历史都投影 toolCallId；回答事件将现有 answers 映射为有界脱敏文本。客户端据问题选项恢复文案，不把执行结果包装 JSON 作为问答历史。


## 可选能力与旧全局准入

模型调用前不再枚举并阻塞全部 required MCP。真实 MCP 工具、资源和 Provider Action 仍在实际使用时检查绑定、认证、项目批准及权限；`mcpProviderAction` 保留这些操作消费者，不再产生全局 admission。

`resume_session` 在已持有合法执行 scope、Coordinator 空闲且原 Run 为 waiting 时，可读取完整 journal，确认同一活动 Turn 的等待来自支持的 State26/State27 全局准入写入路径。当前 Turn 已有模型准备、工具、未知 capability/effect、未决审批或清理时不结算。真实 `awaiting_provider_action` 不属于该路径。

匹配时，Service 通过 Coordinator 的 `commitObsoleteAdmissionResumeCommand` 记录事件对应的 revision/State，再由 `commitCommandBatch` 结算 `provider.admission_cancelled`，原 State、Run waiting→running 与 command receipt 由 Host/Store 一次提交；随后沿原交互 continuation 执行，不重新发送用户消息，不写用户 waiver。查询和历史订阅不触发该修复。

结算已提交但派发前崩溃时，同 commandId 的回执重放先取得 Session execution owner，再经 Bridge 的 `recoverCommittedResume` 重新核对完整 journal、当前 revision 与原 Run 身份；只有无模型准备、尝试、工具或其他副作用证据且无本地活动执行时，Host 才调度同一 Turn。模型网关在出站前持久记录 `model.invocation_prepared`、`model.invocation_attempt_started` 和 `model.requested`，因此一旦出现这些事实，回执只重放结果，不重做模型调用。不同 commandId 也必须通过相同分类条件。真实 Store 8 与 Host 的崩溃、并发和拒绝重放验证见[Coordinator 测试](../test/runtime/runtime-session-coordinator.test.ts)；恢复的权限边界见 [Agent Note 0188](../../../.agents/notes/implemented/simplification/2026-09-16-on-demand-capabilities-and-filesystem-owner.md)。

恢复派发使用本次请求经认证并冻结的 `commandContext`，沿 Host replay、Service wrapper 和 continuation 传递到工具执行。并发同 commandId 的请求各自持有自己的上下文，不从旧回执恢复连接绑定，也不把上下文写入持久回执。Worker 工具组合仍重新核验本次 binding 与有效控制权；缺失或失效时拒绝执行。

### 执行命令时的失效执行收尾

Service 的会话投影查询、历史读取及订阅只读取持久事实并刷新 Host 观察水位，不调用 `reconcileInterruptedSession`。执行命令在 mutation admission 内对目标会话触发该恢复：先保留有效租约的执行；失效执行经 Store CAS 隔离后取得受控恢复 scope，调用 `reconcileRuntimeSessionAfterRestart` 核对 Provider／沙箱资源，在持有当前代际时追加工具、子 Agent、Turn 的收尾事实，由同一 State 事务更新 Run。未知外部结果保留，调度与完成门禁按当前轮归属判断，不能因 Task 跨轮复用而阻塞新消息。

恢复事件在创建后继 Run 前按旧 Run 身份完成投影；不能延迟到新轮激活时给旧 revision 配上新 runId。同一会话的恢复请求共享进行中的 Promise，重复执行命令访问已收尾会话不追加相同事件。清理失败后仍返回可读历史及持久恢复状态；执行请求保留明确失败，不能把检查失败当作清理成功。回归见[重新进入故障测试](../test/isolated/session-reentry-recovery.test.ts)。

终态会话同样核对有持久证据的历史子 Agent 悬挂卡片：先从 State 筛选失败终态父工具与已确认清理的 Provider lifecycle，再读取事件验证唯一 childInvocationId 的 started 尚无 terminal。存在候选时不走 idle／settled authority 的提前返回，而进入相同恢复 writer 追加终态；已失败的旧 Task 不受当前 Task 过滤。成功父工具还必须同时匹配同一 invocation 的 completed observation、attempt／dispatch digest 一致的 cleanup、execution_succeeded 和成功 tool.finished，才补记 subagent.completed；子执行已有 completed observation 但父工具随后失败／取消、完整成功证据不足时保持待核验，不补写失败；身份歧义、未确认子执行清理及有效 owner 不被此规则改写。子 Agent 已有确证的终态在 Provider 核对后即提交，不因其他沙箱清理失败而延后；最终恢复仍保留清理失败，并使用已追加事实避免重复终态。

并行子 Agent 每个 sibling 返回时，Service 即等待其尚未提交的子任务／父工具终态持久化，再等待整批结束；成功写入的事实不重复返回给聚合提交。持久化失败向执行 owner 传播，不能合成为工具执行失败。验证见[并行终态提交测试](../test/isolated/runtime/sibling-terminal-persistence.test.ts)。

会话投影查询统一经过 Host 发布最新持久投影，包括执行命令恢复失败后从 Store 读取的结果。订阅注册后，初始边界查询及后续只读查询得到的新 revision 必须同时进入该订阅，避免 Store 水位已经推进、客户端却永远收不到对应 ready。该发布只同步观察状态，不取得执行权。


主执行停止原因沿 AbortSignal 显式传递：只有主动取消命令使用 user，Host 关闭、租约丢失、执行错误及截止时间使用 error；未分类信号按中断处理，不通过错误文案猜测用户意图。Provider observation 保留 interrupted，避免丢失子终态后恢复时将中断误判为失败。取消收尾覆盖已暂停的子任务；同一子执行已有终态不重复追加，清理未确认不伪造取消成功。

子 Agent 生命周期沿现有持久事件传递：派发意图与带 `status: creating` 的 `subagent.started` 在同一批次保存，实际开始／恢复的 started 为 running。`subagent.failed` 的可选 status 区分 failed、interrupted、cancelled，旧 payload 仍可读取；服务投影把旧的明确 aborted／timed_out 诊断分类为 interrupted，不猜测取消。创建失败也在确认准备资源收尾后提供子任务终态，避免卡在 creating。

后台 child 不保留父工具 effect 的短生命周期写端口。模型 lifecycle、descendant 预算 reservation／reconciliation、完成 Artifact 引用与 after-turn 事实通过原 Session mailbox 提交给发起时的 exact coordinator，并同时核对 coordinator 对象、recovery identity、bridge close 与 lifecycle fence；前台 child 仍使用原 effect-scoped persistence。该路径只复用现有 Session writer，不建立第二个事件 authority。

阶段 D0 的目标边界由[后台 Agent 与 Shell 会话协调方案 §4.0](../../../docs/plans/background-agent-shell-conversation-coordination.md)定义：每个子 Agent 有独立的持久 Session、State revision、模型上下文和执行 owner。上一段描述当前 A–C 后台 task 路径，不构成阶段 D 的共享 Session 设计依据。父 Tool 在父 Session 事务中持久受理确定性创建意图、原 Run 的 required 义务和工具回执；Service 凭该意图幂等创建隐藏的子 Session，子执行只写子 Session。子终态先在子 Session 提交结果 Artifact 与终态封存；Service 桥接器核对准确父 Run／Turn／Tool attempt 后，另在父 Session 的事务中一次性接纳结果、解除原义务并记录回执。父提交成功而确认丢失时重放已有回执，不能再次执行子任务或重复注入结果。父级普通 Provider 重启清理跳过有独立 `childSession` 的 lifecycle；该子线程由自己的 execution generation 恢复。已持久化外部尝试而清理不能确认时，子恢复 writer 先写 unknown Run 与结果封存，以 `cleanupConfirmed=false` 释放 owner，再由父事务交付一次具名 unknown 结果并保留预算 unknown。Service 的私有读端口按准确父子血缘提供 `task_read` 和事件驱动 `task_wait`，并将独立子任务与旧进程目录合并投影；活动子执行的 `task_cancel` 传递用户取消，历史上已受理但尚未外部派发的 queued 子任务使用 `subagent.child_pre_dispatch_cancelled` 与准确预算释放结算为取消；已派发但清理或用量不能确认时保留 unknown，不把用户取消伪装为创建失败。直接 Store／Host 集成已验证这些窗口；[三子线程集成回归](../test/isolated/three-independent-child-sessions.test.ts)还验证同时恢复、交错完成、模型上下文与结果隔离及重复恢复幂等。现行 Store14 App Server 的正式入口已接入上述私有派发；[正式入口回归](../test/isolated/runtime-server-independent-child-session.test.ts)验证父 Tool 受理、独立子 Session 创建、自然完成和用户停止后的一次性父结果。Agent 通信的现行入口及 `current_turn` 限制见上文 D3 段落。

父模型后续轮次的历史 `task` 调用由 Model Controller 按准确原模型 invocation／工具调用身份读取 private request Artifact，仅在模型上下文中恢复公开参数；预算预检与压缩使用相同投影。新模型调用若把内部引用当作输入，按 `invalid_arguments` 生成脱敏工具失败，不将其误判为 Artifact 存储不可用或让整个 Run 因此异常终止。定向回归见[模型控制器失败测试](../test/runtime/model-controller-failures.test.ts)。

独立子 Session 的父 Tool 回执必须由活动 Run 预算承接。Service 在 staging 时检查父预算；未配置时返回具名失败，不保存待接纳 child，也不会在 Tool 终态提交时将这次未派发操作误记为未知结果。开发版需在配置中显式启用 `resourceBudget` 与 `boundedCancellation` 才可验证后台派发。

新 Run 将 `resources.maxConcurrentSubagents` 写入持久预算，未配置时默认 3；当前公开配置限制为 1–28，以保证固定 30 次父级 turn 预算可为每个新子任务分出正额度。同一模型响应中的兼容 `task` 均尝试派发。Service 在产生成功的父工具回执前计入已受理子任务和本批待提交请求；达到子 Agent 上限、有限预算无法分出正额度，或 `code` 子任务达到保留的写者额度时，立即返回失败，不创建 child intent、Session 或 queued allotment。已受理子 Session 立即登记到本机执行租约续约 owner，避免激活前租约过期。历史 queued 委派保留 `resource_budget.child_slot_acquired` 与取消恢复语义；已过期的未派发旧子执行须先隔离其 generation 并证明没有模型／工具尝试，才能结算父 claim。子 Run 创建时原子保存 `origin_session_id`／`origin_run_id`，Store 对照已接纳的父子意图核验两个来源字段；跨 Session QueueOnly 邮件据此识别被授权的子来源。Store11→12 候选转换保留旧 Session ID、Event 和 History 的原样回放；新来源字段只在转换后新建的已授权子 Run 上写入，不为旧 Run 推断父来源或补授跨 Session 邮件权限。正式入口回归覆盖三子同时启动、错峰完成及单子本地失败；独立子工具审批的在线代理行为按上文边界交付。

独立子 Session 的恢复扫描现在先计划并在现有每 Session 工作队列中有界启动，父会话入口不等待子模型完成。无法安全收敛的单个子任务只向父 State 写入带准确意图身份的非终态 `subagent.child_recovery_required` 诊断；`task_read`／`task_wait` 将其读作需恢复，后台卡片显示不可用，原 required claim、预算和健康兄弟任务保持不变。直接 Store／Host 回归已验证该诊断和同时恢复；正式 App Server 入口已调度该扫描，并在既有每 Session 队列中处理恢复。正式 App Server 进程崩溃重启回归已验证自动扫描、子模型在途时父查询响应和一次父结果导入；父模型收到准确具名 `<subagent_result>` 后恰好一次完成原 Run 的崩溃重启验收已通过；子模型和父续轮均无重复请求。

父 Run 已由用户取消、原 child allotment 已释放但仍有未结算的 required child 时，恢复扫描仅对无 dispatch ACK、无预算激活且 revision 0 无模型／工具尝试的准确子 Session 规划取消善后。Service 先隔离过期子执行代际并确认 idle 清理，再通过 Host 的两事件路径提交取消结果；不重复释放预算，也不恢复已取消的父 Run。Service 从原 Run 的持久取消状态与 `turn.aborted(cause=user)` 事件核对，不依赖当前 turn；Store 在同一事务重验原 Run 取消、原用户取消事件、原释放与无派发子证明，即使会话已开始新一轮也能结算，不足则保留 `recovery_required`。续轮审批代理的父 Tool 身份由 [Host storage codec](../../../packages/runtime-host/src/storage/followup-child-approval-identity.ts) 解析，Service 不从 SQLite Store 包读取运行时解析权威。对应验证为 [恢复规划](../test/child-session-recovery.test.ts)、[结算辅助](../test/isolated/child-creation-failure.test.ts)、[Store CAS](../../../packages/runtime-storage-sqlite/test/kite-child-session-intents.test.ts)及[真实 Store／Host 恢复](../test/isolated/child-session-orchestrator-integration.test.ts)。

ACK 前的恢复仅在父资金 Run 的准确委派预留仍为 `reserved`、且 Store 可证明子线程尚未外部派发时，将已结束父 Run 或过期授权的子任务结算为具名启动失败；已有 ACK、预算 unknown 或证据变化继续保留需恢复诊断。D0 首发验收针对默认 Store12 App Server；旧 Store8 Workspace Worker 位于默认发布路径之外，仍使用其保留的子任务路径，不通过可选 owner 接口伪装为 Store11 子线程执行。

原 D0 验收门禁曾把 `agentMailboxAvailable` 设为 false，以隔离子 Session 派发与后续 Agent 邮箱接线。现行 Store14 App Server 已在正式入口接入独立子 Session、根邮箱命令／模型输入与子 Agent 注册；背景 watcher 继续经 A–C 的结果路径结算。`createKiteSessionAppServerStorageComposition` 的启动准备已恢复已验证旧格式的备份、候选转换和发布；合成 Store10 会话经正常启动后保留原 ID，Runtime History 的事件与记录顺序不变。

子 Session 仅可由父 Agent 树或经父子血缘授权的详情入口读取，不进入 Workspace/Space 顶层会话列表、最近会话、搜索或分页。现行 Store14 及可迁移的旧 Store 候选目录、History 和旧列表已在排序、游标与 LIMIT 之前过滤内部 Session；Service 的普通顶层 admission 也拒绝已知子 Session ID。现行 Store 的 `listChildSessions`／`readChildSession` 与逐页核验的子 History 端口已接入显式父树查询；普通读取继续拒绝。TUI 与 Desktop 已接入父作用域子会话只读入口，Web 仍按现有只读观察范围运行。

`auto_review.requested` 表示进入自动审批队列；执行器选中该审批并验证输入后，必须先确认 `auto_review.started` 持久化，再调用 reviewer。该事实只记录阶段，不授予权限或改变审批结果。审批模型请求必须接入当前主执行的停止信号；停止后不再派发请求或提交迟到的审批完成事件。客户端 review queued 对应等待，reviewing 对应自动审批中；审批返回之后仍须等真正的子任务恢复事实才能显示运行中。父工具状态与子任务状态分别维护，不能用父工具取消推断子任务已经停止。
