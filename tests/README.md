# 测试体系

本页是测试归属、发现和默认执行模型的 current authority。

## 环境基线

Required CI、release/platform smoke 与正式 Runtime qualification 统一使用 Bun `1.4.0`。性能对比只有在
相同 Bun 版本和同类 runner 环境下才可作为正式基线证据；其他本地版本只提供补充诊断。

## 目录归属

- `packages/<owner>/test/`：单 package 行为与 contract。
- `apps/kite-cli/test/`：CLI/TUI presentation、client preference、managed Native adapter与fake/client conformance；不得
  创建default Host/Store composition。
- `apps/kite-service/test/`：唯一Runtime Application/Host/Store/Builtin owner、raw History/App Control、config/MCP/
  sandbox/session logging、Service shell、Agent API与carriers；退役Browser BFF/WebObserver不保留production composition或owner test。旧
  Coordinator/Worker/Store 8只作为明确历史/离线机制测试；真实socket/process/state/cwd场景留在owner-local `test/isolated/`。
- `apps/kite-web/test/`：Browser REST presentation/reducer、browser-safe Agent API client consumer与静态Agent API reference；后者固定验证
  `/api-docs` routing、无form/execute control、same-origin no-credential artifact读取及availability未确认状态。该workspace不得引入
  Native、Host、Store、Protocol、Service、CLI 或 raw Runtime source，也不拥有任何 Controller use case。
- `packages/kite-local-runtime/test/manager/`：manager lifecycle、Native process/state/lock/environment与authenticated
  instance handshake；manager不再以App-private source留在Service workspace。
- `tests/integration/`：跨 workspace 公共边界，只导入 package exports。
- `tests/qualification/`：fault、soak、native 与安全 qualification。
- `tests/isolated/` 和 owner-local `test/isolated/`：修改进程环境、cwd、SQLite 文件或真实进程的逐文件测试。
- `tests/tui-system/`、`tests/e2e/`、`tests/release/`、`tests/golden/`：稳定专用套件。
- `tests/fixtures/`、`tests/helpers/`、`tests/reliability-harness/`：非测试辅助资源。

根 `tests/` 不保存散落测试文件，也不使用泛化 `tests/runtime/` 作为第二 owner；clean checkout 中该目录
必须不存在，不能依赖 Git 不跟踪的本地空目录满足 discovery gate。

## Import 边界

- Owner-local tests 可以相对导入自己的非公开源码。
- Root integration 只能使用 workspace package exports 或 App 的正式测试/client surface。
- Root tests 不得相对 deep-import `packages/*/src/`。
- 不得仅为测试便利增加 production public export。

## 默认执行

`bun run test` 保持 deterministic 默认覆盖：

1. 以独立进程并行运行 workspace/App parallel-safe tests；
2. 并行运行 root integration；
3. 逐文件、逐进程串行运行 owner-local 与 root isolated tests。

并发上限是 `max(1, min(4, availableParallelism()))`。每个子进程使用独立临时`HOME`，Windows `USERPROFILE`
与其相同，`KITE_CODE_HOME`固定为该home下的exact `.kite-code` root；结束后连同root一起清理。

默认测试排除真实 PTY、fault/soak、native sandbox、spike 和 live Provider；这些使用已有显式命令。
`tests/release/single-service-real-child.test.ts`使用真实child Service与本地模型fixture覆盖Runtime socket先于Controller、首条`start_turn`、
模型dispatch/terminal、同连接多Session、外来client拒绝及旧installed build→当前build自动换代；
`packages/kite-local-runtime/test/single-service-manager.test.ts`固定验证transient/permanent busy、source隔离与精确旧build stop，旧descriptor manager
suite继续验证restart在busy、outcome-unknown与成功replacement下不重放control mutation；source TUI默认standalone，因此不再保留`tui:fresh`跨build mutation路径。
`apps/kite-service/test/isolated/app-server-process.test.ts`另以真实stdio child固定KASD内部App Server的protocol-only输出、同连接
Runtime/History/App Control/credential client、EOF active model cleanup、SIGKILL/lease/reconciliation/resume no-replay与无global endpoint。
同文件还让真实approved host-shell child记录PID，SIGKILL App Server后验证Runtime Host watchdog清理command group、successor显式reconcile且
resume不重新启动command；当前release未启用local stdio MCP，因此不以测试专用port伪造该能力。
`tests/release/app-server-client.test.ts`分别固定source checked-in entrypoint + worktree持久profile与installed launcher-pinned immutable
candidate解析；两条路径都要求client/child build identity与initialize capability精确配对，不查PATH或running Service。
`runtime-server-multi-workspace.test.ts`固定第二Server read-only不会取得或
取消第一Server的Session generation。这仍不是TUI/candidate cutover证据。

