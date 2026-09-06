# ADR-0149：稳定本机 Agent API 复用现有 Runtime、Controller 与 Store authority

状态：accepted

日期：2026-08-29

决策者：用户直接指令

相关：ADR-0053、ADR-0129、ADR-0142、ADR-0143、ADR-0144、ADR-0147、ADR-0148，
[`Kite Agent Server API V1 RFC`](../design/2026-08-29-kite-agent-server-api-v1-rfc.md)，
[`Kite Agent Server API V1 实施方案`](../space/plans/2026-08-29-kite-agent-server-api-v1.md)。

## 背景

当前默认 release/source topology 已由 Coordinator 定位 canonical Workspace Worker；Worker 独占该 Workspace 的 Store 7、Runtime
Host、Session mailbox、Controller lease、effect/recovery 与 private Runtime Server。Native TUI/CLI 通过 Coordinator resolve/mint、
one-shot Worker capability 与 private JSON-RPC Runtime Protocol直连Worker。唯一Web Gateway和Browser永久只读，只消费path-free
Directory、safe History与live presentation。完整History由Service-owned safe projector和Store 7 readonly query提供。

现有 `kite.runtime-protocol.v1` 是repo-private、exact、transport-neutral contract。它适合仓库内Native Client，但没有面向第三方SDK、
Desktop backend或用户在场本机headless automation的稳定资源、HTTP lifecycle、OpenAPI、first-class Run query/wait/join或Public
compatibility承诺。直接公开`/rpc`会把internal discriminant、initialize/admission和connection model固化为长期ABI；另建HTTP Runtime/
Run database又会制造第二execution/receipt/recovery事实源。

需要接受一条窄的新产品边界：在同一Workspace Worker内增加stable local Agent API façade，同时保持现有Runtime、Store、Controller、
History、Workspace Trust与Web Observer authority不变。该决定必须先于contract/listener实现，并明确哪些问题仍由后续evidence/Store
ADR裁决。

## 决策

### 1. 建立 stable local Agent API V1

Kite接受未来`/v1` Agent API，使用Session、Run、Interaction与Checkpoint资源：

- REST表达资源create/get/list/wait与显式mutation；
- SSE表达bounded replay、gap/resync与live presentation；
- OpenAPI 3.1、JSON Schema、wire TypeScript types、fixtures与runtime codec来自一个browser-safe contract source；
- Public JSON wire固定`snake_case`、request strict、response optional-field forward compatible；
- V1的“public”只表示有版本与SDK兼容承诺，不表示公网、LAN、hosted或multi-user支持。

首期transport只服务loopback、同一OS用户、一个已admission的canonical Workspace。允许consumer为Native TypeScript SDK、Desktop/native
backend、用户在场的本机headless automation与conformance client。Browser不能直接取得Agent API data-plane capability。

本ADR不宣称listener、contract package、SDK或Run resource已经实现。current behavior继续由源码、workspace docs与`docs/active/`拥有，
直到实施计划对应Task通过Gate并完成cutover。

### 2. Public façade不成为第二Runtime

Agent API adapter只允许：

1. strict decode public request与authenticated context；
2. 将public resource操作映射到existing Runtime command/query/subscription或History use case；
3. 通过exhaustive mapper产生closed、bounded、client-safe public DTO/event；
4. 管理HTTP/SSE framing、cursor、queue、backpressure、heartbeat、drain与local wait lifecycle。

它不得直接打开SQLite、调用Kernel、构造Runtime event、持有Host/Store concrete type、缓存authoritative Session/Run状态或建立direct
RuntimeAccess alternate path。默认实现通过in-process Runtime Client/Server logical connection复用private Protocol admission与ordering；
若该路径无法满足HTTP/SSE因果或资源成本，只能由新ADR抽取Runtime Server和Agent API共同消费的application service port，不能复制Host
authority。

Coordinator继续只负责discovery、routing mirror、Worker lifecycle与capability relay，不代理Session/Run/History/SSE data plane，不保存Run
status、receipt、Controller或capability signing key。

### 3. Workspace capability与Session Controller严格分层

Worker继续签发短期、hash-only、one-shot connection capability，用于建立authenticated Agent API client context。它不能直接作为每个
REST/SSE request重复发送的长期bearer。connection exchange、session-bound context、TTL/revocation/reconnect、HTTP security scheme与
role derivation由KASAPI-00 contract freeze裁决，但必须绑定exact Worker instance、Workspace、Client、connection generation与purpose。

Public `controller` role只表示endpoint allowlist，不授予、恢复、转移或接管Session Controller lease。所有effectful mutation还必须满足：

```text
Native App Control取得或恢复Session Controller
  → exact Session/controller generation进入Agent API context
  → authenticated bindingReference进入RuntimeCommandContext
  → Host inspect/commit与prepared effect closure
  → Store 7 Controller/resource/effect authority再次验证
```

