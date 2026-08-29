# Kite Agent Server API V1 实施方案

状态：active

日期：2026-08-29

优先级：P1

方案来源：[`Kite Agent Server API V1 RFC`](../../design/2026-08-29-kite-agent-server-api-v1-rfc.md)

实施基线：`feat/kite-coordinator-workspace-worker-web-v1@e4ab1c374b2fdfa9f9a0958c1ffd38f9ed1cd16b`

依赖：ADR-0142、ADR-0144、ADR-0147、ADR-0148、ADR-0149、ADR-0150，已归档的
[`Kite Runtime Server V1`](2026-08-26-kite-runtime-server-v1.md)，当前 active 的
[`Kite Coordinator、Workspace Worker 与唯一 Web Gateway V1`](2026-08-28-kite-coordinator-workspace-worker-web-v1.md)，以及
[`Runtime Authority Boundary`](../../active/runtime-authority-boundary.md)、
[`Coordinator、Workspace Worker 与 Web Observer 当前边界`](../../active/coordinator-workspace-worker-web.md)、
[`Kite Code 六概念 Runtime 架构`](../../active/six-concept-runtime-architecture.md) 与各 owner workspace README/本地文档。

架构前置：ADR-0149 已接受稳定本机 Public Agent API 对 ADR-0142 repo-private Protocol、ADR-0147 Worker/Controller/Web
边界的局部扩展。KASAPI-00C已接受ADR-0150与
[`Runtime Run Store V1子计划`](2026-08-29-kite-runtime-run-store-v1.md)，固定State 27 / Store 8 canonical Run authority与migration。
KASAPI-02D read-only Gate已关闭；Run mutation仍在该Store 8子计划完成前保持blocked。

## 实施状态（2026-08-30）

KASAPI-00A～02D 已完成：ADR-0149 接受stable local façade；
[`current evidence matrix`](../understanding/2026-08-29-kite-agent-server-api-v1-evidence.md) 证明`turnId`是唯一Run identity候选，但current
Store 7缺少first-class Run index/resource receipt；
[`Public contract freeze`](../understanding/2026-08-29-kite-agent-server-api-v1-contract-freeze.md)已关闭auth/idempotency/Controller/
pagination/status/SSE/compatibility，ADR-0150固定Store 8迁移。`@kite-ai/agent-api-contract`已实现browser-safe closed DTO/codec/limits/
fixtures与独立package Gate，并从同一schema source生成OpenAPI 3.1、JSON Schema、wire declarations、examples与SHA-256 digest。现有
Workspace Worker listener已接入authenticated Agent API context及bounded Session/History/Checkpoint read adapter；Web release已逐字节装入
canonical OpenAPI并提供无execute、无Worker discovery的静态`/api-docs`。Public-codec reference client已在handler及真实Worker listener上关闭
auth/pagination/concurrent update/limits/drain/role/replacement/non-disclosure Gate。KRSRUN-01A～02A已完成neutral Run contract、unpublished
Store8 schema/preflight、Host atomic lifecycle/original resource replay、private Run query、delete/rewind/fork/restart及whole-generation
migration；当前执行入口为KASAPI-03A子计划KRSRUN-03A Worker composition/reopen/cutover。production Worker/Public handler仍不创建Run mutation或发布
`runs`capability。

## 1. 执行结论

本计划把 RFC 的 KASAPI-00～05 展开为可独立验证的 21 个 Task。实施顺序固定为：

```text
ADR / evidence / contract freeze
  → browser-safe Agent API contract + generated OpenAPI
  → authenticated read-only Worker façade + static API docs
  → canonical first-class Run + receipt-bearing mutation
  → SSE / Interaction / Checkpoint mutation
  → SDK / Native journey / release qualification
```

不得为了尽快得到 HTTP endpoint 跳过以下三项：

1. `controller` role 只是 endpoint allowlist；effectful mutation 必须复用现有 Store 7 Session Controller
   lease/generation 与 authenticated `bindingReference`；
2. Public Run 必须由 canonical Runtime/Store fact 查询，不能由 adapter 内存 Map、日志文本、Session Logger 或 sidecar database拥有；
3. SSE 在 History sequence、Session snapshot revision、event ID/generation 与 partial resync 之间没有单一可证明边界前，不得进入稳定
   OpenAPI/SDK。

计划可以在 production listener 前整体回滚。listener 接入后，回滚只能停止新的 Agent API admission；已经 applied 的 Run、Interaction、
rewind/fork/delete command 仍由当前 Runtime/Store receipt、recovery 与 effect authority继续收敛，不能因 façade 下线而取消或重放。

## 2. 目标、成功标准与非目标

### 2.1 目标

1. 在现有 Workspace Worker 上提供 loopback-only、同一 OS 用户、单 admitted Workspace 的稳定 `/v1` REST + SSE API；
2. 以 Session、Run、Interaction、Checkpoint 为 public resource，同时保持 Runtime Host/Store/receipt/revision/recovery 单一事实源；
3. 生成同源 OpenAPI 3.1、JSON Schema、wire TypeScript types、fixtures 与 schema digest；
4. 支持 request/response loss、capability refresh、Client reconnect、Worker restart、slow consumer 与 stream gap 的确定语义；
5. 交付 TypeScript SDK 与 Native bootstrap composition；SDK disconnect/abort 只结束本地 wait/stream，不隐式取消 Run；
6. 在只读 Web Gateway 中提供 release-bundled `/api-docs`，不增加 Browser data-plane/controller capability；
7. 通过 current owner docs、active authority、ADR、计划、测试与 release evidence 的共同 Gate。

### 2.2 V1 完成标准

