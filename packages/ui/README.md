# UI

桌面会话的正文阅读列与底部输入区通过[共享样式](src/desktop/style.css)统一采用 740px 最大宽度，水平居中；可用空间不足时继续随容器缩小。“回到最新消息”的覆盖层与正文视口共用内边距、滚动条预留和环境信息占位，保持按钮中心对齐；按钮采用圆形、浅阴影与不透出正文的悬停底色。会话容器建立独立层叠上下文，正文为0层，置底覆盖层为1层，仍位于外部环境卡及弹层之下；图标复用会话忙碌事实，活动时为三点跳动，静态时为向下箭头。左侧当前页面按钮与会话项使用与悬停相同的选中底色，文字颜色和字重不变，悬停／按下仍共用即时反馈。`SessionPage` 根据实际页面标记新对话、工作台或安排任务；这些页面打开时不同时高亮宿主保留的旧会话，返回会话后恢复对应项。设置分类沿原规则不保留选中底色，选中语义与键盘焦点继续保留。

2026-10-23，Windows x64／Bun1.4.3，`5c28cd1fd` 加本轮样式工作树：逐文件运行 `bun test ./packages/ui/test/isolated/desktop-conversation-scroll.test.tsx` 与 `bun test ./packages/ui/test/isolated/desktop-sidebar.test.tsx`，6项／885断言通过；UI／Desktop typecheck、定向 Biome、文档检查通过。实际 SessionPage／Conversation 与生产编译 CSS 在隔离浏览器中逐步核对上翻、内容追加、运行到静态、回到底部恢复跟随、环境信息展开／收起及侧栏悬停／选中；1280／1600px 和390px、深浅主题下按钮32px且与正文中心误差小于0.01px，窄屏无横向溢出，追加保留手动阅读位置。该轮侧栏与设置分类计算样式均为零过渡，选中项移开后透明；当前侧栏选中底色已按上文要求恢复，下文新证据覆盖此变化。圆形与层级调整后补验深浅主题、活动／静态、悬停及点击：32px按钮的圆角为50%，浅阴影为2px／8px／14%，覆盖层1高于正文0且限定在会话层叠上下文；正文重叠区域命中原按钮，悬停底色不透明，点击后隐藏按钮并到达底部。未重验完整 Electron 安装版；保留既有加载动画的嵌套关键帧编译提示。

2026-10-23，侧栏选中底色恢复：现有[侧栏 DOM 回归](test/isolated/desktop-sidebar.test.tsx)增加页面往返与保留旧会话不重复选中的断言，整文件6项／251断言通过，UI／Desktop类型检查通过。隔离浏览器加载实际 SessionPage、Sidebar 和生产编译 CSS，逐步点击安排任务、新对话及两个会话，再移开鼠标；深浅主题、1200／540px共16次切换始终只有一个选中项，底色与原悬停一致，文字颜色／字重不变且过渡为0s；键盘Enter激活与浏览器零异常通过。此证据覆盖共享页面展示，不代替完整Electron／Service或原生材质验收。

[公共 Button](src/desktop/components/ui/button.tsx)按[桌面规范](../../docs/handbook/clients/desktop/README.md)提供 `icon-xs/icon-sm/icon/icon-lg` 四档，消费[共享样式](src/desktop/style.css)的 `--icon-button-size-*`、`--icon-button-size` 与公共 `--button-radius`；各档显式取消 padding、内部 gap 和最小高度叠加，使用居中图标形成固定留白。文字按钮的 padding／min-height 规则排除所有 `icon*` 尺寸，包装 Button、设置、审批及结果区域保持同一几何规则。输入区和侧栏切换使用32px标准档，标签关闭、审批翻页和代码复制使用24px紧凑档，移除相关局部尺寸与图标覆盖。

[MessageCopyButton](src/desktop/MessageCopyButton.tsx)沿公共 `icon-sm` 使用28px按钮、16px图标及统一8px圆角，默认、成功和失败状态保持相同尺寸；不再单独指定按钮宽高。`--control-gap: 4px` 统一控制按钮与时间的横向间距，`--message-meta-offset: 2px` 保留用户气泡／Agent正文到信息栏的垂直间距；含信息栏的消息保留 `28 + 2 + 8 = 38px` 底部空间，确保工具栏与下一条消息至少间隔8px。悬停／聚焦显示和准确原文复制继续沿原生命周期。

[Conversation](src/desktop/Conversation.tsx)的 `.message-meta` 将复制与时间放在正文下方同一行，用户消息反向排列为时间在左、复制在右。被动时间显示不恢复任何复制或读取资格；普通、最终回复和过程正文均为信息栏预留间距。信息栏使用 `user-select: none`，聊天全选寻找正文端点时同样排除它。[时间格式](src/desktop/message-time.ts)只接宿主 `Message.createdAtMs`，按本地日历区分当天、昨天、本年日期和其他年份；不以24小时差推断昨天，完整 `time` 语义保留 ISO instant、秒与原时刻 UTC 偏移。悬停／聚焦消息重新计算日期标签；缺失或无效时间保持未知，不调用当前时间补造来源。格式回归见[日期边界](test/desktop-message-time.test.ts)，复制与全选回归沿原[消息复制文件](test/isolated/desktop-message-copy.test.tsx)。

2026-10-23，Windows x64／Bun1.4.3，`de498789b` 加本轮工作树：逐文件执行 `bun test ./<原测试路径>`，原[消息复制](test/isolated/desktop-message-copy.test.tsx)、[代码复制](test/isolated/desktop-code-block.test.tsx)、[侧栏](test/isolated/desktop-sidebar.test.tsx)、[标签页](test/isolated/desktop-session-tabs.test.tsx)、[排队消息](test/isolated/desktop-queued-messages.test.tsx)及[输入框](test/isolated/prompt-editor.test.tsx)六个完整文件27项／427断言通过，UI／Desktop typecheck 与定向 Biome 通过。Chrome155.0.8059.85 的隔离浏览器在基础／包装 Button、设置、审批和结果区域核22个图标控件；实际 SessionPage 配合生产编译 CSS 在深浅主题、1280／390px四组场景逐步核悬停、复制成功、复制失败和聚焦。按钮28px／图标16px，工具栏内4px、正文下方2px，下一条消息至少保留8px，反馈不引起尺寸或位置跳变，无横向溢出和页面错误。夹具只使用模拟回调，不读用户数据，未重验完整安装版 Electron。

2026-10-23，Windows x64／Chrome155、当前生产 Conversation／Native 消息适配及编译 CSS，在深浅主题、1280／390px、Asia/Shanghai 固定日历下核四组操作：观察用户与 Agent 的时间位置、当天／昨天／本年／跨年及未知显示、原输入接管、复制成功／失败、流式追加和完成、重挂载历史、跨午夜再次悬停。时间和消息保持一份，较晚业务消息不覆盖原输入时间；正文实际增高时保留手动20px阅读位置，复制与全选不含信息栏，控件与下一条消息保留至少6px，无横向溢出或页面错误。日期格式另以 America/New_York 跑过夏令时与闰日断言；原消息复制3项／52断言通过。UI／Desktop 类型检查、生成 API、边界与文档检查通过。此为隔离组件与真实协议的分层证据，未重验完整安装版 Electron；保留既有嵌套 `@keyframes` 编译提示。

2026-10-23，Windows x64／Chrome 155，实际 Conversation 与生产编译 CSS 在深浅主题、1280／390px 四组隔离浏览器检查中通过：逐步观察悬停→复制成功、复制失败及键盘聚焦，按钮始终 32px、图标 16px、圆角 8px，最终回复按钮与下一条消息保留 6px 间距，无横向溢出或页面错误。原[消息复制回归](test/isolated/desktop-message-copy.test.tsx)3项／48断言和 UI typecheck 通过；未重验完整安装版 Electron。

