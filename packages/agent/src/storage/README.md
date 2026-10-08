# Store 边界

## 只读授权观察

Execution 的可选 `authorization` 由 [原授权 owner](sqlite/authorization-review.ts)从现有记录推导，未增加持久字段或写操作。工具／Job 的原派发状态、准确 reviewer 状态／决定／原因和原人工 Interaction 的保存／accepted decision 分别保留；它不是派发 grant。reviewer 优先沿实际 dispatch binding 读取准确 carrier；没有该 binding 时仅接纳唯一原 purpose 候选，有歧义不猜最新。人工 accepted 还须原答案 revision 与原 Execution 的 decision binding 相符。

观察复核原 Store／Session／Run／attempt／定义／输入／purpose、完整模型结果与原 Artifact proof，不公开原请求、主体、owner、私有上下文或审查全文。历史展示仅跳过当前可变取消标记与重新计算的当前 decision context，以保停止或后续上下文改变后可核对的原决定；这项例外只由只读 observer 显式使用。原 `fact` 授权路径默认仍检查全部当前条件，`getAuthorizationReview`、受理和最终派发不消费观察字段作为资格。

[原授权回归](../../test/isolated/execution/authorization-review.test.ts)核 live、待人工、accepted 与取消后的原决定，并确认同一已取消审查仍不能作为执行证明；[真实 HTTP／Client](../../../../tests/isolated/unified-agent/client-interactions.test.ts)核有限公开投影和未受理的迟到答案。展示与授权分离的理由见[审批观察决定](../../../../.agents/notes/implemented/architecture/2026-10-09-native-approval-observations.md)，当前执行证据范围归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原审批面板与授权观察)。

## Worker 请求内的原生语句

`SqliteOperations` 持有同步请求创建的 `query` 和 `prepare` 原生语句，包括 Drizzle query helper 的 prepared statement。具名操作在事务结束后返回已物化的值；Worker 在成功或失败 ACK 前逐项 finalize，在 strict close 前先释放本请求语句。Bun 的 query cache 遇到已 finalize 的条目会重新 prepare，同一语句不会跨请求借用。连接初始化的原生语句仍由 strict close 收束。

释放计入 Worker total timing；原 SQL/COMMIT 分项、事务回滚、Command 身份和提交未知时查询规则保持。释放失败不能发送成功 ACK，也不重发原操作或效果。[原生 Worker 回归](../../test/isolated/storage/statement-lifecycle.test.ts)以真实 statement 的 `isFinalized` 在响应发送前核成功、错误与关闭路径，继续查询、只读重开和 cursor 保持。采用请求边界的理由见[语句 owner Note](../../../../.agents/notes/implemented/bug-fix/2026-10-08-request-scoped-sql-statements.md)；这项释放不代表完整 RSS 或全部 Runtime 资源资格。

## 写锁的有界等待

正式 SQLite 写连接使用原生 `busy_timeout=1000`，只读连接与启动格式 preflight 保留 100ms。两个 Worker 共享 WAL 时，持锁 peer 被调度延迟不应在原 100ms 实验窗口内直接使普通 Run 失败；当前值让短竞争在原具名事务上等待。它是 SQLite busy handler 的累计等待预算，不是 HTTP wall-time 承诺。

等待耗尽仍返回原 `SQLITE_BUSY`，不自动重发 Worker 请求、事务回调、Command 或外部效果。原 `BEGIN IMMEDIATE`、事务失败回滚、原 ID 回执和提交未知时查询规则保持。真实 Store 测试以独立连接持锁 300ms 核一次原 Command 及零重试事件；持续持锁核有限失败、原意图缺席及释放后的准确同 ID 受理。当前取舍见[写锁等待 Note](../../../../.agents/notes/implemented/bug-fix/2026-10-07-bounded-sqlite-writer-lock-wait.md)。这不证明 Worker crash/提交未知的全部 T095 或 formal 连续负载资格。

## 原 Message 的恢复出处

