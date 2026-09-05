# Web REST 客户端收敛实施方案

状态：completed

日期：2026-08-31

优先级：P0

决策：ADR-0155

依赖：ADR-0149、ADR-0152、ADR-0154、当前Store 9/single-Service/Agent API/Web Observer authority。

局部替代：现有[`Kite Agent Server API V1实施方案`](2026-08-29-kite-agent-server-api-v1.md)中“Web只展示静态API docs、Browser不进入
data plane”的未来任务边界；已完成KASAPI-00A～02D与Run Store证据保持历史有效，未完成Run mutation、SSE、SDK和release任务必须在本方案
完成后rebase到ADR-0155。

参考：OpenCode官方[Server文档](https://dev.opencode.ai/docs/server/)与[Web文档](https://dev.opencode.ai/docs/web/)证明TUI/Web可作为同一
Server的客户端并通过attach共享Session和状态。本方案只采用该客户端原则；Kite继续保证每个canonical home唯一Service，不采用OpenCode可
显式启动多个Server的进程模型。

## 1. 执行结论

本方案只完成一条窄的收敛：

```text
TUI ──现有Native client────────────┐
                                  ├─→ one Kite Service → one Runtime/Store → one kite.sqlite
Web ──browser auth + REST /v1─────┘
```

本阶段不迁移TUI transport，不开放Browser mutation，不新增SSE或业务WebSocket，不实现Desktop/remote/LAN/Agent GUI control。成功标准是Web
Workspace/Session/History/Checkpoint全部来自真实`/v1` contract与同一Service authority，旧Web Directory/History/WebSocket业务路径从
production composition删除。

## 2. 当前事实与问题

### 2.1 已有正确基础

- source/release的TUI、CLI、`service *`与`web`已经按canonical Kite Home复用唯一Local Service；
- single-Service manager已有reservation、concurrent ensure、exact process identity、build mismatch和fail-closed dead cleanup；
- Service拥有唯一Runtime Host、Store 9 writer、`kite.sqlite`与loopback listener；
- `/v1`已有Agent auth、ServerInfo以及Session/History/Checkpoint bounded read；
- Web已有static asset preflight、fragment launch token、HttpOnly cookie、Origin/Host/Fetch Metadata与safe presentation reducer；
- OpenAPI/JSON Schema/wire declarations/examples/digest来自同一Agent API contract。

### 2.2 需要关闭的重复

```text
Web Browser
  → /_kite/web/bootstrap
  → /_kite/web/tabs
  → /_kite/web/directory
  → /_kite/web/history
  → /_kite/web/client
  → WebObserver directory/history/live projection

Agent API client
  → /v1/auth/exchange
  → /v1/sessions
  → /v1/sessions/:id/history
  → /v1/sessions/:id/checkpoints
  → Agent API read adapter
```

同一Session和History存在两套route、DTO、projection、错误与恢复测试。Workspace在Web中只是有Session记录的分组，不是独立resource；因此空
Store或只有已信任Workspace时页面没有Workspace列表。

## 3. 固定产品边界

### 3.1 Service生命周期

所有入口使用同一manager和home选择规则：

```text
TUI start ─┐
Web start ─┼─ resolve canonical home → ensure → exact ready Service
CLI run  ──┘
```

必须满足：

1. TUI-first后启动Web：Web复用TUI已ensure的Service；
2. Web-first后启动TUI：TUI复用Web已ensure的Service；
3. 同时启动：一个spawn获胜，另一个等待ready，不产生第二DB/Host/listener；
4. custom `--kite-home`只与同canonical home的入口复用，不跨profile；
5. build/contract mismatch返回incompatible，不覆盖或并行启动；
6. TUI退出、Browser断开或`web stop`不停止Service；
7. `service stop`在active mutation busy时保持现有fail-closed drain语义。

### 3.2 REST surface

本方案新增或确认以下Browser可消费的read surface：

| Method | Path | Browser行为 |
| --- | --- | --- |
| `GET` | `/v1` | 返回版本、schema digest与当前principal capabilities |
| `POST` | `/v1/auth/browser/exchange` | one-shot fragment launch token换HttpOnly Browser session |
| `DELETE` | `/v1/auth/browser/session` | 撤销当前Browser session |
| `GET` | `/v1/workspaces` | 返回path-free、当前Browser可见Workspace page |
| `GET` | `/v1/workspaces/{workspace_id}/sessions` | 返回该Workspace的Session page |
| `GET` | `/v1/sessions/{session_id}` | 返回Session safe projection与revision |
| `GET` | `/v1/sessions/{session_id}/history` | bounded History page；支持运行中Session增量重新验证 |
| `GET` | `/v1/sessions/{session_id}/checkpoints` | safe Checkpoint metadata page |
| `GET` | `/v1/sessions/{session_id}/checkpoints/{checkpoint_id}/preview` | safe preview，不返回path |

Browser route必须是strict request、closed response、`no-store`、bounded page和path-free projection。Web不得调用OpenAPI中未由`GET /v1`
capabilities声明ready的operation。

### 3.3 认证与principal

```text
Native/automation capability → Agent bearer → exact Workspace-scoped observer/controller principal
Web launch token             → HttpOnly cookie → service-scoped read-only Browser principal
```

两类principal共享read handler/query authority，但authorization filter不同。Browser principal只看到已admitted且Store 9 directory允许投影的
Workspace，不取得canonical path；Agent principal继续只能访问绑定Workspace。cookie、bearer、Native header混用必须fail closed。

### 3.4 Web刷新

本阶段没有事件transport。Web按以下最小策略重新验证：

- 页面初始化读取Workspace与默认Session page；
- 展开Workspace或显式刷新时重新读取该Workspace Session page；
- 选中Session后分页读取History；
- 只有选中Session状态为running/waiting且页面可见时，按有界间隔读取增量History与Session projection；
- 页面隐藏、Session终态、用户切换或transport error时停止该Session轮询；
- 所有响应绑定request generation，旧Session迟到响应不得覆盖当前选择。

首版不增加通用poll scheduler、background sync engine、offline cache或持久client state。

## 4. 目标依赖与删除边界

### 4.1 依赖方向

```text
agent-api-contract
        ↑
browser-safe HTTP client
        ↑
apps/kite-web

agent-api-contract
        ↑
apps/kite-service/agent-api handler
        → existing Runtime/History/Store query authority
```

Web不得依赖`kite-local-runtime`、Runtime Protocol、Service source或Node/Bun I/O。Service handler不得建立第二Store connection、第二RuntimeAccess
或Browser-only Session/History cache。

### 4.2 Cutover后删除

- Browser `/_kite/web/tabs`；
- Browser `/_kite/web/directory`；
- Browser `/_kite/web/history`；
- Browser `/_kite/web/client`业务WebSocket；
- Web transport中的tab handle、subscription与resync state；
- production composition中的WebObserver directory/history/live adapter；
- `packages/kite-app-contract/src/web.ts`中只被退役route消费的wire DTO/codec；
- 对应owner tests、fixtures和current docs。

保留static asset carrier、`kite web` lifecycle、launch token mint、Browser session revoke和`/api-docs`。

## 5. Task执行矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| KWR-00 | ADR-0155 | ADR、计划、operation/owner基线 | `bun run check:docs` | 纯文档，可删除新记录 |
| KWR-01 | KWR-00 | Workspace/Browser auth/read contract、OpenAPI、codec、fixtures | contract package test/typecheck/build/check-generated | 未接listener，可整体删除新增contract |
| KWR-02 | KWR-01 | Browser principal、exchange/session、Workspace/Session/History/Checkpoint read handlers | Service Agent API/auth/read/conformance tests | route未被Web消费，可回退handler |
| KWR-03 | KWR-01 | browser-safe HTTP client与generation/abort边界 | client unit/type tests、contract drift test | 无production consumer，可删除client |
| KWR-04 | KWR-02/KWR-03 | Web REST原子cutover、旧route/WebSocket/WebObserver删除、bounded polling | Web reducer/transport/component、negative route、dead import与browser journey | 同一Task切换并删除；失败回退整个Task，不dual read |
| KWR-05 | KWR-04 | TUI/Web lifecycle一致性、release/docs/final qualification | lifecycle race、TUI-first/Web-first、release smoke、full gates | 不改变Store；失败保持阶段in_progress |

## 6. Task正文

### KWR-00：决策与基线

交付ADR-0155、本计划和索引；登记ADR-0147/0149局部替代关系；只描述future cutover，不修改`docs/active/`当前行为。冻结本方案的API、
生命周期、非目标和删除边界。

### KWR-01：合同闭集

在`agent-api-contract`中增加path-free Workspace page、Browser exchange/session与Workspace-scoped Session list operation；复用现有Session、
History、Checkpoint public DTO与limits。OpenAPI、JSON Schema、wire declarations、fixtures和digest必须同源生成，不能手写Web副本。

合同必须区分Browser cookie与Agent bearer security scheme；Browser operation只声明read capability，不把Run/Interaction/mutation/SSE提前标记
ready。生成物无真实origin、token、Workspace path或build-local绝对路径。

### KWR-02：Service read façade与Browser auth

Service持有launch/session内存authority。exchange消费一次性、短TTL token并设置HttpOnly/SameSite cookie；logout、`web stop`、Service restart、
expiry与drain撤销session。Browser request完成Host/Origin/Fetch Metadata/CSRF/header/body/queue检查后形成read-only principal。

Workspace list从Store 9 canonical directory读取真实Workspace resource，不从Session数组在adapter中反推；Session/History/Checkpoint继续复用
现有bounded query与safe projection。两类principal命中相同read owner，只有scope filter不同。

### KWR-03：Browser-safe REST client

建立只覆盖已实现read operation的browser-safe client。它负责request codec、response codec、Problem、abort、page cursor和request generation，
不负责Service discovery、launch token持久化、Controller、重试daemon、offline cache或事件stream。Browser bootstrap adapter捕获fragment并完成
exchange，随后只使用cookie-authenticated `/v1` request。

### KWR-04：Web原子cutover与重复路径清理

Web初始化后读取Workspace page，渲染独立Workspace列表；展开或选择Workspace读取Session page；选择Session读取safe History与Checkpoint。
保留loading/empty/error/unavailable状态和迟到响应隔离。运行中Session只在页面可见时执行单一有界轮询，组件不直接使用fetch或拼route。

同一Task删除旧Browser tab/directory/history/WebSocket生产route、Web transport与不再消费的WebObserver projection。保留仍被Agent API或
Runtime安全History owner消费的底层query/projector，不按目录名批量删除。增加negative tests证明退役route返回404且Web bundle不包含旧
path。任何中间提交也不得让Web同时调用旧BFF和`/v1`，不得保留无consumer的旧route作为兼容或回滚脚手架。

执行项目`overengineering-check`，确认未保留dual contract、compatibility shim、unused abstraction、通用poll scheduler或仅由测试消费的旧route。

### KWR-05：双入口生命周期与最终Gate

以同一个canonical home覆盖：

1. Service absent时TUI启动后Web attach；
2. Service absent时Web启动后TUI attach；
3. TUI/Web concurrent ensure只spawn一次；
4. 一个客户端退出不影响另一个；
5. `web stop`只撤销Browser session；
6. `service stop/restart`后的TUI/Web诊断与重新ensure；
7. source/installed build mismatch、custom home与asset preflight fail-closed；
8. 两个客户端读取同一新建Session与History事实。

更新owner README、本地docs与`docs/active/agent-api-contract.md`、`coordinator-workspace-worker-web.md`、
`single-service-local-runtime.md`、相关book/tests/release文档和documentation map。运行完整文档、架构、type、Web、Service、local-runtime、TUI system与
release build/verify/smoke Gate；最终完整diff再次执行`overengineering-check`。

## 7. 验证门禁

每Task至少运行owner tests与：

```text
bun run check:agent-api-packages
bun run --cwd packages/agent-api-contract test
bun run --cwd packages/agent-api-contract typecheck
bun run --cwd apps/kite-web test
bun run --cwd apps/kite-web typecheck
bun test apps/kite-service/test/agent-api
bun test packages/kite-local-runtime/test/single-service-manager.test.ts
bun run check:runtime-packages
bun run check:pre-release-architecture
bun run typecheck
bun run check:docs-impact
bun run check:docs
```

KWR-05再运行相关TUI system journey、`bun test tests/release`、`bun run release:build`、`release:verify`与`release:smoke`。不得用裸
`bun test`替代仓库默认/隔离执行规则，不得用Vite dev server证明Service/Web production journey。

## 8. 风险与停止条件

| 风险 | 控制 |
| --- | --- |
| Browser service-scoped discovery泄漏path | 只返回opaque ID/safe label；contract与non-disclosure tests拒绝path |
| cookie与bearer route混用 | auth middleware形成exact principal；混合credential fail closed |
| REST轮询增加Store/Runtime负载 | 仅选中running/waiting Session、页面可见、有界单flight；先量测再决定事件transport |
| API contract包含未实现operation | Web只消费ServerInfo capabilities声明ready的read operation |
| Web cutover丢失History/live保真 | snapshot/增量reducer等价测试；不满足则KWR-04保持in_progress |
| TUI/Web并发启动分裂Service | 复用现有reservation/identity manager并增加真实child race journey |

出现以下任一情况必须停止当前Task，不增加sidecar或fallback：

- Workspace list无法从Store 9 canonical directory bounded读取；
- Browser principal需要canonical path、Native secret或第二Store connection才能工作；
- Web为维持当前展示需要复制Runtime/History authority；
- concurrent ensure可以产生两个ready Service；
- polling在有界策略下仍造成已验证的不可接受负载；
- cutover只能依赖dual read或silent fallback通过。

## 9. 完成定义

- TUI-first、Web-first、同时启动均复用同一Service/Store/DB；
- Web Workspace、Session、History、Checkpoint全部通过真实`/v1`读取；
- 没有Session的已admitted Workspace可按产品scope显示；
- Browser auth不向JavaScript暴露Agent/Native credential；
- 旧Web directory/history/WebSocket生产route与重复projection已删除；
- TUI行为和Native presentation fidelity不回归；
- 没有SSE、业务WebSocket、TUI REST迁移、多Server、remote或GUI automation的提前实现；
- implementation、owner current docs、active authority、OpenAPI、tests与release evidence共同通过Gate。

## 10. 当前实施状态（2026-08-31）

| Task | 状态 | 证据 |
| --- | --- | --- |
| KWR-00 | completed | ADR-0155、计划与索引，docs Gate通过 |
| KWR-01 | completed | contract codec/OpenAPI/schema/wire/example/digest与14项owner test通过 |
| KWR-02 | completed | Browser principal、Store 9 Directory read与Service Agent API 27项完整suite通过 |
| KWR-03 | completed | browser-safe client 4项owner test、typecheck/build与package boundary Gate通过 |
| KWR-04 | completed | Web 7项test、production build旧path零匹配、退役route 404、全仓typecheck与架构Gate通过 |
| KWR-05 | completed | 真实child双入口/并发/同事实、默认测试、TUI system、release 186项、candidate build/verify/smoke全部通过 |

KWR-05在严格TUI Gate中额外关闭了三处single-Service基线缺口：Runtime command不再使用早于Controller创建的socket ticket快照，而是按
已认证Client/connection generation逐请求读取Store 9当前Session Controller；queued Run same-phase activation通过唯一writer transaction；
TUI durable observer只读`kite.sqlite`而不探测旧layout/checkpoints fallback。`startup`、完整`session-lifecycle`与跨进程
`session-persistence`联合通过；最终macOS arm64 dirty-source candidate `e8da3129b3c8bc8339494ee6`通过build、verify与smoke。
