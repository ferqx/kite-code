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
Coordinator → canonical Workspace Worker；Worker 的 Store 8 路径必须由 Coordinator/layout owner 显式 admit。旧单 Service/Store 6
composition仍作为显式 `kite service *` maintenance/compatibility owner存在，但 active-layout/migration fence 禁止它成为默认 fallback
或与 Worker 双写。Web Gateway仍是独立永久只读 Observer BFF。

## 当前实现范围

| 边界 | 当前可由源码证明的行为 | 尚未证明或未接入的行为 |
| --- | --- | --- |
| Coordinator | `kite-local-runtime/coordinator` 提供 closed frame/handshake codec、bounded framing、Native carrier、in-memory registry 与固定 method allowlist；`apps/kite-service/src/coordinator/production.ts` 组合 process manager、Catalog/layout admission、Worker/Gateway registry 与 release entrypoint | hosted process/ACL/三平台 qualification 与完整 crash/soak evidence 仍 pending；Coordinator 不承载 Runtime data plane |
| Workspace Worker | `workspace-worker/production.ts` 以 Coordinator 已 admission 的 Store 8 binding 组合单 Workspace Host/Application/Controller/effect/Run authority；默认 CLI/TUI connector、process manager、owner reservation、ready-before-register、capability/control carrier 与 release entrypoint 已闭合 | Windows/Linux hosted process/ACL 与跨平台 qualification仍 pending；不允许第二 writer 或 legacy fallback |
| Web Observer/Gateway | Web package、query-only Observer、plain loopback Gateway carrier/upstream、Coordinator resolve/mint/direct Worker History/live、生产 gateway entrypoint 与 CLI/TUI lifecycle injection 已存在 | remote/LAN/public Web 不支持；Windows/Linux hosted process、browser/Worker reducer qualification 与 release smoke 之外的完整 Web support evidence 仍 pending |
| Store migration | ADR-0148/0150 与 `runtime-storage-sqlite` 已提供 Store 7→Store 8 whole-generation copy、Workspace binding、Catalog/layout manifest、journal/fence、Store 8 new-Workspace admission 与 first-write fence；默认 release terminal path 使用 committed Store 8 Worker | 自动 legacy migration仍不属于普通启动；缺 persisted Workspace identity/腐败/不确定证据时必须进入显式 maintenance。三平台 filesystem/旧 binary hosted evidence仍 pending |

## Coordinator control-plane primitive

`packages/kite-local-runtime/src/coordinator/` 的 boundary constant 明确 `nativeOnly=true`、`ownsControlPlane=true`，并且
不拥有 Runtime execution、Store、Host 或 Web Gateway。codec 的 method allowlist 目前是 `status`、Workspace Worker resolve/
ensure、Session Workspace resolve、path-free Session metadata list、Worker capability mint、Web Gateway ensure/discover/stop
、Native-client-only Coordinator stop与 directory-change subscription；它不是 generic RPC，也没有 Runtime command/event/model/tool/interaction/credential payload。

Coordinator frame使用wire version 1、current protocol/client revision v2、bounded request/idempotency/deadline/identifier/size/depth，
并拒绝 `event`、`runtimeevent`、`model`、`tool`、`interaction`、`credential`、`secret`、`token`、`stdout`、`stderr` 等 payload key。
POSIX carrier 从已校验的 Kite home 派生 owner-only Unix socket；Windows carrier 派生 current-user SID-bound named pipe。descriptor
不携带 socket/pipe path，平台不可用时返回 typed `unsupported`，不会退回 TCP。carrier 只负责本地 peer identity、length-prefixed
bounded frame、handshake deadline、单连接队列和 partial/malformed/oversized/overflow fail-closed；registry 只保存 Worker
identity、path-free Session metadata、directory revision 与 Gateway singleton。
Kite home在Native no-follow/owner验证完成后统一收敛为`realpathSync.native`身份；Coordinator state、Catalog、Store layout与
release composition必须复用这一结果。Windows长路径、8.3与大小写投影不能分别成为不同owner identity，否则fresh Catalog必须
fail closed而不是尝试字符串互换或放宽Catalog目录校验。
Windows fresh target的固定`layouts/<generation>`目录由offline layout owner只在exact创建回调内初始化protected owner-only
DACL，Catalog只验证目录；新`catalog.sqlite`也只有在exclusive创建并记录exact inode后才能初始化同一ACL。active Catalog、
existing target、foreign owner、reparse或identity drift只验证并fail closed，不能借初始化路径修复。
macOS Coordinator/Worker process identity的`ps lstart`读取固定使用`LC_ALL=C`与`LANG=C`，不继承TUI/CLI shell locale；
`zh_CN.UTF-8`等本地化输出不能使同一PID/start token在descriptor writer与client probe之间漂移。该规范化只稳定OS
identity读取，不把PID数值本身升级为cleanup authority；token不匹配、读取失败或PID reuse仍保持uncertain/fail closed。
Native carrier的client `transport.close()`使用half-close；server收到peer end后必须先drain已排队response，再发送自身FIN并幂等释放
connection。不能只从active registry移除而保留half-open native socket，否则`kite web/status`等短命令虽已打印结果仍无法退出。
client必须在inbox close callback清除外层binding前保留并half-close exact socket；该connection close只结束本次control-plane client
generation，不停止Coordinator、Worker、Gateway、Turn或Controller。

