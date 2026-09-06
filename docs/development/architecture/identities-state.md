# 身份、状态与数据归属

本页解释对象之间的关系，不复制其完整字段。字段定义分别在 Kernel、Runtime contract、SPI 和 Storage。

| 对象 | 用途 | 决定/保存者 | 常见误解 |
| --- | --- | --- | --- |
| Workspace | 信任与执行范围 | Service 准入、Store 记录 | 不是必然一个进程或数据库 |
| Session | 可继续的历史与状态 | Store/Kernel，Host 协调 | 不是窗口或 transport connection |
| Task | 目标、计划与完成关系 | Kernel/运行事实 | 不等于 Markdown 仓库计划 |
| Run / Turn | 执行与输入推进的准确身份 | Service/Host/Kernel/Store 各在规定边界处理 | 正文显示完不意味着 Run 已结束 |
| Command | 一次请求及幂等范围 | Client 提供、Host 复核持久回执 | wire requestId 不能替 commandId |
| Attempt / Effect | 外部执行尝试及结果状态 | Host 组织、Store 持久、Builtin 执行 | retry 不代表可以重复副作用 |
| Interaction | 审批/问答/审核身份 | Kernel facts、Store、client-safe projection | 面板消失不构成已批准 |
| Connection generation | 当前连接有效性 | transport/client | 不能授予 Session writer |
| Message / Step | 展示事实对应 | 持久 identity 与 client projector | 不按正文或工具名去重 |
| RenderEpoch | 物理视图重绘边界 | TUI | 不改变业务 Run 或权限 |

## 状态如何配合

持久事件/快照记录业务事实，Run 索引支持查询，writer generation 防止旧进程提交；客户端只维护交互与显示所需投影。TUI pending echo、输入队列、Web 页面状态和连接状态不自动成为新的业务事实。

收到迟到事件时先检查它所属的 identity 与 revision，再决定是否更新。不能用“当前会话”“最后一个块”或相同文本补足缺失身份。

数据关系深入[Storage 事务](../../../packages/runtime-storage-sqlite/docs/transactions-and-state.md)，显示身份深入[TUI 投影](../../../apps/kite-cli/docs/message-projection.md)，请求身份深入[Host 命令](../../../packages/runtime-host/docs/commands-mailbox.md)。