- Public request、response、Problem Details 与 event wire 全部使用 frozen `snake_case` closed codec；
- Agent API package、Service adapter、Native bootstrap、Web static docs 与 SDK 依赖方向通过 package/static Gate；
- observer 无法命中任何 mutation；controller role 缺少 exact Controller binding 时同样无法 mutation；
- 同 Idempotency-Key 的 applied mutation 跨 capability refresh、reconnect 与 Worker restart 返回 original receipt/resource；
- pre-application rejection 不伪装成 durable receipt，且不会由 adapter 建立第二幂等事实源；
- Run create/list/get/cancel/wait 使用同一 canonical Run identity，Session 并发 create 只可能有一个 applied；
- History + resync snapshot + live SSE reducer 与未断线 reducer 等价，无法证明连续性时显式 resync；
- Worker/Gateway/Coordinator restart、listener drain、response loss、Store reopen 与 slow consumer fault matrix 通过；
- production release 不开放 LAN/remote/Browser mutation，不恢复 `/rpc` public exposure 或旧 Store/Host fallback；
- macOS/Linux/Windows 支持结论只由对应真实 hosted candidate evidence升级。

### 2.3 非目标

- 不兼容 LangGraph SDK，不提供 `/threads` alias；
- 不开放 Assistant CRUD、arbitrary config/state/debug/store、raw Runtime event 或 raw SQLite；
- 不实现 remote/LAN、multi-user、hosted、API key、多租户、webhook、cron、A2A 或 MCP Server 产品面；
- 不新增 Browser mutation、Controller takeover、在线 Try it console 或 credential custody；
- 不让 Agent API 自主 request/release/resume/detach Controller；
- 不建立第二 listener owner、第二 RuntimeAccess path、第二 Store writer、Run sidecar、dual write 或 compatibility fallback；
- 不承诺 Python/Go SDK；
- 不在证据审计前预设 Store 8、Run table、cursor 编码、bearer scheme 或 rejected receipt persistence。

## 3. 当前事实基线

### 3.1 已存在能力

| 能力 | 当前 owner/事实 | Agent API 复用方式 |
| --- | --- | --- |
| command/query/subscription | `runtime-contract` + `runtime-server` + `runtime-client`，repo-private exact Protocol | adapter 通过 in-process Runtime Client/Server logical connection，不公开 `/rpc` |
| applied command receipt | Runtime Host + Store 7 scoped receipt，同 Runtime transaction 提交 | Idempotency-Key 稳定映射为 canonical command identity，只重放 applied receipt |
| Session revision fence | Host mailbox + `expectedRevision`；fork 使用 `sourceRevision` | `If-Match` 映射既有 fence；resume 保留 `afterRevision` barrier |
| Session projection/interaction | closed `RuntimeSessionProjection`、完整 ordered interaction queue | public exhaustive mapper；不 raw passthrough internal DTO |
| short replay | Host per-Session 256 条 durable notification + snapshot reset | SSE bounded replay；gap 时进入 public resync boundary |
| complete History | Service-owned safe projector → `RuntimeLogQueryPort` → Store 7 readonly snapshot | History endpoint；不从 SSE buffer/Logger/trace补偿 |
| Worker admission | Coordinator resolve/mint，Worker 30 秒 hash-only one-shot connection capability | 只用于建立 Agent API context；不可作为每请求长期 bearer |
| Controller/effect | Store 7 Session Controller lease/generation + `bindingReference` + effect/resource gate | controller endpoint allowlist之外仍逐 mutation验证 exact binding |
| Web | 唯一 Gateway + 永久只读 Browser Observer | 只增加 release-bundled static `/api-docs` 与 spec artifact |

### 3.2 当前缺口

1. `RuntimeCommandReceipt` 只返回 Session/revision，start receipt 不持久返回 first-class Run projection；
2. 当前 Session projection只保留 active work，无法直接提供完整 Run list/get/retention；
3. 当前 public candidate没有独立 codec、OpenAPI、HTTP status、header、pagination 或 Problem Details authority；
4. 当前 Worker capability面向一次 connection establish，REST/SSE context 与 capability refresh尚未冻结；
5. 当前 Runtime subscription resume使用 revision/generation，History使用 durable event sequence，二者尚无 public opaque event cursor映射；
6. current persistent receipt只保存 applied outcome，不能满足“sticky rejected response replay”；
7. current Web contract不包含 `/api-docs` deep link/static artifact route；
8. current SDK只覆盖 private Runtime/Native journey，不存在稳定 Agent API client。

### 3.3 Evidence audit 必须回答的问题

KASAPI-00B 必须产出逐项源码/测试证据，不接受“可以从日志推断”或“实现时再定”：

- start command 的 commandId、turnId、workId、run terminal identity如何对应；
- Run create transaction、receipt、State/event、Store row与恢复之间的原子边界；
- completed/failed/cancelled/unknown Run 的 list/get 查询复杂度、排序、retention与 Session delete/fork/rewind语义；
- Worker restart前后 queued/running/waiting/unknown 如何收敛；
- Runtime revision与 Store event sequence是否一一对应，在哪些 event/projection 情况下不是；
- Session snapshot、History cursor、SSE event ID、ephemeral stream sequence与 generation如何建立完整 resync；
- one-shot Worker capability如何建立 REST/SSE Agent API context，refresh后如何保留稳定 Client/idempotency identity；
- Controller binding从 Native App Control进入 Agent API context、RuntimeCommandContext 与 prepared effect closure的完整链路；
- applied receipt以外的 revision/busy/interaction/auth/admission failure是否产生任何 durable事实；
- public Session/Run时间戳的唯一来源与 ISO serialization 规则。

任一问题证据不完整时，对应后续 Task blocked；不得用 adapter cache、unbounded event scan或猜测填补。

