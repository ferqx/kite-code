`SessionPage.workspaceTab` 让宿主的受管网页内容进入原 `SessionTabs`：共用一条标签栏、同一个8项有界model和原可拖动分栏，不新增详情壳或放大／还原按钮。明确请求按scope／requestId去重并选择已有workspace标签；含该标签时首次调宽62%，后续tab切换保留用户拖动宽度。workspace内容保持挂载，只接收当前可见性；收起／切tab不赋予UI取消任务的权限。标签变更即时保留最新model容量，处理同一commit的并发打开；普通browser释放、child与变更读取仍遵循原owner。

Shell 活动摘要采用原调用的可选 description，省略时沿用命令预览；展开仍显示完整命令和原执行结果。统一 shell_execute 的 background:true 显示后台受理，受理不代表成功或完成；历史 shell.launch 保持原解释。展示不参与风险判断、授权或操作身份。

# UI

`Sidebar` 接受宿主的窗口内 `SessionSummary.awaitingFirstMessage` 展示标记，优先排列新出现且尚无首条消息时间的会话；这些会话之间按可选 `awaitingFirstMessageOrder` 从大到小排列，只传原布尔标记时保留原排序。标记撤下后忽略次序，继续按 `updatedAt` 排序，不改变悬浮提示中的消息时间。Native 的新增识别与冷读隔离归 [Desktop owner](../../apps/desktop/README.md)。

[SessionPage](src/desktop/SessionPage.tsx)接受可选 `sidebarSelected`，让宿主已核实的本次新会话行在正文仍准备时接管唯一导航高亮。它不改变正文的 `selected`、输入节点或操作资格；工作台／定时任务仍优先，未提供该字段时保原准备页的空间选中规则。[共享页面](test/isolated/desktop-session-page-render.test.tsx)与[侧栏](test/isolated/desktop-sidebar-render.test.tsx)两个完整文件25项／313断言通过；首次目录／回执的 DOM 和实际 Native 过程证据归上述 Desktop owner。

