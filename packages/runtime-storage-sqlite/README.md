# Runtime SQLite Storage

> 当前物理格式为 Store13；已验证的旧 Store9/10/11/12 先在私有候选副本中逐级转换并校验，再发布到普通 App Server。原 Session ID、State、Event 和 History 保留，旧文件不原位改写。未知或未证明的格式明确拒绝。状态见[会话存储兼容性与连续性 V1](../../docs/plans/session-store-compatibility-and-continuity.md)。


`@kite-ai/runtime-storage-sqlite` 是 Host storage port 的 SQLite concrete adapter。默认 App Server 的物理数据库由 Session Store owner 管理；历史 adapter 与迁移代码仍有独立消费者，不代表普通启动有多个可选 writer。

## 格式与实际入口

物理数据库版本、逻辑 State schema 与 Runtime wire 版本是不同对象。物理版本定义见 [kite-home-store](src/kite-home-store.ts)，逻辑格式常量见 [preflight](src/preflight.ts)，当前调用者见 [App Server](../../apps/kite-service/src/app-server.ts) 与 [Service storage composition](../../apps/kite-service/src/bootstrap.ts)。

| 范围 | 格式 | 实际用途 |
| --- | --- | --- |
| 开发工作树的默认 TUI/CLI child 与显式 daemon | `kite-session.sqlite`，Store13 候选，`kite-session-cross-followup-2026-09-25` | `openKiteSessionRuntimeStorage`；多连接、按 Session execution authority 写入；D3 TriggerTurn 与直接子停止已通过受控正式入口验收 |
| 逻辑 Runtime State/Run | State 27 与 `SQLITE_RUNTIME_RUN_FORMAT_EPOCH` | 由 App 显式注入；不是 Session Store 的物理 schema/epoch |
| 旧单 Service | Home Store 9，`kite-home-single-service-v1-2026-08-30` | 显式旧 composition/测试；不能作为默认 child 或 daemon 的 fallback |
| Workspace Worker 布局 | Store 8，`kite-agent-server-api-v1-2026-08-29` | 保留的 Worker factory、布局验证及迁移机制；不属于默认 release 启动拓扑 |
| Workspace 前代布局 | Store 7，`kite-coordinator-workspace-worker-web-v1-2026-08-28` | 显式旧布局与离线迁移 source |
| 旧 Runtime adapter | Store 6，`kite-runtime-server-v1-2026-08-26` | 显式 legacy adapter/兼容导入 target；不是默认 App Server writer |
| 已知历史 source | State 26/Store 5、State 27/Store 5 | 仅经隔离只读 compatibility reader 导入显式 Store 6；不由当前 Session Store 自动导入 |

表中保留代码的存在不等于发布承诺。不得按任意版本号选择 fallback，也不得把物理 Store13 的 epoch 写入逻辑 Session State 的 format 字段。

阶段 D0 已确认每个子 Agent 需要独立持久 Session。Store11 增加 `runtime_sessions.parent_session_id`、根 Session 查询过滤和父 Tool 意图约束下的原子子 Session 创建。父 dispatch ACK、子首轮预算激活和有界恢复查询已有 Store primitive，Service 的完整创建／结果桥接与跨线程恢复仍在验收。同 Session 的 Agent 邮箱仍是未开放候选。Store10→11 候选转换与多来源发布保留旧根会话 ID、State/Event 和历史读取；普通启动对已验证格式执行准备，未知格式不清空旧库。准确格式与完整性证明见[方案 §4.0](../../docs/plans/background-agent-shell-conversation-coordination.md)。

激活后、父 dispatch ACK 前的子 Session 可按 `activated_no_ack` 结算失败，但 Store 只接受 revision 5 的五个激活事件（末条为固定通用标签的 `task.started`）、唯一 queued Run、空 effect lease、已清理的 idle 执行权和不存在 ACK；检查与父失败 receipt 原子 CAS，任何额外工作证据都会拒绝。Store11 仍是未发布候选。

## 当前数据库与执行所有权

[文件 owner](src/kite-session-runtime-file.ts) 只接受 `kite-session.sqlite`：空文件在 `BEGIN IMMEDIATE` 内初始化，已有文件先只读读取 schema/epoch 并分类兼容性，再检查受支持的完整结构。普通可变打开只接受准确 Store13 epoch；旧 Store10/11/12 经独占维护、备份、私有候选逐级转换及内容校验后发布，不原位升级。未知 epoch、较新 schema、partial 或 corrupt 返回 `store_incompatible`。兼容性错误携带实际与预期 schema；拒绝发生在读写打开前。不能用数字范围或仅能解析历史来声明完整 Runtime 只读兼容。它不自动探测、导入或改写 `kite.sqlite`。

