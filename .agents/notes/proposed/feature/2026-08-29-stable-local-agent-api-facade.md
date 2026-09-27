# Agent Note: 稳定本机 Agent API 复用现有 Runtime、Controller 与 Store authority

Status: proposed

## Problem
以下是 2026-08-29 提案时的历史拓扑，不描述现行实现。当时默认 release/source topology 由 Coordinator 定位 canonical Workspace Worker；Worker 独占该 Workspace 的 Store 7、Runtime
Host、Session mailbox、Controller lease、effect/recovery 与 private Runtime Server。Native TUI/CLI 通过 Coordinator resolve/mint、
one-shot Worker capability 与 private JSON-RPC Runtime Protocol直连Worker。唯一Web Gateway和Browser永久只读，只消费path-free
Directory、safe History与live presentation。完整History由Service-owned safe projector和Store 7 readonly query提供。

该拓扑前提已失效。现行默认入口为配对的 stdio App Server，source 与 installed 使用 canonical Kite Home；协议和 Store 已经历后续迁移。当前拓扑与已开放能力以[本机 App Server 契约](../../../../docs/active/app-server-local-runtime.md)和[Agent API 契约](../../../../docs/active/agent-api-contract.md)为准。本提案未交付的 Run、mutation、SSE 与 SDK 范围不能由旧 Coordinator/Worker/Store 7 设计直接推导。

现有 `kite.runtime-protocol.v1` 是repo-private、exact、transport-neutral contract。它适合仓库内Native Client，但没有面向第三方SDK、
Desktop backend或用户在场本机headless automation的稳定资源、HTTP lifecycle、OpenAPI、first-class Run query/wait/join或Public
compatibility承诺。直接公开`/rpc`会把internal discriminant、initialize/admission和connection model固化为长期ABI；另建HTTP Runtime/
Run database又会制造第二execution/receipt/recovery事实源。

仍待完成的产品边界是稳定本机 Agent API 与既有 Runtime、Store、Controller、History、Workspace Trust 共享单一 authority，不建立第二执行或持久事实源。以下 Worker、Store 7、Protocol v1 的具体实施步骤是原案历史约束；迁移到当前 App Server 的具体映射须按现行 owner 契约重新核实，不能仅凭本 Note 宣称完成。

## Proposal
以下只保留仍适用的单一 authority、安全与兼容取舍。涉及 Coordinator/Worker、Store 7、Protocol v1 的步骤是原提案的历史实施草案；后续必须以当前 App Server、Store 与已冻结 Public contract 核实，不能直接按旧拓扑实施。

### 1. 建立 stable local Agent API V1

Kite接受未来`/v1` Agent API，使用Session、Run、Interaction与Checkpoint资源：

- REST表达资源create/get/list/wait与显式mutation；
- SSE表达bounded replay、gap/resync与live presentation；
- OpenAPI 3.1、JSON Schema、wire TypeScript types、fixtures与runtime codec来自一个browser-safe contract source；
- Public JSON wire固定`snake_case`、request strict、response optional-field forward compatible；
- V1的“public”只表示有版本与SDK兼容承诺，不表示公网、LAN、hosted或multi-user支持。

首期transport只服务loopback、同一OS用户、一个已admission的canonical Workspace。允许consumer为Native TypeScript SDK、Desktop/native
backend、用户在场的本机headless automation与conformance client。Browser不能直接取得Agent API data-plane capability。

本记录不以提案状态宣称 SDK、Run 或 mutation 已经实现。只读 listener 与 contract 已有后续交付，实际开放范围由源码、workspace docs 与 `docs/active/` 维护。

### 2. Public façade不成为第二Runtime

Agent API adapter只允许：

1. strict decode public request与authenticated context；
2. 将public resource操作映射到existing Runtime command/query/subscription或History use case；
3. 通过exhaustive mapper产生closed、bounded、client-safe public DTO/event；
4. 管理HTTP/SSE framing、cursor、queue、backpressure、heartbeat、drain与local wait lifecycle。

它不得直接打开SQLite、调用Kernel、构造Runtime event、持有Host/Store concrete type、缓存authoritative Session/Run状态或建立direct
RuntimeAccess alternate path。原案默认通过 in-process Runtime Client/Server logical connection 复用 private Protocol admission 与 ordering；该具体路径在现行 App Server 上仍待核实。若不能满足 HTTP/SSE 因果或资源成本，须重新裁决共同的 application service port，不能复制 Host authority。

