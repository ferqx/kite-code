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

History adapter 将首次读取投影出的固定水位 transcript 按根／准确父子作用域保留最多 30 秒，供后续分页请求复用；每页仍先从 Store 核对 Session 身份与子线程血缘。Store 提供每 Session 事件内容代次时，新导航的首个无水位请求只在代次不变时复用投影；事件同水位改写也会推进代次。旧读取端口不提供代次时仍重新读取。首次扫描限于读取 Session 时观察到的 source sequence。缓存最多 256 条、按 JSON 字节估算的合计上限为 128 MiB，单条估算超过 32 MiB 不保留；这不是 JS 堆内存上限。淘汰后按原路径重新读取；carrier 对已排序记录按 sequence 定位下一页，不再从第一条逐项跳过。每份投影带内容 digest，后续页携带首次 digest，版本变化时 carrier 拒绝该页并由客户端整次重试一次，不拼接新旧记录。缓存只减少重复只读投影，不取得 Session 执行权，也不改变固定水位和响应大小限制。取舍见[Agent Note](../../../.agents/notes/implemented/bug-fix/2026-09-28-bound-history-transcript-cache.md)；验证见[History adapter 回归](../test/runtime-history-client.test.ts)、[分页 carrier 回归](../test/isolated/runtime-stdio-carrier.test.ts)与[100 组父子线程验收](../test/isolated/history-100-pairs.test.ts)。

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

`bun test --no-orphans apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts apps/kite-service/test/agent-api/context.test.ts apps/kite-service/test/isolated/runtime-stdio-carrier.test.ts apps/kite-service/test/isolated/runtime-transport-conformance.test.ts`。
这些local结果不构成KLSV1-07 Windows/三平台或全部PTY evidence。

初始化后的 History 与明确只读辅助请求使用独立容量。每连接 History 至多接纳 256 个未完成读取、3 MiB 排队输入；App 辅助读取至多接纳 64 个、1 MiB。共享同一 History owner 的全部连接再受总计 8 个执行中、1024 个未完成读取、12 MiB 输入帧约束；同一 Runtime Server 的 App 辅助读取受总计 16 个执行中、256 个未完成读取、4 MiB 输入帧约束。两类读取分别按连接轮转，每次启动前让出一轮事件循环。达到任一上限返回 `overloaded`；排队及过载响应不阻塞后续帧解析，单个输入块每解析 64 帧还会让出事件循环。只有可处理取消通知且注入 History owner 的 stdio carrier 才声明 `history/cancel`；generic InProcess 连接不声明。客户端可按同连接原 RPC id 取消等待中或执行中的 History 读取；连接关闭也取消该连接的排队读取。执行中读取若 10 秒未结束，返回可重试的固定错误；若响应已进入有界输出队列，超时不再生成第二个响应。App Control owner 不接受取消信号，因此其执行名额直到实际调用结束才释放；16 个永久不返回的 owner 调用会使新的 App 辅助读取过载或超时，不能声称该 owner 自动恢复，Runtime 与 History 容量不受此影响。stdout 按序写入，每连接积压超过 2048 帧或 8 MiB、同一 Runtime Server 的全部连接积压超过 8192 帧或 64 MiB 时关闭触发超额的连接，避免多连接背压使输出队列无限增长。读取失败返回稳定 detailCode 与 retryable，不泄漏 SQLite 或路径错误；这些额度是负载保护，不是 Store 的 Session 数量上限。

排队超过 10 秒的 History 或 App 辅助读取返回可重试错误并释放排队名额；执行中读取的 10 秒超时从开始执行时另行计算。

Store-backed App Server 的分页根／子 History 读取由固定两个内部子进程执行。每个进程只运行一个 SQLite 只读快照与事件投影，最多排队 64 个请求、保留 32 MiB 估算编码 transcript 缓存；单次正文读取限 9 秒、32 MiB source、32 MiB 投影及 50,000 条记录，完成后只返回一页。超预算返回 `history_too_large`，不返回截断内容。协议允许的无 `page` 根／子完整读取也交给该子进程；只有完整响应装入单个协议帧才返回，否则明确返回 `history_too_large`。带搜索词的列表也在此子进程中逐页筛选，达到结果页后停止，搜索取消或超时同样终止占用的进程。取消执行中的读取会终止该子进程并为后续请求重建，其他已排队读取仍可继续；子进程失败或超时返回可重试错误。这样大 History 的同步扫描不占用 Runtime 主事件循环。非 App Server 或测试注入的 History owner 仍可走直接读取 fallback，不享有此隔离。

[载入预算取舍](../../../.agents/notes/implemented/architecture/2026-09-28-bound-history-read-admission.md)解释有界接纳、进程隔离和取消的原因。[carrier 回归](../test/isolated/runtime-stdio-carrier.test.ts)覆盖 5 条连接、1100 个 History 请求、轮转公平、控制请求继续响应、断连取消和堵塞 stdout 的过载收尾。[父子会话协议链路测试](../test/isolated/history-protocol-100-pairs.test.ts)默认核对 100 组，可用 `KITE_HISTORY_STRESS_GROUPS=1000` 或 `2000` 跑 2000/4000 个 Session；加 `KITE_HISTORY_STRESS_PROCESS_PAGES=1` 还会接入真实内部子进程页读取。测试覆盖完整内容、分页、反复切换、同水位改写、RPC 身份、明确过载后重试及并行 Runtime 查询。输入输出仍通过内存 stdio 桥接，不代表真实桌面界面延迟或无限规模保证。[子进程页测试](../test/isolated/history-page-pool.test.ts)另外覆盖作用域、成功后的失败回复、超大 History 明确拒绝后继续、取消与关闭。
