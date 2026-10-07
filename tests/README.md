# 测试体系

本页负责当前测试归属、发现和执行。当前默认为精确八个新 workspace；下面单列的历史机制和原资格记录不参与新默认调度，也不证明当前产品或平台通过。

## 环境基线与 owner

Required CI、release/platform 与正式 soak 固定 Bun 1.4.2。性能或稳定性结果只适用于准确代码、运行时和平台；workflow 定义不等于执行证据。

| 目录 | 当前负责范围 |
| --- | --- |
| `packages/ai/test/` | 中立模型流与明确 SDK adapter |
| `packages/agent/test/` | Loop、Execution/Job、业务 Store、I/O 与扩展 leaves |
| `packages/client/test/` | HTTP/SSE、准入、原意图、Browser/Native 公共合同 |
| `packages/ui/test/` | 公共表单、阅读门禁与便携 TUI 组件 |
| `apps/service/test/` | 可信默认装配、实际 HTTP/SSE、paired/daemon、配置与 Gateway |
| `apps/cli/test/` | 薄 CLI/TUI、宿主资源、原请求与真实 PTY |
| `apps/desktop/test/` | 便携客户端、Electron main/preload/renderer 与私有意图存储 |
| `apps/web/test/` | 只读 Browser controller、DOM 与敏感内容读取 |
| `tests/fixtures/extensions/mini-review/test/` | 有独立 package/公开入口的参考扩展 |
| `tests/isolated/unified-agent/` | 新公共进程、故障、源码外制品与安装交接 |

Owner-local tests 可读自己非公开源码；root integration 使用公开 package exports 或明确 App surface。root 不通过相对 deep-import 另建生产语义，不仅为测试便利扩大 production export。fixtures/helpers 不自动拥有测试；根不保存散落测试或第二通用 `tests/runtime/` owner。

## 默认执行与隔离

根 `test`、`test:all` 和 `test:unified-agent` 共用[同一计划](../scripts/unified-test-plan.ts)。它只发现上述当前 owner 与有限的 root 脚本安全列表，不扩展到整个旧 integration/qualification/release/e2e/golden/TUI 树。纯 `--list` 不创建 Profile、Provider 或子进程。

普通测试与安全 isolated 文件使用共享槽，isolated 每文件独立进程且进程内 concurrency=1；编译、SIGKILL、全局资源和准确分类的 exclusive 文件在并行队列 drain 后逐文件执行。macOS 最多4槽，Linux最多2槽；Windows isolated 逐文件串行。失败停止新派发，已启动任务完成 cleanup。每个测试进程使用独立临时 HOME/USERPROFILE 和准确 KITE_CODE_HOME，清理只覆盖自有目录。

维护的[Core备份](../packages/agent/test/isolated/maintenance/backup.test.ts)与[Desktop资产](../packages/agent/test/isolated/maintenance/assets.test.ts)在首DB前用[真实引擎夹具](fixtures/unified-agent/qualified-sqlite-fixture.ts)复用正式SQLite builder和公共initializer，核完整资产及发行身份；原业务预算不变，新增setup hook有限60秒。文件最后DB关闭后清理自有selected资产，外部preload资产只复验；loaded selection不能reset，因此这些文件沿原isolated每文件独立进程运行。[独立默认Source资产文件](../packages/agent/test/isolated/maintenance/mcp-source-approval-intents.test.ts)实测默认engine身份，并核严格关闭后实际Core DB/WAL/SHM的presence与完整bytes在create/inspect后保持。两个范围分别记录，单文件绿色不构成完整默认或三平台资格。

## 当前公共场景与证据

