# Agent Note: Native 浏览器由原生视图拥有可视边界

Status: proposed

## Problem

普通窗口缩放使浏览器呈现不断进入主动 hide、旧 PNG 衔接、两次 Root witness 后再显示。连续 proposal 会延长旧 viewport／黑空阶段。保留页面身份与最终恢复并不证明中间画面正确。直接提前移动 Native 则可能覆盖仍按旧布局显示的聊天。

用户于2026-10-31重新提出缩小闪烁，并明确同意继续此前暂缓的呈现结构调整。浏览器工具、原页面／incarnation、租约、任务与进程生命周期边界仍适用；不增加 Agent Loop 或工具版本。

## Proposal

Main 以统一布局批次拥有聊天 Root、右侧 Chrome 条带、网页和输入屏障的真实边界。普通 browser-live 不使用旧网页图像替身，也不通过隐藏真实页来等待 Root 帧。

原 Root 保唯一 tab model、权限／observer、草稿、注释与业务 handlers。右侧独立 Renderer 只收有限展示快照并返回白名单 UI 事件，不取得 NativeBridge、Service caller、执行代码或通用 CDP。普通 browser-live 使用该宿主；非浏览器 reader、起始页、注释、全局覆盖状态恢复原 Root 完整展示，保留原网页。

Root 必须使用自身的原生物理边界；普通父 View 与正半径 clipPath 在本机没有裁剪 WebContentsView 子项，不能据图层树或数学 bounds 假定物理裁剪。保留完整逻辑窗口宽度的候选使用 Main 独占的固定 UI viewport 设置，需先实测其实际尺寸、字体、坐标与命中。它不作为代理能力，不进入 browser_execute、页面 registry 或 Service 工具端口。若不成立，需重新评估逻辑布局，而非放宽目标／输入门禁。

## 统一尺寸提交（本节已实施，整体视觉资格未完成）

用户在只读审查后确认实施：保留窗口事件与Renderer真实量测两种输入，由原Browser controller持有唯一的最终几何计算和差分应用入口。窗口事件立即使旧坐标失效，再合并投影更新；同步量测仍核原scope／revision并按原回执要求进入相同入口。相同输出跳过原生属性写入，实际不同的校准可以再次应用，不能强求一次拖动只执行一次。

Chrome host撤除独立resize调度，layout不再顺带请求Root viewport。Root CDP仍由原host拥有，启动／释放／文档或连接代次变化与普通缩放统一按desired／inflight／applied比较，成功才记录已应用；A已应用、B在途、最新又为A时必须最终恢复A。同值命令省略不能省首次prepared／绑定确认。业务状态、地址输入echo、witness／ACK、准确目标和权限核对不按矩形相同跳过。

本次保留同步IPC、首次与兼容路径的两步witness，以及Root启动／非托管窗口职责；隐藏／关闭／切scope使旧任务失效。复用现有布局状态和队列，不新增通用布局框架或协议版本。统一Main写入只说明命令组织，不能当作系统画面同帧提交保证。验收分别核同值去重、有效校准、A→B→A、晚到任务不复活、启动与真实缩窗；不以减少调用宣称灰带已消除。

本节已按上述边界接入并完成135项1697断言、类型／格式与边界核对。冻结组件实机保受控页及公开HTTPS原文档，007私有计数为77次metrics、相邻同参0、同值bounds写0，模型账本仍504；真实开发启动正常。007恢复扩窗的process PTS3.425000和display PTS3.466667仍见窗口内窄深灰带，因此本节去重完成不改变整篇proposed状态或整体无闪烁未通过事实。原始失败、过程与资格完整归Desktop owner。

## 本轮范围与收尾

