# Writer fencing、Effect 与恢复

执行资源生命周期及按需恢复由 Service 协调，Store 保持唯一持久执行权与事务边界。

入口：[execution authority](../src/kite-session-execution-authority.ts)、[effects](../src/kite-session-effects.ts)、[Session storage](../src/kite-session-runtime-storage.ts)。

## 身份与写权限

controllerGeneration 与 authority revision 描述持久执行所有权；PID、连接和进程 registry 不能替代它。App 获取/续租/释放 authority，再绑定 execution handle。mutation 与 effect dispatch 在自己的边界重新校验，不信任调用者曾经成功的旧检查。

同一 profile 可以有多个连接读取；同一 Session 的执行 writer 必须满足 generation fence。takeover 后旧句柄不能继续 dispatch 或 commit。

## 恢复顺序

冷会话权限设置允许在 idle 或 recovery_required 下提交无执行资源的决定，具体约束见[事务提交](transactions-and-state.md)。它不取得或释放执行权，不确认 cleanup；active／detached owner 仍阻断该入口。

recovery.inspect 只读 authority、pending 与 unknown effects；reconcile 绑定预期 authority revision，并返回需要处理的 unknown effects。无完整结果的操作不能标记成“没有执行”。Kernel/Host 根据这些 facts 决定继续、拒绝或要求处理，SQLite 不自行重跑 Provider。

进程退出、连接中断、业务取消和会话删除是不同事件。删除需要防止迟到写入复活数据，回执与 tombstone 的保留按各自语义处理。

## 格式边界

[文件打开](../src/kite-session-runtime-file.ts)、[兼容读取](../src/compatibility.ts)和[迁移](../src/migration.ts)分别限定当前 writer 与支持的历史来源。普通读取不建立第二 writer，不对未知格式猜测修复，不把历史身份合成当成真实当前授权。

规范见[App Server 与持久会话](../../../docs/active/app-server-local-runtime.md)、[恢复边界](../../../docs/active/runtime-authority-boundary.md)。验证：[authority](../test/isolated/kite-session-execution-authority.test.ts)、[effects](../test/kite-session-effects.test.ts)、[run recovery](../test/run-recovery.test.ts)。

## 清理确认与恢复命令

同一服务失权后先等待本地执行清理，再用原 generation 对应的新 authority revision 确认 cleanup；确认后仍保持 recovery_required，普通读取不解除保护。没有完成的 Provider 生命周期或仍 dispatching 的模型不能形成确认。明确恢复使用 commitRecoveryDecision，在同一 writer 事务内核对 authority revision、业务 revision、cleanupConfirmed 和 effect 状态；仅改变执行权并保存命令回执，不改业务快照、事件或旧结果。过期请求拒绝，回执可只读查询。无第二份恢复状态、启动扫描或格式兼容分支。

验证：[恢复事务测试](../test/isolated/kite-session-runtime-storage.test.ts)、[Service 生命周期测试](../../../apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts)。
