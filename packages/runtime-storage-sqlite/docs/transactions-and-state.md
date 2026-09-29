# 数据对象与事务提交

入口：[Session storage owner](../src/kite-session-runtime-storage.ts)、[mutation](../src/kite-session-mutation.ts)、[schema](../src/kite-home-store.ts)、[run store](../src/run-store.ts)。名称含 kite-home 的底层文件仍有当前消费者，不等于旧 single-Service 拓扑仍有效。

## 数据关系

| 数据 | 作用 | 交接 |
| --- | --- | --- |
| Session / revision | 当前会话状态与并发版本 | Host 命令 expectedRevision |
| Event / snapshot | 可重放事实与读取加速状态 | Kernel event/state codec |
| Run | 排队、活动与终态执行索引 | Host storage port，API/查询投影 |
| command receipt | 已提交命令的幂等结果 | Host 重放前验证 digest 与 scope |
| execution authority / effect | writer 身份及外部操作状态 | App 获取，mutation/dispatch 校验 |
| Artifact / checkpoint | 大内容或恢复所需数据 | typed reader 与恢复入口 |
| Agent 身份／邮件 | 每个 Session 的 Agent 身份、来源 outbox、目标 inbox、私有正文与输入水位 | 来源与目标各自的受保护 Session 事务 |

表中 Agent 邮箱的模型工具仍未生产开放；Store11 物理格式已用于受保护的旧会话兼容转换。旧 Store10 会话转换后 `runtime_sessions.parent_session_id` 为 NULL，继续作为根会话按原 ID 展示；新建的 D0 子线程以准确父 ID 标记，在目录、搜索与分页前过滤。父 Tool 创建意图与 required claim 在父 Session，子创建回执、模型和终态在子 Session；两个 Session 的 revision、generation 和 effect lease 不共用。旧会话转换发布与 D0 子任务生产派发是两个独立门禁。

具体表定义以 schema 为准，此处不复制 SQL。目录或 API 返回值不是第二数据库 authority。

续轮子工具审批的父 Tool 身份由 [Host storage codec](../../runtime-host/src/storage/followup-child-approval-identity.ts) 编码与解析；Store 保留原公开函数作为兼容转发，Service 与 Store 使用同一 canonical 格式和字段上界。

## 写入过程

执行期间的 Session mutation 在 BEGIN IMMEDIATE 内重新读取 generation 与 Session revision，再执行变更。检查不能放在事务前，否则其他 SQLite writer 可以在检查后提交。无 Session、旧 revision 或失效 writer 必须失败，不覆盖较新状态。

storage owner 使用 AsyncLocalStorage 传递本次 execution handle。runWithExecution 绑定精确 handle，foreign/stale/缺少 execution scope 的写入拒绝；readSnapshot 不因此获取写权限。

App Server 的分页 History 子进程使用[只读连接工厂](../src/log-query.ts)打开当前 Session Store，先核验当前物理 schema，再在独立连接上以 `BEGIN` 固定 metadata、血缘与事件的读取快照，结束时提交或回滚并关闭连接。根查询不暴露 child Session；子查询要求准确的 `parent_session_id`，每个事件页重复核对。这个连接不共享 writer 的同步 `readSnapshot`，也不取得 execution handle 或写权限。

start 对应 Run、command receipt、事件与 State 的关联更新必须在所属事务一致提交；后续 activation、interaction、terminal 同步 Run 索引，不能绕过 Store writer 直接改查询投影。

### D0 子 Session 创建意图

父 `receipt_evidence` 事务中的 `childSessionIntent` 同批核对创建意图、`subagent.started` 角色、dispatch Artifact ref、独立委派预算 reservation 和 `tool.finished` 的 running／required claim。Store 私下读取不可变 Task Artifact，核对 canonical bytes、owner 四元组及独立的原始任务文本 digest。父接受事务还把有界的 sealed grant canonical JSON（最多 128 KiB UTF-8）、字节长度与 SHA-256 同写入私有意图行；Store 校验 grant 的通用父／子身份、角色、Artifact ref 和任务文本 digest，不代替 Builtin 的完整 grant 语义校验。Event 与普通意图 metadata 只包含 ref／digest，不返回 grant JSON。`child_session_intents` 以确定性 childThreadId 唯一保存父 Tool 终态 eventId／revision、角色、Artifact ref、委派上限与 funding deadline。其 receipt marker 为恢复索引，不代替父预算或 Kernel State。