## 稳定命令

- `bun run test`
- `bun run test:all`
- `bun run test:runtime:fault`
- `bun run test:runtime:soak`
- `bun run test:e2e`
- `bun run test:tui:harness`
- `bun run test:tui:system`
- `bun run test:sandbox:smoke:native`

## Runtime Server V1 owner 与 transport 测试

默认workspace typecheck runner覆盖当前Runtime workspace集合。`packages/agent-api-contract/test/`验证Public snake_case DTO、closed request、
forward-compatible response、bounded JSON/UTF-8 limits、Interaction/Run/resync invariants，以及OpenAPI/JSON Schema/wire/example/digest
byte-exact generation；独立`check:agent-api-packages`验证zero-workspace dependency与browser-safe root export。`packages/agent-api-client/test/`
验证cookie REST、contract header/Problem、path/cursor与`after_sequence`编码。`apps/kite-web/test/`验证Workspace懒加载、Session/History/
Checkpoint presentation、generation隔离与可见性敏感增量轮询；`apps/kite-service/test/agent-api/`验证Agent capability与Browser launch exchange、
Workspace Trust/Directory scope、hash-only context/session、role/TTL/generation/revoke及bounded Workspace/Session/History/Checkpoint adapter，
包括cursor checksum/filter、History through/boundary/after-sequence、Checkpoint path non-disclosure与drain。isolated carrier tests证明HTTP复用
同一listener且credential route不混用；static carrier test固定验证退役`/_kite/web/*`业务route 404以及`/api-docs`精确allowlist。
KASAPI-02D的`apps/kite-service/test/agent-api/reference-client.ts`是test-only Public codec client；conformance suite用它同时驱动handler与真实
Worker HTTP listener，验证两种role、capability incompatibility/replay、concurrent keyset page、fixed-through History、1 MiB body/response、
16-request overload/drain、Worker replacement及non-disclosure。它不是production SDK；当前Web只有Service-owned static/auth carrier测试，
不再保留独立Gateway process restart矩阵。
`packages/kite-app-contract/test/` 验证browser-safe、no-secret、
exact App Control codec；`packages/kite-local-runtime/test/`验证Native descriptor/token/lock/lifecycle/credential codec、
filesystem state、Native connector与manager。manager focused suite还固定验证`GET /readyz`之后authenticated exact
`POST /_kite/instance`，包括strict schema/keys/values/content-type/size、malformed与instance/server/build identity
mismatch fail closed与Protocol/client-contract incompatibility。single-Service focused suite另验证兼容客户端跨expected build执行
`describe/ensure/status`时复用ready owner且spawn=0，以及跨build `service stop/restart`返回`incompatible + build_mismatch`。

KLSV1-06 clean cutover后，`apps/kite-service/test/`拥有真实Runtime Application/Host/Store/Builtin、History/App Control与
carrier composition tests；`apps/kite-cli/test/`只验证default managed client/presentation、两阶段Workspace Trust、
disconnect/exit不shutdown owner及无embedded fallback。`apps/kite-service/test/isolated/process-harness/`仍是KLSV1-05
fake-application detached-child fixture，不能代替当前default Store持久恢复或release evidence。

`tests/release/single-service-real-child.test.ts`使用同一custom home与真实source child固定TUI-first、Web-launch-first和并发ensure只得到一个
ready Service；Service ready时根页面、Browser auth与`/v1`已经同源可用。它还在Controller创建后发送真实受控Runtime command、启动Run，并用Browser
fragment/cookie读取同一Session与History boundary，复核Kite Home只有一个`kite.sqlite`及允许的runtime endpoint文件。TUI persisted
observer只读这个Store 9路径，不再探测Store 7/8 layout或`checkpoints.sqlite`fallback。

KRSV1 的 package-owner coverage 固定为以下十个测试文件：

