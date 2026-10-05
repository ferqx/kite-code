# Agent Note: Original Run selection as a private observation

Status: implemented

## Problem

`getSelectedContext` 正确拒绝非当前 selector。Files 核原 capture 时却需要在同 Session 的新选择仍保留原点后，读原 Run 消费时的不可变选择；当前历史不能重建当时 before 是最后完整 selected pair 的事实，完整 Model User 文本也不能单独证明它。[恢复定义](../../../../docs/handbook/features/recovery.md)和[Context owner](../../../../packages/agent/src/storage/sqlite/context/README.md)保留当前选择与原来源的区别。

## Decision

私有 `readOriginalRunSelection({expectedStoreId,sessionId,subjectId,runId})` 从 actual Run/Command 的不可变 pin 派生 selector，不接受任意 selector 参数，不新增 HTTP、Gateway 或普通 ReadContext 权限。读事务核当前 Store、原 Session/Run/Command origin、主体/input pin与准确同 Session selection snapshot及其 context.select/Fork producer request/receipt。previous-selection ranges 从实际生产链完整重建，限制64层、1MiB及256 ranges，精确生产者 lookup不限制累计会话长度。

已知 producer 缺 snapshot 作为损坏拒绝。root 初始 implicit selection 只在实际 session.create、原 Run/Command pin和首个 select 之前的顺序证明下提供；Fork 初始必须实际 snapshot/receipt/source scope。返回水位是本次当前 Session 分配上界，Service 仍按原 trigger 限定完整历史，核原 Model 消费与当前 selected membership。此观察本身不增加最终派发 stamp，既有 records/projection/contextRevision guards保持。

## Alternatives considered

- 用当前 history 或已知 selector ID核旧点：前者会改写原 before，后者违背 current-only API；另设由原 Run 派生的可信观察。
- 缺 snapshot 沿用通用 selected() fallback：会把缺失的已生成选择误判为初始全选；只接受有实际初始顺序证明的 implicit 情况。
- 放宽 HTTP/普通 Extension reader 接受任意 selector：超出必要读取边界，保持私有宿主原 Run scope。

## Consequences

实际 SQLite/Worker 新4/33/0覆盖初始→全保留新 selector、Fork 初始、foreign/future/producer/snapshot 损坏、真实离线 A→B只读且游标不变。邻接四文件20/339/0；随后仅收紧 Fork source scope，最终新4项已重验该收紧，不推成所有邻接均已复跑。Service 真实同 Session 换 selector后旧点独立审批恢复，排除 trigger 后 unavailable/known rejected且零 Job/文件效果，另归 Files owner的默认服务资格。

此方法纯观察，不执行、授权或重标原 Store，也不能单独证明任意 SQL 人为修改后的最终派发安全。