这些仍由 `kite-local-runtime` 作为 Native-only primitive 提供；`apps/kite-service/src/coordinator/production.ts` 现在把它们与
Coordinator process main、Worker/Gateway process manager、Catalog active-layout admission、共享 registry 和 release entrypoint
组合起来。release-side `createManagedLocalCoordinatorClientComposition()` 负责 source/installed resolver、explicit neutral
environment、Coordinator lifecycle 和 typed request client；CLI/TUI/Web Gateway 只取得窄 client，不能访问 registry 或 Store。
本地 composition/contract tests 已证明这些闭集路径，仍不能把本地结果升级为 Windows/Linux hosted、remote 或完整 fault/soak
qualification。

## Workspace Worker 与 Controller/effect 边界

`apps/kite-service/src/workspace-worker/process-manager.ts`/`process-main.ts` 在 Runtime composition 前取得 OS-user owner
reservation 与 Workspace lock，Coordinator 完成 Store 8 materialize/admit 后才 spawn；Worker readiness 携带 exact identity、
Store profile/layout generation、data endpoint 与 internal control origin，ready 后才注册 registry。`worker/production.ts` 再以
已 admission 的 Workspace binding 打开唯一 Store 8 owner，组合真实 Runtime Host/Application/Controller/effect/Run authority；失败时
按 register/runtime/lock 顺序做 best-effort cleanup，不从 cwd/PATH/legacy Service fallback 推导。

Worker capability 绑定 `workerInstanceId`、`workerScopeId`、Workspace digest、`clientId`、connection generation 与 purpose，默认
TTL 为 30 秒且只消费一次 connect；同一 connection 的后续 query 使用已绑定的 capability，reconnect 必须由 Coordinator mint 新
generation/capability。credential 只在 Worker/Gateway 内部 carrier seam 出现，不进入 Coordinator catalog、descriptor、readiness、
Browser DTO 或日志。
Native Trust barrier允许用户停留超过30秒：Runtime尚未连接时，过期capability只会在carrier route dispatch前得到401；
Native connector随后重新ensure exact Worker、mint新generation/capability并把同一App Control request重发一次。该边界不延长
capability TTL，也不重放已dispatch mutation；response丢失、5xx、第二次401、identity mismatch或Runtime active后仍fail closed。

`controller.ts` 的 Controller authority 以注入 Store 为最终事实源，按 Session 串行化操作并用 request digest、expected generation
与 lease identity 做幂等/CAS 检查。`tui` 与 `desktop` 才能得到 `applied` lease；`web_observer` 的 request-control/release-control
始终返回 observer 状态，不会取得或改变 Controller lease。Native client干净退出时先查询exact Runtime projection：durable idle且无
pending interaction则release自己的lease；active/pending或query不确定才把对应client/connection generation标记detached。没有Web takeover、
自动 approval/input 转移、TTL猜测死亡或mutation fallback。

Worker readiness不要求Provider已经配置。Store 8/Host/Server与neutral App Control先由同一Worker ready；first-run credential/model
mutation完成后，首个Runtime context才通过lazy Workspace template组合Provider/MCP/Skill/Sandbox。配置缺失不能触发第二Worker、
placeholder execution backend或legacy Service fallback，Runtime execution保持unavailable。

`effect-gate.ts` 与 `effect-adapter.ts` 当前把同一 Workspace 的 mutation attempt 串行化，并依次要求 Store 8 durable evidence port 的
prepare、OS-user resource lease、dispatch acknowledgement、terminal 或 `outcome_unknown`；Runtime admission 的 authenticated
`RuntimeCommandContext`（connectionId/requestId/bindingReference）固定进入 prepared execution closure，不能按 Session 反查旧
Controller。该 gate 不自行持 signing key，也不绕过 Store authority；默认 release terminal mutation 进入 Worker Store 8 authority；
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