## 4. KASAPI-00 冻结结果

### 4.1 已冻结方向

- `/v1` path major；public wire `snake_case`；request strict、response optional-field forward compatible；
- REST资源 + SSE事件；disconnect continue、显式 cancel、同 Session 单 active Run；
- applied receipt durable replay；pre-application rejection按当前前置条件重新评估；
- create Session不接受 Workspace path，全部资源与 capability Workspace交叉校验；
- controller role不替代现有 Session Controller lease/generation；
- History为完整 durable source，SSE replay是bounded delivery而非History；
- Web只提供静态文档，不提供真实 endpoint/token、Try it、Worker proxy或mutation；
- Native exact build handshake与Public `/v1` compatibility分层。

### 4.2 KASAPI-00 已冻结结果

exact值由[`Public contract freeze`](../understanding/2026-08-29-kite-agent-server-api-v1-contract-freeze.md)拥有；下表只记录关闭结果与后续Gate。

| 决策 | 冻结结果 | 后续Gate |
| --- | --- | --- |
| Agent API auth context | one-shot `Kite-Connection` exchange → 60分钟hash-only in-memory Bearer context；restart/generation/drain revoke | KASAPI-02A conformance |
| stable idempotency mapper | API domain + operation + canonical Workspace/Session scope + high-entropy key；不含transient Client/Worker | KASAPI-03B lost-response |
| Controller binding | role只allowlist；每existing Session mutation重读lease并pin exact bindingReference | KASAPI-03B stale-binding |
| Run authority | ADR-0150 State 27 / Store 8 Run index + receipt result + coverage boundary | KRSRUN-01A～03B / KASAPI-03A |
| pagination | bounded live keyset；History固定through sequence；rewind/delete显式cursor invalidation | KASAPI-01A codec、02B page port |
| HTTP status/header | 每route单一success status；If-Match缺失428、mismatch412、incompatible426 | KASAPI-01A/01B OpenAPI |
| SSE resync | generation + durable sequence + public ordinal + filter；atomic resync frame；heartbeat不推进cursor | KASAPI-04A reducer |
| compatibility | `/v1` + schema + capabilities；Native exact build独立；optional response field only additive | KASAPI-01B compatibility |

## 5. 目标所有权与依赖方向

### 5.1 目标组件

```text
packages/agent-api-contract
  closed public DTO/codec/OpenAPI/schema/fixtures/digest

packages/agent-api-client
  framework-neutral HTTP/SSE client + resource helpers

apps/kite-service/src/agent-api
  public application adapter + exhaustive mapper + cursor/idempotency seams

apps/kite-service/src/carrier
  existing Worker listener中的exact Agent API routes/SSE framing

packages/kite-local-runtime/client
  Native discovery/Trust/Controller bootstrap + Agent API client composition

apps/kite-web + Web Gateway
  release-bundled static API docs only
```

### 5.2 Owner矩阵

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| `agent-api-contract` | public wire DTO/codec、limits、OpenAPI/JSON Schema生成、fixtures/digest | Runtime type、Node/Bun I/O、listener、auth secret、Store、Service、React |
| `agent-api-client` | HTTP/SSE、header/cursor保存、local wait/stream abort、resource helpers | Native discovery、Workspace path、Controller acquisition、credential、RuntimeAccess |
| Service Agent API adapter | public↔private exhaustive mapper、authenticated context、bounded query/mutation/stream orchestration | Store writer、Kernel/Host concrete、第二 receipt/Run state、controller lease签发 |
| Worker carrier | loopback route、HTTP/SSE framing、auth admission、limits/backpressure/drain | domain decision、Run status推断、History authority、Coordinator proxy |
| Runtime Host/Store | canonical Run/receipt/revision/recovery（若ADR确认扩展） | HTTP/OpenAPI/SSE/SDK类型 |
| `kite-local-runtime/client` | Coordinator/Worker discovery、Trust、Controller bootstrap、capability refresh、组合 public client | public resource schema owner、Agent API handler |
| Web/Gateway | immutable spec artifact与无execute文档renderer | Agent API credential、Worker endpoint、controller/data-plane request |

### 5.3 固定依赖方向

```text
agent-api-contract              (zero workspace dependency preferred)
        ↑
agent-api-client
        ↑
kite-local-runtime/client       (Native bootstrap composition)

agent-api-contract
        ↑
apps/kite-service/agent-api adapter
        → runtime-client/runtime-contract explicit mapper
        → Service-owned History client

Web release assets ← generated openapi.json
apps/kite-web runtime code -X→ agent-api-client / Native credential / Worker endpoint
```

`agent-api-contract` 不静态依赖 `runtime-contract`；private-to-public mapper留在 Service，防止 private discriminant自动进入 public
compatibility surface。若实施认为必须共享中立 primitive，KASAPI-00C 必须逐项列出并由 package Gate允许，不能直接依赖整个 private
contract。

## 6. 分阶段实施

### Phase KASAPI-00：决策、证据与实施边界

#### KASAPI-00A：ADR 与 authority freeze（已完成）

完成证据：ADR-0149 已接受；RFC状态已同步为accepted，本计划进入active；current `docs/active/`未被改写为future behavior，零
production code/listener/Store变化。

交付：

- 新 ADR：接受 stable local Agent API、REST/SSE façade、existing Controller binding、no remote/Browser mutation/no second Runtime；
- 明确局部扩展 ADR-0142 repo-private/public SDK No-Go 与 ADR-0147 consumer边界，不改写历史 ADR；
- 固定 production owner、listener owner、rollback、release与current authority更新范围；
- 更新本计划/RFC状态只表示决策接受，不宣称实现。

Gate：ADR accepted；`docs/active/coordinator-workspace-worker-web.md` 仍是当前实现 authority；零 production code。

