# Kite Coordinator、Workspace Worker 与唯一 Web Gateway V1 方案

状态：active

日期：2026-08-28

优先级：P1

依赖：[`Kite Local Runtime Service V1`](2026-08-27-kite-local-runtime-service-v1.md)、
[`Kite Runtime Server V1`](2026-08-26-kite-runtime-server-v1.md)、ADR-0129、ADR-0142、ADR-0144，
以及当前 Runtime Authority、SQLite Store、Workspace Trust、Release Control、TUI Interaction 与 Native Carrier authority。

替代关系：本计划取代本分支此前的“全局长期 Service + pending activation”“默认每Client一个private Store”与
“Web内嵌每个Server”三个draft。它重新启动
[`SQLite 会话日志 Server/Web 实施方案`](2026-08-23-sqlite-session-log-server-web.md) 已关闭且未实施的Web部分，
保留LOGWEB-00～04已经完成的只读SQLite查询与安全展示投影，但不恢复旧`apps/kite`listener。

## 实施状态（2026-08-29）

KCWW-01～08 的源码、owner docs与本地验证已闭合：release/source默认 TUI、`run`、`resume` 通过 Coordinator 定位并直接连接
canonical Workspace Worker；Worker独占admitted Store 7、Session Controller、transactional effect fence与atomic Session create；
唯一Web Gateway/`apps/kite-web` 永久只读，只提供 path-free Directory、History/live presentation与主动断连。显式 `kite service *`
仍保留 legacy Store 6 maintenance surface，但 committed layout/fence 阻止它成为 fallback或与Worker双写。

本地macOS arm64 candidate已完成 build/verify/install、真实 Coordinator→Worker ensure/mint/handshake、TUI启动、Web payload、
companion identity、upgrade/rollback/uninstall与精确test-owned cleanup。KCWW-09仍保持 active，仅因为GitHub-hosted Linux/Windows
process/filesystem/ACL/release qualification尚无远端证据；本机macOS结果不得冒充这些平台结果。下文KCWW-00 baseline是计划制定时
的历史输入，不再描述当前实现。

## 1. 用户裁决

本计划固定以下产品与架构决策：

1. 一个canonical Kite home同时只有一个轻量Local Coordinator。
2. 全系统最多一个Web Gateway，只能通过`kite-code web`启动或返回已有实例；Web不内嵌到每个Runtime Worker。
3. Runtime authority按canonical Workspace分片：一个Workspace同时最多一个active Worker、一个Runtime Host与一个Store writer。
4. TUI与Desktop Client是可申请Controller的交互Client；Web Browser固定为只读Observer。Web可以定位已有Workspace/Session并订阅
   展示投影，但不能创建Session、触发Runtime执行或复制Session authority；是否需要启动只读查询owner由后续lifecycle设计决定，不能
   隐式启动Turn或取得writer authority。
5. 同一个Session同时只有一个Controller。Controller lease的最终authority位于Session所属Worker/Store；只有TUI或Desktop可以申请
   Controller。Web始终是Observer，只能读取、订阅和主动断开，不能发送prompt、回复approval/interaction、cancel或rewind。
6. Client共享Session的方式是连接Session所属的同一个Workspace Worker，不是多个Server之间同步状态。
7. Coordinator只拥有control plane：Worker定位、可重建Session目录索引、Web Gateway registry、Worker capability request relay与唯一
   lifecycle manager编排；它不拥有Controller lease、Session状态或effect recovery。TUI/Desktop取得Worker签发的capability后
   直接连接Worker，Coordinator不代理模型文本、工具输出与History data plane。
8. Web Gateway是只读browser BFF。Browser只连接Web Gateway；Gateway代表每个browser tab建立Observer binding，并代理
   Workspace/Session目录、历史消息与running Session实时展示流，不把Worker长期credential或内部endpoint暴露给Browser。
9. Store采用“一个global metadata Catalog + 每Workspace一个Runtime Store”，不采用一个全局大Runtime writer，也不采用每Client
   一个Store。
10. Worker之间不通信、不复制Session、不做federation；不同Workspace可并行，同Workspace filesystem mutation由Workspace
    Effect Gate协调。

## 2. 问题定义

当前Kite将全部Workspace、Session、Runtime Host与SQLite writer组合进一个长期Local Service。该模型保证单owner，但把所有
客户端版本、Service升级、Web生命周期、多Workspace故障与Store恢复集中到一个进程。相反，“每TUI/Desktop一个完整Service/
Store”会让同一Session出现多个revision、重复effect与无法收敛的interaction authority。

目标不是在两个极端之间任选其一，而是采用成熟的control-plane/worker-shard模型：

```text
全局小型Coordinator负责定位与租约
Workspace Worker负责唯一Runtime authority
Client直接消费Worker data plane
Web Gateway只做browser adapter
```

这允许多个Client安全打开同一Session，也允许不同Workspace独立运行/恢复，而不会引入Server-to-Server状态同步。

## 3. 目标架构

```text
Browser Tab A ─┐
Browser Tab B ─┼→ 唯一 Web Gateway
               │
TUI A ─────────┤
Desktop ───────┤
TUI B ─────────┘
               │ control plane
               ▼
       Kite Local Coordinator
       ├── Worker Registry
       ├── Session Directory Cache
       ├── Capability Request Relay
       ├── Web Gateway Registry
       ├── Process Recovery
       └── Global Metadata Catalog
               │
       issue endpoint + capability
               │
       ┌───────┴────────┐
       ▼                ▼
Workspace Worker A   Workspace Worker B
├── Runtime Host A   ├── Runtime Host B
├── Store A          ├── Store B
├── Sessions A*      ├── Sessions B*
└── Effect Gate A    └── Effect Gate B
       ▲                ▲
       └── data plane ──┘
```

进程基数：

```text
Coordinator       exactly 1 per canonical Kite home
Web Gateway       0 or 1 per canonical Kite home
Workspace Worker  0..N, exactly 0 or 1 per canonical Workspace
TUI/Desktop       0..N
Browser tab       0..N through the one Web Gateway
```

## 4. Authority与依赖矩阵

| Owner | 拥有 | 不拥有 |
| --- | --- | --- |
| Coordinator | Worker位置、可重建Session路由索引、Web singleton、Worker capability request relay、唯一Manager编排 | capability签发密钥、Controller lease、Runtime Host、Session正文、tool effect、Workspace文件、Provider raw body |
| Workspace Worker | Workspace Runtime Host/Store、Session State/Event/Receipt、Controller lease、interaction、MCP/Sandbox/Git、Workspace Effect Gate | global catalog、其他Workspace Store、Web assets、其他Worker生命周期 |
| TUI/Desktop | presentation、本地输入、显式open/request-control、projection reducer | Store、Host、Worker registry、其他Client controller |
| Web Gateway | single listener、browser auth/session、Web assets、只读browser Observer proxy | Runtime/Store authority、Controller特权、mutation、Worker长期token |
| Browser tab | Workspace分组Session列表、消息列表、running Session实时展示流与主动断连 | prompt、approval/interaction、cancel、rewind、Controller、Coordinator/Worker credential、filesystem/Store直接访问 |

