# Kite Local Runtime Service

## 定位

`@kite-ai/kite-service`拥有production backend composition。当前source/release的TUI、`run/resume`、`service *`与`web`按
canonical Kite Home复用唯一Local Service；该进程拥有唯一Store 9 writer、Runtime Host、Controller authority、Native endpoint与
loopback HTTP listener。Workspace仍是Trust、配置、MCP、Skill、Sandbox、Git与query scope，但不拥有独立进程或数据库。

`apps/kite-cli`只保留terminal presentation和Native client。Coordinator、Workspace Worker、独立Web Gateway及Store 6/7/8代码只可由
显式离线迁移、legacy recovery或对应测试调用，不得回到普通terminal/Web data plane。

## 拥有职责

- `src/composition.ts`组合唯一Runtime Application、Host/Store、Builtin execution、Runtime Server、History、Workspace router、
  interaction broker、App Control与共享mutation gate。
- Service拥有config/credential、Workspace Trust、Provider/model、MCP Supervisor/auth、Skill、Sandbox/Shell、Git、observability、
  session logging、checkpoint及release/execution status，并只向client投影closed safe contract。
- `src/executable.ts`接受manager专用的exact `service run-single`入口，从显式canonical home、build identity、neutral cwd、allowlisted env和
  readiness fd启动；stdout不承载readiness。
- `src/single-service-infrastructure.ts`在每个canonical home的唯一native reservation内发布Unix socket或Windows named pipe；
  access/control capability与process identity只在进程内和IPC握手中存在，不写入Kite Home。
- Native IPC v2以protocol/client-contract revision判断兼容；双方均为`dev:` build时允许source build drift复用resident Service，
  installed/source边界保持exact。Web route另校验`kite-app-web-observer-v2`revision，不能被source复用规则绕过。
- `bootstrap.ts`打开唯一`kite.sqlite` connection，组合Store 9 Directory、RuntimeStorage、Controller/recovery authority、Run/checkpoint/
  receipt及八类typed private Artifact backend。Workspace execution context按需建立，但复用同一Host/writer。
- native Runtime command在admission时按command的exact Session从Store 9读取当前Controller lease，并复核Service instance、
  connection generation与client identity；WebSocket建立时携带的Controller Session/generation只是连接期claim，不能覆盖当前Store authority。
  因此先建立Runtime连接、再创建Controller以及同一连接持有多个Session lease都不要求重连。执行继续复用现有Runtime/Host的per-Session
  mailbox、transaction、receipt与recovery，不增加第二套Workspace command registry或跨home OS lease。
- 同一Service listener同时承载Native/Runtime、Agent API和Browser Observer route。本地Browser route不使用Cookie、launch token或
  WebSocket认证ticket；tab handle只用于连接隔离与Observer资源释放。Browser仍没有Controller/mutation route；`web stop`只卸载
  Browser route，不停止Service或Runtime。
- 项目采用未发布clean cutover。Service只打开current `kite.sqlite`，不扫描、迁移或删除旧DB/layout/Artifact/process state及
  `.kite-code-coordination`；正式release不组合legacy companion或migration owner。
- Workspace Trust先由App Control canonicalize并持久化revision CAS；只有trusted后才建立Runtime execution context。Provider未配置时可完成
  neutral first-run配置，但不创建第二Host、第二Store或fallback backend。
- 普通stop先quiesce mutation admission；busy返回`service_busy`，空闲才commit drain。signal shutdown执行recovery-safe
  cancel/drain/dispose。

## 不拥有职责

- 不拥有terminal CLI/TUI、Ink/React、presentation reducer或client preference，也不导入`apps/kite-cli`。
- 不提供第二默认Service、第二Store、embedded fallback、dual write、try-new-catch-old、通用多Store或OS Service。
- 不把development WebSocket reference、parent-owned stdio fixture或fake process harness描述为额外production listener。
- 不提供remote/LAN、多租户或Browser mutation data plane。Web是private loopback observer；Agent API的角色与能力仍受独立contract约束。
- manager lifecycle/process primitive由`@kite-ai/kite-local-runtime/manager`提供；Service process不自行扮演client manager。

