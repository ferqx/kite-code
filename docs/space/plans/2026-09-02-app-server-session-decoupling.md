# App Server进程与Durable Session解耦实施方案

状态：active

日期：2026-09-02

优先级：P0

替代：[`Kite Home 与本机 Runtime 单一化实施方案`](2026-08-30-kite-home-and-local-runtime-simplification.md)中“全局单Service拥有
Runtime/Store/Web”的未完成与后续演进部分；已完成的Store 9、typed Artifact、Trust、receipt与clean cutover成果继续复用。

相关：ADR-0166、ADR-0142、ADR-0152、ADR-0165。

## 1. 目标拓扑

```text
default local
TUI/CLI build X --stdio/private--> App Server build X
                                      │
                                      ▼
                              Durable Kite Store

explicit shared
TUI / CLI --unix socket/named pipe--> App Server daemon
Web -------loopback HTTP------------>       │
                                            ▼
                                    Durable Kite Store
```

不论source或installed，默认client与App Server同build；App Server退出不删除Session/History。daemon只由显式命令启动，不参与普通启动发现。

## 2. 不变量

1. 一个Session同一时刻最多一个execution writer；不同Session可以由不同App Server并行执行。
2. 现有durable `controllerGeneration`提升为Session execution fencing generation，不新增第二套writer generation；每个mutation、Controller grant
   和effect receipt绑定适用的Session/connection/effect generation tuple与expected Store revision。
3. read/list不取得writer lease；resume/handoff/acquire-controller才取得写authority。
4. App Server进程、transport connection与Session durability三者互不冒充authority。
5. local parent-child client/server同build；只有显式本机daemon需要protocol capability negotiation，remote不在本计划范围。
6. unknown effect outcome不自动重放；进程crash不能把“未收到响应”推断为“未执行”。
7. 当前不建立Storage daemon、global migration coordinator、后台upgrade watcher或无真实前任的兼容codec。
8. Web是client；default local readiness不依赖HTTP listener、static assets或Web URL。
9. source与installed使用相同schema/protocol但不同物理Runtime Store：installed使用canonical Store，source按canonical repository/worktree隔离，
   dirty source不得默认写installed Store；Provider/config/credential/Trust仍共享canonical用户配置root并通过同一CAS/lock contract写入。

## 3. 分阶段实施

| Tranche | 状态 | 当前产出 |
| --- | --- | --- |
| KASD-00 | completed | accepted ADR、current mutation/owner inventory、target Store/profile/authority contract、release baseline test |
| KASD-01 | pending | Durable Session execution fencing与多进程Store前置 |
| KASD-02 | pending | App Server正式进程边界 |
| KASD-03 | pending | TUI/CLI default local cutover |
| KASD-04 | pending | 显式本机daemon与exact protocol |
| KASD-05 | pending | Web client解耦 |
| KASD-06 | pending | 旧single-Service控制面删除与qualification |

### KASD-00：冻结契约与迁移基线

- 将ADR-0166转为测试able contract：process、connection、Session、Store四类identity不得混用；
- 保留`54a5603e`作为已验证但不发布的过渡实现，后续tranche撤销临时Store删除语义；
- 建立新旧路径inventory，标出single-Service build convergence、Native manager、Web ownership与Store owner的删除时机；
- 冻结新exact Store epoch与clean-cutover规则：新App Server只使用新的`kite-session.sqlite`，现有`kite.sqlite`/WAL/SHM原样保留且不自动
  导入；旧binary只使用旧文件。新文件不存在/为空时事务初始化，existing exact marker/schema/epoch/DDL正常reopen，不匹配/损坏/无法证明时
  返回`store_upgrade_required`；不创建migration或备份框架；
- 盘点当前Workspace owner lock、Store one-writer composition、首次建库初始化、全部Store/config mutation与Artifact GC；
- 不修改production行为。

验收：architecture test能列出唯一current authority与待删除路径；mutation inventory逐项标明Session generation、独立CAS或disabled；没有
双写、fallback、第二套generation或未裁决global mutation。

