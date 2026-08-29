# Coordinator、Workspace Worker 与 Web Observer 当前边界

状态：active

读取时机：修改 `packages/kite-local-runtime/src/coordinator/`、`apps/kite-service/src/workspace-worker/`、
`apps/kite-service/src/web-observer/`、`apps/kite-service/src/web-gateway/`、`apps/kite-service/src/runtime-client/history-adapter.ts`、
`packages/kite-app-contract/src/web.ts`、`apps/kite-web/`，或修改 Store generation migration、browser auth、Worker recovery、
release/platform evidence 时。

验证：`bun test packages/kite-local-runtime/test/coordinator.test.ts apps/kite-service/test/workspace-worker apps/kite-service/test/web-observer apps/kite-service/test/web-gateway apps/kite-service/test/runtime-history-client.test.ts packages/kite-app-contract/test/web.test.ts`、
`bun run --cwd apps/kite-web typecheck`、`bun run --cwd apps/kite-web test`、`bun run --cwd apps/kite-web build`、
`bun run check:runtime-packages`、`bun run check:pre-release-architecture`、`bun run check:test-ownership`、
`bun run check:docs-impact`、`bun run check:docs`、`bun run typecheck`。

相关：ADR-0147、ADR-0148、[`Kite Coordinator、Workspace Worker 与唯一 Web Gateway V1 方案`](../space/plans/2026-08-28-kite-coordinator-workspace-worker-web-v1.md)、
[`Runtime Authority Boundary`](runtime-authority-boundary.md)、[`SQLite Runtime Log 只读查询`](sqlite-runtime-log-query.md)。

本文是当前实现 authority，不把本机证据误写成三平台 qualification。当前 release/source 默认 TUI、`run` 与 `resume` 已切到
Coordinator → canonical Workspace Worker；Worker 的 Store 7 路径必须由 Coordinator/layout owner 显式 admit。旧单 Service/Store 6
composition仍作为显式 `kite service *` maintenance/compatibility owner存在，但 active-layout/migration fence 禁止它成为默认 fallback
或与 Worker 双写。Web Gateway仍是独立永久只读 Observer BFF。

## 当前实现范围

| 边界 | 当前可由源码证明的行为 | 尚未证明或未接入的行为 |
| --- | --- | --- |
| Coordinator | `kite-local-runtime/coordinator` 提供 closed frame/handshake codec、bounded framing、Native carrier、in-memory registry 与固定 method allowlist；`apps/kite-service/src/coordinator/production.ts` 组合 process manager、Catalog/layout admission、Worker/Gateway registry 与 release entrypoint | hosted process/ACL/三平台 qualification 与完整 crash/soak evidence 仍 pending；Coordinator 不承载 Runtime data plane |
| Workspace Worker | `workspace-worker/production.ts` 以 Coordinator 已 admission 的 Store 7 binding 组合单 Workspace Host/Application/Controller/effect authority；默认 CLI/TUI connector、process manager、owner reservation、ready-before-register、capability/control carrier 与 release entrypoint 已闭合 | Windows/Linux hosted process/ACL 与跨平台 qualification仍 pending；不允许第二 writer 或 legacy fallback |
| Web Observer/Gateway | Web package、query-only Observer、plain loopback Gateway carrier/upstream、Coordinator resolve/mint/direct Worker History/live、生产 gateway entrypoint 与 CLI/TUI lifecycle injection 已存在 | remote/LAN/public Web 不支持；Windows/Linux hosted process、browser/Worker reducer qualification 与 release smoke 之外的完整 Web support evidence 仍 pending |
| Store migration | ADR-0148 与 `runtime-storage-sqlite` 已提供 Store 7 DDL、Workspace binding、Catalog/layout manifest、migration journal/fence、copy-and-switch、new-Workspace admission 与 first-write fence；默认 release terminal path 使用 committed Store 7 Worker | 自动 legacy migration仍不属于普通启动；缺 persisted Workspace identity/腐败/不确定证据时必须进入显式 maintenance。三平台 filesystem/旧 binary hosted evidence仍 pending |

