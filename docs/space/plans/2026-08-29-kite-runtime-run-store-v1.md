# Kite Runtime Run Store V1 子计划

状态：active

日期：2026-08-29

优先级：P1

父计划：[`Kite Agent Server API V1`](2026-08-29-kite-agent-server-api-v1.md) KASAPI-03A

架构依据：[`ADR-0150`](../../adr/0150-store-8-canonical-runtime-run-index.md)、ADR-0148、ADR-0149，
[`current evidence matrix`](../understanding/2026-08-29-kite-agent-server-api-v1-evidence.md)、
[`Public contract freeze`](../understanding/2026-08-29-kite-agent-server-api-v1-contract-freeze.md)。

## 1. 执行状态与边界

KRSRUN-00A随KASAPI-00C完成：Store 8 profile、Run row/index、receipt resource result、coverage boundary、delete/rewind/fork/recovery与
offline generation migration已经冻结。父计划KASAPI-02D read-only conformance Gate已关闭；当前执行入口为KRSRUN-01A neutral Run storage
contract与Store 8 schema。KRSRUN-01A～03B完成前仍不得开放Run route或声明ServerInfo `runs`capability，也不得在Store 7做partial实现。

本子计划不是第二产品roadmap。KASAPI-03A只有在本计划全部Task完成后才能关闭；KASAPI-03B～03D再接Public idempotency/Controller mapper、
Run routes与crash qualification。

## 2. 目标与完成标准

目标：

1. 把canonical `turnId`作为`(session_id, run_id)`持久资源，与start/activation/interaction/terminal/recovery transaction一致；
2. 为Run get/list提供bounded index，不扫描event journal；
3. 让applied receipt原子保存original resource result并跨response loss/restart/delete/rewind重放；
4. 实现Store 7→Store 8完整layout generation offline copy-and-switch，不伪造历史Run；
5. 证明delete、between-turn rewind、fork、restart/recovery、old writer fence与target-first-write rollback语义；
6. 完成owner docs、active authority、migration runbook、release/candidate与三平台evidence。

完成标准：

- exact profile为State 27 / Store 8 / `kite-agent-server-api-v1-2026-08-29`；Store 7不能write/fallback；
- start applied State/event/snapshot/revision + queued Run row + resource receipt同transaction；
- `(session_id, run_id)` get与`(session_id, created_revision, run_id)` page使用index且bounded；
- lifecycle/timestamp全部由Store commit产生，restart不由GET触发recovery；
- migration对每个Session记录`run_index_from_revision`，source active work不收敛则整体blocked；
- target产生新写后不自动回Store 7；旧binary在open前被fence阻断；
- Host/SQLite/Service owner tests、fault/crash/migration/reopen/candidate与docs gates全部通过。

## 3. 不变量与非目标

不变量：

- Host仍是mailbox/command/recovery/receipt owner；SQLite只实现neutral storage port；
- State 27与Kernel event codec不为Public HTTP shape改版；
- Public adapter不直接拿storage port，Run use case仍经private Runtime Client/Server；
- Store 8不建立rejected receipt、Run sidecar、TTL pruning、event-scan fallback或compat DDL；
- History继续拥有coverage boundary以前的safe transcript；Run index不反向改写History；
- Coordinator Catalog不保存Run status、phase、outcome、receipt或timestamp；
- migration是全layout generation、offline、copy-and-switch，不lazy per-Workspace升级。

非目标：backfill Store 7历史Run、online migration、Store 6直升Store 8、跨Session全局Run query、remote data plane、Public endpoint/SDK实现。

## 4. Target schema与transaction checklist

实施前DDL/preflight fixture必须逐项编码ADR-0150，而不是从本计划摘要猜测：

```text
runtime_store_meta.format_version = 8
runtime_store_meta.runtime_format_epoch = kite-agent-server-api-v1-2026-08-29

runtime_sessions.run_index_from_revision NOT NULL

runtime_runs(
  session_id, run_id, origin_session_id?, origin_run_id?, start_command_id,
  phase, status, created_revision, last_revision,
  created_at_ms, started_at_ms?, finished_at_ms?, terminal_json?
)

runtime_command_receipts.result_schema?
runtime_command_receipts.result_json?
runtime_command_receipts.result_digest?
```