Rollback：保持 RFC/plan draft，删除未接受 ADR草稿，不触碰实现。

#### KASAPI-00B：Runtime/Run/receipt/stream evidence matrix（已完成）

完成证据：[`Kite Agent Server API V1 当前证据矩阵`](../understanding/2026-08-29-kite-agent-server-api-v1-evidence.md)已逐项链接
command、receipt、State/event、History、Controller/capability与restart源码/tests；裁决Run需要新Store migration ADR，SSE cursor本身不需要
Store变化，public idempotency不得依赖transient Client principal。

交付：`docs/space/understanding/` evidence文档，逐项链接 command、receipt、State/event、History、Controller/capability、restart tests；
记录所有“不足以实现”的缺口，不提出 sidecar workaround。

Gate：第3.3节全部有源码/测试证据；Run与SSE不存在“以后猜测”的关键项。

Rollback：只读文档可整体删除，不改变current behavior。

#### KASAPI-00C：Public contract freeze 与 integration manifest（已完成）

完成证据：[`Public contract freeze`](../understanding/2026-08-29-kite-agent-server-api-v1-contract-freeze.md)已给出exact
endpoint/status/header/error/role/context/idempotency/pagination/limits/SSE/compatibility；
[`integration manifest`](../understanding/2026-08-29-kite-agent-server-api-v1-integration-manifest.md)已冻结workspace/source/test/release/docs-map
owner；ADR-0150与[`Run Store子计划`](2026-08-29-kite-runtime-run-store-v1.md)已接受。

交付：

- exact endpoint/status/header/error/role/capability/pagination/limits表；
- stable idempotency mapper与pre-application rejection语义；
- Controller binding与SSE resync conceptual schema；
- workspace/package/exports/test/build/release/SBOM/documentation-map representative path manifest；
- 根据00B裁决创建ADR-0150与Run Store subplan，并把KASAPI-03A标为blocked直至migration完成。

Gate：不存在`200|202`、`426|409`等未裁决stable response；OpenAPI输入已冻结；所有新增owner有唯一文档路径。

Rollback：仍无listener/Store变化；contract freeze可由新ADR修订。

### Phase KASAPI-01：Agent API Contract 与 OpenAPI

#### KASAPI-01A：`agent-api-contract` package（已完成）

完成证据：`packages/agent-api-contract`已包含唯一root browser export、snake_case DTO/schema、strict request与forward-compatible response
codec、bounded JSON/UTF-8 limits、fixtures和owner tests；`check:agent-api-packages`固定zero workspace dependency/禁止private Runtime与Node/Bun/
React import。root workspace build/typecheck/default discovery、documentation map与
[`Agent API current authority`](../../active/agent-api-contract.md)已同步；零listener/Service consumer。

目标文件：

```text
packages/agent-api-contract/
  package.json
  README.md
  tsconfig.json
  src/dto/
  src/codecs/
  src/limits.ts
  src/index.ts
  test/
  fixtures/
```

交付：ServerInfo、Session、Run、Interaction、Checkpoint、Problem、page/cursor、SSE envelope/resync、request/response codecs；所有
ID、header、query、body、array、depth与text使用hard limits；request unknown field fail closed。

Gate：zero workspace dependency或00C批准的最小中立依赖；Bun/Node/Service/Runtime/React import为零；prototype-shaped、deep、oversized、
unknown discriminator negative corpus通过。

Rollback：尚无consumer，可整体删除package及graph登记。

#### KASAPI-01B：OpenAPI/Schema/fixture generation（已完成）

完成证据：`packages/agent-api-contract/generated/`包含canonical OpenAPI 3.1、33份JSON Schema、standalone `wire.d.ts`、4份fixture
examples与domain-separated digest manifest；package-local generator由同一Zod schema/operation registry派生全部artifact。owner tests逐byte
比较、重算每文件/aggregate SHA-256、验证20条stable path/success status/security/无live secret，并解析wire declarations；
`check:generated`与package boundary Gate已接入。

交付：从同一codec source生成OpenAPI 3.1、JSON Schema、wire TypeScript declarations、examples与digest；固定security scheme placeholder、
request/response status与SSE media type；加入generated artifact drift test。

Gate：codec/OpenAPI/schema/types fixture逐项一致；旧client optional response字段compatibility tests通过；spec无真实endpoint/token/path。

Rollback：删除generated artifacts，不影响Runtime。

### Phase KASAPI-02：Read-only Worker façade 与 API docs

#### KASAPI-02A：Authenticated Agent API context 与 Worker route shell（已完成）

完成证据：现有Workspace Worker listener通过注入式Agent API façade承载`/v1`与`/v1/auth/*`，没有第二listener、Runtime或Store；
Coordinator只允许Native peer mint `agent_api_observer|agent_api_controller` one-shot capability，Web peer保持`web_observer`且不能mint Agent API
purpose。exchange在消费capability前重新执行Workspace Trust admission，并建立60分钟、仅保存SHA-256 token digest且按
Worker/Workspace/Client/generation绑定的内存context；每请求检查generation，logout、connection close、drain/restart均撤销context。
`GET /v1`只发布空capability集合，未注册任何资源或mutation route；Browser `Origin`、Cookie、Fetch Metadata及不兼容contract均fail
closed。Service/context、carrier、Worker composition与Coordinator owner tests覆盖one-shot、role derivation、Trust不消费、TTL/generation、
overload、Browser signal、同listener dispatch与controller mutation仍404。

交付：在现有 Workspace Worker data listener中注册exact `/v1` routes，不创建第二listener；实现00C冻结的 capability exchange/context、
observer/controller role admission、request ID、body/header/query limits、drain与低信息auth failure。route shell只开放ServerInfo和read-only
placeholder；mutation仍404/forbidden。

