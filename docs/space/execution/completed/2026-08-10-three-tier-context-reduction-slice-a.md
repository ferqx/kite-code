# 三级上下文缩减 Slice A 完成记录

状态：completed
完成日期：2026-08-10
计划：[`../../plans/2026-08-10-three-tier-context-reduction-slice-a.md`](../../plans/2026-08-10-three-tier-context-reduction-slice-a.md)
架构：[`../../../adr/0096-three-tier-context-reduction-l1-l2-live.md`](../../../adr/0096-three-tier-context-reduction-l1-l2-live.md)
当前规则：[`../../../active/three-tier-context-reduction.md`](../../../active/three-tier-context-reduction.md)
后续：[`../../plans/2026-08-10-three-tier-context-reduction-slice-b.md`](../../plans/2026-08-10-three-tier-context-reduction-slice-b.md)（draft；Gate A 前置已满足，但尚未激活）
当前后续：[`../../plans/2026-08-10-progressive-context-compaction.md`](../../plans/2026-08-10-progressive-context-compaction.md)（active，当前入口 PSMC-03；Session Memory 不在当前计划内）

## 完成范围

- 为全部 production ToolSpec 落地有限 `ToolResultBudgetV2`；关闭 flag 时 `compat_v1` 模型可见字节不变，
  开启后 Shell/Search 4000 字符与 serialized/structured/MCP 128 KiB UTF-8 上限由统一 finalizer/validator
  执行；dynamic MCP 在排队时冻结 canonical semantic output schema 与 binding identity；
- `read_file` 落地绑定 path/resource/decoder/initial window/current coordinate 的 `line_byte_cursor_v2`，覆盖
  UTF-8 scalar boundary、UTF-16LE/BE BOM、非法 UTF-8、encoding/BOM/EOL drift 与多次 continuation；
- finished/failed/rejected/cancelled 四类 terminal 自包含唯一 `verified_v2` result、receipt 与
  `terminalIdentity`；全部 control companion、provider action、ask-user cancellation、sandbox/policy reject 和
  invalid Tool Call 以原子 batch 闭合，live/restore/replay 走同一 validator；
- Runtime schema 升至 v22。v2..v21 旧 Tool Result 只迁移为
  `legacy_unverified + legacy_unknown`；迁移与普通写入都绑定 snapshot metadata、observed full event head 与
  持久 generation/fence exact CAS，restore 验证 snapshot/event prefix 和 call/result/terminal 三方一致性；
- 新增 pure、deep-frozen `PreparedContextRequestV2` 与 effect-only final admission。inspection/candidate/
  restore-debug 零 lease/reservation/Provider dispatch；normal primary 在持久所有权前后重验 source/request/
  payload identity，不建立第二条 Provider 路径；
- L2 live 只替换完整 settled、成功、全 `budget_v2` verified、read-only、无 workspace mutation 的
  `read_file|search_content|search_files` block。收益不足或 identity/plan/apply 失败使用 raw fallback，原始
  transcript 不删除；
- 成功 primary 固定使用无推进 2-event 或推进 3-event terminal branch。bounded commit/receipt 只保存
  counts/ranges/digests/policy/cache identity，不保存 selected entries 数组或正文；restart/resume/fork/reset/
  rewind 确定性重建；
- `toolResultBudgetV2=false`、`contextReclaimV1=false`、`reclaimMode=off` 保持默认值；source-owned route
  qualification registry 为空，用户配置、本地 evidence 或模型名称不能制造 production 资格；
- active/Book/README/documentation-map 与生命周期索引已同步，只声明 Slice A。

## Gate A evidence

固定 fixture 为 2,000 个 settled blocks、200 eligible/1,800 ineligible，L1 后 canonical model content
8,390,000 UTF-8 bytes。producer/独立 verifier 命令为：

```bash
bun run scripts/evals/context-reduction-slice-a-local-gate.ts --output <artifact.json>
bun run scripts/evals/context-reduction-slice-a-local-gate.ts --verify <artifact.json>
```

本次 evidence digest 为
`59a3485d8326f7ee939065af218b2514f5ebc8c6e3317821c2246512e4c8d524`，producer 与 verifier 均返回
`passed`。身份绑定 inventory/fixture/policy、Bun 1.3.14、darwin/arm64/Apple M4 Pro、2 次 warmup、7 次
sample、GC protocol、memory metric 与 worker command digest。原始测量为：

- raw/off prepare p95：158.7095 ms；off regression：0%；payload byte mismatch：0；
- L2 plan+apply+final-estimate p95：16.624292 ms（上限 50 ms）；
- fresh worker isolated maxRSS：off 459,538,432 bytes，live 477,413,376 bytes，增量
  17,874,944 bytes（上限 64 MiB）；
- primary commit/receipt/event identity metadata：3,206 bytes（上限 16 KiB）；
- verified terminal metadata：984 bytes（上限 8 KiB）。

off/live memory 样本分别在 fresh Bun worker 中运行相同 fixture/warmup/sample，显式调用 `Bun.gc(true)`，
以 `process.resourceUsage().maxRSS` 计量；verifier 从 artifact 原始样本重算 p95 差值，并对 evidence/schema/
identity/GC protocol/worker command/tamper/drift 做负向验证。该 evidence 是 frozen local Gate，不冒充真实
Provider route qualification。

## 验证证据

- Gate A 定向矩阵全部通过；关键新增测试覆盖 tool result budget/terminal、schema v22 migration、prepared
  admission、L2 live 与 commit；最后一次 terminal/golden/kernel 复验为 63 pass、0 fail；
- `bun run test:mock`：6 pass、0 fail；
- `bun run test`：主 suite 3,263 pass、7 skip、0 fail，13,206 assertions；5 个 process-isolated 文件
  26 pass、0 fail；
- `bun run typecheck`、`bun run format:check`、`bun run lint`、`bun run check:core-boundary`、
  `bun run check:compaction-legacy`、`bun run check:docs-impact`、`bun run check:docs`、`git diff --check`
  全部通过；format/lint 仅保留仓库既有 18 条 `noExplicitAny` warning。

## 明确排除与后续

本记录不表示完整三级上下文缩减已经实现。Slice B 仍为 `draft`，下列能力尚未交付：canonical L3
source/request identities、L1→L2→L3 三段真源验证、`cache_safe_fork:v1`、checkpoint v2/source manifest、
schema v23、durable refill guard/restart-fork-rewind join、自动 L3、typed Provider overflow shrink/retry，以及任意
真实 Provider/route 的 production qualification。现有 `contextCompactionV2` 与 manual 默认值不变；只有新
L1 V2/L2 live 路径默认关闭。
