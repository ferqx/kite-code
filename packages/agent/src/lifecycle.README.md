# Runtime 生命周期 owner

`AgentRuntime.getLifecycleState()` 同步采样本实例已有的接纳、派发、执行、后台操作和绑定清理事实。`tryBeginShutdown('if_idle' | 'cancel', { beforeResourceClose? })` 在同一个同步代码段内检查并封住新工作接纳。空闲关闭被拒绝时，实例继续接纳工作；请求成功时，返回的完成 Promise 与后续所有 `close()` 或关闭调用相同。此 API 仅供可信宿主使用，不向 Extension 提供关闭操作，也不定义 daemon 发现协议。

`runtime.ts` 中闭合的公开入口列表在首次 await 前登记已接纳的异步准备。写入和取消控制使实例处于 busy 状态。观察调用保护 Store/artifact 的寿命，不使空闲实例变为 busy；在 draining 期间，控制和观察仍可使用，直到最终资源接纳被封住。`waitForCommand` 以 `runtime_draining` 结束，不等待关闭流程已停止调度的工作。纯生命周期采样不读取 Store、不调用 Model、不选择 Provider，也不进行远端发现。

Session pump 在取得原 OS owner 前即计入派发工作，直到 owner 释放和绑定清理完成才移除登记。Extension 操作覆盖 detached Job 和重试，直到实际清理完成。Run 到达终态不意味着其保留的后台绑定已空闲。绑定清理失败或 Job 停止/清理未确认时，实例仍为 busy。停止或 handle 清理未确认的 Job 保留原 handle 和 permit；后续绑定清理失败不抹掉已经确认的释放事实。实现不新增第二个全局任务注册表，也不扫描同 profile 的全部 Session。

每个已派发 Job 额外保留一份原 Run 绑定，使其与实际 handle 和执行 permit 同寿命。停止未确认时，普通观察操作可以结束，但不会因此清理该绑定。停止确认且 handle 清理成功后，先释放 permit，再释放绑定；绑定 disposer 因而可以等待其 Workspace 资源协调器，不与后续 Job 清理形成循环。停止或 handle 清理失败时，保留该绑定和 permit。barrier 测试使用真实临时 Workspace OS 锁协调器，核对这一准确释放顺序。

cancel 路径封住新工作，并复用原 owner 范围内的清理链。封门前已接纳的 Command 可以留给仍存活的合法 owner 推进；接纳事实本身不能证明关闭实例拥有该执行。提交准备在实际接纳前再次检查封门状态。写入已经提交、响应仍在途时，保留其耐久 receipt，不因观察该事实的实例关闭就取消它。

本地任务、Extension、Job 和绑定排空后，首次请求捕获的 `beforeResourceClose` 回调让 Service 封住剩余 HTTP 读取/控制接纳，并等待自身在途资源使用者结束。随后 Runtime 封住剩余资源接纳，等待已接纳观察结束，最后关闭 artifacts 和 Store。重复请求不能替换或重复执行该回调。

只有资源关闭完成，状态才变为 `closed`。Job 清理未确认、绑定清理失败或宿主回调失败时，状态变为 `drain_failed`，保留底层 Store/profile 资源，并拒绝共享完成 Promise。宿主不能将该拒绝解释为实际进程退出，也不能因此释放 daemon 所有权。此独立入口不实现 daemon stop/restart 策略、endpoint 锁、HTTP 认证或失败关闭的重试/重置。

验证使用 [lifecycle.test.ts](../test/isolated/execution/lifecycle.test.ts) 中真实可丢弃的 SQLite Worker、固定本机模型和明确 barrier。unknown Job fixture 不含外部进程；只有在证明生产关闭失败和资源保留之后，测试收尾才显式关闭其原 Store。
