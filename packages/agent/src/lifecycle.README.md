# Runtime 生命周期 owner

`AgentRuntime.getLifecycleState()` 同步采样本实例已有的接纳、派发、执行、后台操作和绑定清理事实。`tryBeginShutdown('if_idle' | 'cancel', { beforeResourceClose? })` 在同一个同步代码段内检查并封住新工作接纳。空闲关闭被拒绝时，实例继续接纳工作；请求成功时，返回的完成 Promise 与后续所有 `close()` 或关闭调用相同。此 API 仅供可信宿主使用，不向 Extension 提供关闭操作，也不定义 daemon 发现协议。

`runtime.ts` 中闭合的公开入口列表在首次 await 前登记已接纳的异步准备。写入和取消控制使实例处于 busy 状态。观察调用保护 Store/artifact 的寿命，不使空闲实例变为 busy；在 draining 期间，控制和观察仍可使用，直到最终资源接纳被封住。`waitForCommand` 以 `runtime_draining` 结束，不等待关闭流程已停止调度的工作。纯生命周期采样不读取 Store、不调用 Model、不选择 Provider，也不进行远端发现。

Session pump 在取得原 OS owner 前即计入派发工作，直到 owner 释放和绑定清理完成才移除登记。Extension 操作覆盖 detached Job 和重试，直到实际清理完成。Run 到达终态不意味着其保留的后台绑定已空闲。绑定清理失败或 Job 停止/清理未确认时，实例仍为 busy。停止或 handle 清理未确认的 Job 保留原 handle 和 permit；后续绑定清理失败不抹掉已经确认的释放事实。实现不新增第二个全局任务注册表，也不扫描同 profile 的全部 Session。

原根 Session 有本实例 hot operation 时，其已登记的 accepted-command 轮询资格保留，即使当前列表为空；peer 的新申请仍通过原 pump 和 Store owner/generation、未提交 Action检查。operation 实际清理后，后继空列表才释放该轮询登记。它沿已有有限 pendingSessions/operationSessions，不把冷 unknown 变成 hot，也不放宽关闭或资源许可。准确根 Session intake与有限资格由[Runtime owner](../README.md)和[原交接反例](../test/isolated/execution/owner-handoff.test.ts)维护。

每个已派发 Job 额外保留一份原 Run 绑定，使其与实际 handle 和执行 permit 同寿命。停止未确认时，普通观察操作可以结束，但不会因此清理该绑定。停止确认且 handle 清理成功后，先释放 permit，再释放绑定；绑定 disposer 因而可以等待其 Workspace 资源协调器，不与后续 Job 清理形成循环。停止或 handle 清理失败时，保留该绑定和 permit。barrier 测试使用真实临时 Workspace OS 锁协调器，核对这一准确释放顺序。

cancel 路径封住新工作，并复用原 owner 范围内的清理链。封门前已接纳的 Command 可以留给仍存活的合法 owner 推进；接纳事实本身不能证明关闭实例拥有该执行。提交准备在实际接纳前再次检查封门状态。写入已经提交、响应仍在途时，保留其耐久 receipt，不因观察该事实的实例关闭就取消它。

正常写锁竞争不阻断本机停止信号。新取消意图先只读排除已存在的command ID，再仅对本实例准确Store/主体/Session/目标的live handle收缩；background子树还核root/Workspace祖先，查询失败不扩域，也不阻止原耐久取消事务核实。API仍等待真实取消ACK；本地abort不证明耐久成功或外部效果已停止，失败沿原未确认结果保存。旧取消ID重放不能停止后来启动的工作，`execution.cancel`仍只停止原Execution，根Run可接收该取消结果正常收尾。shutdown在等已接纳写入之前先停止本实例准确handle，但原写入、效果和清理仍须完整排空。[真实写锁取消回归](../test/isolated/execution/cancel-writer-wait.test.ts)核提前signal、尚无durable标记、错误身份与旧ID重放。