通用 Agent V1.3 的当前切片通过 `bun run test:unified-agent` 验证：新包 owner、真实 HTTP/SSE 与双 Service、外部计数工具/mini-review、[两真实进程](isolated/unified-agent/persistence.test.ts)、取消、来源刷新、显式恢复与[目标依赖边界](isolated/scripts/unified-agent-boundary.test.ts)。runner 复用默认 isolated/exclusive 分类，编译与强杀场景按逐文件隔离运行。新 `ai/agent/client/ui` 与 `apps/service/cli/desktop/web` 已纳入默认发现和 build/typecheck，根正式/default/CI已选择新闭包，原客户端测试仅作历史参考；完整能力替代与平台仍待验收。平台、完整交互、维护恢复与制品结果按[进度](../docs/plans/unified-agent-refactor-v1-progress.md)记录，部分子场景不代表完整 T/E 场景通过。

[未见 label-station 样本](isolated/unified-agent/evolution-unseen-sample.test.ts)由独立 owner 在公共接口固定后选择并实现，只有独立 manifest、资源、实现和测试。实际 manifest 构建到源外，以公共包消费真实通用 DOM 卡片→Client HTTP→无模型 Action→受控 Tool→自有 CAS 回执→Query→第二次明确操作；先等原 Execution 终态核 Action/Tool 两种拒绝零效果，两次允许效果与原 parent/rootWork 绑定，Model/Run为零。六文件 diff 和12个核心/公开基线 hash 未变支持本机有限 E01/E02/E03/E14，完整 Evolution Record 与未验证范围保留在[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-04mcp-冷原申请备份-v8-与未见扩展样本)。此处不是全部核心冻结、独立 npm 安装、实际浏览器布局或全部 E01–E14 通过；异常初始化/cleanup 由20秒所属 child kill/await 与临时根清理兜底，绿色运行不证明所有异常路径逐资源 close。

新的 [Browser SDK](../packages/client/test/browser.test.ts)、[Web controller](../apps/web/test/controller.test.ts)与 [Service 配对](../apps/service/test/isolated/development-web.test.ts)分别验证网络合同、视图代次及实际 Core/SQLite 的只读生命周期。Desktop 输入的 [意图](../apps/desktop/test/input.test.ts)与[配对](isolated/unified-agent/desktop-input.test.ts)使用固定 Model/临时新 Store，不接触用户数据。大人工附件的 Client、UI DOM 和便携 Desktop 测试分别证明完整字节/hash、显示后的键盘答复门禁及跨视图证明失效，不能合并声称正式 Electron 或原生浏览器已通过。

[CSP 回归](../packages/client/test/isolated/csp.test.ts)将真实公共 BrowserClient bundle 放入真实 Node V8 的禁用代码生成环境，验证静态生成规则的 closed 请求、嵌套响应和新增字段保留；它不是浏览器布局证据。[Web 预览夹具](fixtures/unified-agent/web-preview.ts)先构建 `apps/web`，再显式启动临时 SQLite、固定 Model 和只读 Cookie Gateway，stdout 仅返回页面 endpoint/identity 与固定计数，不输出 Native token。stdin `append` 只添加一条预定消息，`stop` 结束并清理临时数据。macOS IAB 的实际选区、复制、滚动及诊断结果由 Web owner 和进度记录；没有外部 Provider 或用户 profile。

[独立开发 Web 启动测试](isolated/unified-agent/web-launcher.test.ts)固定已选 profile/配套 entry/API/capabilities 与校验过的资产，经公开 paired Service 和只读 Gateway 验证。有限参数、stdout 仅 endpoint、坏资产零新 profile、浏览器关闭后原 Model 继续，以及真实宿主 EOF/SIGTERM 后所属 PID 和 TCP listener 消失分别断言。隔离 fixture 使用无害固定 Model；不替代正式 daemon/TUI/Electron 或发行安装资格。

