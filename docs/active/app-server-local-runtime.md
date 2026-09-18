# 本机 App Server 与 Durable Session Runtime

> 已确认设计，尚未实现：[会话存储兼容性与连续性 V1](../plans/session-store-compatibility-and-continuity.md)将统一正式数据入口并补齐受支持路径的自动转换和会话保留验收。下文仍描述当前实现；现有格式拒绝与开发 Profile 隔离不代表跨版本会话连续性已完成。


状态：active

读取时机：修改TUI/CLI/Electron桌面本机连接、App Server进程、Session Store fencing、显式daemon/Web、profile或release升级语义时。

验证：`bun run typecheck`、`bun test tests/release/app-server-client.test.ts tests/release/app-server-daemon.test.ts`、
`bun run --cwd apps/kite-desktop test`、`bun run test:desktop:native`、`bun run release:build`、`bun run release:verify`、
`bun run release:smoke`、`bun run check:docs-impact`、`bun run check:docs`。

## 当前拓扑

开发中的 [Electron 桌面客户端](../../apps/kite-desktop/README.md)沿用自有配套 child 与同 build 配对边界：Electron main 持有 stdio 进程，沙箱 renderer 通过冻结的具名 preload bridge 复用环境无关 TypeScript client。host 与 renderer 构建和分层测试已经接入，packaged 原生窗口已通过[本机自动验收](../../apps/kite-desktop/docs/native-validation.md#electron-本机迁移验收)；迁移前 Tauri 的阶段 0 结果不自动成为 Electron 资格。下图列出既有正式入口。

`prepare:service` 复用 release owner 验证 candidate，只提取当前目标的 stdio Service 与 `desktop.json`。`build:electron` 要求该清单存在，并把 candidate build ID、服务摘要、expected server version 与环境变量名白名单编入 main bundle；打开项目只从自身资源目录启动摘要匹配的服务，不根据运行时更新的清单换版本。开发包与打包版均使用 canonical config root，不因 checkout、schema 或 epoch 改变正常数据入口；数据目录校验类型、owner 并限制为私有权限。Electron carrier 的单消费者、16 帧有界队列、1 MiB 帧、EOF 清理与异常结果由 desktop owner 维护，不能把终止自有 child 等同于停止共享 daemon。

Electron `before-quit` 进入绑定主窗口的确认；确认后先关闭 stdin，Service 清理完成才再次退出。重复退出请求不得提前取得退出许可；窗口关闭只隐藏应用。崩溃继续沿用父子连接断开和现有 Service 资源清理，不重放任务或审批。上述生命周期仍须 packaged Electron 原生场景确认。

桌面具名 `runtimeStatus` 暴露宿主当前项目和页面接入代次。renderer 刷新后，`runtimeOpen` 对已有 Service 自动重新接入，不关闭 stdin、重启任务或再次初始化底层 protocol peer。Electron renderer adapter 缓存同一 peer 的真实 initialize 结果、隔离各页面 RPC id、取消旧页面 receive 和订阅；主进程还在 document 导航、renderer 崩溃或销毁时主动 detach。新的 Runtime Client 重新查询、订阅与加载历史。旧代次的关闭不能影响新页面；项目／分支切换或退出仍按 EOF 清理。桌面连接恢复由客户端内部单一退避循环负责，复用健康 Service，仅在旧进程结束后重新启动配套服务；主页面没有连接管理操作。切换与退出取消恢复，不能让迟到接入跨越生命周期。传输重接不改变 principal、Service 授权、Session execution authority 或命令幂等，不保存第二份运行状态；当前宿主取舍见 [ADR-0184](../adr/0184-electron-desktop-runtime-host.md)。

桌面 stdio App Server 可以省略执行 Workspace，先读取同一 profile 的持久历史。`history/list_sessions` 返回有界摘要、cursor 和 Store Workspace membership；目录、历史日志、选中会话的投影查询及订阅均只读取持久事实，不触发旧执行清理。执行命令在受控恢复 scope 内核验旧执行，必要时完成资源清理与持久收尾；恢复失败不隐藏历史。投影查询返回的持久 revision 同时发布给 Host 订阅，订阅建立期间 Store 水位推进后仍须达到一致的初始水位，不使客户端无限等待加载。创建任务须显式请求并授权目标 Workspace；已有会话执行按其持久 Workspace identity 路由和核对既有信任，不以进程启动目录、Desktop项目登记或原目录仍存在限制续聊。原目录缺失时保留其持久身份和原路径，Shell/文件能力在实际调用时报告不可用；不创建替代目录、不回落到进程cwd，也不因读取历史扩大工具权限。已有会话的 `set_interaction_mode` 按持久 Session 身份核对目标 Workspace Trust，再进入同一 Host 的命令事务；不绑定进程当前执行项目，也不改变它。该操作不申请执行租约：已有本地 Runtime 时沿其 execution fence 提交，否则只在 idle／recovery_required 且版本一致时提交权限事务，保留恢复事实；仍受目标 Trust、并发执行所有权、revision 与持久回执约束，不因可读历史获得授权；完整机制见 [Service owner](../../apps/kite-service/docs/runtime-application.md#app-controlhistory-与-mutation)。历史读取不会授予写权限，停止与退出只处理当前 owner 的任务。

桌面[新对话准备](../../apps/kite-desktop/docs/new-conversation.md)不创建 Runtime Session，首次发送沿既有创建／发送命令执行。已打开项目列表属于原生应用偏好，不充当信任或 Session authority。Git 分支选择是显式本地宿主操作，仅切换已登记当前项目的已有本地分支：客户端检查项目任务，关闭自有 Service 并等待清理后，原生宿主再次核实路径、分支、HEAD 与工作区改动。失败或未知结果只重新读取实际状态，不自动重试或回滚；不扩展 Browser REST 写权限，也不承诺协调外部程序的 Git 操作。

```text
default:
TUI/CLI build X -- parent-owned stdio --> App Server build X
                                             |
                                             v
                                     kite-session.sqlite

explicit:
TUI/CLI -- owner-only socket/pipe --> App Server daemon
Web -------- loopback HTTP ------->        |
                                           v
                                   kite-session.sqlite
```

source 与 installed 的语义相同：默认 client 启动 exact same-build child，不发现常驻进程。source 以 canonical checkout digest 隔离
Store profile，installed 使用 canonical profile。App Server 退出不删除 Session/History。
profile resolver以最近存在父目录的`realpath`加未创建尾部计算无写入的稳定identity，同时保留请求路径；preparation再沿请求路径逐段执行
no-follow/owner校验，并把client与child统一到最终canonical target。Windows daemon endpoint digest忽略display casing；准备后的target会再次
推导默认endpoint，任何真实identity漂移仍会被拒绝。

## Authority

桌面模型配置使用既有 Native Provider write 和 App Control model selection；凭据只进入精确写入接口，结果未知先查询且不重放。计划审核由 Service 同时向实时与 History 投影封闭的有界 review 正文和截断标记，参与稳定交互身份比对；没有新增 Store、进程或业务重试队列。

桌面设置中的 MCP 状态、认证／取消认证／重连及 Skills 目录复用已存在的 App Control 方法；请求绑定完整 Workspace identity 和 Server revision，操作未知时不重放，Browser principal 不取得该控制能力。具体页面与验证范围见[扩展设置](../../apps/kite-desktop/docs/extensions.md)。

桌面变更阅读复用已提交文件工具记录与终态输出。原生编辑器跳转绑定当前连接，校验项目内普通文件后仅启动固定编辑器；不会把事件中的路径当成任意本机访问权限。Store 与活动 Bridge 的工作区摘要保持同 revision 一致，恢复验证覆盖真实写入、测试及继续会话。

- App Server process 只拥有自身 Host、transport、in-memory projection 与当前取得的 Session execution generation。
- Durable Store 记录 Session facts、单调 `controllerGeneration`、lease、revision、cleanup 与 effect receipt。
- 一个 Session 同时最多一个 execution writer；不同 App Server 可以并行写不同 Session。
- PID、build、socket、client connection 和 Web URL 均不是 Session authority。
- read/list 不取得 writer；resume/handoff/执行 mutation 必须取得并持续验证 durable generation。冷会话权限事务仅在 idle／recovery_required 与版本一致时允许，不清除恢复状态、不 dispatch Effect。
- stale generation 不能 dispatch effect、提交 terminal receipt 或补写 late completion；unknown outcome 不自动重放。

## 默认 paired App Server

TUI/CLI 通过 release composition 解析 child：

- source：当前 Bun、当前 checkout 的 Service entrypoint、checkout-specific profile；
- installed：launcher-pinned immutable candidate 的 `kite-service`、canonical profile。

两者都使用 `app-server run-stdio` 和同一 exact Runtime Protocol v2/capability set。source与installed配对测试都必须使用当前
protocol schema/version，旧v1 fixture不能作为兼容路径。initialize 的 build identity 必须与 client 配对；失败直接暴露，
不回退 embedded、旧 Service 或 daemon。parent EOF/退出会关闭 child，但 durable facts 保留。

client把默认same-build mismatch诊断为安装内容可能不完整，并提示更新或重新安装Kite Code；显式 daemon mismatch 则提示对同一目标执行 server status/restart；
旧开发实例缺少生命周期接口时才使用匹配客户端停止。默认配对诊断解释 initialize 版本不符；显式 daemon 通过独立 lifecycle v1 管理，不比较 client semver，
不自动stop、replace或upgrade任何进程。

默认路径不监听 HTTP、不构建 Web、不发现 daemon，也不存在 build-drift replacement。

## 显式 daemon 与 Web


`kite server start/status/stop/restart [--server <endpoint>]` 是唯一共享进程 lifecycle。默认 endpoint 是 owner-only Unix socket 或
current-user Windows named pipe；显式 endpoint 仍须满足 canonical owner-only parent。daemon 固定一个 canonical Workspace，并允许多个
兼容 client 连接。兼容依据是 exact daemon protocol/capability，build 仅用于 status 诊断。

daemon lifecycle client 将本地 `server_mismatch` 与服务端返回的 `protocol_version_mismatch` 均报告为 incompatible；
普通 start 不进入 dead cleanup 或替换；显式 stop/restart 可通过独立 lifecycle v1 控制同一实例，不依赖业务 initialize。

daemon 同进程拥有一个 stable loopback Web origin，提供 exact same-build assets、API Docs 与 Browser read-only `/v1`。
`kite web` 只读取现存 daemon status；absent、incompatible 或 identity uncertain 均失败，不 start、stop、replace 或 upgrade。
Browser cookie principal 不能进入 Native mutation/control。

status/stop absent 不创建 profile 或 endpoint state。dead cleanup 必须同时证明 PID/start identity、reservation 与 socket inode 未漂移；
alive/uncertain/drift 全部保留。普通 disconnect 不改变 daemon；显式 stop 才 cancel/drain 并清理 endpoint。

## Store 与版本

Desktop、TUI、CLI 的 source/installed 入口统一打开 `<canonical-config-root>/kite-session.sqlite`，不再计算源码 profile digest。正式读写格式为 schema 10。已取得资格的 macOS 入口在维护期自动转换严格识别的 Store 9、精确 Store 11 子集，并合并多个 Store 10 来源；只凭 schema 数字不能证明可转换。未知 epoch、未经证明的语义或较新格式保留原件并返回明确诊断。

启动准备检查已知 `kite.sqlite` 与 `source-profiles/<digest>/kite-session.sqlite` 历史来源，完成一致性备份、候选转换、内容与关联核对后发布到唯一正式入口。未能完成归并或发布结算时不创建替代空库，也不把未归并历史隐藏为成功的空列表。发布意图用于中断后的核验与接续，不以恢复旧备份覆盖当前数据。跨版本及平台的实际资格、尚未完成范围见[实施方案](../plans/session-store-compatibility-and-continuity.md)。

Desktop 与 stdio TUI/CLI 首次初始化将白名单结构化启动诊断显示为错误码和实际/预期 schema；不展示任意 stderr。Service启动组合对明确的 `store_busy` 每250ms重试准备与开库，首个busy开始最多等待10秒，每轮重新识别真实状态；正常路径不延迟。等待通过封闭的 `waiting_for_store` 阶段展示，超时仍返回busy，未知/不安全准入不重试。启动退出请求可以停止等待；已完成发布的退出不冒充提交前取消。只有实际owner打开成功后报告ready。初始化后的普通断连保持原语义。

Store owner 持有同目录固定维护文件的共享锁；迁移者必须取得独占锁，关闭或进程退出释放锁而不删除固定文件。POSIX 使用 flock，Windows 使用 LockFileEx 并由 Service 注入已有 DACL 安全校验。Windows 真实平台资格尚未完成，不能据此放行迁移。普通owner取得共享锁后重新检查发布意图及历史源，存在待结算状态时不打开或创建正式数据库。该锁不追溯约束不参与协议的历史二进制。

Provider/config/credential/Trust 使用共享 canonical config root 的 file-local lock/revision CAS。

release install/upgrade/rollback 只物化 immutable candidate 并切换 active pointer；不发现、停止或替换运行中的 App Server。已运行 daemon
继续使用自己的 executable，下一次 start 才使用新 candidate。没有 active-candidate Service replacement、previous-build client、
后台 upgrade watcher 或 compatibility range。

## 已删除的控制面

- `kite service ensure/status/stop/restart`；
- internal `service run-single` 与 readiness fd；
- single-Service manager/client、canonical `service.sock`、Native lifecycle request codec；
- descriptor/token/instance/lifecycle filesystem state；
- source standalone temporary Runtime Home；
- Service-owned Web listener和每 TUI Web listener；
- 只为旧生命周期存在的 process harness、installer fence 与 stable-launcher readiness forwarding。

## 验证

本机门禁覆盖双 App Server Store 竞争、same-Session fencing、effect crash/recovery、TUI durable resume、daemon 多 client/Web、
candidate install/upgrade/rollback/uninstall。release workflow 在 macOS、Ubuntu 与 Windows 分别运行 candidate build/verify/smoke，
并在 Windows 单独验证 endpoint lifecycle 与 Session Store fencing。

当前macOS arm64 dirty candidate `9e5ebc21d6cf30a6f7f80c7d`已通过本机build/verify与完整smoke；完整default tests与42-file TUI PTY
也已通过。implementation head `af7c7596c2e1b7b4aa6eccb12375aca017b45222`的GitHub-hosted
[run 33659494358](https://github.com/ferqx/kite-code/actions/runs/33659494358)在macOS 15、Ubuntu 24.04、Windows 2025均通过candidate
build/verify/install、paired App Server、显式daemon/Web、upgrade/rollback/uninstall和TUI PTY；Windows另通过endpoint lifecycle与
Session Store fencing/mutation真实进程测试。

## 稳定生命周期与显式重启

同一 owner-only endpoint 首帧选择 kite.lifecycle.v1 或 Runtime，之后不混用协议。生命周期只有 status 与 expectedInstanceId 绑定的 shutdown(if_idle/cancel)，16 KiB 帧上限与 5 秒请求期限；Web principal 不能进入此通道。

endpoint 排他取得先于 Store/Host 初始化，资源全部释放后才移除 endpoint。shutdown 复用 Application quiesce gate 与 Host activeOperations：if_idle 发现忙碌就 resume，cancel 关闭新 mutation 后取消并清理。状态仅投影现有 gate/Host 的布尔忙碌事实，不维护第二份任务计数。

release restart 固定目标、只读校验存储与 Web assets、按实例停止、等旧进程退出再启动；停止等待 30 秒，超时不强杀、不 spawn。并发实例改变时拒绝，不删除竞争者端点。安装/回滚只切换制品，不隐式 restart；旧客户端重连仍使用其固定 candidate。

Web shell 注入由 instanceId/buildId 派生的非凭据身份摘要，每个 API 响应携带同一摘要，浏览器入口在解码前核对；不匹配保留错误并要求重新加载。它不授予任何 Runtime 或 Session authority。

验收与尚待取得的跨平台证据见[实施计划](../plans/daemon-upgrade-lifecycle.md)。

桌面长历史通过同一 `history/load_session` 请求的只读分页参数传输，固定首次观察的 source sequence 上界，完整 source record 保持顺序和展示身份；每个响应仍满足协议帧限制。客户端汇总 records 后生成完整 transcript，不把分页或重连变成命令重放。RuntimeHistoryClient 的可选读取 signal 只停止客户端后续分页，不中断已发出的服务读取、不新增协议方法。桌面先展示已读取的持久历史或当前连接内的有界正文缓存，实时查询／订阅失败仍保留已读内容；操作资格必须等待新订阅与完整历史校准，阅读数据不产生执行 authority；具体预算与失效规则由[桌面历史 owner](../../apps/kite-desktop/docs/history-and-recovery.md#会话正文缓存与校准)维护。同连接内的消息 gap 或订阅 generation 变化也使桌面校准失效，并在保留正文的同时自动补读 History；新的 projection ready 不能单独恢复发送资格。断线后的桌面 ready 立即失效，丢失 mutation 回执先查询原命令的持久回执；查不到或查询失败才保留结果未知并要求检查实际会话与文件，不自动重发。

Service 从持久 Store 读取未由当前进程持有执行权的会话时，已完成／失败／取消的 Run 保留真实终态和 outcome；只有未收尾或 unknown 的运行使用 recovery_required 投影。缺少当前 execution owner 不能推翻已持久化的终态；该读取不修复或改写 Store。桌面历史重启回归同时核对 list_sessions 和 get_session_projection 的 completed 状态。


## 会话格式连续性准备

Service默认存储组合在初始化客户端协议前执行已知格式准备；正常连接持共享维护锁，转换及发布持canonical与所有来源的独占锁。source CLI/TUI采用当前构建和父进程准入；Desktop通过编入Electron Host的清单摘要与配对Service文件摘要核验发行身份。配对清单的纯Node helper仅供Electron主进程，renderer仍只能使用环境无关的协议入口，不能导入文件、进程观测或Service准入。

准备在私有副本完成严格9/11转换和10来源合并，维护期全量核验后才发布唯一canonical。固定短期意图优先于正常打开，发布后生产读取失败保留恢复阶段；未结清历史来源不能显示成空列表。实际支持矩阵与尚未完成的资格见[会话连续性计划](../plans/session-store-compatibility-and-continuity.md)。此机制不使任意旧安装或手动历史可执行文件自动获得跨版本并发兼容资格。

已完成历史会话的遗留 `recovery_required` 不直接成为新一轮门禁：发送取得执行权前，在 Store writer 事务内核对无 owner、无 lease、无活跃或未知 Run、无未决 effect 和完整已完成 State。满足条件只确认旧 cleanup 并使用既有 acquire；不改历史或重发旧操作，真正未决执行保留恢复要求。


关闭会话后的投影加载统一保留该 Host 已发布的 closed 状态，避免只读快照将其回退为 open；较新的清理或恢复事实仍推进投影及订阅版本，但不能仅因版本增加而重新开启会话。

子 Agent 的创建、运行、等待、自动审批及终态由持久事件投影给客户端；客户端不得将本地停止动画等同于已取消。主任务主动取消／关闭会话与服务异常终止使用显式停止原因级联到子执行；已清理的等待子任务在命令事务中收尾，活跃子任务在清理确认后收尾，崩溃遗留由持有恢复执行权的服务补正。自动审批排队与真正执行通过 `auto_review.requested`／`auto_review.started` 区分，后者必须在模型派发前取得持久确认。开始与失败事件的可选 status 字段保留旧事件读取路径；旧终态没有足够原因时不能臆造用户取消。该链路复用原会话库与执行权，具体阶段及恢复边界见 [Service owner](../../apps/kite-service/docs/runtime-application.md) 和[恢复手册](../handbook/features/recovery.md)。