`agent-kernel`、Runtime Host与Store不依赖Coordinator/Web/TUI类型。Coordinator只依赖closed control-plane contracts与process/
filesystem primitive；Web Gateway只消费browser-safe Client contracts。

## 5. Identity模型

以下identity不能混用：

```text
KiteHomeIdentity       canonical local-user control root
WorkspaceIdentity      canonicalPath + projectId + workspaceDigest
WorkerInstanceId       one live process generation
WorkerScopeId          stable Workspace authority shard
SessionId              durable Session identity
ClientId               TUI/Desktop/Web tab identity
ConnectionGeneration   one live Client connection generation
ControllerGeneration   Session write authority generation
WebGatewayInstanceId   one live Web process generation
ReleaseBuildId         executable/candidate evidence
ProtocolRevision       exact wire compatibility
StoreProfile           exact State/Store/format epoch
LayoutGeneration       one immutable global/sharded Store layout generation
ResourceLeaseIdentity  canonical shared resource mutation identity
```

Workspace identity在Coordinator admission与Worker启动时都重新canonicalize；wire path、cwd、Client metadata或Web输入不能提升
Workspace authority。Session Directory保存persisted Workspace identity，不能由当前调用者覆盖。

## 6. Coordinator control plane

### 6.1 本地IPC

Coordinator使用本地OS identity-bound IPC，而不是固定TCP端口：

- POSIX：owner-only Unix domain socket；
- Windows：current-user SID-bound named pipe；
- endpoint/state root必须no-follow/non-reparse并验证owner；
- source与installed home不得因cwd、Workspace `.env`或ambient HOME重定向。

Coordinator启动采用single-flight lock与server-owned handshake。PID、socket path或descriptor单独不能证明identity；alive/uncertain
state不能清理或spawn replacement，只有exact process identity confirmed dead才能stale recovery。

IPC使用closed versioned frame与固定method allowlist；每个request/response具有bounded ID、size/depth、deadline与idempotency key。
per-client/global queue有消息与字节上限；EOF、partial response与Coordinator crash产生typed unavailable/outcome_unknown，不自动重放
spawn、control或Gateway mutation。peer UID/SID、Coordinator instance、protocol/client contract/build均在initialize验证；frame、capability与
diagnostic不得携带Runtime event、model/tool/interaction正文或Worker长期credential。

### 6.2 API范围

V1 control plane只包含exact use cases：

```text
ensureCoordinator / status
resolveWorkspaceWorker
ensureWorkspaceWorker
resolveSessionWorkspace
listSessionMetadata
mintWorkerConnectionCapability
ensure/discover/stopWebGateway
subscribeDirectoryChanges
```

不提供generic RPC、任意method registry、raw SQLite、filesystem或Runtime command透传。

### 6.3 不进入data plane

Coordinator向目标Worker转发经过本地peer验证的Client binding并请求mint一次性capability，再把Worker endpoint与capability返回
TUI/Desktop；Coordinator不持有签发密钥、不决定scope/revocation，也不缓存可重放的raw capability。以下数据不经过Coordinator：

- model text/reasoning presentation；
- tool stdout/stderr/progress；
- full Runtime event/history；
- approval/input正文；
- artifact正文；
- provider response正文。

Coordinator重启时，已有Client↔Worker connection、Controller lease和active Turn继续；暂时阻止新Workspace/Session定位与
Worker spawn。Coordinator只能从Worker handshake/outbox重建Directory mirror，不能从Catalog恢复或改变Controller；reconcile完成后
才开放新的capability mint。Worker process lifecycle只由Coordinator组合的唯一Manager primitive执行，旧Manager入口不得与
Coordinator并发ensure/cleanup同一Worker。

## 7. Workspace Worker

### 7.1 唯一性

一个canonical Workspace同时只能存在一个active Worker：

```text
WorkspaceIdentity
  → WorkerScope lock
  → Worker process
  → Runtime Host
  → Workspace Store writer
```

lock在Store writer open前取得。alias、symlink、worktree/common-dir或同digest不同canonical identity不能创建第二owner。

该唯一性跨显式Kite home成立：Workspace owner lock由OS-user identity与完整Workspace identity派生，位于owner-only、
non-reparse的OS-user coordination root，而不是任一可切换Kite home。两个Coordinator使用不同`--kite-home`打开同一canonical
Workspace时，第二个必须fail closed。linked worktree仍可各有Worker，但共享Git common-dir、approved external root或user-global
config的mutation必须另外取得`ResourceLeaseIdentity`，不能把working-tree path lock误当作所有资源的全局锁。

### 7.2 启动与发现

Client请求打开Workspace/Session时：

```text
Coordinator canonicalize Workspace
  → acquire OS-user Workspace owner reservation
  → 锁内重新查询Worker Registry/validated scope state
  → existing exact healthy Worker：请求Worker mint capability并释放reservation
  → absent且scope可启动：spawn exactly one current-release companion并handoff reservation
  → Worker再次验证并持有Workspace owner lock
  → Store exact preflight/open
  → Runtime/Application/effect recovery ready
  → bind listener + authenticated worker readiness
  → register Worker
  → Worker mint client-bound one-shot capability
  → 返回endpoint/capability
```

Worker bind`127.0.0.1:0`；Coordinator登记actual port。Client不扫描端口、不依赖固定port。capability短期、hash-only、
worker/workspace/client-bound、one-shot establish；Worker restart后全部失效。

### 7.3 生命周期

Worker保持运行的条件：

```text
active Turn
or pending interaction/effect
or connected Client
or recovery operation
```

全部idle且无Client后进入bounded grace；完成snapshot/receipt/effect drain后关闭Store、unregister并退出。V1不force kill active
Worker，不因任一Client disconnect取消Turn，也不让不确定的Worker与replacement并存。

### 7.4 Workspace Effect Gate

同Workspace不同Session允许并发model generation和明确read-only effect；以下mutation通过Workspace级Gate协调：

```text
file write/patch
shell mutation
Git transaction
workspace config mutation
MCP project mutation
sandbox external scope mutation
```

Gate必须与Session command receipt/outcome_unknown边界组合，不能仅用进程内mutex隐藏crash窗口。不同Workspace Worker互不阻塞。

Workspace Effect Gate使用durable attempt/lease，而不是仅用进程内mutex：prepared effect identity、external process/Job identity、
dispatch acknowledgement、terminal/cleanup与outcome_unknown都写入Workspace Store recovery evidence。Worker crash后，在旧process或
effect identity未确认终止/收敛前，replacement Worker不得发起冲突mutation。

Gate分两层：

```text
Workspace-local gate
  → 当前working tree内file/shell/project config mutation

OS-user ResourceLeaseRegistry
  → Git common-dir、approved shared root、user-global config等跨Workspace资源
```

