# TUI Overlay 设计系统

状态：active
读取时机：修改 `OverlayFrame`、通用 Overlay primitive、MCP 管理页、会话/模型/恢复点选择器、帮助/命令建议、审批、问答或方案审核表面时。
验证：`bun test tests/overlay-frame.test.tsx tests/tui-overlay-choice-list.test.tsx tests/tui-slash-suggestion-overlay.test.tsx tests/tui-checkpoint-selector.test.tsx tests/mcp-panel.test.tsx tests/tui-layout.test.tsx`、`bun run typecheck`、相关 TUI PTY scenario。
相关：[`../space/plans/2026-08-04-tui-overlay-design-system.md`](../space/plans/2026-08-04-tui-overlay-design-system.md)、`src/app/tui/components/OverlayFrame.tsx`、`src/app/tui/components/OverlayPrimitives.tsx`。

## 区域 contract

所有普通 TUI Overlay 使用 `OverlayFrame` 的标题、正文、可选消息和快捷键四区结构。Frame 是外层垂直节奏与水平 content inset 的唯一所有者：页面根节点不得再次添加同义 `marginTop` 或 `paddingX`。消息不存在时不渲染空白占位行，不得用单空格 `Text` 固定高度。

标题右侧 `meta` 只显示位置、模式或短状态。路径、时间、数量和说明属于正文或列表次级行。快捷键顺序为导航/输入、主操作、返回或关闭；相同动作分别使用“导航、打开、选择、确认、继续、返回、关闭”。“取消”只表示确实取消业务过程或可见 choice。

## 内容 primitive

- `OverlaySection` 负责分组标题和组间距；
- `OverlayList`/`OverlayListRow` 负责统一选择指示、选中背景、主次文案和尾部状态；
- `OverlayChoiceList` 是 action list preset，不建立第二套行样式；
- `OverlayDetailList` 负责 label/value 对齐、换行和截断；
- `OverlayMessage` 只承载可见 info/warning/error/busy 状态；
- `OverlayEmptyState` 负责空态，不自行补外层留白；
- `OverlayShortcutBar` 只渲染当前 handler 已支持的动作。

列表主行放对象名称与关键状态，次级行放路径、时间、来源和数量。选中项默认使用主题背景；危险项保持相同选择语法并用 error 色表达危险。heading 不可选择，也不参与可操作项编号。长字段必须保留选择指示和状态列，使用 display-width 感知的截断或安全换行。

## 页面与状态边界

List、Detail、Form、Confirm、Empty 五类页面分别复用上述 primitive。页面组件只解释展示状态；route、selection、input draft、controller command 和 Runtime/Core 事实仍由各 Overlay 宿主拥有。

MCP Overlay 的纯视图位于 `McpViews.tsx`，宿主 `McpOverlay.tsx` 保留订阅、路由、键盘和 controller 编排。Server 列表以名称与连接状态为主行，以配置路径和 capability 数量为次级行；布局迁移不得改变 config revision、审批 digest、认证 flow、credential cleanup、catalog binding 或后台连接语义。

First-run/setup wizard 继续使用独立 `FirstRunShell`，不属于本 contract。
