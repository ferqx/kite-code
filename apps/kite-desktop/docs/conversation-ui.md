# 两栏导航与会话阅读

产品操作见[桌面手册](../../../docs/handbook/clients/desktop/README.md)，后续目标见[界面与协作体验](../../../docs/plans/kite-client-experience.md)。Figma 的三个 Kite 页面用于空间、会话、消息与控制区的结构对照，当前视觉仍可迭代；原型数据不进入生产 renderer。

会话消息与可编辑输入启用原生文本选择，其他界面展示文字不参与选择。共享样式在应用根禁用选择，再为消息／输入开启；段落和列表项收缩到内容宽度并限制最大宽度，避免选区覆盖行尾空白。未增加双击处理或复制事件拦截。Ctrl+A／Cmd+A 明确以可见消息正文首尾为全选边界，输入框内只全选输入文字；正文列裁剪列外绘制，避免全选高亮扩展到布局空白。

## 组成与状态归属

[App](../src/App.tsx)是桌面数据与宿主适配入口，调用 Web 同时使用的 [SessionPage](../../../packages/kite-client-ui/src/SessionPage.tsx)。主页面、侧栏、会话阅读、输入区、Markdown 与基础控件和样式由[共享页面包](../../../packages/kite-client-ui/README.md)唯一维护。桌面入口提供当前已授权的任务操作、原生文件打开、信任与辅助面板，不在共享组件中判断运行平台。

macOS Electron 主窗口使用 `hiddenInset` 标题栏，renderer 延伸到窗口顶边且隐藏重复窗口标题。页面顶部是一个 52 px、横跨窗口的单行 header；原生交通灯定位为 x=13/y=19，header 内图标、标题和操作在 52 px 高度内垂直居中；移除旧宿主的向上偏移，展开态的 kite 标识从 x=80 开始。header 按 236 px 侧栏和会话区显示为不同背景：左段显示 kite 标识并把侧栏收起图标靠右放置，右段显示当前页面或会话标题及操作按钮；侧栏关闭后，右段先为交通灯保留 80 px，再显示展开图标。非交互 header 通过 CSS `-webkit-app-region: drag` 交给 Electron，按钮、输入和其他交互元素使用 `no-drag`；双击只调用具名 `toggleWindowMaximize` bridge。窗口底色与页面一致。该适配只存在于 Desktop 入口，不向共享页面导入宿主协议；拖拽、双击和快速缩放仍须真实 Electron 窗口验收。