Gate：one-shot capability不可作为长期每请求bearer；wrong Worker/Workspace/client/generation/purpose/expired/replayed capability fail closed；
Browser cookie/launch token/Origin请求不能建立Agent API context。

Rollback：移除route registration，现有 `/rpc`/History/App Control不变。

#### KASAPI-02B：Read-only Session/History/Checkpoint adapter（已完成）

完成证据：ServerInfo只发布`checkpoints/history/sessions`，同一Worker listener已开放Session list/get、History page与Checkpoint
list/preview；其他resource/mutation仍404。每个Bearer context拥有一条initialize/query-only private in-process Runtime Client/Server
logical connection，每次read重验Workspace Trust。Session page从already-open Store 7 connection按`updatedAt/sessionId` bounded keyset取ID，
只对page内最多100项以并发8做Runtime projection join；History复用safe `RuntimeHistoryClient` projector与exclusive sequence window，cursor
固定through sequence、boundary event digest及`sequence/public_ordinal`；Checkpoint metadata按revision/id keyset且逐个验证snapshot
schema/epoch/checksum，preview只返回计数与ETag。没有第二SQLite connection、DDL/index、compatibility import、全量transcript/Session物化、
Host/Store/Kernel concrete import或Run/mutation path。Service/Runtime Contract/SQLite owner tests覆盖cursor推进/损坏/rewind invalidation、
cross-scope 404、path non-disclosure、corrupt snapshot、pending connection drain与真实Worker in-process query。

交付：`apps/kite-service/src/agent-api/` read adapter；ServerInfo、Session list/get、History page、Checkpoint list/preview；get projection走
in-process Runtime Client/Server，History走现有 safe `RuntimeHistoryClient`。Session list必须bounded：使用00B证明的page source，再对page内
Session做bounded projection join；禁止先物化全Workspace list再分页。

Gate：cursor稳定推进；offline/missing/corrupt/legacy-only按frozen error返回；adapter无Host/Store/Kernel concrete import；History/live安全
projector负向语料保持一致。

Rollback：删除read routes/adapter，不改变Store/Runtime。

#### KASAPI-02C：Release-bundled `/api-docs`（已完成）

完成证据：Vite build从committed canonical OpenAPI以asset emission逐字节生成固定`api-docs/openapi.json`，因此本地`dist`与release覆盖
output directory使用同一路径；Gateway只允许`/api-docs`、尾斜杠、精确OpenAPI JSON及原有hashed assets，未知deep link保持404。
入口在Observer App bootstrap前选择reference renderer；页面不发现Worker、不保存credential、不发送Agent API request，也没有form、Try it或
execute control，只显示placeholder endpoint和availability未确认。Gateway测试覆盖CSP/no-store/content type/deep-link，Web测试覆盖routing、
no-control与same-origin `credentials: omit`加载；candidate builder/verifier/installer/smoke共同要求manifest绑定的contract asset。

交付：构建时把KASAPI-01B OpenAPI artifact复制到immutable Web assets；Gateway新增`/api-docs` deep link与
`/api-docs/openapi.json` static route；renderer关闭execute/Try it，使用placeholder endpoint/capability，无remote CDN/script。

Gate：页面无Worker discovery/network mutation/credential storage；CSP/Fetch Metadata/cache/build digest/deep-link refresh通过；API未启用或
Worker离线时只显示availability未确认。

Rollback：删除static routes/assets，不影响Browser Observer data plane。

#### KASAPI-02D：Read-only conformance 与 fault Gate（已完成）

完成证据：test-only reference client对每个success/Problem运行Public response codec并复核version/artifact digest/request ID/security headers，
同时驱动in-memory handler和真实Workspace Worker listener。suite覆盖capability incompatibility/replay、observer/controller read与mutation 404、
Session/Checkpoint keyset及并发新Session、History concurrent append下固定through sequence、1 MiB request/response、未知SSE route 404、
每context 16-request overload、pending Trust/read drain、Worker close/replacement与path/token/Workspace/binding non-disclosure；static assertion
禁止direct RuntimeAccess或Host/Store/Kernel concrete import。Gateway restart仍由既有独立process/carrier suite覆盖，且Gateway不代理`/v1`。

交付：contract-driven reference client；覆盖auth、pagination、concurrent Session update、Worker/Gateway restart、body/frame limits、drain、
observer/controller role与non-disclosure。

Gate：read-only façade完全通过后才能开始Run mutation；任何route direct Store/RuntimeAccess bypass使Phase blocked。

### Phase KASAPI-03：First-class Run 与 mutation receipt

#### KASAPI-03A：Canonical Run authority（Store migration tranche）

KASAPI-00B已证明current Store 7不足以提供bounded、无歧义的Run list/get、historical phase/status/timestamp与delete/fork/rewind/late
retry语义。本Task只执行ADR-0150与[`Runtime Run Store V1子计划`](2026-08-29-kite-runtime-run-store-v1.md)：升级State 27 / Store 8、
canonical Run index、receipt resource result、coverage boundary与whole-generation copy-and-switch；KRSRUN-01A～01B已关闭mechanism/
transaction/private query Gate，KRSRUN-02A已关闭delete/rewind/fork/restart Gate，02B已关闭generation migration Gate；在
KRSRUN-03A～03B完成前仍保持blocked。

无论哪条路径，start applied transaction必须持久确定`run_id`并让original/replayed receipt返回同一resource；Session delete/fork/rewind/
retention与unknown recovery全部有闭集语义。

Gate：禁止unbounded log scan、Session Logger推断、adapter Map、sidecar DB、hidden DDL、dual read/write或兼容fallback。

