# 单 Service 本机 Runtime 与 Kite Home 边界

状态：active

读取时机：修改CLI/TUI本机连接、Service lifecycle/native IPC、Store 9、Web启动、Kite Home文件或release companion内容时。

验证：`bun test packages/kite-local-runtime/test/single-service-manager.test.ts tests/release/single-service-native-client.test.ts tests/release/single-service-real-child.test.ts apps/kite-service/test/kite-home-artifact-backends.test.ts apps/kite-service/test/single-service-infrastructure.test.ts`、`bun test tests/release`、`bun run typecheck`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:pre-release-architecture`、`bun run check:docs-impact`、`bun run check:docs`。

相关：ADR-0152、ADR-0153、ADR-0154、ADR-0156、ADR-0159、ADR-0164、[`Kite Home 与本机 Runtime 单一化实施方案`](../space/plans/2026-08-30-kite-home-and-local-runtime-simplification.md)。

## 当前边界

source/release entrypoint中的TUI、CLI `run/resume`、`service *`和`web`共用每个canonical Kite Home唯一的Local Service。客户端只通过
按home digest隔离的Unix socket或Windows named pipe发现Service；descriptor、access/control token、HTTP origin与Browser session均不写
Kite Home。POSIX每home runtime只允许`service.sock`和`service.lock`，Windows endpoint不创建对应文件。除此之外不建立OS app
data/state、跨home lease或另一套coordination目录。

Service拥有一个Runtime Host、一个Store 9 writer connection和一个loopback HTTP listener。Workspace仍是Trust、配置、Skill、MCP、
Sandbox、Controller和query scope，但不拥有独立进程、DB或idle lifecycle。Browser只消费同listener中的static asset与只读`/v1` REST；
Web route与Service同生共死，Browser logout只撤销当前HttpOnly session。

Kite Home白名单是用户配置、`skills/`、Session Logger的`sessions/`以及`kite.sqlite`/WAL/SHM。运行期不得新建
`runtime-service/`、`coordinator/`、`workspace-worker/`、`web-gateway/`、`layouts/`或filesystem Artifact root。

## 启动与Web

- source入口先构建Web；Service child从release composition取得exact static root，在发布ready前验证`index.html`、OpenAPI和hashed
  JS/CSS并挂载到唯一listener。资源缺失时Service启动失败，不存在Web absent/API ready的部分状态。
- `run/resume`和TUI在Trust/App Control前按需ensure Service；同一ready owner直接复用。`GET /`、`GET /api-docs`与受限Session shell直接返回同一个SPA index并创建或复用
  read-only HttpOnly Browser session，同origin继续提供`/v1`与精确OpenAPI asset。
- Browser SPA root持有一个production transport；route unmount不撤销Browser session，document离开且不进入back-forward cache时才清理。
- Native IPC只保留`describe/service_stop`；`kite web`与TUI `/status`先ensure Service，再从`describe.httpOrigin`返回稳定的`origin/`，
  `/status`同时展示Service identity且不保留单独的TUI `/web`。这些只读操作不挂载资源或改变lifecycle；
  `web_launch/web_ensure/web_status/web_stop`不属于当前协议或CLI。
- TUI-first、Web-first和同home并发ensure都经过同一manager/reservation，只产生一个ready Service；一个客户端退出不停止另一个。custom
  `--kite-home`只在同canonical profile内复用。只读Native `describe`即使`expectedBuildId`不同也返回兼容Service的真实identity；manager保留
  该actual build作部署决策，不能把describe成功等同于build已收敛。source普通ensure只复用`dev:`→`dev:` drift及该Service自己的Web assets；
  installed active candidate发现另一installed build时验证active pointer与旧owner并安全换代，source↔installed则返回
  `incompatible/build_mismatch`且不替换。仍运行的inactive installed TUI可在Protocol/client-contract兼容时显式reconnect当前installed
  Service，但不能通过exact-build `service stop/restart`停止或降级它。Protocol/client-contract/identity不兼容仍fail closed且不spawn。普通跨build `service stop/restart`保持
  `incompatible/build_mismatch`，只能由owner build执行。显式source `tui:fresh`只对`dev:`→`dev:`开放一次内部换代：旧Service自报build必须与
  reservation/PID/start/instance一致，previous-build client有界stop确认absent后才spawn当前Service；普通TUI和source↔installed不走该路径。
- Native socket只固定Client/connection/Workspace identity；每条mutation再从Store 9读取目标Session当前Controller并把generation绑定进
  opaque command context。Controller晚于socket创建或TUI切换Session不会沿用旧ticket快照，旧connection generation仍被拒绝。
- Web SPA的目录、API Docs与受限Session shell入口创建或复用短期read-only HttpOnly cookie；Workspace、Session、History、Checkpoint读同一个Store 9/Runtime
  authority。Browser不持有Native/Agent bearer，也不通过旧BFF或业务WebSocket读取。
- status/stop在Service absent时不spawn。stop response丢失只沿原PID/start identity/reservation有界确认，不重放stop。
- 普通stop的busy事实同时覆盖mutation gate临界区与Host-owned queued/running/waiting Session operation；真实TUI Turn未terminal时active
  candidate换代必须保持旧build/instance且`spawn=0`，Turn terminal后的后续ensure才允许收敛。
- busy response必须resume mutation admission；其他已连接TUI继续允许query与正常Session mutation。running model request和waiting interaction
  都属于busy，换代后全部Protocol/client-contract兼容的旧TUI通过各自generation显式reconnect。

Browser打开URL不拥有本机启动权限；Vite dev server只提供前端资源。source `bun run server`和`bun run tui`先build Web assets，
再ensure唯一Service；installed candidate只从immutable release root解析Service executable与payload。

## Store 9

`kite.sqlite`是唯一durable authority。一个connection承载Workspace admission、Session/event/snapshot/named snapshot、checkpoint
preimage、effect lease、command receipt、Run/tombstone、Controller/recovery namespace和Directory query。

Private Artifact保持独立typed表：Model、Plan、Capability、filesystem mutation preimage、Sandbox preparation、Subagent task/lifecycle/
continuation。Builtin schema-aware store由single-Service production注入DB backend；Plan ref的`displayPath/relativePath`使用
`kite.sqlite#...`逻辑位置，不承诺本机文件。

Store 9只保存current schema/format metadata和有生产消费者的领域事实，不保存migration phase、first-write rollback marker或旧Coordinator
operation receipt。所有mutation直接复用一个`BEGIN IMMEDIATE` transaction；普通Runtime command仍复核当前Controller generation并使用
现有Runtime/Host per-Session mailbox、receipt与recovery语义。

## Clean cutover

项目处于未发布阶段。正式CLI/candidate不提供Store 7/8 migration、legacy companion executable或`web recover`。Service启动不扫描、读取或
删除旧DB/layout/Artifact/process state及`~/.kite-code-coordination`；旧开发数据保持原样，但不是current Store 9的fallback source。任何未来
兼容承诺必须另立决策，不能重新进入普通启动路径。

## Qualification

macOS arm64本机candidate已证明release只打包CLI、TUI、Service与Web assets，并通过build/verify/install/single-Service smoke、
upgrade/rollback/uninstall。Ubuntu与Windows hosted native endpoint/ACL/SQLite evidence尚未共同收敛，不能由本机或workflow定义推断完成。