`createChildSession` 在原有 Session／Controller／recovery receipt 同一 writer 事务内核对父意图和 Workspace/project、建立 `parent_session_id`；重放要求同一意图与原创建回执，冲突拒绝。revision 0 的子 State 须预绑定准确 `childSessionOrigin`、私有 Task Artifact ref 和 digest，预算仍为 unconfigured。首轮 `childBudgetActivation` 同批核对 adopted、Task input admitted、configured、turn.started、task.started 与准确子 Run insert，子预算与 deadline 不得超过持久委派上限；之后的模型／工具 dispatch 还要求父 `resource_budget.dispatch_started` ACK 和未结算的准确 child intent；`required` 要求活动父 Run，`after_turn` 允许原父 Run 已完成但仍在原 deadline 内继续执行。父创建永久失败有三个明确模式：子 Session 尚不存在；子 Session 已创建但仍为 revision 0、无 Run/Event/effect、无预算激活与 dispatch ACK；或子 Session 已激活为准确 revision 5／queued Run、但父 dispatch ACK 尚未提交、无外部尝试，且持久 execution owner 已释放为 idle／cleanupConfirmed。Store 在同一父结果事务内重验血缘、Workspace、snapshot、owner 与 mode 后 CAS 记录 failure digest；不删除已创建的内部子 Session，准确重放或冲突均按原行判断。取消后的子清理事实可继续落盘，新的外部 dispatch 拒绝。`after_turn` 的父受理事务同时预留子额度与一次自动汇报模型额度；重启时只保留已核对的 pending、同进程 live ACK 或子终态 seal 所需预留，缺失证明维持 unknown。

父 Run 因用户取消而已释放子预留时，仅 `required`、revision 0 且无任何 Event／Run／effect lease 的子 Session 可走无第二次 `resource_budget.released` 的预派发取消结算。Store 在相同父事务内复核原 Run 的 `cancelled` 状态、准确预留的 `released` 状态、唯一历史释放与 `cause=user` 的原 turn 取消 Event，以及子 Session 已释放的 idle／cleanupConfirmed owner；父快照的当前 turn 可以是后来新开的 Run，不作为旧取消的证明。缺少任一证明则拒绝。普通预派发失败仍须提交原三事件，不借此变体跳过预算结算。

`readChildSessionIntent` 和有界的 `listPendingChildSessionIntents(parentSessionId,limit,cursor)` 是无写入的内部恢复读口，返回准确身份和 ACK／结算 marker，不返回任务正文或 sealed grant JSON。读取私有 `readChildSealedGrant(childThreadId)` 必须处于准确父 Session 的活动执行或 recovery handle scope，再按父／子 ID 与字节 digest 复核。普通用户的 Session 列表与已知 ID 日志读取不经这些读口。根 Session 删除先取消本进程实际执行，Service 跟踪异步收尾；Store 在同一事务删除内部子树，并用元数据 revision 绑定根回执、保留各 Session tombstone。空间删除将所有目标会话纳入一次事务，不逐根调用 Host；跨范围引用和事务回滚仍保证数据一致性。数据删除不依赖执行权取得、历史恢复或 cleanup 确认，见[执行权与恢复](authority-and-recovery.md)。fork／rewind 与父 close 的完整跨线程语义仍需 D0 集成验收。

子线程的未确认外部尝试只可在 `beginRecoveryExecution` 取得的 fenced recovery generation 下封存为 `unknown/cleanupConfirmed=false`。Store 在同一子事务核对原父意图、dispatch ACK、准确子 Run 的 unknown 终态及已持久化的模型／工具尝试；普通执行 generation 无权写这类封存。子 owner 随后以 `cleanupConfirmed=false` 释放为 `recovery_required`，不把 Shell／Provider 清理推断为已完成。父结果导入再核对该 fenced authority、unknown Run 与原封存事件，并交付一次 required 结果；父委派额度若仍为 dispatch_started，同批写 `resource_budget.unknown`，若父恢复已将准确额度标为 unknown，则验证该旧事件与当前 ledger 后保持幂等。它只结算结果投递，不解除未知用量或外部副作用的恢复约束。

子恢复无法安全结算时，`subagent.child_recovery_required` 只能在父 `receipt_evidence` 单事件事务内写入。Store 重读准确待处理意图、父 State 链接与子 execution authority，拒绝已结算 claim、已封存子终态或仍有活动 owner；重复同一诊断不追加事件。诊断既不写 child terminal，也不释放委派预算或导入父结果。

