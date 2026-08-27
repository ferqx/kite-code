# Service Runtime carriers

本页是 `apps/kite-service/src/carrier/` 的 owner-local current authority。production Native loopback、parent-owned
stdio implementation与development/reference carrier都在Service workspace；只有Native managed listener进入默认路径。

## Native listener 与路由

carrier只绑定 `127.0.0.1:0`，descriptor固定发布同端口HTTP origin与`ws://127.0.0.1:<port>/rpc`。封闭路由为
health/ready、authenticated instance handshake、connect、Runtime WebSocket、三个History use case、Workspace Trust、
Provider/model、MCP、Skill、execution/release、Native provider credential与control stop。不存在static assets、
CORS/OPTIONS授权、cookie session、restart route或generic App/RPC registry。

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

carrier close先停止接受新业务并关闭Runtime socket，再以`stop(false)`给已进入HTTP handler的响应一个有界
`drainDeadlineMs`刷出窗口；窗口耗尽才以`stop(true)`强制关闭listener。control stop已经commit时，listener drain
作为terminal transport finalizer继续运行，不阻塞application dispose与state清理；进程由同一有界timer保持到
graceful/force close。该顺序保证control stop的
`applied + draining`响应可先交付调用方，同时仍让transport owner在deadline内完成退出；它不延长Session/Turn
lifecycle，也不授权调用方在响应丢失时重放stop。

## Parent-owned stdio

stdio carrier是Service-owned code，但只用于parent-owned test/internal显式composition。parent必须提供isolated Workspace
admission、明确owner lifecycle与显式nondefault `--checkpoints` path；它不能指向managed default canonical Store，也
不是CLI fallback或daemon。

stdin/stdout使用UTF-8 JSONL且stdout只承载Protocol；stderr只有fixed diagnostic。EOF只释放该logical connection，
parent-owned signal/explicit shutdown才drain Server、flush stdout并释放composition。非法UTF-8、overlong/invalid JSON与
stdout failure fail closed。

## Development reference

development loopback/reference仅用于同一Protocol transport qualification，不进入production support。不存在
`kite server --web`，ADR-0053 Web No-Go仍有效。

## 验证

`bun test --no-orphans apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts apps/kite-service/test/isolated/runtime-stdio-carrier.test.ts apps/kite-service/test/isolated/runtime-transport-conformance.test.ts`。
这些local结果不构成KLSV1-07 Windows/三平台或全部PTY evidence。