Coordinator 的 Directory mirror 从已验证 descriptor/in-memory record 枚举 Worker scope，再通过 authenticated control link 分页读取
current-format outbox。`workerScopeId` 是 manager-local routing/response-check identity，不能透传进 Worker wire body；strict control
request 只允许 bounded `cursor` 与 `limit`。manager收到响应后仍逐条校验scope、sequence/cursor推进，再把path-free metadata写入
Catalog/registry。这样 Browser仍不接触Workspace path、Store或Worker endpoint，同时严格unknown-field拒绝不会把已有Session误显示为
空Workspace目录。
Gateway Directory以Catalog中的`workerScopeId`作为稳定opaque `workspaceId`。即使Worker已按idle策略退出、当前无法解析canonical
Workspace或History，Catalog中的既有Session仍按该scope返回，使用server生成的path-free label并把status标为`unavailable`；不得
`continue`丢弃整组。Worker在线时才用authenticated Workspace identity补project label、History sequence和running/idle status。
Session History与live status分离：`status=unavailable`表示没有可订阅的live Worker，并不删除durable History。用户选择Session时，
Gateway先以Catalog metadata确定exact opaque scope；在线Worker继续走Coordinator resolve/mint后的Worker query-only History，
idle Worker则进入Service-owned offline History facade。offline facade只消费manager提供的显式Kite home与server-owned active-layout，
canonical Store路径在storage boundary内部按generation/scope推导，并以隔离只读snapshot复核pointer/manifest/journal/fence、Store 8
profile、owner/no-follow/nlink和完整Workspace binding。它不启动Worker、不打开writer、不接收Browser path、不触发compatibility
list/import，也不把raw Runtime event加入Coordinator control protocol；missing、legacy-only、corrupt或layout drift固定映射typed
`history_unavailable`。

`apps/kite-service/src/web-observer/core.ts` 只读取注入的 Directory、History 与已经投影的 `RuntimeClientEvent` live port。Directory
结果先经 exact codec round-trip，History 只接受 current-format `WebObserverHistoryPort`，sequence gap、history change、queue
overflow 与 upstream failure 分别转为 typed resync/unavailable。unsubscribe、disconnect 与 iterator release 只释放 Observer
subscription；它们不调用 Runtime mutation、Controller 或 Store writer。

当前 History adapter 有两条明确路径：

- terminal `createKiteRuntimeHistoryClient` 可按既有 native journey 使用显式 compatibility list/import；
- Web `createKiteRuntimeObserverHistoryPort`/`createKiteRuntimeObserverHistoryClient` 不接收 compatibility source，只打开当前 SQLite
  `RuntimeLogQueryPort`，按 current event page 投影 `RuntimeClientEvent`，legacy-only Session 保持 unavailable，不会因 list/load
  副作用导入或写入。

Web Observer的单次`loadSession`固定复用一个pinned reader，`observedLastSequence`跨页必须一致且record总数有固定上限；不能用
两个独立SQLite view拼出一个伪一致transcript。Browser切换Session后旧请求结果不再fold，terminal resync自动重连最多三次。

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

固定`/api-docs`与尾斜杠是同一Web bundle的静态deep link，`/api-docs/openapi.json`是唯一新增allowlisted docs asset；两者不连接
Web Observer core、Coordinator或Worker。Web入口在渲染Observer App前选择只读reference renderer，因此不会bootstrap browser session、
discover Worker、mint capability或发送Agent API data-plane request。renderer无form/Try it/execute与remote CDN/script，只展示
release-bundled canonical OpenAPI、placeholder endpoint及availability未确认；Gateway对这些响应继续使用self-only CSP、`no-store`与固定content type。

Gateway正常停止存在一个有序cleanup window：child先释放自身instance lock，manager收到退出后再清parent-owned descriptor与control
credential。Coordinator/manager若在该窗口退出，restart只可在descriptor的PID + OS start token再次confirmed dead后把“descriptor/
credential存在、child lock缺失”作为可恢复partial state并执行exact cleanup；新Coordinator的in-memory Gateway registry为空时，清理
同一confirmed-dead instance按幂等absence处理，而不同已注册instance仍identity mismatch。alive/uncertain、descriptor缺失的token-only
launch、lock identity mismatch或replacement state仍不得cleanup/spawn。该恢复不把manager变成PID kill owner，也不停止Worker、Turn
或Controller。

