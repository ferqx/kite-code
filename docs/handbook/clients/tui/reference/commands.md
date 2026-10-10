# TUI 命令参考

当前正式 Terminal 与显式 `tui:dev` 使用同一新 UI 命令词汇。固定命令和别名不区分大小写，`/` 提示实际候选，Enter 提交。下表对应当前闭合 parser；完整 37 项能力仍按[进度证据](../../../../plans/unified-agent-refactor-v1-progress.md)核对。

| 命令 | 参数与别名 | 操作与范围 |
| --- | --- | --- |
| `/model`、`/effort` | 无参数 | 明确模型或推理强度选择 |
| `/theme`、`/language` | 无参数 | 保存当前 profile 显示偏好 |
| `/resume`、`/new` | 无参数 | 同 Workspace 选择器或新 Session |
| `/plan [任务]` | 可选完整任务文字 | 单次规划请求或草稿规划模式 |
| `/permissions` | 无参数 | 当前模式、信任与准确授权事实 |
| `/skills` | 无参数 | 当前知识和 Workflow 资格目录，只读不执行 |
| `/mcp` | 无参数 | 安全 Server 目录与详情；明确用户或项目范围启停，查询原未知操作 |
| `/background` | 可加 `stop/output/child <原executionId>` | 当前会话原后台执行目录、准确停止、完整输出或子日志；恢复历史只读，见[后台任务](../guides/tools-and-subagents.md#查看后台任务与恢复历史) |
| `/session rename <标题>` | 非空标题 | 原 Session/control revision 重命名 |
| `/session delete confirm` | 必须明确 confirm | 保存删除与整组停止意图，受理不等于清理结束 |
| `/session fork <标题>` | 非空标题 | 稳定原选择创建分支，不继承授权 |
| `/rewind` | 无参数 | Files 会话/代码/两者三范围及原保存申请 |
| `/context` | 无参数 | 原当前选择的上下文与准确来源 |
| `/compact [重点]` | 可选完整重点 | 记录摘要 Model 与准确覆盖来源，受理不等于发布 |
| `/compact reset` | 保留特殊词汇 reset | 完整展开预检成功后清除活动点，失败保留原点 |
| `/recovery` | 无参数 | 原 Run、报告、遗留中断和外部 Job 的显式恢复/核实 |
| `/drafts`、`/draft <id>` | id 来自原目录 | 私有未提交草稿目录与原完整正文，不自动填入或发送 |
| `/export` | 无参数 | 当前已加载对话 Markdown，不代替完整 records export |
| `/clear` | 无参数 | 清理本地正文展示，保留历史数据、草稿、待决审批和活动工作 |
| `/status` | 无参数 | 实际 profile/实例/API/候选与执行、发行、遥测事实 |
| `/help` | `/h`，无参数 | 当前命令帮助 |
| `/exit` | `/quit`、`/q`，无参数 | 明确结束本宿主 |

未知 slash 不作为普通模型任务提交，固定命令优先于同名 Skill。只有当前编译目录中合格的 `/<Skill名称> [任务]` 才能显式激活 Workflow。`/mcp` 是固定无参数命令；当前有限目录与启停不等于完整认证、重连、增删或工具管理，差异见[MCP 指南](../guides/mcp-and-skills.md#通用-tui-的-mcp-目录与选择)。多余参数局部拒绝，不静默扩大操作。当前实现见[命令 owner](../../../../../packages/ui/src/tui/commands.ts)，详细按键见[键盘参考](keyboard.md)。

## 通用开发 TUI 草稿入口

以下草稿词汇同时用于当前正式 Terminal 与显式开发入口：

| 命令 | 参数 | 操作与范围 |
| --- | --- | --- |
| `/drafts` | 无参数 | 查看当前profile已落盘的非空草稿目录；未保存的冲突编辑仍在composer |
| `/draft <id>` | 目录提供的完整ID | 只读原全文及current/unavailable关联，不填入新输入、不发送或改绑 |

草稿保存与失败行为见[输入指南](../guides/input-and-queue.md#通用开发-tui-的未提交草稿)。未知ID或坏格式局部失败，不启动模型。


## 通用开发 TUI 模型入口

`/model`、`/effort` 均不接受参数。上下选择、Enter 核对再 Enter 保存；模型面板 E 核对启禁，R 读取，K 查询原操作，Esc 放弃确认或关闭。范围为当前 Workspace 项目设置，详情见[模型指南](../guides/models-and-settings.md#开发统一-tui-的模型设置)。


## 通用开发 TUI 状态

`/status` 不接受参数，显示实际profile、实例、构建和API、配对或共享来源、连接与观察状态，以及执行/发行/遥测诊断。R重新读取，Esc返回。连接失败保留最后确认事实并明确当前未知；关闭面板不停止任务或服务。一次状态读取成功不代表持续观察流已经恢复。没有发行证明或沙箱时如实显示未验证，不能把进程监督视为沙箱。

## 通用开发 TUI Skill 目录

`/skills` 不接受参数，只读当前 Workspace 的完整知识目录。上下选择，左右翻阅详情，R 刷新，Esc 返回；面板内 Ctrl+C 仅取消读取。可用、禁用、不可用与当前未知分别显示；宿主支持时另列 Workflow 资格与合格命令。查看目录不启动 Model、工具或 Workflow。

`/<Skill 名称> [任务]` 显式激活当前唯一且允许手动调用、接受空对象输入的 Workflow；固定命令优先。任务文字只作任务内容，活动 Run 上排独立 follow-up。结果未知时 Ctrl+L 查询原命令并刷新，不重发。详见[扩展指南](../guides/mcp-and-skills.md#通用开发-tui-的-skill-目录)。

## 通用开发 TUI 显示设置

`/theme`、`/language` 均不接受参数。上下选择、Enter 保存，R 重读，Esc 或 Ctrl+C 关闭。保存成功才应用当前 profile 的终端显示偏好；失败保原值，版本冲突需重读后重新选择。详情见[界面偏好](../guides/models-and-settings.md#开发统一-tui-的界面偏好)。


## 通用开发 TUI 文件恢复

`/rewind` 不接受参数，读取实际 Files 恢复点与保存申请。上下选择、Enter 预览，1/2/3 选仅会话/仅代码/两者，再 Enter 核对提交。L 查原保存申请，R 只读刷新，C 明确继续未开始的第二 leg，A 返回原独立审批，Esc/Ctrl+C 关闭本地读取。操作与部分完成含义见[恢复指南](../guides/cancellation-and-recovery.md#通用开发-tui-的-files-三范围操作)。
