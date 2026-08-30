# Kite Agent Server API V1 workspace integration manifest

状态：frozen（KASAPI-00C；实施影响清单，不授权未完成行为）

日期：2026-08-29

相关：[`Public contract freeze`](2026-08-29-kite-agent-server-api-v1-contract-freeze.md)、ADR-0149、ADR-0150、
[`Kite Agent Server API V1 实施方案`](../plans/2026-08-29-kite-agent-server-api-v1.md)。

## 1. 新workspace contract

### `packages/agent-api-contract`

KASAPI-01A新增private ESM package `@kite-ai/agent-api-contract`：

- required files：`package.json`、`README.md`、`tsconfig.json`、非空`src/`、非空`test/`、`fixtures/`；
- root export `.`只导出Public wire DTO、strict request/forward-compatible response codec、limits、schema tags与capability/error enums；
- package依赖允许browser-safe `zod`，workspace dependency为零；禁止Bun/Node/React、Runtime Contract/Protocol/Client、Host、Store、Service；
- build同时验证browser target，不使用`process`、filesystem、socket、crypto secret或conditional runtime export；
- `test`固定使用`bun run ../../scripts/run-owned-tests.ts .`；prototype/duplicate/oversize/depth/unknown discriminator与old-client
  compatibility fixture属于owner tests。

KASAPI-01B在同一package增加单一生成入口`src/generation/`与committed artifacts：

```text
packages/agent-api-contract/generated/openapi.json
packages/agent-api-contract/generated/schema/*.json
packages/agent-api-contract/generated/wire.d.ts
packages/agent-api-contract/generated/examples/*.json
packages/agent-api-contract/generated/digest.json
```

generated artifact必须canonical、deterministic、无timestamp/absolute path/real endpoint/token。root export不导出generator I/O；generator是
package-local build tool，runtime consumers只读committed artifact。drift test重新生成到temporary directory并逐byte比较。

### `packages/agent-api-client`

KASAPI-05A新增private ESM package `@kite-ai/agent-api-client`：

- dependency只允许`@kite-ai/agent-api-contract`和browser-safe runtime依赖；
- root export `.`只导出transport-neutral client、REST/SSE/resource helpers；不读取descriptor、Workspace path或credential；
- browser export不得包含Native bootstrap；Node/Bun-specific transport若必要必须有显式subpath并通过package boundary review；
- SDK保留Idempotency-Key、ETag与cursor；AbortSignal只结束local wait/stream，不隐式cancel Run；
- owner tests覆盖HTTP/SSE conformance、retry、resync reducer、unknown optional response field与secret-safe error。

Native组合只在`@kite-ai/kite-local-runtime/agent-api` subpath导出，由其拥有Coordinator resolve/mint、Workspace Trust、App Control、context
exchange/refresh/revoke与agent-api-client composition。agent-api-client不得反向依赖kite-local-runtime。

## 2. package graph、root scripts与static Gate

目标新增依赖边：

```text
agent-api-contract → zod only
agent-api-client   → agent-api-contract
kite-local-runtime/agent-api → agent-api-client + existing Native contracts
kite-service      → agent-api-contract + existing runtime-client/server/host/sqlite
kite-web build    → generated OpenAPI artifact only
```

必须在对应workspace落地的同一Task更新：

| 位置 | exact变化 | Gate |
| --- | --- | --- |
| root `package.json` / `bun.lock` | 新workspace devDependency与lock graph；增加`check:agent-api-packages` | clean install、lock drift、SBOM |
| `scripts/run-default-tests.ts` | 01A加入contract，05A加入client | default suite实际发现owner tests |
| `scripts/run-runtime-workspace-script.ts` | 加入已存在的Agent API package build/typecheck/test | root build/typecheck不漏package |
| `scripts/check-agent-api-packages.ts` | 新增package/README/source/test/export/allowed edge/browser-safe/deep import/consumer rules | negative fixtures证明非法edge失败 |
| `scripts/check-pre-release-architecture.ts` | 禁止Service adapter直达Kernel/SQLite concrete、Web runtime导入client/credential、contract导入private Runtime | source-based boundary |
| `scripts/check-test-ownership.ts` | 识别两个owner workspace与Service/Web/integration/qualification suites | 不把real I/O塞入parallel unit test |
| root `tsconfig.json` | 只在source import确需时增加package path；优先workspace export resolution | 不开放deep alias |
| `docs/documentation-map.json` | 按第7节增加representative source rules | docs-impact all/staged均通过 |