V1 Agent API不提供request/release/resume/detach Controller endpoint。binding缺失、detached、wrong Session或generation drift时mutation fail
closed。若未来允许纯Agent API Client自主取得Controller，必须新增superseding ADR，不得扩大`controller` role的解释。

observer只可list/get/history/stream。Web Gateway/Browser继续使用独立observer-safe companion contract；Browser launch token/cookie/Origin、
Native lifecycle/control token或credential capability不能建立controller Agent API context。

### 4. Mutation复用canonical applied receipt

所有产生Runtime mutation的Public `POST`/`DELETE`必须使用`Idempotency-Key`。KASAPI-00冻结一个稳定mapper，将public key映射为canonical
scoped command identity与request digest。该映射不能依赖短期capability、connection generation、Worker instance或restart-scoped random
secret；capability refresh、Client reconnect和Worker restart后必须命中同一applied receipt。

V1只承诺canonical applied receipt的durable replay：

- 同durable key + 同digest返回original applied receipt/resource；
- 同durable key + 不同digest返回idempotency conflict；
- parse/auth/admission/overload、revision conflict、session busy、interaction mismatch等applied transaction前failure不产生durable rejected
  receipt，后续同key按当前precondition重新评估；
- adapter不得用内存Map或sidecar保存sticky rejected response；
- 若未来要求某类rejected outcome持久重放，必须先扩展Host/Store canonical receipt并接受migration/retention ADR。

现有Session mutation继续使用revision fence：start/cancel/respond/close/delete/rewind映射`expectedRevision`，fork映射`sourceRevision`。
resume保持当前`afterRevision` recovery/presentation barrier，不由HTTP adapter伪装为不存在的`expectedRevision`。

### 5. Run成为canonical first-class resource，但Store实现条件化

Public Run必须拥有durable `run_id`，在start applied transaction中确定，并由original/replayed receipt返回同一resource。Run
create/list/get/cancel/wait、terminal/unknown、Session delete/fork/rewind与retention必须来自canonical Runtime/Store facts。

KASAPI-00 evidence audit必须先证明当前State/event/receipt/Store是否足以bounded、无歧义地query Run。若不足，必须新增独立Store migration
ADR，冻结source/target profile、schema/index、Run/receipt/tombstone retention、maintenance barrier、copy-and-switch、journal/fence、rollback与
platform qualification。禁止：

- adapter内存Run Map或Coordinator Catalog Run facts；
- sidecar Run database；
- 从Session Logger、trace、JSONL或日志文本推断authoritative Run；
- unbounded event scan作为稳定list/get实现；
- hidden DDL、dual write、try-new-catch-old或compatibility fallback。

在evidence/Store ADR关闭前，不得实现Run mutation listener或声称first-class Run已交付。

### 6. History与SSE保持不同authority

完整durable History继续由existing exhaustive safe projector → readonly RuntimeLogQueryPort → canonical Store提供。SSE只提供bounded delivery与
live stream，不成为History、Store或recovery事实源。

Public SSE使用opaque exclusive Last-Event-ID与explicit resync。KASAPI-00必须在contract freeze前定义一个可机械验证的
History/snapshot/live boundary，至少等价包含stream generation、History-through sequence、Session snapshot revision与resume-after event
identity。cursor过旧、Worker replacement、filter/channel改变、ephemeral-only cursor、codec drift、buffer gap或partial resync交付都不能猜测
连续性，必须重新建立完整resync boundary。

`run_id`只在canonical notification/projection能证明关联时出现；Session snapshot/reset/resync/create/close等无Run事实的event省略该字段。
run-filtered endpoint不能建立第二sequence/buffer/History authority。

HTTP mutation response与已有SSE connection必须有可证明的applied event boundary；若无法原子获得，Public contract必须要求显式refetch，不能
用时间戳或到达顺序猜测。

### 7. Public compatibility与Native build identity分层

Native Coordinator/Worker/Gateway/client bootstrap继续验证exact instance、Protocol/client contract、server version与build identity，确保同一
immutable release companion没有漂移。

通过Native bootstrap后，Public SDK compatibility由`/v1`、schema与capabilities决定；普通`build_id`差异不使满足V1 contract的Client自动
incompatible。`build_id`只用于instance/release/diagnostic identity。破坏required field、语义或必须理解的discriminant需要新API major；
新增optional展示字段必须有旧Client compatibility test。

### 8. Web只增加release-bundled静态API文档

唯一Web Gateway可以新增：

- `GET /api-docs`：无execute能力的文档页面；
- `GET /api-docs/openapi.json`：从Agent API contract同源生成、随immutable release打包的spec artifact。

页面不得运行时发现Worker、注入真实endpoint/capability、保存credential、代理Agent API request或启用Swagger/Scalar Try it。artifact存在不
证明listener ready或用户有controller role。Browser/Web Gateway永久只读Observer边界继续有效；未来交互式console必须新增superseding
ADR，重新裁决Browser controller、credential custody、CSRF/Origin、destructive action与audit。

