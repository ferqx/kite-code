# 开发入口

产品预期由[产品手册](../handbook/README.md)和用户确认需求定义；实现与运行证据说明当前交付范围。[通用 Agent V1.3](../plans/unified-agent-refactor-v1.md)仍在实施，37 项能力和三平台资格见[进度证据](../plans/unified-agent-refactor-v1-progress.md)。当前根正式入口、默认测试与 CI 已选择以下精确八个 workspace；入口切换不表示整个 §35 已完成。

## 当前模块与职责

| 模块 | 职责与入口 |
| --- | --- |
| [AI](../../packages/ai/README.md) | 中立模型流与明确 SDK adapter |
| [Agent](../../packages/agent/README.md) | 唯一 Loop、Execution/Job、业务记录、扩展及 I/O owner leaves |
| [Client](../../packages/client/README.md) | 公开 HTTP/SSE 准入、原身份与未知回执查询 |
| [UI](../../packages/ui/README.md) | 便携显示、公共表单与 TUI 组件 |
| [Service](../../apps/service/README.md) | 默认可信装配、HTTP/SSE、paired/daemon 与只读 gateway |
| [CLI/TUI](../../apps/cli/README.md) | 薄调用者、持久原意图、显式开发宿主及安装前门 |
| [Desktop](../../apps/desktop/README.md) | 可移植调用者与 Electron main/preload/renderer |
| [Web](../../apps/web/README.md) | 只读浏览器与敏感内容二次确认 |

运行、默认测试和真实 PTY 命令见[本地开发](local-development.md)与[测试体系](../../tests/README.md)。源码运行默认选择已构建 Terminal 候选；显式 `cli:dev`、`tui:dev`、`web:dev` 使用独立 development profile。发行和安装归[发布边界](../active/release-control.md)、[Terminal owner](../../apps/cli/docs/terminal-release.md)与[Native owner](../../apps/desktop/docs/native-release.md)。

## 从产品问题进入实现

| 用户目标或症状 | 产品定义 | 当前负责模块与验证入口 |
| --- | --- | --- |
| 提交任务、运行中引导或排队后续输入 | [执行与结果](../handbook/features/execution.md) | [Agent](../../packages/agent/README.md)、[Service](../../apps/service/README.md)、[CLI/TUI](../../apps/cli/README.md)；核原 Command/Run 与真实终态 |
| 切换会话、历史串入后来选择 | [会话与历史](../handbook/features/sessions.md) | [Client](../../packages/client/README.md)、[UI TUI](../../packages/ui/src/tui/README.md)、[Desktop](../../apps/desktop/README.md)；核 scope、观察 generation 和读取取消 |
| 模型选择、权限或配置与实际请求不同 | [模型与配置](../handbook/features/models-and-configuration.md)、[工具和授权](../handbook/features/tools-and-approvals.md) | [Service configuration](../../apps/service/src/configuration.ts)、[AI](../../packages/ai/README.md)；活动配置与保存偏好分别核对 |
| 审批、问题或计划答复没有继续原工作 | [工具和授权](../handbook/features/tools-and-approvals.md)、[计划](../handbook/features/planning-and-tasks.md) | [Agent](../../packages/agent/README.md)、[Client](../../packages/client/README.md)、对应客户端 owner；核原 Interaction/attempt/决定版本 |
| 取消后仍运行、未知结果或冷恢复 | [取消与恢复](../handbook/features/recovery.md) | [新执行边界](../active/unified-agent-boundary.md)、Agent/Service owner；核实际资源、取消域、原申请与零重放 |
| Context 压缩、Fork 或 Files 三范围恢复 | [模型与配置](../handbook/features/models-and-configuration.md)、[会话](../handbook/features/sessions.md)、[恢复](../handbook/features/recovery.md) | [Agent](../../packages/agent/README.md)、[Files](../../packages/agent/src/business/file-checkpoints/README.md)、[CLI/TUI](../../apps/cli/README.md)；受理与实际 publication/Job 完成分开 |
| MCP、Skills 或 Workflow | [扩展](../handbook/features/extensions.md) | [Agent](../../packages/agent/README.md)、[Service](../../apps/service/README.md)；目录、授权、实际装配及平台支持分别核对 |
| Web 内容或敏感正文读取异常 | [Web](../handbook/clients/web/README.md) | [Web owner](../../apps/web/README.md)、[Client](../../packages/client/README.md)、[Service gateway](../../apps/service/src/development-web.ts)；只读不授予控制权限 |
| 制品启动、安装登记、SQLite 或宿主退出 | [服务生命周期](../handbook/server/lifecycle.md)、[Desktop](../handbook/clients/desktop/README.md) | [发布边界](../active/release-control.md)、Terminal/Native owner；核完整闭包、实际引擎与所属 lease |

普通局部修复先读负责 owner、相关源码和测试；跨层行为再读对应手册及[新执行边界](../active/unified-agent-boundary.md)。生产 consumer 不能依赖旧 Host/Kernel/State writer/carrier；源码、根/workspace 命令和 CI 均由独立守卫核对。测试证明实际断言，不以 build 或 fixture 代替平台和发行资格。

## 历史架构参考

[架构总览](architecture.md)、[旧 workspace 依赖表](architecture/dependencies.md)、[拓扑](architecture/topology.md)及旧流程/子系统保留历史算法、威胁模型和设计理由。它们描述旧 4 app/14 package 装配，不能作为当前源码定位或运行入口；仍适用的约束须与当前手册、八个 owner 和 active 核对。

追溯时区分静态 import、进程拓扑与请求/事件/提交时序；客户端缓存始终不能成为业务 authority。不得从旧计划、Note 状态或历史测试通过推导当前能力。

## 文档与验证维护

[文档同步](documentation.md) · [有效计划](../plans/README.md) · [Agent Notes](../../.agents/notes/README.md) · [测试体系](../../tests/README.md)。

局部任务沿实际 producer/consumer 扩读；影响映射提供核对候选，不要求整批文档产生 diff。阶段交付按[文档同步 Skill](../../.agents/skills/document-before-commit/SKILL.md)核对实际变化、产品与技术文档、必要验证和剩余范围。
