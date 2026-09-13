# kite-client-ui

侧栏连接说明只在底部展示一次；端侧可以传入空说明，只保留已授权的连接操作。输入可编辑与发送资格由端侧分别提供，桌面允许先写草稿，Web 继续不提供输入组件。

`SessionPage.newConversation` 提供[新对话欢迎区与上下文栏](src/NewConversation.tsx)：四个建议追加到草稿并聚焦；项目／分支菜单贴合输入区、左边缘对齐各自触发按钮，支持方向键、Enter、Escape 和焦点返回。只接收目录、分支展示数据及已授权回调，不创建会话或运行 Git。新对话的真实创建时机、草稿与原生能力由[桌面入口](../../apps/kite-desktop/docs/new-conversation.md)负责。图标使用该 Figma 节点导出的本地 SVG 资源。

Web 与 Tauri 桌面共用的 React 会话页面 owner。两个生产入口均调用 [SessionPage](src/SessionPage.tsx)，共用[侧栏](src/Sidebar.tsx)、[工作台](src/Workbench.tsx)、[会话阅读](src/Conversation.tsx)、[输入区](src/Composer.tsx)、[Markdown](src/MessageContent.tsx)和[样式](src/style.css)。不从某一 app 导入页面，不维护另一份 Web／Desktop 主界面。全局“新对话”与“工作台”复用同一组左对齐主导航行样式；工作台只按宿主给出的运行状态组织“正在推进”和“最近会话”，没有主题归属和时间条件数据时不显示伪筛选，也不从标题推断。

界面图标统一由 `@hugeicons/core-free-icons` 与 `@hugeicons/react` 提供，不在共享客户端内维护页面专用 SVG asset；品牌图形、用户内容图片和纯 CSS 状态标记不属于该约束。

桌面端可在“工作台”下提供[安排任务](src/ScheduledTasks.tsx)入口。共享页面负责空态和任务列表；点击“新建任务”或“创建第一个任务”后，名称、任务说明、项目、频率和本地／独立 worktree 运行环境表单在最右侧的[通用侧栏容器](src/RightSidebar.tsx)中打开，任务页仍保留在主区域。页面只消费宿主显式提供的任务事实与操作；没有持久化和后台执行 owner 时仍可填写表单，但保存保持禁用并说明限制，不在浏览器状态中伪造可运行任务。

页面外壳使用 shadcn Resizable 组合全高同级栏：左侧导航栏、中间页面栏，以及按需出现的最右辅助栏。左栏默认 236 px、范围 200–420 px；右栏默认 380 px、范围 300–640 px；中栏最小 360 px。相邻栏之间都可拖拽调整宽度。每栏自行包含 52 px 标题区和余下内容区，左栏收起后展开按钮进入中栏标题区；会话 header 只显示会话标题，不重复所属空间。标题最多展示 10 个 Unicode 字符，超长标题的第 10 位为省略号，完整值保留在提示和无障碍名称中。窄屏左栏继续作为覆盖抽屉，不改变中栏内容 owner。

Agent 消息正文由 `react-markdown` 与 GFM 生成无排版 class 的语义 HTML，外层统一使用 shadcn/typeset 的 `typeset typeset-chat`。正文不增加 padding 或独立最大宽度，与消息阅读列使用相同可用宽度。Web 与 Desktop 各自在 Tailwind 入口加载同一上游 Typeset stylesheet 和 Geist／Geist Mono 字体；共享样式只保留链接、文件操作、内容宽度选择和代码／表格溢出等功能规则，不维护第二套标题、列表、代码、引用或表格排版。

视觉约束统一维护在[客户端设计规范](docs/design-system.md)，包含间距用途、排版与对齐、图标按钮状态、滚动边界和验收要求。它是共享组件与 Figma 的设计基准；具体客户端是否已符合仍按实现和运行证据核对。

