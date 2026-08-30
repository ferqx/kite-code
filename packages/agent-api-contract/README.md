# Kite Agent API Contract

## 定位

`@kite-ai/agent-api-contract`拥有未来本机Kite Agent API V1的browser-safe Public wire contract。package已经实现，但它的存在不表示
production HTTP listener、认证exchange、Run endpoint、SDK或Web API docs route已经启用。

## 拥有职责

- 定义ServerInfo、Session、Run、Interaction、History、Checkpoint、mutation result、Problem Details、page/query、SSE event与resync
  boundary的closed `snake_case` DTO；
- 定义strict mutation/exchange request schema与JSON/text/identifier/page/stream hard limits；
- 在Zod遍历前拒绝non-JSON、cycle、accessor、prototype-shaped、unsafe-number、deep、oversized与forbidden-key input；
- Client response decoder忽略未知optional field；`encodeAgentApiResponse`递归拒绝Server projector的undeclared field；
- 从同一schema source确定性生成OpenAPI 3.1、JSON Schema、standalone wire declarations、examples与release digest；
- 以byte-exact drift test、route/status/security断言、digest重算和TypeScript parse Gate保护committed artifacts。

## 不拥有职责

- 不导入private Runtime Contract/Protocol/Client、Host、Kernel、Store、Service、Native、React、Bun或Node API；
- 不framing HTTP/SSE，不打开listener，不持有credential，不派生command ID，不授权Controller mutation，不查询History，不恢复Session，
  不持久化Run；
- 不暴露Workspace/Store path、Worker identity、Controller generation/binding reference、Provider正文、raw Runtime event或arbitrary
  metadata/config；
- 不让accepted RFC或future endpoint自动成为current production behavior。

## 允许依赖

唯一dependency是browser-safe `zod`，workspace dependency为零。package source不能读取ambient filesystem/process/network authority。

## 公开入口

唯一package export是`@kite-ai/agent-api-contract`根入口；deep import不是受支持contract。根入口只导出DTO/schema、codec、scalar、limits与
generated aggregate artifact digest常量；不导出generator I/O。
generator是package-local build tool，不从root runtime export导出；consumer读取`generated/` committed artifact。

## 关键不变量

- `decodeAgentApiRequest`先执行bounded JSON admission，再strict递归拒绝unknown request field；schema default只能补materialized default，不能
  放宽input；
- `decodeAgentApiResponse`允许V1旧Client忽略新增optional response field；`encodeAgentApiResponse`不能借strip发送undeclared field；
- byte limit使用UTF-8；number必须finite，并在revision/count处是safe integer；timestamp精确为三位毫秒UTC RFC 3339；
- ID是bounded ASCII identity，opaque cursor/event ID是bounded base64url；
- Interaction response必须携带完整kind-specific identity并与response kind匹配；
- active/terminal Run的started/finished/terminal与timestamp order必须闭合；
- resync中的Session、Interaction queue与snapshot revision必须共享identity/revision；
- schema/codec不接受private camelCase DTO raw passthrough。

## 测试

```text
bun run --cwd packages/agent-api-contract test
bun run --cwd packages/agent-api-contract typecheck
bun run --cwd packages/agent-api-contract build
bun run --cwd packages/agent-api-contract check:generated
bun run check:agent-api-packages
```

## 文档影响

owner-local schema或codec变化更新本README。跨包Agent API compatibility、安全、持久化或release行为同时更新
`docs/active/agent-api-contract.md`与受影响owner current authority。
