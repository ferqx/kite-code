# Kite Local Runtime Service

## 定位

`@kite-ai/kite-service` 是唯一 production Runtime composition root。KLSV1-06 clean cutover 后，默认 Store 的
Runtime Host、Runtime Server、SQLite、Builtin Runtime、Runtime Application、raw History projector与 App Control
owner全部只在本Service；`apps/kite-cli` 只保留 terminal presentation与Native client。

## 拥有职责

- `src/composition.ts` 组合唯一 Runtime Application、Host/Store/Builtin execution、Runtime Server、History reader、
  Workspace router、interaction broker、App Control与共享 mutation gate。
- 拥有service-owned config/credential、Workspace Trust、Provider/model、MCP Supervisor/auth、Skill、Sandbox/Shell、Git、
  observability、session logging、checkpoint与release/execution status owner；向client只投影closed safe contract。
- `src/executable.ts` 是managed companion foreground entry。它从manager提供的显式neutral environment构造canonical
  default checkpoint/config paths，启动Native infrastructure，并以dedicated fd发布readiness；stdout不承载readiness。
- Native infrastructure只绑定 `127.0.0.1:0`，拥有Runtime WebSocket、History、exact App Control、credential、
  authenticated instance handshake与control stop route；state/descriptor/token/instance lock由Service正常发布/清理。
- Workspace启动保持neutral。Trust query/decision先由App Control canonicalize并持久化revision CAS；只有trusted后carrier
  才签发instance/Workspace-bound one-shot ticket，Runtime create与persisted Session identity继续交叉校验。
- 普通stop先quiesce mutation admission；busy返回`service_busy`，空闲才commit drain，关闭carrier/application后最后
  清理state。signal shutdown执行recovery-safe cancel/drain/dispose。

## 不拥有职责

- 不拥有 terminal CLI/TUI、Ink/React、presentation reducer或client preference；不导入 `apps/kite-cli`。
- 不提供第二默认Store、embedded fallback、app-to-app import、dual write、try-new-catch-old、通用多Store或OS Service。
- 不把development WebSocket reference、parent-owned stdio test carrier或KLSV1-05 fake process harness描述为额外
  production listener。Web/Desktop/public SDK仍不在V1支持面。
- manager lifecycle/state/process primitive由 `@kite-ai/kite-local-runtime/manager` 提供，release composition选择
  explicit source/installed companion与Kite home；Service process不自行扮演client manager。

## 允许依赖

允许依赖唯一 backend composition所需的 Builtin Runtime、Runtime Host/Server/SPI/Contract/Protocol、SQLite adapter、
browser-safe App Contract与Native-only local-runtime substrate。禁止依赖 CLI/TUI或另一个App source。

## 公开入口

package根入口只服务repo内部composition/test。compiled `kite-service` companion接受exact internal `service run`，由
managed manager以显式absolute executable、neutral cwd、allowlisted env和dedicated readiness fd启动；普通用户通过
`kite service ensure/status/stop/restart` 控制窄lifecycle surface。

OSS candidate同包输出 `bin/kite`、`bin/kite-tui` 与相邻 `bin/kite-service`（Windows为`.exe`）；manifest、install
preflight与active launcher验证都把companion作为required file。source mode固定解析repo内Service entry，installed mode
固定解析当前terminal executable相邻companion，不从cwd或PATH猜测。

## 关键不变量

- default canonical Store只有本Service一个Host/writer/root；terminal disconnect不取消Turn、不disposeHost/Store。
- Service-owned Shell composition 对普通repository继续只授权canonical Workspace；若Workspace是Git注册的linked
  worktree，则仅把通过标准namespace、commondir与reciprocal backlink验证的primary `.git`作为只读runtime root
  传入native sandbox，不授权primary working tree，也不把generic Shell升级为Git transaction owner。
- Runtime Application、state与transport基础设施都必须ready后才发布descriptor；没有noop listener/state或伪ready。
- descriptor发布身份必须由manager通过`GET /readyz`后authenticated exact `POST /_kite/instance`重新证明，不能回显或
  信任磁盘descriptor。instance/Protocol/client-contract/server/build任一缺失或不匹配都fail closed；expected build
  drift返回`incompatible + build_mismatch`，任一结果都不授权清理alive/uncertain state或spawn replacement。
- access/control token独立且restart-scoped；ticket为32-byte base64url、hash-only、30秒TTL、一次性、instance与
  Workspace bound。credential、token、raw Provider body与diagnostic secret不跨client seam。
- Windows filesystem state通过current-user SID、protected owner-only DACL与non-reparse verifier保护；ACL drift
  fail closed。hosted Windows lifecycle/release job通过前，本地POSIX/focused tests与candidate layout仍不构成
  KLSV1-07三平台或全部PTY通过。

## 本地文档

- [Runtime Application 与 App Control](docs/runtime-application.md)
- [Native/stdio/development carrier](docs/runtime-server-carrier.md)
- [Service state 与锁](docs/service-state.md)
- [Service auth boundary](docs/service-auth.md)
- [Service lifecycle 与恢复](docs/service-resilience.md)
- [KLSV1-05 fake process harness](docs/process-harness.md)

## 测试

`bun run --cwd apps/kite-service test`、`bun run --cwd apps/kite-service typecheck`。owner tests覆盖relocated Runtime/
History/App Control与Native shell/carrier；当前owner run为1358 parallel tests / 6765 expects并通过全部34个isolated
files。manager focused evidence位于`packages/kite-local-runtime/test/manager`（37/135）。完整40个TUI PTY scenario与
本机macOS arm64 release smoke已经通过；正式Windows及当前实现head三平台process/release qualification仍pending。

## 文档影响

Runtime/application/carrier变化更新本README及对应本地文档；跨包Runtime authority、Trust、History、恢复、release或
qualification变化同步更新匹配的`docs/active/`与`tests/README.md`。