[Session runtime storage](src/kite-session-runtime-storage.ts) 为各 WAL connection 提供执行 scope。[execution authority](src/kite-session-execution-authority.ts) 持久保存 generation、revision、lease deadline 与 cleanup 状态，acquire/renew/detach/release 使用 SQLite CAS。fresh Session 的 generation 1 与 Session 创建同事务；过期且 cleanup 未确认的 owner 进入恢复边界，不能直接重放。

[mutation port](src/kite-session-mutation.ts) 在同一 `BEGIN IMMEDIATE` 内重读 execution binding、authority revision、lease deadline 与 Session revision，再执行 callback。Session/event/snapshot、命名与模型、delete、checkpoint/rewind/fork、Run、recovery 和 typed Artifact 的写入受同一 fence 约束。read/list 不获取执行 lease；读取一致性不能代替写入资格。

[effect port](src/kite-session-effects.ts) 绑定 attempt lease revision、Session generation 和 Host/client/connection identity。外部 dispatch 前重验 binding；receipt-bearing State commit 同事务结算 effect。unknown effect 不允许重新 prepare/dispatch/terminal；reconcile、遗留 prepared→unknown 与 cleanup confirmation 按 owner 事务处理。prepared effect 尚存时拒绝 clean release。

## 数据、事务与读取

- command receipt 主键为 `(scope_session_id, command_id)`，绑定 digest 与原决定；applied receipt 与事件、State/snapshot 同事务。close/delete 保留 receipt，fork 不复制 source receipt；无 TTL 或容量裁剪。
- Store 11 的 Agent tree、私有 mail body、按 Session 顺序的 inbox 及 prepared 水位复用同一 Session 事务；显式 `send_message` 的确定性 `messageId` 是 command receipt key，正文只存于私有表。metadata-only Agent 读取按同一 Session 祖先／后代树范围过滤；正文只通过当前执行 handle、准确活动 task 与模型输入 invocation 绑定的窄接口交给可信 Service，不经普通列表暴露。
- 上一条是未发布的单 Session 候选机制。D0 的子线程必须各自持有 execution authority 和 revision；父创建意图、子终态 outbox、父结果接纳／投递 receipt 分属各自 Session 事务，跨线程投递按确定性身份重放。候选私有 Artifact/ref 规则可复用，不能把同 Session mail mutation 直接当成跨线程原子协议。
- Run insert/transition 与所属 State/event/receipt 提交一致。start 后的 queued→running row-only activation 可以复用相同 State revision；其他 transition 仍按 revision/lifecycle 校验。Run list 使用稳定 keyset，单页最多 200 项。
- rewind 只在允许的 coverage/between-turn 边界修改；fork 克隆 checkpoint 范围内可复制的终态 Run，重绑 identity。target facts、receipt 与初始 authority 在同一事务，任一步失败整体回滚。
- Directory、History、Checkpoint 与 Agent API 复用已打开 owner 的有界 read ports，不建立 Catalog mirror 或第二 writer。Directory 不返回 canonical path；空会话名的首条用户消息 fallback 只读、不写回命名事实。
- D0 候选的 `runtime_sessions.parent_session_id` 是父血缘字段（根为 NULL、子为准确父 Session ID），有外键／身份校验。Directory、History 搜索与最近会话、Workspace/Space 分页以及旧 `sessions.listSessions` 已在 SQL 的排序、游标与 LIMIT 之前过滤根 Session；Store 公共日志读取和 Service 普通顶层详情拒绝已知子 ID。父 Agent 树授权的子详情入口及其恢复验证仍待完成。
- Artifact 按 Model/Plan/Capability/filesystem preimage/Sandbox/Subagent 领域存储，不建立通用 blob authority。当前 Session Store 仍禁用 Artifact GC，不能把旧 Home Store 的 GC 接到普通 Session 读取。

详细机制与测试入口：[事务与数据](docs/transactions-and-state.md)、[Writer/Effect/恢复](docs/authority-and-recovery.md)、[查询与 Artifact](docs/queries-and-artifacts.md)。

## 非默认 adapter 与离线迁移

以下规则仅约束实际选择这些旧 profile 的调用者，不用于默认 App Server 打开和恢复：

- [adapter](src/adapter.ts) 管理 Store 6/7/8 lifecycle。Store 7 必须有完整 Workspace/layout binding；Store 8 的 Run port 复用调用者已拥有的同一 connection，不能创建第二 writer。各 profile exact preflight 相互拒绝，不自动升级。
- [compatibility](src/compatibility.ts) 对已知 Store 5 使用 no-follow 隔离副本、选定 Session 原子导入与 tombstone；source 不写回、不 checkpoint、不 rename、不用于执行 fallback。未知/损坏来源不能影响其他 Session。
- [Store 6→7 migration](src/migration.ts) 要求源服务停止、source-bound fence、可验证 Workspace ownership resolver。Catalog builder 由调用者注入；完成所有 Store、metadata Catalog、manifest 与 journal 验证后才切换 pointer。
- [Store 7→8 migration](src/run-migration.ts) 要求整个 generation 的进程、交互、effect 和外部进程已收敛；复制 event/snapshot/receipt 等事实，目标 Run 索引初始为空，coverage 固定 source head。损坏、活动、未知 scope 或 WAL 漂移整体拒绝，旧 source 保持只读。
- 首次真实 mutation 永久标记 layout written；此后禁止回源。重启按 owner、profile、binding 和原始 admission digest 验证，不把变更后的 live DB 字节与首次写前 digest 比较，不重设原始 digest。
- Worker 的 same-connection 有界查询与 offline pinned snapshot reader 是独立接口；后者还验证 layout/pointer/fence，不得接回普通 daemon Browser History。

