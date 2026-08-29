# Runtime SQLite Storage

## 定位

`@kite-ai/runtime-storage-sqlite` 是 Host storage port 的唯一 SQLite concrete adapter 和物理 Runtime Store owner。

## 拥有职责

- 管理 Store 6 current database lifecycle、8 张表、2 个索引、schema、event、session、snapshot、artifact、effect lease、command receipt 与 transaction。
- 以显式 `workspaceBinding` opt-in 打开 Store 7 target：State 27、Workspace/Worker header binding、Session ownership、receipt
  ownership 与 `session_workspace_tombstone`；未提供 binding 时仍保持 Store 6 current authority，避免在 cutover 前改变旧 Service。
- KRSRUN-01A另提供未发布的State 27 / Store 8 / `kite-agent-server-api-v1-2026-08-29` target profile、exact preflight与
  same-connection `runtime_runs` port。Store 8有11张表/3个named index，Session增加coverage boundary，receipt增加resource-result triple；
  `(session_id, run_id)` PK、同Session start-command unique与`(session_id, created_revision, run_id)` page index均由DDL/owner tests固定。
  KRSRUN-01B已让同一connection transaction可选提交Run insert/transition及Store8 receipt result triple；KRSRUN-02A进一步让
  `adapter.ts`仅在显式`targetStore: 'run'`时组合该profile。KRSRUN-03A允许它同时携带`workspaceLayout`作为active Store8 writer，
  复用Controller/session-create/Directory/History/Checkpoint façade并把所有mutation接到first-write fence；不带layout时仍只是测试/迁移target。
- 提供 owner-only generation layout 的 active-layout pointer、manifest、migration journal/fence 与窄回退状态机；离线
  `migrateSqliteRuntimeStoreToWorkspaceLayout` 只从 Service 已停止且 source-bound fence 保护的 Store 6 只读快照复制到
  Store 7，不改写 source、不在线迁移、不双写，也不启动 Worker。迁移不定义或复制 Coordinator Catalog DDL；调用方必须注入
  `catalogBuilder`，由 Coordinator/Service owner 用 exact target `catalogPath` 和 path-free Session routing metadata 建立唯一
  Catalog，返回的 digest 由 migration 在 pointer switch 前复核。
- KRSRUN-02B新增显式offline `migrateSqliteRuntimeLayoutToRunStore`：只有manager提供Coordinator/Worker/Gateway停止且
  Turn/Interaction/effect/external process全部收敛的closed barrier后，才从active Store 7 generation的Catalog与每个Workspace
  no-follow隔离snapshot复制到fresh Store 8 generation。Catalog正文由Coordinator-owned copy port完整保留；Workspace逐表保留
  Session/event/snapshot/preimage/receipt/tombstone/outbox/private meta，把每个`run_index_from_revision`设为source head且不生成历史Run。
  logical digest/count/binding/Store8 preflight全部通过后才复用原journal/fence/pointer状态机切换；任一active/corrupt/unowned/partial/fault
  整体blocked，旧Store7 writer在新fence写入后即fail closed。
- KRSRUN-03B由release owner提供正式命令`kite maintenance migrate-run-store --target-generation <fresh-generation>`。
  命令先通过Manager关闭Coordinator admission，按exact PID/start-token和authenticated control逐个停止Gateway与idle Worker，
  再由Host State predicate及本owner的authority/effect/WAL深检共同证明closed barrier；busy、unknown或corrupt均不建立target pointer。
- Store 7/8 共用 `workspaceAuthority` durable facade：Controller operation receipt/idempotency、Controller generation/lease、
  hash-only resume/DetachedRecovery rotation、detached/recovery state、effect prepare/inspect/terminal 与 resource
  attempt evidence。capability secret 只在调用者内存中出现，Store 仅保留 SHA-256 hash；resource surface 只记录外部
  OS-user lease 证据，不在 Workspace SQLite 内重新 acquire 共享文件资源。
- `apps/kite-service/src/workspace-worker/production.ts` 是当前 Store 8 的 concrete Worker consumer：Coordinator 先完成
  materialize/admit 与 active-generation 校验，Worker 再以已打开的唯一 Store owner 组合 Host/Application。默认 Service 仍是
  Store 6；Store 7只作offline migration source，不会因Web query或Store8 open failure被隐式启用。