## Coordinator control-plane primitive

`packages/kite-local-runtime/src/coordinator/` 的 boundary constant 明确 `nativeOnly=true`、`ownsControlPlane=true`，并且
不拥有 Runtime execution、Store、Host 或 Web Gateway。codec 的 method allowlist 目前是 `status`、Workspace Worker resolve/
ensure、Session Workspace resolve、path-free Session metadata list、Worker capability mint、Web Gateway ensure/discover/stop
与 directory-change subscription；它不是 generic RPC，也没有 Runtime command/event/model/tool/interaction/credential payload。

Coordinator frame 使用 exact schema、固定 protocol/client revision、bounded request/idempotency/deadline/identifier/size/depth，
并拒绝 `event`、`runtimeevent`、`model`、`tool`、`interaction`、`credential`、`secret`、`token`、`stdout`、`stderr` 等 payload key。
POSIX carrier 从已校验的 Kite home 派生 owner-only Unix socket；Windows carrier 派生 current-user SID-bound named pipe。descriptor
不携带 socket/pipe path，平台不可用时返回 typed `unsupported`，不会退回 TCP。carrier 只负责本地 peer identity、length-prefixed
bounded frame、handshake deadline、单连接队列和 partial/malformed/oversized/overflow fail-closed；registry 只保存 Worker
identity、path-free Session metadata、directory revision 与 Gateway singleton。

这些仍由 `kite-local-runtime` 作为 Native-only primitive 提供；`apps/kite-service/src/coordinator/production.ts` 现在把它们与
Coordinator process main、Worker/Gateway process manager、Catalog active-layout admission、共享 registry 和 release entrypoint
组合起来。release-side `createManagedLocalCoordinatorClientComposition()` 负责 source/installed resolver、explicit neutral
environment、Coordinator lifecycle 和 typed request client；CLI/TUI/Web Gateway 只取得窄 client，不能访问 registry 或 Store。
本地 composition/contract tests 已证明这些闭集路径，仍不能把本地结果升级为 Windows/Linux hosted、remote 或完整 fault/soak
qualification。

## Workspace Worker 与 Controller/effect 边界

`apps/kite-service/src/workspace-worker/process-manager.ts`/`process-main.ts` 在 Runtime composition 前取得 OS-user owner
reservation 与 Workspace lock，Coordinator 完成 Store 7 materialize/admit 后才 spawn；Worker readiness 携带 exact identity、
Store profile/layout generation、data endpoint 与 internal control origin，ready 后才注册 registry。`worker/production.ts` 再以
已 admission 的 Workspace binding 打开唯一 Store 7 owner，组合真实 Runtime Host/Application/Controller/effect authority；失败时
按 register/runtime/lock 顺序做 best-effort cleanup，不从 cwd/PATH/legacy Service fallback 推导。

Worker capability 绑定 `workerInstanceId`、`workerScopeId`、Workspace digest、`clientId`、connection generation 与 purpose，默认
TTL 为 30 秒且只消费一次 connect；同一 connection 的后续 query 使用已绑定的 capability，reconnect 必须由 Coordinator mint 新
generation/capability。credential 只在 Worker/Gateway 内部 carrier seam 出现，不进入 Coordinator catalog、descriptor、readiness、
Browser DTO 或日志。

`controller.ts` 的 Controller authority 以注入 Store 为最终事实源，按 Session 串行化操作并用 request digest、expected generation
与 lease identity 做幂等/CAS 检查。`tui` 与 `desktop` 才能得到 `applied` lease；`web_observer` 的 request-control/release-control
始终返回 observer 状态，不会取得或改变 Controller lease。断连只标记对应 client/connection generation detached；没有 Web takeover、
自动 approval/input 转移或 mutation fallback。

