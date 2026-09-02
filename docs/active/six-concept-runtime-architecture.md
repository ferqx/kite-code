# Kite Code 六概念 Runtime 架构

状态：active

读取时机：修改 Agent loop、Kernel state/event/reducer、Capability、Policy、Execution、Verification、Host lifecycle、Builtin module、SQLite storage 或 App composition 时。

验证：`bun run check:pre-release-architecture`、`bun run check:runtime-packages`、`bun run check:core-boundary`、`bun run typecheck`、`bun test packages/runtime-contract/test packages/runtime-spi/test packages/agent-kernel/test packages/runtime-host/test packages/builtin-runtime/test packages/runtime-storage-sqlite/test`、`bun run --cwd packages/kite-local-runtime test`、`bun run --cwd apps/kite-service test`、`bun run --cwd apps/kite-cli test`。

相关：ADR-0128、ADR-0137、ADR-0138、ADR-0140、ADR-0142、ADR-0143、ADR-0152、ADR-0153；模块局部边界见各 workspace README。

物理本机installed/shared拓扑当前是每个canonical Kite Home一个Service、一个Store 9 connection与一个HTTP listener；source TUI默认使用
invocation-scoped Service与临时Runtime Home。Workspace仍是逻辑admission/execution scope，不对应独立Worker进程或DB。详见
[`单 Service 本机 Runtime 与 Kite Home 边界`](single-service-local-runtime.md)。

## 总览

Kite Code 的运行时由 Agent、Runtime Kernel、Capability、Policy、Execution、Verification 六个概念组成。概念不是 workspace 的同义词；workspace 用于强制依赖方向，概念用于定位 authority。

```text
Agent → Capability → Policy → Execution → Verification
  ↑                                           ↓
  └──────────── Runtime Kernel 决定下一步 ────┘
```

| 概念 | 当前 owner | 核心职责 |
| --- | --- | --- |
| Agent | App Session/turn coordinator + Builtin Model Gateway | 从已提交 Runtime 投影构造模型输入，消费模型响应并请求下一步；不直接授权或持久化 |
| Runtime Kernel | `@kite-ai/agent-kernel` | 纯 state transition、静态 reducer、scheduler、completion、recovery 与 invariant |
| Capability | Runtime SPI registry + Builtin domain modules | 定义、发现、披露、绑定、解析与选择唯一 executor |
| Policy | Kernel governance + Builtin effect facts | 基于显式事实决定 allow/deny/approval/admission；不执行副作用 |
| Execution | Runtime Host lifecycle + Builtin concrete mechanisms + App composition | ack 后执行一次，形成 receipt/unknown/terminal，并完成 cleanup |
| Verification | Builtin verifier + Kernel verification domain | 从 Receipt/Artifact/注入 port 形成 evidence，由 Kernel 决定通过、修复、重规划、补偿或 waiver |

## Client Contract 与 SPI

`@kite-ai/runtime-contract` 是 client-facing 的 App semantic contract，不是 wire protocol。command、query、可序列化 subscription spec、封闭 client event 与 projection 分别位于独立模块；presentation/capability/observability 只携带中立数据。Contract 不包含 Kernel state、Host lifecycle、Provider handle、SQLite 类型、wire envelope 或 TUI block。

`@kite-ai/runtime-spi` 是 provider-neutral compile-time port。capability、execution、model context 与 module lifecycle 分文件定义；filesystem、sandbox、MCP、Subagent、Verification 与 Tool Pipeline 继续使用独立 domain port。SPI 不拥有具体 Builtin schema、Policy decision、Host session 或 App composition。

## Runtime Server 与 Local Service client contract：十六个workspace、一个当前 concrete composition

Runtime package Gate当前检查十六个workspace（含private Web App）：`agent-api-contract`、`agent-api-client`、`runtime-contract`、`runtime-protocol`、`runtime-server`、
`runtime-client`、`kite-app-contract`、`kite-local-runtime`、`agent-kernel`、`runtime-spi`、`runtime-host`、
`runtime-storage-sqlite`、`builtin-runtime`、`apps/kite-cli`、private `apps/kite-service`与`apps/kite-web`。核心graph不把Web App算作
Runtime composition owner；它们不是可互换Runtime。依赖和authority必须
保持下列层级：

