# Runtime 访问对象与投影边界

本包提供跨实现的中立结构，不拥有执行、存储或 UI。入口：[commands](../src/commands.ts)、[queries](../src/queries.ts)、[notifications](../src/notifications.ts)、[projections](../src/projections.ts)、[validation](../src/validation.ts)。

| 对象 | 作用 | 消费者 |
| --- | --- | --- |
| Command | 请求业务变更，携带命令和目标身份 | Client → Server → RuntimeAccess/Host |
| Query | 读取当前投影或数据 | Client/Server/Host，不能顺带执行写操作 |
| Receipt | 命令接受、拒绝、冲突或重放结果 | Client 处理提交，不把 applied 当成整个任务完成 |
| Notification | 已确认事件或快照的传播 | 订阅者与客户端投影 |
| Client projection | 安全的会话、运行、交互及展示 DTO | TUI/CLI，不含 raw Store 句柄 |

新增字段需要检查真实 producer/consumer 和严格校验。不能通过 any 或继承 Service 内部类型让字段自动进入客户端。Kernel 的 State/Event、Runtime transport 与 Browser REST 各有边界，不是同一个 union 的别名。

准确字段以源码为准，语义变化同时检查 [Protocol](../../runtime-protocol/docs/wire-format.md)、[Client](../../runtime-client/docs/requests-and-history.md) 和真实 projector。验证：[contract tests](../test/)。
