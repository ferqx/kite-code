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

`@kite-ai/agent-api-contract`是已存在的private、browser-safe Public Agent API V1 wire contract workspace。它当前实现DTO、codec、limits、
fixtures，以及同源生成的OpenAPI 3.1、JSON Schema、standalone wire declarations、examples、SHA-256 digest和package/static/drift Gate；尚无
Workspace Worker production listener、auth exchange与ServerInfo shell已经实现；Agent API SDK、Session/History/Checkpoint adapter、Store 8
Run route、mutation、SSE与Web `/api-docs` route尚未实现。package/artifact或ServerInfo存在不表示resource capability ready，也不改变
private Runtime Protocol、Native CLI/TUI或Browser Observer行为。

唯一root export提供snake_case的ServerInfo、Context、Session、Run、Interaction/queue、History、Checkpoint、page、mutation result、Problem
Details、SSE event/resync与request/query schemas。Request decoder先做bounded JSON admission，再递归拒绝unknown field；response decoder允许旧
Client忽略新增optional field，而Server encoder递归拒绝未声明field。schema tag、discriminant、ID、timestamp、text、page、cursor、array、
depth、object key与UTF-8 byte上限均由同一package拥有。

package runtime/schema/generation source只允许browser-safe `zod`，workspace dependency为零；filesystem/crypto write只在不导出的package-local
generator script。它不导入Runtime Contract/Protocol/Client、Kernel、Host、Store、Service、
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

## Generated artifact当前规则

- `generated/openapi.json`只包含contract freeze的20条Worker `/v1` path；不包含health/readiness/Web `/api-docs` carrier route；
- server URL固定为loopback port 0 placeholder，不携带live endpoint/token；security scheme只描述one-shot exchange和context bearer；
- 每条mutation success status、If-Match/Idempotency-Key、SSE media type与Problem response由同一operation registry生成；
- JSON Schema保留closed shape，并以`x-kite-contract-limits`/`x-kite-text-length-unit = utf8-bytes`绑定codec hard limits；
- `wire.d.ts`从generated JSON Schema转换，不维护手写Public type副本；examples逐byte复制validated fixtures；
- `digest.json`记录每个non-digest artifact的SHA-256并以domain-separated aggregate绑定完整集合；
- generator输出canonical key order、无timestamp/absolute path/real endpoint。owner tests逐byte比较committed output并重算digest。

## KASAPI-02A 当前carrier/context

- `/v1`复用canonical Workspace Worker现有loopback data listener；Coordinator/Gateway不代理，未创建第二listener；
- Native-only Worker capability purpose增加`agent_api_observer|agent_api_controller`，Web Gateway不能mint；
- exchange重新验证Workspace Trust后，以one-shot capability换取60分钟、最多1024个、hash-only in-memory context；
- context绑定WorkerScope/instance/Workspace digest/Client/generation/role；TTL、generation drift、Native connection close、Worker drain/restart
  或logout撤销；
- role只来自capability purpose；`controller`不授予Session Controller lease，当前所有resource/mutation route固定404；
- ServerInfo capabilities当前为空；只有KASAPI-02B route/adapter Gate完成后才能增加read capability；
- Origin/Cookie/Sec-Fetch、CORS/OPTIONS、duplicate/unknown/oversized body与credential混用fail closed，Problem不泄漏内部binding。

## 后续Gate

KASAPI-02B及以后接入read adapter/Web/SDK时，必须消费当前artifact/digest并同步本记录与对应owner current authority；不得把存在但未实现
的route提前加入ServerInfo。Run route仍被ADR-0150 Store 8 implementation与KASAPI-02D阻断。