### KASD-01：Durable Session execution fencing与多进程Store前置

- 建立新exact Store epoch，把现有`controllerGeneration`字段提升为App Server Host持有的Session execution generation；Controller client binding
  从属于Host/generation，保留`connectionGeneration`与effect lease revision的正交职责；不新增第二个writer generation；
- acquire/renew/release全部在SQLite transaction内CAS；Session generation只增不减；lease使用Store可比较的wall-clock deadline，时钟前跳只会
  提前fence旧writer，回拨只会延迟takeover；安全性依赖generation而非时间本身；
- Runtime command、Controller mutation与effect receipt提交校验适用的完整generation tuple；effect prepare记录Session generation，terminal必须
  exact匹配；
- 每次外部effect dispatch前重读Session generation；lease loss取消Provider和可控child tree，禁止新dispatch/terminal commit；已dispatch无receipt
  的attempt转为outcome_unknown并禁止新writer重放；
- cleanup不能确认时把Session持久化为`recovery_required`并保持read-only，禁止acquire/resume新generation；只有cleanup confirmed或用户查看
  未决effect后显式reconciliation才能解除；
- 把所有Session-scoped write ports收口为`sessionMutation(sessionId, generation, expectedRevision, operation)`transaction，覆盖name/model、event/snapshot、
  Run/rewind/fork、checkpoint/preimage、delete、Controller/effect/recovery与Artifact引用；内部port不得绕过fence；
- Workspace/Session创建使用唯一键与transaction；Provider/model/Trust/MCP/project approval等文件mutation逐项增加owner-specific digest/revision、
  lock后重读与typed conflict，未完成项在多App Server路径禁用；不新增global writer lease；
- Artifact GC在本阶段禁用，不实现无当前消费者的pin/maintenance barrier；
- 把空库判定与exact schema初始化放入同一transaction，定义`SQLITE_BUSY`有界重试并验证两个真实进程首次并发open；
- 在允许两个App Server前，删除或下沉当前Workspace process owner lock和one-connection Store composition限制；新边界是同Session generation，
  不是同Workspace process。该改动属于KASD-01前置，不能延期到KASD-06；
- crash takeover必须等待lease失效并运行当前Session recovery，不扫描或迁移无关Session；
- list/read保持lease-free。

验收：同Workspace两个真实进程可并行写不同Session；争用同一Session只有一个writer；stale generation所有mutation/dispatch均拒绝；暂停、
休眠、SIGKILL、response loss与late completion不重放effect；cleanup-confirmed允许takeover，cleanup-unconfirmed保持recovery_required且禁止接管；
global mutation inventory无未裁决写路径；并发首次建库稳定；GC保持关闭。

### KASD-02：App Server正式进程边界

- 从现有Runtime Server/Client与Service composition提取`kite app-server`内部入口；
- default transport为parent-owned stdio或等价private channel，使用initialize + typed request/notification；
- App Server从Durable Store执行thread/session list/read/start/resume与turn start/cancel；
- 每个App Server内Runtime Host继续拥有其Session generation范围内的mailbox、scheduler、interaction、recovery与receipt decision；Store只持久化
  generation与已提交事实，不建立跨进程Host/mailbox；
- parent exit、EOF与signal只关闭本App Server和连接，不删除Session；active writer按KASD-01释放或超时fence；
- 进程crash后的内存model/tool调用不继续执行；新进程只从durable attempt/receipt恢复，可证明未完成的内部步骤终结为interrupted，
  外部效果不确定时保持outcome-unknown且不重放；
- default parent EOF、`/exit`与signal取消active Turn并等待cleanup；daemon client disconnect不自动取消Turn。controller handoff先停止旧Turn并确认
  cleanup，再递增Session generation；client reconnect只轮换connection generation；