- `packages/runtime-contract/test/runtime-contract.test.ts`
- `packages/runtime-protocol/test/runtime-protocol.test.ts`
- `packages/runtime-server/test/runtime-server.test.ts`
- `packages/runtime-client/test/runtime-client.test.ts`、`packages/runtime-client/test/store.test.ts`
- `packages/runtime-host/test/command-receipt.test.ts`、`persistent-command-host.test.ts`、`persistent-command-crash-windows.test.ts`
- `packages/runtime-storage-sqlite/test/compatibility-store.test.ts`、`store-conformance.test.ts`

KRSRUN-01A另由`packages/runtime-host/test/runtime-run-store.test.ts`与
`packages/runtime-storage-sqlite/test/run-store.test.ts`固定neutral Run/receipt-result contract、Store 8 exact marker/11-table/3-index/foreign-key
shape、coverage/lifecycle/keyset/query-plan、Store 7双向拒绝及unknown/missing DDL、terminal/result drift negatives。该suite只证明unpublished
mechanism target；Host atomic lifecycle由01B补齐，migration、Worker reopen与Public `runs` capability仍由后续Task拥有。

KRSRUN-02A再由`packages/runtime-storage-sqlite/test/run-recovery.test.ts`、`run-store.test.ts`及Runtime Host的`runtime-host.test.ts`/
`state-session.test.ts`固定delete cascade与receipt retention、rewind partial/unknown拒绝及fault rollback、fork terminal origin/coverage/
no-receipt copy、reopen/Workspace isolation、pre-resume unknown投影、显式resume与unknown terminal refinement。它仍是unpublished Store8
mechanism evidence，不替代02B migration、03A production composition或release三平台qualification。

KRSRUN-02B的Store7→Store8 migration是未发布历史机制；ADR-0154 clean cutover后不再由`tests/release`或正式CLI验证/组合。current release
只验证single-Service、Store 9与retired companion absence。

KRSRUN-03A的历史证据由同一migration suite的active adapter/new-Workspace case、`workspace-worker/application.test.ts`、
`process-foreground.test.ts`及Store Catalog layout tests固定Store8-only Worker readiness/reopen、
Controller/read/Run façade、first-write fence、fresh layout/new Workspace、private Run query与Store7 no-fallback。Public `runs`与三平台hosted
candidate仍由后续Gate拥有。

这十个 owner tests 覆盖 closed contract/protocol、Server/Client state、Store 6 receipt 的原子性、restart/crash
replay 与 Store 5 source-only import；完整 durable history由SQLite log-query、
`apps/kite-service/test/runtime-history-client.test.ts`和Session persistence/format PTY journeys验证全量分页、已选
compatibility import、ephemeral→durable transcript与live/replay reducer等价；presentation replay断言位于CLI/TUI
tests。Session/TUI tests还固定
验证 reasoning delta/completed 都走无 revision 的 Server presentation route，以及 tool-bearing durable terminal
先于累计 text delta 时连续探索工具仍聚合为同一 Thought；模型展示 `requestId` 贯穿
Kernel/Contract/Protocol/history mapper，正文先于 reasoning 或 terminal 越过 ephemeral delta 时，最终正文、
Thinking 与工具聚合仍各自只有一个 block owner。TUI harness 还以逐帧
`reasoning prefix → content → reasoning suffix → terminal` 验证正文首帧关闭纯 reasoning 活动态，后到 reasoning 只
补充隐藏 Thought metadata；live 与重启 `/resume` 都不得泄漏后缀、恢复活动圆点或重复回答。会创建真实
child、socket、SQLite file、cwd 或 global process environment 的backend tests必须留在
`apps/kite-service/test/isolated/`；CLI isolated目录只保留terminal/client-owned process journey。默认runner逐文件、
逐进程串行执行，不能为了提速改成共享进程。

Runtime Server/Client owner tests 还必须固定 reconnect generation 立即失效 Session readiness、cursor 超过
Host watermark 时以 current snapshot reset/ready 收敛，以及 blocked carrier 的 in-flight send 在 settle 前继续
占用 connection/global encoded-byte budget。

三个显式 transport scripts也都是隔离套件：`bun run test:runtime:stdio`覆盖Service-owned实际child/stdio lifecycle，
`bun run test:runtime:websocket` 覆盖一次性 bootstrap、cookie、loopback socket 与 browser reference，
`bun run test:runtime:transport` 以同一 raw JSON-RPC matrix 覆盖 InProcess、真实 stdio child 与真实 development
WebSocket。该矩阵验证 initialize/allowlist、唯一 Workspace admission、subscribe ack/reset/ready、unsubscribe、
close/drain 与 bounded ping mini-soak；它不把WebSocket升级为production entrypoint。stdio child必须由parent显式提供
isolated Workspace admission与nondefault `--checkpoints` path，不能打开managed default Store。

