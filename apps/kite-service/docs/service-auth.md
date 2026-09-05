# App Server local auth boundary

本页定义same-OS-user本机边界，不声称对抗已经拥有同一用户filesystem与进程权限的恶意程序。

| Surface | Credential / identity | 约束 |
| --- | --- | --- |
| default stdio App Server | parent-owned pipe + exact initialize | child executable/profile/build由release resolver固定；无ambient discovery |
| daemon Runtime/control | owner-only Unix socket或current-user named pipe | exact daemon protocol/capabilities；首请求initialize；另一Workspace拒绝 |
| daemon Browser | HttpOnly SameSite cookie | loopback exact Host与same-origin Fetch Metadata；只读`/v1` |
| Agent API exchange | one-shot `Kite-Connection` | Native-only purpose、Workspace Trust、generation与strict body |
| Agent API shell | hash-only bearer context | absolute TTL、Workspace/client/generation/role bound；Browser拒绝 |

default parent-child build mismatch在initialize时关闭连接，不查找或替换其他进程。daemon build只作status诊断；protocol/capability
mismatch返回incompatible，不触发stop、spawn或upgrade。PID/start identity只用于dead endpoint cleanup，不能授权Runtime mutation。

Workspace Trust与Runtime admission分两阶段：App Control query/decision可在Runtime mutation前使用同一connection，但只有Server返回trusted
canonical identity后才允许执行。request path、cwd、clientInfo、socket存在或Web URL都不产生Trust/Session authority。

Browser cookie与Runtime connection不能互换。Browser只读取可见Workspace、Session、History、Model Context和Checkpoint；不能进入
credential、controller、server shutdown或Runtime mutation。Agent API capability与Browser cookie也不互换。

响应采用no-store、CSP、nosniff、frame与referrer限制，不提供宽松CORS。错误使用固定低信息值，不包含credential、Workspace内容、
absolute path或raw exception。

旧access/control token、Native describe/service_stop、descriptor handshake与跨build Service replacement已从production入口删除。

验证：`bun test tests/release/app-server-client.test.ts tests/release/app-server-daemon.test.ts apps/kite-service/test/isolated/carrier/runtime-stdio-child.test.ts`。