- process-local projection只缓存本Server持有generation的Session；list允许eventually consistent，resume/history/checkpoint固定单一SQLite
  read snapshot并返回Store revision；approval和command提交前重读generation/revision。本计划不新增跨进程notification bus；
- source与installed使用同一入口与schema/protocol，只替换executable resolution和物理profile root。

验收：source和candidate均证明client/server build一致；杀死App Server及active model/Shell/MCP child后，新进程可读取并按interrupted/
outcome-unknown规则resume既有Session；late Host completion无法提交；无Web listener或global endpoint。

### KASD-03：TUI/CLI default local cutover

- TUI、CLI `run/resume`默认spawn配套App Server，不调用canonical Service ensure；
- Session picker、resume、fork、history和approval全部通过App protocol；
- 删除source临时Runtime Home/临时History语义和`tui:fresh`；
- 一个TUI退出不删除durable facts；另一个TUI可读取同一Session，接管写入必须显式取得新generation；
- 保留旧single-Service路径为测试隔离期间的单一fallback是禁止的；cutover必须原子，失败直接暴露。

验收：source/installed PTY journey等价；两TUI读同一历史；同Session双写被fence；重启后resume；普通启动无build drift与Web URL。

### KASD-04：显式daemon与版本协商

- 增加`kite server start/status/stop`和显式`--server <endpoint>`；不自动发现daemon；
- daemon使用owner-only Unix socket/Windows named pipe，WebSocket/remote保持未支持；
- 只定义一套exact Kite App protocol：复用ADR-0142 transport envelope/request identity/strict schema/receipt边界，`initialize`是首个请求而非
  outer/nested协议；选择新的exact revision与exact writable Store format，unknown version/capability fail closed，不做range negotiation，
  不协商build ID；
- 不兼容客户端可获得typed诊断但不能触发daemon升级、stop或spawn；
- daemon可服务多个client，但Session writer仍由Store fencing而非connection数量决定。
- `server stop`遇active Turn先执行cancel/cleanup；busy或cleanup-unconfirmed返回typed结果，不静默终止。daemon client disconnect不等于stop。

验收：default local与daemon使用同一协议conformance；旧/新模拟客户端覆盖read-only、write拒绝和unknown capability fail-closed。

### KASD-05：Web client解耦

- Web assets从App Server Runtime readiness中移除；default local不启动HTTP；
- `kite web`只连接已经显式启动的daemon；daemon absent返回typed unavailable，不隐式启动；
- TUI/CLI只走owner-only Unix socket/Windows named pipe；Browser走loopback HTTP。daemon托管同build静态资产与API，asset/API revision必须exact配对；
- Browser principal保持read-only，除非未来单独ADR批准mutation；
- `/status`显示transport、App Server与Session writer状态，不再把Web URL当Runtime identity；
- 删除每local TUI Web listener、Service-owned static-root preflight和相关build convergence依赖。

验收：两个default TUI不产生Web端口；显式daemon只有一个稳定Web地址；Browser读取与TUI mutation共享Durable Store但authority隔离。

### KASD-06：旧single-Service控制面删除与qualification

- 删除默认路径的active-candidateService replacement、previous-build client、source/installed build drift分支和全局Service reservation；KASD-01已
  前置删除Workspace/Store单进程owner限制，本阶段只清理不可达旧控制面；
- 仅保留daemon endpoint所需的最小process owner状态，不让PID/build拥有Session或Store authority；
- 更新ADR-0152/0159/0164/0165替代关系与全部current authority；
- 完成macOS、Ubuntu、Windows真实process/SQLite locking/PTY/candidate smoke。

验收：普通启动代码不存在canonical Service discovery或build replacement；release upgrade只影响下一次配套App Server启动；完整Gate通过。

## 4. Store format策略

当前阶段产生一个新的exact Store epoch和新的物理`kite-session.sqlite`并执行未发布期clean cutover；旧`kite.sqlite`原样保留、不自动导入。
source/installed Runtime Store物理隔离但使用同一schema；canonical用户配置/credential/Trust共享同一CAS contract。
接口只固定以下能力判断：

