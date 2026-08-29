# Agent API Public Contract 当前边界

状态：active

读取时机：修改`packages/agent-api-contract`、未来Agent API HTTP/SSE adapter、OpenAPI/schema生成、Public compatibility、Agent API SDK或
静态`/api-docs` artifact时。

验证：`bun run check:agent-api-packages`、`bun run --cwd packages/agent-api-contract test`、
`bun run --cwd packages/agent-api-contract typecheck`、`bun run --cwd packages/agent-api-contract build`、
`bun run check:docs-impact`。

相关：ADR-0149、ADR-0150，KASAPI-01A；模块局部边界见
[`packages/agent-api-contract/README.md`](../../packages/agent-api-contract/README.md)。

## 当前实现事实

`@kite-ai/agent-api-contract`是已存在的private、browser-safe Public Agent API V1 wire contract workspace。它当前只实现DTO、codec、
limits、fixtures与package/static Gate；尚无production HTTP listener、auth exchange、OpenAPI artifact、Agent API SDK、Store 8 Run route或Web
`/api-docs` route。package存在不表示Agent API ready，也不改变private Runtime Protocol、Native CLI/TUI或Browser Observer行为。

唯一root export提供snake_case的ServerInfo、Context、Session、Run、Interaction/queue、History、Checkpoint、page、mutation result、Problem
Details、SSE event/resync与request/query schemas。Request decoder先做bounded JSON admission，再递归拒绝unknown field；response decoder允许旧
Client忽略新增optional field，而Server encoder递归拒绝未声明field。schema tag、discriminant、ID、timestamp、text、page、cursor、array、
depth、object key与UTF-8 byte上限均由同一package拥有。

package source只允许browser-safe `zod`，workspace dependency为零。它不导入Runtime Contract/Protocol/Client、Kernel、Host、Store、Service、
Native、React、Bun或Node，不执行I/O、不持有credential、不决定Controller/Workspace admission、不派生command ID、不恢复Session、不查询
History，也不把private camelCase DTO透传为Public wire。

## 当前兼容与安全规则

- request object及嵌套对象closed；unknown/prototype/accessor/cycle/deep/oversize/unsafe number在schema traversal前fail closed；
- response新增optional展示field可被旧decoder忽略；Server不能借此发送undeclared field；
- required field、语义或必须理解的discriminant破坏需要新major；当前path major仍只作为future `/v1` contract metadata；
- timestamp严格为UTC RFC 3339三位毫秒；ID/opaque token为bounded ASCII；text按UTF-8 bytes限制；
- Interaction response携带完整kind-specific identity并与response kind配对；只传ID的shape不存在；
- Run lifecycle codec拒绝active Run携带finished/terminal以及terminal Run缺少必要time/detail；
- resync codec要求Session、Interaction queue与snapshot revision共享identity/revision；
- Public DTO不包含Workspace/Store path、Worker/Controller/binding reference、credential、Provider正文或raw Runtime event。

## 后续Gate

KASAPI-01B只能从当前schema source生成OpenAPI/JSON Schema/types/examples/digest，不能维护第二份手写contract。KASAPI-02及以后接入Service/
Web/SDK时，必须同步本记录与对应owner current authority；在listener实际接入前不得把本文扩写成运行中endpoint。Run route仍被ADR-0150 Store 8
implementation与KASAPI-02D阻断。