这些迁移 primitive 不由正式 CLI 或 release entrypoint 自动调用。维护旧机制时读对应源码和测试，不从旧阶段编号推断当前产品能力。

## 依赖与公开入口

只允许依赖 `@kite-ai/runtime-host` 的 `/storage` port，不导入 Kernel/Builtin domain 类型。公开 package 根入口为 [src/index.ts](src/index.ts)；不提供 alternate driver、dual write 或自动执行 fallback。

## 验证与维护

`bun run --cwd packages/runtime-storage-sqlite test`。测试分别验证 Session Store、多进程 generation、旧 Home Store、Run 与迁移 profile；某个旧 profile 的测试通过不证明它是当前生产入口。

当前文件格式：[Session file tests](test/isolated/kite-session-runtime-file.test.ts)；业务机制见上述三个专题，完整测试目录见 [test](test)。格式、恢复或日志语义变化同步 [Runtime Authority](../../docs/active/runtime-authority-boundary.md) 和[日志查询](../../docs/active/sqlite-runtime-log-query.md)。产品预期从[开发入口](../../docs/development/README.md)定位对应手册。

App Server 打开可变 Store 前先调用[启动准备](src/kite-session-store-preparation.ts)，只对准确已知格式执行维护锁、来源备份、私有候选转换、旧行摘要与连续性校验，再发布 Store13；随后[Session 文件 preflight](src/kite-session-runtime-file.ts)只读核对当前格式。release restart 复用这些检查，失败时不停止旧实例。未知不兼容文件保持原样；absent preflight 不创建文件。旧会话通过原 Session ID 与 History 读取，不清空用户配置、凭据或信任资料。


当前启动先核对文件安全、格式与精确 schema，不扫描所有会话正文。Session snapshot 读取在同一只读事务内校验该会话的绑定、事件顺序／codec、snapshot checksum／revision、Run 与 receipt；损坏会话不阻止先列出目录。Artifact 内容由 typed reader 在访问时验证。完整 physical/FK 扫描保留于显式文件 preflight，不能在每个组合 reader 创建时重复执行。实现与测试见[事务与状态](docs/transactions-and-state.md)。


## 已知会话格式的启动准备

[准备编排](src/kite-session-store-preparation.ts)由普通 App Server 在 owner 打开前调用。它在迁移期取得 canonical 与全部历史源的独占锁，调用方须提供旧 writer 准入，再以[一致性备份](src/kite-session-recovery-backup.ts)和[私有候选](src/kite-session-store-candidate.ts)处理已证明的 9/10/11/12 格式。准确 Store10→11→12→13 转换只对私有候选执行；旧表内容摘要与目标 schema 的完整转换证明必须通过，原位 main/WAL 保持一致，不接受遗漏非空 WAL 来源。

[连续性校验](src/kite-session-continuity-validation.ts)只在维护期完整检查生产Session、目录、State/Event、Run/receipt、Fork、tombstone和Artifact读取；普通启动不全扫历史。[发布](src/kite-session-store-publication.ts)使用固定短期意图和逐文件指纹恢复同文件系统发布，保留原文件作私有恢复资产；生产reader复核之前不开放正常连接。普通owner取得共享维护锁后，先复查待发布意图及未归并历史源，再打开或创建正式库，并持锁至关闭；准备器取得独占锁后也重新读取意图，不能以锁外的旧观察启动另一次发布。调用方仍须独立证明旧writer已退出及正常入口已参与维护；这些Storage函数不授予进程准入。当前平台与发行资格见[实施计划](../../docs/plans/session-store-compatibility-and-continuity.md#17-启动准备与四源收敛集成2026-09-17)。

受支持的AppServer 9/10/11来源将模型、计划、能力结果、文件前像、沙箱准备及三类子任务Artifact存入SQLite的八个专属表；`runtime_file_preimages`也保留文件前像内容。正式Service为这些Builtin读写器注入数据库后端，不使用缺省文件目录作为另一资产权威。迁移逐表保留内容，并验证State/Event和命名快照中已知字段的引用；已知引用缺失或损坏会拒绝候选发布。此校验不是任意嵌套内容或外部路径扫描，Store备份不代表外部工作区文件、技能、配置、日志或任意附件文件也已备份。其他历史入口若依赖外置资产，必须另有来源证据与明确处置，不能套用这组资格。