`apps/kite-web` 是独立 private static React workspace。其 development 与 production transport 都只消费 `kite-app-contract`，
transport failure 显示 unavailable，不打包或回退本地样例。页面保持 Workspace 分组既有 Session、消息/History、running live state 与主动断连，
不创建 Session、不发送 prompt、不回复 approval/interaction、不 cancel/interrupt/rewind/fork、不申请 Controller，也不直接访问
SQLite、Store、Host、Native credential 或 raw Runtime event。
Browser完成bootstrap/tab后立即通过HTTP读取Directory/History；live WebSocket只在running Session订阅时懒建立。WS initialize或live
失败只能降级实时状态，不能阻止或清空HTTP已返回的Workspace/Session snapshot；typed terminal resync仍会废弃旧tab generation并按
bounded History reset规则重建。

## Agent API认证shell

canonical Workspace Worker当前在同一data listener拥有`/v1`Agent API认证shell；Coordinator只允许authenticated Native peer mint
`agent_api_observer|agent_api_controller` one-shot capability并继续只做routing/control plane，不代理HTTP data plane。Web Gateway peer仍只
能mint`web_observer`，Browser launch token/cookie/Origin不能exchange Agent context。

exchange在消费capability前重验Workspace Trust，context为Worker-local hash-only、60分钟absolute TTL并绑定Client generation与private
read logical connection。当前开放exchange/logout/ServerInfo及bounded Session list/get、History page、Checkpoint list/preview，capabilities精确为
`checkpoints/history/sessions`；每次read再次重验Trust。Controller role不取得或替代Store 8 Session Controller lease，Run/Interaction/
mutation/SSE仍未开放。Coordinator仍不代理Agent data plane，Web Observer永久只读且不能取得Agent context。
KASAPI-02D reference client已在handler seam与真实Worker listener上验证两种role的read、capability replay、pagination/limits、drain、replacement
与non-disclosure；旧Worker token在replacement上固定401，draining handler固定503且不恢复context。Gateway restart继续只轮换browser cookie/tab
generation，由独立Gateway process/carrier suite覆盖；Gateway前后都不代理`/v1`，也不影响Worker context/Runtime work。

## Store 8 current authority 与 Store 7 migration source

`apps/kite-service/src/bootstrap.ts` 的显式 legacy composition仍只打开 State 27 / Store 6 /
`kite-runtime-server-v1-2026-08-26` profile；它不再是 release CLI/TUI 的默认 path。`runtime-storage-sqlite` 已提供 Store 7 source与Store 8 current profile、
global metadata Catalog/layout primitives、per-Workspace Store writer、
`active-layout` pointer、generation manifest、migration journal、post-switch/first-write fence、
`session_workspace_tombstone` 与 old-binary fence；Coordinator production composition 负责 active generation/catalog 检查，Worker
production composition 只打开已 materialize/admit 的 Store 8 target。现有 compatibility writer/import 仍只属于 terminal 显式历史
journey，不能被 Web Observer 或目录查询复用。

ADR-0150 接受且当前 Worker 使用的 profile 是 State 27 / Store 8 /
`kite-agent-server-api-v1-2026-08-29`。Store 7只属于whole-generation offline source，Store 6只属于显式legacy Service maintenance path。必须保持：

- Store header、Session row、receipt 与 tombstone 绑定 WorkerScope、完整 Workspace identity digest 与 LayoutGeneration；Browser、
  Coordinator、History reader 永不直接成为 Store writer；
- migration 是 offline full copy-and-switch，source immutable 保留，Catalog 只含 metadata；不是在线 DDL、兼容 import、dual write 或
  silent fallback；
- deleted-session retained receipt 必须有一致的 Workspace tombstone/binding；任一缺失 Workspace identity、corrupt/unknown event、
  unowned/mismatched receipt、uncertain phase/digest/fence 都使整体 migration blocked；
- `active-layout` 切换前可丢弃未写 target；任一 target/Catalog 新写入后禁止自动回退，pointer/target/fence 不确定时不同时启动 legacy
  与 Worker writer；旧 binary 必须在 legacy Store open/write 前 fail closed。

Store 7/8 DDL、逐 Session full validation、journal/pointer crash windows、target-first-write rollback fence、new Workspace admission 与
旧 binary fence已有实现和 focused tests；默认 release terminal path 已切到 Store 8 Worker。旧 Service source/explicit lifecycle 仍保留，
但不是 fallback，不能绕过 committed layout。Worker production path继续保持 explicit admission、single writer、source immutable 与
no silent rollback；Linux/Windows hosted filesystem/process evidence仍不能由本机结果替代。

