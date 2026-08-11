# 三级上下文缩减 Foundation 完成记录

状态：completed
完成日期：2026-08-10
计划：[`../../plans/2026-08-09-context-reclaim-foundation.md`](../../plans/2026-08-09-context-reclaim-foundation.md)
架构：[`../../../adr/0095-three-tier-context-reduction-foundation.md`](../../../adr/0095-three-tier-context-reduction-foundation.md)
设计：[`../../../design/2026-08-09-three-tier-context-reduction-rfc.md`](../../../design/2026-08-09-three-tier-context-reduction-rfc.md)
后续：[`../../../design/2026-08-10-three-tier-context-reduction-complete-rfc.md`](../../../design/2026-08-10-three-tier-context-reduction-complete-rfc.md)

## 完成范围

- 以 `ToolResultBudgetPolicyV1` 统一登记 Shell/Search 4000 字符与 MCP 128 KiB 模型结果边界，既有输出
  字节、截断 marker 和双流语义不变；
- 为 `read_file`、`search_content`、`search_files` 补齐 pre-projection raw digest、精确 model-content
  digest、locator 与 provenance；旧 snapshot/transcript 缺少证明时归一为 `legacy_unknown`，Runtime schema
  保持 v21；
- 新增纯 `ReclaimPlanV1` planner/applier，绑定 raw projection、raw frames、applied frames、environment、
  estimator 与 policy identity；完整 block 原子选择，正文 digest/locator/header/selected coverage 任一不一致均
  fail closed；
- 稳定 reclaim stub 只含 version、tool、原字符数和固定 replay 指令，不包含 locator、digest 或正文；
- 新增默认关闭 `contextReclaimV1`，配置只接受 `compaction.reclaimMode=off|shadow`；
- Model Controller 只在可信窗口 warning 以上压力、flag+shadow 且显式注入 reporter 时计算候选，不应用
  plan；Provider payload/admission、模型调用次数、Runtime event、transcript、checkpoint 和 snapshot 不变；
- 新增独立、严格 DTO、最多 1024 样本的进程内 `ReclaimShadowReporter`/collector，不复用 compaction
  local-debug，不写 event、session trace 或磁盘；
- active/book/documentation-map、ADR、计划与完成记录共同收敛；没有声称 L2 live、L3 source identity 或
  Claude Code parity 已上线。

## 评审与修正

- 设计文档经独立子 agent review 后关闭 L1 metadata、两阶段触发、L3 identity、cache stability 与测试路径
  问题；
- 实施计划经独立子 agent 两轮 review 后 GO，明确三类 digest、reporter 依赖方向、legacy restore、stub、
  target 和验证矩阵；
- 实现由独立子 agent 完成，代码 reviewer 首轮发现 2 个 P1、2 个 P2：model digest 未重算、read locator
  不完整、applier plan 防篡改不足、L1/admission golden 不足；全部修复后复审 GO，未留 P0/P1/P2。

## 验证证据

- 关联实现矩阵：266 pass、0 fail；代码 review 修正专项：87 pass、0 fail；
- `bun run test`：主 suite 3,179 pass、7 skip、0 fail，5 个 process-isolated 文件全部通过；
- `bun run test:mock`：6 pass、0 fail；
- `bun run typecheck`、`bun run format:check`、`bun run lint`、`bun run check:core-boundary`、
  `bun run check:compaction-legacy`、`bun run check:docs-impact`、`bun run check:docs`、`git diff --check`
  全部通过；format/lint 仅保留仓库既有 18 条 `noExplicitAny` warning。

## 后续边界

本完成记录不授权用户可见的 token saving。`contextReclaimV1` 默认关闭，且 schema 不接受 `live`。未来 L2
live 必须新增 ADR/计划，采用 raw projection → fixed plan → final projection → final payload admission 的统一
orchestrator，并补 Provider payload、恢复、缓存与真实模型证据。L3 若消费 L2，必须升级 checkpoint source
identity 与 Runtime migration；不能复用当前 shadow 指标冒充持久审计身份。
