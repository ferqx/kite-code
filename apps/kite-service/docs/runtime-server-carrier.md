# Service Runtime carriers

本页是 `apps/kite-service/src/carrier/` 的 owner-local current authority。parent-owned stdio、显式 daemon 与非默认 Native/Worker/reference carrier 都在 Service workspace。默认 TUI/CLI 使用配套 stdio child；显式 daemon 使用本机 socket/named pipe 并提供独立 loopback Web listener。

## 非默认 Native/Worker listener 与路由

legacy Native carrier只绑定 `127.0.0.1:0`，descriptor固定发布同端口HTTP origin与`ws://127.0.0.1:<port>/rpc`。封闭路由为
health/ready、authenticated instance handshake、connect、Runtime WebSocket、三个History use case、Workspace Trust、
Provider/model、MCP、Skill、execution/release、Native provider credential与control stop。不存在static assets、
CORS/OPTIONS授权、Browser static attachment、restart route或generic App/RPC registry；`/v1` 是否存在取决于下述显式 Agent API 注入，不应统称为404。

除health/ready外，所有route在Service ready前统一503。manager先以unauthenticated exact `GET /readyz`做liveness
precheck，再以access token发送 exact `POST /_kite/instance`、`Content-Type: application/json`、body `{}`、无query/cookie。
response是strict JSON：

```json
{
  "schema": "kite.local-runtime.instance-handshake.v1",
  "instanceId": "...",
  "protocolVersion": 1,
  "clientContractRevision": "...",
  "serverVersion": "...",
  "buildId": "..."
}
```

缺失/额外key、错误content type、超4096 bytes、malformed/value mismatch均`identity_uncertain`，不能从descriptor重建
server-owned identity，也不能据此清理alive/uncertain state。

connect只接受access token与exact `{ workspace }` body；admission重新canonicalize、检查Trust与完整Project identity后
签发32-byte base64url ticket。ticket只保存hash，固定30秒TTL、一次性且绑定instance/Workspace。`/rpc`只接受ticket；
socket close只释放connection accounting、subscription与App binding，不取消Session/Turn或关闭Host。

History handler只取得Service-owned `RuntimeHistoryClient`；App routes逐条使用exact codec。HTTP body、Runtime message、
queue、buffered amount、heartbeat与drain都有hard ceiling；binary/oversized/malformed/backpressure均按固定低信息语义
fail closed，diagnostic不携带body、token、path或secret。

同一Worker listener把`/v1`namespace委托给注入的Agent API façade。carrier只完成loopback/Host/readiness/close barrier，不解析Public
credential、resource或role。注入的 façade 可处理整个 `/v1` namespace，实际 route 与 principal 权限由 Agent API owner 决定，并非仅三个 auth/info route。Agent query由
façade自行closed decode，因此不会被private carrier的全局“禁止query”规则提前吞掉；private route仍保持无query。未注入façade时
`/v1`固定404，不创建第二listener或generic route registry。

carrier close先停止接受新业务并关闭Runtime socket，再以`stop(false)`给已进入HTTP handler的响应一个有界
`drainDeadlineMs`刷出窗口；窗口耗尽才以`stop(true)`强制关闭listener。该顺序保证control stop的
`applied + draining`响应可先交付调用方，同时仍让transport owner在deadline内完成退出；它不延长Session/Turn
lifecycle，也不授权调用方在响应丢失时重放stop。

## Parent-owned stdio

stdio carrier是Service-owned code。KASD-02的内部`app-server run-stdio`是首个真实process owner：parent显式提供profile root、config root、
可选执行 Workspace 和 build identity，Server只打开该profile的`kite-session.sqlite`，不发现managed Service且不是daemon。旧test/internal composition
仍必须提供isolated admission与nondefault Store。

stdin/stdout使用UTF-8 JSONL且stdout只承载Protocol；stderr只有fixed diagnostic。carrier primitive中的EOF仍只释放logical connection；
`app-server run-stdio` process owner观察该EOF后立即执行Server drain、active Turn cancel/cleanup、Session generation release和composition
dispose。SIGINT/SIGTERM走同一idempotent shutdown。非法UTF-8、overlong/invalid JSON与stdout failure fail closed。

Server 主动关闭 logical connection 时，stdio carrier 先销毁它拥有的 Node 输入流，再结束 iterator；Web ReadableStream 则沿 reader.cancel 取消读取。不能只等待 Node iterator.return，因为它会排在尚未收到数据的 next 后面，让已失效的连接一直等待客户端再发一条消息。此取消只作用于当前 pipe/socket，保证连接计数与 parent-owned shutdown 可以收尾；不扩大到其他 daemon 客户端或重放任务。[stdio 回归](../test/isolated/runtime-stdio-carrier.test.ts)用保持打开且空闲的真实 Node stream 核对关闭无需新请求。