KRSRUN-02B现已让layout manifest/journal/fence接受exact Store 8 target，并提供显式offline whole-generation migrator与
`runLocalRunStoreMigration` orchestration。调用方必须先关闭Coordinator/Worker/Gateway admission并证明Turn/Interaction/effect/external
process收敛；Coordinator Catalog owner复制全部Session/outbox/terminal operation事实且只重绑generation，Runtime Store owner逐Workspace
隔离复制并把coverage设为source head，不生成历史Run。任一未结算Catalog operation、未登记Workspace、unsafe WAL/SHM、binding/digest/
preflight或copy fault都使整个generation blocked；新fence同时阻断旧Store 7 binary。

KRSRUN-03A已把normal Coordinator/Worker composition切到Store 8-only。fresh layout与新Workspace直接创建exact Store 8；已有Store 7仍必须显式
maintenance，普通ensure不自动迁移。Worker readiness固定Store 8 epoch，Controller/effect/Directory/History/Checkpoint与private Run port都来自
同一already-open connection；Store 7 manifest或旧process descriptor整体拒绝，不以catch/retry恢复旧writer。Agent ServerInfo/Public route继续不发布`runs`。

KRSRUN-03B提供正式offline命令`kite maintenance migrate-run-store --target-generation <fresh-generation>`。CLI只把exact target交给release owner；
owner通过Coordinator revision v2 authenticated stop先进入draining并确认process exit，再复用Gateway/Worker manager按持久descriptor、control
identity、PID/start-token与idle activity逐个停止child。owner在持有Coordinator lifecycle lock后复核descriptor、endpoint、launch intent与
instance lock全部absent，阻断并发ensure窗口。Host State predicate和SQLite deep validation共同确认Turn/Interaction/effect/external
process为零；任一busy、unknown、corrupt或response loss保持blocked且不切pointer。normal ensure仍不自动迁移existing Store 7。

Worker restart对已写Store的re-admission当前必须复用no-follow只读snapshot preflight，重新验证Store 8 profile与完整Workspace
binding；manifest/journal保留的是first-write前admission digest，只要求两者一致，不与`targetWriteState=written`后的live文件字节
比较或重定基线。未写target仍必须匹配该digest，任一header/binding/evidence drift继续fail closed。
Coordinator从持久Worker descriptor恢复时必须先比较PID与OS start token；confirmed dead在尝试旧control endpoint handshake前
清除exact descriptor/control credential并允许replacement，alive才恢复authenticated control/reservation。uncertain或PID reuse
不清理、不spawn，不能让已死亡loopback endpoint被误报为identity drift而永久阻塞正常restart。若Worker在正常退出时已删除
同一handed-off reservation，manager只在该Worker PID/start token confirmed dead时将缺失文件视为幂等release；reserved/launching、
alive/uncertain或replacement identity仍fail closed。
release/source Worker connector还会把同一canonical Workspace的短暂Worker恢复闭合在一次`connect()`内：最多按
50/150/400/1000毫秒等待后重试完整ensure→capability mint→instance handshake。Manager在进程identity uncertain、control
identity暂不可读或dead-state cleanup未收敛时返回recovery-pending/outcome-unknown，不清理不确定owner，也不重复spawn；
credential先于descriptor清理，若descriptor清理失败，restart只能在exact Worker confirmed dead后继续回收缺credential的
descriptor。Connector只重试Worker unavailable/capability unavailable/transport handshake failure；Coordinator transport、
protocol或exact identity mismatch仍立即fail closed，也不会切换到legacy Service、embedded backend或另一Workspace。
每个默认logical connection分配独立client identity，避免并发generation/capability键互相覆盖。
Coordinator对自己spawn的native Worker保留exact child-exit handle；exit resolution携带同一instance/PID/start-token proof，
在per-scope manager串行区内立即回收reservation、registry、credential与descriptor。因此正常idle exit不会把stale PID留到
下一次TUI，也不会因数值PID随后被无关进程复用而永久blocked。该proof只来自owner-held child handle且必须与当前内存record
完全一致；Coordinator重启后没有该handle时，PID reuse/unknown仍保持fail closed，不据此清理或spawn。Windows runner只有在
提供等价native process-handle exit proof时才能取得该行为，hosted Windows qualification仍pending。
新ensure若与旧Worker的idle drain并发，manager不会立刻返回transient failure：在同一scope串行区内最多等待既有operation
deadline，让owner-held exit promise收敛，随后用exact proof cleanup并直接spawn replacement。deadline内未取得proof仍返回
outcome-unknown且不清理、不spawn；该等待不改变Coordinator restart后无handle时的PID-reuse fail-closed边界。

## Fault、release 与平台 evidence 边界

当前 Coordinator/Worker/Web tests 是 local focused/conformance evidence。它们证明 codec、bounded queue、observer-only method
surface、production composition、本地 process/Store 8/Gateway carrier，以及macOS arm64 installed TUI 经 Coordinator→Worker
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