[完整工具消息结构](../../docs/plans/kite-client-experience.md#会话消息与工具渲染)为已确认设计，尚未完整实现；其中保留全部工具覆盖、现有投影差异与实施验收，不以 Figma 样例替代生产数据。

[子会话下钻](../../docs/plans/kite-client-experience.md#子代理在消息与详情中的展示)为已确认设计，尚未实现：复用主会话页面及消息／工具组件，端侧提供父子身份、读取与已授权操作，共享层不建立独立子代理渲染器。

## 基础控件

共享 [Button](src/components/ui/button.tsx) 、[Textarea](src/components/ui/textarea.tsx) 与 [Tooltip](src/components/ui/tooltip.tsx) 采用 shadcn/ui New York 源码，保留 [MIT 许可](licenses/shadcn-ui.txt)；[页面适配](src/ui.tsx)统一应用现有尺寸与颜色，Button 默认 `type="button"`，Slot 直接使用 Radix 包。[类名合并](src/lib/utils.ts)使用 clsx 与 tailwind-merge。Desktop 通过 Tailwind Vite 插件编译，主题映射至现有变量且不加载 Preflight；Web 的现有 Tailwind 入口扫描共享源码。Tooltip 沿用 Radix 的延迟与定位，详情卡片省略箭头。此接入覆盖共享按钮、多行输入与目录详情浮层，其他组件仍按各自源码核对，不宣称全界面已迁移。

空间标题右侧的新对话按钮仅在端侧提供 `actions.newWorkspaceSession` 时显示；独立于展开按钮，调用已有项目选择流程，不自行创建会话。Composer 保持既有边界，聚焦不叠加描边；禁用原生 resize 手柄，输入使用 14 px Regular 与字体正常行高，避免空白新行的光标随固定行高放大。其他控件保留键盘焦点反馈。

目录默认展示空间名称与会话标题；每个空间按会话 `updatedAt` 倒序排列后再分批展示；相同时间保持原有相对顺序，缺失或无效时间排在末尾，宿主提供新时间后重新排序。首次展开显示 5 条会话，末尾“展开更多”使用辅助文本色，每次追加展示 10 条，不足 10 条时展示剩余部分。收起该空间即重置为 5 条，其他空间的展开数量不受影响。展示数量由 Sidebar 的空间组件持有，复用宿主已有目录数据；端侧数据读取与后续页入口保持原有边界。会话行最右侧用 Spinner 表示 `running`，用 Badge 文案“待用户输入”表示 `waiting` 或已有 `pendingInteractions`，后者优先。`idle` 与 `completed` 不显示行内状态。会话数量、完整状态和更新时间移入详情浮层。工作台继续按自己的汇总语境展示状态，不在空间名称后追加空闲或完成状态。宿主的提交中状态只禁用会发生冲突的操作，不传染为会话目录的视觉禁用；会话切换由宿主按目标 sessionId 保持消息归属。整个目录共用一个 TooltipProvider，首次悬停延迟 500 ms，浮层关闭后 300 ms 内移入其他项立即显示，超时后恢复首次延迟；首次等待中移开取消展示。键盘聚焦可直接查看，Escape 关闭，原生 title 已移除，避免重复提示。浮层使用 Portal 避免目录滚动裁剪。对应回归见 [共享目录测试](test/reading.test.tsx)和 [Web 目录详情测试](../../apps/kite-web/test/directory-details.test.tsx)。

## 数据与权限

会话正文提供按轮复制：每条已发送用户消息单独复制；同一轮 Agent 正文在最后一段提供一个按钮，按显示顺序以空行连接正文，排除思考、工具和子 Agent 输出。未落定的消息或尚未结束的 Agent 轮次不提供复制。按钮在悬停或键盘聚焦时显示；剪贴板写入失败可重试。桌面首条消息的本地发送状态由入口传入，共享组件不负责提交或重试。Composer 的模型列表、权限选择及回调也由入口提供，不补造可用模型或执行授权。

[展示类型](src/types.ts)只包含页面使用的数据，不导入 Runtime、Public API、Native 或 TUI 类型。端侧投影将真实数据转换为这些字段；缺失数据不能从名称或相邻消息补造。共享组件保留展开和阅读位置；服务状态、订阅与恢复由端侧现有 owner 管理。

[`AskQuestionnaire`](src/AskQuestionnaire.tsx)基于 `@shadcn/react/questionnaire` 提供补充问题的共享表单结构、原生单选、自由输入、快捷键和必答校验。组件只接收通用问题数据与提交／取消回调，不导入 Runtime 类型；交互队列、回答传输、取消含义和草稿生命周期继续由端侧 owner 负责。

入口通过已授权的回调提供页面操作：`actions` 决定新建、配置、连接和本地文件打开；`composer` 仅由允许输入的入口提供，不渲染输入框上方的独立状态行，发送／停止回调仍受实时连接、信任和运行状态约束。`interaction` 存在时 `SessionPage` 隐藏 Composer 的提示词输入、模型和权限控件，只呈现当前交互与会话级停止按钮；共享层不复制草稿，交互移除后由同一个端侧 `composer` props 恢复原值。操作缺席时不显示对应入口，本地文件路径退化为文字。没有并列的权限布尔值与操作注册表，也不在共享页面中判断平台名称。此处控制 UI 可用操作，服务端授权保持最终权威。

[Web 入口](../../apps/kite-web/src/app/app.tsx)只提供只读导航，保留 REST、路由、轮询与诊断 owner；[桌面入口](../../apps/kite-desktop/src/App.tsx)提供当前已授权的任务操作和原生宿主适配。诊断、信任、审批和原生辅助面板经具名位置接入；共享页负责它们与会话、输入区的布局，不拥有另一套执行状态。

点击会话或在会话行按 Enter 直接交给入口加载消息，无二次确认。方向键只移动焦点；阅读状态按入口提供的 workspace/session identity 保留于页面实例，跨页面卸载不持久化。多工作区目录由入口通过 `defaultExpanded` 选择默认展开；桌面默认展开，Web 保留按需展开，不提供会话标题搜索。窄屏采用同一侧栏的遮罩展开方式。Light/Dark 使用同一套组件与共享变量；Web 诊断与 API Docs 的独立样式继续由 Web owner 维护。

## 验证

界面默认禁止文本选择，仅会话消息及可编辑输入显式启用原生选择；消息内的按钮、折叠标题和状态标签仍不可选。Markdown 段落与列表项采用内容宽度且不超过正文可用宽度，避免整行选择高亮延伸到列尾空白。消息外的布局空白不可选，避免整段选择越过最后一条消息进入输入区容器。保留双击词语与拖选，不拦截鼠标与复制事件。Ctrl+A／Cmd+A 在会话页面使用原生 Range，将起止点设在可见消息正文的首尾文本；跳过末尾折叠明细和界面标签，输入框保留原生全选。正文列裁剪自身溢出，防止选区高亮延伸到列外。2026-09-11 使用实际共享页面与隔离展示数据，在浏览器核对英文／中文词语双击、整段选择与拖到正文下方空白：调整前整段选区末端进入 `bottom-controls`，调整后停在正文文本。此证据不替代原生 Tauri WebView 的选择高亮绘制验收。

遵循 [HTML 预览优先流程](../../apps/kite-desktop/docs/conversation-ui.md#html-预览优先的界面迭代)。先用真实组件和隔离数据检查布局，再分别验证两端数据接入及受影响原生操作。

`bun run --cwd packages/kite-client-ui test`、`typecheck`，两端的 `test`、`typecheck`、`build`，以及根 `check:runtime-packages`。共享包没有独立打包产物，`build` 核对类型，最终页面由两个 app 的 Vite 构建消费。[权限回归](test/page.test.tsx)核对只读与可操作页面；[桌面 UI 回归](../../apps/kite-desktop/test/ui.test.tsx)覆盖发送、中文组词、审批、停止和阅读位置；[Web 生命周期](../../apps/kite-web/test/app-lifecycle.test.tsx)覆盖只读接入、导航与诊断。

[只读探索](src/ToolExploration.tsx)只按显式工具身份聚合相邻记录，保留失败和真实输出；不猜测 Web 的工具 label。宿主提供 `fileChanges` 时，共享页面把[文件变更](src/FileChanges.tsx)放入同一个全高最右侧容器，并使用 shadcn Tabs 表达会话详情的可扩展标签结构；当前只展示已有事实支撑的“文件变更”标签，不虚构其他详情页。侧栏默认关闭，切换会话关闭；路径操作仍由 `actions.openFile` 决定。侧栏只用页面内状态，无额外存储或运行 authority。

空间摘要的可选 `muted` 仅控制名称的次级文字色，不禁用展开或会话操作。Desktop 用它表示本地目录缺失；共享组件不访问本地文件系统，Web 未提供该标记时保持原样。

共享 SessionPage 的常驻窗口监听与导航回调不持有消息正文或文件变更的历史 props；messages/fileChanges 独立传给当前阅读组件，避免端侧淘汰缓存后首次正文仍被闭包保留。桌面缓存与校准由[桌面历史 owner](../../apps/kite-desktop/docs/history-and-recovery.md#会话正文缓存与校准)负责，Web 数据获取机制不变。
