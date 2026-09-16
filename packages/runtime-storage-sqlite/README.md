# Runtime SQLite Storage

> 已确认设计，尚未实现：[会话存储兼容性与连续性 V1](../../docs/plans/session-store-compatibility-and-continuity.md)将统一正式数据入口并补齐受支持路径的自动转换和会话保留验收。下文仍描述当前实现；现有格式拒绝与开发 Profile 隔离不代表跨版本会话连续性已完成。


`@kite-ai/runtime-storage-sqlite` 是 Host storage port 的 SQLite concrete adapter。默认 App Server 的物理数据库由 Session Store owner 管理；历史 adapter 与迁移代码仍有独立消费者，不代表普通启动有多个可选 writer。

## 格式与实际入口

物理数据库版本、逻辑 State schema 与 Runtime wire 版本是不同对象。物理版本定义见 [kite-home-store](src/kite-home-store.ts)，逻辑格式常量见 [preflight](src/preflight.ts)，当前调用者见 [App Server](../../apps/kite-service/src/app-server.ts) 与 [Service storage composition](../../apps/kite-service/src/bootstrap.ts)。

| 范围 | 格式 | 实际用途 |
| --- | --- | --- |
| 默认 TUI/CLI child 与显式 daemon | `kite-session.sqlite`，Session Store 10，`kite-session-app-server-2026-09-02` | `openKiteSessionRuntimeStorage`；多连接、按 Session execution authority 写入 |
| 逻辑 Runtime State/Run | State 27 与 `SQLITE_RUNTIME_RUN_FORMAT_EPOCH` | 由 App 显式注入；不是 Session Store 的物理 schema/epoch |
| 旧单 Service | Home Store 9，`kite-home-single-service-v1-2026-08-30` | 显式旧 composition/测试；不能作为默认 child 或 daemon 的 fallback |
| Workspace Worker 布局 | Store 8，`kite-agent-server-api-v1-2026-08-29` | 保留的 Worker factory、布局验证及迁移机制；不属于默认 release 启动拓扑 |
| Workspace 前代布局 | Store 7，`kite-coordinator-workspace-worker-web-v1-2026-08-28` | 显式旧布局与离线迁移 source |
| 旧 Runtime adapter | Store 6，`kite-runtime-server-v1-2026-08-26` | 显式 legacy adapter/兼容导入 target；不是默认 App Server writer |
| 已知历史 source | State 26/Store 5、State 27/Store 5 | 仅经隔离只读 compatibility reader 导入显式 Store 6；不由当前 Session Store 自动导入 |

表中保留代码的存在不等于发布承诺。不得按任意版本号选择 fallback，也不得把物理 Store 10 的 epoch 写入逻辑 Session State 的 format 字段。

## 当前数据库与执行所有权

[文件 owner](src/kite-session-runtime-file.ts) 只接受 `kite-session.sqlite`：空文件在 `BEGIN IMMEDIATE` 内初始化，已有文件先只读读取 schema/epoch 并分类兼容性，再检查受支持的完整结构。当前只证明 schema 10 / `kite-session-app-server-2026-09-02` 可读写；同 epoch 较旧 schema 返回 `store_migration_required`（不提供自动迁移），未知 epoch、较新 schema、partial 或 corrupt 返回 `store_incompatible`。兼容性错误携带实际与预期 schema；拒绝发生在读写打开前。不能用数字范围或仅能解析历史来声明完整 Runtime 只读兼容。它不自动探测、导入或改写 `kite.sqlite`。

[Session runtime storage](src/kite-session-runtime-storage.ts) 为各 WAL connection 提供执行 scope。[execution authority](src/kite-session-execution-authority.ts) 持久保存 generation、revision、lease deadline 与 cleanup 状态，acquire/renew/detach/release 使用 SQLite CAS。fresh Session 的 generation 1 与 Session 创建同事务；过期且 cleanup 未确认的 owner 进入恢复边界，不能直接重放。

[mutation port](src/kite-session-mutation.ts) 在同一 `BEGIN IMMEDIATE` 内重读 execution binding、authority revision、lease deadline 与 Session revision，再执行 callback。Session/event/snapshot、命名与模型、delete、checkpoint/rewind/fork、Run、recovery 和 typed Artifact 的写入受同一 fence 约束。read/list 不获取执行 lease；读取一致性不能代替写入资格。

[effect port](src/kite-session-effects.ts) 绑定 attempt lease revision、Session generation 和 Host/client/connection identity。外部 dispatch 前重验 binding；receipt-bearing State commit 同事务结算 effect。unknown effect 不允许重新 prepare/dispatch/terminal；reconcile、遗留 prepared→unknown 与 cleanup confirmation 按 owner 事务处理。prepared effect 尚存时拒绝 clean release。

## 数据、事务与读取

- command receipt 主键为 `(scope_session_id, command_id)`，绑定 digest 与原决定；applied receipt 与事件、State/snapshot 同事务。close/delete 保留 receipt，fork 不复制 source receipt；无 TTL 或容量裁剪。
- Run insert/transition 与所属 State/event/receipt 提交一致。start 后的 queued→running row-only activation 可以复用相同 State revision；其他 transition 仍按 revision/lifecycle 校验。Run list 使用稳定 keyset，单页最多 200 项。
- rewind 只在允许的 coverage/between-turn 边界修改；fork 克隆 checkpoint 范围内可复制的终态 Run，重绑 identity。target facts、receipt 与初始 authority 在同一事务，任一步失败整体回滚。
- Directory、History、Checkpoint 与 Agent API 复用已打开 owner 的有界 read ports，不建立 Catalog mirror 或第二 writer。Directory 不返回 canonical path；空会话名的首条用户消息 fallback 只读、不写回命名事实。
- Artifact 按 Model/Plan/Capability/filesystem preimage/Sandbox/Subagent 领域存储，不建立通用 blob authority。当前 Session Store 因缺少安全 maintenance barrier 而禁用 Artifact GC，不能把旧 Home Store 的 GC 接到普通 Session 读取。

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

App Server 打开可变 Store 前，通过 [Session 文件 preflight](src/kite-session-runtime-file.ts) 只读检查现存格式；release restart 复用同一检查，失败时不停止旧实例。不兼容文件保持原样，不在普通启动迁移；absent preflight 不创建文件。


当前启动先核对文件安全、格式与精确 schema，不扫描所有会话正文。Session snapshot 读取在同一只读事务内校验该会话的绑定、事件顺序／codec、snapshot checksum／revision、Run 与 receipt；损坏会话不阻止先列出目录。Artifact 内容由 typed reader 在访问时验证。完整 physical/FK 扫描保留于显式文件 preflight，不能在每个组合 reader 创建时重复执行。实现与测试见[事务与状态](docs/transactions-and-state.md)。
