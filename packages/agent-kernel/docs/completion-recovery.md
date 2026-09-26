# 完成、失败与恢复决策

入口：[completion](../src/completion.ts)、[terminal outcome](../src/terminal-outcome.ts)、[recovery](../src/recovery.ts)、[restart recovery](../src/restart-recovery.ts)。

完成由 canonical facts、计划身份及所需执行/验证证据决定，不读取模型最后一句“完成”或客户端是否仍显示 Working。计划任务和非计划任务有各自完成输入；证据 identity 不匹配不能借用另一任务的成功。

本轮 required 后台子 Agent 的已接纳 `backgroundResult` 是其生命周期终态事实；完成守卫按原始工具、task identity 与当前工作归属核对后直接解除对应等待。`task_read` 的终态结果同样可提供证据，但不是后台结果已经持久化后的第二次确认权威。

独立子 Session 可封存显式 `unknown/cleanupConfirmed=false` 结果：仅限子 Run 的 unknown 终态、外部效果未知、当前 Turn 非活动且已有未知模型／能力尝试。该结果在父线程以准确原 Tool 血缘接纳后解除 required 等待，但未知委派用量仍由 ResourceBudget 保留为 unknown；解除等待不等于父 Run 可正常完成或子执行已清理。

模型 final 只形成完成候选。required background 是唯一 blocker 时，Kernel 返回专用
`required_background_pending → wait_for_background`，清除候选并持久化仅含 required task ID 的 waiting reason；
这不是完成纠错，不消耗 correction attempt。交互、普通工具、required Shell、unknown invocation、active Skill 和 Plan
仍按既有优先级先行。等待只由 Kernel 已接纳的终态、失败、取消等 canonical fact 解除；Artifact 或内存快照不能单独放行。

## 不同终点

completed、aborted、blocked、unknown、budget_exhausted 和 resource_saturated 具有不同恢复含义。失败分类不能丢弃已知副作用，unknown 不能被转成普通失败后自动重放。

取消先形成当前任务的取消与清理过程，相关调用和 lease 收敛后才能继续后继。客户端收到用户可见终态与 Host 清理完成可能不是同一时刻；调度必须继续依赖相应事实。

## 历史与重启

[state migration](../src/state-migration.ts) 与 [state codec](../src/state-codec.ts) 按受支持格式解码；历史读取不重新授予当前 execution authority。Host 负责重新检查持久 lease 与操作状态，Kernel 根据明确 facts 选择恢复，不能自己读取数据库或杀进程。

TriggerTurn 来源的待结算备付只凭 Store 提供的准确 admission 与 reservation 证明保留。已受理阶段兼容旧 `reserved` 与新 `queued` 备付；后者锁定有限计数但尚未取得活动子位，恢复时不得把它当作已派发，也不能在缺少证明时保留。

当前State epoch早期写入的后台结果可能没有`admissionRevision`。解码时保留其Session、transcript与已结算工具事实，但删除这条无法验证的`backgroundResult` authority；不得推测或补造revision。当前writer产生的后台结果仍必须携带完整revision并通过严格invariant。

改动必须同时检查正常完成、取消前后、未知副作用、迟到事件及重放结果。规范见[完成契约](../../../docs/active/completion-guard.md)、[取消恢复](../../../docs/active/cancel-resume-cleanup.md)。

验证：[completion](../test/completion.test.ts)、[recovery](../test/recovery.test.ts)、[restart recovery](../test/restart-recovery.test.ts)、[state migration](../test/state-migration.test.ts)。
