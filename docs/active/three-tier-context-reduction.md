# 三级上下文缩减：当前实现与清场边界

状态：active

读取时机：修改工具结果预算与 terminal、prepared/final admission、L2 reclaim、checkpoint、上下文压缩
调度、Runtime schema v23、旧 Slice B 兼容读取或渐进式三级压缩计划时。

验证：`bun test tests/tool-result-budget-v2.test.ts tests/runtime/tool-terminal-v2.test.ts
tests/runtime/context-preparation-v2.test.ts tests/runtime/context-reclaim-live.test.ts
tests/runtime/context-reclaim-commit.test.ts tests/runtime/checkpoint-v2.test.ts
tests/runtime/schema-v22-migration.test.ts tests/runtime/schema-v23-migration.test.ts
tests/runtime/context-compaction-manual.test.ts tests/runtime/context-compaction-e2e.test.ts
tests/runtime/legacy-slice-b-removal.test.ts`、
`bun run scripts/evals/context-reduction-slice-a-local-gate.ts --verify <artifact.json>`、
`bun run typecheck`、`bun run check:core-boundary`、`bun run check:docs-impact`、`bun run check:docs`。

相关：ADR-0095、ADR-0096、ADR-0100、ADR-0101（accepted）、
[`../space/plans/2026-08-10-progressive-context-compaction.md`](../space/plans/2026-08-10-progressive-context-compaction.md)、
[`../space/plans/2026-08-10-progressive-session-memory-compaction-inventory.json`](../space/plans/2026-08-10-progressive-session-memory-compaction-inventory.json)。

## 当前结论

PSMC-01/02 清场已经完成。当前代码只保留三部分可执行能力：

1. Slice A 的有限工具结果预算、verified terminal、统一 prepared/final admission 和确定性 L2 reclaim；
2. checkpoint-v1 单叙事兼容压缩器，当前只由显式手动 `/compact` 入口生产；
3. schema v23 的 exact CAS、event-head identity、generation fence 与旧 schema 迁移安全。

旧 Slice B 的 canonical L3 source、checkpoint-v2 writer、三段 proof producer、`cache_safe_fork:v1`、Provider
cache route qualification、durable refill guard producer/门禁、旧 auto L3 eligibility/rollout 和 Gate B
runner/package 已从当前生产路径移除。不存在新旧双编排器，也不存在可登记 qualified cache route 的入口。

新的 MicroCompact policy、schema v24/Verified checkpoint V3、Checkpoint Working Set、SummaryCompact 更新和
统一渐进式 orchestrator 尚未实现；这些属于新计划 PSMC-03..06。不得以本次清场或 Slice A 完成记录声明新
三级已经可用。Session Memory 已移出当前计划，只作为未来可选增强。

## 保留的 Slice A 基础

- `toolResultBudgetV2=false` 保持 `compat_v1` 模型可见字节。开启后，各工具按冻结 binding 应用有限输出预算，
  四类 terminal 携带自包含 verified receipt、terminal identity 与 bounded metadata。
- L2 只折叠完整 settled、非 current turn、全 `budget_v2` verified、read-only、无 workspace mutation 的
  `read_file | search_content | search_files` ToolCallBlock；compat、legacy、mixed、失败、无 locator 或配对异常块
  保持 raw。
- L2 live 必须显式满足 `toolResultBudgetV2=true + contextReclaimV1=true + reclaimMode=live`。成功 primary
  使用封闭 2-event no-advance 或 3-event commit-advance batch；commit 只保存 ranges、counts、digests 与
  policy/cache identity，不保存路径、参数或正文。
- pure prepare 不获取 lease、reservation 或 Provider ownership；只有 exact final payload 通过 resource 与
  Provider data admission 后才允许 dispatch。
- transcript、tool call/result pairing、Store exact CAS 与 generation fence 均不因压缩清场回退。

## 当前唯一压缩 producer

`createNarrativeContextCompactor()` 与 `executeContextCompaction()` 是当前唯一 checkpoint producer/orchestrator。
它只生成 checkpoint v1：一次无工具、零 SDK retry 的 Markdown narrative；输出必须非空、未截断、无 tool call，
并通过安全 source boundary、环境 freshness、真实 before/after 重算和至少 1024 token 的绝对收益校验。

当前生产入口只有显式手动 `/compact`。旧 `contextCompactionAutoV1` 与 `compaction.autoMode` 配置字段仅为
向后配置兼容而继续接受；它们没有自动调度 producer，不能启用 shadow/live 自动摘要。未来自动压缩必须由
新的渐进式 orchestrator 重新接线，不得恢复已删除的 decision/rollout 路径。

active checkpoint 只允许 version 1。checkpoint 替换已覆盖历史前缀的 Provider projection，但从不删除或改写
原始 transcript；`/compact reset` 只撤销活动投影。

## 旧数据只读兼容

`src/core/runtime/legacy-slice-b-reader.ts` 是物理隔离的 bounded reader：

- 只识别历史 checkpoint v2 envelope、manifest 和 source proof；
- 从 durable transcript 重算 source range，拒绝 boundary、manifest、summary 或 digest 篡改；
- 校验成功后立即降级为 checkpoint v1 投影，后续新 snapshot 不再保存 v2 envelope；
- 历史 refill/guard 事件在 replay 时是显式 no-op，不进入当前 rolling state；恢复会剥离旧 `autoGuard`
  与 `autoGuardV2`，历史 auto pending/effect 也不会重新调度；
- 模块不得被 prepare、scheduler、controller 或 Provider dispatch 入口导入。

若旧 checkpoint v2 校验失败，恢复按持久状态损坏处理，不猜测正文，也不恢复旧 writer。

## 路线与回滚

新路线固定为 `MicroCompact → Checkpoint Working Set → SummaryCompact`。当前只完成旧路线清场，没有实现
上述新编排。RFC 与 ADR 已完成整体评审，活动计划从 PSMC-03 开始按单一 orchestrator 渐进接入；对应 Gate
通过前不得把新编排表述为已实现或可用。Session Memory 不参与当前 Gate。

回滚 Slice A 新能力时先关闭 `contextReclaimV1`/`reclaimMode`，再关闭 `toolResultBudgetV2`。回滚不删除
transcript/checkpoint，不降低 tool pair、terminal receipt、prepared/final admission 或 Store fencing。旧 Slice B
producer 不属于回滚目标，禁止重新启用。

## 明确排除

- Provider overflow 后自动摘要、shrink、chunk、repair 或普通请求 retry；
- 任何 checkpoint-v2、cache-safe fork、route cache qualification 或 refill guard 新写入；
- 把 legacy reader 当成 compaction producer 或 Runtime authority；
- 在当前计划中新增 Session Memory schema/event/config、shadow/live maintenance 或 memory Provider；
- default-on、production-supported、无限会话或跨 Provider 等价声明。