`effect-gate.ts` 与 `effect-adapter.ts` 当前把同一 Workspace 的 mutation attempt 串行化，并依次要求 Store 7 durable evidence port 的
prepare、OS-user resource lease、dispatch acknowledgement、terminal 或 `outcome_unknown`；Runtime admission 的 authenticated
`RuntimeCommandContext`（connectionId/requestId/bindingReference）固定进入 prepared execution closure，不能按 Session 反查旧
Controller。该 gate 不自行持 signing key，也不绕过 Store authority；默认 release terminal mutation 进入 Worker Store 7 authority；
显式 legacy Service Store 6 journey保留自身 owner，但 committed layout fence 禁止与 Worker topology并存写入。

## Web Observer、Directory 与 History

`packages/kite-app-contract/src/web.ts` 是 Web 唯一 semantic contract。`WebWorkspaceSummary` 只含 opaque `workspaceId`、安全
`label` 与 Session summary；`WebSessionSummary` 只含 Session id、display name、时间、sequence 与 status。绝不向 Browser 返回
Workspace absolute path、Store path、Worker endpoint、capability、Native token、credential、raw diagnostic 或可改绑 Workspace
authority 的输入。Coordinator/Worker 内部仍可使用完整 canonical Workspace identity；“path-free”只约束 browser-facing Directory
DTO，不能削弱内部 admission/revalidation。

Web contract 是 closed exact schema，当前 route 只有 bootstrap、tab create、directory、history、subscribe、unsubscribe 与
disconnect。`WebGatewayObserverClient` 没有 generic call，也没有 prompt、Session create、approval/input reply、cancel、interrupt、
rewind、fork、mode/config mutation、Controller 或 raw Runtime command。`WebObserverStreamEvent` 只允许 browser-safe message、
typed unavailable 或 typed resync-required。

`apps/kite-service/src/web-observer/core.ts` 只读取注入的 Directory、History 与已经投影的 `RuntimeClientEvent` live port。Directory
结果先经 exact codec round-trip，History 只接受 current-format `WebObserverHistoryPort`，sequence gap、history change、queue
overflow 与 upstream failure 分别转为 typed resync/unavailable。unsubscribe、disconnect 与 iterator release 只释放 Observer
subscription；它们不调用 Runtime mutation、Controller 或 Store writer。

当前 History adapter 有两条明确路径：

- terminal `createKiteRuntimeHistoryClient` 可按既有 native journey 使用显式 compatibility list/import；
- Web `createKiteRuntimeObserverHistoryPort`/`createKiteRuntimeObserverHistoryClient` 不接收 compatibility source，只打开当前 SQLite
  `RuntimeLogQueryPort`，按 current event page 投影 `RuntimeClientEvent`，legacy-only Session 保持 unavailable，不会因 list/load
  副作用导入或写入。

History 与 live 都必须经过 browser-safe presentation projection；service-side projector/reducer 位于
`apps/kite-service/src/web-observer/presentation.ts`，Browser bundle 的 `apps/kite-web/src/presentation/reducer.ts` 与
transport 已闭合并由 Web workspace tests 覆盖。两侧都使用纯 presentation fold、sequence duplicate no-op、gap resync、bounded
message/tool/text projection；这只证明 presentation contract，不把 Browser 变成 Runtime/Controller client。

## Plain loopback Web Gateway

`apps/kite-service/src/web-gateway/carrier.ts` 是 private BFF carrier：只 bind `127.0.0.1:0`，使用实际 ephemeral port，要求
exact Host、exact Origin、`Sec-Fetch-Site: same-origin`、匹配的 fetch mode，并拒绝 `Authorization` header、query、userinfo、
OPTIONS 与未知 mutation path。它提供安全静态 asset root、strict content type/CSP/no-store headers、bounded HTTP/WS body and
queue、initialize deadline、slow-reader drain、overflow/resync 与 gateway draining。