shell默认按可能mutation处理，只有封闭语义能证明read-only时才允许并行。V1第一版可以把同Workspace全部effect mutation串行，
不得为了性能提前引入无法恢复的并发。

`ResourceLeaseRegistry`位于固定OS-user coordination root，由Worker直接通过owner-only atomic filesystem/OS lock primitive操作，
不经过Coordinator，也不让Coordinator成为effect data plane。durable record至少绑定resource canonical identity、Worker/attempt/
external process identity、dispatch ack、terminal/cleanup与outcome_unknown；alias、Git common-dir、junction/reparse和stale owner均按
exact resource identity处理。

## 8. Store模型

### 8.1 Global Metadata Catalog

Coordinator唯一写入小型、可重建的routing index；Catalog不是Session、Controller、Worker健康或effect authority。V1只保存：

```text
sessionId
workerScopeId
directoryRevision
updatedAt
tombstone/routing generation
```

Catalog不保存title/summary、status、controllerGeneration、Worker instance、Session正文、Runtime Event、Tool result、approval正文、
credential、Workspace path、Store path或raw diagnostics。Worker/Host是所有Session与Controller事实源；Catalog entry只用于定位，
open/mutation前仍由Worker重新验证。

Worker Store header必须绑定exact WorkerScopeId与WorkspaceIdentity digest，并维护durable directory outbox。Session create/delete/rename先在
Worker Store transaction提交事实与outbox，Coordinator再幂等更新Catalog；跨DB不宣称原子事务。Catalog丢失/陈旧时阻止未知routing，
但不影响已有Worker/Turn；可以从validated headers与outbox重建，重建不恢复Controller/effect或伪造Worker健康。

### 8.2 Per-Workspace Runtime Store

概念布局：

```text
<kite-home>/active-layout
<kite-home>/layouts/<generation>/catalog.sqlite
<kite-home>/layouts/<generation>/workers/<workspace-scope-id>/runtime.sqlite
<kite-home>/layouts/<generation>/workers/<workspace-scope-id>/state/
```

每个Workspace Store由对应Worker唯一写入，保存Session State、Runtime Events、receipts、interaction、snapshots与recovery evidence。
不同Worker不能打开对方Store作为writer；Web/TUI/Desktop永远不直接打开Store。Store header的scope/workspace binding参与readiness与
Catalog rebuild，不能只凭目录名推断归属。

### 8.3 当前global Store迁移

当前Store不能被多个Worker直接复用。迁移采用独立、离线、generation copy-and-switch计划：

1. 进入显式maintenance barrier：阻止新Client/mutation，要求active Turn、Controller、pending interaction、external process与
   unknown effect全部settled；无法收敛时迁移不开始，不force kill；
2. 停止当前唯一Service并确认descriptor/token/lock/process全部absent；
3. immutable保留原Store/sidecar，不in-place修改；
4. 写入owner-only migration fence，阻止旧manager/binary重新ensure并打开legacy global writer；所有受支持旧入口必须在切换前
   fail closed；
5. 按persisted Session Workspace identity确定性分区；
6. 为每Workspace建立新current-format Store并复制完整State/Event/Receipt/Snapshot；
7. 为deleted Session retained receipt/tombstone建立可验证Workspace binding；既有orphan receipt无法归属时迁移blocked，不能
   伪装成corrupt后丢弃，也不能让Coordinator成为receipt data plane fallback；
8. 校验Session数、event sequence、receipt、snapshot position、content digest与Store profile；
9. 构建完整immutable target layout generation与最小Catalog；
10. 原子切换单一`active-layout` pointer；
11. 新Worker以readiness打开各自Store，并设置post-switch write fence；
12. 切换后原Store只读保留，绝不dual write、receipt fallback或silent Runtime fallback。

目标布局概念结构：

```text
<kite-home>/layouts/<generation>/
  catalog.sqlite
  workers/<workspace-scope-id>/...
<kite-home>/active-layout
```

migration journal记录source identity/digest、target generation、每个Workspace Store、Catalog digest、pointer phase与是否已有target
write。回退只允许：pointer未切时丢弃target，或pointer已切但所有target均未写时切回source；任一target产生新写入后禁止自动
回退，因为旧global Store不含新event/receipt/effect outcome。unknown phase时不得同时启动legacy Worker与Workspace Worker。

`active-layout`是steady-state唯一generation authority；journal只记录transition evidence。启动/recovery必须验证pointer schema、
generation manifest、Catalog digest、完整Worker Store集合与post-switch fence：pointer未切且target incomplete时保留source；pointer已切
但target不完整时阻止所有writer并进入recovery；target全部ready后才解除write fence。Catalog/outbox或任一Worker Store首次新写均将
generation标记为written，之后禁止自动回source。迁移前旧概念路径仅属于legacy layout，切换后不得继续保留第二个active Catalog。

任何Session缺失Workspace identity、corrupt event、unknown/unowned receipt或无法确定归属都使迁移blocked。迁移前后需要
journal、旧binary fence与三平台evidence；本计划不授权边实现Worker边在线搬运Store。普通deleted Session receipt是已知兼容问题，
其tombstone/schema策略已由前置 [ADR-0148](../../adr/0148-workspace-store-layout-generation-migration.md) 裁决，不能拖到迁移实现时处理。

V1候选策略是在sharding前先发布fence-aware Store schema：新receipt与Session delete都持久化Workspace binding和
`session_workspace_tombstone`；既有receipt只允许从仍存在的validated Session/Event证据离线回填，无法证明的历史receipt继续阻断
迁移。migration只支持已经具备fence协议的受支持release；更旧binary进入明确unsupported maintenance边界，source Store位置保留
不可写migration/Store marker使其fail closed，不承诺抵御同一OS用户恶意绕过受支持launcher直接重建旧Store。

## 9. Session Directory与Controller/Observer

### 9.1 打开与控制分离

```text
Coordinator resolveSessionWorkspace(sessionId)
  → Worker endpoint + one-shot connection capability
  → Worker openSession(sessionId)默认Observer

Worker requestControl(sessionId)
  → 可能取得Controller

Worker createSession(workspaceId)
  → 原子create + initial Controller
```

仅查看Session不能抢占Controller。Coordinator不授予Controller，也不在Catalog中恢复Controller；它只定位Worker并协调Worker mint
connection capability。

### 9.2 Lease

```ts
interface SessionControllerLease {
  sessionId: string;
  clientId: string;
  connectionGeneration: number;
  controllerGeneration: number;
  workerInstanceId: string;
}
```

所有mutation在Worker Session mailbox、receipt lookup与Host commit前验证当前lease。旧connection/controller generation、wrong
worker或wrong Session全部fail closed。

不可绕过的执行顺序固定为：

```text
Worker connection/capability admission
  → enter target Session mailbox
  → mailbox内重新读取并线性化当前Controller lease
  → lookup command/controller-operation receipt
  → Host inspect/commit
```

