# Prepared execution、Attempt 与清理

入口：[execution bridge](../src/execution/execution-bridge.ts)、[tool coordinator](../src/execution/tool-pipeline-coordinator.ts)、[lifecycle 目录](../src/lifecycle/)、[process port](../src/process/execution-port.ts)。

## 从决定到执行

Kernel 选择 effect；Host 将已提交命令对应的 prepared execution 绑定准确 Session、操作和 committed revision。外部 Provider work 前完成 durable attempt acknowledgement。准备对象与一次 attempt 的执行身份不能由 UI、Server 或工具参数重新拼装。

Tool coordinator 在 preparation、dispatch、receipt 和结果提交之间维持同一 identity。Builtin 提供实际执行机制，Host 管理 attempt、lease 和提交资格，Store 验证持久 generation/revision。三者职责不能合并为“执行器返回成功即可完成”。

## 并发与失效

dispatch 前严格检查 fence；已 dispatch 的同一模型 invocation 可按当前规则接受与无关用户控制 revision 并发的流和终态，但 Turn 终止、invocation 替换或 identity 漂移后拒绝迟到结果。

命令返回和执行清理不是同一时刻。排队后继要等相应 lifecycle 可调度，不能因客户端已看到取消消息而越过 Provider 或子进程 cleanup。

## 进程与恢复

POSIX 使用 process group/watchdog 边界处理正常取消与 Host 意外退出；Windows 使用相应 Job/process-tree guard。Host 关闭先关闭 bridge，再按 module 生命周期释放，不创建额外业务 daemon。

未知外部结果保持 unknown，不通过重复运行“试试看”恢复。持久恢复事实由 Storage 检查，业务恢复选择由 Kernel 决定，Host 组织执行。流程见[取消恢复链路](../../../docs/development/flows/cancellation-recovery.md)。

验证：[tool coordinator](../test/tool-pipeline-coordinator.test.ts)、[effect supervisor](../test/effect-supervisor.test.ts)、[process execution](../test/process-execution-port.test.ts)、[state recovery](../test/state-recovery.test.ts)。
