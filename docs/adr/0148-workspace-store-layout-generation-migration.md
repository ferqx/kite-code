# ADR-0148：Workspace Store 分片布局、Generation 迁移与旧 Writer Fence

状态：accepted

日期：2026-08-28

决策者：用户直接指令

相关：ADR-0138、ADR-0142、ADR-0144、ADR-0147，
[`Kite Coordinator、Workspace Worker 与唯一 Web Gateway V1 方案`](../space/plans/2026-08-28-kite-coordinator-workspace-worker-web-v1.md)。

## 背景

当前 production writer 是 State 27 / Store 6 /
`kite-runtime-server-v1-2026-08-26`。它由 `apps/kite-service` 的单一 Service composition 打开；当前
`runtime_command_receipts` 只绑定 `(scope_session_id, command_id)`，`runtime_sessions` 删除后迟到 receipt
没有独立、可验证的 Workspace 归属。当前 schema 没有 `session_workspace_tombstone`，也没有
`active-layout` generation、post-switch fence 或阻止旧 binary 重开 legacy global writer 的 migration fence。

KCWW-07 要把一个 global Runtime Store 离线分片为 global metadata Catalog 与每 Workspace 一个 Runtime Store。
这不是在线 schema 漂移，也不是兼容 source import。必须先冻结 target profile、deleted Session 的 Workspace binding、
copy-and-switch、journal、pointer、fence 与不可自动回退规则；在实现和验证完成前，当前 Store 6 与当前 Service authority
继续有效。

## 决策

### 1. Next Store profile

KCWW-07 的唯一 target Runtime Store profile 固定为：

```text
stateSchemaVersion = 27
storeSchemaVersion = 7
formatEpoch        = kite-coordinator-workspace-worker-web-v1-2026-08-28
```

State 27 event、snapshot、Kernel codec 与 Runtime semantics 不因本 ADR 改写。Store 7 是新的 exact writer
profile；Store 6、State 26/Store 5 与 State 27/Store 5 都是 source-only/历史 profile，不能成为 Store 7 writer、
在线 fallback、双写或 receipt fallback。所有 Store 7 header、Session row、receipt 与 tombstone 必须拒绝缺失、额外、
错误类型或错误 profile 字段。

Global Catalog 是独立的 routing metadata database，不是 Runtime Store，也不共享 Runtime receipt/State/event authority。
其 schema/epoch 由 Catalog owner 单独严格校验；它只保存 `sessionId`、`workerScopeId`、`directoryRevision`、
`updatedAt`、`routingGeneration` 与 bounded tombstone/routing state，不保存 title/summary/status、Session正文、
Runtime event、Controller lease、effect/recovery、credential、Workspace path、Store path 或 raw diagnostic。

### 2. Store 7 schema binding

Store 7 保留当前八张 Runtime 表和当前两个非主键索引的语义，并作下列明确变更：

1. `runtime_store_meta` 必须包含并严格验证 `format_version=7`、上述 `runtime_format_epoch`、当前 immutable
   `layout_generation`、`worker_scope_id` 与 `workspace_identity_digest`。后两者是 WorkerScopeId 与完整 canonical
   WorkspaceIdentity 的 digest-only binding；Store 不以目录名或调用方输入推断归属。
2. `runtime_sessions` 每一行新增并绑定 `worker_scope_id` 与 `workspace_identity_digest`，并继续保存现有
   `project_id`、`workspace_digest`、revision、model route 等 Session metadata。Session State 的 Workspace identity、
   Store header binding 与当前 Worker admission 必须逐项相等。
3. `runtime_command_receipts` 每一行新增并绑定 `worker_scope_id`、`project_id` 与 `workspace_digest`；receipt 仍以
   `(scope_session_id, command_id)` 为主键，仍保留原 request digest、target Session、canonical applied receipt、
   committed revision/time。删除后 retained receipt 不能因为 Session row 消失而失去 Workspace binding。
4. 新增第九张表 `session_workspace_tombstone`，主键为 `session_id`，字段固定为
   `worker_scope_id`、`project_id`、`workspace_digest`、`deleted_revision` 与 `deleted_at`。Session delete 必须在同一
   Store transaction 中写入 tombstone、保留 receipt 并删除 Session facts；receipt 与 tombstone 的 Session、WorkerScope、
   project、Workspace digest 或 revision 关系不一致时，读取、重放和迁移全部 fail closed。