[getMessageOrigin](sqlite/fork-operations.ts)在原只读事务中核当前准入 Store、主体／Session 与每层 sealed Message／Part，另从原 Message 明确绑定的 Command 或 Run 读取固定 `origin_store_id`。显式输入 Command 优先于所在 Run，查询只取原出处和准确 Session，不取来源 Run 的后来状态。私有 [Store port](port.ts)返回可选 `originStoreId`，未记录绑定时保持缺省；明确绑定缺失则拒绝为 `fork_origin_unverifiable`，不能补当前 Store。它只为 Service 投影原历史来源，不构成执行、审批、恢复或读取其他来源的 authority。

[冷恢复回归](../../test/isolated/context/restored-origin.test.ts)经真实 Core／SQLite 的普通 Run 与一次 harmless fixture Tool、明确 Fork、严格关闭和公开维护备份恢复为新 Store，核四条原用户／Model／Tool 消息的完整身份与内容、冷只读原 Store 和零新水位／Model／效果。原 [Fork 回归](../../test/isolated/context/fork.test.ts)继续核完整大正文、配对、未来格式及拒绝边界；公共 HTTP 与实际 PC 的范围归 [Service](../../../../apps/service/README.md)及 [Native](../../../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。本片不改 SQL baseline、维护资产格式或公共 HTTP schema。

## 当前会话视图

`getView` 在同一短只读事务读取原 Session、Store、通知水位与显示投影。Run 选取该 Session 最近200个分配身份，加全部 `is_active=1`；Execution 选取最近200个身份，加全部 `planned/dispatching/running/outcome_unknown` 原事实。两组身份分别去重后按原 rowid 顺序返回，历史数量不能隐藏当前 Run、较早的运行中 Job 或未知结果。未知结果即使另有核实证明，也不在此查询中改写原状态；显示不授予恢复或取消权限。

这个投影不是全部 Run/Execution 历史。旧记录仍可按准确 ID 独立读取；完整 Message 历史和输出沿各自固定上界的分页，不从当前视图数量推导 EOF。消息首屏、公共 DTO、执行/授权/恢复事务与读取预算保持各自原合同。

[真实长会话回归](../../../../tests/isolated/unified-agent/active-view.test.ts)通过公开 Runtime/HTTP/Client 完成205轮实际模型执行，第206轮已派发时保留当前 Run、当前 Model及最早的真实 detached Job，并核便携 Desktop controller、只读游标不增长、准确取消当前 Run不停止旧 Job。它不证明跨会话后台总览、所有历史Execution分页或实际三平台窗口；准确执行结果见[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07长会话当前工作投影)。

[显式中断 history owner](sqlite/recovery/README.md) 负责原取消 Tool 的准确 Model call 绑定、完整封存输出读取和最终恢复事务消息 CAS；它不恢复派发，也不改变 SDK 的配对要求，真实 unknown 沿原收束与阻挡条件保留。

## 正常 owner 空闲交接

`inspectOwnerDispatch` 是可信宿主 Store 的有限观察：在同一短事务内核对原 Store、root owner 的 instance/generation 和准确目标 Session，返回该 Session 是否有普通 accepted Command、整个原执行组是否有 active Run 或未结算 Execution，以及下述主 Action 是否尚未提交结果。它不取得新 owner、不恢复工作，也不向扩展或 HTTP 暴露。acquire、release 与前两项观察共用 [owner-dispatch](sqlite/owner-dispatch.ts) 的阻塞条件，保留准确原 Job reconciliation 已核实结果的既有例外。

正常空闲交接仅在原 accepted 列表为空、实际 release 返回 false 且没有原 hot work 时使用前两项观察。新命令在旧列表读取后、release 事务前提交，且原组没有未结算工作时，原 generation 继续循环处理准确 Session；新命令已取消时尝试有限 release 后退出。其他 Session 的命令保持自己的调度，真实 unknown/cold active 仍返回 `session_recovery_required`，不将正常交接扩大为自动接管。

[交接测试](../../test/isolated/execution/owner-handoff.test.ts) 用真实 SQLite、实际 accepted Command 和所属 detached Job 的结算 barrier，稳定复现旧分支错误；验证 pending 精确执行一次、unknown/cancel 零新增执行，以及独立 Session 的隔离。现有原 owner 生命周期、恢复与 child 测试同时验证既有 release 和 fencing 条件；独立 Session 反例不代表专门覆盖了同 group 跨 Session 的运行交错。

有限观察与恢复权分离、共用原阻塞条件的理由见[交接修复 Note](../../../../.agents/notes/implemented/bug-fix/2026-10-03-idle-owner-intake-keeps-original-generation.md)。

## 未提交普通 Action 的串行边界

`inspectOwnerDispatch.hasUncommittedAction`在同一原owner短事务内核准确applied `extension.invoke` Command的receipt主Execution、Store/Session/root/generation/root-work、定义和Run身份。原主Action仍planned/dispatching/running时，Runtime每次处理本Session accepted Command前停止普通派发并报告`session_recovery_required`。原Action结果不补写，后续Command保持accepted，反复同instance调度不能跨过；读取与owned关闭继续。已持久terminal outcome_unknown和合法detached connection Job不由此新增条件判断。

[真实结果提交故障测试](../../test/isolated/execution/action-result-boundary.test.ts)核普通Action实际效果一次、最终apply前失败、queued与later重调度零Execution/效果、独立Session、原五秒waiter与正常关闭；[MCP故障测试](../../test/isolated/mcp/reconnection.test.ts)另核持有新目录时不发布Step或wire。当前实际复验按[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)记录，代码和静态定义不代证该边界已运行通过。

## 目录分页

[SQLite directory](sqlite/directory.ts) 在短只读事务中读取 Workspace/Session 分配 rowid 的 Decimal64 上界与通知观察水位。每页最多 200 项，客户端固定首 upperSeq 并沿 nextAfterSeq 读完，不用名称/id排序或累计数量截断充当完整证明。后创建项目不混入封存上界；未来/越界/非规范游标拒绝。该上界冻结分配范围；不传快照约束时，标题与删除等现行投影仍按每页读取时事实呈现。Session 续页可传首 `snapshotCursor`，同一只读事务核通知水位，变化返回 `directory_changed`，不拼接不同观察。

Workspace 沿用原 profile 范围，核对 expectedStoreId；现有 Workspace 没有主体创建字段，不从 Session 推造所有权，合法空 Workspace 仍可列出。Session 仅列 root、未请求删除的记录，先核当前 Store 准入，再核对真实 `session.create` Command 的宿主主体；恢复保留的旧创建出处不要求等于当前 Store，并在 SQL 分页前执行 workspace 过滤。child 入口保持 Task/父视图的独立权限，不因目录分页扩大。旧 `listWorkspaces/listSessions` 是明确当前页内部接口，不能用它们的默认 100 项证明目录已经读完。

Session 每项附有限 `activity`：准确 active Run 优先、否则 latest Run 的 ID/status/isActive/是否仍有必需结果，未取消且越过停止边界的 accepted run.start/follow-up、同主体当前 Store 的 pending presentation Interaction 数量。没有 Run 不伪造完成，排队不替换尚活动的 Run。时间来自原 Session 最后 cursor 的私人 `kite.session-log@1.occurredAt`；旧／未知／损坏／非整数时间明确 null，不用读取时钟、Run 开始时间或其他会话时间填补。只读取有限字段，不公开原事件 payload、Run config 或输入。没有新增表／列、baseline checksum、Store major 或维护资产，冷读取不写事件。日志封存理由仍归[原决定](../../../../.agents/notes/implemented/architecture/2026-10-03-bounded-session-log-observation.md)，目录取舍见[本决定](../../../../.agents/notes/implemented/architecture/2026-10-08-session-directory-activity-observation.md)。

[真实目录测试](../../../../tests/isolated/unified-agent/directory.test.ts) 使用具名创建命令、超过 200 项 Workspace/root Session、多主体、Native/Browser HTTP 与冷 readonly Store，核对固定上界、准确过滤、空 Workspace、零读取事件/Model 和原身份；另核改名没有 Run 的真实事件时间、queued/active/latest 与未知时间保留，不伪造 Model 成功记录。

[Session 管理 owner](sqlite/session-management/README.md) 负责 root 改名 CAS 和执行组删除意图；目录隐藏 tombstone，真实停止事实与只读历史保留独立。删除回执不代表所有外部效果已停止。

[Context 压缩 owner](sqlite/context/compression.README.md) 负责同 Model ledger 的摘要发布、覆盖范围、Fork 原来源和只读展开；手动压缩/reset 与最终 Run 结算同事务，不引入压缩状态机或默认模型窗口猜测。

Session 完整原始记录的只读导出与分块文本范围见 [export owner](sqlite/export/README.md)。SQL 冻结读集完成验证、完整下载 footer 和原 scope 媒体 EOF 是独立证明；导出不恢复或消费旧工作。

`@kite-ai/agent/sqlite` 的 `preflightSqliteStore(ProfileOptions)` 是启动准备阶段的只读格式预检：持有选定 profile 的外置 shared profile-use lease，返回 `absent`、`uninitialized` 或 `{ status: 'compatible', storeId, formatMajor: 1 }`。它复用正式打开的 baseline schema/migration checksum 校验，读取所选 Bun SQLite 引擎可见的当前 WAL 状态；不启动 Worker/Runtime/Model，不创建 profile、core.db、profile.json，不初始化或迁移业务表。启动准备允许建立 dataRoot/协调锁目录；status 发现入口仍不使用此函数。

未完成 restore journal、exclusive 维护占用、rollback journal、链接/非私有文件和未知/损坏格式明确拒绝。只读连接使用 strict close 后才释放 lease；若数据库关闭未获确认，返回 `store_preflight_cleanup_failed` 并保留该进程的 profile-use 锁，不能冒充已释放。`compatible` 仅证明该次观察的格式与身份，未来 launch 仍须重新执行正式格式和身份准入，也不是完整业务历史的健康证明。源码与发布 SQLite leaf 分别使用各自真实包内 migration SQL，不回退到源码树。

[启动预检测试](../../test/isolated/storage/preflight.test.ts) 验证真实空库/缺库、合法 Store 和 live WAL 的原字节与 Core 事实、未来/未知/破坏 schema/checksum、链接/权限/journal、第二进程锁，以及源码树外公开 leaf 的实际包内资产读取。当前本机证据不能代表其他平台或发布引擎资格。

`sqliteStorageAssets()` 是同一公开 leaf 的纯 metadata getter，返回实际 `module`、`worker`、`baseline` URL。`openSqliteStore` 的 Worker 与 preflight 共用这些实际选择，source/built 分别选择 main.ts/main.js，不由 Service 猜私有路径，也不把 module 的任意父目录当专用 runtime root。它不打开库、读取文件或证明候选目录身份；完整安装 candidate 的 host-only closure 证明归[Service 资产 owner](../../../../apps/service/src/runtime-assets.ts)。


## 原 active Run 的显式恢复

[Run resume owner](sqlite/run-resume-operations.ts) 提供只读 `verifyRunResume`、受限 `beginRunResume`、最终 `commitRunResume` 和独立 lease release。当前资格限同 Store、真实 root 创建主体所属的 `run.start`／`input.follow_up` 原 active Run；终态不重开，child、runless planned closure、压缩和 Job report 的特殊 Run 局部拒绝。全组存在其他 active Run 或 dispatching/running/outcome_unknown Execution 时不借普通 owner 接管。原 Run 的完整成功 Model、已知 Tool 结果只读复用；partial／不完整 Model 不作为安全 checkpoint。

只读预检和原申请回执查询先于恢复工厂。同 ID 已登记 accepted 或 applied 意图只返回原回执，不重新准备、派发或执行；同 ID 改变原 Run／epoch 等意图冲突。内部 `RunResumeInput.expectedOwnerGeneration` 做持久 epoch CAS，公开 HTTP 不接收客户端 generation，由 Service 查询原回执或当前 Session 推导。`before_model_dispatch`、`tool_calls`、`completion` checkpoint 封存当前 Run 读集摘要、原 selection 与初始化状态；Runtime 另核完整 Model 正文和原调用身份。

begin 先取得真实 root OS 锁，事务复核后递增 generation、登记 accepted/null 与私有 `RunResumeLease`。这个 lease 只进入 facade 的 recovery map，不能投影为普通 `OwnerRef` 进行 plan、dispatch 或 finish。可信恢复 binding 准备完成后，commit 同事务再核准确 lease、原配置 canonical 等值、checkpoint、selection、主体、取消与原出处，仅重绑准确的零派发 planned Model/Tool generation，随后登记 applied `run_resumed` 回执并转入普通 owner map。原 Run/Execution ID、attempt、成功结果、原 Interaction 和已保存答案保持；后续派发仍检查当前权限、原审批与取消。

所有四处具名 Run 创建事务捕获 `context_selection_id`；当前 selection 漂移拒绝恢复。`initialization_state` 持久区分 unstarted／started／completed：任何初始化回调前先登记 started，注册 requirement 结果与 completed 同事务提交，空 refs 也必须完成封存。恢复 completed 复用原 refs，不重跑回调；started 拒绝重放半执行的闭包；unstarted 只有零 Execution 时可进入原初始化入口。

独立 accepted `run.resume` 不进入普通 accepted 队列，不阻挡普通 owner release，也不被 Session interrupt 改成 needs_review。准备期取消或删除为新申请记录取消事实、保持 accepted/null，commit 随后拒绝；applied 回执保留已恢复事实，停止原执行仍使用准确原 Run 控制。Runtime 关闭等待准备和 binding 清理；未确认清理时不能宣称 lease 与资源已释放。

[Store 验证](../../test/isolated/recovery/run-resume-store.test.ts) 覆盖真实 SQLite 事务、实际 root 锁、公共 lease 投影拒绝、epoch/config/selection CAS、原 planned attempt／Interaction 保持、初始化三态、取消与事务故障回滚；SQL 修改仅用于明确标注的故障注入。[Runtime 验证](../../test/isolated/recovery/run-resume-runtime.test.ts) 使用所属子进程真实 SIGKILL、固定 Model 和独立效果 ledger，核原边界恢复与拒绝路径。业务 Run 事实可经 [原始导出](sqlite/export/README.md) 读取，私有 purpose lease 不导出。


## Job 核实的受限所有权

[Job reconciliation](sqlite/job-reconcile-operations.ts) 使用独立 `JobRecoveryLease` 和根 Session OS 锁，递增 generation 后只允许原命令的核实派发与证据归档。它不是普通 `OwnerRef`，不能调用原 Job finish、创建 Run 或启动其他操作；释放也不使用会被历史 unknown 阻挡的普通 owner release。Runtime 关闭必须等待查询与恢复 binding 清理，清理不确认时继续持有原资源。

`sealJobRecoveryManifest` 仅在原 Job 派发前保存不可变恢复身份。只读预检先核当前 Store、root 创建主体、原执行归属、原关联和 resultRevision，再进入宿主授权/恢复工厂。begin 与 query dispatch/finalize 事务重核原身份、generation 和当前控制读集；有活动 Run 或未中断的 live 派发时，先由显式中断核实原状态。不同根、旧备份 Store、无原关联不进入外部查询。

申请和证明沿独立 Command 保存，原 Job result 与 revision 不覆盖；Command 仅保存私有恢复配置/关联的摘要，完整私有 manifest 留在 Execution，不通过原始导出暴露。部分索引定位原 execution/revision；普通 owner acquire/release 只对准确原 Store/root/revision 且结果已知、监督 ended 的 proof 排除该 Job 阻挡，不放行其他未知执行。核实不消费结果，pending delivery 在最终事务抑制，原已消费引用保持。

独立 accepted 核实命令不进入普通 accepted 队列，不阻塞正常 owner release，也不被显式 Session 中断改写成 needs_review。取消只为新核实命令记录取消事实并保留 accepted/null；派发与证明提交均核这个取消状态，不能再完成证明或改写原 Job。

## Fork 记录的有限来源观察

`ReadContext.readForkRecordSources(localKey)` 只能从当前 Session/extension 的真实封存 anchor 推导祖先 records；不接受 foreign Session、Store、namespace 或任意原 key。Host 封存完整 `(extensionId,sessionId,key)` stamps 与三字段 binding，最终 `markDispatching` 在同 owned-write SQL 独立重建 applied Fork request/receipt、namespace provenance、原 revisions/origin/rawDigest、实际 selected Message origin/parts 与各层 selection/upper。prepare/execute/Query/context capture 后端口关闭，不向 Model Tool 开放；Action/Ask 的非 Message `next_seq` 不影响摘要。

可信 rebuild 可明确 opt-in `sourceScope:'namespace'`，纯输入额外含 schema-validated、递归冻结的同 namespace records，sourceKeys 由宿主固定；默认旧 group 形状与 keys 保持。共同读集64 identities/32KiB、观察图1MiB/64层及8192 Message/parts边界全部明确拒绝，不能截断后声称完整。source revision/rawDigest 偏离 Fork snapshot 即 unavailable，历史 metadata必须由业务完整 snapshot保存，不猜旧版。它不开放祖先 Execution/Run/Artifact、不转交 approval/grant，当前Action仍独立授权；现有 record observer不能代替后续 sealed readonly media合同。

[真实 Store/Host tests](../../test/isolated/storage/fork-record-sources.test.ts) 新18/94与同生产五文件42/381分别证明两层/63层Fork、null0、64记录边界、foreign/cycle/budget、callback关闭及等待来源/receipt/Message漂移的最终SQL零adapter。owner见 [Fork](../extensions/fork/README.md)，理由见[sealed record观察](../../../../.agents/notes/implemented/architecture/2026-10-03-sealed-fork-record-observation.md)。

## Session 日志元数据只读观察

[Session logs owner](sqlite/session-logs.README.md) 在原 change_event payload 中保存私有版本化 append 元数据，原公共 getChanges payload/SSE 不变。Store 只提供准确原 Session/subject 的固定 upper、有界只读页；旧元数据不可用，不从当前状态补历史。Model 导航只指向原持久输入绑定，不读取正文或授予执行权。无 schema／format 变化，原备份恢复字节契约保持。

## 普通 Action 的完整执行组边界

可信 `ReadContext.readExecutionGroupSafety()` 绑定实际 Store、调用 Session 和 root 创建主体；`requireExecutionGroupQuiescent()` 仅在普通 Action 的实际 prepare 中注册当前静止谓词。它遍历实际 root 父子树并交叉核 root 标记，读取所有 active Run、accepted/needs-review Command 与各类 planned/dispatching/running/unknown Execution，包括 runless 和 detached 工作；既有准确 Job reconciliation 证明沿原条件复用。只排除原 Action intake 与最后核验的准确 carrier，不接受扩展提供 root、主体或任意 exclusion。旧 `readRunExecutionSafety` 的单 Run 语义保持。每类当前关联事实最多读取 8192 项，超出或树关系不可闭合返回 unavailable/denied，不以局部结果宣称完整静止。

Host 自动封存 prepare 中 session namespace 的 `records.get/list` 完整原投影摘要和 revision，缺失与分页 absence 也属于最终依赖。getter 随 prepare 结束关闭。Ask、权限和普通 freshness 完成后，只刷新已注册的当前执行组静止谓词，原记录读集与原 `contextRevision` 不替换；`markDispatching` 在原 OwnedWrite 的短事务内重复检查记录与完整组事实。`contextRevision` 绑定全组真实 Session/selection、完整消息和 Part revision，不把本 Action 的 Command/Ask 分配水位当上下文变化。先拒绝非静止组，再拒绝原上下文漂移；重新读到“目前静止”不能批准未在原 prepare 中消费的新历史。每类读集保持 8192 项有限闭合边界。

本 guarded Action 的准确私有 reviewer 可以提供中立审阅上下文，但须已完成真实纯用途闭包：原 sealed request、唯一 completed Run/成功 Model、原两 Command/两完整 Message 及 parts、原 selector、无额外工作或后代。`authorizationReviewContextSession` 只在这些条件和原 target 绑定均有效时排除该 Session 的 context 摘要；原完整父子树、全部 group safety、unknown 与最终审批证明仍参与核验。额外 Run/Command/Message/part/selector/后代或正文漂移使排除失效，原 pin 拒绝派发，不重写原 prepare。真实 [reviewer 上下文回归](../../test/isolated/execution/guarded-review-context.test.ts)明确区分实际 Model/Ask 与 owned SQLite 故障注入。

普通空读集不扩大 authority，子 operation 保留父 provenance，但不继承原 Action collector 或 guard 授权。Action 已通过最终原读集核验并进入 adapter 后，合法业务写入可以消费自己的 prepared missing-record；后继 Job 仍核原外部 source 和自身独立权限/read-set，不重新用父的旧 absence 否定父刚完成的合法写入。外部 source 在 Job Ask 后漂移仍在 adapter 前拒绝。普通 Query 缺省绑定实际当前 Store，显式 expectedStoreId 不被替换，缺 subject 的私有读取仍拒绝。

`inheritsActionSource` 沿实际 parent Execution 与 Operation Command 证明同 Store/Session/rootWork/主体的 runless 来源，最多 64 个节点（含当前与原 Action），核每个真实请求、取消边、已派发祖先及原 prepared input。多跳 Tool→Job 仍只继承 provenance，不获得父 collector/guard。唯一未派发父节点例外是 `authorizationReviewSourceTarget` 完整封存的真实 reviewer 与准确 planned target；它不批准 target。链断裂、循环、漂移、65 节点或注入父读集均拒绝，原权限、Ask、freshness、requirements 与控制 revision 继续核验。实际 [来源链回归](../../test/isolated/storage/action-source-inheritance.test.ts)与 [Runtime 审阅回归](../../test/isolated/execution/authorization-review.test.ts)分别负责 Store 负例和真实 Model＋独立人类批准。

原 Action `decision_source_json` 中闭合、宿主创建的 `execution_group_quiescence@1` guard 与原 Store/Command/definition/prepared input 绑定。已提交 dispatching/running carrier 是持久的同 root fence：新 Run、普通 Execution/operation、child 激活、压缩与恢复派发不得跨越；已接受申请仍可留在原队列。Job report 原结果仍可落定，只有实际后继 Run 创建被挡并保留 deferred 申请。取消请求不释放 fence；已知实际终态释放，crash/unknown 和冷读不自动解除。其他 root 独立继续。该边界防止受监督的新效果进入正在执行的 guarded Action 窗口；它不把 SQLite 与外部文件或不合作进程的 I/O 变成原子事务。

[真实组边界测试](../../test/isolated/storage/execution-group-dispatch.test.ts) 使用实际 SQLite、Host Action、独立 Ask、原 record writer、冷 readonly Store 和实际 child activation，核 final capture 后受理新工作零 dispatch/event、同 JSON 新 revision 和列表 phantom 拒绝、准确 self/主体、unknown/取消不释放、另一 root 继续以及完整 child/runless 范围。业务叶仍负责登记全部不可变 point、mutable head 和业务相关记录；只读取静止投影而不注册谓词不能取得物理执行 fence。

原上下文 pin 的实际十例 58 条断言及四文件邻接 26/308 分别验证 Ask 自身可继续、另 Run 完整消息或 selection 变化不能刷新掉原 pin。独立[未见扩展](../../../../tests/isolated/unified-agent/extension-unseen.test.ts)以公开 leaf 实际核准备缺失项被合法写入后仍可创建 Job，外部 source 漂移零 adapter；它的完整五例 294 条断言与十一文件 47/631 邻接不代表所有扩展或整个 E14。取舍见[原读集与完整组 fence](../../../../.agents/notes/implemented/architecture/2026-10-03-guarded-actions-pin-original-context-and-group.md)。

新增 immutable readonly source delegation 与上述 live records observer 各有范围：明确 `sourceReads:'declared'` 的可信 rebuild 通过有限准确源声明封存 Execution/Run/Model input/output 和 Artifact refs，读取只能从 current Session/extension 的实际 anchor 打开，不能指定 foreign scope。`openForkSourceProjection` 保留完整 ancestor aliases 与原来源身份；最终 Fork SQL 复核真实 Run/Cmd/Model/Tool、完整请求摘要、namespace/source stamps 和 source-root quiescence。immutable projection 不跟随 Fork 后的 mutable head；来源root的tombstone仍允许存活Fork按原证明读取未清理历史，当前namespace必须未删除，已清理来源拒绝。GC保留存活Fork的完整祖先依赖，ordinary Artifact/foreign readers 没有新授权。最终新文件 [20/313](../../test/isolated/storage/fork-readonly-sources.test.ts) 与此前相邻七文件62/601分别验证，最后深度/全文断言仅新文件重跑。当前合同与持久理由见 [Fork owner](../extensions/fork/README.md)及[封存只读来源 Note](../../../../.agents/notes/implemented/architecture/2026-10-03-sealed-readonly-fork-sources.md)。

私有 reviewer 的完整 ModelOutput 不能由 `response.content` 的 preview 代替。Core 验同一 captured descriptor 的完整 EOF，严格解析答案后将[有限凭据](../authorization-review-output.ts)登记到原 Model execution scope 的不可变 Artifact。`authorization-review.fact` 保留原 purpose、唯一 Run/Model、binding、终态和空 tools 条件，并核当前完整 descriptor 摘要、凭据登记的原 scope/MIME/hash/size、原始全文 hash/bytes，以及 inline 重解析或准确原 carrier Artifact metadata；普通 Extension 的同名 details 不取得这条资格。SQL 不读取 graph／正文文件，冷 proof 不生成凭据或新调用。[实际审阅测试](../../test/isolated/execution/authorization-review-complete-output.test.ts)验证大合法 JSON、独立 Ask、效果一次及 descriptor/答案/登记元数据漂移零目标派发；完整读取、冷 metadata proof 与恢复后的新授权保持各自边界，细节归[输出 owner](../model-output/README.md)。

## 跨会话原 Job 目录

`listBackgroundExecutions` 在短只读事务按原 Execution rowid 的 Decimal64 顺序读取全部 `kind=job`，包括普通 Job、child/task carrier 和后代 Session 内的 Job。先按真实 root `session.create` 主体、原 source／root-work Command 主体、出处与序号、实际 parent ancestry 全程未删除状态与可选 Workspace/root/Execution 过滤，再按固定 upper 和最多200项分页；后代还核原 child-start request 与 carrier、来源和根工作绑定。当前 Store 用于准入；旧来源只在 root creator 原出处已经不同于当前 Store 的准确恢复根内接纳，不为普通根放宽来源。重复恢复保留期间各 Store 的真实来源。`limit+1` 判定准确 EOF。只返回原身份、状态、attempt、result revision、delivery、取消事实和有限 Session/Run metadata，不读取大 input/result/config/reference 正文。runless Job 的 `run` 沿原 parent Execution 链找到原父 Run；`childRun` 只查 `child-start-{execution.id}`，原 child-start Command／request 必须准确绑定载体，已有 reference runId 必须一致，不选择最新 Run。

首页 `snapshotCursor` 与 items 来自同一事务；续页带该游标时，metadata 改变返回 `directory_changed`，不修改业务、ACK或输出。HTTP/SDK 完整扫描在此冲突时丢弃前缀并从头重读，保当前 Store/subject 准入。[实际 SQLite/HTTP 测试](../../../../tests/isolated/unified-agent/background-directory.test.ts)覆盖超200条、nested child、后来无关 child Run、fixed upper、主体/删除过滤、公开物理恢复与只读计数。此 API 证据不替代 Native 实际窗口资格。

[取消操作](sqlite/cancel-operations.ts)在首写前解析完整目标、attached 扩展、准确 child Run／Command 及待取消输入，并要求每个 effect 的 Execution／Run／source 属于当前 Store。新取消命令不能修改旧来源历史；范围混有旧来源时整项拒绝，零部分写入，期间新工作可按准确当前目标停止。既有原取消回执的相同请求仍只返回原记录，不重做效果。
