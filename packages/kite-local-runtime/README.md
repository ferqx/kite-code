# Kite Local Runtime

## 定位

`@kite-ai/kite-local-runtime` 是 Kite managed Local Service 的 Bun/Node-only、repo-private Native substrate。它以互斥
`./client`、`./coordinator`、`./manager`、`./service` exports冻结descriptor/token/lock/lifecycle、instance handshake、Native
credential及Runtime/History/App Control connection contract；它不创建Runtime Host/Store/Server composition。

## 拥有职责

- `./client`：strict descriptor/access discovery、两阶段App Control/Runtime connection、one-shot ticket WebSocket、
  三个History route、exact App Control/Native credential client与`LocalKiteConnection`。`prepareAppControl()`只准备
  authenticated control plane；caller确认Workspace trusted后才显式`connect()`。用户可在Trust页面停留超过Worker
  capability TTL：Runtime尚未连接时，HTTP 401只在carrier dispatch前产生，connector会重新ensure/discover exact
  Worker identity并把同一App Control request重发一次；第二次401、identity drift或Runtime已连接时不自动重试。
- `./manager`：单一ensure/status/stop/restart state machine、native process/spawn/PID probe、cross-process lifecycle lock、
  neutral environment与explicit executable resolver composition。manager拥有control token；普通connection不取得它。
- source mode在POSIX直接执行repo-owned shebang entry（Service、Coordinator、Worker、Gateway各自的 exact entry）；Windows没有
  shebang executable语义，因此固定由当前Bun runtime执行对应 TypeScript entry。installed mode在三平台始终直接执行 resolved
  companion binary，不经PATH fallback。
- manager probe先 `GET /readyz`做liveness precheck，再以access token `POST /_kite/instance`、exact `{}` body读取
  process-owned strict identity；绝不从磁盘descriptor合成healthy response。
- `./service`：strict descriptor/lock/token codec与fixed `runtime-service/v1` filesystem layout；提供no-follow、owner-only、
  bounded read、sibling temp+fsync+atomic rename、instance/lifecycle lock及exact stale quarantine/cleanup primitive。该Native-only
  入口还窄导出同一套Windows state entry secure/verify helper，供Coordinator/Worker/Gateway state owner复用；`./client`与browser
  contract不导出或捆入Win32 ACL/FFI实现。
- `./coordinator`：private、Native-only 的 closed Coordinator control-plane frame/handshake、固定 method allowlist、
  Worker/Web/Coordinator instance/build/protocol identity、bounded ID/deadline/idempotency/size/depth validation，以及
  可注入 transport 的 typed request client/dispatcher。POSIX endpoint 只描述 owner-only Unix socket identity，Windows endpoint
  只描述 current-user SID-bound named-pipe identity；descriptor 不携带 socket/pipe path。其 carrier 使用 length-prefixed
  bounded frame、initialize deadline、单连接有界队列和 fail-closed partial/malformed/oversized 处理；平台不可用时返回
  typed `unsupported`，绝不退回 TCP。Coordinator registry 是纯内存 control-plane owner，只保存 Worker identity、path-free
  Session metadata、directory revision 与唯一 Web Gateway registry。peer half-close后carrier先drain已排队response，再由server
  完成FIN并幂等释放connection；client `transport.close()`不会留下永久half-open socket，因此`kite web/status`等短命令打印结果后
  能正常退出。client cleanup会在inbox close callback清除外层binding前保留并half-close exact socket；该socket close不等于停止
  Coordinator、Worker或Gateway owner。
- `./coordinator`还拥有offline Catalog generation copy primitive：在无active Catalog writer、source/target owner路径与schema精确验证后，
  逐字节保留Session metadata、outbox cursor和terminal operation receipt，只重绑target layout generation；Catalog存在未结算operation或
  未登记Workspace scope时不创建target。它不复制Runtime data plane，也不自行触发Store migration。
- Coordinator capability purpose当前封闭为`native_client`、`web_observer`、`agent_api_observer`、`agent_api_controller`。
  Web Gateway peer只能请求`web_observer`；authenticated Native peer可请求native/Agent API purpose。control plane只转发一次性
  capability与binding metadata，不代理Agent `/v1` data plane，也不保存context token。
- 固定client contract revision、Protocol V1 identity与loopback endpoint shape；拒绝unknown field、non-loopback endpoint、
  secret-bearing descriptor与unsafe JSON。

## 不拥有职责

- 不监听端口，不实现HTTP/WebSocket listener，也不创建Host、Runtime Server、Builtin Runtime、SQLite或第二composition；
  这些production owner只在`apps/kite-service`。