5. Event、snapshot、named snapshot、file preimage、effect lease 与 Runtime command receipt 的原子 transaction 语义继续
   不变；Store 7 不增加 sidecar receipt database、隐式 DDL、TTL/capacity pruning 或第二 writer。tombstone 只能由
   Worker-owned delete transaction 写入，不能由 Coordinator、Gateway、Browser 或 SQLite query reader 补造。

Store 7 的物理写入必须由一个 Worker 持有；WorkerScopeId、WorkspaceIdentity digest、LayoutGeneration 与 Store profile
   在 readiness、Catalog register、History query、recovery 与每次 reopen 时重新验证。不同 Worker 不能以 reader/writer
   方式打开对方 Store；Browser、TUI、Desktop 与 Coordinator 不直接打开 Store。

### 3. Offline full copy-and-switch

迁移只允许按以下顺序执行，不能边运行 Worker 边搬运，也不能把一部分 source 当作已经成功：

1. 建立显式 maintenance barrier，拒绝新的 Client、Controller、Runtime mutation 与 Store writer；要求 active Turn、pending
   interaction、external process 与 unknown effect 已结算。无法收敛时整体 blocked，不 force kill。
2. 停止当前唯一 Service，并以 descriptor、access/control token、instance lock、lifecycle lock 与 process identity 证明
   source owner 完全 absent。只看 PID、descriptor 或 Store path 不足以通过。
3. 在固定 Kite home 建立 owner-only、no-follow、source-bound migration fence。Fence 绑定 source Store identity/digest、
   source profile、target LayoutGeneration 与 migration nonce；从 fence 写入到迁移提交，所有受支持旧 manager/binary 必须
   fail closed，不能重新 ensure 或打开 legacy global writer。
4. 以 current Store 6 的 persisted Session State、snapshot、event、receipt 与完整 Workspace identity 确定性分区。每个
   Session 必须获得完整且一致的 WorkerScopeId、projectId、workspaceDigest 与 canonical WorkspaceIdentity digest；不得通过
   compatibility import、title、当前 cwd、Catalog 猜测归属。
5. 为每个 Workspace 创建新的 Store 7 target，写入并验证 Store header binding，复制完整 State/Event/Receipt/Snapshot、
   named snapshot、preimage、effect/recovery evidence；deleted Session retained receipt 必须同时创建匹配的
   `session_workspace_tombstone`。复制不是跨 Store 原子事务，任何未完成 target 都不能被 Catalog 暴露。
6. 逐 Workspace 验证 Session 数、event sequence、receipt 主键/digest、snapshot position/checksum、tombstone binding、
   State/Store profile、WorkerScope 与 content digest；再构建只含 metadata 的 Catalog 并验证 Catalog digest。
7. 创建完整 immutable LayoutGeneration manifest 与 post-switch write fence，原子替换单一 `active-layout` pointer。Pointer
   只能指向已验证的 `<kite-home>/layouts/<generation>`，不能指向任意 caller path、symlink/reparse 或不完整 target。
8. 新 Worker 只能在 pointer、manifest、Catalog、全部 Store 7 header 与 post-switch fence 验证后 readiness；全部 target ready
   且 reconcile 完成后才解除 fence。旧 Store、旧 sidecar 与旧 layout 保留 immutable/read-only evidence，绝不 dual write、
   receipt fallback 或 silent Runtime fallback。

### 4. Journal、active-layout 与 write fence

Migration journal 是 owner-only、no-follow、原子发布的 transition evidence，不是第二 Store authority。journal 至少固定记录：

```text
schema
sourceStoreIdentity
sourceStoreDigest
sourceProfile
targetLayoutGeneration
targetCatalogDigest
workspaceStoreDigests
pointerPhase
targetWriteState
migrationNonce
```

