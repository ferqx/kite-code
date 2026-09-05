# ADR-0150：Store 8 建立 canonical Runtime Run index 与 receipt resource result

状态：accepted

日期：2026-08-29

决策者：用户直接指令

相关：ADR-0139、ADR-0142、ADR-0147、ADR-0148、ADR-0149，
[`Kite Agent Server API V1 当前证据矩阵`](../space/understanding/2026-08-29-kite-agent-server-api-v1-evidence.md)、
[`Public contract freeze`](../space/understanding/2026-08-29-kite-agent-server-api-v1-contract-freeze.md)、
[`Runtime Run Store V1 子计划`](../space/plans/2026-08-29-kite-runtime-run-store-v1.md)。

## 背景

ADR-0149 接受 stable local Agent API，并要求 Run create/list/get/cancel/wait 使用同一 canonical identity、receipt 与 recovery
authority。KASAPI-00B 的源码和测试审计确认 current `turnId` 是 fresh/restart/terminal 一致的 Run identity，但 Store 7 只有
Session State、event journal 与 scoped applied command receipt：没有 Run row/index、phase、完整 lifecycle time、receipt resource
result，也无法用 bounded query 正确处理 Session delete、fork、rewind与late retry。

从 Store 7 event journal 扫描、聚合并回填 Run 同样不可接受：历史 event 不总是携带 phase、command identity、terminal outcome 或
`turnId`，queued 没有 durable fact，`run.error.turnId` 仍可缺失。由 HTTP adapter、Coordinator Catalog、Session Logger 或 sidecar
database补足会形成第二事实源。

因此 first-class Run 需要一个新的 exact Store profile。该变化必须继承 ADR-0148 的 Workspace binding、layout generation、offline
copy-and-switch、old-writer fence 与不可自动回退规则，不能以 startup DDL 或 Store 7 optional table形式落地。

## 决策

### 1. 新的 exact writer profile

Run authority 的唯一 target profile 固定为：

```text
stateSchemaVersion = 27
storeSchemaVersion = 8
formatEpoch        = kite-agent-server-api-v1-2026-08-29
```

State 27 Kernel event/snapshot语义不因本ADR变化。Store 8 是 Store 7 的单向target；Store 7只可作为本迁移的source，不能与Store 8
dual write、read fallback或receipt fallback。尚未完成ADR-0148 Store 6→Store 7 cutover的installation必须先完成该迁移，不能直接
Store 6→Store 8，也不能把两个migration合并后省略中间验证。

Store 8继续逐次验证`layout_generation`、`worker_scope_id`、`workspace_identity_digest`、Session/receipt/tombstone Workspace binding与
post-switch fence。Coordinator、Gateway、Browser、SDK与History reader均不直接打开Store。

### 2. `runtime_runs` 是唯一 Run query authority

Store 8新增`runtime_runs`，逻辑字段固定为：

```text
session_id
run_id
origin_session_id?
origin_run_id?
start_command_id
phase                  planning | building
status                 queued | running | waiting | completed | failed | cancelled | unknown
created_revision
last_revision
created_at_ms
started_at_ms?
finished_at_ms?
terminal_json?
```

约束与索引固定为：

- primary key为`(session_id, run_id)`；Public identity是该tuple，不能假设`run_id`跨fork后全局唯一；
- unique key为`(session_id, start_command_id)`；同一start command不能产生第二Run；
- page index为`(session_id, created_revision, run_id)`；get/list不得扫描或解析完整event journal；
- `last_revision >= created_revision`，所有revision来自同一Session canonical State transaction；
- `terminal_json`使用Store-private closed codec，只能保存safe terminal reason、retry/recovery entry与必要outcome identity，不保存
  Provider正文、Workspace path、credential、raw diagnostic或HTTP DTO；
- nonterminal status不得有`finished_at_ms`，terminal transition必须在同一transaction设置`last_revision`与terminal time；
- Store adapter不得根据process、listener、SSE或HTTP连接状态改写Run row。

`turnId`进入`run_id`。Public adapter只把它作为opaque值返回，不公开private deterministic derivation算法。Run Store port属于
`runtime-host/storage`抽象；SQLite concrete只实现该port，不把SQLite type泄漏给Host或Service adapter。