[Terminal 跨代码版本](isolated/unified-agent/terminal-cross-version.test.ts)由[固定旧提交夹具](fixtures/unified-agent/terminal-predecessor.ts)调用其原 builder，与当前源码分别生成完整候选，保持同一 productVersion、锁输入和SQL基线，搬迁后删除旧source与原输出。实际安装 CLI/daemon A→B→A→B 核同原 Store、新正文完整读回和进入回退后的新模型请求、冷只读零重放、准确普通停止/EX及卸载保数据；[reader](fixtures/unified-agent/terminal-cross-version-read.ts)的裸 imports只解析各自安装候选。它沿原 isolated 每文件进程/进程内 concurrency=1，共享默认槽且不写当前checkout；Required unit完整history缺固定旧commit即失败。本机代码比较不是已发布旧fixture或Native/三平台资格，准确执行与原失败归[进度](../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07terminal-真实代码升级与冷回退)。

[Model Inspector Core](../packages/agent/test/isolated/model-input/inspector.test.ts)、[Client 完整流](../packages/client/test/isolated/model-input.test.ts)、[实际 Service/Gateway](isolated/unified-agent/model-input.test.ts)和[Web DOM](../apps/web/test/model-input.test.tsx)分别验证准确原调用、完整交接和展示。>200 目录压力通过具名 Store 建立 planned intents，不称发生了相同数量的 Provider 调用；实际17MiB内容经过原scope Artifact/固定Model与Native/Browser，成功EOF/hash前不发布正文。真实流在首块后停住仍能取消，非法metadata先释放body；UI确认前零正文GET，隐藏/关闭/切换清正文，缺失settings明确unavailable。IAB验收固定无害内容，关闭后Model计数保持，不将当前Context或Runtime logs导航等同该原请求入口。

## 显式命令与 CI


根默认和 `test:unified-agent` 共用[同一计划](../scripts/unified-test-plan.ts)：精确八 workspace、mini-review 独立扩展、新 root unified-agent 场景及有限脚本安全列表；不会发现整个旧 integration/qualification/release/e2e/golden/TUI 树。原测试机制的独立 HOME、exclusive、失败停止派发、运行者 drain 与 OS 并发上限保持。新增 source-free/真实 Native/TTY 场景按实际分类单独进程执行，不以历史排除规则丢失其断言。

新 `test:tui:system` 由[当前 runner](../scripts/run-unified-tui-system-tests.ts)从新 UI TUI 与 CLI `tui*.test.ts` owner 动态发现，按当前文件清单分配四个 shard；`--list` 只读返回准确 inventory，只有所有 shard 成功才通过既有 `tui-system` check。根 runtime mock/e2e/fault/stdio/transport 与 Desktop aliases 已指向当前 owner 测试；旧 WebSocket/standalone/foundation/模型 live aliases 已退出，未将 paid Provider 测试重命名为 mock 通过。

三平台 workflow 使用新实际 producer/SQLite/平台报告，保 Bun1.4.2、40位Action pin、PR源head、clean-source与失败上传。OS vault 只在 CI 双 gate执行随机 owned namespace；默认 gate关闭零vault调用。live MCP默认gate关闭零network，workflow明确开启后才真实官方 tools/list+Tool。ACL脚本按实际OS核private路径，Winx64走currentSID/DACL；ARM64明确unsupported，运行失败非skip。

Windows transport的原Store/config测试加[五项Node后端案例](../apps/desktop/test/isolated/windows-node-access.test.ts)，release的Native build均先调用[有限预装工具准备](../scripts/release/prepare-windows-native-ci.ts)。准备只收固定x64 compiler/SDK事实和十个环境变量，原字节严格解码、清空CL参数注入；Windows缺编译器/addon/ABI实际失败，不依据availability跳过。CI guard核原head/repository、完整消费命令和准备顺序；[纯合同测试](isolated/unified-agent/windows-native-ci.test.ts)不能代替本机未执行的Windows编译/生命周期。

