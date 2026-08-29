# Agent API Public Contract 当前边界

状态：active

读取时机：修改`packages/agent-api-contract`、未来Agent API HTTP/SSE adapter、OpenAPI/schema生成、Public compatibility、Agent API SDK或
静态`/api-docs` artifact时。

验证：`bun run check:agent-api-packages`、`bun run --cwd packages/agent-api-contract test`、
`bun run --cwd packages/agent-api-contract typecheck`、`bun run --cwd packages/agent-api-contract build`、
`bun test apps/kite-service/test/agent-api/conformance.test.ts`、
`bun run check:docs-impact`。

相关：ADR-0149、ADR-0150，KASAPI-01A；模块局部边界见
[`packages/agent-api-contract/README.md`](../../packages/agent-api-contract/README.md)。

## 当前实现事实

`@kite-ai/agent-api-contract`是已存在的private、browser-safe Public Agent API V1 wire contract workspace。它当前实现DTO、codec、limits、
fixtures，以及同源生成的OpenAPI 3.1、JSON Schema、standalone wire declarations、examples、SHA-256 digest和package/static/drift Gate；
Workspace Worker production listener、auth exchange、ServerInfo与bounded Session/History/Checkpoint read adapter已经实现；canonical OpenAPI
也已逐字节进入release Web asset并由静态`/api-docs`参考页展示。Agent API SDK、Store 8 Run route、mutation与SSE尚未实现。
package/artifact、静态参考或ServerInfo存在不表示未发布resource capability ready，也不改变
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
- required field、语义或必须理解的discriminant破坏需要新major；当前stable façade的path major精确为`/v1`；
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
- Web Vite build通过asset emission逐字节生成固定`api-docs/openapi.json`；candidate verifier、installer preflight与smoke要求
  `payload/web/api-docs/openapi.json`存在并由manifest checksum绑定，不能从CDN、live endpoint或另一schema source生成。

## KASAPI-02A～02D 当前carrier/read façade、静态参考与conformance

- `/v1`复用canonical Workspace Worker现有loopback data listener；Coordinator/Gateway不代理，未创建第二listener；
- Native-only Worker capability purpose增加`agent_api_observer|agent_api_controller`，Web Gateway不能mint；
- exchange重新验证Workspace Trust后，以one-shot capability换取60分钟、最多1024个、hash-only in-memory context；
- context绑定WorkerScope/instance/Workspace digest/Client/generation/role与一条read-only private Runtime logical connection；TTL、Trust撤销、
  generation drift、Native connection close、Worker drain/restart或logout撤销；
- role只来自capability purpose；`controller`不授予Session Controller lease，所有command/subscribe/mutation route仍固定404；
- ServerInfo只发布`checkpoints/history/sessions`；Session list/get、History page与Checkpoint list/preview是当前唯一resource routes；
- Session list使用same-connection bounded keyset page并仅对page内ID做Runtime projection join；History固定through sequence和boundary digest，
  Checkpoint metadata按revision keyset且preview不投影path。cursor checksum只发现损坏，每次请求仍做context/Workspace/Session admission；
- Origin/Cookie/Sec-Fetch、CORS/OPTIONS、duplicate/unknown/oversized body与credential混用fail closed，Problem不泄漏内部binding。
- 每context最多16个in-flight request；overload返回429。revoke/drain从map移除context后等待已认证read收敛，再且仅再关闭一次private
  connection；迟到Trust admission会复核context/handler current，不能越过replacement。History达到1 MiB encoded body上限时按最后
  `sequence/public_ordinal`提前分页；未知SSE/mutation route不因`Accept`协商泄漏为已注册route。
- test-only reference client对所有success/Problem执行Public response codec与artifact header检查，并同时覆盖handler seam及真实Worker HTTP
  listener；fault matrix包含capability incompatibility/replay、keyset及concurrent update、fixed-through History、body/response limits、
  observer/controller、Worker replacement、drain与non-disclosure。static Gate拒绝direct RuntimeAccess和Host/Store/Kernel concrete import。
- Web Gateway固定`/api-docs`及尾斜杠为静态HTML deep link，并只允许精确`/api-docs/openapi.json` artifact；renderer不启动
  Observer/Worker discovery、不保存credential、不发送Agent API request，也没有form、Try it或execute control。CSP为self-only、cache为
  `no-store`，placeholder endpoint不代表live endpoint；API或Worker状态只标记availability未确认。

## 后续Gate

KASAPI-03A及以后接入Store 8/SDK时，必须消费当前artifact/digest并同步本记录与对应owner current authority；不得把存在但未实现
的Run/Interaction/SSE/mutation route提前加入ServerInfo。Read-only Gate已关闭，但Run route仍被ADR-0150 Store 8 implementation阻断。
