# 身份、状态与数据归属

Session、Run、Command、Execution、Job、连接和展示分别标识不同事实。准确类型和事务归 [Agent Store](../../../packages/agent/src/storage/README.md)及其[具名端口](../../../packages/agent/src/storage/port.ts)，公开投影归 [Service](../../../apps/service/README.md)与 [Client](../../../packages/client/README.md)。

| 对象 | 当前归属与含义 |
| --- | --- |
| Profile / Store | 明确的数据范围与持久来源；新 Store 不重标旧申请 |
| Session | 持久会话及创建主体、Workspace 范围，不随页面或连接消失 |
| Command | 原完整请求与稳定 ID；accepted、applied、业务结果分别核实 |
| Run | 原任务与后续输入的工作生命周期，不用页面 loading 代替 |
| Execution / Job | 真实模型、工具或后台资源的执行与结果，保留原来源和取消域 |
| Client generation / read generation | 限定当前连接或读取所属范围，不能生成执行权限 |
| Message / UI row | 原业务事实的投影；相同正文或近似时间不证明相同输入 |

发送前由调用者保存原意图；传输丢失后只查询原 Command，不换 ID 重发。Service、Client 和 UI 必须保留准确 Store/Session/Workspace 与读代次，迟到结果归原申请，不能覆盖后来选择。

活动持久 Run 不等于当前存在有效执行 owner。重连时读取、明确会话核实、原任务恢复与新任务派发各有边界；[会话状态核实](../../../packages/agent/src/storage/sqlite/run-resume.README.md)在准确 owner 锁与事务内结算 owner 丢失事实，不自动重放工具。`outcome_unknown` 不因重新连接、另一个窗口或查询成功而降级为失败或成功。

当前会话视图是有界投影，原消息、完整结果、来源与历史游标分别读取。分页须固定上界、核前进和身份；SSE 通知不代替完整业务历史或结果接纳证明。跨客户端显示和真实 owner 结算应分别验证，不能从一次订阅成功推导所有进程实时一致。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/architecture/identities-state.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
