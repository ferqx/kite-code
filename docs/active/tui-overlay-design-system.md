# TUI Overlay 设计系统

状态：active
读取时机：修改 `OverlayFrame`、通用 Overlay primitive、MCP 管理页、会话/模型/恢复点选择器、帮助/命令建议、审批、问答或方案审核表面时。
验证：`bun test tests/overlay-frame.test.tsx tests/tui-overlay-choice-list.test.tsx tests/tui-slash-suggestion-overlay.test.tsx tests/tui-checkpoint-selector.test.tsx tests/mcp-panel.test.tsx tests/tui-layout.test.tsx`、`bun run typecheck`、相关 TUI PTY scenario。
相关：[`../space/plans/2026-08-04-tui-overlay-design-system.md`](../space/plans/2026-08-04-tui-overlay-design-system.md)、`src/app/tui/components/OverlayFrame.tsx`、`src/app/tui/components/OverlayPrimitives.tsx`。

## 区域 contract

所有普通 TUI Overlay 使用 `OverlayFrame` 的标题、正文、可选消息和快捷键四区结构。Frame 是外层垂直节奏与水平 content inset 的唯一所有者：页面根节点不得再次添加同义 `marginTop` 或 `paddingX`。消息不存在时不渲染空白占位行，不得用单空格 `Text` 固定高度。快捷键区必须由整行分隔线与正文分开，不得紧贴最后一个可操作项。

标题右侧 `meta` 只显示位置、模式或短状态。路径、时间、数量和说明属于正文或列表次级行。快捷键顺序为导航/输入、主操作、返回或关闭；相同动作分别使用“导航、打开、选择、确认、继续、返回、关闭”。“取消”只表示确实取消业务过程或可见 choice。

## 内容 primitive

- `OverlaySummary` 负责列表总量与配置范围等页级摘要，位于标题和第一个分组之间，并在后续内容前保留一个空白行；
- `OverlaySection` 负责分组标题、组间距和标题下分隔线，分隔线与组内容之间保留一个空白行；
- `OverlayList`/`OverlayListRow` 负责统一选择指示、选中背景、主次文案和尾部状态；
- `OverlayChoiceList` 是 action list preset，不建立第二套行样式；
- `OverlayDetailList` 负责 label/value 对齐、换行和截断；
- `OverlayMessage` 只承载可见 info/warning/error/busy 状态；
- `OverlayImpactNotice` 负责副作用选择的“将做什么 / 不会做什么”动态提示，统一使用左侧竖线、
  水平 inset，并与前一组选项固定间隔一行；
- `OverlayEmptyState` 负责空态，不自行补外层留白；
- `OverlayShortcutBar` 只渲染当前 handler 已支持的动作，并将按键与说明统一显示为不加粗的浅色文本，不使用主题主色抢占内容层级。

列表主行放对象名称，并在同一行尾部放带语义色的关键状态；次级行放路径、时间、来源和数量。对象浏览列表的选中项默认使用主题背景；紧凑 action/confirm list 只使用 `❯`、粗体或语义色，不铺整行背景。危险项保持相同选择语法并用 error 色表达危险。heading 不可选择，也不参与可操作项编号。长字段必须保留选择指示和状态列，使用 display-width 感知的截断或安全换行。

带搜索的选择器把搜索行视为独立区域：搜索行与结果列表之间固定保留一个空白行，并把该行计入 Overlay 高度预算。结果行之间保持紧凑，不得通过增大每项高度模拟区域间距。

使用 `ScrollList` 的可选择列表必须把每个可选择行作为它的直接子项；不得用单个列表容器包裹所有行，否则 `selectedIndex` 无法定位到实际行，长列表不会随键盘选择滚动。

选择式表单把问题或说明视为独立区域：问题与首个选项之间固定保留一个空白行，同一组内的选项行保持紧凑。多步表单的每个选择步骤都遵循同一节奏，不得仅修补某个 route。

问答、审批和确认页遵循相同边界：问题/上下文、分隔线或 warning callout 与后续选项之间保留一个空白行；连续 callout 之间也保留一个空白行。带显式字段标题的文本输入在标题与输入行之间保留一个空白行，输入值与其辅助说明仍属于同一字段组。

动作涉及删除、禁用、重连、认证、配置写入、权限批准或状态恢复时，当前选项下方必须动态显示
`OverlayImpactNotice`。文案优先使用“将……”说明直接结果，再用“不会…… / …会保留 / 可恢复”
界定影响边界；普通导航、查看和无副作用选择不显示提示。普通动作与禁用/移除等危险动作分组时，
只在组边界留一行，组内选项保持连续单行，不能给每项平均加空行。

## 页面与状态边界

List、Detail、Form、Confirm、Empty 五类页面分别复用上述 primitive。页面组件只解释展示状态；route、selection、input draft、controller command 和 Runtime/Core 事实仍由各 Overlay 宿主拥有。

模型选择器以 `provider + model name` 作为选项 identity 和当前项判定，而不是只使用 model
name；每个 provider 都占独立的加粗 accent 色标题行，并与 model name 文本列对齐；标题与首项紧邻，不同分组之间固定保留一行间距，标题下的选项只展示 model name，
不显示配置的 `default` 标记。
因此不同 provider 可以配置同名模型，列表 key 仍稳定唯一，选择 action 也会保留用户选中的 provider。
向上回到某分组的首个模型时，滚动锚点必须是该 provider 标题，确保标题与首项一同回到视口。
`/model` 不接受 model name 参数；确认命令后始终打开按 provider 分组的模型选择器，由用户明确选择 route。
确认模型后，TUI 将所选 route 绑定并持久化到当前会话，同时把它保存为用户级 `model: "provider:model name"` 简写供新会话使用；会话切换和历史恢复必须还原各自 route，实际模型调用与上下文功能使用当前会话配置。没有真实用户对话的空会话不得因切换模型而生成或显示 context token 估算，新会话也不得继承上一会话的 context snapshot。分隔只使用第一个 `:`，加载器兼容旧 `model.default` 对象；用户配置写入失败时本次会话切换仍生效并显示错误提示。

MCP Overlay 的纯视图位于 `McpViews.tsx`，宿主 `McpOverlay.tsx` 保留订阅、路由、键盘和 controller 编排。Server 列表固定采用“数量/配置范围摘要 → 项目或用户分组 → Server 主次行 → 添加动作 → 分隔后的快捷键”顺序；工具列表使用“工具数量 / Server 名称”摘要，摘要与首项之间保留一行，所有编号共享同一文本起始列；详情固定先展示状态、传输方式、能力和配置位置，再展示操作区及当前副作用提示；普通连接动作与禁用/移除组之间留一行。破坏性确认使用 warning callout，并默认选择“取消”。布局迁移不得改变 config revision、审批 digest、认证 flow、credential cleanup、catalog binding 或后台连接语义。

First-run/setup wizard 继续使用独立 `FirstRunShell`，不属于本 contract。
