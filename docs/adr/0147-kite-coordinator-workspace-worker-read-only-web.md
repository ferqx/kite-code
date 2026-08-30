# ADR-0147：Kite Coordinator、Workspace Worker 与本地只读 Web Gateway V1 边界

状态：accepted

日期：2026-08-28

决策者：用户直接指令

相关：ADR-0053、ADR-0129、ADR-0138、ADR-0140、ADR-0141、ADR-0142、ADR-0143、ADR-0144、ADR-0145、ADR-0146，
[`Kite Coordinator、Workspace Worker 与唯一 Web Gateway V1 方案`](../space/plans/2026-08-28-kite-coordinator-workspace-worker-web-v1.md)。

## 背景

当前实现仍由 `apps/kite-service` 以一个 concrete Host、一个 Runtime Store 和一个 Service composition 承载多个
Workspace；`apps/kite-cli` 通过 Native client 连接该 Service。当前 Store 是 State 27 / Store 6 /
`kite-runtime-server-v1-2026-08-26`，已有 History query 与 safe presentation projector，但不存在 Coordinator IPC、
Workspace Worker 分片或 production Web Gateway。该事实在 KCWW-00 之后仍保持有效，直到对应阶段通过 Gate 并完成切换。

本 ADR 接受一个后续可分阶段实施的 control-plane/worker-shard 拓扑，同时冻结 Web V1 的产品边界。它是架构决策，不把尚未
实现的 Coordinator、Worker、Gateway 或 Store migration 描述成当前行为。

## 决策

### 1. Control plane 与 Worker authority

1. 一个 canonical Kite home 最多一个 Local Coordinator；Coordinator 只拥有 Worker 定位、可重建的 Session Directory
   routing mirror、Gateway registry、Worker capability request relay 与受管生命周期编排。
2. 一个 canonical Workspace 同时最多一个 active Workspace Worker。Worker 是该 Workspace 的 Runtime Host、Runtime Store、
   Session mailbox、Controller lease、interaction、effect/recovery 与 Workspace-local config/MCP/Sandbox/Git authority；
   同一 Workspace 不得出现第二 Store writer 或第二 Runtime Host。
3. Global Catalog 只保存可重建的 routing metadata（Session/Worker scope、directory revision、更新时间与 tombstone/generation）。
   它不保存 Session 正文、Runtime event、Controller lease、effect/recovery、credential、Workspace/Store path 或 raw diagnostic。
4. Coordinator 不代理 Runtime data plane，不拥有 Controller lease、Session state、receipt、effect recovery 或 capability 签发密钥。
   TUI/Desktop 取得 Worker 签发的短期、hash-only、一次性 capability 后直连目标 Worker；Worker 之间不通信、不复制 Session、不做
   federation。
5. Workspace identity 在 Coordinator admission 与 Worker 启动时都重新 canonicalize，并复用 Runtime Host 的唯一
   `resolveProjectIdentity()` 语义。cwd、wire path、client metadata、Web 输入或 Catalog entry 都不能提升或改绑 Workspace authority。

### 2. Store 与迁移边界

1. steady state 使用一个 global metadata Catalog 加每 Workspace 一个 Runtime Store。Web、TUI、Desktop、Coordinator 都不能直接打开
   Worker Store；Store/Host 仍是 Session State、event、receipt、snapshot、interaction 与 recovery evidence 的事实源。
2. 当前 State 27 / Store 6 writer 不能通过隐藏 DDL、sidecar、双写或兼容 fallback 直接变成分片 Store。删除 Session 后仍需可验证地
   归属迟到 receipt；receipt 的 Workspace binding、`session_workspace_tombstone`、新 schema/profile/epoch 与 copy-and-switch 细节，
   必须由独立 Store migration ADR 冻结后才能修改 current schema 或开始 KCWW-07。
3. migration 只能在明确 maintenance barrier 下进行 offline generation copy-and-switch；source immutable 保留，未知/损坏/无归属
   Session 或 receipt 使迁移 blocked；target 产生新写入后禁止自动回退。任何 current Store reader、History query 或 Gateway adapter
   都不得通过兼容源导入来补齐或改变 Directory/History 事实。

### 3. Web Gateway 与永久只读 Observer V1

1. 一个 canonical Kite home 最多一个 Web Gateway，只有 `kite-code web` 可以 ensure/discover/stop；Gateway 是 browser BFF，不能
   内嵌到每个 Worker。Gateway 与 Browser 均不取得 Controller、Controller resume、DetachedRecovery 或任何 mutation authority。
2. Browser 只能连接 Gateway。Gateway 为每个 tab 建立独立、递增 generation 的 Observer binding，并以 Worker 的 read-only capability
   代理 Workspace/Session Directory、safe durable History、Session projection、running Session presentation stream 与主动断连。
   Browser refresh、tab close、BFCache、Gateway crash 或 slow reader 只释放/关闭该 Observer binding，不取消 Turn/effect、不释放或
   改变 Controller。
3. Web V1 的闭集能力永久限于：按 Workspace/project-space 分组的已有 Session 列表、选中 Session 的消息/History、running Session
   的 browser-safe live presentation stream、unsubscribe/disconnect 与连接/resync 状态。禁止 prompt、Session create、approval/input
   reply、request/release/resume Controller、cancel、interrupt、rewind、fork、mode/config mutation、filesystem/SQL/raw Runtime command。
   隐藏按钮不是安全边界；Gateway 与 Worker allowlist 必须同样拒绝这些 use case。未来若要增加 Web 控制面，必须新增 ADR，不得用
   feature flag 或隐藏 route 扩展本 ADR。
