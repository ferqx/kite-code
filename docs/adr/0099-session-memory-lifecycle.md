# ADR-0099：会话记忆使用增量单叙事、独立激活与低权限恢复

状态：proposed
日期：2026-08-10
补充：ADR-0021、ADR-0022、ADR-0024、ADR-0090、ADR-0091、ADR-0098
关联：`docs/design/2026-08-10-progressive-session-memory-compaction-rfc.md`、
`docs/space/plans/2026-08-10-progressive-session-memory-compaction.md`
Backlog：`docs/space/backlog/2026-08-10-session-memory-enhancement.md`
后续：ADR-0100 已将 Session Memory 从当前压缩主链和实施计划中移除。本文保留为独立增强提案；在另立
计划并被明确接受前，不构成当前三级压缩、自动调度或发布资格的依赖。

## 背景

当前 Runtime 没有 Session Memory 实体。现有 checkpoint 是压缩时生成的摘要，不等于压缩前持续维护的会话
记忆；Plan、Verification、Task 和授权状态也不能被复制成另一份记忆权威。若未来实现该增强，仍需定义记忆
的生成、覆盖范围、激活、失效和恢复；这些问题不再阻断当前压缩主链。

## 提议

本 ADR 不属于当前压缩实施阶段。当前实现不生成、不持久化、不注入会话记忆；未来只有独立计划被接受后，
Session Memory 才能作为低权限 `CompactPrefixProvider` 候选接入，且不得取代活动 checkpoint 的基础能力。

### 1. 记忆内容

`SessionMemoryV1` 是一份有固定章节的规范化 Markdown narrative，覆盖目标与约束、已确认决定、完成与验证、
失败与阻断、未完成事项和继续工作线索。它是低权限 assistant history，不进入 system prompt，不能改变
Plan、Verification、授权、Interaction、Tool、Skill 或 Runtime 状态。

### 2. 生成方式

V1 使用一次无工具、零 SDK retry 的模型调用增量生成：

- 首次更新输入为安全 settled transcript prefix；
- 后续更新输入为上一份 active/candidate memory 加上其覆盖范围之后的新 transcript delta；
- delta 先经过局部压缩 projection，图片和可重建附件使用占位符；
- 每次输出仍是一份完整记忆，不保存独立 facts ledger、JSON schema 或 patch 指令。

记忆更新只在完整 turn 结束、所有工具/交互/verification 已结算后调度。同一 session 的 V1 不并发执行 primary
Provider 与 memory Provider：新用户输入在 memory dispatch 前到达则取消维护；dispatch 已开始则输入可以排队，
primary dispatch 等该单次 bounded attempt 终结。

### 3. 更新与激活分离

生成成功只更新 `latestMemory`，不自动改变模型上下文。只有压缩 orchestrator 验证 coverage、recent window、
token 收益和最终 admission 后，才能原子写入引用该 memory 的 `compact_boundary`。活动 projection 使用 boundary
引用的 memory，而不是无条件使用最新候选。

因此 Runtime 至多需要保留两份正文：当前 active boundary 引用的 memory，以及更新的 latest candidate；两者
相同则只保存一份。更旧正文只留在历史 event 中，不复制到滚动 state。

### 4. 持久化与恢复

记忆候选保存 source range、base memory/content digest、memory input digest、policy、prompt contract、route、
content digest 和 token metadata。
恢复时从 immutable transcript 重算单一 source-range digest；不建立 raw/source/applied/candidate 三段 proof chain。
无效、缺失或冲突的 memory/boundary 只使会话记忆路径失效并回退 raw/旧 checkpoint，不升级为 Runtime hard block，
除非底层 Store checksum、event ordering 或 transcript 本身损坏。

rewind 恢复目标 revision 当时的 memory/boundary；fork 复制 fork cut 可见的 memory/boundary；`/compact reset` 只
撤销 active boundary，不删除 verified memory candidate；`/clear` 创建新 session 并清空全部会话记忆。

### 5. 失败与重试

memory Provider failure、空输出、tool call、截断、stale source 或 admission denial 都不阻断 normal request。
`dispatch_started` 后无 terminal 的 attempt 标记 `unknown_external_outcome`，不得用同一 `memoryUpdateId` 自动重放。
后续只有在安全边界推进、source range 严格扩大时才可创建新的维护请求。

## 未决定

本 ADR 在下列参数由测试和 evidence 冻结前保持 `proposed`：预热 utilization、最小 delta tokens/turns、memory
最大 token、recent window min/max token、维护 cooldown 与 Provider route policy。

结构验证不能证明语义无损。接受本 ADR 还要求冻结长会话 retention/continuation evidence；失败的
route/prompt contract 必须关闭 Session Memory，并回退 raw 或模型摘要兜底。