原案中 Coordinator 只管 discovery/routing、Worker 拥有执行事实，是为了防止第二 authority。现行 App Server 下继续禁止 HTTP adapter 保存独立的 Run status、receipt、Controller 或 capability signing key；不要求恢复原 Coordinator/Worker 进程拓扑。

### 3. Workspace capability与Session Controller严格分层

原案的 Worker 短期 one-shot capability 不能直接作为每个 REST/SSE request 重复发送的长期 bearer。这说明准入与请求身份需要分层；当前 Agent API 的 exchange、role 与 binding 以[现行契约](../../../../docs/active/agent-api-contract.md)为准，未交付 mutation 的身份方案仍待核实。

Public `controller` role只表示endpoint allowlist，不授予、恢复、转移或接管Session Controller lease。所有effectful mutation还必须满足：

```text
Native App Control取得或恢复Session Controller
  → exact Session/controller generation进入Agent API context
  → authenticated bindingReference进入RuntimeCommandContext
  → Host inspect/commit与prepared effect closure
  → canonical Store Controller/resource/effect authority再次验证
```

V1 Agent API不提供request/release/resume/detach Controller endpoint。binding缺失、detached、wrong Session或generation drift时mutation fail
closed。若未来允许纯Agent API Client自主取得Controller，必须新增superseding Agent Note，不得扩大`controller` role的解释。

observer只可list/get/history/stream。Web Gateway/Browser继续使用独立observer-safe companion contract；Browser launch token/cookie/Origin、
Native lifecycle/control token或credential capability不能建立controller Agent API context。

### 4. Mutation复用canonical applied receipt

所有产生Runtime mutation的Public `POST`/`DELETE`必须使用`Idempotency-Key`。KASAPI-00冻结一个稳定mapper，将public key映射为canonical
scoped command identity与request digest。该映射不能依赖短期capability、connection generation、Worker instance或restart-scoped random
secret；capability refresh、Client reconnect和 App Server restart 后必须命中同一applied receipt。

V1只承诺canonical applied receipt的durable replay：

- 同durable key + 同digest返回original applied receipt/resource；
- 同durable key + 不同digest返回idempotency conflict；
- parse/auth/admission/overload、revision conflict、session busy、interaction mismatch等applied transaction前failure不产生durable rejected
  receipt，后续同key按当前precondition重新评估；
- adapter不得用内存Map或sidecar保存sticky rejected response；
- 若未来要求某类rejected outcome持久重放，必须先扩展Host/Store canonical receipt并接受migration/retention Agent Note。

现有Session mutation继续使用revision fence：start/cancel/respond/close/delete/rewind映射`expectedRevision`，fork映射`sourceRevision`。
resume保持当前`afterRevision` recovery/presentation barrier，不由HTTP adapter伪装为不存在的`expectedRevision`。

### 5. Run成为canonical first-class resource，但Store实现条件化

Public Run必须拥有durable `run_id`，在start applied transaction中确定，并由original/replayed receipt返回同一resource。Run
create/list/get/cancel/wait、terminal/unknown、Session delete/fork/rewind与retention必须来自canonical Runtime/Store facts。

KASAPI-00 当时的 evidence audit 已确认 Store 7 不足，并引出[Agent Note 0150](../../implemented/simplification/2026-08-29-store-8-canonical-runtime-run-index.md)；后续 Store 又发生迁移。未来要开放 first-class Run，须重新核实当前 State/event/receipt/Store 是否足以 bounded、无歧义地查询；若仍需 Store 变化，必须新增独立 migration Agent Note，冻结 source/target profile、schema/index、Run/receipt/tombstone retention、maintenance barrier、copy-and-switch、journal/fence、rollback 与 platform qualification。禁止：

- adapter内存Run Map或独立目录 Run facts；
- sidecar Run database；
- 从Session Logger、trace、JSONL或日志文本推断authoritative Run；
- unbounded event scan作为稳定list/get实现；
- hidden DDL、dual write、try-new-catch-old或compatibility fallback。

first-class Run 是否可开放，须以当前 Store、Run query、mutation 与发布证据共同核实；历史 Store 8 Note 已实施不等于 Public Run 已交付。

### 6. History与SSE保持不同authority

完整durable History继续由existing exhaustive safe projector → readonly RuntimeLogQueryPort → canonical Store提供。SSE只提供bounded delivery与
live stream，不成为History、Store或recovery事实源。