4. Browser-safe Directory DTO 必须 path-free：不得携带 Workspace absolute path、Store path、Worker endpoint、capability、Native token、
   credential、raw diagnostic 或可用于重新选择 Workspace authority 的输入。按 canonical Workspace/project-space 分组使用稳定、无路径的
   opaque identity/安全展示 metadata；Worker/Coordinator 内部仍以完整 canonical identity 做复核。
5. Gateway 的 static/bootstrap/query/stream contract 必须是 closed exact schema。Gateway 不透明转发 Runtime Protocol、rich TUI event 或
   raw Runtime event；History 与 live presentation 必须复用同一 browser-safe projection/reducer 语义，并在 gap/overflow 时显式 resync。
   Gateway 不读取 SQLite，不把 Session Logger、JSONL、trace 或历史 compatibility source 当作 query fallback。
6. Browser auth、Gateway-native capability 与 Worker capability 分属不同 credential namespace。launch token 仅在 Gateway 内存中一次性消费；
   cookie 只证明 browser session，不证明 tab identity 或任何 mutation authority。loopback、Host/Origin、Fetch Metadata、CSP、cookie
   lifetime、backpressure、diagnostic non-disclosure 与 dead-only recovery 必须沿用当前安全边界。

### 4. 当前 authority 与 release 边界

1. Runtime Kernel、Runtime Host、Runtime Protocol/Client/Server、SQLite safe query/projector、Workspace Trust、receipt/unknown recovery、
   single-writer 与 no-generic-RPC/no-remote/no-silent-fallback 约束继续有效。此 ADR 不允许 Coordinator/Web 取得第二 Runtime authority，
   不允许 Web 直读 SQLite，也不允许绕过 existing credential、loopback、Trust、recovery 或 destructive-action boundary。
2. Coordinator、Worker、Gateway 与 Web assets 必须由同一 immutable release bundle 提供，但每个 running process 固定其启动 build；安装、
   pointer 切换或某一进程断连不得静默 kill active Worker/Turn。incompatible、alive/uncertain、partial response 与 `outcome_unknown`
   一律保持 fail closed，并按 query/recovery 处理，不自动重放 spawn、capability、prompt、approval 或 effect。
3. ADR 接受只授权后续 KCWW tranche 的实现顺序，不授权 production cutover。KCWW-00 的 baseline/relocation manifest、KCWW-07 的 Store
   migration ADR 以及 KCWW-09 的文档、fault、release 与平台 evidence 未完成前，当前 Service/Store authority 不能被删除或静默改写。

## 局部替代关系

- 部分替代 ADR-0053 第 3 项关于本地 Web 的 No-Go：只允许本 ADR 定义的同一用户、loopback、单 Gateway、browser Observer-only Web V1；
  hosted、多用户、remote/LAN、跨设备控制、服务端 credential custody 与无人值守共享 writer 仍 No-Go。
- 部分替代 ADR-0129 关于当前阶段不创建 HTTP/SSE/Web UI 的局部限制：SQLite 仍是唯一可回放事实源，`RuntimeLogQueryPort`、safe projector、
  query-only reader、无 raw event/Artifact locator 与无 compatibility fallback 的边界不变。
- 部分替代 ADR-0142 第 5、6 节的 single-Workspace Server 与 Web non-production 局部结论：Worker 可按 Workspace 分片，Gateway 可提供本地
  Observer-only BFF；Protocol/Server/Client、History、receipt、唯一 execution authority、no generic RPC 与 no remote 结论不变。
- 部分替代 ADR-0144 关于一个全局 Service/Host/Store 承载多个 Workspace 的 production topology；single local OS user、Trust/revalidation、
  capability separation、neutral process、dead-only lifecycle、no dual writer/fallback 等约束继续有效。
- 不替代 ADR-0143 的 closed local presentation DTO 与 History/live 等价原则；Web 只能在新的 browser-safe closed projection 内复用该原则。
  不替代 ADR-0145/0146 的 Workspace external-read scope 与重新授权语义；Browser 不得执行 Trust decision 或自行提交 Workspace path。

## 后果

- Coordinator 变成轻量 control-plane metadata owner，但不能变成 Runtime data-plane bottleneck 或 receipt/effect authority；Worker failure 可以按
  Workspace 隔离，Catalog 丢失只阻止未知 routing 并可由 validated Worker header/outbox 重建。
- Store 从 global writer 迁移到分片布局会产生新的 schema/tombstone/migration evidence 责任；没有独立 migration ADR 和完整校验时，迁移必须停止。
- 本地 Web 可以观察已有 Session 而不参与 Controller 竞争，但不能通过浏览器完成任何 Runtime 操作。Path-free Directory DTO 会使 Browser 不拥有
  物理 Workspace 选择 authority，浏览器只能使用 Gateway 已验证的 opaque grouping。
- 当前实现、release manifest 与 active authority 在各 KCWW gate 通过前仍描述旧 Service topology；不能把本 ADR 的目标拓扑或 Web 产品面写成已交付。

## 回滚

在 KCWW-08 production cutover 前，可以删除尚未接入的 Coordinator/Worker/Gateway/Web implementation，保持当前 Service/Store/CLI 组合；不得
保留半接入的双 writer、legacy fallback 或第二 Web listener。Store migration 只能按其独立 ADR 的 source/target/fence 规则回滚；target 发生新写入
后不可自动切回旧 Store。cutover 后如需改变本 ADR 的 Worker/Web/Store topology，必须新增 superseding ADR，并保持当前 running Worker、Turn、Controller
与 effect recovery 的 fail-closed 边界。