2026-10-31用户在两项原生候选验证后明确选择“先保留当前实现，明确保留缩放缺口”。当前已接入的原生分栏及统一尺寸提交／去重保持，不继续引擎补丁、结构试验或重复实机；失败候选不接入普通客户端。此决定仅结束本轮实施与调查，未将缩窗空带／闪烁判为通过，也未降低原产品预期。整体Note继续proposed，保留已实施部分、未取得资格和原反例；文档收尾复用未变源码的既有验证，不新增模型或客户端。

## 未托管Root双击缩放回归

用户随后新增反馈：未打开浏览器时普通窗口双击缩放也出现更明显黑边。原BaseWindow改造将非托管Root尺寸更新延后到setImmediate，使其在原生动画回调中保留上一尺寸；最小修复让未托管Root在自身resize回调内同步跟随全窗，已托管浏览器仍归原controller布局和裁剪。Root不再加入共享队列，不改变页面、观察、输入或回执；同值bounds仍省写。

同Electron冻结修前／修后工厂的真实双击对照确认大L空区回归消除；最新开发UI连续过程也未见大空区、整块黑空或旧布局回闪。BrowserWindow基线与修后均仍有细窄暗边，不能将此局部回归修复改写为全局无闪烁。该新失败只重新打开未托管Root职责，不恢复引擎补丁或此前右浏览器缩放试验；不以内容视图重挂扩大焦点、输入盾和兄弟视图的生命周期范围。实际源证据及38项296断言归Desktop owner；整篇仍proposed。


## 稳定hosted量测的异步边界

用户新增已打开网页后快速拉伸卡顿，原慢速验收未覆盖。本轮先移除同值present重复装饰，但高速反例仍在：Root量测sendSync等待Main，在原生live-resize期间阻塞Root绘制。仅窗口尺寸变化时切异步的候选仍会在同尺寸回程与ResizeObserver重入时重新同步，实测停顿更长，故否决；不将该候选或去重计数写成卡顿解决。

当前稳定hosted正向校准全部沿原channel的异步invoke，最多一个在途，后续完成时重测当前DOM；不保留过时矩形队列。Main在修改witness／revision／anchor前验证当前几何、active／visible、已有presentation、准确scope及Chrome binding，异步入口不能bootstrap或复活已撤页。首次绑定、bootstrap、未托管兼容路径与旧preload仍同步；hide不等待正向队列，卸载和scope变化拒绝迟到回复。该部分替代上节“保留同步IPC”的稳定hosted范围，不改变首次与兼容同步回执的理由，也不改变统一Main几何owner、工具或协议版本。

