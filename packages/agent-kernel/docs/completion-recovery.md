# 完成、失败与恢复决策

入口：[completion](../src/completion.ts)、[terminal outcome](../src/terminal-outcome.ts)、[recovery](../src/recovery.ts)、[restart recovery](../src/restart-recovery.ts)。

完成由 canonical facts、计划身份及所需执行/验证证据决定，不读取模型最后一句“完成”或客户端是否仍显示 Working。计划任务和非计划任务有各自完成输入；证据 identity 不匹配不能借用另一任务的成功。

## 不同终点

completed、aborted、blocked、unknown、budget_exhausted 和 resource_saturated 具有不同恢复含义。失败分类不能丢弃已知副作用，unknown 不能被转成普通失败后自动重放。

取消先形成当前任务的取消与清理过程，相关调用和 lease 收敛后才能继续后继。客户端收到用户可见终态与 Host 清理完成可能不是同一时刻；调度必须继续依赖相应事实。

## 历史与重启

[state migration](../src/state-migration.ts) 与 [state codec](../src/state-codec.ts) 按受支持格式解码；历史读取不重新授予当前 execution authority。Host 负责重新检查持久 lease 与操作状态，Kernel 根据明确 facts 选择恢复，不能自己读取数据库或杀进程。

改动必须同时检查正常完成、取消前后、未知副作用、迟到事件及重放结果。规范见[完成契约](../../../docs/active/completion-guard.md)、[取消恢复](../../../docs/active/cancel-resume-cleanup.md)。

验证：[completion](../test/completion.test.ts)、[recovery](../test/recovery.test.ts)、[restart recovery](../test/restart-recovery.test.ts)、[state migration](../test/state-migration.test.ts)。