`requestControl/release/createSession(initial Controller)/abandonDetachedController`本身使用独立durable request ID、request digest与
`ControllerOperationReceipt`；response丢失后只query/replay原receipt，不再次推进generation。Worker通过internal
`WorkerCommandContext{clientId,connectionGeneration,controllerGeneration,workerInstanceId}`把caller authority带到mailbox，任何
Server/RuntimeAccess旁路都不得绕过该gate。

Worker是lease唯一authority。两类capability严格分离：

- `WorkerConnectionCapability`绑定当前Worker instance、Workspace/Trust、Client与connection generation，只用于一次建立连接；
- `SessionControllerResumeCapability`绑定Session、Client与controller generation，不绑定旧Worker instance；raw secret只在Client，
  hash与消费/轮换事实进入Workspace Store durable Session State。

Coordinator可保存bounded mirror用于展示，但Coordinator/Catalog crash不能创建、续期或转移lease。Worker restart使旧live connection
capability失效；新Worker从Store验证resume hash、当前generation与handoff状态，成功后原子轮换resume secret并取得新connection
generation。旧secret重放、wrong Session/Client或已handoff generation全部拒绝。command receipt与controller-operation receipt提供
独立query API，Observer不能通过重发mutation探测结果。

### 9.3 对称Client行为

```text
TUI先取得Controller     → Desktop只读、Web始终只读
Desktop先取得Controller → TUI只读、Web始终只读
Web tab打开Session      → 仅订阅，不申请或改变Controller
```

Observer可以订阅projection/history/status。Web从contract到界面都不存在输入框、approval/input action、cancel/rewind或
request-control入口；只隐藏控件不构成安全边界，Worker/Gateway allowlist同样必须拒绝这些mutation。TUI与Desktop的Controller
规则仍由Worker lease决定，不根据clientKind猜测authority。

### 9.4 状态机

```text
idle + unowned
  → acquire(controllerGeneration+1)
  → active(controller)

active + another client opens
  → observer

controller disconnect + active Turn
  → detached-controller
  → Turn继续
  → Observer仍只读

controller disconnect + idle + no pending interaction/effect
  → release(controllerGeneration+1)
  → idle + unowned

Turn settled + no pending interaction
  → release
  → idle + unowned
```

pending approval/input不自动迁移。原Controller使用Session-bound resume capability恢复；若原Client永久死亡，任一authenticated
Observer只能先请求Worker mint短期、one-shot、Session/controller/interaction-bound的`DetachedRecoveryCapability`，并在明确用户确认
后调用`abandonDetachedController`。Worker只在原connection已确认absent且Session处于detached状态时，在同一mailbox以expected
controller/interaction generation取消当前interaction/Turn、写入durable recovery receipt并释放lease；Controller resume与abandon
并发时只有一个CAS结果。该操作不是普通cancel，普通Observer仍无cancel authority。随后其他Client才能request control。V1不允许
新Controller直接回答旧
interaction，不做force takeover、TTL猜测死亡或两个Controller短暂并存。response已发送但receipt丢失时只query command/Session
state，不自动重放。

## 10. Client data plane

TUI/Desktop从Coordinator取得Worker endpoint与Worker-minted capability后，使用exact Runtime Client/Protocol直连Worker。
capability使用closed schema并绑定`WorkerInstanceId + WorkspaceIdentity/Trust revision/external-read scope digest + ClientId +
ConnectionGeneration + purpose + expiry + nonce`；hash-only、短期、one-shot establish。initialize只携带bounded client identity与
capability proof，不增加UI类型。Worker per-connection admission绑定Workspace、Client与可用Session；list/query不能提升mutation
authority，普通Workspace connection capability不能绕过Session Controller lease。

Client本地只拥有presentation：输入框、光标、折叠、主题、buffer和render reducer不跨Client同步。共享的是Worker投影的durable
Session State与live events；live replay、History replay与reconnect必须归约为相同presentation state。

## 11. 唯一 Web Gateway

### 11.1 命令与singleton

唯一用户入口：

```bash
kite-code web
kite-code web --json
kite-code web status
kite-code web stop
```

首次启动：

```text
connect/ensure Coordinator
  → acquire web-gateway lock
  → spawn current-bundle Web Gateway
  → bind 127.0.0.1:0
  → authenticated register
  → output actual URL
```

再次执行`kite-code web`：验证existing gateway handshake并返回同一个URL，不启动第二个。alive/identity-uncertain实例不能清理或
replace；confirmed dead才stale recovery。

### 11.2 Browser BFF

Browser只连接Gateway。Gateway：

- 托管bundle-owned Web assets；
- one-shot browser bootstrap与HttpOnly session；
- 为每个tab分配独立ClientId/connection generation；
- 通过Coordinator读取Workspace分组的Session目录，并为用户选中的已有Session resolve Worker；
- 取得只读、Observer-purpose的Worker短期capability，只代理History、Session projection与running Session live presentation events；
- 不向Browser返回Worker endpoint、capability、Store path或Native token。

Gateway和browser tab都不能申请、持有或恢复Controller。Gateway不得透明转发raw Runtime Protocol或rich TUI event，而是拥有只读
closed browser-safe query/event DTO allowlist，再映射到Worker exact read use case。HTML、JSON、stream、redirect、error、WebSocket
close reason、source map、browser console与diagnostic都不得出现Worker endpoint/capability/path/token。

V1选定固定Browser transport：static/bootstrap使用HTTP；bootstrap后每个tab通过exact`POST /_kite/web/tabs`取得Gateway生成的
opaque tab handle，再连接固定`WS /_kite/web/client`。WebSocket必须携带当前HttpOnly browser session，首帧在deadline内发送closed
`initialize{tabHandle}`；不使用query token或透明Runtime JSON-RPC。ClientId与ConnectionGeneration由Gateway生成，tab handle只是
cookie-bound identity、单独不构成authority。每个tab对每个Worker使用独立upstream Worker Client connection，不在V1实现multiplex
envelope；不同tab绝不能共享一个Worker Client authority。duplicate/reload/BFCache/tab close与Gateway crash都关闭旧socket并推进
connection generation，旧response不能改变Session。

`WebGatewayContract`只列出bootstrap/tab、按Workspace分组的Session list、Session message/history page、running Session live event、
unsubscribe/disconnect的exact schema/method/error。contract不得定义create/prompt、request/release control、approval/interaction、
cancel或rewind；unknown command/field和raw Runtime command全部拒绝。Gateway只把Browser query/subscription映射到Worker exact read
use case，并把Worker event投影为browser-safe display DTO，不能返回rich TUI event。

### 11.3 `/web`

TUI `/web`只发现已经由`kite-code web`启动的Gateway并mint browser launch URL：

```text
/web
  → Coordinator discoverWebGateway
  → Gateway mint one-shot launch URL
  → TUI LOCAL_TEXT输出actual URL
```

`/web`不能启动Gateway。Gateway absent时显示：`Kite Web is not running. Run kite-code web.`；不回退到Worker内嵌Web或固定端口。

### 11.4 Browser auth

