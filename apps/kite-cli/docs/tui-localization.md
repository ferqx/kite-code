# TUI 本地化规范

本页是 `apps/kite-cli` 的 owner-local current authority，覆盖 Kite Code 自有 TUI 文案和 locale 切换。

## Locale authority

- 用户级 `language` 偏好是 locale authority；它属于 `apps/kite-cli/src/preferences/**` 的纯 UI-local
  preference，不属于 Service config 或 App Control。`/language` 只打开选择器，确认后立即切换当前 TUI。
- 所有 Kite Code 自有标题、状态、快捷键、空态、错误和交互说明从统一 catalog 读取。
- Slash command 的名称与帮助来自共享 command metadata；catalog 只为实际注册的 TUI command 提供说明。
  发布与遥测状态由既有配置/CLI 入口负责，TUI 不注册 `/release` 或 `/telemetry`，也不保留其孤立译文。
- Runtime event、command、failure code、status 枚举和 provider 返回值保持稳定英文机器值，不进入翻译 key。
- 状态推导先生成稳定语义值，渲染边界再映射当前 locale；禁止从译文反推状态。

## 文案边界

- 中文是默认仓库 current 文档语言；产品可见 locale 至少保持现有中文/英文目录完整。
- 路径、命令、模型名、Provider 名、schema 字段和用户/模型原文不翻译。
- 可见错误只使用已脱敏的 bounded projection，不把 Provider 原文、credential、Artifact locator 或内部 identity 拼入译文。
- Approval 的 queue sequence、generation 与 interaction ID 是内部 durable identity，不注册可见翻译 key；面板只翻译
  人工/自动 route、匹配请求数量与用户动作，settlement 仍使用未展示的 exact identity。
- 推荐标记、动作动词和快捷键说明由 catalog 统一生成，页面不得维护第二份同义字符串。

## 布局

- 翻译后仍遵守 display-width 截断和 Overlay 四区布局；不得用固定字符串长度代替 `string-width`。
- 数量、位置和步骤计数使用结构化参数，不通过拼接英文句子生成其他 locale。
- locale 切换不改变 Runtime、Session、approval、MCP 或配置 revision 语义。

## 验证

`bun test apps/kite-cli/test`、语言/Overlay/StatusBar 定向测试和相关 TUI PTY scenario。
