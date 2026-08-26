# Native Runtime Server carrier

本页是 `apps/kite-service/src/carrier/` 的 owner-local current authority。它描述 KLSV1-04 Native loopback policy；development/reference carrier 仍由 `apps/kite-cli` 的本地文档定义。

## Listener 与路由

carrier 只绑定 `127.0.0.1:0`，descriptor 固定发布同端口 HTTP origin 与 `ws://127.0.0.1:<port>/rpc`。封闭路由为 health/ready、connect、Runtime WebSocket、三个 History use case、Workspace Trust、Provider/model、MCP、Skill、execution/release、Native provider credential 与 control stop。不存在static assets、CORS/OPTIONS授权、cookie session、restart route或generic App/RPC method registry。

除health外，所有route在Service发布ready前统一503。connect只接受access token与exact `{ workspace }` body；injected admission执行canonical realpath、Trust与完整Project identity验证后签发32-byte base64url ticket。ticket只在内存保存hash，固定30秒TTL、一次性消费并绑定instance与完整Workspace identity。

`/rpc`只接受ticket。每个socket调用`RuntimeServer.open(connection, { admission, onClose })`；allowed Workspace必须精确等于ticket binding，异步admission在connection close后返回也会被拒绝。Session-scoped resume/query/subscribe/fork仍由injected admission与persisted Workspace交叉校验。socket关闭只释放Server accounting、subscription与App binding，不取消Session/Turn或关闭Host。

History handler只取得注入的`RuntimeHistoryClient`，不取得RuntimeAccess、SQLite path、Store writer或raw event。App routes逐条使用exact codec；带Workspace的request和response都必须与重新解析的identity完全一致。credential route使用Native codec且不回显secret。

HTTP body、Runtime message、queue、buffered amount、heartbeat与drain都有hard ceiling。binary以1003关闭，oversized以1009关闭，malformed JSON只返回Protocol parse error；negative send/backpressure等待writable，dropped send关闭所属connection。diagnostic callback只接收固定code，callback failure不能阻止cleanup。

验证：`bun test --no-orphans apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts`。当前真实loopback listener只连接injected fake application，不是默认Store入口，也不构成KLSV1-05 connector、KLSV1-06 cutover或KLSV1-07三平台证据。