```text
runtime-contract ─────────────────────────────────────────→ ∅
agent-api-contract ───────────────────────────────────────→ ∅（仅external zod）
agent-api-client ─────────────────────────────────────────→ agent-api-contract
runtime-protocol ─────────────────────────────────────────→ runtime-contract
runtime-client ───────────────────────────────────────────→ runtime-contract + runtime-protocol
runtime-server ───────────────────────────────────────────→ runtime-contract + runtime-protocol
kite-app-contract ────────────────────────────────────────→ runtime-contract
kite-local-runtime ───────────────────────────────────────→ app-contract + client + protocol
agent-kernel ─────────────────────────────────────────────→ ∅
runtime-spi ──────────────────────────────────────────────→ runtime-contract
runtime-host ─────────────────────────────────────────────→ agent-kernel + runtime-contract + runtime-spi
runtime-storage-sqlite ───────────────────────────────────→ runtime-host
builtin-runtime ──────────────────────────────────────────→ runtime-contract + runtime-spi
apps/kite-cli ─────────────────────────────────────────────→ app-contract + local-runtime + client + contract
apps/kite-service ─────────────────────────────────────────→ agent-api-contract + app-contract + local-runtime + client + server + host + builtin + sqlite + protocol + contract + spi
apps/kite-web ─────────────────────────────────────────────→ agent-api-client + agent-api-contract
```

`runtime-protocol` 拥有精确、browser-safe、framing-neutral 的 JSON-RPC V1 DTO/codec、allowlist、schema 与 limits；不拥有 Runtime execution、listener、Workspace 或 client-state authority。`runtime-server` 只拥有 connection state、initialize/routing、subscription multiplexing、bounded outbound delivery 与 connection shutdown，并且 core 只接受 abstract duplex logical-message connection。它仅注入 `RuntimeAccess` 和 App-owned admission，不得创建 Host、Kernel、Builtin module、Store、SQLite reader 或 listener。`runtime-client` 拥有 request correlation、reconnect/resubscribe、generation/snapshot state 与 `RuntimeHistoryClient` interface；不依赖 Server concrete type、Host、storage 或 UI。

KASD parent-owned App Server在同一条已initialize Protocol connection上增加三个exact durable History read与九个no-secret App Control方法。
Service stdio carrier在消息进入Runtime Server前处理这些App-owned方法，以单一SQLite read snapshot调用History projector，并用现有
`kite-app-contract`逐方法codec调用App Control；Runtime Server只条件发布capability，不路由它们。Runtime Client复用现有correlation/
connection并验证exact server version/capability，`kite-local-runtime/client`组合semantic App adapter、Native credential codec与
parent-owned child。credential secret不进入App Control、response或diagnostic。该内部入口尚未成为TUI/CLI默认路径，source/candidate
launcher pairing也仍未完成。

`@kite-ai/kite-app-contract` 只导出当前 Workspace Trust、Provider/model、MCP、Skill 与 authoritative status
journey 所需的 no-secret exact DTO/codec 和 closed client methods；它是 browser-safe repo-private contract，不拥有
I/O、credential、process、descriptor 或 UI。`@kite-ai/kite-local-runtime` 只有 `./client` 与 `./service` Native
出口：`./service`已经实现Native filesystem state/lock primitive，`./client`冻结descriptor/lifecycle/raw credential
codec并实现Native connector；package本身仍不实现listener、spawn、Store或Runtime composition。它不得依赖Host、Server、Builtin、SQLite、UI或
任一 App source。

`@kite-ai/agent-api-contract`是zero-workspace-dependency的browser-safe Public wire contract；`@kite-ai/agent-api-client`只依赖该contract并
封装Browser cookie REST read。single-Service复用既有listener注入Agent bearer与Browser cookie认证，以及bounded Workspace/Session/History/
Checkpoint façade，不创建第二Runtime/Store/listener。Agent context拥有query-only private Runtime logical connection；Browser read context直接复用
同一Store 9 Directory/Runtime/History/Checkpoint authority。Web只依赖client与contract，不依赖Service或Runtime package。

