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

后台执行列表的`aggregateGeneration`属于组合目录；每项`ownerGeneration`和`revision`属于其原生执行owner。
列表和单项同时携带读取时的`sessionRevision`，它才是`stop_background_execution.expectedRevision`的来源。
组合目录generation、执行owner generation、执行revision都不能充当Session CAS。

活动 Run 可投影 `waitingReason={ kind: required_background, taskIds }`。它说明当前 Run 因哪些 required task 等待，
不复制 task 的 running／terminal 生命周期，也不成为完成 authority；客户端仍从后台执行投影读取每个 task 的真实状态。
该字段只允许出现在 `status=waiting` 的当前 Run，task ID 必须非空且唯一。客户端用它区分等待后台结果与模型持续思考，
不能据此锁定输入或推导 child 成功。


主工具审批展示使用 `tool.review` 的 toolId／reviewId／status／有界 summary；`approval.granted.grant` 可选地保留 approve_once／same_command。二者经过同一 Protocol allowlist 进入 live 和历史回放，缺失 grant 不推导授权范围，不接收原始 reviewer result 或模型身份。具体字段见 [notifications](../src/notifications.ts)。

恢复契约提供只读 `get_session_recovery` 摘要（authority revision、清理确认、effect 计数与有界 identity、允许操作）与显式 `recover_session`（同时绑定业务和 authority revision）。`get_command_receipt` 携带原命令和 scope，只查询已提交回执，不执行原命令。错误区分 runtime_busy、session_cleanup_pending、session_recovery_required、external_outcome_unknown 和 storage_unavailable；消费者不能解析错误字符串决定恢复。

Ask 的 input interaction 可携带只读 toolCallId 归属；input.answered 可携带 1–3 个 question ID 对应的答案。两者仅供客户端合并重复工具记录和还原问答展示，不改变交互提交的 revision 校验或授权规则。