launch token 32-byte random、hash-only、Gateway-instance-bound、30秒TTL、one-shot；URL fragment只在browser内存交换，随后
`history.replaceState`清除。Gateway使用instance-specific cookie name、HttpOnly、SameSite=Strict、Path固定；cookie与browser
session有界、无滑动无限续期。Host/Origin/Fetch Metadata/CSP/frame/nosniff/no-store/referrer与stored-XSS测试必须闭合。

Cookie只证明browser session，不证明tab identity或任何mutation authority。Gateway对Browser、Coordinator与Worker分别使用独立credential
namespace；Browser请求不能提交Worker URL/capability或raw Workspace path。Gateway→Worker capability绑定Gateway instance、tab
ClientId/connection generation、Worker instance、Workspace/Session与purpose，且只留在Gateway内存。

ADR冻结exact auth矩阵：Native mint只接受Gateway-native capability且拒cookie；browser bootstrap只接受body launch token、exact
Gateway Origin且拒Authorization；有效current-instance cookie可被原子轮换，畸形/重复current cookie拒绝，foreign Gateway cookie按
instance-specific name忽略；Browser HTTP/WS只接受
当前Gateway cookie+tab binding并拒所有Native credential。Cookie无`Domain`、Path固定Gateway Web root、absolute TTL与registry上限
固定；plain loopback HTTP的`Secure`策略必须明确。missing/wrong Origin、Fetch Metadata、OPTIONS、redirect与multiple current cookie
全部fail closed。

## 12. Web产品面

Web V1是严格只读的Session观察界面，不是完整Runtime Client，也不参与Controller/Observer竞争。页面只包含两个主要区域：

```text
左侧：按canonical Workspace/项目空间分组的已有Session列表
右侧：当前所选Session的消息列表与连接状态
```

固定能力：

- 列出可见Workspace，并在每个Workspace下列出已有Session；
- 选择Session后分页读取browser-safe durable消息/展示投影；
- 若Session仍在运行，订阅该Session的browser-safe实时展示流，并把新增内容归约到同一消息列表；
- Browser刷新或重连时先读取durable projection，再从有界sequence恢复live订阅；无法连续恢复时显式重新同步；
- 用户可以主动断开当前Session或关闭tab；断连只unsubscribe/释放Gateway binding，不cancel Turn、不释放或改变Controller；
- 明确显示loading、connected、reconnecting、disconnected、resync-required与Session unavailable状态。

明确不提供：

- prompt输入或Session创建；
- approval、ask-user或任何interaction回复；
- cancel、interrupt、rewind、fork、mode/config mutation；
- request/release/resume Controller；
- generic SQL/file/API或raw Runtime command。

消息展示按稳定的browser-safe projection渲染；live与History必须经过同一个presentation reducer并得到同一消息树。文本按段落或组件
渲染，不按transport chunk/文本行建立独立消息；Thinking、工具步骤与模型正文的聚合规则属于safe display DTO，不允许Browser根据
到达顺序重新猜测Runtime状态。

### 12.1 Web技术栈

Web作为独立private build workspace实现，不放入`apps/kite-service/src`，也不导入Service、Runtime Host或Store源码：

```text
apps/kite-web/
├── src/
│   ├── app/             # app shell与页面composition
│   ├── components/
│   │   ├── ui/          # project-owned shadcn/ui源码
│   │   ├── session/     # Workspace/Session sidebar
│   │   └── timeline/    # browser-safe消息组件
│   ├── presentation/    # History/live唯一reducer
│   ├── transport/       # Web Gateway query/subscription/disconnect adapter
│   ├── styles/          # design tokens与全局样式
│   └── main.tsx
├── components.json
├── vite.config.ts
├── tsconfig.json
└── package.json
```

V1固定技术选择：

| 层 | 选择 | 约束 |
| --- | --- | --- |
| UI runtime | React 19 | 单一React root；组件只消费Presentation State，不解释raw Runtime Event |
| 语言 | TypeScript strict | connection、message block与resync状态使用closed discriminated union |
| 构建与开发 | Vite | 只构建client-side SPA/static assets；不引入Next.js、SSR、RSC或第二个应用Server |
| UI组件 | shadcn/ui | 组件源码进入`apps/kite-web/src/components/ui`并由Kite持有；不把registry当runtime dependency |
| primitive | Radix UI | 只属于Web component内部；Radix类型不得进入Gateway/browser-safe contract |
| 样式 | Tailwind CSS v4 + CSS variables | CSS variables定义Kite semantic design tokens；业务组件不散落固定品牌颜色 |
| 图标 | Lucide | 只使用明确导入的图标，不引入另一套图标体系 |
| 状态 | React `useReducer` + Context | V1不引入Redux、Zustand或其他第二状态源 |
| 测试 | Vitest/Bun + React Testing Library；Playwright browser qualification | reducer、组件语义与真实双栏/断线/实时流分别验证 |

V1不需要React Router或full-stack React framework：当前只有一个双栏工作面，Workspace/Session选择属于页面状态，不建设多页面路由。
若未来出现可分享deep link、设置页或多页面导航，再由独立决策引入Router，不能提前把Gateway URL设计成UI routing authority。

shadcn/ui只按需纳入`Sidebar`、`ScrollArea`、`Collapsible`、`Badge`、`Skeleton`、`Spinner`、`Alert`、`Button`、`Sheet`、
`Separator`与必要的Tooltip；不得一次生成整个registry。`Button`仅用于主动断连或普通页面操作，不因此扩大Web mutation contract。

### 12.2 Presentation State边界

History page与live stream必须进入同一个纯reducer：

```text
browser-safe History page ─┐
                           ├─→ WebPresentationReducer → SessionViewState → React
browser-safe live stream ──┘

disconnect/reconnect/resync event → 同一connection state reducer
```

最小状态形状：

```ts
interface SessionViewState {
  readonly session: SessionSummary;
  readonly messages: readonly PresentationMessage[];
  readonly connection: WebConnectionState;
  readonly historyCursor: string | null;
  readonly liveSequence: number | null;
}
```

`PresentationMessage`由closed block union组成，至少区分text、thinking、tool activity、tool result、error与status。Thinking是完整可展开
组件；工具活动属于对应模型步骤；Shell stdout、stderr与exit code属于一个tool result；文本按paragraph/component渲染。React component
不得读取transport chunk、根据上一事件推断归属或维护另一份optimistic Runtime lifecycle。

V1不渲染raw HTML，不使用`dangerouslySetInnerHTML`，也不允许Server下发React组件名、JSX、CSS或任意UI schema。第一版正文可以只渲染
safe paragraph/code/link block；若后续需要Markdown，只允许在browser-safe text block内采用无raw-HTML renderer，工具结果与结构化block
不重新解释为Markdown。

当前不引入TanStack Query、GraphQL、Web Components、micro-frontend、Agent生成JSX或server-driven component tree。未来Agent Runtime控制
UI时，应基于新的closed semantic action/component contract扩展，而不是让Agent直接操纵DOM、shadcn primitive或Runtime authority。