`apps/kite-service/src/composition.ts` 是唯一 concrete Runtime composition root：它创建唯一 Host、State 27 / Store 6
SQLite writer、Builtin assembly、Runtime Server、raw History projector/readonly reader、Runtime Application 与 App
Control owner。一个 Service process可承载多个 canonical Workspace与同一 Workspace的多个 Session；context按完整
Project identity隔离，重启从这一个 Store恢复 Session identity，跨 Workspace create/resume/query/subscribe/fork
fail closed。不存在第二 composition root、第二默认 Store writer、dual write、alternate execution backend、
`try-new-catch-old` fallback或legacy Host bridge。

Runtime Application的共享 operation gate先阻止新 mutation admission，再等待active临界区并决定resume或commit drain。
Service-owned interaction broker持有durable generation/revision waiter；connection disconnect只释放client binding，
不取消Turn/approval或关闭Host，只有显式owner shutdown关闭broker。Workspace Trust、Provider/model、MCP、Skill、
execution/release和Native first-run credential由Service的exact App Control/credential owner提供；config、actual Skill、
MCP runtime provider、shell/sandbox、observability与History projector也都按canonical Workspace在Service内组合。

Workspace Worker可在Provider尚未配置时先ready同一个Store 8/Host/Server与neutral App Control；execution dependency context只在
first-run完成、首个Runtime context请求到达时由lazy Workspace template创建。它不是第二Runtime或configuration daemon，配置仍未ready
时execution fail closed。

`apps/kite-cli`只拥有CLI/TUI/presentation、UI-local preferences与Native client composition。CLI/TUI先通过
authenticated App Control完成Workspace Trust query/decision，再建立one-shot ticket Runtime connection；之后只消费
Runtime/History/App Control/credential client。client close只关闭本connection/subscription/snapshot state，不取消
Session或dispose Service Host。CLI不依赖Server、Host、Builtin、SQLite或Runtime SPI，也不导入Service source；Service
同样不导入CLI source。发布组合只把typed manager/connector传给terminal App，没有app-to-app production import、
embedded fallback或第二默认Store。`kite service ensure/status/stop/restart`只是同一typed manager的显式lifecycle
surface，不把control token或process/state authority交给普通Runtime connection。

Native manager把`GET /readyz`只作为liveness precheck，随后用restart-scoped access token执行exact
`POST /_kite/instance`与`{}` body。它严格验证content type、大小、closed keys以及
`{schema, instanceId, protocolVersion, clientContractRevision, serverVersion, buildId}`，并比较descriptor/PID/
Protocol/client contract/server version与Service自身build identity。malformed、server identity drift或无关listener返回
`unavailable/identity_uncertain`。single-Service只读Native `describe`允许兼容客户端发现跨expected build的ready owner；source
`dev:` drift和非active installed candidate可复用该owner，但只有active installed candidate能在验证旧owner identity后通过旧build
client执行stop并收敛到当前candidate。source与installed owner互不复用、互不替换；显式跨build `service stop/restart`仍返回
`incompatible/build_mismatch`。所有不兼容或不确定结果都保留state、`spawn=0`，且绝不从调用者descriptor/build回显或重建健康身份。

## Runtime Kernel

Kernel 是唯一 state/event/reducer/scheduler authority：

- 根 `state.ts` 组合 domain state，根 `events.ts` 组合静态 event map；
- reducer 顺序固定，caller 不能注册 reducer 或注入 domain；
- planning、context 与 verification state/event 已进入 `src/domains/`；
- Kernel 不读 clock、random、filesystem、network 或 Provider；Host 必须把 identity、time 与 observed facts 显式投影为 input；
- schema/protocol/format 数字只作为 metadata 值，不作为类型或文件身份。

