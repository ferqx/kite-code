# 开发入口

运行中引导、受管后台 Shell/service 与后台子 Agent 的产品行为见[执行与结果](../handbook/features/execution.md)；命令、投影、恢复与客户端合并语义分别由 Runtime Contract、Protocol、Host、Client 和 Service 的 owner 文档维护。

这里提供两条路径：学习项目从架构逐层深入；完成任务从症状或功能直接进入负责模块，只在发现跨层影响时扩读。产品预期见[产品手册](../handbook/README.md)。

## 产品与架构全景

先看[客户端能力](../handbook/capabilities.md)区分正式 TUI、CLI、只读 Web、Server 和开发中的 Desktop，再按下表从用户目标进入实现。产品承诺仍由手册负责；这里的实现入口不自动证明承诺全部兑现。验证应从对应 owner 文档、源码和测试入口核对。

| 用户目标与产品承诺 | 实现与影响路径 | 验证定位 |
| --- | --- | --- |
| [发起工作并取得结果](../handbook/features/execution.md) | [提交到完成](flows/task-execution.md) → Service/Host/Kernel；[模型工具循环](flows/model-tool-cycle.md) → Builtin | [Host 命令测试](../../packages/runtime-host/test/persistent-command-host.test.ts)、[Kernel 完成测试](../../packages/agent-kernel/test/completion.test.ts) |
| [选择模型与管理上下文](../handbook/features/models-and-configuration.md) | [模型子系统](subsystems/model-context.md) → Service 配置、Builtin context/gateway；活动 Run 与保存偏好分开 | [模型与上下文 owner](../../packages/builtin-runtime/docs/model-and-context.md) |
| [使用工具和控制授权](../handbook/features/tools-and-approvals.md)、[确认计划](../handbook/features/planning-and-tasks.md) | [交互链路](flows/interactions.md) → 客户端提交、Service 事务、Kernel 决定、Host 继续 | [交互测试](../../packages/agent-kernel/test/interaction-governance.test.ts)、[TUI 客户端测试](../../apps/kite-cli/test/service-mode/tui-client.test.ts) |
| [停止、恢复并再次工作](../handbook/features/recovery.md) | [取消和后继](flows/cancellation-recovery.md) → TUI 队列、Service/Host cleanup、Store effect | [Host 生命周期测试](../../packages/runtime-host/test/runtime-host.test.ts)、[TUI 系统场景](../../tests/tui-system/scenarios/session-switch.test.ts) |
| [管理连续会话](../handbook/features/sessions.md) | [切换/历史/重连](flows/session-history.md) → 各客户端投影；[多客户端同会话](architecture/identities-state.md#同一会话被多个客户端或进程访问) → Service/Store | [导航测试](../../apps/kite-cli/test/session-navigation.test.ts)、[Store authority 测试](../../packages/runtime-storage-sqlite/test/isolated/kite-session-execution-authority.test.ts) |
| [使用 MCP 与 Skills](../handbook/features/extensions.md) | [工具子系统](subsystems/tools.md) → Builtin、Service App Control、Native 客户端 | [工具流水线测试](../../packages/builtin-runtime/test/tool-pipeline-callbacks.test.ts) |
| [查看执行与诊断](../handbook/flows/web-observation.md) | [Web 查询](flows/web-queries.md) → Web/共享 UI、API client/contract、Service read adapter | [Web 测试与限制](../../apps/kite-web/docs/testing.md) |
| [启动本机服务](../handbook/server/README.md)及[桌面工作](../handbook/clients/desktop/README.md) | [拓扑](architecture/topology.md)、[启动准入](flows/startup-admission.md) → release、Native、Desktop host、Service | [App Server 配对测试](../../tests/release/app-server-client.test.ts)、[Desktop 原生验收](../../apps/kite-desktop/docs/native-validation.md) |

从模块反查功能：使用[全部 workspace 清单](architecture/dependencies.md#从功能找模块从模块反查功能)，覆盖 4 个 app 与 14 个 package 的职责、manifest、代表性源码消费点、产品和 owner 文档。修改影响可沿该行进入链路，在 producer/consumer 两侧核对；共享 `kite-client-ui` 影响 Web/Desktop 的呈现，不使 Web 获得 Desktop 的执行权限。

看图时区分三种关系：[依赖表](architecture/dependencies.md)描述静态 import；[拓扑](architecture/topology.md)描述进程间调用和共享存储；流程时序图描述请求、事件与提交顺序。[身份与数据](architecture/identities-state.md)解释状态归属，不把客户端缓存当作业务 authority。

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

[跨包契约目录](subsystems/contracts.md) · [测试体系](../../tests/README.md) · [文档同步](documentation.md) · [有效计划](../plans/README.md) · [Agent Notes](../../.agents/notes/README.md) · [运行排障](../runbooks/agent-production-incident.md)。

局部任务从上表进入对应段落、负责模块与测试；发现跨层影响后再扩读。影响映射是核对候选，不是整批必读清单。完成时按[文档同步](documentation.md#规则归属与执行入口)定位规则，已读内容与验证结果的复用由现有 Skill 判断。