Rollback：只按migration ADR回滚，target新写后不自动切回source。

#### KASAPI-03B：Public mutation mapper、idempotency 与 Controller gate

交付：Idempotency-Key→canonical command identity mapper、canonical request digest、If-Match parser、applied receipt mapper；Agent API context的
exact Controller binding进入RuntimeCommandContext/prepared effect；pre-application failure不保存adapter receipt。

Gate：跨capability refresh/reconnect/restart命中原applied receipt；同durable key不同digest冲突；observer、stale/detached/wrong generation/
wrong Session binding在Host/effect前拒绝；secret/binding不进DTO/diagnostic。

Rollback：关闭mutation routes；既有Runtime receipt继续存在且不重放effect。

#### KASAPI-03C：Run create/list/get/cancel/wait

交付：五个Run endpoint；create立即返回durable Run；cancel提交receipt-bearing command；wait用bounded query/subscription+deadline，只取消本地
wait，不取消Run；同Session active Run返回`session_busy`。

Gate：并发create只有一个applied；response丢失原key返回同Run；cancel与terminal race确定；wait timeout/Client abort/slow reader不改变Run；
run/session/workspace identity交叉校验。

Rollback：停止新Run API admission；已applied Run继续由Runtime完成/恢复。

#### KASAPI-03D：Run crash/restart/retention qualification

交付：commit前/后、response前/后、activation/schedule/dispatch/terminal各窗口；Worker confirmed-dead replacement、Store reopen、delete/fork/
rewind、late retry、outcome_unknown与retention tests。

Gate：零重复effect、零丢失applied Run、unknown不自动重放；qualification未通过不得进入SSE/SDK。

### Phase KASAPI-04：SSE、Interaction 与 Session mutation

#### KASAPI-04A：Public event mapper 与 canonical cursor/resync

交付：exhaustive private→public `snake_case` event mapper、channel分类、optional `run_id`关联、opaque event ID/generation、History-through/
snapshot/live boundary与partial-resync state machine。Session-only event不猜Run；run filter不创建第二sequence。

Gate：每个RuntimeClientEvent显式project/omit/unavailable；filter改变/ephemeral cursor/Worker replacement/codec drift触发resync；cursor、snapshot、
History range可机械验证。

Rollback：尚未开放SSE route，可整体删除mapper/cursor adapter。

#### KASAPI-04B：SSE carrier、backpressure 与 ordering

交付：Session/run events routes、Last-Event-ID、channel allowlist、heartbeat、per-connection/global count+byte queue、slow consumer close、drain；
Create Run/Interaction response返回`applied_through_event_id`或00C批准的refetch contract。

Gate：HTTP response/SSE causal boundary可证明；ack-before-notification不能被错误外推到不同connection；slow consumer只关闭连接；heartbeat不
推进cursor/revision。

Rollback：关闭SSE admission；Run继续，Client回退query/History而非private `/rpc`。

#### KASAPI-04C：Interaction、close/delete/rewind/fork

交付：interaction replacement queue GET、exact identity response、Session close/delete、rewind/fork；全部使用Idempotency-Key与适用的
If-Match/sourceRevision；resume继续使用afterRevision barrier。

Gate：完整interaction identity回显，empty text不冒充cancel；stale revision/generation/digest拒绝；delete后late replay、fork target identity、
rewind file outcome与receipt retention符合Host/Store authority。

Rollback：停止这些public routes；applied command仍由canonical recovery完成。

#### KASAPI-04D：History/snapshot/live reducer 与 fault/soak

交付：未断线、短replay、gap-resync、partial boundary断线、Worker restart、slow consumer、malformed frame、drain、long-running Run soak矩阵。

Gate：History + snapshot + live最终presentation/Run状态与连续stream等价；任何遗漏/重复/伪完整使Phase blocked。

### Phase KASAPI-05：SDK、Native journey 与 release

#### KASAPI-05A：`agent-api-client` TypeScript SDK

交付：generated public types消费、HTTP/SSE transport、resource client、page iterator、ETag/Idempotency-Key保存、explicit retry、wait/stream local
abort、resync callback与typed Problem error。SDK不读取descriptor/token文件或Workspace path。

Gate：browser build可编译但controller bootstrap不进入Browser export；unknown optional response字段兼容；mutation retry不生成新key；abort不发
cancel。

Rollback：SDK未进入Native默认journey前可整体删除。

#### KASAPI-05B：Native bootstrap 与端到端 journey

交付：`kite-local-runtime/client`组合Coordinator resolve、Trust、现有Controller acquisition/resume、Worker capability exchange与
AgentApiClient；覆盖Session create/resume、Run、Interaction、History、SSE、Checkpoint journey。Public SDK仍不反向依赖Native package。

Gate：TUI/CLI private Runtime path不被Agent API悄然替换；Agent API reference journey与现有Runtime语义等价；Browser/observer不能使用Native
controller bootstrap。

Rollback：移除Native Agent API bootstrap/export，不改变TUI/CLI默认journey。

#### KASAPI-05C：Release assets、current docs 与 completion evidence

交付：package graph/exports/build/typecheck/test/release/SBOM、OpenAPI artifact/digest、Web assets、owner README、Service local docs、相关
`docs/active/`、book/runbook、documentation map、plans index与completion record。只有实际实现完成后RFC/plan状态才更新。

Gate：`document-before-commit` 全流程与所有Required checks通过；spec/build/digest与运行server一致；release uninstall/rollback不留discoverable
endpoint。

#### KASAPI-05D：Fault、candidate 与三平台 qualification

交付：source/installed candidate、Coordinator/Worker/Gateway restart、upgrade/rollback/uninstall、macOS/Linux/Windows hosted process/filesystem/
ACL/release evidence；headless automation只在用户在场的本机scope验证。