完整平台与soak verifier继续拒绝缺资格：bounded source-free诊断不等于生产Shell/network/fork/resource边界，闭合v2固定七类CI不等于8外层/60分钟、每类warmup0+measured1—8原生资源和§33.3完整连续组合负载资格。旧ci-baseline/State测试保历史，不参与新默认执行；[当前CI守卫](integration/scripts/unified-ci.test.ts)核真实新调度与反例。最新执行、失败及平台范围见[当前进度](../docs/plans/unified-agent-refactor-v1-progress.md)。

当前命令以根 [package.json](../package.json) 为准。`test:mock` 使用固定模型配置；`test:runtime:fault`、`test:e2e`、`test:runtime:stdio`、`test:runtime:transport` 与 `test:desktop:native` 指向新 owner。`test:desktop:window` 验完整 Native lifecycle；`test:shell:native` 验实际 confined leaf。纯 version smoke 不能替代真实窗口/PTY/平台证据。

`check:docs` 核可检查链接、active 元数据和当前 owner；`check:docs-impact` 提示实际 diff 的产品/技术核对范围，Markdown diff 不证明语义。`check:plan-evidence` 核保留历史证据与对应代码身份，不将旧 run 当新资格。文档同步 Skill 的 ready/blocked 只覆盖对应 action，不能扩大 Git 授权或表示完整 V1.3 完成。

## 历史机制与原资格记录

以下仅保留原测试职责、设计约束和已发生的证据。旧 package、State/App Server、standalone、默认发现或命令字样不构成当前执行入口；不得用这些记录替代新 public Runtime/Client/Store 的断言或当前三平台验收。

### Runtime Server V1 owner 与 transport 测试

默认workspace typecheck runner覆盖当前Runtime workspace集合。`packages/agent-api-contract/test/`验证Public snake_case DTO、closed request、
forward-compatible response、bounded JSON/UTF-8 limits、Interaction/Run/resync invariants，以及OpenAPI/JSON Schema/wire/example/digest
byte-exact generation；独立`check:agent-api-packages`验证zero-workspace dependency与browser-safe root export。`packages/agent-api-client/test/`
验证cookie REST、contract header/Problem、path/cursor与`after_sequence`编码。`apps/kite-web/test/`验证Workspace懒加载、Session/History/
Checkpoint presentation、generation隔离与迟到日志隔离；可见性轮询的验证缺口见[Web 验证](../apps/kite-web/docs/testing.md)。
`apps/kite-service/test/agent-api/`验证Agent capability与Browser launch exchange、
Workspace Trust/Directory scope、hash-only context/session、role/TTL/generation/revoke及bounded Workspace/Session/History/Checkpoint adapter，
包括cursor checksum/filter、History through/boundary/after-sequence、Checkpoint path non-disclosure与drain。daemon Web carrier test证明
static与Browser `/v1`复用一个listener且credential route不混用；同时固定退役`/_kite/web/*`业务route 404以及`/api-docs`精确allowlist。
KASAPI-02D的`apps/kite-service/test/agent-api/reference-client.ts`是test-only Public codec client；conformance suite用它同时驱动handler与真实
Worker HTTP listener，验证两种role、capability incompatibility/replay、concurrent keyset page、fixed-through History、1 MiB body/response、
16-request overload/drain、Worker replacement及non-disclosure。它不是production SDK；当前Web由显式daemon-owned static/auth carrier承载，
不再保留独立Gateway process restart矩阵。
`packages/kite-app-contract/test/` 验证browser-safe、no-secret、
exact App Control codec；`packages/kite-local-runtime/test/`验证App Server transport、credential codec、profile/config filesystem与
owner-only daemon endpoint lifecycle。dead cleanup focused suite验证PID/start/reservation/socket identity全部exact，drift/uncertain保持fail closed。

KLSV1-06 clean cutover后，`apps/kite-service/test/`拥有真实Runtime Application/Host/Store/Builtin、History/App Control与
carrier composition tests；`apps/kite-cli/test/`只验证default managed client/presentation、两阶段Workspace Trust、
disconnect/exit不shutdown owner及无embedded fallback。旧fake process harness已删除，不能以test-only lifecycle保留退役production抽象。