`.github/workflows/runtime-stdio-smoke.yml` 与 `.github/workflows/runtime-transport-qualification.yml` 都在
`macos-15`、`ubuntu-24.04`、`windows-2025` 上运行相应脚本。它们是 pending qualification checks：在对应 PR 的
三平台结果实际返回前，测试文档不得称其 passed、不得以 workflow 定义代替 evidence。

## KLSV1-06/07 当前 evidence 边界

KLSV1/KCWW本地cutover Gate已执行：当前default runner的Service owner为1519 tests / 8428 expects，CLI owner为
704 + 76 sandbox + 1 conformance，共781 tests；Web workspace为17 tests。Runtime transport为3 tests / 852 expects。
相关package typecheck、Biome与diff-check通过；15-workspace typecheck及runtime package/core/pre-release/test-ownership Gate也通过。

KLSV1-07当前只登记本地结果：Runtime fault 36/106、CI-profile soak 7/7 cases、carrier 23/129、Service shell
23/97，以及macOS arm64 candidate build/verify/smoke；smoke覆盖安装、CLI/TUI、Service/Coordinator/Worker/Gateway companion
assets、真实 Coordinator→Worker ensure/mint/handshake、Web payload、MCP stdio wrapper、精确PID+OS start-token绑定的test-owned
companion cleanup、升级、回滚与卸载，结束后无该smoke残留进程。当前 release manifest 的 `releaseSlots`
已绑定 CLI、TUI、Service、Coordinator、Worker、Gateway 与 Web entrypoint/identity；asset/entrypoint smoke 不提供 formal
qualification metrics。Windows managed runner v2 marker、唯一 `active` pointer、immutable candidate pin 与 no-follow/fail-closed
只已有本地定向测试；真实 Windows ACL/write-through 及 GitHub-hosted macOS 15、Ubuntu 24.04、Windows 2025 的当前实现 head
process/transport/release evidence 在完整 matrix 成功前仍 pending，本地 POSIX、workflow 定义或单平台 artifact 不能升级平台结论。

## 迁移期测试

Parity/cutover 测试只有在每条独有断言映射到 owner 测试后才能删除。State 26 read-side compatibility、
fail-closed 和历史恢复测试继续保留，但使用领域化 compatibility 名称；schema 数字只出现在测试数据和断言中。

本次 V2 已删除两个不再比较独立实现的迁移 harness：

- 原 Agent Kernel package parity 的 State bytes、codec、129-case reducer、recovery、scheduler 与 completion
  断言分别由 `packages/agent-kernel/test/agent-kernel.test.ts`、`codec.test.ts`、`recovery.test.ts`、
  `state-migration.test.ts`、`core-reducers.test.ts` 和 `completion.test.ts` 承接；
- 原 event-type parity 的 discriminant、required-field 与 unknown-event 断言由
  `packages/agent-kernel/test/agent-kernel.test.ts` 和 `codec.test.ts` 承接。

其余改名为 conformance 的测试继续验证真实跨 owner seam，不是同一实现的自比较。

## 门禁

`bun run check:test-ownership` 验证目录、deep import、root 散落、isolated 分类和 test discovery。
`bun run test` 验证默认执行，系统/qualification 使用各自显式命令。
`tests/integration/scripts/ci-bun-baseline.test.ts` 验证所有 `setup-bun` workflow 与 formal qualification
共同 pin Bun `1.4.0`，Required workflow 只取消同一 PR/ref 的过期运行，并确保 native keyring smoke 的
path filter 与执行命令共同指向 `tests/qualification/mcp-keyring-platform-smoke.test.ts`。同一测试还验证
execution-boundary workflow 的触发路径与 adversarial command 全部使用迁移后的 `apps/kite-service/test/**` current
owner，并显式拒绝旧 `apps/kite-cli/test/**` 路径。stateful TUI overlay journey在发送确认键前等待对应action footer，
避免把标题已渲染误作输入层已ready；mutation次数与最终disk/Session断言不放宽。fixture lifecycle owner test使用真实
explicit Kite home/state absent组合，先验证manager stop fence，再验证其余server/workspace cleanup与聚合错误顺序。