Store12 新增来源 `agent_mail_outbox` 和目标 `agent_mail_inbox`，沿 `runtime_sessions.parent_session_id` 核对准确父子血缘、Workspace 与 project。持久 Store11 lineage 不含这两张表；Store11→12 在私有候选中补建空表及索引，并核对旧行未变。`QueueOnly` 的来源受理保存同一 Tool 命令回执、私有正文和可恢复的待投递身份；目标接收以消息 ID 幂等，受理时把目标准确活动 Run 作为可输入归属冻结，空闲目标保留 NULL 归属；目标接收复制该绑定，模型输入只可读取当前 Run 的非空归属，并单独标记目标 inbox 水位。正文只保存在来源 Session 的 `agent_mail_bodies`。Store owner 已将三个步骤绑定到各自受保护的 Session 事务并有焦点回归；正式 Service 的 `send_message` 已接入来源 Tool、目标 Event／inbox 与模型输入，在线及冷启动回归验证单次接收；该段跨 Session 设计边界已由 Store13 实施。自动审批拒绝删除未发布 Store11 的旧同 Session 表，因此旧 `agent_mail` 暂留且生产能力开关关闭。

Store12 在独立子 Agent Session 上增加私有 `child_approval_proxies`。Store11→12 只在带维护锁的私有候选副本中增加跨 Session mail 和代理表，并核对旧表内容 digest；Store9／10 来源先沿原转换链进入 Store11，再进入 Store12，原文件不被就地修改。代理请求从子 Session 同一 canonical `approval.requested` 事务核对 ACK 后的父子意图、子请求 Event 与持久待审批 State，按确定性代理 ID 保存父／子工具、grant digest、子交互 generation 和请求 revision。父回答必须与父 Session command receipt 同事务提交私有决定；子 Session 的 `approval.granted`／`approval.rejected` 同事务核对代理决定并记录应用 revision。表与读口仅供 Service 内部父作用域使用，不能据代理行把未确认的 Tool attempt 当作可重放工作。

Store13 将跨 Session `TriggerTurn` 与 `QueueOnly` 按 outbox mode 分开恢复。Store12→13 只转换带维护锁的私有候选副本，拒绝无法证明来源授权的旧 TriggerTurn 行，并核对旧表内容 digest；Store10/11 经既有转换链进入 Store13，原 Session ID、State/Event、History 保留。来源 Tool 的 `agent.mail_accepted`、备份预算 `resource_budget.reserved`、command receipt、正文与 followup admission Artifact 同一来源事务受理。Admission Artifact 封原 prepared Tool 的请求策略与身份；Store 核空 binding、invocation、arguments/schema/授权 digest、Tool attempt 与交互模式，供当前 Catalog 复分类。目标 TriggerTurn 接收由目标 owner 以低信息 Event 与 inbox 单事务完成，重检 outbox、正文 hash、直系血缘和 Workspace；重放只认同一收件 receipt，不进入 QueueOnly 恢复。`new_turn` 的来源有界资金替换、目标新 grant／Run／模型 Surface 与邮件水位、来源 activation／terminal receipt 各在准确 Session owner 的独立事务写入；旧 Run final 先于路由时，仅准确 TriggerTurn inbox 的未准备消息可 CAS 改绑新 Run，普通 QueueOnly 仍按原 Run 隔离。`current_turn` 的来源受理先以完整 D0 激活与父派发 ACK 证明冻结准确旧 Run；仅有限 sealed grant、空 binding、来源策略上界、目标本地 reserved 模型预算和含邮件的未派发 Surface 均可核时，目标在准确 call_model lease 内提交 route 与水位，来源随后释放 backup 并写唯一 ACK，Provider 派发前重读该 ACK。Store 只允许 `explore`／`plan`／`review` 的有限旧 grant，逐项核对 Surface 工具属于旧 grant 与 `read_file`／`search_content`／`search_files` 的交集；`code` 的空 allowedTools 代表不受限，拒绝当前轮路由。来源和目标只读恢复证明分别区分 route-only 与 released 阶段：前者要求来源 backup 仍 reserved 或 queued，后者要求真实释放修订；两者均核准确 child intent、模型／Surface／邮件、无 attempt／dispatch Event 与无外部 effect lease。冷启动先保留有证明的原 child allotment 与 backup，route-only 只重提原释放 CAS，随后沿原 Model ID 恢复；缺失证明、已尝试或资金 unknown 均失败关闭。来源 pending funding 查询重读当前或 retained ledger，只返回未结算的准确 reservation；TriggerTurn 与 QueueOnly 使用各自的冷启动索引。受控正式 App Server 已验证 `new_turn`、直接子停止以及当前轮下一次只读 Model 在原 Run 消费消息；内部真实 Provider 链路及两种 SIGKILL 窗口验证零 Tool `current_turn`；Store 分别验证来源政策及其 revision、目标初始 grant 的 mode／revision 0，不要求独立 Session 的修订号数值相同。