Public SSE使用opaque exclusive Last-Event-ID与explicit resync。KASAPI-00必须在contract freeze前定义一个可机械验证的
History/snapshot/live boundary，至少等价包含stream generation、History-through sequence、Session snapshot revision与resume-after event
identity。cursor过旧、App Server/订阅 generation 变化、filter/channel改变、ephemeral-only cursor、codec drift、buffer gap或partial resync交付都不能猜测
连续性，必须重新建立完整resync boundary。

`run_id`只在canonical notification/projection能证明关联时出现；Session snapshot/reset/resync/create/close等无Run事实的event省略该字段。
run-filtered endpoint不能建立第二sequence/buffer/History authority。

HTTP mutation response与已有SSE connection必须有可证明的applied event boundary；若无法原子获得，Public contract必须要求显式refetch，不能
用时间戳或到达顺序猜测。

### 7. Public compatibility与Native build identity分层

原案要求 Native bootstrap 检查 exact instance、Protocol/client contract 与 build identity，以避免配套组件漂移。现行配对 App Server 与显式 daemon 的不同兼容规则由[本机 App Server 契约](../../../../docs/active/app-server-local-runtime.md)维护；本提案不重新指定它们的验证方式。

通过Native bootstrap后，Public SDK compatibility由`/v1`、schema与capabilities决定；普通`build_id`差异不使满足V1 contract的Client自动
incompatible。`build_id`只用于instance/release/diagnostic identity。破坏required field、语义或必须理解的discriminant需要新API major；
新增optional展示字段必须有旧Client compatibility test。

### 8. Web只增加release-bundled静态API文档

原案允许 Web Gateway 增加下列只读静态文档；现行 API Docs 已交付的范围以[Agent API 契约](../../../../docs/active/agent-api-contract.md)为准：

- `GET /api-docs`：无execute能力的文档页面；
- `GET /api-docs/openapi.json`：从Agent API contract同源生成、随immutable release打包的spec artifact。

页面不得运行时注入真实 endpoint/capability、保存credential、代理Agent API request或启用Swagger/Scalar Try it。artifact存在不
证明listener ready或用户有controller role。Browser/Web Gateway永久只读Observer边界继续有效；未来交互式console必须新增superseding
Agent Note，重新裁决Browser controller、credential custody、CSRF/Origin、destructive action与audit。

### 9. 分阶段交付与current authority

原实施方案的 KASAPI-00A～05D 是历史阶段划分，不作为当前执行门禁；后续以现行 owner 文档和实际交付证据确定范围：

1. Agent Note/evidence/contract freeze；
2. browser-safe contract/OpenAPI；
3. authenticated read-only façade/API docs；
4. canonical Run/mutation receipt；
5. SSE/Interaction/Checkpoint mutation；
6. SDK/Native journey/release qualification。

每个Task使用独立branch/worktree与唯一Git owner。同一current authority串行合并、rebase并重跑docs-impact。架构、Store、Controller、stream、
recovery或release behavior变化必须同步owner README/本地docs与相关`docs/active/`；plan/design/Agent Note不能满足current behavior Gate。

未交付的 mutation、Run、SSE 与 SDK 只能在各自 production capability、Store 与 release gate 完成后宣称可用；现行只读能力由负责文档说明。

## 局部替代关系
- 原案拟部分替代[Agent Note 0053](../../implemented/architecture/2026-07-30-local-single-user-first-topology.md)关于首发production consumer仅为TUI/foreground CLI的局部范围：允许同一OS用户、loopback、已完成Native
  Workspace Trust与Controller journey的SDK、Desktop/native backend和用户在场headless automation消费stable Agent API；[Agent Note 0053](../../implemented/architecture/2026-07-30-local-single-user-first-topology.md)的
  single-user、remote/LAN/hosted/multi-user No-Go继续有效。
- 原案拟部分替代[Agent Note 0142](../../implemented/feature/2026-08-26-runtime-server-client-protocol-boundary.md)关于 Runtime Protocol 不提供 Public SDK compatibility 的局部结论：私有 Runtime Protocol 仍不公开、不承诺 SDK compatibility；Public compatibility 只属于独立的 Agent API contract/façade。当前私有协议版本由 App Server 契约维护。
- 原案的 Coordinator/Worker 分权与 Store 7 migration 约束不要求恢复这些历史进程或存储版本；现行 Session/Store authority 以[本机 App Server 契约](../../../../docs/active/app-server-local-runtime.md)为准。未来 first-class Run 若需要新的 Store 变化，仍须独立 migration Agent Note。
- 不替代[Agent Note 0143](../../implemented/bug-fix/2026-08-26-local-runtime-presentation-fidelity.md)的closed local presentation与History/live等价原则，也不改变Workspace Trust、Sandbox、MCP、credential或effect授权。