Gateway代理有两个独立backpressure边界：Worker→Gateway与Gateway→Browser。每tab、每Worker及Gateway全局都必须有连接、消息与
字节上限；slow browser只关闭对应tab binding，overflow发送resync/typed unavailable后关闭，断开时unsubscribe Worker但不取消
Turn/effect或改变Controller。Browser WebSocket event携带bounded sequence；gap/overflow发送`resync_required`后关闭，Browser重新执行
bounded History/projection query。V1不把Gateway队列当History，也不提供stream replay；Gateway stop发送bounded
`gateway_draining`并在deadline内关闭Browser socket与upstream binding。

## 13. 并发模型

最终并发规则：

```text
不同Workspace Worker：并行，Store隔离

同Workspace不同Session：
  model/read-only并行
  filesystem/Git/config mutation经Workspace Effect Gate

同Session：
  Session mailbox + expected revision/CAS串行

同Session多Client：
  一个Controller + 多Observer

Catalog：
  Coordinator单writer transaction

Web：
  一个Gateway，多browser Observer identity，只读query/subscription/disconnect
```

这套模型不依赖Server之间同步，也不以SQLite transaction代替Runtime/interaction authority。

## 14. Version与release

CLI、TUI、Coordinator、Worker与Web Gateway由同一个immutable release bundle提供，但running process固定其启动build。安装新bundle
不kill旧Coordinator/Worker/Web/TUI。每个handshake包含exact protocol/client contract/build evidence：

- compatible Client可继续Observer/Controller；
- incompatible Client得到typed error，不自动restart/downgrade Worker；
- Worker升级只在Workspace idle、无Controller/Turn/interaction/effect时显式执行；
- Web Gateway通过`kite-code web stop`后重新`kite-code web`切当前bundle；
- Coordinator若contract不兼容，只能在无active recovery mutation的显式maintenance边界替换。

V1不实现multi-contract projector、后台自动热升级或force kill。

release layout必须先于production cutover冻结：stable launcher解析单一active pointer，Coordinator/Worker/Gateway从同一个immutable
candidate root启动；运行中的旧进程不重新读取pointer解析新companion。Windows使用可验证的regular-file atomic replacement/
write-through primitive，不覆盖正在运行的旧`.exe`。source/installed home、candidate与process build identity不能互相接管。

## 15. 故障与恢复

- Coordinator crash：已有TUI/Gateway↔Worker connection与Worker-owned Controller继续；Gateway停止新的Session/Worker resolve与capability
  mint，但已有tab可在现有upstream范围内继续。Coordinator重启后从Worker header/outbox/handshake恢复Directory mirror，不从Catalog
  恢复lease，也不重放Runtime mutation；partial capability response视为outcome_unknown并向Worker查询/等待expiry，不重新mint同一nonce。
- Worker crash：保存Store/recovery evidence，Controller失效；Coordinator只在confirmed dead后spawn replacement，Worker从durable
  receipt/effect/Session State恢复。
- Web Gateway crash：Worker/Turn/Controller不受影响；browser cookie、tab handle、upstream Observer binding与connection generation全部
  instance-bound并失效。重启Gateway后Browser重新bootstrap、读取durable projection并建立新的只读订阅；不得因此发送Runtime mutation。
- Client crash：Turn继续，Controller进入detached；Observer不自动接管。
- Catalog损坏：阻止新routing；不清理Worker/Store、不改变Controller，使用verified headers/outbox重建routing metadata后恢复。
- Workspace Store损坏：只隔离对应Worker/Workspace，不影响其他Workspace。

outcome_unknown一律query/recovery，不自动重放prompt、approval、tool effect、Worker spawn或Controller mutation。

## 16. 非目标

- 不实现Worker-to-Worker RPC、Session replication、leader election或distributed consensus。
- 不让两个Worker同时拥有同一Workspace/Store。
- 不让多个Client同时控制一个Session。
- 不让Web Gateway成为Runtime/Store authority。
- 不让Web创建Session、发送prompt、回复approval/interaction、cancel、rewind或申请Controller。
- 不提供remote/LAN/public Web、mDNS、宽松CORS或公网Coordinator。
- 不实现public SDK、generic RPC、dynamic method registry或UI component protocol。
- 不实现跨Store自动Session移动、dual write、silent fallback或在线Store migration。
- 不实现force takeover、自动approval迁移或共享Client输入buffer。

## 17. 分阶段实施

### KCWW-00：ADR、baseline与relocation manifest

KCWW-00 已接受 [ADR-0147](../../adr/0147-kite-coordinator-workspace-worker-read-only-web.md)，冻结 Coordinator/Worker/Web/Store/Controller
authority 与 Web V1 永久只读 Observer 边界。ADR 接受只冻结后续实现边界，不把目标拓扑写成 current behavior；在本计划的 production cutover
Gate 通过前，当前 `apps/kite-service` Service/Host/Store composition 继续是唯一实现事实。

当前 baseline（只读审计事实，非目标实现 evidence）：

- `apps/kite-service/src/composition.ts` 仍以一个 Service composition、一个 Runtime Host 与一个 State 27 / Store 6 writer 承载多个
  Workspace；`apps/kite-service/src/bootstrap.ts` 的 multi-Workspace router 仍在该同一 Host/Store 内运行，没有独立 Worker process。
- `apps/kite-service/src/carrier/` 仍拥有 Native loopback、History/App Control 与 internal/development carrier；当前没有 Coordinator IPC、Worker
  registry 或 Web Gateway listener。`packages/kite-local-runtime/` 仍是 Native client/manager/service-state substrate。
- `apps/kite-cli/src/cli/index.ts` 当前没有 `web` command；`apps/kite-web/`、Browser BFF 与 path-free Directory DTO 尚不存在。
- current SQLite schema 是 State 27 / Store 6 / `kite-runtime-server-v1-2026-08-26`，已有 `runtime_command_receipts` 没有 Workspace binding，
  也没有 `session_workspace_tombstone`；不得在 KCWW-00 或 KCWW-01 中以隐藏 DDL 改写它。

relocation manifest（目标归属；每行在对应 Gate 前保持当前 owner，不表示已迁移）：