### 9. 分阶段交付与current authority

实施必须按[`Kite Agent Server API V1 实施方案`](../space/plans/2026-08-29-kite-agent-server-api-v1.md)的KASAPI-00A～05D执行：

1. ADR/evidence/contract freeze；
2. browser-safe contract/OpenAPI；
3. authenticated read-only façade/API docs；
4. canonical Run/mutation receipt；
5. SSE/Interaction/Checkpoint mutation；
6. SDK/Native journey/release qualification。

每个Task使用独立branch/worktree与唯一Git owner。同一current authority串行合并、rebase并重跑docs-impact。架构、Store、Controller、stream、
recovery或release behavior变化必须同步owner README/本地docs与相关`docs/active/`；plan/design/ADR不能满足current behavior Gate。

在production listener、Store migration、SDK discovery与release manifest各自Task完成前，当前private Runtime Protocol、Native
TUI/CLI、Coordinator/Worker、Store 7与Web Observer行为不变。

## 局部替代关系

- 部分替代ADR-0053关于首发production consumer仅为TUI/foreground CLI的局部范围：允许同一OS用户、loopback、已完成Native
  Workspace Trust与Controller journey的SDK、Desktop/native backend和用户在场headless automation消费stable Agent API；ADR-0053的
  single-user、remote/LAN/hosted/multi-user No-Go继续有效。
- 部分替代ADR-0142关于Runtime Protocol不提供Public SDK compatibility的局部结论：private `kite.runtime-protocol.v1`仍不公开、不承诺
  compatibility；Public compatibility只属于新的Agent API contract/façade。
- 不替代ADR-0147的Coordinator control-plane only、Worker唯一Runtime/Store/Controller与Browser/Web Gateway永久只读边界。
- 不替代ADR-0148的Store 7/layout generation/migration规则；first-class Run若需要Store变化，必须新增独立migration ADR。
- 不替代ADR-0143的closed local presentation与History/live等价原则，也不改变Workspace Trust、Sandbox、MCP、credential或effect授权。

## 备选方案

### 直接公开private `/rpc`

拒绝。它会把repo-private exact discriminant、initialize、subscription与Native connection model变成长期Public ABI，也没有REST resource、
HTTP concurrency、OpenAPI或first-class Run contract。

### REST handler直接调用RuntimeAccess或Host

拒绝。它会绕过Runtime Server admission/ordering/limits并形成第二execution path。只有新的共同application service port ADR可以改变默认
in-process Client/Server路径。

### 复制LangGraph Agent Server完整surface

拒绝。Assistant/config/state/store/debug等任意surface与Workspace filesystem、approval、Sandbox、receipt/recovery authority冲突。Kite V1
只借鉴Thread/Run分离、resource API、disconnect continue、stream lifecycle与OpenAPI思路。

### Agent API独立Run/receipt数据库

拒绝。它在response loss、Worker restart与Store recovery时会与Runtime事实分裂。Run/receipt只能进入canonical Host/Store authority。

### 让Browser直接使用Agent API

拒绝。它违反ADR-0147永久只读Observer边界，并引入未裁决的credential custody、CSRF/Origin与destructive action surface。

### 首期提供stateless Run或remote API key

延期。编码Agent会产生Workspace mutation、interaction、receipt与recovery evidence；stateless/remote/multi-user需要独立capability、retention与
operational ADR。

## 后果

- Kite获得稳定local SDK产品方向，同时private Runtime Protocol仍可按repo需求演进；
- 新增contract/client package、Service adapter、HTTP/SSE carrier与release artifact，package/测试/文档owner数量增加；
- first-class Run可能要求新的Store profile与migration tranche，只有evidence确认后才接受；
- Controller binding、idempotency、SSE resync与compatibility在contract freeze前成为显式阻断项，降低后期HTTP façade补救风险；
- Web用户可以查看同release API文档，但不获得新的data-plane权限；
- remote/hosted/multi-user仍No-Go，Public命名不会被误解为公网支持；
- current behavior不会因ADR接受自动变化，实施证据与current authority必须逐Task收敛。

## 回滚

production listener前，contract、OpenAPI、reference adapter与SDK可以整体删除，不影响private Runtime、Native TUI/CLI、Web Observer或Store。

listener接入后回滚顺序固定为：

1. quiesce新的Agent API mutation admission；
2. 有界drain HTTP/SSE，slow connection关闭但不cancel Run/Session；
3. 已applied Run/Interaction/Checkpoint/Session command继续由canonical Runtime/Store recovery收敛；
4. 不删除persistent receipt、Run/Session facts、tombstone或migration target；
5. SDK discovery、manifest、descriptor/capability与Web spec artifact同tranche撤回，不能留下可发现但不可用endpoint；
6. Store变化只按对应migration ADR回滚，target新写后不自动切回source；
7. 不恢复public `/rpc`、embedded Runtime fallback、第二Store/Host、Web mutation或remote listener。