[Conversation](src/desktop/Conversation.tsx) 允许宿主在首轮尚无 Run 时显示本地准备状态，使用同一原提交的展示键过渡到核实后的 Run。状态行位于所属轮次，接收宿主的模型派发事实，正文和已有过程按原顺序显示。自动打开的实时过程直接使用完整高度，用户手动展开已结束的过程时仍播放过渡。若完成的 Run 仍对应尚未更新的流式正文，已显示的过程和正文保留至最终消息接管，轮次完成状态即时生效。业务事实和实窗验证见 [Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。

全局原生滚动条在[共享样式](src/desktop/style.css)中使用当前主题前景色与透明色混合：普通滑块不透明度为10%，悬停／拖动为18%，轨道透明。深浅主题使用相同比例，覆盖会话、嵌套详情、侧栏、附件列表及Portal原生viewport。支持`::-webkit-scrollbar`且未开启强制颜色时，将标准滚动条属性恢复为`auto`，让滑块悬停／按下样式实际生效；当前Windows Chromium的轨道显式保留10px占位。其他浏览器沿标准细滚动条，悬停由浏览器处理；强制颜色模式保留标准原生绘制，不覆盖系统配色。原生滚动交接仍交给浏览器，不增加wheel接管。

2026-11-06，Windows／Bun1.4.4，20%／32%版本的既有会话与嵌套滚动两个完整回归文件6项／846断言通过，定向Biome及隔离工作树文档检查通过，隔离客户端生产CSS编译通过。随后按实际反馈进一步降至10%／18%，只调整颜色混合比例；上述回归仅复用于未变化的滚动逻辑，不证明新比例的外观。IAB连接本机服务超时，本机Chrome观察被Computer Use因无法可靠识别当前URL而停止，深浅主题的实机外观与拖动过程验收仍未完成。

同日补核hover：标准属性会覆盖WebKit滑块样式，Windows Chrome156的原生暗色悬停像素为178／178／179，不随10%或18%的滑块色降低。修复后隔离浏览器加载实际生产编译CSS，连续观察会话、详情和Portal的静止／悬停／按下／拖动／移开：浅色滑块为228→211→228，深色为46→63→46，按下和拖动不再使用高亮系统灰；三类viewport及附件保留10px占位，强制颜色下恢复标准原生绘制；连续滚轮到内层边界后交接外层。截图及数据在本机`.cache/scrollbar-hover-20261106/`。另核到Chromium差异：拖动后立即程序定位或End到内层底部，首个边界wheel可能被原生控件消费，下一次恢复交接；标准原生路径在同条件下首个wheel即交接。该差异也在真实共享ScrollArea隔离组件中复现，尚未核完整Native窗口；本轮不宣称完整客户端滚动体验验收通过。

`ToolActivity` 为宿主已核实的 `view_images` 结果显示图像图标、“已查看 N 张图像”与120px圆角缩略图，默认展开，标题按钮可折叠，多图保持120px并自动换行；成功消息不直接铺原始 JSON。计数来自准确成功回执的展示字段，运行、失败、取消和未核实结果不计入成功数。宿主通过原图片 reader 提供缩略图，混合工具分组保持原顺序且不重复渲染图片；后续加入普通工具不会自动折叠已展示的图片，用户显式折叠仍优先。[聚合回归](test/isolated/desktop-tool-aggregation.test.tsx)覆盖计数、增量展开与取消／失败；Native 的真实图片、读取租约及组件过程归[Desktop owner](../../apps/desktop/README.md)。

[Sidebar](src/desktop/Sidebar.tsx)接受宿主确认的 `SessionSummary.hasUnreadTurn`，在会话行右侧显示8px蓝色微光圆点，并补充“有新结束的回复”无障碍描述；原运行中图标与待输入提示保留。提醒不增加行高、不执行读取或业务操作，已读与持久化由[Native owner](../../apps/desktop/README.md#native-项目会话目录)负责；Web 未提供该标记时保持原目录行为。

同一会话行接受宿主确认的 `SessionSummary.hasCreatedWorktree`，在右侧显示14px Git 分支图标，并在无障碍描述与原悬浮提示中说明“已创建 Git 工作树”；它与运行中、待输入及未读标记并存。UI 不自行检查目录或读取工具正文，字段缺失时不显示；[Sidebar 回归](test/isolated/desktop-sidebar-render.test.tsx)核对标记接管、原节点保留与状态共存。历史事实及持久读取由[Native owner](../../apps/desktop/README.md#native-项目会话目录)和其上游负责。

会话行的运行中与等待执行 Spinner 和空间操作图标在[共享样式](src/desktop/style.css)中统一消费 `--ui-icon-size`（14px）；会话 Spinner 单独使用2.4秒一圈的匀速动画，其他加载位置沿用原速度。会话标题的左缩进按空间行的10px内边距、图标宽度与10px间距计算，与空间名称左缘对齐；选中背景仍覆盖整行。

2026-11-09，Windows x64／Bun1.4.4，`e8a483d65`加会话缩进修复：两份侧栏完整回归14项／393断言、定向Biome、隔离Native生产样式编译及文档检查通过。用户截图中的旧26px缩进改为34px，与空间行文字起点一致。IAB连接本机服务超时，本机Chrome观察因工具无法可靠识别当前URL而中止，修后实际外观及折叠／切换全过程尚未验收；不以DOM回归或编译结果代替实机结论。

应用确认框另有公开的 `@kite-ai/ui/desktop/confirmation` [专用入口](src/desktop/confirmation.ts)，只重新导出原 `ApplicationConfirmationDialog` 与 Full 确认组件；[Desktop 构建](scripts/build-desktop.ts)同步产出 `confirmation.js`。固定确认页面无需通过桌面总出口加载会话 Markdown／公式／高亮初始化，统一呈现完全权限、空间移除、提供商删除与技能卸载确认。确认文案和样式由共享组件负责，焦点恢复和动作提交由调用方负责。共享加载动画 `conversation-loading-shimmer` 的关键帧位于顶层，保留原动画参数与减少动态效果覆盖，避免生产 CSS 优化器拒绝嵌套关键帧。

表单样式按职责分类：主题提供`--card`、`--input`与8px的`--form-control-radius`；公共Input／Textarea／SelectTrigger共用[form-control](src/desktop/components/ui/form-control.ts)的背景、边框、文字、焦点、禁用和无效状态，控件自身只补尺寸及各自语义。`ui-form-control`标记使旧原生控件兜底避开这些组件，因此脱离设置页容器仍保持相同外观；Native不再为它们另设错误边框或禁用透明度。公共Select的浮层选项直接消费同一圆角token。右栏表单与底栏沿用RightSidebar背景，容器只提供布局和表单内选择器形态变量，PillSelectTrigger在表单内使用常规圆角。

公共控件自行负责图文对齐：[Select](src/desktop/components/ui/select.tsx)的箭头保持块级、不可收缩的14px图标，选项勾选由Radix `ItemIndicator asChild`直接挂到SVG；[DropdownMenu](src/desktop/components/ui/dropdown-menu.tsx)的单选与复选标记同样消费 `--ui-icon-size` 并在固定图标位中居中，消除行内SVG基线产生的额外高度。胶囊选择器的 `.pill-select-label` 使用 `text-align: start`，在宽控件与长名称截断时仍紧随前置图标；[TabsTrigger](src/desktop/components/ui/tabs.tsx)与[Badge](src/desktop/components/ui/badge.tsx)分别提供6px、4px图文间距。其他按钮、输入与控件行高继续由原组件维护。

2026-11-07，Windows x64／Bun1.4.4，`5d39518e1`加本轮公共控件调整：[选择字段](test/isolated/select-field.test.tsx)、[侧栏菜单](test/isolated/desktop-sidebar.test.tsx)、[Native页面](../../apps/desktop/test/isolated/native-new-conversation-dom.test.tsx)、[会话标签](test/isolated/desktop-session-tabs.test.tsx)及[定时任务](test/isolated/scheduled-tasks.test.tsx)五份完整回归155项／2859断言通过，UI／Desktop类型、五文件Biome与生产Vite编译通过。隔离浏览器逐步核实际公共组件和Native页面的深浅主题、中英文、13／14px、210px长名称截断、下拉选择、复选／单选切换、键盘标签切换、输入、Escape及返回会话；下拉与菜单勾选由偏上约2.3px收敛至中心偏差0，主题菜单标记由24px改为14px，胶囊文字沿起始端对齐，前后图标保留完整尺寸。返回后草稿保留，用户与助手消息各一份，浏览器无错误或警告。截图与几何记录归本机 `.cache/component-alignment-20261107/`。此为实际组件与生产资产的隔离验证，未重验完整安装版Electron、真实Service或其他平台。

2026-11-07，Windows x64／Bun1.4.4，`5d39518e1`加本轮侧栏补修：用户实际截图暴露主要导航10px、空间行4px的间距差及字面偏上，前一轮图标框中心的几何检查未覆盖这两点。生产CSS编译与单文件Biome通过；在普通运行的Kite窗口观察默认与定时任务选中态、返回原会话、空间折叠与重新展开。捕获画面中三行文字左缘由47／47／41px统一为47px；按可见文字像素边界核对，补偿后英文空间名的垂直中心与图标一致，两项中文导航的中心差为0.5个捕获像素。主区原用户／助手消息各一份，原空草稿与展开状态保留。本轮仅修改CSS，复用上述未变组件的155项行为回归与类型结果；实际截图、字面边界数据及最终窗口状态归本机 `.cache/sidebar-optical-alignment-20261107/`。该补验覆盖当前Windows普通开发窗口，不代表完整安装或其他平台资格。

普通表单的枚举选择共用[SelectField](src/desktop/components/ui/select-field.tsx)，在公共Select上组合受控选项、显式空选项和必填校验；内部值编码只用于控件，回调始终返回原选项值，不因选项重建自动选择或清空草稿。浮层优先挂到当前Dialog，其次当前`.kite-client`，保留主题与嵌套Escape范围；字段值由宿主React状态序列化，不提供原生FormData的name接口。[定向回归](test/isolated/select-field.test.tsx)覆盖清空、必填、任意原值与选项重建。普通Button自行提供焦点环，旧原生按钮兜底避开`data-slot=button`；Button与Popover显式消费主题文字／边框色，表单控件与浮层采用border-box，脱离`.kite-client`的Portal也不依赖浏览器默认文字色或盒模型。Desktop编译扫描UI完整源码，使共享根入口表单的尺寸类同样进入生产CSS。

2026-11-03，Windows x64／Bun1.4.3／Chrome156，普通控件统一使用现有隔离运行器逐文件核49个非TUI UI文件及11个Desktop文件，共60个完整文件通过；覆盖原身份、问答与方案草稿往返、重复提交、未知结果、浏览器操作与注释、提示生命周期、模型设置及定时任务。[方案DOM回归](../../apps/desktop/test/isolated/native-plan-review-dom.test.tsx)按公共选择器更新可见值断言，仍核原反馈、明确模式与准确回执；[问答DOM回归](../../apps/desktop/test/native-questionnaire-dom.test.tsx)按当前手册通过侧栏原会话返回。实际组件与编译样式在隔离浏览器逐步核深浅主题×1280／390px四组44个操作阶段，包括菜单、提交中禁用、失败保留、注释编辑／保存／删除、内层Escape与旧元素失效后的清空；浮层输入不越界、深色按钮可读且页面无异常。另核公共基础及包装按钮的四组键盘焦点过渡，终态仅保留公共3px焦点环。截图与计算样式在本机`.cache/public-controls-20261103/`；UI／Desktop类型及定向Biome通过。此证据覆盖共享呈现与隔离Native集成，不扩大正式安装版或真实网页业务资格。

[公共Tabs](src/desktop/components/ui/tabs.tsx)的TabsTrigger自行清除浏览器默认按钮边框与背景，并继承父层常规文字色；选中与键盘焦点由公共组件呈现。旧原生控件焦点兜底避开`data-slot=tabs-trigger`，避免叠加第二套outline。RightSidebar、会话标签页和模型提供商列仍保留各自已有布局与展示覆盖。2026-11-03，Windows x64／Bun1.4.3／Chrome156，公共筛选页隔离生产CSS核深浅主题×1280／390px四场景共28个操作阶段及无任务状态：鼠标选择、方向键、Home／End、搜索交集、无匹配及清除恢复均保持正确数量与面板关联，无默认按钮边框、重复焦点描边或横向溢出。过程截图和计算样式在本机`.cache/scheduled-filters-20261103/`；定时任务、Native页面、会话标签、模型浮层与共享页面五个完整文件67项／752断言，UI类型与定向Biome通过。此范围为共享组件及隔离浏览器，未扩大Native安装发行资格。

[Switch](src/desktop/components/ui/switch.tsx)自行管理36×20px轨道、16px滑块和两端2px留白，显式设置border-box、起始对齐及零padding，避免原生button内边距将圆点推偏或推出轨道；开关两态及切换中保持垂直居中，颜色与滑动过渡遵循系统减少动态效果设置。业务层继续只传入受控状态、禁用状态和变更回调。

2026-11-01，Windows x64／Bun1.4.3，Switch内边距修复：模型、联合设置和提供商三个完整文件151项／2021断言，UI／Desktop类型、四文件Biome和文档检查通过。[几何回归](../../apps/desktop/test/session-shell-geometry.fixture.ts)定向执行深浅主题×正常／减少动态效果四场景，核独立开关及实际Native模型浮层中的两态、禁用、点击和Space切换；逐帧检查圆点不越界、垂直居中，动画完成后对应端留白为2px，减少动态效果时轨道和圆点均不执行过渡。浏览器矩形采用0.1px浮点容差，截图与数据归`.cache/switch-check-hWiG2r/`。实际Windows开发窗口只读观察原模型浮层，另逐步观察隔离开关点击、键盘切换及中间位置到终态；未改动用户模型启停配置，页面零异常。产品启停与受控提交语义核对保持，不扩大完整安装或其他平台资格。

2026-11-01，Windows x64／Bun1.4.3，表单样式归属整理：提供商、模型、联合设置、MCP、Skills、Native页面／菜单、定时任务和SessionPage九个完整文件283项／4257断言，UI／Desktop类型、九文件Biome、文档结构／影响、测试归属及边界检查通过。[现有隔离入口](../../apps/desktop/test/session-shell-browser-runner.fixture.ts)的[组件样式与几何函数](../../apps/desktop/test/session-shell-geometry.fixture.ts)定向执行12组：深浅主题下，脱离设置页的三类控件在正常、无效、禁用及键盘焦点时保持相同外观，禁用和输入／选择语义有效；另外十组右栏共1969帧核对边界、滚动、统一宽度及草稿恢复。实际逐步观察独立组件输入／选择／焦点，以及Native设置长表单输入、MCP校验从名称错误转到地址错误时的边框和焦点恢复，页面零异常。生产编译制品与原始数据归`.cache/form-components-2Jxlba/`。产品样式承诺核对保持；完整会话视觉段沿用[Native owner已记录的限制](../../apps/desktop/README.md#复用原桌面展示层)，此项不取得安装版或其他平台资格。

[RightSidebar](src/desktop/RightSidebar.tsx)导出的`RIGHT_SIDEBAR_FORM_DEFAULT_WIDTH`统一定义420px固定表单宽度，SessionPage与Native设置通过`--right-sidebar-form-width`交给各自的布局消费。定时任务表单使用静态分隔线，关闭拖拽与键盘调宽；会话阅读详情仍沿原约束调宽。内容外框不足800px时与设置一样改为覆盖，窄于默认值时按外框收缩。窄窗中暂存的展开尺寸在恢复宽窗时取得真实分配，不重挂载草稿；关闭会清除该待恢复意图。重复新建不递增编辑器 generation，草稿、原创建身份和输入节点保持；关闭后新建才建立新编辑器。

Desktop入口导出公共shadcn Input、Textarea、Select和Switch供Native设置复用。Select使用Radix触发器、选项和可指定容器的Portal，Switch保留受控的`checked`／`onCheckedChange`及无障碍语义；共享样式的旧设置按钮兜底避开带`data-slot`的公共组件，防止覆盖开关几何和状态底色。`SessionPage`导出的`NAVIGATION_MIN_WIDTH`同时提供设置导航宽度，数值只在共享布局中维护。`RightSidebar`内的定时任务和Native配置表单共用`.right-sidebar-editor`、`-body`、`-footer`结构：标题和底栏固定，中段收缩并独立滚动，内容与底栏留白分别为12px和8px／12px；正文也是绝对定位辅助控件的包含块，隐藏表单控件不撑开外层栏体。设置页的布局与实际验证归[Desktop owner](../../apps/desktop/README.md#复用原桌面展示层)。

新增Select沿现有Dialog的Radix依赖族锁定版本，共用DismissableLayer与FocusScope，避免嵌套菜单的Escape同时关闭父层；更新依赖时须保留该嵌套交互回归。Native的选择器组合仅提交当前选项中的值，条件选项重建时隐藏表单控件的空值通知不会清空已选的凭据处理方式。

共享 [QueuedMessages](src/desktop/QueuedMessages.tsx) 只在宿主提供 `onSteer` 时显示每条“引导发送”，`steerable` 与 pending 门禁决定可操作性；它只返回准确原 ID，不自行撤回、发送、改变当前 Run 或消费草稿。普通 Native 发送先排队，实际原子转换、原回执与前台工具等待由 [Native owner](../../apps/desktop/README.md#原运行中消息队列)和 Agent 负责。[队列组件回归](test/isolated/desktop-queued-messages.test.tsx)核显式点击、禁用和保留原条目；Main 成功核实后才由宿主更新。

桌面会话的正文阅读列与底部输入区通过[共享样式](src/desktop/style.css)统一采用 740px 最大宽度，水平居中；可用空间不足时继续随容器缩小。“回到最新消息”的覆盖层与正文视口共用内边距、滚动条预留和环境信息占位，保持按钮中心对齐；按钮采用圆形、浅阴影与不透出正文的悬停底色。会话容器建立独立层叠上下文，正文为0层，置底覆盖层为1层，仍位于外部环境卡及弹层之下；图标复用会话忙碌事实，活动时为三点跳动，静态时为向下箭头。左侧当前页面按钮与会话项使用与悬停相同的选中底色，文字颜色和字重不变，悬停／按下仍共用即时反馈。`SessionPage` 根据实际页面标记新对话、工作台或定时任务；新对话选定的项目 ID 匹配当前空间目录时，通过 `selectedWorkspace` 将唯一选中语义标记在空间按钮，并由整行 `.space-heading.selected` 保留原悬停底色，替代“新对话”的高亮。未选项目或目录中已无对应空间时仍标记“新对话”；项目切换、读取忙碌与空间折叠不改变这套归属。这些页面打开时不同时高亮宿主保留的旧会话，返回会话后恢复对应项。Native设置分类的选中高亮与键盘焦点由[Desktop owner](../../apps/desktop/README.md#交互状态与透明材质)维护。

2026-10-25，Windows x64／Bun1.4.3，`b31d05415` 加本轮工作树，重新打开新对话往返抖动：复查时文档已记录统一占位，但负责源码仍为挂载后测量滚动条、固定环境卡基础留白的旧实现；此前临时浏览器证据不适用于该源码。现补齐首帧CSS轨道预留、28／20／12px响应式留白，回到最新消息的覆盖层也显式沿相同轨道占位，不再额外建立原生滚动条预留。[原浏览器runner](../../apps/desktop/test/session-shell-browser-runner.fixture.ts)接入[持久几何回归](../../apps/desktop/test/session-shell-geometry.fixture.ts)，原隔离bridge可显式提供首Run封存协议与40段长正文，普通DOM消费者的原夹具输入保持。修复前新增回归实际复现按钮对齐失败；修复后单独执行完整几何段：Chrome155深浅主题、500／800／1440／1920px八组，包含选择等待、模型准备、历史读取、完成、上翻和缓存返回，1446帧的输入区横纵位置、宽高及消息列对齐保持；两份草稿保留，返回后准确恢复80px阅读位置，无重复输入区和浏览器异常。原[侧栏](test/isolated/desktop-sidebar.test.tsx)与[滚动](test/isolated/desktop-conversation-scroll.test.tsx)逐文件10项／1100断言、UI／Desktop类型检查、定向Biome、测试归属与文档检查通过。未重跑原shell runner其余200次切换段、真实Service／模型或完整安装版Electron；保留既有嵌套关键帧编译提示。

侧栏会话运行中与普通执行等待的 `Spinner` 在[共享样式](src/desktop/style.css)中与空间编辑／更多图标共用14px尺寸；不修改公共Spinner或其他加载图标。2026-10-25，Windows x64／Chrome155，实际Sidebar与生产编译CSS的隔离浏览器在深浅主题、1280／500px四组场景逐步核悬停、持续旋转、运行→空闲→运行：loading与编辑图标均为14×14px，状态切换保留32px行高与原行宽，页面无横向溢出或浏览器异常。定向Biome与文档检查通过；本轮仅调整局部样式，未重验完整安装版Electron。

2026-10-23，Windows x64／Bun1.4.3，`5c28cd1fd` 加本轮样式工作树：逐文件运行 `bun test ./packages/ui/test/isolated/desktop-conversation-scroll.test.tsx` 与 `bun test ./packages/ui/test/isolated/desktop-sidebar.test.tsx`，6项／885断言通过；UI／Desktop typecheck、定向 Biome、文档检查通过。实际 SessionPage／Conversation 与生产编译 CSS 在隔离浏览器中逐步核对上翻、内容追加、运行到静态、回到底部恢复跟随、环境信息展开／收起及侧栏悬停／选中；1280／1600px 和390px、深浅主题下按钮32px且与正文中心误差小于0.01px，窄屏无横向溢出，追加保留手动阅读位置。该轮侧栏与设置分类计算样式均为零过渡，选中项移开后透明；当前侧栏选中底色已按上文要求恢复，下文新证据覆盖此变化。圆形与层级调整后补验深浅主题、活动／静态、悬停及点击：32px按钮的圆角为50%，浅阴影为2px／8px／14%，覆盖层1高于正文0且限定在会话层叠上下文；正文重叠区域命中原按钮，悬停底色不透明，点击后隐藏按钮并到达底部。未重验完整 Electron 安装版；保留既有加载动画的嵌套关键帧编译提示。

2026-10-25，Windows x64／Bun1.4.3，新对话空间高亮：原[侧栏回归](test/isolated/desktop-sidebar.test.tsx)整文件7项／281断言通过，覆盖未选项目、两个项目间切换、读取忙碌、目录目标失效、定时任务及返回旧会话，始终只有一个选中项。UI／Desktop类型检查通过；实际 SessionPage、Sidebar、项目选择器与编译 CSS 在隔离浏览器中逐步核对选择ToDesk→切换Kite→折叠空间→定时任务→返回旧会话，高亮随目标转移，鼠标移开后保留，折叠不丢失选中态，草稿保持；未重验完整安装版Electron。

2026-10-23，侧栏选中底色恢复：现有[侧栏 DOM 回归](test/isolated/desktop-sidebar.test.tsx)增加页面往返与保留旧会话不重复选中的断言，整文件6项／251断言通过，UI／Desktop类型检查通过。隔离浏览器加载实际 SessionPage、Sidebar 和生产编译 CSS，逐步点击定时任务、新对话及两个会话，再移开鼠标；深浅主题、1200／540px共16次切换始终只有一个选中项，底色与原悬停一致，文字颜色／字重不变且过渡为0s；键盘Enter激活与浏览器零异常通过。此证据覆盖共享页面展示，不代替完整Electron／Service或原生材质验收。

[公共 Button](src/desktop/components/ui/button.tsx)按[桌面规范](../../docs/handbook/clients/desktop/README.md)提供 `icon-xs/icon-sm/icon/icon-lg` 四档，消费[共享样式](src/desktop/style.css)的 `--icon-button-size-*`、`--icon-button-size` 与公共 `--button-radius`；各档显式取消 padding、内部 gap 和最小高度叠加，使用居中图标形成固定留白。普通SVG默认消费`--ui-icon-size:14px`，Button、菜单、Command、Spinner及Trace／Marker沿同一变量；原16px的工具／轮次箭头、输入操作及菜单局部覆盖同步调整，按钮点击区域和图标轨道容器尺寸保持，原独立的大图标按用途保留。文字按钮的 padding／min-height 规则排除所有 `icon*` 尺寸，包装 Button、设置、审批及结果区域保持同一几何规则。输入区和侧栏切换使用32px标准档，标签关闭、审批翻页和代码复制使用24px紧凑档，移除相关局部尺寸与图标覆盖。

[SettingsNavigationIcon](src/desktop/SettingsNavigationIcon.tsx)由UI workspace拥有Hugeicons依赖，为Native设置导航提供返回、常规、提供商与模型、MCP与Skills五种装饰图标，统一标记`data-icon="inline-start"`与`aria-hidden`；宿主沿共享14px尺寸变量控制布局，图标不增加Tab停靠或业务行为。

Desktop入口导出现有[Popover](src/desktop/components/ui/popover.tsx)的 Root、Content 与 Trigger，供宿主组合按钮锚定浮层；Content可选 `container` 转交原Radix Portal，未指定时仍沿原body目标。Native设置将浮层挂在当前设置Dialog内，保留主题和焦点范围并避开卡片／滚动区裁剪；浮层状态和配置操作仍归宿主。

[MessageCopyButton](src/desktop/MessageCopyButton.tsx)沿公共 `icon-sm` 使用28px按钮、14px图标及统一8px圆角，默认、成功和失败状态保持相同尺寸；不再单独指定按钮宽高。`--control-gap: 4px` 统一控制按钮与时间的横向间距，`--message-meta-offset: 2px` 保留用户气泡／Agent正文到信息栏的垂直间距；含信息栏的消息保留 `28 + 2 + 8 = 38px` 底部空间，确保工具栏与下一条消息至少间隔8px。悬停／聚焦显示和准确原文复制继续沿原生命周期。

[Conversation](src/desktop/Conversation.tsx)的 `.message-meta` 将复制与时间放在正文下方同一行，用户消息反向排列为时间在左、复制在右。渲染按真实位置区分独立消息、Turn 过程和轮次结果；过程内的非用户正文不生成信息栏，悬停／聚焦也不补出时间或复制，因此不会触发信息栏的额外间距。首条输入、用户引导、过程外最终回复及独立 Agent 结果沿原规则显示，最终正文复制资格不变。被动时间显示不恢复任何复制或读取资格。信息栏使用 `user-select: none`，聊天全选寻找正文端点时同样排除它。[时间格式](src/desktop/message-time.ts)只接宿主 `Message.createdAtMs`，按本地日历区分当天、昨天、本年日期和其他年份；不以24小时差推断昨天，完整 `time` 语义保留 ISO instant、秒与原时刻 UTC 偏移。悬停／聚焦消息重新计算日期标签；缺失或无效时间保持未知，不调用当前时间补造来源。格式回归见[日期边界](test/desktop-message-time.test.ts)，复制与全选回归沿原[消息复制文件](test/isolated/desktop-message-copy.test.tsx)。

2026-10-23，macOS／Bun1.4.2：消息复制、轮次过程、Agent 邮件与 Native transcript DOM 四个完整文件31项／1800断言通过，UI／Desktop typecheck、格式及边界检查通过。实际 SessionPage／Conversation 与生产编译 CSS 在隔离浏览器的深浅主题、1280／390px四组场景中逐步核悬停、聚焦、流式到完成、折叠展开及冷重挂；原信息栏28px高度与38px预留可复现，修复后过程中间正文和 Agent 邮件不生成信息栏，首条输入、引导及最终回复通过浏览器 Clipboard API 写入和读回的原文一致。268条布局／复制观察和补充长历史136条观察没有额外信息栏误现、横向溢出或页面错误；上翻阅读期间追加和完成均保持400px位置。证据保留在 `.cache/message-meta-audit`，夹具不读取用户 Store、不启用生产诊断；未重验完整安装版 Electron 或 Native 系统剪贴板。

2026-10-23，Windows x64／Bun1.4.3，`de498789b` 加本轮工作树：逐文件执行 `bun test ./<原测试路径>`，原[消息复制](test/isolated/desktop-message-copy.test.tsx)、[代码复制](test/isolated/desktop-code-block.test.tsx)、[侧栏](test/isolated/desktop-sidebar.test.tsx)、[标签页](test/isolated/desktop-session-tabs.test.tsx)、[排队消息](test/isolated/desktop-queued-messages.test.tsx)及[输入框](test/isolated/prompt-editor.test.tsx)六个完整文件27项／427断言通过，UI／Desktop typecheck 与定向 Biome 通过。Chrome155.0.8059.85 的隔离浏览器在基础／包装 Button、设置、审批和结果区域核22个图标控件；实际 SessionPage 配合生产编译 CSS 在深浅主题、1280／390px四组场景逐步核悬停、复制成功、复制失败和聚焦。按钮28px／图标16px，工具栏内4px、正文下方2px，下一条消息至少保留8px，反馈不引起尺寸或位置跳变，无横向溢出和页面错误。夹具只使用模拟回调，不读用户数据，未重验完整安装版 Electron。

2026-10-23，Windows x64／Chrome155、当前生产 Conversation／Native 消息适配及编译 CSS，在深浅主题、1280／390px、Asia/Shanghai 固定日历下核四组操作：观察用户与 Agent 的时间位置、当天／昨天／本年／跨年及未知显示、原输入接管、复制成功／失败、流式追加和完成、重挂载历史、跨午夜再次悬停。时间和消息保持一份，较晚业务消息不覆盖原输入时间；正文实际增高时保留手动20px阅读位置，复制与全选不含信息栏，控件与下一条消息保留至少6px，无横向溢出或页面错误。日期格式另以 America/New_York 跑过夏令时与闰日断言；原消息复制3项／52断言通过。UI／Desktop 类型检查、生成 API、边界与文档检查通过。此为隔离组件与真实协议的分层证据，未重验完整安装版 Electron；保留既有嵌套 `@keyframes` 编译提示。

2026-10-23，Windows x64／Chrome 155，实际 Conversation 与生产编译 CSS 在深浅主题、1280／390px 四组隔离浏览器检查中通过：逐步观察悬停→复制成功、复制失败及键盘聚焦，按钮始终 32px、图标 16px、圆角 8px，最终回复按钮与下一条消息保留 6px 间距，无横向溢出或页面错误。原[消息复制回归](test/isolated/desktop-message-copy.test.tsx)3项／48断言和 UI typecheck 通过；未重验完整安装版 Electron。

桌面 [共享样式](src/desktop/style.css)的空间添加按钮与行内编辑按钮使用透明背景和图标变色反馈；Composer 的聚焦边色／阴影遵循宿主根元素的 `data-input-modality`，pointer 状态不保留焦点装饰。未提供该状态的宿主沿原焦点规则。Dialog／Sheet 关闭按钮使用 `focus-visible` 提示；Native 的统一鼠标／键盘判定和窗口验证由 [Desktop owner](../../apps/desktop/README.md#复用原桌面展示层)负责。

空间添加、行内新对话和更多由独立的 `.sidebar-actions` 容器负责显隐；内部公共按钮只负责禁用反馈。父容器隐藏时，子按钮的禁用透明度、Tailwind 样式或选择器优先级变化均不会使其显现，不再通过提高按钮隐藏选择器的优先级维持这条边界。悬停、行内聚焦、菜单打开及触屏仍按原条件显示；可见且禁用的操作沿公共按钮的0.45透明度弱化。父容器保留布局与键盘访问，禁用和业务串行门禁仍由原按钮及宿主执行。[默认浏览器回归](../../apps/desktop/test/isolated/sidebar-actions-browser.test.ts)构建生产 CSS 并通过原 Native 处理函数覆盖目录选择等待／取消、发送等待／未知回执恢复、逐帧显隐、DOM 身份、Tab、菜单和触屏；同时强制将按钮设为 `opacity:1!important`，验证父层仍能保持隐藏。它进入默认测试和 Required unit；[测试准备](../../tests/README.md#侧栏显隐浏览器回归)说明浏览器依赖。

侧栏底部“个人工作区”保持14px、400常规字重，由 `.profile-card strong` 显式指定。主要导航与空间名称统一采用14px图标、10px图文间距与相同文字起点；标签使用 20px 行高，并与图标在 32px 行内垂直居中。空间行内操作为新对话与更多，图标固定为14px，采用紧凑 `icon-xs` 按钮；点击区域为24×32px，行内不额外添加按钮间隙。更多和个人工作区弹层共用 `.sidebar-menu`，分别向下／向上展开并左对齐原触发按钮；沿项目选择器使用13px字号、18px行高、28px选项与4px／8px上下／左右内边距，主题标题同为13px，单选项保留原勾选留位。弹层宽度随内容调整，最小160px、最大240px并受窗口留白限制。移除空间使用正常文字色，只有选择该菜单项才调用原Workspace ID的移除回调；打开或取消菜单不提交移除。空间提示与更多菜单由所在行的展示状态互斥；打开菜单立即关闭并卸载提示内容，避免提示退出动画与菜单重叠，菜单打开期间不再显示该空间提示。关闭菜单后继续抑制提示，焦点回归、同一行内点击或移动均不重开；鼠标离开空间行并重新进入后才恢复原提示行为。菜单打开期间通过所在行的 `data-menu-active` 保持空间行与两个操作按钮可见。关闭菜单时立即撤销该标记；`onCloseAutoFocus` 统一读取所在行的真实 `:hover`，鼠标在行外就取消触发器焦点回归，两个按钮直接隐藏；鼠标仍在行内才允许原焦点回归，由悬停维持按钮可见。Esc与鼠标关闭遵循同一规则，不保留输入方式分支或延迟隐藏。忙碌时触发器与移除项均禁用，Esc沿Radix关闭，焦点是否返回遵循同一悬停条件。空间行内操作的显隐归父容器，禁用前后均按悬停／`focus-within` 显示，触屏沿原媒体查询常显。子按钮禁用仍阻止点击和指针事件；忙碌本身不改变父层显隐。Composer 的 `sending` 仅表达实际输入提交，普通权限／管理操作通过各自忙碌状态及 `disabled` 门禁表达。

2026-10-25，Windows x64／Bun1.4.3：原[侧栏回归](test/isolated/desktop-sidebar.test.tsx)8项／296断言和Native新对话整文件82项／1668断言通过，覆盖更多菜单零提前移除、忙碌禁用、准确空间ID、原unknown查询，以及关闭后焦点与行内指针移动不重开提示、离行再悬停恢复；UI／Desktop类型检查通过。实际NativeDesktop／Sidebar与编译CSS逐步观察点击行→更多→Escape、键盘Enter→Escape及重新打开，移除项只出现在菜单中，鼠标仍在空间行内时，键盘关闭后焦点回到原更多按钮，菜单打开不折叠空间或改变项目选择。菜单排版补验中，实际更多与个人工作区弹层左边缘到触发器误差均为0px，所有选项字号13px／行高18px／高28px，主题标题13px；移除文字与图标在深浅主题均为原前景色。浮层互斥补验先聚焦显示空间提示→打开更多（1菜单／0提示）→Escape或鼠标点击原触发器关闭（0菜单／0提示），同一行内点击并聚焦仍为0提示；移到正文再返回空间行并聚焦后恢复1提示，页面无错误。原Electron后台与跨版本夹具已同步新入口；本轮未重验完整安装版或原生确认窗口。

同日按统一悬停规则补验：实际NativeDesktop／Sidebar与生产CSS在隔离浏览器中逐帧观察，鼠标在行外按Esc关闭后65帧中两个按钮透明度均始终为0，焦点未回到空间行，空间提示保持隐藏；鼠标仍在行内按Esc关闭的66帧中两个按钮透明度始终为1，焦点正常回归，没有闪隐。侧栏整文件8项／312断言覆盖Esc及指针在行外关闭不回焦点、按钮节点保留及提示重新悬停恢复，Native空间移除定向2项／32断言、UI／Desktop类型检查通过；未重验完整安装版。

Composer 在原停止按钮内使用 Hugeicons `StopIcon` 的实心方块，填充继承按钮前景色、无描边；圆形按钮继续沿原主题配色。发送中、活动任务、停止等待、运行中引导及原回调和禁用条件保持。

附件移除按钮由[共享样式](src/desktop/style.css)单独设为常显的 24px 深色圆底、白色图标、浅色描边和阴影，不依赖缩略图颜色或主题背景；悬停／按下保留实色底，键盘聚焦使用明暗双层提示，普通文件和图片共用。

用户消息由 [Conversation](src/desktop/Conversation.tsx) 分为宿主 `renderMessageAttachments` 附件插槽和 `.user-message-body` 正文气泡，时间／复制继续属于同一原消息；空正文不保留气泡。普通用户的Markdown正文由`PromptMarkdown`默认限制在约360px气泡内，短窗口按半个视口收敛；超出时底部以渐隐及内阴影显示“展开”，展开后可在底部收起。只裁切展示，完整源文、全文复制、附件和发送失败／结果未知提示保留；短消息不显示折叠按钮。CSS先限制高度，再在布局阶段及内容／窗口尺寸变化时判断溢出，避免先显示全文后收起；活动页才保留观察，暂停时按钮不可用。手动选择沿同一消息节点保留，历史接管和缓存返回不重置，冷重开默认收起。键盘聚焦裁切区内的链接或代码操作时展开并定位，收起后保持按钮可见。`SessionPage` 透传附件插槽，Agent 内容和工具不消费它。[MessageAttachments](src/desktop/MessageAttachments.tsx) 使用 [shadcn AttachmentGroup](src/desktop/components/ui/attachment.tsx) 的横向滚动、吸附与边缘渐隐，按实际宽度决定附件总数和前后按钮，读取或缓存资格不由滚动控件授予。尺寸／数量变化重新测量，滚动只更新端点按钮；隐藏缓存暂停观察，恢复重新测量。导航文字不进入聊天全选。[AttachmentFileCard](src/desktop/AttachmentFileCard.tsx) 与 Native 图片共用 Attachment／Media／Title，保留当前148px卡宽、80px预览、8px间隔与消息卡片12px圆角；shadcn 源码仅调整本地导入，使用已有 Radix Slot、Button 和样式工具，不增加依赖。输入区沿原移除与选择流程。

[Conversation](src/desktop/Conversation.tsx)将宿主确认的 `model_connection` 系统消息与工具放在所属 Turn 的处理过程中，共用 Trace 行组件及原折叠、阅读位置；连接等待期间由过程行表达活动，不重复显示“正在回复”。连接事实、次数及因果位置归 [Desktop owner](../../apps/desktop/README.md#普通客户端与测试诊断)，UI 不推断网络状态。[ModelConnection](src/desktop/ModelConnection.tsx)仅在宿主确认重连耗尽并提供可读原因时显示详情折叠按钮；正常重连、成功及取消保持普通过程行，详情随原阅读状态保留。非重连的会话执行异常（包括启动、上下文及底层逻辑异常）由[TurnFailure](src/desktop/TurnFailure.tsx)在普通客户端统一使用公共[Alert](src/desktop/components/ui/alert.tsx)，只显示详细原因／建议，不显示可见标题；采用中性圆形信息图标、16px圆角、细边框及灰色说明，图标20px，内边距16px。无障碍名称仍保留准确异常摘要，不渲染聊天message或伪造Tool行；未知原因明确说明现有记录无法核实，技术详情继续受原构建诊断门禁控制；[诊断回归](test/desktop-diagnostics.test.tsx)核开发与生产均无折叠按钮或内部错误码。

轮次摘要在所有终态统一只显示原已核实用时，缺少可靠时间时显示“用时未知”；进行中沿原阶段文字，摘要不按失败、停止、中断或恢复状态着色。真实`data-turn-status`、取消／恢复资格及过程内错误保持，失败细节仍可展开阅读。有准确 `turnId` 的 `turn_failure` 与其他过程记录一起进入原 Turn 的折叠内容，不再独立渲染在结果区域；正常完成／主动停止仍默认收起；失败或异常中断且同Turn没有已核实最终回复时默认展开，外层过程不设高度上限，显式阅读选择优先。默认由整Turn的finalReply集合决定，不只检查当前片段；异常Alert不能覆盖准确的中断／取消／完成终态。冷读与原时间身份沿原合同。没有 Turn 的原输入拒绝仍是独立未启动事实，不由 UI 猜补 Run。首条输入、明确最终回复及独立 Agent 结果仍按原业务边界显示；[过程回归](test/desktop-reasoning-turns.test.tsx)和[Native 投影回归](../../apps/desktop/test/isolated/native-transcript-dom.test.tsx)核失败正文的过程归属与冷重开。

2026-11-05，Windows x64／Bun1.4.4，轮次摘要调整通过过程、响应、投影、阅读滚动及Native轮次五文件69项／2174断言，UI／Desktop类型和定向Biome通过。隔离生产组件与编译CSS逐步观察执行中→失败收起→展开真实原因→停止／中断／成功→冷重挂及深浅主题；各终态只显示“用时38秒”，实际终态仍分别保留，失败正文仍在原过程内。摘要深色computed color为`rgb(181,181,181)`，浅色为`rgb(102,102,102)`，无状态红色、重复摘要或过程外失败正文。材料归本机`.cache/turn-summary-audit-20261105`，临时入口沿原过程审查夹具；不代表完整Electron安装制品或其他平台验收。

2026-11-05，后续异常展示调整：Alert／轮次／新会话／Native投影六个完整文件152项／3240断言，另阅读滚动与Agent活动两文件4项／2038断言通过，UI／Desktop类型、定向Biome、边界及测试归属通过。隔离生产组件页面沿同一原轮逐步核活动→未知异常Alert、明确项目说明读取失败、中断保aborted、手动收起、冷重挂默认展开、正常最终回复默认收起和深浅主题。60项过程实际高度2343.875px，外层max-height为none，使用原会话滚动；手动上翻后主题切换scrollTop前后均为1159.333374px。普通异常只有一份Alert且不带message类，不含旧消息保留提示、原因码或日志；完整截图与DOM事实归本机`.cache/turn-exception-audit-20261105`，临时入口沿原轮次审查夹具。不证明完整Electron安装制品、真实模型故障或其他平台；本次不改变模型重连、执行或恢复协议。

2026-11-05，按用户参考图进一步调整Alert外观并移除可见标题：普通异常只保留20px圆形信息图标和详细文本，16px内边距／圆角，沿主题background、border和中性文字，诊断制品的原技术详情门禁保持。诊断／轮次／Native三个完整文件35项／699断言、UI／Desktop类型及定向Biome通过。隔离生产组件页面逐步核活动→未知异常、明确原因、深浅主题及冷重挂；标题节点为0、Alert始终单份、异常过程仍默认展开。深色背景`rgb(25,25,25)`、图标`rgb(237,237,237)`、说明`rgb(181,181,181)`，实际padding／border-radius均16px；截图和样式事实归本机`.cache/alert-style-audit-20261105`。本轮仅外观及可见标题变化，原失败分类、重连、阅读选择及完整安装资格保持其各自范围。

重连行在[共享样式](src/desktop/style.css)内单独使用 `--destructive`，覆盖图标、标题、次数、详情原因及建议；进行中与成功／失败／停止后的颜色一致，悬停、键盘聚焦和展开保持红色，原活动 shimmer 保留。标题与次数直接相连，次数继承同一字号和行高；图标与文字仍保留原间距。2026-11-03 在 Windows 的隔离生产组件页面中逐步切换上述四种状态及失败详情，深浅主题实际绘制和 computed style 均核对：浅色 `rgb(161,62,62)`、深色 `rgb(224,161,152)`，普通工具对照仍为原灰色；标题／次数间距均为0、字号均为14px、行高均为24px，图标与文字间距保持6px。证据位于本机`.cache/reconnect-color-preview/colors.json`、`layout.json`及`failed-expanded-final.png`，临时入口为`.cache/reconnect-color-preview.ts`；只补样式验证，重连次数、请求、取消和冷恢复继续复用 Desktop owner 的真实窗口证据。

消息过滤使用宿主确认的 `Message.hasAttachments` 保留已保存的仅附件用户消息；标记只影响展示，不授予读取权限。Desktop 的持久消息及发送占位均从附件元数据提供此标记。发送接管、失败、重开与真实浏览器布局证据归 [Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。

[Conversation](src/desktop/Conversation.tsx)按浏览器实际夹紧后的 `scrollTop` 记录自己的滚动写入；来自该位置的迟到 scroll 事件不改变跟随状态，用户改变位置时只有实际到底（容许1px的分数滚动精度差）才恢复跟随，取消原48px近底吸附区，避免状态提交或流式追加把手动阅读拉到底部，恢复与“回到最新消息”共用同一写入。首次／缓存恢复及历史窗口补入仍同步定位；普通跟随由原ResizeObserver在viewport或正文几何改变后、绘制前更新，不在每次metadata提交重复读取scrollHeight触发布局，缺少ResizeObserver时保留同步回退。避免新一段内容增长先于旧 scroll 通知抵达时误判为用户上翻；[阅读滚动回归](test/isolated/desktop-conversation-scroll.test.tsx)覆盖这一顺序、手动阅读、恢复及重复卸载的观察器／监听清理。Native 图片挂载与资源生命周期见 [Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。

2026-10-23，同一 Windows 工作树的近底吸附修复：上述滚动回归先复现距底47px时从1853跳到2000，修复后1项／742断言通过，覆盖47／16／2px手动位置、后续重绘与内容增长、0.5px精度差下的真实到底及原观察器清理；UI typecheck、Biome和文档检查通过。隔离实际组件页面用相同上翻／下滚操作复现旧版提前置底，新版停在距底约36px；运行中追加正文保留原scrollTop，手动到底后追加继续跟随，静态会话与显式置底同样核实，无页面错误。验证范围为当前桌面共享组件，未重验安装版 Electron。

[Conversation](src/desktop/Conversation.tsx)首次呈现历史时，对默认展开的活动轮次同样登记 `data-restored-expanded`，直接进入完整高度，避免首次打开重播300ms展开动画而带动正文移动。缓存恢复与冷历史共用原恢复标记，后续手动开合由 `onToggle` 清除标记并继续动画；不改变展开选择、消息顺序或滚动跟随。[轮次回归](test/desktop-reasoning-turns.test.tsx)核冷／恢复两种入口；生产组件浏览器耗时、逐帧高度及连续流式证据归 [Desktop owner](../../apps/desktop/README.md#会话消息渲染验证)。

宿主可通过 `initialPresentationPending` 延迟尚未呈现的 Conversation 首次内容提交，让已保存消息和结构事实同时进入原轮次布局；UI不读取或推断轮次／工具事实。第一次可读 layout commit 后该标记不再遮住正文，普通流式更新、缓存恢复和阅读滚动继续原行为；换 readingKey 或DOM淘汰后重新挂载才重新等待。Native的失败、缓存及首条输入豁免由 [Desktop owner](../../apps/desktop/README.md#原轮次阅读聚合与问答回执)负责；[阅读滚动回归](test/isolated/desktop-conversation-scroll.test.tsx)核首次等待、后续更新、重新挂载及原滚动生命周期。

[SessionPage](src/desktop/SessionPage.tsx)的 `synchronizePresentation` 将初次消息和 footer 作为同一可见提交；[Conversation](src/desktop/Conversation.tsx)完成布局后回报准确 scope／readingKey，旧页回调不能提前放开新页。宿主已有同会话只读输入区快照时传 `retainedPresentation`，现存缓存树恢复即可立即一起显示，不等待后台读取；正文 DOM 被淘汰时，新树仍须完成准备，不能只放开输入区。已经显示的同页普通刷新不重新隐藏；未启用屏障时同样记录准确的页面身份，同scope首发历史接管随后启用屏障，不重新隐藏history／footer或临时施加inert。身份变化立即撤销该豁免，新会话仍按原规则等待；记录身份不引发未启用屏障页面的额外render。footer 几何由前置 sibling 的 layout effect 在缓存消息恢复滚动前确定，避免首帧以旧输入区高度夹紧阅读位置；ResizeObserver 继续跟随实际尺寸变化，不使用固定延时。缓存预算及 `readActive`／`interactive` 准入保持，显示快照不授予读取或写入资格。[页面回归](test/isolated/desktop-session-page-render.test.tsx)分别核冷页、完整缓存、仅输入区缓存、首次分组与普通刷新时消息和 footer 的同步可见性；Native过程证据见 [Desktop owner](../../apps/desktop/README.md#native-provider-与下一次模型选择)。

准备期的 history／footer 共用 `presentationStyle`，同时设置 `visibility:hidden` 和父层 `opacity:0`，并沿原 `inert` 关闭交互。按钮的 `transition-all` 会过渡继承的 visibility，使父层已隐藏时子控件短暂保持可见；父层透明度将整个子树一起停止绘制，几何测量与原 DOM 继续保留。完成准备后同步撤下此样式；缓存已就绪和普通刷新沿原显示路径。验证逐项核对子控件的 computed visibility 及祖先透明度，原仅检查 Composer 父节点的结果不足以排除残影；修前／修后及真实开发窗口证据归上述 Desktop owner。

Native 提供 `retainedPresentation` 时，输入区的模型或审核标签可以保持已核实的空态；该标记不要求页面已经具备发送或权限操作资格。首次页面的模型读取是否结束由 Native 通过 `initialPresentationPending` 一起交付，纯 UI 不推断默认模型、权限或读取结果。原缓存回归中的无标签历史、保留 DOM／展开、新消息接管、成本淘汰和只读准入继续适用。

[SessionPage](src/desktop/SessionPage.tsx)在 layout effect 中取得首个正宽度并直接确定环境卡占位，首次测量不启动 padding 过渡，防止已绘制正文／Composer 再横移及换行。后续实际尺寸跨阈值和用户开合仍使用原动画；Native环境卡从scope建立就保留原节点，业务内容晚到不新增占位。[侧栏回归](test/isolated/desktop-sidebar.test.tsx)核初始占位、晚填内容、窗口阈值和窄窗浮层。

同一组件的 `.response-status` 与 `.message-meta` 沿[共享 CSS](src/desktop/style.css)共用28px信息行高度并垂直居中。独立流式消息直接在原 `.message-meta` 中显示提示，完成后替换为原时间与具备资格的复制控件；回复期间不叠加第二行时间或额外占位。准确轮次的提示继续位于处理过程折叠区外；上方为展开过程的最后一条Agent正文时，与完成后的工具栏同样距正文2px，轮次底部保留8px，避免原24px轮次留白造成完成时下一条消息上移16px。上方为展开工具时仍使用原混合间距，收起过程或尚无正文时保留原正文块间距。显示提示时过程区不叠加底部padding。底部跟随继续由阅读内容高度驱动，复制资格、过程内无信息栏与活动状态的来源规则保持。

“正在回复…”与工具消息共用字号、字体及文字颜色规则，使用 `--conversation-text-size`（默认14px）和 `--muted-foreground`。思考／回复标签直接使用宿主已引入的 [shadcn shimmer utility](https://ui.shadcn.com/docs/utils/shimmer)，以行内块将流光范围限制在标签文字，使用语义前景色作为高光以跟随应用主题；通过库内置 `shimmer-spread-[16px]` 和 `shimmer-duration-1500` 将高光收窄为16px、每1.5秒扫过一次，避免默认宽光带在短状态文字上仅呈现整句轻微变色；沿库内置的减少动态效果规则恢复静态文字，不新增动画实现或依赖。读取与业务交互门禁保持。

该提示由 [Conversation](src/desktop/Conversation.tsx) 按准确 `turnActivity` 与终态 marker 在轮次底部呈现，位于过程折叠区外。普通活动过程入口固定为“处理过程”；准确的当前未结束思考且没有活动工具时，底部同一节点显示“正在思考…”，出现正文或活动工具后恢复“正在回复…”。底部状态只显示思考／回复文字，不附运行时长；`TurnElapsed` 仅在原 summary 展示可靠起止时间对应的终态耗时，不再启动活动计时器。没有可展开过程的普通活动轮次不显示空 summary，首条状态行不额外增加顶部留白；等待、停止、恢复和失败等真实轮次状态保留；观察失败不追加普通界面异常标签。

外层 Turn 过程仅在确证轮次结束后允许折叠：进行中强制展开并使用静态状态行，没有折叠按钮或 chevron，工具自己的异常详情不受影响。单条最终正文或工具结算不覆盖仍在进行的宿主 Turn；`unavailable`／执行待核实不等于终态。结束后恢复原默认折叠、手动选择和阅读缓存。

模型或工具消息的 `settled` 不结束轮次提示；queued、running、waiting、cancelling 与 recovery_required 保持，真实 terminal 优先移除，同 Turn 分裂条目仅末条目显示一次。暂时 `unavailable` 保留已有活动展示，不显示新的思考判断或“上次确认状态”标签；不扩大当前读取或操作资格。宿主通过独立 `TurnActivity.executionUnconfirmed` 表明原执行权已释放或不能核实时，未结束轮次停止回复／思考及 busy 展示；普通界面不追加“执行状态待核实”，这两类标签仅在显式测试诊断中显示。原 status 和真实终态保持，诊断标签不能覆盖失败、取消或中断终态；撤除标记后重新按原事实展示。无 Turn 身份的旧独立流式消息保留原局部提示。[生命周期回归](test/isolated/desktop-turn-response.test.tsx)核空正文、思考／回复节点切换、工具、普通观察失败、执行权待核实、折叠及真实终态。

Composer 的图片卡片保持固定预览区域，接受宿主交付的小尺寸URL并提示异步解码；等待URL时显示准备占位，可选 `previewError` 只显示预览失败，不改变原 `loading/error` 的发送门禁。图片转换、缓存与原字节校验归 [Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)，UI不读取或转换原图。Native登记给ConversationCache的图片成本现包含缩略图编码字节与RGBA像素估算，继续使用原媒体／DOM预算、停用和释放协议；派生Blob的独立有界缓存由原窗口owner管理，不能恢复旧读取资格。

## Markdown 消息内容

桌面 [MessageContent](src/desktop/MessageContent.tsx) 在 GFM 上支持以下展示；Web 的 `SafeMessageMarkdown` 和独立 TUI renderer 保持各自范围。

文件引用展示由 `MessageContent` 负责。反引号路径默认用文件名作标签，带行号的 Markdown 链接沿用作者标签。两种引用共享文件图标、行号和悬停／焦点提示，并在悬停或键盘聚焦时显示虚线下划线。宿主可提供当前项目的 `fileRootUri` 供提示展示，原相对路径和可选行号仍独立交给 `openFile`。读权限暂停时关闭提示并禁止激活。未提供 `openFile` 时反引号引用保留行内代码，带行号的链接保留标签文本。具体排版、打开资格与验证见 [Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。

行内文件图标和任务复选框按 `em` 跟随字号，并以当前字体的大写字高 `cap` 为参照对齐文字基线。设置导航等具备独立图标槽的控件以文字行盒和图标框的中心对齐。失败提示的图标沿首行行高居中，描述换行后继续对齐首行。

正文renderer与[纯语法入口](src/desktop/markdown-parser.ts)共同接入固定`remark-cjk-friendly@2.3.4/parseOnly`，使`**说明：**后续正文`等中文标点紧邻写法正确解析强调；直接、缓存、prepared和Native Worker保持一致。不替换原字符串或插入不可见字符，原模型输出、复制来源、AST源码offset和HTML／图片／URL安全策略保持。插件在[UI manifest](package.json)与[Desktop内联清单](scripts/bundled-dependencies.ts)登记，构建保存其许可。取舍见[中文强调决定](../../.agents/notes/implemented/bug-fix/2026-11-05-cjk-markdown-emphasis.md)。

2026-11-05，Windows x64／Bun1.4.4，截图准确原文和相邻标点反例在旧实现两项均失败；修复后正文扩展、缓存、流式、Worker构建／owner和输入编辑六文件37项／1551断言通过，UI／Desktop类型通过。`bun packages/ui/scripts/build-desktop.ts --outdir=.cache/markdown-cjk-build`通过，新插件无残余bare import且包含许可；实际Worker在无DOM／Node的VM中保留CJK强调。隔离生产组件页面逐步观察未闭合→补齐→追加→完成→prepared历史重开、深浅主题与340px窄列，截图原段三处粗体一致且无多余星号／横向溢出，材料归本机`.cache/cjk-markdown-audit-20261105`。锁定依赖包含插件要求的共享serializer更新，原编辑器回归已覆盖；未重建完整Native安装制品，不代表其他客户端或平台资格。

[增量展示](src/desktop/incremental-markdown.tsx)保留整条消息的固定GFM／公式解析与语义处理，再为生成元素设置无DOM包装的memo边界；比较实际内容、属性及图表围栏闭合状态。只读态忽略源码位置与一次性渐显提示，编辑态同时比较文本源码坐标，防止后续点击落到旧位置。未变化的段落、列表项、表格、链接和代码组件跳过渲染；追加中的元素仅更新变化分支，后补引用、脚注与标题目标仍按完整上下文校正。代码围栏闭合状态从当前源码派生到该块，不再通过整条源码Context使所有代码组件重新渲染；操作能力Context仍按当前准入更新。

`MessageContent.streamingReveal:false`只使本次自动全文初次填充静态显示，仍记录`streaming`连续性供后续追加；不改变正文来源、读取或复制资格。Native自动正文版本交接的只读保留归[Desktop owner](../../apps/desktop/README.md#会话消息渲染验证)，共享Web/TUI不新增该保留策略。

`MarkdownDocument`仅随正文、prepared语法树或消息前缀变化重新进入转换管线；读取暂停／恢复与streaming标记变化只更新外层的已提交状态，不使相同正文重新处理。下一次正文变化仍使用当次的渐显资格，memo不冻结权限Context。

普通IPC历史读取会先撤销读取资格、完成后再交付同一消息的新正文。渐显只要求当前读取已准入，连续追加的依据是上一次已显示的同挂载正文，不要求上一次`readActive`也为true；否则实际跨任务读取会把所有追加动画关闭。首次历史、非追加纠正和Activity隐藏／重连仍清除连续性；当前不可读时不播放，不恢复任何读取或操作资格。

宿主以`streaming:true`标记实际Agent流式预览，以`false`交接其完成预览；静态正文及显式完整读取不传此标记。[绘制层渐显](src/desktop/streaming-text-reveal.ts)为每个Markdown文字节点保留一个连续Text节点，使用`appendData`追加以保留旧选区，React保留固定种子内容、由layout effect同步本次完整正文。普通格式空白保持原文本，避免向table／list等结构容器插入非法span。新增完整字素通过CSS Custom Highlight的`StaticRange`快照绘制颜色渐变，不建立逐字DOM、不改变字距／连字，也不建立React逐帧状态。每个文字节点只保有一个原生动画时钟；各字240ms、普通间隔18ms，跨行内Markdown节点保序，较大批次最多等待180ms、整批最多420ms。新的追加沿同一绝对时钟接续，旧字不重新变透明；每次追加按当前Text节点重建静态绘制范围，避免大量live Range随每次注册和边界设置反复更新；读者选区仍是原连续Text节点上的独立live Range。各字素的独立颜色规则和严格递增时序保持。每条规则用`:where(.原文字元素唯一class)::highlight(name)`限定实际文字来源，保持原伪元素规则的specificity，避免其他UI元素参与每个字素的样式重算；清理同时移除该绘制class。完成、减少动态效果或卸载释放原highlight、动态样式和媒体监听。同一Document的待绘制实例在一个microtask中先全部读取来源文字颜色，再统一发布Highlight、样式与动画时钟，避免逐节点读写交错触发反复样式计算；正文仍同步进入原Text节点。同一实例在发布前连续追加按最终源码顺序接续独立字素时序，发布时重新核连接、隐藏与减少动态效果；纠正、释放或新更新使旧待发布绘制失效。颜色从文字来源元素取得，避免`currentColor`沿highlight继承链读到透明值。缺少StaticRange、Highlight、注册属性或原生动画接口时直接显示正文。

长文字仍只在原文与解码位置一一对应时，以2048个UTF-16单位为目标在完整字素边界分段；含实体或转义的位置转换保留原节点与准确源码范围。后补组合字符或emoji直接采用完整字素，不保留半字绘制范围。代码、公式及图表沿原组件更新；隐藏、暂停读取、首次历史、非追加纠正与Activity重连不重播旧字，末次流式追加仍可渐显。DOM缓存沿原文字／节点预算保留，不积累字素包装节点；绘制记录仅保留未完成的短时动画。原整文解析、当前读取准入和完整正文复制资格保持。取舍与被替代的逐字span方案见[绘制层决定](../../.agents/notes/implemented/bug-fix/2026-10-25-streaming-text-paint.md)。

[流式回归](test/isolated/desktop-streaming-markdown.test.tsx)核实际React跳过渲染、旧DOM／选区保留、后补语法、末次追加、减少动态效果、缓存Activity重连和Unicode；[代码复制](test/isolated/desktop-code-block.test.tsx)、[正文复制](test/isolated/desktop-message-copy.test.tsx)与[阅读滚动](test/isolated/desktop-conversation-scroll.test.tsx)继续核原边界。生产Native组件的连续帧与交付范围归[Desktop owner](../../apps/desktop/README.md#会话消息渲染验证)。取舍见[增量渲染Note](../../.agents/notes/implemented/architecture/2026-10-24-desktop-incremental-markdown.md)。

2026-10-27，macOS arm64／Bun1.4.2，本轮绘制回归13项／797断言、滚动1项／772断言及历史窗口7项／81断言通过；包括原300字素独立严格递增时序、完整正文和原选区、发布前失效、所有颜色先读后写、准确来源规则及释放。实际Native原16流／120切换的样式成本对照与内存边界归[Desktop owner](../../apps/desktop/README.md#本次全量失败修复)。缓存10项／572断言核原预算、暂停与释放；不从这些隔离结果推导真实外网模型或其他平台资格。

| 内容 | 语法与行为 |
| --- | --- |
| 图表 | `mermaid` 围栏内支持 `graph`／`flowchart`、`sequenceDiagram`、`classDiagram`、`stateDiagram`／`stateDiagram-v2`、`erDiagram`。围栏闭合后异步绘制，未闭合时显示当前源码；源码开关和复制保留原文，错误或不支持时回退源码。 |
| 代码与差异 | lowlight 的 common 语言集合按显式语言标记高亮，包括 TypeScript、JavaScript、Python、JSON、SQL、Shell 与 diff；未知语言或超过32768个UTF-16单位的块保持全文纯文字。高亮仅改变 token 文字颜色。 |
| 提示块 | 引用首段的 `[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]` 转为中文标题、装饰图标与正文，按类型使用低饱和底色与标题色，无外围线或侧边线。图标不进入正文或复制来源。 |
| 数学公式 | remark-math 与 rehype-katex 渲染 `$…$` 和独立 `$$` 围栏；KaTeX渲染与本地字体样式固定同版，`trust:false`、展开上限100、尺寸上限20em。错误公式保留可读源内容，不执行链接或加载图片。 |
| 正文导航 | 标题使用 GitHub 风格 slug，重名递增；标题与脚注ID按消息隔离，fragment仅能跳往同一消息已有目标，跳转后移动键盘焦点。脚注保留编号、说明与返回正文链接。 |

[图表 adapter](src/desktop/markdown-diagram.ts)懒加载 Mermaid，以 strict 模式、纯文字标签和客户端控制的透明主题绘制，再作为 SVG image 展示，不把生成标记或事件绑定挂进应用DOM。图表不接受配置指令、frontmatter、自定义样式、HTML、点击或图片／图标语法；原文不删除。单块源码上限16384个UTF-16单位、边数250；生成SVG上限200万个字符、单边12000及面积1600万坐标单位，超限回退源码。图表保持自然尺寸并在局部滚动，去掉默认阴影；节点边框与箭头使用蓝色 `--diagram-accent`，生命线、分组与注释边框使用青色 `--diagram-secondary`，正文保持原前景色。两种图表色分别适配深浅主题，颜色单独变化也会重绘，主题切换保留已有画面直至新版完成。渲染串行化，全局队列仅保留完成信号，不保留已结算的图像或失败对象；停用取消排队或丢弃迟到结果；已绘图资源登记到原会话缓存预算，窗口隐藏释放，恢复后重绘。详细取舍见[图表展示边界](../../.agents/notes/implemented/architecture/2026-10-22-desktop-markdown-content.md)。

[队列回归](test/desktop-markdown-diagram-queue.test.ts)核并发串行顺序、原图交付、完成信号及取消后恢复。[内容回归](test/desktop-markdown-extensions.test.tsx)核公式／提示块／高亮、完整源码、消息锚点隔离和prepared树不变；[图表生命周期回归](test/isolated/desktop-markdown-diagram.test.tsx)核迟到结果、Activity暂停、资源记账、窗口恢复和仅图表颜色变化时的重绘／原图保持。浏览器验证归[Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。输入框继续编辑这些类型的Markdown源码，不在草稿中绘图或排版公式；[编辑器回归](test/isolated/prompt-editor.test.tsx)核无关编辑后的扩展语法保留。

2026-10-22，Windows x64／Bun1.4.3、`beabc9628`加本次Markdown工作树：以准确`./`文件路径执行Markdown、扩展内容、语法缓存、代码块、提示词编辑、阅读滚动、Native Worker构建与调度8个文件，28项／1501断言通过；图表生命周期隔离文件另以独立Bun进程执行，1项／16断言通过。UI／Desktop typecheck、UI三个入口构建、定向Biome、统一边界、workspace、测试归属与文档检查通过。测试Mock只存在于隔离生命周期文件，不进入普通客户端；完整安装版Electron与其他平台未在本轮重验。

2026-10-23 推送前同步远端 `c3cfa313a` 后，前述8个完整文件再次通过28项／1505断言，独立图表生命周期文件通过1项／22断言。编辑器扩展用例曾在JSDOM默认聚焦选区落到代码块开头时失败；夹具改为明确设置末尾用户选区并派发selectionchange后再粘贴，保留全部源码和末尾追加断言，生产编辑器不变。同步后全仓typecheck、文档range影响、统一边界和workspace检查通过；此前Electron与浏览器证据按未改变的展示范围复用。

闭合Mermaid图表按原源码行数预留160–520px阅读区域，绘制等待、源码、图像和错误回退使用相同高度；inline-size containment固定400px固有宽度贡献，实际仍受可用列宽限制，避免冷重开图像加载撑宽用户气泡。图像保持自然尺寸并在区域内滚动。派生SVG按完整源码与主题色复用，最多16项／4MiB纯图像载荷，窗口隐藏清空；显式固有宽高避免图像解码再次改变尺寸。现有Activity／会话资源预算和操作准入继续分别生效。

## Markdown 提示词编辑

用户确认提示词输入不再渲染Markdown。[PromptEditor](src/desktop/PromptEditor.tsx)使用原生多行`Textarea`编辑原始字符串，不解析、序列化或预览Markdown；已移除Milkdown、Lexical和专用编辑依赖。用户消息和Agent回复复用[MessageContent](src/desktop/MessageContent.tsx)，[PromptMarkdown](src/desktop/PromptMarkdown.tsx)仅增加用户正文高度与展开控件，内部复用同一renderer，沿同一GFM／CJK／公式及扩展语义显示表格、提示块、脚注、代码和图表。HTML不执行，Markdown图片不发起资源读取，附件仍走Composer原流程。当前取舍见[纯文本输入决定](../../.agents/notes/implemented/bug-fix/2026-11-07-plain-prompt-markdown-messages.md)。

`Conversation`的普通用户正文默认使用`PromptMarkdown`；消息分组、独立entry和分段key沿宿主提供的`presentationKey`保持，物理消息ID仍用于读取、复制和动作核验。发送消息不降低整条透明度，代码复制入口不因资格变化增减尺寸。[输入回归](test/isolated/prompt-editor.test.tsx)核原生文本、完整源文、同步变更、父级回传、scope与读取门禁及附件；实际键盘、中文IME、原生撤销、发送与冷重开证据归[Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。输入只显示Markdown源文，用户与Agent消息采用相同的只读解析和排版。

本节描述共享UI的默认样式。Native 在共同内容外框内提供 [深灰背景与中性灰交互](../../apps/desktop/README.md#原主题与窗口背景联动)，主区与右栏共用颜色；Markdown 正文字号和间距在会话主区设置，界面字体来自共享系统字体栈，用户消息沿同一输入区底色。左栏另由Native提供灰色玻璃背景，Windows Mica的左栏、主区与右栏共用最外层描边和圆角，四周统一保留6px留白，内部主区不另加圆角或外边距。Native另将左右侧栏的内部分隔线减淡，覆盖式编辑右栏只绘制单线；用户消息气泡的上下内边距为8px、左右为16px。正文首末元素不额外叠加外边距，引用、列表项和表格单元格同样收住边缘；Native末尾的一级／二级标题不绘制分隔线及其留白，标题后有内容时保留原分隔线和间距。左栏与右栏布局沿用共享组件，具体展示与验证归 Desktop owner。

消息正文按元素使用共享样式：普通引用保留2px左侧竖线及透明底，文字仅轻度弱化；行内代码采用等宽字、轻底色与4px小圆角，不再加底线；代码块使用完整中性底色与原圆角，移除外围及标题分隔线，保留语言标签、复制、键盘焦点与局部滚动。Mermaid绘图区域继续透明，切换源码或错误回退时使用代码底色。可操作的正文链接使用深浅主题各自的链接色，悬停或键盘聚焦时显示下划线；无打开资格的路径保留相同文字和排版，点击不执行操作。代码底色、小圆角与链接色由共享`--markdown-*`变量管理，输入框保持普通文字，草稿中的链接不产生可导航节点。

表格样式保持：完整细边框与共享圆角、横纵单元格分隔线、透明表头、原字号和内边距均不变；表头下边框与其他边框统一使用1px和相同主题边框色，相邻边缘不重复叠线，保留原滚动区域、焦点提示与GFM对齐。正文解析、完整源码复制、编辑与读取边界保持。

2026-10-25补核`34fa71f6`：原透明选择器匹配所有Mermaid容器，导致未闭合、绘制等待、源码展开和错误回退都丢失上述代码底色；现仅匹配实际图像的`.markdown-diagram-scroll`。原[内容浏览器夹具](../../apps/desktop/test/markdown-content-browser-runner.fixture.ts)不再对未闭合源码断言透明，补核源码往返、缓存返回与错误恢复。Linux x64／Bun1.4.2的[图表组件回归](test/isolated/desktop-markdown-diagram.test.tsx)用实际组件DOM和生产选择器／级联复现修复前失败、修复后通过；主题底色在JSDOM中替换为固定色，不代证浏览器像素。生产浏览器夹具构建通过，但Chrome channel缺失，已安装Chromium的正常沙箱启动又被`socket() Operation not permitted`阻止；本轮未取得实际浏览器或完整Electron视觉资格，原macOS结果不覆盖本修正。

2026-10-22，Windows x64／Bun1.4.3：Markdown、语法缓存、代码块、提示词编辑与阅读滚动五个测试文件19项／913断言通过；原[浏览器夹具](../../apps/desktop/test/ai-elements-browser-runner.fixture.ts)在Chrome155的深浅主题、1280／390px四组检查通过，保持代码滚动、过程展开和回复状态转换。另用实际 `MessageContent`、`PromptEditor` 与生产编译CSS逐步观察引用嵌套、代码复制回执、表格键盘横向阅读、输入编辑，以及追加开始／中间／结束时的布局；760／342px阅读列的深浅样式均可读。此为隔离组件验证，未运行本轮完整安装版Electron窗口；编译仍有既有嵌套 `@keyframes` 提示。

[PromptEditor](src/desktop/PromptEditor.tsx)保留`Composer`的`draft/onChange`字符串接口。`onInput`同步发布完整源文，父级同值回传不重设选区和撤销；延迟回传不覆盖本地最新输入。选区、撤销和输入法沿原生文本控件；scope切换在绘制前重置原生撤销，即使两边文本相同也不会撤销出其他会话内容。只有跨scope的未结束组合输入会替换旧控件，迟到候选不能进入新草稿。读取暂停时只读并阻止发送和附件动作，普通页面切换保留控件。Enter发送、Shift+Enter换行，中文输入法确认和229按键不发送；文本粘贴保留原文，文件粘贴／拖放沿原附件入口，handle保留focus/caret操作。Composer发送等待时保留PromptEditor可编辑、原节点、透明度和焦点，仅用sending与原提交门禁挡住Enter、按钮及form重复提交；真正的业务禁用、读取失格和scope切换仍沿原规则阻止动作。
输入正文与占位提示默认使用14px字号；消息中的Markdown标题和代码按各自层级排版。Composer 内模型／思考与审批选择器的触发文字为 13px；项目／分支选择器、模型列表和选择菜单同为 13px，上下文详情保持 13px；输入框内选择器图标与上下文状态圆环为 14px，项目／分支与模型选择入口的图标统一为14px，附件、发送／停止及展开菜单的操作图标同为14px。底部工具栏按 32px 高居中，文字选择器为 28px 高、18px 行高，内边距上下 4px／左右 6px；附件与发送／停止图标按钮保持 32px；`composer-options` 将附件与权限放在左侧，`composer-trailing` 将模型、上下文圆环和发送／停止放在右侧，缓存率只在上下文提示中展示。模型选择器与上下文圆环相隔8px，不渲染无模型名称的空占位；底栏按可用宽度在两组之间换行，模型名称在可用空间内省略，保留完整名称提示与无障碍名称。Native 模型容器使用 Grid 承接按钮和后续错误信息。权限菜单使用 `max-content` 按标题、名称及说明自适应宽度，同时受视口留白与 Radix 可用宽度限制，达到上限时自然换行；常规宽度下标题区单行排列，标题与选项名为 13px／18px，辅助说明为 11px／14px，均为 400 字重；容器、标题、RadioItem 和分隔线直接使用组件库默认的 padding／margin，选项高度按内容与默认内边距自然形成；名称与说明无额外行间空隙。窄区域允许说明自然换行，不裁剪内容。原生输入框统一使用Enter发送、Shift+Enter换行，不因输入代码围栏改变按键；文本编辑与粘贴不执行HTML或获取远程图片。

`Composer` 的缓存命中率放在上下文圆环的提示中，分子与分母仍来自原累计命中／未命中用量。旁边14px静态圆环默认常驻，直接渲染为 `role="img"` 的 SVG，不使用按钮、不提供点击操作或按钮悬停底色；保留键盘聚焦以读取提示。圆环仅消费宿主的 `contextUsage`：当前上下文输入估算除以模型完整窗口，不能用缓存命中率、累计输入或扣除输出预留后的可用输入预算替代。悬停或键盘聚焦时沿原 Radix Tooltip 在上方显示260px宽的左对齐卡片，并受视口约束：上下两块分别为“上下文占用”和“缓存命中率”，块间细分隔线；标签13px、右侧数值14px、明细12px。上下文展示约数百分比、4px占用条及估算／总量tokens，均按1024换算为大写K／M；缓存展示百分比及命中／输入tokens，按1024换算为大写K／M。未知上下文不画占用条，缺少缓存样本明确显示暂无数据；完整上下文数值保留在图标无障碍描述中。未知容量显示空环与“占用比例未知／总量未知”，真实零仍为0%；超过容量时环最多一圈，详情保留实际超过100%的估算。宿主可通过`metricsLoading`保持首次读取期间的指标节点：不单独显示缓存文字，圆环沿用静态轨道并标明正在读取，不提供数值提示或键盘焦点；读取结束后原节点直接接管已核实数据。该纯展示状态不禁用输入或停止。浮层使用主题卡片色、共享圆角和视口避让，Escape关闭；无对应估算、数据失效或读取失败时，原圆环保留空轨道并显示未知；提示与无障碍描述中的输入、容量缺失也明确显示未知，不补0%或无效数字。缓存命中率与命中／总量合并到上下文圆环的悬停提示，没有可用样本时明确显示暂无数据；真实0%仍显示原命中／总量，圆环与发送／停止位置保持。宿主读取与会话／模型隔离归 [Desktop owner](../../apps/desktop/README.md#输入区上下文占用)，UI不读取上下文正文或发起业务请求。

[上下文占用回归](../../apps/desktop/test/isolated/native-context-usage-dom.test.tsx)核缓存99%而上下文68%的反例、完整窗口分母、零、未知容量、超过容量、迟到响应、会话与模型隔离；原[累计缓存回归](../../apps/desktop/test/isolated/native-cache-metrics-dom.test.tsx)继续核统计保留、真实零与无样本。

2026-10-20，Windows x64／Bun1.4.3，`5dba8a6b`工作树加本次左右分组修改：对上述上下文、缓存回归及[共享页面](test/desktop-page.test.tsx)执行 `bun test --parallel=1 --max-concurrency=1`，22项／214断言通过；UI／Desktop的 `tsc --noEmit`、两个源码文件的Biome及文档检查通过。Chrome155以实际Composer和生产样式检查深浅主题、320–1100px输入区、中英文、长模型名与思考档位，并沿隔离Main夹具检查实际NativeDesktop的会话切换及缩窄，共23组通过；核分组边界、模型省略、菜单、上下文浮层、无指标、DOM身份和停止按钮。未运行安装版窗口或其他平台。

`Composer` 的 `+` 菜单以输入框等宽的“添加”列表向上展开，只有“添加文件”一行，使用图标、12px 文字与整行高亮；菜单沿原 Radix 键盘／焦点合同，按 form 和 trigger 的实际边界定位，`ResizeObserver` 在输入框尺寸变化时更新宽度和顶边间距，切换 scope 时关闭。一个无类型过滤的多选 file input 交付实际 File 对象；同次选择、粘贴或拖入先按 MIME／已知图片扩展名分流，图片交给 `onImageFiles`，普通文件由宿主 `onFileReferences(files, signal)` 准备独立字节，再由 `onFilesSelected` 交给原 scope。准备期间显示“正在保存附件…”和“取消添加”；取消、切换 scope 或卸载都会终止所属 signal，保留草稿且丢弃迟到结果，失败可重新选择。准备 signal 保持到宿主接纳原附件；输入随后 disabled／隐藏或未进入 onFilesSelected 的结果会释放，已经接纳的附件不随准备作用域结束而删除。默认每条消息 10 张图片，宿主通过 `imageLimit` 表达同一准入值；已有与新增合计超限时不调用任何附件 port。文件拖入在捕获阶段接管，避免 Lexical 再处理同一份附件。迟到或取消的选择不进入后来 scope。两类附件以受控 `images/files` 在正文上方横向展示并独立移除，不改写 Markdown 草稿；准备中或错误的图片阻止发送，两类附件均可单独发送。UI 不读取本地路径、上传图片或拥有 Artifact 读取权限。[编辑器测试](test/isolated/prompt-editor.test.tsx)核 Markdown、IME、混选、取消、切换、10／11 张边界及粘贴／拖入累计，实际图片 owner 见 [Native](../../apps/desktop/README.md#markdown-与附件输入)。

`Composer.context`允许宿主展示独立上下文卡片；`contextHasInput`只表达宿主已有待提交上下文，让空正文也能明确发送，并在活动Run时与停止按钮正确区分。它不准备附件、不构成授权，也不改变草稿文本；宿主仍以sendDisabled核准备、未知提交和准确版本。Native网页注释的元数据／图片与Main证明由[Desktop owner](../../apps/desktop/README.md#agent-浏览器观察与人工操作)负责。

文件卡片由 [AttachmentFileCard](src/desktop/AttachmentFileCard.tsx)供 Composer 与 Native 历史共用，图标依赖由 UI workspace 拥有。文件选择 port 的有限 `file_picker_restart_required` 错误显示完全退出后重新启动的操作提示，其他失败沿原通用重试文案，不把宿主异常原文带进界面；两类失败均保留输入且不触发发送。旧主进程判断由 Native 适配器负责，UI 不识别 IPC 或其他原始错误码。

正式 UI 根入口与 Desktop 构建内联[声明的普通浏览器依赖](scripts/bundled-dependencies.ts)，React、React DOM 和 Client 保持外部身份；原 CSS 与许可全文保留。Markdown 的 github-slugger、lowlight 和 mermaid 也由同一构建内联，避免其开发依赖进入运行闭包；remark-math／rehype-katex 继续按现有外部依赖资格分发，KaTeX CSS／字体保持完整，不跳过许可检查。TUI 在[同一次 splitting 构建](scripts/build-tui.ts)输出展示入口及 `@kite-ai/ui/tui/ink`，CLI 的 renderer 与 hooks 共同使用这份 Ink。锁定 Ink 7.1.1 的 DEV/devtools 分支在构建核实原文件结构后固定关闭，环境与普通组件参数不能开启。原行为与真实客户端验证边界见[闭包成本决定](../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)和 [Terminal owner](../../apps/cli/docs/terminal-release.md)。

[同次 Ink 构建适配](scripts/ink-output.ts)只绑定 Ink 7.1.1 的准确 `output.js` 物理路径，校验唯一原行序列化结构后，为所有单元均无样式的整行直接拼接字符；任一单元有样式仍使用原 ANSI 序列化。空白单元分配、宽字符覆盖、裁剪、行尾空白处理及原输出顺序保持，未知版本或结构拒绝构建。没有修改安装依赖或增加运行开关。[实际编译对照](test/tui/ink-output-build.test.ts)3项／265断言通过，核原版与编译版的 Unicode、重叠、裁剪、颜色、链接、转换器和完整 9,000,025 字节正文。2026-10-24 Windows x64／Bun1.4.3 的独立 `Output.get` 对照中，80列／75,001行原版3.10–3.45秒，适配后0.66–0.70秒；此为渲染函数范围，完整正式候选资格仍由 Terminal owner 维护。

当前 TUI 复用原 Ink 展示，输入、消息／工具阅读、审核和管理面板经公共 Server port 接入；功能迁移、普通模式与显式测试诊断由[终端 owner](src/tui/README.md#原-ink-展示与明确测试诊断)维护。Desktop 的[诊断展示 context](src/desktop/diagnostics.tsx)默认 false，回复失败技术详情与客户端面板只按显式测试值显示，不从 `NODE_ENV=development` 等环境名推断。dev／prod 客户端不得开启测试专用调试功能，测试 fixture 可显式提供 true；Native 另外执行构建常量的关闭门禁，见[Desktop owner](../../apps/desktop/README.md#普通客户端与测试诊断)。这份展示开关不扩大控制权限。

## 原桌面展示层

[SessionTabs](src/desktop/SessionTabs.tsx) 的新标签页并排两列展示工具，卡片按右栏可用宽度收缩，窄栏使用更紧凑的名称字号。变更使用文件差异图标，执行轨迹使用流程图标，入口与标签共用图标定义。

审批方式入口按输入框的实际可用宽度切换文字显示。输入框内容宽度不超过 400px 时，按钮隐藏模式名称，通过悬停提示和无障碍名称提供当前方式，菜单继续显示各模式的完整名称和说明。

桌面会话的标题栏、正文与输入区留白、消息气泡、刻度和新对话控件使用同一套基础样式。正文和输入区保留 740px 最大宽度，随分栏可用空间自然收缩。标题栏与输入区的实测高度继续决定正文和刻度的可用空间。

[SessionPage](src/desktop/SessionPage.tsx)为主会话启用[消息导航](src/desktop/ConversationMessageNavigation.tsx)。刻度来自已挂载的主输入，沿用消息展示身份，发送占位交给持久消息时保留同一刻度。刻度条在标题栏和输入区之间居中，按两者之间的可用高度判断是否溢出。溢出时以独立滚动区和翻页按钮浏览，恢复足够高度后收起翻页按钮。正文阅读位置或可用高度变化时显示对应的当前刻度，键盘操作期间保持焦点刻度可见。点击刻度写入原正文滚动区并保存阅读锚点，历史补入、缓存恢复与回到最新消息沿用 [Conversation](src/desktop/Conversation.tsx) 的阅读状态。

`Composer.confirmFullPermission`是可选宿主确认port：提供时使用宿主异步确认及AbortSignal，只有准确当前scope／权限／回调与严格true才调用原权限变更；取消、失效与卸载退休确认，失败显示有限可重试说明。没有port的Web／共享调用保留原DOM确认及风险文案。普通模式菜单的原门控保持，仅本地完全访问确认在途禁止重复选择。[权限DOM回归](test/isolated/permissions-dom.test.tsx)核宿主与Web两条路径；Native专用自绘浮层与原有权限命令分离，实际身份／窗口和像素资格归[Desktop owner](../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。

[ApplicationConfirmationDialog](src/desktop/FullPermissionConfirmationDialog.tsx)集中维护完全权限与移除空间两种应用确认的固定内容和相同视觉组件；Full包装继续由Composer的Web路径复用。取消保持默认焦点，Esc取消，危险操作按钮使用共享红色样式；组件只返回用户决定，不执行权限变更或空间移除；Native退出应用保留系统原生确认框。Native在独立WebContentsView渲染同一组件、CSS和主题，Main拥有原生层序及跨视图焦点；临时失败message由Native owner负责，不复用此模态组件。

[共享主题](src/desktop/style.css)集中维护暖红、偏红的暖橙、柔绿、偏深的蓝色和淡紫，分别表达异常／危险、警告／注意、成功、信息和重要提示；中性灰表面与主操作颜色沿原规则。`--destructive`负责文字／图标，`--destructive-fill`及hover／pressed变量负责白字实心按钮，错误提示使用`--error-background`与`--error-border`；公共危险按钮和无效表单的焦点环使用75%异常色。`--success`及底色同时供成功提示、配置圆点和diff新增使用，diff删除沿异常色与底色。`--info-foreground`／`-background`／`-border`供信息提示、未读圆点、文件引用、浏览器标注与错误页图标使用，`--important-foreground`供重要提示和最高思考程度使用。Markdown五类提示直接消费对应语义色，与图表的中性线条颜色解耦。子Agent的六个固定色槽消费同族前景色及青蓝色`--identity-secondary`，身份hash和图标分配保持。代码diff的addition／deletion也消费这套颜色，字符串、数字等语法高亮保持各自颜色；Native内容框继承共享状态色，提供商提示与删除按钮沿相同文字／底色及填充阶。

2026-11-07，警告色微调：浅色`--attention-foreground`改为`#9b4f34`，深色改为`#e5a184`，权限图标、名称、说明、警告提示底色与同族色槽通过原变量同步。生产CSS与单文件Biome通过；实际Native权限菜单在隔离浏览器逐步核深浅主题、打开、方向键高亮“完全访问”和Escape关闭。图标、名称与说明计算色一致，菜单普通／高亮文字对比度最低5.36:1；按源码配对的12%提示底色核对最低4.97:1。关闭后仍为自动审核、原草稿保留，无页面错误或警告。本轮只改两个CSS色值，沿用前述未变组件的193项行为回归与类型结果；截图与计算样式在本机 `.cache/warning-warm-20261107/`，未重验完整安装版或其他平台。

2026-11-07，Windows x64／Bun1.4.4，`5d39518e1`加本轮语义色调整：公共选择器、侧栏、Native提供商与页面、浏览器控制装饰及子Agent显示六份完整回归193项／4842断言通过，UI／Desktop类型、八文件Biome与生产Vite编译通过。隔离浏览器逐步核实际组件的深浅切换、危险按钮与提供商按钮悬停、错误输入／危险按钮键盘焦点、确认框打开与取消、五类Markdown提示、未读圆点和diff；40组实际文字／底色组合最低4.78:1，错误焦点环最低3.52:1，信息蓝边界相对纯白／深灰底最低3.29:1。另核深浅主题下六个身份色槽与浏览器错误图标共14组颜色，以及可信网页蓝框／光标开启、关闭与焦点不拦截，固定中蓝相对纯白／深灰底最低3.29:1；关闭后标记卸载，表单原值保留，页面无错误或警告。截图与计算样式归本机 `.cache/semantic-theme-20261107/`。颜色交互与危险分支为隔离生产组件证据；普通Windows窗口仅作只读观察，未重建完整安装制品或验证真实浏览器租约，不扩大原平台与发布资格。

2026-11-05，Windows x64／Bun1.4.4，`76e49e317`加本轮配色diff：[权限DOM](test/isolated/permissions-dom.test.tsx)与[Native确认框DOM](../../apps/desktop/test/isolated/native-global-dialog-dom.test.tsx)两个完整文件26项／239断言通过，沿原身份、取消、失效与主题切换核实，不改变权限或操作语义。源码色值的深浅主题共26组正常文字／背景对比度检查通过，最低4.63:1；两份CSS的Biome检查通过。隔离生产组件样式已编译；电脑操作因无法可靠识别本机浏览器地址而停止，实窗视觉与交互过程尚未完成验收，不以DOM或色值计算代替这项资格。

`SessionPage`手动动画收起准确已展示浏览器时，关闭意图立即更新，同scope原页仅保持到既有布局rAF开始，再同批撤页与折叠。立即重开、scope／active tab／host panel替换和无布局都退休pending；不为保画面恢复旧owner或延迟真正覆盖／隐藏。普通详情、导航及已有网页直接展开时序保持。[同提交与退休回归](test/isolated/desktop-session-page-render.test.tsx)只证明状态与面板目标，真实原生过程归上述Desktop owner。

`useSessionTabs`把明确关闭浏览器标签与scope变化／组件卸载分开。关闭回执失败时只合并回准确原标签，保留后来选择、标题及其他标签改动；同 scope 往返也不能接纳旧 owner 回执。未确认关闭继续占一个容量，成功后释放，避免失败恢复突破八项上限。后两者只结束界面观察，由Native Pane撤下呈现，Main继续持有网页；私有restore可交付同scope的全部存活页及activeId，保留旧单page消费形式。恢复清单不授控制权，迟到或错误scope不发布。不同网址的Agent新页保留已有标签，后台会话不因恢复清单抢占当前选择；明确Tab X交宿主核准确当前scope并关闭原页，活动操作的结果与资源清理另核，不把控制权移给替代页。实现和真实资格归[Desktop owner](../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)。

[SessionPage](src/desktop/SessionPage.tsx)的可选`tabsScopeKey`独立持有标签model、选中页、展开意图及已处理请求的展示身份，缺省沿原readingKey。Native以已知Store／当前选择意图提供稳定scope；正文读取、Caller generation或暂时缺少selection不应重建同一会话的标签，实际Store／会话变化仍重置展示。正文Conversation与历史readingKey、恢复准入browserRestoreKey和宿主权限均保持独立，稳定tab scope不恢复旧reader或操作资格。

[SessionTabs](src/desktop/SessionTabs.tsx)只在宿主fresh restore明确返回`reveal:true`且准确activeId存在于本次页面列表时，投影一次展示恢复意图。SessionPage等读取与恢复结算、准确browser tab仍存在且页面未被covered／其他详情面板替代后，才恢复原右栏并选择该页；普通restore不自动打开。按scope／page记录已处理意图，用户主动收起优先于迟到或重复reveal，A→B→A不复活旧请求；关闭原tab后也不展开另一页。该字段不保存截图或授予网页控制。[tab展示回归](test/isolated/desktop-session-page-render.test.tsx)、[标签生命周期](test/isolated/desktop-session-tabs.test.tsx)与[Native完整Root回归](../../apps/desktop/test/isolated/native-browser-restore-root-dom.test.tsx)在2026-10-30完整三文件24项449断言通过，覆盖selection暂不可见、fresh恢复、完整Root重挂载、旧请求与用户关闭；UI／Desktop类型通过。JSDOM和受控宿主证据不代替真实Electron连续画面，实机资格归上述Desktop owner。

子详情标签通过 `SessionChildTabRequest.childAgentIdentity` 复用 `ChildAgentIcon`，与环境卡、工具消息和审批保持相同外观；名称变更与同一子会话的不同任务不重新分配图标。该字段只负责装饰，标签去重和reader仍按原Session／Execution处理，缺身份时保留通用图标。原生网页、变更及关闭按钮图标保持各自语义。

`BackgroundExecutions` 的每个子 Agent 行在名称前复用 `ChildAgentIcon`；宿主通过 `childAgentIdentity` 交付稳定的原 Store／子 Session 身份，缺身份时使用通用图标，不以标题或任务状态分配外观。详情按钮只给右侧箭头应用辅助色，子 Agent 图标保留共享配色，文字继续单行省略；无详情回调时名称行也保留图标。原详情导航、停止和只读边界保持。

`ToolActivity` 与轻量 `ToolRow` 显示宿主核实的目标文字，沿原单行布局省略长目标，原生 `title` 保留完整展示文本；网页目标先经原去敏规则再进入文字与悬停提示。目标本身不提供文件或执行权限，原文件打开回调仍由宿主单独授予。Native 的参数来源、版本白名单及父／子详情交接归 [Desktop owner](../../apps/desktop/README.md#原工具过程与结果阅读)。

宿主核实的普通文件缺失由读取明细显示灰色“文件不存在”，沿成功观察呈现，不生成空正文、假行数或失败红色。该显示只接受原 Files 结果及准确来源，不把真实失败或未知转成缺失；原文件打开资格独立核验。[Desktop 实际过程记录](../../apps/desktop/README.md#原工具过程与结果阅读)覆盖单次输入、读取、完成与刷新重开，不由组件最终截图代替全过程验收。

[Conversation](src/desktop/Conversation.tsx)的主消息区采用可聚焦、具名的原生滚动section，保留原跟随／手动阅读／全选和缓存viewport身份，不再装配主消息区的Radix content包装、thumb轮询与scrollbar ResizeObserver。`SessionPage`在已有首次布局／窗口resize测量中按真实原生滚动条占位同步正文、输入区和准备页留白，overlay与传统滚动条不硬用同一宽度；只在值改变时写CSS变量，原工具详情的独立ScrollArea继续按各自reader规则工作。

Native 的 SessionPage 在有页面缓存时开启 `lazyHistory`，共享默认调用关闭。[窗口策略](src/desktop/conversation-window.ts)按实际可见 entry 分组计数：首次不超过100条完整挂载，超过100条只挂载末40条；折叠 turn 内的工具记录不逐项计数。向上接近200px边界或点击“加载更早消息”，经RAF后的task补20条。窗口保留已经挂载的内容，后续流式跨100条不会突然裁掉旧消息；点击“回到最新消息”可重新选择末40条。每条回复仍沿完整Markdown pipeline显示，不做正文段落拆分。

窗口只保留稳定entry keys及顺序，不缓存宿主投影闭包。补入前记录可见entry和相对viewport的偏移，提交后按该锚点恢复，避免以scrollHeight差值混入同时追加的消息高度。手动阅读及正文晚到的高度变化也保持锚点；冷重建时在原锚点附近挂载40条，允许向前／向后补入，旧版仅像素阅读记录完整挂载一次以保持其坐标。离开／Activity暂停取消所属frame与task，迟到回调不能接管新页面。Ctrl/Cmd+A只选择已加载的消息正文，保持即时响应；未挂载历史不进入DOM选择。

[DeferredProcessContent](src/desktop/DeferredProcessContent.tsx)使默认折叠的turn过程和[ToolActivity](src/desktop/ToolActivity.tsx)聚合明细在首次展开时才调用内部投影工厂。冷关闭不创建Content，展开后继续使用原Radix退出动画及卸载；关闭动画期间采用当前事实，不冻结旧身份或factory。原来关闭的Radix内容本就不挂载reader，本次减少的是提前构造明细和空Content的工作；不改变读取、审批、复制与恢复资格。

主消息区使用上述原生viewport，会话中的嵌套详情由ScrollArea的原生分支承载。CodeBlock的header／footer间距选择器限定在同一个块内，避免外层`group:has()`使追加消息反复失效整棵turn样式树；默认及small尺寸的间距和现有Shell／Markdown覆盖规则保持。成本登记以不可变token区分同resource的新旧登记，迟到注销不能删除新登记或owner释放责任；DOM缓存预算和完整成本测量准入不变。缓存entry变更回调在渲染闭包外构造，只捕获原retire函数、准确key和entry，避免仍在缓存的entry经共享闭包保留旧entries Map及已退役的空portal；保留原成本扫描、暂停、释放与所属scope核验。

[窗口策略](test/isolated/desktop-conversation-window.test.ts)、[真实Conversation DOM](test/isolated/desktop-conversation-window-dom.test.tsx)、[滚动](test/isolated/desktop-conversation-scroll.test.tsx)与[原展示](test/isolated/desktop-conversation-presentation.test.tsx)核阈值、尾部、双向补入、锚点、已加载全选、取消及展开恢复；[折叠工厂](test/isolated/desktop-deferred-process.test.tsx)、[工具聚合](test/isolated/desktop-tool-aggregation.test.tsx)、[成本](test/isolated/conversation-cache-cost.test.ts)和[缓存](test/isolated/desktop-conversation-cache.test.tsx)保留各自生命周期与身份断言。取舍归[按消息加载Note](../../.agents/notes/implemented/architecture/2026-10-26-desktop-progressive-history.md)，实际性能与限制归[Desktop owner](../../apps/desktop/README.md#大会话首次构建)。

[SessionPage](src/desktop/SessionPage.tsx)用共享 [NativeScrollbars](src/desktop/components/ui/scroll-area.tsx) 上下文统一普通会话的原生滚动：消息内详情、左右侧栏、宿主注入内容和 Portal 中的模型选择均继承；工作台和定时任务沿原模式。原生分支保留 viewport 的 ref、事件、双轴方向、具名 region 和渐隐，省去 Radix 内容包装及自绘轨道。会话内原生滚动条使用 `scrollbar-width: thin`，WebKit 回退轨道为8px；会话留白仍由真实占位测量。模型提供商的键盘定位改用共享 viewport 标记，不依赖 Radix 私有属性。原生 viewport 的 wheel 监听为 passive，只撤销待完成的键盘定位，不 `preventDefault` 或写祖先 `scrollTop`，边界交接与惯性交给浏览器；非原生分支保留原 wheel 接管。

工具详情继续在原项下展开，文件差异、Shell、问题与通用结果各自保留已有 reader。公共 [ScrollArea](src/desktop/components/ui/scroll-area.tsx) 的 `chainScroll` 还保护键盘边缘阅读：仅在 viewport 自身接到无修饰 Home／End 时，在原生滚动后将该边缘移入可滚动祖先的可见窗口；若相应展开动画仍在进行，等待其真实结束再核一次当前焦点和边缘。其他按键、焦点转移或卸载使旧定位失效，不拦截子控件、选择快捷键或取消原生默认行为。原400px聚合上限和输出跟随不变。[滚动回归](test/isolated/desktop-file-diff-scroll.test.tsx)核边缘可见性、无重复位移及子控件隔离；实际像素仍由 Desktop 浏览器旅程验证。

TUI [通用工具结果](src/tui/ink/ToolCardBlock.tsx)保留单行300／多行每行200字符、最多五行的有界预览；任一字符或行裁切均显示省略提示与 `Ctrl+E` 完整已保存结果入口，截取沿完整字素边界，不拆开代理对或组合 emoji。未截断内容不显示提示，原结果和执行目录读取保持完整。该规则不改变文件 diff、问答或 Shell 的各自呈现。

`ToolActivity` 的已知 `web_fetch` 使用地球图标、“读取网页”和原目标的网站／路径，省略协议、user-info、query与fragment，过长目标沿原省略与title阅读。准确成功只保留工具行，不挂载结果正文或原记录reader，不提供正文展开；这不修改Tool结果、Artifact或模型输入。失败及unknown仍保各自原详情，`web_timeout`仅补充不推断阶段的中文说明并保原代码。真实failed/rejected子工具的整个标题沿`--destructive`呈现，hover／focus／展开保持；重复结果标签仅供读屏，不参与行布局。聚合标题不因子项失败取得error装饰，unknown／等待／审批提示仍独立表达。DOM回归核同一聚合身份、状态转换、URL隐私与成功正文缺席，真实生产CSS的浏览器回归核整行颜色、目标截断、原因实际可读与原滚动合同。

`ToolActivity` 的 `toolDetailText` 不将 `source:auto/state:approved` 的通过理由混入工具详情；运行、成功、失败与未知结果均沿同一规则，工具原异常及 stdout／stderr 保留。批准盾牌与提示、拒绝／待人工／审批未知原因、原记录和宿主授权事实保持。纯显示筛选不删除 `Message.approval.reason`，也不更改执行状态。[聚合回归](test/isolated/desktop-tool-aggregation.test.tsx)覆盖未知工具、Shell、失败／未知、重读和原错误保留。

2026-10-25，Windows x64／Bun1.4.3，网页行与失败颜色这一轮：聚合／Native metadata／Native DOM 三文件66项／2519断言通过；页面13项／95断言及按原隔离方式单独运行的Sidebar9项／332断言通过，UI／Desktop类型、定向Biome、文档与边界检查通过。实际Chrome155在浅1280／深780px验证6个网页结果、成功正文不挂载、失败整行颜色与隐藏的重复标签、11种审批／结果、展开收起、原原因实际可见、键盘／滚轮／拖动及边界传递；25145份DOM／几何采样、10233帧中无页面错误，标题、外层阅读和输入区稳定，已人工复看关闭、悬停、展开及原因可见阶段。报告与逐阶段截图归`.cache/native-live-tool-aggregation-xG4M8P`。过程中实际发现收起的侧栏拖拽柄仍造成父面板2px横向溢出；仅在`data-open=false`时裁切其内容，修复键盘焦点带动整个内容区横移，展开柄和拖拽保持。原失败记录在`.cache/native-live-tool-aggregation-e7SSd5`／`.cache/native-live-tool-aggregation-ZsvQhY`；不放宽原精确几何断言。上述为隔离生产组件及受控metadata验证，不代表重新构建并验收完整安装版。

2026-10-25，Windows x64／Bun1.4.3／Chrome155、`3dc3a941f` 加本轮改动：共享聚合、Native metadata、Native 工具 DOM 与 Web Fetch network 四个完整文件66项／2510断言通过。原 long-group 浏览器 runner 使用实际 Native／共享组件与生产 CSS，在浅色1280px、深色780px两组逐步观察折叠、悬停、展开、关闭、11种审批／执行状态、键盘滚动及边界传递；20672份 DOM／几何采样、7328帧中均无自动批准理由混入可见工具正文，真实失败／unknown及拒绝全文保留，标题和输入区位置稳定、外层阅读位置保持，无页面错误。截图及报告在 `.cache/native-live-tool-aggregation-IhHAZ3`，没有读取用户 Store或发送真实任务，不代表完整安装版验收。

额外 tool-details 场景在嵌套文件差异尾部发现既有裁切：末行下缘546.875px而外层可见下缘535.1875px。隔离构建临时还原本次通过理由筛选前的逻辑后，得到相同几何失败；该场景与本次审批展示无关，未计为通过。保留原 [browser runner](../../apps/desktop/test/native-live-tool-aggregation-browser-runner.fixture.ts) 断言和两个证据目录 `.cache/native-live-tool-aggregation-J21EC6`／`.cache/native-live-tool-aggregation-M7ihds`，未放宽差异阅读规则。

Conversation 的 `systemKind:agent_result` 只消费宿主已确认实际触发父续跑的 `agentResult`，与普通消息共用 MessageItem 和输入气泡样式，增加“〔名称〕Agent 发送”头部，正文显示实际 Markdown 和非成功状态。父原轮 active 接纳不由宿主投影为此类消息，UI 也不按当前 Run 是否活动再过滤已确认的唤醒消息。独立消息边界不被相邻过程分组吸入，默认折叠及冷读仍保留正文，且不取得用户输入、助手最终回复或复制资格。同一 Turn 如被独立消息分段，整轮最终耗时仅在最后一段显示。`renderMessageContent` 仍由宿主提供准确详情入口，正文完整性由 `contentComplete` 明示。真实来源与读取由 [Desktop](../../apps/desktop/README.md#native-当前会话环境信息与子详情)及 Store 负责，UI 不根据名称、正文或子 Agent 状态制造消息。

普通邮件使用 `systemKind:agent_message` 和宿主验证的 `agentMessage`，沿原接收 Run 的 turnId 留在同一处理过程。原 MessageItem 复用用户／引导消息的靠右输入气泡，将“〔名称〕Agent 发送”、完整 Markdown 和正文不可读状态放在同一 `user-message-body` 内；发送者与不可读提示不叠加浏览器默认段落 margin，过程内邮件不预留信息栏的32px间隔，相邻块间距交给原过程容器。保留 `agent-message` 展示类别与 Agent 来源，不改成用户输入、工具执行或助手最终回复，正文中的批准文字也不生成操作入口。`data-agent-message-id` 沿原 mail ID，终态及冷历史保持同一份正文和一段过程，普通邮件的复制／时间资格保持；最终结果的独立消息边界保持上述规则。[共享邮件 DOM](test/isolated/desktop-agent-activity.test.tsx)与 [Native 投影 DOM](../../apps/desktop/test/isolated/native-transcript-dom.test.tsx)分别核来源、气泡正文、失败状态和活动→完成→冷历史的分组、单耗时与复制边界。

共享样式以 `--font-ui` 统一正文、控件与浮层的系统界面字体。中文沿系统字形回退。`--ui-text-size: 14px` 是客户端默认字号，`body`、`.kite-client` 与会话字号变量共用它；挂到 `body` 的 Portal 因此保留14px正文，不通过修改HTML根字号缩放 `rem` 布局；基础层的原生按钮、输入框、选择器与文本框继承所属正文的字体，避免浏览器默认控件仍显示13.33px。普通通知／问卷及操作、任务表单、右栏标签和工作台会话主名称使用该基准，徽标、代码与辅助信息保留明确层级。共享 `Textarea` 统一使用 `text-sm`，移除 `text-base md:text-sm` 的宽窄差异；欢迎标题固定28px，通用页面一级标题固定36px，不再按窗口宽度变更字号。普通文字为 400，界面标题、设置名称与 `font-semibold` token 共用 `--font-weight-semibold: 600`；Markdown 标题、加粗和等宽代码保留内容层级。代码块、行内代码、Shell 输出与等宽配置输入共用 `--font-mono`。`font-synthesis: style` 保留中文斜体的倾斜效果。Native 阅读区变量由 [Desktop owner](../../apps/desktop/README.md#复用原桌面展示层)接入。

会话、导航与右侧栏的共享 header 基准高度为48px，会话 header 上下内边距为8px；右侧标签本身保持32px高度，上下各留8px。`SessionPage` 的普通会话滚动 viewport 从标题栏顶边延伸至主面板底边；标题栏使用 85% 主体底色和 12px 背景模糊，输入区悬浮在底部，环境信息卡位置与标题栏下边线保持。局部 `ResizeObserver` 测量标题栏和输入区的完整外框高度，分别写入 `--session-header-height` 与 `--conversation-footer-height`，为首尾消息及键盘滚动保留对应空间；输入区变高时同步更新，卸载时释放观察器。主面板统一管理叠层：正文 viewport 在底层，玻璃标题栏居中，ScrollArea 轨道覆盖在右侧且标为 `no-drag`，只按实测标题栏高度下移轨道顶部并缩短轨道高度；全高 viewport 保持默认客户端区域，不整块声明 `no-drag`，避免伸到 header 背后的区域扣除 macOS 宿主的原生 drag 区域，不占用标题栏宽度，实际拖窗与验证边界归 [Native owner](../../apps/desktop/README.md#原消息复制与标题栏缩放)；正文视口、欢迎区与输入区通过 `--conversation-scrollbar-width` 在首帧统一预留10px轨道空间，浮动输入区不再等待 `SessionPage` 测量视口后改变右侧inset；输入区外围留白不拦截滚轮和滚动条；回到最新消息按钮位于输入区上方。布局只按实际渲染的顶部提示判断回退，Native 传入的空 React Fragment 不关闭效果；可见提示、读取错误与其他页面沿用正常布局。原 `Conversation` 继续管理跟随最新和手动位置。[布局回归](test/isolated/desktop-sidebar.test.tsx)覆盖空 Fragment、可见提示、页面往返与测量监听释放。

共享[桌面样式](src/desktop/style.css)的主体背景由 `--page-background` 跟随 `--background`：深色为炭黑 `#191919`，亮色为浅灰 `#fafafa`；输入框使用独立的 `--composer-background`，深色为 `#202020`、亮色为 `#fff`，与阅读区保留轻微明度层次；卡片和浮层继续使用 `--card` 的深色 `#242424`／亮色 `#fff`。会话标题、阅读区、设置内容与右侧详情沿同一主体变量，会话与右侧栏的标题栏共用 `--border` 绘制 1px 下边线，使用内阴影避免增加布局高度，使两侧下边线对齐；文字、交互叠层和侧栏实色回退值保持。原生透明侧栏与窗口底色由 [Desktop owner](../../apps/desktop/README.md#原主题与窗口背景联动)负责。

输入框的1px描边使用 `--composer-border-color`，亮色为黑色10%、深色为白色5%；键盘焦点边色使用 `--composer-focus-border-color`，亮色为黑色14%、深色为白色12%。投影色由 `--composer-shadow-color` 管理，亮色为黑色4%、深色为黑色24%；焦点外圈由 `--composer-focus-ring-color` 管理，亮色为黑色4%、深色为白色4%。常态投影保持 `0 1px 2px`，键盘聚焦时额外绘制 `3px` 淡外圈，继续遵循原输入方式判定。

[Sidebar](src/desktop/Sidebar.tsx) 的会话悬浮提示只显示完整名称与 `updatedAt` 的本地化时间；缺失或非法时间只保留名称。状态仍供列表标记与 `aria-description` 使用，不重复写入悬浮内容。

环境卡 [BackgroundExecutions](src/desktop/BackgroundExecutions.tsx)有业务名称时保留原名，无名称时普通环境信息显示“Shell”／“子 Agent”，仅诊断模式显示内部执行 ID；tooltip 和可访问名称遵循相同展示规则，操作仍传递原 ID。以可选 `busy` 表示短时校准：保留正文和停止按钮，沿 `disabled` 禁止停止并提供 `aria-busy`；`stale` 继续表示实际不可用／失败。首次子 Agent 读取同样只标记忙碌，不插入加载文字或提前显示空列表；真实 stale 仍撤销停止资格，以 `data-stale` 保留观察事实；“上次状态 · 待核实”等附加文案只在显式测试诊断中显示。环境卡忙碌时保留禁用按钮的原透明度和悬停外观，原 disabled、事件和真实异常显示保持；其他消费者默认透明度与行为不变。

审批模式在[Composer](src/desktop/Composer.tsx)共用 `HandIcon`／本地 `ShieldTerminalIcon`／`ShieldAlertIcon` 表示请求批准／自动审核／完全访问，自动审核复用 `Shield01Icon` 的轮廓并在内部加入 `>_` 终端路径，沿同一Hugeicons渲染与线宽；菜单与当前模式触发器消费同一映射。完全访问的名称、说明、图标与勾选统一使用 `--permission-full-foreground`，浅色为 `#b45309`、深色为 `#fb923c`；当前触发器的静态、悬停、聚焦及读取暂停展示保持同一橙色。Full确认框的图标继续与标题同用中性色，实际确认按钮继续实红色，不改变权限确认与范围隔离。

完全权限确认框沿[Composer](src/desktop/Composer.tsx)复用原AlertDialog及原确认范围门禁，落实用户确认的“清晰分行”方案：440px最大外宽、24px内边距、12px圆角、16px标题，警告图标直接继承标题文字颜色，深浅主题均为中性色。中英文风险采用原生两项列表，14px／500字重和前景色，分别说明文件覆盖／删除与敏感数据外泄及不可逆后果；列表项间8px，不附底部辅助说明。底部按钮靠右，以留白分区，不绘制分隔线。窄窗两侧至少16px，外宽计入边框和内边距，调宽不对宽度作过渡。公共[Button](src/desktop/components/ui/button.tsx)危险变体继续使用独立实色填充变量 `--destructive-fill`／`--destructive-fill-hover`／`--destructive-fill-pressed`与白字，具体色值由共享主题的深浅两套语义色维护；其他警示文字使用 `--destructive`。

2026-10-25，Windows x64／Bun1.4.3：原Native新对话整文件82项／1666断言、UI／Desktop类型检查和定向Biome通过。实际NativeDesktop／Composer与编译CSS在隔离浏览器逐步核对浅色打开→取消→深色重开→390px换行→确认：风险保持原生两项列表、文案完整，图标与标题计算色在浅色均为 `rgb(34,34,34)`、深色均为 `rgb(237,237,237)`；底部边框0px，内边距24px，窄窗弹窗358px且两侧16px，无横向溢出或页面错误。取消保留原审批方式，明确确认后更新原控件；原Full范围隔离、取消和门禁断言保持通过。模式图标调整后，同一整文件82项／1666断言与UI类型检查再次通过；浏览器补验深浅主题菜单、Full确认、确认后入口及重复选择，举手／终端盾牌／警告盾牌清晰，浅色图标、名称、说明均为 `rgb(180,83,9)`，深色入口图标与文字均为 `rgb(251,146,60)`；修正普通触发器样式覆盖后复验静态颜色，不重复弹出已选Full的确认。终端盾牌补验菜单与底部入口路径一致，重新打开菜单及重复选择保持原审批方式，页面无错误。此为隔离模拟Bridge下的实际生产组件及样式验证，未重验完整Electron安装版。

共享 [Composer](src/desktop/Composer.tsx)把业务可用性与读取资格分开：`disabled`／动作禁用值表达真实业务状态，`readOnly` 与 `readGate` 表达范围交接及各动作尚未完成的读取。[ReadGate](src/desktop/ReadGate.tsx)由公共 Button 与 PromptEditor 消费，实际原生禁用／编辑器只读仍拦截交互，视觉只随业务状态变化；嵌套门禁只能收紧资格。Composer 不再缓存最近控件外观，也不靠逐控件 CSS 覆盖透明度。空草稿、提交中、停止中与真实失败照常显示禁用；Enter、表单提交、附件及权限回调同样核当前门禁。切换范围、确认范围失效或权限读取未就绪时关闭旧菜单和 Full 确认，模型浮层也在读取门禁下关闭。`sessionLoading` 只描述普通读取状态，不授予资格。

目录、[定时任务](src/desktop/ScheduledTasks.tsx)、[文件操作](src/desktop/FileChanges.tsx)及共享[模型输入](src/model-input.tsx)／[输出](src/model-output.tsx)读取不显示临时加载文案，忙碌由区域的 `aria-busy` 和原控件状态表达。定时任务与文件操作只在读取完成后展示空状态，已有内容仍可保留；附件准备期间保持原文件名和预览占位，不插入准备提示；普通文件的在途准备仅保留忙碌图标、无障碍名称与“取消添加”，发送门禁和取消信号保持，失败仍可见。会话原转圈及其无障碍名称保留。

共享 [Composer](src/desktop/Composer.tsx)把内嵌菜单的鼠标事件留给菜单自身处理，菜单项及其文字不触发输入区空白处的 输入框聚焦逻辑。审批触发器以原 `permissionPending` 提供 `aria-busy` 和切换中标签，原禁用门禁保持；会话权限状态是否需要占据主区由 Native 宿主负责。

[PillSelectTrigger](src/desktop/components/ui/pill-select-trigger.tsx)复用共享 Button，统一13px/18px、28px高与胶囊圆角，传透按钮属性及ref供Radix Trigger使用；支持前置图标、后缀和向下/向右指示图标。项目/分支入口、模型入口与思考面板模型按钮共用该组件，标签可截断，后缀保持可见，展开反馈与减少动态效果集中维护。

选择器尺寸规范由[共享样式](src/desktop/style.css)的 `:root` 中 `--select-*` 参数统一拥有。项目／分支入口和选项、模型入口／思考面板／双栏列表共用这些参数；Composer 模型与审批触发器及审批菜单主文本也消费相同的字号与行高。新增紧凑选择器应复用 `PillSelectTrigger` 和这些参数，不在业务选择器中复制字号或行高。调整默认密度只改该参数源；主题覆盖也应放在根或主题根，确保 body Portal 与页面内菜单取得相同值。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--select-font-size` | 13px | 触发器、选项及菜单主文本字号 |
| `--select-line-height` | 18px | 主文本行高 |
| `--select-min-height` | 28px | 触发器及紧凑选项最小高度 |
| `--select-padding-block` | 4px | 紧凑触发器及选项上下内边距 |
| `--select-padding-inline` | 8px | 胶囊触发器及紧凑选项左右内边距 |
| `--select-icon-size` | 14px | 选择入口图标、箭头及模型勾选标记尺寸 |
| `--select-trigger-gap` | 6px | 胶囊触发器内部间距 |
| `--select-trigger-radius` | 9999px | 胶囊触发器圆角 |

高度按内容和最小高度共同决定，不以固定高度裁剪；换行选项自然增高，胶囊入口保持单行省略。菜单项圆角仍消费公共 `--button-radius`，弹层圆角消费 `--radius`。菜单宽度、列宽与容器留白由各菜单布局负责；Composer 原有普通文字入口保留6px水平内边距，审批菜单含辅助说明的多行条目保留组件库默认内边距，辅助说明字号独立。这些差异不作为紧凑单行选项的默认值。


新对话项目菜单由 [NewConversationContext](src/desktop/NewConversation.tsx) 统一只显示项目名称与选中标记，不把 `path` 选择值作为副标题；原值仍用于选中、React key 和 `onProject` 回调。没有项目时只挂载“添加项目…”操作，不生成空选项组或分隔线；有选项时再显示选项列表与分隔线。

项目／分支菜单沿共享 `.context-menu` 采用13px文字、18px行高，单行选项最小高度28px、上下内边距4px，与胶囊选择入口及模型列表保持紧凑节奏；按内容自适应宽度，常规窗口限制在160–240px，窄窗口扣除两侧16px安全间距；选项右侧保留32px选中标记空间，长名称沿原规则换行并自然增加高度。

共享[桌面样式](src/desktop/style.css)将交互状态与静态背景分开：`--control-hover`、`--control-selected`、`--control-pressed` 分别为亮色黑色5%／9%／12%、暗色白色7%／11%／15%的中性叠层，在控件所在的实色或系统材质上合成。普通按钮、问卷选项和设置内容沿用这些状态；左侧 `.client-sidebar-panel` 将 `--control-pressed` 局部映射到 `--control-hover`，使导航、空间与会话行、用户按钮和收展按钮的悬停／按下底色一致。选中导航与会话行局部将按下变量映射到 `--control-selected`，按下时也保持选中高亮；ghost 按钮静止时透明，主操作仍使用原实色配色。空间行内添加／移除等原本仅变图标的入口保持透明。状态标签等静态内容继续消费 `--accent`／`--sidebar-accent`；Markdown表格保持透明底与细线，代码使用独立的中性底色变量。Native 设置、菜单焦点映射与材质验证归 [Desktop owner](../../apps/desktop/README.md#交互状态与透明材质)，本层不取得壁纸或宿主材质读取能力。

2026-10-14 Windows x64／Bun 1.4.2，当前 `006b79d3` 工作树上的该变量修改：实际 Chrome headless 载入当前 Tailwind 编译 CSS 及共享 Sidebar／Button 的静态标记，用鼠标悬停核亮／暗、Mica／实色四种组合。亮色空间、会话、主要导航、用户按钮及设置返回样式与普通按钮均为 `rgb(236,236,236)`，选中会话与设置分类沿同值；临时替换 `--accent` 后亮色侧栏与按钮同步变化。暗色保原侧栏 `rgb(48,48,48)`，Mica 侧栏承载层仍透明。该次定向 Biome 核对保留了当时三项 `!important` 提示；此 CSS 核对不代证原生壁纸合成或完整客户端交互。

[SessionPage](src/desktop/SessionPage.tsx) 的外层 Group 分配导航与 `workspace`；工作区内的 `.client-content-frame` 包住第二层 Group，由它分配阅读区 `content` 和工具区 `details`。右栏开合只改变框内两区的宽度，外框到应用右侧的留白保持固定；描边、阴影、圆角与材质留白由 [Native owner](../../apps/desktop/README.md#windows-原生-mica)在共同外框上绘制。右栏展开时，工作区将两区合计660px最小宽度交给外层约束，保留紧凑窗口中导航让出空间的行为。布局取舍见[共同外框记录](../../.agents/notes/implemented/bug-fix/2026-10-20-session-content-frame.md)。

当前两侧可折叠面板在 [SessionPage](src/desktop/SessionPage.tsx) 通过 `ResizablePanel` 已有的 `style` 端口设置原 `overflow: hidden`，该值落在库默认 `overflow: auto` 的同一内容节点，保留原裁剪和滚动行为。会话阅读区由 [Conversation](src/desktop/Conversation.tsx) 使用共享 [ScrollArea](src/desktop/components/ui/scroll-area.tsx)，通过 `viewportRef`／`viewportProps` 保留原阅读视口与事件；内容容器由 Radix 生成，保留其内联 `display: table`／`min-width: 100%`。阅读列与轨道空间沿共享 CSS 约束，滚动跟随和阅读恢复仍由 Conversation 负责。

环境信息沿[共享样式](src/desktop/style.css)使用整张卡片宽度加 16px 右边距的水平位移，从右侧滑入、向右滑出，保持原尺寸并延续 180ms 缓出节奏；会话容器只裁剪水平方向，避免动画进入相邻详情区。原 CSS transition 支持连续反向切换，隐藏后延迟撤除可见性，减少动态效果时直接切换。

2026-10-23，Windows x64／Chrome 155，以原[会话浏览器夹具](../../apps/desktop/test/session-shell-browser.fixture.tsx)和当前生产编译 CSS 在 1440／760／390px 下逐帧检查滑入、滑出及连续反向切换，并观察中间画面：位移覆盖完整卡片与右边距，尺寸保持，右边界裁剪，没有横向溢出或页面错误；系统减少动态效果时立即切换。此为隔离浏览器验证，未重验完整安装版 Electron。

`@kite-ai/ui/desktop` 的 [SessionPage](src/desktop/SessionPage.tsx)、Sidebar、Conversation、Composer、RightSidebar 与 shadcn 控件从原 kite-client-ui 展示源码迁入，保留原 CSS、交互和依赖版本；[样式导出](src/desktop/style.css)供正式 Native 的原 Vite/Tailwind 管线编译。此层不导入旧 workspace 或 Runtime，事实映射和写入 authority 属 [Desktop host](../../apps/desktop/README.md#复用原桌面展示层)。

[Sidebar](src/desktop/Sidebar.tsx) 的会话行通过宿主回调提供“…”浮层，阅读与菜单为同一行内的独立按钮，列表箭头仍在会话行之间移动。菜单与空间栏的原操作查询将用户选择传给 Native，目录身份、会话修订和回执由 [Desktop owner](../../apps/desktop/README.md) 核对。

桌面圆角在[共享样式](src/desktop/style.css)统一定义：面板、卡片、列表、菜单和提示框消费 `--radius: 16px`，输入框消费 `--input-radius: 16px`，普通文字按钮、图标按钮和菜单项消费 `--button-radius: 8px`。Composer 仅在内部实际 `button` 节点上将 `--button-radius` 设为 `9999px`，形成随高度夹紧的胶囊形；非 Portal 权限菜单的菜单项仍为8px。Tailwind 的 `--radius-xs` 到 `--radius-4xl` 仍作为面板圆角的别名，控件按自身用途引用对应变量。圆形控件、滚动条、调宽把手保留圆形或胶囊轮廓，拼接内侧和全屏容器保留必要的直角；Native 设置样式、Mica 面板及正文排版共用这些变量。调整只改外观，不增加请求、写入或阅读权限；实际编译后的值和窗口验证归 [Native owner](../../apps/desktop/README.md#统一桌面圆角)。

同一共享样式的 `--resize-handle-width: 1px` 管理调宽线。导航分隔以该值占位，收起时归零；阅读区与右侧工具之间的分隔始终不占布局宽度，以伪元素覆盖接缝，保留原命中区、把手和键盘操作，避免右栏开合改变共同外框的可分配宽度。Native Mica 以导航分隔和内容留白计算玻璃导航的外侧间距，具体视觉边界与实窗证据由 [Native owner](../../apps/desktop/README.md#玻璃导航间距)维护。

[SessionPage](src/desktop/SessionPage.tsx) 的 `schedulePanelChange` 在实际开合时统一开启内外 Group 的 `data-animate-width`，面板、分隔与标题占位均消费[共享样式](src/desktop/style.css)的 `--sidebar-motion-duration`／`--sidebar-motion-easing`，默认180ms／ease-out，两种方向相同；导航与右栏分别按所属 Group 测量和调宽，不对已在目标状态的面板重复启动。调宽分隔收到鼠标／触摸或键盘操作后立即结束程序动画，拖动直接跟随；原240ms动画清理计时器在卸载时释放，减少动画设置同时关闭面板及分隔过渡。各用途的 RightSidebar、关闭与阅读生命周期保持。

[Sheet](src/desktop/components/ui/sheet.tsx) 的浮层与遮罩通过 `data-slot`／`data-side` 采用相同动画参数，Radix Presence 等待退出动画结束后移除节点，退出时不接收指针操作；减少动画时直接关闭。环境卡的透明度、位移与占位也消费这两个变量，宽度不足或恢复均启动过渡，新挂载卡用 `@starting-style` 进入。宿主详情开启时清除旧的内部右栏缓存，关闭仍立即卸载当前详情读者，退出的栏体不会显示之前另一面板的内容。

2026-10-19 Windows x64／Bun1.4.3、`f734245a` 加本轮改动：共享页面、侧栏和定时任务三文件31项／294断言及UI类型检查通过。Chrome155沿实际共享组件、Native编译样式及设置布局标记逐帧核18组双向显示／隐藏，窄窗左栏、环境卡自动恢复、设置右栏原跳变路径从零中间帧恢复为连续过渡，全部实际动画为180ms／ease-out；另核两组减少动画、浅色实色下快速反向、直接拖拽和减少动画的窄窗关闭，零页面错误。宿主详情不为退出动画保活；设置真实表单／关闭证据归[Desktop owner](../../apps/desktop/README.md#复用原桌面展示层)。未运行本轮安装版或其他平台原生窗口，既有嵌套 `@keyframes` 优化提示保留。

同页以单一 `sidebarOpen` 保存左侧导航的按钮开合意图；所有窗口宽度共用同一 Group 和按钮，不再切换窄窗 Sheet 或重挂载主区。导航不启用面板库自动折叠：展开时按200–420px约束调宽，按钮关闭时将约束设为0px并禁用分隔线，拖拽、键盘调宽、选择会话、新建对话与Escape均不改变开合意图。主区保留200px最小分配宽度，极窄窗口由面板库按可用空间分配；右栏仍沿原独立约束处理。私有 `NavigationPanel` 固定初始 `defaultSize`，避免保存宽度变化造成多余注册；按钮展开以及展开状态下的窗口拉宽会恢复保存宽度，只有用户拖拽写入保存值。导航显隐、按钮、`aria-expanded`／`aria-hidden` 和 `inert` 共用该状态。[侧栏 DOM 回归](test/isolated/desktop-sidebar.test.tsx)覆盖跨原600px断点的状态和节点保持、按钮开合、初始窄窗以及选择／新建／Escape不自动关闭。

2026-10-23，Windows x64／Bun1.4.3，`5c28cd1fd` 工作树加本轮修改：逐文件运行 `bun test` 的侧栏、标签页、desktop-page、scheduled-tasks 及 Native 新对话DOM五个文件，共109项／1912断言通过；UI／Desktop类型检查、定向Biome和文档检查通过。IAB实际SessionPage／NativeWindowFrame与生产编译样式逐步观察1280／901／900／800／600／500px窗口，核按钮开合、拖动200／290／420px宽度、Home／Enter／Escape、选择会话、草稿保持和右栏空间不足后恢复。左栏仅按钮关闭，header保持10px 24px、用户区8px下内边距且无侧栏额外10px；深浅主题800px核实际页面无错误。另核距底约38px时追加正文，scrollTop保持2548.67px，状态从跳动点切换为箭头不打断阅读，点击按钮回到底部。此证据为隔离renderer页面；原生窗口800px下限由Main配置，未做安装版系统拖窗或其他平台验收，保留既有嵌套keyframes编译提示。

桌面侧栏的开关意图、按钮和面板宽度由 `schedulePanelChange` 在同一个动画帧提交；没有可测尺寸时只更新开合意图。桌面只挂载一个收展按钮，放在导航分隔之后的零宽轨道 `.desktop-sidebar-toggle`，随实际面板边界及同一180ms偏移过渡移动；它不在导航或主区的裁切层内，开合不重建按钮、不丢失焦点，也不改变面板可分配宽度。标题保留原节点，`.session-sidebar-toggle` 保留0与“32px按钮＋当前标题间隔”之间的占位动画和32px高度；窄窗继续使用同一按钮和面板。减少动画时一起直接切换。[侧栏DOM回归](test/isolated/desktop-sidebar.test.tsx)另核帧前后开关同步、唯一按钮、标题／按钮节点和焦点保持。侧栏末端、标题起始内边距由共享变量与按钮共用，不再在900px断点改写；底部用户区保留8px内边距，侧栏不再在窄窗额外叠加10px下内边距。Native 的留白与macOS安全间距由 [Desktop样式](../../apps/desktop/src/native-tailwind.css)适配。

2026-10-19 左栏按钮复验：侧栏、共享页面、定时任务与Native新对话四个整文件52项／921断言、UI／Desktop类型检查及定向Biome通过。Chrome155沿实际SessionPage、NativeWindowFrame与编译样式，在200／285／420px保存宽度、800／1100／1400px窗口、深浅Mica、实色、macOS样式标记与减少动画七组配置核35段开合和快速反向，按钮保持同一节点、焦点、完整32px点击区，无重复绘制、裁切或垂直位移；另三组场景核深浅／材质下右栏同开、按住拖到0后反向、键盘收起、500px浮层及600／601px循环；700px窗口的右栏把导航挤至0px时，展开按钮仍可点击，手动展开及拉宽自动恢复均通过，显式关闭保持关闭。窗口约束解除后的保存宽度由原290→240px保留偏窄恢复为290px；草稿、标题和输入节点保持。此证据未覆盖安装版或其他平台的原生窗口合成。

右侧 `details` 面板及分隔在 `rightSidebarOpen=false` 时一同禁用，隐藏分隔不再响应鼠标／键盘，也不能经其他面板间接展开空栏。分隔以开合状态重新挂载，启用时重新登记相邻面板，保留重开后的键盘调宽。真实用户调宽至库确认的折叠状态时，沿当前 RightSidebar 的同一个关闭回调处理宿主详情、文件变更或定时任务编辑；原读取释放、焦点返回与编辑代次保护保持。正常展开时仍沿300–640px约束调宽。

右栏展开同步同时响应600px断点造成的 Group 重建，并在展开意图存在时观察内部内容 Group 尺寸；窗口或导航释放空间后，恢复被约束折叠的右栏。收起或卸载即释放该 ResizeObserver。窗口缩放不调用用户关闭回调，显式关闭仍清除展开意图。

2026-10-19 Windows x64／Bun 1.4.3，基于 `f734245a` 加本轮工作区改动：共享[页面](test/desktop-page.test.tsx)、[定时任务](test/isolated/scheduled-tasks.test.tsx)、Native [页面](../../apps/desktop/test/isolated/native-new-conversation-dom.test.tsx)和[后台](../../apps/desktop/test/native-background-panel.test.tsx)四个整文件54项／849断言及 UI／Desktop typecheck 通过。Chrome 155 隔离夹具沿实际 SessionPage、固定面板库和 Native CSS 复现关闭右栏仍可拉出640px空白，修复后保持0；2048／1240px、亮暗／Mica与实色下核实际拖拽、300–640px约束、键盘收起、详情组件卸载、重开及关闭按钮，500px另核收起右栏与窗口缩放。未运行安装版窗口、其他平台或全量默认测试；既有嵌套 `@keyframes` 优化提示保留。

同日宽窄切换修复在上述版本加本轮改动上复验：页面与定时任务27项／195断言、UI typecheck及定向Biome通过。Chrome155沿实际组件和Native CSS在亮暗／Mica与实色五个场景核宿主详情、文件变更及定时任务编辑，原1600→500→1600px右栏为300→0→0px，修复后恢复300px；另核800px挤压后恢复、600／601px反复切换、环境卡自动恢复与窄窗浮层、显式关闭不重开、草稿保留和零页面错误，并复验原拖拽／键盘收起与空栏回归。该证据不代替安装版或完整Electron窗口验收。

同日左栏双按钮修复：新增侧栏DOM3项／70断言，三个用例在原实现均失败，修复后通过；连同原页面、定时任务和Native页面共51项／849断言、UI typecheck及定向Biome通过。Chrome155在亮／暗Mica与暗色实色三场景沿实际SessionPage及Native CSS复现拉宽后导航为200px却仍 `aria-hidden`／`inert`、两个按钮均绘制；修复后只有一个可用按钮。另核桌面手动关闭、窄窗浮层开关、600／601px反复切换、保存宽度、键盘收起、草稿及右侧变更面板恢复；安装版、其他平台和全量测试仍未运行。

公共 Desktop 入口也导出已有 [Badge](src/desktop/components/ui/badge.tsx) 与 [Spinner](src/desktop/components/ui/spinner.tsx)，供 Web 目录复用原关注提示和加载图标；没有 Tailwind 编译的 Web 仅保留必要 scoped CSS，关注配色沿 attention 语义变量及系统语义色回退。

同一公共入口现导出原[Tooltip](src/desktop/components/ui/tooltip.tsx)四个组件，供[Web目录](../../apps/web/README.md)复用已有hover／focus／Escape和共享延迟行为；原组件、Radix依赖与Native Sidebar保持。Web负责准确公共activity、读取生命周期和本包scoped CSS，不引入第二份计时器、运行状态或业务authority。Web完整DOM、可信browser build与本机IAB证据归该owner和[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11web-完整工作区与会话目录)，不据新增export宣称全平台资格。

原 Conversation 的复制交互现归共享 [MessageCopyButton](src/desktop/MessageCopyButton.tsx)，正式 Native 的 Conversation 和正式 Web 用户／助手消息共同消费。宿主只交付准确文本、复制类别和 clipboard port；原 `useTextCopy` 继续订阅完整ActivityContext，按准确text／writer稳定copy回调，私有纯view只在复制状态、类别、disabled、readActive或回调真实变化时更新。[复制投影回归](test/isolated/desktop-copy-presentation.test.tsx)核纯resume跳过Button／图标构造、真实权限与宿主变化、旧回调和迟到写入隔离；组件保成功两秒反馈、失败重试、卸载及正文／disabled 变化后的迟到隔离，不推断 Turn、聚合正文、读取模型或发业务请求。原 Conversation 继续决定用户原文及宿主确认的最终助手全文，缺完整 copyText 的守卫保持。[真实 Conversation DOM](test/isolated/desktop-message-copy.test.tsx)核原文本、回合守卫、重试、换 scope 及同 ID 正文变化；Web 的原文、实际页与独立资产样式证据归 [Web owner](../../apps/web/README.md)，不把共享控件测试外推为 OS 剪贴板或完整客户端资格。

[Desktop build](scripts/build-desktop.ts)将[唯一声明](scripts/bundled-dependencies.ts)的 `@hugeicons/core-free-icons` 内联到原浏览器产物；其余 npm 依赖、React peer、原导出及 CSS 保持。Terminal 的生成 package manifest 不再声明这条已内联依赖，复制器仍保留其他包真正需要的依赖边。原包许可和 NOTICE 完整复制；固定 4.3.2 npm 包实际缺许可正文时，仅对准确版本／MIT使用[附带官方原文](scripts/licenses/core-free-icons-4.3.2/LICENSE.md)和[固定来源](scripts/licenses/core-free-icons-4.3.2/SOURCE.json)，离线核 SHA，不替换其他包许可。制品全部生成文件仍进入完整 inventory，实际原窗口和默认回归结果归[普通启动进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

有限 renderMessage、Composer 控件/输入标签/发送门禁 slot 和 detailPanel 让宿主接入已验证公共正文 reader、准确 controller 与原右侧栏；缺省保持原展示契约。侧栏开关不卸载 Conversation，宿主 detailPanel 关闭则卸载所属工具内容以释放原读取，不沿旧动画缓存保留隐藏 reader。Sidebar 在连接标签为空且未提供 connection action 时不生成连接行，用户菜单独立保留；Native 的测试辅助入口显示规则归 [Desktop owner](../../apps/desktop/README.md#普通客户端与测试诊断)。UI 不读文件、发请求或取消业务。缺少真实操作回调时不从 view model 推造能力；Message completion 不能提升为 final reply 或旧 Tool grouping。

[SessionTabs](src/desktop/SessionTabs.tsx)由 SessionPage 标题栏的“标签页”图标打开，替代原直接“文件变更”按钮。受控 Radix Tabs 提供新标签页、加号、切换、关闭和收起，最多8项；新标签页的工具网格可打开变更和执行轨迹，各工具在同会话内各保留一页。关闭最后一个标签通过同一 `onClose` 收起右侧栏并将焦点返回顶栏按钮，释放原网页或详情 reader；再次从顶栏打开且没有现存标签时显示新空白页。宿主可通过 `childTabRequest` 打开子 Agent 详情，以准确 Session／Execution 去重并选择标签，和网页／变更共享8项上限；满额的新详情请求显示必要提示。标签模型初始为空，关闭最后一个标签后也保持为空；仅主动点击顶栏“标签页”且没有现存标签时创建空白网页。子详情首次打开、关闭后重开均不预建无关网页，已有网页仍保留。`renderChildSession` 只在当前可见子标签挂载，`onChildSessionChange` 将准确目标或关闭状态交还宿主；标题更新不重新打开已收起的侧栏。主会话的 `readingKey`、正文、输入区与环境卡不因子标签切换而改变。`useSessionTabs` 位于响应式 Group 之上，调宽、窗口缩放与收起保留当前会话标签；独立展示 scope 变化或页面卸载只结束界面观察，明确关闭标签才调用宿主 `closeBrowser`，网页是否销毁及原任务如何收束由宿主核实。`renderBrowser` 接收稳定 ID、可见性、工具入口和标题回调；共享 `SessionBrowserToolbar` 只交付导航事件，不接触宿主接口。浏览器控制入口统一放入 `.native-browser-tools`，`canNavigate=false` 时保留可选取的只读地址并禁用导航，宿主仍负责控制权校验。工具浮层的 Portal 表单提交不触发外层地址导航；Native 的固定行高、窄栏收纳与页面几何由[Desktop owner](../../apps/desktop/README.md#普通页面控制租约候选2026-10-27未发布)维护。标签栏以 `visible` 控制交互、原生网页可见性和工具 reader；收起时立即设置 `aria-hidden`／`inert` 并卸载变更读取，保留栏体外壳供父面板沿原180ms宽度动画裁切退出。标签页由 `changeTabsOpen` 同步保存 `tabsKey`，父面板宽度继续由原调度在下一帧调整；阅读区与右栏共用180ms缓出过渡，并在共同外框内裁切；外框右侧留白不参与开合动画。`present` 仅在实际展开或退出动画期间保留外壳，结束、覆盖页面或让位其他详情面板时设置 `hidden`；空间不足导致实际折叠时也隐藏网页并卸载工具 reader，展开意图仍可在拉宽后恢复。外层 `#details` 使用不占布局空间的裁切，避免面板库的外层 `overflow: visible` 让300px最小内容宽度越界；减少动画和直接调宽继续遵循原规则。


拖动分隔线时，[SessionPage](src/desktop/SessionPage.tsx)通过 Group 的实时 `onLayoutChange` 投影实际折叠状态，及时撤下右栏的 `visible`／`present`；`onLayoutChanged` 只在交互完成后确认用户关闭意图。窄窗口自动折叠仍保留拉宽后恢复的意图。折叠布尔值相同直接返回，不为稳定正宽通知逐像素读取布局。[页面展示回归](test/isolated/desktop-session-page-render.test.tsx)6项83断言通过，核完成通知前隐藏、原页节点保留、显式关闭与自动折叠的恢复差异，以及同值通知不追加几何读取；测试受控发送布局通知，不替代实际指针拖动。真实开发客户端的边框收起、隐藏时缩窗、原页展开及连续画面限制归[Desktop owner](../../apps/desktop/README.md#macos-原生分栏与浏览器工具栏2026-10-31)。

Native 浏览器的标签 header 与地址栏持续由同一主 Renderer 绘制；共享 UI 不再提供远端 Chrome 展示 ports、hosted 隐藏或跨 Renderer 动作转发。[SessionTabs](src/desktop/SessionTabs.tsx) 保留唯一8项模型，浏览器 Pane 保持挂载并接收可见性；切标签、收起、换 scope 与页面卸载只撤展示，真正网页寿命由宿主 Main 负责。Native 的单一网页矩形、首文档可绘制及弹层恢复归[Desktop owner](../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。

`useSessionTabs` 在用户点击 X 的同一调用栈发起一次宿主 `closeBrowser`，让宿主在 UI 模型变化前捕获准确原页 token；不再预备旧 Root／Chrome 交接或等待显示画布。邻页选择与最后一项收栏仍在同次更新完成。关闭失败只在原 scope、准入及意图仍相同时恢复准确标签并显示错误，结果未知不重新发送关闭。切标签不预读目标截图；已有浏览器原页展开使用最终栏宽。共享组件只交付准确 ID 与有限交互，页面、Run 与租约是否结束由宿主核实。[标签回归](test/isolated/desktop-session-tabs.test.tsx)核容量、真实关闭一次、邻居选择、scope、迟到失败、清单恢复与 reader 释放。

共享 `SessionBrowserToolbar` 继续交付地址、前进／后退和刷新／停止事件，`canNavigate=false` 保留可选取的只读地址并阻止导航。地址聚焦时保编辑、选区与 IME，失焦同步最后确认 URL；同一 owner 的 React Refresh 不清未提交地址，真正 scope／页面／Host／文档变化退休旧编辑。新对话的手动网页由 Desktop 的 Root-local 草稿 owner 绑定，不为展示创建 Session 或授 Agent 控制。首个网址的 loading／错误层持续在 Root 中，Main 自行证明准确新文档可绘制后显示真实页；普通显示成功不成为观察或输入证明。首次／恢复的布局在当前Root layout commit同步准入，稳定resize继续单在途异步校准；这不证明原生surface与Root像素同帧提交。冻结制品已观察到单帧暗空、重开空底及灰带，整体体验验收尚未通过，准确过程、范围与未完成工作仍归Desktop owner。

原 [FileChanges／FileDiff](src/desktop/FileChanges.tsx)与 `fileChangesContent` 继续复用；只有当前可见且选中的变更或子详情标签挂载 reader，切换、覆盖或收起即卸载，其他标签不在后台读取。`renderDetail` 仍只在展开项挂载。实际网页、文件回执和编辑器目标校验归 [Desktop owner](../../apps/desktop/README.md#会话标签页与内置浏览器)。[标签生命周期回归](test/isolated/desktop-session-tabs.test.tsx)覆盖入口、reader、会话释放、窗口缩放、数量边界，以及最后一个网页／变更／子详情标签关闭后的自动收起、焦点返回和重新打开；UI 不取得文件或执行权限。同一文件新增宿主详情面板关闭与标签打开交错的回归：原实现中 `detailPanel.onClose` 先使宿主面板关闭，延迟到rAF的标签意图会被 `rightSidebarOpen=false` 的布局effect取消；仅标签开关同步保存 `tabsKey` 后，布局帧可被替换，不再丢失打开标签的操作；导航及其他面板保留原同帧提交合同。该修复恢复原标签合同，保留原reader释放、尺寸、共享复用与动画边界；合并后的实际执行结果单独核实。

SessionPage 的可选 `covered` 保留主panel树、尺寸和阅读实例，以opacity0／inert／aria-hidden退出绘制与交互；`overlays` 仍在同级可见层。左侧栏随同一主panel树被覆盖，原开合状态保留，恢复页面时不重新挂载导航。该属性不取消任务或重新选择会话；标签页隐藏网页并卸载当前工具reader，其余宿主reader保持原合同，默认不覆盖页面。原 [DialogContent](src/desktop/components/ui/dialog.tsx)新增可选 `showOverlay`，默认true保旧遮罩；Native全屏设置明确false，仍由原Radix内容保焦点、Escape与模态语义。具体玻璃层和状态恢复由 [Native owner](../../apps/desktop/README.md#windows-原生-mica)维护。

原 [MessageContent](src/desktop/MessageContent.tsx)和 [ToolActivity / ToolRow](src/desktop/ToolActivity.tsx)公开给 Native 复用，文件操作仍只调用显式宿主回调。`ModelOutputMessage.renderText` 可为同一预览或已验证全文提供宿主展示；不改完整读取、身份／字节门禁、关闭与 onContent，未传时继续 SafeMessageMarkdown。`autoRead` 失败保留原文和错误说明，不发布未核验的全文复制内容；缺省不提供“重新读取”按钮，Web 的显式 `autoReadRetry` 差异见下文正文读取契约，Native 保持缺省。显式完整 reader 沿用原操作。当前 Native 的消息路径与默认模型摘要归 [Desktop owner](../../apps/desktop/README.md#原消息文件路径与常规摘要)，纯 UI 不取得文件、来源核验或编辑器权限。

[桌面 Markdown](src/desktop/MessageContent.tsx)在 HAST 标记独立行内代码里的项目相对路径。自动识别有扩展名的斜杠路径，也支持带正整数行号的文件名。代码块和已有链接内的代码沿原语义。带宿主文件回调时，引用显示可换行的蓝色标签，悬停或键盘聚焦时带细虚线下划线。点击或按 Enter 分别交付路径和可选行号。当前阅读准入失效时暂停操作。无回调时反引号引用保留行内代码，带行号的链接显示标签文本。[Markdown 回归](test/markdown.test.tsx)覆盖预解析树、源码保留及渲染边界。

[Code Block](src/desktop/components/ui/code-block.tsx)与[Trace](src/desktop/components/ui/trace.tsx)使用官方 shadcn/ui 的 Radix 源码结构，分别适配现有 Button、Hugeicons 和语义 token。[MarkdownCodeBlock](src/desktop/MarkdownCodeBlock.tsx)只接块级代码，保留原 `pre > code`、语言类、缩进与换行；保持单个代码容器，显式语言按token高亮，不拆行；Mermaid图表使用同一标题与准确源码复制，正文仍走固定Markdown parser与安全规则。语言标题和复制操作由 Code Block parts 组合，表格身份保持。[Markdown 回归](test/markdown.test.tsx)和[代码块回归](test/isolated/desktop-code-block.test.tsx)核语言、准确复制、原安全限制与复制资格。 CodeBlock的Header／Footer间距通过同父前置／后续兄弟关系决定，取消3条无界group-has样式规则，避免长消息分批追加时将整个agent-turn反复标为样式失效；保留default／sm及现有Shell／Markdown的最终padding覆盖，源码复制与读取准入不参与这些选择器。

[Clipboard context 与 hook](src/desktop/clipboard.tsx)复用原消息复制生命周期；Conversation 提供宿主 port，正文内的代码复制同时消费原 `copyText` 资格，包含自定义正文 reader 子树。预览或未核实最终回复不提供代码复制，已核实正文关闭后撤销；停用、换文或换 port 的迟到结果失效，已完成反馈沿原两秒截止时间保留。复制不从 DOM 重建文本，不新开宿主或业务接口。

[ToolActivity](src/desktop/ToolActivity.tsx) 的可选 `childAgent` 只消费宿主交付的准确身份和名称，不接收子任务生命周期或新鲜度。Trace 复用彩色图标、14px 单行名称和来自原 Message 的静态工具标题；子任务完成、失败、中断或后续工作不改写历史操作，Trace 状态与运行动画只按该次工具调用的原事实显示，不从子任务派生。图标与 [ApprovalHeader](src/desktop/ApprovalHeader.tsx) 共用 `ChildAgentIcon` 的稳定身份分配；已识别的子 Agent 行使用原生共享 Button，整行调用准确 `childDetail.onOpen`，没有折叠入口、独立详情按钮或回执内容，旧 `expanded=true` 也不挂载原正文 reader。缺少详情回调时禁用整行，普通工具和真实工具失败、取消、结果未知仍沿原披露路径，不建立执行或导航 authority。[消息 DOM 回归](test/isolated/desktop-agent-activity.test.tsx)核创建／继续操作在旧生命周期输入变化后文字、ARIA、DOM 和原工具状态不变，保文本选择、直接导航、旧展开隔离与真实工具失败边界；宿主关联和窗口证据归 [Desktop owner](../../apps/desktop/README.md#native-当前会话环境信息与子详情)。

ToolActivity／ToolRow 用 TraceLine、Title、Icon、Description 和受控 Collapsible 承载原工具过程；`asChild`保留原按钮／div、独立文件操作、展开身份和恢复动画层。状态只消费已有执行事实，取消或结果未知不转成 Trace error；工具聚合、异常／原始详情、Shell输出、文件差异和原子Agent工具过程共用ScrollArea的原生viewport分支，并只在真实viewport加`scroll-fade-y`；共享适配的`fade`默认关闭，其他原消费者不因这次工具调整改变。`orientation`支持纵向、横向或双轴，代码与差异保原PRE内容，region／ARIA、键盘焦点和Shell的ref／onScroll改由viewport承接；原PRE不再形成第二滚动区。Shell以原CodeBlockHeader／Title／Footer组成灰底圆角卡片，带`$`的命令在Header按原始换行完整显示，长行自动折行、不省略，完整命令沿原CodeBlockCopyButton／宿主clipboard复制，摘要不提供全文复制；Header不绘制下边框，滚动提示沿真实viewport的scroll-fade-y；只有输出区滚动，右下角13px结果固定在Footer。外层工具行标题限制为512个UTF-16单位加省略号，Header命令节点保完整原文，摘要另明确标注。宿主的`Message.shell`只承载已核实的命令、输出和Job事实；launch受理、read／wait结果与stop请求不冒充Job成功，只有准确成功才显示勾号，成功不追加退出码、非成功结果保留实际退出码；缺少准确结果时不把最小operation称作已受理或已请求停止。失败／未知即使已有输出，仍保原完整异常记录。Shell独立输出保256px上限，聚合内按剩余空间收缩，保24px跟随阈值、截断与退出码，手动上滚停跟随、滚回底部恢复，不挂回到最新输出按钮。读取metadata期间保持同一卡片，原始记录的读取控件也在该卡片内，不切换另一输出壳。[聚合回归](test/isolated/desktop-tool-aggregation.test.tsx)验证真实 DOM 和输出追加；正式生产样式与浏览器验证归 [Desktop owner](../../apps/desktop/README.md#会话消息渲染验证)。

工具执行结果为 completed／failed、且没有明确未派发或审批拒绝事实时，已知动作使用“已读取”“已写入”“已修改”等完成式标题；它描述该次调用已有结果，不授予成功或读取资格，unknown 和未执行仍保原名。Shell 的 execute 失败保“已运行”和原命令，整行沿 error 颜色，不叠加“运行失败”，标题统一常规400字重；真实错误、退出码与审批说明仍沿原详情／ARIA。聚合逐项行高由32px收紧至28px，上下内边距各2px，外层摘要及展开正文的行距保持。

共享折叠 reveal 用直接子层的 `grid-template-rows` transition 与 `@starting-style`，快速开合在当前插值高度反向，不重播从零或完整高度开始的 keyframe。关闭内容只用等长的可见性动画让 Radix Presence 等待过渡，再沿原生命周期释放 reader；恢复展开与减少动态效果跳过过渡。冷折叠仍不投影内容、结束关闭后不保留 reader。原 [延迟内容回归](test/isolated/desktop-deferred-process.test.tsx)核生命周期，真实反向逐帧证据归 [Desktop owner](../../apps/desktop/README.md#原工具过程与结果阅读)。

工具状态 `queued` 显示“等待执行”，`running` 显示“执行中”；读取和修改行不隐藏运行状态文字；聚合标题只显示动作、图标和箭头，不追加数量、状态或异常文本。执行权不可核实时继续停止活动提示，普通界面不追加通用异常标签；准确审批中／待人工／拒绝优先级保持。已批准状态沿共享ToolApproval用14px盾牌勾和Tooltip呈现；自动审批未通过复用同一14px图标布局与交互，改用盾牌警告图标及随主题变化的attention-foreground，不挂常驻文字。图标只表示审批，状态与批准范围说明沿aria-label及13pxTooltip保留；拒绝原因不进入Tooltip，只保留在展开详情。按钮内不增加嵌套交互或tabstop，键盘聚焦原摘要可读、Escape可关；鼠标点击展开不强制弹说明。其他工具行附属状态共用13px辅助色，真实异常继续使用原异常色；确认未派发的审批拒绝、取消与审批中停止不追加重复的未执行／停止文案，Shell详情不再重复审批等待或挂载空状态。未知效果、超时与已派发后的独立执行结果不被审批标签覆盖。Native 的后端状态映射与对应 DOM 验证归[工具过程 owner](../../apps/desktop/README.md#原工具过程与结果阅读)。

`MessageContent` 的宿主文件回调在 layout effect 取得当前已提交值，稳定派发函数只调用这一值；正文解析组件只按原 text 保持 memo。私有 Context 将当前回调能力交给独立 Markdown 链接，能力撤销仍立即把文件按钮改为不可点击文本，重新提供及正文变化正常更新；普通回调更新与历史校准的撤销／恢复都不重新解析未变化正文。[原 Markdown 测试](test/markdown.test.tsx)通过实际 DOM 点击核最新回调、撤销／恢复、解码路径、外链和正文更新；不使用忽略回调的比较器保留旧宿主权限。实际 Native 完整历史与退出证据归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)，不据解析复用提升读取或阶段资格。

[MessageContent](src/desktop/MessageContent.tsx) 的聊天排版由[共享 CSS](src/desktop/style.css)统一管理：会话正文统一使用固定14px，不随窗口宽度调整；Markdown行高1.8，标题、代码、表格与脚注继续按正文的相对字号缩放。工具标题、过程摘要和压缩状态共用 `--conversation-text-size`，同步为14px。标题字号按层级覆盖通用页面标题，标题上方为两份正文块间距、下方一份，不随标题字号另外放大。段落、引用和代码块按正文尺寸统一块间距，避免代码的小字号缩小留白；一级列表项间距为正文块间距的2/3、子项为1/2，项内段落及代码前后保持一份正文块间距。渲染阶段在原解析树的副本上保留紧凑列表的段落节点，使代码后的文字与松散列表具有相同块边界；间距只从相邻块的起始侧提供，代码、引用或表格结束消息时不另加尾部留白。首段归零不清除文字与子列表之间的间隔，原文、任务清单状态及解析缓存不改写。正文沿原阅读列显示；代码保原换行并在块内滚动。表格使用具名、可键盘聚焦的滚动 section 包裹真实 table，表头与单元格保GFM结构和对齐，超宽内容在该区域横向阅读。稳定的表格组件保留流式追加期间的焦点和横向阅读位置；表格颜色显式继承正文，深色主题同样可读。固定GFM加公式parser与缓存、完整原文、安全链接及宿主回调规则统一。[原 Markdown 测试](test/markdown.test.tsx)核两类列表的段落、代码、子列表与预解析树保全；[语法缓存](test/desktop-markdown-cache.test.tsx)和[阅读滚动](test/isolated/desktop-conversation-scroll.test.tsx)继续核原合同，实际编译样式证据见下文。

会话间距也由这份共享样式负责：`--conversation-block-gap` 与Markdown段落共用正文字号的0.8倍；工具行已有上下各4px内边距，混合块间距扣除一份、连续工具扣除两份，因此固定14px正文下分别为文本11.2px、文本与工具7.2px、工具3.2px，宽窄窗口保持一致。处理过程以列布局统一直接子块的单侧间距，首尾按文本或工具的内部留白平衡；无轮次的原顺序消息采用同一相邻规则，聚合内工具列表项间距单独固定为0。存在最终回复时，过程容器不再提供底部内边距，由最终正文按前一项统一衔接：展开过程末尾为工具时7.2px、文本时11.2px，过程收起时与摘要相隔11.2px，避免过程尾部与最终正文顶部叠加。处理过程底部不绘制分隔线；最终回复的32px复制操作留白和用户消息原间距保持，分组、顺序、状态、折叠选择与读取权限均未改变。

2026-10-21，macOS arm64／Bun1.4.2，`a7f629960` 工作树加本次字号调整：Markdown、语法缓存、思考轮次、工具聚合、消息复制与阅读滚动六文件使用 `bun test --parallel=1 --max-concurrency=1` 执行，24项／992断言通过；定向Biome、文档结构与影响检查通过。Chrome沿实际Native Vite／Tailwind编译样式和 `MessageContent` 在深浅主题、320／767／768／1280px下核8组：正文及相关会话文本均为14px，正文行高25.2px，标题、代码、表格与脚注按原相对字号缩放，未发生页面横向溢出或脚本错误，并核对宽窄截图。编译保留既有嵌套 `@keyframes` 提示；此为组件与实际CSS证据，未运行完整安装版窗口。

轮次摘要的文字悬停样式绑定 `.agent-turn-status-label:hover`，不以整个按钮或展开状态触发；右侧空白、箭头和上下内边距保持原色，标题底色始终透明。可折叠按钮的 `focus-visible` 仍高亮文字，静态耗时只有文字悬停反馈而无新增操作，失败／停止颜色保持更高优先级。2026-10-23，Windows隔离浏览器加载实际Conversation与生产编译CSS，在深浅主题、1200／540px四组中逐步核文字、空白、内边距、箭头、展开移开、鼠标与键盘收展及静态耗时，均符合上述边界，浏览器零异常。现有轮次测试5项通过、1项既有失败：精确用户文本断言未包含当前“时间未知”展示；对应Conversation、message-time与测试文件均未改动，本次CSS不参与其SSR断言。该测试问题保留，不将浏览器样式验证表述为整套回归通过。

“用时”标题收展时，最终正文的顶部间距与过程高度一起过渡，避免关闭瞬间在混合块间距与正文块间距之间跳变、正文先下跳再收起。共享样式的 `--collapsible-expand-duration/easing` 与 `--collapsible-collapse-duration/easing` 同时供原折叠动画和该间距过渡使用，沿用展开300ms／原缓出曲线、收起240ms／ease-in-out；恢复已保存展开状态不重播原进入动画，减少动画时同时关闭间距过渡。2026-10-19同一Windows候选下，思考轮次、工具聚合、阅读滚动与复制四个整文件13项／857断言及Biome通过；Chrome155沿实际组件和Native编译样式在21组配置逐帧核84次双向收展，覆盖深浅、1280／500px、工具／文本结尾、字号、键盘及8次减少动画路径，正文无反向帧，标题无位移，普通动画保留连续中间帧。原52组长正文布局检查继续通过。此证据未覆盖完整安装版窗口。

2026-10-19 Windows x64／Bun1.4.3、`f734245a`加当前改动：工具聚合、思考轮次、Markdown、语法缓存、消息复制与阅读滚动六个整文件23项／974断言、UI类型检查及定向Biome通过。Chrome155加载实际Conversation、MessageContent、工具与NativeWindowFrame及编译样式，以截图长正文在深浅主题、1280／800／500px、放大字号、紧凑／松散列表及过程开合下核52组组合；默认工具过程至最终正文的24px叠加留白归为8px，二级标题前后从约31／9px归为24／12px，代码块前后段落间距均为12px，两类列表排列相同。另核以代码、引用或表格结束的消息至后续工具，不附加尾距；最终复制控件与下一轮消息不重叠，底部分隔线为0px，无横向溢出或页面错误。深浅宽窄两组共六次手动过程／工具聚合开合无内容裁切。此为组件与实际CSS证据，未复验完整安装版窗口。

长普通文本在 Markdown 转换后的树中拆成相邻 Text 节点，不增加包装元素、换行或省略内容，继续沿原消息列和 GFM 展示完整正文；code／pre 保原结构。超过4096个字符串单位的文本按约2048单位组织，非ASCII沿 grapheme 边界，单一更长 grapheme 仍完整保留。原文字、标题、链接、表格、图片替代文字及 HTML 处理保持；全文仍先经宿主完整 EOF／SHA／UTF-8／scope 核验，复制使用原正文，不增加读取或文件权限。[原 Markdown 文件](test/markdown.test.tsx)保全部原断言并核实际 DOM 的完整长文本与 Unicode 边界；实际 Electron 可见性与全文资格归 Desktop owner 和[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)，不据此承诺固定内存或所有设备的延迟。

浏览器执行沿工具行显示已核调用中的可选 `description`，使用可读动作名和最多40个Unicode字符的短说明；省略描述仍可正常执行，完整原描述保存在原调用中；加载技能只显示真实 Skill ID，不附调用目的；读取资料只显示 Skill ID／资源路径，不附执行描述。未知定义／版本不读取该字段，旧记录不补造。Native 通过原 `Message.target` 投影，通用组件也识别这三个公开名称的简短参数，保持单行省略与完整 title；描述不参与执行状态、审批或文件打开资格。已识别的浏览器操作在无真实异常时只绘制静态摘要，即使恢复了旧展开状态也不挂载原始正文或调用宿主 reader；失败、拒绝、结果未知及未核实记录继续沿原异常／原始 reader。

原工具组件允许宿主给 `Message.target` 传展示文本，不从文本取得文件或执行权限。Native 的已知工具行沿准确执行结果与当前视图适配；未来定义／版本不借旧同名分类解释，原文仍可展开。Shell 操作继续复用原工具图标，实际身份、目标、状态与限定证据归 [Desktop owner](../../apps/desktop/README.md#原工具过程与结果阅读)。

SessionPage／Conversation 的 `renderMessageContent` 和 `renderToolActivity` 让宿主复用原消息外层、轮次折叠、最终回复复制和分组阅读状态，工具 slot 接完整分组与原展开控制；原 `renderMessage` 及未传新 slot 的缺省行为保持。`copyText=null` 表示当前正文仅可读预览，不能当全文复制；`TurnActivity.cancelling/unavailable` 只表达宿主确认的停止中／上次确认状态。ToolActivity 的 `unverified` 不推断缺少的执行状态，“状态待核对”仅在显式测试诊断中显示，已提供的真实执行状态仍优先；独立的 `Message.executionUnconfirmed` 使未结算的活动工具停止执行／审批／等待提示，保留原 status、settled 和已保存输出，普通界面不追加“执行状态待核实”。已结算成功、失败、取消及未知结果不被覆盖；混合聚合与空 Shell 输出由[工具回归](test/isolated/desktop-tool-aggregation.test.tsx)核对。这些标记仅控制展示，不建立执行结果。`openFileForMessage` 保每项独立回调，`ask.cancelled` 表达取消信息回答，与工具／Run 终态分开。准确公共 Run、原问答结果和完整正文资格归 [Desktop owner](../../apps/desktop/README.md#原轮次阅读聚合与问答回执)，纯 UI 不建立来源或业务 authority。

[ModelEffortSelector](src/desktop/ModelEffortSelector.tsx)默认在入口上方居中打开，靠近视口边界时沿原避让规则调整；复用原双栏浮层与 [GemSlider](src/desktop/GemSlider.tsx)。模型浮层统一使用400常规字重，提供商、模型名称与思考面板的模型按钮均继承该字重，选中、悬停或聚焦不加粗。双栏模型浮层默认宽320px，提供商列宽128px，模型列保持原可用宽度；思考面板与双栏切换时先测量当前及目标实际尺寸，以180ms宽高动画衔接，内容以140ms淡入并轻移4px；快速反向从当前动画尺寸继续，模型聚焦不滚动外层浮层。系统减少动态效果时直接切换尺寸并关闭该浮层的开合与内容动画。整体宽度仍不超过窗口宽度减32px。列表为13px／18px，两列容器共用4px外层留白与2px标题／列表间隔；标题使用与权限菜单Label一致的上下6px内边距，标题及条目的左右内边距统一8px。提供商和模型行高28px，与Composer内选择器高度一致，条目上下内边距4px；两列列表上下留白与项间距均为2px，首行、标题与条目文字对齐；仍保留288px默认高度及原Radix可用高度限制，两列各自滚动。内嵌Command使用 `rounded-none`，避免默认16px容器圆角裁切首项；浮层保持16px，提供商与模型项的四角均为8px。模型项默认沿用未选中提供商的 `--muted-foreground`，仅实际 `selected` 模型的 `data-current` 使用 `--foreground` 并显示勾选图标；不提供常驻选中底色，cmdk的第一项及导航态 `data-selected` 不改变文字颜色或产生背景。提供商与所有模型项均由各自的 `:hover` 沿用 `--control-hover`，移开后恢复透明背景。键盘导航在模型列获焦时保留独立细线焦点提示，Enter仍提交准确导航项。思考面板与选择器文字同为13px，采用12px外层留白，标题组内8px间隔、模型按钮至滑块操作区4px间隔，使模型文字上下两段可见间距一致。浮层内滑轨高24px且无边框，保留32px操作区域与22px白色按钮；按钮在悬停和拖动时通过变换放大25%，结束后恢复，不改变布局或档位映射。仅在允许动态效果时使用150ms过渡。选中模型且宿主提供变更回调时即可调整思考程度，不接收模型支持能力开关。六档「轻度、中、高、极高、Max、Ultar」分别回调 `low/medium/high/xhigh/max/ultar`，不提供配置默认或关闭思考按钮及回调。模型按钮、浮层顶部和滑块无障碍值显示同一档位；纯函数resolveThinkingEffort供选择器、Native宿主与定时任务表单共用：已有明确值优先，缺省为medium；稀疏目录不含medium时选择六档中最低的可选项。选中模型后标题、摘要和滑块直接显示同一具体默认值，不显示“未指定”；宿主发送或保存同一个解析结果，无需先调整滑块，也不在挂载时伪造用户变更回调。旧none/minimal等明确值不在六档位置时，GemSlider保留中性轨道；用户点选或键盘操作后才替换成六档值。档位变化只经onValueChange交付一次，不在松手时重复回调。宿主可传准确 `ModelOption.id` 与 `reasoningEffortChoices`；选择、列表键和当前标记按 ID 区分，同一提供商内同名模型补显示 ID。滑块映射宿主提供的六档子集；一档用按钮，零档不造滑块。旧 none/minimal 可作为已配置值显示，不生成额外选项。宿主可用纯文本 `modelSelectionHint` 在模型列表底部提供12px左对齐的辅助说明，不在思考档位面板常驻展示。说明占原288px列表布局的底行，两列继续在剩余高度内各自滚动，不增加浮层总高度；组件不据此锁模型或改变候选，协议过滤与后端校验由宿主负责。[浮层回归](test/isolated/model-effort.test.tsx)核无能力元数据的模型可调整、缺失路由及默认档位首次显示、键盘调节；[Native DOM](../../apps/desktop/test/isolated/native-model-picker-dom.test.tsx)核 Ultar 回调、稀疏档位、两按钮缺席、旧 none 配置及切换模型后清除临时值。

2026-11-07，Windows x64／Bun1.4.4／Electron44.3.0，基于`ad9015854`加本次具体默认档位与发送修复：[浮层](test/isolated/model-effort.test.tsx)、[Native模型选择](../../apps/desktop/test/isolated/native-model-picker-dom.test.tsx)、[定时任务](test/isolated/scheduled-tasks.test.tsx)及[完整桌面发送](../../apps/desktop/test/isolated/native-new-conversation-dom.test.tsx)四个完整文件176项／2884断言通过，UI／Desktop类型与定向Biome通过。新增回归核未配置时首次显示中、原配置和会话记忆优先、旧推荐缺档位、稀疏目录、无滑块操作的首条与后续发送、切会话与切模型，以及定时任务默认值保存。实际生产编译样式与NativeModelPicker的隔离Electron观察和发送意图记录在本机`.cache/effort-display-20261107/frames-default.json`及`intents-default.json`；下游参数编码复用[输入owner](../../apps/desktop/src/input.README.md)所述Service／SDK物理请求证据，相关源码和schema未变。未调用远端付费模型，也未验收正式安装窗口或其他平台。

[Desktop 构建](scripts/build-desktop.ts)在普通 workspace 与源码外候选中均输出实际 desktop/index.js 和原样 desktop/style.css，补齐新增 exports；Native renderer 编译 CSS/字体并纳入原递归 manifest。[原页面测试](test/desktop-page.test.tsx)迁回原 12 项展示断言。正式 macOS 窗口、原身份读写和剩余旧页面迁移范围由 Desktop owner 维护。

上述ModelEffortSelector默认`combined`模式保持输入区的组合入口。可选`model`模式只显示模型名，直接打开原双栏，聚焦当前提供商，选中准确ID后关闭；`effort`模式只显示档位，打开同一思考面板和GemSlider，不附带模型切换按钮。两种模式共用原候选、稀疏档位映射、具体默认档位与禁用规则，不复制浮层实现。无模型、无档位回调或无可选档位时，独立思考入口禁用。[浮层回归](test/isolated/model-effort.test.tsx)核独立入口与原组合模式；[Native DOM](../../apps/desktop/test/isolated/native-model-picker-dom.test.tsx)继续核会话模型／档位契约。

定时任务模块的侧栏、页面、新建／编辑面板、搜索、筛选、空状态和删除确认统一使用“定时任务”；侧栏、空状态及任务卡片复用 `AlarmClockIcon` 闹钟图标，其他功能的图标不受影响。公共组件接口与宿主调度语义保持。

2026-11-04，定时任务筛选组使用公共Tabs的className统一内外胶囊圆角：原整文件20项回归、UI typecheck和定向Biome通过。隔离Chrome在明暗主题×1280／800／390px六组30阶段逐步核全部、已启用、已暂停及Home／End键盘切换，容器与选项四角均达到各自半高的胶囊轮廓，焦点无重复outline且无横向溢出；截图和计算样式在本机`.cache/scheduled-tabs-radius-preview/`。此修正只作用于该筛选组，其他Tabs的默认外观与运行逻辑保持。

同日仅调整定时任务更多菜单弹出层的紧凑排版：隔离Chrome深浅主题×1280／800px四组实际对比确认选项由42px收紧为28px、文字13px，外部标题、按钮、筛选与统计的计算字号及数量保持。逐步核打开、Escape焦点恢复、键盘重开、暂停后的计数／启用菜单及删除确认取消，页面零异常；截图与数据在`.cache/scheduled-popup-font-preview/`，本轮CSS Biome通过。

[ScheduledTasks](src/desktop/ScheduledTasks.tsx)负责定时任务页、状态筛选与任务／说明／项目文字搜索；全部／已启用／已暂停复用[公共Tabs](src/desktop/components/ui/tabs.tsx)的TabsList／TabsTrigger，筛选容器与内部选项均通过公共className采用rounded-full胶囊圆角，数量保留在标签旁，受控选择继续与搜索取交集，结果由对应TabsContent关联；不再保留任务页自建筛选按钮的底色、边框、选中和焦点样式，没有任何任务时不产生无对应页签的tabpanel。搜索框复用公共Input的背景、边框、字号和焦点状态，搜索图标位于框内且不拦截输入，label通过htmlFor关联准确输入ID；[ScheduledTaskCard](src/desktop/ScheduledTaskCard.tsx)负责卡片、更多菜单、删除复核与独立展开的运行历史；更多菜单弹出层沿共享选择器指标使用13px文字、18px行高、28px选项及4px／8px上下／左右内边距；选项显式采用border-box，避免Portal脱离主区盒模型后把最小高度和padding相加。页面和触发按钮字号保持原规则；[ScheduledTaskEditor](src/desktop/ScheduledTaskEditor.tsx)负责右栏表单，项目直接复用[新对话的ProjectSelector／ContextMenu](src/desktop/NewConversation.tsx)，模型和思考程度分行使用上述ModelEffortSelector的`model`／`effort`模式。定时任务表单不提供额外添加项目操作；项目菜单、选中标记与普通新对话同源，不保留自建TaskChoice或选择浮层样式。模型目录保留准确ID、提供商、名称、已配置思考程度和可选档位，选择模型后按新模型配置显示，保存当前显示的具体档位，未调整时也解析并保存模型配置或缺省medium。已保存但当前不支持的档位不能保存，不静默改成其他档位。[类型与校验](src/desktop/scheduled-task-types.ts)保存宿主契约，原ScheduledTasks入口继续重导出类型、编辑器和校验函数；实际持久化与派发归Desktop。卡片采用12px上下留白与8px列表间距，名称／说明单行省略并通过title保留全文；编辑、立即运行及更多菜单位于标题行，项目、安排、下次运行共用元信息行，窄容器按需换行，不再单设操作页脚。历史独立展开，失败与未知详情仍完整换行。右栏内容独立滚动，底部操作固定；表单的EditorSection／EditorRow保留分组卡片与左右标签／原控件，行高36px，说明区复用[公共Textarea](src/desktop/ui.tsx)及其[组件库控件](src/desktop/components/ui/textarea.tsx)，背景、边框、字号、内边距、占位符、焦点与禁用状态沿公共表单规范，不再被任务页外观覆盖；局部仅保留固定内容尺寸、80px最小高度、240px最大高度与纵向拖拽。其余留白和圆角同步收紧。重复与时间同组，频率复用DropdownMenu单选与PillSelectTrigger，每周星期保留原生单选语义。时间行内联共享[TimePicker](src/desktop/components/ui/time-picker.tsx)／[Input](src/desktop/components/ui/input.tsx)，沿[shadcn Time Picker 示例](https://ui.shadcn.com/docs/components/base/date-picker#time-picker)采用type=time并隐藏系统选择器图标；step=60保持原分钟精度，通过form属性关联右栏原表单。时间输入位于行右侧，左侧label通过htmlFor关联；不再渲染时间触发按钮、Popover和额外标题。草稿和校验不含时区，时钟归Desktop宿主；清空时间会禁用保存，重新输入后可继续。高级设置复用AnimatedCollapsibleContent，默认展开项目、模型和思考程度，各行保留标签；折叠不丢失父层草稿，调整思考程度不改变模型。不附加安排摘要和环境解释。

2026-11-03，Windows x64／Bun1.4.3／Electron44.3.0，`c82f0efea`加本轮工作树：实际development窗口核名称普通／鼠标聚焦／键盘聚焦，只有控件自身边框与公共焦点环，原名称、时间及说明区高度保持。隔离生产CSS在Chrome156深浅两主题核7个字段／卡片的背景、边框及8px圆角一致，名称外层无卡片边框；进一步核键盘切换、多行输入、保存中禁用、模拟保存失败后原文与操作恢复，页面零异常。截图和计算样式归本机`.cache/scheduled-form-style-20261103/`；原定时任务整文件20项／182断言、UI类型及定向Biome通过。此验证使用隔离保存回调，不声明真实宿主保存或其他平台发行资格。

2026-11-03，同一Windows开发窗口逐步核对公共Textarea的空白聚焦、中英文与多行输入、Enter换行、全选清空、80px与240px之间的拉伸及缩回，内容、输入位置、底部操作与原时间保持正常；原定时任务回归整文件20项／182断言、UI类型及定向Biome通过。此次替换保持原草稿、校验、pending禁用和保存回执处理；不新增宿主或调度能力。

名称直接复用[公共Input](src/desktop/components/ui/input.tsx)，不再套带边框的卡片，36px高度之外沿公共控件样式；关联label使用sr-only，不参与布局，placeholder为“名称”，保留原aria-label和整行左对齐输入。名称、说明、时间与分组卡片统一使用--card背景、--input边框和--form-control-radius圆角，不再使用任务页的混合填充或覆盖公共输入样式。焦点只由控件自身呈现，时间控件继续右对齐并使用等宽数字。2026-11-03，Windows x64／Bun1.4.3／Electron44.3.0，`c82f0efea`加本轮工作树：在当前development窗口逐步观察空名称聚焦、中英文输入、Home移动、全选和清空，位置正常且原时间保持；原[定时任务回归](test/isolated/scheduled-tasks.test.tsx)整文件20项／182断言通过。此范围为共享样式与当前开发窗口，不扩展安装发行或其他平台资格。

卡片保留编辑与立即运行，将启禁和删除收在Radix菜单；删除仍须明确复核，并说明已有会话保留。没有运行记录时隐藏历史入口，展开后不重复显示最近状态；主动停止只显示“已停止”，具体失败与未知详情保留。页面不重复顶栏标题或常驻运行条件说明，筛选位于工具栏左侧，搜索与新建按钮成组位于右侧并保持同高同行；空间不足时筛选可换行，搜索与新建仍保持同行；空页、筛选和暂停状态不追加解释。SessionPage／Sidebar透传宿主的resumeNewConversation导航回调，只有宿主明确授予时才允许在忙碌期间返回已有准备页，不授予新的提交或项目操作。事实和执行资格均来自宿主参数，UI不调度或调用模型。异步失败保留字段，pending阻止重复点击，缺宿主保存回调仍禁用；新建表单保留稳定创建意图key，真实任务ID、未知回执核对及原会话归属仍由Native持有。ScrollArea内容表格继续固定到viewport宽度，SessionPage原编辑器代次防止旧保存回执收起后来面板，关闭后按原触发按钮恢复焦点。定时任务编辑开启时，内容外框使用专属容器查询；不足800px时同一右栏覆盖列表，表单始终使用静态分隔线，不重挂编辑器或改变左导航宽度。恢复足够宽度后沿原Panel句柄展开并排，ResizeObserver随编辑器关闭释放。此修复针对实际最小800px窗口中原360px主区加300px右栏无法分配、表单存在但不可见的问题，不扩展其他详情面板。验证见[DOM测试](test/isolated/scheduled-tasks.test.tsx)，真实持久化、权限及完整Native窗口观察归[Desktop owner](../../apps/desktop/README.md#native-定时任务)。

2026-10-25，Windows x64／Bun1.4.3，`b31d05415` 加本轮工作树：原模型浮层与Native模型选择器DOM两个完整文件24项／326断言通过，核思考面板无常驻提示、模型列表单份辅助说明、选模后撤下说明、档位回调、三种原协议来源过滤及首次运行前不限协议。Chrome155隔离组件配合生产编译CSS在深浅主题、1280×800／390×800／390×360六组场景逐步核打开、调档、双栏切换、滚动选择末项和返回，说明12px且完整位于原290px外框内，无横向溢出或浏览器异常。UI／Desktop类型检查、定向Biome与文档检查通过；未重验完整安装版Electron或真实模型。

原 SessionPage 欢迎区仅显示标题，项目／分支菜单与 Composer 继续承载正式 Native 新对话准备，不展示任务建议卡片。纯 UI 只编辑／聚焦草稿和回调宿主选择，项目字段承载宿主 ID，不据此读取目录或执行 Git。创建、权限、实际模型及首次消息接管归 [Desktop owner](../../apps/desktop/README.md#native-新对话准备与首次发送)；不将准备页状态转为 Session 或执行 authority。

原 [BackgroundExecutions](src/desktop/BackgroundExecutions.tsx)环境信息卡已由 Native 的 SessionPage 消费，保留 Shell／子 Agent 分组、名称、当前任务和子详情回调。宿主可声明 queued／starting／unknown／restored 状态；当前环境模式 `currentOnly` 的 Shell 由宿主先核验后台启动来源，再保留运行／停止中；前后台身份归 Native 适配，UI 不按取消关系推断。Shell 逐项 `canStop=false` 或缺少停止回调时不提供停止入口；子列表保全部记录、状态和只读详情，并通过原 `stoppingExecutionId/onStop` 操作宿主已核实的新鲜准确 carrier。旧状态、unknown、恢复历史或宿主未提供停止资格时不可停止；回调保原 Execution／task 范围，不从同一 child Session 推断最新目标。状态本身不证明进程清理。300px 卡及宽窄窗口停靠／浮层仍由原 SessionPage 管理。卡片采用12px上下、14px左右留白；空分组在标题同行显示 Shell“空闲”或子智能体“暂无”，不重复显示零计数和独立空状态。环境状态由宿主通知自动更新，标题不提供手动刷新按钮；有记录时显示计数、列表及原操作；Native 宿主在读取失败后保留原内容并后台重读，普通环境卡不追加异常文案或临时重试按钮。停靠时共享 CSS 先利用 844px 阅读列右侧的留白，再按可用宽度将右侧占位限制在 28–344px；不再固定缩为 720px。留白足够时正文和输入区的原位置与宽度保持。`SessionPage` 按会话区域实测宽度判断自动停靠：达到1560px（28px基础留白＋844px居中列＋两侧各344px卡片空间）才展开，保证正文及输入区不因自动开卡缩窄或偏移；新对话同样按此条件，未达到时默认关闭，手动打开使用浮层。卡片关闭／浮层时的基础安全区沿 `--conversation-inline-padding` 随窗口使用28／20／12px，与无环境卡的准备页一致，不因卡片挂载恢复成固定28px。停靠栏因宽度不足收起时恢复 `default` 偏好，拉宽后自动停靠；显式 `closed` 保持关闭，窄窗仍可手动打开浮层。原滚动条和动画保持。完整目录、准确停止、只读子详情和草稿往返归 [Desktop owner](../../apps/desktop/README.md#native-当前会话环境信息与子详情)，UI 不取得新执行或读取 authority。

2026-10-25，Windows x64／Bun1.4.3，`b31d05415` 加本次环境卡阈值修改：`bun test ./packages/ui/test/isolated/desktop-sidebar.test.tsx` 整文件9项／332断言通过，核新对话冷挂载、1559／1560px边界、晚到内容、手动浮层、关闭记忆及缩放恢复。UI／Desktop类型检查与定向Biome通过。Chrome155隔离夹具加载实际NativeDesktop／SessionPage和生产编译CSS，深浅主题逐步观察1440px默认关闭、手动开合、1920px自动停靠、缩窄再恢复及500px窄窗；921帧中卡片始终一份，手动开合时740px输入区位置及宽度保持，草稿保留，窄窗无横向溢出，浏览器零异常。夹具使用模拟桥接数据，未重验真实首条消息创建或完整安装版Electron；保留原嵌套关键帧编译提示。

自动权限审核的当前投影读取 `authorization.check`，展示状态使用 `checking`／`auto_checking`／`queued_auto_check`；旧 `authorization.review` 及其历史展示状态仅兼容读取。TUI 与 Desktop 的实际子 Agent 均沿通用类别和相同消息组件展示，`review` 类别不建立独立 Agent 引擎。自动权限审核和标题内部 Model 不进入子 Agent 投影、数量或步骤；目录边界来自 Core 的实际记录，不依靠 UI 隐藏。权限证明与原子派发仍归 Agent，UI 不从状态授予执行权。

原 [Approval](src/desktop/Approval.tsx)经 `InteractionCard.renderApproval` 接入宿主，保留“批准一次”、拒绝和分体范围菜单；只有实际 `same_command` grant 才显示“本次会话批准”，辅助文字明确仅本次及本会话相同命令。工具类型与单行省略的等宽正文分层，悬停／聚焦沿现有 Radix Tooltip 展示全文，详情入口退役。[ApprovalHeader](src/desktop/ApprovalHeader.tsx)承载右上逐项分页、紧跟标题的子名称及固定彩色图标，主 Agent 不显示名称；图标仅按宿主交付的准确随机 Session identity 稳定分配，不依赖可改名称或渲染次数。`embedded` 去除重复标题和外框，独立按钮、grant 与 disabled 语义保持。slot 只接原卡、disabled、原完整附件正文与已获准的回答回调；紧凑模式自动读取并核对原完整附件，失败可重试，未验证时没有回答回调，换卡即失效。MCP／问题／计划仍沿独立表单。ToolActivity 的 `submitted`／`unavailable`／`cancelled` 与 `dispatchCommitted` 只表达宿主确认的审批和派发事实，不把批准当工具成功；准确来源、accepted decision 和原提交链归 [Desktop owner](../../apps/desktop/README.md#原审批面板与授权观察)。

[QueuedMessages](src/desktop/QueuedMessages.tsx)由 Composer 的可选 `queue` 接入，在同一外框顶部显示受控 pending 条目。真实 Markdown 经原 [MessageContent](src/desktop/MessageContent.tsx)安全解析；预览将块元素压为单行并省略，Tooltip 展示完整 Markdown，保持禁 HTML／远程图片获取的原合同。无序号或额外业务状态串；可折叠，常显手柄、编辑和删除。原生拖拽及手柄 Alt+↑／↓只交付当前完整 ID 排列，拖拽中成员变化拒绝旧操作；所有内容移除、变更和异步状态均由宿主确认，不维护乐观副本。`editable:false` 仅禁编辑，附件等条目保删除和调序。编辑成功后的普通 `draft` 仍由宿主 `onChange` 管理，`queueFocusKey` 只在同 scope 变更后聚焦并移 caret 至末尾，暂时 disabled 等待解锁，换 scope 不抢焦点；没有编辑模式或取消／恢复逻辑。[队列 DOM](test/isolated/desktop-queued-messages.test.tsx)核委托回调、完整 MD、Tooltip／Escape、折叠、迟到拖拽隔离、pending门禁与聚焦，服务撤回和未知结果归 [Native owner](../../apps/desktop/README.md#原运行中消息队列)。

Conversation 在调用宿主 `renderMessage` 之前统一排除 thinking、timing、terminal 内容以及宿主明确标为 `presentation:hidden` 的非工具消息；隐藏项不占消息行，也不拆分相邻工具。工具仍按原规则保留真实失败、取消与结果未知。只有结构标记的准确 Turn 保留一个原顺序锚点和静态状态行，不产生空折叠控件；有可读正文或工具的 Turn 沿用原分组，隐藏思考不会打断相邻工具聚合。已确认终态的原 Turn 不因遗留 incomplete 前缀继续标记忙碌，其他活动 Turn 仍保持实际状态。过程 Collapsible 以原 Turn 的 process／complete 阅读 key 区分生命周期，终态重分组直接进入关闭状态，避免旧过程在退出动画中与最终回复同时重绘；手动展开与收起保留原动画，工具展开选择仍由 Conversation 阅读状态保存。所有连续工具在同一 Turn 内聚合，不依赖只读／Shell 分类；可读消息或不同 Turn 分隔分组。逐消息的宿主 `renderMessage` 仍逐项调用，不将原记录吞成首项。单条工具详情与工具聚合使用独立阅读 key；宿主提供 `presentationGroupId` 时，第一项即以 `aggregate` 聚合壳呈现，后续新增、回执替换和 metadata 补齐不换 DOM 或阅读开关。缺省聚合身份回退首项`presentationKey ?? id`，逐项开关与React key也优先使用宿主的稳定`presentationKey`，阅读缓存保留仍存在的展示身份别名；原消息ID仍交给正文reader及业务回调，不从展示身份取得权限。聚合默认收起，后续增加工具和状态更新保留用户选择。标题按实际动作去重组合，如“编辑文件读取文件运行命令”，直接拼接动作，不加“了”或顿号，不显示工具总项数；标题后不追加任何文本，各项仍保留原审批、运行、等待与异常事实，缺状态不推断成功，重新评估不计完成；不切换到最后工具的名称／路径。聚合通过`--tool-aggregate-max-height`统一限制整体最高400px，32px标题以外的列表最多368px并在内部滚动，聚合内列表项之间不再额外留纵向间距；长异常详情的滚动区随总高收缩、保留全文，列表及长详情支持键盘聚焦滚动。聚合、工具详情、差异、Shell 输出及子过程的纵向滚动到达边界时继续传给外层阅读区，无溢出时直接由外层滚动；横向滚动仍限制在原区域。上述阅读区显式启用公共 `ScrollArea.chainScroll`：仅在目标及内层均无法沿当前方向继续时，以非 passive wheel listener 将纵向增量交给最近可滚动祖先，并阻止重复原生滚动；内层仍可滚动、横向／Shift手势、缩放和不可取消事件保留原处理，卸载或停用时移除监听。边界、嵌套、行／页单位与清理由[滚动回归](test/isolated/desktop-file-diff-scroll.test.tsx)验证。执行失败或审批未通过的工具均通过逐项展开显示完整原因，工具行和聚合标题不附错误预览；成功读取保留原文件操作。组内保留文件行、修改差异、Shell、问答和未知工具的各自阅读；聚合本身不重复挂载各项 reader。ToolActivity 的 `renderItem` 只替换组内单项，原组壳和开关仍由组件管理，让宿主把未核实原记录保留在独立的逐项展开内；缺已识别 toolName 时不把原始 text 作为收起的错误预览，实际状态仍显示。[聚合 DOM 回归](test/isolated/desktop-tool-aggregation.test.tsx)核活动聚合、单项升级、手动选择与后续更新。[思考轮次回归](test/desktop-reasoning-turns.test.tsx)核宿主不接收原思考、无正文终态／耗时／原用户顺序、无空控件与工具聚合。

2026-10-25，聚合高度与错误披露调整后，共享聚合和页面两整文件33项／489断言通过，核标题无任何状态或数量追加、失败与审批原因只在对应项展开、完整错误各段保留、收起后隐藏及重开恢复、成功文件操作和问答阅读，以及失败Shell终态只给一个输出流时保留另一个既有输出流；UI／Desktop类型、定向Biome与文档检查通过。生产CSS下450px总高、内部键盘滚动、完整长错误阅读及开合全过程归[Desktop owner](../../apps/desktop/README.md#原工具过程与结果阅读)的本轮浏览器证据。以下状态计数记录只描述调整前的原版本。

2026-10-25，macOS arm64／Bun1.4.2，`bfdb6a273` 加本次连续聚合工作树：工具聚合、共享页面、思考轮次、阅读缓存、阅读滚动与轮次回复六个相关文件共61项通过；DOM隔离文件按原环境各自执行，避免测试全局清理干扰后续文件的ResizeObserver。UI／Desktop typecheck和定向Biome通过。新增回归覆盖首项稳定壳、混合工具、可读消息／Turn边界、真实状态计数与共享task组内准确导航。生产CSS和Native回执交接的浏览器过程证据归 [Desktop owner](../../apps/desktop/README.md#原工具过程与结果阅读)。

宿主明确交付 `Message.inputKind:input.steer` 及 `turnId` 的用户引导属于原 Turn 的过程，沿同一 MessageItem／Markdown／附件与复制入口渲染；多条引导和前后工具／说明保持输入顺序，不新增处理段。可读轮次与结构锚点使用相同归组判断，只有引导及隐藏结构标记时也保一段过程。准确本地 sending 占位沿同一归属接管，failed／unknown 保原独立恢复展示；缺少类别或 Turn 身份的用户消息不推断为引导。终态后随原“用时”折叠，展开、阅读恢复和冷挂载保留完整正文，原最终回复与耗时仍各一份。

## 公共表单与观察

设置动作图标由 [SettingsActionIcon](src/desktop/SettingsActionIcon.tsx)统一使用共享图标库；[DropdownMenu](src/desktop/components/ui/dropdown-menu.tsx)公开普通菜单项和分隔线，Content 可指定 Portal container，使设置内的菜单留在所属 Dialog 的焦点及 Escape 边界内。宿主决定菜单内容与业务资格，公共组件不建立连接或授权。

普通问题共用中立的 [原 schema 解析器](src/question.ts)。DOM [Questionnaire](src/questionnaire.tsx) 为完整可表达的标量或浅 object 提供单选、闭合自由输入与多步骤；可以先浏览未回答的题目，最终明确点击提交时才发送完整答案。原字段和 choice 值、Unicode codepoint 长度与非空白约束保持；仅闭合浅 object 加明确 null alternative 的根 oneOf 可作为整份问卷的另一项决定，其他未知或重叠约束仍回退原 JSON。选项标题和完整说明在可用宽度内同行或换行，单选通过 `aria-describedby` 引用说明。题头的原问题给单选组提供无障碍名称。题号按原字段校验标记已答或待答，翻页后聚焦题目并重置卡片内部滚动。鼠标点选“自定义输入”进入文本框，原生单选的键盘方向键仍留在选项组内。题号、翻页和最终提交各有独立按钮身份，避免浏览器将导航解释为提交。

问卷与主输入同时显示时，底部区域保持 [Composer](src/desktop/Composer.tsx) 可用，并按会话高度预留阅读空间。超高的选项正文与问卷区域均可滚动。宿主可保持输入框可编辑并暂停发送，当前任务可停止时使用同一个按钮提供停止操作。带选项且允许自由回答的题目在最后显示“自定义输入”，该项沿原 schema 提交自由回答。

结构化问题的可作答卡片使用共享选择行、推荐标记、紧凑说明按钮和同一操作栏；已知 `Cancel answering` 展示为“取消回答”，原 null 值保持。可作答卡不显示 kind/state、原请求或执行身份，原文和 choice 值仍用于提交与恢复；只读卡及 JSON fallback 保留原材料。对应样式由 [Desktop CSS](src/desktop/style.css)提供，深浅主题与窄窗共用。

`InteractionCard.initialQuestionDraft/onQuestionDraftChange` 与 `ActionInputForm.initialDraft/onDraftChange` 将草稿生命周期交给实际宿主，既覆盖步骤也覆盖原 JSON fallback。`questionDraftKey` 固定 Store、source/presentation Session、Interaction ID、revision 与 inputDigest，不以连接 generation 另建草稿。组件自身不从 Promise resolve、卡片缺席或状态查询推导保存成功；Native 宿主按原准确回执清理。只读卡仍显示原完整请求与身份，缺回调没有作答入口。[DOM 验证](test/questionnaire-dom.test.tsx)核完整原值、空白拒绝、翻页零提交和重复抑制；实际 Native 窗口与页面生命周期由 [Desktop owner](../../apps/desktop/README.md#native-普通问题与页面草稿)维护。

`@kite-ai/ui` 是新 Client 的基础共享展示库，依赖 React 与 `@kite-ai/client`；不拥有执行、连接准入、存储或服务器实现。正式 Terminal 已消费[独立 TUI 入口](src/tui/README.md)，普通问题的原 schema 步骤与答案范围由该 owner 维护；完整客户端能力与发行资格仍按各客户端证据核对，权限保持其手册定义。

[PublicViewCard](src/index.tsx) 消费生成的 PublicView，展示摘要、content type/version、完整 JSON payload、附件引用和宿主显式提供的动作回调。未知内容与版本仍保留原始公开对象，缺少专用 renderer 不隐藏结果；没有回调时动作禁用。连接状态由宿主提供，组件不从没有更新推导执行终态。

[ActionInputForm](src/index.tsx) 只维护当前草稿，提交给宿主提供的回调。不允许额外字段的简单 object schema 支持 string、number、integer、boolean 与字符串 enum；嵌套、引用、复杂组合或未知约束明确使用原始 JSON。UI 不替代 Service 的完整 schema 校验和授权。命令 ID、目标 Store 和重试由宿主与 Client 契约决定，不由表单自动生成。

ActionInputForm、Questionnaire及方案审核的文本、数值、JSON和枚举字段使用公共Input／Textarea／SelectField，提交、翻页、取消与信息操作使用公共Button；单选与复选保留原生语义及明确确认。审批、上下文、完整消息读取、图表源码切换和子任务详情同样复用公共按钮，组件仍只调用原宿主回调，提交门禁、准确身份、失败草稿与结果未知处理保持。

验证：`bun run --cwd packages/ui typecheck`、`build`、`test`。测试核对纯输入投影、数值精度、复杂 schema 退化与未知内容保留；完整 Web/Desktop 产品入口、浏览器交互和原生制品验收仍由对应阶段核对。

P3 的 `InteractionCard` 直接消费生成的 Interaction：真实来源 Session、根回答 Session、祖先关系、Run/Execution、定义版本、输入摘要、策略版本、requiredRefs、准确原请求和决定版本分别保留。审批缺省发送 `grant:approve_once`；只有原 `request.grants` 实际包含 `same_command` 时才提供“本 Session 相同命令”独立选项，发送 `grant:same_command`。所选范围作用于真实来源 Session，展示根不改写批准 scope。deny 不携带 grant；question 按实际 `request.schema` 使用基础字段/内部 enum ID，复杂或未提供 schema 明确退化为原始 JSON。没有回答回调时只读；plan_review 展示已有实际记录，有限信息答复按下文契约处理，不提供虚构计划执行或完成状态。回答面板分别显示 saved/submitting/command accepted/unknown/failed，command accepted 不等于 Core 已接受 decision 或执行已成功。

表单同步阻止同一 render 中重复提交，失败保留草稿和请求。验证包括纯 React element 投影（不是浏览器 DOM/键盘验收）、schema 函数和配套薄客户端真实 HTTP 链路；正式 Web/Electron/TUI 入口和可访问性端到端资格尚未由这些测试建立。

便携 Context 切片提供 `ContextPanel`：显示准确 selection、范围、消息及两个独立分页游标、结果 source ID、原 Execution/revision/Store 与 automatic/explicit 来源。历史 Job 的 `suppressed/context_rewound` 明确表示被当前选择隔离，原执行效果仍保留；缺少原 Store 字段时显示出处 unavailable，不补当前 Store。Rewind 提交精确消息 ID/seq 或显式空边界，最终完整消息/Tool 配对边界由 Service 校验；Include 保存原结果来源，不重放执行或自行开始 Run。没有写入回调时没有操作入口；Rewind 在活动/未核实执行时禁用。Include 可在准确 active Run 上显示目标并封存原 Store/Session/selection/Run envelope；缺出处、revision 或准确 Run 时禁用，idle include 不带目标 Run。读取固定选择与上界的下一页是独立只读回调。

`ContextSubmissionNotice` 显示原 command 与 saved/submitting/queued/applied/unknown/failed 事实；保存来源不等于模型已读取或执行成功。queued 明确等待原 checkpoint，尚未纳入；applied 仍不证明模型正确使用。Context UI 同时包含纯投影与 [test/context-active-dom.test.tsx](test/context-active-dom.test.tsx) 的实际 JSdom 点击、目标准确性和缺目标禁用验证；不声称原生浏览器或正式客户端迁移完成。


有限 `plan_review` 答复只在请求提供 planId/version/digest/content 时开启，提供批准此计划、补充修改和拒绝三个显式决定；答案仅含 kind/decision 与可选 feedback，不接受 allowedModes 或 answer.mode。手动、Auto、Full 都等待用户明确答复，计划批准不切换权限模式、不授予后续工具执行权，也不证明执行或完成。旧格式请求只读显示完整原文，不转换为新批准。反馈最多 8192 个 JavaScript 字符串单位，原空格、Unicode 与换行保留；空 Enter 和未明确选择不会默认批准。 默认 Planning 工具在用户拒绝后保存简短拒绝结果并停止当前轮次；该行为来自工具的业务控制，不由面板把通用信息卡的 deny 解释为取消。

`PlanReviewDraft` 与 `initialPlanDraft/onPlanDraftChange` 让宿主以原 Interaction 身份保存原反馈。表单事件同步通知宿主，同一 render 重复提交受原锁约束；失败不清理，Promise resolve 也不冒充准确 accepted 回执。完整 canonical `plan_document` 的 ID/version/digest 与原 request 相符时，以安全 Markdown 展示完整正文和步骤；陌生格式保留完整原文。大附件仍先沿原 reader 完整验证，未完成读取时不提供答复，原完整附件另可展开核对。[实际 DOM 测试](test/isolated/plan-review-dom.test.tsx)核原草稿恢复、纯业务决定、空 Enter 不批准、一次提交与失败保留；宿主的页面生命周期、Main 读取证明和真实窗口资格归 [Desktop owner](../../apps/desktop/README.md#native-计划入口与完整审核)，组件不取得 I/O 或批准权。


`InteractionCard` 的 `onReadAttachment` 是可选宿主回调，只接受原公开 reference 的准确 Store、Session、scope 和元数据。大审批附件在完整读取、SHA-256 与严格 UTF-8 校验成功后展示全文；缺 reader、加载中或失败时保留原卡并禁用回答。取消读取、替换卡片、切换身份或卸载只释放视图等待，迟到正文不能成为另一卡的已读证明。组件仅在当前视图保存正文，重复键盘/点击同步抑制，不把正文存入控制器验证集合。无附件的原审批行为保持不变。

[test/attachments-dom.test.tsx](test/attachments-dom.test.tsx) 使用实际 ReactDOM/createRoot 和 JSDOM KeyboardEvent 验证 Enter 提交、重复抑制、缺 reader/错误正文、迟到身份响应；另以真实 Service/SQLite/ArtifactStore 的超过 17 MiB Auto 人工附件核对完整 DOM 正文再提交原审批。该测试建立便携组件的 DOM/键盘证据，不代表正式 Electron/TUI、真实浏览器布局或完整可访问性资格。


`SafeMessageMarkdown` 使用 react-markdown 与 GFM 渲染完整原正文的标题、段落、列表、代码、引用与表格。原 HTML 转义为文字；图片只显示 alt，不请求资源；相对文件与不安全 scheme 链接只显示文本。HTTP(S) 链接需用户主动打开并隔离 opener。组件只接受正文，不拥有网络、Token、编辑器或阅读缓存，正文宽度由宿主消息列决定。

[test/markdown.test.tsx](test/markdown.test.tsx) 验证上述安全边界、标准结构与完整长正文。Web 的 DOM 阅读测试另覆盖会话选择范围与位置恢复；这些不构成原生浏览器布局、选区或滚动资格。

`PermissionPanel` 只消费公开 mode/trust 事实，新模式仅提供请求批准（`accept_edits`）、自动审核（`auto`）、完全访问（`full`），与以后会话默认值分别确认；当前与默认模式继续显示原始事实；旧 raw `ask` 已从类型、输入和显示路径退役，不作兼容映射；信任前展示 actual readScopes 和原范围摘要，用户须明确核对。子会话或无 callback 时只读，未决/未知提交禁写；一份观察只提交一次，失败保留选项，不显示已应用。`PermissionSubmissionStatus` 将原 command 的已保存、提交中、已应用、未知和失败分别显示。新身份卸载旧面板，旧异步结果不能覆盖新卡；组件不持有凭据、服务器、文件或执行控制。

[test/isolated/permissions-dom.test.tsx](test/isolated/permissions-dom.test.tsx) 使用实际 ReactDOM/JSDOM，验证 Enter/空格键选择、重复键盘/点击抑制、模式/default、未确认 trust 禁用、原读取范围、子会话只读、失败草稿及迟到身份响应；正式 Electron/TUI 与真实浏览器布局仍未由本证据建立。

`ModelOutputMessage` 消费公开 `Message.outputBody`，默认明确显示有限预览，不把预览声称为完整输出。宿主可提供 `onRead({sessionId,executionId,signal})`；该 reader 必须先通过公共 Client 的完整 EOF、SHA、UTF-8 与正文验证，再返回 `ModelOutputSnapshot`。组件复核原 Store、Session、Run、Execution、完整性与正文长度；缺省只在当前视图保存已读全文。显式关闭、`suspended`、身份／预览更新或实际卸载会 abort 所属读取并清除全文，迟到结果不能显示。可选 `onClose` 只通知用户明确关闭全文，使宿主能够单独撤销复制展示资格，不把临时读取暂停的 `onContent(undefined)` 混同为关闭；原通知、读取取消和身份校验不变。宿主 KeepAlive 停用时仍 abort 原 lease，但可保留同一已核实身份的显示；可选 `readActive=false` 撤销新读取与正文通知，重新激活后用当前回调恢复，不从保留状态取得操作资格。临时 `readActive=false` 以 `aria-disabled` 和读取 handler 的 gate 暂停动作，保留按钮外观；缺 reader 时预览仍可读，全文按钮禁用；失败不展示半正文。原完整 Tool calls 需用户展开，不完整前缀不显示完整调用。原 reasoning 缺省不展示；只有明确诊断宿主设置 `showReasoning` 才提供展开入口，普通会话阅读不启用。

`onContent` 只通知当前准入视图已显示的完整正文，回到预览、停用或 `readActive=false` 时通知 `undefined`，供宿主准确复制；组件不拥有网络关闭或 Runtime 取消。[Model output DOM 测试](test/model-output.test.tsx) 验证超过 17 MiB 的完整尾部、显式读取、single flight、关闭/身份变化/隐藏的 abort 与 late 隔离、缺 reader、身份冲突和不完整前缀。它建立 React/JSDOM 证据，不代表真实浏览器、Electron 或 TUI 资格。

未完成、无origin且尚无工具调用的当前原Message，其有界历史摘要可以落后于同原Model的完整GET。组件仅对同Store／Session／Run／Execution、旧预览仍为正文前缀、UTF8字节不倒退且确有追加／完成的已核快照接受前进；已有complete、封存origin或已有calls继续精确匹配。未完成快照不得携工具调用，真正改写、缩短、身份、SHA、EOF、UTF8及传输错误仍拒绝；未完成提示依实际已读snapshot，不借旧摘要制造瞬时失败。Native Main再独立核同一边界，renderer不能供应前进许可。当前DOM21项275断言及Native9项123断言和两workspace类型通过，真实窗口修后过程归Desktop owner，见[正文前进决定](../../.agents/notes/implemented/bug-fix/2026-10-29-live-model-output-projection.md)。

普通 Native／Web 聊天启用共享 `autoRead`：在当前可读视图内自动沿原 reader 获取已保存完整正文，不显示“回复预览”“完整回复”标题、查看／收起按钮或原始工具调用详情。流式正文与尚未核实的预览原位保留，完整读取及 Store／Session／Run／Execution／字节验证通过后才交付全文复制资格；暂停、切换与晚回包仍受原门禁约束。“回复未完成”须由当前身份已核实的终态snapshot与不完整输出共同支持；planned／dispatching／running的流式前缀和读取中间状态不插入此提示，避免首段出现后再移除提示造成上下跳动。failed／cancelled／outcome_unknown及已终止但输出仍不完整的记录保留该提示。读取失败保留原文和错误说明；缺省不显示重试按钮，Native 沿用缺省。Web 显式启用 `autoReadRetry` 后才提供“重新读取”，仅沿原 reader 和原身份重新核验；暂停时仍受 `readActive`／`suspended` 门禁约束。不自动重复读取、更换身份或重新提交任务；无 reader 或不支持格式时保留必要不可用说明。专用 reader 不启用此选项时继续保留显式打开／关闭及原门禁，原 reasoning 仍只供明确诊断宿主查看。

当最后一次全文读取仍为running、随后取消／失败且正文未增加时，Native／Web以`modelOutputTerminalObserved`核准确Model或原所属Run的终态，向自动reader提供`terminalObserved`。这只是一次重新核验的提示，不授予正文、复制或未完成警告资格；Model不在有界View时可用已有准确Run事实，缺失或其他来源不推断终态。旧非终态读取的lease被撤销，迟到响应受原代次隔离；同一正文身份只完成一次终态刷新，失败不轮询，暂停中断的刷新可在恢复准入后继续。提示仍须由新读取并校验通过的终态snapshot产生。

2026-10-25，Linux x64／Bun1.4.3，`3dc3a941f`加审查修复工作树：上述生命周期缺口先由共享reader与实际WebPage的onRead路径回归复现，再核取消时正文／DOM身份不变、Model缺席时原Run终态接管、迟到隔离、暂停恢复、身份冲突与零重复GET。验证沿原[Model output DOM](test/model-output.test.tsx)及[Web页面](../../apps/web/test/page.test.tsx)，不代表真实浏览器绘制或安装版Electron资格。

宿主已经完成公共 Client 的 EOF／SHA／UTF-8 验证时，可直接提供 `verifiedSnapshot`，组件仍核同一 Store／Session／Run／Execution、complete、正文／reasoning字节数和toolCalls，再呈现原正文或已保存的未完成前缀。关闭后可本地重开，不重复下载；宿主替换 snapshot、暂停、身份替换和卸载均撤销旧读取。该 prop 不接受未验证 transport 数据，也不赋予组件网络或执行权。

Native 主会话启用 [ConversationTrace](src/desktop/ConversationTrace.tsx)，共享 Trace 的折叠根、标题和内容。宿主提供准确的轮次、流式正文、公开思考来源和工具事实。相邻的思考和工具复用同一标题与阅读 key，首条工具可以直接展开其结果，后来加入的步骤保持各自的阅读状态。工具标题复用 `ToolActivity` 的图标映射，思考行始终使用思考图标，多步工具摘要使用流程图标。展开后的 `TraceLine` 共用行内缩进、图标宽度和图文间距。首次展开前不构造步骤内容；整条思维链与思考正文随会话滚动，单项工具沿各自输出组件处理溢出。[Native 工具回归](../../apps/desktop/test/isolated/native-live-tool-aggregation-dom.test.tsx)覆盖并行顺序、元数据延迟和回执接管。

桌面 `SessionPage` 的[阅读状态缓存](src/desktop/reading-state.ts)只保存滚动与展开数据，最多32项、256KiB估算载荷、每项512个展开ID；保存时裁剪当前消息中已不存在的展开项。`Conversation`一次建立各轮运行工具和thinking集合，避免每轮重扫全部消息。缺省切换仍卸载原消息DOM和effect；Native 通过可选 `conversationCache` 启用下述有界停用树，不保活全部会话；[阅读缓存回归](test/desktop-reading-state.test.ts)核容量、淘汰和裁剪。恢复时，各级折叠用 `data-restored-expanded` 跳过自己的展开动画；后续手动开合清除本层恢复标记。[轮次回归](test/desktop-reasoning-turns.test.tsx)与[Native 往返回归](../../apps/desktop/test/isolated/native-history-presentation-dom.test.tsx)核恢复和手动选择。

[ConversationCache](src/desktop/ConversationCache.tsx)为最近8个非当前会话保留原 portal 容器、组件状态与 DOM，停用容器脱离可见文档，Activity 统一清理 effect。CacheHost作为portal之前的React sibling先接入活动容器，恢复后代layout时容器已经连接文档，不用attached状态再次提交整棵可见树；原viewport与嵌套滚动在同次恢复中保留。DOM 与宿主登记的媒体估算合计总预算16MiB／20,000节点，单项8MiB／10,000节点，超过预算先淘汰最近最少使用项；活动超长正文不裁剪，离开后可释放。新 scope 清全部，revision 清非当前项，实际失效由宿主定义。[成本owner](src/desktop/conversation-cache-cost.ts)在后台任务中每片至多统计1024节点，结构／文字变化才失效；属性及已完整计量的等成本叶文字替换不重算。分片期间任何结构变化都重启，避免旧walker沿脱离的节点提前结束；准入前取走未投递的Mutation记录，并核同一revision。切换与layout只读取已确认成本，不执行DOM预算扫描；尚未计量、已失效或超预算的页面离开时释放DOM，消息数据和阅读状态仍由原宿主管理。媒体登记／移除即时更新成本，隐藏媒体释放不强制全部页面重扫。命中项在新数据未就绪时先显示原树，fieldset的 `aria-disabled` 和事件捕获隔离旧操作，保留原透明度与悬停命中，不用原生 `disabled` 或 `inert` 改变整树外观；`readActive` 与当前本地展开的 `interactive` 分开，显示不成为读取权限。恢复的展开和 Markdown 节点沿原组件保留；容器捕获嵌套区域的实际 scroll 位置并在重新接入的 layout 阶段恢复，丢弃已移除节点，不覆盖 Conversation 自有 viewport 的跟随／手动策略。计时在临时不可读时冻结已有文字。缓存资源通过 `useConversationResourceRetention` 登记给 Activity 外的 entry owner，停用时保留已核验资源，真正移除、淘汰或 scope 失效时释放；窗口隐藏统一释放媒体。资源仍计入原体积预算，不声称限制解码后的像素、完整 snapshot 或总 heap。重新接入的首个绘制周期暂时取消后代过渡，随后恢复正常交互动画；复制反馈停用时清计时器，恢复时按原到期时间继续，不能由迟到的剪贴板答复改写。纯 UI 不导入 Native／Runtime；[缓存 DOM 回归](test/isolated/desktop-conversation-cache.test.tsx)覆盖节点身份、原 textarea／表格状态、8项LRU、条数／体积／节点预算、未变提交与切换零同步扫描及100轮 effect 清理，[成本回归](test/isolated/conversation-cache-cost.test.ts)核真实失效、分片重启、资源计账与取消，[全文回归](test/model-output.test.tsx)核 Activity 停用后原全文 DOM、lease abort及late隔离。详见[取舍](../../.agents/notes/implemented/architecture/2026-10-19-native-conversation-dom-cache.md)。

`Sidebar` 在空间、空间标题和单条会话分别使用默认memo；标题仅接收实际展示字段和当前操作，行接收原SessionSummary、选中布尔值和导航回调。选中变化只更新旧、新两行，真实摘要、回调替换和授权撤销照常更新；排序、分页、展开和键盘导航仍由原空间owner管理。[侧栏渲染回归](test/isolated/desktop-sidebar-render.test.tsx)核实际render／字段读取次数和原节点、状态、键盘与最新／撤销回调。

`SessionPage` 的薄入口持有原 `useSessionTabs`；会话scope改变时，标签页原有状态重置只重跑该入口，页面内容组件保持同一挂载位置。浏览器关闭、child读取与最后标签页收栏仍走原生命周期，避免为性能改写标签页所有权。

`Conversation` 将消息分组与 entry JSX 投影按原消息、Turn、renderer、展开状态和恢复标记复用；缓存 resume／读取资格变化不重复构造未变正文，叶组件仍通过原 Context 立即更新操作门禁。已提交投影另保留当前实际挂载并展开的轮次过程ID，resume时补齐默认展开但未显式选择的活动轮次标记；只有缺失标记才重新投影，已标记页面反复返回仍命中原投影。`loading` 往返会刷新恢复标记，外层滚动、选择和 observer 生命周期仍独立执行。[投影回归](test/isolated/desktop-conversation-presentation.test.tsx)核40条原消息的 renderer 调用次数、真实消息／回调／Turn更新、普通及220条历史窗口中初始及后来新增的默认展开轮次在实际缓存往返后的原DOM与标记、重复恢复零重投影、手动开合和仅loading往返后的原阅读位置。

`Conversation` 可供主会话和当前子详情同时显示；Cmd／Ctrl+A 先按事件目标、焦点和已有选区选择唯一可见阅读区，避免两份 document 监听覆盖彼此，输入框和编辑器仍使用自身快捷键。[复制与选区回归](test/isolated/desktop-message-copy.test.tsx)覆盖两区同时显示、隐藏、输入和单区回退。宿主通过 `ConversationActivityContext` 提供当前读取资格，保留正文不会恢复复制或正文读取；子详情的已核事实和资格由 Native 管理。

`Conversation` 的消息区使用共享 [ScrollArea](src/desktop/components/ui/scroll-area.tsx)（shadcn／Radix），通过 viewportRef／viewportProps 保留原 region／ARIA、阅读位置、自动跟随与跳到最新。10px 轨道覆盖在右侧，不占标题栏宽度；正文预留同宽空间。同一个 ResizeObserver 观察 viewport 与 reading-column，正文内部读取、折叠动画或窗口变化引起高度更新时，在绘制前同步跟随，手动阅读时不改位置。真实多会话窗口曾保留13棵旧消息树，heap 引用链为 Document 动画 controller→RAF callback→旧 viewport，原因是 Radix 1.2.18 的 ScrollAreaThumb 滚动后立即卸载遗漏持续 RAF 清理。现在通过版本绑定的 [Bun 补丁](../../patches/@radix-ui%2Freact-scroll-area@1.2.18.patch)在该 effect 清理时取消轮询并清空引用，CJS／ESM 同步，其他消费者也获得同一清理修复，不修改全局 RAF。[滚动生命周期回归](test/isolated/desktop-conversation-scroll.test.tsx)在100轮中分别挂载真实 thumb、触发活动轮询、立即卸载，核零残留 RAF／ResizeObserver／keydown 监听，并核内部内容增高、跟随、手动位置与跳最新；测试按 isolated 约定单文件进程运行。实际窗口 DOM 与 heap 历史证据归 [Native owner](../../apps/desktop/README.md#native-当前会话环境信息与子详情)。

Desktop `MessageContent` 的固定 GFM＋公式 parser 复用[纯语法树缓存](src/desktop/markdown-parse-cache.ts)，最多32项、8MiB估算总量、单项2MiB，原文本 key 与树数据均计入。每次管线取得独立克隆，后续转换不能污染缓存；只保存语法数据，不持有 React、processor、文件回调或操作范围。超预算正文仍完整解析与显示，HTML、图片与链接安全门禁不变。[语法缓存回归](test/desktop-markdown-cache.test.tsx)核淘汰、污染隔离、安全GFM和超预算全文；真实窗口响应测量归[Native owner](../../apps/desktop/README.md#native-当前会话环境信息与子详情)。

纯子路径 `@kite-ai/ui/desktop/markdown` 公开 `parseDesktopMarkdown` 固定语法计算，compiled desktop build同时生成 `markdown-parser.js`，Worker不经UI组件barrel。`PreparedDesktopMarkdown` 是展示数据；`MessageContent.preparedMarkdown` 只在其原文与当前text准确相等时克隆该树，后续仍经过原react-markdown的HTML／图片／链接安全处理，错配回原parser；不接受树数据作为任何业务权限。`ModelOutputMessage.renderText` 的第二个可选参数只交当前复核通过的snapshot，既有单参数回调保持兼容。Native拥有Worker静态资产、纯实体decoder解析、调度、取消与活动树生命周期，UI compiled入口不内置Vite专用Worker路径；[prepared回归](test/desktop-markdown-cache.test.tsx)核准确原文、管线隔离、安全结构和超全局预算全文。

正文身份的序列化按原八项输入 memo：Store、restored-origin 资格、Session、Run、Message、originMessage、outputBody 与 content。相同身份的普通 render 不重复序列化完整正文，任一原字段变化仍触发原 identity 清理；callbacks 更新、suspension、abort、完整 snapshot 门禁和复制撤销不变。原完整 Model output DOM 文件6pass／40断言通过，源码 token 核对仅新增 memo wrapper 与 import；当前完整 Native 历史窗口资格仍归 Desktop owner 和[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

只有独立核实原 Model Store 的宿主 reader 才能提供 `canReadRestoredOrigin`，允许当前连接 Store 与封存出处不同；Native 先核 Main 已观察 Message 的原 Execution／Session／Run／originStoreId，再验证完整正文。组件仍核 snapshot 的当前 Store 与原来源身份；资格变化使旧正文失效，不授予网络或执行权限。缺省保持原限制，Web 未提供此资格。上述 DOM 核已获资格的原正文显示与关闭后 `onContent(undefined)`；实际安装／恢复范围由[Native owner](../../apps/desktop/README.md#恢复后封存-model-正文)负责。

[test/interaction-grants-dom.test.tsx](test/interaction-grants-dom.test.tsx) 使用真实 ReactDOM/JSDOM 验证一次默认值、显式同命令按钮/键盘、原 child/卡片版本保留、未知原回答意图禁用、只读以及 plan/question 不提供该授权。组件只提交原答案字段，不保存本地授权缓存、不将 accepted 回执当成派发成功；持久授权与 clear 最终核对由 Service/Core 负责。DOM 证据不等于正式 Electron/TUI 或原生浏览器资格。

`ModelInputs` 已从 Web 调用者抽到 [共享输入检查器](src/model-input.tsx)，公开 `ModelInputPort` 仅包含原 Store/capability 身份、有限目录页与准确原 Execution 读取。`initialExecutionId` 从 Runtime logs 定位原记录时只打开敏感内容确认页，不自动读取正文。调用者或 scope 改变即使不重新挂载组件，也清除已读正文并 abort 本视图读取，迟到结果不重绑新身份；原数据确认和 actual metadata 行为保留。Web 实际 DOM 组合为 8 项、73 条断言，公共 Client 输入/输出 verifier 组合为 11 项、99 条断言；Native 输入/输出共用 main 单正文 lease。上述证据没有授予 UI 运行或网络关闭权限。

`PermissionGrantsPanel` 只显示公开授权目录的实际 Session、原 Store、epoch、definition/kind、Interaction 决策版本、原 Execution 与输入/命令摘要，不展示原命令正文、不缓存执行许可。清除前必须明确核对观察到的 Session/epoch，callback 固定原 observation；未知/在途意图禁止另一次写入，但其他会话仍可只读查询。无 callback 或无法核实目录时只读，子会话目录不从根会话模式推造。并发 epoch 变化由真实 Core CAS 拒绝，不静默重试。[授权目录 DOM 测试](test/permission-grants-dom.test.tsx) 使用实际 ReactDOM/JSDOM 键盘验证一次提交、重复抑制、只读与旧结果不覆盖替换身份；真实窗口/HTTP 清除证据由 [Desktop owner](../../apps/desktop/README.md)负责。

独立 [终端消费者](src/tui/README.md) 从 `@kite-ai/ui/tui` 导出 Ink 组件与固定原身份的 port/controller，终端正文与 DOM 分开渲染。当前正式 Terminal 已消费此入口，提供会话选择、原 active Run 输入、原卡回答、精确取消及 MCP 目录/启停、来源决定、连接/强制重连、条目增删与HTTP认证的独立原申请；完整主屏、全部手册面板与跨平台资格仍按实际证据核对。

恢复后 Context 的明确 Include 同样由[终端 owner](src/tui/README.md)维护：当前 snapshot/view 准入与原结果出处分别核对，新申请保准确 selection/revision/活动目标，idle 保存来源后仍须用户明确新任务；实际 Ink/HTTP 恢复证据不替代 installed 终端或整体退出资格。

共享 `ModelOutputMessage` 的 Fork 正文读取使用公开 sealed `Message.originMessage` 原 Session/Run，复核准确 Store/Execution；foreign Store 不发正文 GET，未来 `contentFormat` 或 `outputBody.readAvailability:unsupported` 保留预览并禁用完整读取。该新增作用域路径由共享 DOM 5 项、31 个断言以及实际 HTTP Fork 17 MiB 1 项、38 个断言验证，不据此声明全量 Fork/平台产品已收束。独立 TUI 同样保留原 Session/Run/Execution 来源；恢复到新 Store 后由宿主公共 Core reader证明原出处，controller核当前准入 Store及完整消息摘要，不把 Fork的新身份冒充原输出。实际 Ctrl+O 完整读取与已加载导出范围由[TUI owner](src/tui/README.md)维护。

通用 TUI `Ctrl+B` 使用宿主完整分页的 pending 目录选择独立卡，打开时冻结原 Store/来源 Session/展示 Session/cardId/revision，刷新变更不把原行指向后来卡。每卡分别保留答案草稿与明确 grant 选择，revision 变化清旧草稿；已完整读取的附件按相同身份保留，提交另核公共完整 review reference 的原 identity，不能借用另一张卡或旧正文。Session 切换与未知答复仍走原 controller 查询，不重发。选择器不提供父批准替代 child/Job 许可。

TUI 的附件快捷键和 Controller reader 都要求当前原卡存在实际附件信封；无附件的普通问题收到 Ctrl+A 时保留步骤与草稿，不调用宿主附件接口。有附件的问题仍须完成原范围正文核实后才能答复，具体接线与验证见 [TUI owner](src/tui/README.md)。

普通问卷的自定义输入在首行向上／末行向下时可继续选择其他选项，文本内部仍按视觉行编辑；返回时保留原草稿，方向键与 Tab 都不提交答案。纯输入题保持原光标行为，具体实现及键盘回归同见 TUI owner。

TUI Markdown 根布局约束实际正文列宽，普通及流式回复的长段落在列内换行，续行保持左缩进；原正文、完整读取与导出保持原值。布局与实际终端验证见 [TUI owner](src/tui/README.md)。

普通 TUI 的 Thinking 只使用指示器自身留位，与回复正文同列；消息容器不再重复为 Thought 添加回复缩进，活动、结束及工具步骤的布局归上述 TUI owner。

[真实四卡 PTY](test/isolated/tui/pending-cards.test.ts) 在 owned Core/Service SQLite、80×24 中同时保持两个 sibling Ask Tool、root question 和独立 `required-verifier` ordinary Job，按 root-first/job-first 顺序分别批准。真实 parent/child intersection 70KB policy 的完整 artifact 由公共 SDK reader 核 hash/原 scope，缓存切换不重复读取；首 POST 与首原 GET 回应物理丢失后只查原 answer Command，实际两 child 效果与 Job 各一次。该 configured ordinary Job 的通用审批能力保留；Skill Workflow 执行及其专用夹具已移除。revision 清理和迟到选择由 Ink 反例核对，不代表同四卡窗口内实际改变后端 policy 的资格。


开发 TUI 的 `/rewind` 现在通过有限 `TuiFileRecoveryPort` 读取实际 Files 恢复点、预览与原两 leg，支持仅会话/仅代码/两者；它不持 profile、文件或热 POST permit。普通审批、已确认 Code 后的明确 Fork 继续、unknown 原 GET 与关闭/切会话的迟到隔离见 [TUI owner](src/tui/README.md)。实际编译 PTY、强杀与丢回执证据归 [CLI host owner](../../apps/cli/README.md#files-三范围恢复-caller)，不据此宣称正式旧入口、Native 或所有平台已完成切换。


[MCP Source Review](src/mcp-source-review.tsx)只接受准确来源批准或既有opaque Ref binding的问题：闭合原schema/choices/read-set与安全身份，显示完整原请求，提交准确decision。非法或未来Source request保只读，不退化为任意JSON答复；同定义产生的普通approval仍保独立Approve once，不能因definitionId被误当Source question。[实际DOM测试](test/mcp-source-review.test.tsx)核Source答复和普通审批分离；正式Native窗口与Main再次核原答案的证据归[Desktop owner](../../apps/desktop/README.md#native-mcp-完整设置)。


[completeRunReplies](src/run-reply-copy.ts)是两个正式宿主共用的纯回复资格与正文投影；宿主交准确原 Run、完整已读 Message 和当前 verified full-content callback。它以准确 completed／inactive 及完整最终回复核资格；Web 使用 `copyScope=run` 按严格 Decimal64 顺序合并同 Session／同 Run 的未封存助手正文，以空行连接。Native 显式 `copyScope=final` 保桌面手册只复制完整最终回复、不含同轮工具前说明的合同。两者均不加入 Tool 参数、结果、reasoning、其他 Run 或子消息；各自复制范围内非零 body-backed 段均须由宿主当前 reader 提供完整正文，缺失／不完整／未来格式不拿预览补齐。该 leaf 没有 I/O、cache、剪贴板或新 authority；[纯契约](test/run-reply-copy.test.ts)与两个宿主的实际消费分别证明选择和读取边界。

桌面 [ToolActivity](src/desktop/ToolActivity.tsx)消费宿主已核实的 `decisionRefresh/not_executed`，在各工具行区分正常未派发的重新评估与真实执行失败，完整异常原因仅在该项展开后显示，聚合标题不附状态计数；该状态不由原正文或通用错误字符串推断。[桌面契约](test/desktop-page.test.tsx)与 [Native 实际 Main→transcript→组件](../../apps/desktop/test/isolated/native-tool-messages-dom.test.tsx)验证混合状态，缺少派发证据不隐藏失败。

共享 [completeRunReplies](src/run-reply-copy.ts)仅对准确 completed 且非 active 的 Run 建立最终回复资格，排除带原压缩身份的 assistant 消息；Native 最终复制与 Web 整轮复制均不包含压缩摘要。完整模型消息仍可能是候选或维护输出，不能先于真实 Run 完成显示为最终结果。回归见[最终回复复制](test/run-reply-copy.test.ts)与[Native 实际链路](../../apps/desktop/test/isolated/native-transcript-dom.test.tsx)。

桌面 [Conversation](src/desktop/Conversation.tsx)的压缩状态使用普通 `Marker`，按工具消息标题的字号、行高和上下留白左对齐显示，不绘制文字两侧的分隔线；进行中扫光、失败颜色和具体错误说明保留。

宿主可以为临时压缩行与对应持久消息提供相同 `presentationKey`，使原 MessageGroup 在状态接管时保留 DOM。它仅是渲染身份，真实消息、来源、正文读取和复制仍使用 `id`；每次压缩须独立标识，跨 Store／Session／Run 不复用。实际热进度与持久事实合并和回归归 [Native owner](../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。

## 选中与重连的后端状态核实

[TuiController](src/tui/controller.ts) 的明确 `select` 默认先等待宿主可选 `reconcileSession` port，再读历史。普通刷新由 `refresh` 读取[事件影响的部分](src/tui/observation.ts)，等待在途激活并合并同范围的后续事件。执行状态与操作准入分别更新，只有当前执行与准入读数均新鲜时才恢复写操作。切换会话或断线会撤销旧读取资格，迟到结果不能接管当前会话。失败时保留可读历史并后台重读，写入与 capability 核验归 [CLI Host](../../apps/cli/README.md)。[选择器](test/tui/session-chooser.test.tsx)和[观察回归](test/tui/observation.test.tsx)覆盖激活、断线、迟到结果及读写顺序。桌面持久终态优先于 `executionUnconfirmed` 回退，后端恢复归[Core owner](../agent/src/storage/sqlite/run-resume.README.md#会话恢复时的状态核实)。

TUI `/skills` 仅查看普通 Skill 知识目录；不再提供 Workflow 资格、激活按钮或动态 Skill 执行命令。刷新、详情和读取取消保留，MCP prompt 命令继续由独立目录提供。实现与键盘回归见 [Skills panel](src/tui/skills-panel.tsx) 和 [目录测试](test/tui/skills.test.tsx)。

Native宿主可给`useSessionTabs`提供只读保留页恢复回调：恢复期间不分配新Tab，3秒超时或失败保持明确未核实并只由用户重查；A-B-A旧回复也不覆盖新状态。没有标签时显示“正在核对保留页面…”，已有标签因新的恢复key再次核实时继续原读取和分配门禁，但不向现有标签内容前插入正常流提示，避免推移已保留浏览器的工具栏与视口；真实恢复失败仍显示错误和原重查入口。[真实组件回归](test/isolated/desktop-session-tabs.test.tsx)通过held恢复请求核读取次数、pending门禁、原Tab／toolbar／viewport节点及布局子节点保持，并保留新reading scope的首次等待和真实失败断言；该DOM证据不代证Native像素。恢复不导航或取消Job，关闭旧UI只通知宿主隐藏/关闭，由Main租约决定保留。当前入口归[SessionTabs](src/desktop/SessionTabs.tsx)，跨层mock与实机资格归[Native候选](../../apps/desktop/README.md#普通页面控制租约候选2026-10-27未发布)。

保留的[SessionPage](src/desktop/SessionPage.tsx)切换tabs scope时，在layout阶段取消旧右栏RAF／timer，按目标已确认的右栏意图直接布局；loading／browserPending／restore未决时不把空tabs当作用户关闭。导航与右栏分别持有动画状态和timer，右栏动画只属于原scope，普通手动开合保持动画。自动reveal与已有页请求在layout阶段采用；reveal去重只限当前scope的一次激活，返回原scope可重新接纳，而用户显式收起的记忆仍保留。任务编辑器退休不再另排一次无目标的collapse，由当前右栏意图统一决定。上述[回归](test/isolated/desktop-session-page-render.test.tsx)通过受控RAF和真实Group／Panel核提交前收栏、旧动作取消、未决原页恢复、目标详情、显式关闭和独立导航动画；原生连续画面与灰带限制仍归Desktop owner。

标题栏重开保留的浏览器标签、请求已有网页，与首次空白标签、子会话及普通详情统一使用180ms缓出动画。同scope从真实折叠状态打开时，首个render即带上过渡标记，避免启用的分隔线重新注册、Group先于RAF重建布局而跳过动画；layout阶段提交打开意图，并沿现有240ms计时保留标记。实际折叠状态读取Panel handle，不能使用可能迟于布局的React通知状态。scope切换、恢复与明确直接布局继续沿原逻辑；尚未开始的收起被取消时保持原宽度，不另播动画。[回归](test/isolated/desktop-session-page-render.test.tsx)覆盖收起未执行、进行中及动画结束后的重开，已有页请求和普通详情的首个提交、旧回调取消、原页节点与输入保持。实际Page／文档是否可暖恢复仍由Desktop Main核实，UI标签存在不授显示或Agent能力；真实Electron连续画面及限制归[Desktop owner](../../apps/desktop/README.md#固定-renderer-布局收敛2026-11-02)。

统一审批展示由冻结 `options/optionId` 驱动；`Approval` 保留仅此次主按钮与范围菜单，菜单原文换行显示完整资源和限制。共享普通卡和 TUI 复用 Client 只读选项投影，不按工具名产生后续范围。TUI 默认选择原 once，选中的长说明完整换行；授权目录组件可查看原范围、真实 bindings 与审批出处；普通 Native 权限菜单不再提供该目录入口。历史工具状态使用后端保存的 `optionKind/presentation` 显示批准范围，不从 opaque optionId 推断。

输入框底栏左侧为附件和权限入口（图标与名称，不带展开箭头），其中 accept_edits 显示“工作区内修改”，右侧同一行排列上下文圆环、模型选择器及发送／停止按钮；同会话刷新只撤销操作资格，权限、模型与附件弹层保留打开状态和原节点；切换会话或输入区被交互接管时关闭。权限Full确认仍绑定准确原范围，过期确认不能继续。权限点击与确认门禁保持。桌面公共按钮、表单、下拉选项、开关、滑块和Tab，以及模型／权限入口、问答选项和定时任务星期选择不再按禁用状态降低透明度或显示禁用光标；权限提交期间输入节点、草稿与工具栏透明度保持。原JS请求锁、pending检查、原生禁用语义及权限／读取门禁继续阻止重复操作，不引入延时防抖。 [隔离浏览器验证](../../apps/desktop/test/session-shell-browser-runner.fixture.ts)的 `--permission-stability` 覆盖深浅主题和500／1440px窗口，挂起真实Native组件的权限提交后逐帧核对输入节点、草稿、可见性、文字颜色与透明度，释放后核恢复。2026-11-09 Windows／Chrome156在公共禁用样式清理后，深浅主题表单、开关及500／1440px权限等待共10组通过；权限过程72帧同时核输入和整排按钮透明度，截图与报告归本机 `.cache/session-shell-browser-Fy2PbG` 和 `.cache/disabled-visual-stability-20261109.json`。Native定向等待／未知恢复2项及UI权限23项通过；桥接回执为隔离替身，不代证真实Service权限写入。`SessionPage` 在新对话准备时通过 `Composer.hideContextWhenUnavailable` 隐藏没有 `contextUsage` 的圆环与浮层；实际用量（包括0）出现后恢复，已有会话的加载和未知状态保持。会话正文与工具消息沿 `--conversation-text-size: 14px` 统一字号。`Composer.inputPlaceholder` 独立提供占位提示，未提供时沿 `inputLabel`；Native 会话使用“输入新的想法”。

提示词文字区域左右内边距为16px、上方为8px，底部工具栏沿原内边距排列。

上下文总量按1024换算为大写K／M显示，例如262144 tokens显示为256K；上下文估算数量也采用相同换算，比例计算和无障碍描述保留原始token数。

### 文件差异的按需与有界显示

共享 [ToolActivity](src/desktop/ToolActivity.tsx)允许宿主对已确认的文件变更提供 `renderFileChange`，只在该工具展开时挂载，聚合内沿同一槽传递；不为失败／未知工具建立成功diff。[FileDiff](src/desktop/FileChanges.tsx)默认双栏，可切换统一视图，使用真实行号、轻量语法色、低饱和增删底色与空侧纹理；[模型](src/desktop/file-diff-model.ts)只解析原操作预览或标准Git patch，不读磁盘、不重建缺失内容。操作上下文未提供旧侧行号时留空，未知格式保留原文。计数明确为预览增删，不能当作整个文件或仓库统计；已保留的连续上下文可折叠／展开，后端省略的行明确不可展开。

解析最多64 KiB／400行，每行最多2048个UTF-16单元，裁剪保持代理对。轻量词法着色每行最多48个着色token、整份最多1024个着色token，另有每行纯文本回退；双栏复用模型且最多生成2048个着色span；长行或预算用尽时回退纯文本，不加载异步语言包。切换布局和折叠不重读正文，一个ScrollArea同时滚动两侧，保留Home／End交接；不为每行建立滚动器。`layout/onLayoutChange`可由宿主管理，文件切换清除旧折叠，宿主可保留当前视图布局选择。[独立样式](src/desktop/file-diff.css)由style.css导入，正式UI构建同时复制该文件。

原SessionPage中的宿主变更工作区允许右栏扩至85%，首次可见变更页按62%准备阅读宽度；同scope后续选择、刷新和重开保留用户宽度，用户先自行调整时不再覆盖，关闭／切scope／覆盖会取消未执行的尺寸操作。这些最小／最大尺寸属于共享右栏，因此同宿主中的浏览器和子页沿用该范围；62%的首次尺寸准备只针对变更页，不主动调整其他页。没有宿主变更内容的浏览器右栏仍为300px／640px约束。[布局回归](test/isolated/desktop-changes-layout.test.tsx)、[解析回归](test/desktop-file-diff-model.test.ts)和[差异滚动回归](test/isolated/desktop-file-diff-scroll.test.tsx)分别负责宿主布局、有限模型与阅读交接。历史来源、Git状态、取消及实际窗口资格归[Desktop owner](../../apps/desktop/README.md#原文件变更面板与编辑器)。

## 执行轨迹展示

[分型指标与计时](src/desktop/trajectory/DetailMetrics.tsx)只取准确所选Model事件的显式usage和实际模型名，0值保留，合计不补算；请求指标与选项只属于独立圆点详情的概述／选项／用量／计时，普通思考仅正文及准确历史尝试选择。思考采用轻背景、强调线和14px前景文字，阅读宽度约76ch，长思考局部展开，不恢复输出跳转或来源编号。计时核原member与所选sequence截止，不把重连退避的逻辑总span当单次请求，缺界／倒序／跨来源保未知，不制造TTFT、生成时长或吞吐量。通用Tool／Job显示自己的执行记录区间；Run只列直接范围逻辑摘要，不借子执行时长。

[结果呈现](src/desktop/trajectory/TrajectoryResult.tsx)按有限typed种类列核心字段与公开正文，次要操作／版本／回执标志折叠。Shell突出目标状态／退出码，观察成功不代替命令成功；Task分受理／工作／交付，选择旧观察时概述也按当前截止过滤原事件。压缩容量主信息明示本地估算，未采用不造效果。异常／未知的独有公开诊断主区域可读，仅与同一typed正文逐字相同才去重；明确空正文不借其他fallback，MCP的null／false／0保留，Browser元素目录不吞掉附带公开文本。文件、Web、计划、工作树、技能、问答及正式媒体保持原准确材料边界，不重取当前文件或网页。

[附件视图](src/desktop/trajectory/TrajectoryAttachments.tsx)只将获准的原ModelMessage.images四格式闭合base64内容转为data:图片；描述性消息附件只列name／mediaType／size，精确Decimal64大小含0，保顺序和重复，不从URI／路径或当前文件反推图片。畸形列表、非法格式与浏览器解码失败有独立说明，换准确图片不保旧失败。仅附件消息无空正文Accordion，正常原文／用户JSON／空白保留。系统／输入预览均使用该组件，日志结构不依赖加载后图片结果。

[操作内容](src/desktop/trajectory/TrajectoryOperationContent.tsx)只从准确子Agent的prompt／taskName／preset展示委派信息，参数JSON继续完整保留；压缩context的selection只读原消息boundarySeq／tailFromSeq／ranges，明确为消息序号而非事件游标。压缩metadata实测基线与估算分量按需可读，不混摘要请求usage。[交互内容](src/desktop/trajectory/TrajectoryInteraction.tsx)只消费闭合公开问题／选项与原答案，按原id匹配，不用邻近工具参数或当前schema补题目；取消只取原事实，不能由null答复推断。

[输出存在性规则](src/desktop/trajectory/output-presence.ts)仅消费同一 verified 原 Store／Session／Execution、准确事件与引用版本的第一方 `outputPresence`，不按已加载正文增删行。成功且完整的工具调用独占输出精简其虚拟输出与 canonical assistant Message，原 byId／target 仍保留；生成中准确无正文的前缀由思考承载进度，有正文、完整空输出、失败／取消／未知及旧缺字段分别保留。纯空白正文不删。重连前有正文或未知输出继续显示“历史输出”并提供原尝试选择，思考正文页直接呈现公开思考，不放“查看该次公开输出”跳转按钮或材料来源编号；回复与历史输出仍从对应行进入。被精简的 Message 同步退出回复统计、过滤匹配与消息时间轴，原逻辑 Agent 处理仍计一次。

日志行身份与结构只由事实／展示设置决定，材料读取仅更新固定38px行内文案；原读取取消和迟到拒绝不变。[事实阅读锚点](src/desktop/trajectory/fact-anchor.ts)只在同源向前新事实、展示控制未变时以原行ID及行内偏移恢复位置；原行被 canonical 消息接管时可回其思考代表。主动seek、返回最新、搜索与折叠不被自动纠正。输出状态与DOM回归见[存在性反例](test/trajectory-output-presence.test.ts)及[原树过程](test/isolated/desktop-trajectory-tree.test.tsx)，生产编译连续过程归Desktop owner。

主干按[Agent loop展示](src/desktop/trajectory/loops.ts)表达：原Run就是唯一Agent loop，不再给内部每次模型请求另加loop。Run下普通阶段平铺，主Model包装presentationHidden但仍保byId与准确材料，presentationRepresentativeId映射思考；originalParentId保平铺前逻辑父级，原tree与operation.members保完整原关系，仅child carrier与child Run显示层级。自动重连不加loop或主行；Run.loopPhase只取原Run生命周期，requestPhase另核原请求和Tool回执，后台Job不拖住已经返回的launch。归并到旧Shell行的后续read仍按其原父模型归属对应原模型请求。底层model／Tool／Job和生命周期不合并，系统／本次请求上下文／思考／输出行只是准确材料切片，不计逻辑调用或时间轴标记；独立消息事实优先去重，旧缺消息身份时不推断当前用户或补造消息事件。

[实机分类与顺序](src/desktop/trajectory/loops.ts)使用原写事务封存的Model `display.operation=review` 识别无独立Command事实的自动审批检查，仍须准确Tool／Job父、原Store／Session及verified身份；旧缺证明不猜。准确canonical回复的阶段呈现锚最多提前到该回复首观察，确保系统准备／思考先于回复，原材料版本与真实Tool／child顺序不变。子Agent有同一原Job可用终态结果时，默认预览省较早或同事件附带的进度检查点；显式历史观察仍保原材料。新记录提示位于固定高度顶部工具栏，不增列表前布局块；未显式返回最新不刷新游标。

[业务树过滤](src/desktop/trajectory/tree.ts)为准确无Run的审批检查Model派生`approvalCheck`：要求已验证同Store／Session的`authorization.check`原Command与准确commandId、已验证原父Tool／Job，缺证明不猜。Workbench将其归approval并保留一条“自动审批检查”，不生成Agent虚拟阶段；原检查请求／规则／结果仍按原ref读取，真实Interaction仍独立。默认仅省略双方completed／succeeded、同Store／Session／Run、准确父链、第一方封存display与已知definition/version共同核实的`git.worktree→shell.command`、`browser.open→browser.session`、`browser.execute→browser.code_session`支撑Job；异常、运行中、child或缺证明一律保留，all_events与原byId／member不裁剪。重连不跨业务category归并。边界由[降噪纯回归](test/trajectory-auxiliary-presentation.test.ts)覆盖默认／全量、异常、缺证明、旧材料与同文独立消息。没有任一准确材料的system／input／reply不造空壳，thinking始终作为原Model选择代表；任一旧attempt有材料时仍留原入口。

阶段详情沿[纯Tab与材料规则](src/desktop/trajectory/workbench-details.ts)：系统准备为system_prompt／tools，只归类原请求的system角色，移除developer兼容判断和专用标签，输入与回复为content，思考仅为thinking（旧request_info归一化到thinking），真实Tool为overview／parameters／result，轮次为overview／preview；所有节点均移除raw入口，内部Model包装不显示为独立阶段。不合法旧Tab回该阶段首项；tools只看当次public request.tools的id／description／完整inputSchema，不以内部assembly目录替代。request_info保持同attempt的准确输入／输出截止，不重铺其他阶段正文；参数和结果权限不因此扩大。系统提示词单Accordion调整经原树DOM32项1270断言及材料／详情24项384断言通过；新构建完整Electron候选中唯一条目标题为“系统提示词”，收起与重开恢复原文、切换工具Tab保原4项目录，连续89帧日志几何保持，Tab client／scroll均38px；本机证据`.cache/trajectory-desktop-live-4Bq6OE/system-single-accordion-review.json`，多system正文保序由原DOM夹具覆盖。工具目录使用本地名称／说明搜索与紧凑行，520px目录容器以上同行、较窄时双行；左侧chevron／工具图标、等宽名称与次要摘要分层，展开才挂载完整说明和Schema JSON。搜索不增加Evidence读取且保留同材料已展开状态；换原event／ref／contentVersion仍重置。各类型详情不再显示来源sequence／sourceIds、来源组及来源计数，也不再重复展示Tab正文上方的caption标题；原模型输入与事件完整保留，完整版本保父材料section的title及原材料键；系统指令合为一个默认展开的无边框Radix Accordion，原system消息正文和图片按原顺序保留，不再生成编号折叠项；请求用户上下文和消息正文仍以multiple独立开合、首条默认开，其余关闭，按event／ref／version的父key切换重建且开合不新增Evidence读取。思考、工具目录、工具参数／结果、审批和压缩继续沿各类型结构，不机械再套一层；输入阶段以“本次请求上下文”标明历史范围，不再重复冗长免责声明。审批检查预览只列检查内容、结果和按需规则，有公开检查思考时保按需展开，零工具与空思考不另占组。 无原问题的旧问答若明确保存answers为空对象，仍显示“已保存的答复”及原空对象；有原问题时逐题保留未答状态，不把缺失答复补为空对象。提交前定向交互9项66断言通过。

列表[材料摘录](src/desktop/trajectory/loop-materials.ts)只消费当前可见最多四个原模型请求的准确model_input／output，系统提示词、用户上下文、公开reasoning与输出可直接定位阅读，不预读所有历史。新事实真实模型名优先step.display，旧数据沿当次已读metadata.adapter.provider回退；内部request.modelId不冒充名称，缺值明确提示。概述去父级／内部绑定字段，思考直接可见；压缩仍只公开摘要。当前视口和详情分别管理读取，选择、切片、折叠与取消保留原版本边界。输入详情与列表摘录共用`trajectoryRequestUserMessages`：仅准确完整、verified_origin的model_input且metadata.context装配版本／顺序匹配时，按当次sources中准确Session的session-files与准确Run的`builtin.planning:runtime:<runId>`来源，仅省略其最后一次单来源user项；不按JSON正文或全局sourceId裁剪，历史复制和用户粘贴保留。部分／截断、旧身份、缺metadata或顺序不明保持原内容。空白正文仅无images／toolCalls时省略，图片与工具请求提示仍展示；原request、事件和Evidence不变，摘录保持惰性有界读取。

[统计纯函数](src/desktop/trajectory/stats.ts)为每个Run提供统一`row.summary`，供轮次详情及准确child内部摘要使用；主列表的Run展开、折叠、筛选均不展示右侧统计或相同统计悬浮文案。原统计仍消费同一集合：`model/tool/child/approval/compression`分别表示重连归一的逻辑Agent处理、Shell观察归一的工具操作、子任务、审批和压缩，`actions`仅为这五项之和；`userMessages/assistantMessages`独立统计。范围按原Store／Session／Run key，排除虚拟切片、结构和辅助事件，不递归累计子Run；child载体只在准确子Session／Run与原Execution命名空间核实且已载入时附其内部summary，否则保持未知而非0。筛选改变命中小计，八种展开组合与子scope加载不改变主Run统计。摘要不代表原网络attempt或实际Tool请求数，成员与attempt仍完整保留供原详情核对。

系统准备提示由`loopSystemPreparations`仅比较同一真实Run内紧邻的两个逻辑请求，材料必须是当前已准入、准确版本且完整available的`model_input`；只比较原system指令与public tools，不把其他上下文相同当成准备相同。完全相同显示“沿用系统准备”，确认不同显示“系统准备已更新”；材料缺失、部分／截断或超比较预算不分类。当前比较不预读历史、不留正文或指纹cache；行继续占38px，准确快照详情入口及原owner／ref不变。

本轮按用户确认的[逻辑操作决定](../../.agents/notes/implemented/feature/2026-11-09-trajectory-semantic-operations.md)维护当前展示；[原工作台布局](../../.agents/notes/implemented/feature/2026-11-08-trajectory-workbench.md)与[分型详情](../../.agents/notes/implemented/feature/2026-11-08-trajectory-node-details.md)中仍适用的入口、材料和历史边界保留。本机连续过程与交付资格由Desktop owner记录。

[SessionTabs](src/desktop/SessionTabs.tsx)在右侧栏“新标签页”的“工具”区提供“执行轨迹”，每会话scope只有一个轨迹标签，与浏览器、变更等共用原8项容量；已打开时复选回到原页。`SessionPage.renderTrajectory`与`trajectoryTabRequest`沿原右侧栏交接，不新增对话／轨迹主区域切换或第二份同会话reader。对话位置、草稿和待处理交互继续由原会话owner保持。

[TrajectoryPanel](src/desktop/trajectory/TrajectoryPanel.tsx)展示执行概览、独立时长坐标切换、筛选菜单、元数据搜索和按需详情。顶部不再提供轮次／调用／子调用三个全局展开按钮，轮次与子Agent保留可折叠容器和局部箭头；历史expansion与局部覆盖仍按原状态读取，普通阶段没有层级箭头。筛选菜单仅六种类型，“工具”与“子 Agent”分别控制普通操作和准确子任务载体；Panel将旧视图的duration／runKeys／subcalls归一化为all／null／all，不再提供对应入口或条件chip，Workbench底层过滤契约保留；`childAgents`缺省视为开启，保持旧视图兼容。筛选外子任务若承担命中内部日志祖先，仅保留上下文身份。父级不覆写后代偏好，默认不额外显示会话结构行、固定上界、事实覆盖泛化提示或上下文祖先数；事实覆盖状态随“轨迹信息”按需显示，真实读取错误与legacy缺失提示保持。匹配数量只在筛选生效时于日志头出现一次，执行概览不再重复；固定上界与当前cursor由“轨迹信息”按需查看。视觉沿确认原型采用轻量图标、右对齐搜索、彩色类型badge、细层级连接、原Run band、右侧观测时长／状态与蓝色选中行。日志行高38px，有界滚动与窗口化保持；全局顺序按逻辑操作首次`firstSequence`，不以DFS重排并行过程。宽容器详情初始40%，沿现有ResizablePanelGroup调宽；小于840px为同工作区覆盖式Sheet。关闭恢复原焦点且不为归焦重新滚动列表。详情Tablist使用39px外高／38px按钮与overflow-y:hidden，保留必要横向滚动；正文padding为8px 12px 14px，首材料无额外上边距。

行背景只由整行拥有，选择和折叠按钮的hover／active不另叠背景；覆盖详情使用主题分隔边框。Sheet开关与行归焦使用`preventScroll`，避免进入动画中的焦点目标推动祖先滚动；列表因并排／覆盖布局替换viewport时，在首次绘制前按原阅读锚点恢复实际滚动与窗口化位置。

[完整树](src/desktop/trajectory/tree.ts)继续拥有原Store／Session身份、父子、独立重试、消息聚合和全部来源ID。[逻辑操作归并](src/desktop/trajectory/operations.ts)在其后合并准确重连链、Shell原启动／Job／观察、子任务载体及压缩生成／发布；稳定链首／原启动行保留全部member、attempt、observation及原ID别名，工具结果不会被观察成功覆写。相同名称或时间不能构成归并依据。折叠和计数只作用于逻辑行，不裁剪底层事件。[Workbench索引与过滤](src/desktop/trajectory/workbench.ts)按固定前缀建立安全索引，再由独立筛选与搜索AND过滤；同类多选OR、空集合法。默认业务范围及精确标题子树排除保持，辅助事件仅全量且五类全选时加入。命中祖先保留淡显，活动过滤临时展开路径，不改用户偏好。

[请求圆点](src/desktop/trajectory/request-markers.ts)从准确逻辑Model与可见阶段建立只读Map，优先以thinking为anchor但圆点位于其上沿节点间隙，不是阶段本身；缺thinking才退首可见切片。含准确Model的compression操作也在原操作行之前有边界，单纯context采纳／发布不造点，自动审批Model不混成对话请求。重连成员共享一点，不增行或tree层级。线只表示可核实同Run记录顺序，scope／业务省略／缺身份处断开，默认不可见辅助记录不造伪gap；Shell按原starter证明范围，不能据邻近请求迁移因果。每个内容节点仍按原顺序平铺。

[独立请求详情](src/desktop/trajectory/TrajectoryRequestDetails.tsx)使用`selectedRequestId`与`requestTab`选择准确owner和overview／options／usage／timing，普通node选择清请求模式；不借thinking节点承载四Tabs。概述取原Model的input/output、选项只取input、用量／计时不读正文；[选择规则](src/desktop/trajectory/request-details.ts)只接当前选定Model member及事件截止的原ref，不把压缩context／采纳材料或其他request混入。公开adapter／provider可用才显示配置，字段缺失不补零；Token直接取选中Model事件，计时用`trajectoryDetailTiming`核原边界，缺首Token／服务生成耗时不编造。结果优先准确可见原reply，历史输出须选原ref且有正文证明；canonical Message须核原Store／Session／Execution和观察截止，工具专用空输出不出空占位入口。关闭回原圆点并preventScroll，节点与请求的阅读状态分开；无新权限、数据版本或工具协议。普通思考仅保正文与准确历史内容选择，请求指标不再混入；旧request_info状态归首合法thinking Tab，不读取旧输入通道。[边界回归](test/trajectory-request-markers.test.ts)、[请求回归](test/trajectory-request-details.test.tsx)、[现有DOM](test/isolated/desktop-trajectory-tree.test.tsx)分别核纯边界、精确材料／计时和实际交互。浏览器证据归Desktop owner。

[子范围组合](src/desktop/trajectory/related.ts)只接收已经各自获准、与父cursor一致的子投影，核准确carrier／childSession／childRun和原Run命名空间；子展示ID命名空间化，原step与event不变。冲突、缺证明、未来与重复事实不任意拼接。在线scope读取和准确材料路由归Native；离线不借此取得联网资格。

[执行概览](src/desktop/trajectory/TrajectoryTimeline.tsx)按输入／回复、Agent、工具／子任务、压缩／审批四条命名泳道呈现刻度与网格，支持观测时间与事件顺序。Agent条保持模型请求跨度口径，含重连、不含工具执行；消息是记录时间点，确证区间为条，并行区间分轨。缺时域只用原sequence刻度，全量辅助原事件单独定位，不冒充业务调用。缺界、缺时、倒序与跨Store保持未知，消息不被当成调用时长。顺序轴等距不代表耗时，材料切片不增加标记，选中切片高亮所属loop。时间轴不移动cursor或扩展upper；只保留底部坐标模式标签，不常驻显示右侧区间解释，原标记计时语义不变。定位后按当前视口的有界规则读取材料。搜索仅用公开元数据，不为搜索预读正文或生成模型摘要。

[分型详情](src/desktop/trajectory/TrajectoryDetails.tsx)与[纯材料目标选择](src/desktop/trajectory/workbench-details.ts)按逻辑操作和原成员确定Tab：工具／Shell为概述／参数／结果，其他常规节点为概述／预览；消息仅使用内容。请求圆点及内容阶段可选原准确重连尝试；输入准备按原system／用户上下文／工具目录分组，不展示来源文案。Shell默认原启动参数和Job输出，附属观察按需选读，无Job输出只回退准确最近观察，不预读全部轮询。子任务的接纳、工作状态和交付分开。完整原事件和材料仍由底层保留，显式选择只读该观察材料。旧raw及其他不合法Tab回该节点首个合法Tab，归一化前不发起材料读取；没有通用生命周期区，筛选／折叠不改选或补未来材料。概述首屏仅保主要状态、耗时与适用业务信息，记录时间和计时范围收进默认关闭的“记录信息”；压缩保采用与容量变化首屏，阈值及计数口径收进“压缩信息”。按需展开信息不恢复raw或父级／内部绑定ID。

工具参数沿原`tool_input`材料呈现完整公开执行请求JSON，空对象、null、缺封存和不可读分别表达，不使用当前intent或邻近Model补历史。结果通过[共享只读结果视图](src/desktop/trajectory/TrajectoryResult.tsx)消费原定义／版本对应的typed公开DTO及通用文本／JSON回退，去掉执行、批准和重试动作；原Files差异、Shell预览／gap、图片与PDF页图不从今天的文件或网页重建。Shell renderer跳过空stdout／stderr标题块及无丢弃字节的非gap空分片，原非空空格、不同序号同文输出、gap、截断和状态保持；不借此改变typed材料覆盖与未知结果的原回退。模型、消息、Job、child和交互保持各自材料owner，不把接纳回执当关联任务完成。

自动压缩Model与发布Context按确证压缩／执行身份关联而不合并或重挂父子。概述只对已采用、同口径的原before／after计数展示减少量；调用usage单列，缺值不补0、不用Provider outputTokens推算摘要大小。Model默认当前前缀可引用已确证的采用状态；显式旧观察不会读到之后发布。摘要沿原Model公开输出读取；候选、部分输出与实际采用结果在概述与压缩预览中分别说明。

节点详情不再提供原始内容、规范事件JSON或公开字节查看入口；底层原记录与现有导出保持完整。阶段详情不开放私有reasoning、transport、授权或内部continuation。材料目标绑定原event/ref/contentVersion；实际open/read/close、主体与权限epoch、Blob/hash校验由Native owner处理。组件不读取文件、网络、Store或取得执行权限。

[TrajectoryViewState](src/desktop/trajectory/view-state.ts)只保存descriptor、cursor、筛选、坐标、展示行与独立请求选择、各自合法Tab、原观察、折叠、详情宽度／阅读锚点等纯值。行政行用稳定rowId区分同对象的多个原观察，nodeId仍指向原树owner。隐藏、换来源、seek、切观察／Tab或关闭详情释放材料；清除条件不重置原选择和阅读。精确来源与A→B→A迟到结果的门禁归[Desktop owner](../../apps/desktop/README.md#执行轨迹离线窗口与-trace-设置)。

旧格式`unknown/legacy_local`显示“旧记录 · 原sourceEventType”，现行未知来源独立标识；无时间、父关系、入参或正文时保留缺失，不重分类或追补。固定历史上界、新事实提示、显式返回最新以及仅事件／含获准Evidence导出保持原合同。

当前回归入口为[投影](../trajectory/test/projection.test.ts)、[树](test/trajectory-tree.test.ts)、[工作台](test/trajectory-workbench.test.ts)、[详情目标](test/trajectory-workbench-details.test.ts)、[状态](test/trajectory-view-state.test.ts)、[工作台DOM](test/isolated/desktop-trajectory-tree.test.tsx)和[Session标签](test/isolated/desktop-session-tabs.test.tsx)。本轮连续UI过程和实际验收范围统一归Desktop owner；下列2026-11-08记录是此前消息／树页面迭代证据，不授予本轮新布局、参数或typed结果资格。

同日消息上下文迭代，`e8a483d65`加本轮工作树、macOS arm64／Bun1.4.4：七个完整协议／投影／树／状态／reader／材料纯文件71项516断言，树DOM9项266断言，离线DOM9项74断言，Trace设置DOM4项33断言；真实Store／消息Evidence及相关输入、Fork、恢复材料回归93项1086断言，Trace consumer／host32项304断言，共218项2279断言通过。UI／Desktop／Trajectory／Agent／Client／Service类型、UI／Desktop／Trajectory构建、API生成、文档、边界和测试归属检查通过；定向Biome无错误，Runtime未变路径的optional-chain提示保持。真实Store反例另验证未知／损坏wrapper不能向后续消息传播未核实namespace。浏览器连续过程和边界归[Desktop owner](../../apps/desktop/README.md#执行轨迹离线窗口与-trace-设置)。

同日默认四类过滤迭代，macOS arm64／Bun1.4.4：六个完整协议／投影／树／状态／reader纯文件60项449断言、树DOM8项204断言、标签DOM30项401断言、离线DOM9项74断言、四个真实Store隔离文件26项268断言，共133项1396断言通过。覆盖精确标题子树排除、旧分类不猜测、10,000层父链、默认根匹配分页和未决读取期间切换全量保留所选工具／Tab。UI／Desktop／Trajectory及相关Agent／Client／Service类型通过，定向Biome、UI／Desktop／Trajectory构建、API生成核对、文档、边界和测试归属检查通过。受控浏览器全过程及资格边界归[Desktop owner](../../apps/desktop/README.md#执行轨迹离线窗口与-trace-设置)。

同日按用户确认的树与三个 Tab 改造后，`e8a483d65` 加本轮工作树、macOS arm64／Bun1.4.4：共享树、状态与协议／reader回归53项／302断言，完整标签 DOM 30项／401断言，树 DOM 6项／105断言，离线 DOM 9项／74断言，共98项／882断言通过。树 DOM 包含真实组件10,000层执行链的完整节点、原事件、真实父身份和层级；首次／重开读取未决时保持原 Tab，用加载占位替代根节点和零记录闪现，索引到达后恢复原选择与滚动。UI类型636文件、Desktop类型1,392文件通过；UI／Desktop构建、定向Biome、文档、API、边界和测试归属检查通过。实际编译Chrome156隔离页面的连续操作与范围归[Desktop owner](../../apps/desktop/README.md#执行轨迹离线窗口与-trace-设置)，不将旧列表布局的Native窗口画面作为本次树界面的像素验收。

2026-11-08，本机 macOS／Bun1.4.4，完整[标签页 DOM 回归](test/isolated/desktop-session-tabs.test.tsx)和[纯值状态回归](test/trajectory-view-state.test.ts)共31 pass／0 fail、406断言，UI类型633文件通过；UI build在本轮轨迹组件边界建立时通过，后续布局与游标修复复验上述DOM及类型。新增断言覆盖8项共享容量、唯一轨迹页、显隐／切scope释放、正式入口、旧游标不展示未来正文、Evidence原版本、超安全整数位置和卸载暂停。此为共享组件与JSDOM验证，完整Native窗口过程及安装／其他平台资格归[Desktop owner](../../apps/desktop/README.md)，不以DOM或最终画面代替。