| 当前 owner/源码 | 目标 owner | 迁移边界与证明 |
| --- | --- | --- |
| `apps/kite-service` Host、Runtime Application、Session/interaction、Workspace Store 与 effect/recovery | 每个 canonical Workspace 的 Workspace Worker | KCWW-03～05/08；取得 Workspace owner lock、Store header binding、single Host/writer、Controller/Observer 与 recovery evidence 后才能切换；旧 Service 不得与 Worker 双写 |
| Service 的 global routing、Worker/Gateway registry 与 lifecycle 编排 | Local Coordinator control plane | KCWW-01～02/08；只保存可重建 metadata，不转发 Runtime data plane、不持有 Controller/receipt/effect/capability signing key |
| current `RuntimeLogQueryPort`、History adapter 与 safe presentation projector | Worker-owned History/query surface，再由 Gateway映射 browser-safe DTO | KCWW-03/06/08；query-only、current-format safe projection；禁止 Logger/JSONL/trace 或 compatibility import 作为 fallback |
| 当前全局 Store 与 retained command receipt | generation copy-and-switch 后的 Catalog + per-Workspace Store | KCWW-00 冻结策略，KCWW-07 专门 migration ADR；Workspace-bound tombstone/receipt schema、fence、journal 与 rollback 未闭合前迁移 blocked |
| `apps/kite-cli` Native connector、TUI/foreground CLI presentation | Coordinator resolve + Worker direct data plane | KCWW-05/08；TUI/Desktop 保留 Controller 可能性，disconnect 不取消 Turn；CLI 不读取 Store/Host/Coordinator internals |
| 新 `apps/kite-web` static assets、React presentation 与 browser transport adapter | private Web build workspace；Gateway listener/BFF 为独立、已冻结的 Web process owner | KCWW-06；Browser 只读 Observer，Directory DTO path-free；Web 不导入 app source、Host、Store、Native credential 或 raw Runtime event |
| Workspace Trust、MCP/Sandbox/Git 与同 Workspace mutation | Worker-local authority；跨 Workspace shared resource 由 OS-user ResourceLeaseRegistry 协调 | KCWW-04/08；复用 current Trust、Policy、receipt/unknown recovery，不新增 silent fallback 或重复策略层 |

KCWW-00 阻断条件：

1. Web Directory/History 必须保持 query-only；任何为列出或观察 Session 而调用 compatibility import、打开 legacy source writer、写 Catalog/Store
   或创建第二 SQLite authority，均停止 KCWW-02/06，不得以“只读页面”名义放宽。
2. Browser-facing Directory DTO 必须 path-free；只要 HTML/JSON/WebSocket/error/diagnostic/source map/console 返回 Workspace/Store path、
   Worker endpoint、capability、Native token 或可改绑 Workspace 的 raw input，KCWW-06 blocked。

ADR 接受前零 production relocation；KCWW-01 以后每个 owner 迁移必须同时满足本 manifest 对应的 lock/capability/recovery/format Gate。

### KCWW-01：Release、process与IPC primitive

先冻结stable launcher、immutable bundle root、single active pointer、Coordinator/Worker/Gateway exact entrypoint与build identity；实现
POSIX Unix socket、Windows named pipe/process handle、closed IPC frame、single-flight与dead-only stale primitive。running old binary
固定启动时bundle，不能在active pointer切换后重新解析新companion。

### KCWW-02：Read-only Coordinator skeleton与legacy observation adapter

实现单Coordinator、local IPC、Worker registry、最小Catalog/outbox mirror、Gateway registry与server-owned handshake；当前唯一Local
Service只作为read-only legacy observation adapter注册，默认CLI/TUI mutation继续走现有路径。此阶段不签发Controller lease、不改变
legacy multi-client语义，证明Coordinator重启不影响existing Runtime connection。

### KCWW-03：Workspace Worker prototype

在隔离home/process harness实现per-Workspace lock、Worker spawn/readiness、capability、Effect Gate与empty current Store；验证两个
Workspace Worker并行、同Workspace第二writer拒绝、Coordinator routing和Worker fault isolation。production仍用legacy Worker。

### KCWW-04：Global owner拆分与durable Effect Gate

把Workspace Trust/project config/MCP/Sandbox/Git/effect owner迁入Worker；把credential broker、release、global catalog等保留在
Coordinator或明确global owner。每项必须有跨进程CAS/lock/read-only分类；实现Workspace-local durable effect attempt与OS-user
shared-resource lease，覆盖Git common-dir、external root、user-global config、child process与outcome_unknown。

### KCWW-05：Worker-owned Controller lease

在隔离Workspace Worker上实现open/request-control/release、durable Controller generation、resume capability、Observer projection与
detached cancellation；同步TUI/future-Desktop fake与Native conformance，并验证Web Observer不能进入任何Controller use case。
legacy Worker只有在所有mutation入口原子切入同一capability gate、旧direct path不再可绕过时才能启用此模式；默认legacy语义在此前
保持不变。

### KCWW-06：唯一 Web Gateway

实现`kite-code web`singleton、browser auth、per-tab Observer identity、只读BFF query/event DTO、Coordinator目录查询与Worker
History/live projection proxy双层backpressure。页面只交付左侧Workspace分组Session列表、右侧消息列表、running Session实时流与主动
断连；独立`apps/kite-web`使用React 19、TypeScript、Vite、shadcn/ui/Radix、Tailwind CSS v4与唯一presentation reducer构建static
assets。TUI `/web`只发现已有Gateway；验证actual random URL、endpoint non-disclosure以及所有Web mutation route不存在或fail closed。

### KCWW-07：Offline Store sharding migration

前置裁决已完成：[ADR-0148](../../adr/0148-workspace-store-layout-generation-migration.md) 已接受并冻结 State 27 / Store 7 /
`kite-coordinator-workspace-worker-web-v1-2026-08-28` target profile、Workspace binding、deleted-session tombstone/receipt binding、
offline full copy-and-switch、journal、`active-layout`、post-switch write fence、target 首次写入后的禁止自动回退与旧 binary fence。
ADR 对应实现已完成；Store 6只继续服务显式 legacy maintenance，默认 release terminal path 使用 Store 7 Worker。

实现当前global Store到immutable layout generation的copy-and-switch tool、deleted-session tombstone策略、journal、旧binary migration
fence、验证与post-switch write fence。迁移必须在current Service完全stopped时执行；原Storeimmutable保留，target有任何新写入后
禁止自动回退。corrupt/unknown/unowned Session或receipt使cutover blocked。

### KCWW-08：Multi-Worker production cutover与lifecycle closure

CLI/TUI/Web全部经Coordinator resolve Worker并使用Worker capability；移除legacy direct mutation与default global Runtime Worker
authority。验证全局Session routing、同Session Controller、同Workspace/共享资源Effect Gate、不同Workspace并行、版本handshake、
Windows lifecycle与完整restart recovery。不自动中断active Client/Turn；future Desktop只跑contract conformance，不作为V1交付App。

### KCWW-09：文档、fault与qualification

同步所有owner README/本地docs、runtime/release/store/browser active authority、documentation map与completed evidence；运行docs/static/
typecheck、TUI/Desktop/Web、multi-process、Store migration、fault/soak、candidate和真实macOS/Linux/Windows qualification。

## 18. Task矩阵

