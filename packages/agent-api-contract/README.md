# Kite Agent API Contract

## 定位

`@kite-ai/agent-api-contract`拥有本机Kite Agent API V1的browser-safe Public wire contract。显式App Server daemon listener已经实现
Agent bearer与Browser cookie认证，以及Workspace、Session、History、诊断Log、Browser-only Model Context、Checkpoint只读route；default
stdio App Server不开放HTTP，Run mutation、SSE与外部SDK尚未ready。

## 拥有职责

- 定义ServerInfo、Workspace、Session、Run、Interaction、History、诊断Log、Model Context、Checkpoint、mutation result、Problem Details、page/query、SSE event与resync
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
- 不暴露Workspace/Store path、Worker identity、Controller generation/binding reference、Credential、Provider-native options/response、raw Runtime event或arbitrary
  metadata/config；Browser-only Model Context是唯一显式的模型请求正文诊断投影，只包含provider-neutral system/messages/tools与safe settings；
- 不让accepted RFC或future endpoint自动成为current production behavior。

## 允许依赖

唯一dependency是browser-safe `zod`，workspace dependency为零。package source不能读取ambient filesystem/process/network authority。
production Browser client位于相邻`@kite-ai/agent-api-client`，不进入本contract package。

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
- Browser projection只包含opaque Workspace identity/safe label与Directory-scoped Session；不包含canonical path；
- History `after_sequence`是非负safe integer并与page cursor互斥；
- History/SSE工具生命周期区分`failed`与`rejected`；后者表示dispatch前终止，可携带稳定`reason_code`与脱敏摘要，
  不能伪造exit code、output或raw Runtime reason；
- Log page与History共享固定through boundary和`after_sequence`规则，但只携带closed event type/category/status/summary/detail vocabulary，
  不允许raw Runtime event或arbitrary metadata；
- Model Context必须绑定可见Session与exact invocation，只允许Browser principal；system/messages/tools分别受累计byte budget限制并明确返回truncated，
  不能携带Artifact ref、route fingerprint、Provider options、endpoint或Credential；
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