本地任务、Extension、Job 和绑定排空后，首次请求捕获的 `beforeResourceClose` 回调让 Service 封住剩余 HTTP 读取/控制接纳，并等待自身在途资源使用者结束。随后 Runtime 封住剩余资源接纳，等待已接纳观察结束，最后关闭 artifacts 和 Store。重复请求不能替换或重复执行该回调。

只有资源关闭完成，状态才变为 `closed`。Job 清理未确认、绑定清理失败或宿主回调失败时，状态变为 `drain_failed`，保留底层 Store/profile 资源，并拒绝共享完成 Promise。宿主不能将该拒绝解释为实际进程退出，也不能因此释放 daemon 所有权。此独立入口不实现 daemon stop/restart 策略、endpoint 锁、HTTP 认证或失败关闭的重试/重置。

macOS Store close 现另等原 Worker 的 Mach 权终态及准确释放，SQLite ACK 与线程停止分开核实。原身份、终态或释放未确认同样使共享关闭失败并保原 Profile 锁；详细职责和跨平台未知归[Store owner](storage/README.md#store-关闭未确认时的锁归属)，不把这个局部线程事实当作完整 Runtime 资源资格。

默认普通 Web Tool的解析资源也通过[Agent Web binding](tools/web-fetch/README.md)归属原 Run disposer。Tool已保存 outcome_unknown、permit已释放时，原 scope清理失败仍保 Run binding lease，关闭返回 `shutdown_cleanup_unconfirmed`并进入 `drain_failed`，不能提前关闭Store或交接维护锁。该接线复用既有生命周期检查；被动配置准备不取得Web parser scope。

配置返回前，可信producer若确实取得资源且清理失败，使用公开 `ConfigurationPreparationCleanupError({originalError,cleanupError,resources})` 明确交接。非枚举cause保两种原错误及实际资源引用；Runtime不从任意Error.cause猜所有权。根／follow-up、child、Run resume、report recovery和Job reconcile五处resolver接收该类型；配置已返回后验证或SQL启动失败，其disposer失败由准确接收者组成同一交接。失败沿原配置清理预约集合强保，返回缓存拒绝，shutdown不重试宿主disposer；单一准备清理失败事实进入已有busy/drain门禁，原恢复lease／owner保留，不伪造Run或建立另一资源registry。普通配置拒绝且清理成功仍可正常关闭。

[返回配置回归](../test/isolated/execution/preparation-cleanup.test.ts)用真实Files／SQLite核失败与健康同一校验场景；[完整Service准备回归](../../../apps/service/test/isolated/preparation-cleanup-ownership.test.ts)核实际standalone目录、原必选Skill错误、原JavaScript close拒绝、零Model／Run／Execution、活进程维护拒绝和所属进程退出后的完整冷读。fixture手工清理不是Runtime成功；源码测试可三端执行，本机结果不授全资源观测、临时I/O全部失败边界或Win/Linux原生资格。

[三个显式恢复入口](../../../apps/service/test/isolated/recovery-preparation-ownership.test.ts)另直接核 Run resume／report recovery／Job reconcile 返回前的实际准备资源失败：原 lease／Session owner 在关闭拒绝之后仍保留，独立 Store 的抢占被拒绝。Run resume 和 Job reconcile 已接纳恢复 Command，report 尚未提交新 Command；原执行、消息、交互及 report 保持，恢复 Model 与 adapter 零重放。关闭失败不等于进程退出；所属进程真实 0 与 stdout／stderr EOF 后才核维护和完整冷记录。

验证使用 [lifecycle.test.ts](../test/isolated/execution/lifecycle.test.ts) 中真实可丢弃的 SQLite Worker、固定本机模型和明确 barrier。unknown Job fixture 不含外部进程；只有在证明生产关闭失败和资源保留之后，测试收尾才显式关闭其原 Store。Store strict-close 未确认时的原锁交接与 owned child 实际退出后的维护／冷读见 [Store owner](storage/README.md#store-关闭未确认时的锁归属)；该失败不能因 terminate 请求被提升为资源已关闭。
