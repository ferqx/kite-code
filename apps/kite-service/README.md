# Kite Local Runtime Service

## 定位

`@kite-ai/kite-service`拥有production backend composition。当前source/release的TUI、`run/resume`、`service *`与`web`按
canonical Kite Home复用唯一Local Service；该进程拥有唯一Store 9 writer、Runtime Host、Controller authority、Native endpoint与
loopback HTTP listener。Workspace仍是Trust、配置、MCP、Skill、Sandbox、Git与query scope，但不拥有独立进程或数据库。

`apps/kite-cli`只保留terminal presentation和Native client。Coordinator、Workspace Worker进程拓扑及Store 6/7/8代码不得回到普通
terminal/Web data plane；独立Web Gateway process/control/state实现已经删除。

KASD-02新增尚未接默认client的内部`app-server run-stdio`入口。它从显式profile打开`kite-session.sqlite`多连接owner，以parent-owned
JSONL承载现有Runtime Protocol，复用同一Host/Builtin/config/Trust composition，但不创建single-Service reservation、Native socket、HTTP或
Web。每个进程只cancel/dispose自己持有generation的Session；list/get/checkpoint是单SQLite read snapshot，不取得writer。统一Kite App
History读取已通过同一条initialize后的JSONL connection提供，Runtime Server不取得History/Store authority。App Control方法面与
TUI/candidate launcher尚未完成，因此当前production定位仍是上文single-Service。

## 拥有职责

- `src/composition.ts`组合唯一Runtime Application、Host/Store、Builtin execution、Runtime Server、History、Workspace router、
  interaction broker、App Control与共享mutation gate。
- Service拥有config/credential、Workspace Trust、Provider/model、MCP Supervisor/auth、Skill、Sandbox/Shell、Git、observability、
  session logging、checkpoint及release/execution status，并只向client投影closed safe contract。
- 用户配置、MCP配置、Project approval与Workspace Trust写入复用`kite-local-runtime/config`的owner-specific跨进程lock、持锁后revision
  重读和atomic replacement。Provider/model跨user/project两文件按canonical顺序取锁并在写前重新CAS；不存在global config daemon或宽锁。
- `src/executable.ts`接受manager专用的exact `service run-single`入口，从显式canonical home、build identity、neutral cwd、allowlisted env和
  readiness fd启动；stdout不承载readiness。
- `src/single-service-infrastructure.ts`在每个canonical home的唯一native reservation内发布Unix socket或Windows named pipe；
  access/control capability与process identity只在进程内和IPC握手中存在，不写入Kite Home。
- `bootstrap.ts`打开唯一`kite.sqlite` connection，组合Store 9 Directory、RuntimeStorage、Controller/recovery authority、Run/checkpoint/
  receipt及八类typed private Artifact backend。Workspace execution context按需建立，但复用同一Host/writer。
- native Runtime command在每次admission时用已认证socket的client/connection generation读取Store 9当前Session Controller；Controller
  generation进入opaque command binding reference，不固化为socket建连快照，因此同一TUI可在多个Session间切换且旧connection generation仍
  fail closed。执行复用现有Runtime/Host的per-Session mailbox、transaction、receipt与recovery，不增加第二套command registry。
- 同一Service listener同时承载Native/Runtime、Agent API `/v1`和Browser static route。Service发布ready前验证并挂载fixed Web assets，
  `GET /`直接返回index并创建或复用read-only HttpOnly Browser session；Web只读Workspace/Session/History/Log/Model Context/Checkpoint。cookie不能访问
  Native/Controller/mutation route，Native authorization也不能混入Browser request；Web route只随Service关闭。
- Browser Model Context诊断复用同一Store 9 Artifact backend和Builtin schema-aware reader，只能从可见Session的exact prepared invocation读取
  bounded provider-neutral system/messages/tools；不打开第二DB、不提供通用Artifact读取，也不暴露ref、Provider options、endpoint或Credential。
- Browser History将`tool.rejected`投影为独立pre-dispatch `rejected`状态与稳定reason code，不再伪装为执行失败；
  Public摘要不携带raw Runtime reason、命令或路径。
- Native Runtime Client 的 tool queue projector 只把 Runtime 已确认
  `effectClass=read_only + sideEffect=false` 的 Shell 投影为 `exploration`；未知、写入或有副作用的 Shell
  保持 `standalone`。CLI/TUI 只消费该 closed presentation fact，不解析命令文本建立第二套分类权威。
- 项目采用未发布clean cutover。Service只打开current `kite.sqlite`，不扫描、迁移或删除旧DB/layout/Artifact/process state及
  `.kite-code-coordination`；正式release不组合legacy companion或migration owner。