`new_turn` v2 的新备付在 Tool/Shell 活动 gauge 上记录 0/0，Store 同时接纳历史已持久化的 1/1 备付；后者仍逐项核对目标 grant 与旧上界。v1 的零工具授权校验不变。两种 v2 记录的来源资金、身份、持久回执与恢复门禁相同，Tool/Shell 数字字段不再作为新工具执行的数量准入。

已受理的 TriggerTurn 若来源 Tool 确定失败，或尚未路由／派发时有可信的到期、目标上下文不可用、来源授权变化证据，来源在同一事务释放准确 backup，并在原 outbox 行写唯一带原因的 release receipt。Store 拒绝已有目标续轮、route 或资金替换的释放；后续目标受理与冷启动扫描排除该 submission。来源 Run 用户取消时，原取消事务按同批预算释放、`turn.aborted(cause=user)` 与 Run 终态写入 `source_cancelled` 回执，不执行第二次释放。目标 Model 已准备而未派发时，到期结算另核目标失败 Run、零 attempt／dispatch／effect、本地预算释放与准确固定终态理由；已尝试或用量未知时保持待核。来源 owner 按当前 Run 和直接子 Session 提供失败状态及只读 watermark，目标 History 不生成失败正文或虚构的新 Run。

Store13 从完成态新续轮的目标 settlement／来源资金 ACK 派生确定性的 `reply` outbox；派发前失败或取消仅在目标终态、来源两笔资金释放及零模型尝试均匹配时派生相应状态回复；首轮 required 子结果沿原父 Run 具名结果帧交付，避免重复邮箱事件。回复复用跨 Session inbox 与未投递恢复；父 Run 已结束时回复不绑定后来 Run。只读漏写回复索引还覆盖已受理但未派发的具名失败／来源取消回执，供启动扫描恢复唯一通知；查询本身不创建会话或外部动作。来源备付可处于 `queued`，锁定有限计数但不占活动子位；取得执行位后准确 `resource_budget.child_slot_acquired` 才允许新轮资金替换。来源 Run 用户取消的同批预算释放也覆盖 queued 备付，Store 才写 `source_cancelled` 回执。`capacity_timeout` 要求受理时间加 `maxConcurrencyWaitMs` 已到、当前提交的槽数仍等于上限、准确备付仍 queued、无 slot acquisition／路由／目标 Run／派发，且来源同事务释放备付并记录唯一原因。已派发或 unknown 的资金不得按预派发失败释放。

Store14 在 Session 行增添内部 History 内容代次，保留 Store13 的邮箱语义。`runtime_events` 的 INSERT／UPDATE／DELETE trigger 与事件写入同事务推进对应 Session 的 `history_generation`，使同水位回退重写也能失效首屏缓存；代次不作为跨库内容相等性的依据。Store13→14 使用受维护保护的私有候选并核对旧表内容；其中旧 active／detached 执行 owner 提升代次并转为未确认清理的 `recovery_required`，旧的已确认恢复状态继续保留，原 Store 不改写。合并仅在事务内暂停精确校验过的内建 trigger，复制后重建；未知 trigger／view 仍拒绝。每条事件写入多一次 Session 行更新，写入开销与读缓存命中收益都需按实际负载判断。[升级及代次测试](../test/kite-session-store13-to14.test.ts)和[合并测试](../test/kite-session-store-merge.test.ts)为当前验证入口。

若来源通用重启恢复已把准确 followup turn/model 两笔 reservation 持久标为 unknown，目标同一 Run、模型、本地 reservation 与任务也封为 unknown，来源可在无新预算 Event 的 fenced decision 中写现有 funding row 的唯一 terminal ACK。Store 重读双方 State/Event、activation、route 和同一来源资金 Run；任何混合态、缺目标失败事实或既有 terminal receipt 均拒绝，不能重复未知用量事件。