- 执行只读 format preflight、current log query 和已知历史 source 的隔离导入。
- `createSqliteWorkspaceRuntimeLogQueryPort` 只接受server-owned layout、active generation与opaque Worker scope，canonical Store
  path由layout owner推导。production从Store 8 marker取得内部Workspace digest后在同一隔离只读snapshot复核完整binding，并在每次
  query前后重验active pointer/manifest/journal/fence；不会在live Store旁创建WAL/SHM、schema或第二writer。
- active Store 8 writer额外窄暴露same-connection bounded read ports：`openWorkspaceLogQuery`对`runtime_sessions/runtime_events`
  执行keyset/sequence window查询，`workspaceCheckpointQuery`按`revision + checkpointId`分页并逐个验证选中snapshot checksum。
  两者不打开第二SQLite connection、不创建DDL/index、不返回State JSON/Store path，也不接受compatibility source。
- 通过 `transaction.ts` 原子提交 Runtime event 与 snapshot。

## 不拥有职责

- 不导入或解释 Kernel/Builtin domain 类型。
- 不提供 alternate driver、dual write 或 execution fallback；Store 7 只能通过显式 Workspace binding 进入 target path，不能
  作为 current Store 的 silent format fallback。
- Store 8 Run port只接受调用方已经拥有的同一SQLite connection，不创建第二writer或自主transaction owner；Worker Host可消费private port，
  Public Agent API仍不得直接消费或发布`runs`capability。
- 历史 source reader 不进入 current execution port。

## 允许依赖

只允许依赖 `@kite-ai/runtime-host`，生产源码只使用其 `/storage` port。

## 公开入口

只导出 package 根入口 `@kite-ai/runtime-storage-sqlite`。

## 关键不变量

- `adapter.ts` 是唯一 current database lifecycle owner。
- current production Workspace Worker writer精确为State 27 / Store 8 / `kite-agent-server-api-v1-2026-08-29`；显式legacy Service
  writer仍为State 27 / Store 6 / `kite-runtime-server-v1-2026-08-26`。两者都只由`adapter.ts`拥有database lifecycle，layout fence禁止并行双写。
- Store 7 target 精确为 State 27 / Store 7 / `kite-coordinator-workspace-worker-web-v1-2026-08-28`；必须携带显式
  `layoutGeneration`、`workerScopeId`、`workspaceIdentityDigest` binding，header/session/receipt/tombstone 任一 ownership
  drift 都在 reopen/preflight 时 fail closed。
- Store 8 target精确为State 27 / Store 8 / `kite-agent-server-api-v1-2026-08-29`。preflight拒绝Store 7 marker、未知/缺失
  table/column/index、binding/coverage drift、malformed terminal与receipt-result digest/schema/JSON drift；反向Store 7 preflight同样拒绝Store 8。
  普通compatibility importer仍只列出两个Store 5 profile；Store 7只由单独的offline Run migration source常量标识，不进入per-Session import。
- Run list固定`createdRevision ASC + runId ASC`、limit 1～200并走dedicated index；Run ID只在Session内唯一。insert/transition先验证
  coverage、canonical Session revision、immutable identity、lifecycle与millisecond timestamps；insert在同一writer transaction内拒绝
  同Session第二个queued/running/waiting Run。start decision后的same-phase `queued→running` activation可复用刚提交的State revision；其他
  same-revision transition继续拒绝，避免把无State event的调度边界伪造成新revision。
- Store8 transaction在一个`BEGIN IMMEDIATE`内提交State/event/snapshot/revision、Run mutation及digest-bound resource receipt，任一
  receipt/Run/SQLite fault都会完整rollback。Store8-aware receipt lookup返回原result；Store6/7 writer与current Store7 adapter收到
  resource result或Run mutation时fail closed且不留下Session partial facts。
- Store8 delete依赖已验证的`runtime_runs -> runtime_sessions ON DELETE CASCADE`在现有delete transaction内移除Run，并保留tombstone和
  全部receipt。rewind只在coverage内的between-turn边界删除较新Run；若会保留active/unknown或截断`lastRevision`则整笔拒绝。fork只复制
  checkpoint以前的`completed|failed|cancelled`行，保留时间/phase/status，重绑target并记录直接origin，同时继承source coverage boundary；
  任一Run maintenance、snapshot或receipt fault都会回滚全部Session target事实。