桌面 [共享样式](src/desktop/style.css)的空间添加按钮与行内编辑按钮使用透明背景和图标变色反馈；Composer 的聚焦边色／阴影遵循宿主根元素的 `data-input-modality`，pointer 状态不保留焦点装饰。未提供该状态的宿主沿原焦点规则。Dialog／Sheet 关闭按钮使用 `focus-visible` 提示；Native 的统一鼠标／键盘判定和窗口验证由 [Desktop owner](../../apps/desktop/README.md#复用原桌面展示层)负责。

空间行内操作的显隐选择器覆盖通用按钮的 `:disabled` 透明度，禁用前后均按悬停／`focus-within` 显示，触屏沿原媒体查询常显。禁用仍阻止点击和指针事件；忙碌本身不使隐藏按钮出现。Composer 的 `sending` 仅表达实际输入提交，普通权限／管理操作通过各自忙碌状态及 `disabled` 门禁表达。

Composer 在原停止按钮内使用 Hugeicons `StopIcon` 的实心方块，填充继承按钮前景色、无描边；圆形按钮继续沿原主题配色。发送中、活动任务、停止等待、运行中引导及原回调和禁用条件保持。

附件移除按钮由[共享样式](src/desktop/style.css)单独设为常显的 24px 深色圆底、白色图标、浅色描边和阴影，不依赖缩略图颜色或主题背景；悬停／按下保留实色底，键盘聚焦使用明暗双层提示，普通文件和图片共用。

用户消息由 [Conversation](src/desktop/Conversation.tsx) 分为宿主 `renderMessageAttachments` 附件插槽和 `.user-message-body` 正文气泡，时间／复制继续属于同一原消息；空正文不保留气泡。`SessionPage` 透传附件插槽，Agent 内容和工具不消费它。[MessageAttachments](src/desktop/MessageAttachments.tsx) 使用 [shadcn AttachmentGroup](src/desktop/components/ui/attachment.tsx) 的横向滚动、吸附与边缘渐隐，按实际宽度决定附件总数和前后按钮，读取或缓存资格不由滚动控件授予。尺寸／数量变化重新测量，滚动只更新端点按钮；隐藏缓存暂停观察，恢复重新测量。导航文字不进入聊天全选。[AttachmentFileCard](src/desktop/AttachmentFileCard.tsx) 与 Native 图片共用 Attachment／Media／Title，保留当前148px卡宽、80px预览、8px间隔与消息卡片12px圆角；shadcn 源码仅调整本地导入，使用已有 Radix Slot、Button 和样式工具，不增加依赖。输入区沿原移除与选择流程。

消息过滤使用宿主确认的 `Message.hasAttachments` 保留已保存的仅附件用户消息；标记只影响展示，不授予读取权限。Desktop 的持久消息及发送占位均从附件元数据提供此标记。发送接管、失败、重开与真实浏览器布局证据归 [Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。

[Conversation](src/desktop/Conversation.tsx)按浏览器实际夹紧后的 `scrollTop` 记录自己的滚动写入；来自该位置的迟到 scroll 事件不改变跟随状态，用户改变位置时只有实际到底（容许1px的分数滚动精度差）才恢复跟随，取消原48px近底吸附区，避免状态提交或流式追加把手动阅读拉到底部，恢复与“回到最新消息”共用同一写入。避免新一段内容增长先于旧 scroll 通知抵达时误判为用户上翻；[阅读滚动回归](test/isolated/desktop-conversation-scroll.test.tsx)覆盖这一顺序、手动阅读、恢复及重复卸载的观察器／监听清理。Native 图片挂载与资源生命周期见 [Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。

2026-10-23，同一 Windows 工作树的近底吸附修复：上述滚动回归先复现距底47px时从1853跳到2000，修复后1项／742断言通过，覆盖47／16／2px手动位置、后续重绘与内容增长、0.5px精度差下的真实到底及原观察器清理；UI typecheck、Biome和文档检查通过。隔离实际组件页面用相同上翻／下滚操作复现旧版提前置底，新版停在距底约36px；运行中追加正文保留原scrollTop，手动到底后追加继续跟随，静态会话与显式置底同样核实，无页面错误。验证范围为当前桌面共享组件，未重验安装版 Electron。

[Conversation](src/desktop/Conversation.tsx)首次呈现历史时，对默认展开的活动轮次同样登记 `data-restored-expanded`，直接进入完整高度，避免首次打开重播300ms展开动画而带动正文移动。缓存恢复与冷历史共用原恢复标记，后续手动开合由 `onToggle` 清除标记并继续动画；不改变展开选择、消息顺序或滚动跟随。[轮次回归](test/desktop-reasoning-turns.test.tsx)核冷／恢复两种入口；生产组件浏览器耗时、逐帧高度及连续流式证据归 [Desktop owner](../../apps/desktop/README.md#会话消息渲染验证)。

宿主可通过 `initialPresentationPending` 延迟尚未呈现的 Conversation 首次内容提交，让已保存消息和结构事实同时进入原轮次布局；UI不读取或推断轮次／工具事实。第一次可读 layout commit 后该标记不再遮住正文，普通流式更新、缓存恢复和阅读滚动继续原行为；换 readingKey 或DOM淘汰后重新挂载才重新等待。Native的失败、缓存及首条输入豁免由 [Desktop owner](../../apps/desktop/README.md#原轮次阅读聚合与问答回执)负责；[阅读滚动回归](test/isolated/desktop-conversation-scroll.test.tsx)核首次等待、后续更新、重新挂载及原滚动生命周期。

[SessionPage](src/desktop/SessionPage.tsx)在 layout effect 中取得首个正宽度并直接确定环境卡占位，首次测量不启动 padding 过渡，防止已绘制正文／Composer 再横移及换行。后续实际尺寸跨阈值和用户开合仍使用原动画；Native环境卡从scope建立就保留原节点，业务内容晚到不新增占位。[侧栏回归](test/isolated/desktop-sidebar.test.tsx)核初始占位、晚填内容、窗口阈值和窄窗浮层。

同一组件的 `.response-status` 沿[共享 CSS](src/desktop/style.css)正常参与轮次底部排版，为“正在回复…”保留24px行高，位于处理过程折叠区外。轮次提示的上方留白使用正文块间距；上方为展开工具时使用原混合间距，抵消工具控件自身留白。显示提示时过程区不再叠加底部 padding，收起过程或尚无正文时仍保留完整块间距。底部跟随继续由阅读内容高度驱动；浏览器回归核状态文字完整位于viewport与各级裁剪容器内。

“正在回复…”与工具消息共用字号、字体及文字颜色规则，使用 `--conversation-text-size`（默认14px）和 `--muted-foreground`。思考／回复标签直接使用宿主已引入的 [shadcn shimmer utility](https://ui.shadcn.com/docs/utils/shimmer)，以行内块将流光范围限制在标签文字，使用语义前景色作为高光以跟随应用主题；通过库内置 `shimmer-spread-[16px]` 和 `shimmer-duration-1500` 将高光收窄为16px、每1.5秒扫过一次，避免默认宽光带在短状态文字上仅呈现整句轻微变色；沿库内置的减少动态效果规则恢复静态文字，不新增动画实现或依赖。读取与业务交互门禁保持。

该提示由 [Conversation](src/desktop/Conversation.tsx) 按准确 `turnActivity` 与终态 marker 在轮次底部呈现，位于过程折叠区外。普通活动过程入口固定为“处理过程”；准确的当前未结束思考且没有活动工具时，底部同一节点显示“正在思考…”，出现正文或活动工具后恢复“正在回复…”。底部状态只显示思考／回复文字，不附运行时长；`TurnElapsed` 仅在原 summary 展示可靠起止时间对应的终态耗时，不再启动活动计时器。没有可展开过程的普通活动轮次不显示空 summary，首条状态行不额外增加顶部留白；等待、停止、恢复和失败等真实轮次状态保留；观察失败不追加普通界面异常标签。

模型或工具消息的 `settled` 不结束轮次提示；queued、running、waiting、cancelling 与 recovery_required 保持，真实 terminal 优先移除，同 Turn 分裂条目仅末条目显示一次。暂时 `unavailable` 保留已有活动展示，不显示新的思考判断或“上次确认状态”标签；不扩大当前读取或操作资格。宿主通过独立 `TurnActivity.executionUnconfirmed` 表明原执行权已释放或不能核实时，未结束轮次停止回复／思考及 busy 展示；普通界面不追加“执行状态待核实”，这两类标签仅在显式测试诊断中显示。原 status 和真实终态保持，诊断标签不能覆盖失败、取消或中断终态；撤除标记后重新按原事实展示。无 Turn 身份的旧独立流式消息保留原局部提示。[生命周期回归](test/isolated/desktop-turn-response.test.tsx)核空正文、思考／回复节点切换、工具、普通观察失败、执行权待核实、折叠及真实终态。

Composer 的图片卡片保持固定预览区域，接受宿主交付的小尺寸URL并提示异步解码；等待URL时显示准备占位，可选 `previewError` 只显示预览失败，不改变原 `loading/error` 的发送门禁。图片转换、缓存与原字节校验归 [Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)，UI不读取或转换原图。Native登记给ConversationCache的图片成本现包含缩略图编码字节与RGBA像素估算，继续使用原媒体／DOM预算、停用和释放协议；派生Blob的独立有界缓存由原窗口owner管理，不能恢复旧读取资格。

## Markdown 消息内容

桌面 [MessageContent](src/desktop/MessageContent.tsx) 在 GFM 上支持以下展示；Web 的 `SafeMessageMarkdown` 和独立 TUI renderer 保持各自范围。

| 内容 | 语法与行为 |
| --- | --- |
| 图表 | `mermaid` 围栏内支持 `graph`／`flowchart`、`sequenceDiagram`、`classDiagram`、`stateDiagram`／`stateDiagram-v2`、`erDiagram`。围栏闭合后异步绘制，未闭合时显示当前源码；源码开关和复制保留原文，错误或不支持时回退源码。 |
| 代码与差异 | lowlight 的 common 语言集合按显式语言标记高亮，包括 TypeScript、JavaScript、Python、JSON、SQL、Shell 与 diff；未知语言或超过32768个UTF-16单位的块保持全文纯文字。高亮仅改变 token 文字颜色。 |
| 提示块 | 引用首段的 `[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]`、`[!CAUTION]` 转为中文标签、侧边线与正文，无色块背景。 |
| 数学公式 | remark-math 与 rehype-katex 渲染 `$…$` 和独立 `$$` 围栏；KaTeX渲染与本地字体样式固定同版，`trust:false`、展开上限100、尺寸上限20em。错误公式保留可读源内容，不执行链接或加载图片。 |
| 正文导航 | 标题使用 GitHub 风格 slug，重名递增；标题与脚注ID按消息隔离，fragment仅能跳往同一消息已有目标，跳转后移动键盘焦点。脚注保留编号、说明与返回正文链接。 |

[图表 adapter](src/desktop/markdown-diagram.ts)懒加载 Mermaid，以 strict 模式、纯文字标签和客户端控制的透明主题绘制，再作为 SVG image 展示，不把生成标记或事件绑定挂进应用DOM。图表不接受配置指令、frontmatter、自定义样式、HTML、点击或图片／图标语法；原文不删除。单块源码上限16384个UTF-16单位、边数250；生成SVG上限200万个字符、单边12000及面积1600万坐标单位，超限回退源码。图表保持自然尺寸并在局部滚动，去掉默认阴影；节点边框与箭头使用蓝色 `--diagram-accent`，生命线、分组与注释边框使用青色 `--diagram-secondary`，正文保持原前景色。两种图表色分别适配深浅主题，颜色单独变化也会重绘，主题切换保留已有画面直至新版完成。渲染串行化，全局队列仅保留完成信号，不保留已结算的图像或失败对象；停用取消排队或丢弃迟到结果；已绘图资源登记到原会话缓存预算，窗口隐藏释放，恢复后重绘。详细取舍见[图表展示边界](../../.agents/notes/implemented/architecture/2026-10-22-desktop-markdown-content.md)。

[队列回归](test/desktop-markdown-diagram-queue.test.ts)核并发串行顺序、原图交付、完成信号及取消后恢复。[内容回归](test/desktop-markdown-extensions.test.tsx)核公式／提示块／高亮、完整源码、消息锚点隔离和prepared树不变；[图表生命周期回归](test/isolated/desktop-markdown-diagram.test.tsx)核迟到结果、Activity暂停、资源记账、窗口恢复和仅图表颜色变化时的重绘／原图保持。浏览器验证归[Desktop owner](../../apps/desktop/README.md#markdown-与附件输入)。输入框继续编辑这些类型的Markdown源码，不在草稿中绘图或排版公式；[编辑器回归](test/isolated/prompt-editor.test.tsx)核无关编辑后的扩展语法保留。

2026-10-22，Windows x64／Bun1.4.3、`beabc9628`加本次Markdown工作树：以准确`./`文件路径执行Markdown、扩展内容、语法缓存、代码块、提示词编辑、阅读滚动、Native Worker构建与调度8个文件，28项／1501断言通过；图表生命周期隔离文件另以独立Bun进程执行，1项／16断言通过。UI／Desktop typecheck、UI三个入口构建、定向Biome、统一边界、workspace、测试归属与文档检查通过。测试Mock只存在于隔离生命周期文件，不进入普通客户端；完整安装版Electron与其他平台未在本轮重验。

2026-10-23 推送前同步远端 `c3cfa313a` 后，前述8个完整文件再次通过28项／1505断言，独立图表生命周期文件通过1项／22断言。编辑器扩展用例曾在JSDOM默认聚焦选区落到代码块开头时失败；夹具改为明确设置末尾用户选区并派发selectionchange后再粘贴，保留全部源码和末尾追加断言，生产编辑器不变。同步后全仓typecheck、文档range影响、统一边界和workspace检查通过；此前Electron与浏览器证据按未改变的展示范围复用。

## Markdown 提示词编辑

消息正文的引用、代码和表头不铺独立底色：共享样式用2px引用竖线、1px代码外框／标题线和表格网格线区分层次；行内代码使用等宽字与细底线。表格保留完整细边框和共享圆角，单元格以横纵细线分隔，表头下边框与其他边框统一使用1px和相同主题边框色；相邻边缘不重复叠线，保留原滚动区域、焦点提示与GFM对齐。`PromptEditor` 的代码块和行内代码同步采用透明底与线条，正文解析、复制、编辑与读取边界保持。

2026-10-22，Windows x64／Bun1.4.3：Markdown、语法缓存、代码块、提示词编辑与阅读滚动五个测试文件19项／913断言通过；原[浏览器夹具](../../apps/desktop/test/ai-elements-browser-runner.fixture.ts)在Chrome155的深浅主题、1280／390px四组检查通过，保持代码滚动、过程展开和回复状态转换。另用实际 `MessageContent`、`PromptEditor` 与生产编译CSS逐步观察引用嵌套、代码复制回执、表格键盘横向阅读、输入编辑，以及追加开始／中间／结束时的布局；760／342px阅读列的深浅样式均可读。此为隔离组件验证，未运行本轮完整安装版Electron窗口；编译仍有既有嵌套 `@keyframes` 提示。

[PromptEditor](src/desktop/PromptEditor.tsx) 使用固定 Lexical 0.52.0 实时渲染和编辑 Markdown，`Composer` 继续通过 Markdown `draft/onChange` 与宿主交接；未编辑的外部草稿保留原源文。正文、占位提示与代码默认使用 14px 字号，Markdown 标题保持独立层级。Composer 内模型／思考与审批选择器的触发文字为 13px，缓存统计同为 13px；输入区外的项目／分支选择器及上下文详情保持 14px，模型列表为 13px，项目／分支的展开菜单保持 14px；输入框内选择器图标与上下文状态圆环为 14px，附件、发送／停止、输入区外项目／分支及展开菜单的操作图标保持 16px。底部工具栏按 32px 高居中，文字选择器为 28px 高、18px 行高，内边距上下 4px／左右 6px；附件与发送／停止图标按钮保持 32px；`composer-options` 将附件、模型与审批放在左侧，`composer-trailing` 将缓存率／上下文状态组与发送／停止放在右侧，状态组与发送按钮间距为 16px。底栏按实际可用宽度在两组之间换行，右组整体右对齐；左组保持同一行，模型名称在可用空间内省略，保留原完整名称提示和无障碍名称。Native 模型容器使用 Grid 承接按钮和后续错误信息。权限菜单使用 `max-content` 按标题、名称及说明自适应宽度，同时受视口留白与 Radix 可用宽度限制，达到上限时自然换行；常规宽度下标题区单行排列，标题与选项名为 13px／18px，辅助说明为 11px／14px，均为 400 字重；容器、标题、RadioItem 和分隔线直接使用组件库默认的 padding／margin，选项高度按内容与默认内边距自然形成；名称与说明无额外行间空隙。窄区域允许说明自然换行，不裁剪内容。输入法确认、Enter 发送、Shift+Enter、撤销与 scope 切换由该组件处理，链接点击不导航，粘贴只解析 plain text Markdown，不执行 HTML 或获取远程图片。组件 handle 提供 focus/caret 操作，不再暴露 textarea。

`Composer` 的缓存命中率恢复为独立文字，分子与分母仍来自原累计命中／未命中用量。旁边14px静态圆环直接渲染为 `role="img"` 的 SVG，不使用按钮、不提供点击操作或按钮悬停底色；保留键盘聚焦以读取提示。圆环仅消费宿主的 `contextUsage`：当前上下文输入估算除以模型完整窗口，不能用缓存命中率、累计输入或扣除输出预留后的可用输入预算替代。悬停或键盘聚焦时沿原 Radix Tooltip 在上方显示三行居中详情：上下文窗口、约多少百分比已用、已用／总窗口标记数，较大数字缩写为 k／m 等；完整数值保留在图标无障碍描述中。未知容量显示空环与“占用比例未知／总量未知”，真实零仍为0%；超过容量时环最多一圈，详情保留实际超过100%的估算。浮层使用主题卡片色、共享圆角和视口避让，Escape关闭；无对应估算时隐藏圆环，缓存率仍独立显示。宿主读取与会话／模型隔离归 [Desktop owner](../../apps/desktop/README.md#输入区上下文占用)，UI不读取上下文正文或发起业务请求。

[上下文占用回归](../../apps/desktop/test/isolated/native-context-usage-dom.test.tsx)核缓存99%而上下文68%的反例、完整窗口分母、零、未知容量、超过容量、迟到响应、会话与模型隔离；原[累计缓存回归](../../apps/desktop/test/isolated/native-cache-metrics-dom.test.tsx)继续核统计保留、真实零与无样本。

2026-10-20，Windows x64／Bun1.4.3，`5dba8a6b`工作树加本次左右分组修改：对上述上下文、缓存回归及[共享页面](test/desktop-page.test.tsx)执行 `bun test --parallel=1 --max-concurrency=1`，22项／214断言通过；UI／Desktop的 `tsc --noEmit`、两个源码文件的Biome及文档检查通过。Chrome155以实际Composer和生产样式检查深浅主题、320–1100px输入区、中英文、长模型名与思考档位，并沿隔离Main夹具检查实际NativeDesktop的会话切换及缩窄，共23组通过；核分组边界、模型省略、菜单、上下文浮层、无指标、DOM身份和停止按钮。未运行安装版窗口或其他平台。

`Composer` 的 `+` 菜单以输入框等宽的“添加”列表向上展开，只有“添加文件”一行，使用图标、12px 文字与整行高亮；菜单沿原 Radix 键盘／焦点合同，按 form 和 trigger 的实际边界定位，`ResizeObserver` 在输入框尺寸变化时更新宽度和顶边间距，切换 scope 时关闭。一个无类型过滤的多选 file input 交付实际 File 对象；同次选择、粘贴或拖入先按 MIME／已知图片扩展名分流，图片交给 `onImageFiles`，普通文件由宿主 `onFileReferences(files, signal)` 准备独立字节，再由 `onFilesSelected` 交给原 scope。准备期间显示“正在保存附件…”和“取消添加”；取消、切换 scope 或卸载都会终止所属 signal，保留草稿且丢弃迟到结果，失败可重新选择。准备 signal 保持到宿主接纳原附件；输入随后 disabled／隐藏或未进入 onFilesSelected 的结果会释放，已经接纳的附件不随准备作用域结束而删除。默认每条消息 10 张图片，宿主通过 `imageLimit` 表达同一准入值；已有与新增合计超限时不调用任何附件 port。文件拖入在捕获阶段接管，避免 Lexical 再处理同一份附件。迟到或取消的选择不进入后来 scope。两类附件以受控 `images/files` 在正文上方横向展示并独立移除，不改写 Markdown 草稿；准备中或错误的图片阻止发送，两类附件均可单独发送。UI 不读取本地路径、上传图片或拥有 Artifact 读取权限。[编辑器测试](test/isolated/prompt-editor.test.tsx)核 Markdown、IME、混选、取消、切换、10／11 张边界及粘贴／拖入累计，实际图片 owner 见 [Native](../../apps/desktop/README.md#markdown-与附件输入)。

文件卡片由 [AttachmentFileCard](src/desktop/AttachmentFileCard.tsx)供 Composer 与 Native 历史共用，图标依赖由 UI workspace 拥有。文件选择 port 的有限 `file_picker_restart_required` 错误显示完全退出后重新启动的操作提示，其他失败沿原通用重试文案，不把宿主异常原文带进界面；两类失败均保留输入且不触发发送。旧主进程判断由 Native 适配器负责，UI 不识别 IPC 或其他原始错误码。

正式 UI 根入口与 Desktop 构建内联[声明的普通浏览器依赖](scripts/bundled-dependencies.ts)，React、React DOM 和 Client 保持外部身份；原 CSS 与许可全文保留。Markdown 的 github-slugger、lowlight 和 mermaid 也由同一构建内联，避免其开发依赖进入运行闭包；remark-math／rehype-katex 继续按现有外部依赖资格分发，KaTeX CSS／字体保持完整，不跳过许可检查。TUI 在[同一次 splitting 构建](scripts/build-tui.ts)输出展示入口及 `@kite-ai/ui/tui/ink`，CLI 的 renderer 与 hooks 共同使用这份 Ink。锁定 Ink 7.1.1 的 DEV/devtools 分支在构建核实原文件结构后固定关闭，环境与普通组件参数不能开启。原行为与真实客户端验证边界见[闭包成本决定](../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)和 [Terminal owner](../../apps/cli/docs/terminal-release.md)。

[同次 Ink 构建适配](scripts/ink-output.ts)只绑定 Ink 7.1.1 的准确 `output.js` 物理路径，校验唯一原行序列化结构后，为所有单元均无样式的整行直接拼接字符；任一单元有样式仍使用原 ANSI 序列化。空白单元分配、宽字符覆盖、裁剪、行尾空白处理及原输出顺序保持，未知版本或结构拒绝构建。没有修改安装依赖或增加运行开关。[实际编译对照](test/tui/ink-output-build.test.ts)3项／265断言通过，核原版与编译版的 Unicode、重叠、裁剪、颜色、链接、转换器和完整 9,000,025 字节正文。2026-10-24 Windows x64／Bun1.4.3 的独立 `Output.get` 对照中，80列／75,001行原版3.10–3.45秒，适配后0.66–0.70秒；此为渲染函数范围，完整正式候选资格仍由 Terminal owner 维护。

当前 TUI 复用原 Ink 展示，输入、消息／工具阅读、审核和管理面板经公共 Server port 接入；功能迁移、普通模式与显式测试诊断由[终端 owner](src/tui/README.md#原-ink-展示与明确测试诊断)维护。Desktop 的[诊断展示 context](src/desktop/diagnostics.tsx)默认 false，回复失败技术详情与客户端面板只按显式测试值显示，不从 `NODE_ENV=development` 等环境名推断。dev／prod 客户端不得开启测试专用调试功能，测试 fixture 可显式提供 true；Native 另外执行构建常量的关闭门禁，见[Desktop owner](../../apps/desktop/README.md#普通客户端与测试诊断)。这份展示开关不扩大控制权限。

## 原桌面展示层

Conversation 的 `systemKind:agent_result` 只消费宿主已确认实际触发父续跑的 `agentResult`，与普通消息共用 MessageItem 和输入气泡样式，增加“〔名称〕Agent 发送”头部，正文显示实际 Markdown 和非成功状态。父原轮 active 接纳不由宿主投影为此类消息，UI 也不按当前 Run 是否活动再过滤已确认的唤醒消息。独立消息边界不被相邻过程分组吸入，默认折叠及冷读仍保留正文，且不取得用户输入、助手最终回复或复制资格。同一 Turn 如被独立消息分段，整轮最终耗时仅在最后一段显示。`renderMessageContent` 仍由宿主提供准确详情入口，正文完整性由 `contentComplete` 明示。真实来源与读取由 [Desktop](../../apps/desktop/README.md#native-当前会话环境信息与子详情)及 Store 负责，UI 不根据名称、正文或子 Agent 状态制造消息。

普通邮件使用 `systemKind:agent_message` 和宿主验证的 `agentMessage`，沿原接收 Run 的 turnId 留在同一处理过程。原 MessageItem／MessageContent 显示“〔名称〕Agent 发送”、完整 Markdown 和正文不可读状态；它没有独立气泡、用户输入、工具执行或助手最终回复的身份，正文中的批准文字也不生成操作入口。`data-agent-message-id` 沿原 mail ID，终态及冷历史保持同一份正文和一段过程；最终结果的独立消息边界保持上述规则。[共享邮件 DOM](test/isolated/desktop-agent-activity.test.tsx)与 [Native 投影 DOM](../../apps/desktop/test/isolated/native-transcript-dom.test.tsx)分别核来源、正文、失败状态和活动→完成→冷历史的分组、单耗时与复制边界。

共享样式以 `--font-ui` 统一正文、控件与浮层字体，优先使用 Geist Variable；中文回退到系统界面字体，Windows 优先 Microsoft YaHei UI。`--ui-text-size: 14px` 是客户端默认字号，`body`、`.kite-client` 与会话字号变量共用它；挂到 `body` 的 Portal 因此保留14px正文，不通过修改HTML根字号缩放 `rem` 布局；基础层的原生按钮、输入框、选择器与文本框继承所属正文的字体，避免浏览器默认控件仍显示13.33px。普通通知／问卷及操作、任务表单、右栏标签和工作台会话主名称使用该基准，徽标、代码与辅助信息保留明确层级。共享 `Textarea` 统一使用 `text-sm`，移除 `text-base md:text-sm` 的宽窄差异；欢迎标题固定28px，通用页面一级标题固定36px，不再按窗口宽度变更字号。普通文字为 400，界面标题与 `font-semibold` token 为 500；Markdown 标题、加粗和等宽代码保留内容层级。Native 字体资源及阅读区变量由 [Desktop owner](../../apps/desktop/README.md#复用原桌面展示层)接入。

`SessionPage` 的普通会话滚动 viewport 从标题栏顶边延伸至主面板底边；标题栏使用 85% 主体底色和 12px 背景模糊，输入区悬浮在底部，环境信息卡位置与标题栏下边线保持。局部 `ResizeObserver` 测量标题栏和输入区的完整外框高度，分别写入 `--session-header-height` 与 `--conversation-footer-height`，为首尾消息及键盘滚动保留对应空间；输入区变高时同步更新，卸载时释放观察器。主面板统一管理叠层：正文 viewport 在底层，玻璃标题栏居中，ScrollArea 轨道覆盖在右侧且标为 `no-drag`，只按实测标题栏高度下移轨道顶部并缩短轨道高度，viewport 仍为全高，不占用标题栏宽度；正文和输入区仍预留 10px 轨道空间，输入区外围留白不拦截滚轮和滚动条；回到最新消息按钮位于输入区上方。布局只按实际渲染的顶部提示判断回退，Native 传入的空 React Fragment 不关闭效果；可见提示、读取错误与其他页面沿用正常布局。原 `Conversation` 继续管理跟随最新和手动位置。[布局回归](test/isolated/desktop-sidebar.test.tsx)覆盖空 Fragment、可见提示、页面往返与测量监听释放。

共享[桌面样式](src/desktop/style.css)的主体背景由 `--page-background` 跟随 `--background`：深色为炭黑 `#191919`，亮色为浅灰 `#fafafa`；输入框使用独立的 `--composer-background`，深色为 `#202020`、亮色为 `#fff`，与阅读区保留轻微明度层次；卡片和浮层继续使用 `--card` 的深色 `#242424`／亮色 `#fff`。会话标题、阅读区、设置内容与右侧详情沿同一主体变量，会话与右侧栏的标题栏共用 `--border` 绘制 1px 下边线，使用内阴影避免增加布局高度，使两侧下边线对齐；文字、交互叠层和侧栏实色回退值保持。原生透明侧栏与窗口底色由 [Desktop owner](../../apps/desktop/README.md#原主题与窗口背景联动)负责。

输入框的1px描边使用 `--composer-border-color`，亮色为黑色10%、深色为白色5%；键盘焦点边色使用 `--composer-focus-border-color`，亮色为黑色14%、深色为白色12%。投影色由 `--composer-shadow-color` 管理，亮色为黑色4%、深色为黑色24%；焦点外圈由 `--composer-focus-ring-color` 管理，亮色为黑色4%、深色为白色4%。常态投影保持 `0 1px 2px`，键盘聚焦时额外绘制 `3px` 淡外圈，继续遵循原输入方式判定。

[Sidebar](src/desktop/Sidebar.tsx) 的会话悬浮提示只显示完整名称与 `updatedAt` 的本地化时间；缺失或非法时间只保留名称。状态仍供列表标记与 `aria-description` 使用，不重复写入悬浮内容。

环境卡 [BackgroundExecutions](src/desktop/BackgroundExecutions.tsx)以可选 `busy` 表示短时校准：保留正文和停止按钮，沿 `disabled` 禁止停止并提供 `aria-busy`；`stale` 继续表示实际不可用／失败。首次子 Agent 读取同样只标记忙碌，不插入加载文字或提前显示空列表；真实 stale 仍撤销停止资格，以 `data-stale` 保留观察事实；“上次状态 · 待核实”等附加文案只在显式测试诊断中显示。环境卡忙碌时保留禁用按钮的原透明度和悬停外观，原 disabled、事件和真实异常显示保持；其他消费者默认透明度与行为不变。

共享 [Composer](src/desktop/Composer.tsx)用 `sessionLoading` 区分普通读取等待与真实不可用。按 `scopeKey` 有界保存最近12项已启用的控件外观，临时只读保留输入、发送／停止及附件的透明度；空草稿等原本禁用的发送仍保持原样。已知审核标签与模型在校准中保持原节点和悬停，未知审核方式使用静态“审核方式”／“Approval mode”标签；原生 disabled、事件捕获和当前回调门禁继续阻止操作。会话／确认范围变化或权限暂不可操作时关闭旧审核菜单和 Full 确认，模型弹层同样拒绝禁用状态下打开。

目录、[安排任务](src/desktop/ScheduledTasks.tsx)、[文件操作](src/desktop/FileChanges.tsx)及共享[模型输入](src/model-input.tsx)／[输出](src/model-output.tsx)读取不显示临时加载文案，忙碌由区域的 `aria-busy` 和原控件状态表达。安排任务与文件操作只在读取完成后展示空状态，已有内容仍可保留；附件准备期间保持原文件名和预览占位，不插入准备提示，失败仍可见。会话原转圈及其无障碍名称保留。

共享 [Composer](src/desktop/Composer.tsx)把内嵌菜单的鼠标事件留给菜单自身处理，菜单项及其文字不触发输入区空白处的 输入框聚焦逻辑。审批触发器以原 `permissionPending` 提供 `aria-busy` 和切换中标签，原禁用门禁保持；会话权限状态是否需要占据主区由 Native 宿主负责。

新对话项目菜单由 [NewConversationContext](src/desktop/NewConversation.tsx) 统一只显示项目名称与选中标记，不把 `path` 选择值作为副标题；原值仍用于选中、React key 和 `onProject` 回调。

项目／分支菜单沿共享 `.context-menu` 按内容自适应宽度，常规窗口限制在160–240px，窄窗口扣除两侧16px安全间距；选项右侧保留32px选中标记空间，长名称沿原规则换行。

共享[桌面样式](src/desktop/style.css)将交互状态与静态背景分开：`--control-hover`、`--control-selected`、`--control-pressed` 分别为亮色黑色5%／9%／12%、暗色白色7%／11%／15%的中性叠层，在控件所在的实色或系统材质上合成。普通按钮、问卷选项和设置内容沿用这些状态；左侧 `.client-sidebar-panel` 将 `--control-pressed` 局部映射到 `--control-hover`，使导航、空间与会话行、用户按钮和收展按钮的悬停／按下底色一致。选中导航与会话行局部将按下变量映射到 `--control-selected`，按下时也保持选中高亮；ghost 按钮静止时透明，主操作仍使用原实色配色。空间行内添加／移除等原本仅变图标的入口保持透明。状态标签等静态内容继续消费 `--accent`／`--sidebar-accent`；Markdown代码和表格使用透明底与细线。Native 设置、菜单焦点映射与材质验证归 [Desktop owner](../../apps/desktop/README.md#交互状态与透明材质)，本层不取得壁纸或宿主材质读取能力。

2026-10-14 Windows x64／Bun 1.4.2，当前 `006b79d3` 工作树上的该变量修改：实际 Chrome headless 载入当前 Tailwind 编译 CSS 及共享 Sidebar／Button 的静态标记，用鼠标悬停核亮／暗、Mica／实色四种组合。亮色空间、会话、主要导航、用户按钮及设置返回样式与普通按钮均为 `rgb(236,236,236)`，选中会话与设置分类沿同值；临时替换 `--accent` 后亮色侧栏与按钮同步变化。暗色保原侧栏 `rgb(48,48,48)`，Mica 侧栏承载层仍透明。该次定向 Biome 核对保留了当时三项 `!important` 提示；此 CSS 核对不代证原生壁纸合成或完整客户端交互。

[SessionPage](src/desktop/SessionPage.tsx) 的外层 Group 分配导航与 `workspace`；工作区内的 `.client-content-frame` 包住第二层 Group，由它分配阅读区 `content` 和工具区 `details`。右栏开合只改变框内两区的宽度，外框到应用右侧的留白保持固定；描边、阴影、圆角与材质留白由 [Native owner](../../apps/desktop/README.md#windows-原生-mica)在共同外框上绘制。右栏展开时，工作区将两区合计660px最小宽度交给外层约束，保留紧凑窗口中导航让出空间的行为。布局取舍见[共同外框记录](../../.agents/notes/implemented/bug-fix/2026-10-20-session-content-frame.md)。

当前两侧可折叠面板在 [SessionPage](src/desktop/SessionPage.tsx) 通过 `ResizablePanel` 已有的 `style` 端口设置原 `overflow: hidden`，该值落在库默认 `overflow: auto` 的同一内容节点，保留原裁剪和滚动行为。会话阅读区由 [Conversation](src/desktop/Conversation.tsx) 的原生 `div` 渲染，没有第三方内联 `display`／`min-width`；对应共享 CSS 保持 `display: block`、`min-width: 0`，无需 `!important`。布局、宽度、滚动恢复及事件仍由原组件负责。

环境信息沿[共享样式](src/desktop/style.css)使用整张卡片宽度加 16px 右边距的水平位移，从右侧滑入、向右滑出，保持原尺寸并延续 180ms 缓出节奏；会话容器只裁剪水平方向，避免动画进入相邻详情区。原 CSS transition 支持连续反向切换，隐藏后延迟撤除可见性，减少动态效果时直接切换。

2026-10-23，Windows x64／Chrome 155，以原[会话浏览器夹具](../../apps/desktop/test/session-shell-browser.fixture.tsx)和当前生产编译 CSS 在 1440／760／390px 下逐帧检查滑入、滑出及连续反向切换，并观察中间画面：位移覆盖完整卡片与右边距，尺寸保持，右边界裁剪，没有横向溢出或页面错误；系统减少动态效果时立即切换。此为隔离浏览器验证，未重验完整安装版 Electron。

`@kite-ai/ui/desktop` 的 [SessionPage](src/desktop/SessionPage.tsx)、Sidebar、Conversation、Composer、RightSidebar 与 shadcn 控件从原 kite-client-ui 展示源码迁入，保留原 CSS、交互和依赖版本；[样式导出](src/desktop/style.css)供正式 Native 的原 Vite/Tailwind 管线编译。此层不导入旧 workspace 或 Runtime，事实映射和写入 authority 属 [Desktop host](../../apps/desktop/README.md#复用原桌面展示层)。

桌面圆角在[共享样式](src/desktop/style.css)统一定义：面板、卡片、列表、菜单和提示框消费 `--radius: 16px`，输入框消费 `--input-radius: 16px`，普通文字按钮、图标按钮和菜单项消费 `--button-radius: 8px`。Composer 仅在内部实际 `button` 节点上将 `--button-radius` 设为 `9999px`，形成随高度夹紧的胶囊形；非 Portal 权限菜单的菜单项仍为8px。Tailwind 的 `--radius-xs` 到 `--radius-4xl` 仍作为面板圆角的别名，控件按自身用途引用对应变量。圆形控件、滚动条、调宽把手保留圆形或胶囊轮廓，拼接内侧和全屏容器保留必要的直角；Native 设置样式、Mica 面板及正文排版共用这些变量。调整只改外观，不增加请求、写入或阅读权限；实际编译后的值和窗口验证归 [Native owner](../../apps/desktop/README.md#统一桌面圆角)。

同一共享样式的 `--resize-handle-width: 1px` 管理调宽线。导航分隔以该值占位，收起时归零；阅读区与右侧工具之间的分隔始终不占布局宽度，以伪元素覆盖接缝，保留原命中区、把手和键盘操作，避免右栏开合改变共同外框的可分配宽度。Native Mica 以导航分隔和内容留白计算玻璃导航的外侧间距，具体视觉边界与实窗证据由 [Native owner](../../apps/desktop/README.md#玻璃导航间距)维护。

[SessionPage](src/desktop/SessionPage.tsx) 的 `schedulePanelChange` 在实际开合时统一开启内外 Group 的 `data-animate-width`，面板、分隔与标题占位均消费[共享样式](src/desktop/style.css)的 `--sidebar-motion-duration`／`--sidebar-motion-easing`，默认180ms／ease-out，两种方向相同；导航与右栏分别按所属 Group 测量和调宽，不对已在目标状态的面板重复启动。调宽分隔收到鼠标／触摸或键盘操作后立即结束程序动画，拖动直接跟随；原240ms动画清理计时器在卸载时释放，减少动画设置同时关闭面板及分隔过渡。各用途的 RightSidebar、关闭与阅读生命周期保持。

[Sheet](src/desktop/components/ui/sheet.tsx) 的浮层与遮罩通过 `data-slot`／`data-side` 采用相同动画参数，Radix Presence 等待退出动画结束后移除节点，退出时不接收指针操作；减少动画时直接关闭。环境卡的透明度、位移与占位也消费这两个变量，宽度不足或恢复均启动过渡，新挂载卡用 `@starting-style` 进入。宿主详情开启时清除旧的内部右栏缓存，关闭仍立即卸载当前详情读者，退出的栏体不会显示之前另一面板的内容。

2026-10-19 Windows x64／Bun1.4.3、`f734245a` 加本轮改动：共享页面、侧栏和安排任务三文件31项／294断言及UI类型检查通过。Chrome155沿实际共享组件、Native编译样式及设置布局标记逐帧核18组双向显示／隐藏，窄窗左栏、环境卡自动恢复、设置右栏原跳变路径从零中间帧恢复为连续过渡，全部实际动画为180ms／ease-out；另核两组减少动画、浅色实色下快速反向、直接拖拽和减少动画的窄窗关闭，零页面错误。宿主详情不为退出动画保活；设置真实表单／关闭证据归[Desktop owner](../../apps/desktop/README.md#复用原桌面展示层)。未运行本轮安装版或其他平台原生窗口，既有嵌套 `@keyframes` 优化提示保留。

同页以单一 `sidebarOpen` 保存左侧导航的按钮开合意图；所有窗口宽度共用同一 Group 和按钮，不再切换窄窗 Sheet 或重挂载主区。导航不启用面板库自动折叠：展开时按200–420px约束调宽，按钮关闭时将约束设为0px并禁用分隔线，拖拽、键盘调宽、选择会话、新建对话与Escape均不改变开合意图。主区保留200px最小分配宽度，极窄窗口由面板库按可用空间分配；右栏仍沿原独立约束处理。私有 `NavigationPanel` 固定初始 `defaultSize`，避免保存宽度变化造成多余注册；按钮展开以及展开状态下的窗口拉宽会恢复保存宽度，只有用户拖拽写入保存值。导航显隐、按钮、`aria-expanded`／`aria-hidden` 和 `inert` 共用该状态。[侧栏 DOM 回归](test/isolated/desktop-sidebar.test.tsx)覆盖跨原600px断点的状态和节点保持、按钮开合、初始窄窗以及选择／新建／Escape不自动关闭。

2026-10-23，Windows x64／Bun1.4.3，`5c28cd1fd` 工作树加本轮修改：逐文件运行 `bun test` 的侧栏、标签页、desktop-page、scheduled-tasks 及 Native 新对话DOM五个文件，共109项／1912断言通过；UI／Desktop类型检查、定向Biome和文档检查通过。IAB实际SessionPage／NativeWindowFrame与生产编译样式逐步观察1280／901／900／800／600／500px窗口，核按钮开合、拖动200／290／420px宽度、Home／Enter／Escape、选择会话、草稿保持和右栏空间不足后恢复。左栏仅按钮关闭，header保持10px 24px、用户区8px下内边距且无侧栏额外10px；深浅主题800px核实际页面无错误。另核距底约38px时追加正文，scrollTop保持2548.67px，状态从跳动点切换为箭头不打断阅读，点击按钮回到底部。此证据为隔离renderer页面；原生窗口800px下限由Main配置，未做安装版系统拖窗或其他平台验收，保留既有嵌套keyframes编译提示。

桌面侧栏的开关意图、按钮和面板宽度由 `schedulePanelChange` 在同一个动画帧提交；没有可测尺寸时只更新开合意图。桌面只挂载一个收展按钮，放在导航分隔之后的零宽轨道 `.desktop-sidebar-toggle`，随实际面板边界及同一180ms偏移过渡移动；它不在导航或主区的裁切层内，开合不重建按钮、不丢失焦点，也不改变面板可分配宽度。标题保留原节点，`.session-sidebar-toggle` 保留0与“32px按钮＋当前标题间隔”之间的占位动画和32px高度；窄窗继续使用同一按钮和面板。减少动画时一起直接切换。[侧栏DOM回归](test/isolated/desktop-sidebar.test.tsx)另核帧前后开关同步、唯一按钮、标题／按钮节点和焦点保持。侧栏末端、标题起始内边距由共享变量与按钮共用，不再在900px断点改写；底部用户区保留8px内边距，侧栏不再在窄窗额外叠加10px下内边距。Native 的留白与macOS安全间距由 [Desktop样式](../../apps/desktop/src/native-tailwind.css)适配。

2026-10-19 左栏按钮复验：侧栏、共享页面、安排任务与Native新对话四个整文件52项／921断言、UI／Desktop类型检查及定向Biome通过。Chrome155沿实际SessionPage、NativeWindowFrame与编译样式，在200／285／420px保存宽度、800／1100／1400px窗口、深浅Mica、实色、macOS样式标记与减少动画七组配置核35段开合和快速反向，按钮保持同一节点、焦点、完整32px点击区，无重复绘制、裁切或垂直位移；另三组场景核深浅／材质下右栏同开、按住拖到0后反向、键盘收起、500px浮层及600／601px循环；700px窗口的右栏把导航挤至0px时，展开按钮仍可点击，手动展开及拉宽自动恢复均通过，显式关闭保持关闭。窗口约束解除后的保存宽度由原290→240px保留偏窄恢复为290px；草稿、标题和输入节点保持。此证据未覆盖安装版或其他平台的原生窗口合成。

右侧 `details` 面板及分隔在 `rightSidebarOpen=false` 时一同禁用，隐藏分隔不再响应鼠标／键盘，也不能经其他面板间接展开空栏。分隔以开合状态重新挂载，启用时重新登记相邻面板，保留重开后的键盘调宽。真实用户调宽至库确认的折叠状态时，沿当前 RightSidebar 的同一个关闭回调处理宿主详情、文件变更或安排任务编辑；原读取释放、焦点返回与编辑代次保护保持。正常展开时仍沿300–640px约束调宽。

右栏展开同步同时响应600px断点造成的 Group 重建，并在展开意图存在时观察内部内容 Group 尺寸；窗口或导航释放空间后，恢复被约束折叠的右栏。收起或卸载即释放该 ResizeObserver。窗口缩放不调用用户关闭回调，显式关闭仍清除展开意图。

2026-10-19 Windows x64／Bun 1.4.3，基于 `f734245a` 加本轮工作区改动：共享[页面](test/desktop-page.test.tsx)、[安排任务](test/isolated/scheduled-tasks.test.tsx)、Native [页面](../../apps/desktop/test/isolated/native-new-conversation-dom.test.tsx)和[后台](../../apps/desktop/test/native-background-panel.test.tsx)四个整文件54项／849断言及 UI／Desktop typecheck 通过。Chrome 155 隔离夹具沿实际 SessionPage、固定面板库和 Native CSS 复现关闭右栏仍可拉出640px空白，修复后保持0；2048／1240px、亮暗／Mica与实色下核实际拖拽、300–640px约束、键盘收起、详情组件卸载、重开及关闭按钮，500px另核收起右栏与窗口缩放。未运行安装版窗口、其他平台或全量默认测试；既有嵌套 `@keyframes` 优化提示保留。

同日宽窄切换修复在上述版本加本轮改动上复验：页面与安排任务27项／195断言、UI typecheck及定向Biome通过。Chrome155沿实际组件和Native CSS在亮暗／Mica与实色五个场景核宿主详情、文件变更及安排任务编辑，原1600→500→1600px右栏为300→0→0px，修复后恢复300px；另核800px挤压后恢复、600／601px反复切换、环境卡自动恢复与窄窗浮层、显式关闭不重开、草稿保留和零页面错误，并复验原拖拽／键盘收起与空栏回归。该证据不代替安装版或完整Electron窗口验收。

同日左栏双按钮修复：新增侧栏DOM3项／70断言，三个用例在原实现均失败，修复后通过；连同原页面、安排任务和Native页面共51项／849断言、UI typecheck及定向Biome通过。Chrome155在亮／暗Mica与暗色实色三场景沿实际SessionPage及Native CSS复现拉宽后导航为200px却仍 `aria-hidden`／`inert`、两个按钮均绘制；修复后只有一个可用按钮。另核桌面手动关闭、窄窗浮层开关、600／601px反复切换、保存宽度、键盘收起、草稿及右侧变更面板恢复；安装版、其他平台和全量测试仍未运行。

公共 Desktop 入口也导出已有 [Badge](src/desktop/components/ui/badge.tsx) 与 [Spinner](src/desktop/components/ui/spinner.tsx)，供 Web 目录复用原关注提示和加载图标；没有 Tailwind 编译的 Web 仅保留必要 scoped CSS，关注配色沿 attention 语义变量及系统语义色回退。

同一公共入口现导出原[Tooltip](src/desktop/components/ui/tooltip.tsx)四个组件，供[Web目录](../../apps/web/README.md)复用已有hover／focus／Escape和共享延迟行为；原组件、Radix依赖与Native Sidebar保持。Web负责准确公共activity、读取生命周期和本包scoped CSS，不引入第二份计时器、运行状态或业务authority。Web完整DOM、可信browser build与本机IAB证据归该owner和[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11web-完整工作区与会话目录)，不据新增export宣称全平台资格。

原 Conversation 的复制交互现归共享 [MessageCopyButton](src/desktop/MessageCopyButton.tsx)，正式 Native 的 Conversation 和正式 Web 用户／助手消息共同消费。宿主只交付准确文本、复制类别和 clipboard port；组件保成功两秒反馈、失败重试、卸载及正文／disabled 变化后的迟到隔离，不推断 Turn、聚合正文、读取模型或发业务请求。原 Conversation 继续决定用户原文及宿主确认的最终助手全文，缺完整 copyText 的守卫保持。[真实 Conversation DOM](test/isolated/desktop-message-copy.test.tsx)核原文本、回合守卫、重试、换 scope 及同 ID 正文变化；Web 的原文、实际页与独立资产样式证据归 [Web owner](../../apps/web/README.md)，不把共享控件测试外推为 OS 剪贴板或完整客户端资格。

[Desktop build](scripts/build-desktop.ts)将[唯一声明](scripts/bundled-dependencies.ts)的 `@hugeicons/core-free-icons` 内联到原浏览器产物；其余 npm 依赖、React peer、原导出及 CSS 保持。Terminal 的生成 package manifest 不再声明这条已内联依赖，复制器仍保留其他包真正需要的依赖边。原包许可和 NOTICE 完整复制；固定 4.3.2 npm 包实际缺许可正文时，仅对准确版本／MIT使用[附带官方原文](scripts/licenses/core-free-icons-4.3.2/LICENSE.md)和[固定来源](scripts/licenses/core-free-icons-4.3.2/SOURCE.json)，离线核 SHA，不替换其他包许可。制品全部生成文件仍进入完整 inventory，实际原窗口和默认回归结果归[普通启动进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)。

有限 renderMessage、Composer 控件/输入标签/发送门禁 slot 和 detailPanel 让宿主接入已验证公共正文 reader、准确 controller 与原右侧栏；缺省保持原展示契约。侧栏开关不卸载 Conversation，宿主 detailPanel 关闭则卸载所属工具内容以释放原读取，不沿旧动画缓存保留隐藏 reader。Sidebar 在连接标签为空且未提供 connection action 时不生成连接行，用户菜单独立保留；Native 的测试辅助入口显示规则归 [Desktop owner](../../apps/desktop/README.md#普通客户端与测试诊断)。UI 不读文件、发请求或取消业务。缺少真实操作回调时不从 view model 推造能力；Message completion 不能提升为 final reply 或旧 Tool grouping。

[SessionTabs](src/desktop/SessionTabs.tsx)由 SessionPage 标题栏的“标签页”图标打开，替代原直接“文件变更”按钮。受控 Radix Tabs 提供新标签页、加号、切换、关闭和收起，最多8项；首页工具只提供唯一“变更”标签。宿主可通过 `childTabRequest` 打开子 Agent 详情，以准确 Session／Execution 去重并选择标签，和网页／变更共享8项上限；满额的新详情请求显示必要提示。`renderChildSession` 只在当前可见子标签挂载，`onChildSessionChange` 将准确目标或关闭状态交还宿主；标题更新不重新打开已收起的侧栏。主会话的 `readingKey`、正文、输入区与环境卡不因子标签切换而改变。`useSessionTabs` 位于响应式 Group 之上，调宽、窗口缩放与收起保留当前会话标签，换 readingKey 或页面卸载通过 `closeBrowser` 释放旧网页。`renderBrowser` 接收稳定 ID、可见性、工具入口和标题回调；共享 `SessionBrowserToolbar` 只交付导航事件，不接触宿主接口。标签栏以 `visible` 控制交互、原生网页可见性和工具 reader；收起时立即设置 `aria-hidden`／`inert` 并卸载变更读取，保留栏体外壳供父面板沿原180ms宽度动画裁切退出。标签页由 `changeTabsOpen` 同步保存 `tabsKey`，父面板宽度继续由原调度在下一帧调整；阅读区与右栏共用180ms缓出过渡，并在共同外框内裁切；外框右侧留白不参与开合动画。`present` 仅在实际展开或退出动画期间保留外壳，结束、覆盖页面或让位其他详情面板时设置 `hidden`；空间不足导致实际折叠时也隐藏网页并卸载工具 reader，展开意图仍可在拉宽后恢复。外层 `#details` 使用不占布局空间的裁切，避免面板库的外层 `overflow: visible` 让300px最小内容宽度越界；减少动画和直接调宽继续遵循原规则。

原 [FileChanges／FileDiff](src/desktop/FileChanges.tsx)与 `fileChangesContent` 继续复用；只有当前可见且选中的变更或子详情标签挂载 reader，切换、覆盖或收起即卸载，其他标签不在后台读取。`renderDetail` 仍只在展开项挂载。实际网页、文件回执和编辑器目标校验归 [Desktop owner](../../apps/desktop/README.md#会话标签页与内置浏览器)。[标签生命周期回归](test/isolated/desktop-session-tabs.test.tsx)覆盖入口、reader、会话释放、窗口缩放和数量边界；UI 不取得文件或执行权限。同一文件新增宿主详情面板关闭与标签打开交错的回归：原实现中 `detailPanel.onClose` 先使宿主面板关闭，延迟到rAF的标签意图会被 `rightSidebarOpen=false` 的布局effect取消；仅标签开关同步保存 `tabsKey` 后，布局帧可被替换，不再丢失打开标签的操作；导航及其他面板保留原同帧提交合同。该修复恢复原标签合同，保留原reader释放、尺寸、共享复用与动画边界；合并后的实际执行结果单独核实。

SessionPage 的可选 `covered` 保留主panel树、尺寸和阅读实例，以opacity0／inert／aria-hidden退出绘制与交互；`overlays` 仍在同级可见层。左侧栏随同一主panel树被覆盖，原开合状态保留，恢复页面时不重新挂载导航。该属性不取消任务或重新选择会话；标签页隐藏网页并卸载当前工具reader，其余宿主reader保持原合同，默认不覆盖页面。原 [DialogContent](src/desktop/components/ui/dialog.tsx)新增可选 `showOverlay`，默认true保旧遮罩；Native全屏设置明确false，仍由原Radix内容保焦点、Escape与模态语义。具体玻璃层和状态恢复由 [Native owner](../../apps/desktop/README.md#windows-原生-mica)维护。

原 [MessageContent](src/desktop/MessageContent.tsx)和 [ToolActivity / ToolRow](src/desktop/ToolActivity.tsx)公开给 Native 复用，文件操作仍只调用显式宿主回调。`ModelOutputMessage.renderText` 可为同一预览或已验证全文提供宿主展示；不改完整读取、身份／字节门禁、关闭与 onContent，未传时继续 SafeMessageMarkdown。当前 Native 的消息路径与默认模型摘要归 [Desktop owner](../../apps/desktop/README.md#原消息文件路径与常规摘要)，纯 UI 不取得文件、来源核验或编辑器权限。

[Code Block](src/desktop/components/ui/code-block.tsx)与[Trace](src/desktop/components/ui/trace.tsx)使用官方 shadcn/ui 的 Radix 源码结构，分别适配现有 Button、Hugeicons 和语义 token。[MarkdownCodeBlock](src/desktop/MarkdownCodeBlock.tsx)只接块级代码，保留原 `pre > code`、语言类、缩进与换行；保持单个代码容器，显式语言按token高亮，不拆行；Mermaid图表使用同一标题与准确源码复制，正文仍走固定Markdown parser与安全规则。语言标题和复制操作由 Code Block parts 组合，行内代码与表格身份保持。[Markdown 回归](test/markdown.test.tsx)和[代码块回归](test/isolated/desktop-code-block.test.tsx)核语言、准确复制、原安全限制与复制资格。

[Clipboard context 与 hook](src/desktop/clipboard.tsx)复用原消息复制生命周期；Conversation 提供宿主 port，正文内的代码复制同时消费原 `copyText` 资格，包含自定义正文 reader 子树。预览或未核实最终回复不提供代码复制，已核实正文关闭后撤销；停用、换文或换 port 的迟到结果失效，已完成反馈沿原两秒截止时间保留。复制不从 DOM 重建文本，不新开宿主或业务接口。

[ToolActivity](src/desktop/ToolActivity.tsx) 的可选 `childAgent` 只消费宿主交付的准确身份、名称、工作状态与观察新鲜度；复用 Trace 展示彩色图标、14px 单行名称和不被长名称挤掉的状态，不新增卡片或原始结果段落。图标与 [ApprovalHeader](src/desktop/ApprovalHeader.tsx) 共用 `ChildAgentIcon` 的稳定身份分配；已识别的子 Agent 行使用原生共享 Button，整行调用准确 `childDetail.onOpen`；没有折叠入口、独立详情按钮或回执内容，旧 `expanded=true` 也不挂载原正文 reader。缺少详情回调时禁用整行，普通工具和真实工具失败仍沿原披露路径。普通目录刷新保留已观察的状态文字，`fresh=false` 停止运行动画，不建立执行或导航 authority；真实工具失败优先于子任务装饰。[消息 DOM 回归](test/isolated/desktop-agent-activity.test.tsx)核同一行的状态更新、文本选择、直接导航、旧展开状态隔离与失败边界，宿主关联和浏览器证据归 [Desktop owner](../../apps/desktop/README.md#native-当前会话环境信息与子详情)。

ToolActivity／ToolRow 用 TraceLine、Title、Icon、Description 和受控 Collapsible 承载原工具过程；`asChild`保留原按钮／div、独立文件操作、展开身份和恢复动画层。状态只消费已有执行事实，取消或结果未知不转成 Trace error；Shell 以 CodeBlockContent 保留原具名 PRE、256px输出上限、24px跟随阈值、截断、退出码和回到最新。[聚合回归](test/isolated/desktop-tool-aggregation.test.tsx)验证真实 DOM 和输出追加；正式生产样式与浏览器验证归 [Desktop owner](../../apps/desktop/README.md#会话消息渲染验证)。

工具状态 `queued` 显示“等待执行”，`running` 显示“执行中”；读取和修改行不隐藏运行状态文字，聚合仍按未结算的运行项生成活动摘要。执行权不可核实时继续停止活动提示，普通界面不追加通用异常标签；准确审批中／待人工／拒绝优先级保持。Native 的后端状态映射与对应 DOM 验证归[工具过程 owner](../../apps/desktop/README.md#原工具过程与结果阅读)。

`MessageContent` 的宿主文件回调在 layout effect 取得当前已提交值，稳定派发函数只调用这一值；正文解析组件只按原 text 保持 memo。私有 Context 将当前回调能力交给独立 Markdown 链接，能力撤销仍立即把文件按钮改为不可点击文本，重新提供及正文变化正常更新；普通回调更新与历史校准的撤销／恢复都不重新解析未变化正文。[原 Markdown 测试](test/markdown.test.tsx)通过实际 DOM 点击核最新回调、撤销／恢复、解码路径、外链和正文更新；不使用忽略回调的比较器保留旧宿主权限。实际 Native 完整历史与退出证据归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)，不据解析复用提升读取或阶段资格。

[MessageContent](src/desktop/MessageContent.tsx) 的聊天排版由[共享 CSS](src/desktop/style.css)统一管理：会话正文统一使用固定14px，不随窗口宽度调整；Markdown行高1.8，标题、代码、表格与脚注继续按正文的相对字号缩放。工具标题、过程摘要和压缩状态共用 `--conversation-text-size`，同步为14px。标题字号按层级覆盖通用页面标题，标题上方为两份正文块间距、下方一份，不随标题字号另外放大。段落、引用和代码块按正文尺寸统一块间距，避免代码的小字号缩小留白；一级列表项间距为正文块间距的2/3、子项为1/2，项内段落及代码前后保持一份正文块间距。渲染阶段在原解析树的副本上保留紧凑列表的段落节点，使代码后的文字与松散列表具有相同块边界；间距只从相邻块的起始侧提供，代码、引用或表格结束消息时不另加尾部留白。首段归零不清除文字与子列表之间的间隔，原文、任务清单状态及解析缓存不改写。正文沿原阅读列显示；代码保原换行并在块内滚动。表格使用具名、可键盘聚焦的滚动 section 包裹真实 table，表头与单元格保GFM结构和对齐，超宽内容在该区域横向阅读。稳定的表格组件保留流式追加期间的焦点和横向阅读位置；表格颜色显式继承正文，深色主题同样可读。固定GFM加公式parser与缓存、完整原文、安全链接及宿主回调规则统一。[原 Markdown 测试](test/markdown.test.tsx)核两类列表的段落、代码、子列表与预解析树保全；[语法缓存](test/desktop-markdown-cache.test.tsx)和[阅读滚动](test/isolated/desktop-conversation-scroll.test.tsx)继续核原合同，实际编译样式证据见下文。

会话间距也由这份共享样式负责：`--conversation-block-gap` 与Markdown段落共用正文字号的0.8倍；工具行已有上下各4px内边距，混合块间距扣除一份、连续工具扣除两份，因此固定14px正文下分别为文本11.2px、文本与工具7.2px、工具3.2px，宽窄窗口保持一致。处理过程以列布局统一直接子块的单侧间距，首尾按文本或工具的内部留白平衡；无轮次的原顺序消息采用同一相邻规则，展开的工具聚合列表沿用工具间距。存在最终回复时，过程容器不再提供底部内边距，由最终正文按前一项统一衔接：展开过程末尾为工具时7.2px、文本时11.2px，过程收起时与摘要相隔11.2px，避免过程尾部与最终正文顶部叠加。处理过程底部不绘制分隔线；最终回复的32px复制操作留白和用户消息原间距保持，分组、顺序、状态、折叠选择与读取权限均未改变。

2026-10-21，macOS arm64／Bun1.4.2，`a7f629960` 工作树加本次字号调整：Markdown、语法缓存、思考轮次、工具聚合、消息复制与阅读滚动六文件使用 `bun test --parallel=1 --max-concurrency=1` 执行，24项／992断言通过；定向Biome、文档结构与影响检查通过。Chrome沿实际Native Vite／Tailwind编译样式和 `MessageContent` 在深浅主题、320／767／768／1280px下核8组：正文及相关会话文本均为14px，正文行高25.2px，标题、代码、表格与脚注按原相对字号缩放，未发生页面横向溢出或脚本错误，并核对宽窄截图。编译保留既有嵌套 `@keyframes` 提示；此为组件与实际CSS证据，未运行完整安装版窗口。

轮次摘要的文字悬停样式绑定 `.agent-turn-status-label:hover`，不以整个按钮或展开状态触发；右侧空白、箭头和上下内边距保持原色，标题底色始终透明。可折叠按钮的 `focus-visible` 仍高亮文字，静态耗时只有文字悬停反馈而无新增操作，失败／停止颜色保持更高优先级。2026-10-23，Windows隔离浏览器加载实际Conversation与生产编译CSS，在深浅主题、1200／540px四组中逐步核文字、空白、内边距、箭头、展开移开、鼠标与键盘收展及静态耗时，均符合上述边界，浏览器零异常。现有轮次测试5项通过、1项既有失败：精确用户文本断言未包含当前“时间未知”展示；对应Conversation、message-time与测试文件均未改动，本次CSS不参与其SSR断言。该测试问题保留，不将浏览器样式验证表述为整套回归通过。

“用时”标题收展时，最终正文的顶部间距与过程高度一起过渡，避免关闭瞬间在混合块间距与正文块间距之间跳变、正文先下跳再收起。共享样式的 `--collapsible-expand-duration/easing` 与 `--collapsible-collapse-duration/easing` 同时供原折叠动画和该间距过渡使用，沿用展开300ms／原缓出曲线、收起240ms／ease-in-out；恢复已保存展开状态不重播原进入动画，减少动画时同时关闭间距过渡。2026-10-19同一Windows候选下，思考轮次、工具聚合、阅读滚动与复制四个整文件13项／857断言及Biome通过；Chrome155沿实际组件和Native编译样式在21组配置逐帧核84次双向收展，覆盖深浅、1280／500px、工具／文本结尾、字号、键盘及8次减少动画路径，正文无反向帧，标题无位移，普通动画保留连续中间帧。原52组长正文布局检查继续通过。此证据未覆盖完整安装版窗口。

2026-10-19 Windows x64／Bun1.4.3、`f734245a`加当前改动：工具聚合、思考轮次、Markdown、语法缓存、消息复制与阅读滚动六个整文件23项／974断言、UI类型检查及定向Biome通过。Chrome155加载实际Conversation、MessageContent、工具与NativeWindowFrame及编译样式，以截图长正文在深浅主题、1280／800／500px、放大字号、紧凑／松散列表及过程开合下核52组组合；默认工具过程至最终正文的24px叠加留白归为8px，二级标题前后从约31／9px归为24／12px，代码块前后段落间距均为12px，两类列表排列相同。另核以代码、引用或表格结束的消息至后续工具，不附加尾距；最终复制控件与下一轮消息不重叠，底部分隔线为0px，无横向溢出或页面错误。深浅宽窄两组共六次手动过程／工具聚合开合无内容裁切。此为组件与实际CSS证据，未复验完整安装版窗口。

长普通文本在 Markdown 转换后的树中拆成相邻 Text 节点，不增加包装元素、换行或省略内容，继续沿原消息列和 GFM 展示完整正文；code／pre 保原结构。超过4096个字符串单位的文本按约2048单位组织，非ASCII沿 grapheme 边界，单一更长 grapheme 仍完整保留。原文字、标题、链接、表格、图片替代文字及 HTML 处理保持；全文仍先经宿主完整 EOF／SHA／UTF-8／scope 核验，复制使用原正文，不增加读取或文件权限。[原 Markdown 文件](test/markdown.test.tsx)保全部原断言并核实际 DOM 的完整长文本与 Unicode 边界；实际 Electron 可见性与全文资格归 Desktop owner 和[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)，不据此承诺固定内存或所有设备的延迟。

原工具组件允许宿主给 `Message.target` 传展示文本，不从文本取得文件或执行权限。Native 的已知工具行沿准确执行结果与当前视图适配；未来定义／版本不借旧同名分类解释，原文仍可展开。Shell 操作继续复用原工具图标，实际身份、目标、状态与限定证据归 [Desktop owner](../../apps/desktop/README.md#原工具过程与结果阅读)。

SessionPage／Conversation 的 `renderMessageContent` 和 `renderToolActivity` 让宿主复用原消息外层、轮次折叠、最终回复复制和分组阅读状态，工具 slot 接完整分组与原展开控制；原 `renderMessage` 及未传新 slot 的缺省行为保持。`copyText=null` 表示当前正文仅可读预览，不能当全文复制；`TurnActivity.cancelling/unavailable` 只表达宿主确认的停止中／上次确认状态。ToolActivity 的 `unverified` 不推断缺少的执行状态，“状态待核对”仅在显式测试诊断中显示，已提供的真实执行状态仍优先；独立的 `Message.executionUnconfirmed` 使未结算的活动工具停止执行／审批／等待提示，保留原 status、settled 和已保存输出，普通界面不追加“执行状态待核实”。已结算成功、失败、取消及未知结果不被覆盖；混合聚合与空 Shell 输出由[工具回归](test/isolated/desktop-tool-aggregation.test.tsx)核对。这些标记仅控制展示，不建立执行结果。`openFileForMessage` 保每项独立回调，`ask.cancelled` 表达取消信息回答，与工具／Run 终态分开。准确公共 Run、原问答结果和完整正文资格归 [Desktop owner](../../apps/desktop/README.md#原轮次阅读聚合与问答回执)，纯 UI 不建立来源或业务 authority。

[ModelEffortSelector](src/desktop/ModelEffortSelector.tsx)复用原双栏浮层与 [GemSlider](src/desktop/GemSlider.tsx)。模型浮层统一使用400常规字重，提供商、模型名称与思考面板的模型按钮均继承该字重，选中、悬停或聚焦不加粗。双栏模型列表为13px／18px，两列容器共用4px外层留白与2px标题／列表间隔；标题使用与权限菜单Label一致的上下6px内边距，标题及条目的左右内边距统一8px。提供商和模型行高28px，与Composer内选择器高度一致，条目上下内边距4px；两列列表上下留白与项间距均为2px，首行、标题与条目文字对齐；仍保留288px默认高度及原Radix可用高度限制，两列各自滚动。内嵌Command使用 `rounded-none`，避免默认16px容器圆角裁切首项；浮层保持16px，提供商与模型项的四角均为8px。模型项默认沿用未选中提供商的 `--muted-foreground`，仅实际 `selected` 模型的 `data-current` 使用 `--foreground` 并显示勾选图标；不提供常驻选中底色，cmdk的第一项及导航态 `data-selected` 不改变文字颜色或产生背景。提供商与所有模型项均由各自的 `:hover` 沿用 `--control-hover`，移开后恢复透明背景。键盘导航在模型列获焦时保留独立细线焦点提示，Enter仍提交准确导航项。思考面板采用12px外层留白，标题组内8px间隔、模型按钮至滑块操作区4px间隔，使模型文字上下两段可见间距一致。浮层内滑轨高24px且无边框，保留32px操作区域与22px白色按钮；按钮在悬停和拖动时通过变换放大25%，结束后恢复，不改变布局或档位映射。仅在允许动态效果时使用150ms过渡。选中模型且宿主提供变更回调时即可调整思考程度，不接收模型支持能力开关。六档「轻度、中、高、极高、Max、Ultar」分别回调 `low/medium/high/xhigh/max/ultar`，不提供配置默认或关闭思考按钮及回调。模型按钮和浮层当前值只显示宿主明确提供的档位；未配置时不补“默认”或空的档位节点，打开滑块也不自动发送选择。宿主可传准确 `ModelOption.id` 与 `reasoningEffortChoices`；选择、列表键和当前标记按 ID 区分，同一提供商内同名模型补显示 ID。滑块映射宿主提供的六档子集；一档用按钮，零档不造滑块。旧 none/minimal 可作为已配置值显示，不生成额外选项。[浮层回归](test/isolated/model-effort.test.tsx)核无能力元数据的模型可调整与缺失路由；[Native DOM](../../apps/desktop/test/isolated/native-model-picker-dom.test.tsx)核 Ultar 回调、稀疏档位、两按钮缺席、旧 none 配置及切换模型后清除临时值。

[Desktop 构建](scripts/build-desktop.ts)在普通 workspace 与源码外候选中均输出实际 desktop/index.js 和原样 desktop/style.css，补齐新增 exports；Native renderer 编译 CSS/字体并纳入原递归 manifest。[原页面测试](test/desktop-page.test.tsx)迁回原 12 项展示断言。正式 macOS 窗口、原身份读写和剩余旧页面迁移范围由 Desktop owner 维护。

[ScheduledTasks/ScheduledTaskEditor](src/desktop/ScheduledTasks.tsx)由正式 Native 消费，支持本地任务创建／编辑、项目与模型选择、日／工作日／周频率、时间和时区，以及启禁、立即运行、删除确认、运行记录与原会话入口。事实和行为均来自宿主参数，UI不调度或调用模型；异步失败保留字段，pending阻止重复点击，缺宿主保存回调仍禁用。SessionPage 每次打开编辑器绑定独立代次，关闭后再打开同一或其他任务时，旧保存结果不能关闭后来面板。工作树只显示禁用选项。验证见[DOM测试](test/isolated/scheduled-tasks.test.tsx)，真实持久化与权限归[Desktop owner](../../apps/desktop/README.md#native-安排任务草稿)。

原 SessionPage 欢迎区、建议、项目／分支菜单与 Composer 已接正式 Native 新对话准备。纯 UI 只追加／聚焦草稿和回调宿主选择，项目字段承载宿主 ID，不据此读取目录或执行 Git。创建、权限、实际模型及首次消息接管归 [Desktop owner](../../apps/desktop/README.md#native-新对话准备与首次发送)；不将准备页状态转为 Session 或执行 authority。

原 [BackgroundExecutions](src/desktop/BackgroundExecutions.tsx)环境信息卡已由 Native 的 SessionPage 消费，保留 Shell／子 Agent 分组、名称、当前任务和子详情回调。宿主可声明 queued／starting／unknown／restored 状态；当前环境模式 `currentOnly` 的 Shell 由宿主先核验后台启动来源，再保留运行／停止中；前后台身份归 Native 适配，UI 不按取消关系推断。Shell 逐项 `canStop=false` 或缺少停止回调时不提供停止入口；子列表保全部记录、状态和只读详情，并通过原 `stoppingExecutionId/onStop` 操作宿主已核实的新鲜准确 carrier。旧状态、unknown、恢复历史或宿主未提供停止资格时不可停止；回调保原 Execution／task 范围，不从同一 child Session 推断最新目标。状态本身不证明进程清理。300px 卡及宽窄窗口停靠／浮层仍由原 SessionPage 管理。卡片采用12px上下、14px左右留白；空分组在标题同行显示 Shell“空闲”或子智能体“暂无”，不重复显示零计数和独立空状态。环境状态由宿主通知自动更新，标题不提供手动刷新按钮；有记录时显示计数、列表及原操作；Native 宿主在读取失败后保留原内容并后台重读，普通环境卡不追加异常文案或临时重试按钮。停靠时共享 CSS 先利用 844px 阅读列右侧的留白，再按可用宽度将右侧占位限制在 28–344px；不再固定缩为 720px。留白足够时正文和输入区的原位置与宽度保持，空间不足时才调整。停靠栏因宽度不足收起时恢复 `default` 偏好，拉宽后自动停靠；显式 `closed` 保持关闭，窄窗仍可手动打开浮层。原滚动条和动画保持。完整目录、准确停止、只读子详情和草稿往返归 [Desktop owner](../../apps/desktop/README.md#native-当前会话环境信息与子详情)，UI 不取得新执行或读取 authority。

自动权限审核的当前投影读取 `authorization.check`，展示状态使用 `checking`／`auto_checking`／`queued_auto_check`；旧 `authorization.review` 及其历史展示状态仅兼容读取。TUI 与 Desktop 的实际子 Agent 均沿通用类别和相同消息组件展示，`review` 类别不建立独立 Agent 引擎。自动权限审核和标题内部 Model 不进入子 Agent 投影、数量或步骤；目录边界来自 Core 的实际记录，不依靠 UI 隐藏。权限证明与原子派发仍归 Agent，UI 不从状态授予执行权。

原 [Approval](src/desktop/Approval.tsx)经 `InteractionCard.renderApproval` 接入宿主，保留“批准一次”、拒绝和分体范围菜单；只有实际 `same_command` grant 才显示“本次会话批准”，辅助文字明确仅本次及本会话相同命令。工具类型与单行省略的等宽正文分层，悬停／聚焦沿现有 Radix Tooltip 展示全文，详情入口退役。[ApprovalHeader](src/desktop/ApprovalHeader.tsx)承载右上逐项分页、紧跟标题的子名称及固定彩色图标，主 Agent 不显示名称；图标仅按宿主交付的准确随机 Session identity 稳定分配，不依赖可改名称或渲染次数。`embedded` 去除重复标题和外框，独立按钮、grant 与 disabled 语义保持。slot 只接原卡、disabled、原完整附件正文与已获准的回答回调；紧凑模式自动读取并核对原完整附件，失败可重试，未验证时没有回答回调，换卡即失效。MCP／问题／计划仍沿独立表单。ToolActivity 的 `submitted`／`unavailable`／`cancelled` 与 `dispatchCommitted` 只表达宿主确认的审批和派发事实，不把批准当工具成功；准确来源、accepted decision 和原提交链归 [Desktop owner](../../apps/desktop/README.md#原审批面板与授权观察)。

[QueuedMessages](src/desktop/QueuedMessages.tsx)由 Composer 的可选 `queue` 接入，在同一外框顶部显示受控 pending 条目。真实 Markdown 经原 [MessageContent](src/desktop/MessageContent.tsx)安全解析；预览将块元素压为单行并省略，Tooltip 展示完整 Markdown，保持禁 HTML／远程图片获取的原合同。无序号或额外业务状态串；可折叠，常显手柄、编辑和删除。原生拖拽及手柄 Alt+↑／↓只交付当前完整 ID 排列，拖拽中成员变化拒绝旧操作；所有内容移除、变更和异步状态均由宿主确认，不维护乐观副本。`editable:false` 仅禁编辑，附件等条目保删除和调序。编辑成功后的普通 `draft` 仍由宿主 `onChange` 管理，`queueFocusKey` 只在同 scope 变更后聚焦并移 caret 至末尾，暂时 disabled 等待解锁，换 scope 不抢焦点；没有编辑模式或取消／恢复逻辑。[队列 DOM](test/isolated/desktop-queued-messages.test.tsx)核委托回调、完整 MD、Tooltip／Escape、折叠、迟到拖拽隔离、pending门禁与聚焦，服务撤回和未知结果归 [Native owner](../../apps/desktop/README.md#原运行中消息队列)。

Conversation 在调用宿主 `renderMessage` 之前统一排除 thinking、timing、terminal 内容。只有结构标记的准确 Turn 保留一个原顺序锚点和静态状态行，不产生空折叠控件；有可读正文或工具的 Turn 沿用原分组，隐藏思考不会打断相邻探索聚合。已确认终态的原 Turn 不因遗留 incomplete 前缀继续标记忙碌，其他活动 Turn 仍保持实际状态。过程 Collapsible 以原 Turn 的 process／complete 阅读 key 区分生命周期，终态重分组直接进入关闭状态，避免旧过程在退出动画中与最终回复同时重绘；手动展开与收起保留原动画，工具展开选择仍由 Conversation 阅读状态保存。单条工具详情与工具聚合使用独立的阅读 key，聚合使用宿主的 `presentationGroupId`（缺省回退首项 ID），不随首个回执替换而重置；阅读缓存按仍存在的分组身份裁剪。新形成的聚合默认收起，后续增加工具和状态更新保留用户对聚合的选择。ToolActivity 的 `renderItem` 只替换组内单项，原组壳和开关仍由组件管理，让宿主把未核实原记录保留在独立的逐项展开内；缺已识别 toolName 时不把原始 text 作为收起的错误预览，实际状态仍显示。[聚合 DOM 回归](test/isolated/desktop-tool-aggregation.test.tsx)核活动聚合、单项升级、手动选择与后续更新。[思考轮次回归](test/desktop-reasoning-turns.test.tsx)核宿主不接收原思考、无正文终态／耗时／原用户顺序、无空控件与工具聚合。

## 公共表单与观察

普通问题共用中立的 [原 schema 解析器](src/question.ts)。DOM [Questionnaire](src/questionnaire.tsx) 为完整可表达的标量或浅 object 提供单选、闭合自由输入与多步骤；可以先浏览未回答的题目，最终明确点击提交时才发送完整答案。原字段和 choice 值、Unicode codepoint 长度与非空白约束保持；仅闭合浅 object 加明确 null alternative 的根 oneOf 可作为整份问卷的另一项决定，其他未知或重叠约束仍回退原 JSON。选项说明以悬停／聚焦浮层展示完整原文，不推移翻页按钮；翻页和最终提交保留不同按钮身份，避免浏览器将末次翻页解释为提交。

结构化问题的可作答卡片使用共享选择行、推荐标记、紧凑说明按钮和同一操作栏；已知 `Cancel answering` 展示为“取消回答”，原 null 值保持。可作答卡不显示 kind/state、原请求或执行身份，原文和 choice 值仍用于提交与恢复；只读卡及 JSON fallback 保留原材料。对应样式由 [Desktop CSS](src/desktop/style.css)提供，深浅主题与窄窗共用。

`InteractionCard.initialQuestionDraft/onQuestionDraftChange` 与 `ActionInputForm.initialDraft/onDraftChange` 将草稿生命周期交给实际宿主，既覆盖步骤也覆盖原 JSON fallback。`questionDraftKey` 固定 Store、source/presentation Session、Interaction ID、revision 与 inputDigest，不以连接 generation 另建草稿。组件自身不从 Promise resolve、卡片缺席或状态查询推导保存成功；Native 宿主按原准确回执清理。只读卡仍显示原完整请求与身份，缺回调没有作答入口。[DOM 验证](test/questionnaire-dom.test.tsx)核完整原值、空白拒绝、翻页零提交和重复抑制；实际 Native 窗口与页面生命周期由 [Desktop owner](../../apps/desktop/README.md#native-普通问题与页面草稿)维护。

`@kite-ai/ui` 是新 Client 的基础共享展示库，依赖 React 与 `@kite-ai/client`；不拥有执行、连接准入、存储或服务器实现。正式 Terminal 已消费[独立 TUI 入口](src/tui/README.md)，普通问题的原 schema 步骤与答案范围由该 owner 维护；完整客户端能力与发行资格仍按各客户端证据核对，权限保持其手册定义。

[PublicViewCard](src/index.tsx) 消费生成的 PublicView，展示摘要、content type/version、完整 JSON payload、附件引用和宿主显式提供的动作回调。未知内容与版本仍保留原始公开对象，缺少专用 renderer 不隐藏结果；没有回调时动作禁用。连接状态由宿主提供，组件不从没有更新推导执行终态。

[ActionInputForm](src/index.tsx) 只维护当前草稿，提交给宿主提供的回调。不允许额外字段的简单 object schema 支持 string、number、integer、boolean 与字符串 enum；嵌套、引用、复杂组合或未知约束明确使用原始 JSON。UI 不替代 Service 的完整 schema 校验和授权。命令 ID、目标 Store 和重试由宿主与 Client 契约决定，不由表单自动生成。

验证：`bun run --cwd packages/ui typecheck`、`build`、`test`。测试核对纯输入投影、数值精度、复杂 schema 退化与未知内容保留；完整 Web/Desktop 产品入口、浏览器交互和原生制品验收仍由对应阶段核对。

P3 的 `InteractionCard` 直接消费生成的 Interaction：真实来源 Session、根回答 Session、祖先关系、Run/Execution、定义版本、输入摘要、策略版本、requiredRefs、准确原请求和决定版本分别保留。审批缺省发送 `grant:approve_once`；只有原 `request.grants` 实际包含 `same_command` 时才提供“本 Session 相同命令”独立选项，发送 `grant:same_command`。所选范围作用于真实来源 Session，展示根不改写批准 scope。deny 不携带 grant；question 按实际 `request.schema` 使用基础字段/内部 enum ID，复杂或未提供 schema 明确退化为原始 JSON。没有回答回调时只读；plan_review 展示已有实际记录，有限信息答复按下文契约处理，不提供虚构计划执行或完成状态。回答面板分别显示 saved/submitting/command accepted/unknown/failed，command accepted 不等于 Core 已接受 decision 或执行已成功。

表单同步阻止同一 render 中重复提交，失败保留草稿和请求。验证包括纯 React element 投影（不是浏览器 DOM/键盘验收）、schema 函数和配套薄客户端真实 HTTP 链路；正式 Web/Electron/TUI 入口和可访问性端到端资格尚未由这些测试建立。

便携 Context 切片提供 `ContextPanel`：显示准确 selection、范围、消息及两个独立分页游标、结果 source ID、原 Execution/revision/Store 与 automatic/explicit 来源。历史 Job 的 `suppressed/context_rewound` 明确表示被当前选择隔离，原执行效果仍保留；缺少原 Store 字段时显示出处 unavailable，不补当前 Store。Rewind 提交精确消息 ID/seq 或显式空边界，最终完整消息/Tool 配对边界由 Service 校验；Include 保存原结果来源，不重放执行或自行开始 Run。没有写入回调时没有操作入口；Rewind 在活动/未核实执行时禁用。Include 可在准确 active Run 上显示目标并封存原 Store/Session/selection/Run envelope；缺出处、revision 或准确 Run 时禁用，idle include 不带目标 Run。读取固定选择与上界的下一页是独立只读回调。

`ContextSubmissionNotice` 显示原 command 与 saved/submitting/queued/applied/unknown/failed 事实；保存来源不等于模型已读取或执行成功。queued 明确等待原 checkpoint，尚未纳入；applied 仍不证明模型正确使用。Context UI 同时包含纯投影与 [test/context-active-dom.test.tsx](test/context-active-dom.test.tsx) 的实际 JSdom 点击、目标准确性和缺目标禁用验证；不声称原生浏览器或正式客户端迁移完成。


有限 `plan_review` 答复只在请求提供 planId/version/digest/content 与非空、无陌生值的 allowedModes 时开启。支持模式仅 `auto`、`accept_edits`（严格取请求提供的子集），批准要求用户显式选择；Full 不在选项中。缺失/陌生 metadata 或 modes 保只读说明，并仍显示完整原 request；未知身份字段明确 unknown。反馈最多 8192 个 JavaScript 字符串单位，原空格、Unicode 与换行保留，deny/revise 不携带 mode。信息回答不改变默认权限，不证明计划已满足业务 required evaluator，也不证明执行或完成。

`PlanReviewDraft` 与 `initialPlanDraft/onPlanDraftChange` 让宿主以原 Interaction 身份保存显式模式与原反馈。表单事件同步通知宿主，同一 render 重复提交受原锁约束；失败不清理，Promise resolve 也不冒充准确 accepted 回执。完整 canonical `plan_document` 的 ID/version/digest 与原 request 相符时，以安全 Markdown 展示完整正文和步骤；陌生格式保留完整原文。大附件仍先沿原 reader 完整验证，未完成读取时不提供答复，原完整附件另可展开核对。[实际 DOM 测试](test/plan-review-dom.test.tsx)核原草稿恢复、显式模式、一次提交与失败保留；宿主的页面生命周期、Main 读取证明和真实窗口资格归 [Desktop owner](../../apps/desktop/README.md#native-计划入口与完整审核)，组件不取得 I/O 或批准权。


`InteractionCard` 的 `onReadAttachment` 是可选宿主回调，只接受原公开 reference 的准确 Store、Session、scope 和元数据。大审批附件在完整读取、SHA-256 与严格 UTF-8 校验成功后展示全文；缺 reader、加载中或失败时保留原卡并禁用回答。取消读取、替换卡片、切换身份或卸载只释放视图等待，迟到正文不能成为另一卡的已读证明。组件仅在当前视图保存正文，重复键盘/点击同步抑制，不把正文存入控制器验证集合。无附件的原审批行为保持不变。

[test/attachments-dom.test.tsx](test/attachments-dom.test.tsx) 使用实际 ReactDOM/createRoot 和 JSDOM KeyboardEvent 验证 Enter 提交、重复抑制、缺 reader/错误正文、迟到身份响应；另以真实 Service/SQLite/ArtifactStore 的超过 17 MiB Auto 人工附件核对完整 DOM 正文再提交原审批。该测试建立便携组件的 DOM/键盘证据，不代表正式 Electron/TUI、真实浏览器布局或完整可访问性资格。


`SafeMessageMarkdown` 使用 react-markdown 与 GFM 渲染完整原正文的标题、段落、列表、代码、引用与表格。原 HTML 转义为文字；图片只显示 alt，不请求资源；相对文件与不安全 scheme 链接只显示文本。HTTP(S) 链接需用户主动打开并隔离 opener。组件只接受正文，不拥有网络、Token、编辑器或阅读缓存，正文宽度由宿主消息列决定。

[test/markdown.test.tsx](test/markdown.test.tsx) 验证上述安全边界、标准结构与完整长正文。Web 的 DOM 阅读测试另覆盖会话选择范围与位置恢复；这些不构成原生浏览器布局、选区或滚动资格。

`PermissionPanel` 只消费公开 mode/trust 事实，新模式仅提供请求批准（`accept_edits`）、自动审核（`auto`）、完全访问（`full`），与以后会话默认值分别确认；当前与默认模式继续显示原始事实；旧 raw `ask` 已从类型、输入和显示路径退役，不作兼容映射；信任前展示 actual readScopes 和原范围摘要，用户须明确核对。子会话或无 callback 时只读，未决/未知提交禁写；一份观察只提交一次，失败保留选项，不显示已应用。`PermissionSubmissionStatus` 将原 command 的已保存、提交中、已应用、未知和失败分别显示。新身份卸载旧面板，旧异步结果不能覆盖新卡；组件不持有凭据、服务器、文件或执行控制。

[test/permissions-dom.test.tsx](test/permissions-dom.test.tsx) 使用实际 ReactDOM/JSDOM，验证 Enter/空格键选择、重复键盘/点击抑制、模式/default、未确认 trust 禁用、原读取范围、子会话只读、失败草稿及迟到身份响应；正式 Electron/TUI 与真实浏览器布局仍未由本证据建立。

`ModelOutputMessage` 消费公开 `Message.outputBody`，默认明确显示有限预览，不把预览声称为完整输出。宿主可提供 `onRead({sessionId,executionId,signal})`；该 reader 必须先通过公共 Client 的完整 EOF、SHA、UTF-8 与正文验证，再返回 `ModelOutputSnapshot`。组件复核原 Store、Session、Run、Execution、完整性与正文长度；缺省只在当前视图保存已读全文。显式关闭、`suspended`、身份／预览更新或实际卸载会 abort 所属读取并清除全文，迟到结果不能显示。可选 `onClose` 只通知用户明确关闭全文，使宿主能够单独撤销复制展示资格，不把临时读取暂停的 `onContent(undefined)` 混同为关闭；原通知、读取取消和身份校验不变。宿主 KeepAlive 停用时仍 abort 原 lease，但可保留同一已核实身份的显示；可选 `readActive=false` 撤销新读取与正文通知，重新激活后用当前回调恢复，不从保留状态取得操作资格。临时 `readActive=false` 以 `aria-disabled` 和读取 handler 的 gate 暂停动作，保留按钮外观；缺 reader 时预览仍可读，全文按钮禁用；失败不展示半正文。原完整 Tool calls 需用户展开，不完整前缀不显示完整调用。原 reasoning 缺省不展示；只有明确诊断宿主设置 `showReasoning` 才提供展开入口，普通会话阅读不启用。

`onContent` 只通知当前准入视图已显示的完整正文，回到预览、停用或 `readActive=false` 时通知 `undefined`，供宿主准确复制；组件不拥有网络关闭或 Runtime 取消。[Model output DOM 测试](test/model-output.test.tsx) 验证超过 17 MiB 的完整尾部、显式读取、single flight、关闭/身份变化/隐藏的 abort 与 late 隔离、缺 reader、身份冲突和不完整前缀。它建立 React/JSDOM 证据，不代表真实浏览器、Electron 或 TUI 资格。

宿主已经完成公共 Client 的 EOF／SHA／UTF-8 验证时，可直接提供 `verifiedSnapshot`，组件仍核同一 Store／Session／Run／Execution、complete、正文／reasoning字节数和toolCalls，再呈现原正文或已保存的未完成前缀。关闭后可本地重开，不重复下载；宿主替换 snapshot、暂停、身份替换和卸载均撤销旧读取。该 prop 不接受未验证 transport 数据，也不赋予组件网络或执行权。

桌面 `SessionPage` 的[阅读状态缓存](src/desktop/reading-state.ts)只保存滚动与展开数据，最多32项、256KiB估算载荷、每项512个展开ID；保存时裁剪当前消息中已不存在的展开项。`Conversation`一次建立各轮运行工具和thinking集合，避免每轮重扫全部消息。缺省切换仍卸载原消息DOM和effect；Native 通过可选 `conversationCache` 启用下述有界停用树，不保活全部会话；[阅读缓存回归](test/desktop-reading-state.test.ts)核容量、淘汰和裁剪。恢复时，原轮次过程与工具层分别用 `data-restored-expanded` 跳过自己的展开动画，包括未显式选择但默认展开的活动轮次；后续手动开合清除本层恢复标记，父层标记不抑制嵌套工具的手动动画。[轮次回归](test/desktop-reasoning-turns.test.tsx)与[Native 往返回归](../../apps/desktop/test/isolated/native-history-presentation-dom.test.tsx)核恢复和手动选择。

[ConversationCache](src/desktop/ConversationCache.tsx)为最近3个非当前会话保留原 portal 容器、组件状态与 DOM，停用容器脱离可见文档，Activity 统一清理 effect。DOM 与宿主登记的媒体估算合计总预算16MiB／20,000节点，单项8MiB／10,000节点，超过预算先淘汰最近最少使用项；活动超长正文不裁剪，离开后可释放。新 scope 清全部，revision 清非当前项，实际失效由宿主定义。命中项在新数据未就绪时先显示原树，fieldset的 `aria-disabled` 和事件捕获隔离旧操作，保留原透明度与悬停命中，不用原生 `disabled` 或 `inert` 改变整树外观；`readActive` 与当前本地展开的 `interactive` 分开，显示不成为读取权限。恢复的展开和 Markdown 节点沿原组件保留；容器捕获嵌套区域的实际 scroll 位置并在重新接入的 layout 阶段恢复，丢弃已移除节点，不覆盖 Conversation 自有 viewport 的跟随／手动策略。计时在临时不可读时冻结已有文字。缓存资源通过 `useConversationResourceRetention` 登记给 Activity 外的 entry owner，停用时保留已核验资源，真正移除、淘汰或 scope 失效时释放；窗口隐藏统一释放媒体。资源仍计入原体积预算，不声称限制解码后的像素、完整 snapshot 或总 heap。重新接入的首个绘制周期暂时取消后代过渡，随后恢复正常交互动画；复制反馈停用时清计时器，恢复时按原到期时间继续，不能由迟到的剪贴板答复改写。纯 UI 不导入 Native／Runtime；[缓存 DOM 回归](test/isolated/desktop-conversation-cache.test.tsx)覆盖节点身份、原 textarea／表格状态、LRU、条数／体积／节点预算与100轮 effect 清理，[全文回归](test/model-output.test.tsx)核 Activity 停用后原全文 DOM、lease abort及late隔离。详见[取舍](../../.agents/notes/implemented/architecture/2026-10-19-native-conversation-dom-cache.md)。

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

[真实四卡 PTY](test/isolated/tui/pending-cards.test.ts) 在 owned Core/Service SQLite、80×24 中同时保持两个 sibling Ask Tool、root question 和独立 `required-verifier` ordinary Job，按 root-first/job-first 顺序分别批准。真实 parent/child intersection 70KB policy 的完整 artifact 由公共 SDK reader 核 hash/原 scope，缓存切换不重复读取；首 POST 与首原 GET 回应物理丢失后只查原 answer Command，实际两 child 效果与 Job 各一次。该 configured ordinary Job 不是 `skill.workflow.verify`；Workflow verifier 的真实审批另由 CLI Workflow question/compensation fixtures 验证。revision 清理和迟到选择由 Ink 反例核对，不代表同四卡窗口内实际改变后端 policy 的资格。


开发 TUI 的 `/rewind` 现在通过有限 `TuiFileRecoveryPort` 读取实际 Files 恢复点、预览与原两 leg，支持仅会话/仅代码/两者；它不持 profile、文件或热 POST permit。普通审批、已确认 Code 后的明确 Fork 继续、unknown 原 GET 与关闭/切会话的迟到隔离见 [TUI owner](src/tui/README.md)。实际编译 PTY、强杀与丢回执证据归 [CLI host owner](../../apps/cli/README.md#files-三范围恢复-caller)，不据此宣称正式旧入口、Native 或所有平台已完成切换。


[MCP Source Review](src/mcp-source-review.tsx)只接受准确来源批准或既有opaque Ref binding的问题：闭合原schema/choices/read-set与安全身份，显示完整原请求，提交准确decision。非法或未来Source request保只读，不退化为任意JSON答复；同定义产生的普通approval仍保独立Approve once，不能因definitionId被误当Source question。[实际DOM测试](test/mcp-source-review.test.tsx)核Source答复和普通审批分离；正式Native窗口与Main再次核原答案的证据归[Desktop owner](../../apps/desktop/README.md#native-mcp-完整设置)。


[completeRunReplies](src/run-reply-copy.ts)是两个正式宿主共用的纯回复资格与正文投影；宿主交准确原 Run、完整已读 Message 和当前 verified full-content callback。它以准确 completed／inactive 及完整最终回复核资格；Web 使用 `copyScope=run` 按严格 Decimal64 顺序合并同 Session／同 Run 的未封存助手正文，以空行连接。Native 显式 `copyScope=final` 保桌面手册只复制完整最终回复、不含同轮工具前说明的合同。两者均不加入 Tool 参数、结果、reasoning、其他 Run 或子消息；各自复制范围内非零 body-backed 段均须由宿主当前 reader 提供完整正文，缺失／不完整／未来格式不拿预览补齐。该 leaf 没有 I/O、cache、剪贴板或新 authority；[纯契约](test/run-reply-copy.test.ts)与两个宿主的实际消费分别证明选择和读取边界。

桌面 [ToolActivity](src/desktop/ToolActivity.tsx)消费宿主已核实的 `decisionRefresh/not_executed`，将正常未派发的重新评估与真实执行失败分别计数，并保留逐项原因；该状态不由原正文或通用错误字符串推断。[桌面契约](test/desktop-page.test.tsx)与 [Native 实际 Main→transcript→组件](../../apps/desktop/test/isolated/native-tool-messages-dom.test.tsx)验证混合状态，缺少派发证据不隐藏失败。

共享 [completeRunReplies](src/run-reply-copy.ts)仅对准确 completed 且非 active 的 Run 建立最终回复资格，排除带原压缩身份的 assistant 消息；Native 最终复制与 Web 整轮复制均不包含压缩摘要。完整模型消息仍可能是候选或维护输出，不能先于真实 Run 完成显示为最终结果。回归见[最终回复复制](test/run-reply-copy.test.ts)与[Native 实际链路](../../apps/desktop/test/isolated/native-transcript-dom.test.tsx)。

桌面 [Conversation](src/desktop/Conversation.tsx)的压缩状态使用普通 `Marker`，按工具消息标题的字号、行高和上下留白左对齐显示，不绘制文字两侧的分隔线；进行中扫光、失败颜色和具体错误说明保留。

## 选中与重连的后端状态核实

[TuiController](src/tui/controller.ts) 的明确 `select` 默认先等待宿主可选 `reconcileSession` port，再读历史；普通刷新显式传 `reconcile:false`；同会话激活尚未完成时等待其核实与历史读取，不中止核实或重复写入。失败仍读历史并保留内部失败事实，普通会话在后台退避重读而不另加异常横幅或 Error 行，切换／取消后旧结果不发布，等待中的旧刷新也不能重新选中原会话。写入与 capability 核验归 [CLI Host](../../apps/cli/README.md)，纯 UI 不取得 authority。[选择器测试](test/tui/session-chooser.test.tsx)核顺序、跳过及失败阅读。桌面持久终态优先于 `executionUnconfirmed` 回退；后端与原恢复边界归[Core owner](../agent/src/storage/sqlite/run-resume.README.md#会话恢复时的状态核实)。