State 只有一个当前写入 shape。当前 codec 继续读取同一 schema/epoch 内有明确白名单和测试的退休事件字段；ADR-0138 另外允许 exact 已知历史 profile 在选中单个会话后投影为当前 State。迁移只保留安全历史，清空 approval/grant/effect authority；未知格式在发现阶段静默忽略，不猜测、不改写。恢复 Session 时，State 的 Workspace path 与 Project digest 是不可拆分的 retained identity，不能与调用方当前 checkout 路径混合；Coordinator admission 必须先于 Session registry publication。checksum/revision/project/workspace identity 漂移、event tail 非法或 recovery evidence 不完整仍只让所属会话 fail closed。

## Capability、Policy 与 Tool Pipeline

Builtin domain module 在一个冻结的 `RuntimeModuleRegistry` snapshot 中注册 operation、parser、schema、description、availability、effects、traits、policy compiler、provider 与 executor revision。所有 model surface、Tool Pipeline、Host execution port 与 App controller 使用同一 snapshot；不得在 App/Host 重建第二 catalog。

Tool Pipeline 固定经过：

```text
snapshot → resolve → validate → classify → authorize/admit
         → attempt acknowledgement → dispatch → receipt/unknown commit
```

Kernel 拥有 authorization、approval binding、resource admission 与 ToolOutcome decision。Builtin 拥有 parser、effects 与具体机制。Host 拥有 attempt claim、effect lease、generic lifecycle 与 cleanup。App 只组合这些 owner，并将持久阶段映射到 `runtime/tool-persistence/` 的唯一实现。

Host 的通用 event-batch admission 是 capability/Tool 终态屏障：任何直接 `tool.*` terminal 都会先闭合同一 Tool 下全部
`recorded|running` capability invocation；App 中会间接终结 Tool 的 reviewer/approval producer 也必须在同一 batch 提供
等价 terminal fact。该屏障按 Tool identity 匹配全部 invocation，不依赖可选 receipt 字段，也不能在 invariant 失败后用
取消外层 turn 掩盖半终态。

Filesystem mutation 必须在同一 acknowledged attempt 下提交 intent、mutation-ready、preimage Artifact 与 terminal observation；Subagent suspension 必须提交 parent attempt、private continuation Artifact、blocked Tool identity 与 exact review event。任何 clone、cross-parent、stale revision 或持久失败都在 dispatch/terminal 发布前 fail closed。

## Execution 与 Host lifecycle

Runtime Host 按职责分为 `host/`、`lifecycle/`、`execution/`、`kernel-adapter/`、`format/`、`process/`、`storage/` 与 `observability/`。Host：

- 是唯一的 RuntimeAccess、每 Session FIFO mailbox、revision fencing、lifecycle、recovery 与 command receipt owner；
- 在 Provider work 前完成 attempt acknowledgement；
- 管理 cancellation、cleanup barrier、effect lease 与 restart recovery；
- 对 durable notification 保留 revision history，对 gap 返回 snapshot；ephemeral stream 使用 monotonic sequence；
- 只翻译 Kernel facts，不解释具体工具结果、Prompt、Skill 或 MCP 业务语义；
- 使用冻结 snapshot 创建一个 capability execution port，不提供 registry-taking alternate factory。

Builtin concrete operation modules位于 `git/model/planning/subagent/verification` 领域目录。Skill、Subagent、Verification 只能从各自 subpath 导入。App Tool router 选择一个 executor；Builtin/MCP/Skill/Subagent executor 不得互相回退。

## Session、Context 与 Model

App Session 代码位于 `apps/kite-service/src/runtime/session/`：

- `session-registry` 只管理运行时身份；
- `session-lifecycle` 管理列表、加载、删除与命名；
- `rewind-service` 管理 checkpoint preview/fork/restore；
- `planning-mode-service` 只通过 live Kernel control 改变 planning；
- `context-compaction-service` 复用同一 Host control、Model Gateway、effect lease 与 storage ports；
- `session-projection` 形成 Session/TUI 可消费投影。

Context 只有一条 current projection 与 compaction 管线。Manual/auto 使用相同 safe boundary、token estimate、summary validation、checkpoint 与 terminal semantics；不存在旧 estimator、standalone coordinator 或第二 Store writer。Model streaming inactivity timeout 与 structured retry terminal 语义由既有 Gateway 保持，不因模块拆分改变。