- 已发布 generation 的 Store 7 reopen 必须带 active-layout、manifest、migration journal/fence 证据并使用 canonical
  Workspace Store path；纯 reopen 不会标记 generation 已写，首个真实 mutation 在同一 storage write seam 前永久写入
  `targetWriteState=written`，之后 rollback helper 必须拒绝回源。新 target 只能由显式 migration/admission 流程发布；
  `admitNewWorkspaceStore` 只在已 committed 的 active generation 中登记已 materialize 且 header 已由 Store owner 验证的
  canonical file，并先将 generation 标记为 written，绝不自动推断 Workspace ownership。
- `targetWriteState=written` 后的 Worker restart/re-admission重新验证owner/no-follow、Store 8 profile与完整 Workspace
  binding，并要求manifest/journal中的原始admission digest彼此一致；它不再把已写live Store字节与first-write前digest比较，
  也不重设或更新该原始digest。`targetWriteState=none`时仍必须精确匹配pre-write digest。
- offline Store 7 log reader仍要求regular、owner-only、no-follow、nlink=1与exact Store 7 scope/profile；pointer或binding在
  query期间漂移会使本次读取失败，legacy-only/Store 6不能作为silent fallback。
- live Worker的same-connection Session/History/Checkpoint page source只在already-open Store 8 owner存活时可用；Session按
  `updatedAt DESC + sessionId DESC`，Checkpoint按`revision ASC + checkpointId ASC`稳定推进，单页最多200项。关闭page reader不关闭
  writer，关闭writer后新reader fail closed；这些port不执行recovery、mutation或全Workspace正文物化。
- Store 6 到 Store 7 的 copy-and-switch 必须由调用方提供已验证的 persisted Workspace ownership resolver；缺失/冲突归属、
  orphan retained receipt、损坏或未知 source fact 会整体 blocked，source 保持只读且 active-layout 不切换。迁移逐 Session
  校验 event count/sequence、snapshot checksum/position、receipt digest、recovery evidence 与 content digest，完成所有
  Worker Store、metadata-only Catalog、immutable manifest 和 journal 后才原子切换 pointer。
- Store 7到Store 8只允许whole-generation copy-and-switch；source manifest/journal/fence、Catalog、全部manifested Workspace与安全WAL/SHM
  必须共同稳定。Catalog不能丢失outbox cursor或operation receipt，存在`in_progress`operation或未登记Worker scope时拒绝；Store8 target
  receipt result固定为空、Run表为空、coverage固定source Session revision。Controller/recovery/effect/resource authority与recovery identity
  先按owner codec完整校验；任何未收敛或损坏事实整体阻断，合法记录只重绑target LayoutGeneration后复制。target首次写通过
  `markSqliteRuntimeRunStoreWritten`把generation永久标记written；Store7/Store8 active helper按manifest profile双向阻断错误binary，Store8
  writer还必须等journal达到`committed`。
- `runtime_command_receipts` 的主键精确为 `(scope_session_id, command_id)`；applied receipt 与 event/snapshot 同一 `BEGIN IMMEDIATE` 原子提交。
  rewind后receipt的`committed_revision`可以高于current Session head，这是保留original applied decision的预期语义，reopen按owner/digest/
  canonical receipt验证而不把它误判为未来伪造事实。不会建立额外 receipt 索引、TTL 或裁剪。
- command fork 在同一 `BEGIN IMMEDIATE` 中精确验证 source checkpoint、克隆/rebind target 并写 scoped applied receipt；普通 fork 不写 receipt。
- State 26/Store 5 与 State 27/Store 5 (`kite-runtime-saq-v1-2026-08-25`) 都只读、no-follow、隔离复制并单向导入到 Store 6；Store 5 永远只是 source，不会被写回、checkpoint、rename 或作为 execution fallback。source 不改写，导入目标的 receipt 为空。
- 删除/close 保留 receipt，fork 不复制 receipt；只有删除整个 Store 才会移除它们。
- Host-owned `delete_session` transaction 在同一个 `BEGIN IMMEDIATE` 中删除该 Session 的 event、snapshot、
  named snapshot、Workspace file preimage、recovery identity 与 lease facts并写入 scoped applied receipt；receipt
  row 不随 Session facts 删除，因此 response 丢失后的 retry 不会重删或重建。

## 测试

`bun test packages/runtime-storage-sqlite/test`（当前90 pass；含Store7→Store8 generation/WAL/fault/active/corrupt/partial migration、Store8 production reopen/activation/recovery与Store7 negatives）

## 文档影响

模块局部变化更新本 README；格式、恢复或日志查询变化同时更新 [Runtime Authority](../../docs/active/runtime-authority-boundary.md) 和 [日志查询](../../docs/active/sqlite-runtime-log-query.md)。