Gate：对应平台真实evidence通过前不得升级支持结论；remote/LAN/public Browser仍明确unsupported。

## 7. Task执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| KASAPI-00A | RFC/plan确认 | 新ADR、RFC/plan状态、authority边界 | `bun run check:docs` | 零production code，未接受则保持draft |
| KASAPI-00B | 00A | understanding evidence matrix | focused source/test audit、`git grep/rg` evidence | 只读文档可删 |
| KASAPI-00C | 00A～B | contract freeze、integration manifest、ADR-0150/Run Store subplan | docs/schema decision review | 已完成；零production变化 |
| KASAPI-01A | 00C | `packages/agent-api-contract/**`、README、graph/test owner | package test/typecheck/browser build/static gates | 无consumer时整体删除 |
| KASAPI-01B | 01A | OpenAPI/JSON Schema/types/fixtures/digest | generation drift、compatibility/negative corpus | 删除generated artifacts |
| KASAPI-02A | 01B | Service agent-api context、existing Worker route shell | auth/role/limits/drain negative tests | 移除route registration |
| KASAPI-02B | 02A | read adapter、Session/History/Checkpoint routes | pagination/non-disclosure/History tests | 删除adapter/routes，无Store变化 |
| KASAPI-02C | 01B、02A | Web/Gateway static api-docs assets/routes | Web build/CSP/deep-link/no-network tests | 删除static assets/routes |
| KASAPI-02D | 02B～C | read conformance/fault suite | Worker/Gateway restart、role、limits | 失败则不进入mutation |
| KASAPI-03A | 00B～C、02D、KRSRUN-00A～03B | Host/Store canonical Run authority | reopen/list/get/retention/migration/fault | 按ADR-0150；target新写后不自动回退 |
| KASAPI-03B | 03A | idempotency/fence/Controller binding mapper | lost response、refresh/restart、stale binding | 关闭mutation admission，保留receipt |
| KASAPI-03C | 03B | Run REST endpoints | concurrency/cancel/wait/identity tests | 已applied Run继续执行 |
| KASAPI-03D | 03C | Run crash/restart qualification | crash-window/Store reopen/retention | 未通过不进入SSE/SDK |
| KASAPI-04A | 00C、03D | event mapper/cursor/resync state machine | exhaustive event + reducer property tests | 未开放route可整体删除 |
| KASAPI-04B | 04A | SSE routes/queue/heartbeat/drain | ordering/gap/slow consumer/partial boundary | 关闭SSE，query/History仍可用 |
| KASAPI-04C | 03B、04B | Interaction/Session/Checkpoint mutation routes | exact identity/revision/receipt/fault | applied command由Runtime恢复 |
| KASAPI-04D | 04B～C | reducer/fault/soak suite | History+snapshot+live等价 | 失败则不发布SDK |
| KASAPI-05A | 01B、04D | `packages/agent-api-client/**` | SDK unit/conformance/typecheck/browser build | 未接Native前整体删除 |
| KASAPI-05B | 05A | Native bootstrap composition/E2E | Coordinator→Worker→REST/SSE journey | 移除Native export/composition |
| KASAPI-05C | 05B | release/docs/assets/completion | docs/static/build/release gates | 同tranche撤回descriptor/assets/SDK |
| KASAPI-05D | 05C | 三平台candidate/fault evidence | hosted matrix/candidate smoke | 平台无证据则保持unsupported |

## 8. 必测矩阵

### 8.1 Contract/HTTP

1. 所有request unknown/malformed/oversized/deep/prototype-shaped input fail closed；
2. header/query/body/cursor/id/frame有hard limits，重复header与非法UTF-8/number拒绝；
3. OpenAPI、JSON Schema、types、codec、examples与digest逐项一致；
4. response新增optional展示字段时旧SDK可忽略；required/semantic/discriminant破坏必须新major；
5. 缺If-Match、stale If-Match、错误ETag Session、sourceRevision、resume afterRevision分别符合冻结表；
6. Problem Details无path/token/credential/raw body/provider/sandbox/diagnostic；
7. Native build mismatch与Public schema/capability incompatibility不会混淆。

### 8.2 Capability/Controller/Security

1. capability绑定wrong Worker/Workspace/client/generation/purpose/expiry/replay全部拒绝；
2. Agent API context refresh不改变stable idempotency identity；
3. observer全部mutation拒绝；controller role无Controller lease同样拒绝；
4. stale/detached/wrong Session/controller generation/bindingReference在effect前拒绝；
5. Browser launch token/cookie/Origin不能建立Agent API context；
6. Coordinator不代理Session/Run/History/SSE data plane，不保存raw capability或Run facts；
7. DTO、OpenAPI examples、diagnostic、logs、source map不含endpoint/token/path/binding；
8. adapter无Host/Store/Kernel concrete import，无direct RuntimeAccess alternate path。

### 8.3 Idempotency/Run/Concurrency

1. applied response丢失后同key/digest返回同Run/receipt；
2. durable key不同digest固定conflict；
3. auth/admission/revision/busy/interaction precondition rejection不创建durable rejected receipt；
4. 同Session并发Run create只有一个applied；不同Session可并行；
5. cancel与terminal race、重复cancel、late cancel、wait timeout/abort确定；
6. Worker crash在commit/response/activation/schedule/dispatch/terminal各窗口零重复effect；
7. delete/close/fork/rewind后的late retry与receipt/Run tombstone/retention符合ADR；
8. Workspace/Session/Run/Interaction/Checkpoint identity不能跨scope命中。

### 8.4 Streaming/Recovery

