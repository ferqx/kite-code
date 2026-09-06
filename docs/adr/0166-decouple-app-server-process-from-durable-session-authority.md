# ADR-0166：App Server进程与Durable Session Authority解耦

状态：accepted

日期：2026-09-02

决策者：用户直接指令

相关：ADR-0142、ADR-0152、ADR-0159、ADR-0164、ADR-0165、
`docs/space/plans/2026-09-02-app-server-session-decoupling.md`。

## 背景

当前Kite把Native endpoint、Runtime Host、Session/Controller、Store、Web listener与candidate build共同绑定到一个长期Local Service。
这使“客户端是否共享Server”同时决定进程版本、Session持久性、SQLite owner、Web地址和多客户端行为，并产生active-candidate接管、
previous-build stop、PID/reservation验证、busy换代与source `tui:fresh`等控制面复杂度。

ADR-0165通过为每个source TUI创建临时Service与临时Store消除了默认build drift，但也让开发态失去持久Session、多客户端共享行为和稳定
Web语义，与installed拓扑不一致。问题根因不是Server必须共享或独享，而是持久Session authority错误地从属于Server进程生命周期。

Codex的公开命令面与app-server schema表明它支持stdio/daemon等可替换连接进程以及Thread/Turn的start、resume、read、list、fork操作。
这只作为接口与生命周期方向的启发，不证明Codex内部持久化或authority实现。Kite不把未公开实现当作事实，也不复制其领域模型。

## 决策

### 1. 三层authority

Kite分为三个独立生命周期：

```text
TUI / CLI / Web clients
          │ typed App protocol
          ▼
replaceable Kite App Server process
          │ transactional Session/Store ports
          ▼
durable Kite Home Session / History / Checkpoint / Artifact facts
```

- Client只拥有输入、展示、审批交互与连接状态；
- 每个App Server内的Runtime Host继续是其已取得Session generation范围内的mailbox、scheduler、interaction、recovery与receipt decision owner；
- Durable Store拥有Session identity、event/history、checkpoint、artifact、当前Session generation与已提交effect receipt，但不替代Host执行决策。

App Server退出释放执行authority，但不删除Session、History或Store。

### 2. 默认local是同build配套进程

普通source与installed TUI都启动同一distribution/source build附带的App Server，并通过stdio或等价private parent-child transport连接：

```text
Client build X -> App Server build X
```

默认local不发现、不连接、不升级canonical全局daemon，因此普通启动没有跨build client/server兼容或previous-build process replacement。
source与installed只在可执行物和Runtime profile来源上不同，使用相同协议、Session格式、Store schema与退出语义。installed使用canonical
Runtime Store；source默认使用按canonical repository/worktree隔离的持久开发Store，不能直接写installed物理Store。用户级Provider/config、
credential与Workspace Trust仍共享canonical配置root，但所有mutation必须完成跨进程CAS/lock门禁；source不得创建私有语义分叉。
显式连接installed daemon仍受相同protocol/format/write admission约束。

### 3. Session持久且单写

同一profile内多个App Server可列出和读取同一个Durable Store，也可并行执行不同Session。同一个Session同一时刻只有一个execution writer：

- 现有durable `controllerGeneration`字段提升为Session execution fencing generation，不新增第二套writer generation；generation由取得
  Session的App Server Host instance持有，Controller client binding从属于该Host/generation；`connectionGeneration`继续只绑定client connection，
  effect lease revision继续只绑定一次effect attempt；
- Host取得Store内单调递增的Session generation与有界lease；每个mutation transaction、Controller grant和effect receipt都校验
  `(sessionGeneration, connectionGeneration, effectLeaseRevision)`中适用的完整binding；
- lease续期失败、generation漂移或Store revision漂移立即停止新mutation；
- crash后新Server只在lease过期并完成既有recovery检查后取得更高generation；
- read/list不取得writer lease；resume/handoff/acquire-controller才取得写authority。

