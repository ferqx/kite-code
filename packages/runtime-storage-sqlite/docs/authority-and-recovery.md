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

## Store 维护准入

正常 Store owner 生命周期持有共享维护锁，维护者使用独占锁。POSIX 为固定文件 inode 上的 flock；Windows 为 LockFileEx，由 Service 注入已有路径 DACL 校验。关闭和进程退出释放，固定锁文件不删除。Windows 真机资格仍待验证。该锁只协调参与协议的版本，不替代 session execution fence、数据库事务或停掉历史 writer 的证明。

## 格式边界

[文件打开](../src/kite-session-runtime-file.ts)、[兼容读取](../src/compatibility.ts)和[迁移](../src/migration.ts)分别限定当前 writer 与支持的历史来源。普通读取不建立第二 writer，不对未知格式猜测修复，不把历史身份合成当成真实当前授权。

规范见[App Server 与持久会话](../../../docs/active/app-server-local-runtime.md)、[恢复边界](../../../docs/active/runtime-authority-boundary.md)。验证：[authority](../test/isolated/kite-session-execution-authority.test.ts)、[effects](../test/kite-session-effects.test.ts)、[run recovery](../test/run-recovery.test.ts)。

## 清理确认与恢复命令

同一服务失权后先等待本地执行清理，再用原 generation 对应的新 authority revision 确认 cleanup；确认后仍保持 recovery_required，普通读取不解除保护。没有完成的 Provider 生命周期或仍 dispatching 的模型不能形成确认。明确恢复使用 commitRecoveryDecision，在同一 writer 事务内核对 authority revision、业务 revision、cleanupConfirmed 和 effect 状态；仅改变执行权并保存命令回执，不改业务快照、事件或旧结果。过期请求拒绝，回执可只读查询。无第二份恢复状态、启动扫描或格式兼容分支。

验证：[恢复事务测试](../test/isolated/kite-session-runtime-storage.test.ts)、[Service 生命周期测试](../../../apps/kite-service/test/isolated/runtime-server-multi-workspace.test.ts)。


## 离线转换子步骤（尚未接入自动启动）

[Store 9专属转换](../src/kite-session-store9-conversion.ts)只接受已知旧格式子集；调用者负责备份、旧writer停写及独占维护。它在同一事务内保留原业务内容与旧authority记录，改变效果表与格式身份，并建立保守的新执行权。旧idle不代表cleanup；State未就绪或存在queued/running/waiting Run时仍进入recovery_required。转换不重放Run、不授予waiver、不确认未知外部结果。

[已知格式恢复备份](../src/kite-session-recovery-backup.ts)生成包含已提交WAL数据的私有恢复资产，使用完整逐表保留清单验证，完成后持久化ready清单。它不切换正常入口、不自动恢复旧数据时间点，也不承诺外置工作区文件全部在SQLite备份中。备份支持精确9/10/11布局；Windows恢复备份仍待真机资格。启动准备已接入Service组合，四源隔离演练通过，本机原用户四源已收敛且185条历史经正式客户端打开；更广发行/平台资格仍未完成。


[可恢复发布](../src/kite-session-store-publication.ts)在所有源独占锁与Service旧writer准入下归档原位main/WAL/SHM，发布已验证候选。短期正式意图优先于正常打开；重启仅接续经指纹验证的阶段，不覆盖不明新数据。发布后reader拒绝保留意图。恢复备份可以借用一个真实、仍存活、同路径的独占token；结构伪造、已释放及共享token均不能借用。

发送路径可通过 `reconcileSettledSession` 核验遗留恢复标记：同一 writer 事务内核对 authority revision、无 owner／lease、无 prepared／unknown effect、无 active／unknown Run，以及调用方的完整终态谓词。只对 State 与 terminalOutcome 均 completed、恢复正常且无待验证事实的会话确认 cleanup，随后由既有 acquire 取得执行权；首次 acquire 刚将过期 owner fence 的情况使用相同核验。原事件、快照、旧 Run 和工具失败记录均不改写，不扫描启动历史，不重放旧操作。

`beginRecoveryExecution` 是 Service 的受控恢复写入口：仅接受已 fenced 的 recovery_required authority，在同一 writer 事务检查 revision、无 owner／lease，保留旧 unknown effect、将前代 prepared effect 标 unknown，并取得 cleanupConfirmed=false 的新代际。该 scope 用于持久化资源核对与旧执行终态，不能新派发；完成后按真实 cleanup 结果释放，失败则回到 recovery_required。它不代表确认外部结果成功，也不建立第二份会话或数据库。
