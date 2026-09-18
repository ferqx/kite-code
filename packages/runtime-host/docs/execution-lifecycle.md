# Prepared execution、Attempt 与清理

入口：[execution bridge](../src/execution/execution-bridge.ts)、[tool coordinator](../src/execution/tool-pipeline-coordinator.ts)、[lifecycle 目录](../src/lifecycle/)、[process port](../src/process/execution-port.ts)。

## 从决定到执行

Kernel 选择 effect；Host 将已提交命令对应的 prepared execution 绑定准确 Session、操作和 committed revision。外部 Provider work 前完成 durable attempt acknowledgement。准备对象与一次 attempt 的执行身份不能由 UI、Server 或工具参数重新拼装。

Tool coordinator 在 preparation、dispatch、receipt 和结果提交之间维持同一 identity。Builtin 提供实际执行机制，Host 管理 attempt、lease 和提交资格，Store 验证持久 generation/revision。三者职责不能合并为“执行器返回成功即可完成”。

## 并发与失效

dispatch 前严格检查 fence；已 dispatch 的同一模型 invocation 可按当前规则接受与无关用户控制 revision 并发的流和终态，但 Turn 终止、invocation 替换或 identity 漂移后拒绝迟到结果。

命令返回和执行清理不是同一时刻。排队后继要等相应 lifecycle 可调度，不能因客户端已看到取消消息而越过 Provider 或子进程 cleanup；会话关闭后，即使带有排队许可也不得再调度。
`waitForSessionIdle()` 等待当前执行及其清理期间排入的后继执行，直到该会话没有 scheduled work；关闭 Host 也使用同一空闲判定。
Host 关闭时并发请求各 Session 的持久取消，单个 Session 的取消写入迟滞不会阻止其他 Session 开始取消；各 Session 的本地执行仍须在其取消请求之后中止并等待清理。
关闭全过程使用固定 10 秒预算，留出 Desktop 进程退出的剩余窗口。取消写入或 Provider 清理超时时，Host 拒绝关闭结果、停止后续 bridge/module/Store 释放，不把未知清理当作成功；本地执行会收到 abort，但其实际结束仍需进程退出或恢复证据确认。

## 进程与恢复

POSIX 使用 process group/watchdog 边界处理正常取消与 Host 意外退出；Windows 使用相应 Job/process-tree guard。Host 关闭先关闭 bridge，再按 module 生命周期释放，不创建额外业务 daemon。

未知外部结果保持 unknown，不通过重复运行“试试看”恢复。持久恢复事实由 Storage 检查，业务恢复选择由 Kernel 决定，Host 组织执行。流程见[取消恢复链路](../../../docs/development/flows/cancellation-recovery.md)。

验证：[tool coordinator](../test/tool-pipeline-coordinator.test.ts)、[effect supervisor](../test/effect-supervisor.test.ts)、[process execution](../test/process-execution-port.test.ts)、[state recovery](../test/state-recovery.test.ts)。

## 空闲执行权

App Server 的释放回调由 Host 在会话 mailbox 中调用，与下一条命令取得执行权串行。命令提交、activation 和 scheduled work 的 completion 全部结束后，Service 等待 coordinator 清理并核对未决 effect/Provider 事实，才以原 generation 与 authority revision 释放；不再续约空闲会话。下一次执行重新获取 generation 并恢复 coordinator。终态通知先于清理时仍等待实际 completion；等待用户交互只在没有活动执行资源时释放。
延迟发布前一轮 State 的通知时，Run 投影选用该 State revision 当时已创建的 Run；不能把后续新 Run 的排队状态投到旧 revision，造成同 revision 投影冲突。

get_command_receipt 只读取原命令的持久结果，校验查询 scope 与原命令相符，不进入 mailbox、不获取执行权、不执行 activation。缺失回执保持未知；命令自身的持久幂等校验继续保留。验证见[命令与清理回归](../test/persistent-command-host.test.ts)。
