# 单 Service 本机 Runtime 与 Kite Home 边界

状态：active

读取时机：修改CLI/TUI本机连接、Service lifecycle/native IPC、Store 9、Web启动、Kite Home文件或release companion内容时。

验证：`bun test packages/kite-local-runtime/test/single-service-manager.test.ts tests/release/single-service-native-client.test.ts tests/release/single-service-real-child.test.ts apps/kite-service/test/kite-home-artifact-backends.test.ts apps/kite-service/test/web-gateway/service-lifecycle.test.ts`、`bun test tests/release`、`bun run typecheck`、`bun run release:build`、`bun run release:verify`、`bun run release:smoke`、`bun run check:pre-release-architecture`、`bun run check:docs-impact`、`bun run check:docs`。

相关：ADR-0152、ADR-0153、ADR-0154、[`Kite Home 与本机 Runtime 单一化实施方案`](../space/plans/2026-08-30-kite-home-and-local-runtime-simplification.md)。

## 当前边界

source/release entrypoint中的TUI、CLI `run/resume`、`service *`和`web`共用每个canonical Kite Home唯一的Local Service。客户端只通过
按home digest隔离的Unix socket或Windows named pipe发现Service；descriptor、access/control token、HTTP origin与Web launch session均不写
Kite Home。POSIX每home runtime只允许`service.sock`和`service.lock`，Windows endpoint不创建对应文件。除此之外不建立OS app
data/state、跨home lease或另一套coordination目录。

Service拥有一个Runtime Host、一个Store 9 writer connection和一个loopback HTTP listener。Workspace仍是Trust、配置、Skill、MCP、
Sandbox、Controller和query scope，但不拥有独立进程、DB或idle lifecycle。Browser只消费同listener中的observer route；该route不建立
Browser认证状态，`web stop`只卸载route并关闭tab/socket，不停止Service或Agent API。

Kite Home白名单是用户配置、`skills/`、Session Logger的`sessions/`以及`kite.sqlite`/WAL/SHM。运行期不得新建
`runtime-service/`、`coordinator/`、`workspace-worker/`、`web-gateway/`、`layouts/`或filesystem Artifact root。

## 启动与Web

- `run/resume`和TUI在Trust/App Control前按需ensure Service；同一ready owner直接复用。
- Native IPC contract当前为`kite-local-runtime-contract-v2`。protocol/client-contract revision相同且双方build identity均为`dev:`时，
  source build drift复用现有ready Service；installed或source↔installed drift继续拒绝。build ID不替代wire compatibility。
- `kite web`先验证fixed asset root、`index.html`、OpenAPI和hashed JS/CSS，再ensure Service。缺失返回
  `web_assets_missing`，不读取lifecycle、不spawn、不创建DB/socket/token。
- `web_ensure`额外校验`kite-app-web-observer-v2` semantic revision；revision drift返回incompatible，不把新Browser asset挂到旧Web wire。
- `web_status`只返回`absent|ready`、origin与asset digest；`web_ensure`返回同一普通loopback URL，不mint token。TUI `/web`使用ensure/open语义。
- status/stop在Service absent时不spawn。stop response丢失只沿原PID/start identity/reservation有界确认，不重放stop。

Browser打开URL不拥有本机启动权限；Vite dev server只提供前端资源。`bun run web:dev`执行build、asset preflight、Service ensure并原样
输出typed diagnostic。

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