必须有PK/unique/page index、strict CHECK/closed decode、foreign/session binding与transaction invariant tests。具体SQLite column storage types由
KRSRUN-01A实现review确定，但不能改变逻辑字段、precision、identity或nullable语义；任何物理调整都要同步ADR实现说明，不能静默省字段。

## 5. 实施Tasks

### KRSRUN-00A：Store 8 ADR、evidence与subplan freeze（已完成）

交付：ADR-0150、Public contract freeze、integration manifest与本子计划；明确Store 7 evidence不足、coverage boundary与父计划blocking。

Gate：docs/plan matrix通过；零production source/Store变化；current Store 7 authority不改写。

Rollback：删除未接受文档并保持KASAPI-03 blocked。

### KRSRUN-01A：Neutral Run storage contract与Store 8 schema

目标文件：

```text
packages/runtime-host/src/storage/**
packages/runtime-storage-sqlite/src/schema.ts
packages/runtime-storage-sqlite/src/compatibility.ts
packages/runtime-storage-sqlite/src/connection.ts
packages/runtime-storage-sqlite/src/run-store.ts
packages/runtime-storage-sqlite/test/**
```

交付：Run row/query/page/mutation与receipt resource result neutral types/ports；Store 8 exact marker、DDL/index、preflight/closed codec；Store 7 exact
source-only rejection；in-memory/test storage同步实现contract。

Gate：Host不导入SQLite/Bun；Store package只依赖`runtime-host/storage`；DDL count/index/profile/unknown-extra/malformed terminal/result negatives；
Store 7以writer打开固定失败。

Rollback：尚未接Host production transaction时可整体删除Store 8 target代码；Store 7 current路径不变。

### KRSRUN-01B：Start、lifecycle与resource receipt原子事务

目标：Host start decision/commit、activation、interaction request/settlement、terminal/cancel/recovery transaction与Runtime private receipt/query
projection。

交付：

- start一次性提交queued row、State/event/snapshot/revision与original Run result receipt；
- activation写running/started time；interaction写waiting/running；terminal写status/outcome/finished time；
- replay在lookup-before-recovery路径返回stored original result，不重新prepare/schedule；
- private Runtime query支持bounded Run get/page；Public handler仍未开放；
- deterministic test clock冻结毫秒timestamp，production clock保持真实UTC。

Gate：transaction rollback任一失败均无partial Run/receipt/State；commit/response/activation/schedule crash windows；same key/digest replay、different
digest conflict；同Session单active Run；query走index query plan。

Rollback：未cutover时移除Host Store 8 composition；不得对已写Store 8 target用Store 7 Host打开。

### KRSRUN-02A：Delete、rewind、fork与restart recovery

交付：

- delete同transaction移除Run rows、保留resource receipts与Session tombstone；
- rewind只接受between-turn boundary，删除target以后的Run rows，拒绝截断partial Run；
- fork复制完整terminal rows、重绑target Session并记录origin，不复制source receipt/active unknown Run；
- pre-resume GET use case不recover，nonterminal projection unknown；resume/recovery原子更新Run；
- receipt replay与current resource不存在的组合按contract测试。

Gate：delete/fork/rewind/reopen/fault matrix；cross-Session/Workspace isolation；recovery不重复external effect；History与Run coverage无伪造。

Rollback：仍在unpublished target上可重建target；任何target写后不回Store 7。

### KRSRUN-02B：Store 7→Store 8 generation migration

目标文件在existing layout migration owner内确定，必须包含migration journal schema、fence、target builder/verifier、pointer switch与CLI/manager
orchestration；不新增独立migration daemon。

交付：

1. maintenance barrier与active Turn/Interaction/effect/external process convergence；
2. source Store 7/Catalog/layout/owner/WAL/SHM snapshot proof；
3. whole-generation copy，Store 8 DDL与每Session coverage boundary；
4. count/digest/binding/preflight validation；
5. pointer/manifest/journal/targetWriteState/old-binary fence；
6. Store 6、unknown/corrupt/unowned/partial Workspace整体拒绝。

Gate：phase-by-phase crash injection、no-follow/owner/ACL/atomic publish、old manager open denial、target-first-write no rollback、source digest unchanged、
macOS/Linux/Windows filesystem implementation tests。

Rollback：只允许ADR-0150两个pre-write窗口；任何unknown/first write保持blocked。

### KRSRUN-03A：Production composition、reopen与fault qualification