## Alternatives considered
### 直接公开private `/rpc`

拒绝。它会把repo-private exact discriminant、initialize、subscription与Native connection model变成长期Public ABI，也没有REST resource、
HTTP concurrency、OpenAPI或first-class Run contract。

### REST handler直接调用RuntimeAccess或Host

拒绝。它会绕过Runtime Server admission/ordering/limits并形成第二execution path。只有新的共同application service port Agent Note可以改变默认
in-process Client/Server路径。

### 复制LangGraph Agent Server完整surface

拒绝。Assistant/config/state/store/debug等任意surface与Workspace filesystem、approval、Sandbox、receipt/recovery authority冲突。Kite V1
只借鉴Thread/Run分离、resource API、disconnect continue、stream lifecycle与OpenAPI思路。

### Agent API独立Run/receipt数据库

拒绝。它在response loss、App Server restart与Store recovery时会与Runtime事实分裂。Run/receipt只能进入canonical Host/Store authority。

### 让Browser直接使用Agent API

拒绝。它违反 Browser 只读边界，并引入未裁决的 credential custody、CSRF/Origin 与 destructive action surface；当前 Browser 权限以[Agent API 契约](../../../../docs/active/agent-api-contract.md)为准。

### 首期提供stateless Run或remote API key

延期。编码Agent会产生Workspace mutation、interaction、receipt与recovery evidence；stateless/remote/multi-user需要独立capability、retention与
operational Agent Note。

## Expected consequences
- Kite获得稳定local SDK产品方向，同时private Runtime Protocol仍可按repo需求演进；
- 新增contract/client package、Service adapter、HTTP/SSE carrier与release artifact，package/测试/文档owner数量增加；
- first-class Run可能要求新的Store profile与migration tranche，只有evidence确认后才接受；
- Controller binding、idempotency、SSE resync与compatibility在contract freeze前成为显式阻断项，降低后期HTTP façade补救风险；
- Web用户可以查看同release API文档，但不获得新的data-plane权限；
- remote/hosted/multi-user仍No-Go，Public命名不会被误解为公网支持；
- current behavior不会因Agent Note接受自动变化，实施证据与current authority必须逐Task收敛。

## Acceptance criteria

Run、Interaction、mutation、SSE 与外部 SDK 分别取得对应 production capability、协议与恢复验证，并在当前 owner 文档及发布证据中记录实际开放范围；仅有 OpenAPI future contract 或部分只读资源不构成整项提案完成。

## Risks

新增 HTTP/SSE、Controller、Run 与 SDK surface 会增加授权、兼容、恢复和发布维护成本。现有只读 Agent API 已交付的部分继续由当前 owner 文档说明；未开放的资源不得因本提案被当作可用能力。

## 回滚
production listener前，contract、OpenAPI、reference adapter与SDK可以整体删除，不影响private Runtime、Native TUI/CLI、Web Observer或Store。

listener接入后回滚顺序固定为：

1. quiesce新的Agent API mutation admission；
2. 有界drain HTTP/SSE，slow connection关闭但不cancel Run/Session；
3. 已applied Run/Interaction/Checkpoint/Session command继续由canonical Runtime/Store recovery收敛；
4. 不删除persistent receipt、Run/Session facts、tombstone或migration target；
5. SDK discovery、manifest、descriptor/capability与Web spec artifact同tranche撤回，不能留下可发现但不可用endpoint；
6. Store变化只按对应migration Agent Note回滚，target新写后不自动切回source；
7. 不恢复public `/rpc`、embedded Runtime fallback、第二Store/Host、Web mutation或remote listener。

## Historical relationships

决策者：用户直接指令

相关：[Agent Note 0053](../../implemented/architecture/2026-07-30-local-single-user-first-topology.md)、[Agent Note 0129](../../implemented/feature/2026-08-23-sqlite-runtime-log-query-boundary.md)、[Agent Note 0142](../../implemented/feature/2026-08-26-runtime-server-client-protocol-boundary.md)、[Agent Note 0143](../../implemented/bug-fix/2026-08-26-local-runtime-presentation-fidelity.md)、[Agent Note 0150](../../implemented/simplification/2026-08-29-store-8-canonical-runtime-run-index.md)，

`Kite Agent Server API V1 RFC`（历史资料已从当前工作树移除），

`Kite Agent Server API V1 实施方案`（历史资料已从当前工作树移除）。
