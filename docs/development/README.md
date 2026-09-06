# 开发入口

这里提供两条路径：学习项目从架构逐层深入；完成任务从症状或功能直接进入负责模块，只在发现跨层影响时扩读。产品预期见[产品手册](../handbook/README.md)。

## 解决当前问题

| 任务或症状 | 先读的产品定义 | 技术入口与验证 |
| --- | --- | --- |
| 切换会话后串消息 | [会话](../handbook/clients/tui/guides/sessions.md) | [导航与加载竞态](../../apps/kite-cli/docs/session-navigation.md) |
| 回答重复、完成后仍刷新 | [对话](../handbook/clients/tui/guides/conversation.md) | [消息投影](../../apps/kite-cli/docs/message-projection.md)、[终端输出](../../apps/kite-cli/docs/terminal-output.md) |
| Web 内容不更新 | [更新条件](../handbook/clients/web/guides/updates-and-connection.md) | [REST 更新](../../apps/kite-web/docs/data-and-updates.md)、[页面生命周期](../../apps/kite-web/docs/routing-and-lifecycle.md) |
| 模型选择与实际请求不同 | [设置生效](../handbook/clients/tui/guides/models-and-settings.md) | [模型与上下文](../../packages/builtin-runtime/docs/model-and-context.md)、[Service 配置](../../apps/kite-service/src/config/index.ts) |
| 审批后工具状态异常 | [交互](../handbook/clients/tui/guides/approvals-and-questions.md) | [交互链路](flows/interactions.md)、[客户端提交](../../apps/kite-cli/docs/approvals-and-interactions.md) |
| 取消后仍执行或重复执行 | [取消与恢复](../handbook/features/recovery.md) | [取消链路](flows/cancellation-recovery.md)、[Host lifecycle](../../packages/runtime-host/docs/execution-lifecycle.md) |
| 新增工具 | [工具语义](../handbook/features/tools-and-approvals.md) | [声明到执行](../../packages/builtin-runtime/docs/tool-pipeline.md) |
| 修改存储或恢复 | [历史与恢复](../handbook/features/sessions.md) | [事务](../../packages/runtime-storage-sqlite/docs/transactions-and-state.md)、[authority/recovery](../../packages/runtime-storage-sqlite/docs/authority-and-recovery.md) |
| 行为不变的内部重构 | 核对实际受影响行为，不强制修改手册 | 所属 workspace 的模块文档与测试；[同步核对](documentation.md#规则归属与执行入口) |
| 一个研发阶段交付、还有剩余工作 | 仅同步已交付功能 | [当前事实与设计状态](documentation.md#当前事实与设计状态)、[研发计划](../plans/README.md) |

每个技术专题继续链接实际源码与测试。文档不能回答时检查实际 producer/consumer，不从历史方案补齐推测。

## 系统学习

1. [本地运行与验证](local-development.md)。
2. [架构与运行机制](architecture.md)：组成、依赖、身份与状态。
3. 追踪[一次任务](flows/task-execution.md)，再按问题阅读模型、交互、历史、取消及 Web 链路。
4. 进入[Kernel](subsystems/kernel.md)、[会话](subsystems/sessions.md)、[模型](subsystems/model-context.md)、[工具](subsystems/tools.md)、[授权](subsystems/security.md)、[存储](subsystems/storage.md)、[客户端](subsystems/clients.md)；沿链接深入 workspace 内的实现机制。

## 查询与维护

[跨包契约目录](subsystems/contracts.md) · [测试体系](../../tests/README.md) · [文档同步](documentation.md) · [有效计划](../plans/README.md) · [运行排障](../runbooks/agent-production-incident.md)。

局部任务从上表进入对应段落、负责模块与测试；发现跨层影响后再扩读。影响映射是核对候选，不是整批必读清单。完成时按[文档同步](documentation.md#规则归属与执行入口)定位规则，已读内容与验证结果的复用由现有 Skill 判断。
