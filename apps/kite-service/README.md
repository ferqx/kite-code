# Kite Local Runtime Service

## 定位

`@kite-ai/kite-service` workspace 拥有 production backend composition。当前 release/source 的默认 TUI、`run` 与 `resume`
走 Local Coordinator → canonical Workspace Worker；每个 Worker 独占已 admission 的 Store 7、Runtime Host/Application、Controller
与 effect authority。旧单 Service/Store 6 composition仍保留给显式 `kite service *` maintenance/compatibility journey，layout
fence 禁止它与 active Worker topology 双写。`apps/kite-cli` 只保留 terminal presentation与Native client。

## 拥有职责

- `src/composition.ts` 组合唯一 Runtime Application、Host/Store/Builtin execution、Runtime Server、History reader、
  Workspace router、interaction broker、App Control与共享 mutation gate。
- 拥有service-owned config/credential、Workspace Trust、Provider/model、MCP Supervisor/auth、Skill、Sandbox/Shell、Git、
  observability、session logging、checkpoint与release/execution status owner；向client只投影closed safe contract。
- `src/executable.ts` 是managed companion foreground entry。它从manager提供的显式neutral environment构造canonical
  default checkpoint/config paths，启动Native infrastructure，并以dedicated fd发布readiness；stdout不承载readiness。
- `src/coordinator/production.ts`、`src/workspace-worker/production.ts` 与 `src/web-gateway/production.ts` 分别组合
  Coordinator control plane、单 Workspace Worker Store 7/Host/Application 与只读 Web Gateway BFF。release entrypoint 只把
  显式 source/installed executable、neutral environment、layout generation 与 readiness fd 注入这些 owner；不从 cwd、PATH、
  ambient home 或 legacy Service fallback 推导运行时。
- Coordinator registry 只保存 path-free Worker/Session metadata；Worker 的 Store 7 writer、Controller/effect authority 与
  Runtime Host 属于该 Worker；Gateway 通过 Coordinator resolve/mint 后直接连接 Worker 的 read-only History/live surface，
  不把 Worker endpoint、capability 或 Store path 投影到 Browser。
- Worker idle 时，Gateway 可按 Catalog 的 `sessionId → workerScopeId` 调用 Service-owned offline History facade。该 facade只从
  显式Kite home的active-layout推导Store 7路径，在隔离只读snapshot上复核pointer/manifest/journal/fence、owner/no-follow/file与
  Workspace binding，并在读取前后重验active generation；它不是Store authority，不创建writer、不启动Worker、不接受Browser path，
  也不调用compatibility importer。missing/legacy/corrupt/drift一律返回typed unavailable。
- Coordinator 的 Directory mirror 只通过 authenticated Worker control link 读取 current-format outbox。manager-local
  `workerScopeId` 只用于选择并复核 exact Worker，不进入 strict control request；wire body 只投影 bounded `cursor/limit`，
  再逐条复核响应 scope 后写入 path-free Catalog，避免 strict codec 把合法目录读取静默降成空目录。Gateway始终按该stable
  path-free scope投影既有Session；Worker idle/unroutable时仍返回同组Session并标记`unavailable`，不因无法取得Runtime/History而
  删除整个Workspace。Worker在线时才用authenticated identity补project label、History与live status。
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
  production listener。Web 仅通过 private loopback Gateway 提供永久只读 Observer；remote/LAN、多租户、Desktop/public SDK
  仍不在V1支持面。
- manager lifecycle/state/process primitive由 `@kite-ai/kite-local-runtime/manager` 提供，release composition选择
  explicit source/installed companion与Kite home；Service process不自行扮演client manager。

## 允许依赖

允许依赖唯一 backend composition所需的 Builtin Runtime、Runtime Host/Server/SPI/Contract/Protocol、SQLite adapter、
browser-safe App Contract与Native-only local-runtime substrate。禁止依赖 CLI/TUI或另一个App source。

## 公开入口

package根入口只服务repo内部composition/test。compiled `kite-service` companion接受exact internal `service run`，由
managed manager以显式absolute executable、neutral cwd、allowlisted env和dedicated readiness fd启动；普通用户通过
`kite service ensure/status/stop/restart` 控制窄lifecycle surface。

OSS candidate同包输出 `bin/kite`、`bin/kite-tui`、`bin/kite-service`、`bin/kite-coordinator`、`bin/kite-worker`、
`bin/kite-web-gateway`（Windows为`.exe`）及 `payload/web` 静态资产；manifest、install preflight与active launcher验证都
把这些 independent companion assets 绑定到 candidate identity。source mode固定解析repo内各自 entry，installed mode固定解析
当前 candidate 的相邻 companion，不从 cwd 或 PATH 猜测。

## 关键不变量