`DesktopClient` 仍是 Runtime／App Control／History 适配 owner，由 `main.tsx` 持有，App 热更新复用该实例。Electron 宿主也会跨 renderer 热更新保留既有 Service 进程；只改 renderer 的页面刷新不会加载 Service 源码或 wire projection 变更，这类开发改动必须完整退出并重启应用后验证。完整页面刷新后的宿主自动重接与会话定位见[新对话与项目恢复](new-conversation.md#页面刷新与连接恢复)。UI 只保存折叠、草稿、阅读位置、展开项、编辑器选择和命令提交反馈。草稿与阅读状态以 `workspace + sessionId` 隔离，保留到进程结束；没有浏览器持久缓存或第二套 Run 状态。停止反馈绑定原会话和 runId，从提交开始到真实终态期间禁用重复停止和局部回答；失败显示错误，断线清除本地提交标记，重连不自动重发。

输入框在尚未打开项目、尚未选择会话及断开期间仍可聚焦和编辑；发送资格独立核对连接、信任、会话就绪与运行状态。[新对话准备页](new-conversation.md)与已创建会话共用“描述你想完成的工作”占位提示；准备页使用独立草稿，跨项目／分支选择保留，首次发送才创建会话；进入已有会话时不把准备草稿混入其输入。首次发送立即清空输入框并在内容区显示本地用户消息，“正在发送”作为气泡外的右对齐附注绝对定位，不增加消息高度；运行时投影到达后接管，确定失败则原位提示并恢复输入供重试，回执未知则保持“待确认”且不允许重复提交，直到新运行时事实或显式会话恢复完成。Agent 回复尚未结束时，正文下方以同样不占消息高度的左对齐附注显示“正在回复”，最终回复落定后移除。用户气泡和 Agent 正文的底部间距为 32 px，为连续轮次和复制操作留出更清晰的分隔；阅读列底部留出按钮空间，避免最后一条回复的悬停按钮被列裁剪。复制操作使用 Runtime 提供的稳定 `turnId`：每条已发送用户输入提供一个复制按钮；同一 turn 内由 `toolCallCount=0` 标记的最终 `model.responded` 正文提供一个复制按钮；若该标记缺失，成功的 turn 终态仅在最后一段 Agent 正文之后没有工具调用时补齐最终回复身份，复制内容只是该完整最终回复，不包含同轮工具前说明、思考、工具、子 Agent 或其他非最终文本。按钮为 `24×24`、零内边距的圆角正方形，鼠标移入该消息或按钮获得键盘焦点时才显示；按钮及其与消息之间的透明桥接区始终参与鼠标命中，仅视觉透明，因此移动到按钮时不会因丢失悬停而隐藏。发送状态未定、失败或流式回复不提供复制操作。已有会话仍按项目与会话隔离草稿。输入框上方不展示独立状态文字或预留状态行；运行与停止反馈由对应操作按钮和会话内容表达。本地服务连接管理属于内部逻辑，不提供重连或断开入口。草稿只保留在当前进程，不承诺重启恢复。

## 导航与历史

侧栏默认展开持久空间。桌面入口只提供工作台，共享层用现有目录中的运行状态组织“正在推进”和“最近会话”，不提供独立待处理入口、分组或筛选页；等待回答、审批或恢复的会话仍保留真实状态并进入最近会话。点击后仍由同一个会话选择 owner 读取历史；未提供的主题分类、完整后台实时状态和时间条件不由 UI 补造。目录分页、局部错误、跨空间阅读和实际发送时的项目切换见[历史与恢复](history-and-recovery.md)。点击会话或按 Enter 直接读取历史并切换订阅；方向键只移动列表焦点。

“工作台”下方的“安排任务”复用全局导航行与同一页面 shell；共享 UI 提供任务空态、任务卡片，并在点击创建后把表单放入页面最右侧的通用侧栏，桌面端只传入已打开项目。页面 shell 使用 shadcn Resizable 把左侧导航、中间页面与按需右栏组织为全客户端高度的同级栏，相邻边界均可拖拽调整宽度；右栏拥有自身 52 px 标题区，不嵌套在中间页面 body。当前 App Control／Runtime 没有定时任务的持久化、调度、运行历史或通知操作，因而不能保存表单，也不在 renderer 中建立本地任务真相；后续接入时必须由新的服务端 owner 提供任务事实与 mutation 回执。

新建任务右栏采用纵向紧凑表单：无边框标题、独立任务说明文本区、项目／运行环境分组、频率分组，以及固定在底部的取消与保存操作。表单正文自行滚动，不挤压标题或底部操作；没有对应服务事实的设备、通知和新聊天选项不从参考产品复制。左栏容器与内容区都占满客户端高度，拖拽分隔线为 1 px 实色边界，扩大的命中区不再以透明 padding 形成背景缝隙。

同一连接的 snapshot 更新已知目录行时保持顺序；连接、新建和所订阅运行结束时自动读取目录。每个空间默认读取完整会话目录，底层协议分批时由桌面 owner 自动读完，不提供手动“加载更早的会话”入口。刷新保留已有行的顺序；不早于目录 revision 的实时投影只更新生命周期、运行、交互和更新时间，目录继续拥有展示标题与 Workspace 元数据，避免会话加载完成后列表标题换源。侧栏不再提供独立“切换项目”、“断开项目”和刷新按钮；空间标题只折叠／展开，项目选择沿目标会话及新对话上下文栏完成。目录在模型和 Git 检查前展示；当前项目的实时投影更新目录中的实时状态，其他空间只读目录且不启动各自 Workspace context。没有后台全会话订阅，不将目录中的旧摘要表述为实时进度。当前 ready 会话再次进入不会重载；新选择继续使用原有 AbortController、订阅 generation 和 20 秒加载边界。加载历史时即使订阅已 ready 也不能发送，避免在历史未恢复时提交新轮次。

会话消息列表使用共享 shadcn ScrollArea 独立滚动，实际 viewport 继续拥有滚动监听、自动跟随与阅读位置；单条消息内部的代码、表格、命令输出和 diff 溢出仍由内容 owner 处理。首次进入显示最新消息；用户向上阅读后停止跟随，提供回到最新消息入口。流式正文、窗口缩放以及输入／交互区高度变化只在仍跟随时贴住底部；连续尺寸变化产生的滚动校正按 animation frame 合并，每帧最多读取和写入一次布局。切换会话保存 scrollTop、跟随意图和工具／子代理展开项，回到该会话时，缓存命中即恢复，未命中则在完整历史加载后恢复；后台校准不改变会话组件 identity。缓存状态与验证见[历史 owner](history-and-recovery.md#会话正文缓存与校准)。

未缓存历史加载时保留同一个消息滚动容器及其尺寸，正文列暂时为空，中央覆盖 48 px 无底色、低对比度风筝图标，并以透明度与阴影做不改变几何尺寸的轻微闪光；系统要求减少动态效果时显示静态图标。加载层通过 `aria-busy`／状态标签保留无障碍加载语义，不插入可见加载文案。完成后移除覆盖层并直接提交正文 DOM，避免加载提示参与正文流造成布局抖动。已有缓存正文的后台校准不覆盖正文。

## 消息与交互

思考及普通工具到非最终正文统一使用 8 px 间距，到最终回复为 16 px，思考 `pre` 底部外距为 0；展示文本用 `trimEnd()` 去除末尾空白，原消息数据不变，内部换行保留。思考父容器用 flow-root 包含内部边距，统一由父容器承担 8 px 外距，内部活动外距为 0；展开和收起使用相同衔接间距。2026-09-16 浏览器使用真实组件与隔离消息实测：展开思考、收起思考、普通 task 工具到非最终正文均为 8 px；共享 UI 45 项测试通过。Figma 工具当前不可用，本轮未同步。

工具标题展开后使用与 hover 相同的主文字色，标题图标、文件名和箭头继承高亮；文件 diff 通过所属箭头的 `aria-expanded`，工具和思考摘要通过共享 Collapsible 的 `aria-expanded` 驱动。摘要及工具步骤使用共享 Marker，收起恢复辅助色，不增加背景或间距。

消息间距由共享样式统一维护：用户／助手最终回复后 32 px，助手非最终正文后 8 px（按 Runtime `finalReply` 区分），工具或思考记录到下一段非最终正文 8 px、最终回复 16 px，工具活动外距 8 px。2026-09-15 使用真实共享组件与参考图同类隔离消息核对，首轮浏览器实测思考到正文 16 px、正文到工具 32 px，无重叠。随后按用户反馈将非最终正文到工具收紧为 8 px，保留最终回复的 32 px；修正后的共享 UI 45 项测试、类型与文档检查通过，浏览器验证接口连续两次审批超时，未完成本次视觉复核。此次未验证 Electron 原生窗口或窄窗口。

Desktop 的消息复制不依赖 renderer 的 Web Clipboard API；共享会话组件把经 turn 归属选定的最终纯文本交给桌面宿主，preload 只暴露具名 `writeClipboardText`，IPC 核对主窗口 frame、封闭 `{text}` 参数和 1 MiB UTF-8 上限后，由 Electron 主进程写入系统剪贴板。宿主写入失败时按钮显示失败状态，不伪装成已复制。

补充问题使用共享 `AskQuestionnaire` 组合 `@shadcn/react/questionnaire`：Runtime 的每道题映射为一个必答 Questionnaire item，固定选项保留原始 option id，允许自由回答时增加受控文本输入；多题请求按顺序前进，最后原子提交以 `q1`、`q2`、`q3` 为键的答案映射及可读摘要，服务端重新核对题目集合和选项归属，不能把第二题答案降级成无归属的单值。单题仍保持原有单值摘要兼容。取消由桌面宿主单独处理。Questionnaire 提供 fieldset／legend、原生单选、字母快捷键和逐题空回答校验。交互区是会话 footer 中的普通布局项，不使用绝对定位、最大高度或内部 `overflow:auto`；完整内容增高时由上方会话阅读区让出空间。选项卡使用 40 px 紧凑基准、6 px 组间距和 12 px 面板内边距，避免用大卡片制造无意义高度。各题自由回答和计划修改意见与主输入草稿共用 App 的进程内草稿 owner，额外按 interactionId 和 questionId 隔离。切换会话、进入新对话或工作台再返回时恢复同一交互各题的输入；不同会话和下一次交互不沿用旧回答。提交失败保留原文，成功回答、反馈或取消后只清理对应交互草稿，不清理主输入和其他会话草稿。Interaction 只消费受控文本，不再将草稿放在随导航卸载的组件内。完整页面刷新与应用退出后的恢复不在此承诺范围。

Provider 配置由 [models](../src/models.ts)分别处理写入回执和随后读取的结果；刷新失败不覆盖明确拒绝或未知写入结果，已确认写入则提示仅刷新配置。所有路径均在写入结束后、刷新开始前清空临时密钥，不重放写入。[配置回归](../test/models.test.ts)覆盖回执丢失、明确未知、拒绝和已保存与刷新失败的组合；实际配置和继续任务另由真实 Service 的[开发闭环测试](../test/development.test.ts)验证。

[投影](../src/presentation.ts)对历史与实时事件使用同一映射，仍以 message/request/tool/subagent/interaction identity 幂等，不按正文去重；终态不能被迟到进度重新打开。工具记录保留 queued 与 Runtime 提供的 presentation/group identity、结构化参数、分别累积的 stdout/stderr、明确失败／拒绝／取消和文件证据，会话按工具类型展示：读取不展开正文，Shell 可展开真实输出及底部状态，文件修改展开已确认的工具差异，不新增原始参数面板。会话正文、工具活动和后续正文保持同一阅读列；连续工具活动使用无容器底色的紧凑日志结构，总览与步骤共享左侧图标轨道，步骤将动作和主要目标排在同一行。已完成状态由记录留在活动流中表达，不逐项重复绘制徽标；运行、等待、排队与异常仍显示文字状态，错误摘要保持可见。

Runtime 明确提供的 `reasoning.activity` 按 request/segment identity 显示为可折叠思考活动，不接收或推导私有 reasoning 字段；`plan.progress` 与 `plan.completed` 按 plan identity 原位更新轻量计划状态。工具终态的 `exhausted` 在 Shell 底部标明已达到输出限制，缺失时不猜测截断；问题回答回执优先使用 Runtime 提供的安全 summary。

子代理消息保留服务事实用于恢复，但主会话只渲染工具活动与稳定 stepId 对应的工具步骤，不显示子 Agent 结果段落。可见父 task 的子工具进入父展开区的子 Agent 容器，按确切 toolCallId 去重；没有可见父工具时保留子 Agent 容器入口，内部工具不进入主消息列表。当前没有独立子代理详情或控制。

主工具的 `tool.review` 由 Service 投影真实自动审批请求与完成事实，显示审批中、批准、未通过或转人工；技术异常和无效结果均转人工，不伪装拒绝。`approval.granted` 保留明确 grant，批准与工具执行结果分开保存，停止后不丢批准来源。审批控件只在 `interaction.grants` 包含 same_command 时显示下拉直接批准入口，调用原 `respond_interaction`，不增加本地授权缓存。压缩 requested／completed／failed 更新同一次压缩标记；Ask 回执保留已有安全问题文本与回答摘要，详情可折叠。

[Markdown](../../../packages/kite-client-ui/src/MessageContent.tsx)使用 react-markdown 与 remark-gfm 展示助手段落、列表、代码和表格；语义 HTML 的外层由 shadcn/typeset `typeset-chat` preset 统一排版，使用 Geist／Geist Mono、14 px 与 1.6 行高。Agent 正文不增加 padding 或独立限宽，与消息阅读列同宽。共享 CSS 只补充选择、溢出、链接和文件按钮行为，不再覆盖 Typeset 的正文排版。渲染跳过 HTML，保留默认 URL 安全转换，不自动请求图片。文件路径链接及 read_file 的结构化 path 调用既有 native editor 校验。编辑器选择在当前进程由 App 共享，默认 VS Code，可在设置中切换；限制见[文件与编辑器](results-and-editor.md)。

普通用户与助手正文不重复绘制角色标签，但保留可访问名称。没有 active interaction 时，输入区位于底部，模型与权限选择及主控收在同一输入卡片中，不展示快捷键教学；底部共享 `DropdownMenu` 按 Provider 分组展示 App Control 实际返回的模型，选定后输入区只显示模型名称，不附带 Provider，并展示 Runtime 已有的 Ask（`accept_edits`）、Auto 与 Full 权限模式；不在共享组件中补造模型或权限。Full 菜单文案和风险弹窗标题使用警示色。桌面客户端每次从其他权限切换到 Full 时，由共享 `AlertDialog` 说明代理无需逐项征得同意即可在当前环境允许的范围内运行命令、读取或修改文件、访问互联网；明确提示文件可能被覆盖或删除，命令与联网操作可能传输敏感数据，并说明可以切回其他审批方式及系统限制仍然有效；取消不更改权限，明确确认后才沿原路径提交。点击当前已选中的权限不弹窗，也不重复提交权限命令。共享页面按当前 `data-theme` 切换 `color-scheme`，原生表单控件与当前明暗外观一致；主题偏好与系统跟随由桌面入口维护。已有会话确认后通过 `set_interaction_mode` 提交。切换会话时先从已加载的会话目录显示目标 Session 的模型，随后由该会话的投影校准；不等待历史和订阅全部完成才显示模型名称。模型选择是 Session 本地待提交 route：新对话随 `create_session` 提交，已有会话随下一次 `start_turn` 提交；它不调用 workspace 默认模型写入，也不覆盖其他 Session。新对话权限在创建会话后、首条消息前提交，失败则不发送任务；提交期间仍禁用模型和权限选择以避免并发 revision 冲突，但保持原有视觉，不通过短暂透明度变化制造闪烁，真正断连或加载不可用时仍显示禁用态。active interaction 由完整 queue 选择，审批／问题／计划放在底部操作区；此时共享 `SessionPage` 给 `Composer` 传入 `promptHidden`，整个 Composer 返回空，不渲染主 textarea、模型、权限或停止按钮，避免并行操作。主草稿仍由 App 持有，交互结束后原样恢复。Enter 发送、Shift+Enter 换行，composition 与 keyCode 229 防止中文组词确认误发。任务运行但未等待交互时允许先写草稿，尚未接入 TUI 消息队列；唯一主控为停止。命令失败保留草稿，成功只清除实际提交且未被继续编辑的草稿。

切换已有会话的校准中间态保留上一条已确认权限作为禁用占位，并维持按钮不透明，不回退显示 `Auto`；目标历史返回后一次替换为该会话的真实权限，加载期间不会把占位值提交给目标会话。权限命令只有在连接发送或等待回执期间中断时才标记为结果未知；服务端明确拒绝保留原始原因。真正丢失回执后只读核对持久历史，目标权限已经生效时直接确认成功，不自动重放命令。

[消息投影](../src/presentation.ts)将失败的 `run.terminal`／`turn.terminal` 转成对应 Turn 的一条 system 消息；使用稳定消息身份合并双终态和重复历史，明确认证失败可以更新先到的通用提示。Run 通知优先使用携带的 Turn identity，旧运行的迟到终态不结束其他 Turn 的思考状态。取消不新增失败消息，错误不伪装成助手成功回复。Service 只传递安全错误分类，不把 Provider 原始响应写入正文。[投影回归](../test/presentation.test.ts)覆盖身份、去重和取消，[真实 Service 回归](../test/session-calibration.test.ts)覆盖 HTTP 401 首次无回复、实时显示与历史重读一致且不重发。

## HTML 预览优先的界面迭代

桌面界面调整优先通过 HTML 页面在浏览器中预览，直接复用实际 React 组件与样式，检查布局、视觉层级和交互，再根据预览结果修改实现。Figma 提供结构与交互方向，当前视觉方案仍可调整；已确认的调整同步到代码和受影响文档。

预览重点覆盖常用与最小窗口、长列表与长内容、草稿、会话切换、滚动跟随，以及输入区与审批／问题／计划面板的相互占位。可以使用隔离的临时测试数据复现状态；入口与数据留在临时目录，不作为生产路由或另一套 UI 实现交付。预览结果注明使用测试数据还是真实服务，测试数据中的成功状态不能证明服务命令已经执行。

浏览器预览调整完成后，按变更范围补充 Electron 原生验证：原生窗口行为、系统中文输入法、preload/IPC、文件与外部编辑器打开等需要在实际宿主中检查；服务命令、历史与恢复语义由相应集成测试或真实服务场景验证。交付时分别说明浏览器、服务和 Electron 原生证据，以及尚未验证的部分。

## 验证与限制

[UI 回归](../test/isolated/ui.test.tsx)覆盖点击直接加载／键盘进入、200 项列表导航、草稿隔离、组词事件、重复与失败提交、加载期间禁止发送、审批与停止、Questionnaire 单题及多题归属提交、问题／截断计划；[共享阅读回归](../../../packages/kite-client-ui/test/reading.test.tsx)覆盖 Markdown 安全边界、阅读位置和展开恢复。[投影回归](../test/presentation.test.ts)覆盖累计正文、迟到事件、工具结果、子代理关系与审批回执；Service interaction projector 回归覆盖 `questions` 安全投影及 `answers` 映射回写。原有真实 App Server 导航、大历史、开发闭环和回执丢失测试继续覆盖服务语义。

2026-09-08 使用当前 React 组件与临时测试数据在浏览器中检查 50 项列表、Markdown／工具／子代理、会话预览返回、草稿和审批布局；1440 × 960、900 × 760 及原生配置最小值 760 × 540 均检查了输入区和页面宽度。最小窗口下审批区域独立滚动，输入与停止可见，无页面横向溢出；窗口缩放的底部跟随问题已修正。测试数据入口位于临时目录，不作为应用路由交付。

这些证据不替代真实 Electron 窗口、系统中文输入法、屏幕阅读器、最终视觉或性能资格；本阶段未重跑原生安装与模型窗口验收。迁移前 Tauri 原生证据和当前 Electron 待验范围见[原生验收](native-validation.md)。


2026-09-08 共享页面迁移后，两端生产入口均消费同一页面；Web 使用只读操作策略，桌面保留原有输入与控制。浏览器复查了 Web 的深浅主题、390 × 844 窄屏目录／预览／路由返回与日志，以及桌面的 1440 × 960 和 760 × 540 审批／输入布局。两端均使用隔离测试数据；当时未重跑 Tauri 原生窗口或系统输入法，且当时的 IPC 与宿主操作实现未改动。这是 Electron 迁移前记录，不能证明当前 preload 或窗口行为。

2026-09-08 会话导航纠正：删除标题搜索与预览确认，点击即加载目标会话。以上早期预览／继续的验证记录不再定义当前交互；本次通过两端实际 App 的 HTML 测试数据预览复核直接切换，共享 UI 5 项、桌面 22 项、Web 13 项回归及全仓类型检查通过。系统输入法与当时的 Tauri 原生能力未重跑；该记录只证明仍沿用的页面交互。

## 设计功能同步

2026-09-13 会话顶栏标题收敛：共享页面的会话 header 只显示会话名称，不重复所属空间；超长会话标题限制为最多 10 个可见 Unicode 字符，超出时显示前 9 个字符和单字符省略号，完整标题保留在悬停提示与无障碍名称中。共享 UI 20 项、桌面 UI 41 项及共享、桌面、Web 三处类型检查通过；桌面全量套件的 20 个失败均为测试服务随机端口 `EADDRINUSE`，受影响 UI 套件单独重跑通过。[Figma Header](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4025-10)示例已同步为 10 字符的 `kite-code…`，规则写入组件说明，并移除遗留的空间名称／分隔符实例 `4277:21245`；回读确认该实例已不存在、可见内容只有会话标题和既有操作图标，header 仍为 `1204 × 52`，截图未见布局变化。

2026-09-13 边框线减淡：浅色主题的普通分隔线与卡片边框由 `#D9D9D9` 调整为 `#E7E7E7`，输入与必要控件边界由 `#8A8A8A` 调整为 `#C7C7C7`；焦点继续由独立 focus ring 表达，错误等语义边界不随普通边框一起减淡，深色主题不变。相关 49 项 UI 回归、共享与桌面类型检查、桌面生产构建通过；[Figma 三栏画面](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4502-23102)已同步 `border`／`sidebar-border`／`input` token，分隔线、任务表单分组、底栏与默认 Input 回读为新值，destructive Input 仍保留错误色。

2026-09-13 左栏浅色层级调整：浅色主题的侧栏背景由 `#EDEDED` 提亮为 `#F5F5F5`，选中与悬停表面同步由 `#E1E1E1` 调整为 `#E9E9E9`，继续保留与白色正文区、选中行之间的可见层次；深色主题不变。相关 49 项 UI 回归、共享与桌面类型检查、桌面生产构建通过；[Figma Sidebar](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4025-18427)及[安排任务三栏画面](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4502-23102)已同步变量并回读为 `#F5F5F5`／`#E9E9E9`。

2026-09-13 侧栏重新展开修复：三栏重构后的原生标题栏拖拽规则改为直接作用于当前 `.sidebar-header`／`.session-header`，并将其中的按钮、链接和表单控件明确标记为 `no-drag`；左栏收起后，中栏标题区的“展开侧栏”按钮不再被 Electron 窗口拖拽区域吞掉。桌面 UI 41 项、类型检查与生产构建通过，其中回归覆盖收起、确认左栏卸载、点击展开及恢复左栏。[Figma Sidebar](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4025-18427)、[Header](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4025-10)与安排任务画面已同步按钮 no-drag 语义并回读确认，现有几何和视觉保持不变。

2026-09-13 三栏样式修复与任务表单收敛：左栏内容补满全高，Resizable 分隔线改为 1 px 实色边界并用伪元素扩展命中区；右栏修正为纵向 flex、白色全高背景，任务编辑器改为无边框标题、说明文本区、详情／频率分组与固定底部操作栏。共享 UI 19 项、桌面 UI 39 项、两端类型检查与生产构建通过；1440 × 762 浏览器实测左右栏与 shell 等高，右栏 footer 底边等于窗口底边，控制台无错误。[Figma 安排任务画面](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4502-23102)已同步，frame、左栏、右栏与两条分隔线均回读为 960 px 全高，右栏组件 `4522:963` 包含 836 px 正文和 72 px 固定操作栏；[整页截图](https://www.figma.com/api/mcp/asset/b8d895d2-78c3-4cc1-85cf-896518295ace.png)与[右栏截图](https://www.figma.com/api/mcp/asset/b3e3805d-ee4f-4da8-908e-960adadaaf9d.png)确认无缝隙、裁切、重叠或底部空白。

2026-09-13 全高可调三栏：共享页面使用 shadcn Resizable 将左侧导航、中间页面与按需右栏改为全客户端高度的同级面板，左／中及中／右边界均可拖拽；安排任务创建表单和文件变更复用同一右栏。共享 UI 19 项、桌面 UI 39 项、两端类型检查与生产构建通过。[Figma 安排任务画面](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4502-23102)已同步为 `236 / 824 / 380` 三栏，右栏实例 `4530:4385` 为 `380 × 960`，左右分隔把手及中栏空态均已回读，整页截图确认无裁切或重叠。

2026-09-13 补充问题 Questionnaire：桌面 `Interaction` 改用共享 `AskQuestionnaire`，固定选项与允许的自由输入通过同一必答 item 统一提交，保留 Runtime 原始 option id、宿主取消与 interactionId 草稿 owner；共享 UI、桌面 UI、类型检查、桌面完整 100 项测试及生产构建通过。[Figma 计划与问题样例](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4208-578)已原位同步标题／说明、两枚单选卡片、A/B 快捷键、自由输入及取消／提交操作；根节点、fieldset、choices、input 与操作节点的语义注释已写入，metadata 和整页截图回读确认无裁切或重叠。此次未改变 Composer、计划审核或 Runtime 回答协议。

2026-09-13 活动交互隐藏主输入：审批、补充问题、计划审核或不支持的等待交互存在时，共享页面不渲染整个 Composer，包括主提示词 textarea、模型、权限控件和停止按钮；App 继续持有原草稿，交互结束后恢复。此前“保留会话级停止按钮”的实现与设计记录已经失效，当前交互只提供自身回答、批准、修改或取消操作。Figma [交互示例](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4208-578)已移除空 Composer 卡片和停止按钮，高度调整为 `1110` 并回读确认无裁切。

2026-09-13 Questionnaire 紧凑与完整展示：交互区移除绝对定位、固定最大高度和内部滚动，作为 footer 普通布局项完整增高；选项使用 40 px 代码基准、6 px 间距和 12 px 面板内边距。桌面 UI 39 项、共享 UI 19 项、类型检查与生产构建通过。[Figma Questionnaire 样例](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4225-955)已同步无 clipping／overflow 的自动高度结构；两枚选项卡最终为 `756 × 51`，fieldset 为 `780 × 300`，整体为 `780 × 448`，整页截图回读未出现交互区滚动条或裁切。

2026-09-13 Questionnaire 多题归属：Runtime client projection 与 wire 保留 Builtin 已生成的 `q1`／`q2`／`q3` 题目 ID，桌面按题保存受控草稿并在最后一步原子提交 `answers` 映射；Service 在写回 State 前核对答案键、题目数和固定选项，第二题答案不再丢失归属。除 unit projection 外，[真实 Service 校准回归](../test/session-calibration.test.ts)现以一次包含两题的 `ask_user` 工具调用核对桌面收到 `q1/q2` 并一次回传 `q1-o1/q2-o2`；该回归同时防止后端再次只投影首题。[Figma 第 1 题状态](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4225-955)与相邻[第 2 题状态](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4540-23479)记录对应交互。

2026-09-13 Questionnaire 导航与显示修复：固定选项值与自由回答显示值分离，选择选项只呈现选中状态，不再把 `q1-o1` 等协议 ID 写入输入框；当前题号由客户端显式维护，上一题／下一题只切换展示，不要求当前题先通过校验，因此可以先查看后续问题再返回作答。第一页只渲染取消回答与下一题，最后一题才渲染上一步与提交回答，且全部问题有效前提交保持禁用。桌面 UI 回归覆盖未答第一题进入第二题、返回作答、option ID 不泄漏和未完成时禁用提交。Figma 的[第 1 题状态](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4225-955)已同步“当前题未回答”但下一题可用；[第 2 题状态](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4540-23479)已同步上一步及“全题有效后启用”的禁用提交。移除交互态 Composer 后两者均为 `780 × 380`，回读无裁切或内部滚动条。

2026-09-13 运行态停止按钮稳定性：停止操作继续受 ready、loading 和 stopping 门禁约束，但运行期间固定不透明度并取消 shadcn Button 的全属性过渡，订阅校准造成的短暂 disabled 变化不再表现为按钮持续明暗闪烁；发送按钮的空输入禁用反馈不受影响。Figma [`Kite/Composer`](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4022-18431)的 Running 变体 `4022:12` 已同步停止按钮 100% 不透明、无 pulse／淡入淡出契约；实例 `4042:168` 回读为 `opacity: 1`，且保留发送按钮原有 disabled 透明度。

2026-09-12 安排任务页面：侧栏在“工作台”下新增“安排任务”，共享页面包含任务空态、列表契约与名称、任务说明、项目、频率、独立工作树／本地项目环境创建表单；当前 Service 没有保存和后台执行协议，保存禁用并显示真实限制。桌面完整测试 98 项、共享页面测试 19 项、类型检查与生产构建通过。[Figma 创建表单页面](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4502-23102)已同步并截图核验，包含相同字段、禁用保存状态与服务未接入提示；本轮不宣称定时任务已经能运行。

2026-09-12 输入区视觉收敛：HTML 预览以 1440 px 常用宽度和 760 px 最小窗口核对，输入卡片高度统一为 92 px，底栏只保留模型、权限与主控，不展示快捷键或运行态草稿教学；共享 UI、桌面 UI、类型检查和桌面构建通过。Figma 的 [`Kite/Composer` 主组件](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4022-18431)及[日常会话实例](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4156-20507)、[新会话实例](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4160-2120)原位同步，18 px 圆角、低对比边框与轻阴影保持不变，旧附件／语音覆盖已清除；主组件说明同时记录原生选择器固定使用浅色方案，模型和权限选择器均回读确认 16 px 图标、6 px 文图间距与 8 px 右侧留白。新会话实例保留其阅读列既有 780 px 宽度。本轮只调整输入区布局与视觉，不改变发送、停止、模型或权限语义，未复验 Electron 原生窗口和系统输入法。

2026-09-12 交互草稿与导航回执核对：浏览器使用生产 App 和隔离数据复现并确认补充回答在切换后恢复；760 × 540 下 Tab 可到达提交按钮，交互区滚动不遮挡主输入与停止。草稿隔离、失败保留和成功清理规则已原位同步至 [Figma 计划与问题样例](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4208-578)的交互注释；迟到创建回执不得覆盖更新阅读选择的规则同步至[日常会话侧栏](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4271-20908)与[新会话侧栏](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4096-1965)。注释已回读确认，没有改变 Figma 页面结构，也不宣称静态原型实现了运行时草稿存储。命令和旧订阅隔离由[真实 Service 回归](../test/session-calibration.test.ts)验证；本轮未复验 Electron 原生窗口。

2026-09-12 Electron 原生标题栏同步：真实 `hiddenInset` 窗口验证后，侧栏 header 保持 52 px 高，交通灯使用宿主配置的 x=13、y=19，kite 标识从 x=80 开始，32 px 收起按钮位于 x=188、y=10；不再对 header 内容附加向上位移。[Figma Sidebar 主组件](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4025-18427)已原位同步，[日常任务画面的实例](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4271-20908)继承相同标题区，新对话入口从 y=60 开始。主组件 metadata 与两处页面上下文渲染均核对通过；Figma 的隔离实例导出会漏掉越过实例左边界的继承层，不作为页面视觉证据。

共享[工具活动](../../../packages/kite-client-ui/src/ToolActivity.tsx)消费 Runtime 的显式展示分类：只有相邻、同 turn、`presentation=exploration` 且 `presentationGroupId` 相同的记录合并；standalone、缺失分组和 Web Public History 的弱事实均保持独立，不从 label 或邻近关系推导。普通探索与文件工具使用轻量状态行；内部工具名仅在没有更具体标题时转换为可读动作。完成态不重复绘制状态，queued、running、waiting、failed、rejected、cancelled 与 unknown 保留文字状态；Shell 使用终端图标，其他工具按类别使用 18 px 图标。工具参数、stdout/stderr、退出码与输出限制不进入会话 UI；失败工具仍显示有界错误摘要。带明确`presentationOwner`的子工具及异常只在所属子 Agent 容器内展示，没有 owner 的历史异常保持可见。子 Agent 摘要独立于父工具折叠，避免父记录收起后失去任务结果。

同步子代理通过原 `task` 工具结果返回主 Agent；客户端保留父工具活动、子代理名称、真实状态与结果摘要，不创建独立发送气泡或推断已消费状态。子代理执行过程只在子 Agent 容器内提供；有可见父 task 时，该容器位于父 task 展开区，所有状态默认收起，只有用户点击才展开；进度更新、失败和完成不改变用户的展开选择；父工具收起时仅保留结果摘要。缺少父工具身份的历史提供带来源的过程入口，不猜测归属；没有独立历史接口时不提供详情导航。文件变更的右侧副层见[文件与编辑器](results-and-editor.md)，MCP／Skills 设置接入见[扩展设置](extensions.md)。

2026-09-09 本轮通过共享 UI 7 项、桌面 24 项、Web 13 项及 Service 扩展 owner 5 项回归。HTML 测试数据预览核对桌面 1440 × 960／760 × 540 副层开关、Esc 焦点返回、输入可达与设置分类；Web 390 × 844 无横向溢出，点击即进入且不提供输入、文件副层或扩展管理。窗口改变的初始化监听同步当前媒体查询，避免挂载时遗漏尺寸变化。类型、构建与边界检查通过；本轮没有更新原生窗口、系统输入法或真实 MCP 认证资格。

2026-09-12 空间列表分批展示：共享侧栏默认显示 5 条，点击“展开更多”每次追加 10 条，收起空间重置；浏览器以 28 条隔离会话核对默认数量、追加与重置，按钮计算颜色为辅助色 `#666`。共享和桌面回归覆盖空间隔离、尾页与键盘导航。Figma 的[日常侧栏](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4271-20908)、[工作台侧栏](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4271-20967)和[新对话侧栏](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4096-1965)已保存分页交互注释，共享组件的底部展开控件已回读确认；新增的三条示例会话在最终回读中缺失，因此五条默认会话的视觉同步与最终渲染复核尚未完成，不能以此前截图认定设计同步全部通过。

会话列表按更新时间倒序排序后再分批展示；相同时间保持输入顺序，缺失或无效时间排在末尾。2026-09-12 已将排序规则追加到上述三个 Figma 侧栏的分页注释并回读确认，本次仅同步交互语义；上一段的五条示例会话视觉同步限制仍保留。对应共享目录测试覆盖时区换算、同时间顺序、更新时间变化以及排序后的展开与重置。

2026-09-14 Agent 会话消息布局收敛：HTML 预览按用户参考核对正文—工具活动—正文的阅读结构，工具总览使用前置类别图标与尾部折叠箭头，展开步骤按 18 px 图标轨道和单行“动作＋目标”排列；完成态移除重复状态，单条运行工具不再重复显示总览和进度文案。初次预览发现详情入口及三层运行态造成 P2 密度问题；最终按产品要求移除工具“查看参数与输出”入口及原始详情，只保留失败摘要。修正后在 1440 × 900 与窄屏复查通过，控制台无错误；共享 UI、共享与桌面类型检查、桌面生产构建通过。[Figma Tool Message 组件](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4207-579)与[会话实例](https://www.figma.com/design/qr0diiu1SH2prMVmhqMrJ0?node-id=4029-49)已原位同步并回读：General／Shell 的详情树、Context 和 Output Surface 均已删除，两个会话工具实例只保留 32 px Tool Header；General／Shell 的 `Execution Process` 与 `Bounded Result Summary` 继续保留，子 Agent 消息分组及“执行过程”未受影响。回读截图见[组件集](https://www.figma.com/api/mcp/asset/7fd2fcc7-ea0e-4249-9939-a72c78e369df.png)、[General 展开态](https://www.figma.com/api/mcp/asset/99474ee1-c0d6-4f13-b110-a083d84637fb.png)、[Shell 展开态](https://www.figma.com/api/mcp/asset/5ef6422a-8462-4778-801e-e4a1e547af8e.png)和[会话实例](https://www.figma.com/api/mcp/asset/f4f547b8-d7d7-44da-b277-6f7c1ba90c2b.png)。

Ask 投影保留服务提供的 toolCallId 和有序问题；input.answered.answers 按问题 ID 配对，选项 ID 通过原问题选项还原为文案，自由文本原样展示。历史与实时共用该路径，重复输入请求不覆盖已提交答案；主列表按确切调用归属隐藏重复 Ask 工具结果，不依赖相邻关系。

Ask 历史沿用 TUI 单题/多题信息结构，使用共享 UI 的有序明细、悬挂缩进与每项五行截断；取消内容仅显示“已取消”，不重复题目。数据归属和问题 ID 映射保持不变。

思考段计时由实时订阅传入 observedAt，消息投影保留首个 thinkingStartedAt 并在思考完成或 turn/run 终态写入 thinkingEndedAt；历史投影不使用重放时间生成耗时，只保留当前会话已有的对应段计时。共享标题以“思考中／已思考”表示生命周期，每秒重绘；思考完成或 turn/run 中断均落定为“已思考”并冻结已有计时，完成及卸载清理定时器，不新增 Runtime 时间协议。

## 用户菜单与外观

共享侧栏的用户按钮通过 shadcn DropdownMenu 展示设置入口与主题单选项，设置继续使用原有页面。桌面 [theme.ts](../src/theme.ts) 持有暗、亮、系统跟随偏好，保存在 `kite.desktop.theme`，默认系统跟随；入口挂载前应用已保存主题，系统模式订阅媒体查询并在卸载时移除监听。共享侧栏只消费宿主传入的主题值与回调，不持有存储。Electron 的封闭 `setTheme` IPC 同步原生外观与窗口背景，不涉及 Runtime 或会话配置。Web 保留现有主题入口与行为。

本次使用隔离数据与真实共享组件在浏览器核对黑灰暗色、亮色、系统跟随菜单、选中标记和刷新后偏好恢复。自动化覆盖 [主题生命周期](../test/isolated/theme.test.tsx)、[设置菜单入口](../test/isolated/ui.test.tsx) 与 [preload 桥接](../test/preload-bridge.test.ts)。Electron 构建和参数边界已验证，未实测原生窗口中的系统外观切换。

用户菜单浮层背景修正：两端 Tailwind 主题补齐 popover 语义映射，共享 DropdownMenu 显式使用主题边框色。浏览器计算样式确认修正前背景为 `rgba(0, 0, 0, 0)`，修正后亮色为 `rgb(255, 255, 255)`、暗色为 `rgb(36, 36, 36)`；Portal 不依赖页面私有菜单背景。
