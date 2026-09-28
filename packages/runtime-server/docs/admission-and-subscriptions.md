# Server 准入与订阅

入口：[server](../src/server.ts)、[in-process adapter](../src/in-process.ts)。Runtime Server 依赖中立 RuntimeAccess，由 Service 注入业务执行与准入；不是第二个 Runtime owner。

先校验协议/初始化状态和绑定范围，再把 command/query 交给 RuntimeAccess。冻结连接上下文沿 inspect/commit 传递，不允许从请求体或 Session 再猜另一份身份。Server 不分配业务 writer authority。

订阅向客户端传递安全通知；连接关闭释放对应订阅资源，不删除 Session。恢复连接后的 snapshot/replay 遵循当前协议边界，不能恢复 raw event 漏洞或代替完整 History API。
`runtime/unsubscribe` 可按已确认的 `subscriptionId`，也可按同一 logical connection 上原始 `runtime/subscribe` 的 `subscribeRequestId` 脱离。后一种形式在准入或初始投影仍待完成时，Server 立即释放订阅名额与请求计数、停止已取得的 iterator，并让等待中的 Server 请求任务结束；即使 App 准入或投影查询一直不返回，也不会保留该请求 ID。迟到的结果不能确认或启动已脱离的订阅；若确认已经排队，后续仍不启动它。logical connection 关闭执行相同的待处理请求清理。这两种脱离只清理通知资源，不发送 `cancel_turn` 或停止 Session 执行。
`child_session` 订阅须由 Service 准入先核验父子血缘及工作区；Server 只在核验通过后映射为既有的子 Session 事件流，并从父作用域投影查询建立初始水位。直接以子 ID 发起普通 `session` 订阅仍被拒绝。
订阅名额在鉴权前预留，等待鉴权的请求也计入连接和全局上限；鉴权失败、异常、连接关闭或 drain 开始都会阻止新订阅并释放名额。同一订阅的重复关闭等待同一次 iterator 清理并观察同一失败。关闭时先释放连接计数并关闭 carrier，再等待 Host iterator 清理。drain 的超时覆盖订阅、outbound 和连接关闭；超时返回错误，不能视作 iterator 已完成清理。

carrier 决定 stdio/socket/WebSocket framing，Server 不因 transport 不同改变 Kernel 调度与 Store 提交逻辑。拒绝与不可用必须明确返回，不能以空快照掩盖错误。initialize、command、query 和 subscribe 均保留 admission 分类：授权拒绝使用 `unauthorized`，基础设施不可用使用现有 `internal_error` 与 `detailCode=temporarily_unavailable`，消息为 `Runtime admission unavailable`。两者都不调用 Runtime backend；没有新增自动命令重放。

验证：[runtime-server tests](../test/runtime-server.test.ts)。业务命令提交顺序见[Host](../../runtime-host/docs/commands-mailbox.md)。