- `./coordinator`不实现generic RPC、Runtime command/event/model/tool/credential data plane、Worker/Store/Host/Web Gateway；
  transport、OS peer verification与process lifecycle仍由上层 owner 注入。
- manager只在PID明确dead且exact identity仍匹配时cleanup；alive/uncertain、malformed state、handshake mismatch与unknown stop
  outcome均fail closed，不kill、不spawn replacement、不回显descriptor identity。
- macOS PID/start identity使用fixed `/bin/ps -o lstart=`并由primitive强制`LC_ALL=C`/`LANG=C`；不能继承调用方
  interactive shell locale。否则同一进程在中文locale会投影不同字符串并被误判为identity uncertain。Linux继续使用
  boot ID + `/proc` start ticks，Windows继续使用native process creation time。
- status对完整absent返回`applied + absent + not_running`；若只剩descriptor/instance-lock stale evidence，必须先由process
  probe确认PID dead并完成exact stale cleanup，才能返回同一canonical absence。alive/uncertain不清理且不伪造absence。
- 不依赖 Runtime Host/Server/Builtin/SQLite、React、Ink或任何`apps/*`。
- 不自动retry/replay Runtime mutation或已进入dispatch的App Control mutation。唯一自动重发是Runtime连接前收到carrier
  pre-dispatch 401后，refresh exact Worker capability并重发同一HTTP request一次；response丢失、5xx、第二次401或任何
  identity drift仍必须按`outcome_unknown → exact state query → explicit decision`处理。
- 不定义generic RPC、Browser transport、Desktop IPC、public SDK、OS Service或默认Store path。

## 允许依赖

只依赖 `@kite-ai/kite-app-contract`、`@kite-ai/runtime-client`、`@kite-ai/runtime-protocol` 与 codec所需`zod`。
source不得导入Host/Server/Builtin/SQLite、React/Ink或`apps/*`。

## 公开入口

只导出 `@kite-ai/kite-local-runtime/client`、`@kite-ai/kite-local-runtime/coordinator`、
`@kite-ai/kite-local-runtime/manager` 与 `@kite-ai/kite-local-runtime/service`。不提供root export，不暴露跨layerimplementation。

## 关键不变量

- descriptor schema为`kite.local-runtime-service.v1`，只含instance/PID/start time、loopback endpoint、Protocol、client
  contract revision、server version与build ID；token、Workspace、Store/executable path、credential与Session字段fail closed。
- authenticated instance handshake必须是 `POST /_kite/instance`、`Kite-Local-Access`、JSON `{}`、无cookie/query，response
  exact keys为`schema/instanceId/protocolVersion/clientContractRevision/serverVersion/buildId`且不超过4096 bytes。
  content-type缺失、malformed/extra field或instance/server/build identity mismatch统一`identity_uncertain`；
  Protocol/client-contract不兼容被拒绝，expected build drift返回`incompatible + build_mismatch`。以上状态都不授权
  清理alive/uncertain owner或spawn replacement。
- access/control token不同且restart-scoped；client connection只用access admission，stop/restart由manager独占control。
- Runtime initialize instance必须与descriptor相同；reconnect重新ensure/discover并清空旧generation readiness/ephemeral
  stream，再以authoritative reset接受replacement Service current revision。mutation不会自动重放。
- state identity来自explicit validated home，不从request Workspace/cwd推导。POSIX验证owner UID与`0700`/`0600`并拒绝
  symlink/hardlink/type drift；Windows通过进程内Win32 API校验current-user SID、protected owner-only DACL与
  non-reparse file/directory。explicit home先验证non-link/current owner再收紧权限；state创建时收紧ACL，后续每次敏感
  读取、替换与清理都重新验证owner、DACL protected control与exact single ACE，既有state ACL/reparse drift fail closed。
  current SID由fixed system `whoami.exe`有界解析
  一次并缓存，ACL apply/verify不启动child process；resolver timeout不授权访问。只有当前操作刚exclusive创建并记录
  inode的entry可初始化owner SID，既有路径owner不匹配时拒绝。

## 测试与 evidence

`bun run --cwd packages/kite-local-runtime test`。当前focused manager suite
`bun test packages/kite-local-runtime/test/manager`为37 pass / 135 expects；package typecheck、Biome与diff-check也已通过。
这些是本地evidence；Windows ACL负向测试由hosted Windows release candidate job执行，只有对应远端run成功后才能登记
Windows与三平台process/release evidence。

## 文档影响

codec/state/manager/native client变化更新本README；跨包Service auth、恢复、carrier、process或release变化同时更新匹配的
`docs/active/` current authority。