`pointerPhase` 必须能区分 `source_active`、`target_prepared`、`pointer_switched`、`target_ready`、`committed` 与
`blocked/unknown`；`targetWriteState` 至少区分 `none` 与 `written`。journal、pointer、generation manifest、Catalog 与
每个 Worker Store 的 digest/owner binding 任一不一致，都使启动/recovery 停止所有 writer，不得从最接近的阶段猜测继续。

`active-layout` 是 steady-state 唯一 generation authority。Catalog 或任一 Worker Store 的第一次新写入必须在同一
generation evidence 中把 `targetWriteState` 原子标为 `written`；标记后禁止任何自动回退或同时启动 source/target writer。
pointer 已切但 target 不完整、旧 fence 未确认或 phase unknown 时，所有新 routing、writer、Worker replacement 与旧 writer
都必须 blocked，直到显式 recovery 得到可验证结论。

### 5. Unknown/corrupt/unowned 的整体阻断

以下任一事实使整个 migration blocked，source 不得 in-place 修改，target 不得成为 active，Catalog 不得发布部分 routing：

- 任一 Session 缺失 Workspace identity、WorkerScope binding、project/digest 或 canonical identity 无法重算；
- 任一 event、snapshot、receipt、tombstone、WAL/SHM 或 Store marker/schema 损坏、unknown 或无法完整验证；
- 任一 receipt 没有可验证的 Workspace binding，或 receipt 与 tombstone/Session facts 不一致；
- 任一 Session/receipt 无法归属唯一 Workspace/Worker，或存在重复/冲突的 WorkerScope identity；
- source/target/Catalog/journal/pointer/fence 的 phase、digest、owner、generation 或 write state 不确定；
- 任一旧 writer、Worker、external process 或 effect identity 的终止/收敛无法确认。

“坏会话只隔离会话”的 current read-only log-query 语义不适用于 Store sharding cutover：迁移要求全量 ownership 与 receipt
证据；未知、损坏、无归属必须整体停止，不能伪装为 corrupt 后丢弃，也不能由 Coordinator 成为 data-plane fallback。

### 6. 回退与旧 binary fence

回退只有两个窄窗口：

1. `active-layout` 尚未切换且 target 未写入：可丢弃不完整 target，保留 source；
2. `active-layout` 已切换但所有 target/Catalog 均明确 `targetWriteState=none`：可按 journal 与 pointer evidence 原子切回
   source，并继续保持 source/target 单 writer fence。

pointer 切换后任一 Catalog 或 Worker Store 产生新写入，旧 global Store 没有这些 event、receipt 或 effect outcome，因而禁止
   自动回退。任何 unknown phase、旧 fence 丢失、target write state 不确定或 source/target 同时可写，都只能进入 blocked
   recovery；不得启动 legacy Worker 与 Workspace Worker 的并行兼容模式。

旧 manager/binary 的 migration fence 检查必须在 legacy Store open/write 前执行。旧入口不能通过删除 marker、切换 cwd、使用
   旧 `--kite-home`、读取旧 descriptor 或直接重建 Store 来获得受支持的 migration writer；本 ADR 不声称抵御同一 OS 用户
   恶意绕过受支持 launcher 直接修改文件，但受支持 release 必须在 fence 存在时 fail closed。

## 实现与验证边界

本 ADR 已接受 target profile 与 migration contract，但不表示 Store 7、Catalog、migration tool、fence、Worker 或 Web 已实现。
KCWW-07 implementation pending；在其完成前，Store 6、当前 Service composition、当前 History query 与当前 release authority
继续是唯一实现事实。实现必须补齐 Store 7 DDL/preflight、tombstone/receipt transaction、逐 Session full validation、journal/pointer
crash windows、old-binary fence、target-first-write rollback、三平台 filesystem evidence 与 migration fault tests；任何本地
通过结果都不能替代远端平台 evidence。

## 回滚

在 pointer 切换前可以删除未写入 target 并保留 source；pointer 切换后只能依据 journal、fence、target write state 与全部
identity/digest evidence 执行上述窄回退。不得通过回退代码恢复 Store 6 writer、兼容 source import、双写或 silent fallback。
Store 7 target 已有新写入、phase unknown、receipt/unowned/corrupt 证据或旧 writer 未确认终止时，保持所有 writer blocked，
由新的显式 recovery decision 处理，不做自动清理。
