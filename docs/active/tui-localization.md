# TUI 本地化

状态：active
读取时机：修改 `src/app/tui/i18n/`、用户级 `language` 配置、`/language`、会影响启动门禁的 TUI 文案、Static 输出重建或已接入本地化的 TUI 表面时必读。
验证：`bun run typecheck`、`bun test tests/config.test.ts tests/tui-i18n.test.ts tests/tui-slash-command.test.ts tests/tui-reducer.test.ts tests/run-status.test.ts tests/tui-layout.test.tsx`、`bun run check:docs-impact`、`bun run check:docs`。
相关：[TUI 中英文国际化实施方案](../space/plans/2026-08-15-tui-i18n-zh-en.md)、[TUI Overlay 设计系统](tui-overlay-design-system.md)、[Workspace 信任门禁](workspace-trust.md)。

## 配置与解析

用户级 `~/.kite-code/kite-code.jsonc` 可选字段 `language` 的值为 `system`、`zh-CN` 或 `en-US`；缺省等同 `system`。它是个人展示偏好，项目 `.kite-code/kite-code.jsonc` 不得覆盖，也不得用于未信任工作区门禁前的语言解析。

`system` 通过宿主 `Intl.DateTimeFormat().resolvedOptions().locale` 的语言子标签解析：语言严格为 `zh` 时使用 `zh-CN`；其他语言、无效 locale 或 `Intl.Locale` 不可用时一律使用 `en-US`。地区不参与判断，因此中文系统语言在任何地区都显示中文。

在 macOS 上，若 TUI 宿主把 `LANG`/`LC_ALL` 覆盖为 `C`，启动时额外读取 `defaults read -g AppleLanguages` 的首选语言；该系统偏好优先于被覆盖的 Node locale。

`TuiBootstrap` 在 workspace 信任门禁前只读取用户级语言偏好与宿主 locale；该读取不得触发项目配置、Skill、MCP、会话或模型初始化。`/language` 不带参数打开选择器；确认后立即更新当前进程并写回用户配置。写入失败不回滚本次显示切换，但必须给出当前 locale 的本地提示。

## 展示与边界

词典位于 `src/app/tui/i18n/`，英文 catalog 是 key 集合的编译期基准，中文 catalog 必须覆盖完全相同的 key。组件经 `I18nProvider` 和 `useI18n()` 取得文案、数字、日期和时长 formatter；不得在 `src/core/` 导入该目录或存储翻译后的文本。

仅翻译 Kite Code 自有的标题、选项、状态、快捷键和安全说明。用户输入、模型回复、工具/MCP 原始输出、Provider 和模型名、命令 token、路径、URL、配置键和未知错误正文保持原样。外部错误可使用本地化的外围说明，但诊断参数不得被翻译或改写。

语言变化是展示 identity 的变化。`useStaticContent` 必须把已解析语言纳入 `presentationKey`，使 Ink 的 `<Static>` 与动态输出按同步输出边界重新构建；不得追加旧语言和新语言两份历史内容。

当前已接入的表面包括 workspace 信任、首次 Provider/API key/配置错误界面、帮助与 slash command 描述、通用偏好选择器、权限/推理深度/主题选择、回退检查点（含确认、文件影响和日期）、会话和模型选择器、审批、问答、计划审核、问答工具卡片的标题/取消状态、运行状态栏和语言选择器。其余 TUI 表面迁移前可以保留既有基准文字，但不得声称已完成全界面覆盖；新增自有文案应优先进入 catalog，并按实施计划补齐双语言测试。