1. Last-Event-ID exclusive resume连续时无重复/遗漏；
2. cursor过旧、Worker replacement、filter change、ephemeral cursor、codec drift全部resync；
3. resync control/snapshot partial delivery后重连重新发完整boundary；
4. Session-only event无`run_id`，run-filter不创建第二sequence；
5. HTTP applied boundary与已有SSE connection因果关系可证明或明确要求refetch；
6. slow consumer只关闭该connection，释放iterator/queue，不取消Run或阻塞正常Client；
7. heartbeat不推进event cursor/revision；
8. terminal前flush reasoning/text/tool progress；
9. History + snapshot + live reducer与连续stream等价；
10. Worker/Gateway/Client restart后旧generation/cursor/capability fail closed。

### 8.5 Web docs/SDK/Release

1. `/api-docs/openapi.json` digest/API/build identity与release artifact一致；
2. renderer无Try it/execute/form、无真实endpoint/token、无remote CDN/script；
3. API未启用/Worker离线时静态文档仍可查看且只标availability未确认；
4. SDK retry保留key/ETag/cursor，abort只结束local wait/stream；
5. SDK browser build不导出Native Controller bootstrap；
6. source/installed bundle、upgrade/rollback/uninstall不留下stale endpoint/spec/descriptor；
7. macOS/Linux/Windows分别由真实hosted candidate evidence登记。

## 9. 迁移、cutover 与回滚

### 9.1 Contract/read-only阶段

KASAPI-01/02在无mutation情况下可以整体删除。不得让read-only façade写Store、导入legacy source或启动Worker来补History；API docs artifact
存在不表示listener ready。

### 9.2 Run Store迁移

KASAPI-00B已证明需要新的Run persistence/index；ADR-0150与
[`Runtime Run Store V1子计划`](2026-08-29-kite-runtime-run-store-v1.md)已冻结Store 7 source → State 27 / Store 8 target、DDL/index、
Run/receipt retention、coverage、maintenance barrier、copy-and-switch、journal/fence、rollback与platform qualification。禁止：

- hidden DDL或复用旧Store版本号；
- sidecar Run database；
- event/Logger text回填authoritative Run；
- old/new dual write或try-new-catch-old；
- target出现新写后自动切回source。

### 9.3 Production listener/SDK rollback

回滚顺序：

1. quiesce新的Agent API mutation admission；
2. 有界drain HTTP/SSE，slow connection关闭但不cancel Run；
3. 保留所有canonical receipt/Run/Session/recovery facts；
4. 同tranche撤回SDK discovery、manifest、descriptor/capability与Web spec asset，不能留下可发现但不可用endpoint；
5. existing Runtime Protocol/TUI/Web Observer继续当前authority，不把public `/rpc`、embedded Host或Store fallback作为回滚；
6. Store变化严格按migration ADR处理。

## 10. 文档、提交与发布Gate

每个Task必须同步对应 owner README/本地docs。跨包Runtime/Store/Controller/capability/stream/recovery/release变化同步相关
`docs/active/`；架构变化追加ADR，不改写已接受ADR。`docs/documentation-map.json`只在新增production owner path时更新，并增加
representative path tests；plan/design/ADR本身不登记为current authority。

在任何stage/commit/push/PR前，必须读取并显式执行 `.agents/skills/document-before-commit/SKILL.md`：

```text
bun run check:docs-impact
bun run check:docs
bun run check:runtime-packages
bun run check:pre-release-architecture
bun run check:core-boundary
bun run typecheck
```

再按Task运行：

```text
bun test packages/agent-api-contract/test
bun test packages/agent-api-client/test
bun test apps/kite-service/test/agent-api
bun test apps/kite-service/test/workspace-worker
bun test apps/kite-service/test/web-gateway
bun run --cwd apps/kite-web typecheck
bun run --cwd apps/kite-web test
bun run --cwd apps/kite-web build
```

上述future path/command只在对应workspace/test实际创建后进入Required Gate；KASAPI-00C必须同步workspace runner、default/owned tests、build、
release、SBOM与test ownership，不能靠无效future path预占owner。

## 11. 并发执行规则

1. 每个可写Task使用独立branch/worktree与唯一Git owner；
2. KASAPI-00A～00C影响同一RFC/ADR/plan authority，串行完成；
3. KASAPI-01 contract与KASAPI-02/03 consumer不能在contract freeze前并行；
4. KASAPI-02C Web assets可在01B后准备，但与02A/02B共同命中release/active authority时，必须串行合并并rebase重跑docs-impact；
5. KASAPI-03A命中Runtime Contract/Host/Store/active authority，只允许一个owner，禁止与其他Store migration并行；
6. KASAPI-03B～04D共同命中Service adapter/carrier/Runtime authority，按依赖串行；
7. 协作Agent只能修改明确分配的互斥路径，不stage/commit/push/PR；
8. 不使用`git add -A`吸收其他worktree或用户改动。

## 12. 完成定义

计划只有在以下事实同时成立时才能标记`completed`并建立`docs/space/execution/completed/`证据：

1. KASAPI-00A～05D全部完成，或未交付平台明确保持unsupported且不影响已声明scope；
2. RFC、ADR、plan、owner README、active docs、book/runbook与源码/测试无冲突；
3. OpenAPI/schema/types/codec/SDK/server release digest一致；
4. canonical Run、applied receipt、Controller binding、History/SSE recovery与rollback fault evidence闭合；
5. TUI/CLI/Browser Observer现有journey无authority或presentation回归；
6. 所有Required docs/static/typecheck/test/release Gate通过；
7. 没有第二Runtime/Store/receipt/Run/cursor authority、public `/rpc`、Browser mutation、remote支持或silent fallback；
8. completion evidence记录实际commit、命令、平台与结果，不把计划定义或本地结果冒充实现/远端证据。