每次Provider/Shell/MCP/文件/Git effect dispatch前必须在Store重新验证当前Session generation；lease丢失立即取消Provider和可控child tree，
禁止新dispatch与terminal commit。时间租约和进程死亡都不能单独证明外部效果未发生；已dispatch但未形成receipt的attempt在takeover时持久化为
`outcome_unknown`，late completion因generation漂移拒绝提交，新writer禁止自动重放。

若旧Provider/child/effect cleanup不能确认，Session进入durable `recovery_required`并保持read-only，禁止acquire/resume新generation。只有
cleanup confirmed，或用户在看见未决effect清单后执行显式reconciliation，才能解除阻断。generation fencing不能把`cleanupConfirmed=false`
伪装成可安全接管。

default parent-child App Server在parent EOF、`/exit`或signal时取消active Turn并等待上述cleanup；无法确认时落为`recovery_required`。
显式daemon中的client disconnect不自动取消active Turn，Host generation继续执行；controller handoff必须先停止旧Turn并完成cleanup，随后才递增
generation。client reconnect只轮换connection generation，不自动取得或废止Session execution generation。

Store中的非Session事实不因此取得第二个全局writer：Workspace/Session创建使用唯一键与transaction；Run/Artifact引用必须与所属Session
transaction绑定。当前配置、MCP approval与部分Trust路径并非都具备可靠跨进程CAS，必须在多App Server cutover前逐项增加owner-specific
digest/revision、lock后重读与conflict结果，未完成的mutation保持禁用。Artifact GC在本阶段直接禁用，不预建pin/maintenance framework；
首次真实GC需求另行设计。任何无法归属Session generation且没有独立CAS/transaction authority的global mutation不得开放。

### 4. Store compatibility取代默认Server compatibility

兼容问题收敛为“App Server能否读取或写入某个Session format”，而不是“新客户端能否接管整个旧Service”。

- writer fencing产生新的exact Store schema/format epoch，并使用新的物理`kite-session.sqlite`；现有`kite.sqlite`及WAL/SHM原样保留、不覆盖、
  不自动导入。当前未发布阶段采用clean cutover，不创建无前任消费者的migration framework；旧binary只能看到旧文件，新binary只打开新文件。
  新文件不存在或为空时在单一transaction内初始化exact Store；existing marker/schema/epoch/DDL完全匹配时正常reopen；不匹配、损坏或无法证明时
  才返回typed `store_upgrade_required`。一旦新epoch写入，runtime rollback到旧binary不受支持；恢复旧代码只会回到原样保留的旧Store，
  不会看到新Session；
- Store envelope、Session/event payload与effect receipt分别版本化，未知newer critical format fail closed；
- 当前epoch使用exact protocol和exact writable format，不实现range negotiation。读取能力与写入能力概念分开保留；无法完整保留未知字段的
  Server不得重写该Session；
- 未来首次真实format bump必须新增ADR，并优先采用Session-local、CAS提交的迁移，不在App Server普通startup批量迁移全库；
- 不新增Storage daemon。多个本地App Server直接通过SQLite transaction、revision CAS和writer fencing访问Durable Store。

### 5. 本机daemon与Web均为显式部署

默认local App Server不要求HTTP listener或Web assets。需要多客户端共享一个active execution host、Web或远程连接时，用户显式启动daemon：

```text
kite server start
TUI / CLI / Web -> explicit daemon endpoint
```

KASD定义一套exact Kite App protocol，并复用ADR-0142现有transport-neutral envelope、request identity、strict schema与receipt边界；
`initialize`是该单一协议的首个请求，不存在outer/nested第二协议。ADR-0166只扩展方法面并选择新的exact revision，继续拒绝unknown
version/capability且不实现range。TUI/CLI通过Unix socket或Windows named pipe连接；daemon以loopback HTTP提供
API和同build静态Web资产。`kite web`要求daemon已显式启动，否则返回typed unavailable，不隐式创建daemon。Web是App client，不再是每个
default local Runtime进程的必备启动输入，Static Web资产与Session authority也不证明Server进程ownership。

