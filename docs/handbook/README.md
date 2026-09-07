# Kite Code 产品手册

Kite Code 帮助你在工作区内理解代码、执行任务、检查结果并保留可继续的会话。模型会使用工具完成工作；需要授权、补充信息或方案确认时，由可交互客户端向你提出请求。

## 适合谁

- 希望在工作区完成代码理解、修改、验证和连续任务的开发者。
- 需要自选模型、在自己的环境中运行的个人或团队。
- 需要明确操作授权、检查执行结果和处理恢复问题的使用者。

## 产品边界

当前提供 TUI、Web、CLI 和本机服务，各自能力以[对照表](capabilities.md)为准；未来客户端不提前承诺。工具发现、授权与实际运行环境相互独立，不能以能力目录替代操作系统隔离，也不承诺任意第三方调用都具有通用 exactly-once 保证。

需要的验证与恢复取决于具体功能、配置和可用证据，不把默认关闭或尚未交付能力列为无条件承诺。外部内容、Skill 或模型不能自行扩大用户授权。

当前客户端与 TUI 按个人本地工具使用，不要求注册或登录 Kite Code 账号。模型 Provider 的 API key 和可选 MCP 服务的授权由对应服务决定，不构成 Kite Code 用户登录。未来接入远程控制时再设计所需的用户身份与访问认证，当前不预建账号体系。

## 选择入口

- [TUI](clients/tui/README.md)：在终端中交互开发、阅读过程、处理审批与恢复。
- [Web](clients/web/README.md)：在浏览器中查看本机已有会话、结果和诊断，当前不提供执行控制。
- [CLI](cli/README.md)：通过命令启动或继续任务，消费事件输出。
- [Server](server/README.md)：了解本机服务的启动、连接和生命周期。

不同入口能力不同，见[能力对照](capabilities.md)。未来客户端不会因为共享产品名称就自动拥有 TUI 的操作或 Web 的限制。

[Tauri 桌面客户端](clients/desktop/README.md)处于开发验证阶段，尚未作为正式入口发布；[首版计划](../plans/desktop-client.md)保留未交付能力和验收项。当前正式入口能力仍以上述手册为准。

## 功能全景

| 用户目标 | 共享含义与入口 |
| --- | --- |
| 理解项目 | [模型与配置](features/models-and-configuration.md)、客户端输入和结果 |
| 执行与修改 | [执行](features/execution.md)、[工具和授权](features/tools-and-approvals.md) |
| 管理连续工作 | [会话](features/sessions.md)、历史、继续与导出 |
| 控制计划和权限 | [计划](features/planning-and-tasks.md)、审批与问题 |
| 停止和恢复 | [恢复](features/recovery.md)，不混淆取消与回滚 |
| 使用扩展 | [MCP 与 Skills](features/extensions.md) |
| 查看诊断 | Web 日志/上下文、CLI trace 与客户端排障 |

## 系统学习

先读[核心概念](concepts.md)和[客户端能力](capabilities.md)，再完成适合自己的流程：

1. [用 TUI 完成一次开发任务](flows/tui-development.md)。
2. [用 Web 查看与诊断执行](flows/web-observation.md)。
3. [CLI 发起与继续任务](flows/cli-continuation.md)。

## 解决当前问题

直接进入对应客户端的指南、命令/设置参考和排障；无需通读全书。

开发者从[任务入口](../development/README.md)进入实现与测试。