Gateway 的 retryable attempt 仍由有界 retry policy 收敛；fatal Provider rejection 不重试。App turn
coordinator 只把 fatal outcome 投影到已有 failure taxonomy，不能将其降级为 `unknown` 或恢复第二套
retry authority。同一 Gateway、同一 route 的并发调用观察到 Provider rate limit 后，后续 retry 必须共享
route-local 退避时隙；不得让 sibling Subagent 以完全相同的指数节奏同时重试并形成惊群。首次调用继续并发，
共享协调只在真实 `provider_rate_limited` observation 后生效，且实际时隙延迟必须写入各 invocation 自己的
`model.retry.delayMs`。

TUI 与 foreground CLI 都只通过Native `RuntimeClient → RuntimeServer → RuntimeAccess` 的同一 Client path进行 command/query/subscribe；one-shot ticket、initialize、admission、subscription ordering和Server routing均不可绕过。TUI通过`apps/kite-cli/src/adapters/tui/session-adapter.ts`获取typed client surface，二者均不接触Kernel state、Host execution control、Builtin executor或SQLite handle。完整旧Session history不从notification replay、trace、JSONL或Server history补偿，而是走`RuntimeClient.history → RuntimeHistoryClient → Service exhaustive client-event projector → RuntimeLogQueryPort → SQLite readonly reader`，并与live使用同一TUI reducer。
模型展示由closed `requestId/messageId/presentationGroupId`建立因果分组：reasoning/text按request归属，tool queue只在
其opaque group与对应model message精确匹配时进入同一presentation step。该identity不授权执行，TUI不得用事件相邻
关系代替；identity缺失或不匹配只形成独立neutral tool group，绝不把当前Thought当通配owner。

Approval的bounded command、revision、generation与grant集合必须由Runtime Contract、Protocol notification/session projection和
`respond_interaction` command使用同一个closed shape；任一wire codec遗漏字段都必须fail test，不能静默丢弃live interaction。
Session projection另外携带与Session同revision的完整有序interaction queue和唯一active identity；Service从durable
State投影该替换集，Protocol验证queue/entry revision、identity唯一性和active membership，Native Client/TUI收到
event-free snapshot时替换旧Map/queue而不是union。JSON/WebSocket与InProcess logical-message mapper必须生成相同closed
值，不能因共享对象引用产生不同的decode结果。Service启动时的Store-only session index也从纯State投影完整queue，
不得用空占位覆盖pending交互。interaction的`sessionRevision`表示当前settlement CAS；稳定身份由interactionId与
kind-specific generation/plan/provider/verification/input/command字段承担；activeTurn重复字段必须与queue member完整相等。
无关State revision前进时Client先取得新CAS；Host inspect接受command后CAS固定，commit不得用最新State revision替换。
TUI所有approval/input/plan的Enter/Esc都只有在respond command receipt accepted后才结束提交态；提交错误保持原interaction
可见并由用户显式重试，不得吞错、fire-and-forget cancel或在receipt前制造granted/answered事实。Service process重启后
从durable State重建pending effect与continuation，applied response receipt由Host作为原Turn的single-use execution重新调度，
不依赖旧waiter且不重复dispatch。每个durable event携带其exact post-event State queue；缺失历史State时unavailable，
不得伪造空替换集。

每个新建或恢复 Session 先持有自己的 bootstrap readiness promise，后续 turn、compaction、reset、mode、cancel、rewind 与 close 必须等待 exact `create_session` / `resume_session` applied receipt，再读取 committed revision 并提交命令。空 Session 可以在首个 Runtime event 前没有 transcript，但不能让 follow-up command 抢跑到尚未建立的 Host authority，也不能因跨 Session 的本地 sequence 排序把命令归给旧 Session。
Ctrl+C通过Native TUI client提交durable`cancel_turn`；若notification在读取revision与Host admission之间前移
committed revision，Client使用conflict回执中的最新revision和新command ID有界重试。terminal App不持有Service
进程内AbortController、第二mailbox、receipt cache或root-controller authority，Host lifecycle仍只在applied receipt后
执行自己的abort。不可重试的拒绝必须进入client错误/终态投影，不能静默改写为本地取消。TUI exit与Ctrl+C不同：exit
先按exact projection对本client Controller执行idle release或active/pending/unknown detach，再关闭client connection；不隐式调用
`abortAll()`或dispose Service Host。