不得预先登记不存在的package/path来让Gate“通过”。01A只登记contract；Service、client、Web与Store规则在对应production source出现的同一
Task增加。`check:runtime-packages`继续拥有private Runtime graph；新的Agent API checker拥有Public package/consumer graph，两者均由
pre-release architecture Gate组合运行，不能互相替代。

## 3. Service adapter与Worker carrier inventory

唯一production位置固定为：

```text
apps/kite-service/src/agent-api/
  context/
  application/
  mapping/
  pagination/
  streaming/
  index.ts

apps/kite-service/src/workspace-worker/agent-api-carrier.ts
apps/kite-service/test/agent-api/
apps/kite-service/docs/agent-api.md
```

- `application/`只消费in-process Runtime Client/Server logical connection与Service-owned History page port；不得导入
  `runtime-storage-sqlite`、Kernel、Host concrete、Worker production object或TUI types；
- `mapping/`穷举private→Public DTO/event，不raw passthrough private camelCase；
- `context/`拥有exchange、hash-only in-memory context、role/expiry/revoke与Controller binding pin orchestration，不拥有Controller lease；
- `pagination/`拥有opaque cursor codec和bounded page orchestration，不保存authoritative collection snapshot；
- `streaming/`拥有Public event ordinal/filter/resync reducer、bounded queue与heartbeat，不成为History；
- `agent-api-carrier.ts`只把exact routes注册到existing Workspace Worker data listener，拥有HTTP/SSE framing、body/header/query limits、
  drain与Browser signal rejection；不作Run status、History或Controller domain decision；
- Worker production composition必须显式注入ports，Coordinator/Gateway不能注册同一data-plane route。

KASAPI-02A只接Context、ServerInfo与read-only route shell；KASAPI-02B接Session/History/Checkpoint reads；KASAPI-03/04在Store 8及各自Gate后
接mutation/SSE。route table必须由contract-generated registry测试覆盖，未完成route返回404且ServerInfo不声明对应capability，不能返回501
或隐藏feature flag后的partial stable route。

## 4. Store 8 / Host integration inventory

ADR-0150 implementation只修改existing Runtime owners：

```text
packages/runtime-host/src/storage/**
packages/runtime-host/src/host/**
packages/runtime-storage-sqlite/src/**
apps/kite-service/src/bootstrap/runtime/**
apps/kite-service/src/workspace-worker/**
```

`runtime-host/storage`新增neutral Run row/query/mutation与receipt resource result port；Host start/activation/interaction/terminal/recovery/delete/
rewind/fork transaction使用该port。SQLite package实现Store 8 DDL/preflight/index/migration。Public Agent API adapter只能通过private Runtime
Client/Server读取Run resource use case，不能直接取得该storage port；如private Runtime Contract需新增Run query/receipt projection，由
KASAPI-03A在同一tranche以repo-private exact codec扩展。

Store 8 source/target、coverage、journal/fence/cutover/fault files由
[`Runtime Run Store V1 子计划`](../plans/2026-08-29-kite-runtime-run-store-v1.md)逐Task列出。任何Store source path出现时必须同步
runtime-host/runtime-storage owner README、Service runtime docs、Runtime/Coordinator active authority和release migration runbook。

## 5. Web docs与release asset inventory

Web不依赖agent-api-client。KASAPI-02C增加：

```text
apps/kite-web/src/api-docs/**
apps/kite-web/test/api-docs.test.tsx
apps/kite-web/vite.config.ts                    # exact emit plugin
apps/kite-service/src/web-gateway/carrier.ts    # exact static route allowlist
packages/agent-api-contract/generated/openapi.json
```

Vite build从contract generated artifact逐byte emit为`api-docs/openapi.json`；页面bundle只渲染immutable schema/examples，所有execute/
Try it/form/network client关闭。不得提交第二份手写spec到Web source。Gateway：

- `/api-docs`及其deep-link只返回同release `index.html`；
- `/api-docs/openapi.json`只返回exact emitted file，`Content-Type: application/json`、immutable build cache identity；
- existing Browser auth/Fetch Metadata/CSP/no remote script保持；页面不取得Worker endpoint或data-plane context；
- Web offline/Worker unavailable仍可查看artifact，但UI标识availability未确认。