## 允许依赖

允许依赖唯一backend composition所需的Builtin Runtime、Runtime Host/Server/SPI/Contract/Protocol、SQLite adapter、browser-safe App
Contract、browser-safe Agent API Contract与Native-only local-runtime substrate。禁止依赖CLI/TUI或另一个App source。

## 公开入口

package根入口只服务repo内部composition/test。compiled `kite-service`只接受manager调用的exact internal `service run-single`；普通用户通过
`kite service ensure/status/stop/restart`控制窄lifecycle surface。

OSS candidate只输出`bin/kite`、`bin/kite-tui`、`bin/kite-service`（Windows为`.exe`）及`payload/web`。manifest中的
Coordinator/Worker/Gateway slot必须为null，archive不得包含相应executable或launcher。`payload/web/api-docs/openapi.json`是必需的Agent API
contract asset；installed mode只从launcher固定的immutable candidate root解析Service和Web assets，不从cwd或PATH猜测。

## 关键不变量

- 每个canonical Kite Home最多一个Service、一个Runtime Host、一个Store 9 writer与一个`kite.sqlite`。
- Kite Home只保存用户配置、`skills/`、`sessions/`和`kite.sqlite`及SQLite companion；不得写process descriptor、token、socket、lock、
  launch intent、layout sidecar或filesystem Artifact root。
- POSIX每home runtime只允许`service.sock`与`service.lock`；Windows endpoint使用named pipe。custom home按canonical home digest
  隔离endpoint并作为相互独立的profile，不增加跨home coordination。
- `kite web`必须在任何DB、endpoint或Service lifecycle访问前验证fixed asset root、`index.html`、OpenAPI与hashed JS/CSS；缺失返回
  `web_assets_missing`且不留下状态。
- Store 9 mutation直接使用同一`BEGIN IMMEDIATE` transaction。Session初始State/snapshot/receipt/recovery identity/Controller state与
  receipt共同commit或rollback；Session删除同事务清理namespaced authority。数据库不保存migration phase、first-write marker或旧Coordinator
  operation receipt。
- Controller恢复绑定client/service identity、connection generation与rotating capability。Service restart只在取得新exact reservation后把旧
  instance lease转为detached；同一logical client恢复到新generation，不启动Worker process。
- status/stop在Service absent时不spawn。stop response丢失只沿原PID/start identity/reservation有界确认，不自动重放mutation。
- 正常Service从不删除legacy source；旧开发数据保持原样且不作为current fallback。
- Windows owner/DACL/reparse、named pipe ACL与locked-directory evidence必须由真实Windows qualification证明；macOS/Linux结果不能代替。

## 本地文档

- [Runtime Application 与 App Control](docs/runtime-application.md)
- [Native/stdio/development carrier](docs/runtime-server-carrier.md)
- [Agent API context 与 route shell](docs/agent-api.md)
- [Service state 与锁](docs/service-state.md)
- [Service auth boundary](docs/service-auth.md)
- [Service lifecycle 与恢复](docs/service-resilience.md)
- [KLSV1-05 fake process harness](docs/process-harness.md)

跨包当前边界见[`docs/active/single-service-local-runtime.md`](../../docs/active/single-service-local-runtime.md)。

## 测试

`bun run --cwd apps/kite-service test`、`bun run --cwd apps/kite-service typecheck`。single-Service manager/native/release journey位于
`packages/kite-local-runtime/test`与`tests/release`；正式Linux/Windows hosted process/release qualification仍pending。

## 文档影响

Runtime/application/carrier变化更新本README及对应本地文档；跨包Runtime authority、Trust、History、恢复、release或qualification行为
同步更新匹配的`docs/active/`与`tests/README.md`。
