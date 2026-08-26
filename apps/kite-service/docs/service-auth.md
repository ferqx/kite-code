# Service Native auth boundary

本页定义same-OS-user Native listener边界，不声称对抗拥有同一用户filesystem权限的恶意进程。

| Surface | Credential | 额外要求 |
| --- | --- | --- |
| health/ready | 无 | loopback peer/exact Host；Origin absent或exact；无credential header |
| connect | `Kite-Local-Access` | 无cookie；exact JSON；Workspace由Trust/Project port重新验证 |
| Runtime WebSocket | one-shot `Kite-Local-Ticket` | 无cookie/subprotocol；Origin absent或exact；instance+Workspace bound |
| History/App | `Kite-Local-Access` | 无cookie；Origin absent或exact；exact route codec |
| control stop | `Kite-Local-Control` | Origin/cookie缺失；body exact `{}` |

access/control token采用constant-time compare且不能相等。ticket只保存hash，不写descriptor、Store、history、log或observability；replay、expiry、wrong instance和unknown ticket统一unauthorized。control拒绝access token，普通connector不读取control token。

response设置`no-store`、CSP、nosniff、frame与referrer限制，不提供宽松CORS。错误使用固定低信息值，不带body、token、credential、Workspace content或raw exception。Native credential只进入secret-bearing exact codec；App Contract保持browser-safe/no-secret。验证：`bun test --no-orphans apps/kite-service/test/isolated/carrier/native-loopback-carrier.test.ts`。
