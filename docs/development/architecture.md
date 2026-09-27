# 架构与运行机制

先建立系统地图，再沿具体链路进入机制。正在修改一个局部问题时，可直接使用[任务入口](README.md)，不需要顺序读完所有章节。

## 整体理解

1. [组成与运行拓扑](architecture/topology.md)：客户端、进程、服务和 Store 的位置。
2. [依赖方向与职责](architecture/dependencies.md)：哪些模块可以调用哪些边界。
3. [身份、状态与数据归属](architecture/identities-state.md)：Session、Run、Task、Turn、连接和展示不是同一对象。

## 追踪运行

[启动与准入](flows/startup-admission.md) → [任务执行](flows/task-execution.md) → [模型和工具](flows/model-tool-cycle.md) → [交互](flows/interactions.md)。

按问题深入：[会话历史](flows/session-history.md)、[取消与恢复](flows/cancellation-recovery.md)、[Web 查询](flows/web-queries.md)。

## 子系统与底层

[会话协调](subsystems/sessions.md) · [Kernel](subsystems/kernel.md) · [模型上下文](subsystems/model-context.md) · [工具扩展](subsystems/tools.md) · [授权交互](subsystems/security.md) · [持久化恢复](subsystems/storage.md) · [客户端](subsystems/clients.md)。各子系统链接 workspace 内的机制和测试，不复制一份实现手册。

[跨包契约目录](subsystems/contracts.md)用于查规范，不是每个任务必读清单。架构负责解释，准确的共同不变量在对应契约中维护。