显式`app-server run-daemon`复用同一JSONL logical-message carrier，但listener是独立owner-only Unix socket或Windows named pipe；
每条socket connection拥有一个carrier/Runtime Server connection并共享daemon composition。Client EOF只释放该connection，不触发
`cancelAll`或dispose。daemon只额外声明exact`server/status|server/shutdown`，parent-owned stdio不声明；shutdown response仍走同一JSON-RPC
correlation，随后owner取消active Turn、drain全部connection、关闭endpoint并dispose Store。未知字段、未initialize、缺少capability或协议版本
不匹配都fail closed，不存在外层lifecycle frame或build negotiation。

daemon v2在endpoint ready前另创建唯一`127.0.0.1:0` Web carrier；status返回strict `webOrigin`。该listener提供同build static/API Docs与
Browser cookie read-only `/v1`，直接复用daemon的Runtime/History/Directory/Checkpoint owner。Web close先停止新请求并bounded drain，随后
Runtime shutdown继续；Browser断开不等于daemon stop。legacy Native carrier已删除static route attachment，根不提供 static；未注入 Agent API 时 `/v1` 为404，Worker 注入情形按本页非默认路径处理。

App Server执行未sandboxed host Shell时，Runtime Host generic process port使用Service内嵌的
`--kite-internal-process-tree-v1`（source使用同源码child）作为POSIX watchdog；App Server意外死亡会关闭watchdog stdin，watchdog终止
同process group的实际command。正常EOF/signal仍优先走Host cancel/cleanup。该internal mode不接受普通CLI路由或command args。

同一stdio connection完成initialize后还承载三个根 Session durable History read；Store11 可另组合显式子 History read。carrier在把logical message交给Runtime Server前识别并验证
`history/list_sessions`、`history/list_events`和`history/load_session`，调用App composition注入的`RuntimeHistoryClient`；每次调用的
Store读取使用一致的SQLite只读快照；默认App Server的完整正文和分页正文在固定子进程中执行。未initialize返回`not_initialized`，未组合History owner返回`method_not_found`，未知
`history/*`方法和malformed params不进入Store。Runtime Server只在该composition中声明History capability，不路由或持有History。

`history/load_child_session` 要求同时携带父、子 Session ID；Store 的受限日志端口在每页读取时重新核验直属血缘，并使用与普通 History 相同的安全事件投影和固定 source sequence 分页。普通 `history/load_session(childId)` 仍拒绝；只有组合了该端口的 App Server 宣告新方法。

直接注入的 History adapter（非默认子进程分页路径）将首次读取投影出的固定水位 transcript 按根／准确父子作用域保留最多 30 秒，供后续分页请求复用；默认 App Server 使用下文的私有磁盘页快照。每页仍先从 Store 核对 Session 身份与子线程血缘。Store 提供每 Session 事件内容代次时，新导航的首个无水位请求只在代次不变时复用投影；事件同水位改写也会推进代次。旧读取端口不提供代次时仍重新读取。固定水位的缓存遇到代次变化时，生产 History worker 可在同一只读快照中通过 Storage owner 核对水位内原始事件行的 SHA-256；全部字段一致才复用已有投影，避免运行中仅尾部追加也反复解码与投影整段历史。摘要不一致或读取端口不支持摘要则按原路径重读。它不跳过每页身份／父子血缘核对，不替代跨页投影 digest，也不构成跨库内容或执行权证明。首次扫描限于读取 Session 时观察到的 source sequence。缓存最多 256 条、按 JSON 字节估算的合计上限为 128 MiB，单条估算超过 32 MiB 不保留；这不是 JS 堆内存上限或读取资格门禁。淘汰后按原路径重新读取；carrier 对已排序记录按 sequence 定位下一页，不再从第一条逐项跳过。每份投影带内容 digest，后续页携带首次 digest，版本变化时 carrier 拒绝该页并由客户端整次重试一次，不拼接新旧记录。缓存只减少重复只读投影，不取得 Session 执行权，也不改变固定水位和响应大小限制。取舍见[Agent Note](../../../.agents/notes/implemented/bug-fix/2026-09-28-bound-history-transcript-cache.md)；验证见[History adapter 回归](../test/runtime-history-client.test.ts)、[分页 carrier 回归](../test/isolated/runtime-stdio-carrier.test.ts)与[100 组父子线程验收](../test/isolated/history-100-pairs.test.ts)。

