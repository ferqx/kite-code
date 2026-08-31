# Service Native auth boundary

本页定义same-OS-user Native listener边界，不声称对抗拥有同一用户filesystem权限的恶意进程。

| Surface | Credential | 额外要求 |
| --- | --- | --- |
| health/ready | 无 | loopback peer/exact Host；Origin absent或exact；无credential header |
| instance handshake | `Kite-Local-Access` | exact `POST` + JSON `{}`；无query/cookie；strict process-owned identity response |
| connect | `Kite-Local-Access` | 无cookie；exact JSON；Workspace由Trust/Project port重新验证 |
| Runtime WebSocket | one-shot `Kite-Local-Ticket` | 无cookie/subprotocol；Origin absent或exact；instance+Workspace bound |
| History/App | `Kite-Local-Access` | 无cookie；Origin absent或exact；exact route codec |
| control stop | `Kite-Local-Control` | Origin/cookie缺失；body exact `{}` |
| Agent API exchange | one-shot `Kite-Connection` | Native-only purpose；Workspace Trust重验；无Origin/Cookie/Sec-Fetch；strict body |
| Agent API shell | hash-only `Bearer` context | 60分钟absolute TTL；Worker/Workspace/Client generation/role bound；Browser拒绝 |

access/control token采用constant-time compare且不能相等。ticket只保存hash，不写descriptor、Store、history、log或
observability；replay、expiry、wrong instance与unknown ticket统一unauthorized。control拒绝access token，普通connector
不读取control token。

Agent API capability与private access/ticket/control token不互换。只有Native peer可mint
`agent_api_observer|agent_api_controller`。Exchange通过hash匹配恢复已签发binding，不接受caller提供的Client/generation header；成功后
原capability立即删除。context只保存digest，explicit logout、TTL、generation supersede、Native connection close或Worker close撤销。
`controller` role不等于Controller lease，当前02A没有mutation route。

manager不能只信PID、`/readyz`或磁盘descriptor。它必须严格解码schema、instance、Protocol、client-contract、server version与
Service build identity；response缺失content-type、unknown key、超限、malformed以及同一次发现中的instance/server/build identity drift
均fail closed `identity_uncertain`。single-Service Native `describe`允许兼容客户端跨expected build取得Service真实descriptor和access
capability；Protocol/client-contract仍在Runtime连接前严格验证。跨build `service_stop/restart`返回
`incompatible + build_mismatch`。以上失败都不授权cleanup alive/uncertain state、spawn replacement或把caller build回显成Service identity。

Workspace Trust与Runtime admission分两阶段：App Control query/decision可在Runtime WebSocket前使用access token，但只有
Service返回trusted canonical identity后connect route才签发ticket。request path/cwd/clientInfo不产生Trust authority。

response设置`no-store`、CSP、nosniff、frame与referrer限制，不提供宽松CORS。错误使用固定低信息值，不带body、token、
credential、Workspace content或raw exception。Native credential只进入secret-bearing exact codec；App Contract保持
browser-safe/no-secret。

验证：`bun test --no-orphans apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts packages/kite-local-runtime/test/manager/composition.test.ts`。