```text
readable(exactSessionFormat) -> boolean
writable(exactSessionFormat) -> boolean
acquireWriter(sessionId, expectedRevision) -> fenced generation
```

首次真实format升级另立ADR，必须给出真实旧版消费者与fixture。优先Session-local迁移；禁止App Server启动时批量改写全库，禁止未知字段
lossy round-trip，禁止通过重放Shell/MCP/文件效果重建状态。

## 5. 测试矩阵

- protocol：initialize、start/resume/read/list、unknown field/capability、stdio EOF；
- Store：同Workspace双进程不同Session并发、同Session竞争、并发首次建库、lease renewal、暂停/休眠/crash takeover、stale generation、
  revision CAS、cleanup confirmed/unconfirmed、old/new executable物理Store隔离与fail closed、source/installed profile隔离；
- effects：accepted response loss、receipt replay、outcome unknown、lease-loss cancellation、late completion、旧generation dispatch/commit拒绝；
- TUI：source/installed等价、多TUI读、显式handoff、退出后resume、active Turn `/exit`结果、无默认Web端口；
- daemon：显式start/stop、owner-only endpoint、多client、exact protocol/format诊断、busy/unknown stop；Web asset/API exact配对；
- release：build/verify/install/upgrade/rollback/uninstall和三平台真实candidate。

测试不得为了自身存在而保留旧兼容分支；每个矩阵必须指向production caller或当前安全不变量。

## 6. 文档与提交门禁

每个tranche完成前：

- 执行`.agents/skills/overengineering-check/SKILL.md`；
- 更新owner README与命中的`docs/active/`，架构变化新增ADR而不改写accepted历史；
- 运行`bun run check:docs-impact`、`bun run check:docs`、`bun run check:core-boundary`、`bun run typecheck`和相关真实process测试；
- 在新路径通过全部qualification前不得删除旧保护；在cutover完成后不得保留双路径fallback。

## 7. 停止条件

出现以下任一情况必须暂停并重新评审：

- 需要Storage daemon、分布式锁、跨机器writer或后台migration coordinator；
- writer fencing无法覆盖某类mutation/effect receipt；
- default local必须连接未知版本daemon才能工作；
- Web重新成为Runtime readiness或Session ownership前提；
- 为未发布格式增加多代兼容、dual write或普通startup repair；
- source与installed走不同Session/Store/协议语义。

## 8. KASD-00 current mutation inventory

本节冻结`54a5603e`后的当前事实，不表示目标能力已经实现。KASD-01必须逐行关闭`gap`后才允许两个production App Server打开同一
Runtime Store。

### 8.1 Session-scoped Store mutation

