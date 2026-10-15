# TUI 设置参考

| 设置 | 入口 | 范围和生效 |
| --- | --- | --- |
| Provider / 模型 | 首次配置、`/model` | 保存期望配置；当前执行保留开始时配置，下一次执行采用新值 |
| 推理深度 | `/effort` | low、medium、high、max；Provider 对这些值的支持不同 |
| 权限 | `/permissions` | 控制执行审批方式；不替代工作区信任 |
| 计划模式 | `/plan`、Shift+Tab | 控制规划阶段，与权限分开 |
| 语言 | `/language` | `system`、`zh-CN`、`en-US`；终端客户端偏好 |
| 主题 | `/theme` | teal、blue、purple、cyan、mono 配色；不改变对话数据 |
| MCP | `/mcp` | 配置范围、连接、认证按当前条目提供的操作 |

终端偏好保存在用户配置中。项目配置和服务配置有各自范围；不要用修改语言、主题来改变服务端模型或权限。

配置保存失败需要修正权限或配置内容。手工编辑时保留合法 JSONC，不在共享截图或日志中暴露凭据。具体配置含义见[共享配置](../../../features/models-and-configuration.md)。

功能开关不是通用解锁方式；CLI 不接受旧的 `--feature` 覆盖入口。被禁用或未提供的能力不能仅凭旧文档启用。

## 手工配置位置与模型字段

当前统一 TUI 的用户模型配置为 `<data-root>/<profile>/config.jsonc`，项目覆盖为 `<工作区>/kite-agent.jsonc`；以实际选定的数据根和 profile 为准。优先使用首次配置、`/model` 和 `/effort`，不要在项目文件中提交真实凭据。模型目录使用 `models[]`，默认模型由 `modelId` 引用准确 `id`，不读取下方旧 `provider.*` 格式。

| 当前字段 | 含义 |
| --- | --- |
| `modelId` | 默认模型的准确 `models[].id` |
| `models[].id / provider / model` | 配置 ID、受支持的 Provider 适配器及实际远端模型名称 |
| `models[].baseURL / credentialRef` | 实际端点及不透明凭据引用；不写凭据正文 |
| `models[].options.maxOutputTokens` | 实际请求的输出上限；也优先作为该请求的上下文输出预留 |
| `models[].modelCapabilities.contextWindowTokens` | 用户显式声明的模型上下文窗口 |
| `models[].modelCapabilities.maxOutputTokens` | 用户显式声明的模型输出容量；实际请求没有输出上限时用作显示预算的预留 |

`modelCapabilities` 可省略；它只接受上面两个可选正安全整数，未知字段或无效数值拒绝封存。这些元数据随原 Run 冻结，不是 Provider 能力探测或保证，也不会自动把元数据输出容量变成 Provider 请求参数。窗口或输出预留缺失时，`/context` 和底部只显示已核输入的 token 估算及容量未知，不猜模型窗口或显示虚构百分比。模型对象中其他未支持字段即使保留在配置文件，也不会自动进入执行快照。

### 旧配置格式参考

下表仅用于辨认旧 TUI 格式，不是当前统一入口的配置合同，也不构成旧配置迁移支持。旧默认用户配置为 `~/.kite-code/kite-code.jsonc`，项目配置为 `<工作区>/.kite-code/kite-code.jsonc`。

| 字段 | 含义 |
| --- | --- |
| `provider.<名称>.type` | deepseek、openai、openai-compatible 或 ollama |
| `provider.<名称>.baseURL` | Provider 地址，需合法 URL |
| `provider.<名称>.apiKey` | 凭据；也可由实际支持的环境/认证来源提供，不分享真实值 |
| `provider.<名称>.model` | 默认模型名称 |
| `provider.<名称>.models` | 模型名称列表，或带元数据的对象列表 |
| `model` | 当前选择，可写成 `Provider名称:模型名称` |
| `provider.<名称>.effort` | 推理深度；界面提供 low/medium/high/max |
| `provider.<名称>.reasoning` | 是否向 Provider 传递推理参数，受模型支持限制 |
| `provider.<名称>.modelKwargs` | 高级 Provider 参数；不能据此放宽授权或平台限制 |
| `language` | 用户语言偏好，项目不能覆盖 |
| `colorPreset` | `/theme` 保存的配色选择 |
| `theme` | dark/light 基础主题配置，与配色预设不同 |
| `interactionMode` | accept_edits、auto、full |

模型对象可声明 `name`、`default`、`contextWindow`、`maxOutputTokens`、`tokenizerFamily`、`supportsUsageMetadata`、`supportsPromptCache`、`streaming`。这些声明需要与实际 Provider 能力一致；旧 `tokens` 字段不用于新配置。

## 高级配置范围

`features` 只接受已注册功能，不能解锁未满足运行条件的能力。`autoReview` 可指定 reviewer provider/model、timeout 和循环限制；不能将 failOpen 字段理解为所有未知操作都应自动执行。`compaction` 管理自动模式、预算和阈值；自动模式 off/shadow/live 不等同于手动命令是否可用。

压缩阈值要求 warningRatio < compactRatio < hardRatio，maxSummaryTokens 不超过 maxNarrativeTokens。localDebug 输出可能包含敏感上下文，未经检查不要分享。`sessionLogging`、`telemetry` 和 `sandbox` 各有受限语义，不以项目配置任意放宽用户与发行限制。

这些高级选项没有完整 TUI 设置面板。手工调整前核对对应能力说明；配置被接受也不证明所有条件已具备。


## 统一入口设置

正式 Terminal 和 `bun run tui:dev` 的 `/model`、`/effort` 使用专门的项目模型设置 API，作用域为当前实际 Workspace，不是按会话保存的模型偏好。`/effort` 的选项来自读取结果；compatible 适配器可提供 none、minimal、low、medium、high、xhigh、max，但这不是远端模型能力承诺。清除项目 effort 的最终值取决于现有配置层覆盖，保存后以重读事实为准。上面的旧配置字段表不能作为新 API 的任意写入入口；操作与快捷键见[模型与界面设置](../guides/models-and-settings.md#统一-tui-的模型设置)。

统一 TUI 的 `/theme`、`/language` 保存到当前 profile 的 `ui/preferences.jsonc`，字段分别为 `colorPreset` 和 `language`；基础 `theme` 可手工配置 dark/light。缺文件默认 teal/system/dark；非法或损坏文件不自动覆盖。每次保存使用读取时文件 revision，冲突需重读后再明确选择。该文件属于客户端显示偏好，随显式维护备份采集；不写服务模型配置，也不承接旧用户目录的数据。