### 6. 保留与删除的严格性

保留：Workspace Trust、Session单writer、controller generation、transaction revision、effect receipt、unknown outcome no-replay、
Checkpoint/Artifact完整性与格式fail-closed。

从默认local路径删除：global single-Service build ownership、active-candidate运行时接管、source previous-build stop、跨build PID/reservation换代、
每TUI临时Store、每TUI Web listener及以Web URL证明Runtime身份。

## 非目标

- 当前阶段不实现remote/WebSocket/LAN公网服务、分布式Store、跨机器writer lease或多人协作；remote必须由真实消费者与新ADR批准；
- 不建立Storage Service、全局migration coordinator、后台upgrade watcher或多代codec框架；
- 不保证旧未发布Store格式兼容，不从历史设计/fixture推导production predecessor；
- 不允许两个App Server同时mutation同一Session；多客户端共享不等于多writer。

## 局部替代关系

- 替代ADR-0165“source TUI默认临时Store且退出删除History”的结论；同build parent-child process隔离保留，但Session转为durable。
- 局部替代ADR-0152“每个Kite Home只能有一个Service进程/Runtime Host”的结论；每个Session仍只有一个writer，Store仍是一个durable authority。
- 局部替代ADR-0159/0164中默认启动必须处理跨buildService发现与换代的结论；这些规则只在迁移期或显式daemon管理中保留，完成cutover后删除。
- 局部替代ADR-0155～0158中“每个默认Service拥有Web listener/root”的结论；Browser `/v1`、read-only principal、root cookie和asset/API
  exact pairing只保留给显式daemon Web endpoint。
- ADR-0142的transport-neutral envelope、receipt和严格边界保留，并由ADR-0166选择单一exact Kite App protocol revision与扩展方法面；
  不增加nested protocol。

## 后果

- source与installed日常路径同构，client/server天然同build，开发态覆盖真实Session/Store语义；
- 同一profile内两个TUI可各有配套App Server，同时读取同一历史，但同一Session写入由提升后的Controller/Session generation裁决；
- TUI退出不删除Session，下一次启动通过resume恢复；active Turn能否恢复由durable facts决定，不能从进程仍存活推断；
- 进程crash不会继续内存中的半个model/tool调用；新Server按durable attempt、receipt与outcome事实恢复，无法证明的attempt终结为typed
  interrupted/outcome-unknown，不能重新执行外部效果；
- process-local projection只可缓存自己持有generation的Session；跨进程list可以eventually consistent，resume/history/checkpoint必须在一个
  SQLite read snapshot中返回并携带Store revision。command admission和approval action提交前重读当前generation/revision；当前计划不新增
  跨进程live notification bus；
- default `/exit`在active Turn cleanup完成后返回；cleanup不确定时明确显示`recovery_required/outcome_unknown`。daemon client disconnect继续
  后台Turn，`server stop`则遵守busy/cleanup-confirmed规则，不能静默终止或伪报成功；
- 普通TUI不再产生Web地址；只有显式daemon/Web入口展示稳定endpoint；
- 版本治理重点从进程替换迁移到Store envelope、Session format与writer fencing；
- 实施必须先建立durable Session contract和fencing，再切换默认进程拓扑，不能先删除现有single-Service保护。

## 回滚

在新Store epoch首次写入前可以回滚到当前single-Service owner。首次写入后不支持把新Session回滚给旧binary；停止所有新App Server并恢复旧
代码只会重新打开原样保留的`kite.sqlite`，新`kite-session.sqlite`保持不可见且不得删除。任何回滚都不得让旧binary忽略new epoch、双写
新Store，或通过删除Session/receipt事实伪造兼容。