| Mutation族 | 当前owner/source | 当前保护 | KASD-01裁决 |
| --- | --- | --- | --- |
| Workspace admission、Session create、initial Controller | `kite-home-workspaces.ts`、`kite-home-runtime-journal.ts`、`kite-home-authority.ts` | SQLite transaction、Workspace/Session unique facts、当前Controller transaction | 纳入新epoch；Session create原子分配首个execution generation；stale Host不得补写initial facts |
| event append、snapshot、Session name/model route | `kite-home-runtime-storage.ts`、`kite-home-runtime-journal.ts`、`kite-home-workspaces.ts` | `BEGIN IMMEDIATE`/revision分散存在；name/model setter没有统一execution token | 全部只能通过`sessionMutation(sessionId, generation, expectedRevision, operation)` |
| Session delete/tombstone | `kite-home-runtime-journal.ts`、`kite-home-workspaces.ts` | transaction删除多表并写receipt，但无统一Host generation参数 | delete transaction校验execution generation；read-only client不得删除 |
| named checkpoint、restore、fork、rewind、file pre/postimage | `kite-home-checkpoints.ts`、`kite-home-runtime-storage.ts` | 各自transaction与event position校验；无统一generation | prepare/commit都绑定同一Session generation与revision；fork target在同一transaction取得initial generation |
| Run insert/transition/rewind/fork | `kite-home-runs.ts`、`kite-home-runtime-storage.ts` | Run revision/receipt与SQLite transaction | 归属Session的Run mutation绑定Session generation；list/get保持read-only snapshot |
| Controller acquire/detach/handoff | `authority.ts`、`workspace-worker/controller.ts`、`controller-adapter.ts` | durable controller/connection generation与worker instance；仍从属于单Workspace process owner | 提升现有`controllerGeneration`字段为Host-ownedSession execution fence；handoff先cleanup再递增；connection generation保持从属 |
| effect prepare/renew/release/terminal receipt | `effect-leases.ts`、`kite-home-transactions.ts`、`effect-gate.ts`、`resource-lease.ts` | effect owner/revision、Controller binding、receipt；dispatch前未统一重读Session generation | prepare记录generation tuple；每次dispatch前重验；late terminal exact拒绝；cleanup不确定进入`recovery_required` |
| recovery identity、attempt/terminal recovery | `kite-home-recovery-identities.ts`、`kite-home-transactions.ts` | per-Session metadata与transaction；Host仍在单进程owner内 | Host继续决定recovery；Store只提交fenced facts；takeover不得跨过unconfirmed effect |
| Artifact write与Session引用 | `kite-home-artifacts.ts`、`kite-home-runtime-storage.ts`、各Artifact backend | content identity/insert exact；Artifact写与引用并非全部同一Session transaction | 引用必须在Session mutation transaction提交；无法归属的writer保持禁用 |
| Artifact GC | `kite-home-artifacts.ts::collect*Garbage` | caller传reachability；无法观察跨进程pending reference | KASD阶段production GC关闭；不预建pin、barrier或maintenance daemon |

### 8.2 Non-Session/global mutation

| Mutation族 | 当前source | 当前并发事实 | KASD-01裁决 |
| --- | --- | --- | --- |
| Provider/model、language、interaction mode、color preset等用户配置 | `apps/kite-service/src/config/index.ts` | 多处`readFileSync`后直接`writeFileSync`，可能lost update | 每个文件定义digest/revision、owner lock、lock后重读与typed conflict；未完成setter在多App Server路径禁用 |
| MCP config | `mcp-config-repository.ts` | 有revision检查与atomic rename，但缺少跨进程lock后的重新CAS | 增加owner-specific lock + reread CAS；不建立全局config daemon |
| Project MCP approval | `mcp-project-approvals.ts` | 读取旧文件后覆盖，无可靠跨进程CAS | 增加独立revision/lock/conflict；未完成前mutation禁用 |
| Workspace Trust | `workspace-trust.ts` | 有文件lock/revision，但旧PID/固定时间stale判断不足以证明长操作owner | 使用可验证owner identity并在lock内重读expected revision；失败返回typed conflict，不静默抢锁 |
| Store首次初始化 | `kite-home-runtime-file.ts`、`kite-home-store.ts` | 空库判断在初始化transaction之外，两个进程可能同时认为需要初始化 | 空库判断、DDL、metadata insert与exact validation进入同一transaction；`SQLITE_BUSY`有界重试 |
| Directory/list/history/checkpoint read | `kite-home-directory.ts`及各read port | 无writer lease；多个query可能跨revision拼接 | list允许eventually consistent；resume/history/checkpoint固定单一SQLite snapshot并返回Store revision |

### 8.3 Process/ownership constraints to remove or narrow