| Task | dependsOn | 关键Owner | 关键Gate | 停止条件 |
| --- | --- | --- | --- | --- |
| KCWW-00 | current authority | docs/ADR | authority、IPC、migration baseline | ADR未接受或baseline/relocation manifest不完整 |
| KCWW-01 | KCWW-00 | release/process/local-runtime | stable bundle、IPC、Windows | old build/identity drift |
| KCWW-02 | KCWW-01 | coordinator/local-runtime | read-only registry、Catalog reconcile | Coordinator进入data plane/改变legacy mutation |
| KCWW-03 | KCWW-01～02 | Worker/SQLite | scope lock、two-workspace、fault | 同Workspace双writer |
| KCWW-04 | KCWW-03 | config/MCP/credential/effect | global owner、durable resource lease | lost update/重复effect |
| KCWW-05 | KCWW-03～04 | Runtime Application/client | controller/observer/recovery | 双Controller或interaction悬挂 |
| KCWW-06 | KCWW-02～03 | Web Gateway/TUI | singleton/只读BFF/History+live等价/backpressure | Web mutation入口、Worker credential泄漏、透明Runtime proxy |
| KCWW-07 | KCWW-03～05、ADR-0148 | migration/Store | generation/hash/receipt/journal/fence | ADR-0148未接受、implementation未闭合、corrupt/unowned receipt/old writer复活 |
| KCWW-08 | KCWW-05～07 | CLI/TUI/Worker/release | cutover/multi-worker/recovery/Windows | fallback/global双Host/direct mutation旁路 |
| KCWW-09 | all | docs/qualification | full gates | 三平台证据不全 |

## 19. 必测矩阵

### Coordinator/Worker

1. 一个home并发ensure只得到一个Coordinator；
2. 同Workspace并发open只spawn一个Worker；
3. 不同Workspace Worker可并行且Store path不重叠；
4. Coordinator crash/restart不取消Worker active Turn；
5. Worker PID reuse/alive/uncertain不清理、不spawn第二owner；
6. wrong Workspace capability/descriptor/token全部fail closed；
7. 两个explicit Kite home打开同一canonical Workspace，OS-user Workspace lock只允许一个Worker；
8. Coordinator在Worker register/outbox reconcile/capability mint中途crash，不产生第二Worker或虚假Directory authority；
9. legacy observation adapter不能签发mutation lease，旧direct path与新capability path不得同时成为authority。

### Controller/Client

1. TUI先控制时Desktop只读；Desktop先控制时TUI只读；Web在任何情况下都只读且不能申请Controller；
2. Observer mutation进入目标Session mailbox后、receipt lookup前拒绝；
3. Controller disconnect active Turn继续并进入detached；
4. old connection/controller generation恢复后不能写；
5. pending interaction不自动交给Observer；
6. two-client acquire只有一个成功；
7. live与History replay得到相同presentation state；
8. Coordinator crash不改变Worker-owned lease；Worker restart使旧live connection失效但resume capability按exact规则恢复；
9. pending approval/input、response已发未收receipt、原Client永久死亡的detached cancellation只收敛一次。

### Web

1. `kite-code web`并发调用只spawn一个Gateway并返回同URL；
2. `/web`不启动Gateway，absent显示明确命令；
3. 多tab有独立Observer identity，所有tab均不能写或取得lease；
4. launch token/cookie TTL/replay/wrong-instance/wrong-origin安全；
5. Gateway crash不影响Worker/Turn；
6. Browser永远看不到Worker endpoint/capability/Store path/Native token；
7. duplicate/reload/BFCache/multi-window使用独立tab generation，不能产生或改变Controller authority；
8. Worker→Gateway与Gateway→Browser的slow reader、overflow、resync、unsubscribe和drain分别有界；
9. Browser contract只接受Workspace/Session list、message/history、live subscribe/unsubscribe/disconnect；prompt、create、approval/
   interaction、cancel、rewind、Controller、raw Runtime command与rich event全部拒绝；
10. 左侧按Workspace稳定分组Session，右侧History与live使用同一reducer；running Session断线重连无重复/乱序消息；
11. Browser主动断连只释放订阅与tab binding，不cancel Turn、不改变Controller或Session状态。

### Store/Effect

1. Catalog只含metadata，无正文/secret/path；
2. 每Workspace Store只有对应Worker writer；
3. 同Workspace不同Session read/model并发、mutation gate串行；
4. 不同Workspace mutation可并行；
5. offline migration逐Session count/sequence/receipt/snapshot/digest完全相等；
6. deleted Session retained receipt/tombstone具有可验证Workspace binding；unowned receipt使cutover停止；
7. 任一corrupt/unowned Session使cutover停止且原Store未改；
8. pointer切换前可丢弃target，target发生新写后禁止自动回退；
9. migration fence阻止旧manager/binary重新spawn legacy writer；
10. Git common-dir/shared root/user-global config使用OS-user resource lease，crash/outcome_unknown不重复effect；
11. cutover后无legacy fallback/dual write。

### Version/Release

1. 安装新bundle不停止running Worker/Web/TUI；
2. incompatible Client得到typed error，不restart/downgrade；
3. Worker只在idle/无lease/无effect时显式upgrade；
4. Windows运行中old executable不被覆盖；
5. source/installed home与release identity不能互相接管。

## 20. 风险与控制

| 风险 | 控制 |
| --- | --- |
| Coordinator成为新单点/瓶颈 | control-plane only；existing data connection独立继续；catalog无正文 |
| 多Worker重复写Workspace | OS-user跨home Workspace lock + single Worker + durable Effect Gate |
| 多Client重复执行Session | Controller generation + Session mailbox + CAS/receipt |
| Web取得过大authority | Gateway BFF、browser普通Client、Worker capability不出Gateway |
| Store分片丢Session/receipt | generation copy-and-switch、immutable source、tombstone、逐Session验证、blocked-on-unknown |
| global config跨进程lost update | KCWW-05 owner matrix与CAS/lock；无法分类即blocked |
| 版本升级中断工作 | running process pinned build；explicit idle maintenance；无force/background restart |
| 架构一次性重写风险 | legacy Worker adapter分阶段迁移；每Task可验证、无silent fallback |

## 21. 文档与提交Gate

本计划记录已实现的KCWW-01～08边界与仍待远端qualification的KCWW-09；current behavior以源码、tests、workspace docs与
`docs/active/`为准。KCWW-00已接受ADR-0147；production relocation不得绕过该ADR，也不得改写ADR-0129/0142/0144历史。新ADR明确
限制/取代ADR-0144的单全局Service/Store production topology、ADR-0142的Web non-production与ADR-0129的no HTTP/SSE/Web UI局部
结论，同时保留exact Runtime authority、capability separation、no generic RPC/no remote/no dual writer等其余决定。旧 Service
authority只保留显式maintenance，不得成为默认fallback。Store migration implementation必须遵守ADR-0148；每个Task同步
对应workspace README/本地docs；跨包Runtime、Store、Coordinator IPC、browser auth、recovery、release与qualification变化同步
`docs/active/`。ADR-0148 implementation已有本地evidence，但远端平台qualification仍须单独登记。

每次stage/commit/push/PR前显式执行`document-before-commit` Skill，并至少通过：

```text
bun run check:docs-impact
bun run check:docs
bun run check:runtime-packages
bun run check:core-boundary
bun run check:pre-release-architecture
bun run typecheck
```

再按Task运行Coordinator/Worker/Store/TUI/Desktop/Web/browser/multi-process/fault/release与真实三平台验证。本地结果不得冒充远端
平台证据；任一Task未闭合时不得提前删除legacy authority或宣称最终cutover完成。