以下 `agentMailboxMutations`、同 Session Agent 祖先／后代及 `recipient_run_id` 说明的是未开放的旧候选路径，不构成独立子 Session 的邮箱协议；跨线程的现行实施依据见[后台协调方案 §4.0.1](../../../docs/plans/background-agent-shell-conversation-coordination.md#401-跨线程邮箱的下一实施边界)。旧候选在完成替换前不得通过正式工具入口启用。

Store11 的 `agentMailboxMutations` 在同一 fenced Session 事务中与 canonical Event、State、command receipt 一起提交。显式 mail 受理要求 `commandReceipt.commandId == messageId`、digest 和 Session scope 一致；同一 exact Tool 重试先查询原 command receipt，不重插 mail。Store 验证正文 SHA-256、4 KiB UTF-8 上限、8 条未准备容量、Session 祖先／后代可见性、递增顺序与 `agent.mail_input_prepared` 的准确 invocation／水位。邮件正文在私有 `agent_mail_bodies` 表，Event 只包含 ref 和 digest；普通 Agent 列表仅公开 metadata。子任务 checkpoint 与 followup 授权快照分别使用专属不可变 Artifact 表，GC 在当前 Session owner 仍关闭。

新 Session 在初始 Controller/receipt 事务内隐式建立 root Agent，保持原 revision 0；主 Agent 的活动 task 由同一事务中的 `turn.started` 与准确 Run insert 推导为该 `runId`。准确 Run 终态 transition 与 canonical terminal event 清除其活动映射。旧 Store10 Session 在首次新 Run 中补建 root row，不改写旧事件。child 首轮须在同一事务提交 `agent.created` 与 `agent.turn_started`；Store 从当前活动执行 handle 取得真实 Controller generation，核对 Event 并与 grant digest 一起保存，terminal 再核对原 generation。

私有邮件输入只可在当前 `runWithExecution(handle)` 作用域内，经过持久 authority 复核、准确活动 Agent/task 校验与最多八条正文完整性验证后读取；已准备输入的恢复读取还要匹配原 invocation 与 model admission。推进 `agent.mail_input_prepared` 水位时，Store 还核对同批 `model.invocation_prepared`，以及准确模型 reservation 在提交后的 State 中仍属于同一预算 Run 和 invocation；无预算模式则绑定 invocation ID。Service 仍负责在调用前核对 child grant 和目标策略，Store 的 Session generation 不替代该授权。

投向 root Agent 的邮件仅在发送来源 Run 与 root 当前活动 Run 相同的受理时写入 `recipient_run_id`；root 正空闲或来源属于旧 Run 时该字段为空。root 的模型读取和 prepared 水位只选择绑定其当前 Run 的邮件；旧 Run 邮件仍保持私有、可按 metadata 查询，但不会自动进入后来的人类 Run。child 收件不受 root Run 过滤。离线连续性校验同时核对邮件正文的长度／SHA-256 与非空 root 收件 Run 的来源绑定。

验证：[mutation](../test/kite-session-mutation.test.ts)、[storage](../test/isolated/kite-session-runtime-storage.test.ts)、[run store](../test/run-store.test.ts)。


## 无执行者的设置事务

冷会话权限设置使用 `commitUnownedDecision`，不取得 execution handle。该入口在同一 BEGIN IMMEDIATE 内要求 authority 为 idle 或 recovery_required，并校验 expected Session revision；active、detached 与旧版本拒绝。必须携带同 Session 的命令回执，禁止 requiredEffectLease、runMutation 与 sessionModelRoute；Service 再限制为权限事件。入口只调用已有 decision 原子提交，不暴露通用无租约写作用域，不修改 authority 或恢复事实。后续执行仍走原有 generation fence，事务失败不会留下可用于任意写入的作用域。验证见 [Session Store 回归](../test/isolated/kite-session-runtime-storage.test.ts)。

## 按会话恢复校验

schema assertion 检查表、列、索引、DDL、marker 与 epoch；SQLite physical/FK 全库检查属于显式 preflight，不是每个 reader 的初始化步骤。普通 Session Store 打开执行无写入的结构 preflight 后打开唯一 writer connection，不解码全部 Session 或 Artifact。

`loadSnapshot`／`loadSnapshotRecord` 在一次 read snapshot 内校验目标 Session 的 Workspace binding、snapshot checksum／identity／revision、事件 schema／连续顺序、Run start receipt 与 active Run 唯一性。已有事务内复用其快照，未开启事务时在本层创建并关闭只读事务；并发 writer 的提交只能在下一次读取观察到。不持久化“已验证”标记，不用校验缓存掩盖后续内容变化。Artifact 的长度、JSON 与业务完整性继续由所属读取边界负责。

[全局 owner 回归](../test/kite-home-runtime-storage.test.ts)覆盖目录读取不解码历史以及损坏 snapshot 在访问时拒绝；[Session 并发回归](../test/isolated/kite-session-runtime-storage.test.ts)在校验中让另一连接提交，核对每次读取只观察一个一致版本。

显式恢复事务以 authority revision 与业务 revision 为共同 CAS 边界，只允许已确认清理且无未决、未知 effect 的 recovery_required 记录回到 idle；它原子保存命令回执，不能重写历史 State、事件或旧操作结果。机制见[执行权与恢复](authority-and-recovery.md#清理确认与恢复命令)。
