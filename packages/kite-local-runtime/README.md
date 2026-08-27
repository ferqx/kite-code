# Kite Local Runtime

## 定位

`@kite-ai/kite-local-runtime` 是 Kite managed Local Service 的 Bun/Node-only、repo-private Native substrate。它以互斥
`./client`、`./manager`、`./service` exports冻结descriptor/token/lock/lifecycle、instance handshake、Native
credential及Runtime/History/App Control connection contract；它不创建Runtime Host/Store/Server composition。

## 拥有职责

- `./client`：strict descriptor/access discovery、两阶段App Control/Runtime connection、one-shot ticket WebSocket、
  三个History route、exact App Control/Native credential client与`LocalKiteConnection`。`prepareAppControl()`只准备
  authenticated control plane；caller确认Workspace trusted后才显式`connect()`。
- `./manager`：单一ensure/status/stop/restart state machine、native process/spawn/PID probe、cross-process lifecycle lock、
  neutral environment与explicit executable resolver composition。manager拥有control token；普通connection不取得它。
- manager probe先 `GET /readyz`做liveness precheck，再以access token `POST /_kite/instance`、exact `{}` body读取
  process-owned strict identity；绝不从磁盘descriptor合成healthy response。
- `./service`：strict descriptor/lock/token codec与fixed `runtime-service/v1` filesystem layout；提供no-follow、owner-only、
  bounded read、sibling temp+fsync+atomic rename、instance/lifecycle lock及exact stale quarantine/cleanup primitive。
- 固定client contract revision、Protocol V1 identity与loopback endpoint shape；拒绝unknown field、non-loopback endpoint、
  secret-bearing descriptor与unsafe JSON。

## 不拥有职责

- 不监听端口，不实现HTTP/WebSocket listener，也不创建Host、Runtime Server、Builtin Runtime、SQLite或第二composition；
  这些production owner只在`apps/kite-service`。
- manager只在PID明确dead且exact identity仍匹配时cleanup；alive/uncertain、malformed state、handshake mismatch与unknown stop
  outcome均fail closed，不kill、不spawn replacement、不回显descriptor identity。
- 不依赖 Runtime Host/Server/Builtin/SQLite、React、Ink或任何`apps/*`。
- 不自动retry/replay Runtime或App Control mutation；response丢失必须按
  `outcome_unknown → exact state query → explicit decision`处理。
- 不定义generic RPC、Browser transport、Desktop IPC、public SDK、OS Service或默认Store path。

## 允许依赖

只依赖 `@kite-ai/kite-app-contract`、`@kite-ai/runtime-client`、`@kite-ai/runtime-protocol` 与 codec所需`zod`。
source不得导入Host/Server/Builtin/SQLite、React/Ink或`apps/*`。

## 公开入口

只导出 `@kite-ai/kite-local-runtime/client`、`@kite-ai/kite-local-runtime/manager` 与
`@kite-ai/kite-local-runtime/service`。不提供root export，不暴露跨layerimplementation。

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
  symlink/hardlink/type drift；Windows通过fixed system PowerShell校验current-user SID、protected owner-only DACL与
  non-reparse file/directory。explicit home先验证non-link/current owner再收紧权限；state创建时收紧ACL，后续每次敏感
  读取、替换与清理都重新验证，既有state ACL/reparse drift fail closed。

## 测试与 evidence

`bun run --cwd packages/kite-local-runtime test`。当前focused manager suite
`bun test packages/kite-local-runtime/test/manager`为37 pass / 135 expects；package typecheck、Biome与diff-check也已通过。
这些是本地evidence；Windows ACL负向测试由hosted Windows release candidate job执行，只有对应远端run成功后才能登记
Windows与三平台process/release evidence。

## 文档影响

codec/state/manager/native client变化更新本README；跨包Service auth、恢复、carrier、process或release变化同时更新匹配的
`docs/active/` current authority。