认证是 plain loopback HTTP 上的 Gateway-local launch token → HttpOnly/SameSite=Strict cookie：launch token 只在 fragment 和 exact
bootstrap body exchange 中出现，Gateway registry 只保留 hash；cookie 只证明 Gateway browser session，不是 Worker capability、
Controller lease 或 Workspace identity。每个 tab 由 opaque handle 与递增 connection generation 绑定，tab/socket replacement 或
cookie replacement 会关闭旧 binding；Gateway crash/disconnect 只释放 Observer subscription，不取消 Turn、effect 或 Controller。

Gateway 路由只连接 Web Observer core；WebSocket initialize 后仅接受 subscribe/unsubscribe/disconnect，HTTP 只接受 bootstrap/tab/
directory/history/disconnect。`apps/kite-service/src/web-gateway/production.ts` 与
`scripts/release/entrypoints/gateway.ts` 已把该 carrier 组合为独立 Gateway companion；
`scripts/release/local-coordinator-client.ts` 与 CLI/TUI entrypoints 提供显式 lifecycle/discovery client。plain loopback 也不等同
于 TLS、remote/LAN、hosted 或 public Web 支持，后者仍保持不支持/待 qualification。

`apps/kite-web` 是独立 private static React workspace。其 development 与 production transport 都只消费 `kite-app-contract`，
transport failure 显示 unavailable，不打包或回退本地样例。页面保持 Workspace 分组既有 Session、消息/History、running live state 与主动断连，
不创建 Session、不发送 prompt、不回复 approval/interaction、不 cancel/interrupt/rewind/fork、不申请 Controller，也不直接访问
SQLite、Store、Host、Native credential 或 raw Runtime event。

## Store 7 与 generation cutover

`apps/kite-service/src/bootstrap.ts` 的显式 legacy composition仍只打开 State 27 / Store 6 /
`kite-runtime-server-v1-2026-08-26` profile；它不再是 release CLI/TUI 的默认 path。`runtime-storage-sqlite` 已提供 Store 7 profile、
global metadata Catalog/layout primitives、per-Workspace Store writer、
`active-layout` pointer、generation manifest、migration journal、post-switch/first-write fence、
`session_workspace_tombstone` 与 old-binary fence；Coordinator production composition 负责 active generation/catalog 检查，Worker
production composition 只打开已 materialize/admit 的 Store 7 target。现有 compatibility writer/import 仍只属于 terminal 显式历史
journey，不能被 Web Observer 或目录查询复用。

ADR-0148 接受且当前 Worker 使用的 profile 是 State 27 / Store 7 /
`kite-coordinator-workspace-worker-web-v1-2026-08-28`。Store 6只属于显式 legacy Service maintenance path。必须保持：

- Store header、Session row、receipt 与 tombstone 绑定 WorkerScope、完整 Workspace identity digest 与 LayoutGeneration；Browser、
  Coordinator、History reader 永不直接成为 Store writer；
- migration 是 offline full copy-and-switch，source immutable 保留，Catalog 只含 metadata；不是在线 DDL、兼容 import、dual write 或
  silent fallback；
- deleted-session retained receipt 必须有一致的 Workspace tombstone/binding；任一缺失 Workspace identity、corrupt/unknown event、
  unowned/mismatched receipt、uncertain phase/digest/fence 都使整体 migration blocked；
- `active-layout` 切换前可丢弃未写 target；任一 target/Catalog 新写入后禁止自动回退，pointer/target/fence 不确定时不同时启动 legacy
  与 Worker writer；旧 binary 必须在 legacy Store open/write 前 fail closed。

Store 7 DDL、逐 Session full validation、journal/pointer crash windows、target-first-write rollback fence、new Workspace admission 与
旧 binary fence已有实现和 focused tests；默认 release terminal path 已切到 Store 7 Worker。旧 Service source/explicit lifecycle 仍保留，
但不是 fallback，不能绕过 committed layout。Worker production path继续保持 explicit admission、single writer、source immutable 与
no silent rollback；Linux/Windows hosted filesystem/process evidence仍不能由本机结果替代。

