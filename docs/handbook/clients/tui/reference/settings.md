# TUI 设置参考

| 设置 | 入口 | 范围和生效 |
| --- | --- | --- |
| Provider / 模型 | 首次配置、`/model` | 保存期望配置；当前执行保留开始时配置，下一次执行采用新值 |
| 推理深度 | `/effort` | 轻度、中、高、极高、Max、Ultar；对应 low/medium/high/xhigh/max/ultar，参数效果由模型服务决定 |
| 权限 | `/permissions` | 控制执行审批方式；不替代工作区信任 |
| 计划模式 | `/plan`、Shift+Tab | 控制规划阶段，与权限分开 |
| 语言 | `/language` | `system`、`zh-CN`、`en-US`；终端客户端偏好 |
| 主题 | `/theme` | teal、blue、purple、cyan、mono 配色；不改变对话数据 |
| MCP | `/mcp` | 配置范围、连接、认证按当前条目提供的操作 |

语言、主题等终端偏好保存在所选 Profile 的 `ui/preferences.jsonc`；模型统一保存在用户根目录文件中。修改语言、主题不改变模型或权限。

配置保存失败需要修正权限或配置内容。手工编辑时保留合法 JSONC，不在共享截图或日志中暴露凭据。具体配置含义见[共享配置](../../../features/models-and-configuration.md)。

功能开关不是通用解锁方式；CLI 不接受旧的 `--feature` 覆盖入口。被禁用或未提供的能力不能仅凭旧文档启用。

## 手工配置位置与模型字段

模型配置唯一位于 `~/.kite-code/kite-code.jsonc`，切换 Profile 或工作区不会改变该位置。`/model`、`/effort` 与首次配置均修改这份用户文件；项目文件不提供模型覆盖。项目 `kite-agent.jsonc` 中其他受支持配置仍按其范围生效。首次配置优先使用交互入口，不在项目文件中提交真实凭据。

### 兼容的统一模型字段

同一用户文件也兼容 `models[]` 与 `modelId` 格式，不与下方 `provider.*` 格式混用。默认模型由 `modelId` 引用准确 `id`。

| 当前字段 | 含义 |
| --- | --- |
| `modelId` | 默认模型的准确 `models[].id` |
| `models[].id / provider / model` | 配置 ID、受支持的 Provider 适配器及实际远端模型名称 |
| `models[].baseURL / credentialRef` | 实际端点及不透明凭据引用；不写凭据正文 |
| `models[].options.maxOutputTokens` | 实际请求的输出上限；也优先作为该请求的上下文输出预留 |
| `models[].modelCapabilities.contextWindowTokens` | 用户显式声明的模型上下文窗口 |
| `models[].modelCapabilities.maxOutputTokens` | 用户显式声明的模型输出容量；实际请求没有输出上限时用作显示预算的预留 |

`modelCapabilities` 可省略；它只接受上面两个可选正安全整数，未知字段或无效数值拒绝封存。这些元数据随原 Run 冻结，不是 Provider 能力探测或保证，也不会自动把元数据输出容量变成 Provider 请求参数。窗口或输出预留缺失时，`/context` 和底部只显示已核输入的 token 估算及容量未知，不猜模型窗口或显示虚构百分比。模型对象中其他未支持字段即使保留在配置文件，也不会自动进入执行快照。

### 原 Provider 配置字段

现有用户文件的 `provider.*`、`model` 和启禁字段继续读取和保存，未知字段及注释保留。

| 字段 | 含义 |
| --- | --- |
| `provider.<名称>.type` | deepseek、openai、openai-compatible 或 ollama |
| `provider.<名称>.baseURL` | Provider 地址，需合法 URL |
| `provider.<名称>.apiKey` | 兼容现有明文；新替换值存用户级系统凭据库，文件保存 credentialRef |
| `provider.<名称>.model` | 默认模型名称 |
| `provider.<名称>.models` | 模型名称列表，或带元数据的对象列表 |
| `model` | 当前选择，可写成 `Provider名称:模型名称` |
| `provider.<名称>.effort` | 请求推理深度；low/medium/high/xhigh/max/ultar，已有 none/minimal 保持有效 |
| `provider.<名称>.reasoning` | 是否向 Provider 传递推理参数，受模型支持限制 |
| `provider.<名称>.modelKwargs` | 高级 Provider 参数；不能据此放宽授权或平台限制 |
| `provider.<名称>.credentialRef` | 系统凭据库引用，由配置入口维护 |
| `disabledModels` | 被禁用模型的 provider/name 路由列表 |
| `theme` | dark/light 基础主题配置，与配色预设不同 |
| `interactionMode` | accept_edits、auto、full |

模型对象可声明 `name`、`default`、`contextWindow`、`maxOutputTokens`、`tokenizerFamily`、`supportsUsageMetadata`、`supportsPromptCache`、`streaming`。这些声明需要与实际 Provider 能力一致；旧 `tokens` 字段不用于新配置。

## 高级配置范围

`features` 只接受已注册功能，不能解锁未满足运行条件的能力。`autoReview` 可指定 reviewer provider/model、timeout 和循环限制；不能将 failOpen 字段理解为所有未知操作都应自动执行。`compaction` 管理自动模式、预算和阈值；自动模式 off/shadow/live 不等同于手动命令是否可用。

压缩阈值要求 warningRatio < compactRatio < hardRatio，maxSummaryTokens 不超过 maxNarrativeTokens。localDebug 输出可能包含敏感上下文，未经检查不要分享。`sessionLogging`、`telemetry` 和 `sandbox` 各有受限语义，不以项目配置任意放宽用户与发行限制。

这些高级选项没有完整 TUI 设置面板。手工调整前核对对应能力说明；配置被接受也不证明所有条件已具备。


## 统一入口设置

`bun run tui:dev` 和正式 TUI 的 `/model`、`/effort`、首次配置统一使用用户级模型 API，不按 Workspace 保存。所有配置可用的模型均提供完整 effort 档位，实际请求发送 `reasoning_effort`；模型服务决定如何处理。清除 override 后以重读事实为准。操作见[模型设置](../guides/models-and-settings.md#统一-tui-的模型设置)。

统一 TUI 的 `/theme`、`/language` 保存到当前 profile 的 `ui/preferences.jsonc`，字段分别为 `colorPreset` 和 `language`；基础 `theme` 可手工配置 dark/light。缺文件默认 teal/system/dark；非法或损坏文件不自动覆盖。每次保存使用读取时文件 revision，冲突需重读后再明确选择。该文件属于客户端显示偏好，随显式维护备份采集；不写服务模型配置，也不承接旧用户目录的数据。
