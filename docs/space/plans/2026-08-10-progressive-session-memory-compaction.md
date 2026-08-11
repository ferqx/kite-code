# 渐进式会话记忆压缩实施计划

状态：superseded（清场 PSMC-01/02 已完成；后续由 `2026-08-10-progressive-context-compaction.md` 接管）
日期：2026-08-10
优先级：P0
设计依据：[`../../design/2026-08-10-progressive-session-memory-compaction-rfc.md`](../../design/2026-08-10-progressive-session-memory-compaction-rfc.md)
架构依据：[`../../adr/0098-progressive-session-memory-compaction.md`](../../adr/0098-progressive-session-memory-compaction.md)、
[`../../adr/0099-session-memory-lifecycle.md`](../../adr/0099-session-memory-lifecycle.md)（proposed）
取代：[`2026-08-10-three-tier-context-reduction-slice-b.md`](2026-08-10-three-tier-context-reduction-slice-b.md)
后续计划：[`2026-08-10-progressive-context-compaction.md`](2026-08-10-progressive-context-compaction.md)

## 清场终态

旧 Slice B 已停止。PSMC-01/02 清场已完成：cache qualification、checkpoint-v2 writer/三段 proof producer、
durable refill guard、旧 auto L3 和双编排入口已移除；历史 checkpoint-v2 仅由物理隔离的 bounded reader 校验
并降级为 checkpoint-v1。PSMC-03..10 未在本计划下获得实施授权。ADR-0100 接受后，Session Memory 已退出
当前主链；新三级能力改由后续计划重新定义。

## 最终进度

- PSMC-01：completed；inventory 已冻结保留、改造、删除与兼容义务。
- PSMC-02：completed；当前唯一 writer/orchestrator 为 checkpoint-v1 手动 narrative 路径，旧 guard 事件 replay
  为 no-op，旧 `autoGuard`/`autoGuardV2` 与 auto pending/effect 不进入新 snapshot 或调度。
- PSMC-03..10：superseded；没有实施，不能由本文继续授权。

## 历史目标（已被 ADR-0100 取代）

交付局部压缩、会话记忆压缩和模型摘要兜底的统一优先级链，并以显式 boundary 支持 restart、resume、fork、
rewind 和增量压缩。原 transcript、工具协议、Runtime authority、Provider admission 和持久 CAS 边界不回退。

## 渐进阶段

| 阶段 | 范围 | 完成口径 | 下一阶段失败时的状态 |
| --- | --- | --- | --- |
| A：基础压缩 | PSMC-01..05 | 局部压缩、最近窗口、模型摘要兜底和 boundary 可用 | 保持可用，不依赖 Session Memory |
| B：Memory Shadow | PSMC-06..07 | memory 可生成、持久、恢复和评估，但 Provider payload 零变化 | 关闭 memory maintenance，阶段 A 不回退 |
| C：Memory Live | PSMC-08..10 | verified memory 优先、摘要可靠兜底、完整三级 Gate 通过 | 关闭 live 回到阶段 A；保留候选供诊断 |

本文当时只授权并完成了 PSMC-01/02。阶段 A/B/C 的后续授权现已取消；当前目标、Task 和 Gate 以
`2026-08-10-progressive-context-compaction.md` 为准。
每个阶段必须建立独立完成记录，禁止用阶段 A 或 B 的结果声明完整三级。

## Task 矩阵

| Task | dependsOn | 文件/产出 | 定向验证 | 迁移与回滚 |
| --- | --- | --- | --- | --- |
| PSMC-01 | RFC reviewed | 旧路线保留/改造/删除 inventory、源码与测试基线 | inventory gate、现有 compaction 全矩阵 | 零删除、所有新 flag 默认 off |
| PSMC-02 | PSMC-01 | 移除旧 cache-safe/checkpoint-v2 writer/route-gate/refill producer 与双入口；兼容 reader 独立隔离 | dead-code、schema/read-only migration、no-producer、full baseline tests | 保留可逆 patch；发现持久兼容义务时只保留 reader，绝不恢复 writer |
| PSMC-03 | PSMC-02 | micro policy、白名单、时间/大小资格、micro boundary | pairing、current-turn、pin、bytes/token、replay tests | 关闭 micro flag 回到 raw projection |
| PSMC-04 | PSMC-02 | recent-window selector、协议 block 与 compact boundary V1 | token/message 上下限、无 gap、tool pair、stream fragment、restore property tests | boundary 无效回退 raw/旧 v1 checkpoint |
| PSMC-05 | PSMC-03..04 | 单一 orchestrator、unavailable memory provider、单次摘要、附件预处理、typed PTL、阶段 A Gate/文档/完成记录 | manual/auto/admission/failure、no generic-400、docs/typecheck/full/fault/perf gates | 关闭新 orchestrator 使用保留的 checkpoint-v1 摘要兼容路径 |
| PSMC-06 | PSMC-05、ADR-0099 accepted | SessionMemory 类型、事件、reducer、source/input identity 与 migration | update/restart/stale/conflict/privacy tests | 保留最后 verified memory；失败不阻断 normal |
| PSMC-07 | PSMC-06 | 增量 updater、idle maintenance、单 effect lease、shadow evaluator 与阶段 B Gate | bootstrap/incremental/cancel/unknown/resource/admission、retention/continuation eval | 关闭 maintenance flag；阶段 A 不回退 |
| PSMC-08 | PSMC-07 | verified memory provider、recent-window activation 与完整 lifecycle | manual/auto/restart/resume/fork/rewind、final admission E2E | 关闭 live 后 provider 返回 unavailable |
| PSMC-09 | PSMC-08 | 移除阶段 B shadow-only 旁路、收敛 memory live 单入口与兼容 reader 退役判定 | no-double-producer、schema/read compatibility、full test、diff audit | reader 有真实兼容义务时继续 read-only 保留 |
| PSMC-10 | PSMC-08..09 | 阶段 C evidence、active/book/map 与完整三级完成记录 | docs、typecheck、full test、fault/replay/perf/semantic gates | 任一 Gate 失败保持 Memory Shadow |

## 历史激活条件（不再有效）

阶段 A 只有以下条件全部满足才可从 `draft` 进入 `active`：

1. 与阶段 A 有关的局部压缩白名单、recent window 和第三级预算问题关闭；
2. 阶段 A 独立方案评审结论为 GO；
3. PSMC-01 inventory 证明哪些旧代码可保留、改造或删除；
4. 旧 Slice B 的在途代码没有被误登记为完成或 production-supported；
5. 回滚不删除原 transcript、不降低 tool/result 配对和 Store CAS 安全性。

阶段 B/C 另需 RFC 的 Session Memory 问题关闭、ADR-0099 accepted，并分别通过 shadow 与 live Gate；不得因
阶段 A 已 active 自动获得实施授权。