| 当前机制 | Source | 当前必要性 | 删除/收窄时机 |
| --- | --- | --- | --- |
| 每Workspace process owner lock | `workspace-owner-lock.ts`、`workspace-worker/runtime-composition.ts` | 当前阻止两个Host进入同Workspace，是one-process Store前提 | KASD-01在execution fencing真实双进程测试通过时删除/下沉；不能等KASD-06 |
| one connection/one writer Store composition | `createKiteHomeRuntimeStorageComposition`、`kite-home-runtime-file.ts` | 当前single-Service唯一Store connection | KASD-01改为多connection SQLite WAL + short transaction；Session generation拥有长期execution权而非connection |
| canonical single-Service endpoint/reservation | `single-service-manager.ts`、`single-service-native-client.ts` | 当前承载client/server build、Store、Web与process owner | 保留至KASD-03 cutover通过；KASD-06删除default discovery/replacement，只保留显式daemon endpoint最小owner |
| active candidate/previous-build convergence | `single-service-manager.ts`、release composition | 当前避免新client误用旧global Service | default same-build App Server完成后不可达并删除；daemon不允许client触发upgrade |
| Service-owned Web listener/static preflight | Service executable/Web gateway/release entrypoint | 当前每Service ready必带HTTP/Web | KASD-05移到显式daemon；default local不得创建HTTP |
| source invocation临时Store | `createManagedLocalSingleServiceComposition`、TUI disposer | `54a5603e`过渡实现，解决drift但删除History | KASD-03切换到worktree persistent `kite-session.sqlite`并删除临时History语义 |

## 9. KASD-00 Store/profile baseline

当前production仍是：

```text
installed/shared: <canonical Kite Home>/kite.sqlite
source standalone: <temporary Runtime Home>/kite.sqlite
format epoch: kite-home-single-service-v1-2026-08-30
```

KASD目标但尚未实现：

```text
installed: <canonical Kite Home>/kite-session.sqlite
source: <canonical Kite Home>/source-profiles/<profile digest>/kite-session.sqlite
target format epoch: kite-session-app-server-2026-09-02
```

source profile digest固定为前32位hex：

```text
sha256("kite-source-runtime-profile\0" + canonical Kite Home + "\0" + canonical repository/worktree root)
```

repository/worktree root来自source entrypoint所属checkout的validated realpath，不从用户Workspace cwd或ambient环境猜测。`source-profiles/`与digest
目录必须owner-only、non-link且path-safe；它们只隔离Runtime Store。Provider/config/credential/Trust继续使用canonical用户配置root，
并受8.2的跨进程CAS门禁。旧`kite.sqlite`及WAL/SHM原样保留、不自动导入或删除。

新Store打开契约：

1. 文件不存在/为空：在单一transaction初始化exact DDL/metadata/epoch；
2. existing exact marker/schema/epoch/DDL：正常reopen；
3. 不匹配、损坏或无法证明：typed `store_upgrade_required`，不repair、不fallback；
4. old binary只打开旧`kite.sqlite`，new binary只打开`kite-session.sqlite`；不得dual write或根据内容猜测另一路径。

目标Session execution authority继续复用现有Workspace authority metadata owner，不新增平行registry/table。新epoch中的exact record至少包含：

```text
sessionId
status: idle | active | detached | recovery_required
controllerGeneration  // Session execution fence，单调递增
hostInstanceId
clientId | null
connectionGeneration
interactionGeneration
leaseUntilMs | null
cleanupConfirmed
updatedAt
revision
```

`controllerGeneration`由App Server Host持有；client binding不能单独延长lease或提交Session mutation。effect lease仍是attempt-local revision，
不进入第二套Session generation。

## 10. KASD-00 architecture baseline test

`tests/release/app-server-decoupling-baseline.test.ts`冻结以下尚未改变的production事实：

- current Store basename/epoch仍为`kite.sqlite`/single-Service epoch；
- Workspace process owner lock与one-connection composition仍存在；
- source过渡入口仍创建临时Runtime Home；
- production尚未出现`kite-session.sqlite`、`sessionMutation`或default app-server entrypoint；
- ADR-0166/KASD文档已经存在且旧single-Service计划已superseded。

该测试不是永久兼容层。KASD-01～06每关闭一项current约束就同步改写对应断言；cutover完成后删除“旧路径仍存在”断言，只保留最终
architecture invariants。
