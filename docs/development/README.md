# 开发入口

这里提供两条路径：学习项目从架构逐层深入；完成任务从症状或功能直接进入负责模块，只在发现跨层影响时扩读。产品预期见[产品手册](../handbook/README.md)。

## 产品与架构全景

先看[客户端能力](../handbook/capabilities.md)区分正式 TUI、CLI、只读 Web、Server 和开发中的 Desktop，再按下表从用户目标进入实现。产品承诺仍由手册负责；这里的实现入口不自动证明承诺全部兑现。核实层级、分析基线、冲突和实跑结果见[本次建图范围](architecture.md#本次建图范围与证据)。

| 用户目标与产品承诺 | 实现与影响路径 | 验证定位 / 本次深度 |
| --- | --- | --- |
| [发起工作并取得结果](../handbook/features/execution.md) | [提交到完成](flows/task-execution.md) → Service/Host/Kernel；[模型工具循环](flows/model-tool-cycle.md) → Builtin | 链路含源码符号、已读断言；Host、Kernel 与 Pipeline 定向实跑，未跑真实模型 |
| [选择模型与管理上下文](../handbook/features/models-and-configuration.md) | [模型子系统](subsystems/model-context.md) → Service 配置、Builtin context/gateway；活动 Run 与保存偏好分开 | 已核对执行链中的冻结配置；各 Provider、压缩与设置 UI 未全面深入 |
| [使用工具和控制授权](../handbook/features/tools-and-approvals.md)、[确认计划](../handbook/features/planning-and-tasks.md) | [交互链路](flows/interactions.md) → 客户端提交、Service 事务、Kernel 决定、Host 继续 | 已读 TUI/Host 交互断言，审批队列实跑；Desktop/CLI 独立 UI 时序未深入 |
| [停止、恢复并再次工作](../handbook/features/recovery.md) | [取消和后继](flows/cancellation-recovery.md) → TUI 队列、Service/Host cleanup、Store effect | 已核实 TUI caller/receiver 并读相关断言；PTY、崩溃和原生清理未实跑 |
| [管理连续会话](../handbook/features/sessions.md) | [切换/历史/重连](flows/session-history.md) → 各客户端投影；[多客户端同会话](architecture/identities-state.md#同一会话被多个客户端或进程访问) → Service/Store | 导航竞态和 SQLite 多进程 writer 定向实跑；不是整套连接恢复验收 |
| [使用 MCP 与 Skills](../handbook/features/extensions.md) | [工具子系统](subsystems/tools.md) → Builtin、Service App Control、Native 客户端 | 已清点 owner 与调用入口；认证、外部服务、所有 Skill workflow 未深入 |
| [查看执行与诊断](../handbook/flows/web-observation.md) | [Web 查询](flows/web-queries.md) → Web/共享 UI、API client/contract、Service read adapter | 核实 REST 与页面轮询分界；[Web 测试缺口](../../apps/kite-web/docs/testing.md)仍保留 |
| [启动本机服务](../handbook/server/README.md)及[桌面工作](../handbook/clients/desktop/README.md) | [拓扑](architecture/topology.md)、[启动准入](flows/startup-admission.md) → release、Native、Desktop host、Service | 核实进程和正式数据入口，配对测试实跑；Desktop 原生、发行与跨平台资格未重跑 |

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

[跨包契约目录](subsystems/contracts.md) · [测试体系](../../tests/README.md) · [文档同步](documentation.md) · [有效计划](../plans/README.md) · [运行排障](../runbooks/agent-production-incident.md)。

局部任务从上表进入对应段落、负责模块与测试；发现跨层影响后再扩读。影响映射是核对候选，不是整批必读清单。完成时按[文档同步](documentation.md#规则归属与执行入口)定位规则，已读内容与验证结果的复用由现有 Skill 判断。