同一connection还承载九个fixed App Control方法。Protocol只关闭方法名和外层envelope，carrier再用`kite-app-contract`既有的逐方法
request/response codec验证Workspace Trust、Provider/model、MCP、Skill、execution与release payload；mutation仍只进入既有共享
OperationGate一次，response loss不触发自动重放。App Server composition显式开启`appServerProtocol`并注入单Workspace App Control client；
普通Service/Worker不会因Store支持snapshot而发布这些capability。unknown/malformed `app/*`在调用owner前拒绝。

第十个App方法`app/provider_credential/write`不进入browser-safe App Control：carrier使用`kite-local-runtime`的现有Native credential
codec，只接纳`write_provider_api_key`，再调用Service-owned credential owner。secret只存在于parent pipe/request与配置owner，不写stdout、
diagnostic或response；response loss继续由mutation ID与`outcome_unknown`规则处理，client不得自动重放。

## Development reference

development loopback/reference仅用于同一Protocol transport qualification，不进入production support。显式daemon的private loopback Web已由
[Agent Note 0166](../../../.agents/notes/implemented/simplification/2026-09-02-decouple-app-server-process-from-durable-session-authority.md)批准；仍不存在remote/LAN `kite server --web`或把Browser cookie提升为Runtime mutation credential的路径。

## 验证

`bun test --no-orphans apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts apps/kite-service/test/agent-api/context.test.ts apps/kite-service/test/isolated/runtime-stdio-carrier.test.ts apps/kite-service/test/isolated/exclusive/runtime-transport-conformance.test.ts`。
这些local结果不构成KLSV1-07 Windows/三平台或全部PTY evidence。

初始化后的 History 与明确只读 App 辅助请求使用独立执行容量：共享同一 History owner 的连接总计最多 8 个实际读取，同一 Runtime Server 的 App 辅助读取最多 16 个。合法未完成请求不因队列条数或累计输入字节提前 `overloaded`；原请求帧暂存于私有 0700 目录、0600 文件，等待队列只保留身份和调度 metadata，执行、取消、超时或连接关闭即回收。调度按连接轮转，每次启动前让出事件循环；输入每解析 64 帧也让出，因此排队期间 `history/cancel` 和控制请求仍可解析。只有可处理取消通知且注入 History owner 的 carrier 才声明 `history/cancel`，客户端按同连接原 RPC id 取消等待或执行中的读取，断连也取消排队工作。排队与实际执行各自限 10 秒，失败返回固定可重试错误。App owner 不接受取消信号，永久不返回的调用会占用实际执行位，后续 App 读取限时等待；Runtime 与 History 容量独立。

stdout 按序写入，驻留输出仍以每连接 2048 帧／8 MiB、同 Server 8192 帧／64 MiB 控制内存；达到阈值后生产者等待容量释放，等待中的帧暂存磁盘，不因累计传输或暂时积压直接断链。实际单帧仍按 Protocol 格式／解析边界校验；无法 drain 超过 5 秒才关闭连接，关闭中止 drain 等待并释放定时器、监听器和后续输出。阈值用于在途驻留量，不是总读取或总输出额度。排队文件新增真实 I/O 成本：本机 1,200 请求受控测试约 205ms，不能用旧版提前拒绝后的约 65ms 当作完整执行对照。

Runtime Server 上层的可靠响应与 durable 通知也按连接 FIFO 等待全局驻留容量。stdio、Native／development WebSocket 和 Service InProcess composition 都注入同一 Service-owned 磁盘 spool；Server core 只调用中立的写入／读取／回收 port，不依赖文件系统。排队正文保存在私有 0700 目录、0600 文件中，只有实际发送帧预留全局 resident bytes；从入队到发送完成共用 drain 时限，关闭立即释放容量、唤醒等待者并删除连接目录。ephemeral 展示通知保留可丢弃语义，真实 RPC 执行并发、订阅并发、单帧校验和认证边界继续生效。验证见 [Server 回归](../../../packages/runtime-server/test/runtime-server.test.ts) 与 carrier 回归。