`tests/release/app-server-daemon.test.ts`负责Web当前证据：absent discovery不spawn、stable origin/static shell、HttpOnly Browser `/v1`读取
Native client写入同一`kite-session.sqlite`的Session、v1/v2 mismatch、双client History与stop清理。

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

KRSRUN-02B的Store7→Store8 migration是未发布历史机制；[Agent Note 0154](../.agents/notes/implemented/simplification/2026-08-30-pre-release-store9-clean-cutover.md)确定 clean cutover 后，不再由`tests/release`或正式CLI验证/组合。current release
只验证App Server、Store 9与retired companion absence。

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
逐进程执行；可并行文件仍不能为了提速改成共享进程，独占文件必须放在 `isolated/exclusive/`。

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

### KLSV1-06/07 当前 evidence 边界

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

### 迁移期测试

Parity/cutover 测试只有在每条独有断言映射到 owner 测试后才能删除。State 26 read-side compatibility、
fail-closed 和历史恢复测试继续保留，但使用领域化 compatibility 名称；schema 数字只出现在测试数据和断言中。

本次 V2 已删除两个不再比较独立实现的迁移 harness：

- 原 Agent Kernel package parity 的 State bytes、codec、129-case reducer、recovery、scheduler 与 completion
  断言分别由 `packages/agent-kernel/test/agent-kernel.test.ts`、`codec.test.ts`、`recovery.test.ts`、
  `state-migration.test.ts`、`core-reducers.test.ts` 和 `completion.test.ts` 承接；
- 原 event-type parity 的 discriminant、required-field 与 unknown-event 断言由
  `packages/agent-kernel/test/agent-kernel.test.ts` 和 `codec.test.ts` 承接。

其余改名为 conformance 的测试继续验证真实跨 owner seam，不是同一实现的自比较。

### 门禁

`bun run check:test-ownership` 验证目录、deep import、root 散落、isolated 分类和 test discovery。
`bun run test` 验证默认执行，系统/qualification 使用各自显式命令。
`tests/integration/scripts/ci-bun-baseline.test.ts` 验证所有 `setup-bun` workflow 与 formal qualification
共同 pin Bun `1.4.2`，普通Required/keyring/stdio/transport/ACL workflow只取消同一PR/ref的过期运行，正式release/platform
evidence不自动取消，并确保native keyring push只覆盖`main`且path filter与执行命令共同指向
`tests/qualification/mcp-keyring-platform-smoke.test.ts`。同一测试还验证平台job有界timeout、stdio只有一个workflow owner，以及
execution-boundary workflow 的触发路径与 adversarial command 全部使用迁移后的 `apps/kite-service/test/**` current
owner，并显式拒绝旧 `apps/kite-cli/test/**` 路径。stateful TUI overlay journey在发送确认键前等待对应action footer，
避免把标题已渲染误作输入层已ready；mutation次数与最终disk/Session断言不放宽。fixture lifecycle owner test使用真实
explicit Kite home/state absent组合，先验证manager stop fence，再验证其余server/workspace cleanup与聚合错误顺序。

### 文档结构、影响与保留证据

`bun run check:docs` 递归检查当前手册、内部文档和入口；`bun run check:docs-impact` 的 all/staged/range 输出需要核对的文档，不以 Markdown diff 证明语义正确。映射或路径错误仍失败。

`bun run check:plan-evidence` 独立检查 release/oss-first-release/evidence 中实际保留的任务和完成证据。App Server 迁移证据位于 release/app-server/evidence，由对应 release tests 消费；不再要求历史 Space 索引存在。

文档工具回归：`bun test tests/integration/docs-impact.test.ts tests/integration/docs-structure.test.ts tests/isolated/scripts/docs-impact-scopes.test.ts`。客户端行为分别使用 TUI/PTY 与 Web tests，不能互相代替。