相同高速助手的冻结组件及最新完整开发UI已记录Root响应性改善，纯分栏也未回入同步；定向边界回归及当前连续画面资格归[Desktop owner](../../../../apps/desktop/README.md#macos-原生分栏与浏览器工具栏2026-10-31)。这是响应性修复，原生窗口宽灰余带仍有反例，整体Note继续proposed。Main／preload须完整重启才加载，Renderer HMR不能升级已运行的旧桥。


## 完整开发客户端的scope读取与原生跟随

用户随后确认组件例子较快、完整desktop:dev即使空会话也慢。真实开发链显示几何和DrawFrame节奏比rAF稀疏，不能用旧约9ms的JS回调授画面帧率。实际Main scope getter反复调用完整Caller state，连无关UI提交记录的同步读取、解析与克隆一起完成；组件夹具的常量scope不能覆盖该成本。

当前NativeCaller的窄browserScope与state共享同一选中快照、lastView和unavailable逻辑，不缓存authority，也不触碰原journal及持久提交／查询校验。原loading、观察／权限失败、ABA和presentation/input差异保持。仅提前原生布局而保留该成本的候选使Root绘制更差，故未采用；在窄读后，同客户端对照才同时支持几何和内容提交改善。

prepared hosted页现于原生resize回调内沿原唯一几何入口投影，先废旧坐标并取消之前bootstrap任务；启动和恢复仍排队并即时更新输入屏障。此处替代前文稳定hosted排队phase，保留bootstrap队列的适用理由；不引入定时阈值、图像替身、权限缓存或引擎补丁。最后真实开发源码的独立追踪与连续画面、失败候选及未覆盖资格归[Desktop owner](../../../../apps/desktop/README.md#macos-原生分栏与浏览器工具栏2026-10-31)。灰带和局部裁切仍有实证，整体Note继续proposed，不把该局部性能改进当作像素同步保证。


## 右栏拖动折叠的撤销边界

实际折叠可见性必须由实时layout通知投影，完成通知只确认显式关闭意图；否则拖到零宽、尚未pointerup时仍会向Chrome发布visible。实机已证Main先hide又在16ms后沿旧drawnRequest恢复，因此仅补UI时点不足以约束晚到准备通知。已通过scope/revision校验的普通Renderer显式hide现退休旧drawn证明；内部onSuspend临时隐藏及专用presentationKey交接仍保原bootstrap依据。恢复需要新的有效量测，页面本身和控制租约不与呈现一并销毁。稳定正宽同值通知早退，不新增每像素布局读取；原例、修后真实边框收起／闭栏缩窗／原页重开及视觉限制归Desktop owner，整篇proposed资格不变。

## 连续约束历史与原位切页

分栏在最小宽度处改变后续相对比例，不能把每次原生预测都视为从早先Renderer比例出发的独立计算。真实Panel回放和实机同宽分界反例支持单独推进native预测历史；新的准确Renderer量测仍重置预测，原观察、drawn和输入proof不受预测改写。同尺寸复用避免累计舍入，预测状态不成为新的authority。

已加载页的切换不应每次撤掉整个物理宿主。保留后台资料端口、在layout阶段先发布新目标，只让可见owner安装呈现effect；否则旧inactive cleanup会在新目标绑定后再次发hide，这是实机IPC已证的撤销竞态。Main只对同scope、同Root环境及已确认原页原位轮换wire身份，旧页隐藏、新页重新ACK和量测，交接未确认有界回完整Root；关闭、跨scope和错误仍走真实撤下。006实录证明只保宿主仍有正文灰空，不能把setVisible成功当首帧就绪。后续短期交接只保准确旧live页，在已完成准备的原生shield保护下，等新目标自身一次完整当前帧，再撤旧页；保持旧层不拆装，把hidden目标插到它下方。内部帧只作就绪门，不保存／展示／借作新目标的模型观察；每页单在途，scope／导航／几何／Root等失效与1500ms期限按单次key退休。模型／租约不转给新目标，不以全局吞键保护代替原生输入屏障。剩余空带／分步绘制及实际像素资格继续由Desktop owner如实维护，整体Note仍为proposed。

## 新建、导航与关闭的呈现交接

007的稳定已加载互切没有覆盖新建B导航和当前B销毁。008真实返回A取得标签／工具栏／正文整条灰空，说明网络loading=false也不构成当前呈现就绪；UI关闭先发close再选继任，端口卸载早于父active更新，还会发布中间null。仅保旧live页无法解决已经真实关闭的源。

当前保留同scope／Root／几何合格的物理shell，和旧页是否可供live像素分开；同id导航换wire、新tab或旧页loading不自动使shell失效。选择／当前关闭前，Main以唯一UI预备事实将准确既有目标放旧页下方、置原生shield，并只读一次目标自身完整帧（100ms期限）；ready最多1500ms等待fresh ACK／量测采纳。尺寸变化先废旧坐标，内部帧不保存或显示、不授模型截图／控制证明，每目标单在途，各独立意图的key隔离。源在ready后真实销毁不使目标准备失效；迟到取消、ABA及新绑定仍按精确目标与key核对。009实机另证Electron在源关闭后会清空view.webContents getter，而普通fake仅置destroyed仍保对象；ready后的输入shield须先核源Map及contents，源确不存在时使用准确目标，不能再解引用旧源导致呈现IPC抛错和Root fail/null。已在源下层的目标不移除重插，以免旧sourceIndex因移除左移而改变真实层级。

Root即时删除旧端口的动作准入，只聚合React提交中间的缺失发布。子SessionTabs先发布准确继任A，父layout effect在同一同步提交派发真实close(B)，避免跨scope微任务丢失关闭；Main收到close仍立即销毁真实WebContents，不能假装旧port已死或保已销毁页截图。未提交准备可取消、失败走fresh路径，最后／后台／非浏览器关闭保原路径。未采用延迟Main真实关闭或无限保旧图的方案；代价是有界的目标帧准备时间。当前实施、完整边界测试与连续像素资格由Desktop owner维护，本节不把整体resize Note升级为implemented。

## 工具栏的展示身份与派发身份

用户另报切换已加载tab时工具栏刷新闪烁。011实录及DOM采样区分了两层：Chrome文档和网页均未重载，但以含page id的ownerKey作为React key使整条工具栏重建；fresh ACK暂缺又把真实hasPage／能力乘成false，使刷新按钮opacity1→0.45→1。网络loading一直false，不能把该现象归为网页加载或引擎重绘。

当前仅Root scope决定Chrome DOM寿命，准确page id继续留在binding fence，不能为保DOM删掉目标身份。目标切换立即采用其地址并退休旧编辑／IME／echo／提交，旧异步unknown不得写新页；只接纳当前焦点地址框的用户input，避免旧IME尾事件写入被复用的新页input。同页geometry仍保草稿、选区与IME，真正scope／null撤下。页面事实保实际值，interactionPending独立禁按钮和提交，仅对本来可用按钮保持外观；addressReadOnly按OR收窄真实编辑限制。真实busy／uncertain／控制状态照常展示，Main／Root／send准入不放宽。不使用整条inert破坏IME，不用旧工具栏缓存掩盖失联。012已有真实四切的节点与opacity证据，连续像素和有限资格归Desktop owner；整体resize Note状态仍proposed。

## Alternatives considered

- 保持旧 PNG 衔接：已有真实过程证实旧宽正文、暗空与最终恢复；无法满足连续缩小。
- 仅删除 hide 或放宽 same-geometry retain：大缩窗可只剩窄条真实页；提前按新 anchor 移动则能覆盖旧聊天。
- 裁剪旧新槽交集：大变化可能为空，不能保证原页持续可见。
- 超尺寸 Root 放在父 View 中：本机 plain 与 radius1 均出现 Root 洋红区覆盖真实网页；可信点击亦命中越界 Root。私有材料保留于 `.cache/browser-native-clip-probe-20261031`，不算产品资格。
- 将全部混合 reader／编辑器都迁入新 Renderer：现有 ReactNode、草稿、注释和业务所有权不能安全直接序列化，超出所需范围。
- 仅把边界计算移入原生LayoutManager：固定Electron44.3.0虽未在当前类型／API文档声明`setLayout`，源码导出及实际二进制均支持；隔离三个WebContentsView原型已由该回调独占几何应用。真实缩小仍露出窗口内13图像像素宽的品红底色，窗口和桌面原帧共同确认，故不将它接入普通产品当作消除闪烁的修复。原页保留及回调先于JS resize不构成所有surface同帧提交证据；完整过程归Desktop owner。
- 只恢复Chromium原生外窗等待入口：固定版本AsyncLiveResize默认关闭，Electron未转发相应父类；私有delegate转发与feature组合已实测74次进入等待分支。窗口和真实桌面源仍有内部品红带，故不采用默认关闭的feature或私有运行时注入作为产品修复。等待父Widget compositor帧也不等于所有网页surface新内容与外窗同刻提交；当前源码还不能将默认配置问题定因为缺失super或永久live-resize状态。后续引擎补丁可能影响构建、签名和升级维护，需要明确扩大实施范围，不能由本轮失败原型默认为正式依赖。

## Acceptance criteria

- 在既有分栏仍展开的 browser-live 槽内，连续小缩窗、大缩窗及来回缩放保持真实页面 live；聊天、Chrome 与网页各自受实际边界限制，无旧截图替换、黑空或覆盖聊天。沿用既有空间不足时的分栏折叠语义，不能以“始终可见”夹具断言改写该行为；折叠不销毁原页面。
- 保留 pageId、incarnation、WebContents、navigation、documentId、timeOrigin、表单与阅读位置；不导航、重开、存储恢复或重放业务动作。
- Root 与独立 Chrome 的 tab、导航、菜单、控制按钮、地址输入／IME、焦点、Escape、splitter 和全局覆盖互斥正确；只有一套业务 handlers／observer。
- 新宿主无 Service／Agent 执行入口；旧 scope、迟到事件、重复序号与未知派发不重放；原截图坐标与元素引用照常按变化失效。
- 冻结实际生产制品后记录真实 OS 缩放过程，区分原型、受控 HTTPS／公开 HTTPS 与完整客户端资格，保留所有失败及未覆盖项。

## Risks

独立原生视图不构成跨 Renderer 的原子事务；正确性依赖各自真实物理边界。逻辑 viewport 与物理 bounds 的关系必须实测，不能仅信 innerWidth。Root modal、混合 tab、注释与焦点还原属于必须验证的状态切换。受限 preload、构建资产、关闭清理、缩放／DPR和 Main／Renderer 生命周期需按实际边界接入。

## 启动边界

本轮曾让隐藏Root的`capturePage`成功后才允许窗口启动。真实`desktop:dev`实证其会抛`Current display surface not available for capture`并退化成`native_startup_failed`，该前提已撤除。BaseWindow／WebContentsView的实际loadURL或loadFile成功才允许Main显示，加载失败、窗口关闭和后继加载替代仍拒绝；加载完成不伪装为`ready-to-show`绘制证明。真实隔离开发启动已输出Service ready、显示并保持Root界面后正常退出；该有限回归不证明缩窗过程修好。

## Native resize phase evidence

首次生产组合实机发现初次宿主错误依赖绘制后的scope，已改用页面本身的Store／Session归属；页面归属不等待首次绘制。scope、导航及Root新绑定仍各自核实。后继冻结组合实际保留原页、表单与固定阅读段落；scrollY随网页重排改变，但同段落viewport top保持，不能只要求数值scrollY恒定。

`attempt-002`窗口源及`attempt-004-native-display`受纯色隔离背景保护的真实桌面源，都观察到窗口内部右灰带。后者为真实系统边缘拖拽；网页／Chrome右界先于外窗边界约一帧，排除了仅窗口录制源伪影的解释。两轮失败和未执行的步骤保留在 `.cache/browser-recheck-20261030/ordinary-dev/observations/native-layout-20261031`，不授无闪烁资格。

[固定Electron delegate](https://github.com/electron/electron/blob/v44.3.0/shell/browser/ui/cocoa/electron_ns_window_delegate.mm#L203-L206)在原生windowDidResize内、super之后直接通知JavaScript resize。当前候选将Root／Chrome／page与UI viewport的实际更新合并到原生回调后的同一Main批次，事件内先废弃旧坐标依据和Chrome动作；它只改变布局执行phase，不使用延时常量、截图衔接或越界overscan。该phase已由冻结`app-005-post-native`及`attempt-005-native-display`否定其消除闪烁的结论：原页、表单、阅读段落与header拖窗通过，但真实桌面帧73（PTS1.825秒）和95（PTS2.233333秒）仍见窗口内部右灰带。后置JS批次不是CA／WindowServer原子提交保证；不能将调度延后作为已完成修复。当前候选保留未交付状态，停止等价实机重跑，不能据定向测试、正常退出或最终截图将本Note标记implemented。

### 首个网址的 Root 到 Native 交接（2026-11-01）

013实机把首次导航与已加载tab切换分开：Root先移除起始内容、隐藏本地栏，Native Chrome虽dom-ready仍未交付工具栏首帧，出现整栏灰空及约167ms顶部空缺。不能用导航完成、DOM挂载或已有切页通过覆盖此反例。

保留Root的起始DOM和本地工具栏，完成原两步量测后只确认布局；Main在完整Root下以准确viewport预备真实原页，复用其文档ready生命周期但不取得Agent租约。工具栏也须有当前Renderer提交与自身完整原生帧，之后才发布hosted；fresh Root ACK再次核身份与几何后采用同一Page，再确认已呈现。只移动预备层，不拆装Root；图像不保存、展示或返回模型。正式Model截图与旧坐标仍按原sizeEpoch及页面身份失效。

014保住Root但首帧准备失败，015私有诊断确认Chrome从0尺寸变为准确尺寸后直接capturePage返回UnknownVizError。因此Chrome改等自身beginFrameSubscription交付当前完整尺寸的真实绘制帧，不用DOM已挂载替代Viz就绪，也不固定sleep、轮询或重试capture。同一次准备后继同尺寸revision可复用surface存在事实，单次读取当前帧，不依赖一定有新的paint；统一读取槽保旧capture至完成，退休的订阅回调不能授予新准备。原页单次只读capture仍受文档、frame、token、URL、revision、scope和几何校验；每页单在途，超时、停止、重导航、关闭、Root及布局变化取消旧准备。fresh ACK有独立1500ms期限，失败还原Root并准确报错，不刷新、新开或重放导航。首开实机制品资格和失败由Desktop owner维护；此项不改变未完成的resize及跨平台范围，整体Note仍为proposed。

### 首条输入前的手动网页（2026-11-01）

用户实证新对话未发送消息时手动打开百度只更新标题与地址，正文停在工具起始区。正式会话scope在preparing中按原设计撤销，而Pane现代布局端口又把它当成展示前提；直接复用旧selected scope会让create把准备页网页挂到旧会话。提前创建空Session则违反首次发送才创建的产品契约，这两种替代均不采用。

准备页使用独立的Root本地draft owner，Main绑定准确页面、Root frame与document epoch，不注册Agent Page、不arm，不将该token解释为Session或任务权限。普通请求、布局nonce/ACK、菜单与关闭均核同owner；Session restore和Agent控制菜单继续拒绝draft。恢复只返回当前owner的已有页清单，切走隐藏而不销毁；不为显示重开、刷新或重放导航。正式会话路径保持原授权，不自动把准备页转换为Agent受控页。

Root按Store在窗口sessionStorage保存token及draft展示revision，HMR保同document身份。真正Root替换后旧epoch/证明失效，仅准确token的显式恢复可重新绑定当前Root；Main保旧revision floor，新计数高于旧请求，不能让迟到正/负请求复活或隐藏新呈现。原网页文档与表单不变。文档ready生命周期独立于Agent注册安装，模型观察、控制租约和未知动作结果仍归原owner。

018阶段草稿沿Root本地标签栏/工具栏与同一Main布局控制器呈现，首次同样核两次真实Root绘制和目标自身完整帧；采用后复用异步尺寸校准及Native当前窗口外推。它不等待Session专属Chrome shell，旧/空shell释放不得取消草稿准备。当前实机像素、候选切口及仍有的过程缺口由Desktop owner维护，受控回归不补造无闪或普通发行资格。

019尝试让草稿Page在窗口clip外以最终viewport和最终层级预备，意在避开就绪后重挂；真实DOM-ready后的读取却返回`Current display surface not available for capture`，故该候选已放弃，原制品/源码保留。不能把正确尺寸或DOM-ready当成已有可读surface，也不能靠轮询截图、固定sleep或重放导航补造通过。撤回019时生产Main逐字节匹配018已验版本；首显一帧暗空、返回短起始区、resize灰带与close残片仍如实归Desktop owner，不授整体无闪。

## 正反向显示交接收敛（2026-11-01，代码已实现，像素范围另列）

用户要求继续解决018的暗空、起始内容闪回及关闭残影，并先核源码。当前分叉已确认：草稿Page首帧就绪后还会从Root下方重挂上方；恢复清单裁掉已有Page状态并走blank/Tools，自动reveal又启动240ms宽度动画；最后关闭在Root删除标签和收栏绘制前先派发真正close。019裁切外预备已被真实surface不可读否定，不再重做。

本次将同一Chrome Host的展示owner推广为真实Session scope或独立draft token。Agent授权仍只接受真实Session；草稿不注册/arm、不伪造scope。Root显式声明带单调context代次的当前展示意图，快照/撤下必须对应context，旧cleanup/ABA不能撤新展示。草稿沿现有Page+Chrome自身帧、fresh ACK、Root真实裁剪交接，删除其采用时重挂Page的分叉。

恢复已有页面保准确显示初值，仍须新证明，不再回到新标签Tools；自动恢复直接给最终分栏尺寸，普通用户开合/其他reader动画不变。最后关闭采用反向准备：保原生顶部条带并禁输入，把Root放全窗在其下；Root提交最终无标签布局后，在条带下绘制单次nonce，Main确认完整Root帧，再等同一帧流清除nonce的当前帧，才派发一次真实close并撤条带。Main收到真正close仍立即隐藏并销毁准确WebContents，不保已销毁截图；失败只查原状态，不重发关闭或业务导航。

此为现有呈现owner/控制器的收敛，不新建Agent Loop或升级工具/公共协议版本。定向回归证明所有权、取消、真实销毁及帧先后；冻结制品只针对这些新增交接核一次完整过程。未取得实机证据前不授无闪资格，原018/019失败和其他resize/发行限制保留。

020实机支持去掉草稿采用时层级切换后首显直接接替，返回不再闪Tools；但它也否定了“只保旧Chrome条带即可完成关闭体验”的推断：Root正文已到目标画面，旧标签/地址及局部stale提示还悬留约0.11秒。故Root-return的物理宿主寿命与可显示的toolbar数据也必须分开；Root准确null意图后，envelope/read均清内容，原strip只保当前主题无文本背景至帧证据结束，不保旧标签/地址/截图，也不新增View。此空宿主并不证明Root展宽与各surface原子提交。

本节替代前述018草稿专用Root本地工具栏/采用后上移的显示策略，不替代其独立draft、不借旧Session和观察/输入边界。020原片中的切会话灰列、resize灰/短缺页及旧bar残留完整保留；后继仅对旧bar清内容的关闭因果切口做021定向，不重复天气/模型或宣称整体渲染完成。准确代码、实机PTS及验证范围仍归Desktop owner，整篇Note继续proposed。

021限定关闭片已观察Page直接退Root，未再采到020旧toolbar/stale提示悬留，也未见白L或nonce；右上Root按钮仍在空strip退休后分步出现。此后继只为清旧内容取得本机开发切口证据，不覆盖020已有的切Session/resize灰列，不把两阶段JS/帧顺序当作系统像素原子保证。准确PTS/原片完整性沿Desktop owner，本次不继续等价实验或升级发行资格。

## 关闭绘制标记的最小原生遮挡（2026-11-01，代码已实现，实机范围另列）

021已确认Root目标正文出现后，整条空Chrome仍挡住右上按钮75–108ms；nonce实际仅使用原strip左上120×3 CSS区域。继续保整条宿主没有帧证明上的必要，也不能为提前露按钮跳过Root清除帧。拟只在有效Root-return且Root已提交准确null意图后，把同一个Chrome View收成覆盖nonce的最小保守矩形（普通zoom1约124×7 DIP），保原receipt坐标、Root有序两帧与真实关闭顺序，不增加View/Renderer/协议字段。

Host先核准确原geometry，再更新Root-return保存的Chrome bounds；重复null省写，context/Root/resize/页面失效照常取消。按mac backing scale不低于1，以Root zoom作为Canvas DPR保守下界复用现有witness尺寸；新矩形必须覆盖实际palette且不越原strip。小zoom可能需要更大保守高度，只承诺准确遮住marker并缩小无必要遮挡，不伪造全zoom按钮同时出现。finish/cancel撤原View，下一普通layout重新给完整工具栏bounds，不把临时mask当成长期anchor。定向回归后仅重验关闭实际切口。

另沿固定Electron44.3.0/Chromium152源码核到Root setVisibleSize会走RWHVMac实际SetBounds，并非只预分配bitmap。它与已否定的父View/调度/AsyncLiveResize候选不同，尚未证明Electron外层物理裁剪能约束更宽RWHV；只允许一次私有边界probe，不接产品。真实裁剪、字体/坐标或点击任一不成立即否定，不追加参数搜索或等价完整UI重验；不由本段授权引擎补丁。当前灰列及所有旧反例保持。

最小遮挡已接现有Host的release路径，先通过原Root-return/current守卫；原strip另存以便重复null幂等，临时小bounds不成为shell anchor。完整Host回归92项1047断言通过。补核极低zoom的DPR下界可能过度估算实际能放下的palette，此时保原准确条带继续关闭，不因优化取消合法关闭；真正setBounds故障仍安全取消。023已观察按钮随首个全宽Root帧出现，但process8/0.141667有一帧正文先撤、旧窄布局/旧bar尚在，下一样本才完整Root；原反例不改写为无闪。

该新切口对应Main在有效closing事实中present(null)仍提前hide。后继仅在原capsule仍准确、shield可用、同一未销毁Page确在Root下时保真实live像素，仍清presentation/active并automation.present(false)，旧坐标/新截图/异步旧布局照常拒绝。现有nonce/clear完成才真实hide/close，不重挂、不保存截图、不扩跨scope显示；取消只清准确原Map对象且无新presentation的临时页，并同步收回shield。Main完整179项3050断言和18个取消边界支持此close-only顺序，实际24号制品范围由Desktop owner维护。物理visible不授Actor能力；通用后台CDP仍归原lease，不声称输入盾拦截CDP。

可见surface预留候选已由唯一实际命令明确否定：私有Root API bounds仍700×760，实际帧从1400×1520扩大到2400×1520，WindowServer两源均见Root洋红覆盖原橙/青Chrome与Page。字体/文档/输入/阅读位置保持也不能授裁剪正确。原001基线夹具因同步helper阻塞后过早读点击停止、候选0次；002仅修异步真实点击事件确认，基线两个trusted点击成功后才调用一次setVisibleSize，见越界即结束，没有参数搜索或产品接入。此反例对应固定[EmulationHandler](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/devtools/protocol/emulation_handler.cc#L808)经WebContents到[mac RenderWidgetHostView SetSize/SetBounds](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/renderer_host/render_widget_host_view_mac.mm#L616)改变真实内容视图的路径。不能靠完整Root帧/外层getBounds推断独立预分配surface，不放宽输入/呈现边界，也不据此进入引擎补丁。Root展宽灰列与原resize缺口继续保留。

024冻结开发制品的两路关闭切口已观察完整原Page直接到完整Root与按钮，未采到023正文先撤的过渡，也未见nonce/色条/白L/旧正文闪回；Source最终确认前未hide，到真实close与shield/Chrome一起撤。此结果只支持同一owner准确closing事实中的物理live页寿命与Root目标帧交接；不推广为跨scope旧页面显示，也不替代Actor lease或Root compositor原子保证。Main/Host回归和准确PTS/原片完整性沿Desktop owner，切Session/resize灰列与整篇proposed资格保持。