Store-backed App Server 的分页根／子 History 读取由固定两个内部子进程执行，每个进程一次只处理一个请求，其余请求排队；排队和实际正文读取分别限 9 秒，不按队列数量拒绝。首次读取在同一 SQLite 只读快照中投影完整固定水位历史，计算投影摘要，并通过 [磁盘页快照](../src/runtime-client/history-page-snapshots.ts)按协议页写入私有文件；后续页只读取对应文件位置并校验页字节摘要，不重复解码和投影整份历史。内存只保留页位置索引、metadata 和当前页缓冲，不保留第二份完整 transcript；首次投影仍需要与正文相应的内存。每次命中前重新核对当前 root／准确父子范围、水位及内容代次，页内 Session metadata 刷新为当前值；当前 Store16 以 Session 实例身份、改写代次和历史追加水位证明纯尾部追加，持续追加不重新扫描原始前缀；改写、删除或 Session 重建则重新生成并拒绝旧投影摘要。缺少该证明的旧读取端口仍按原始固定前缀摘要核对。任意合法 sequence 游标可在已有页内继续，响应重新按当前 metadata 的实际 JSON 字节适配协议边界。私有目录由父进程原子创建，POSIX 权限 0700，文件权限 0600；快照空闲 30 秒或 LRU 淘汰后可重新生成，最多保留 256 份页索引，不以记录数或累计字节拒绝读取。正常 worker EOF 清理文件，父 owner 在取消、失败或关闭后的 worker 退出确认后清理整个目录，父 owner 仍存活时，worker 的 SIGKILL 也不留下临时快照；两者同时崩溃不承诺启动时自动回收。缓存文件丢失、存储不可用、临时缓存清理失败或证明缺失时，当前请求回到准确来源重新投影，不把缓存命中当作执行权或跨重启恢复证据。协议允许的无 `page` 根／子完整读取也交给该子进程；只有完整响应装入单个协议帧才返回，否则明确返回 `history_too_large`。带搜索词的列表也在此子进程中逐页筛选，达到结果页后停止，搜索取消或超时同样终止占用的进程。取消执行中的读取会终止该子进程并为后续请求重建，其他已排队读取仍可继续；子进程失败或超时返回可重试错误。这样大 History 的同步扫描不占用 Runtime 主事件循环。非 App Server 或测试注入的 History owner 仍可走直接读取 fallback，不享有此隔离。

2026-09-30 的生产 worker 对照用例在每次续页前追加源事件，20,001 条／40 页的后续读取由 1,865ms 降到 121ms；静态历史续页为 118ms。当前 [50,001 条大历史回归](../test/isolated/history-large-sqlite.test.ts)也在后续 97 页前持续追加，首屏约 693ms、续页合计 317ms、完整读取约 1.01 秒。源内容改写、删后重插与 Session 实例变化另由 Store／worker 回归验证，性能优化不放宽完整性判断。

2026-09-29 使用同一隔离 Store14 的 5,000 条事件，对无原始前缀摘要与启用摘要的两个独立 observer cache 做十次尾部追加，并交替测量固定水位续读：中位数由 8.38ms 降为 2.86ms。同代次命中仍不扫描前缀；首次读取需要额外建立摘要，该样本由 15.50ms 增至 17.03ms。此为直接 History adapter 测量，不含 worker 启动、RPC 或 Desktop 渲染；摘要优化降低运行中分页重读成本，不承诺首次打开加速。


[载入预算取舍](../../../.agents/notes/implemented/architecture/2026-09-28-bound-history-read-admission.md)解释排队、进程隔离和取消的原因。[carrier 回归](../test/isolated/runtime-stdio-carrier.test.ts)覆盖跨连接轮转公平、1,200 个读取排队时的控制／取消、App 与 History 隔离、3,000 个请求的慢 stdout 续读及有界断链清理。[父子会话协议链路测试](../test/isolated/history-protocol-100-pairs.test.ts)默认核对 100 组，可用 `KITE_HISTORY_STRESS_GROUPS=1000` 或 `2000` 跑 2000/4000 个 Session；加 `KITE_HISTORY_STRESS_PROCESS_PAGES=1` 还会接入真实内部子进程页读取。测试覆盖完整内容、分页、反复切换、同水位改写、RPC 身份及并行 Runtime 查询。输入输出仍通过内存 stdio 桥接，不代表真实桌面界面延迟或无限规模保证。[真实大历史分页回归](../test/isolated/history-large-sqlite.test.ts)在 SQLite 中写入 50,001 条、超过 40 MiB 的源事件并通过生产子进程读取全部协议页；2026-09-30 同机对照中，分页读取由 49.95 秒降到 1.09 秒，测试总耗时由 50.29 秒降到 1.43 秒；修复后首个页面 0.79 秒，后续 97 页合计 0.30 秒。测试核对快照文件持续复用，并以相对首屏耗时的回归断言防止每页全量重扫。这是受控 SQLite／生产子进程测量，包含进程启动和私有管道传输，不包含 Desktop 渲染，也不是其他机器的延迟承诺。[子进程页测试](../test/isolated/history-page-pool.test.ts)另外覆盖作用域、成功后的失败回复、单条源事件超过旧预算后继续、80 个同会话请求排队、取消与关闭。
