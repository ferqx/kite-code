# 命令、Mailbox 与持久回执

入口：[DefaultRuntimeHost](../src/host/runtime-host.ts)、[SessionMailbox](../src/session-mailbox.ts)、[command receipt](../src/host/command-receipt.ts)。Service 注入 execution bridge 与 storage，Runtime Server 只通过 RuntimeAccess 调用 Host。

## 单次命令的顺序

1. 校验 command，冻结连接上下文，计算 Session scope 与 request digest。
2. 查持久回执；相同已提交命令返回重放结果。进程内相同 commandId 的 pending 请求共享 Promise，digest 不同则拒绝。
3. 进入该 Session mailbox 后再次查回执，检查删除、revision、busy 与恢复状态。
4. bridge inspectCommand 产生 terminal 结果或可提交决定；校验目标 Session。
5. commit 将回执与业务变化落入所属事务。Host 重读持久回执并确认与 commit 返回一致。
6. 执行 activation、刷新 Session projection，再调度 prepared execution；cancel/close 走对应生命周期操作。

回执存在性必须在调度前证明。客户端断线后重新发送不能执行第二次副作用。delete receipt 可以比 Session 存活更久，重放删除不能重新创建目标。

## Mailbox 的边界

`set_interaction_mode` 不进入 Host 的 execution lease 包装，也不在回执重放时恢复 Runtime。它保留同一 mailbox、digest、事务回执与通知顺序；每次命令从 Store 投影刷新 revision，避免其他设置写入者提交后仍按旧 registry 冲突。commit 失败后若已存在同命令的持久回执，返回其已知结果，不重试写入。执行 bridge 必须在具体提交处裁决：活动 State owner 继续验证执行权，无执行 owner 的专用设置事务须原子验证无并发执行者与 State revision。其他执行命令仍进入 execution scope。

SessionMailbox 用 Promise tail 串行化单 Session 的操作，失败也将 tail 收敛为可继续的 Promise，避免污染后续队列；不同 Session 不共用一条队列。进程内串行不能替代 SQLite 多进程 writer fencing。

## Query 与通知

query 可以读取 Store 中尚未进入本进程 registry 的 Session，并通过 projector hydrate 订阅者。query 不凭空提交业务事件。App 注入 ownsSessionExecution 时，只发布本进程实际拥有的执行投影；不能把能读到的 Session 都视为本进程可取消对象。

验证：[mailbox](../test/session-mailbox.test.ts)、[持久命令](../test/persistent-command-host.test.ts)、[crash windows](../test/persistent-command-crash-windows.test.ts)、[notification](../test/notification-projector.test.ts)。
