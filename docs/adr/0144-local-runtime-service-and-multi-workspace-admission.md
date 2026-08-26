# ADR-0144：默认 Runtime Store 由本机 Service 单一拥有，多 Workspace 由 App admission 隔离

状态：accepted

日期：2026-08-27

决策者：用户直接指令

相关：ADR-0053、ADR-0129、ADR-0139、ADR-0140、ADR-0141、ADR-0142、ADR-0143、
[`Kite Local Runtime Service V1 实施方案`](../space/plans/2026-08-27-kite-local-runtime-service-v1.md)。

## 背景

Runtime Protocol、Server、Client、InProcess/stdio/development WebSocket carrier、完整 History adapter 与持久
command receipt 已经落地，但 production composition 仍由前台 `apps/kite` 进程创建。TUI 或 foreground CLI 退出会
释放 Host/Store，多个前台入口又各自具备打开默认 Store 的能力；当前单 Workspace Server admission 也不能让一个长生命周期
Host 安全承载来自多个可信 Workspace 的 Session。

不能只给当前 App 加 PID 文件或把 development WebSocket 政名为 production。真正的本机服务边界还需要唯一 Store owner、
App-owned multi-Workspace admission、完整 History transport、TUI 直接依赖的 exact App Control、neutral process
environment、发现与生命周期，以及一次性的默认入口 clean cutover。与此同时，Web、Desktop、remote、多用户、通用 RPC、
多 Store daemon 和 OS Service 都没有相应产品或安全准入，不应被本次本机进程拆分顺带实现。

## 决策

### 1. 默认 Store 使用一个用户级本机 Service

一个 canonical `userKiteCodeDir()` 对应一个 `runtime-service/v1` identity，并只拥有 canonical
`defaultCheckpointPath()`。最终 cutover 后，`apps/kite-service` 是受支持 production 入口中默认 Runtime Store、
Runtime Host、Runtime Server、Builtin execution、SQLite writer 与完整 History projector 的唯一 composition root；
`apps/kite-cli` 的 TUI 与 foreground CLI 只连接该 Service。

custom Store 不是 Service instance key。embedded/diagnostic 与 parent-owned stdio 只能显式使用经过 canonical/no-follow
校验、且不与默认 Store 或其 alias 相等的隔离 Store。连接失败不得静默回退到 embedded，Service 和旧前台 owner 也不得同时
打开默认 Store。本规则是同一 release 支持入口的 composition 约束，不声称抵御同一 OS 用户运行旧 binary、直接打开 SQLite
或恶意删除 state；Host/SQLite correctness 继续由现有 transaction、revision 与 lease 保证。

### 2. App 拆为 terminal client 与 Runtime Service

`apps/kite` 先机械重命名为 `apps/kite-cli`，再新增 `apps/kite-service`。两个 App 不得互相 production import，也不得复制
Runtime backend。新增两个仓库私有 package：

- browser-safe `@kite-ai/kite-app-contract` 只承载当前 CLI/TUI 已使用的无 secret exact DTO/codec；
- Bun/Node-only `@kite-ai/kite-local-runtime` 只承载 Native state/process/discovery、lifecycle/secret codec 与
  Runtime/History/App Control connector；它不得依赖 Host、Server、Builtin、SQLite、UI 或任一 `apps/*`。

`kite-app-contract` 不成为公共 SDK、UI component contract、通用 method registry 或 plugin protocol；
`kite-local-runtime` 不成为通用 daemon framework。未来 Browser/renderer 禁止静态导入 native package；本 ADR 不创建
Browser transport、Desktop IPC 或 future-only adapter。

### 3. 一个 Host 服务多个可信 Workspace，但 Workspace 不进入 Protocol

一个 Local Service 可以服务同一本地用户 Store 中多个 canonical trusted Workspace。create 使用 connection-scoped
App admission；resume、fork、query 与 command 从持久 Session State/identity 解析 Workspace。客户端不能从
`clientInfo`、display name、请求 body 或 Runtime command 提升、替换或改绑 Workspace authority。

Runtime Server `open()` 可取得 App-owned per-connection admission override 或生命周期受限的等价 opaque binding。
Runtime Protocol V1、Runtime Host、State 27、Store 6 与 format epoch 不变。多 Workspace 路由由 App-owned
`RuntimeExecutionBridgeRouter` 和以 canonical Workspace/Project identity 为 key 的 context factory 完成；不修改 Host、
不创建第二 Host/Store，也不把“当前 Workspace”放入 process-global mutable singleton。

本决定仅取代 ADR-0053 的“一个 trusted Workspace”production topology 与 ADR-0142 §5 的“每 Server instance 固定一个
Workspace”局部结论。ADR-0053 的单本地 OS 用户、用户在场 foreground consumer、Web/hosted/multi-user/remote No-Go，
以及 ADR-0142 的 exact Protocol、唯一 Runtime authority、receipt、History 与 transport 分层继续有效。

### 4. Native carrier 使用独立 capability 与 restart-scoped secret

Service 只监听 `127.0.0.1:0`。access-authenticated `POST /_kite/connect` 对请求 Workspace 做 canonical realpath、
Trust 与 Project identity 校验，并签发 32-byte、base64url、一次性、30 秒、只存内存的 connection ticket；`WS /rpc`
消费 ticket 并把 admission 绑定到该 connection。Runtime Protocol DTO 不携带 token、ticket、Workspace、process 或 build
信息。

