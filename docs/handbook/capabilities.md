# 各入口能力对照

根正式入口、默认测试与 CI 已切换通用 Agent V1.3 的八个新 workspace。下表描述当前消费者；“有条件”要求准确配置、授权、完整来源或可恢复数据。完整 37 项保真与三平台发行尚未完成，已确认目标及差异保留在[实施计划](../plans/unified-agent-refactor-v1.md)与[进度证据](../plans/unified-agent-refactor-v1-progress.md)，不能把入口切换视为全部交付。

| 能力 | TUI | Web | CLI | Native |
| --- | --- | --- | --- | --- |
| 发起或继续任务 | 输入新任务，保持原 Session | 只读 | `run/resume`；resume 是新任务 | 原 Session 输入新任务 |
| 浏览会话与消息 | 同 Workspace 选择器与完整历史 | 目录、会话与完整正文读取 | 事件输出与显式原对象查询 | 同 Workspace 目录与历史 |
| 会话管理 | `/session rename`、`delete confirm`、`fork` | 只读 | `session rename/delete/fork` 闭合 JSON | 重命名、删除、Fork 面板 |
| 审批、问题和计划审核 | 原卡、单次决定与完整附件 | 只读 | 有条件：stdin 原答案，EOF 保留等待 | 原卡、完整附件和原意图查询 |
| 取消与停止 | 原 work 取消与准确后台 execution 停止 | 不提供控制 | 原 Command 取消；不等于资源已停止 | 原 work/Job 取消及只读终态观察 |
| 运行中引导与后续输入 | 同 Run 引导或原边界 follow-up | 只读 | `work` 的显式原目标 DTO | 原目标引导和后续输入 |
| 后台执行 | `/background` 的状态、正文、子上下文和准确停止 | 只读 | 显式原 Job 核实，能力按 owner | 执行树、正文、子上下文与准确停止 |
| 计划与 Workflow | `/plan`、合格 Skill 显式激活 | 只读 | `--activate-skill` 与完整单次请求 | 明确单次 Plan/Workflow 请求 |
| 文件与会话恢复 | `/rewind` 会话/代码/两者三范围 | 原点、预览与结果只读 | `files` 三范围和原 intent 查回 | Files 三范围与持久原 intent |
| Context 与压缩 | `/context`、`/compact`、`/compact reset` | 完整原调用上下文只读 | `context read/rewind/include/compact/reset` | Context/压缩面板 |
| 模型与偏好 | `/model`、`/effort`、主题和语言 | 不修改配置 | 消费明确配置与 `--model` | 项目/用户模型配置与选择 |
| MCP 与 Skills | `/skills` 目录、显式合格 Workflow；`/mcp` 安全详情和用户/项目启停，完整管理仍待闭合 | 只读 | 已配置能力与 `--skill`；不代表完整 MCP 管理 | 目录及已接线管理功能，完整资格按 owner |
| 导出与诊断 | 已加载对话 Markdown 导出、`/status` | 日志、原模型输入/输出 | `trace`、状态选项与显式管理 JSON | 诊断及原 Model 完整正文；完整导出 UI 按计划核对 |
| 未确认申请恢复 | 私有 journal，只查原 ID | 展示原状态 | 完整 caller/recovery/files intent，只查原 ID | 私有数据库与原请求分页，只查原 ID |

恢复、审批、取消和管理回执只证明相应申请落定；Run/Job/文件实际结果须继续观察。读取、关闭面板和连接恢复不自动重放操作。Web 的只读能力不因共享 UI、Service 或产品名称而获得控制权限。

操作入口：[TUI](clients/tui/README.md)、[Web](clients/web/README.md)、[CLI](cli/README.md)、[Native](clients/desktop/README.md)。服务生命周期见[Server](server/README.md)，完整 Terminal/Native 候选和安装登记见[发布边界](../active/release-control.md)。

当前 macOS 的新 TUI 28 文件 runner、源码外 Terminal/Native 及各公共链路有具名证据；Native 尚未取得完整平台及 publisher 发行资格。Linux/Windows、默认完整 Shell、混合长跑等未完成项保持明确，历史客户端或旧 40 场景结果不代替当前资格。