### 文档任务路由与完成动作

文档映射按 Web 视觉/路由/数据/诊断、TUI 输入/导航/审批/投影/终端、Storage 查询/事务/authority/Artifact 和 Host 职责定位。全部生产文件仍必须有唯一 source owner；新增路径不能通过重叠或漏映射满足检查。

`tests/integration/document-sync-skill.test.ts` 使用 JSON Schema 验证 design_complete、iteration_complete 和既有提交动作，并保留 ready/blocked 输出契约。语义完整性由 skill 与评审核对，测试不把标题或字数当作正确性。

设计方案链接位于产品和技术页面；`tests/isolated/scripts/docs-impact-scopes.test.ts` 验证计划删除后两侧都必须清理链接，部分交付保持有效入口。核心回归命令：`bun test tests/integration/docs-impact.test.ts tests/integration/docs-structure.test.ts tests/integration/document-sync-skill.test.ts tests/isolated/scripts/docs-impact-scopes.test.ts`。

根入口检查覆盖仓库根目录与 docs 根目录的全部 Markdown，而非仅固定 README 名单；新增客户端规则或产品入口的失效链接同样会失败。已归档的 Agent Notes 按历史材料处理，不以旧代码路径强制改写其正文；当前文档引用仍须链接有效。


### 桌面客户端验证

`apps/kite-desktop/test` 归属桌面 owner，已加入默认测试发现。页面与 client 测试验证累计文本、持久终态、导航、恢复与发送失败不重试；bridge/preload 测试固定具名方法和 channel，不暴露通用 `ipcRenderer`。Electron host 测试分别覆盖 IPC 来源与封闭参数、项目/Git/编辑器、Service 制品与进程、窗口生命周期，以及 renderer initialize 复用、旧代次隔离和订阅清理。

`bun run typecheck` 与 runtime package gate 包含桌面 workspace。renderer 只允许 `kite-local-runtime/client/protocol` 及 browser-safe contracts，禁止 Electron、Node/Bun、Host、Store、Service concrete source 和 Native I/O 根入口；Node/Electron 依赖只存在于 main/preload owner。

`bun run test:desktop:native` 是显式配套 Service smoke，需先执行 `prepare:service`。它使用隔离 home/workspace、本地模型 fixture、真实 `DesktopHost` 与同 candidate stdio Service，验证配对 initialize、流式执行中的 renderer 重接、持久历史、活动模型 EOF 清理及后继进程读取；不调用外部 Provider，也不证明 Electron preload、原生窗口、目录对话框、隐藏/激活或工具进程树崩溃清理。

`build:desktop` 构建 renderer 与 main/preload，再由官方 Electron Packager 生成 macOS `.app`。[packaged window smoke](../apps/kite-desktop/scripts/native-smoke.ts)用于在隔离 home/app data/workspace 下驱动真实制品，核对沙箱 bridge、IPC/Service、流式刷新重接、隐藏/激活和确认退出；只有脚本实际通过并登记准确制品后才能形成 Electron 原生资格。当前该结果仍 pending。迁移前 Tauri `.app` 的本机证据保留在[原生验收](../apps/kite-desktop/docs/native-validation.md)，不替代 Electron 或正式发布与其他平台资格。

文档结构测试中的子进程检查位于 `tests/isolated/scripts/docs-structure.test.ts`；普通 workspace/契约导航读取仍在 `tests/integration/docs-structure.test.ts`，原断言保持。

桌面 Electron 安装包的显式窗口验收入口为 `bun run test:desktop:window`（先构建 `build:desktop`），通过隔离的源码外 `.app`、preload 与本机模型检查流式重接、隐藏恢复和退出；原生对话框由 fixture 代答，系统输入法和人工窗口操作资格见[桌面原生记录](../apps/kite-desktop/docs/native-validation.md)。