Worker restart对已写Store的re-admission必须复用no-follow只读snapshot preflight，重新验证Store 7 profile与完整Workspace
binding；manifest/journal保留的是first-write前admission digest，只要求两者一致，不与`targetWriteState=written`后的live文件字节
比较或重定基线。未写target仍必须匹配该digest，任一header/binding/evidence drift继续fail closed。
Coordinator从持久Worker descriptor恢复时必须先比较PID与OS start token；confirmed dead在尝试旧control endpoint handshake前
清除exact descriptor/control credential并允许replacement，alive才恢复authenticated control/reservation。uncertain或PID reuse
不清理、不spawn，不能让已死亡loopback endpoint被误报为identity drift而永久阻塞正常restart。若Worker在正常退出时已删除
同一handed-off reservation，manager只在该Worker PID/start token confirmed dead时将缺失文件视为幂等release；reserved/launching、
alive/uncertain或replacement identity仍fail closed。
release/source Worker connector还会把Coordinator对同一canonical Workspace的短暂Worker `unavailable`恢复闭合在一次
`connect()`内：最多按50/150/400/1000毫秒等待后重试ensure。该重试只覆盖dead Worker descriptor/进程退出交界的typed
unavailable；Coordinator transport failure、protocol/identity mismatch、capability或instance handshake failure不会被重试，
也不会切换到legacy Service、embedded backend或另一Workspace。

## Fault、release 与平台 evidence 边界

当前 Coordinator/Worker/Web tests 是 local focused/conformance evidence。它们证明 codec、bounded queue、observer-only method
surface、production composition、本地 process/Store 7/Gateway carrier，以及macOS arm64 installed TUI 经 Coordinator→Worker
ensure/mint/handshake 的真实启动与 test-owned exact cleanup；release tests还覆盖 companion assets、stable launcher、upgrade/
rollback/uninstall。这些结果不证明 Windows/Linux hosted process、跨平台 ACL/write-through 或完整三平台 qualification。

现有 release/open-source authority 将 development/reference WebSocket 与 browser reference 区分于当前 private loopback Web Observer
companion；`apps/kite-web` build、candidate static payload、Coordinator/Worker/Gateway entrypoints 与单平台本地 HTTP 只证明闭集
composition，不单独升级为 hosted Web support。macOS/Linux/Windows process、ACL、installed release、fault/soak 与远端
qualification 结果必须以对应真实 job/artifact 为证；本地结果不得冒充三平台证据。当前没有 remote/LAN Web、public SDK、宽松 CORS、
mDNS、server-side credential custody 或 browser-to-Worker direct endpoint。

任一未知 response、partial frame、alive/uncertain process、Worker/Store identity drift、Gateway draining、history gap/overflow、
`outcome_unknown` 或 migration phase uncertainty 都保持 fail closed，并通过 query/resync/recovery 或显式 maintenance decision 收敛；
不得为了“减少安全限制”新增绕过现有 credential、loopback、Trust、single-writer、recovery 或 destructive-action boundary 的 fallback。

## 与方案的当前偏差记录

方案 KCWW-01～08 的实现已进入默认 release terminal path；KCWW-00 的历史 baseline 不再是当前源码事实。仍待外部证明的是
Linux/Windows hosted process/filesystem/release qualification，以及不把本地 Web asset/browser smoke升级为 remote/public支持。
`kite-code web` 只拥有显式 Coordinator lifecycle surface，Web 永久是 Observer；旧 Service authority保留给显式 maintenance且不能
成为 fallback。若要改变 Web 只读边界、Store profile、remote 支持或 Controller/data-plane ownership，必须另行新增 ADR；本页不替代
ADR-0147/0148。
