# Server 准入与订阅

入口：[server](../src/server.ts)、[in-process adapter](../src/in-process.ts)。Runtime Server 依赖中立 RuntimeAccess，由 Service 注入业务执行与准入；不是第二个 Runtime owner。

先校验协议/初始化状态和绑定范围，再把 command/query 交给 RuntimeAccess。冻结连接上下文沿 inspect/commit 传递，不允许从请求体或 Session 再猜另一份身份。Server 不分配业务 writer authority。

订阅向客户端传递安全通知；连接关闭释放对应订阅资源，不删除 Session。恢复连接后的 snapshot/replay 遵循当前协议边界，不能恢复 raw event 漏洞或代替完整 History API。

carrier 决定 stdio/socket/WebSocket framing，Server 不因 transport 不同改变 Kernel 调度与 Store 提交逻辑。拒绝与不可用必须明确返回，不能以空快照掩盖错误。initialize、command、query 和 subscribe 均保留 admission 分类：授权拒绝使用 `unauthorized`，基础设施不可用使用现有 `internal_error` 与 `detailCode=temporarily_unavailable`，消息为 `Runtime admission unavailable`。两者都不调用 Runtime backend；没有新增自动命令重放。

验证：[runtime-server tests](../test/runtime-server.test.ts)。业务命令提交顺序见[Host](../../runtime-host/docs/commands-mailbox.md)。