历史 Session 的 `resume_session` 还是 presentation admission barrier：先在唯一 Coordinator 中提交通用 restart facts，
再完成 Subagent Provider/sandbox process authority cleanup，随后 TUI await readiness、重读 Store head，最后才提交前台
navigation。第一次 compatibility/persisted load 只用于注册 admission，不能在 recovery 改写 revision 后继续作为 replay
输入。非可恢复 running Tool 收敛为 unknown failure，未 dispatch work 安全取消；exact durable interaction、approval queue
与 continuation 保留。TUI crash projection 只停止 spinner、显示 unknown 或本地取消，不产生用户批准、拒绝或取消事实。

`RuntimeSessionCoordinator` 的 Workspace、Project、user、recovery identity 与 Artifact evidence 是 retained
Session 的不可变身份，Host recovery 重复 `ensure` 时必须继续严格校验。`interactionMode` 则是可变的、已持久化
Session 状态：TUI replay、Plan approval 或权限选择把最新模式投影到 `SessionRuntime` 后，`SessionManager` 必须先将
该模式对齐到既有 coordinator，再校验其余不可变身份。该对齐只更新 coordinator 的 retained mode 镜像，不写第二份
Runtime State，也不得掩盖 Workspace、Project、recovery key、sandbox 或 Artifact evidence 漂移。
Project digest 的唯一 canonicalizer 是 Runtime Host `resolveProjectIdentity()`：Coordinator admission 复用该
resolver 验证持久 digest。Builtin `canonicalPathForComparison()` 继续负责 sandbox/Tool 的 Windows
case-insensitive containment 与 equality，但不得再对它的 case-folded spelling 二次哈希；否则 drive letter、8.3
alias 或 native realpath casing 会让同一个 Workspace 在 fresh session 创建时产生两个 Project identity。

Approval rejection 的 durable settlement 同样只由当前 turn 的事实决定：Runner 在 sibling 收敛后的 `stop` 边界
只检查 `createdAtTurnId` 等于 live `turnId` 的 rejected call、未终结 Tool 与 queue record；`activeTaskId` 不能替代
turn identity，否则同一 Task 的旧 rejection 会错误终止 successor turn。

## SQLite storage

`@kite-ai/runtime-storage-sqlite`是Host storage port的唯一concrete adapter。当前production Workspace Worker target精确为
**State 27 / Store 8 / `kite-agent-server-api-v1-2026-08-29`**，固定为11 tables / 3 named non-primary-key indexes；显式legacy
Service maintenance仍使用State 27 / Store 6 / `kite-runtime-server-v1-2026-08-26`的8 tables / 2 indexes，Store 7只作offline generation source：

- `adapter.ts` 单独拥有当前数据库创建、连接与关闭；独立 `RuntimeLogQueryPort` reader 只做 current-format、no-follow、query-only durable-log 读取，不能取得写 Store capability；`compatibility.ts` 只拥有历史 source 的 readonly discovery、atomic target import ledger 与 tombstone；
- SessionStore 的会话列表投影通过 `event-store.ts` 有界分批解码，找到第一条 session-name candidate 即停止；它不代替打开具体会话时的 strict Event/Snapshot 恢复校验；
- 命名恢复点按 durable `event_position` 降序投影；秒级 `created_at` 与 snapshot 名称都不承担同秒内的恢复时序；
- `preflight.ts` 在写连接前验证 current metadata；
- event/session/snapshot/artifact/authority/effect 子模块共享同一 database context；
- `transaction.ts` 是 Runtime event+snapshot 原子提交唯一 owner；一个 applied command 的 State/event/snapshot/revision decision 与 scoped receipt 在同一 transaction 提交；
- App 只取得 Host 提供的嵌套 `sessions/transactions/effects/checkpoints` ports；
- `runtime_command_receipts` 的唯一主键是 `(scope_session_id, command_id)`，并绑定 request digest、target session、original receipt、committed revision/time；同 scope/key 的不同 digest fail closed。close、Session delete、target delete 都保留 receipt，fork 不复制 source receipt；不设 TTL/容量裁剪，只有删除整个 Store 才删除 receipt metadata；
- Store 8在Store 7 Workspace binding上增加canonical Run index、receipt resource result与coverage boundary；normal ensure只初始化fresh
  Store 8，existing Store 7只通过formal offline whole-generation command copy-and-switch；