`scripts/release/oss-candidate.ts`的Web asset allowlist增加唯一exact path`api-docs/openapi.json`，candidate manifest为它记录SHA-256与contract
schema digest；verifier要求存在且digest等于`generated/digest.json`。archive/install/uninstall tests验证无stale spec。普通hash JS/CSS allowlist
不扩展为任意JSON目录。

## 6. Test ownership、build、release与SBOM

| Layer | owner/location | Required evidence |
| --- | --- | --- |
| Public contract | `packages/agent-api-contract/test/` | codecs、limits、fixtures、OpenAPI/schema/digest/browser build |
| SDK | `packages/agent-api-client/test/` | REST/SSE、retry、ETag/key/cursor、abort、compatibility |
| Service application | `apps/kite-service/test/agent-api/` | mapping、auth context、role、pagination、controller pin、resync |
| Worker I/O | `apps/kite-service/test/isolated/agent-api-*.test.ts` | real loopback HTTP/SSE、drain、limits、Browser negatives |
| Host/Store | existing owner tests + Store 8 suites | atomic Run/receipt、reopen、delete/fork/rewind、migration/fault |
| Web | `apps/kite-web/test/api-docs.test.tsx` + Gateway tests | deep-link、CSP、no execute/network、artifact digest |
| Cross-package | `tests/integration/agent-api-*.test.ts` | exports-only consumer、Native journey、private/public isolation |
| Qualification | `tests/qualification/agent-api-*.test.ts` | response loss、restart、slow consumer、upgrade/rollback/candidate |

Default tests包含owner unit/integration，不包含fault soak、native platform smoke或live Provider。real listener/process tests标记isolated并串行。
Required实现Gate按影响取并集：`check:agent-api-packages`、`check:runtime-packages`、`check:core-boundary`、
`check:pre-release-architecture`、`check:test-ownership`、typecheck/build、owner tests、Web build/tests、candidate release tests。

`bun.lock`与synthetic CycloneDX必须出现实际新增workspace/dependency。OpenAPI JSON不是第三方dependency但属于release payload，进入candidate
file manifest/digest；SBOM不替代artifact digest或三平台support evidence。Native platform支持只有对应hosted candidate/install/loopback/
filesystem/ACL evidence通过才升级。

## 7. documentation-map representative paths

代码出现时按最小真实owner增加规则：

| rule | representative sources | current authorities |
| --- | --- | --- |
| `agent-api-contract` | `packages/agent-api-contract/src/**`, `package.json`, `generated/**` | package README；Agent API Service doc；Public compatibility active记录 |
| `agent-api-client` | `packages/agent-api-client/src/**`, `package.json` | package README；Native local runtime doc；Agent API active记录 |
| `kite-service-agent-api` | `apps/kite-service/src/agent-api/**`, Worker carrier | Service README/doc；Coordinator/Worker、Runtime authority、Workspace Trust active记录 |
| `runtime-run-authority` | Host Run/receipt port、SQLite Store 8/schema/migration | Host/SQLite README；Runtime authority/resilience；Coordinator/Worker active记录 |
| `web-api-docs` | Web api-docs source、Vite emit、Gateway static routes、release asset verifier | Web/Service README；Coordinator/Web、open-source release active记录 |
| `native-agent-api-bootstrap` | `packages/kite-local-runtime/src/agent-api/**` | local-runtime README/doc；Workspace Trust、Coordinator/Worker、Agent API active记录 |

ADR、RFC、plan与understanding manifest不是current authority，不能作为documentation-map `authorities`。KASAPI-05C只有在所有owner source、README、
active/book/runbook/release evidence共同收敛后才把主计划标记completed。

## 8. Rollback inventory

- 01A/01B无consumer时删除package、root graph与generated artifacts；
- 02A/02B移除existing Worker route registration/context/read adapter，不触碰Store；
- 02C移除exact Web emit/static route与release manifest entry，不留discoverable stale spec；
- Store 8只按ADR-0150 journal/fence/write-state回滚，不能因HTTP façade关闭而回退Store writer；
- mutation/SSE关闭时先quiesce admission并drain，已applied Run/receipt继续由Runtime recovery收敛；
- SDK/Native export与descriptor/capability同tranche撤回；private Runtime TUI/CLI与Web Observer不切到fallback。