- Workspace Trust先由App Control canonicalize并持久化revision CAS；只有trusted后才建立Runtime execution context。Provider未配置时可完成
  neutral first-run配置，但不创建第二Host、第二Store或fallback backend。
- 普通stop先线性化quiesce mutation admission，再同时检查gate临界区与Host-owned长生命周期Session operation；任一active都恢复admission并
  返回`service_busy`，空闲才commit drain。signal shutdown执行recovery-safe cancel/drain/dispose。
- 并发Native control stop在Service shell内single-flight，只产生一次quiesce/commit/cleanup；不同manager不共享进程内Promise，但native
  reservation确保换代spawn只有一个winner，loser只观察ready owner。

## 不拥有职责

- 不拥有terminal CLI/TUI、Ink/React、presentation reducer或client preference，也不导入`apps/kite-cli`。
- 不提供第二默认Service、第二Store、embedded fallback、dual write、try-new-catch-old、通用多Store或OS Service。
- 不把development WebSocket reference、parent-owned stdio fixture或fake process harness描述为额外production listener。
- 不提供remote/LAN、多租户或Browser mutation data plane。Web是private loopback REST observer；Agent API的角色与能力受独立contract约束。
- manager lifecycle/process primitive由`@kite-ai/kite-local-runtime/manager`提供；Service process不自行扮演client manager。

## 允许依赖

允许依赖唯一backend composition所需的Builtin Runtime、Runtime Host/Server/SPI/Contract/Protocol、SQLite adapter、browser-safe App
Contract、browser-safe Agent API Contract、Browser HTTP client与Native-only local-runtime substrate。禁止依赖CLI/TUI或另一个App source。

## 公开入口

package根入口只服务repo内部composition/test。compiled `kite-service`只接受manager调用的exact internal `service run-single`；普通用户通过
`kite service ensure/status/stop/restart`控制窄lifecycle surface。

同一internal executable也接受exact `app-server run-stdio`，但当前没有公开CLI route或默认launcher；直接调用必须提供显式profile、Workspace与
build identity，不能发现/替换shared Service，也不能产生Web endpoint。

OSS candidate只输出`bin/kite`、`bin/kite-tui`、`bin/kite-service`（Windows为`.exe`）及`payload/web`。manifest中的
Coordinator/Worker/Gateway slot必须为null，archive不得包含相应executable或launcher。`payload/web/api-docs/openapi.json`是必需的Agent API
contract asset；installed mode只从launcher固定的immutable candidate root解析Service和Web assets，不从cwd或PATH猜测。

## 关键不变量

- installed/shared topology中每个canonical Kite Home最多一个Service、一个Runtime Host、一个Store 9 writer与一个`kite.sqlite`；source
  standalone为每次TUI调用分配独立临时Runtime Home，不共享该Store owner。
- Kite Home只保存用户配置、`skills/`、`sessions/`和`kite.sqlite`及SQLite companion；不得写process descriptor、token、socket、lock、
  launch intent、layout sidecar或filesystem Artifact root。
- source standalone通过`KITE_CODE_CONFIG_HOME`从canonical Home读取配置、Trust、MCP与Skills，`KITE_CODE_HOME`只指向临时Runtime Home；
  Service成功停止后release composition删除临时Home，停止不确定时保留现场且不删除活跃Store。
- POSIX每home runtime只允许`service.sock`与`service.lock`；Windows endpoint使用named pipe。custom home按canonical home digest
  隔离endpoint并作为相互独立的profile，不增加跨home coordination。
- Web assets是Service的exact启动输入；`index.html`、OpenAPI或hashed JS/CSS缺失时Service不发布ready。客户端不能在Service ready后
  attach、替换或停止Web route。
- Store 9 mutation直接使用同一`BEGIN IMMEDIATE` transaction。Session初始State/snapshot/receipt/recovery identity/Controller state与
  receipt共同commit或rollback；Session删除同事务清理namespaced authority。数据库不保存migration phase、first-write marker或旧Coordinator
  operation receipt。
- Controller恢复绑定client/service identity、connection generation与rotating capability。Service restart只在取得新exact reservation后把旧
  instance lease转为detached；同一logical client恢复到新generation，不启动Worker process。
- status/stop在Service absent时不spawn。stop response丢失只沿原PID/start identity/reservation有界确认，不自动重放mutation。
- Native `describe`允许Protocol/client-contract兼容的其他build发现并连接ready Service；返回值始终携带Service真实build与其自身Web origin。
  `service_stop/restart`仍要求client expected build与owner build一致，不匹配时保持Service ready且拒绝控制操作。
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