### 3. Run lifecycle 与 timestamp authority

start command 的applied transaction必须原子完成：

1. 生成/验证canonical `turnId`；
2. 提交State/event/snapshot/revision；
3. 插入`runtime_runs` queued row，保存phase、created revision与commit clock；
4. 写入带resource result的applied command receipt。

只有上述四项共同成功才存在Run。commit之后、activation之前的真实状态是`queued`；activation transaction进入`running`并写
`started_at_ms`。Interaction durable request把同一Run改为`waiting`，settlement/recovery再改为`running`；completed、failed、cancelled或
无法安全证明outcome的recovery进入对应terminal/unknown状态。每次状态变化与触发它的canonical event/revision在同一Store transaction。

`created_at`、`started_at`、`finished_at`只从上述Store commit clock产生，持久为UTC epoch milliseconds，对外严格序列化为带三位毫秒的
RFC 3339 UTC字符串。HTTP response time、event receive time、SQLite默认秒级`CURRENT_TIMESTAMP`与Logger timestamp都不是Run时间源。

`unknown`表示canonical recovery已无法证明outcome；它结束普通wait，但允许后续显式recovery/reconciliation transaction把它推进为更
精确terminal。该推进必须保留原`finished_at_ms`或记录新terminal commit time的确定规则，并由Host recovery tests覆盖，adapter不能自行
“修复”。

### 4. Receipt 保存 original resource result

Store 8扩展`runtime_command_receipts`，增加exact、digest-bound的：

```text
result_schema?
result_json?
result_digest?
```

Host storage contract同步增加可选closed resource result。Create Run必须保存original create response所需的Run projection；Create
Session与Fork在Public API启用后同样保存original Session result。其他mutation只有在Public contract要求resource replay时才保存结果。

resource result与request digest、State/event/snapshot、Run row及applied receipt同transaction提交。replay只返回原result，不能query当前
row后伪装为original response；same scoped command ID + different request digest继续固定为idempotency conflict。pre-application
rejection仍不持久化，不新增rejected receipt表。

Session delete或rewind可以移除current Run row，但必须保留既有receipt及其original result，使lost-response/late retry仍返回original
applied response。随后对该Run执行GET可以是404；两者分别表达历史command outcome与current resource existence，不构成双重authority。
Store 8不增加receipt TTL/capacity pruning；未来pruning必须有新retention ADR。

### 5. Coverage boundary，不伪造Store 7历史Run

Store 7历史不能可靠回填first-class Run。Store 8在每个Session row增加`run_index_from_revision`，迁移时把它设置为source Session当前
revision；新Session设置为0。其语义为：

- `created_revision > run_index_from_revision`的每个start command必须有且仅有一个Run row；
- boundary以前的历史继续由safe History提供，但不出现在Public Run list/get；
- Agent API在Store 8 cutover前不开放，因此不存在需要兼容的旧Public Run ID；
- migration不得从不完整event推断phase、queued、terminal或timestamp来制造row；
- contract/ServerInfo可以声明`runs`能力的前提是当前Workspace已经Store 8 ready，不能在Store 7上降级为partial Run API。

迁移maintenance barrier要求所有source Session没有active Turn、pending Interaction、unknown effect或未收敛external process。因此
coverage boundary不会切断一个active Run。无法达到该条件时迁移blocked，不force terminal、不丢弃Session。

### 6. Delete、rewind、fork 与 recovery

规则固定为：

- Session delete在同一transaction写现有Session Workspace tombstone、保留receipts、删除Run rows及其他Session facts；不建立第二
  Run tombstone表，late mutation replay由receipt result拥有；
- rewind只接受between-turn safe checkpoint。`created_revision`晚于target revision的Run row随对应events删除；已在checkpoint前完整
  terminal的Run保留。任何会截断半个Run的checkpoint fail closed；receipts仍按current规则保留；
- fork复制checkpoint以前完整terminal Run row到target Session，保留`run_id`、phase、status与timestamp，重绑`session_id`，并写
  `origin_session_id/origin_run_id`。source command receipts不复制，target的Run identity仍是`(target_session_id, run_id)`；
