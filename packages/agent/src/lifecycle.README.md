# Runtime 生命周期 owner

Extension 的 `lifecycle.onRunStart/onRunEnd/onModelStart/onModelEnd` 是有限只读观察。Run start 从实际激活 ACK 发布，Model start 从派发准入 ACK 和取消复核之后、进入 adapter 前发布；end 只反映真实提交终态。start 回调不阻塞执行，恢复不重放原 Run start 或历史 Model。两个 `beforeRun/beforeRunComplete` 业务 Action 钩子只用于显式任务输入，不随内部 child 或自动 report 重入。顺序、命名与通知合同归[Agent 生命周期扩展](../README.md#生命周期扩展)。观察队列不持有运行绑定、执行许可或 Store 使用权，不计入 busy；Run 真实终态可先于其资源 disposer。关闭不等待观察 Promise，并在最终资源关闭前丢弃未交付项；观察错误不能令已经确认的任务或资源关闭变成失败。可靠业务工作仍走原 Action/Job，与普通资源清理门禁保持分离。

`AgentRuntime.getLifecycleState()` 同步采样本实例已有的接纳、派发、执行、后台操作和绑定清理事实。`tryBeginShutdown('if_idle' | 'cancel', { beforeResourceClose? })` 在同一个同步代码段内检查并封住新工作接纳。空闲关闭被拒绝时，实例继续接纳工作；请求成功时，返回的完成 Promise 与后续所有 `close()` 或关闭调用相同。此 API 仅供可信宿主使用，不向 Extension 提供关闭操作，也不定义 daemon 发现协议。

`runtime.ts` 中闭合的公开入口列表在首次 await 前登记已接纳的异步准备。写入和取消控制使实例处于 busy 状态。观察调用保护 Store/artifact 的寿命，不使空闲实例变为 busy；在 draining 期间，控制和观察仍可使用，直到最终资源接纳被封住。`waitForCommand` 以 `runtime_draining` 结束，不等待关闭流程已停止调度的工作。纯生命周期采样不读取 Store、不调用 Model、不选择 Provider，也不进行远端发现。

Session pump 在取得原 OS owner 前即计入派发工作，直到 owner 释放和绑定清理完成才移除登记。Extension 操作覆盖 detached Job 和重试，直到实际清理完成。Run 到达终态不意味着其保留的后台绑定已空闲。绑定清理失败或 Job 停止/清理未确认时，实例仍为 busy。停止或 handle 清理未确认的 Job 保留原 handle 和 permit；后续绑定清理失败不抹掉已经确认的释放事实。实现不新增第二个全局任务注册表，也不扫描同 profile 的全部 Session。

原根 Session 有本实例 hot operation 时，其已登记的 accepted-command 轮询资格保留，即使当前列表为空；peer 的新申请仍通过原 pump 和 Store owner/generation、未提交 Action检查。operation 实际清理后，后继空列表才释放该轮询登记。它沿已有有限 pendingSessions/operationSessions，不把冷 unknown 变成 hot，也不放宽关闭或资源许可。准确根 Session intake与有限资格由[Runtime owner](../README.md)和[原交接反例](../test/isolated/execution/owner-handoff.test.ts)维护。

每个已派发 Job 额外保留一份原 Run 绑定，使其与实际 handle 和执行 permit 同寿命。停止未确认时，普通观察操作可以结束，但不会因此清理该绑定。停止确认且 handle 清理成功后，先释放 permit，再释放绑定；绑定 disposer 因而可以等待其 Workspace 资源协调器，不与后续 Job 清理形成循环。停止或 handle 清理失败时，保留该绑定和 permit。barrier 测试使用真实临时 Workspace OS 锁协调器，核对这一准确释放顺序。

Tool 的失败、拒绝、adapter 异常和已落定 unknown 不结束 Agent Loop；原 Execution 与配对结果提交后，下一 Model 可以解释，五次同参失败也不触发 Run 取消。adapter 返回值先在其异常边界内脱离原引用为纯JSON快照，循环、BigInt、非有限值、accessor和可执行toJSON等非法结果准确结算为已尝试执行的unknown；不调用getter／toJSON，也不让序列化错误冒充Store失败。人工 deny 只停止本批后继效果，不等同用户取消。回复 Run completed 不解决原 unknown，也不证明后台 Job 已停止；准确 Run 内活动执行及 Model／Job unknown 的完成约束、仍活 Job 的 permit／binding、busy／drain_failed 和关闭门禁继续独立执行。原终态保存失败或 authority 损坏不能由 Loop 补造结果。

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

## 浏览器代码 Job 与 Run 收口

[browser.execute](tools/browser/execute.ts) 的持续代码环境由原 `browser.code_session` Job 持有 process slot 和 Run binding，同 Run 批次在 leaf 内排队；网页动作仍创建独立 child Tool／Operation，浏览器 daemon／页面租约仍归 `browser.session`。内部 generation、seq 和 key 留在宿主，代码环境不能用旧 JS 变量或冷记录恢复控制权。隔离平台、预算与正式图像通道的完整边界归[Browser owner](tools/browser/README.md#统一执行入口与隔离环境)。

Core 从 [ExecutionResources](execution/resources.ts) 将冻结总容量注入 `ToolContext.resourceCapacity`，不报告当前空闲许可或签发权限。统一 Browser 执行在创建环境和申请 Job 前要求 process 总容量至少 2；容量 1 准确返回 `browser_resource_capacity_unavailable`，代码 Job、Browser Job 和进程均不启动，模型仍可说明失败。容量足够时保留原排队和取消，不释放仍活进程的许可来凑容量。

代码 Job 每 250ms 只读核准确原 Run 是否仍活动，终态或失去该范围时关闭环境；这是原 Job 的资源监督，不是 onRunEnd 业务钩子。Job 停止后释放原 permit／binding，最终配置 disposer 再做幂等兜底，避免 Job 等 disposer、disposer 又等 Job 的循环。模型没有打开页面或忘记显式 close，也不能让已结束 Run 永久保留代码进程。对准确已取得且仍由本次持有的 Agent 页面请求交还，Main 原页面按其 owner 保留；人工接管／交接的预约不因代码环境结束而被错误撤销。

收口先封住新 API 并停止代码，同时取消准确在途 Tool 与已保存的 Browser Job 申请；包括尚等 process slot、首次 snapshot 尚未返回页面句柄的申请，不能在本批失败之后迟到启动。清理读取原 Operation 的终态，不使用已经取消的 Tool signal 继续普通 wait。原 child 的真实 Execution／outcome 回填批次，未知效果优先保留，取消不改称普通派发失败。代码进程停止、host 调用达到终态、网页效果和 Browser 进程监督分别归属；原 Browser Job 的 unknown 及资源保留不由代码 Job 的结束覆盖。

代码环境还按 Core 冻结的总容量对象共享叶内准入票据，上限为 `floor(process/2)`；它只避免多个代码 Job 相互占满所有进程槽，不代替或释放实际 Core permit。同 Run 多批共一票，等待可取消，代码与 host 调用清理确认后才归还；代码关闭未知保票，已经结束的业务 unknown 不被扩成跨会话新 fence。

原 `browser.open` 返回后，代码环境等待准确 Browser Job 的授权、资源准入和 controller 身份，不另设 5 秒页面句柄超时；原真实启动期限、取消和原 Job 失败／unknown 保持。实际失败交回原引用，拒绝不降级路径，排队取消不能迟到启动。

[Runtime 因果回归](../test/isolated/browser/execute.test.ts)覆盖无页面及遗漏 close 的普通完成、并行代码批次、首次观察失败、单 process 总容量不可用、容量 2 加外部占位的排队取消、超过 5 秒原审批等待和实际输入派发期间取消；底层死循环／父死亡边界由[执行器回归](../test/isolated/browser/executor.test.ts)验证。模型、Native 窗口、物理输入和普通构建的资格沿[Desktop owner](../../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)，不由这些 Runtime／OS leaf 测试补齐。

## 活动 Run 的有限控制响应

可信 `ActionDefinition.runControl` 是宿主代码声明，公共命令不能添加。Runtime在已有热Run的准确Store/Session/owner下登记并保留原owner，按owner串行派发这些有限Action；最多32条本实例在途控制申请，未确认清理仍封门。每条继续原Action准备、新鲜度、权限、持久command/execution与取消流程，nested Tool不能借此伪装独立人工来源。普通Action仍进入Session pump，不是所有Action并发，也不是新的后台轮询器。

控制Action不得申请slot/serial资源，不能 `operations.ensure`、取消/重启其它operation或发起Question；仅可读/等待已有operation和写自己的扩展记录。关闭先abort准确在途控制，再与原任务一起排空并释放owner。现有 `readWorkEligibility` 只读既有work-control证据，不取得新的派发权限。跨Runtime/peer intake的主动控制尚未取得资格。

[宿主缩权接缝](execution/host-control.ts)只认可信内置代码登记并冻结的 handoff、close 或 `respond_human(choice=stop)` 对象；同名 Action、对象展开副本或公共 `runControl` 标记不能取得这项准入。Core 封存定义时继承原登记，准备输入冻结后才使用准确缩权授权，因而停止不受普通业务审批等待阻塞。原主体、Store／Session／owner、Action 输入与页面 generation 校验仍执行；continue、resume 和网页业务写入继续走原权限。

同 owner 控制队列中，准确缩权可以先取消尚未派发的同页 resume／human continue，随后排空原队列再执行停止。人类 Stop 还须匹配原 requestId／revision；已派发、目标变化或身份不符不借此重放或扩大停止范围。该接缝不把既有控制 Action 变成通用并发执行入口。[真实 Runtime／SQLite 替身回归](../test/isolated/browser/host-revocation.test.ts)覆盖审批与 Question 等待中的停止、pending continue 抢占、冻结输入、同名伪装和旧 generation 拒绝。

[Browser 真实 Runtime mock](../test/isolated/browser/human-async-runtime.test.ts)核原模型继续无关工作时的人类回应、主动接管、普通 Action 仍串行和禁止新工作；Browser 的有限请求／Job／通知均归[Browser owner](tools/browser/README.md)，Core 不接管页面 owner 或新增 Browser 业务表。此处只说明当前代码与受控验证边界，最终实机／模型资格沿 Desktop owner 核实。
