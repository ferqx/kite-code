# 渐进式三级上下文压缩完成记录

状态：completed
完成日期：2026-08-11
计划：[`../../plans/2026-08-10-progressive-context-compaction.md`](../../plans/2026-08-10-progressive-context-compaction.md)
架构：[`../../../adr/0100-checkpoint-working-set-compaction.md`](../../../adr/0100-checkpoint-working-set-compaction.md)、
[`../../../adr/0101-verified-checkpoint-working-set-protocol.md`](../../../adr/0101-verified-checkpoint-working-set-protocol.md)
当前规则：[`../../../active/three-tier-context-reduction.md`](../../../active/three-tier-context-reduction.md)

## 完成范围

- 统一 `MicroCompact → Verified Checkpoint Working Set → SummaryCompact` 编排；原 transcript 不删除，
  Session Memory 不接入；
- VerifiedContextCheckpointV3、半开区间 Working Set、schema v24 canonical event registry、全域 nested exact
  schema、generation/writeEpoch fence 与 resumable event/fence/named-proof migration；
- manual/auto 共用一次 Provider 请求的 Summary lifecycle、原子 start/terminal/resolution、六个 crash cut、
  continuation exactly-once、resource/Provider admission 与 stale settlement；
- Core opaque branch candidate/nonce、同 candidate contention retry、250ms transaction、receipt/completion/BCTC
  closure、ACK-unknown resolution、verified historical named fork/rewind 与 fail-closed legacy boundary；
- length-first snapshot/event/branch decoder、event/fence/branch ledger、quota/counter/ref tamper 与 WAL/DELETE fault
  matrix；本地 producer 和另起进程重放实现的独立 verifier。

## Review 收口

首次整体 review 与唯一最终回归复审均曾返回 P0=0、P1>0、NO-GO。随后由原架构与实现 review Agent 直接实施
全部列出的 accepted-scope P1：branch ownership/ACK、fence migration、LegacyNamedCutProof、nested schema、
length-first/ledger/quota、qualification replay 与 crash matrix。没有启动第二轮回归 review；主 Agent 依据每项
复现、定向矩阵和最终全量 Gate 确认清单归零。

## 验证证据

- `bun run test`：主 suite 3325 pass、8 skip、0 fail、14,826 assertions；5 个 process-isolated suite 全部通过；
- `bun run test:mock`：8 pass、0 fail；
- branch authority fault matrix：9 pass、0 fail；覆盖 count/byte boundary、ACK/GC、delete/recreate、counter/ref
  corruption、event/fence ledger 与 WAL/DELETE contention；
- Summary crash/event schema/qualification 定向矩阵：36 pass、0 fail；
- `bun run typecheck`、`bun run format:check`、`bun run lint`、`bun run check:core-boundary`、
  `bun run check:compaction-legacy`、计划矩阵与 `git diff --check` 全部通过；format/lint 仅保留既有 18 条
  `noExplicitAny` warning。

PSMC-06 artifact digest 为 `dc25271927e1652abaa67917d5066c51dd1efbd0c28322669546c672de33bfca`。
20 条长会话 fixture 的 mandatory retention=100%、continuation success=100%、raw baseline=100%、相对差值=0pp。
2000-block fixture 为 8,545,671 UTF-8 bytes；producer prepare p95=40.245ms、restore proof p95=42.810ms、
incremental peak RSS=0.922MiB，分别低于 75ms、100ms、96MiB Gate。独立 verifier 另起 producer 进程重放，
其 prepare p95=40.419ms、restore p95=43.159ms、peak RSS=0.922MiB，并拒绝自洽伪造 artifact。

## 仍关闭或未资格化

- `contextCompactionAutoV1` 与 Micro live rollout flag 保持默认关闭；
- 不声明 production-supported、default-on、无限会话或任意真实 Provider route qualification；
- Session Memory lifecycle、shadow/live、后台维护与跨会话记忆继续 deferred；
- checkpoint-v1/v2 仅保留 bounded legacy reader，不恢复旧 Slice B producer。
