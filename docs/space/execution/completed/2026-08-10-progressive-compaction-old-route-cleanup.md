# 旧三级压缩生产路线清场完成记录

状态：completed
日期：2026-08-10
计划：`../../plans/2026-08-10-progressive-session-memory-compaction.md` 的 PSMC-01/02
后续：`../../plans/2026-08-10-progressive-context-compaction.md`

## 完成范围

- 删除旧 auto decision/rollout、checkpoint-v2 writer、cache-safe fork、Provider cache route qualification、durable
  refill guard producer 和旧 Gate runner；
- live Kernel 拒绝旧 auto request/pending/effect、checkpoint-v2 completion 和 guard 写入；
- current rolling state 不再保存旧 auto guard；历史 guard event 只作 no-op compatibility；
- 历史 checkpoint-v2 只经物理隔离的 bounded reader 校验并降级为 checkpoint-v1，后续 snapshot 不写回 v2；
- 保留 Slice A 的有限工具结果、verified terminal、prepared/final admission、deterministic reclaim、exact CAS 与
  generation fence；当前唯一 checkpoint producer 是手动 checkpoint-v1 narrative。

## Review 关闭项

独立 review 最终为 GO。清场关闭了 live auto 仍可构造、current guard 仍可写、legacy reader 字段/容量校验
不闭合和文档仍宣称旧 auto 可用等问题。reader 在 normalize/map/digest 前执行 exact-key、深度、字段和
JSON-escaped byte budget；3MiB NUL 与 getter sentinel 证明畸形输入会在大分配和后续字段读取前拒绝。

## 验证证据

- 主套件：3259 pass、8 skip、0 fail、13260 expects；5 个隔离组全部通过；
- cleanup focused 最终 11/11，通过 restore/replay/fork/rewind/no-resave、tamper/oversize 与 live no-producer；
- `bun run typecheck`、`bun run format:check`、`bun run lint`、`bun run check:core-boundary`、
  `bun run check:compaction-legacy`、`bun run check:docs-impact`、`bun run check:docs`、`git diff --check` 均 exit 0；
- format/lint 仅报告 18 个既有、与本次无关的 `noExplicitAny` warning。

本记录不证明 MicroCompact、Checkpoint Working Set、新自动 orchestrator 或完整三级已经实现。
