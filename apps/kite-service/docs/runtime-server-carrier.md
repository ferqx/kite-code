# Service Runtime carriers

本页是 `apps/kite-service/src/carrier/` 的 owner-local current authority。production Native loopback、parent-owned
stdio implementation与development/reference carrier都在Service workspace；只有Native managed listener进入默认路径。

## Native listener 与路由

legacy Native carrier只绑定 `127.0.0.1:0`，descriptor固定发布同端口HTTP origin与`ws://127.0.0.1:<port>/rpc`。封闭路由为
health/ready、authenticated instance handshake、connect、Runtime WebSocket、三个History use case、Workspace Trust、
Provider/model、MCP、Skill、execution/release、Native provider credential与control stop。不存在static assets、
CORS/OPTIONS授权、cookie session、Browser static/`/v1` route、restart route或generic App/RPC registry。

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
credential、resource或role。当前façade只实现`/v1/auth/exchange`、`/v1/auth/session`与`GET /v1`；其他route固定404。Agent query由
façade自行closed decode，因此不会被private carrier的全局“禁止query”规则提前吞掉；private route仍保持无query。未注入façade时
`/v1`固定404，不创建第二listener或generic route registry。

carrier close先停止接受新业务并关闭Runtime socket，再以`stop(false)`给已进入HTTP handler的响应一个有界
`drainDeadlineMs`刷出窗口；窗口耗尽才以`stop(true)`强制关闭listener。该顺序保证control stop的
`applied + draining`响应可先交付调用方，同时仍让transport owner在deadline内完成退出；它不延长Session/Turn
lifecycle，也不授权调用方在响应丢失时重放stop。

## Parent-owned stdio

stdio carrier是Service-owned code。KASD-02的内部`app-server run-stdio`是首个真实process owner：parent显式提供profile root、config root、
Workspace和build identity，Server只打开该profile的`kite-session.sqlite`，不发现managed Service且不是daemon。旧test/internal composition
仍必须提供isolated admission与nondefault Store。

stdin/stdout使用UTF-8 JSONL且stdout只承载Protocol；stderr只有fixed diagnostic。carrier primitive中的EOF仍只释放logical connection；
`app-server run-stdio` process owner观察该EOF后立即执行Server drain、active Turn cancel/cleanup、Session generation release和composition
dispose。SIGINT/SIGTERM走同一idempotent shutdown。非法UTF-8、overlong/invalid JSON与stdout failure fail closed。

显式`app-server run-daemon`复用同一JSONL logical-message carrier，但listener是独立owner-only Unix socket或Windows named pipe；
每条socket connection拥有一个carrier/Runtime Server connection并共享daemon composition。Client EOF只释放该connection，不触发
`cancelAll`或dispose。daemon只额外声明exact`server/status|server/shutdown`，parent-owned stdio不声明；shutdown response仍走同一JSON-RPC
correlation，随后owner取消active Turn、drain全部connection、关闭endpoint并dispose Store。未知字段、未initialize、缺少capability或协议版本
不匹配都fail closed，不存在外层lifecycle frame或build negotiation。

daemon v2在endpoint ready前另创建唯一`127.0.0.1:0` Web carrier；status返回strict `webOrigin`。该listener提供同build static/API Docs与
Browser cookie read-only `/v1`，直接复用daemon的Runtime/History/Directory/Checkpoint owner。Web close先停止新请求并bounded drain，随后
Runtime shutdown继续；Browser断开不等于daemon stop。legacy Native carrier已删除static route attachment，根与Browser `/v1`保持404。

App Server执行未sandboxed host Shell时，Runtime Host generic process port使用Service内嵌的
`--kite-internal-process-tree-v1`（source使用同源码child）作为POSIX watchdog；App Server意外死亡会关闭watchdog stdin，watchdog终止
同process group的实际command。正常EOF/signal仍优先走Host cancel/cleanup。该internal mode不接受普通CLI路由或command args。

同一stdio connection完成initialize后还承载三个exact durable History read。carrier在把logical message交给Runtime Server前识别并验证
`history/list_sessions`、`history/list_events`和`history/load_session`，调用App composition注入的`RuntimeHistoryClient`；每次调用的
同步Store读取由同一个SQLite read snapshot包围。未initialize返回`not_initialized`，未组合History owner返回`method_not_found`，未知
`history/*`方法和malformed params不进入Store。Runtime Server只在该composition中声明History capability，不路由或持有History。

同一connection还承载九个fixed App Control方法。Protocol只关闭方法名和外层envelope，carrier再用`kite-app-contract`既有的逐方法
request/response codec验证Workspace Trust、Provider/model、MCP、Skill、execution与release payload；mutation仍只进入既有共享
OperationGate一次，response loss不触发自动重放。App Server composition显式开启`appServerProtocol`并注入单Workspace App Control client；
普通Service/Worker不会因Store支持snapshot而发布这些capability。unknown/malformed `app/*`在调用owner前拒绝。

第十个App方法`app/provider_credential/write`不进入browser-safe App Control：carrier使用`kite-local-runtime`的现有Native credential
codec，只接纳`write_provider_api_key`，再调用Service-owned credential owner。secret只存在于parent pipe/request与配置owner，不写stdout、
diagnostic或response；response loss继续由mutation ID与`outcome_unknown`规则处理，client不得自动重放。

## Development reference

development loopback/reference仅用于同一Protocol transport qualification，不进入production support。显式daemon的private loopback Web已由
ADR-0166批准；仍不存在remote/LAN `kite server --web`或把Browser cookie提升为Runtime mutation credential的路径。

## 验证

`bun test --no-orphans apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts apps/kite-service/test/agent-api/context.test.ts apps/kite-service/test/isolated/runtime-stdio-carrier.test.ts apps/kite-service/test/isolated/runtime-transport-conformance.test.ts`。
这些local结果不构成KLSV1-07 Windows/三平台或全部PTY evidence。