交付：Workspace Worker只在active-layout/manifest/journal/fence/Catalog/Store 8全部验证后ready；private Runtime TUI/CLI在Store 8上保持行为；
Agent API仍只开放read-only shell。补齐long-run reopen、response loss、process kill、slow storage、disk full/corrupt、Controller/recovery与
multi-Workspace isolation tests。

Gate：Runtime package/static/typecheck/default tests、fault/soak、real child process、source candidate与installed candidate；无Store 7 fallback log/
branch/import。

Rollback：quiesce writer；按journal决定blocked或允许pre-write rollback，不启动双writer。

### KRSRUN-03B：Current authority、release migration与父计划handoff

交付：更新Host/SQLite/Service README和local docs；`docs/active/runtime-authority-boundary.md`、
`runtime-resilience-qualification.md`、`coordinator-workspace-worker-web.md`及相关book/runbook；documentation map、release manifest/migration command、
SBOM/candidate evidence；本计划completion record。父KASAPI-03A在evidence commit后关闭，KASAPI-03B才可开放mutation mapper。

Gate：document-before-commit all/staged、docs impact/docs、pre-release architecture、runtime packages、test ownership、typecheck/build/default/
fault/release/candidate及三平台hosted evidence。缺任一平台evidence时该平台保持unsupported，不伪装完成。

Rollback：文档必须与实际active pointer一致；不能只回滚authority文字或删除migration evidence。

## 6. Task执行矩阵

| Task | dependsOn | 主要产出 | Required验证 | 迁移/回滚 |
| --- | --- | --- | --- | --- |
| KRSRUN-00A | KASAPI-00B | ADR-0150、contract/manifest/subplan | docs、plan matrix | 零production变化 |
| KRSRUN-01A | 00A、KASAPI-02D | neutral port、Store 8 DDL/index/preflight | package/static/schema tests | unpublished target可删 |
| KRSRUN-01B | 01A | Host lifecycle/receipt/private query | atomic/crash/replay/index tests | 未cutover不接production |
| KRSRUN-02A | 01B | delete/rewind/fork/recovery | fault/reopen/isolation tests | target写后不回Store 7 |
| KRSRUN-02B | 02A | generation migration/journal/fence | migration crash/platform tests | 仅pre-write窄回滚 |
| KRSRUN-03A | 02B | Worker composition/fault/candidate | default/fault/soak/release | blocked优先，不dual writer |
| KRSRUN-03B | 03A | current docs/runbook/completion | docs/release/三平台Gate | 按active pointer记录事实 |

## 7. 必测fault matrix

1. start commit前、Run row后模拟异常、receipt写前/后、response前、activation前、schedule前与terminal commit窗口；
2. same key same/different digest、delete/rewind后late replay、fork target无source receipt；
3. queued/running/waiting各状态restart，effect dispatched/unknown/cancelled与nonresumable recovery；
4. Run page 1/200/byte cap、concurrent start、rewind invalidation、query plan无full event scan；
5. Store 7 unknown column/table、Store 8 missing/extra/index drift、result/terminal digest mismatch；
6. migration每个journal phase crash、pointer原子性、WAL/SHM变化、owner/symlink/hardlink、disk full；
7. source active work无法收敛、一个Workspace corrupt/unowned、Store 6 source、old binary fence bypass尝试；
8. target first write后rollback请求固定blocked；reopen只认active layout且不读Store 7 fallback；
9. macOS/Linux/Windows path/ACL/lock/atomic replace真实hosted candidate evidence。

## 8. Required commands

每Task按真实diff选择并记录，Store/cutover Task至少运行：

```text
bun run check:docs-impact
bun run check:docs
bun run check:runtime-packages
bun run check:pre-release-architecture
bun run check:core-boundary
bun run check:test-ownership
bun run typecheck
bun run build
bun test packages/runtime-host/test
bun test packages/runtime-storage-sqlite/test
bun test apps/kite-service/test/workspace-worker
bun run test:runtime:fault
```

future test/path只在对应Task创建后执行。stage/commit/push/PR前始终显式激活`document-before-commit` Skill；失败不得提交或宣称完成。

## 9. 完成定义

只有KRSRUN-00A～03B全部完成、Store 8 active pointer与current authority一致、fault/candidate/平台evidence登记且父计划KASAPI-03A更新为完成，
本计划才迁入`docs/space/execution/completed/`。ADR接受、schema unit test或本地migration成功均不能单独构成完成。