- default canonical Store只有本Service一个Host/writer/root；terminal disconnect不取消Turn、不disposeHost/Store。
- 默认 release terminal path 使用 State 27 / Store 7 Workspace Worker；显式 legacy Service 仍只认识 State 27 / Store 6，并在
  committed layout/fence 存在时 fail closed。Worker 只在 Coordinator 完成 materialize/admit、active layout 与 binding 复核后打开
  Store 7；两条路径不双写，也不存在 try-new-catch-old fallback。
- Runtime admission 将 authenticated `connectionId`、`requestId` 与 Worker binding reference 作为只存在于进程内的
  `RuntimeCommandContext` 传入 prepared execution closure；effect adapter 再按 Store 7 Controller/resource authority 验证，
  不把该 context 加入 Runtime wire protocol 或 Browser contract。
- 每个Session projection都从同一durable State revision投影完整、有序的client-safe interaction queue与唯一focus；
  intermediate revision不得携带未来queue。Runtime Contract/Protocol、Native与InProcess carrier消费同一替换语义，
  不能把snapshot与旧client interaction做并集，也不能因对象共享引用改变logical-message行为。Store-only启动/index
  hydration直接从已加载Runtime State投影完整queue，不实例化Workspace context，也不能把pending交互伪装为空。
  pending interaction在无关State revision前进后以稳定kind-specific identity和当前Session CAS重新投影；结算transaction
  固定使用Host inspect已接受的command revision，inspect与commit之间State再前进必须CAS失败，不能自动替换成更新revision。
  Service重启后从durable State重建pending effect与active Turn continuation；结算receipt applied后由Host重新调度原Turn，
  不依赖旧进程的waiter/closure，也不重复提交approval或dispatch工具。旧generation/digest/provider/verification/input/command
  内容仍fail closed。
- Coordinator重启加载Worker process state时先以PID + OS start token判定进程身份：confirmed dead才清除exact
  descriptor/control credential并允许replacement；alive才进入authenticated Worker handshake与reservation recovery；
  uncertain或PID reuse保持fail closed，不用已死亡endpoint阻断后续restart。Worker已正常释放同一exact reservation、文件因而
  已不存在时，manager仅在handed-off PID/start token confirmed dead后把release视为幂等完成；launching或身份不确定仍拒绝。
  同进程ensure在OS/control identity短暂不确定或dead-state cleanup未收敛时返回recovery-pending，不清理、不二次spawn；
  cleanup先删除exact credential再删除descriptor，descriptor阶段失败后只有confirmed-dead recovery可继续清理，避免留下
  无descriptor的token-only状态。已知alive Worker返回ready前还要重做authenticated control identity检查。Coordinator
  自己spawn的native Worker还保留exact child-exit handle：正常exit一发生就用instance/PID/start token proof串行回收
  reservation、registry、credential与descriptor，不等待数值PID被其他进程复用；Coordinator restart丢失handle后仍保持
  PID-reuse uncertain fail closed，不能把数值PID不同进程当成原Worker已死的证据。若新ensure正好撞上旧Worker
  draining/control关闭窗口，同一per-scope operation会有界等待owner-held child exit、完成exact cleanup后直接spawn replacement，
  不把内部drain时长泄漏成用户必须重试的启动失败。
- Gateway child 在 graceful stop 时先释放自身 instance lock，Coordinator manager 随后才清理parent-owned descriptor/control
  credential；若manager正好在两步之间退出，新manager只在descriptor的exact PID/start token confirmed dead后恢复并清除该
  partial state；Coordinator restart后为空的in-memory Gateway registry在清理同一dead instance时按幂等absence处理，不把已经
  完成的exact state cleanup误报成失败。alive/uncertain descriptor、token-only launch marker或replacement identity仍保持fail
  closed，不直接删除或spawn。
- Service-owned Workspace scope discovery把canonical Workspace之外的Git`gitDir/commondir`作为exact external-read
  identity纳入Trust snapshot/revision；用户未确认时Runtime不连接且native sandbox获得零外部root，确认后才只读投影。
  scope漂移会使trust重新变为unknown；该授权不依赖命令名、不包含primary working tree，也不升级Git write/transaction权力。
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
History/App Control、Coordinator/Worker/Web与Native shell/carrier；当前default owner run为1488 tests / 8273 expects，
manager/Coordinator focused evidence位于`packages/kite-local-runtime/test`。完整TUI PTY scenario与
本机macOS arm64 installed release smoke已经覆盖 Coordinator→Worker ensure/mint/handshake、TUI startup、精确 test-owned companion
cleanup、upgrade/rollback/uninstall并通过；正式 Linux/Windows hosted process/release qualification 仍 pending。

## 文档影响

Runtime/application/carrier变化更新本README及对应本地文档；跨包Runtime authority、Trust、History、恢复、release或
qualification变化同步更新匹配的`docs/active/`与`tests/README.md`。