完整 durable history 使用独立 authenticated HTTP route，继续返回现有 client-safe History DTO；handler 只取得
`RuntimeHistoryClient`/readonly query capability。App Control 为 Workspace Trust、Provider/model、MCP、credential 与
authoritative status 的当前 exact use case 提供独立 route/codec；无 secret projection 位于 browser-safe contract，raw
credential 与 lifecycle request 只位于 native contract。不得提供 generic JSON-RPC control plane、Manager passthrough、
动态 method、静态 Web、CORS、cookie 或 Browser ticket。

`access.token` 只用于 connect、Runtime ticket、History 与 App Control；独立 `control.token` 只用于 stop。token、ticket、
request body、Workspace/Store path 与正文不得进入 descriptor、Runtime Store、Session Log、observability 或普通诊断。

### 5. Service discovery 与 lifecycle fail closed

Service state 位于 canonical `userKiteCodeDir()/runtime-service/v1/`，使用 strict descriptor、restart-scoped token 与
同一 filesystem 上原子目录 `lifecycle.lock/`、`instance.lock/`。健康只由 descriptor endpoint 的 Runtime initialize、
exact protocol/client-contract revision 与相同 instance ID 共同证明；目录、PID 或 descriptor 单独都不是健康证明。

PID 已确认退出时才可原子隔离 stale state。PID 存活、identity 无法确认、symlink/reparse/owner/ACL drift 或 handshake
不确定时返回 `service_unavailable`，不启动第二个 owner，也不依据 PID 直接 kill。ensure 使用有界 readiness channel，
不解析 stdout；build mismatch 只给诊断，不自动重启。V1 只提供 ensure/status/stop/restart 与内部 foreground run，不注册
launchd/systemd/Windows Service，不开机自启，不自动 crash restart，也不提供 force stop。

普通 stop 先 quiesce Runtime 与 App Control mutation admission、等待已 admission 请求离开临界区，再原子观察 active
Runtime operation。busy 时恢复 admission 并返回 `service_busy`；idle 时才 commit drain 并关闭 Server、Application、Host、
Store、listener，最后清理 descriptor/token/instance lock。signal shutdown 走现有 cancel/recovery-safe disposal；无法确认
完全关闭时保留 stale evidence。

### 6. neutral process 与 Service-owned interaction

Service home identity 默认从 OS user home 解析；custom home 只能来自显式 CLI/process argument 或测试注入，必须经过
canonical/no-follow 校验。child 使用 state root 下 owner-only、无 `.env*`/bunfig/loader 的 neutral cwd，并由显式
allowlist 构造环境；不得继承任意 Workspace cwd 或 `{ ...process.env }`。Workspace Trust/config/Skill/MCP/filesystem
只在显式 admitted Workspace context 中解析，Provider 未配置时 neutral Service 仍可 ready。

等待用户交互的 broker 属于 `apps/kite-service` execution mechanism；durable Runtime State/notification 仍是 pending
interaction authority。Client disconnect 只关闭 connection，不取消 Turn、approval waiter 或 Session；Service restart
从持久状态恢复 waiter。TUI 的 input provider、AbortController、SessionRuntime、Manager 与 Store handle 不跨进程。

### 7. 发布采用一次性 clean cutover

Service infrastructure、connector 与真实 Runtime Application relocation 必须在隔离 home 下先验证。公开 `kite service *`、
TUI/foreground CLI 默认连接、默认 Store 单 owner、stdio/custom Store 拒绝规则，以及 release companion `kite-service`
必须在同一 atomic cutover tranche 完成。不得保留 `try-new-catch-old`、silent fallback、app-to-app import 或默认 Store 双
Host 作为迁移手段。

installed candidate 必须同时包含 `kite`、`kite-tui` 与 manifest-managed `kite-service` companion；upgrade/rollback 在替换
binary 前只执行普通 stop，busy 时保持当前 candidate。发布兼容性不扩大 effectful execution platform support；standalone
keyring limitation 继续以 exact `unavailable` fail closed。macOS、Linux、Windows 支持结论只能来自各自真实 candidate
workflow evidence，本地结果或 workflow 定义不能替代。

## 后果

- 前台 client 生命周期与 Runtime work 解耦，默认 Store 在受支持入口中只有一个正常 production owner；
- 多 Workspace isolation、Trust revalidation、History 与 App Control 成为明确的 App/service capability，而不是 Protocol 或
  Host authority；
- 本机 discovery/auth/process state 引入新的 Native 攻击面，必须由 strict filesystem identity、loopback admission、
  capability-separated token、fault/process/security matrix 与三平台 candidate smoke 持续验证；
- V1 的包和 route 数量增加，但范围保持在当前 CLI/TUI exact use case，不产生 Web/Desktop/remote/OS daemon 承诺。

## 回滚

默认 cutover 前可以整体删除未公开的 package、Service shell 或 opt-in connector，并保持当前 InProcess production。cutover
后只能在 Service idle 且普通 stop 成功、descriptor/token/lock 已由原 Service 正常清理后，整体回滚到旧 composition；busy、
shutdown 不确定或 state evidence 漂移时不得 force kill、手工清理后启动旧 owner，必须保持当前 candidate 并先解决故障。
State 27、Store 6 与 epoch 没有变化，因此不需要数据迁移；也不得借回滚恢复默认 Store 双 owner。