- fork不得复制active/waiting/unknown未收敛Run；source checkpoint不满足完整Run边界时拒绝；
- Worker restart前，query不触发Host recovery。未admitted/recovered Session的nonterminal Run只可投影为`unknown`/recovery-required；
  `resume`进入existing Host recovery并在canonical transaction更新Run row。GET handler不得为了让状态好看而调用recovery；
- recovery、cancel、interaction settlement与terminal commit必须同时更新Run row和现有State/event/snapshot，不允许event已终结而Run仍
  running的committed状态。

### 7. Store 7 → Store 8 offline copy-and-switch

迁移复用ADR-0148的完整layout generation机制，并固定为全generation转换：

1. 建立全局maintenance barrier，拒绝新Client/Controller/Runtime mutation/Agent API admission，并证明所有Workspace Worker、Turn、
   Interaction、effect与external process已收敛；
2. 停止Coordinator/Worker/Gateway writer链，验证source active layout、Catalog、每个Store 7、owner/lock/fence与WAL/SHM；
3. 写source-bound migration journal和old-binary fence，绑定source generation digest、target generation、nonce与write state；
4. no-follow只读复制Catalog与每个Workspace Store到新的owner-only target generation；创建Store 8 schema、Run index/receipt result字段，
   对每个Session写coverage boundary，不生成历史Run row；
5. 验证全部event/snapshot/receipt/tombstone/Controller/effect事实的count、digest、binding与Store 8 preflight；
6. 以原子`active-layout` pointer切换到完整target；第一笔target写入前后维护exact `targetWriteState`；
7. 全部Store 8 ready、Catalog reconcile和Worker replacement通过后解除admission barrier。

任一Workspace损坏、unowned、active work未收敛、coverage不一致或receipt/result digest错误都会阻断整个generation，不发布partial Store 8
Workspace。Store 8 target第一次新写之后禁止自动回到Store 7。旧binary必须在Store open前识别fence并fail closed。

### 8. 实施顺序与current authority

实现由[`Runtime Run Store V1 子计划`](../space/plans/2026-08-29-kite-runtime-run-store-v1.md)拥有，并作为KASAPI-03A的前置tranche。
KASAPI-01 contract和KASAPI-02 read-only façade可以先实施；任何Run route、mutation admission或`runs`capability都必须等Store 8迁移、
reopen/fault/cutover Gate完成。

本ADR接受target contract，不表示Store 8已经实现。当前行为在cutover前仍由Store 7源码、owner README与`docs/active/`拥有；实现时必须
同步`runtime-host`、`runtime-storage-sqlite`、Service owner docs、Runtime authority/resilience、Coordinator/Worker active authority、
documentation map、release/migration runbook与三平台qualification。

## 备选方案

### Store 7原地加optional Run table

拒绝。optional DDL会让同一Store profile拥有两种writer语义，并允许旧binary在不知道Run authority时继续写入。

### 从event journal回填所有历史Run

拒绝。phase、queued、部分turn identity、terminal和timestamp证据不完整；推断出的row不能成为Public contract authority。

### Agent API独立Run database或内存Map

拒绝。它无法与State/event/receipt/recovery原子提交，并在response loss、restart、rewind或delete时分裂。

### 只把runId塞进HTTP response

拒绝。它不能提供bounded list/get、original resource replay、fork/rewind和restart semantics。

## 后果

- First-class Run获得与Runtime transaction一致的query、lifecycle、timestamp和late retry事实；
- 新增Store profile、表、receipt schema、migration journal/fault matrix与三平台cutover成本；
- Store 7历史Run不伪造回填，Public Run完整性从显式coverage boundary开始；
- fork后的Run identity按Session tuple解释，避免复制历史时重新发明identity；
- Agent API Run mutation被明确阻断到Store 8 Gate完成，但read-only contract/façade可以继续推进。

## 回滚

pointer切换前且target无写时，可以删除未完成target并保留Store 7 source。pointer切换后但所有target明确未写时，只能依据journal、fence、
manifest与完整digest原子回退。任一Store 8产生新写、write state unknown、source/target ownership不明或receipt/result/Run invariant失败后，
禁止自动回退；保持所有writer与Agent API admission blocked，等待新的显式recovery decision。不得恢复Store 7 writer作为silent fallback，
不得删除canonical receipt、Run row或migration evidence来“修复”启动。