- Store 5 只可作为 explicit readonly source：State 26 / Store 5 / `kite-runtime-modularization-v1-2026-08-19` 与 State 27 / Store 5 / `kite-runtime-saq-v1-2026-08-25` 都经 no-follow isolated copy、selected-session atomic import 进入显式Store 6 legacy target。source 不写回、checkpoint、rename 或 fallback 执行；未知/损坏 source 只隔离该 Session；
- 默认Coordinator/Worker的Session selector与normal ensure不发现、列出或lazy import Store 5；即使source Workspace identity匹配也保持
  byte-for-byte隔离。Store 5兼容只存在于显式legacy Service path；
- 不存在平面 bridge、alternate current-writer constructor、format selector、sidecar receipt database、dual write、Store 5 current writer、try-new-catch-old、alternate-driver retry 或 execution fallback。

Ack、Receipt、terminal、recovery、sandbox cleanup、MCP/Subagent lifecycle 与 effect lease 仍保持原有事务顺序。拆分不允许复制 transaction、Store、reducer 或 recovery identity owner。

## MCP、Subagent 与 Verification

MCP 默认配置来源只有 project 与 user；explicit 是调用方授权的独立文件。project 必须通过配置摘要审批。没有旧 source、迁移 command 或 ambient-environment auth spelling。Runtime 只获得受限 `McpRuntimeProvider`，不能调用配置 mutation 或 Supervisor control API。

Subagent Provider 使用 private task/handle/continuation Artifact、exact parent attempt、resource admission 与 cleanup receipt。并发 sibling approval 共享 State 27 Session durable queue；每个 child 保留 route、generation、sequence 与 binding facts，只有当前可见 `activeApprovalId` 占据人工焦点，其余记录按 FIFO 保留。清除 Session command grants 时，Kernel 与 TUI 从同一个 canonical event 将被撤销的 `same_command` 调用恢复到原 route，并在重新暴露焦点前把仍可交互的 queue record 重绑到新 generation；batch release 中已匹配并签发 receipt 的 auto-review sibling 不得再被 reviewer-cancellation 列表覆盖。恢复不能重启已挂起 child model；已恢复 child 再次阻塞时必须按 queue sequence 排在既有请求后面，不能由一个长任务连续抢占并造成审批饥饿。

Verification 只消费已提交 Receipt、Artifact 与注入的 Shell/MCP port。Kernel verification state/event map 是唯一 lifecycle authority；App effect 不得自行 waiver、改变 outcome、调用模型复核或制造 evidence。

## 完成与静态门禁

生产命名使用领域职责；旧 alias、双路径、fallback dispatcher、版本 façade 与长期 allowlist 均禁止。当前架构由以下 Gate 共同验证：

- `check:pre-release-architecture`：命名、目录、封闭 compatibility owner、唯一 composition root、Runtime→TUI、current SQLite writer 与 required domain files；Service raw log projector等必需源码不得命中通用`logs` ignore规则，必须显式纳入版本控制；
- `check:runtime-packages`：十六个workspace、依赖图、exports、deep import、cycle 与唯一 concrete composition authority；
- `check:core-boundary`：Kernel/Host/Builtin/App、filesystem、sandbox、Tool Pipeline 与 Model authority；
- `check:docs-impact` / `check:docs`：实现与当前文档共同收敛。

## Workspace 文档与测试 owner

Package/App 的职责、允许依赖、公开入口与局部不变量由各自 README 拥有；本页只定义跨 workspace 的 Runtime
authority 和依赖方向。TUI 展示与系统测试规范位于 `apps/kite-cli/docs/`，测试归属与默认执行位于
`tests/README.md`。ADR、book、plan、completed、design、deprecated 和索引不替代 current authority。
