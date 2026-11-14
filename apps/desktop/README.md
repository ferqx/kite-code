# Desktop 与 Native 制品

## 执行观察与操作准入

模型重连行由当前执行观察更新标题、次数、状态和失败详情，不继承等待中正文缓存的旧重连事实；新增行按当前投影插入原历史位置。终态过程仍沿原规则折叠。[完整 DOM 回归](test/isolated/native-transcript-dom.test.tsx)补失败、取消、连接成功、继续重试及新增行五种交接，核正文节点、单行和后续输入顺序；该文件32项／551断言通过。同机隔离Chrome沿实际投影／Conversation及生产CSS连续观察失败详情、恢复重试、取消与成功，33帧保原输入／草稿节点、焦点及阅读位置且无页面错误；本机`.cache/lifecycle-review-browser-process.json`保过程，夹具装配修正保留原失败，不代完整Native／Service或安装版资格。

底层只读后台目录保留内部fallback／generate记录；普通[环境投影](src/native-environment.tsx)只接纳有准确Tool来源的后台Shell或真实child，命名不进入业务列表。通用后台面板的既有诊断入口差异归[原专题](#native-跨会话后台总览)。

2026-11-10，Windows x64／Bun1.4.4，本次Native开发范围的执行／准入拆分、重连、同Run恢复、首次创建和阅读保持已验。原全量159任务／234文件为131任务通过／28失败，1902pass／90fail／50skip，整体返回1，日志为`.cache/lifecycle-all-desktop-coverage.log`。30个失败文件的85个用例有HEAD同名失败；当前独有差异中的刷新、Root重建和迟到回执夹具已对齐准确激活／重连契约，前两完整文件共8项／133断言通过，定时任务整文件2pass／1个HEAD既有表单失败。Node日志取消恢复宿主复验通过，但该文件另一次原本通过的启动用例触发原30秒时限及迟到错误，未取得全文件资格；其夹具直接使用未改的journal／私库／Client，不调用NativeCaller，根会话已明确命名。构建、平台及既有恢复限制保留，不能据这些定向通过宣称全量或发行通过。

[Controller](src/controller.ts)在 bounded View 返回并核完 Store／Session 后即发出只读执行观察；完整 Snapshot 仍等待权限、交互和准确活动 Command。两域复用同选择在途的 View GET，执行 reader 不等待 admission Promise。[Native caller](electron/native-caller.ts)分别合并执行目标 cursor 和准入后继；Run／Execution 目标或相关交互／权限变化立即撤销旧操作快照，ready 协调期间也关闭准入。只读交互分页位置与操作快照分开保存；撤销准入不把后页退回首页，重新读取仍核 Store／Session／Workspace／contextSelection，显式选择或 scope 改变从首页开始。自身已登记的 Workspace 准备事件保留原准确授权交接。执行事件直接唤醒 reader，不等待普通100ms刷新间隔；无关会话 cursor 不成为当前执行目标。

[只读投影](src/native-bridge.ts)带 generation／Store／Session／Workspace／viewSelection／historyEpoch 和 observedCursor，独立表达 fresh／refreshing／unavailable，不携带权限或操作目标证明。[展示核验](src/native-execution-observation.ts)按完整 scope 选取，[Run 投影](src/native-transcript.ts)与[保留展示](src/native-transcript-display.ts)据此更新活动、终态、计时和同消息复制资格，正文／工具分组及阅读身份继续由原 reader 管理。更高 cursor 的同 Run 恢复可以重新显示活动事实；热态动画还需准确目录 owner 资格，读取失败不能冒充完成。发送、引导、回答与取消仍从完整新鲜准入快照取得原目标。

Native 使用现有 SDK 的单次 `observe({reconnect:false})`，由 Main 原观察循环负责重连。传输断开即撤销执行／准入资格并建立新历史 epoch，持续失败不重复推进 epoch；重新打开流前用 `verifyConnection` 核同 Profile／Store／instance／build，普通 HTTP 成功不能单独恢复旧流资格。新 ready 后再协调所选会话；历史沿新 epoch 由 Renderer 独立读取，不在 ready 回调等待历史 EOF，隐藏页面或历史读取失败不能阻塞全局 change/checkpoint 消费。重新读取不当作激活协调。普通窗口在连接实际不可用时显示“连接暂不可用，当前状态待核实。”，恢复核实后撤下；它沿原提示区展示真实失败，不开启测试诊断或提供操作重放。

同 generation／Store／Session／selection／historyEpoch 的 ready 与显式选择共用一次原激活结果；ready 水位更高时只补新鲜读取，失败或低于目标不能开放准入。Renderer 的 attach 若已带恢复选择，沿该准确结果建立模型、草稿和历史 reader，不再提交第二次 select。首次输入的后续原回执查询也沿用已经选中的 activation；读取失败由同 nonce 的既有只读重试恢复，不为准备页另起激活。实际重载原会话的协调 POST 从2次降为1次、View GET从9次降为6次，业务 POST 为0；这是该次请求计数，未取得 Native 启动耗时分布。

首次创建的会话先进入已核实目录时，[Native renderer](src/native.tsx)按原 Store／Workspace／Session 及仍打开的首次提交页立即给出侧栏选中目标，不再等待首次回执、selection 或模型读取。未确认目录、已删除／child 行、被拒绝的创建和后来页面不取得该展示目标。共享页面的 `sidebarSelected` 只接管导航高亮，正文 `selected`、原输入节点与准备／操作准入保持原链路，该展示更新不提交 Main 选择或额外业务。

2026-11-10，完整首次会话 DOM 111项／2378断言、共享页面与侧栏两个完整文件25项／313断言通过；新增回归先复现“行已出现但无选中”，再核首条回执前、selection／模型读取持有期间、输入焦点／草稿及迟到目录／回执不覆盖后来选择。全仓6716文件／9项目类型检查通过。Windows／Bun1.4.4／Electron44.3.0 的相同隔离 Native 制品中，旧renderer直到回执释放才选中新行；修复后10个可见变化状态里，新行首次出现即为唯一导航选中项，fallback到AI标题及完整读取接管均保原行、原输入节点和下一条草稿，每条用户消息单份，实际仅一次`conversation.send`及一次`run.start`，原Run真实completed。连续状态在本机`.cache/native-first-row-focus-{old,new}-{held,after}.json`，图片为`native-first-row-focus-old-held.png`及`native-first-row-focus-new-{held,after}.png`，汇总为`.cache/native-first-row-focus-final-audit.json`。测试后台按键未提交的样本保留，前台可见驱动补验无页面异常；普通renderer诊断关闭，使用本地合成Provider，不外推安装版或远端模型资格。

2026-11-10，Windows x64／Bun1.4.4／Electron44.3.0：完整 Native caller 60项／647断言、历史展示 DOM 24项／482断言、首输入 DOM 109项／2307断言通过；首输入回归先复现原选择在途时原回执查询另起 activation，再核同一选择、后编辑草稿和单次提交。上述隔离普通制品的可见冷开窗口中，标题 Job／Model 保持 running，首 Run 已 completed、界面显示真实耗时且下一轮已进入 Provider；释放标题后二轮均 completed，24个变化状态中每条用户消息各一份，占位到持久消息保原节点。三次 select 读取均为同一 activation，重试零额外协调；首输入本身的初始协调与用户选择协调分属原有不同准入步骤，不合并其权限。

同一隔离窗口另实际注入配套 Service 崩溃：断线立即撤销活动并保留原文，冷开后原 Run 显示 interrupted，明确恢复前业务 POST 为0；仅一次既有 `run.resume` 将同一 Run 在 cursor612→618重新显示活动，最终cursor708为completed。59个变化状态中三条用户输入各一份、节点保持，未发送草稿和80px阅读位置保留。原模型中断前缀与恢复后新模型内容分别保其原身份，不当作重复输入合并。原始事实在本机同目录 `recovery-*.json/png`。夹具在控制文件热写及关闭时另记录过 JSON 读取异常，不能据此授予无传输异常的全过程资格；后续复验须改为原子发布控制文件。注入崩溃的宿主退出1，健康恢复实例最终正常退出0，原错误保留。

控制文件随后改为同私有目录写完整临时文件后原子重命名，按同配置／Provider URL对受影响的恢复过程补验：准确原Run在cursor720／726／755分别为interrupted／running／completed，三阶段文档均visible，明确恢复前业务POST为0，恢复POST仅1次；恢复后的Provider只有1次进入及其完整结束，未重启旧标题。59个变化状态中四条用户输入各一份并保原节点，下一条草稿和80px阅读位置保留，健康实例正常退出0且该次无控制JSON读取异常。原失败样本仍保留；补验证据为同目录`recovery-atomic-*.json/png`和本机`.cache/native-lifecycle-recovery-atomic-analysis.json`。

CDP重载后曾出现原生窗口／View均报告可见而文档为hidden，原只读重试按可见性规则暂停；重新冷开并确认visible后完成上述并行与恢复过程。当前Windows菜单的[视图入口](electron/native-window-menu.ts)没有重新载入，本轮未改Main窗口／View可见性机制，普通冷重开和断线恢复不调用CDP重载；尚未确认该私有调试操作的现象归因，不授予CDP重载恢复体验资格，也不将其外推为普通冷开失败。OS截图工具的应用授权超时，本次图片为实际renderer捕获，不授予OS最终合成或其他平台资格。

本轮真实窗口先发现 SDK 内部重连掩盖断流、旧活动仍为 fresh；[真实 HTTP 回归](test/isolated/native-history-incremental-http.test.ts)新增断流期间、第二次流申请与零额外 POST 断言，先失败后通过，当前整文件1项／16断言。完整 Native caller 58项／636断言、Controller／执行 scope 两文件17项／98断言、[普通窗口 DOM](test/isolated/native-history-presentation-dom.test.tsx)23项／472断言通过，后者核提示恢复和原正文节点保留。Windows x64／Bun1.4.4／Electron44.3.0 的独立源码制品接真实 Main／Service／SQLite／SDK 和合成本地 Provider，已连续观察权限未返回时主 Run 终态先显示、保留草稿在权限恢复后发为新 Run、SSE 断流撤销活动、离线完成后由新 ready 接管、迟到跨会话读取与80px阅读位置恢复；三条输入各一份。原始请求、过程帧和截图在本机 `.cache/native-lifecycle-window-806aa763-097e-49e5-8338-58f00ca6788b` 及 `.cache/native-lifecycle-*.png`，普通 renderer 诊断常量关闭。最初 Provider 夹具自身10秒空闲断流、修复前窗口及未通过回归均保留。该范围不代证真实远端模型、安装版或其他平台；同Run显式恢复及本机CLI进程分布已补验，限定范围见前述段落与Service owner。

2026-11-09，Windows x64／Bun1.4.4，`4a527742c` 加当前工作树：Controller、Native caller、执行 scope、历史和会话五份完整文件在宿主共109项／986断言通过；两份 transcript／history-presentation DOM 完整文件共49项／970断言通过。可控权限 gate 证明它未释放时原 Run completed 与较新同 Run running 均可发布，旧 selection 仍不含权限；突发事件最大在途 View GET 为1，当前选择未追赶外会话水位。旧链路同 gate 下151ms观察窗内零后继 View GET；新链路单样本执行发布约0.4ms，只是本地替身的因果证据，不是实际 Service／Provider 启动预算或性能分布。最终渲染微调已按上述两份完整 DOM 文件复验；这是早期受控gate结果；后续可见窗口过程已在前述段落归位，不扩展安装版、远端模型或其他平台资格。

新会话目录位置由 [NativeDirectoryProjection](src/native-presentation.ts)在同 Store 的连续完整目录间识别新增项；缺少首条消息时间时投影 `awaitingFirstMessage` 和递增的窗口内 `awaitingFirstMessageOrder`，由 Sidebar 优先展示，多个待消息项按观察顺序后者在前（同批按目录遍历顺序登记）。刷新与选择不推进次序，时间到齐后移交原最近消息排序并移除次序；移除的项不保留标记，Store 切换重置计数。该窗口内标记不写数据库、不伪造 `updatedAt`，冷读和 Store 切换不将旧空历史置顶。[目录回归](test/native-directory.test.tsx)覆盖首次发布、多个待消息项、刷新／选择稳定、消息时间接管、移除、单行和冷读／Store 隔离。

2026-11-09，Windows／Bun1.4.4：目录与两份隔离 Sidebar 回归分别运行，共24项537断言通过；Desktop／UI 类型、四文件 Biome、文档结构与影响检查通过。Chrome156 的实际投影／Sidebar 生产样式隔离夹具按空项发布、刷新、消息时间接管逐步观察，145个连续动画帧中新增行始终第一、单份且保留原节点；阶段截图已核对，页面错误为0。材料在本机 `.cache/session-order/`；不以该受控目录过程代替真实 Service／Electron 端到端或其他平台验收。

2026-11-09轨迹类型筛选简化：移除顶栏轮次／调用／子调用三个按钮，筛选菜单只保留消息、思考、工具、子 Agent、自动压缩、审批六类。旧时长、轮次、层级条件在Panel归一化为全部，避免隐藏筛选；childAgents缺省开启，普通工具和子Agent独立控制，局部折叠与准确材料继续保留。DOM26项897断言、Workbench与统计17项140断言、UI663／Desktop1426文件类型和定向Biome通过。生产编译资产`.cache/trajectory-browser-GOo68D`通过实际浏览器菜单与子Agent／工具切换观察，重新勾选恢复原12行，证据`type-filter-manual-review.json`；此为隔离桥组件验证，未取得安装态Electron或真实Provider资格。预览服务已停止。
## 执行轨迹、离线窗口与 Trace 设置

2026-11-10提交审查修复：在线材料读取权与原清理身份分离，release／显式close立即撤销，关闭未确认仍保准确身份供重试，旧lease不随同scope重开恢复。离线成功pick由Main先退休旧包，Renderer不再重复close旧id；材料按准确readId独立offset与关闭，最多16份（含pending）、128MiB，并在I/O前按已验证section大小预留，换包全撤销且迟到open不占新包预算。Native原材料17项118断言、离线换包12项262断言、离线Main材料11项38断言、Desktop1433文件类型通过。冻结后重建完整Electron候选，真实离线窗口连续三包打开／换包及详情读取通过，无旧包／offset错误、重复行或renderer错误；本机记录`.cache/trajectory-desktop-live-4Bq6OE/commit-offline-review/review.json`。同候选在线隐藏／重开三轮，每轮准确子工具结果均可读、29行不重复；本机记录`.cache/trajectory-commit-review/actual-online-restoration.json`，没有操作日常Profile。

2026-11-10完整 Native 实机复核修复：`electron/trajectory.ts` 只按父读取器确已返回的原 Task carrier／child Session／准确 Run 及原 Store 允许直接子范围，子上界不超过父观测 cursor；材料再核已见原事件与精确 ref／contentVersion，隐藏或换选择撤销证明、取消读取并关闭材料，迟到旧 lease 不因同范围重开而复活。`src/trajectory-related.ts` 重开时在原父游标内只读复核 carrier，未扩大 IPC 或读取任意 Session。UI 在准确挂接证明成立时去掉这一条外部 carrier 的缺父误报，原父关系和其他真实异常保持。Native manager／related／materials 27项209断言、在线 DOM6项59断言通过；UI／Desktop／Agent 类型检查分别676／1433／1194文件通过。完整对话中的自动审批分类、公开压缩边界及待答动作投影归[Agent owner](../../packages/agent/src/trajectory/README.md)，详情顺序与定高新记录提示归[UI owner](../../packages/ui/README.md)。

同一耐久工作树、macOS arm64／Bun1.4.4，以独立 HOME／Profile 构建并启动完整 Electron 候选（非隔离 bridge）：Main／preload／Service／真实 Runtime 和 SQLite 配合 loopback 确定性模型，完整对话执行原 Files、子 Agent 内部 Files、自动压缩、风险检查、实际“仅此次”人工批准 Shell、等待子任务及最终回复。修前实际重复分类、回复因果顺序、提示行位移和子材料拒绝均保留失败证据；修后主过程20行、展开子过程29行，无重复身份或工具独占空回复。审批接管连续220帧中14条原历史行与35px工具栏位置稳定；最终候选窄栏1463帧、宽栏1465帧遍历各类型详情及子请求四Tab，原29行身份／纵向位置／高度稳定，Tab client／scroll均38px。隐藏重开3轮均能读取准确子工具结果；冷启动重读模型调用为0。浅／深色实际hover内按钮透明，深色窄栏仅主题1px左边框。原过程、截图和材料观测在本机`.cache/trajectory-desktop-live-4Bq6OE/`，最终两份`final-interactions.json`／`final-wide-interactions.json`与`final-tab-restoration.json`记录实际结果；未操作用户日常Profile。此证据覆盖本机完整源码候选与真实执行链，模型由本地确定性服务提供，不代证远程Provider、用户已安装版本更新、其他平台或完整发布资格。

2026-11-10其他节点内容补齐：消息附件展示原名称／类型／精确字节数，保0与重复，附件-only不出空正文壳；准确Model输入的四格式inline图片仅用获准原字节，不恢复描述附件或重取URL。子Agent委派先呈现原prompt／taskName／preset，保完整参数JSON；压缩预览按原消息selection展示边界／尾部／范围，触发实测基线与估算分量折叠可读。Interaction公开投影只从原schema闭合提取题干／选项，按原id匹配对象答案；未答、取消、空值与缺封存分开，审批无写动作。Shell／Job展示原输出区间、缺口及丢弃量，计划／步骤独立译状态，Browser／Plan／Question准确空列表与未提供分开。UI纯38项254断言、typed结果16项117断言、树DOM31项1235断言、原材料格式7项34断言、Agent原Evidence与真实ask_user投影5项91断言、Native在线6项59断言及详情目标13项294断言通过；UI675／Desktop1433／Agent1193类型及14文件Biome通过。最终编译组件的连续观察见`.cache/trajectory-browser-UB2PVp/node-content-review.json`：原图片解码为1×1、重复附件与0字节保留、子任务原prompt／JSON同页、压缩12200→2600与原保留范围、问答精确选项文字仅一次；Tab栏38px无纵向溢出、正文8／12／14px，窄栏覆盖／宽栏并排均保留，50帧材料挂起→读取及44帧开合原12行几何稳定，关闭焦点回原行。此为隔离bridge中的生产编译Native组件，不授予安装态Electron、真实Provider或跨平台资格。

请求边界与独立四Tab：普通请求圆点移至thinking行之前的节点间隙，不占树层级或额外行；含准确Model的压缩另有一点，单context不造请求。点选择原request owner，概述／选项／用量／计时独立于思考内容；旧request_info回thinking，思考不再混请求指标。在线与离线共用presentation merge已纳selectedRequestId/requestTab与原attempt，旧node/request回调不能跨模式改写；Native详情阅读随请求选择／Tab正常进入history，游标／descriptor权威不变。UI纯回归53项678断言、UI DOM27项1172断言、presentation纯回归20项69断言、在线6项59断言、离线12项258断言全部通过，UI669／Desktop1430类型和定向Biome通过。最终`.cache/trajectory-browser-3tqMab/independent-request-inspector-review.json`记录：299px侧栏两个圆点中心均在anchor行上沿误差0、原9行不变，四Tab实际保留于Native宿主；选项只开原input，用量／计时0新正文读取；请求1／2工具请求数分别1／0，缺usage不补0，普通思考仅一Tab。56帧开合日志位置稳定且焦点回圆点；首次失败attempt准确input-0-3/output-0-4，4attempt仍一逻辑点；压缩／child四Tab准确读取其原Model与child Session范围，不混采用估算或主请求数据。编译组件与隔离桥验证不等同安装态Electron、真实Provider或跨平台资格。

请求圆点交付：当前每准确逻辑Model请求一个点，附最早可见切片，不新增行或另一层Agent loop；准确重连不重复出点，子scope、过滤和缺Run证明处不错误连线，普通Tool不按相邻请求猜因果。点选择原thinking/request_info，保原attempt/ref/版本和读取准入。纯helper8项27断言、详情／计时／Loop30项492断言、树DOM27项1074断言、UI666／Desktop1428文件类型及定向Biome通过。生产编译资产`.cache/trajectory-browser-cS9R5v/request-marker-manual-review.json`记录同Run两请求各一点且原9行不变，24px点按钮中心对齐误差0；分别打开两点查看准确工具请求1／0，56帧详情开合原行几何与scrollTop保持。4次attempt仍1个主点，展开准确child只新增该namespace一点并中断跨scope连线。该证据覆盖隔离桥中的编译组件，不授安装态Electron／真实Provider资格；原完整事件、关系、统计和材料不变。

2026-11-09详情紧凑化：Accordion外框和条目分隔线去除，Tab下caption标题与各类型生成的来源文案／组／计数移除；业务路径摘要、原用户正文、准确材料引用和版本title保持。记录信息无时间时不显示空组。Tablist固定39px外高、38px按钮并关闭纵向滚动；正文8px 12px 14px覆盖右侧栏通用18px，首材料无额外上边距。DOM26项1021断言、详情13项287断言、typed result11项78断言、UI664／Desktop1427类型与定向Biome通过。`.cache/trajectory-browser-pRleaG/compact-detail-manual-review.json`记录299px侧栏中系统／工具Tab的clientHeight与scrollHeight均38、正文首块距顶部8px和无框无caption无来源；21工具正文scrollTop100时Tabtop175固定。浏览器证据覆盖编译组件与隔离桥，非安装态Electron／真实Provider资格；后续只增加overview空记录信息的条件，该分支由DOM与纯详情验证，所核CSS及系统／工具分支不变，复用上述几何证据。

2026-11-09详情内容层次：输入／系统切片和消息内容页去掉重复来源行，准确材料版本仍保留在section title和原读取键；系统指令、用户上下文、消息及回复使用Accordion逐项开合，默认首项展开。思考、工具目录、参数／结果、子任务、审批与压缩核对后保持专属结构。DOM26项957断言和详情13项285断言通过，UI664／Desktop1427文件类型及定向Biome通过。实际编译资产`.cache/trajectory-browser-sgvmyd`在隔离桥浏览器的299px侧栏核对三条上下文首开后闭、多项开合、原粘贴文本保留、无重复来源与水平溢出、透明无边框标题按钮；折回第二项时原日志行y=520保持。此为编译组件验证，未取得安装态Electron或真实Provider资格。

2026-11-09移除轨迹常驻冗余：默认不再显示事实覆盖泛化提示、时间轴右侧区间解释及Run行右侧操作统计，Run折叠／展开／筛选也无相同统计title。覆盖状态保留在轨迹信息，真实读取错误、legacy材料缺失说明与child折叠内部摘要继续保留；底层summary及轮次详情不变。

当前生产编译资产`.cache/trajectory-browser-14Ycoo`复用的最终`.cache/trajectory-browser-mqqpMa/detail-layout-verification.json`通过原20场景、暗浅×三宽度六场景及新增默认／筛选／折叠／child删减检查、partial coverage按需披露与真实error／重连正文恢复；571帧日志几何稳定，36次材料读取准确，facts不变。同资产完整语义验证`.cache/trajectory-browser-SNxSU3/semantic-verification.json`通过八种开关组合、筛选、子Agent载入、精确材料版本、Shell观察与断线恢复，浏览器错误及警告为空。主Agent实际核三处默认缺席、信息开关、Run折叠展开、思考详情开合及scrollTop 41.5保持，证据`quiet-chrome-manual-review.json`。原纯统计／Workbench17项140断言、树DOM25项865断言、UI663／Desktop1426文件类型和定向Biome通过；文档同步当前展示规则。此为生产编译组件／隔离桥范围，不授安装态Electron、真实Provider或跨平台资格，未操作用户Profile。

2026-11-09思考内容强调：仅沿原正文区增加轻背景、主题边框／2px左强调线与内边距，标题14px加粗、正文14px，保持原资料、长思考折叠和上下分组。当前生产编译组件`.cache/trajectory-browser-gGwj7Z`通过原`--verify --detail-layout`20场景及暗浅×三宽度六场景，571帧开合稳定、26次准确材料读取与facts不变，横向溢出0，错误／警告为空；主Agent观察挂起→正文读取→关闭且原行／scrollTop 28.5保持，并目视核暗色窄／宽、浅色宽截图。仅CSS变更，复用未变TypeScript和数据语义的前次相关测试／类型证据，定向Biome和文档检查通过；生产编译组件／隔离桥资格不扩大为安装版Electron或真实Provider。

2026-11-09详情视觉层次调整：思考页移除重复Agent思考caption，由实际模型＋状态摘要行、独立Token用量区、单一思考内容标题和底部紧凑计时构成。详情自身命名container驱动两列／宽栏横排，数字16px、标签10px，保准确0值与缺失语义，不新增统计或材料读取。

最终生产组件资产`.cache/trajectory-browser-m4gotb`在macOS arm64／Bun1.4.4／Chrome156.0.8078.81通过扩展`--verify --detail-layout`：保留原20场景与26次准确材料读取／facts不变审计，另核暗浅主题×299／495.2／1000.5px六种实际详情；受控四指标均来自显式fixture值，不生产计算合计。前两档2列、摘要146.38px，宽档4列、摘要96.78px；字号层级、正文初屏可见、共同左界、摘要<正文视口30%、计时约30.59px及无横溢出全部通过，572帧开合与日志几何误差≤1px。主Agent人工观察挂起→加载→正文→关闭，原行和scrollTop 28.5保持；主Agent及独立图审核六张实际截图无必修项。证据`detail-layout-verification.json`、`hierarchy-manual-review.json`和`detail-layout-thinking-{dark,light}-{300,500,1000}.png`。相关44项1200断言、UI663／Desktop1426文件类型、定向Biome及文档检查通过。此为生产编译组件和隔离桥验证，保留安装态Electron、真实Provider与跨平台资格限制，未操作用户Profile。

2026-11-09分型详情整理：思考首页按实际模型／原状态／显式Token、公开思考、准确原请求记录区间组织，长思考可展开，设置仍在请求信息；普通Tool结果按typed种类突出核心内容和唯一诊断，成功回执按需查看。Shell观察不代替命令结果，child受理／工作／交付分开且旧观察不借未来状态；压缩容量主信息明示本地估算。不补造首Token延迟、生成时长或吞吐量，不变更原Tabs、材料权限或底层事实。

macOS arm64／Bun1.4.4／Chrome156.0.8078.81，当前源码编译资产`.cache/trajectory-browser-WlbIES`通过`bun apps/desktop/test/trajectory-browser-runner.fixture.ts --verify --detail-layout --serve`：`detail-layout-verification.json`覆盖20处场景、9次窄栏开合484帧，行身份、行几何、滚动和视口误差均≤1px；宽约495px／窄约299px，全部无横溢出。26次材料读取准确绑定原event/ref/version，未预读Shell轮询正文，facts不变，浏览器错误／警告为空。主Agent人工核思考指标与内容、详情关闭锚点、child三种状态和压缩本地估算，过程归`detail-layout-manual-review.json`；并目视核思考、Shell、child、压缩及文件结果截图。详情／计时／结果3文件30项422断言，树DOM25项856断言通过；全仓7185文件类型、UI663／Desktop1426文件类型、定向Biome、测试归属及文档检查通过。此证据覆盖生产编译组件和隔离材料桥，不代证安装态Electron主进程、真实Provider或跨平台，未操作用户Profile。

2026-11-09思考详情精简：按用户截图移除“查看该次公开输出”按钮及思考正文页的材料来源编号，保留思考正文、请求信息和准确输出行。生产编译组件资产`.cache/trajectory-browser-0IGBMx`中人工逐步核材料挂起→思考详情加载→准确正文→请求信息往返→关闭，无按钮／来源编号闪现，原行身份及scrollTop 408.5保持，截图已目视核对；过程见`thought-detail-review.json`。详情13项270断言、树DOM25项850断言、UI660文件类型及四文件Biome通过。此为隔离材料桥与桌面组件验证，不扩大安装版Electron或真实Provider资格。

2026-11-09输出占位去噪：成功且完整、准确证明仅含工具调用的Model输出与canonical assistant Message不再占回复行；原事实、准确材料与工具操作保留。输出结构取同一原事件封存的可选`outputPresence`，不按正文加载结果删行；空完成、未读正文、生成前缀、失败／取消／未知和旧缺字段分别表达，空白正文与历史尝试输出保留。真实新事实接管只在同源向前且控制未变时按稳定行及行内偏移保阅读锚点；显式seek／返回最新不被自动纠正。

最终生产组件资产`.cache/trajectory-browser-6GEr6V`在macOS arm64／Bun1.4.4／Chrome156.0.8078.81通过`bun apps/desktop/test/trajectory-browser-runner.fixture.ts --verify --output-state --serve`：`output-state-verification.json`覆盖12种场景，材料取消／加载／详情开合1040帧的行身份、位置、行高、滚动与面板几何误差不超过1px；固定cursor追加45帧保持相对viewport锚点，显式返回最新54帧仅发生预期显隐，准确最终正文可读。原facts、精确材料引用与三个独立toggle保持，错误／警告为空。主Agent人工连续核生成无正文→准确正文、固定cursor新记录提示→返回最新、材料加载与详情开合，以及canonical纯工具空消息省略，原42条事实保留；证据`output-state-manual-review.json`。相关UI纯回归8文件71项824断言、DOM25项849断言、UI660／Desktop1424文件类型及定向Biome通过；全仓7176文件类型、API生成一致性、包边界、测试归属与文档检查通过。真实后端writer、传输与协议验证见各owner。范围为实际编译桌面组件与隔离材料桥，不代表安装态Electron主进程、真实Provider或其他平台，未操作用户Profile。

2026-11-09继续排查轨迹冗余：准确Planning runtime补充不再归用户输入，旧混合材料中性标“本次请求上下文”；所有材料的长版本仅title保留。自动审批检查在准确原Command／父执行核实后保留为一条审批，详情读检查内容／规则／结果，不造普通Agent四阶段；成功且已由准确成功父工具覆盖的有限工作树／浏览器支撑Job退出默认，完整模式恢复，运行中及失败／取消／未知保持。无任何attempt材料的system/input/reply空壳省略，thinking与旧准确材料入口保留；Shell空流与无缺口空分片省略，不去重不同序号真实输出。

最终生产组件资产`.cache/trajectory-browser-b2Y6xZ`在macOS arm64／Bun1.4.4／Chrome156.0.8078.81通过`--verify --input-context`：两种用户JSON粘贴反例、7条原请求／body/facts不变、占位→最终3块、无Host/runtime/长版本/冗长说明闪现，浏览器无错误／警告。主Agent另在同资产隔离事实桥实际操作自动审批概述→检查请求／结果→关闭→全部事件，默认一审批、成功支撑Job省略、完整模式恢复、无材料Model只保thinking、原5条事实不变；证据`auxiliary-manual-review.json`。Shell结果Tab实际核空stdout不占组、真实stderr/退出码/截断/gap保留、不同序号同文输出保两份，原事实不变，证据`shell-empty-manual-review.json`。材料／详情／Workbench／loop／统计5文件51项620断言、辅助树等6文件58项645断言（有重叠，不相加）、Panel DOM23项833断言、UI657／Desktop1419类型、UI构建及定向Biome通过；文档与测试归属检查通过。该范围为实际编译桌面组件与隔离材料桥，不代证安装态Electron主进程、真实Provider或其他平台，未操作用户Profile。

2026-11-09输入上下文修复：列表与详情共用UI来源规则，省略当次已核实的系统会话文件清单和无文字／图片／工具请求的空项，准确原材料与事件不变；用户粘贴同形JSON、先前同来源历史及纯图片输入仍保留，旧或不完整材料不猜测来源。macOS arm64／Bun1.4.4／Chrome156，`bun apps/desktop/test/trajectory-browser-runner.fixture.ts --verify --input-context --serve`构建的生产组件资产`.cache/trajectory-browser-dVPwsd`中，`input-context-verification.json`覆盖300px窄栏读取占位→三块准确内容、无Host路径／空块闪现、完全相同JSON粘贴反例、原六条请求消息与事件不变、列表与详情一致；控制台无警告／错误。主Agent人工核打开／关闭详情、文字与图片说明及关闭后原焦点，树位置／尺寸／滚动与打开前相同。材料／详情22项316断言与Tree DOM21项807断言通过，UI656／Desktop1419文件类型及定向Biome通过。此为桌面生产组件与隔离材料桥的定向验证，不代证安装态Electron主进程或真实Provider，未操作用户Profile；此前布局／统计证据仍只覆盖其原范围。

2026-11-09冗余与统计口径收口：Run展开与折叠统一使用准确本Run的逻辑摘要，Agent重连归一次处理、Shell多观察归一个工具操作，消息独立，子Run内部另计；子范围载入及8种展示开关不改变主摘要，筛选明确为筛选内小计。默认去重复匹配／固定上界／上下文祖先与来源store标签，筛选后只保一次找到N项；通用详情去重复名称、目标、所属轮次和状态，原记录信息与压缩依据按需展开，普通完整消息不常驻完成图标。系统准备仅同真实Run紧邻请求、双方原身份／完整原引用／已准入完整材料均核实后比较system+公开tools；一致显示沿用，变化显示更新，缺失或预算外不猜，全部阶段仍38px，不额外预读／缓存正文或指纹，准确快照可点读。

最终生产组件资产`.cache/trajectory-browser-qmdyQS`以macOS arm64／Bun1.4.4／Chrome156和隔离事实／材料桥验收，语义报告`.cache/trajectory-browser-ios22k/semantic-verification.json`与同资产完整回归`.cache/trajectory-browser-otDeU6/verification.json`通过。主摘要准确为1次Agent处理／3工具操作／1子任务／1审批／1压缩，四尝试与Shell五观察不重复；8组合、子scope载入、筛选及清除口径均核。相同系统准备仅对当前已准入相邻完整快照给沿用，单独Schema变化给更新，读取接管前后行高／位置不变；比较受512000字符与20000节点预算约束，过大／partial／外来版本／缺中间请求／其他Run均不判同。压缩12200→2600、减少9600／78.7%及三项准确摘要保留，重连4次请求与旧raw合法恢复、Shell／child独立状态和原取消／迟到／重连范围均过；48连续帧几何／双向滚动最大差0，主题边框与透明hover正常，浏览器无警告／错误。主Agent人工核Shell单状态与记录信息展开、主摘要在child展开前后恒定、相同系统准备仍可读准确第二请求，以及最终沿用／更新宽栏实际裁图。现有纯展示／状态58项471断言、SSR13项259断言、Tree DOM21项807断言、SessionTabs30项426断言、材料与子范围Hook12项95断言通过；全仓7153文件类型、UI／Desktop构建、定向Biome、API／边界／测试归属及文档检查通过。此范围不代证安装态Electron主进程或真实Provider，未操作用户Profile；原语义首轮旧重连文案断言失败保留在qmdyQS，最终仅更新断言，不放宽准确尝试与材料条件。

2026-11-09工具目录UI优化：系统工具页采用工具数量／准确来源同排、本地名称／说明搜索及紧凑disclosure列表；宽目录单行、窄目录双行，展开显示完整名称并按需挂载说明与Schema，描述不重复。长contentVersion保原title和准确材料键，不在正文铺开。最终生产组件资产`.cache/trajectory-browser-vMaGap`的`tool-catalog-verification.json`在macOS arm64／Bun1.4.4／Chrome156通过：21项目录、83字符版本、263px与779.7px目录分别约56／40px行高、横向溢出0，名称／说明搜索与空结果、无描述提示、长名换行、24段说明完整一次、原Schema一致及搜索保展开均过，搜索新增材料读0，控制台无警告／错误。主Agent人工核最终窄栏数量／来源、Tab切换、native Enter展开和原Schema，并审宽／窄折叠及展开裁图。现有SSR12项216断言与Panel DOM21项773断言通过，全仓7146文件类型、UI／Desktop构建、定向Biome及文档检查通过；无工具／协议版本或读取权限变化。此为生产桌面组件和隔离材料桥的目录范围验证，不代证安装态Electron主进程、真实Provider或全工作台重验，未操作用户Profile。

2026-11-09按用户要求移除所有节点的“原始内容”Tab及关联入口。系统、内容、思考、工具参数／结果等阶段详情继续读取准确版本；旧raw选择回节点首个合法Tab，不请求已移除的原始内容。底层原事件、父子关系、生命周期与现有轨迹导出保持，公开材料权限及隐私边界不变。本次无raw资产`.cache/trajectory-browser-NLQugs`的`semantic-verification.json`与同资产完整回归`.cache/trajectory-browser-pN1Lgj/verification.json`通过；所有分型均无原始Tab，42连续帧详情开合位置／尺寸／双滚动差值为0，浏览器无警告／错误。旧raw恢复用隔离NativeTrajectory host cache覆盖工具／系统／思考／消息四类，回各自首合法Tab并保原选择与观察；主Agent人工核系统旧失败请求内容→工具目录、消息单Tab、工具概述→参数JSON→结果。纯详情12项216断言、Panel DOM21项773断言、SessionTabs整合30项426断言及材料／子范围Hook12项95断言通过，另有64项467断言的现有纯展示／状态／decoder回归通过；全仓7144文件类型、UI／Desktop构建、定向格式及文档检查通过。上述运行范围仍为macOS arm64／Bun1.4.4／Chrome156的生产组件和隔离材料桥，不代证安装态Electron主进程或真实Provider，未操作用户Profile。以下历史验证记录保留其当时的界面和覆盖范围，不作为当前raw入口仍存在的承诺。

Agent loop与原Run／执行轮次为同一个分组，不再在Run内增第二层loop。轮内普通阶段按原观察顺序平铺，不显示决策包装行；只有child carrier与其child Run保显示层级。准确模型owner仍在索引中，旧选择和时间轴定位映射思考阶段；Run状态只采用原Run生命周期。系统准备为系统提示词／工具，消息为内容，思考为思考／请求信息；真实Tool为概述／参数／结果。工具目录仅取准确public request.tools的id、description与完整inputSchema，整行展开且收起时不挂载长描述和JSON；请求信息只呈已公开模型／设置／用量／完整性，不重复其他阶段正文。

2026-11-09平铺展示收口：生产编译资产`.cache/trajectory-browser-AqWyQG`的`semantic-verification.json`通过。主Run下系统、消息、思考、Tool、审批、压缩和回复同parent／depth且无普通阶段箭头；child carrier保子Run，子Run内也平铺，子Run标题实际缩进26px。无Run的旧记录只平铺到真实Session，不补造loop；原父事实未变，旧Model选择与时间轴转到准确思考代表。系统与思考详情保初始请求及3次重连的4个准确版本，8种展开组合均过；48连续帧开关详情的位置、宽度及双向滚动差值为0，深浅主题边框与hover、取消／迟到、断线重连及子范围恢复均过，控制台无警告／错误。主Agent在同资产人工核入口、主／子loop同级行、子标题缩进、子工具四Tab与展开／关闭／折回过程，并核最终实际截图；系统工具及旧重连版本过程在此前同源迭代资产人工核对。最后变化仅子Run标题padding；旧完整回归`.cache/trajectory-browser-xy2Gy6/verification.json`无该子Run分支且主Run padding不变，复用其未受影响的长日志／键盘／工具结果／外栏调宽结论，不以其截图证明新子标题。Panel DOM21项749断言含历史Model／重连alias／思考ID折叠先红后绿，材料与子范围Hook12项95断言、阶段纯规则28项360断言通过；全仓7144文件类型、UI／Desktop构建、定向格式、API／边界／测试归属及文档检查通过。该范围为macOS arm64／Bun1.4.4／Chrome156中生产桌面组件与隔离事实／材料桥，不代证安装态Electron主进程、真实Provider或其他平台；未操作用户Profile。

2026-11-09本次阶段详情收口，生产编译资产`.cache/trajectory-browser-wCoZsP/dist`在macOS arm64／Bun1.4.4／Chrome156以隔离事实与材料桥验证；同资产的最终[语义流程](test/trajectory-browser-runner.fixture.ts)报告在`.cache/trajectory-browser-m50yl0/semantic-verification.json`，原完整回归在`.cache/trajectory-browser-MNTsCf/verification.json`。覆盖同Run两决策仅1loop、第二真实Run才loop2且决策重置、旧无display／无message事实的准确输入与输出、系统工具Tab逐项展开Schema、思考请求信息不重铺正文、消息内容页、名字断线→暂不可读→正在读取→实际名称恢复且不误报未保存；原Shell／child／重连／折叠／取消／迟到／宽窄布局仍通过，控制台错误和警告为空。47帧开关详情的panel／header／timeline／tree位置、宽度和双向滚动差值均为0。主Agent人工核系统提示词、工具Tab及完整参数定义、Run唯一loop与请求归属，并核实际截图。纯展示／状态／formatter73项561断言、Panel与材料／子范围DOM30项376断言通过；全仓7144文件类型检查、UI／Desktop构建、API／边界／测试归属和文档检查通过。后端正文引用外壳的真实封存、原Inspector与准备窗口回归由各owner记录，未读写用户Profile；此受控组件证据不代证安装态Electron主进程、外部真实Provider或其他平台。

主过程按Agent loop展示，系统／请求用户上下文／公开思考／本次输出是原model材料的展示切片；新事件仍保原Execution与父子身份，不为展示新增事实。列表和详情分别使用[材料owner](src/trajectory-materials.ts)，当前视口最多四个原模型请求获准读原model_input／output；折叠且已有准确模型名时不读隐藏输入，旧缺名才沿准确metadata回退。`retainCommon`仅给视口owner启用，只保留同source／scope／revision和完整target一致的当前交集文本，不保留移出目标、图片URL或过去scope。加入相邻loop不闪回已有正文，换源／断线立即隐藏并重新准入，重试不复用失败或旧成功。普通思考直接可读，父级和内部绑定ID移至原始记录；压缩仍不公开思考。旧无message事实时只显示准确请求上下文，不用当前消息表补造历史。

2026-11-09，本次逻辑操作改造以macOS arm64／Bun1.4.4／Chrome156的生产NativeDesktop编译组件和隔离事实／材料桥验证，最终资产`.cache/trajectory-browser-Nnq1Es`的`semantic-verification.json`与同一资产复用的`.cache/trajectory-browser-cLgiHD/verification.json`通过。48帧开关详情采样中，panel／header／timeline／tree的x、y、宽度及双向滚动范围差值均为0；深浅主题仅左侧1px且命中主题边框色，hover内部按钮保持透明。完整过程核对8种折叠组合、模型3次重连归1行及准确版本、Shell观察与真实终态、准确子范围、选中child工具后折叠→断开→重连恢复原参数Tab、取消／迟到材料、宽窄布局和拖宽；原事实未变，控制台错误与警告为空。主Agent人工核入口、消息、折叠、重连预览、Shell状态、hover和边框，并逐图核最终宽窄截图。相关展示／状态51项344断言、协议／真实writer42项308断言、Panel DOM17项254断言、子范围／材料Hook10项78断言、Service兼容4项33断言均通过；全仓7128文件类型检查、UI／Desktop构建、格式、API生成一致性、包边界、测试归属及文档检查通过。此证据覆盖实际组件与受控读取恢复，不代表安装态Electron主进程、真实Provider或其他平台资格；未操作用户Profile。

[子范围reader](src/trajectory-related.ts)只接当前原carrier核实的直接child Session／准确Run，固定在父cursor，最多并发3个metadata读取；[共用准入](../../packages/ui/src/desktop/trajectory/related.ts)用于展开、恢复选择及显示拼接。持久选择本身不授权读取，当前父事实未到时保留选择并等待。选中子任务内部节点后再折叠父级仍可阅读该详情；断线保留已读同源metadata锚点，正文立即清除并取消租约，重连重新读取准确子scope后才恢复，不借父Snapshot或缺Run的Snapshot。原namespace、事件、材料ref与版本继续独立。

[在线renderer](src/native-trajectory.tsx)经[Main reader](electron/trajectory.ts)→Client→Service加载固定范围，先核页再保存到本窗口临时IndexedDB，纯Controller／Projector负责播放／seek。原8项[SessionTabs](../../packages/ui/src/desktop/SessionTabs.tsx)在右侧栏“新标签页”的“工具”区打开独立轨迹页，同scope唯一；不增加主区域切换或重复reader。隐藏、离开与切Session取消读取、暂停播放并释放Evidence，不取消业务，原对话草稿与阅读位置由会话owner保持。

[前缀reader](src/trajectory-view.ts)流式扫描完整固定前缀，投影保留安全规范事件、原对象／父子、时间、ref／版本、usage与有限压缩metadata，不保存私有binding或完整正文。第一方公开display只来自原owner封存的有界模型、工具和消息摘要；缺失时不预读Evidence补写，第三方Trace继续排除display。新工作台走索引路径，选择、条件AND／多选OR、搜索和折叠只派生本地展示，不再为详情重扫原事件页。行按原观察顺序全局排列，普通阶段使用平铺展示depth，真实关系留在原事实，38px窗口化日志不把并行调用重排成DFS；全量行政观察以独立rowId区分同对象不同原事件。索引更新保留当前选择与原版本，缺失或筛选外选择给出说明，不回退成首项或祖先。

工作台默认显示消息、模型、工具与子任务、自动压缩和审批。原事实完整保留，主行按准确关联聚合逻辑工作：同一Model的自动重连归一行，Shell启动、Job及读取／等待／停止观察归一行，子Agent派发、carrier和返回归一行；显式重新执行不合并。顶部“轮次”“调用”“子调用”是三个独立开关；轮次和子任务可折叠，调用只精简阶段切片，真实操作保持同级；“时长”独立切换比例轴，条件过滤在单独“筛选”。定义分类、结构祖先、空筛选与临时展开规则归[UI owner](../../packages/ui/README.md#执行轨迹展示)。顶部轴按可比较的同来源观测时间分域，未知时间保留独立定位，事件顺序模式不冒充耗时。宽容器详情默认40%，可沿分隔拖宽并保存比例；窄布局由轨迹容器而非整个窗口宽度决定，小于840px使用覆盖Sheet，关闭恢复原列表位置和焦点。右侧栏自身窄时也不会强行挤成双列。

[分型详情](../../packages/ui/src/desktop/trajectory/TrajectoryDetails.tsx)按节点选择概述／预览，Tool使用概述／参数／结果；系统、消息和思考使用各自专属Tab，没有通用生命周期列表，原事件／phase／修订继续保存。普通操作概述与筛选使用轻量索引；系统、输入上下文、思考与输出切片在各自阶段Tab读取准确event/ref/contentVersion，其他材料按预览、参数和结果读取。所有节点均无原始内容入口，底层原事件及获准公开材料继续保存和沿原导出规则使用；不开放私有reasoning、权限、transport或任意私有payload；原正式model_output已保存且获准公开的reasoning在Agent loop思考详情直接可读，压缩预览抑制reasoning。结构分组不合成整组输入／输出；Tool接纳、Job终态与child返回保持独立。

[材料owner](src/trajectory-materials.ts)在同一所选材料集合内管理有界读取，绑定generation、来源scope、fixed upper、cursor、展示行／原观察、Tab、ref／版本及请求epoch。A→B→A、切Tab／来源、隐藏／关闭与权限变化清理旧结果、取消原读取并关闭准确lease；迟到open也沿原资源关闭。分块仍核连续offset、总长和view SHA。换筛选不替换原选择／版本时不重开材料；浏览器document隐藏同样释放当前读取。旧游标不使用普通正文reader的latest放宽。

[材料解码](src/trajectory-evidence-view.ts)消费受限公开DTO。`tool_input`为原Tool执行请求JSON，空对象、null、缺封存和不可读分别表示；历史Reader不读今天intent或相邻Model补参数。工具结果按原definition／version确定的白名单presentation复用只读结果视图；Files原差异、Shell保留输出／gap、浏览器与PDF正式图片只沿原Artifact读取，不按路径或URL重新获取。旧材料缺少typed字段时仍用原公开文本／JSON回退，不按工具名猜成功或媒体。

压缩概述使用原同口径before／after计数及采用状态，调用usage另列；没有准确发布事实不称已采用，缺值不填0，摘要来自原Model公开输出。Model与发布Context保独立来源和父子，默认当前前缀可沿确证关联说明采用结果；显式旧观察不带入之后发布。消息正文与模型材料同样独立，未完成前缀与之后完成版本分别绑定。

[Trace设置](src/native-trace-settings.tsx)对工具参数等材料种类提供独立显式选择；新增`tool_input`不扩大旧manifest、已存grant或原metadata权限，显式重新授权才进入新epoch。第一方材料读取不授予Trace外发。新V1字段／材料的兼容与负向授权回归见[独立兼容测试](../service/test/isolated/trajectory-workbench-compat.test.ts)；当前读端继续接纳未提供新字段的旧V1事实，不承诺旧闭合schema读端透明理解新增种类。

2026-11-09，macOS arm64／Bun1.4.4／Chrome156.0.8078.81，以关闭diagnostics的生产Vite资产和隔离bridge执行[连续浏览器回归](test/trajectory-browser-runner.fixture.ts)，最终制品与`verification.json`归本机`.cache/trajectory-browser-RBqGJm`。实际组件按确认原型对齐四泳道／刻度网格、轻量图标筛选与搜索、彩色类型标签、层级细线、轮次分组、行尾观测时长／状态、蓝色选中态及详情层次。`prototype-dark-wide.png`、`prototype-light-wide.png`是实际1024px容器裁图，沿真实分隔条恢复40%详情并关闭回放；`prototype-drawer.png`是300px窄栏全高详情。独立图审和主Agent逐图核对均无剩余视觉阻断，示例正文没有被填入生产metadata。

完整runner核新标签工具入口、真实父级与折叠／键盘定位、首次零材料请求、工具四Tab及原JSON／分型结果／规范Raw、外栏与内详情调宽、AND筛选与空集／单项清除、压缩12200→2600及准确摘要／采用状态、消息、固定历史新增提示及显式返回最新；保留原425条事实并追加200个独立实体后，347项匹配只渲染22行，末项仍可达。所有边界保持在视口内，`pageerror`及console／CDP原生warning/error为空。曾发现菜单Escape收起整栏、窄详情只覆盖列表剩余高度和退出前归焦触发aria-hidden警告；最终修复为菜单消费Escape、覆盖整个轨迹内容区、Sheet完成隐藏清理后归焦，`escapeClosedDrawer`保存返回原tool行／右栏保留／无隐藏祖先的反例。

同一最终资产另由ChromeDevTools page19人工观察：从新标签工具区打开轨迹，工具badge与四Tab正确；窄栏选择立即聚焦概述，键盘Escape退出后回原行且侧栏保留、console无error/warn。外栏键盘调至实测939.609375px后为并排布局，详情375.4453125px约40%，全部日志行38px；四泳道名称、0／4／8／12／16s刻度、蓝色选择与真实父级保持。前序同轮人工亦核压缩采用／摘要及用户消息被时长过滤后仍保原详情；最终暗浅裁图负责原型视觉对照，不以单张图替代过程观察。

离线新材料adapter另在生产编译隔离页面`.cache/trajectory-browser-K5GJed`人工逐步核610条事实：滚动／定位610，实际切预览后经4个分块读取原`result-7`，明确已保存前缀，lease归零；切到607–609无材料节点后旧正文立即清除并说明没有公开材料。连续换包关闭bundle-1／bundle-2、清除详情和旧正文，所有调用仅pick/events/close/evidence.open/read/close，console无error/warn，没有Runtime或Provider调用。UI DOM/state16项253断言、在线DOM5项41断言、离线DOM11项124断言、材料hook4项30断言、Session标签30项421断言及既有材料／状态回归通过；全仓11项目7087文件类型、UI／Desktop构建、API、适用边界／测试归属／文档检查通过。原事务、授权、导出／离线及私有材料反例的独立范围见各owner，未变底层结论沿原证据复用。本轮资格限源码、实际编译renderer与隔离bridge／本机受控Service，不授完整安装版Electron、真实Provider或跨平台发布资格。

同轮后续用户截图重新揭示行内按钮叠加hover背景、Sheet边缘继承前景色、打开详情抖动，前述静态图审未覆盖这三项过程缺口。修复仅在UI行样式、详情边框、主动focus的`preventScroll`及viewport替换后的绘制前锚点恢复。macOS／Bun1.4.4／Chrome156生产资产的完整回归归本机`.cache/trajectory-browser-Qbb8U8/verification.json`：行／折叠按钮hover与active不叠背景，深浅主题均仅1px主题左边框，窄栏打开／关闭保持横向位置及树滚动38，超过300实体的宽栏详情开关保持滚动5000；无页面异常、焦点隔离警告或浏览器warning。主Agent另从正式标签入口，实际操作300px与758.85px容器的开关、Escape归焦、hover及外栏键盘调宽，并审查连续录屏中13.10–13.77、26.10–26.77、64.80–65.80和94.98–95.65秒的进入／退出画面，未见底层工具栏／时间轴／列表整体位移；原片归本机`.cache/trajectory-browser-Qbb8U8/manual-process.mp4`。录屏资产与clean回归的JS／CSS SHA相同。范围限本次三项源码及受控编译页面，未重新验收安装版Electron或真实Provider。

以下2026-11-08消息／树页面的旧证据保留其原日期、构建与范围，不作为本轮新布局、拖宽／覆盖详情或新typed材料的验证。

同日消息上下文迭代在生产编译Chrome156隔离页面`?messages=1`逐步观察：用户原文读准确事件2／`message-revision-2`；回复完成版本10读完整正文后，再从生命周期读取原版本4仍为已保存前缀；第二轮回复从18→19→20持续使用同一message节点及原Model父，更新清除旧正文，完成后可读完整新正文。关闭／重开经历加载占位再恢复同一消息与出参，默认／全量保持四个原消息身份及父关系，草稿始终`Draft A`，材料lease归零，无浏览器error／warn。26个去重过程状态与准确材料请求保留在本机`.cache/trajectory-browser-SdJAJS/message-review.json`，预览已停止。这是受控fixture bridge与编译renderer的验证；真实Store／Runtime另覆盖普通输入、steer／follow_up、旧解释公开回答、多来源、旧prefix和namespace降级；没有操作用户Profile、调用真实Provider或重验安装版Electron整链路。定向218项回归和门禁范围归UI owner。

同日四类过滤的受控生产编译Chrome156页面（`e8a483d65`加本轮工作树，macOS arm64／Bun1.4.4）逐步观察默认混合树、工具出参原事件12／`filter-tool-output-v1`、显示全量、选择问答再关闭全量回退原工具、自动压缩运行→完成→原结果挂接，以及追加问答不进入默认树、默认／全量关闭重开的选择与Tab保留。重开采样经过加载占位再恢复原压缩节点，没有冒充根节点；原草稿始终`Draft A`，材料lease归零，无浏览器error／warn。过程摘要在本机`.cache/trajectory-browser-PBj895/filter-review.json`；索引未到时切换全量保留缓存选择的最后修正另由完整树DOM覆盖。133项定向回归及类型／构建／文档门禁通过，具体范围归UI owner。这是明确fixture bridge与隔离页面的验证，没有操作用户Profile、调用真实模型或重新验证安装版Electron／真实Service整链路；此前未变的读取准入、导出及关闭边界复用下述原证据。

同日用户实机截图的42条旧记录经只读核对均在格式启用边界之前（来源620–661，启用边界661，fact均为NULL），不是树投影把已有typed事实改成未知。UI现显示“旧记录 · 原事件类型”，并说明旧格式未保存可读入参／出参；现行未知来源独立标识，旧记录不补关系或材料。当前会话后续新执行即可产生新格式记录。[旧／新混合隔离场景](test/trajectory-browser.fixture.tsx)的`?legacy`仅属于测试制品：连续观察42条旧记录、现行未知和typed模型切换，旧入参保持明确空态且零材料读取，新模型仍读取原事件3的准确版本；没有改动用户历史或启动用户模型。两份完整纯投影／树18项、完整DOM7项、真实Store隔离schema／reader／flow14项合计39项／446断言通过；Trajectory／UI／Desktop类型及Trajectory／UI构建通过。该补验确认启用前后区分与展示，不代表旧日志能恢复缺失事实。

2026-11-08，`e8a483d65` 加树界面工作树，macOS arm64／Bun1.4.4／Chrome156.0.8078.81：使用生产编译资产与受控 bridge 的[隔离页面](test/trajectory-browser-runner.fixture.ts)连续观察模型输入、工具结果、授权生命周期、切节点／Tab、断开与重连、历史新事实提示及返回最新。旧材料在切节点和断开时清除；历史位置437、树滚动200保持至显式返回最新，随后上界439且原工具选择保留，原会话消息与草稿各保持一份。关闭重开覆盖“加载占位→原read_file／出参／滚动180”的中间与最终状态；没有短暂冒充根节点。在线长树共437条原事件、425条原长轨迹仍保留，生命周期详情有界分页；自动脚本截图在本机`.cache/trajectory-browser-fQo5Xx/`。另观察[离线页面](test/trajectory-offline-browser.fixture.tsx)610条记录的宽屏左右分栏、390px上下布局和深浅主题；位置610的原输出明确为已保存前缀，材料lease归零，只有原本地文件接口调用，没有Runtime／Service构造权。53项纯投影／reader及45项UI／离线DOM共98项通过；构建、类型、文档和适用边界检查通过。本段覆盖开发源码及实际编译隔离页面，未重新取得安装版Electron、真实Service全链路或其他平台资格；下述此前列表界面Native证据只复用于未变的Main／HTTP／文件权限与关闭边界。

[离线包](electron/trajectory-bundle.ts)是本产品单文件容器，复用 Client manifest／section 验证；无通用解压、外部路径或 URL fallback。导出由 Main 系统选择目标并在准确 generation 下重核来源，默认只含事件，显式选择后才复制获准 Evidence；先写私有临时文件、核内容并原子发布。[独立窗口](electron/trajectory-offline-window.ts)只提供 `trajectoryFiles` preload，冷开早于 Runtime／Profile 启动，生产 CSP 禁网络。[renderer](src/native-trajectory-offline.tsx)没有 Client／Runtime 构造权，包内容只作为查看状态。

含证据导出只复制当前获准的类型化材料。旧封存 Artifact 观察若曾将私有 Model 封装标为可用，准确的 `artifact_scope_denied` 只使该通用材料在包内缺失；对应 Model typed Evidence 仍独立读取。其他 scope／身份／完整性／取消失败继续中止发布，不能借导出放宽通用下载。仅事件包或未封装的可选材料，在原 event/ref 已验证后于材料区显示“此包未包含该材料”；不把正常缺少可选材料显示成整个轨迹读取失败。错误范围／引用、字节损坏和实际读取失败仍明确报错。

[Trace 设置](src/native-trace-settings.tsx)通过 [闭合 bridge](src/native-trace-bridge.ts)及 Main／生成 Client 管理本机 Host。安装、配置、grant 与 enable 分开，所有外发许可默认关闭；password 提交即清空，不进入草稿或设置快照。历史任务的扫描、连续 ACK、死信与 [OTel 远端状态](../service/src/trace-integrations/opentelemetry/README.md)分开；写入结果未知只读刷新，原工具／Full 模式不授予外发权。

Main 的在途 open／Evidence read 进入原 owner 的关闭屏障；迟到 lease 先登记再核选择，关闭等待这些请求并释放准确原资源。单文件 reader／writer 共享原 close promise；关闭失败保留实际 FileHandle 和原失败原因，不以重开替换。多次初始离线打开串行复用同一窗口建立过程。相关回归归 [Main reader](test/isolated/native-trajectory.test.ts)、[文件 owner](test/isolated/native-trajectory-files.test.ts)及[容器](test/isolated/native-trajectory-bundle.test.ts)。面板展示回调按其原 render baseline 合并实际变动字段，避免列表模式／锚点更新覆盖 loader 已推进的 descriptor 或播放游标；[差量回归](test/trajectory-presentation-state.test.ts)核这些交错。

2026-11-08，`e8a483d65` 加本次工作树，macOS arm64／Bun1.4.4／Electron44.3.0：[真实在线夹具](test/trajectory-online-native-driver.fixture.ts)经 SQLite→HTTP→Client→Main IPC→生产 renderer 完成10阶段。逐段观察原游标保留及新记录提示、返回最新后立即切全部事件、流式原 prefix 与完成后旧材料、双向 seek、开合／切 Session、原 WebContentsView 显隐与焦点，以及实际 Evidence 请求等待时关闭 tab。366帧未发现重复可见消息；47次轨迹 HTTP 均200，关闭实际中止原请求并关闭准确 lease，Electron正常退出0。末段切另一 Session 的原始截图处于布局动画中，未作通过依据；同一 Profile 冷开只复验该段，[布局夹具](test/trajectory-online-native-layout.fixture.ts)逐帧确认最终1100×780窗口内面板完整、无横向溢出，核心 cursor／Model／Command 前后相同。本机材料在 `.cache/trajectory-online-native-A4mAG9/`。

[独立生产冷开夹具](test/trajectory-native.fixture.ts)在最终构建实际核加载→展开→原保存材料→回退→播放，页面错误0、无HTTP／WS请求、只暴露file bridge、所选Runtime Profile未创建；本机材料在 `.cache/trajectory-native-9DK4Oq/`。线上及离线的浏览器组件过程还覆盖长轨迹分页、阅读锚点、隐藏重开与 seek 中间状态；真实过程发现的 closed-controller 白屏、漏新提示、Evidence 布局／锚点及 seek 空白均在原 owner 修复后复验。`.cache/trajectory-browser-6XXtLI/` 另保审批等待→回答→派发、原失败→独立重试→完成、unknown／并行 child、断开期间新增→重连、冷 remount／空态及8项容量的过程图与观察记录；这是生产 renderer 加明确 fixture bridge 的受控验证，不代称 Main 发起这些业务变化。纯播放不新增 Provider、Tool、审批或业务写入。

[真实导出夹具](test/trajectory-export-native-driver.fixture.ts)另在同一原 Profile 完成11阶段：生产按钮→系统 SaveDialog→Main／Caller／真实 HTTP→原子包，再分别冷打开仅事件包与含证据包。夹具只替代系统选路，等待时文件均未发布；两包同为 upper30／28事件，仅事件30998字节／0材料，含证据1163784字节／24材料。99次有限HTTP包含旧私有Artifact的8次准确拒绝；24个材料lease全部关闭，typed原前缀仍可读。前后业务水位30→30、Execution／Command／Interaction和逐条事实摘要相同、Provider／审批调用0，三个Electron进程正常退出，无临时包；材料在 `.cache/trajectory-export-native-Xgpl5a/`。原仅事件缺材料时的全局错误误义已修，[冷读定向夹具](test/trajectory-export-cold-missing.fixture.ts)只复验该包的5阶段，最终 `.cache/trajectory-export-cold-missing-URyOQ4/` 确认局部缺失说明、关闭后正常seek／返回30，包SHA不变、零网络／Profile／页面错误且exit0；原失败图保持。受控renderer恢复过程另在 `.cache/trajectory-browser-CUDDqP/` 观察unknown、并行child、原Model结果未知、Recovery及新尝试按序出现，原未知不改写为成功。

Trace 设置的最终生产 Native 经真实 Main／Client／候选 Service 完成空态→安装但未授权／未开启→独立当前 Session 范围与 metadata 授权→凭据提交清空→停用／撤权→卸载。卸载清除所选详情与动作，不再 inspect 已退休安装；[DOM回归](test/isolated/native-trace-settings-dom.test.tsx)4项33断言通过。过程 cursor 2→2、Model数0、renderer错误0，原资料在 `.cache/trajectory-settings-native-NEctSL/`。本机 OS 凭据绑定返回 `service_unavailable`，只确认失败被保留、密码清空及显式清理，未取得 OS 写入成功资格；非活动句柄显示“不可用”。以上限本机源码／候选构建，未据此取得安装版、Linux／Windows或远程 Collector 后端资格。


[Native transcript](src/native-transcript.ts)对原 Run 的 `necessary_condition_unsatisfied` 使用已知完成条件失败说明，保留已保存的正文与工具结果；不把该事实误写成模型连接失败或没有最终回复。异常摘要和正文沿同一处选择，原上下文失败、中断及未知原因的说明保持。该展示不修改完成条件、审批、版本、工具回执或重试资格。[真实 DOM 整文件](test/isolated/native-transcript-dom.test.tsx)25项／483断言通过，包含已有输出后的失败与冷重建、零重复和无运行中状态；Desktop类型检查1291文件、全仓6558文件／9 projects及定向Biome通过。

2026-11-07普通 `testDiagnostics:false` Native 的真实 Luna／medium 自然任务覆盖三模式中文方案保存、四次计划人答、拒绝后三模式新问题及原计划待答时Full→Auto→Full。40份完整Model输出、80条Execution与10个Run保存；三个计划拒绝均由原Tool返回简短说明并直接结束原轮，零后继Model／实施效果。Full原计划写入与读回成功，模型三次抄错进度Run ID的原失败保留；正是该样本暴露上述错误展示。修复后重建普通制品，沿同Profile冷开逐段观察正确说明、原拒绝历史与新回复，原Run／Execution／Command／Interaction／Message完整摘要和文件字节均保持，零重放，Main正常exit0且三个Session owner释放。报告与原失败边界归[模型验证](../../tests/e2e/live/model/README.md#当前-v1-扩展验证8秒默认)，不以这次冷读追加真实模型样本或授予其他平台／完整发布资格。

[本地工作树导航](src/native-worktree-navigation.ts)只消费目录有限 `worktreeSource`，在同 Store 可见根 Session／Workspace 内验证来源，标题栏的“退出工作树”和独立无附件退出命令沿 [Native](src/native.tsx)刷新目录、核原 nonce 后调用既有 select。创建原会话 cwd 未变时仅说明，无来源时保草稿并提示，不向模型回退；解释、引用、代码、复合正文及带附件输入仍走原聊天。退出不创建 Run／Tool／Job、不调用 Git/remove、不改权限或停止原任务，各会话草稿和阅读状态继续沿原切换流程保存。Main 只传 Store 已核有限关系，未引入新 IPC、工具或版本；自动审批策略与导航意图指导分别由 Agent owner 维护。

2026-11-06，`8364d9e40`加退出／Auto差量、Windows x64／Bun1.4.4／Electron44.3.0：八 workspace 构建后重启普通桌面客户端，在真实旧 linked-r2 项目观察输入草稿→标题栏退出→来源历史、返回 linked 恢复草稿，再以独立“退出工作树”命令返回来源。过程无新消息占位、重复正文或旧会话串入，原来源草稿保持；只读前后核对两个 Session 的 workspace/context/nextSeq、Run/Model/Tool/Job 计数、Git登记和文件摘要完全相同，零新执行，原失败历史不改写。材料在本机 `.cache/worktree-exit-20261106/{before,after,result}.json`。源目录读取等待中的整体变暗曾在夹具暴露，已改为仅阻止重复发送，草稿保持可编辑；最终生产 renderer 已由开发热更新加载。

[Native 新对话／导航 DOM](test/isolated/native-new-conversation-dom.test.tsx)整文件94项／1924断言通过，最后的等待中编辑分支另有12项／142断言定向通过；[导航与原输入](test/native-worktree-navigation.test.ts)、[输入](test/native-input.test.ts)及模型合同合计12项／118断言通过。原[会话外壳浏览器 runner](test/session-shell-browser-runner.fixture.ts)的 `--worktree-navigation` 显式测试制品在 Chrome156 深浅主题各12阶段、309连续帧通过：核目录／选择／历史等待、无模型／缺目录、原来源不动、来源不可见及迟到响应不覆盖后选；等待时普通控件颜色／透明度／编辑资格与矩形保持，期间新草稿往返后完整保留。未见欢迎闪现、重复或跨会话正文，页面错误与业务／删除／权限提交均为0。报告在 `.cache/worktree-navigation-browser-20261106.json`，最终阶段图在 `.cache/session-shell-browser-JbARMT/`；旧候选证据保留，不以最终图代替过程观察。本机验证不授任意真实模型、完整安装版或其他平台资格。

统一 Shell 启动沿[Shell owner](../../packages/agent/src/tools/shell.README.md)使用 shell_execute；background:true 仍显示原后台受理及 Job 状态。Native 从准确原调用读取 description 作为摘要，完整命令和审批事实保留；无 key 的新调用从已核原结果取得 shell_id，不在客户端推导或生成。后台目录仅据准确父 Tool 来源的 background:true 接纳新后台项，历史 shell.launch 兼容，默认前台不误入后台列表。

Git 工作树错误沿[Main 工具事实](electron/tool-message-fact.ts)核原内容、原 Execution 和 Run 的准确 `builtin.shell/git.worktree@1` 注册，再向[Native 工具消息](src/native-tool-messages.tsx)投影有限 `worktreeFailure`。详情用中文区分进程启动、权限拒绝、Git 命令及核验失败，保留原消息正文和部分／未知效果、清理未确认说明。旧 generic 不从 stderr 或 EPERM 猜审批；可选 Run 读取失败回退原文，不阻塞消息。私有 IPC 不传完整 Run 配置，不增加重试入口、公开调试开关或工具版本。

2026-11-06，`8364d9e40`加错误分类差量／Windows x64／Bun1.4.4／Electron44.3.0：八 workspace 构建后重启普通 `desktop:dev`，沿真实窗口观察选择来源会话→加载→完整历史→展开已结束轮次→工具组→权限拒绝详情。原 `permission_denied` 显示“策略未批准，未记录用户明确拒绝”、未开始与不自动重试说明，原英文原因只保一份；展开后全部可读，无工作树重试按钮，侧栏原创建历史图标保持。没有提交新模型任务或审批动作；旧模型错误结论保留原文，不追溯改写。此窗口验收仅覆盖已有策略拒绝历史，三类错误的完整执行回归归[Windows tests](../../packages/agent/test/isolated/tools/git-worktree/README.md)，不授完整安装或真实模型重试资格。

同轮 [Main 工具事实](test/native-tool-messages.test.ts)35项／1407断言及[实际 Native DOM](test/isolated/native-tool-receipt-render-dom.test.tsx)17项／272断言通过，另核原消息／Run 注册不符回原文、可选读取失败、畸形 JSON 安全回退和权限拒绝不覆盖显式 partial／unknown／completed。[原聚合浏览器 runner](test/native-live-tool-aggregation-browser-runner.fixture.ts)新增隔离 `worktree-errors` 场景，用真实 Main 投影和生产 Native／样式逐层展开7种回执，浅色1280与深色780通过；1151帧及阶段图观察加载、折叠、分组／错误展开、原文接管、普通刷新和会话往返。三类提示、旧记录未分类及 partial／unknown／清理说明均可读，原回执各一份，无重试／扩权按钮；刷新保原详情节点和 scrollTop90，切B无旧错误，回A保展开及阅读位置，页面错误与横向溢出均为0。本机材料在 `.cache/native-live-tool-aggregation-Vrntsc/`；先前 driver 遗漏正常三层展开的失败材料保留于 `QHy3id`、`wKtVy1`，不改产品默认折叠规则。该隔离受控回执验收不代替完整 Electron／模型／发行资格；类型、47份本任务代码 Biome及文档／边界检查通过。

[Controller](src/controller.ts)在核实所选 View 后，并行读取独立的扩展展示、待处理交互、Context、权限模式、工作区信任及活动原 Command，减少会话切换的串行请求等待。全部读取仍绑定同一 activation signal；必要事实完整核实后才发布快照，取消、迟到结果、原命令身份与写资格检查保持。[Controller 回归](test/controller.test.ts)覆盖并行启动、等待完整事实、100次快速选择及旧权限读取消；[刷新回归](test/native-refresh.test.ts)继续覆盖通知积压和读取期间撤销写资格。模型目录加载与切换期间的控件稳定显示合同保持。

[NativeCaller](electron/native-caller.ts)将 SSE ready 的同选择 reconciliation 登记为当前读取的后继，等待原显式选择读取结束后才启动，避免互相取消代次；真正读取前重核选择、关闭与取消状态。显式选择等待已登记的后继完成，实际读取错误继续传回，切换后的迟到结果仍拒绝；其他只读调用保持原 drain 范围。2026-10-26 macOS arm64／Bun 1.4.2 在本轮清理工作树先复现模型输入目录的 `native_selection_changed`，修复后 [Caller 门控](test/native-caller.test.ts)、[原 205 请求目录](test/native-model-input.test.ts)、Controller 与刷新四个完整文件为 55 pass／0 fail／541 assertions，Desktop 类型检查通过。此为受控回归与真实 Core／Service 目录验证，不替代完整默认、实际窗口或其他平台资格；下文原失败记录保留当时范围。

2026-10-25，Windows x64／Bun1.4.3，`aefb47472` 加本次读取 diff：上述两份完整回归13项81断言通过，Desktop／Agent typecheck通过。由[会话文件浏览器夹具](test/session-files-browser-runner.fixture.ts)派生的本机隔离入口 `.cache/session-switch-live.ts` 使用真实 NativeCaller／HTTP／SQLite、两个会话及受控分段模型，实际观察发送接管、会话切换、长回复上滚、草稿往返及页面重载后完整尾段；用户和Agent消息各保一份，切到其他会话没有旧正文或草稿。证据目录为 `.cache/session-files-browser-5ca00750-91c7-4e02-a403-651c05d15a66`，冷读截图为 `.cache/session-switch-final.png`。本次未量化真实安装窗口的切换延迟或复验原1.1GiB内存峰值。额外[导航DOM](test/isolated/native-session-navigation-dom.test.tsx)为27通过／3项执行状态断言失败；[会话外壳浏览器夹具](test/session-shell-browser-runner.fixture.ts)在“上次状态”文案断言失败，均未计为通过，也未改其断言。它们的模拟桥不经过本次Controller读取实现；原完整UI／安装资格不由本轮定向结果取得。

普通 Workspace／明确外部路径写入的完整快照同样复用消息内交付卡。外部文件只提供原交付的阅读，不借用 Workspace 的编辑器打开权限。2026-10-23 最新 Main／交付 DOM 两文件12项118断言通过；工作文件删除、改动不改变原快照，中文跨页仍完整。受控浏览器中 Plan 修订为版本2后，选择 Auto 并批准，原待审卡退出、原轮次继续结束；此结果不外推 TUI／安装版资格。

会话文件已接入 Main 字节准备、稳定导入、原消息绑定及后续 [Files 读取](../../packages/agent/src/tools/files/README.md)；输出和 Plan 的准确会话文件可由现有文件入口打开。下述受控页面、IPC 合同与真实 Node 冷查分别证明其覆盖的路径，不替代完整 Electron 安装制品或其他平台资格。

会话输出在对应工具消息提供“查看本次交付的文件”。[历史 reader](electron/file-changes.ts)核原 succeeded Execution、原结果 revision、scope、Artifact 成员及完整 hash／size，按完整 UTF-8 边界返回每段至多64KiB；界面提供续读和回到开头，当前文件被改动或删除也不改旧版本。“打开当前文件”仍单独走原编辑器路径及准确登记重核。历史读取目前沿 Client 完整 Artifact reader 后分页 IPC，不宣称流式磁盘分页或大文件内存限额。

本地 `files.view_images@1` 和 PDF `files.read@5` 复用[图片 reader](electron/input-image-reads.ts)及 [NativeUserImages](src/native-user-images.tsx)：Main 只接观察到的完成 Tool 消息和索引，核原执行及准确引用；图片工具1至10张PNG、每张最多8MiB且整批16MiB，PDF仍最多4张／16MiB。renderer 不能指定任意引用或路径。后继轮次、Fork 与冷历史按原来源读取，预览缓存只负责显示，不承担历史保存。原件和实际模型图片的持久目录由[Files owner](../../packages/agent/src/tools/files/README.md#本地保存与缓存目录)维护。

图像工具消息按准确成功回执显示“已查看 N 张图像”，默认展开120px圆角缩略图；标题可折叠，成功时不铺原始JSON或重复文件名。混合工具分组把图片放回所属工具，计数只来自 Main 核实的成功引用。加载、关闭、切换和失败重试沿原读取租约与窗口预览缓存。[原执行来源回归](test/input-image-reads.test.ts)覆盖图片／PDF跨Fork与伪造scope拒绝，[共享工具聚合](../../packages/ui/test/isolated/desktop-tool-aggregation.test.tsx)覆盖准确计数、折叠与零重复；[隔离浏览器 runner](test/tool-image-preview-browser-runner.fixture.ts)使用真实组件和预览 Worker，观察加载、折叠取消、成功、切换、hash失败与恢复全过程。它是明确测试制品，不由普通dev/prod开关启用；受控桥／Chrome组件验证不代完整Native窗口或安装资格。

2026-11-04，`686a384e5`加本次diff、Windows x64／Bun1.4.3／Chrome156：[实际 Native 页面回归](test/isolated/native-tool-receipt-render-dom.test.tsx)10项139断言、工具聚合29项1124断言通过，包含后续普通工具加入时保留已展开图片。浏览器12阶段（含10图等待／完成／折叠）逐图核对通过，缩略图完整120×120、阅读位置保持、单图最多一图、10图同次恰10张且顺序一致、取消／切换后零租约，hash失败的重试文字在深色主题可读且实际恢复；本机截图及报告位于`.cache/tool-image-preview-H3ilVi`。夹具最初误等不会结束的CSS滚动时间线，已限定等待普通披露动画并设置5秒上限；串行最终构建与12阶段均通过。全面更名后的Main来源、实际Native页面和聚合回归再次通过；上述更名前的Chrome像素证据按未改变的中文文案、布局和读取生命周期复用，不冒称已重跑该浏览器程序。此前全窗口自动化初始化失败，未取得完整Electron窗口或安装资格。

2026-10-23，`ba34a2e6` 加本轮修复、同一 Windows 开发环境：实际页面观察复制中源文件变化的失败提示、准备中状态、显式取消保留草稿与后续重新添加。补正准备完毕但界面未接纳的生命周期：signal 保持到 `addFiles` 接管，失效输入或丢弃的晚结果释放准确 Main 项，已接纳附件不随准备结束删除。[准备 owner DOM 回归](test/isolated/native-input-files-dom.test.tsx)1项30断言和 [Composer 回归](../../packages/ui/test/isolated/prompt-editor.test.tsx)8项78断言通过。最新页面再次混选文本／PDF／图片，实际观察发送占位→一条持久用户消息→三次读取→页图与报告交付→终态；源文件删除后重载，原图片、页图和历史正文仍可读，没有重复消息或卡住。该观察使用上述隔离浏览器桥，仍不代证完整 Electron 安装窗口。

2026-10-23，`5c28cd1fd` 加当前会话文件工作树、Windows x64／Bun1.4.3：[会话文件浏览器夹具](test/session-files-browser-runner.fixture.ts)通过真实页面、Main 请求、HTTP、SQLite、Artifact 与受控模型逐步观察三种附件准备、删除临时源文件、发送占位接管、文本与 PDF 读取、页图、输出写入、进程关闭后重开及后继编辑。旧报告与修改后报告同时展开核对，各保原版本；过程未见重复消息。原 Plan 文件经普通 Files 修订后，审核显示相同修订正文和版本2。Main／DOM 历史交付与工具展示三文件23项284断言通过。夹具的传输桥、模型和私有 UI 数据端口是测试替身；不证明完整 Electron IPC、外部编辑器启动、真实模型识别或安装版资格。普通侧栏在此窄视口出现零宽现象，未计作通过；消息内交付阅读独立可用。

Desktop renderer的普通图标沿共享`--ui-icon-size:14px`，原16px的设置返回、设置分类及提供商页面SVG局部覆盖同步消费该变量；按钮点击区域、文字字号和原生窗口／托盘资源保持原规则。

产品展示名称统一为 **Kite**：共享侧栏、启动页、页面与窗口标题、关于菜单和原生提示使用相同大小写。原 `kite-native` 运行标识、workspace 包名、IPC 与本机偏好键保持，已有用户数据路径保持。

## Windows 托盘与窗口图标

[Main](electron/main.ts)在 Windows 启动时设置固定应用身份 `dev.kite-code.native`，使用 [Kite 原生图标](app-icon.ico)创建窗口和唯一托盘。双击托盘或选择“打开 Kite”恢复最小化的原窗口并显示、聚焦；普通关窗仍只隐藏。托盘“退出”调用原 `app.quit()`，立即移除托盘并隐藏窗口，正常清理最多4秒，未完成就终止自有Service并退出，整个退出不超过5秒，不等待状态检查或确认，退出期间不重新显示窗口。

ICO 沿用 [SVG](app-icon.svg)，包含 16、20、24、32、40、48、64、256px 图像。[构建入口](scripts/build-native.ts)在开发热更新与固定 renderer 两条路径共用的阶段复制图标，正式 Native 的现有完整文件清单自动包含该资源。托盘生命周期与安全退出回归沿用 [Main 夹具](test/isolated/native-main-scheduling-lifecycle.test.ts)；它验证主进程接线，不代替真实 Windows 通知区域操作。

2026-10-24，Windows x64（10.0.26300）／Electron44.3.0／Bun1.4.3：Main 回归30项352断言、Desktop typecheck、定向Biome与文档检查通过。普通 Main／生产 renderer 构建在独立 Profile、真实配套 Service 下正常启动并退出；随后仅在隔离测试制品加入私有观察端口，逐步观察关窗隐藏且托盘保留、投递 Tray 双击事件恢复并聚焦同一窗口、最小化后恢复，以及点击托盘原生菜单“退出”。最终 Main 退出0，准确所属 Service PID 已消失；观察记录在本机 `.cache/native-tray-live-20261024`。双击事件与菜单展开由该测试端口触发，原生菜单退出由实际 Windows UI 点击；没有取得通知区域物理双击／右键或完整安装包资格，不将该端口加入普通开发或正式客户端。

## Markdown 与附件输入

桌面主会话的 [Native 内容样式](src/native-content-theme.css)为用户与 Agent 消息共用 14px 正文、430 字重、1.625 倍行高、12px 正文块间距和 2px 同组列表项间距。标题沿各级比例排版，表格内容沿用正文行高。表格由共享滚动容器绘制 1px 圆角外框，Native 内容样式控制透明表头和横向分隔线。`NativeDesktop` 从当前 Store 的项目目录向共享正文传递 `fileRootUri`，供文件引用提示显示路径。引用激活仍复用原 `messageFile.open`，由 Main 核实当前消息、项目和文件。格式规则见[桌面手册](../../docs/handbook/clients/desktop/README.md#提示词与附件)。

2026-11-13，Windows x64／Bun 1.4.4／Chrome 157，在 `04807430e` 起的工作树用[发送夹具](test/prompt-send-browser-runner.fixture.ts)核对深浅主题与 1280／800px 的正文间距、投递占位、保存接管和冷重开。[文件引用夹具](test/markdown-content-browser-runner.fixture.ts)在 1280／390px 核对流式闭合、悬停移开、键盘提示和激活、读取暂停及缓存返回。四组[流式夹具](test/streaming-render-browser-runner.fixture.ts)逐帧核对渐显、上翻、重连、终态交接和首段正文位置。编辑器实开与安装版 Electron 未在本轮验证。

2026-11-14 在同一 Windows 浏览器夹具补核表格四边外框、圆角、列宽与宽表格的键盘横向滚动，页面宽度保持在视口内。

同日以 Windows x64／Chrome 157 核对统一字体。浏览器实际绘制的正文字形为 Segoe UI 与 Microsoft YaHei UI，代码与 Shell 输出使用 Consolas。深浅主题与宽窄窗口核对发送、正文接管、打开和退出设置、文件引用提示 13px，以及流式换行与重连时的阅读位置。macOS 系统字形尚待实机核对。

提示词输入使用UI的原生多行[PromptEditor](../../packages/ui/src/desktop/PromptEditor.tsx)，只编辑原始Markdown字符串，不预览或标准化源文。首次发送、已有会话投递占位、已保存用户消息和Agent正文复用[MessageContent](../../packages/ui/src/desktop/MessageContent.tsx)，[PromptMarkdown](../../packages/ui/src/desktop/PromptMarkdown.tsx)仅增加用户正文的高度与展开控制，内部复用同一renderer；表格对齐、CJK强调、公式、提示块、脚注和图表沿共同语义与Native内容主题。输入法、选区、撤销及scope隔离见[UI owner](../../packages/ui/README.md#markdown-提示词编辑)与[纯文本输入决定](../../.agents/notes/implemented/bug-fix/2026-11-07-plain-prompt-markdown-messages.md)。[Native展示](src/native.tsx)让普通inline用户正文在占位与历史之间保持同一组件位置；[正文reader](src/native-model-output-message.tsx)保留完整读取、复制与文件打开准入。外部HTTP(S)链接仍经Main校验交给系统浏览器，文件路径由原messageFile.open核验；草稿链接只是文本。正文首末及引用／列表／单元格边缘不叠加外边距，末尾一级／二级标题不显示分隔线和其留白，有后续内容时保留原排版。普通用户正文默认约360px上限，矮窗口收敛至约半屏；超出时通过泡内渐隐／内阴影的“展开”按钮阅读全文，可再次收起。附件、发送失败／未知提示及全文复制不被裁切，手动展开随同一节点跨接管／缓存保留，冷重开默认收起；具体生命周期沿UI owner。

2026-11-07补修输入区闪烁，仍基于`556398400`加当前工作树、Windows x64／Bun1.4.4／Chrome156.0.8078.80：发送等待原本使原生textarea disabled、透明度降到0.55并丢焦，首发历史接管又因启用`synchronizePresentation`重建准备身份而隐藏footer一帧。Composer现只阻止重复提交，loading期间输入保持可编辑；SessionPage记住未启用屏障时已显示的准确scope，保存记录接管不重新隐藏，同scope资格不跨会话沿用。首发等待中的新编辑即时绑定原创建意图的目标Session，受理只消费原草稿；可见Session接管后才清理准备页副本，回执丢失也不覆盖新编辑或显式清空。[输入回归](../../packages/ui/test/isolated/prompt-editor.test.tsx)、[页面回归](../../packages/ui/test/isolated/desktop-session-page-render.test.tsx)及[Native新对话回归](test/isolated/native-new-conversation-dom.test.tsx)按准确`./`路径逐文件`bun test --parallel=1 --max-concurrency=1`，共143项／2614断言通过，保留不同scope加载、页壳重用、未知恢复及附件断言；其余未变Markdown、复制、滚动和transcript结论沿前述证据。生产浏览器夹具补核深浅×1280／800px的新旧会话loading中编辑、重复Enter／form零重发、受理后新草稿保留、随后连续发送，以及逐帧原生节点、透明度、焦点、边框和光圈稳定；原四组Markdown、折叠、历史和冷重开同跑。最终报告见本机`.cache/prompt-send-browser-Ktx917`，最终源码资产在`.cache/prompt-send-browser-vOMug3/dist`；修前禁用变暗、首发隐藏帧及逐步观察材料在`.cache/prompt-input-flicker-20261107`。UI／Desktop类型、UI Desktop构建、格式、边界、测试归属及文档检查通过；仍仅为浏览器生产renderer与隔离桥，不扩展Electron安装、真实Service／Provider或其他平台资格。
[transcript](src/native-transcript.ts)以已保存用户消息的`humanInput.publicCommandId`或`originCommandId`提供稳定`presentationKey`；旧记录仅有sourceIds时，[Native](src/native.tsx)只在当前Store／Session的原Run确认该来源后使用其原commandId。继承记录不能借用当前投递身份；相同正文不会用于关联，独立两次输入保留两条。稳定标识只负责展示，不替代物理消息ID、业务回执或操作权限。[首条消息回归](test/isolated/native-new-conversation-dom.test.tsx)核Markdown与附件在延迟选择／历史交接过程中的原节点；[transcript回归](test/isolated/native-transcript-dom.test.tsx)核当前输入、已保存消息、选区、两条同文与冷挂载。

首条输入的回复进度由 [Native](src/native.tsx) 按原 Store、会话及提交身份投影。提交当帧显示本地准备，原 Run 接管前保留该状态。确认本轮主模型已经派发时切换为思考，等首段正文接管。已核实的 Run 和本地状态用原提交身份共享一个会话展示节点，确认执行后不会因之后的读取交接重新显示准备。模型重连、终态及提交失败继续用所属的真实事实。[会话控制器](src/controller.ts) 直接消费会话协调返回且已核实的新 View，成功路径省去一次相同的 GET。[首条消息回归](test/isolated/native-new-conversation-dom.test.tsx) 分别暂停受理、选中、Run 和模型派发，并核对首个流式正文与终态。

2026-11-11，macOS arm64／Electron 44.3.0，隔离实窗连接真实本机 Service 与分段测试模型。首个可见回复状态从旧版约 377ms 提前到修后约 5–9ms，与用户消息同帧出现。最终 595 帧覆盖首轮、流式追加、手动上翻、事件流断开和恢复、终态先于最终历史约 230ms、切回会话及模型失败。首段正文出现前状态行位置一致，首段正文按完整高度进入。断线复现了旧 View 上界落后于已读正文，导致回复消失和滚动归零。修后 [历史读取](src/native-history.ts)拒绝用落后上界替换同一会话已读正文，断线状态显示在会话标题栏。断线、续流和最终接管都保留单份正文、输入焦点、下一条草稿及原上翻位置。模型失败在原会话显示，Renderer 冷重开保留一条用户消息及原失败，未再次请求模型。旧版和修后样本、截图在本机隔离测试目录。相关回归见[历史高水位](test/native-history.test.ts)、[连接状态](test/isolated/native-history-presentation-dom.test.tsx)及[三段模型与工具实窗](test/isolated/native-reasoning-render-electron.test.ts)。

2026-11-07，`0bf501bc` 后续首发接管修复：已受理但目标选择或模型目录尚在读取时，准备页中的继续输入和显式清空仍写入原创建目标的草稿缓存；准确目标接管完成后清除准备页副本，自动读取恢复沿同一收尾路径，不能把新文字留给下一次新对话。[Native 新对话回归](test/isolated/native-new-conversation-dom.test.tsx)新增 accepted 后分别延迟选择和模型目录的四种情景，原码实际出现新文字被回执前草稿替换，修后核目标草稿、原输入节点、零重复发送及新准备页空白。Linux x64／Bun1.4.4 的定向 DOM 回归 1 项／80 断言、原新对话整文件 108 项／2287 断言和 Desktop 类型检查通过；该证据不是真实窗口或安装包验收。独立依赖安装的原生文件 postinstall 因缺少 Cargo 未完成，未据 DOM 结果声明原生文件能力通过。

隔离[发送浏览器夹具](test/prompt-send-browser-runner.fixture.ts)使用生产`NativeDesktop`与编译CSS，仅由测试桥分开受理、历史保存和回复阶段，保存测试历史供页面冷重开；Agent返回原提示词以比较用户与Agent消息展示。逐帧核首次绘图、正文节点、尺寸、透明度和消息数量，并核原文编辑、原生撤销、输入法、完成、刷新与缓存返回。另核单独／末尾标题、引用／列表内标题、标题后正文及末尾分隔线的实际边缘样式，以及长消息默认收起、内阴影展开、手动状态接管／缓存保留、冷重开重置、键盘展开／收起／隐藏操作定位与矮窗口下结果未知提示可见。控制只存在于测试制品，普通dev／prod诊断常量保持关闭。此范围不代替真实Service／Provider、完整安装版Electron或系统断线资格。

早一轮Lexical子集的验证不作为当前三处统一GFM的验收依据。此前沙箱组合运行中的真实Core压缩曾在`client.connect`返回`network_outcome_unknown`，同一完整transcript文件在宿主复验通过；旧日志保留于本机`.cache/prompt-markdown-20261107`，该环境失败未被解释为Electron体验通过。

2026-11-07，Windows x64／Bun1.4.4／Chrome156.0.8078.80，在`556398400`基础上的早期手写编辑阶段完成共享Markdown编辑器：13个完整定向文件216项／5406断言通过，覆盖编辑、语法与缓存、公式、流式、复制、阅读滚动、首条消息、真实transcript和正文读取；UI581文件／Desktop1283文件类型、UI Desktop构建、边界与测试归属检查通过。深浅主题×1280／800px四组生产页面核全选完整源文、表格单元格与撤销、Chromium组合输入提交／取消、提示块编辑、代码与公式源码修改及后续输入、三处语义DOM与排版、占位→受理→保存→Agent回复、缓存返回和冷重开。每组投递接管正文child/text变更为0，气泡节点、尺寸、透明度和消息数量保持；冷重开源码→图像的正文尺寸与阅读位置保持。逐阶段截图与连续帧归本机`.cache/prompt-send-browser-qAUNwd`；另逐步观察未知结果保留原文、确认后接管且零重发，修复前后证据及日志归`.cache/prompt-shared-markdown-20261107`。依用户要求实际体验验证仅用浏览器；阶段由隔离桥控制，不代表完整安装版Electron、真实Provider或其他平台资格。

用户先否定手写编辑体验并选择Milkdown，随后明确取消提示词输入中的Markdown渲染；当前已移除两套编辑内核，早期编辑验证不作为原生输入的验收。2026-11-07，Windows x64／Bun1.4.4／Chrome156.0.8078.80，`556398400`加当前工作树：13个完整定向文件211项／5385断言通过，覆盖原文输入、语法与缓存、公式、流式、复制、滚动、Native首发、真实transcript及正文读取；UI581／Desktop1283文件类型、UI Desktop构建、边界与测试归属通过。`bun apps/desktop/test/prompt-send-browser-runner.fixture.ts`四组深浅主题×1280／800px生产Native renderer页面核原文、不渲染输入、同文跨会话原生撤销隔离、撤销／重做、中文组合输入提交／取消、Enter／按钮立即发送、受理、历史接管、Agent同文回复、缓存返回和冷重开；用户与Agent的语义DOM及逐元素字体、行距、表格、公式样式一致。接管期间正文child/text变更为0，节点、尺寸、透明度和消息数量保持；首次与冷重开图像生成前后正文尺寸及阅读位置稳定。四组各补10种消息边缘场景：末尾标题外边距为0，独立标题仅保留气泡上下各8px内边距，标题后正文仍保留分隔线与间距。长消息在1000px窗口中气泡为360px，560px矮窗口中正文裁切区为264px；展开保持完整DOM，受理和历史接管不重置选择，收起及键盘访问隐藏内容保持操作可见，结果未知保留原始草稿和裁切区外恢复提示。最终源码重新构建后的截图／连续帧与生产资产归本机`.cache/prompt-send-browser-iq25BX`，逐步观察与日志归`.cache/milkdown-20261107`。实际体验验证只使用浏览器及隔离桥，不代表完整安装版Electron、真实Provider、系统断线或其他平台资格。额外旧内容夹具在与Markdown无关的设置页标题字重断言处失败：未修改的HEAD规则为500，旧断言要求600；该完整夹具未计入通过。

[网页链接入口](electron/external-links.ts)由 Main 为当前准确 renderer 注册新窗口处理：只将不带凭据的 HTTP／HTTPS 地址交给系统默认浏览器，始终拒绝创建新的应用窗口。延期投递前重核窗口与 renderer，拒绝本地文件、自定义协议和无效地址；浏览器启动失败显示“无法打开链接”，原聊天仍可阅读并再次点击。消息内标题／脚注继续由共享 Markdown 在原消息跳转，输入框编辑链接仍不导航。[Main 回归](test/isolated/native-main-scheduling-lifecycle.test.ts)核接线、地址拒绝、页面变化／关闭与失败重试；[Electron 回归](test/isolated/native-browser.test.ts)通过原 MessageContent 的鼠标点击、键盘 Enter 和消息内跳转核系统打开请求与原窗口保持。Main 更新需完全退出并重启客户端。

2026-11-02，Windows x64／Bun1.4.3／Electron44.3.0，`840f71b31`加本次链接修复：`bun test --parallel=1 --max-concurrency=1 ./apps/desktop/test/isolated/native-main-scheduling-lifecycle.test.ts`为33项／388断言通过；`bun test --parallel=1 --max-concurrency=1 ./apps/desktop/test/isolated/native-browser.test.ts`为1项及实际窗口断言通过，Desktop typecheck、定向Biome、边界、测试归属及文档检查通过。隔离夹具另启用真实系统打开，在可见回复上实际点击 Excalidraw，Main准确交出原GitHub地址，系统Chrome出现对应项目标题；全过程记录原聊天仅一条回复、相同页面地址和滚动位置，无脚本错误。观察产物位于本机`.cache/native-links-acceptance/`。Computer Use随后因无法可靠识别浏览器当前URL而停止，浏览器页面截图未完成核验；自动回归中的系统打开端口为替身，真实点击仅覆盖本机隔离组件窗口，不代表完整安装包或其他平台资格。生产renderer诊断常量保持关闭，未调用模型。

用户消息的图片和普通文件通过 `SessionPage.renderMessageAttachments` 从正文气泡中分离，由 [NativeUserImages](src/native-user-images.tsx) 接入[共享 Attachment 列表](../../packages/ui/src/desktop/MessageAttachments.tsx)，沿原文件后图片的顺序显示，超宽时横向滚动；正文、时间和复制归原消息。首次发送及已有会话发送冻结附件名称作为占位，接管前不再将图片数量写进正文，也不借用已被草稿释放的 blob URL；历史确认后由原图片 reader／缩略图缓存显示预览。原输入身份、图片暂存、文件引用、读取与失败重试不变。空正文且没有需显示的真实格式／读取状态时不创建正文内容。产品尺寸和操作归[桌面手册](../../docs/handbook/clients/desktop/README.md#提示词与附件)。

2026-10-23，Windows x64／Bun1.4.3、Chrome155.0.8059.85、`7af0dee6b` 加本次附件工作树：[图片浏览器夹具](test/image-previews-browser-runner.fixture.ts)的 `--attachments --observe` 在生产组件与样式中逐步观察深浅主题×1280／390px的发送占位→保存预览、滚动两端→键盘回翻、刷新→缓存切回、失败→仅附件→重开；正文位置、消息顺序、时间／复制数量和横向溢出均核对。发现并修正仅附件消息被空正文过滤、失败边框跨附件和窄屏焦点裁切；最终 `--attachments` 四组通过，并补核重开图片就绪与焦点轮廓。过程截图／报告位于本机 `.cache/image-previews-browser-SfuHgK`，最终复验位于 `.cache/image-previews-browser-Xpmahn`。[首条消息DOM回归](test/isolated/native-new-conversation-dom.test.tsx)70项通过，包含文字＋文件／仅文件的延迟选择与历史接管；图片读取、输入附件、消息复制及阅读滚动定向回归通过。此为隔离生产组件及受控桥接验收，未取得本轮完整安装版Electron、真实模型或其他平台资格；既有嵌套 `@keyframes` 编译提示保留。

消息内容通过[共享 Markdown renderer](../../packages/ui/README.md#markdown-消息内容)显示 Mermaid、语法高亮／diff、提示块、公式及消息内标题／脚注跳转。主消息、子详情与后台正文沿原 `NativeModelOutputMessage` 复用；本文不扩展 Web 或 TUI 的独立展示能力。正文绘制沿共享 `StaticRange` 快照保留逐字素渐显；追加时重核每个绘制范围，不把绘制范围登记成随所有文字变更同步维护的live Range，原连续Text节点与用户选区保持。同一Document的待绘制节点先集中读来源颜色，再发布原逐字绘制，避免跨节点交错强制重算样式；同步正文、独立时序及隐藏／纠正／释放后的失效边界保持。公式语法已加入 Worker 的同一固定 parser，图表／KaTeX排版留在 renderer；纯Worker入口不引入DOM或可视化库，原CSP、Main IPC、完整正文核验与复制资格保持。

2026-10-25，macOS arm64／Bun1.4.2、Chrome155.0.8059.86、`ccd1201d5`加本次样式工作树：`bun apps/desktop/test/markdown-content-browser-runner.fixture.ts`通过1280／390px及深浅主题，核代码底色／无外框、行内代码小圆角／无底线、引用、五类提示图标和标题、链接悬停／键盘聚焦、输入编辑、准确源码复制与原图表恢复。五类提示标题对实际合成底色均至少4.5:1；表格原字号、内边距、网格与透明表头保持。实际浏览器逐步观察深浅切换、图表生成、流式开始→追加→完成及390px换行；同一500px视口下表格的样式和几何与改动前完全一致，代码和行内代码的原节点在追加／完成后保留。报告和过程截图位于本机`.cache/markdown-content-browser-I8m5Eq`。原`bun apps/desktop/test/streaming-render-browser-runner.fixture.ts`四组场景通过，核选区、手动阅读、缓存返回和完成状态，材料位于`.cache/streaming-render-Rs1qbD`；仅后续链接优先级与提示标题配色由前述内容夹具重新构建核实，未改变流式管线。六个Markdown／代码复制／正文复制／输入编辑／流式／滚动回归逐文件独立运行通过27项／1073断言，UI与Desktop typecheck、定向Biome及文档结构／影响检查通过。此为隔离生产组件与受控Native桥接验证，未重验完整安装版Electron或真实Service／模型；既有嵌套`@keyframes`编译提示保留。

2026-10-22，Windows x64／Bun1.4.3、`beabc9628` 加本次Markdown工作树：[内容浏览器夹具](test/markdown-content-browser-runner.fixture.ts)用生产Vite资产、原生产CSP和Chrome155.0.8059.85通过1280／390px，覆盖深浅主题、五类图表、未闭合围栏、错误后恢复、源码复制、脚注往返、读取暂停和会话缓存切回，未发起外部资源请求。实际逐步观察生成占位→图表、源码展开→切会话→恢复、错误→修正及主题变化，并修正默认阴影与小图放大；字体从本地资产加载。[纯Worker构建回归](test/native-markdown-build.test.ts)核新增公式树仍可在无document／window／Node的VM运行；组件与输入编辑证据归[UI owner](../../packages/ui/README.md#markdown-消息内容)。此为隔离生产组件验收，未取得本轮完整安装版Electron或其他平台资格；保留既有嵌套`@keyframes`编译提示。

2026-10-23 补充 Windows x64／Electron44.3.0 实际窗口验证：同一工作树通过 `buildNativeDesktop` 构建普通 Main／preload／生产 renderer，`testDiagnostics:false`，连接真实配套 Service、独立 Profile 与本机兼容 SSE Provider；没有使用开发 HMR 页面或用户配置。由普通输入框发送一次请求，人工逐段观察10段输出：未闭合行内公式保留原文，补全后排版；块公式增量补全正常；Mermaid 未闭合围栏显示源码，闭合后经过绘制提示成为流程图／时序图；追加正文与表格没有重复图表，表头下边线与其他表格边线一致。手动上滚稳定后追加内容保持阅读位置，返回最新恢复跟随；错误图表回退源码，后续合法图表与公式正常显示。完成时运行指示消失、复制按钮出现、正文保持一份；源码展开后切换会话再返回保留展开与阅读位置，深浅主题均可读。正常退出并冷重开后，原图表、公式与完成状态读回，Provider 总请求仍为1；两次 Main 均退出0，准确所属 Service PID 已消失。临时复现入口为本机 `.cache/native-markdown-live.ts`，分段输入与进程记录保留于 `.cache/native-markdown-live-20261022/events.json`；本次不新增生产代码改动。范围仅为当前 Windows 隔离构建的上述实际操作，不代表正式安装包、远端模型、其他平台或所有流式分段组合；此前浏览器与组件回归证据继续按原范围适用。

2026-10-23 主题色修正：用户指出流程图／时序图缺少主题色，确认原 adapter 将全部线条映射为正文色。现改为深浅主题各自的蓝色节点边框／箭头和青色生命线／辅助边框，继续透明底。`bun apps/desktop/test/markdown-content-browser-runner.fixture.ts` 在 Chrome155／1280与390px下通过；新增解码图像像素断言核对蓝色确实绘出、时序生命线有青色、背景主要透明及深浅切换，页面错误和外部请求为0。生命周期隔离回归1项／22断言、UI与Desktop typecheck、定向Biome通过。再用当前生产renderer、`testDiagnostics:false`、原独立Profile和真实Service构建Electron44.3.0窗口，冷读原消息并实际检查亮／暗流程图、时序图与主题切换：颜色更新，文字可读，阅读位置保持；切换后先保留旧图再异步替换，不承诺颜色与页面背景同帧变化。此增量只复验主题色，前述流式时序／冷读等证据按未变化范围复用，不据此扩大安装或平台资格。

产品操作见[桌面手册](../../docs/handbook/clients/desktop/README.md#提示词与附件)。[共享 Composer](../../packages/ui/src/desktop/Composer.tsx)按 MIME／图片扩展名分流。图片保留现有字节流程；普通 File 由 renderer 分块读取，每块至多 64 KiB，经闭合 IPC 交给 [Main 准备 owner](electron/input-files.ts)，不让 renderer 自报路径触发 Main 任意文件读取。每窗口最多 128 个准备项，单项及总量至多 256 MiB；显式取消、移除与换代终止所属准备并释放 Main 项，上传在途保留预算直到真实完成。

新会话先创建准确 Session，再将冻结准备项通过 Service 流式发布为 Artifact；稳定导入 ID 绑定 Store／Session／draft ID。ACK 丢失先 GET 原导入，同 ID 不重复创建逻辑附件。调用 journal 保存已准备引用，原 command 接纳事务完成绑定；未知提交保留原意图而不盲目重新发送。历史附件和占位仍使用原文件名，普通附件从此不依赖源路径。未发送草稿仍仅保窗口生命周期。旧路径附件不静默转换。

2026-10-23，`ba34a2e6d` 加本次会话文件工作树、Windows x64／Bun1.4.3：[普通附件 IPC 回归](test/isolated/native-session-files-ipc.test.ts)实际构建生产 preload，在 VM 中接入真实 Main handler、NativeCaller、Service HTTP、SQLite 与 Artifact，31断言通过。准确 sender、未完成／已释放／换代准备项和传入字节复制均核对；在实际 Windows Artifact 临时文件写入边界注入一次 ENOSPC 后，确认临时文件关闭并删除、输入导入与绑定均未形成、无 command／caller journal／模型调用、原文本草稿保持。解除故障后直接复用原准备 ID 和原字节重试，随后分别丢弃成功上传与 command 的 ACK，确认 GET 查回原导入，只有一次成功上传和一次 command POST。重建 caller 后首次 GET 再丢回执，第二次只查回原 command，原消息绑定、完整 Artifact 字节与模型调用数保持。此为实际链路写失败注入，不是物理磁盘满额资格；Electron 传输和此例私有 UI 数据端口为替身，也不代证完整 Electron 进程冷恢复。

[普通文件 DOM 回归](test/isolated/native-input-files-dom.test.tsx)接真实 Main 准备 owner，核活动 FileReader 上显式 AbortSignal 取消及 scope 换代均不 append／finish、不生成 ready 草稿，并释放准确准备项；重新选择随后成功。本例本轮1项30断言通过；[Main 字节回归](test/input-files.test.ts)的原预算与字节合同证据继续适用。取消后的用户全过程观察仍以上述浏览器证据为准。

[真实 Node 冷查](test/isolated/native-caller-journal-host.test.ts)使用 Node24.15.0、真实私有 SQLite journal 与 Profile 准入：原 `run.start` 携普通附件，在真实 HTTP 接纳后断开回执并强制退出 caller，冷进程首次 GET 再丢回执，后续只 GET 查回原 ID／摘要／scope，零重发；原附件绑定与字节仍可读。另两例核合法恢复活动 Run 后的 `input.steer` 原 ID 查回及已完成原公共 Run 的冷查，三例共102断言通过。冷重开本身不启动新模型或恢复业务效果。既有 `execution.cancel` 子进程夹具依赖 Unix Shell，在本机仍为 `shell_unavailable`；该独立平台限制不由附件或 command 查回测试取得资格。

[文件入口](electron/file-changes.ts)保留原消息／执行回执核验；默认读取版本增加 5，旧 3／4 保持可读。打开 Profile 中的输出或方案时，先通过当前 Session 的 Files／Planning 查询匹配准确绝对目标，再核实际目录身份、规范路径与单链接；其他受保护路径仍拒绝。历史预览与“打开当前文件”的含义分开，外部编辑不会改变原保存的预览。

会话输出的中文／含空格文件名与Files、备份共用[纯名称／路径合同](../../packages/agent/src/tools/session-output-path.ts)。Native只在路径语法通过后继续查询当前Session的准确登记并重核物理对象；合法中文名不再被额外的ASCII正则排除，未登记、其他Session、受保护目标与旧frame仍沿原边界拒绝。相关真实原生Files读写／Fork／备份恢复与Main受管文件回归分别归[Files owner](../../packages/agent/src/tools/files/README.md#会话文件与-pdf)和[test/native-file-changes.test.ts](test/native-file-changes.test.ts)，不从纯语法通过推定编辑器窗口资格。

开发热更新后的旧 preload 可能缺少 `fileReferences`，旧 Main 也可能拒绝图片暂存方法。[窗口适配器](src/native-input-images.ts)把原 `invalid_native_request/native_host_operation_unavailable` 识别为附件接口尚未加载；缺少文件路径解析 port 时以有限 `file_picker_restart_required` 错误交给共享 Composer，图片暂存直接保留明确的完全退出／重新启动提示。普通选择失败仍可重试，不展示原错误细节、不清草稿或重发。取消选择返回空列表。[窗口回归](test/isolated/native-input-images-dom.test.tsx)与[编辑器回归](../../packages/ui/test/isolated/prompt-editor.test.tsx)分别核旧协议、普通失败、取消和原草稿保持；主进程仍按原开发边界显式重新启动。

直接图片经[封闭 IPC](electron/native-ipc.ts)分块进入 [NativeInputImages](electron/input-images.ts)：每条输入最多 10 张，每张 16 MiB，窗口保留总量最多 128 张／64 MiB，核连续 offset、完整大小与 SHA-256。UI 在读取前拦截超量；[草稿 owner](src/native-input-images.ts)再次核已有与新增，IPC／Main 发布独立核每次输入的数量。Renderer 在任何读取前预留全部已选图片的窗口预算，跨添加批次串行准备；[原生异步编码](src/input-image-encoding.ts)以可取消 FileReader 完成摘要读取及 32KiB Base64 分块，避免逐字节字符串数组和整图 Data URL，摘要 buffer 不跨后续编码保留。移除或退出取消所属 reader，排队任务不再读取。Main 在原输入 journal 准备前，按准确 Store/Session 发布图片 Artifact，只把稳定引用放入正式命令；Provider 请求由 AI 转为内联 Base64，不使用外部托管或 Provider file ID。原 Command 与未知回执继续按原查询处理，不在窗口重开时重放上传或发送。未发送附件为窗口内草稿，不属于私有文本草稿的冷保存；成功受理才清理此次冻结的附件 ID。

历史图片由 [Main reader](electron/input-image-reads.ts)从已观察的准确用户 Message 取得引用，不接受 renderer 自报 Artifact；每次核 generation/viewSelection/historyEpoch，完整 Client Artifact 校验后分块交付。[Renderer](src/native-user-images.tsx)再次核大小／EOF／SHA，在可见区域前后 160px 内自动准备 blob 缩略图；原图读取等待 close 回执，预览准备完成后才接纳下一项，同窗口 bridge 按序执行。图片加载、错误与重试共用固定预览区域；同一观察范围内的普通历史同步只暂停新的读取，不卸载原卡片或已验证预览。远离区域或隐藏窗口取消所属排队／读取并释放 URL，回到可见区域时重新按当前观察校验。切换会话仍取消未完成读取，但图片 key 只含 generation、原消息及图片引用身份，不使用 viewSelection／historyEpoch；已核验 URL 由有界缓存 owner 持有，返回时复用原 img，淘汰或真正移除时释放，缩略图编码与RGBA像素估算一起计入原 UI 预算。CSP 仍只允许本地 blob 图片，不开放远程图片源。

[窗口缩略图缓存](src/native-image-previews.ts)由附件 owner 按 bridge／generation／当前Store创建，输入区和历史正文共用。原图先完成当前读取与SHA核实，再按完整hash／媒体类型／字节数／转换版本复用派生结果；普通重绘、viewSelection和historyEpoch变化不失效派生内容，缓存不替代Main准入或原始校验。相同原图的在途请求合并，单个调用者取消不影响其他调用者，最后一个取消则终止活动Worker或移除排队项。完成后只缓存派生Blob与尺寸；LRU最多128项，按缩略图编码字节＋宽×高×4估算合计32MiB。待转换原始输入包含活动项在内最多8项／32MiB。已显示URL的保留仍受原正文资源owner或草稿生命周期管理，不随派生LRU淘汰而撤销。清范围／卸载取消所有任务并清缓存；失败不缓存，旧Worker答复不能恢复已取消的结果。

[原生Worker](src/native-image-preview-worker.ts)只使用 `createImageBitmap`、OffscreenCanvas与 `convertToBlob`，单次处理一张，保持比例且不放大小图，长边最多512px，输出WebP质量0.8（平台不支持该编码时可返回PNG）；原生解码处理EXIF方向与透明度，GIF为静态首帧。原图Bitmap在绘制后关闭，临时Canvas在结束后释放；Worker空闲5秒终止，命中缓存无需重新启动。首次生成仍需解码一张原图，像素预算是派生数据估算，不能作为任意原图解码峰值或浏览器总heap保证。图片暂存、Artifact和模型输入仍使用原字节；输入预览失败显示“预览不可用”，不把它当成上传失败或阻止原图发送，历史卡片可显式重试。原生能力不可用时不回退到完整原图预览。取舍见[缩略图缓存](../../.agents/notes/implemented/architecture/2026-10-20-native-image-preview-cache.md)。

本轮[缓存回归](test/native-image-previews.test.ts)核合并、LRU、像素／条数／队列预算、取消、失败重试与scope清理；原[草稿](test/isolated/native-input-images-dom.test.tsx)和[历史图片](test/isolated/native-user-images-dom.test.tsx)继续核原发送字节、预览失败不影响暂存、门禁及URL回收。[真实浏览器入口](test/image-previews-browser-runner.fixture.ts)执行 `bun run apps/desktop/test/image-previews-browser-runner.fixture.ts`，仅使用隔离测试制品、生产组件和真实原生Worker，生成10张不同的4000×3000 JPEG，核512×384预览、转换时输入、历史刷新／会话切换／重选原文件不增加转换，以及完整原发送字节；另核PNG／WebP透明度、GIF及EXIF旋转。CPU减速仅是本机对照，不取得实际低性能电脑、完整Electron／IPC或跨平台资格。

2026-10-20 Windows x64／Bun 1.4.3／Chrome155.0.8059.82的隔离生产构建中，正常／4倍CPU减速下，10图从选择到原始暂存完成分别约710／1213ms，重选约133／801ms（包含原图hash、编码和模拟上传，并非缓存查询耗时）；转换并发峰值1。两种条件下连续30次A→B→A、30次历史刷新及重选后，转换总数仍为10，各自两轮共20次原图暂存的字节全部相符。转换期间输入成功，无达到50ms的主线程长任务，冷准备最大RAF间隔分别50／43.7ms；这组证据不表示全程60fps。报告与截图输出于 `.cache/image-previews-browser-*/`。

2026-10-18 Windows x64／Bun 1.4.3，本任务工作树的[图片暂存](test/input-images.test.ts)、[窗口草稿](test/isolated/native-input-images-dom.test.tsx)、[IPC](test/input-images-ipc.test.ts)、[历史读取](test/input-image-reads.test.ts)及受影响的原草稿／首次发送／导航 DOM 测试已运行；隔离 Chrome 实测 Markdown 快捷输入、撤销、路径引用、图片粘贴、Enter 与 scope 隔离。实际 HTTP／Provider 映射证据归 [Service](../service/README.md#图片输入协议)与 [AI](../../packages/ai/README.md#图片消息)。未调用真实付费图片模型，不据此宣布安装或跨平台资格。

2026-10-19 Windows x64／Bun 1.4.3／Electron 44.3.0，在独立 Profile 与合成 Workspace 的普通 Native 开发窗口中，用系统文件选择器经 `+` 选文件并点击发送；真实用户配置的 `deepseek-v4-flash`／chat-completions、自动审核模式完成两场景。工作区内含中文／空格／方括号的 ini 文件实际 `files.read` 成功，最终回复准确合成标记；工作区外 ini 的同一工具返回 `file_path_invalid`，同 Run 的下一次真实 Model 正常解释拒绝。两个 Run 的持久记录均为 `completed`，各两次成功 Model、一次 Files；完整封存 Model 输入核实工具结果进入下一轮、外部文件及说明正文未进入模型，均无 `context_source_unavailable`。[越界装配回归](../service/test/isolated/assembly-file-denial.test.ts)另1项／13断言通过。当前范围为手工原生窗口路径引用资格，不代表直接图片、PDF 正文解析、其他模型、完整安装或跨平台资格；不增加普通客户端诊断入口，用户 Profile 与配置保持。

2026-11-02 工具入口收敛：普通文件选择仍只发送路径；工作区外文本改由统一 `read_file` 读取，外部写入／编辑使用 Shell。私有资产和外部项目指令边界保持。下述 `read_user_file/files.read_path` 记录为原日期的历史证据，当前入口与验证归 [Files owner](../../packages/agent/src/tools/files/README.md#统一读取工作区外文件) 和 [Service 回归](../service/test/isolated/configuration.test.ts)。

普通宿主的外部只读工具曾遗漏于默认清单，上述强制工作区工具的拒绝测试不代表已选外部附件可用。默认补齐 `read_user_file` 后，同日同一平台／模型／自动审核模式重新在独立普通 Native 窗口经系统选择器选工作区外 ini，以普通“这是什么文件，读取实际内容”提问：模型实际使用 `files.read_path` 成功读取准确路径，回复实际字段值；原 Run `completed`、两次成功 Model、一次成功只读 Tool，完整下一 Model 输入包含准确文件内容，不包含同目录未选中的 `AGENTS.md`，无 `context_source_unavailable`。主输入和 `+` 仍只发送路径，不修改权限模式／配置、不复制文件或开放外部写入。当前默认装配归 [Service](../service/README.md#默认装配与业务规则归属)，取舍归[Note](../../.agents/notes/implemented/bug-fix/2026-10-19-default-external-file-read.md)。此证据限普通用户文本文件，不补齐二进制内容解析或其他模型／平台资格。

2026-10-19 同一平台／模型／协议的独立普通 Native 窗口补齐混合附件：经两个系统选择器选工作区外 INI 和直接 PNG，原正文保持，消息独立保存一个 `files` 和一个 `images`；两次 Model 成功、一次 `files.read_path` 成功、Run `completed`。最终准确回复 INI 两个合成字段、图片文字与两个红色方块，封存 Model 输入中的图片 Base64 与原文件字节完全相同，未包含同目录未选的 `AGENTS.md`，无 `context_source_unavailable`。本段补齐前述直接图片未知，仅覆盖真实 DeepSeek Chat Completions；其他提供商及 Responses 仍为受控 HTTP 映射测试，未扩为真实端点或安装资格。

同日 [Composer／草稿回归](test/isolated/native-input-images-dom.test.tsx)核编码中切换 scope、继续编辑、移除准确图片后停止后继分块及 finish、所属 URL／暂存释放、另一会话附件与正文保持；[编辑器回归](../../packages/ui/test/isolated/prompt-editor.test.tsx)核取消／迟到选择不进入其他会话。手工浏览器入口为 `bun run apps/desktop/test/input-attachments-browser-runner.fixture.ts`，只构建[独立测试入口](test/input-attachments-browser.fixture.tsx)，不改普通客户端、用户 Profile 或权限。实际 Electron 44.3.0 窗口验证 12 个文件在 720px／380px 容器中保持单行、横向滚至末尾、准确移除及会话隔离。四张各 16 MiB 的小 PNG 补齐文件分别在 1ms／8ms 模拟分块回执延迟下完成编码，Data URL 读取上限 32768 字节、各四次摘要读取／2048 个分块；两次观测均无超过 50ms 的主线程长任务，最大帧间隔约 37.7／49.9ms。时间包含夹具回执延迟，不代表实际 IPC 吞吐、超大像素图片解码或其他机器性能保证；dev／prod 无该观测入口。

2026-10-19，Windows x64／Electron 44.3.0，统一入口在[独立浏览器夹具](test/input-attachments-browser-runner.fixture.ts)中使用真实沙箱 preload 和系统多选，一次选择工作区外 INI 与 PNG：真实磁盘 File 路径解析成功、普通文件卡片与完成编码的图片缩略图并排显示、正文保持空白，只有图片触发一次摘要读取。夹具的图像 IPC 为模拟回执，此项不冒充新的真实模型发送或完整安装资格；原 Provider 映射未改。10／11 张边界、混选超限零附件 port、粘贴／拖入累计、分批预留、移除释放名额、Main 窗口计数，以及 HTTP 超限零模型请求分别由上述 owner 测试核对。

2026-10-19，本次 Windows x64／Bun 1.4.3／Electron 44.3.0 工作树针对流式抖动补齐验证：[Native 页面回归](test/isolated/native-history-presentation-dom.test.tsx)核活动 Run 的连续历史扫描期间，图片自动加载且卡片、img 与 URL 不被重复重建；[预览生命周期](test/isolated/native-user-images-dom.test.tsx)核六张可见图片只有一个活跃读取、视区／隐藏释放、切换后的排队取消与坏元数据零预览及显式重试。独立沙箱 Electron 窗口中，共享 Conversation 与真实 Native 图片组件使用合成 PNG 和受控 IPC 回执，24 次流式更新零向后跳，距底部最大偏差约 0.67 CSS px；12 次手动阅读更新中锚点和卡片高度偏移均为 0，切换后释放原 URL，返回后自动重新显示。此项验证实际浏览器布局与滚动，不代表新的真实模型或安装资格。

## 真实输入消息的唯一展示

首次发送与已有会话的引导／后续输入在构造原意图时共用 [promptTextForSend](src/prompt-text.ts)，只去掉末尾连续 CR／LF；发送占位与实际消息使用相同正文，编辑草稿保留原字节以供失败恢复及版本比较。Main 的自动草稿证明、[caller journal](electron/caller-journal.ts)准入和[私有草稿消费](electron/private-data.ts)允许原文或仅去尾换行的正文对应；仍核准确 Store／Session／草稿 revision 及原文 SHA，不因转换清除后来编辑。旧请求原文继续可读，不改写历史。纯函数、[Native DOM](test/isolated/native-new-conversation-dom.test.tsx)、[Main](test/native-caller.test.ts)和[真实 Node 冷读](test/isolated/native-prompt-draft-store.test.ts)分别验证转换、发送／恢复、原证明与受理后的持久清理。2026-10-25，Windows x64／Bun1.4.3：上述四文件125项、Desktop类型及定向Biome通过。隔离生产页面实际观察三个尾部换行的首发与续发、占位接管、草稿清空和回复完成；Native 请求及受控 Responses wire 均保留两个内部换行与两个尾部空格，末尾 CR／LF 为零，证据归本机既有 `.cache/session-files-browser-96f83a8f-934d-4d39-829c-3f094948e584/newline-*-send.json`。浏览器夹具的假草稿 ID 先前不符合正式 SHA 形状，首轮失败后按现有 Main 单测对齐该替身，未放宽生产校验；真实持久清理由 Node 用例单独证明，仍不代证完整 Electron 安装包。

新消息直接进入当前主 Agent；首次发送保留一条用户消息及实际 Agent 回复，没有额外的“关联工作”判定答复。运行中引导进入原轮次安全检查点，排队等待仍沿原队列；UI 不靠过滤新回复掩盖重复。相同正文的两次提交保持两个独立输入，冷重开只读取原历史。普通输入的本地投递占位在原持久用户消息到达后交接。新 `run.start` 消息在原事务保存 `originCommandId`，历史先于 Run View 到达时也能核对原提交并立即接管，不短暂多出用户消息；此路径同样适用于 Responses；带 `originMessage` 的继承记录不能消费当前 Store 的投递占位。旧历史中仅有 `sourceIds` 的原 `run.start` 消息也须核同 Store／Session／Run 与准确原 Command，不按正文比较或合并独立提交。Run 状态先于历史到达时，本地输入仍按原 Command 绑定该轮次，位于该轮状态、工具和回复之前；连续引导输入按原输入身份保存因果前驱，前条从本地转为持久消息时也不反转后条。

旧处理／业务双记录继续通过 [呈现投影](src/native-presentation.ts)消费准确 `Message.humanInput` 证明，只有本次读取含同 Session／原输入／公开提交身份的替代 Message 才合并副本。业务对象在原输入位置呈现，保原 ID/seq/Run/正文/附件；不改 SQL 顺序、不删除原历史、不按正文去重，Fork 只映射本分支已封存的替代行。证明来源归 [输入 owner](../../packages/agent/src/storage/sqlite/inputs/README.md)。

[普通页面回归](test/isolated/native-new-conversation-dom.test.tsx)保旧历史、缺替代行和独立同文的展示兼容。[真实普通 Electron 回归](test/isolated/native-human-input-electron.test.ts)使用实际 Main/Service/SQLite 与受控业务 Provider、关闭产品调试入口，核首次为用户→实际回复、正常退出冷重开零新提交，以及同文重交仍为独立用户→回复；SQL 不生成 raw/decision/processing，新请求无分类调用。

2026-10-25，新对话准备闪烁修复：Windows x64／Bun1.4.3，原[新对话DOM回归](test/isolated/native-new-conversation-dom.test.tsx)82项／1666断言、Desktop类型检查与定向Biome通过，新增暂停读取期间的目标展示、同项目控件节点保持、失败禁发及重试恢复断言。实际NativeDesktop／共享CSS在隔离浏览器中逐步观察重复点击→读取暂停→完成、其他空间→全局默认空间→迟到读取返回；目标高亮与项目名直接更新，重复点击期间分支节点保留，选择器不变淡，草稿保持，原请求不覆盖后选空间，页面无错误。该夹具使用模拟NativeBridge，覆盖此前仅共享SessionPage夹具遗漏的宿主异步准备过程，不替代完整安装版Electron或真实IPC验收。

2026-10-25，Windows x64／Bun1.4.3：连续输入修复在独立 Profile 的 NativeCaller→HTTP→SQLite 与本机受控 Responses SSE 页面观察到旧版第二次发送的额外用户占位；补齐原提交身份后，连续同文发送分别由一条持久用户消息接管，流式回复、完成及重载读回保持原顺序，重载未增加模型请求。Store 与 Native DOM 回归分别核相同正文的新 Command、幂等重查、冷读和 Run View 迟到；证据保留在本机 `.cache/session-files-browser-96f83a8f-934d-4d39-829c-3f094948e584`。浏览器桥与受控模型不代证完整 Electron IPC、真实远端模型或安装包。

## 普通客户端与测试诊断

2026-11-05，在`81bbe6c14`加当前默认重连、异常Alert和轮次展示修复的工作树，使用Windows x64／Electron44.3.0及完整Main／preload、诊断关闭的生产renderer、配套Service与全新SQLite Profile验证新请求。通过普通模型选择器和输入框发送一次请求，本机匿名HTTP端点逐次实际关闭TCP连接；逐步观察首次投递接管及1/5、2/5、3/5、4/5、5/5，始终更新原轮次的一条重连过程行，没有Alert或重复用户消息。耗尽后过程默认展开，摘要仅为中性用时，原行变为“重连失败”，展开后保留传输中断原因和网络／代理检查建议；运行期间输入的未发送草稿保持。正常退出再冷重开原会话，原失败行和详情仍可读，无Alert；只读SQLite确认原Run为`model_reconnect_exhausted`，重开前后均为6次实际HTTP请求及6个Model Execution，没有重放。两次Main正常退出0，所属Service与故障端点关闭。本机截图、UI观察和持久事实保存在`.cache/native-reconnect-physical-572b8da2-d908-4e9b-8d33-144b8bc3b700`，临时入口为`.cache/native-reconnect-physical.ts`。本次未修改业务源码，沿用此前定向回归与类型检查，补充文档门禁；覆盖当前源码构建的完整Electron链路和实际连接中断，不代表直接关闭整机公网、真实远端模型或完整安装包资格。

2026-11-05，Windows x64／Bun1.4.4，`0211e6590`加[默认重连修复](../../packages/ai/README.md)：用户刚才失败轮的只读SQLite仅首次Model、约3.5秒后`model_failed`，没有重试或可恢复的原始错误分类。修复后沿既有生产Native组件夹具、NativeCaller／Service／SQLite和独立Profile，以本机SDK传输注入`ENETDOWN`及无code的Error：逐步观察原输入接管、1/5→2/5、恢复后的原轮正文及成功过程记录，输入草稿保持；第二轮未知错误依次观察1/5、3/5、5/5、耗尽收起、展开原失败详情及页面重开，只有一条原重连行，没有过程外通用失败副本或内部日志。重开前后仍共9次尝试（恢复轮3次、耗尽轮6次），没有重放。截图和请求事实归本机`.cache/model-network-reconnect-20261105`，临时入口复用会话文件浏览器夹具。本轮未在普通客户端新增诊断开关；自动回归与认证／权限拒绝的单次请求反例归AI owner。该观察覆盖隔离浏览器生产组件及本机受控传输，不证明直接公网断网、完整Electron安装制品或其他平台资格。

2026-11-03 提交前衔接远端 `cf5b5c587`：保留远端活动过程固定展开、终态才可折叠及工具结果交回模型解释的产品规则。AI、Agent 重连／长度／标题／冷恢复／工具结果、Service HTTP/SSE、Native 轮次及 UI 过程／响应／滚动／复制／诊断共14个完整文件218项／4279断言通过，AI／Agent／UI／Desktop／Service 类型检查通过。旧 Responses unknown 夹具连续返回同一调用而超时，现按现行[工具结果合同](../../docs/handbook/features/tools-and-approvals.md)只提供一次模型解释，核原 unknown、原效果一次及冷读零重放；额外工具结果整文件的普通 Windows 临时根不满足私有 Profile ACL，改为独立新建数据子目录，并同步原终态 SQL 故障注入路径，16项原断言全部保留。新基线的生产组件页面再次观察活动过程无折叠按钮、失败展开内容位于原过程内、后续最终回复与冷重挂无过程外失败副本；本机证据为`.cache/turn-process-audit-rebased`，入口`.cache/turn-process-audit-rebased.ts`。原真实 DeepSeek 窗口证据保留原代码基线和范围，本次未重新执行外部模型或安装包资格。

[模型重连投影](src/native-model-connections.ts)消费同 Store／Session／Run 的公开 Execution `modelRetry` 及有限可重试失败码，在[原轮次投影](src/native-transcript.ts)中生成 `model_connection` 系统过程行。原前驱链聚合最多5次重连，次数显示不包含首次请求；位置保持在首次失败尝试的部分正文之后、重试输出和后续工作之前；收到输出即结算连接状态，不等待整轮完成。取消与停止中状态分别表达，已经收到输出的连接成功事实不被后续取消改写。它只负责展示，不新增重试、写入、工具定义或协议版本；恢复派发仍由后端原合同控制。后端以`model_reconnect_exhausted`确认耗尽后，原行结算为“重连失败”，通过[共享重连行](../../packages/ui/src/desktop/ModelConnection.tsx)展开有限分类映射的中文原因和建议，移除同Turn外重复的通用失败提示；正常重连、成功和取消不提供错误详情。当前 View 未包含的旧尝试不由正文或耗时猜补。[原轮次 DOM 回归](test/isolated/native-transcript-dom.test.tsx)覆盖作用域、因果位置、重试接管、折叠、恢复、停止及冷读。

轮次摘要沿[共享Conversation](../../packages/ui/src/desktop/Conversation.tsx)统一使用中性进度／耗时：运行中保留原阶段文字，结束后只显示已核实用时，无可靠时间时显示“用时未知”，不附失败／停止／中断标签或状态颜色；展开后的真实失败和重连原因继续保留。

普通客户端的[异常提示](../../packages/ui/src/desktop/TurnFailure.tsx)使用公共 Alert，以中性信息图标、圆角细边框和灰色正文显示详细原因与检查建议。Native 在原因未知时说明记录不足，已知项目说明读取失败时保留准确说明。主会话按原轮次顺序保留异常提示，思维链维持用户的展开选择。原输入拒绝尚无 Run 时继续保留未启动事实。原失败码及恢复诊断限于隔离诊断制品，重发仍由用户操作。

2026-11-03，进一步审查 Native 主／子会话投影、系统消息 producer、共享 Conversation 及页面提示入口，发现通用 `turn_failure` 原被排除在过程组外并重复作为结果渲染，现归入准确原 Turn。过程／响应、Native 轮次、阅读滚动与复制共5个完整文件61项／1911断言通过，UI／Desktop 类型检查通过。Windows 隔离生产组件页面沿真实 `desktopTranscript` 转换受控历史，逐步观察执行中→失败收起→展开过程及工具→后续完成回复→冷重挂：中间说明、引导、压缩和失败均在原过程内，收起／冷读后只留下原输入、本轮失败摘要、后续用户输入和真实标记的最终回复，没有过程外失败副本、压缩摘要正文或重复消息；未将模型上下文的系统指令作为会话消息。原 Agent 来信／独立结果、ask、重连、取消及压缩交接由同一 Native 整文件复验。截图与 DOM 观察在本机`.cache/turn-process-audit`，临时入口为`.cache/turn-process-audit.ts`；该页面使用受控业务数据，未重验真实远端模型、完整 Electron 安装包或其他平台。此前真实窗口的网络／预算／停止证据保持其原范围。

2026-11-03，继续在 Windows x64／Bun1.4.3／Electron44.3.0 对同一修复工作树进行真实窗口验证：完整 Main／preload、普通生产 renderer（诊断关闭）、配套 Service 与独立 SQLite Profile，通过本机 HTTP 转发器实际关闭连接；恢复请求透传到现有 DeepSeek `deepseek-v4-flash`，没有合成模型回复。连续断线共6次请求，首次请求后的重连在原 turn 过程内更新至5/5，耗尽后停止；过程展开再展开原重连行，可读原因是连接传输中断，并附网络／代理检查建议，没有内部码、日志或额外失败正文。重连期间输入的草稿及阅读位置保留。两组分别连续断开2次后，真实远端均返回200及正文“8”／“13”，过程保留2/5连接成功事实，没有恢复占位正文；第二组放慢故障节奏，逐步观察首次等待→1/5→2/5→真实回复→终态折叠。另在1/5进行中点击停止，最终为“重新连接已停止”，该组仅2次请求。正常退出并冷重开，旧失败详情仍在后续用户消息之前，成功／停止记录保持，请求总数仍为14，无重放；最终 Main／所属 Service 及转发器正常退出。阶段截图、UI观察、实际请求元数据及冷库保存在本机`.cache/native-reconnect-real-bfd3b3db-2bfd-4096-9819-dca77a26317a`，临时入口为`.cache/native-reconnect-real.ts`及`.cache/rebuild-real-service.ts`。首次受限沙箱启动超时仅是未进入业务的测试装配失败，允许本机回环后重新执行。测试显式注入隔离配置路径和只读凭据解析，密钥仅从现有用户配置读入内存，未复制或修改用户配置；覆盖真实远端模型与源码构建窗口，不证明默认凭据后端、完整安装包、直接公网断网或其他平台。生产源码未再变化，复用下述188项定向回归及类型／边界检查，本次补充文档门禁。

2026-11-03，同一Windows／Bun1.4.3、`09d13bd65`加5次重连与易读错误修复：AI SDK、Agent重连／长度续写／标题／冷恢复、Service Responses／持续任务、Native轮次及UI活动／滚动／诊断共11个完整文件188项／3742断言通过。AI／Agent／Desktop／UI类型检查、定向Biome、边界、测试归属及文档门禁通过。原预算内核首次加5次请求、第5次成功、耗尽终态、已释放原执行权拒绝恢复、明确新任务、部分工具零效果及冷恢复计数；受限沙箱中的长正文读取／本机HTTP失败改在本机隔离Profile复验，未放宽预算。独立真实NativeCaller／Service／SQLite及本机503 Provider页面观察原输入接管→重连计数→5/5失败→过程／错误详情展开与收起→页面重开；重开后仍共6次模型请求，明确新任务才增加第7次并完成。发现并修正无模型正文的旧失败过程落在新回复之后：插入位置只沿原轮次可见消息，忽略末尾隐藏时间／终态标记；同页和冷重开均核旧失败及详情在新输入之前。详情仅显示服务不可用的中文原因与建议，没有内部码、原日志、地址、额外失败正文或恢复占位文案。隔离数据为本机`.cache/session-files-browser-2cc30672-8619-402c-b83f-4fc2047a2674`，临时入口沿`.cache/model-connection-live.ts`，复用普通生产组件构建、诊断常量关闭。未验证真实远端服务、完整Electron安装包或其他平台；既有嵌套`@keyframes`构建提示保留。

2026-11-03，Windows x64／Bun1.4.3，`09d13bd65` 加首次展示修复、尚未加入本轮5次上限时：原轮次、Turn 活动、阅读滚动及诊断四个完整文件共49项／1687断言通过，Desktop／UI typecheck、定向Biome、边界、测试归属及文档检查通过。复用[会话文件浏览器夹具](test/session-files-browser-runner.fixture.ts)的独立 Profile、NativeCaller／HTTP／SQLite 和普通生产组件构建，以本机模拟 Provider 的503→恢复流式输出→完成、400终态失败逐步观察；实际核对用户投递占位接管、次数更新、过程收起／展开、恢复状态接管、回复完成与页面重开，没有重复用户消息、额外恢复正文或旧失败卡片。恢复场景8次模型尝试，另一次明确失败；冷重开仍共9次请求，原重连记录可在过程内展开，失败提示保持一条。另在先前隔离页面观察重连期间明确停止，已收到的部分正文继续可读；修正后连接成功记录不被随后取消改写。最终隔离数据在本机`.cache/session-files-browser-e48ac659-b1b2-4759-8593-10e91c49bd32`，临时入口为`.cache/model-connection-live.ts`。该浏览器传输桥及受控模型不代证完整Electron安装包、真实远端网络或其他平台；构建保留既有嵌套`@keyframes`提示。

子详情首次读取尚未取得完整且身份匹配的历史时，沿共享聊天加载状态等待，包括首次失败到后台重试之间的间隔；不把读取失败当作空会话展示欢迎页。成功核实为空的子日志才进入空历史状态，已有完整正文在刷新失败时继续保留。[子日志恢复回归](test/isolated/native-environment-child-recovery-dom.test.tsx)核首次失败、慢重试、空历史接管和反复失败时的正文保持；后台调度与只读资格沿用下述边界。

2026-10-26，macOS arm64／Bun1.4.2，子日志恢复 DOM 3项／56断言通过；[普通子详情窗口](test/isolated/native-child-stream-electron.test.ts)使用真实 Main／preload／renderer／Service／SQLite 与本机受控 Chat、Responses SSE Provider，完整文件2项通过。两协议分别执行100次父／子导航，记录602／622次DOM变化及首次、流式追加、完成重入三阶段截图，没有捕获欢迎页或重复消息，reader并发峰值2且关闭后在读为0。Responses子任务先执行映射工具再流式回复，完成与导航不重放原模型步骤。证据保存在本机 `dist/acceptance/responses-child-detail-20261026`；公开输出摘要修复与私有映射保留归[Model输出owner](../../packages/agent/src/model-output/README.md)。该范围不代表外部真实模型、安装包或其他平台验收。

Native 启动、目录与子 Agent、定时任务、分支、模型／提供商／MCP／Skills 设置、扩展能力、文件差异、上下文、交互记录和完整日志／输出读取均不插入临时加载文案，刷新同样不追加“正在核对”提示。已有正文、静态控件标签、图片文件名和预览占位保持，忙碌由原转圈、控件禁用及 `aria-busy` 表达；共享模型输入／输出遵循 [UI owner](../../packages/ui/README.md#原桌面展示层)。会话观察失败、历史不完整和原申请回执丢失由后台自动重读或查询原 ID，普通页面不再在消息区外追加异常文案、临时重试／核对按钮或通用错误弹窗。已读正文和草稿保留；真实执行失败和未知结果保留在原输入、轮次或工具消息中。设置、启动与空间管理等独立业务错误仍在所属界面处理，敏感内容确认、完整读取和写入准入不变。测试等待使用实际区域的忙碌状态，不能以加载文案消失推断完整读取成功。

[会话后台核查](src/native-session-recovery.ts)按原 scope／请求身份持续退避，间隔最高15秒、当前恢复范围最多2项并发；同一 scope 的选择读取失败与 observation 缺口共用原选择读取 key，不重复占槽，原答案查回可并行推进；隐藏、切范围或退出撤销待调度项，未结束的原 key 保留去重身份，同 key 重新显示时等待原读取；已撤销范围的在途读取不占用新范围预算。同一子日志的自动恢复沿原读取任务保留已核实正文，即使后续目录读取也失败仍不清空；旧正文仅供展示，不恢复操作资格。首次消息、后续输入、答案、权限和队列未知结果仅查询原申请，不重发原写入；队列编辑的原文不能覆盖后来草稿。会话选择以原激活序号区分首次明确激活与自动读取重试，Main 只保存当前一项；自动重读不重复生命周期 POST，也不重新分配 Main 的会话选择身份。失联后的 observation 恢复以原 activation ID 重读当前选择，不能只轮询 Main 缓存；同范围恢复保留正在读取的完整历史与阅读位置，不经 preview 中止并重启正文扫描。真实输入投递失败附在原用户输入项中，准确持久消息接管后移除本地副本。首次提交查回后，目录观察独立恢复，不阻塞原会话接管；选中读取重试成功后按原页、Session 与 Store 结束准备态。首次引导 POST 的明确4xx `input_target_stopped` 拒绝保存为本地 rejected，不能继续作为 unknown 查询不存在的 Command；网络、5xx和结果核对失败继续保未知，不据此自动重发。[调度器](test/native-session-recovery.test.ts)、[Main／Controller](test/native-caller.test.ts)、[会话页面](test/isolated/native-read-ownership-dom.test.tsx)、[首次接管](test/isolated/native-new-conversation-dom.test.tsx)、[子日志恢复](test/isolated/native-environment-child-recovery-dom.test.tsx)及[历史展示](test/isolated/native-history-presentation-dom.test.tsx)分别验证并发、原 ID、迟到隔离、慢请求不自取消、后台恢复与普通界面无额外异常提示。

2026-11-07，macOS arm64／Bun1.4.4／Electron44.3.0，在本轮审批精简 diff 上重新构建闭合 Service 与普通 Native（testDiagnostics:false），独立 Profile、受控本机模型和真实 Shell 逐步观察单次批准、重复点击、范围批准、同命令复用、回执丢失后原答案查回及正常退出后的冷读。三轮各产生一次隔离文件效果，共2次 reviewer／2张人工卡；复用轮不增 reviewer 或卡，自身 Job 不增第二张卡。长历史在断线与重读前后保持 scrollTop600，未发送 Unicode 草稿保持；冷开原历史及授权目录不增模型／效果。过程39份状态与截图、源码／制品摘要归本机 `/private/tmp/kite-approval-apply-observe-b7667a99-4955-4cd7-9c96-b0cdcc346481/evidence`。本轮 Native 五份整文件120项／1882断言通过；同 scope 双恢复原因的挂起读取回归确认只有1次选择读取，原答案查询在读取释放前已完成。该本机受控模型证据不替代付费模型、其他平台或完整安装资格。

2026-10-20，`5dba8a6b` 上的本次工作树，Windows x64／Bun1.4.3：逐文件独立运行 UI、Native 和共享 Web 输入阅读的25个完整文件，228项／3013断言通过；覆盖[慢配置读取与迟到隔离](test/isolated/native-mcp-settings.test.tsx)、[Skills 刷新保留详情](test/native-skills-settings.test.tsx)、[会话门禁](test/isolated/native-session-shell-dom.test.tsx)、[完整输出](test/native-job-output-panel.test.tsx)及启动、子日志、附件与文件差异。UI／Desktop typecheck、34个本轮 TypeScript 文件的 Biome、文档结构及影响核对通过。原 Electron driver 的等待同步改为区域忙碌状态，本轮未重新运行真实制品或安装窗口，不增加平台或发行资格。

[统一展示 context](src/native-diagnostics.tsx)只允许显式测试诊断。`NativeDesktop({testDiagnostics:true})` 供直接 DOM fixture；可信 `buildNativeDesktop` 第三参数中的 `testDiagnostics:true`、`buildNativeCandidate` 输入的同名选项供单独测试制品写入 renderer 构建常量，纳入实际制品字节指纹。普通正式制品和 `desktop:dev` 将常量固定为 false，Provider 同时核对该常量与组件参数，传入 true 不能绕过构建关闭值。dev／prod 不得出现测试专用调试功能，不依据 NODE_ENV、development 身份或 fixture 内容推断资格，也不改变 Main／IPC／Service 权限和恢复资格。顶部“会话工具／设置”、左栏连接标签与重读目录、两处 Composer 的“先审核计划”、当前会话的“保留草稿”及缺默认模型辅助提示均只在此显式测试模式展示；普通界面的设置仍从“个人工作区”用户菜单进入，Windows 另有[顶栏菜单](#windows-顶栏菜单)。[Main](electron/main.ts)移除 Linux 窗口菜单栏，Windows 隐藏独立系统菜单行并保留原生快捷键。

普通界面隐藏机器身份、泛化 Model result dump、已确认的创建／答案／交互账本，以及正常完成的历史校准、后台状态汇总计数、子日志的固定序号／原子轮次 ID 和缓存诊断。后台计数非零、出现未知任务或观察不可用都不能绕过测试诊断开关；实际任务状态继续由原轮次和环境信息展示。所保留的面板在未开启测试诊断时使用“执行记录”标签，未知、当前错误、未完成申请和取消未确认保持原查询合同；“查看提交记录”仍可读原申请全文并清理已核实记录，不清除 unknown。原全文继续核 EOF、完整字节、SHA 和准确命令，关闭／切 scope 只结束所属读取。非 Model [结果组件](src/native-result.tsx)逐字段保留全部业务正文；下文涉及“会话工具”的 Job／子日志、Model input、Context、恢复与管理面板由自动测试显式进入，配置另保普通用户菜单入口。

旧 Electron 身份断言在测试构建显式开启诊断；普通模式验证见[diagnostics DOM](test/isolated/native-diagnostics-dom.test.tsx)、[启动 DOM](test/isolated/native-startup-dom.test.tsx)、[新对话 DOM](test/isolated/native-new-conversation-dom.test.tsx)及[会话导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)。启动与当前会话覆盖默认隐藏、显式开启辅助入口及零新增请求，缺模型仍禁发送；导航回归另核非零／未知计数、观察失败、子日志身份在普通模式隐藏，构建关闭时组件 opt-in 无法开启，显式测试诊断仍保留原计数与身份。需要侧栏或目录重读的原问答／计划／草稿／恢复 DOM 明确开启诊断，其他用例保普通模式。DOM 文件沿测试体系各自隔离运行，避免多个 JSDOM 共享 React DOM 的全局捕获。此展示调整不建立完整 Windows／Linux 实测或新的发布资格。

[构建隔离回归](test/isolated/native-diagnostics-build.test.tsx)另经真实dev Vite服务加载原Provider，以及真实Vite／React构建原Provider和共享context的私有生产IIFE，验证编译关闭后即使组件传true、运行时伪造全局常量、dev／prod／test环境名、诊断环境变量或URL参数，仍保持普通模式；显式测试构建的true正向对照继续生效。实际2项／14断言通过，临时服务和目录均释放。生产部分验证原组件的实际编译行为，完整普通生产窗口另由下述混合压力回归覆盖，不将小入口当作完整发布打包资格。

2026-10-14 Windows x64／Bun 1.4.2，基于 `006b79d3` 的本次界面 diff：分别执行上述启动、新对话、诊断文件，以及目录读取归属、草稿、问答、计划、模型选择、共享页面和 Sidebar 目录，共十个完整文件49项／665断言通过。Desktop／UI typecheck 和定向 Biome 通过；Biome 保一个未改动的 fragment 提示。[恢复压缩原输入](test/isolated/native-restored-compression-input.test.tsx)及 `HEAD` 原文件的临时副本都在页面挂载前的压缩准备断言失败（`compression` 未生成），不计为本轮通过；临时副本已清理。本轮未运行完整默认测试或新的正式制品窗口。

本地开发先安装当前 workspace 依赖，使用根 `npm run build` 后 `npm run desktop:dev`。该[显式开发宿主](../../scripts/development/unified-desktop.ts)复用已构建的 workspace 运行资产、实际 Bun SHA、已有 Native development assets 与构建器，从当前 Service 源码构建独立开发版本，使用当前用户 `~/.kite-code` 数据根中的 `development` profile，数据库直接位于 `~/.kite-code/development/core.db`，与 CLI/TUI/Web 开发入口共用；checkout 和启动工作目录不决定数据位置。目录结构与旧数据读取方式见[本地开发](../../docs/development/local-development.md)。Windows x64 的[开发环境准备](../../scripts/development/windows-desktop-environment.ts)复用已初始化环境或通过已安装 vswhere／VsDevCmd 自动初始化，只导入本次进程的构建白名单；普通 PowerShell 无须手动配置 MSVC。每次构建到独立 `.cache/unified-desktop-*`，Windows 目录由原生权限接口创建并通过私有 ACL 校验，实际 Electron 退出后清理自己的应用目录；开发数据保留，活动应用目录不覆盖。纯帮助与严格参数拒绝先于资产读取／工具探测／构建／Profile 写入，缺 built Service 明确要求 `npm run build`；SIGINT／SIGTERM通过本次父连接请求所属进程收尾，菜单退出沿Native原收尾流程。操作步骤及 Windows C++ 工具安装要求归[本地开发](../../docs/development/local-development.md)。[开发入口测试](../../tests/isolated/unified-agent/development-desktop.test.ts)核对自动初始化、已有环境复用、缺工具／SDK／无效环境拒绝、帮助、缺资产、严格参数、独立私有应用目录及已有缓存保留。

当前桌面构建与启动使用仓库根 `bun run release:build --product native` 和 `bun run desktop`，定向验证为 `bun run test:desktop:native`，安装／归档／版本选择见 `bun run release:native --help`。旧 `apps/kite-desktop` 的普通开发、服务准备和打包命令已给出明确退役诊断／退出码2；不再从当前checkout构建或启动旧writer。原Vite开发热更新只属历史实现，当前Native候选启动的具体行为仍按本页及[发布owner](docs/native-release.md)核对。此项调用者退役不表示全部旧源码或阶段已退出。

Windows 开发启动还会先运行 [Electron 权限预检](../../scripts/development/windows-electron-permissions.ts)及其固定 [PowerShell 实现](../../scripts/development/windows-electron-permissions.ps1)，按已安装包／实际 EXE／版本限定物理 `dist`。在固定原对象并完整扫描后，仅向缺权限的现有对象追加受限应用包 RX；无递归继承授权、ACL 重置或提权。链接、硬链接及适用的拒绝 ACE 在写入前失败；已有 ACL、所有者、继承和运行字节保留，已满足时不写入。每次启动重新解析当前安装，覆盖重装／版本切换；项目、私有应用目录、Profile 和正式 Native 权限策略不变。范围与取舍归 [Note](../../.agents/notes/implemented/bug-fix/2026-10-19-development-electron-sandbox-acl.md)，操作与错误码归[本地开发](../../docs/development/local-development.md)。[权限回归](../../tests/isolated/unified-agent/development-electron-permissions.test.ts)覆盖真实 ACL 增量、原权限／数据保全、重装、幂等、目录联接／硬链接和拒绝规则。2026-10-19 Windows x64／Bun 1.4.3／Electron 44.3.0 的独立官方 ZIP 新解压夹具复现 GPU `0x80000003`，自动修复后 renderer 加载且实际 preload 报告 sandboxed／contextIsolated 为 true，再次检查零写入；此证据只覆盖本机开发启动。

2026-10-22，macOS arm64／Electron 44.3.0／Bun 1.4.2／Node 22.21.1，[普通 Native 故障整窗口](test/isolated/native-session-anomalies-electron.test.ts)使用真实 Main／preload／生产 renderer 与配套 Service，构建常量 `testDiagnostics:false`，以隔离的兼容 SSE Provider 和真实 `files.write@2` 验证：销毁 Main→Service 的实际 socket 后后台完成并自动重连；原 POST 已收到 202 响应数据后截断回执，后台仅 GET 原 Command 确认；活动 Model 期间对准确配套 Service 与 Main 执行 SIGKILL，冷重开将旧轮次收束为 interrupted，并可明确发送新轮次。六次输入各保留一个原 Command／Run，五个完成轮次各一次工具、两次 Model；被强杀的原轮次始终只有一次 Model、无工具效果。继续输入与再次冷读后原身份、请求 digest、执行集合和五份实际文件均未重放，普通退出核 Main exit 0 与所属 Service 已消失。全过程记录 129 次 DOM 观察、40 帧实际窗口画面和 11 个阶段快照，并逐段核对输入先于对应状态／工具／回复、投递与持久历史接管无重复、无通用异常文案闪现；失败现场继续保留，最终截图或脚本通过不能覆盖中间异常。该范围为本机隔离构建及 Main 作用域的实际 HTTP 故障，未做操作系统全局断网、付费 Provider、完整安装版或其他平台验收。

同日按用户要求改用已配置真实 `deepseek-v4-flash`／chat-completions／medium，沿[真实模型整窗口入口](../../tests/e2e/live/model/README.md#普通桌面会话异常)重验上述三类故障。真实第 02 轮发现原 Run 未重放，但新模型缺少旧 Run 已中断事实，在新 Run 又发起旧文件写入；该失败保留在 `dist/acceptance/session-anomalies-live-20261022-02.json`，不能计为通过。后端补齐[历史输入生命周期投影](../../packages/agent/README.md#人类输入工作选择与可靠结果)后，提示词、模型和断言不变的第 03 轮通过：11 次真实 200 请求，六条原输入／Command／Run，五个完成任务各一次实际写入，旧中断任务只有原一次 Model、零工具且旧文件不存在。回执丢失确认实际 202／357 字节后截断，原 POST 一次、仅原 ID GET 查回；断线与强杀的响应 gate 均先收到真实响应正文而未向 Service 转发。11 个阶段逐次暂停观察，另核 313 帧窗口、168 份顺序采样和 18,604 次 DOM 扫描，输入先于对应状态／工具／实际回复，未发现重复气泡、顺序倒置或会话外异常文案。最终正常退出／第三次冷开保持原业务身份、11 次调用及五份文件不变，三次启动的六个所属原 PID 均确认消失；外层及 driver 均退出 0。准确代码 hash、阶段截图／轨迹、冷事实及清理证据在 `dist/acceptance/session-anomalies-live-20261022-03.json.workspace/evidence`。第 01 轮夹具识别／取消判定失败同样保留。范围仍为本机隔离源码构建、明确文件任务和 Main 作用域 HTTP 故障，未做系统全局断网、安装版、其他模型或平台验收。

## Windows 数据权限预检与恢复

[Main](electron/main.ts) 在正式候选原交接／制品准入之后、BrowserWindow／paired Service／Core 与 UI SQLite 之前，通过 [启动控制器](electron/profile-permissions.ts)调用固定 Node-API `profilePermissions(dataRoot,profile)`。它只读取所选数据根、`.coordination`、准确 Profile 协调键、Profile 与 `desktop-private` 目录、原 `profile-use.lock`、Core/UI 主数据库及 WAL/SHM/journal 的元数据；缺失对象不创建，不枚举或改写其他 Profile。元数据不可核实不能当作安全空目录。该流程适用于正常正式制品和显式开发制品，不是测试诊断入口，不接 renderer、Model 或 HTTP 修复请求。

原普通 `profileShared`、Bun 私有路径、Service 独立准入、reparse／单链接／SID／DACL／使用锁验证保持。初始问题只提供默认退出和重新检查；只有原生检查证明 current SID owner、原 owner-FA 和适用的 protected DACL 完整，所有额外 ACE 均仅授读取／执行时，才提供用户明确选择的修复。foreign write、deny／未知 ACE、foreign owner、未受保护目录、链接或访问不可核实时保留阻断，不通过重置 ACL 把可能遭改写的数据变成“安全”。

[原生维护实现](native/windows-access/profile-permissions.h)封存原 root/target FileID、owner/group/DACL，不持有跨确认窗口的 OS 资源。用户选择后重新 pin 全部祖先，以原数据根 `MAXIMUM_ALLOWED` HANDLE 排除已有消费者并阻止新消费者；重核原 root/target 身份与权限快照。备份通过 current SID 私有 CREATE_NEW、完整写入和 Flush 先持久化于数据根的随机 `permissions-backup-*.txt`，包含原路径、Volume/FileID 和原 owner/group/DACL。备份失败或碰撞不修改目标、不覆盖已有备份。之后只对原 target HANDLE 写 DACL，owner/group/SACL 不改；使用 [SetSecurityInfo 的 MAXIMUM_ALLOWED 语义](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo)阻止 ACE 向子项传播。原生私有政策和 FileID 重新通过、所有 HANDLE 严格关闭后再重新执行全套启动预检。修改后核验失败保留 unknown，不自动回滚或重提；关闭未知保原资源，不放行替代启动。关闭／取消期间的迟到确认不发起修复。

[流程回归](test/profile-permissions.test.ts)核默认退出、取消、明确修复、只重查、占用、失败／unknown 与晚到确认；[原 Main 生命周期回归](test/isolated/native-main-scheduling-lifecycle.test.ts)核确认窗口期间 renderer／Service／SQLite 均未创建，取消仍零启动，修复后先重查再进入原启动流程。[完整 Windows 后端回归](test/isolated/windows-node-access.test.ts)通过实际 Electron 加载原 Node-API，核只读元数据、私有备份、子项 ACL 与数据原字节、可写／deny／未保护拒绝、身份与 ACL 漂移、备份碰撞、busy、伪造 native receiver，以及修复后原 SQLite／Store／草稿冷读取。有限后端与 Main 端口验证不授完整 installed Native 或其他平台资格。长期取舍见[显式权限恢复决定](../../.agents/notes/implemented/bug-fix/2026-10-31-desktop-private-permission-recovery.md)。

2026-10-31，`69c097587` 加本工作树，Windows x64／Bun1.4.3／Electron44.3.0：上述三个完整文件按各自隔离要求分别执行，11＋32＋12＝55项／507条Bun断言通过，原生夹具另执行Node断言；新增冷重开实际启动独立Service，核原Store、唯一原会话／标题、未增加历史消息及原UI草稿。Desktop类型检查、定向Biome、依赖边界、测试归属和文档检查通过。合并执行流程文件与独占Main文件的一轮出现超时，不计为通过；随后按现有隔离要求完整逐文件复验通过，未扩大期限或放宽断言。

同日本机逐步观察普通固定renderer测试制品（开发资产、独立HOME／AppData／数据根、测试诊断关闭）：额外只读ACL→启动权限弹窗→默认Enter退出1，数据根仍为空且ACL未变；重开→明确点击备份并修复→实际生成同提示文件名的私有备份并恢复currentSID-only→正常新对话页面→菜单退出0；第三次冷启动无重复权限弹窗，普通页面正常、Ctrl+Q退出0。按测试根过滤的进程查询确认自有Electron／Service均已退出，未操作其他用户窗口或调用模型。过程与最终状态由本次窗口操作观察及本机 `.cache/permissions-window-d62eaa2c-8a46-4793-a9d8-9edbeb0dedfe` 的三次退出日志和原权限备份互证；首次缺少测试AppData的提前退出记录保留。此范围不代完整受信安装前门、安装包／升级、其他平台或真实模型资格。

## 开发热更新与服务重载

`desktop:dev` 在选定既有 Service 资产后，对实际 `~/.kite-code/development` 复用 Store 的只读格式预检，再准备 Electron、Vite 与新 Service。按用户要求，`store_incompatible` 由开发入口提示确认后自动解决：[准备函数](../../scripts/development/unified-desktop.ts)取得原 Profile 的 EX 使用锁，重新核对后，在交互终端展示准确备份位置、旧历史隔离及全局模型配置保留说明。只有明确输入 `y`／`yes`（忽略大小写）才将整个原目录原子改名为同一数据根下的 `development-backup-<时间戳>-<随机标识>`，再继续原启动流程，由 Service 初始化新 Profile。回车、其他输入、Ctrl+C 和 EOF 均取消并释放锁；非交互环境返回 `development_profile_confirmation_required`，不能通过管道自动接受。完整旧目录、附件、sidecar 与权限保留；不把旧授权事实转换成新版合同，不删除备份。新环境不显示备份中的历史，全局模型配置保持原位。兼容 Profile 直接复用且不询问；活跃 SH／EX 使用者、待处理 restore journal、权限／I/O／关闭未知或改名备份失败仍停止，不抢占资源或先清空目录。此处使用仓库内 Profile 锁与同步预检实现，不扩展公开 Store／维护 API，也不改变其他开发入口和正式客户端的格式拒绝。预检不代替 Service 启动时的正式准入，help、无效参数和缺失选定资产仍不触碰 Profile。

[开发入口回归](../../tests/isolated/unified-agent/development-desktop.test.ts)覆盖旧同编号／伪造当前指纹／其他 major 在非交互环境拒绝、明确拒绝时零备份／原数据保持、确认后的原数据库／WAL／SHM／附件字节、全局配置保持、全新与兼容数据复用、活跃使用锁及 restore journal 拒绝。下面 2026-11-07 的拒绝／人工处置记录是当时行为的历史证据；当前确认后自动处置以本段为准。

2026-11-09，Windows x64／Bun1.4.4：本轮开发入口整文件11项／182断言通过，原真实 Main 用例仍仅在 macOS 运行并在本机跳过。真实终端隔离数据分别核回车、Ctrl+C 和 `YeS`：前两者原数据不变，后者才完整改名保留，三次结束后均可重取原 EX 锁。实际默认 `npm run desktop:dev` 先停在准确备份路径和 `[y/N]` 提示，用户明确确认后才输入 `y`，原目录完整保留为 `~/.kite-code/development-backup-1794156761877-ece1f9eb-b9f5-45c9-8e84-2129f656de1b`；3444个文件共714206073字节的完整清单、SHA与文件身份逐项一致，全局模型配置SHA保持。Service握手就绪，新Profile通过当前格式1／schemaChecksum只读预检；真实窗口从初始无正文到完整唯一新对话、项目／模型选择和草稿区，未发送任务。启动总耗时包含等待用户确认，不作构建性能证据。核对摘要在本机 `.cache/desktop-profile-{before,recovery-result,current-result}.json`；本次范围为确认、备份和新开发数据启动，不代证旧历史迁移、模型执行或完整产品验收。聚合类型检查、定向格式、边界、测试归属与文档门禁通过。额外执行未改动的 Store 预检整文件为11通过／1失败，失败位于原 `chmod(0644)` 权限反例（Windows 该调用不改变私有 ACL），不计为该权限链或完整平台资格通过。

同日继续修复上述权限失败：Store 预检将实际 Windows 私有 ACL 拒绝准确分类为 `store_access_denied`，不进入不兼容数据的确认／备份流程；开发入口完整文件重新验证11项／185断言通过，原macOS专属用例在Windows继续跳过。权限夹具与Store完整回归结果归 [Store owner](../../packages/agent/src/storage/README.md)，前述原失败保留为发现记录。

2026-11-07，macOS arm64／Bun1.4.4，当前工作树的[开发入口整文件](../../tests/isolated/unified-agent/development-desktop.test.ts)8项／153断言通过，原真实 Main 三场景与30秒 watchdog 保持；新增实际旧格式 SQLite／manifest 用例核零 Electron、零构建缓存、原字节不变且无 WAL／SHM。原默认命令已真实复现格式1拒绝，并在修后立即报告准确原因，用户 DB／manifest 哈希不变。另以全新隔离 HOME／Profile 走现有完整开发入口及测试专用 CDP观察：Service 在5.07秒就绪，12个 Renderer 过程样本从加载前空页到约6.35秒出现唯一新对话／输入区；草稿输入与清空正常、零 pageerror，无模型请求。原控制停止返回143，所属 Electron 已退出，Profile EX可重新取得；过程及结果在本机 `/private/tmp/kite-desktop-dev-actual-DFTfkZ/`，原终端日志为 `/private/tmp/kite-desktop-dev-actual-20261107.log`。此为全新开发数据的启动资格，不把隔离成功当作旧数据已升级或默认目录已恢复。

同日用户明确确认完整备份后新建 development。持原 Profile EX、确认旧 DB 无打开句柄后，将原目录整体保留为 `~/.kite-code/development-format1-backup-20261107-133838`；1556个文件／目录条目的完整清单、字节及权限核对一致，未迁移或清空旧库，模型配置保持原位。随后未加测试 wrapper 的原 `bun run desktop:dev` 在默认目录创建格式2，5.11秒完成实际 Service 握手；准确所属原生窗口已在屏幕上显示完整新对话，单窗口 OS 截图保存在 `/private/tmp/kite-desktop-dev-default-window-20261107.png`，原日志为 `/private/tmp/kite-desktop-dev-default-restored-20261107.log`。用户随后明确要求移除无用旧数据，已仅删除上述备份目录，核对新 development 目录身份不变、格式仍为2且桌面 Main 仍在运行。此为该本机旧格式拒绝、用户明确处置与默认新库启动的闭环，不是自动迁移能力。

同日用户再明确未投产期间仅将本次 Store／审核回执编号统一为1。当前开发库在正常关闭、取得独占权且核完整 schema 与原checksum后，只重标版本与本轮schemaChecksum，26张表其他事实及Store ID保持，未重建或清库。原 `bun run desktop:dev` 在原默认目录再次5.11秒就绪；当前编号1的准确屏上窗口截图为 `/private/tmp/kite-store-major-restore-20261107/default-window.png`，日志为同目录 `default-desktop.log`。相关20整文件206项／2718断言及开发入口10项／177断言的完整资格归 [Store owner](../../packages/agent/src/storage/README.md)。

2026-11-07 本轮版本统一 apply 复核未改生产启动代码，再以当前入口和隔离HOME／Profile实启：Store编号1、5.42秒Service就绪，12个Renderer样本从加载前空页到6.36秒唯一新对话／输入区，草稿输入与清空正常、零pageerror；原SIGTERM控制退出143，准确Electron退出、所属资产路径零残留、Profile EX已释放。材料归本机 `/private/tmp/kite-desktop-dev-actual-R4U10W/` 和 `/private/tmp/kite-desktop-dev-version1-review-20261107.log`。退出观察区间出现一次sandbox_extension_issue_file stderr，原记录保留；日志无独立发出者／时戳，不认定具体诱因，不将其计为启动失败或删目录竞态证明，也未据此修改未变的原生清理。此为启动、草稿和退出的有限验证，不扩为完整Native呈现或业务验收。

开发 Main 给配套 Service 的 bootstrap／连接阶段各30秒有限期限，正式 paired 默认仍各10秒，外层开发父控制保持45秒。Main 只将 Service 的闭合阶段／状态／毫秒计时打印为 `[desktop:dev] Service ...`，不透传私有 stderr；Shell 运行时、配置、Store、Runtime 和 HTTP 的开始／完成／失败可在超时时定位最后阶段。父宿主在真实准入后另报告 Electron／Service 握手耗时，原失败清理和就绪条件保持。

2026-11-05，Windows x64／Bun1.4.4，隔离目录内交替正反顺序对照本机 Git 的1,139个文件／约303MiB：原同步 Git Bash 冷准备10.36／10.79秒，优化后3.56／4.01秒，清单摘要相同；热准备原2.91／3.33秒、优化后2.23／2.39秒。真实开发 builder 生成的 Service 由 Node 私有管道启动，全新隔离 HOME 下 bootstrap 为5.85秒，Shell 阶段4.03秒，原10秒探针期限内完成，父 EOF 后退出0。这是本机文件准备和 Service 启动证据，不承诺所有机器的耗时，也不代证实际窗口、模型或完整发行资格。

同轮完整 `runDevelopmentDesktop` 使用隔离 HOME／Electron userData 实际启动：Shell 冷准备3.20秒，Electron／Service准入6.24秒，含构建总20.54秒；终端完整输出五阶段日志，父控制停止后入口返回143，原Electron已退出。此处只核终端就绪与所属退出，没有验收窗口交互。准备、原生Shell、Service计时／配对、开发入口与重载完整文件通过；Shell检索／只读子Agent集成首次12秒等待失败，保持原期限的独立复验通过。Main生命周期为40通过／4失败，四项Windows无page host的浏览器夹具失败在Git HEAD原Main中同样复现，未计为本轮通过或扩展修复范围。

本次定向验证沿原隔离运行器逐文件执行 macOS runtime、普通／开发 renderer 构建、确认框 DOM、诊断构建、开发启动与开发重载六个完整文件，30项／373断言通过；最小夹具仅预热存在的页面，不引入缺文件预处理错误。UI 构建并实际导入新 compiled 确认出口，根／Desktop／UI类型、定向Biome、边界、测试归属与文档检查通过。普通生产主页面仍有原大chunk提示，不计为开发启动警告；本轮未取得Windows／Linux实机或安装发布资格。

2026-11-03，macOS arm64／Bun1.4.2／Electron44.3.0，`6719ed84e` 加本次启动优化：同机按原准备顺序、独立数据目录测得基线 Service 就绪16106ms，其中 Electron 准备1899ms、Service 构建与加载343ms、Native 构建10747ms、Electron 到真实握手2929ms；最终普通开发函数的隔离 HOME／Profile 实测就绪5140ms，Main／preload 构建200ms，首个完整新对话正文／输入样本在6488ms。中间多次启动的就绪范围约5.1–6.6秒，属于本机现有依赖缓存状态，不是跨机器或首次安装性能承诺。连续20个Root样本、4个确认框样本与取消后画面核对无重复输入区或挂起，Full默认焦点为取消，取消保留自动审核及原未发送草稿；未请求模型。原加载动画实际名称正确且opacity变化，renderer无pageerror；SIGTERM沿原流程返回143，所属应用目录已清理。过程、终端日志及准确退出结果位于本机`.cache/desktop-startup-check-20261103-final4/`；早期私有观察脚本误选隐藏页／错误菜单筛选的失败保留，不计为通过。

开发 Main 的 Root 与全局确认框均沿同一受限 Vite 地址加载，builder 不再生产构建这条路径不会使用的静态 HTML／renderer；Main、两个 preload、私有权限 helper 与运行资产校验仍每次构建。普通固定 renderer 继续生成完整页面与确认框。Vite 在启动期间预热两个 HTML 入口及动态加载的 NativeDesktop，提前转换依赖；这不执行页面或业务请求，也不提前宣告 Service 就绪。终端逐项报告 Electron 准备、renderer／监听、Service 构建与加载检查、Main／preload 构建及真实就绪总耗时。

[开发 Vite 配置](scripts/development-renderer.ts)仅对 Client 生成的 `validators.js` 省略内联源码映射，继续通过原模块图提供校验代码，普通模块仍生成开发映射。[重载回归](../../tests/isolated/unified-agent/development-desktop-reload.test.ts)直接核对实际 HTTP 响应及普通模块映射。Windows x64／Bun 1.4.4 的同一路径探针中，响应从约 158 MiB 降到 20 MiB，包含收取响应的探针工作集从约 2.4 GiB 降到约 300 MiB。

开发 Vite 的文件监听跳过 `apps/desktop/.cache` 及其内容。Windows x64／Bun 1.4.4 本机约 1.69 万个监听条目来自该生成目录，`fs.watch` 注册曾阻塞约 24 秒。排除该目录后保留原生监听，同机从准备到构建完成由约 31 秒降至约 9 秒。全量轮询也能绕开阻塞，但在同一探针中空闲 CPU 达单逻辑核心的约 87%，因此沿用原生监听。[重载回归](../../tests/isolated/unified-agent/development-desktop-reload.test.ts)核对生成目录被跳过、普通文件仍在监听范围内。

2026-11-13，Windows x64／Bun 1.4.4，沿 `runDevelopmentDesktop` 使用独立 HOME 和 Electron userData 实启，完成窗口观察的三次启动在 16.67–22.77 秒握手就绪。最终一次 Main／preload 构建 2.71 秒。窗口从启动页进入唯一新对话和输入区，UI 模块更新后保留同一文档，Service 更新后原窗口完成重载并恢复输入区，退出返回 0 且临时应用目录已清理。一次 Service 重载观察到额外的页面导航，后续按 WebContents 区分导航的复测只看到预期的一次主页面重载，额外导航的触发原因未确定。

2026-11-13 使用隔离 Profile 执行 `npm run desktop:dev`，Service 完成握手，实窗显示新对话且能输入草稿。CSS 热更新保留草稿，保存 Service 源码后旧进程退出、同一 Main 重载页面。退出后核对所属进程和应用临时目录均已清理。修前后的实窗采集都出现同一处矩形遮挡，重载后的草稿区可用。定向重载回归 13 项通过，启动测试的四项 Store 故障注入断言在同批未修复对照中同样失败。

确认框经 [UI 专用出口](../../packages/ui/src/desktop/confirmation.ts)只导入原确认组件，避免从会话展示总出口带入 Markdown、公式及高亮初始化。macOS arm64 的独立引擎副本请求文件系统写时复制，不支持时沿普通复制；首次源库存贯穿目标完整等价／独立 inode 校验与最终源不变校验，保留原两处补丁、签名前后完整 payload、签名及 Main 实际加载准入。准备期间只合并重复源扫描，不跨启动复用已修改 runtime 或改动已安装 Electron。

Renderer模块热更新与整页重载分别处理。`NativeBrowserPane`的展示revision归当前Root document持有，模块重求值继续递增；新document使用新序列，Main仍按当前Caller generation及完整scope拒绝旧展示／cleanup。Root重新attach后从同Main保留的准确会话展示意图重新执行select、历史和模型事实读取，不把旧selection或截图当授权。Main为其生命周期内的全部Caller分配不重复的generation，Service重载后的新Caller只接收原Store／Session展示候选并重新核实；Main实际重启没有进程内网页保留承诺。原网页由Main独立持有，Renderer重挂载不导航、不刷新、不重开网页；模型观察仍由实际页面／文档／控制身份及新Run边界判断有效性。

[Native Root](src/native.tsx)与[Caller](electron/native-caller.ts)将展示恢复和读取资格分开：同Main保留的Store／Session只作候选，attach取得新generation后沿原select重读权限、历史、模型与草稿；准确缺失的会话清候选，其他读取失败保留失败，不能恢复旧权限。Fast Refresh仍保留React状态时，新会话准备页及未发送草稿沿原边界保留；整页重建不新增未发送草稿持久化承诺。`SessionPage.tabsScopeKey`只按已知Store与当前选择意图保持tab model、选中页和展开状态，selection暂不可见不会清空标签；真实Store／会话变化仍换scope，读取未核实时新建标签和控制操作保持禁用。正文与历史读取继续沿自己的readingKey，恢复仍核新的browserRestoreKey及完整Main scope；共享契约归[UI owner](../../packages/ui/README.md#原桌面展示层)。

[Main页面owner](electron/native-browser.ts)在Root导航／崩溃撤下呈现前，只记录当时实际visible的准确原页及scope。新Root经fresh scope恢复同一存活页后，私有restore才可返回`reveal:true`及准确activeId；UI重建新的观察与布局后恢复原已展开右栏。原本收起的页、其他会话、被关闭或替换的页不取得这个意图；普通restore不自动抢前台。新的准确present成功后清Main意图，UI也按scope／page仅消费一次，用户收起优先于迟到或重复reveal。它不保存或重放旧截图，不签发导航、输入或模型控制权。Root导航、timeOrigin和Main／Service PID用于区分整页重载与进程重启；仅看到attach或模块更新不能推定是哪一种场景。

页面保留不等于旧观察有效：旧Caller读取句柄和scope不能跨新generation复用，新Run必须重新绑定原pageId／incarnation并取得当前语义快照；新Service不恢复旧解释器变量或热租约。仍在同一Run／Main中的语义引用按实际文档与控制身份核实，正式截图坐标另核原captureId、导航、真实viewport／滚动及输入基准，失效时重新观察，不以保留页图冒充当前依据。页面实际销毁按独立闭页路径反馈，不把Renderer观察丢失当成页面消失。可信确认原页缺失后只让准确旧候选失效，模型可按当前明确任务和URL另发新调用建立新页面身份／观察；替换、变址或未知不能冒充缺页，也不借恢复重放已执行或未知效果，准确准入归[Browser owner](../../packages/agent/src/tools/browser/README.md#统一执行入口与隔离环境)。

根 `desktop:dev` 在已准备 workspace 资产后，由[开发宿主](../../scripts/development/unified-desktop.ts)通过 builder 的 `development` 选项构建 Main／preload 和首个独立 Service 版本，由[本地 Vite renderer](scripts/development-renderer.ts)提供页面。[重载协调器](../../scripts/development/desktop-reload.ts)在初次构建和每次重建后，以新 Bun 进程实际加载 Service 及外部 workspace 导入；不执行 `import.meta.main` 分支、不自动安装依赖，最长等待10秒，失败保留最多16K字符诊断并回收探测进程。缺失导出不能只因入口 bundle 生成而放行。加载检查不代替完整类型检查或业务验证。

Browser 配置使用的 guardian locator 在本次开发 Service 的 JS 入口内编译；同一源码快照的 POSIX／Windows guardian 随每次初构及重载生成在该入口的同一私有版本目录。隔离代码执行器的 facade 也只在 Browser 配置导入处参与 bundle，其 locator 指向本版本的 `tools/browser/executor/worker.js`，worker 同步从当前源码构建，不能误读仓库中旧 dist。其他 MCP workspace 引用继续读取当前源码，Shell 沿原编译资产选择。原 locator 的 `.ts` 拒绝规则保持；直接源码调用不会获得编译资产资格。任一资产构建失败拒绝新版本，缺少该版本的 `.js` 资产时能力明确不可用，不能退回旧版本或同名 `.ts`。Service 入口摘要封存编译后的定位代码，所选资产继续进入原运行资产保护。[开发 Browser 回归](../../tests/isolated/unified-agent/development-desktop-browser.test.ts)覆盖当前资产重建、旧版本保持、构建失败、源码拒绝，以及真实配对 Service 的只读可用／缺资产反例；新增执行器闭包与真实源码离线构建2项23断言、既有开发重载12项120断言通过。测试不打开浏览器或请求模型，不代表新 Chrome 实机资格；开发父构建脚本自身变化须下一次启动才会加载，已有 Main 的 Service 重载不会替换父进程内已加载的构建函数。

协调器监听 Service、Agent、AI、Client 的 `src`。启动时从 Vite 公开声明的 `FSWatcher` 类构造器创建本次独立监听器，先注册 ready／error／变化处理，再一次加入 source roots；缺少的根沿最近存在目录及祖先去重监听，忽略其下缓存、node_modules 和 symlink。等待该实例真实首次扫描完成后才开始首个 Service 构建，构建期间变化先记 dirty、原重载队列就绪后接管；不向已经 ready 的 Vite UI watcher 晚加路径并误用其首次 ready。构造器形状不可用或建立监听失败明确拒绝启动；运行期监听错误停止本次准确父控制并非零退出，不能继续报告热更新可用。退出先关闭自有监听器，即使关闭失败仍执行原构建队列、Vite、控制通道及所属进程清理。原 UI watcher 继续负责页面 HMR，没有新增启动配置或依赖。协调器合并连续保存、串行构建并保留旧版本字节；同时核源码内容摘要，避免外部 workspace 变化而入口 SHA 未变时跳过重载，内容相同不重启。检查中源码变化拒绝发布该版本，后续保存仍沿原队列处理；编译／加载检查失败保持旧服务。React 组件及 CSS 沿 Vite Fast Refresh，共享 UI 保存不重启 Service。

Main／preload及其IPC投影变更，包括被 Main 导入打包的 `src` 共享 helper（如 [tool-request-target](src/tool-request-target.ts)），必须退出并重新启动`desktop:dev`，沿新启动构建加载；只刷新页面或新建会话不会替换旧主进程。重新启动沿原development profile读取已保存会话，不需重新提问或重跑工具；进程内未发送内容须按原草稿边界保留。完整操作边界归[本地开发](../../docs/development/local-development.md)。

[Main重载](electron/main.ts)的developmentReload只表示本次在途更新，成功或失败结算后均释放自身latch，原失败照实返回；不把Renderer load失败伪装成更新成功。[父控制通道](../../scripts/development/desktop-reload.ts)收到准确匹配的`ok:false`只拒绝本次pending，后续新的明确保存才可提交新版本，不自动重投原版本。Main下一次仍先走原close门禁：closingNativeResources的原失败保持sticky，switchingService和quitting继续拒绝不安全开启，未知cleanup不会因新保存被改成已确认。ACK缺失、身份不符后没有匹配回执、断线、停止或timeout仍锁存通道未知／停止，不自动切换或重发。

2026-10-30，macOS arm64／Bun1.4.2，`3c45bbb0c`加当前浏览器工作树：`bun test --parallel=1 --max-concurrency=1 apps/desktop/test/isolated/native-main-scheduling-lifecycle.test.ts tests/isolated/unified-agent/development-desktop-reload.test.ts`完整两文件48项通过、3项Windows平台跳过、547断言，Desktop类型、根`tsc --noEmit`与定向Biome通过。新增用例先复现settled失败永久占位，再核实际保存队列→认证TCP→reload响应的明确失败、下一新保存和停止零重发，以及原cleanup unknown、quitting和SIGTERM等待准确Service资源。这些是原Main模块的受控端口、构建与loopback证据，没有启动真实客户端或模型，不能补造此前退出unknown的正常回执。

开发 Main 在页面加载后沿原 `openCaller` 完成 Service 握手、Client 连接和私有数据准入，才在准确父连接报告 `desktop.ready`；初次失败携有限错误码报告 `desktop.failed`。连接建立本身不报告就绪；父宿主最长等待45秒，失败以非零结束并等待所属 Electron 退出后清理目录，不把加载失败窗口当成成功。正常候选的启动错误／重试展示及控制边界保持。

Vite 使用 middleware 模式，HTTP 与 HMR WebSocket 共用宿主拥有的 loopback 端口；其默认 SIGTERM／stdin EOF 退出处理不再接管整个开发进程。宿主信号处理器保留到 Vite、父通道与所属 Electron 收尾完成并清理私有应用目录，防止 Vite 直接退出而跳过清理。

2026-10-24，macOS／Bun1.4.2：[真实开发 Main 回归](../../tests/isolated/unified-agent/development-desktop.test.ts)在隔离 Profile、独立 Electron 数据目录及最小 renderer 中逐步核缺失导出先于 Electron 启动失败、有效模块但后台失败返回非零、实际 Service／Native caller 就绪、外部依赖加载失败保留原 Service PID、修正保存后唯一一次更新及新旧 PID 退出；开发函数真实返回143后应用目录为空。未调用模型，不代表完整聊天界面、其他平台或安装版验收。

2026-10-27，macOS arm64／Bun1.4.2，原隔离runner完整重跑开发重载12项／120断言、真实开发 Main7项／141断言（5208ms）、开发 Shell1项／38断言（2536ms）通过。新增回归在独立监听器首次 ready 后不等待便覆盖已有源码，随后立即创建子目录／文件及原本缺失的 Client source root，核真实事件、关闭后零投递、祖先去重、半启动错误／abort／运行期错误及不可用构造器拒绝。真实 Main 原30秒每场景预算与65秒整例预算不变，仍验证缺失导出、失败保原 Service PID、修正后恰一次更新、143返回和准确新旧进程退出／目录清理；不使用sleep后编辑或延长预算换取成功。本轮资格限定本机受控制品，未新增Windows／Linux实机资格。

开发 Service 对 `@kite-ai/agent/jobs/shell` 的导入固定为当前 checkout 已构建的 `packages/agent/dist/jobs/shell.js`，以独立文件 URL 保留资产定位器的原模块位置；其余工作区导入继续使用当前源码。不能把源码 `.ts` 的资产不可用误判为宿主缺少 Shell，也不能内联定位器后按 Service 缓存目录寻找 guardian。资产准备、平台限制和实际权限仍归[默认 Shell 装配](../service/README.md#默认-shell-装配)，子 Agent 按父 Agent 实际工具范围继承。[开发 Shell 回归](../../tests/isolated/unified-agent/development-desktop-shell.test.ts)通过普通开发构建与 paired Service，在隔离 HOME／Profile／Workspace 和受控模型下，核 macOS 主 Agent、默认通用及 code 子 Agent 的真实工具声明、Shell 执行和完整短输出；不注入工具或审批策略。[构建回归](../../tests/isolated/unified-agent/development-desktop-reload.test.ts)另核连续重建及中文／空格路径保留原资产 URL。本机执行证据不赋予 Windows／Linux Shell 或正式发行资格。

开发配置由 builder 固定且仅 `kind: development` 接受。[闭合配置／父通道](electron/development.ts)限定 renderer 为 `127.0.0.1` 的实际 HTTP 地址；script 用 Vite nonce，connect 只允许同源资源及该端口 WebSocket。Main 的沙箱、隔离、导航与准确窗口／主 frame 校验保持，Vite 文件服务只开放应用／workspace／依赖源码并拒绝仓库内 Profile、缓存、密钥及内部目录。正式候选不接受这份开发配置，继续 file renderer 和原 `connect-src 'none'`。

Windows GUI stdin 的实际过早 EOF 已否定其控制通道方案。当前父宿主为每次启动创建独立 loopback TCP 连接，编译到私有 Main 的 32 字节随机 token 认证连接；token 不进入 argv、日志、renderer 或 Vite 内容。闭合重载请求只含版本 ID／SHA，不接受任意路径或命令；Main 派生自己应用目录内的版本，先验证新字节，再沿原 caller／私有数据／paired 关闭并确认实际退出0，按新 build 身份准入并整页重新 attach。新旧 Service 不重叠，历史和持久申请保留，不重发工作；未知关闭或回执阻止后续自动切换。父连接 EOF、错误或关闭，以及 Main 的 SIGINT／SIGTERM，均等待同一幂等资源收尾完成再退出；配套 Service 自己也沿信号进入原 drain。父控制在连接／认证前收到停止会锁存，准确认证后立即 EOF，不丢退出请求；停止后拒绝新重载，迟到回执不恢复资格。菜单等待检查或用户决定期间被上述退出接管后，迟到“保留服务”或拒绝不能重新启动调度／观察。普通应用退出关闭 Vite 和监听器。取舍归[开发重载 Note](../../.agents/notes/implemented/architecture/2026-10-14-desktop-development-reload.md)。

[开发协调测试](../../tests/isolated/unified-agent/development-desktop-reload.test.ts)验证真实构建版本、编译失败保旧字节、串行更新、认证、原请求回执及 Vite 私有文件拒绝；[开发配置测试](test/development.test.ts)验证明确开发类型、URL／nonce／闭合通道，[窗口 IPC](test/native-window-ipc.test.ts)保原断言并核 HTTP 主 frame／origin／路径边界。2026-10-14 Windows x64／Bun 1.4.2／Electron 44.3.0 的实际窗口已核共享组件 Fast Refresh、草稿保留、UI 更新零 Service 重启、自动 Service 换 PID、旧 PID 退出、同 Main／Store、编译失败继续旧服务及下一次修正保存恢复。其结果仅覆盖开发热更新，不代 formal Native、其他平台或模型执行资格。操作及 Main／preload、Worker 资产需重新启动的边界归[本地开发](../../docs/development/local-development.md)。

## 复用原桌面展示层

配置表单根容器不另铺背景色，直接沿用RightSidebar底色；内容、标题与底栏之间继续保留原分隔线及滚动结构。

Input、Textarea、SelectTrigger的基础外观与交互状态归[UI公共表单样式](../../packages/ui/src/desktop/components/ui/form-control.ts)统一维护；Native表单负责字段布局、帮助／错误文案和业务语义，不再用页面CSS重复覆盖控件背景、圆角、无效边框或禁用透明度。

[浏览器面板](src/agent-browser-panel.tsx)的地址、注释、填入内容与元素选择，以及[注释卡片](src/browser-annotation-cards.tsx)的编辑和操作统一复用公共Input／Textarea／SelectField／Button；布局CSS只补可用宽度和文本区高度，不再叠加外框。默认模型搜索移除局部背景与边框覆盖，[提示消息](src/native-message.tsx)关闭入口沿公共紧凑按钮，原提示身份与暂停计时保持。原生文件选择、浏览器画布、系统菜单和隔离诊断控件仍按各自用途管理，不由通用表单组件接管。

提供商与模型复用设置的公共单列列表及分隔线，取消模型页专属的自适应卡片网格、卡片背景和圆角。每行以连接信息为主体，模型数量及管理入口对齐名称列；`provider-row`容器查询负责窄行内的状态和操作换行。[连接模型组件](src/native-connection-models.tsx)继续管理原连接的模型浮层，不改变配置提交与启用语义。

2026-11-01，Windows x64／Bun1.4.3，列表调整通过提供商及联合设置两文件91项／1433断言、Desktop类型、两文件Biome及文档检查。既有[侧栏几何回归](test/session-shell-geometry.fixture.ts)在深浅主题、500／800／1000／1020／1280px十组通过；内嵌浏览器另逐步观察普通、长名称、自动接入三行在宽窄窗口和并排编辑时的排列、模型浮层开合、双击表单及取消恢复，行内横向溢出为零。隔离生产夹具的截图与数据归`.cache/provider-list-8mbw1e/`，未重验正式安装客户端或真实配置写入。

2026-11-01，Windows x64／Bun1.4.3，默认栏宽统一：定时任务和提供商／MCP／Skills均消费UI公共420px默认值。定时任务保留手动调宽，宽窗口缩放按像素保持栏宽，新建或编辑另一份表单恢复默认值；不足800px的内容外框统一改用覆盖布局。定时任务／SessionPage及Native页面壳／Windows菜单四个完整文件104项／1982断言、UI／Desktop类型、八文件Biome、文档结构／影响、测试归属和边界检查通过。既有[几何回归](test/session-shell-geometry.fixture.ts)在隔离生产页面核500／800／1000／1020／1280px、深浅主题十组，共1784帧：四类栏宽在可用空间足够时均为420px；500px窗口按各自内容外框收缩到293／294px，控件无横向裁切。另核覆盖与并排切换、窗口继续拉宽、草稿保留、手动拖到360px及新表单恢复420px。实际观察Windows开发窗口的任务表单及内嵌浏览器中四类面板的开合、焦点和底栏，页面零异常；截图与数据归`.cache/sidebar-width-CXQdKJ/`，不取得完整安装或其他平台原生合成资格。

设置页由[Native壳](src/native.tsx)、[公共样式](src/native-tailwind.css)和[设置样式](src/native-provider-settings.css)统一布局：导航宽度直接消费UI的`NAVIGATION_MIN_WIDTH`（200px），各分类共用880px最大内容列、48px上下／32px左右留白，600px及以下仅将水平留白改为20px。`.settings-page-heading`统一标题、说明与操作区；打开右栏不按分类改写主区padding。所有设置操作使用公共shadcn Button／Input／Textarea／Select／Switch；[选择器组合](src/native-settings-select.tsx)把Select浮层挂到当前Dialog内，保留主题、焦点与Escape层级。配置读取、保存、凭据清理及原申请恢复沿原owner执行。

2026-11-01，Windows x64／Bun1.4.3，`be57a4a1d`加本轮工作树：逐文件执行原[提供商](test/isolated/native-provider-settings-dom.test.tsx)、[模型](test/isolated/native-model-settings-dom.test.tsx)、[联合设置](test/isolated/native-provider-model-settings-dom.test.tsx)、[MCP](test/isolated/native-mcp-settings.test.tsx)、[Skills](test/native-skills-settings.test.tsx)、[页面壳](test/isolated/native-new-conversation-dom.test.tsx)及[共享侧栏](../../packages/ui/test/isolated/desktop-sidebar.test.tsx)，270项／4357断言通过；UI／Desktop类型、21个变更源码与测试文件的Biome、文档结构／影响、测试归属与边界检查通过。内嵌浏览器加载实际Native与生产编译CSS、独立合成bridge，逐步观察深浅主题、500／800／1280px布局、四页切换、编辑器／提供商／MCP下拉选择、模型开关、右栏开合与重开；菜单Escape只关菜单，下一次才关编辑栏，焦点返回对应入口。1280px下四页标题位置相同、均为24px，内容列880px；500px下侧栏仍200px、水平留白20px且无横向溢出，详情面板内容可读。最终页面无浏览器错误；未重验完整安装版Electron、真实Service或外部提供商，保留既有嵌套`@keyframes`编译提示。

模型和提供商设置的普通保存过程不再插入独立状态段落，提供商保存／删除成功直接更新原列表并关闭所属编辑面板；取消、控件忙碌及失败／结果未知的原申请查询保持。附件准备仅保留原忙碌图标、无障碍名称和取消入口。环境信息有业务名称时保留原名，否则普通页面回退为“Shell”／“子 Agent”；内部执行 ID 及“执行状态待核实”仅供测试诊断显示，实际操作仍绑定原 ID，执行权未核实仍撤销停止资格。定时任务的运行记录沿共享 UI 显示中文状态。设置、环境、附件和任务的回归归各自原有 DOM 测试，不改变 Main／Service 操作协议。

Native 的会话、工具、输入、设置及浮层共用共享 `--font-ui`。macOS 默认使用系统界面字体，Windows 优先 Segoe UI，Linux 使用系统界面字体。中文沿系统字形回退。设置页的页面、右栏标题与编辑器名称为 500，字段名、分组名、模型／连接名称、徽标说明、表单标签与当前值为 400；不再让普通设置名称继承 `strong` 或标题的粗体。其他界面标题仍消费共享 `--font-weight-semibold: 600`，Markdown 强调沿原语义样式。共享 `--font-mono` 为代码块、行内代码、Shell 输出、执行轨迹与等宽配置输入提供系统等宽字体。缺少斜体字形时由 `font-synthesis: style` 保留倾斜效果。客户端默认字号由共享 `--ui-text-size: 14px` 管理；[Native样式](src/native-tailwind.css)与[设置样式](src/native-provider-settings.css)中的窗口菜单、设置普通段落、按钮、模型／连接主名称、表单标签和输入、完整详情正文，以及浏览器地址和失败正文统一消费该基准。模型名称多行输入保留等宽字体，字号与普通输入一致；页面标题、徽标、标识符与辅助说明保留各自层级。设置导航不再重复定义窄窗字号，窗口缩放只改变布局。设置与输入区沿[公共控件](../../packages/ui/README.md)的图文对齐规则，选项勾选使用14px并垂直居中，长名称截断时前后图标保持完整；具体归属与本轮隔离验证由UI owner维护。样式入口先登记 `theme, base` 层，再引入 utilities，保持原生控件的字体继承低于组件明确字号；既有 utilities 与 components 的相对优先级保持。提供商删除确认沿用共享窗口级弹窗的正文样式。

2026-11-06，Windows x64／Bun1.4.3，`5d39518e1` 加本轮字重调整：生产 CSS 编译与三个样式文件的 Biome 检查通过。隔离浏览器加载实际 Native 组件及生产 CSS，逐步观察用户菜单进入设置、四个分类切换、提供商右栏与下拉开合、Escape、取消及返回会话；普通标签和列表名称实测为400，页面／编辑栏标题为500，“个人工作区”为14px／400，会话正文仍为500。返回后草稿保留，用户与助手消息各一份，未见重复或卡住。截图保存在本机 `.cache/regular-settings-20261106/`。本轮仅修改样式，复用未变的组件与交互回归；未重验完整安装版 Electron、真实 Service、macOS 或 Linux。

2026-11-04，Windows x64／Bun1.4.3／Chrome156.0.8078.80，`9855b3c56` 加本轮字体修复：原 Markdown、代码复制及输入编辑三个完整文件17项／219断言，UI／Desktop类型、五文件Biome、测试归属和文档结构／影响检查通过。[内容浏览器夹具](test/markdown-content-browser-runner.fixture.ts)在1280／390px及深浅主题通过；实际字形分别为 Geist-Italic、Geist-Mono-Italic、MicrosoftYaHeiUI-Bold 和 Geist-Mono，中文斜体与正体的同位置截图不同。逐步观察占位→图表、流式开始→追加→完成、错误→修正、主题切换及输入编辑，原正文、代码和输入保持一份，未见字体回退闪变、重复正文或页面异常。报告及过程截图归本机 `.cache/client-font-fixes-20261104/`。此为生产组件与编译资产的隔离浏览器证据，未重验完整安装版 Electron、macOS 或 Linux。

2026-10-21，macOS arm64／Bun1.4.2，`a7f629960` 工作树加本次全客户端字号核对：17个相关UI／Native测试文件以 `bun test --parallel=1 --max-concurrency=1` 执行，167项／2701断言通过；UI与Desktop类型检查、四个变更源码文件的Biome、文档结构与影响检查通过。Chrome155.0.8059.86沿实际Native与共享组件、生产编译CSS及隔离只读bridge，在深浅主题、360／767／1000／1280px下完成292组计算字号检查，覆盖设置列表和表单、删除确认、工作台、任务表单、问卷、右栏、地址输入及容器外Portal；另核12px辅助容器内组件明确的14px字号仍生效，并检查宽窄截图。Markdown的8组深浅／宽窄编译样式检查保持14px正文及原相对层级。无脚本错误；保留既有嵌套 `@keyframes` 编译提示，未运行本轮完整安装版窗口。

[Native样式](src/native-tailwind.css)的窗口留白、会话标题和设置右栏与[共享面板](../../packages/ui/src/desktop/SessionPage.tsx)统一消费UI的侧栏动画参数，默认180ms／ease-out。设置导航独立于共同的`.client-content-frame`，主内容与编辑宿主在框内分配两列，编辑列消费UI的RIGHT_SIDEBAR_FORM_DEFAULT_WIDTH（420px），在0与默认宽度之间开合；Windows材质的上下6px留白、外沿圆角和描边只由外框持有。内部栏体在动画期间保持目标宽度，避免自动聚焦遇到零宽表单时提前滚动。空编辑宿主不直接 `display:none`，透明度与可见性随退出完成；外框可用宽度不足800px时，与定时任务一样改为框内右侧覆盖，并以相同曲线位移。提供商、MCP与Skills和定时任务共用`.right-sidebar-editor`、`-body`、`-footer`的高度、独立滚动、12px内容留白及8px／12px底栏留白；标题和底栏不随内容滚动。原portal内容仍在关闭时立即卸载，原读取取消、秘密清理和焦点语义不等待动画。

2026-11-01，Windows x64／Bun1.4.3／Electron44.3.0，右栏溢出修复：页面壳、Windows菜单、提供商、MCP、Skills、定时任务和SessionPage七个受影响完整文件206项／3298断言，UI／Desktop类型、12个变更源码与测试文件的Biome、文档结构／影响、测试归属及边界检查通过。[既有浏览器入口](test/session-shell-browser-runner.fixture.ts)扩充[几何检查](test/session-shell-geometry.fixture.ts)，仅在[隔离夹具](test/session-shell-browser.fixture.tsx)内启用Windows Mica标记；500／800／1280px、560px高、深浅主题六组共1039帧检查外框留白、标题／底栏边界、双击聚焦、滚动与重开，均通过。正文建立定位边界，将Radix隐藏表单控件留在内部滚动区，防止短窗口中聚焦带走整个栏体。实际Windows开发窗口逐步观察定时任务、提供商及MCP开合和Escape恢复；内嵌浏览器另观察窄窗下拉菜单、长表单末尾及Skills详情，标题和底栏保持可见，外层滚动量与溢出量均为零。截图与逐帧数据归`.cache/session-shell-browser-JZmv5A/`。同次入口的八组阅读区几何检查通过，但随后完整会话视觉段在`light: action opacity`断言失败（0.45与1）；以HEAD的Native、共享布局与样式源码对照构建后同样失败，未取得该完整入口通过结论，不将本轮设置证据扩展为完整会话或安装发布资格。

2026-10-19 Windows x64／Bun1.4.3、`f734245a` 加本轮动画改动：[Native页面](test/isolated/native-new-conversation-dom.test.tsx)、[提供商](test/isolated/native-provider-settings-dom.test.tsx)、[MCP](test/isolated/native-mcp-settings.test.tsx)与[Skills](test/native-skills-settings.test.tsx)四个完整文件111项／1713断言及Desktop类型检查通过；连同共享三文件共142项／2007断言。设置宽窄栏的逐帧布局证据见[UI owner](../../packages/ui/README.md#原桌面展示层)，该夹具使用实际RightSidebar与Native CSS，不代证完整安装窗口、真实服务或其他平台资格。

正式 [NativeDesktop](src/native.tsx) 已使用原 kite-desktop 的共享 [SessionPage](../../packages/ui/src/desktop/SessionPage.tsx)、Sidebar、Conversation、Composer 与 RightSidebar。[renderer 入口](src/native-main.tsx)载入原主题、字体、Tailwind/typeset 和共享 CSS；[构建器](scripts/build-native.ts)复用原 Vite/React/Tailwind 管线，仅替换 renderer 构建，Main/preload、Service 闭包、递归制品清单与使用锁保持。macOS 沿原 hiddenInset 与 trafficLightPosition 布局；正式 workspace 仍为原八个。

[输入方式监听](src/native-input-modality.ts)由 renderer 入口在挂载前安装，在 document 捕获鼠标／触摸和键盘事件，通过根元素 `data-input-modality` 统一控制原生控件、共享组件与 Portal 的焦点外观。[Native CSS](src/native-tailwind.css)在 pointer 状态关闭 outline，并约束 Tailwind `focus-visible` ring／边色及调宽把手光环；共享 Composer 的聚焦边色／阴影沿同一状态。实际 focus、输入、菜单／弹窗归焦和键盘导航保持，未增加 blur 或阻止默认事件。键盘仍可恢复焦点提示，Web 未安装此 Native 监听。

2026-10-18 Windows x64／Bun 1.4.3，基于 `f734245a` 的本次焦点样式变更：隔离 Vite 编译的实际共享组件在 Electron 44.3.0 中通过21项点击／键盘检查；包含原工作区既有样式调整的 Chrome 155 无头夹具通过23项，另核亮暗主题添加／编辑按钮的透明悬停和按下背景、相同图标颜色。控件实际保持 focus，菜单／Dialog／Sheet 关闭归焦无残留外框，Tab、键盘菜单退出及按钮／滑块光环恢复，草稿保留，零页面异常。上述[共享页面](../../packages/ui/test/desktop-page.test.tsx)与[Native 新对话](test/isolated/native-new-conversation-dom.test.tsx)两个完整文件31项／567断言、Desktop／UI typecheck、定向 Biome 和文档检查通过。隔离编译保留原嵌套 `@keyframes` 提示；未运行全量默认测试、正式安装窗口或其他平台。

[适配器](src/native-presentation.ts)只将生成 Client 的真实 Workspace/Session/Message 转为原 UI view model。目录状态与时间消费同快照只读 activity，缺能力或未记录的事实保持待读取／未知；完成消息不推断 final reply、Turn、Tool grouping 或执行成功。正文 slot 继续使用现有 ModelOutputMessage 与完整原身份 reader；未知格式、预览与不完整内容继续保留。正文未增加但准确Model或已有原Run事实结束时，将重新核验提示交给[共享reader](../../packages/ui/README.md)，不从宿主状态生成未完成警告或复制资格；原Main lease每次open沿Client读取当时snapshot，不按正文hash复用旧执行状态。原 Composer 的发送、草稿、model choice 和 planMode 回调沿现有 Native controller，不建立第二条提交链。

显式自动测试模式中的“会话工具”将已有后台目录、Runtime logs、Context、恢复、权限、管理、原命令与草稿面板接到原可调整宽度的右侧栏。侧栏开关不卸载对话区，管理操作保留本视图已读的完整正文；关闭读取仍只 abort 所属 GET。全屏设置复用原 Dialog、双栏布局和主题偏好，模型/提供商/MCP/Skills 数据仍沿新 Main 的准确观察与原 mutation。只有真实端口提供操作 callback；工作台仍按手册隐藏。原定时任务草稿页、新对话准备与首次发送、全局目录状态和时间排序、环境信息卡与只读子详情已迁入，空间移除已接原侧栏与主窗口自绘确认；空间和单会话离线历史清理已接同一公开维护，安装版五项常用维护的 macOS 已验范围见[Native owner](docs/native-release.md#macos-安装版离线维护)，这些原主入口已有正式适配，完整行为与阶段退出仍须按[PC 主线](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)的动态结果及剩余资格核对。

[原页面契约测试](../../packages/ui/test/desktop-page.test.tsx)迁回原 12 项展示断言；现有 Native 目录、草稿、问答与计划 DOM 只调整控件/浏览器 API，保留业务断言。源码外 [Native 候选](test/isolated/native-bundle.test.ts)与[driver](test/native-bundle-electron.fixture.ts)已核编译 CSS/字体、可操作 Composer、新 preload bridge、实际审批/任务、冷读和两层使用锁收尾。准确输入、原失败与结果归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08复用原-pc-桌面展示层)，不代表完整客户端、installed 全量、独立审查或 Windows/Linux 阶段退出。

## 原启动页与初始化重试

Windows Mica 与 macOS Vibrancy 窗口的[启动样式](src/native-startup.css)仅在 Main 已确认 `data-window-material=mica/vibrancy` 时将 `.kite-client.desktop-startup` 设为透明，准备中和初始化失败沿用同一容器，直接透出原生材质。文字、图标与共享按钮保留原主题及交互；未确认材质的窗口保留原实色启动背景，服务准备与重试逻辑保持。

2026-10-14 Windows x64／Bun 1.4.2，启动页 DOM 完整文件3项／58断言通过；实际 Chrome headless 按 renderer 的 CSS 顺序载入当前 Tailwind 编译结果、启动样式与共享 CSS，核亮／暗、Native Mica／无材质／非 Native、准备中／失败共12种组合：Mica 启动容器及其承载层透明，其他组合保原实色，文字与重试按钮保主题颜色。定向 Biome、文档结构与影响检查通过；此 CSS 验证不代证 Windows 桌面的最终材质合成，Main 的材质选择未改。

[NativeStartup](src/native-startup.tsx)迁入原 kite-desktop 的启动页布局、[图标](app-icon.svg)和[启动样式](src/native-startup.css)，按钮仍用原共享 Button。[正式入口](src/native.tsx)先完成现有 Main 的 attach 与首屏完整 Workspace／Session 目录观察，再显示原 SessionPage；尚未核实的目录不能进入，空目录与未配置模型可以进入处理。没有人为最短停留时间，不另建服务或执行路径。

[窗口容器](src/native-window-frame.tsx)在准备中、启动失败和重试时使用 `showHeader=false`，不渲染自绘顶栏与 Windows 菜单，也不监听 F10／Alt 菜单导航；内容区使用整个窗口高度。缺 bridge 的失败页使用同一显示规则。完整首屏目录观察通过后恢复32px顶栏与菜单；进入主界面后的连接失败沿原逻辑保留页面和顶栏。Main 继续负责原生窗口按钮，服务准入、诊断、重试和退出沿原端口。

2026-10-14 Windows x64／Bun 1.4.2，`5f41fc3d` 加菜单及启动 header 调整：[启动 DOM](test/isolated/native-startup-dom.test.tsx)与[窗口动作 DOM](test/isolated/native-window-actions-dom.test.tsx)两个完整文件4项／90断言通过，覆盖准备中及首屏目录等待、启动失败、重试、进入应用后恢复菜单、隐藏时菜单快捷键零宿主调用，以及迟到观察、后续连接错误和原草稿。Desktop typecheck、定向 Biome、文档结构与影响核对通过；Biome 保留原未改动 fragment 提示。本次未重新运行真实窗口或完整默认测试，下面既有窗口证据不代证本次启动 header 显隐。

初始化失败保留启动页、公开错误分类和明确“重新尝试”。初始目录观察确认 unavailable 时显示 `native_directory_unavailable`，不会一直显示准备中；原 generation 后来取得完整可用目录仍自动进入。同步状态阻止重复点击；每次重试撤销旧观察、所属历史读取和旧 generation，迟到响应不能覆盖新的目录。Main 的 detach 只释放读取与选择，不停止 Service、Run 或重发业务。进入主界面后连接或目录读取失败保留原页面与草稿，不重新遮挡。缺 preload bridge 时沿同一启动页说明资源错误，不提供不能执行的重试。原“保存诊断”现已接回，范围见下节；完整安装恢复仍按原方案验收。

[Main](electron/main.ts)从已完成真实身份准入的 paired Service 向 [NativeCaller](electron/native-caller.ts)交接同一个 Client 的一次初次许可，首次 attach 不再重复 `/v1/server`。许可消费前同步清空，Main 核原 paired Service 与退出状态；detach、网络释放和关闭都撤销未消费许可。standalone Client 的缓存 `serverInfo` 不能替代准入，后续重连仍沿 Client 完整身份核验。内部交接不增加 renderer／IPC 权利，不改变必需能力或超时；[真实 HTTP caller 测试](test/native-caller.test.ts)核一次交接、再次准入、错 Store／profile 和撤销，准确结果归[普通启动进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动目录恢复与准入交接)。

[启动 DOM](test/isolated/native-startup-dom.test.tsx)沿实际 NativeDesktop 核首次等待、未核目录、空项目／无模型、两类失败、重复重试、旧响应隔离和进入后草稿保持；同轮原新对话／草稿／定时任务测试保业务断言。原[源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)核编译启动样式及首次／冷启动完成后进入原页面，保原任务、审批、冷读与退出；实际窗口不代证初始化失败矩阵。代码输入、执行结果及剩余迁移归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原启动页与初始化重试)，完整 PC、安装恢复及阶段退出仍按原方案核对。

旧读取的失败与成功使用同一展示归属：refresh 的 state 和 select/draft.read 捕获 generation、viewIntent 与 Main 退出生命周期 epoch，迟到拒绝不影响后来的页面；全局目录绑定 generation 与生命周期。读取、会话和草稿失败沿原局部状态、提交记录与后台恢复核实；诊断开关不再开启这些错误的全局Toast。只有普通客户端独立业务入口可提交临时消息，后台读取不会清除或继承它。原全局“操作未完成” AlertDialog 已移除；[NativeToast](src/native-message.tsx)通过 Portal 脱离会话正文与滚动布局，通常挂到 `document.body`，按会话区域的 CSS anchor 固定位置与宽度，避开标题栏和右侧网页。原 `beforeConversation` 渲染入口保留标题栏布局判断。设置打开时，应用级 Toast 移入当前设置 Dialog，仍只临时显示一条，保留原剩余时间；失去原挂载点的 hover／focus 不留下暂停。设置表单继续负责自己的局部错误，不再接收会话、窗口或连接的全局错误副本。消息停留6秒，hover或焦点在消息内时暂停，可以明确关闭；准确 occurrence ID 使旧定时器、关闭动作和未提交渲染不能清除继任消息。

目录不可用无论来自本次目录 GET，还是 Main 状态观察中的 `directory.unavailable`，均由同一原作用域的后台只读恢复重新核实。确认同 Store、原观察作用域仍有效的目录恢复成功后，唤醒该作用域已有的其他只读恢复，沿原 key 和并发上限重新核实，不再额外等待旧退避档位；仍在途的同 key 读取不重复启动。原答复只查询已保存的 Command；确认该原答复回执后也唤醒同作用域已登记的目录恢复，不把缓存的 unknown 当作连接恢复，不因核实目录重新发送答案或工具。当前可见作用域的只读失败按 250／500／1000ms 退避并保持 1 秒上限，最多两项并发；这只影响原读取，不调用模型或重投答案。会话切换、隐藏、Store／generation 变化与退出仍撤销所属恢复。

[可读错误映射](src/native-message.tsx)维护普通客户端实际可触发的三类错误：移除前核实项目不存在、本地数据存储异常和Service未分类处理异常；其余普通业务异常使用中性兜底，不回显内部原因或推断业务成败。无producer、仅状态枚举、只有诊断展示或已有其他局部owner的条目都不作为全局别名。私有存储也承载配置与操作日志，不能一概称草稿失败。业务已有添加／移除空间的有效回执后，后续目录或状态刷新失败沿原读取恢复，不改报原业务失败或未知，亦不重发业务。分支初始读取、项目选择与刷新保持静默，普通目录无须Git，显式切换的安全检查留在所属结果。用户配置审批方式不经过工具审批；真实权限、Store／scope、CAS与启动失败门禁保持。明确退出无条件关闭界面，不再存在退出确认失败Toast或其IPC通知链。

2026-11-06，macOS arm64／Bun1.4.4，本轮按普通客户端实际Toast路径核对原43个映射，最终只保留项目记录不存在、本地数据存储异常和Service处理异常三个专门映射及中性兜底。五个完整DOM文件（Toast、首次会话／草稿、读取归属、窗口动作、恢复压缩输入）118项／2364断言通过，含普通客户端三类移除错误提示、诊断开关不新增Toast、原草稿CAS／同ID查询与恢复零重放。恢复测试改为等待真实Main选择及草稿读取，不再把Toast出现作为同步屏障；原业务与恢复断言保留。前轮Main Conversation／WorkspaceRemoval和Node私有数据18项／172断言的实现输入未变，复用其真实producer边界证据。沿现有隔离Native shell、普通生产样式与诊断关闭，实际观察三类普通空间移除错误的弹出、关闭及后台读取失败，93帧最多一条Toast，草稿与240px阅读位置保持、页面异常为空；受控bridge仅验证真实UI处理，不代证实际Service故障或安装包。过程证据在本机`.cache/toast-20261106/production-only-review.json`及`*-production.log`。Toast组件与CSS未改，复用前轮`error-audit-review.json`的设置Dialog归属、剩余约4秒退役和返回无复现，以及`review.json`的主题／宽度与分栏几何；已删除诊断映射的文案观察不再作为当前资格。退出控制器的变更及验证另归下方退出owner，不由上述浏览器夹具代证。

[真实页面归属回归](test/isolated/native-read-ownership-dom.test.tsx)在原源码下实际三红，修后8pass/61assert：旧选择、草稿和事件状态的拒绝不污染新会话；当前错误、全局目录错误、未知首次提交的同ID查询及启动真失败继续成立。[正式默认 Shell 整窗口](test/isolated/native-shell-lifecycle-bundle.test.ts)保全部原断言、预算与故障路径，在 firstWindow 连接后被动记录公开启动错误与操作弹窗；正常启动、真实 parent 完成、准确停止及最终冷读要求记录为空。该观察不代证此前首屏的瞬时提示，SIGKILL 后真实断线继续保留。准确 owner 全量、原失败与本地交付证据见[客户端修复进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11客户端迟到读取误报)。

## 原启动诊断保存

原 [saveStartupDiagnosticReport](electron/startup-report.ts) 从 kite-desktop 逐字迁入，原两项[保存测试](test/startup-report.test.ts)只调整 owner import。Service 的真实 Store 打开失败产生闭合 `data_unavailable/opening_store`，配对启动准入失败在关闭所属 child 后把有效诊断交给 [Main](electron/main.ts)。没有有效 Service 诊断的通用连接、资源或目录错误不显示保存按钮；重试清除前次诊断，进入主界面不保留该启动操作。诊断协议与报告生成归 [Service owner](../service/README.md)，不导入旧 runtime，也不恢复旧数据迁移。

[preload](electron/preload.ts) 固定提供 `startupStatus/saveStartupDiagnostic`；[IPC](electron/native-ipc.ts) 只接受无 payload 的两个固定端口，核当前窗口、准确主 frame 和 renderer URL，不打开业务 caller。renderer 只得到可保存与保存结果，不接收报告、路径或任意文件写权限。Main 复用原系统保存对话框、JSON filter 和默认文件名，只有用户选定新路径后才以 `wx/0600` 写入。取消不写，已有文件不覆盖；保存失败沿原启动页说明选择新的文件名重试，不把 OS 异常正文或路径送回页面。对话框等待后重新核 frame、当前窗口和捕获报告，重试或退出撤销旧保存资格。

报告保原 `kite.startup-diagnostic.v1` JSON 形状、缩进及固定处理提示，只记录当前真实错误分类与准备阶段；没有有效的存储格式号诊断，`actualSchema/expectedSchema` 均为 null，不推断损坏类型或旧格式迁移。原 [NativeStartup](src/native-startup.tsx) 的保存按钮／错误提示与明确重试沿当前 [NativeDesktop](src/native.tsx) 接入。保存和读取诊断不发送任务、不修改原 Store。

[闭合诊断](../service/test/startup-diagnostic.test.ts)、[实际配对失败与重试](../service/test/isolated/paired.test.ts)、[Main 保存资格](test/native-startup-ipc.test.ts)和[启动 DOM](test/isolated/native-startup-dom.test.tsx)分别核 producer、交接、无 payload／迟到 frame 与报告变化、原页面及固定失败提示。原[源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)保已有任务／冷读／退出断言，再以同一不可变候选运行[诊断 driver](test/native-startup-diagnostic-electron.fixture.ts)：真实坏 Store、原保存入口、取消／已有文件／新 JSON、原坏文件保持、外部修复后同窗口明确重试和零 Model。只有 OS 对话框的选路径 callback 被控制，不代证 OS 人工点击或所有存储故障分类；原 120秒整例预算保持，新增 driver 有界20秒，页面10秒。实际结果、输入和仍未验的完整恢复／平台范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原启动诊断保存与明确重试)。

## 原主题与窗口背景联动

[useNativeTheme](src/native-theme.ts)沿原 kite-desktop Hook 与原 Sidebar 的“暗／亮／跟随系统”，继续使用 `kite.desktop.theme` 本机偏好、DOM theme／color-scheme 和系统媒体监听。现有[preload](electron/preload.ts)固定提供 `NativeThemeBridge`；业务 `NativeBridge` 仍只持原请求与观察，有限展示夹具可不提供窗口端口。主题沿独立固定 IPC 到[Main](electron/main.ts)，只接受原三个值、当前窗口的准确主 frame 与 renderer URL；额外字段、陌生值、其他 frame 和已销毁窗口在改变外观前拒绝。

Main 迁入原 nativeTheme.themeSource、创建时背景和 updated 监听，无系统材质时窗口底色保留浅色 `#fafafa`／深色 `#191919`，关闭后移除所属监听。Mica／Vibrancy 的窗口继续透明，左侧导航仅叠半透明主题灰色，不以主体实色覆盖。固定主题随原偏好立即同步，跟随系统时由实际外观引擎更新；恢复本机偏好沿同一 Hook。窗口外观端口不打开业务 caller，连接或初始化失败不妨碍同步已有偏好，也不改变 Store、任务、草稿或 Service 生命周期。公共 HTTP 和私有数据格式保持。

[内容主题](src/native-content-theme.css)由 [Native 样式入口](src/native-tailwind.css)加载：`.kite-client .client-content-frame` 统一承载会话及设置的主区、右栏配色，并重新绑定实际文字颜色；主会话 Markdown 的行距和间距由 `.client-main-panel` 局部设置。Web 使用自己的样式。深色主体为 `#181818`、输入区与用户消息为 `#262626`，卡片和代码块为 `#222222`，沿用 [Dark Modern](https://github.com/microsoft/vscode/blob/main/extensions/theme-defaults/themes/dark_modern.json)的背景层级与语法高亮。主要交互恢复共享中性灰：深色为 `#ededed` 填充配 `#1c1c1c` 文字，浅色为 `#252525` 配白色文字；正文和输入区链接沿前景色并始终带下划线。现有lowlight类别继续用于代码高亮，注释改用次级文字色，不引入新的解析或协议。正文 14px／430 字重／22.75px 行高，标题和强调保留各自的层级，围栏代码为 12px／20px。字体由共享桌面样式的系统字体栈提供。浅色使用同一会话排版，左侧导航、右栏控件、全屏设置、窗口背景与顶栏布局沿 [UI 共享样式](../../packages/ui/README.md#原桌面展示层)。主区用户消息的 `.user-message-body` 直接消费现有 `--composer-background`，与提示词输入框共用深浅主题底色；不覆盖投递、失败或取消的状态展示。左栏的灰色玻璃叠层归下文的独立背景层，右栏与主区共用内容主题。DOM Portal 沿其实际容器的原主题，不向文档根节点扩散主面板覆盖。

内容主题以语义变量成对管理surface、foreground、muted和primary-foreground。主区保持不透明底色，玻璃仅由左栏负责；更换强调色不直接改变正文对比关系。状态层取当前前景与透明色混合，浅色hover／selected／pressed为5%／7%／9%，深色为7%／11%／13%，在page、card和composer的实际底色上合成后核对。深色正文 `#ededed`、次级与辅助文字 `#c6c6c6`，在小字号下提高文字明度并保留层级；状态文字、图标、提示底色与边框沿[UI共享主题](../../packages/ui/README.md#原桌面展示层)的五类语义色配对，Native内容框继承这些变量，不再单独覆盖红／绿／琥珀色。`--ring`沿前景色，Native Tailwind的ring映射优先消费它并保留input回退；输入区聚焦边框由65%前景与输入底色混合，外晕不承担唯一焦点提示。按[WCAG文字对比](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)核13px可用文字至少4.5:1，按[非文字对比](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)核必要焦点／状态图形与相邻底色至少3:1；不把hover前后两种装饰底色互比作为3:1要求。未来新增配色需提供完整前景／底色组合并通过同一核对，不能只替换背景值。

2026-11-06，内容背景压暗，Windows／Bun1.4.4，`5d39518e1` 加本轮CSS差量：主区与右栏从 `#1f1f1f` 降为 `#181818`，输入框与用户消息从 `#313131` 降为 `#262626`，卡片／代码块从 `#2b2b2b` 降为 `#222222`；accent、内联代码与细边框同步收低，正文／次级文字、500字重及左侧玻璃层保持。生产CSS编译和Biome通过。隔离实际Native组件观察右栏打开／关闭、深浅主题切换与草稿保留，页面无异常；计算样式核主区和右栏RGB24、输入区与用户消息RGB38，普通段落仍为RGB237／13px／500，浅色仍为原配色。用新计算变量复核77组配色零失败，最低文字4.6244:1、焦点3.1387:1；深色正文／主体15.1668:1，次级文字／主体10.3952:1。截图和计算取样在本机`.cache/darker-content-20261106/`；本轮只有颜色变量变化，复用未变组件和运行语义证据，不扩展完整安装或系统材质资格。

2026-11-06，正文500字重，Windows／Bun1.4.4，`5d39518e1` 加本轮CSS差量：只在会话主区 `.typeset-chat` 设置500，行内代码与pre显式保留400，输入框及两侧栏不继承正文覆盖。生产CSS编译和Biome通过。隔离实际Native组件只将bridge夹具的固定Reply文字换为中文段落、列表和代码，组件逻辑与磁盘上的生产JS未改；观察正文阅读及右栏展开后的换行，原草稿保留、页面无异常且无外层横向溢出。计算样式核用户／助手普通段落和列表13px／500，标题与strong为600，行内／围栏代码Consolas 13px／400，输入框13px／400、侧栏14px／400。当前系统字体文件核Segoe UI为400／600、微软雅黑为400／700，没有独立500字面；CSS500由浏览器匹配现有字面，中文增粗可能不明显，未更换原字体或开启额外字重合成。截图、样式读数和字体元数据在本机`.cache/text-weight-500-20261106/`；此范围不代替完整安装版或其他平台字体资格。

2026-11-06，正文亮度调整（字重调整前），Windows／Bun1.4.4，`5d39518e1` 加本轮CSS差量：仅将深色正文由 `#ccc` 提高为 `#ededed`、次级文字由 `#b5b5b5` 提高为 `#c6c6c6`；13px／400字重、背景与布局保持。生产CSS编译和Biome通过，隔离实际Native组件核正文计算颜色为RGB237、字号13px、字重400，祖先合成opacity为1；菜单打开／Escape、hover和深浅主题切换保留草稿与原两条消息，页面无异常。77组配色重新计算零失败，深色正文／主体由10.2638:1提高为14.0792:1，次级文字／主体为9.6498:1；所有已列组合的最低文字4.6244:1、焦点3.1387:1，浅色仍沿原配色。截图和计算输入／结果在本机`.cache/readable-text-20261106/`。本轮仅变更两个颜色变量，复用未变组件JS和运行语义证据；此为所列颜色组合与隔离组件范围，不是完整安装版或全产品无障碍认证。

2026-11-06，中性灰与对比度阶段（正文提亮前），Windows／Bun1.4.4，`5d39518e1` 加本轮CSS差量：生产CSS编译和定向Biome通过；以实际Native隔离组件逐步核深浅主题切换、审批菜单打开／Escape、鼠标hover、键盘Tab焦点出现到3px稳定外圈，以及灰色链接下划线和Consolas 13px行内代码，未发送任务。原草稿保留，用户／助手仍各一条，三栏框架保持。用浏览器实际计算的变量，对page、card、composer上的单层normal／hover／selected／pressed、主按钮、焦点、红绿状态和深色代码颜色共77组计算未舍入的对比度，零失败：文字最低4.6244:1，焦点最低3.1387:1；深色正文／主体为10.2638:1，次级文字／主体为8.0386:1。实际hover文字色与合成背景、稳定焦点样式另有DOM与截图取样，记录在本机`.cache/neutral-contrast-20261106/`。既有67项布局／桥测试及Desktop类型结果复用于未变的TSX和协议，隔离组件JS与上轮哈希一致；本轮只重编CSS。此结果覆盖所列主题与颜色组合，不是全产品无障碍认证，也不代替完整安装版Electron、任意新增颜色或原生玻璃最终合成验收。

2026-11-06，Windows／Bun1.4.4，`5d39518e1` 加本轮样式：原主题两个整文件、[流式 Markdown](../../packages/ui/test/isolated/desktop-streaming-markdown.test.tsx)与[会话滚动](../../packages/ui/test/isolated/desktop-conversation-scroll.test.tsx)共23项／1651断言通过，生产CSS编译、定向Biome与文档检查通过。以[原隔离 bridge](test/session-switch-bridge.fixture.ts)驱动实际Native组件与编译样式，逐步核对深浅主题的标题、列表、引用、代码、表格、警告块、中文输入、新对话及会话往返；B→A保留360px手动阅读位置与原草稿，可见消息仍为原用户／助手各一条。深色前后对照的左侧目录、选中行、右侧标签栏与地址输入五处取样，其配色、字体、字号和尺寸相同。1280px浏览器内把主面板调窄到439px，代码和工具栏正常适配，没有外层横向溢出；未把此项称为窄整窗验证。代码从14px进一步调为13px后重编生产CSS并补核，围栏与行内代码均为13px，正文13px／30px／20px保持。截图和边界取样保留在本机`.cache/dark-modern-main-20261106/`；本轮未复验完整安装版Electron、系统材质或macOS／Linux实际字体。

原四项[主题 Hook 测试](test/isolated/native-theme-dom.test.tsx)只迁 owner／Hook／bridge 名称，保原恢复、系统变化、固定主题、存储拒绝和 DOM 断言；[Main 端口](test/native-theme-ipc.test.ts)核闭合值、准确 frame、连接失败及零 caller 启动。原[源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)从原用户菜单切换三档，核真实 Main／页面底色、Electron 外观引擎更新和冷启动偏好，保全部原业务与收尾。Playwright 默认浅色模拟须取消后才观察真实 Native 引擎；测试仅驱动该引擎，不修改用户系统外观。高速人工拉伸与完整产品视觉资格不由底色状态断言代证。准确输入、原失败与实际通过见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原主题与窗口背景联动)。

2026-10-20 Windows x64／Bun1.4.3，`5dba8a6b` 加本次配色改动：上述两个主题整文件8项／60断言、Desktop typecheck、定向Biome与文档检查通过。Chrome155以隔离的原 Native 会话夹具和实际 Vite／Tailwind 编译样式，核深浅主题×实色／Mica／Vibrancy样式分支×1280／500px共12种组合，主体、标题与输入框色值正确、主体前景对比度保持，宽窗菜单与设置的有效底色正确、透明分支的导航和根承载层保持透明，无页面异常或横向溢出。原 macOS 整窗口夹具的色值断言已同步；本轮浏览器检查不代替实际系统材质合成或完整安装版窗口资格。

## 原消息复制与标题栏缩放

Native [renderer 入口](src/native-main.tsx)明确开启 `NativeDesktop` 的 `nativeWindow` 布局，由[窗口容器](src/native-window-frame.tsx)承载启动与业务页面，启动页显隐按[启动显示规则](#原启动页与初始化重试)。普通 DOM 嵌入默认不套窗口布局。Windows／Linux 的沉浸式窗口顶栏单独占32px，内容区从 y=32px 开始；Mica 会话面板另按下文圆角留白内缩。macOS 将原生窗口按钮与48px业务 header 整合，内容区从 y=0 开始，不再额外保留32px空行。[Main](electron/main.ts)在 Windows／Linux 设置 `titleBarStyle: hidden` 和32px的透明 `titleBarOverlay`，不另显示系统应用图标与标题；macOS 保 `hiddenInset`，traffic-light位置为 `{x:13,y:17}`，与业务 header 垂直居中。`nativeTheme` 更新同步按钮符号颜色，窗口背景继续沿原主题端口。选择 [Electron 原生叠层](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)是为了保留宿主的窗口操作，不新建最小化／关闭 IPC 或另一套按钮状态。

[Main](electron/main.ts)创建主窗口时设置 `minWidth: 800`（Electron逻辑像素），初始尺寸保持1100×780；系统调宽受此下限约束。当前没有保存／恢复窗口尺寸的独立路径。共享页面仍适应缩放后的CSS宽度，左侧栏仅由按钮收展；header和底部个人工作区的内边距不再受900px媒体查询改写。

[Native CSS](src/native-tailwind.css)通过明确的 `data-native-window`和平台属性限定窗口展示；共享 Web 页面不因此变为可拖拽。Windows／Linux 只由独立顶栏声明 drag，内容区使用剩余高度，全屏设置相对内容区定位，所有宽度的侧栏都留在该内容区内，仅由按钮收展。macOS 的顶栏元素改为左上角80×48px的绝对定位区域，不占流式高度；侧栏顶部隐藏重复品牌文字，侧栏收起时通过已有 `sidebar-visible` 状态将安全间距转移到主 header。设置侧栏顶部统一保留48px窗口操作空间，导航另留与主侧栏一致的8px顶部间距，保持键盘焦点轮廓完整；“返回应用”置于同一分类导航首项，在其下方按正常列表排列，不再单独增加横向避让。返回按钮使用共享ghost按钮，带14px返回箭头，32px高、10px图文间距，与主侧栏“新对话”规范一致；其余四个分类沿共享SettingsNavigationIcon提供齿轮、链接、插头及书本，统一14px、10px间距和左右10px内边距，宽窄窗口均与返回行的图标及文字列对齐，分类保留原36px行高；关闭设置仍恢复原会话、草稿与焦点生命周期。macOS 的侧栏、会话、右栏与设置 header 空白声明 drag，内部按钮、链接和表单控件声明 no-drag。顶栏区域在 modal 遮罩之上保留窗口操作。此变更不增加 Service 能力，不改变关闭隐藏与原退出收尾。

2026-10-15 macOS／Electron 44.3.0／Bun 1.4.2 的隔离实际 Main／preload／renderer 与配套 Service 验证了整合布局：1100×780窗口的业务区从 y=0 开始，侧栏 header 高52px，原生按钮位置为 `{x:13,y:19}`；侧栏收起、设置往返、文件变更及760／550／400px窗口的窄侧栏与设置控件均避开按钮区域，草稿往返保留，页面无异常。Windows／Linux 的平台 CSS 切换核实独立32px行保留，不代替这两平台的原生窗口验证。现有窗口交互、启动与共享页面三个完整测试文件共16项／171断言、Desktop typecheck、定向 Biome 和文档检查通过；drag／no-drag 核对为计算样式证据，未进行物理鼠标拖拽验收。

2026-10-31 修复 macOS 会话 header 无法拖窗：[共享样式](../../packages/ui/src/desktop/style.css)的全高 `.conversation-viewport` 在历史启用标题栏叠层后延伸到 header 背后，原整块 `no-drag` 区域在 Electron 中扣除了 header 的原生拖动区域。该视口恢复默认客户端区域；header 与其按钮、侧栏按钮占位仍由上述 Native CSS 分别声明 drag／no-drag。问题在没有 Native 网页时也能复现，首次回复出现与右侧网页打开常在同一轮发生；修复不改变网页容器、控制租约或缩放策略。

当前耐久 dirty 工作树／Electron44.3.0／Bun1.4.2，沿原 `ordinary-dev` 隔离 HOME/Profile，以生产 `SessionPage`、编译 CSS、preload 和真实沙箱 `WebContentsView` 验证。原样式的无历史 header 实际 OS 拖动位移为64×24px；历史顶部、底部及 HTTPS 网页显示后均为0×0px，同窗口仅撤掉视口 no-drag 后恢复64×24px。随后冻结修复源码和制品，无运行时样式覆盖的 Main73937 在六组场景均移动64×24px；Main74904 又记录网页完整显示后的真实拖动，按钮点击一次且窗口不移动，拖动前后保持同一 `https://example.com/` 文档和 `timeOrigin`。原对照、修复制品及过程证据分别保留在 `.cache/browser-recheck-20261030/ordinary-dev/observations/header-drag-stdio-20261031`、`header-drag-fixed-native-20261031`、`header-drag-final-native-20261031`；后者录像完整解码1595帧，人工核184张包含变化邻帧与时间采样的图像至30.008333秒，所核拖动过程未见已显示的网页黑空或旧画面闪回。八项源码／制品 hash 前后相同，相关 Main 正常退出0，本次模型调用为0，原账本仍为295＋209＝504。

聊天正文鼠标选字的辅助断言没有通过，以上两个修复制品的 `RESULT.json` 保留 `actual_native_assertion_failed`，不能当作全项成功。无网络对照 `header-drag-selection-probe-20261031` 核实原 no-drag 与修复样式均为空选区，独立段落可选字；可信 pointermove 的 buttons 为1，但正文 anchor／focus 一起折叠，具体原因未确认，不据此改写生产选字逻辑。用户同日本地实际反馈正文选择正常；这条使用反馈与原隔离夹具失败分别保留，不依据夹具追加选字修复。早期夹具启动／导航超时与准确身份下的强制退出记录同样保留。侧栏／叠层与 Native 窗口操作两个完整文件共11项／361断言及定向 Biome 通过，生产 CSS 编译保留原嵌套 keyframes 优化警告。本次资格仅覆盖上述 macOS 隔离生产组件窗口，不补普通整客户端、安装版或其他平台资格；原浏览器业务验收与用户明确保留的连续缩放缺口沿原负责记录。

[正式 Native 页面](src/native.tsx)接回原 kite-desktop 的 `copyText`／`handleHeaderMouseDown` 行为，仍由原 SessionPage／Conversation 决定可复制正文及 header 交互。[preload](electron/preload.ts)固定提供 `NativeWindowBridge` 的文本复制、窗口缩放及只读材质查询，沿三个固定 IPC 到 [Main](electron/native-ipc.ts)；当前窗口、准确主 frame、renderer URL 与闭合 payload 验证先于宿主动作。文本按原宿主上限接受至 1 MiB UTF-8 字节，超限明确失败，不截断或替换正文；缩放不接受 payload，按实际 isMaximized 切换 maximize／unmaximize；材质查询同样无 payload，只返回 `mica/vibrancy/none`。窗口端口不打开 Service caller，不提交任务或写私有存储。

Native 正文中的 Code Block 单独复制沿用上述原宿主 port 和 1MiB 上限，仍须取得原 Conversation 的准确 `copyText` 资格；预览、流式和未知最终身份不出现代码复制入口。共享 context 覆盖 `NativeModelOutputMessage` 的自定义正文子树，完整 reader 关闭即撤销；缓存校准只暂停操作，保留原代码 PRE、横向阅读位置和已完成反馈。子详情同样以当前 reader 的 `onContent` 和准确阅读身份提供可复制全文，而不是把已取得的 snapshot 长期当作复制资格；关闭全文同步撤销整消息与代码复制，重新读取后才恢复，换 Store／Session／Execution、generation 或快照不能沿用旧资格。临时暂停时保留正文、阅读位置和已有复制反馈，仍由当前读取资格禁用操作；reader 的明确关闭通知单独撤销复制，包括暂停期间关闭，不把普通暂停误当成用户关闭。[子详情复制回归](test/isolated/native-child-copy-dom.test.tsx)核完整正文关闭后的截断代码预览、重新读取及身份失效。[正文缓存 DOM 回归](test/isolated/native-model-output-cache-dom.test.tsx)核完整 reader 的代码复制、停用与关闭，[浏览器缓存夹具](test/conversation-cache-browser-runner.fixture.ts)核实际生产样式及 A→B→A 的节点、滚动与宿主复制。

原 header 只接左键单击／双击，控件与链接不触发窗口操作；单击不缩放，双击切换。失败沿原 AlertDialog，草稿保留。原完整正文门禁保持：预览、不完整回复和未知最终身份不启用 Agent 复制，完整 reader 当前已显示并核实的原文才可复制，关闭撤销资格；成功／失败提示仍归原 Conversation。

2026-10-14 独立顶栏初次验证（Mica 圆角内缩前）：Windows x64／Electron 44.3.0／Bun 1.4.2 的隔离实际窗口使用当时 Main／preload、普通模式 renderer 构建与真实配套 Service，顶栏与原生叠层均为 y=0、高32px，导航及侧栏 y=32px、高52px，导航恢复24px右侧间距。782px内容 viewport 下业务区与设置页均为750px、高度准确到窗口底部；500×720窄窗口的侧栏浮层从 y=32px 开始、高688px。实际主题菜单亮／暗、设置返回、侧栏展开／关闭、最大化／还原、零页面异常与 Main 正常退出0通过。原窗口 IPC／DOM 两个完整文件5项／53断言、Desktop typecheck与定向Biome通过；构建保原 CSS keyframes 优化与大chunk提示。此范围没有物理鼠标拖拽、Linux／macOS新窗口或正式安装制品资格，原平台门禁保持；当前 Mica 面板几何按下文验证。

[Main 端口测试](test/native-window-ipc.test.ts)核原 Unicode／换行、UTF-8 边界、准确 frame、宿主失败、连接失败及零 caller；[实际 Native DOM](test/isolated/native-window-actions-dom.test.tsx)核原 header 过滤、双栏回调和失败时草稿，原[轮次 DOM](test/isolated/native-transcript-dom.test.tsx)保全文复制门禁。原[源码外 macOS 整窗口](test/isolated/native-bundle.test.ts)首次／冷启动以实际 Main 剪贴板读取核准确完整正文，浏览器 fallback 明确失败；测试的[剪贴板保护进程](test/native-clipboard-guard.fixture.jxa)仅在内存保留原各格式字节，stdin 关闭时恢复，不导出用户内容。header 的 DOM 事件验证真实 BrowserWindow 缩放，不代证物理鼠标双击或窗口拖拽；完整 PC 资格仍另核。准确输入、执行结果与未验范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原消息复制与标题栏缩放)。

## Windows 顶栏菜单

Windows 设置页的 `.desktop-settings-header` 不再预留额外高度，`.settings-sidebar` 内部顶部仅保留8px间距，最外层另统一保留6px留白；原独立32px菜单／窗口标题栏已经负责窗口安全区。规则仅作用于 Windows Native，macOS 的48px窗口按钮避让、设置主内容和右侧编辑栏保持原布局。

2026-11-01，Windows x64／Electron44.3.0：实际开发窗口前后核左栏返回行上移42px，右侧外框和菜单栏保持；独立Profile、生产renderer（诊断关闭）与原配套Service另核常规／MCP切换、顶部返回按钮及原页面恢复，窗口正常退出0，5个所属进程全部结束，零模型请求。过程图与无障碍树在本机`.cache/settings-win-sidebar-20261101/`，隔离renderer复用`.cache/scheduled-inline-time-20261101/app`。原窗口动作DOM整文件1项21断言、CSS Biome及文档检查通过；仅改CSS，不扩展安装版或其他平台资格。

[窗口容器](src/native-window-frame.tsx)在进入主界面后，于 Windows 顶栏左侧绘制“文件、编辑、视图、帮助”，沿共享主题颜色和圆角，菜单按钮使用 `no-drag`，其余顶栏保持原拖动区域。菜单支持 F10、左右键与下键，以及 Alt+F／E／V／H；点击时保留原编辑器焦点与选区。macOS／Linux 主界面保留原顶栏。窗口布局由 `NativeDesktop` 明确启用，启动准备及失败页按[启动显示规则](#原启动页与初始化重试)隐藏 header，进入应用后全屏设置页继续保留菜单。

[菜单 owner](electron/native-window-menu.ts)定义中文原生项，[Main](electron/main.ts)安装隐藏的窗口菜单以保留原生快捷键，再从相同模板通过 [Electron Menu.popup](https://www.electronjs.org/docs/latest/api/menu#menupopupoptions)打开对应下拉，不增加另一行菜单。编辑、缩放、全屏、隐藏与退出使用 Electron roles，退出仍经过原 `before-quit` 与 `settleDesktopQuit`。文件前三项沿固定事件返回原 renderer controller 的 `prepareConversation`、`addWorkspace` 与设置状态；Ctrl+N／O／, 在 Main 的 `before-input-event` 中按同一固定动作分发，拒绝组词、重复和额外修饰键，并阻止重复进入原生 accelerator。F10／Alt 导航留给 renderer。准备中、原 mutation 进行中或退出中不进入页面操作，迟到事件同样核当前状态。进入新对话保原草稿，不创建会话或发任务，添加空间保持原准确选择及登记路径。

Windows Native 的全屏设置保留已有 `covered` 内容区的隐藏与 `inert`，设置 Dialog 使用非 modal 模式以保留顶栏的鼠标、键盘和可访问入口；其他嵌入及平台保持原 modal 模式。全屏设置不按外部鼠标或焦点事件自动关闭：下拉控件开合中的第二次按下可能被重定向到文档，焦点守卫也位于设置DOM外；`onInteractOutside`阻止默认关闭，外部pointerdown同时取消原事件的默认行为，窗口菜单文字禁止选择。正常输入框双击选词、顶栏菜单、原返回与Escape层级保持，未改公共Dialog的默认策略。

2026-11-01，Windows x64／Bun1.4.3，`be57a4a1d`加当前工作树：在现有development Electron44.3.0窗口复现双击“默认编辑器”退回主页面；修复后逐步核对常规下拉框双击、提供商未提交表单的输入框选词与预设下拉框双击、第一次Escape关闭编辑栏／第二次关闭设置，配置未提交并恢复原会话。原[窗口操作回归](test/isolated/native-window-actions-dom.test.tsx)在修复前以焦点守卫聚焦复现设置卸载，修复后核外部焦点／第二次pointerdown不关闭、原事件取消、菜单仍可调用及Select／设置两级Escape；整文件1项／34断言通过。连同原[页面壳](test/isolated/native-new-conversation-dom.test.tsx)共82项／1776断言、Desktop类型检查和定向Biome通过。范围为当前开发窗口及上述DOM事件，不代替完整安装发行或其他平台验证。

[封闭菜单 bridge](src/native-menu-bridge.ts)只暴露四个 menu ID、整数位置与当前可操作状态，以及三个固定页面动作。[preload](electron/preload.ts)过滤未知事件并在卸载时移除监听；Main 核当前窗口、准确主 frame、renderer URL、Windows 平台、闭合 payload 和窗口边界，按实际页面缩放换算下拉位置，窗口菜单端口不打开 Service caller。宿主错误返回通用失败，顶栏允许再次打开。设置和目录仍由已有业务端口核权限。

[菜单端口测试](test/native-window-menu.test.ts)覆盖页面缩放、禁用项、文件快捷键的修饰／组词／重复边界、外来窗口／frame／文档、开发 HTTP 边界、闭合参数和宿主错误；[窗口 DOM](test/isolated/native-window-actions-dom.test.tsx)核四个菜单、现有页面动作、设置页菜单可访问、设置返回、添加空间原请求、草稿保留及零任务提交。

2026-10-14 Windows x64／Bun 1.4.2／Electron 44.3.0，`5f41fc3d` 加本次菜单 diff：使用当前 Main／preload、普通 renderer 构建与独立 Profile／真实配套 Service，实际窗口核四个入口、原生下拉、保留原输入焦点与全选、文件菜单进入设置／新对话、设置页继续打开菜单、草稿保留、Electron 输入端口的 Ctrl+, 与 F11 全屏／返回、F10／左右／下键与 Alt+H、实际放大／恢复、用户菜单暗／亮主题、32px初始内容起点及500px窄窗口。零页面异常、Main 正常退出0；文件快捷键验证使用 Electron 输入端口，原生项选择使用实际 MenuItem，不代证物理键盘／系统菜单鼠标点选。菜单端口、原窗口 IPC、窗口动作 DOM 与启动 DOM 四个完整文件13项／181断言通过；Desktop typecheck、定向 Biome、文档结构／影响核对和统一边界检查通过，Biome 保留原未改动 fragment 提示，构建保原 CSS keyframes 与大 chunk 提示。未运行完整默认测试、正式安装制品或其他平台新窗口；这项菜单改动不提升这些资格。

## Windows 原生 Mica

用户消息气泡由[内容主题](src/native-content-theme.css)设置为上下8px、左右16px内边距。2026-11-07后续留白调整（Windows／Bun1.4.4，`5d39518e1`加本轮CSS）的生产CSS编译和定向Biome通过；原隔离实际Native组件的计算值为8px／16px／8px／16px，单行总高46px，宽度与原左右16px时相同。逐步观察B→A，原草稿和用户／助手消息各保留一份，页面无异常；截图与计算值在本机`.cache/message-padding-20261107/`。本次只改内边距，复用未变的组件JS、主题和布局验证，不扩展完整安装版资格。

2026-11-07，Windows／Bun1.4.4，`5d39518e1`加本轮样式：分隔线与用户消息内边距调整的生产CSS编译、两文件Biome、文档结构及影响检查通过。沿原隔离bridge与实际Native组件逐步观察1280px深浅主题、两侧鼠标拖动和键盘调宽、设置打开／返回，以及900px下定时任务编辑右栏打开／取消：内部分隔线为4%单线，右栏宿主不重复描边，草稿和原用户／助手消息各一份；用户气泡计算上下内边距由12px变10px，单行总高由54px变50px，左右16px与底色保持。截图及几何记录在本机`.cache/sidebar-borders-20261107/`。本轮仅变更Native CSS，复用未变的组件JS与既有行为测试；未重验完整安装版或原生材质最终合成。900px且左栏扩至420px时，浏览器标签栏宽度折叠为0，调整前后CSS同样复现，此次未改变该布局行为。

三栏整体的外沿使用 [Native CSS](src/native-tailwind.css) 的 `--native-content-shadow`：深浅主题均为向下1px、模糊6px的单层黑色阴影，亮色不透明度6%、深色28%。唯一1px半透明描边由 `.client-panels::after` 与 `.desktop-settings.settings-layout::after` 绘制，包住左侧玻璃栏、主区和右栏；`--native-content-border` 亮色为黑色5%、深色为白色10%。最外层统一圆角和裁切，内部 `.client-content-frame` 及右栏不再单独设置圆角、外边距、阴影或外沿描边；内部左右分隔线独立消费`--native-sidebar-border`，浅色为黑色4%、深色为白色4%；左栏调宽线、材质设置导航的右边线与右栏左边线保持1px声明，外框描边不变。覆盖式右栏的`#details`宿主不再重复描边，分隔线由`.right-sidebar`持有，原生浏览器继续读取该边框的宽度与RGBA颜色。调宽把手保留原命中、悬浮／聚焦提示和键盘行为。macOS继续保持直角、零外留白和无外沿描边。

Windows 导航的 [Native CSS](src/native-tailwind.css) 将宽侧栏和窄窗口侧栏的外层左右 padding 归零，列表内边距设为6px、header设为10px；底部用户区沿共享负 margin 抵消列表内边距，使顶部分隔线铺满侧栏。此布局也适用于 Windows 实色回退，不改变调宽与收展逻辑。

[Main](electron/main.ts)根据实际运行宿主的 Windows build选择材质：Win32且build至少22621时，在窗口构造中设置 `backgroundMaterial: mica`，窗口背景保持 `#00000000`；主题变化只更新原生深浅外观与窗口按钮符号，不改回实色。范围由 [Electron](https://www.electronjs.org/docs/latest/api/base-window#winsetbackgroundmaterialmaterial-windows)及 [DWM](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type)的最低支持版本定义；较早 Windows 与 Linux 保持原实色，macOS 按下文使用 Vibrancy。具体材质绘制与系统降级归 [Windows Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)。

`getWindowAppearance()`沿前述窗口守卫只读 Main 选择，不从构建机、NODE_ENV或浏览器 User Agent猜支持情况。renderer在挂载前读取闭合 `mica/vibrancy/none`，读取失败或旧bridge缺此端口时按 `none`；这项外观读取不依赖 Service成功连接。明确 `mica/vibrancy` 的 Native窗口共用透明 root／body／Frame／shell作为材质承载层，窗口顶栏直接显示原生材质；`.client-sidebar-panel` 叠上述半透明主题灰色，内部 `.sidebar-header`／`.sidebar` 保持透明，窄侧栏使用同一背景规则。主面板、会话header及main保留实色背景，输入框与用户消息共用输入区底色，卡片沿所属主题。设置dialog透明，分类侧栏与返回区沿同一左栏灰色玻璃层，右侧设置内容和编辑栏保留原实色背景，面板圆角和留白按下文平台规则处理；未确认材质时保留原实色设置背景。共享Web不消费Native材质标记，Windows／Linux 独立32px顶栏及原运行权限保持。

设置是同级视图切换：[Native页面](src/native.tsx)将settingsOpen交给SessionPage.covered，主panel树保持挂载和原几何，以opacity0退出绘制，inert／aria-hidden退出交互，避免玻璃侧栏叠出下层正文、边缘或导航文字。保持挂载用于保留未发送草稿、阅读位置和panel状态，不执行会话重选、任务取消或新业务申请。窄侧栏原模态在covered期间关闭，返回后按原开关恢复；原返回自动聚焦在切换期间被抑制，设置自身仍有Radix焦点范围与Escape关闭。设置内容位于panel同级的overlays，明确showOverlay=false，不渲染会压暗材质或透出旧页面的遮罩；设置reader随原内容打开／关闭，Core／Service的authority与运行状态保持。

Windows Mica 的 `.native-window-content` 以 `--native-shell-inset: 6px` 统一保留四周留白，最外层会话Group和设置布局在其中包住全部三栏；左侧导航与实色主区之间只有细分隔线，不叠额外间距。内部 `.client-content-frame` 铺满所属工作区，宽高100%、外边距0、圆角0、无独立阴影。`--native-panel-inset` 保持0，标题、收展按钮与设置导航不重复预留材质间距；设置dialog按同一外层6px内缩，主区与编辑栏仍沿原900px断点并排或覆盖。导航开合、调宽及右栏退出只重分配原两层Group，整体外沿保持固定。macOS继续以0px外留白和直角铺满，共享Web与无材质回退不增加材质边距。

Windows `.sidebar-header` 的左／右内边距分别为16／10px，使 Kite 标题与主要导航、空间图标的左边缘对齐。桌面共用收展按钮的展开位置消费同一 `--sidebar-header-end-padding`，收起位置消费标题起始内边距；Mica／Vibrancy 加上内容的顶部留白，Mica 收起位置另计6px左留白，macOS 收起位置避让原窗口按钮区。按钮位于共享面板边界的零宽轨道，不受导航200px最小内容宽度的裁切，窗口拖动排除仍由 `no-drag` 保持。macOS 收起后按钮覆盖会话 header 内的 `.session-sidebar-toggle` 占位，该占位同样声明 `no-drag`，使原生拖拽区域明确扣除按钮所在位置；只给外部按钮声明 `no-drag` 仍可能被 header 的拖拽区域截获。

玻璃导航的 `.sidebar-header` 不再单独添加顶部材质间距，`--native-panel-inset` 统一为0；Windows Mica的6px留白由最外层提供，macOS继续为0。Windows 标题行取消共享48px最小高度，由品牌内容和顶部10px内边距撑开，主导航顶部外边距沿共享8px；品牌、侧栏按钮、会话标题与操作按钮共用垂直中心。收展按钮两种状态均沿原 `--sidebar-toggle-top` 在最外层Group内定位，不再重复计入材质留白。macOS／Linux 沿共享48px标题高度居中。2026-10-23 的隔离浏览器加载当前生产 CSS 与标题结构，深浅主题、Mica／实色、1200／600px八组测得四处中心相同，侧栏收起与恢复时按钮中心不变；标题行随28／40px内容行高增为42／54px，主导航间距保持8px。该证据只覆盖浏览器布局，不代替完整 Electron 窗口交互或原生材质合成验收；2026-10-19 旧52px标题行的历史几何结果不作为当前自适应标题行的验收依据。

2026-10-25，macOS／Electron44.3.0：隔离 `hiddenInset` 窗口以系统鼠标事件复现收起后按钮不接收 pointerdown／click，而DOM点击仍能展开；占位排除拖拽后，系统点击可反复收展，邻近标题空白仍能原生拖窗。当前48px header与32px按钮保持。浏览器窗口回归同时核深浅主题下占位完整覆盖按钮、header仍为drag、占位为no-drag；CDP点击仅验证DOM交互，系统鼠标证据单独核实，未重验正式安装包。

Native 的会话标题栏左内边距仅在共享Group的 `data-animate-width=true` 时跟随180ms过渡，与[共享标题占位](../../packages/ui/src/desktop/SessionPage.tsx)及macOS窗口按钮安全间距同步；Windows Mica的6px外留白固定在最外层，内部面板不再动画调整独立外边距；手动调宽沿原事件关闭动画，减少动画偏好统一直接切换。2026-10-19 Windows x64／Electron44.3.0 的隔离实际组件与编译样式逐帧对照：原Windows Mica侧栏收起的标题反向跳动为50px，实色为44px，macOS样式标记为108px；修复后1086px可用宽度的反向偏移小于0.1px、垂直位移为0。786px紧凑布局另核深浅主题、有／无右侧按钮、实色及macOS样式，减少动画偏好另核五组，反向及垂直位移均为0。页面／侧栏／定时任务／Native新对话／后台五个整文件60项、1041断言和UI／Desktop类型检查通过；平台标记只验证样式，不代证其他平台原生窗口或安装资格。

Mica 分隔条在实时 `aria-valuenow=0` 时立即归零、关闭过渡的规则，只用于 Group 未进行程序动画的直接调宽。按钮收展仍沿共享分隔条过渡，避免快速反向切换时提前撤掉1px占位；原指针／键盘调宽事件先结束程序动画，因此按住拖到0会立即释放分隔条占位，最外层6px留白始终保持，同次按住反向展开继续可用。

同日基于 `f734245a` 加当前未提交源码，`bun .cache/sidebar-rapid-20261019/run.ts wide-verified` 构建运行，再以 `compact-verified --width=800 --skip-build`、`reduced-verified --reduce --skip-build` 复用同一构建。隔离 Electron44.3.0 实窗加载实际 SessionPage、Conversation、Composer、NativeWindowFrame 与编译样式，独立用户目录、沙箱保持开启。1086／786px可用宽度及减少动画模式共36组，每组24次快速切换，共864次切换请求，另含同帧重复点击和最终状态校准；5795份位置采样包含逐帧跟踪与点击前后核对。修前 Mica 的面板与标题过渡相差约1px；修后标题、正文和输入框的非预期反向／垂直位移、点击瞬间突跳及滚动漂移均为0，节点、草稿、保存宽度与最终按钮／ARIA／inert 状态保持。键盘 Home 收起及 Chromium 输入事件保持按下拖到0后反向展开，18组均通过。420px上限经面板库按可用宽度换算，最终恢复宽度与初始值最多差0.532px，保存值仍为420；该边界核连续性、方向和最终状态，不假定归一化动画进度完全一致。上述五个完整测试文件本轮重跑60项／1041断言通过，定向CSS检查通过；这是本机组件布局与输入证据，未复验真实Service、完整安装包或其他平台原生材质。

2026-10-14 设置组件层验证（统一圆角前）：Windows 11 x64 build26300／Electron 44.3.0／Bun 1.4.2，实际当时Main／preload、普通renderer与配套Service隔离窗口核Mica标记。原Main窗口资格已由 `DwmGetWindowAttribute`确认 `DWMSBT_MAINWINDOW=2`；该次未改宿主材质选择。亮／暗设置中，主panel树opacity0但仍保持750px布局高度；向该树注入仅供验证的洋红底色后，返回区、分类栏及其与原主内容重叠区域的实际PNG alpha均为0，右侧设置内容为原主题RGB／alpha255，圆角和顶栏仍透明，无旧页面或黑色遮罩。主textarea和panel对象、未发送草稿及非零scrollTop（120px）在返回与Escape后保持；覆盖期间旧输入不能取得焦点。500×720窗口设置侧栏180px，原侧栏模态暂停，连续Tab均在设置内，返回后恢复侧栏并保草稿。零页面异常、Main退出0通过。[新会话DOM](test/isolated/native-new-conversation-dom.test.tsx)另核原输入实例、未发送草稿、返回／Escape、零重复attach／select／messages／draft.read和零发送；它与启动、草稿、读取归属、模型／提供商／MCP／Skills设置和窗口动作共九个完整文件44项／526断言通过。Desktop／UI typecheck及定向Biome通过。未运行完整默认、旧Windows或新macOS／Linux窗口，透明PNG不代证桌面壁纸最终合成或正式安装视觉资格。

同环境此前圆角与分界验证（统一圆角前）：亮／暗主题下四周留白均为6px，面板y=38、高738px（viewport782）；实际PNG的圆角切口、留白和未聚焦的调宽分隔均为alpha0，面板内部为255。实际Playwright键盘与鼠标调宽、聚焦把手的可见环、收展动画结束后的6px左留白均通过；500×720窄窗口面板为x=6、y=38、宽488、高676，无整页溢出。后续设置覆盖调整复用该次主面板与调宽证据；当前圆角值和本轮窗口验证见下文。此检查核renderer交互与绘制层，不提升未取得的安装或其他平台资格。

共享 [RightSidebar](../../packages/ui/src/desktop/RightSidebar.tsx) 的外观由 [Native CSS](src/native-tailwind.css) 管理。会话工具、文件变更、宿主详情和定时任务编辑在同一 `.client-content-frame` 内与阅读区等高，右栏是共同内容面中的一个区域；开合只重新分配内部宽度，接缝保留单一左边框。唯一外沿描边由更外层布局包住左栏、阅读区和最右侧，内部阅读区与右栏不分别形成圆角外框。提供商／MCP／Skills 设置编辑栏继续沿原900px断点并排或覆盖，使用原独立宿主和外侧留白，覆盖时仍与设置内容等高。两类布局复用主题变量，关闭、滚动、焦点与读取生命周期保持。

[左栏背景](src/native-navigation-material.css)仅在Main已确认的Mica／Vibrancy分支生效：`.client-sidebar-panel` 与设置 `.settings-sidebar` 各绘制一层主题灰色，深色为55%的 `#1f1f1f`、浅色为60%的 `#fafafa`，使用24px的 `backdrop-filter`；内部header和列表保持透明，避免重复叠色。左栏控件、字体和业务内容沿原样式；右栏的 `--page-background` 等颜色由上述共同外框提供，玻璃叠层不进入右栏。原生材质仍由系统合成，renderer不读取壁纸或创建额外窗口。无材质分支保持原实色；减少透明时左栏使用对应不透明灰，强制颜色时使用Canvas并关闭模糊。左栏、主区和右栏共用最外层圆角与裁切，Windows边界覆盖全部三栏且四周统一6px留白，内部主区不再单独装饰，macOS保持原有直角铺满；不修改浏览器协议、Native View或宿主材质选择。

2026-11-06，三栏整体协调阶段，Windows x64／Bun1.4.4，`5d39518e1` 加本轮差量：`bun test` 分别执行[Native面板DOM](test/isolated/native-browser-pane-dom.test.tsx)与[布局桥](test/native-browser-bridge.test.ts)两个整文件，67项／595断言通过，包含外层6px与内层0px的唯一计量、CSS与旧几何不一致时等待及恢复；Desktop typecheck核1278文件通过，实际Native组件与生产CSS重编通过。隔离浏览器逐步观察深浅主题切换、左栏收展、右栏新标签／变更切换、调宽到433px主区后恢复、设置编辑栏打开／取消及返回：原草稿和用户／助手各一条消息保持，无重复文字或旧页面透出，页面无异常。1280×720视口内最外层为(6,38)、1268×676，标题栏下方四周均6px，唯一外层圆角16px；内部内容框margin、圆角和阴影均为0／none，且无独立描边。主区和右栏深色均RGB31、浅色均RGB250；输入框和用户消息深色均RGB49、浅色均RGB255。左侧玻璃和右栏原字号保持。无材质分支padding为0，macOS样式标记另核0留白、直角及无外阴影／描边。截图及取样在本机`.cache/theme-content-boundary-20261106/`。本项覆盖隔离浏览器的实际组件与CSS操作，不代替完整安装版Electron、系统材质最终合成或实际Native View裁切资格；原协议定义、版本及宿主材质选择未改。

2026-11-06，左栏材质阶段（右栏颜色同步前），Windows x64／Bun1.4.4，`5d39518e1` 加本轮样式：`bun test` 分别执行[侧栏交互](../../packages/ui/test/isolated/desktop-sidebar.test.tsx)和[列表渲染](../../packages/ui/test/isolated/desktop-sidebar-render.test.tsx)两个整文件，14项／393断言通过；本轮此前执行的[标签页](../../packages/ui/test/isolated/desktop-session-tabs.test.tsx)与[页面](../../packages/ui/test/desktop-page.test.tsx)共39项／457断言继续适用于未变的TypeScript。生产CSS重编后，以[实际Native组件夹具](test/session-shell-browser.fixture.tsx)和受控渐变底图观察深浅主题、左栏收展、设置分类切换、右侧编辑栏打开／取消及返回应用，原草稿与用户／助手各一条消息保持，没有旧页面透出或重复文字。左栏各主题只有一层55%／60%灰色及24px模糊，子header与列表透明；右栏恢复原深色RGB25／浅色RGB250，原字体、字号和控件保持。1280px浏览器内共同外框与右栏的右边缘均为1274px，整体圆角16px并保持裁切；输入框和用户消息底色在深色均为RGB49、浅色均为RGB255。`none` 分支左栏仍为原RGB36且无模糊。截图、取样与对照保留在本机`.cache/gray-glass-20261106/`。此项为隔离浏览器的组件与CSS操作核验，不代替完整安装版Electron、系统壁纸最终合成或实际Native View裁切资格；宿主材质选择与浏览器协议未改。

2026-10-18 Windows x64、Bun 1.4.3，在 `f734245a` 加本次布局改动上，定向 `bun test --parallel=1 --max-concurrency=1` 的 Native 设置／新会话与共享页面／定时任务七个文件共136项、1823断言通过。隔离模拟桥夹具编译实际 Native 与共享 SessionPage，Chrome 155.0.8059.82 无界面检查72组几何状态：明暗主题、Windows／macOS／实色回退的 CSS 标记、设置400–1600px窗口及900px断点两侧、三类会话右栏和左侧导航收展均核等高与接缝；键盘调宽、分隔条上下边界及关闭后留白恢复通过，页面零异常。CSS Biome、文档结构／影响检查通过；未运行实际 Service、macOS／Linux 原生窗口或正式安装制品，不以 CSS 标记检查替代这些资格。

最外层1px淡边缘位于左栏、实色主区与工具栏之上，不接收指针或增加占位尺寸；会话使用既有导航／工作区Group，设置使用既有Grid容器，不增加第三套分栏。内部接缝分别由导航分隔条与右栏左边框承担。[NativeBrowserPane](src/native-browser-pane.tsx)读取 `.native-window-content` 的实际padding，沿原 `NativeBrowserLayout.groups` 的left／right表达外层留白；内层读取原内容frame的实际margin，当前为0。CSS与实测几何不一致时等待下一次有效测量，不拿旧尺寸伪装新布局；协议定义及版本不变。macOS不绘制外沿描边。分栏和动画仍由[共享UI](../../packages/ui/README.md#原桌面展示层)负责，原共同内容框的布局理由及本次装饰归属见[共同外框记录](../../.agents/notes/implemented/bug-fix/2026-10-20-session-content-frame.md)。

2026-10-18 Windows x64／Bun 1.4.3／Chrome 155.0.8059.82，在 `f734245a` 加本次修复上，隔离夹具加载实际 SessionPage 及当前 Vite 编译样式：100%／150%缩放下三类右栏共60组开合逐帧检查，左栏的物理像素边界保持稳定，最大 CSS 量化差为1/64px；修复前同类场景曾短暂偏移约113px。真实鼠标将右栏调宽80px，左栏位移为0；键盘调宽、动画中切入调宽、快速反向开合、左栏收展恢复和减少动画设置通过。亮暗主题在标题及正文左边缘均读到描边像素，macOS CSS 标记仍为无描边。定向 `bun test --parallel=1 --max-concurrency=1` 的共享页面、定时任务和 Native 新会话三个文件46项／713断言、UI typecheck及定向Biome通过；未复验真实 Service、原生壁纸合成或其他平台实窗。

2026-10-20 Windows 11 x64 build26300／Bun1.4.3／Electron44.3.0（Chromium152.0.7977.78），`5dba8a6b` 加本次共同外框 diff：隔离测试制品从现有[浏览器 UI 夹具](test/native-browser-ui.fixture.tsx)和[原生宿主夹具](test/native-browser-electron.fixture.ts)编译实际 SessionPage、NativeWindowFrame、NativeBrowserPane、preload 与浏览器 controller，并开启可见原生窗口及独立用户目录。亮暗主题、1280／900px、新标签页／变更／实际 WebContentsView／长正文共32段开合逐帧检查通过；阅读区与右栏首次移动采样相同，宽度总和最大误差小于0.001px，外框右侧6px留白固定，零临时主区滚动条、零内容溢出，收起时原生网页立即隐藏。8个开合状态的PNG核四边持续可见、外侧留白不含实色栏内容；4组亮暗／减少动画配置核快速反向、Escape与焦点、拖拽／键盘收起及导航同开。另核900→800→700→650→500→700→900px恢复和显式关闭保持；16组平台／材质／主题／减少动画样式配置通过，其中macOS／Linux仅为CSS标记检查。`bun test --parallel=1 --max-concurrency=1` 的共享页面、标签页、导航、定时任务及Native文件变更、浏览器、新对话七个整文件共67项通过，移除固定面板数量断言后页面整文件13项另行复验；UI／Desktop typecheck、定向Biome、文档结构／本次作用域影响核对及统一边界检查通过。该证据不覆盖正式安装制品、真实Service或其他系统原生合成；既有嵌套 `@keyframes` 编译提示保留。

## macOS 原生玻璃

[Main](electron/main.ts)在 macOS 窗口构造中设置 `vibrancy: sidebar` 和 `visualEffectState: active`，窗口及主题更新的底色均保留 `#00000000`。使用 [Electron 原生 Vibrancy](https://www.electronjs.org/docs/latest/api/structures/base-window-options)使材质由 macOS 合成，失焦时保留活动材质，深浅外观沿原 `nativeTheme` 端口同步；不设置 `transparent: true`，保留普通原生窗口的缩放与阴影。Main 只读报告 `vibrancy`，[preload](electron/preload.ts)接受闭合新值，未新增让 renderer 自选窗口效果的端口。

macOS 复用上述玻璃透明层、左栏灰色叠层、设置遮盖、导航对齐和调宽样式，并将 `--native-panel-inset` 设为0。会话共同外框 `.client-content-frame`、内部 `.client-main-panel` 与设置 `.settings-content` 均使用0px外边距和直角，内容铺满可用区域；共同外框不绘制外沿描边，内部卡片和输入框仍沿原样式。侧栏 header、会话 header 与 `{x:13,y:19}` 的原生窗口按钮保持同一顶部行。启动中与失败页同样透明；会话正文、设置内容与编辑右栏继续实色。系统材质的最终合成由 macOS 管理。

同日内容铺满调整后，隔离实际窗口重核13种状态：亮暗主题的主面板与设置内容均为0px圆角、0px外边距、无阴影描边，高度铺满780px可用区；550／400px设置内容同样到达窗口右边界。玻璃透明层、侧栏收展、键盘调宽、草稿往返保持，Mica 平台 CSS 仍为10px圆角和6px外边距；页面无异常，CSS Biome及文档检查通过。本次仅改 CSS，沿用未变 TypeScript 的前轮检查结果。

2026-10-15 macOS 26.7.1／Electron 44.3.0／Bun 1.4.2，内容铺满调整前的隔离实际 Main／preload／普通 renderer 与配套 Service 的13种状态核对通过：原桥返回 `vibrancy`，亮暗主题经原用户菜单切换后透明承载层保持透明，NativeImage 中导航空白 alpha为0、正文为255；向原主面板注入洋红底色后，设置左栏与原主面板重叠区域仍为alpha0，右侧内容为255。侧栏收展、键盘调宽、550／400px窄侧栏和设置往返保留草稿，顶部 header仍从y=0开始，原生按钮位置和窗口可调宽保持，页面无异常。另核 Mica 与 `none` 的 CSS 适用边界；窗口 IPC、窗口动作 DOM、启动 DOM 三个完整文件9项／155断言、Desktop typecheck、定向 Biome 和文档检查通过。此证据覆盖宿主接线和 renderer 透明层，未核系统壁纸最终合成或切换系统辅助功能设置。

## 交互状态与透明材质

Native消费[UI共享语义色](../../packages/ui/README.md#原桌面展示层)的深浅两套红、暖橙、绿、蓝和紫：应用确认及提供商删除按钮使用独立实色填充阶，提供商错误／成功／信息提示使用对应文字、边框与底色；未读提醒、浏览器标注及错误页图标沿信息蓝色。实际网页中的[可信浏览器装饰](electron/browser-decoration.ts)使用同族中蓝固定值，2px内框及白描边光标在网页深浅底色上保持可见，不读取网页主题或引入新的执行权限。权限确认、操作准入、取消与原数据身份保持；组件配色验证与适用范围归上述UI owner。

2026-11-01，设置分类恢复持续选中高亮：Windows x64／Electron44.3.0、独立Profile及普通生产renderer实际核常规、MCP、Skills、提供商与模型四项，鼠标移开后仍只有当前项保留底色；Tab把焦点移到Skills时仍保留MCP选中，Enter后选中转到Skills，键盘焦点环保持，返回原页面正常。过程截图和无障碍树在本机`.cache/settings-selection-20261101/`；零模型请求，窗口正常退出0，5个所属进程全部结束。本轮仅改CSS及当前文档，未改页面状态或TypeScript；原窗口动作DOM结果沿用前轮，CSS Biome与文档检查通过，不扩展安装或其他平台资格。

Native 的[普通设置样式](src/native-tailwind.css)与[提供商／MCP／Skills 列表](src/native-provider-settings.css)消费 [UI owner 的中性交互变量](../../packages/ui/README.md#原桌面展示层)，顶栏菜单与设置内容沿用默认的悬停／选中／按下分级；设置返回与 `.settings-sidebar` 将按下变量局部映射到悬停值，与共享侧栏保持一致。设置分类沿原aria-pressed标记当前页，选中项持续保留悬停底色，指针移开或重复点击不撤下也不加深；切换只标记新的分类，保留原生按钮及键盘焦点提示；Tailwind 的 `--color-accent` 映射到 `--control-hover`，使移出页面树的菜单也遵循同一规则。原 `--accent` 继续服务静态内容，不随交互高亮调整。实色主操作保留原角色配色，禁用状态和键盘焦点沿原控件语义。

2026-10-19 Windows x64／Bun 1.4.3／Chrome 155.0.8059.82，在 `f734245a` 加当前未提交源码上，用隔离夹具加载实际 SessionPage、Sidebar 与 Native 编译样式，Windows／macOS CSS 标记下亮暗、Mica／Vibrancy／实色、窄侧栏、选中导航与设置分类选择器共14组对照：悬停／按下底色不一致的采样由64处降为0。键盘按下空间标题只绘制一层背景，焦点提示、透明承载层、草稿和主区普通按钮的原按下反馈保持；页面无异常，定向 CSS Biome 与文档检查通过。设置页仅核选择器夹具，未复验真实 Service、Electron 实窗或系统材质最终合成。

[Native 页面](src/native.tsx)对当前可用目录中未删除的普通根会话，在点击时即用目录的 Store／Session 身份更新 SessionPage 的标题、选中项与 `readingKey`，让页面缓存先恢复原 DOM；后台 `select`、模型控件准备与完整历史校准继续独立完成。尚无目标缓存时只传空消息和 loading，不把旧消息装入新树。真实 `selection` 仍独立控制所有读取与写入；子会话和不可用目录不走提前展示。首条投递占位只在原目标保留，切走后不能覆盖新目标。没有显式切换目标的初始已选会话、同会话刷新及原晚到响应守卫保持。回归归[新对话与导航 DOM 测试](test/isolated/native-new-conversation-dom.test.tsx)与[历史展示 DOM](test/isolated/native-history-presentation-dom.test.tsx)。

2026-10-19 Windows x64／Bun 1.4.3，在 `f734245a` 加当前未提交源码上：选中高亮回归先复现延迟选择响应时旧行仍带 `aria-current="page"`，修后核初始已选会话、会话／全局及项目准备入口、缺选择的 Main 发布、目标确认与晚到响应。新对话、会话导航及共享页面三个整文件44项／981断言，Desktop typecheck、定向 Biome 和文档检查通过。Chrome 155.0.8059.82 隔离实际 Native renderer 沿既有模拟桥，亮暗下三种入口及键盘共8组逐帧核对，修前8组误选旧行，修后为0；两种准备入口的4组旧行背景 alpha 全程为0，同目标刷新保留高亮。未改共享 hover 配色、会话选择请求或写入门禁；未复验真实 Service 或 Electron 实窗。

Mica／Vibrancy 的背景明度与壁纸合成继续由系统材质管理，承载层保持透明，不为每个按钮重复添加模糊或读取壁纸。半透明交互层只控制组件的叠色；完全透明且明暗不受约束的底图无法仅靠一种 hover 色保证对比度。此边界也符合[系统材质的可读性说明](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic#legibility-considerations)。

2026-10-19，基于 `f734245a` 和当时未提交源码的中性交互调整：Windows／Chrome 155.0.8059.82 隔离夹具加载实际 SessionPage、共享控件与当前 Native 编译样式，Windows／macOS CSS 标记下亮暗主题各4种模拟材质底色，以及540px侧栏共18种状态通过。普通按钮、空间／会话／导航／用户行、移出页面树的菜单核同一 hover，选中悬停与按下强度分开；禁用背景、键盘焦点、透明承载层、正文及草稿保持。另8种模拟底色的截图像素符合黑5%／白7%叠色，样本导航文字对比度最低约6.08:1；实际 NativeWindowFrame 与设置选择器夹具的亮暗2种状态核顶栏开合、设置返回／分类、提供商与目录按钮、选中悬停、禁用和实色保存按钮。三份 CSS 的 Biome、文档结构与影响检查通过。本轮未运行真实 Service、Electron 壁纸最终合成或其他平台实窗，模拟材质结果不构成任意壁纸可读性保证。

## 统一桌面圆角

Native 统一消费[共享 UI 的圆角变量](../../packages/ui/README.md#原桌面展示层)：普通按钮和菜单项为8px，字段与弹出层为16px，提示词输入框内部按钮为胶囊形。[设置／Mica 样式](src/native-tailwind.css)与[提供商表单](src/native-provider-settings.css)分别按用途引用 `--button-radius`、`--input-radius` 和 `--radius`；[正文排版](src/native-typeset.css)继续消费表面圆角。macOS 主内容与设置内容另按上文采用直角；Tailwind 尺寸别名、圆形及拼接直角的范围归 UI owner。现有 Mica 透明层、6px留白、设置覆盖与业务交互保持。

2026-10-23，Windows x64／Bun1.4.3／Chrome155.0.8059.85，基于 `de498789b` 的当前圆角与输入区 diff：实际共享组件与生产编译 CSS 在深浅两套组件画廊及1280／390px四组会话中核对按钮、字段、主／子菜单、Tooltip、Dialog 和 Sheet。提示词选择器为13px文字、14px图标、28px高度与上下4px／左右6px内边距，附件／发送图标保持16px；宽屏左右两组中心一致，窄屏换行后各组仍居中，无横向溢出。观察圆环提示的悬停与键盘聚焦、复制反馈、模型选择、权限和附件菜单的展开与关闭，以及弹窗归焦，草稿与消息保持；14px状态圆环为独立SVG，鼠标、Enter与Space均未提交任务，无页面异常。四个相关原文件22项／198断言、UI／Desktop类型检查及定向Biome通过。夹具使用模拟回调，不读取用户数据；未重验完整安装版Electron，保留既有嵌套 `@keyframes` 编译提示。

2026-10-14 同环境、基于 `006b79d3` 的当前圆角 diff：隔离普通 Native 构建和真实 Service，由实际空间选择入口登记测试目录（仅控制系统选择框回调）。亮／暗实际 computed style 核空间列表、主面板、Composer、建议按钮、项目选择、用户菜单及菜单项、设置内容、卡片、选择框与导航按钮均为10px；临时将根变量改为14px后全部随之改变，随后恢复10px。顶栏、设置分类栏与返回区保透明；500px窄窗口仍为同一圆角，返回与Escape保原输入实例和未发送草稿，圆形发送按钮与全屏直角保持。截图核布局，零页面异常、Main退出0通过。Desktop／UI typecheck、三份 CSS 的 Biome 和 diff 检查通过（保留原三项 `!important` 提示）；构建保原 keyframes 优化与大chunk提示。仅核本轮桌面外观，未运行完整默认测试或其他平台／安装制品验证，不将先前完整状态矩阵作为本轮重跑结果。

2026-10-19，基于 `f734245a` 和当时未提交源码的16px调整：Windows／Chrome 155.0.8059.82 隔离夹具用实际 `SessionPage`、共享控件及 Native 编译样式核对1600／1000／540px亮暗共6种状态。面板、空间与会话行、输入框、环境卡、正文代码／引用／表格、菜单及弹窗随根变量由10px变为16px；发送按钮保留圆形，右栏拼接边和 macOS 主内容保留直角。前后布局尺寸与草稿相同，页面无异常；定向 CSS 和文档检查通过。本轮未重跑 Electron 实窗或平台发行资格。

## 玻璃导航间距

[Native 玻璃样式](src/native-tailwind.css)在 macOS 宽窗口的 `#navigation .client-sidebar-panel` 左侧加入 `--native-panel-inset + --resize-handle-width` 留白，补偿1px调宽占位；macOS 的内容留白为0。Windows 宽、窄侧栏均取消这份外层补偿，采用上述6px列表内边距，用户区负 margin 将分隔线展开到容器左右边界；Mica 主面板的展开与实时收起边距按[上述样式规则](#windows-原生-mica)处理。共享分隔宽度的定义归 [UI owner](../../packages/ui/README.md#原桌面展示层)，原200～420px调宽范围保持。共享 Web、macOS 的列表内边距及未确认材质时的主面板布局保持。

2026-10-16 Windows x64 的隔离 Chrome headless 页面加载实际 SessionPage 与 Native／共享 CSS：200px侧栏展开时，分隔线止于x=200，正文从x=201开始，只保留1px分隔条。前轮验证只核鼠标释放后的收起布局；补测发现按住拖到0时，旧 `.sidebar-visible` 仍为true、主面板左边距仍为0。改用实时ARIA后，亮暗主题下实际 `buttons=1` 的收起／反向展开／再次收起均通过：收起时主面板左右6px、分隔条0px，展开时主面板贴齐1px分隔条；拖动中偏好写入0次，松开到展开宽度后才保存1次。按钮／键盘收起、窄窗口浮层开关／Escape、截图和零页面异常通过。此前宽窄切换验证与本轮区分，不把旧鼠标释放后结果当作持续按住证据。此验证只覆盖renderer布局和交互，未启动真实Main／Service或验证原生Mica合成。

2026-10-14 Windows 11 x64 build26300／Electron 44.3.0／Bun 1.4.2，基于 `006b79d3` 的本轮 CSS diff：隔离普通 Native 构建与真实 Service，修前实际常用入口／空间行左右为12px／19px，分隔1px加内容留白6px确为差值；修后两侧均为19px，header两侧23px、用户区15px、底部分隔线7px。亮／暗、200px起始宽度、键盘左右调宽、鼠标拖到420px及收展后均保持等距；500px窄窗口两侧仍12px，取消Mica标记的普通布局不加补偿。设置返回与窄侧栏Escape保未发送草稿；截图核布局、零页面异常、Main退出0通过。两份 CSS Biome与diff检查通过，保原三项 `!important` 提示和构建提示；未改TypeScript，前轮Desktop／UI typecheck范围可复用。未运行完整默认、其他平台或正式安装验证。

## 原窗口关闭与退出收尾

配套launcher本身的普通close仍等待Service真实drain／退出；Native明确退出按用户2026-11-06最新要求单独设置4秒清理截止，使主进程在5秒内结束。Main菜单明确退出、信号和开发父连接EOF／error／close共用同一个停止owner。明确退出直接同步隐藏窗口、退休应用确认和托盘，macOS同时隐藏应用与Dock，不读取活动任务、不等待Service状态、不显示确认或失败Toast。普通关窗继续只隐藏，可激活恢复；明确退出后的activate、ready-to-show和迟到启动／重载不能重开界面。取舍见[明确退出与后台清理决定](../../.agents/notes/implemented/bug-fix/2026-10-22-single-confirmation-exit.md)。

停止Promise在退休界面前取得唯一owner，全局窗口引用清空后仍在局部保留准确原窗口与页面。正常清理时Service沿原lease的revoke／release及真实exited完成后才destroy窗口，避免把页面提前销毁引起的stale当作释放成功；意外销毁仍保unknown。在途启动和重载也受同一4秒退出截止约束，截止前交回原owner关闭；已移除仅供可取消确认使用的决定Promise和交接屏障。界面退休异常不能阻止其他退休动作或留住已明确退出的应用；失败回收仍只触及Main直接创建的准确配对child。

开始退出通过原固定event channel发送quitting，renderer撤销旧state、目录、选择与私有草稿读取的展示归属并暂停自动刷新；不重新attach、写草稿或重发任务。开发Service切换自己的quitting／active通知保持，明确退出不再有取消恢复分支。真实执行失败和未知效果保留在所属持久记录；全局Toast不为隔离诊断读取新增提示。

[settleDesktopQuit](electron/quit-settlement.ts)核唯一清理Promise与4秒期限，清理完成返回clean，抛错、拒绝或超时返回force；正常结束会退休计时，迟到结果不能二次退出。截止从停止入口开始，不受启动、重载或Service响应阻挡。Main按原顺序关闭caller、私有数据／使用权与配对Service，另核实际Service退出为零后才释放制品使用权；launcher.close返回不代证正常退出。成功后app.exit(0)，失败或到期沿准确所属child句柄回收并app.exit(1)，不扫描其他进程、不把界面隐藏视作清理成功。重复退出不增加清理、确认或提示。

Service 完成原 Runtime、HTTP 资源、正文流及 Store 收尾后，最后结束残留传输连接，避免已完成但客户端未消费的响应耗尽 Main 的4秒清理窗口。Main 仍等待准确 Service 的真实退出，页面通道继续保留至原资源释放；没有提前关闭页面、延长截止或改写 unknown。关闭边界及背压回归归 [Service owner](../service/README.md)，实际普通构建验证另按对应批次记录。

2026-11-07 本机 macOS arm64／Bun1.4.4 的三模式真实 Luna 工具验收曾在全部业务资源已结算后复现该等待；原4秒强退与诊断副本失败保留。修复后从当前耐久源码重建普通 `testDiagnostics:false` 制品，逐步观察原历史加载和恢复，正常退出 Main48ms／exit0、精确 Service kqueue exit0、捕获子树全结束；原6个 Run／87个 Execution／58个 Command／2个 Interaction完整行、效果与 Browser事实摘要不变，零新Model／Tool／答案／Browser动作。原生命周期13项／100断言、配对退出5项／85断言及退出／既有工具夹具9项／69断言通过。该无模型冷读补验不扩大真实业务或跨平台发行资格，原证据和范围归[模型验证 owner](../../tests/e2e/live/model/README.md#2026-11-07-luna-工具与权限联验)。

[Main有限宿主回归](test/isolated/native-main-scheduling-lifecycle.test.ts)最终38项／433断言通过，4项Windows专用用例在本机跳过，覆盖同步隐藏、零状态检查／对话框、重复退出、启动／重载受同一期限约束、展示异常及超时后迟到结果不能二次退出。[退出结算](test/quit-settlement.test.ts)6项／21断言通过，核4秒截止、提前结束退役计时和异常收尾。NativeCaller实现未变，复用同轮完整文件54项／598断言；旧退出检查辅助与测试已删除。Desktop类型、定向Biome、边界、测试归属和文档门禁通过；计划审核driver及其父例只同步退出断言，未重跑无关模型业务。

2026-11-06，macOS arm64／Bun1.4.4，使用经锁定校验和核对的缓存官方Electron44.3.0，私有重建当前Main／renderer普通候选（诊断关闭），仅运行现有[专门退出driver](test/native-quit-electron.fixture.ts)，保持45秒总预算。最终driver code0、stderr为空；五份关键源码与driver前后SHA相同。原Service被SIGSTOP后不再恢复，退出同步回读窗口／Dock不可见且零确认；0、1、2.5秒重复quit／activate不复活，截止前原Service及双锁仍在。Main在4053ms退出1，4055ms时准确Main、Service及四个Electron helper／renderer PID全部消失，outer／inner双锁释放。普通退出样本254ms已请求准确Service stdin EOF，但Service未在期限内完成，4046ms退出1、4048ms全部PID和双锁结束，明确记录cleanupConfirmed=false；这证明五秒结束，不授予实机clean0资格。预先SIGKILL Service场景同样同步隐藏、快速exit1并在预算内释放PID和锁。实际控制端记录unexpectedRequests为空，收尾核对无本次候选遗留进程。候选digest为`630e49a27c4afe995ec75f743df91c2bfe67e81a85ba5fcddbcf7324e19cb8f8`，原始阶段、构建、源码核对和前两次普通样本必须clean0的错误测试预期保留在本机`.cache/toast-20261106/quit-deadline-real-*`及`quit-deadline-real-1793970354693/result-final.json`。旧20.5秒方案记录保留为历史，不再代表当前合同。本轮未修改用户安装或原应用，未扩大Windows／Linux实机、活动工具完整后代树或完整发布资格。

既有整窗口结果属于此前固定制品，退出确认和立即destroy顺序都不是当前行为。2026-10-29浏览器007实际退出复现：窗口及原页先销毁，Service随后revoke／release报stale，监管保unknown，正常退出未确认，最终由隔离夹具120秒后强杀；原记录不改写。该轮Main改为先hide、准确release／exited后destroy；当时的真实退出driver只同步断言、尚未新启。真实Main模块／BrowserPageHost／DesktopTransport的agent与human顺序先红后绿，意外destroy仍unknown；完整生命周期32通过、3项Windows专用跳过、387断言，退出结算5项18断言及Desktop类型通过。上述历史证据不授予新候选真实退出资格；本轮结果按本节当前验证记录核对。

新对话的 Git 查询／首次明确分支切换和默认编辑器入口现共用 Caller 所属的 [NativeProcessOwner](electron/native-processes.ts)。明确退出后，Caller 在首次 await 前封闭 helper 新准入，对仍属自己的原 ChildProcess 句柄请求停止，并等待实际 close；Main 继续在 Caller 完成之后释放私有数据／Profile 和制品使用权。Git 每次串行启动都重新经过该 owner，只读分支读取也纳入 Conversation 收尾。超时或启动错误保存首次失败，不能在仅发出 kill 后返回或被迟到的零退出覆盖；信号失败或close未到时界面已关闭，Main在本次四秒期限内等待原资源结算，超时强退不补写成功。普通窗口隐藏不关闭该owner。范围仅为这些直接 helper，`/usr/bin/open` 后交给系统的编辑器应用仍属于 external，不构成全 Runtime 后代树证明。原十五秒 Git deadline、stdout／stderr 各1 MiB、严格 UTF-8 和编辑器十秒期限保持；期限确定超时结果，实际 close 才结束调用。默认 IPC 沿 `NativeCaller.openEditor` 登记所属 launcher；可信测试 opener 不进入生产 Main 装配。取舍见[Main helper 收束决定](../../.agents/notes/implemented/bug-fix/2026-10-10-native-main-helper-shutdown.md)。

[所属进程整例](test/isolated/native-processes.test.ts)和[实际 Node driver](test/native-processes-node.fixture.ts)核原 handle／双 EOF、首错与 Caller 收束；原首次发送真实 Git、文件目标／frame和上述完整窗口各核原范围。替代编辑器 executable 的夹具不操作个人应用，也不证明 OS 编辑器窗口已打开；准确执行归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10native-普通用户操作的所属-helper-收尾)。

## 会话标签页与内置浏览器

会话 header 的“标签页”图标打开[共享 SessionTabs](../../packages/ui/src/desktop/SessionTabs.tsx)，默认新标签页，工具区以卡片网格展示“变更”和“执行轨迹”。关闭最后一个网页、变更或子详情标签会沿原收起逻辑关闭右侧栏并返回顶栏按钮，再次打开显示新的空白页。旧直接“文件变更”按钮移除；原调宽、折叠、主题与无下边框 header 保留。标签模型在响应式 Group 之外，侧栏收起与窗口缩放不销毁网页；明确关闭网页或退出 Main 才销毁相应 WebContents；换阅读 scope、页面卸载及 Root renderer 导航／崩溃只退休展示，重建后先按 Main 清单恢复准确 ID 的原页。Main 重启不宣称原文档存活。工具与子详情 reader 仅在当前可见标签挂载，覆盖／切换／收起会释放读取。环境卡打开子 Agent 时选择原 Session／Execution 的详情标签，重复打开复用原项；全部标签共享8项上限。每次明确点击的单调请求 ID 只消费一次，等待实际阅读 scope 就绪后才打开；切会话、临时选择状态或返回原父会话不重放旧导航，不据此关闭当前任务面板。主会话始终保持显示与自身读取，子详情的准确目标、正文与操作门禁见[环境与子详情 owner](#native-当前会话环境信息与子详情)。

[renderer adapter](src/native-browser-pane.tsx)通过[封闭浏览器 port](src/native-browser-bridge.ts)发送导航与可见 viewport，preload 只交付有限操作与有界显示 metadata。[Main controller](electron/native-browser.ts)复用当前主窗口、准确 mainFrame 和 renderer URL 的 sender 校验，校验地址后才分配最多8个 WebContentsView。顶层导航只支持 HTTP／HTTPS；网页的 WebSocket 子资源可使用无凭据的 ws／wss，不开放对应的顶层或子框架导航。纯文本交 Bing 搜索，localhost 默认 HTTP，普通域名默认 HTTPS。地址栏聚焦编辑期间保留输入，失焦后同步最后确认的页面地址，包含重定向结果。历史操作使用 Electron navigationHistory；网页弹窗的 HTTP 链接在当前标签打开，下载与外部协议拒绝并保留必要错误。

网页使用独立非持久 session，无应用 preload，sandbox／contextIsolation／webSecurity 开启，Node、webview、DevTools 和权限申请关闭。网页不共享应用 Cookie 或 Service port；手动网页本身不开放通用执行端口；当前普通页的受控 Agent 接入归[统一浏览器入口](#统一浏览器入口候选2026-10-28)，导入、扩展、下载和跨 Main 重启的持久标签／文档不由该手动入口提供。renderer 依据活动标签、窗口可见性、覆盖层和实际几何隐藏／定位 native view，网页 viewport 先与所属 ResizablePanel 的实际边界取交集，并观察该面板尺寸使原生网页随宽度动画逐帧裁切；完全折叠或收起结束后不保留可绘制内容。Main 再按 root zoom 和内容边界夹紧；Root 重载隐藏原页，Main 退出才清理网页，Cookie 只留内存。取舍见[浏览器隔离决定](../../.agents/notes/implemented/architecture/2026-10-20-sidebar-browser-isolation.md)，产品操作归[桌面手册](../../docs/handbook/clients/desktop/README.md)。Main／preload 更新需要完全退出并重启。

[地址与 port 测试](test/native-browser-bridge.test.ts)、[共享 UI 生命周期](../../packages/ui/test/isolated/desktop-session-tabs.test.tsx)、[地址同步与面板裁切 DOM](test/isolated/native-browser-pane-dom.test.tsx)、[网络策略回归](test/isolated/native-browser-network.test.ts)、[原文件 reader DOM](test/isolated/native-file-changes-dom.test.tsx)分别核有限输入、标签资源、实际面板裁切与原文件读取合同。[隔离 Electron](test/isolated/native-browser.test.ts)使用真实 Main controller／preload／SessionPage 及 loopback 页面，测试专用入口只在 test fixture，普通构建诊断常量仍为 false。实际执行结果与平台限制在本节验证记录维护。

2026-10-20 Windows x64／Bun 1.4.3／Electron 44.3.0／Node 24.15.0，在 `5dba8a6b` 工作树既有输入加本轮 diff 上执行：`bun test --parallel=1 --max-concurrency=1 packages/ui/test/desktop-page.test.tsx packages/ui/test/isolated/desktop-sidebar.test.tsx packages/ui/test/isolated/desktop-session-tabs.test.tsx apps/desktop/test/native-browser-bridge.test.ts apps/desktop/test/native-file-changes.test.ts apps/desktop/test/isolated/native-file-changes-dom.test.tsx` 的对应分组共33项／419断言通过；上述隔离 Electron 命令另通过1项及实际窗口断言，核真实前进／后退／刷新、独立 Cookie、无应用／Node接口、外来 frame 拒绝、同标签弹窗、下载拒绝、宽窄保留和关闭／换会话销毁。亮暗新标签页截图核标签条、地址栏、工具留白和无 header 下边框；UI／Desktop typecheck、定向 Biome、文档和边界检查通过。窗口隐藏运行，不代证原生网页与系统材质合成、外部站点兼容、macOS／Linux 或安装制品；未调用模型。Tailwind 对既有嵌套 keyframes 的优化 warning 保留，普通客户端未增加测试入口。

## Agent 浏览器观察与人工操作

2026-10-27，macOS27.0.1／arm64、Electron44.3.0、Chrome156.0.8078.48：独立可见Electron制品使用实际NativeDesktop／preload／IPC／NativeCaller和真实Service／SQLite，renderer保持sandbox=true、contextIsolation=true、nodeIntegration=false。UI私有数据使用测试夹具的Node SQLite内存端口，运行／模型／浏览器结果保存在真实Core；不是正式安装版或普通用户Profile验收。客户端实际目录核所选route enabled／configured，API model=`gpt-6-luna`；沿原createCodexLocalSource只读采用本机ChatGPT登录，没有复制认证文件、重登或新API key。

客户端输入本地页面自然语言任务后，第一成功轮由模型自主执行10个浏览器Tool；最终窗口轮10次真实模型请求、9个浏览器Tool全部成功，实际填写 `Kite Luna real value`、点击一次后显示 `Clicked once`，下滚500再回顶并给出最终回复。A在真实慢导航期间切B，保持B至原Run完成；回A后明确重开只读观察面板，核同一browserId及generation、仅一个Browser Job和一次目标导航，没有重发。实际窗口再核接管、选择元素、备注连同原有草稿保留且未发送、交还及显式关闭；四个人工Action成功，原Job取消且报告完整树清理，Service正常关闭后私有会话目录为空。等待原命令核实的短暂pending提示沿原查询路径处理，不重复提交；最后截图包含关闭后的中间显示，最终Core回执另行核对。截图仅留本机内部检查。

此前真实模型曾把未知generation猜为数字，并对改参数后的读取复用key；安全校验分别拒绝为stale target和intent conflict。仅补清Tool参数说明：首次snapshot省略未知generation，不猜值；不同读取／改变参数用独立意图key，未知网站操作仍不得换key重试。Tool／协议版本与执行校验未变。早期夹具的Bun SQLite／模块格式、缺Artifact store、目录显示名筛选及旧测试标记问题均保留失败记录，未计为真实模型通过。原资产启动及共享MCP间歇失败边界归[Browser owner](../../packages/agent/src/tools/browser/README.md)。

以上真实窗口／模型结果发生在后续Darwin owner控制校验加严和共享broker内层EOF修正之前。截至v1审查包时新启动被自动审批拒绝；随后用户明确允许的单实例最终native闭环通过，当时尚未重新运行真实窗口／模型A-B路径，后续05:53轮另记如下。原未知实例与目录继续保留，不能由此前窗口成功授予最终控制实现完整资格。父死亡测试仅核一次父链快照中的已观察成员，不是独立全coalition终态枚举。

2026-10-27 05:53 UTC另按后续明确授权，以同一v1源码和重新构建guardian进行一个新受限真实Native窗口／gpt-6-luna后台轮。A慢导航在途时05:53:33.830选B，并在61次aria-current采样中一直保持B，至Run于05:53:49.907 completed、05:53:50.031在B观察确认。切换后模型新发fill、click、down/up scroll和最终snapshot共5个Tool，全成功；服务端独立记录填写值、一次点击、scrollY500→0，页面初始及慢导航各一次，一个Browser Job／owner，无后台取消或重启。最终回复含KITE_FINAL_BACKGROUND_DONE。

同轮切换前一次snapshot使用browser_id及generation=??，被invalid_tool_arguments在派发前拒绝，模型正确修正后读取成功。driver把“全轮每个Tool都成功”作为总断言，因该已知失败退出1，未执行回A辅助画面或UI结束按钮；不将整脚本称为通过。只读独立校验确认用户要求的后台新动作／真实页面效果／任务完成主条件。随后Service正常关闭沿准确原Job取得cancel stopped、terminal supervision=ended及dispose；冷Job回执确认owned process-tree cleanup，17个采样身份absent、准确label113、目录为空，旧unknown未动。没有为补辅助步骤重开或重发模型。

这是独立于上节手动网页标签的受管浏览器观察面板，不接管 WebContentsView，也不添加另一套 Agent Loop。产品操作见[桌面手册](../../docs/handbook/clients/desktop/README.md#agent-浏览器)，能力装配与真实资源分别由 [Service](../service/README.md#受管-browser-默认装配)和 [Agent Browser](../../packages/agent/src/tools/browser/README.md)负责。当前 Linux PID namespace 与 macOS launchd coalition 监督适配已实现；macOS本轮真实Host／Runtime范围见[Browser owner](../../packages/agent/src/tools/browser/README.md)，Linux真实Chrome与正式安装制品仍未取得资格，Windows明确不可用。

[Native 主页面](src/native.tsx)在普通主会话提供“Agent 浏览器”入口，不受测试诊断开关控制。[自动呈现](src/agent-browser-presentation.ts)只接受当前已核实 Store／Session 内 `browser.session@1` 的 dispatching／running Job，排除 child、foreign、取消中和未完成选择的记录。每个准确 Job 在当前 renderer 生命周期内最多自动打开一次；用户关闭面板不因同一记录重读而重新打开。换会话、准备新会话或进入定时任务收起面板，不改变浏览器 Job。

[Observer](src/agent-browser-observer.ts)沿原 Main Extension 读取身份调用 `browser.view`，只持一份最新帧；隐藏、设置覆盖、不可见或卸载时释放观察句柄并撤销旧操作资格。[View decoder](src/agent-browser-view.ts)核 envelope、generation／seq、帧和选取引用；页面内容不能提供新的读取或执行权。人工 handoff／resume／input／select／close 仍走原 Action 和持久 Command，未知只查原 commandId；原提交跨面板重开继续查询，不重发输入。主进程和公开 HTTP 协议未增加浏览器专用旁路。

[Panel](src/agent-browser-panel.tsx)通过 `SessionPage.workspaceTab` 进入现有 `SessionTabs` model／标签条，与普通网页、变更和子会话共享8个位置，没有独立详情壳、重复标题或新增放大按钮。所有tab变更在model最新状态即时保留名额，同一commit内workspace／child请求不能各用一份旧容量。首次请求将原可拖动分栏调到62%内容宽度；含Agent标签时可在240px最小宽度和85%上限内调宽，普通信息rail沿原边界。切tab、收起保留组件、注释历史帧及尚未加入卡片的备注，只把 `visible=false` 传给Observer；More浮层同步关闭，网页Job生命周期不归Tabs。指向模式的document Escape监听仅在可见时注册，处理时再核当前visible，后台tab不消费前台键盘；返回后可继续备注，可见时Esc仍退出并丢弃尚未加入的备注。明确打开请求按scope／requestId去重并选中现有标签；新准确Job可重新呈现，关闭后同一Job不反复打开。换会话沿原scope清标签，关闭Agent标签只结束观察，不派发browser.close。

一行42px工具条只显示指向、按状态接管／交还、地址与More。窄栏收起按钮文字，保持可访问名称和title，不把地址挤到下一排；结束浏览器、人工元素选择／填写／点击和滚动归More，沿原Action权限与当前身份验证。状态／必要错误保留，常态不另占标题／说明行；画面保持原比例，备注与历史提示浮在图内。

2026-10-27，本轮同一macOS隔离静态Native窗口核对：实际同一标签栏、42px单行工具／地址、拖动后宽度保留、切tab关闭More但保留画面组件、注释卡与A/B草稿、820px窄栏不换行及按实际图片命中。24项逐文件DOM测试／356断言（含隐藏tab Esc负例修复复验）、UI／Desktop类型和生产Vite夹具构建通过；这是受控Main bridge／静态像素验证；Esc修正后复用未变布局的原截图，新增键盘行为只由DOM回归核实，没有新增窗口、真实Chrome owner或模型请求，不扩大此前Runtime／后台模型完成资格。

地址栏沿已有 `browser.input` navigate／Main Extension／原Command通道，不增加公共能力。仅新鲜human代次可提交，不隐式handoff；HTTP／HTTPS且无内嵌账户的URL在面板与原后端各校验一次。编辑期间不被新网址覆盖，Esc取消、IME确认不导航；同一Observer的同步in-flight／pending锁去重，unknown仍查原申请。输入绑定scope／browserId／generation，冻结注释时不接受导航；页面变化后仍由最新View呈现结果／失败。

[Panel](src/agent-browser-panel.tsx)的“指向元素”在已验证且成功解码的画面上冻结一帧，按实际图片矩形换算坐标；重叠区域选择面积最小的既有 annotation。hover／选取只画一个蓝框，不派发 Action、不暂停或接管 Agent，Esc 或退出指向回到最新画面；导航、滚动和缩放不会把冻结引用改绑到新帧。画面更新时明确显示历史状态，换 Session／scope 清掉 picker。只能命中当前 backend 提供的 annotations，不能任意拾取 DOM／div。agent-browser 0.39.4 的编号已烘焙进 JPEG，CSS 不能隐藏；面板不再重复叠加常驻编号。“暂停并接管”后的页面元素选择仍用原 browser.select，实际点击、填写、滚动和导航只走明确按钮及原身份校验，不能把注释引用当作当前操作许可。普通填写值进入耐久会话记录，面板不支持密码、验证码或其他凭据。

[注释 owner](src/browser-annotation-drafts.ts)按 Store／Session 保存冻结来源、元素与用户说明；[卡片](src/browser-annotation-cards.tsx)在 Composer 的 context 插槽中显示数量、原帧缩略图、元素标签和说明，支持编辑／删除，编辑器仍仅显示原 prompt。每 Session 最多4条、窗口最多16条，每份 JPEG最多96 KiB；同帧像素首次准备后由原 NativeInputImages 的 begin／append／finish／publish 保管，编辑说明只更新版本，不重传或重哈希像素。普通图片排在前面，注释截图按卡片顺序随后，总数仍最多10张。删除、确认消费和窗口收束释放原 prepared image；没有伪造磁盘路径或 file attachment。私有草稿只存 metadata，不含 Base64、临时 prepared ID 或无限截图历史。500ms静默后串行 CAS 只保存小元数据；保存结果未知不盲重写。冷重开恢复文字卡片但标“快照未恢复”，不能发送，需删除后重新选取；同窗口换会话保留原像素。

[共享纯合成函数](src/browser-annotation-content.ts)冻结实际出站 content：完整 prompt、注释全文、来源、历史语义和图片序号／hash，像素沿原 images 进入同一消息。普通 files 只自动附引用，不能代替首请求的注释文字。Native 私有 drafts.content兼容旧 JSON string 与闭合 annotation envelope，不新增 Core 表或公开协议字段；旧换行／hash语义保留。Main 的 [CallerJournal](electron/caller-journal.ts)从保存结构重算 proof并校验图片顺序、hash、mediaType／size，[PrivateData](electron/private-data.ts)在原受理事务按相同投影消费。notes-only也可提交；失败保留，unknown按原commandId核实且不重复发送，受理只清准确注释版本，新 prompt／新卡片不被旧回执清掉。草稿文本与图片的信任边界见[输入区 owner](#markdown-与附件输入)。Tool、Extension和HTTP协议版本未变。

[Observer 回归](test/agent-browser-observer.test.ts)、[View 回归](test/agent-browser-view.test.ts)和[呈现回归](test/agent-browser-presentation.test.ts)核读身份、未知结果、换代、引用与自动打开；[面板 DOM](test/isolated/agent-browser-dom.test.tsx)、[自动呈现 DOM](test/isolated/agent-browser-native-dom.test.tsx)和[实际 Native 页面](test/isolated/native-read-ownership-dom.test.tsx)核冻结选择、Agent不中断、原正文、卡片、跨会话、失败／unknown和notes-only发送；[注释 owner](test/isolated/browser-annotation-drafts.test.ts)核数量／字节限制、冷恢复与消费版本，[ModelInput／Provider](test/isolated/browser-annotation-input.test.ts)核首请求文字＋原像素及运行中 steer，无预先 read_file。[Node 私有文件](test/isolated/private-data.test.ts)沿真实SQLite核metadata冷恢复、CAS、notes-only、unknown保留与旧回执保护新编辑。UI验证使用静态帧／本地模拟Provider和独立Electron，不授予新浏览器、真实模型或安装制品资格；上文最终v1真实后台轮是本次UI修改前的独立检查点。

2026-10-27在上述macOS隔离工作树（基准982db30e加本轮未提交UI diff）实跑：16个相关文件按独立进程合计94项／897个Bun断言通过，真实Node私有SQLite／原Caller恢复另7项／162断言通过；Desktop与UI类型、定向Biome、API／边界／测试归属、文档检查通过。同进程直接组合16文件曾88通过／5失败，保留日志，不将该组合称绿。新增ModelInput／SDK测试由本地模拟transport记录实际请求格式，首请求与运行中steer均包含原文、完整说明和原JPEG，无read_file；不代表再次调用真实Luna。隔离Electron44.3.0加载真实Native renderer／样式及原preload，Main为静态无凭据测试端口；逐步核hover、选取、就地备注、卡片编辑、切B隔离、回A保留、820px卡片布局无横向溢出、深浅主题与删除。像素仅留本机；初次夹具executable未找到、会话读取前过早断言及构建原keyframes warning均保留。本轮没有新Browser owner／模型请求，旧unknown和先前v1资格边界不变。

Cookie导入仍未实现，也没有假可用菜单。本轮未读取、解密或复制任何浏览器Cookie、密码或Profile。后续需先明确来源、站点范围和目标浏览器，单次明确授权后仅把选中Cookie交给准确owner，原值不进模型、提示词或日志；手动网页标签与Agent浏览器不能互相默认继承。单独方案见[Cookie导入提案](../../.agents/notes/proposed/feature/2026-10-27-browser-cookie-import.md)。

## 原文件变更面板与编辑器

2026-11-09，按用户确认的参考图规则，变更标签在原可拖动分栏内采用紧凑编辑器与右侧目录树，不新增窗口或执行权。首次打开按62%准备宽度，之后保留用户拖动，最多85%；窄栏改为上下布局，文件树仍可访问。目录树可筛选、折叠和键盘导航，每页固定50个节点而非累积挂载，最多1000条文件元数据、2048个目录节点与24层目录；超出目录／深度预算时保留全部已准入文件，以剩余相对路径简化展示并提示，不改变不透明观察ID。每次只保留选中文件正文；选中、过滤排除、关闭和scope变化撤旧reader，迟到结果不能替代新正文。刷新后只按重新核准的同路径恢复选择意图，跨会话不复用；布局选择可跨同视图文件与刷新保留；筛选值跨同scope手动刷新、窗口聚焦和消息更新保留，刷新后不再匹配的选择立即关闭。不同scope重置，不缓存多份正文。

共享diff以双栏／统一方式呈现真实保留内容及原行号，操作记录与HEAD工作区的列标题明确不同。已保留上下文可以折叠，后端省略内容不可展开；计数仅是预览，仓库树没有未经读取的完整增删总数。语法色使用有限同步词法标记，不加载语法库或网络资源；具体字节、行、单行与token上限归[UI owner](../../packages/ui/README.md#文件差异的按需与有界显示)。详情切换不从当前文件重建历史，不改文件工具、审批、Git写入或编辑器授权。

[NativeOperationDiff](src/native-file-changes.tsx)通过共享 [ToolActivity](../../packages/ui/src/desktop/ToolActivity.tsx) 的 `renderFileChange` 懒读槽接到会话中已核实成功的 write/edit 工具行；独立箭头展开本次操作，文件名仍打开当前文件。元数据由原32项扫描取得，不为折叠的历史预读正文。Main `fileChanges.detail` 的 `view:diff` 只返回原 `fileChange`，`view:snapshot` 单独读取历史全文；两者同在时不再由 snapshot 盖过 diff。旧调用未传 view 仍保留原读取顺序。完整 Artifact 超过1 MiB时不整份读取，只返回明确不可展示原因；原完整快照与写入不变。关闭／换scope只释放阅读，失败／unknown不取得成功差异。共享 [FileDiff](../../packages/ui/src/desktop/FileChanges.tsx)另限制旧结果的正文字符数、400个DOM行和每行2048个UTF-16单元，保原ScrollArea、键盘与红绿语义。

右侧“变更”由[NativeWorkspaceChanges](src/native-workspace-changes.tsx)和[Main Git reader](electron/workspace-changes.ts)独立负责整个仓库当前工作区相对HEAD的状态，不再把历史工具操作列表当作仓库总变更，也不将用户或Shell修改归因Agent。Main只从当前登记Workspace沿实际Git根取得路径；renderer传作用域和观察ID，不传任意路径。暂存区和工作区状态独立保留，HEAD到最终工作区差异抵消仍列出状态；无HEAD时按空树处理新增。仓库根覆盖受保护目录、根或父目录漂移、不支持的链接／子模块／冲突明确拒绝或省略。状态和差异命令使用Main私有临时Git目录、固定配置和HEAD、最多16 MiB的索引副本，并只读引用原对象库；不载入原仓库的可执行过滤器配置，禁用外部diff/textconv、hooks、fsmonitor与自动网络取回，源仓库无Git写入，每条命令10秒期限。原clean/process过滤器（含用户配置）、非空info／全局attributes、分离索引或过大索引明确不支持，不把未能读取当作干净仓库；worktree的.gitattributes继续作为数据使用，info／全局忽略规则只作有界副本。子模块内部不递归读取，侧栏明确说明这一范围。临时目录随观察释放并等待所属子进程关闭后清理；状态最多512 KiB／1000项，树每页仅挂载50个节点，最多保留一份选中正文。单文件工作区和HEAD对象各先核1 MiB上限，按需差异最多64 KiB，二进制与截断明确说明。可见标签的列表 lease 负责文件系统失效通知；工作区、linked worktree 的 index／HEAD 及共享 refs 分别观察，通知只含原作用域与读取ID。macOS／Windows优先递归事件；Linux为避免递归展开依赖树采用浅层通知与10秒后备核对，监听失败同样降为后备，不在隐藏窗口或关闭标签中保活。Main以500ms静默窗口／1秒最大等待合并事件，过滤对象库／日志噪声；一般忽略目录未按Git规则过滤。Renderer自动刷新最多1Hz，慢读取按耗时进一步降频至最多10秒冷却，一次在途最多一个后继。连续写入不反复取消正在读取的列表，手动刷新、focus与可见性恢复仍能核对。刷新保留同路径已验证正文、目录折叠、布局和滚动，接收新观察后重读选中正文；真实失败明确显示旧结果尚未更新并最多进行3次退避重试。切换／关闭／隐藏释放所属进程与监听，过期事件和响应不能回填新scope。暂存删除但磁盘仍有同路径未跟踪文件时合并为一个路径，保留两种状态；仅在Main私有索引副本恢复HEAD成员后计算当前字节，源索引不修改。相关设计取舍见[可见工作区同步](../../.agents/notes/implemented/architecture/2026-11-09-visible-workspace-diff-refresh.md)。

2026-11-09，5a9e1d98 加未提交diff实现的后续同步修复：Linux x64／Bun1.4.4，7份完整回归共91项／911断言通过，含真实临时Git的创建、删除、重命名、index和linked-worktree refs通知，监听合并／后备／关闭，D＋未跟踪同路径比较且源索引不变，以及renderer连续失效单后继、隐藏／恢复、旧scope拒绝、正文／目录节点和滚动保留、新增／删除前序目录不串折叠与焦点、短暂失败自动恢复。九项目6647文件类型检查、生产renderer构建、定向Biome、边界、API、测试归属与文档检查通过。DOM测试不等于真实画面或帧率；既有Chromium宿主socket EPERM与Files native不可用的环境限制未解除，本轮未宣称实际Native窗口或平台体验验收通过。

[Main reader](electron/file-changes.ts)从 NativeCaller 已登记的原 Message 取得唯一 `sourceIds`，经生成 Client GET 核真实原 Run 和 Execution 的 Store、Session、Run、定义、结果 revision 和准确 content。当前 Store 负责连接准入，备份恢复后的原出处仍保留；封存 Fork 严格沿 `originMessage` 的原 Run，不借当前消息补来源，也不要求整 Run 成功才可读其中已成功的 Files。观察 ID 封存原 Run/Command、Execution 定义和完整结果的固定 SHA-256 摘要，详情与打开前重新核对，同 revision 的结果或来源变化也不能换绑旧 ID。仅 succeeded 的 `files.write/edit` 进入列表；同名 tool call 不建立关联，Shell/MCP 和 failed/unknown/cancelled 不猜逐文件贡献。`details.fileChange@1` 由 [Files owner](../../packages/agent/src/tools/files/README.md#逐操作文件变更预览)提供。旧 receipt 或未知格式保留已确认操作与可用路径，明确无差异，不从当前文件或恢复检查点重建。原来源和当前 Workspace 不同或不能确认时不提供打开按钮。

“常规”复用原编辑器选择，默认 VS Code，Zed/TextEdit 可选，只在当前 renderer 进程保留。文件操作中的路径按钮传 Main 观察 ID 和封闭 editor 枚举，不传任意路径、工作区根或应用名。Main 再读原 receipt、当前登记 Workspace 和物理根 dev/inode，沿迁入的 [editor leaf](electron/editor.ts)只接受该项目内存在的普通文件；保护 Profile 与候选目录。调用固定 macOS `/usr/bin/open` 的独立 argv，打开当前磁盘内容；编辑器未安装或目标漂移明确失败。Main 在所有读取后、分发前重新检查原 renderer frame。正文阅读不以编辑器可用为前提，路径按钮也不证明历史 diff 等于当前磁盘。原消息路径与常规设置的当前接入见下一节；本面板仍不代表整个 PC 迁移完成。

取舍见[文件结果迁移决定](../../.agents/notes/implemented/architecture/2026-10-08-native-file-change-receipts.md)。[真实 Files 回归](../../packages/agent/test/isolated/files/change-preview.test.ts)、[Main 端口](test/native-file-changes.test.ts)、[原面板 DOM](test/isolated/native-file-changes-dom.test.tsx)与原[源码外窗口](test/isolated/native-bundle.test.ts)分别负责 IO/receipt、准确作用域、原入口与冷读。实际执行输入、失败与通过边界归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原文件变更与编辑器入口迁入)；OS 编辑器窗口、安装版全路径和 Windows/Linux 资格不由有限 callback 或按钮断言代证。

[恢复后真实消费者](test/isolated/native-restored-file-changes.test.ts)使用默认 Files、公开 Fork/backup/restore 和两个冷 Service/Node Main，核源会话与封存 Fork 的保存 write/edit 差异、read/write/edit 路径及普通消息路径，当前磁盘独立改变后历史仍精确。全部原 Message/Run/Command/Execution、原出处与 metadata 保持，冷读取全 GET、Provider 不增加；可信 opener 只核已重新验证的当前文件目标。原 UI/Caller/IPC 完整文件核既有派发守卫，该新例没有重新证明恢复后的整窗口点击或 OS 编辑器；准确红绿输入和剩余门禁归[恢复文件进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-文件历史与当前文件入口)。

2026-11-09，隔离Linux云副本／Bun1.4.4，基准`b3c66bdb`加本次未提交改动：`bun test --parallel=1 --max-concurrency=1`对[Main文件读取](test/native-file-changes.test.ts)、[真实Git工作区](test/workspace-changes.test.ts)、[Git IPC](test/workspace-changes-ipc.test.ts)、[历史文件DOM](test/isolated/native-file-changes-dom.test.tsx)、[实际NativeDesktop工具DOM](test/isolated/native-tool-receipt-render-dom.test.tsx)、[工作区DOM](test/isolated/native-workspace-changes-dom.test.tsx)、[共享差异滚动](../../packages/ui/test/isolated/desktop-file-diff-scroll.test.tsx)与[有界预览](../../packages/agent/test/isolated/files/bounded-change-preview.test.ts)八份整文件合计75项／844断言通过；最后补显式禁止Git自动取回环境后，Git两文件22项／106断言复验通过。根聚合typecheck九项目、变更TS的Biome、工作区边界、公开API、测试归属、文档结构和本次作用域影响核对通过。未修改发布入口或取得安装／跨平台资格。

2026-11-09，参考图版在独立`5a9e1d98`副本整合此前操作／Git补丁，保留原Profile和输入区改动。沿原隔离runner逐文件执行13份完整文件，154项／4465断言通过，覆盖有界解析、双栏／统一、上下文折叠、首开宽度竞态与用户先拖动、单reader／过期响应、筛选与刷新保留、目录／文件预算、原工具聚合和Main Git边界；根聚合typecheck九项目6647文件、正式UI构建及CSS附属资产、Web构建、变更TS/CSS的Biome（1项建议）、文档结构／影响、工作区／Agent边界、公开API和测试归属通过。只读模型探针对1000个独立24层路径核得2048目录＋1000文件，身份完整、最多50节点／页，建树与展平中位数5.17ms／最高11.49ms；这不是浏览器帧率。另运行原恢复Files集成1项失败，隔离诊断确认真实read_file返回`file_native_unavailable`，不计入通过，也未修改原断言。生产夹具DOM过程可以核取消／切换等状态，仍不能替代下述真实浏览器与Native窗口资格。

[真实浏览器夹具](test/file-diff-browser-runner.fixture.ts)生产Vite／CSS构建通过，但Chromium在打开页面前因宿主`socket() Operation not permitted`失败，正规受审执行仍相同，未禁用Chromium沙箱；浏览器过程、截图与视觉断言均未执行，不能以DOM结果替代。原[真实write/edit预览集成](../../packages/agent/test/isolated/files/change-preview.test.ts)六项在夹具创建即遇`file_native_unavailable`，此环境无Rust1.97.1或预建Files资产，未进入差异断言。实际Native窗口／原生写入验收仍待具备这些条件的环境完成。复验浏览器使用`bun apps/desktop/test/file-diff-browser-runner.fixture.ts`；普通dev／prod未增加测试入口。

## 原消息文件路径与常规摘要

Markdown 文件引用复用 `messageFile.open`，可选正整数行号独立于路径传递。Windows Main 通过系统关联查找 VS Code，然后在原来源、工作区、普通文件和 frame 校验通过后，直接把文件作为参数交给注册的 `Code.exe`。使用 `--reuse-window` 复用最近使用的窗口，带行号时传 `--goto`。macOS 的 VS Code 行号定位使用固定 `vscode://file` 入口，其余编辑器继续打开文件。[文件回归](test/native-file-changes.test.ts)覆盖可选行号校验、编辑器参数、放行前 frame 复核和原工作区限制。[浏览器夹具](test/markdown-content-browser-runner.fixture.ts)覆盖流式闭合、深浅主题、窄列换行、悬停／焦点提示、激活和缓存返回。编辑器参数见 [VS Code 文档](https://code.visualstudio.com/docs/configure/command-line#_core-cli-options)。

Windows x64／Chrome 157 运行 `bun apps/desktop/test/markdown-content-browser-runner.fixture.ts --file-references-only`，在 390／1280px 深浅主题核对完整引用、蓝色下划线、长路径换行、正文自然左对齐、反引号闭合前后的流式展示、暂停读取、会话往返、键盘和鼠标各自触发。2026-11-13 另用 Electron 44.3.0 当前源码开发构建、独立 Profile 和真实配套 Service，在 Windows x64 已打开的 VS Code 1.146.0 窗口复验。先点 `host.ts`，核对打开的标签与完整路径。回到 Kite 点 `collaboration-observation.test.ts:94`，同一 VS Code 窗口保留两个标签，前台文件切到测试文件，编辑器显示光标在第 94 行，状态栏报告行 94、列 1。证据范围为本机开发构建和单个已有 VS Code 窗口。

原 [MessageContent](../../packages/ui/src/desktop/MessageContent.tsx)沿 `ModelOutputMessage.renderText` 展示同一条预览或已验证全文；普通正文自动读取并沿用原来源、哈希及读取暂停门禁。HTTP(S)仍需显式打开，图片不请求，HTML、锚点和 scheme 不产生文件操作；相对路径沿原 decodeURIComponent。子详情和未知格式不提供文件回调。消息文件点击传已读 Message ID、viewSelection/history epoch、最多8192 UTF-8 bytes 的路径及封闭 editor 枚举；[Main](electron/file-changes.ts)核当前登记项目、原 Message 来源、物理根和普通目标／保护目录，派发前核当前 frame。一般 Markdown 路径表达当前项目文件，不证明文件贡献；有原 Run 时核其准确身份和出处，无 Run 的原用户消息仍沿已观察 Message、当前准入的源 View 同 Workspace 和物理目标核对。恢复后的旧出处不因 Store 不同被拒绝，也不继承另一项目的文件范围；跨项目或来源不可核对时拒绝，缺失文件沿原 AlertDialog 告知。

[元数据 reader](src/native-file-targets.ts)复用原32项扫描与所属 GET 释放，消息结果有 path 仅用于筛选请求，不授予行为；Main核准确原 Execution后只给成功的 Files read/write/edit 提供原 [ToolRow](../../packages/ui/src/desktop/ToolActivity.tsx)文件路径。完整历史不依赖 View 的近200项执行列表，未知格式／未核结果沿原正文保留。面板与工具行重复扫描同一封存结果时保持相同观察 ID，不相互撤销；历史文件元数据仍只以成功写入／编辑作为操作差异，不把读取算作变更；右侧Git列表独立读取整个仓库。失去当前scope即清元数据，刷新失败可显式重读，关正文只结束其 reader。

[常规卡](src/native-general-settings.tsx)保留编辑器及 Windows 集成终端设置。移除默认模型行后，常规不再请求模型配置，Main 移除该行专用的 `settings.general.models.read/close` 端口。

### Windows 集成终端 Shell

Windows 的[集成终端 Shell](src/native-shell-settings.tsx)复用设置下拉组件，显示自动、Git Bash 与 Windows PowerShell 5.1 和已核实的可用性。Main 从根窗口和当前调用者代次接收封闭枚举，由原配套 Service 保存至当前 Store。界面在已确认后更新选中值，读取或保存异常在同一行提示。重开可读取实际保存状态。保存后由新会话创建时生效，具体绑定见 [Service owner](../service/README.md#默认-shell-装配)。

打开新对话时同步撤销旧会话尚未完成的选择读取。先前读取即使在新草稿输入后才返回，也只属于原选择，不能接管准备页输入区。[新对话回归](test/isolated/native-new-conversation-dom.test.tsx)覆盖该时序。

2026-11-12 Windows x64，从[同一安装候选](docs/native-release.md#构建与安装)的隔离安装运行实际窗口，连续记录 93 次界面变化。在同一 Main 和 Service 中从自动切到 PowerShell，再切到 Git Bash。首次保存发生在原 Bash 命令结果之前，两个新建会话分别执行所选方言，原 Bash 与 PowerShell 会话各自继续执行。进程退出后从 SQLite 冷读五条已完成轮次和各会话绑定，重开窗口读回 Git Bash。独立无 Git 的 Profile 显示自动使用 PowerShell，Git Bash 禁用，新会话实际执行 PowerShell。三次窗口均正常退出，最终隔离安装已卸载，正式安装登记和快捷方式摘要一致。证据保存在本机 `.cache/shell-settings-win-20261112/installed-shell-settings-221d5e7b.json`。定向设置、准备页接管及 Store 回归七项 110 断言，Bash 检索集成与真实 PowerShell 策略回归两项 44 断言通过。

2026-10-25，后台模型队列与常规页的租约冲突已通过生产 queue＋Main manager 精确复现：模型保存后的健康 flush 中，旧 General GET／close 覆盖或清空队列 observation，下一次开关在 POST 前被拒，恢复按钮普通 GET 后才重获资格。独立只读 manager 修复后，Main 配置／提供商30项／302断言、General与模型DOM45项／649断言、完整NativeDesktop82项／1705断言通过；并发 GET 用例确认 General close 不取消模型续读，封闭IPC拒绝注入scope、Store、写入或continuation authority。此路径不依赖未决journal或Service保存失败；不据此推定每一种重新读取提示都来自该冲突。同轮匿名生产UI／真实Main浏览器夹具在1100／550px深浅四组合通过，共12391次过程采样／2127帧，无页面错误；每组合常规read/close各1次，返回后台队列不增加普通模型GET，原5次串行POST继续完成。健康阶段2442次采样中恢复控件、alert及只读状态均为零，原未知、失败、foreign read-set和草稿读取断言保持。该证据不代表当前已运行的旧Main已热更新，也不代证安装版或真实用户配置操作。

[原入口 DOM](test/isolated/native-original-entries-dom.test.tsx)、[Main 文件端口](test/native-file-changes.test.ts)和原[源码外窗口](test/isolated/native-bundle.test.ts)核常规编辑器选择、旧 scope、预览／全文／关闭、准确路径／frame 和首次／冷读；窗口只核可用路径按钮及真实缺失目标拒绝，不实际启动 OS 编辑器。输入、实际通过与旧错误见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原消息文件路径与常规摘要)，完整PC／installed全路径／其他平台和阶段退出仍按原条件核对。

## 原工具过程与结果阅读

[工具分段渲染](src/native.tsx)从首个普通工具就建立稳定的分段容器，后续“创建／继续子 Agent”只插入所属行；首段沿原工具组身份，后续段沿前一个子 Agent 操作身份保存展开状态。[NativeToolPresentation](src/native-tool-messages.tsx)按同scope、同执行展示身份记录首次观察的位置，回执在同一可读工具块内原位接管，避免完成顺序将仍在运行的工具移到另一段并重建DOM。说明正文、引导和其他Run继续分隔工具块；冷读从实际历史顺序开始，窗口内切换沿原有界展示缓存保留位置。位置身份与完整展示共同计入原缓存预算，不参与元数据、结果、读取或操作资格。共享扫光CSS与循环参数保持。

[实际Native聚合回归](test/isolated/native-live-tool-aggregation-dom.test.tsx)补充收起／展开两例，先复现子Agent加入时的节点替换，再覆盖其回执先到时两侧活动工具的节点、展开选择和运行标记；[位置与来源回归](test/isolated/native-tool-targets-dom.test.tsx)核乱序接管、正文／引导／Run边界、会话缓存和冷读。2026-11-05，`e96af0dd4`加本次diff、Windows x64／Bun1.4.4／Chrome156，六个完整定向文件91项／2014断言、Desktop类型、定向Biome、Core边界与测试归属检查通过。隔离生产Native页面检查深浅主题下普通混合工具、Shell、子Agent加入及收起状态共8组；6025个活动逐帧采样中原工具组零缺帧，CSS动画对象与起始时间各保持一个，展开工具行的动画身份在加入与回执接管后同样保持。过程图及原始采样在本机`.cache/tool-animation-native-trace/before/`与`after/`，临时入口为`.cache/tool-animation-native-trace.ts`；原始重建与首轮仅保首段、未保另一侧工具的失败证据保留于测试输出。该夹具使用受控业务事实，普通工具的合成metadata目标不作为真实路径验收；此范围不代完整Electron窗口、真实模型或安装资格。

同一隔离Native流程另在深浅主题继续到全部回执、轮次完成和重新展开过程：工具扫光、运行标记和底部回复状态均归零，原输入只显示一次，最终回复和草稿位置保持。完整阶段图与终态数据在本机`.cache/tool-animation-native-trace/completion/`；不以单张完成截图替代前述活动阶段的节点和动画时序核对。

[NativeToolPresentation](src/native-tool-messages.tsx)同时保留完整行及该行此前准入的准确展示 fact，父会话与[只读子详情](src/native-child-detail.tsx)在回到原scope、当前metadata仍待核验时沿用同一工具类型，避免先画通用图标再替换。fact 只在原展示键和原消息ID一致时复用，与完整行共同计入既有有界缓存；来源冲突、输入未完成、bridge／generation 重置及缺失记录均撤销。它只支持已核实展示：文件打开仍取 fresh fileTargets，子详情导航须有当前工具 fact，图片新读还须当前 fact 已完成核验，不从缓存描述授予操作资格。[回执实际DOM](test/isolated/native-tool-receipt-render-dom.test.tsx)核已知、混合和图片工具的多次快速往返、核验挂起／接管、原SVG身份及图片新读门禁；[来源回归](test/isolated/native-tool-targets-dom.test.tsx)核准确身份和撤销。

共享会话的细原生滚动条、紧凑工具行、完成式工具名称和可反向折叠由 [UI owner](../../packages/ui/README.md#原桌面展示层)负责。工具名称、颜色和动画只改展示，未升级工具定义或协议，也不改变执行结果、审批或读取资格。

2026-11-05，`e96af0dd4`加本轮展示改动、Windows x64／Bun1.4.4／Chrome156.0.8078.80：逐文件 `bun test ./<原路径> --timeout 20000`，UI 的聚合、延迟内容、侧栏、差异滚动、模型选择、Agent行及页面七个完整文件，加 Native 的聚合、目标、回执、工具消息、Agent行、子消息复制及环境／子详情恢复七个完整文件，共149项／4867断言通过；UI／Desktop 类型和定向 Biome 通过。共享 viewport、Portal、逐项完成式名称、失败原因与原读取门禁均沿原测试入口核对。

隔离生产 Native 页面在深浅主题各做两次 A→B→A，并挂起再交付工具 metadata；510个相关逐帧／变化采样中，原SVG零替换、零错误图标、零页面错误。基线均能复现核验期间退回通用图标，前后材料在本机`.cache/tool-icon-session-preview/{before,after}/`。生产 SessionPage 与编译CSS另核深浅×1280／780px四组：Shell手动阅读时追加保持位置，边界 wheel 原生传递至聚合及消息区，24个真实 wheel 事件均未阻止默认行为，期间零JS scrollTop setter；原生thumb拖动、普通刷新位置、差异双轴与Home／End、具名焦点、草稿及模型选择均正常。工具行实际28px，失败行常规400字重且按主题取error颜色。画面观察发现的深色 Portal 浅轨道已修正，补核两主题的thin与color-scheme；阶段图及逐帧报告在`.cache/session-native-scroll-preview/`，四组报告保留为`report-four-cases.json`。

连续开合在深浅主题各做三组反向点击：旧keyframe基线跳变最大约326px，新transition在12次反向提交前后高度差均为0，原reader节点保持；1895个过程帧中，反向阶段最大帧间隔14.1ms。关闭结束后reader退出、再次打开正常，减少动态效果模式直接显示。已观察快速反向、稳定展开和最终收起画面；材料在`.cache/tool-collapse-interruption-preview/{before,after}/`，没有以最终截图代替时序采样。以上均为隔离生产组件与受控事实，不读取用户Store、不发送真实任务，未重验完整安装版Electron或其他平台。

最终共享折叠和滚动样式下，另重跑前述Native扫光八组：6308个过程帧、零页面错误，普通刷新、子Agent插入及回执接管前后原动画对象和起始时间保持。最新逐帧记录及阶段图覆盖本机`.cache/tool-animation-native-trace/after/`，已复核子Agent两侧与Shell展开过程；早先完成／重开材料仍按其原范围复用。

扩展回归保留既有边界：`native-session-navigation-dom.test.tsx` 的四项阅读／owner回执断言在原HEAD渲染来源同样失败；`native-transcript-dom.test.tsx`完整运行为23通过／1失败，真实HTTP createWorkspace报`network_outcome_unknown`，该单例独立执行12断言通过，把全部改动来源替换回HEAD后完整文件仍同样失败。它们未计入上述149项通过，未扩大为本轮滚动与工具展示修复；首轮高并发导致延迟内容文件超时，独立重跑5项／40断言通过。原浏览器夹具的差异按钮／模型视图定位及隐藏原生轨道参数已校正，再以可见原生轨道完成拖动验证。

[目标提取](src/tool-request-target.ts)在已支持定义／版本中只选择明确的文件路径、查找／搜索条件及范围、目录、MCP查询／服务／资源／提示词、计划与Skill引用，目标最多4096个完整Unicode码点。不打印工具正文或任意扩展参数；无单一可读目标的验证记录、空输入读取及任意远端工具不猜字段。Shell继续走原命令分片和结果证明，网页显示继续沿共享UI去掉凭据／查询部分。

`browser.execute`、`skills.load`、`skills.resource` 当前版本1的工具行分别显示“浏览器操作”“加载技能”“读取技能资料”，浏览器取原输入的 `description` 作为本次动作说明；加载技能只显示原 id，例如“加载技能 computer-use”，不附调用目的；读取技能资料只显示 id／资源路径，不附执行描述。仅浏览器的新模型调用要求执行描述为1–10个Unicode字符且非空白；Skill 两入口不再接受 description 入参，历史原文保留。展示只压为单行，不从代码或结果生成说明，不把目的当成成功或权限。旧浏览器记录缺字段只保可读名称，旧 Skill 可回退原 id／资源路径；未知版本不借新 schema 解释字段。该文本复用原 target 元数据及完整呈现门禁，live、只读子详情、保存回执与来源冲突撤销沿原通道，不传原代码或新增 IPC 字段。

[实时工具适配](src/native-tool-messages.tsx)只在原Store／Session的活动Run中，从已有公开Execution输入提取展示目标；子详情的 [execution投影](src/tool-messages-bridge.ts)只加有界target，不传输入payload或控制资格。保存的ModelOutput可将消息中的toolCalls留空，Main的 [原请求核验](electron/tool-message-fact.ts)因此在同原Execution／来源／Run／toolCallId且没有可见匹配声明时读取原Execution输入；可见调用重复、未完整、错定义或错调用不能绕过原门禁。缓存订阅同来源调用变化，冲突在重读完成前撤下目标，失败保原结果；文件打开仍独立由原成功文件目标reader授予。实现取舍沿[连续工具呈现Note](../../.agents/notes/implemented/bug-fix/2026-10-25-native-contiguous-tool-aggregation.md)。[目标表回归](test/tool-request-target.test.ts)、[实际工具DOM](test/isolated/native-tool-targets-dom.test.tsx)与[元数据DOM](test/isolated/native-tool-messages-dom.test.tsx)覆盖现行参数、父／子详情、排队→运行→省略Model声明的终态及冲突撤销；实际执行结果另记于本节。

普通 `read_file` 的确定缺失仍经过准确原调用和回执核验，以成功的 `exists:false` 观察展示：明细保留原请求路径，灰色“文件不存在”，不添加正文、假 0 行或失败红色。私有文件、真实权限拒绝、损坏及未知结果继续显示各自真实状态，不能按路径或错误词猜成缺失。2026-11-05，macOS 本机隔离 Chrome 中加载 Desktop 页面及真实 Service／Core，逐次观察一次输入→正在回复→读取文件→正常完成，展开结果准确；82 次 DOM 变化没有失败／红色记录，刷新重开保持相同结果，原读取没有重执行。过程与重开证据在 `dist/acceptance/tool-feedback-20261105-high/window-process-observation.json`、`window-reopened.json`，夹具日志 `window-fixture-r3.log`；这是隔离浏览器、固定模型与真实服务资格，不代表真实模型任务稳定完成、完整 Electron 安装版或其他平台资格。

2026-10-31 描述消失定位：执行中 Renderer 已热更新，但当时运行的12:15 Main 仍未在目标 reader 中识别 browser／skills 三个定义，保存回执因此缺少展示目标。之后只读核13:11新 Main 已包含 description 读取分支；已有说明沿准确历史原输入重读。共用 helper 也属于 Main 构建依赖，不能凭 src 路径认定只需 HMR；本次 Skill 身份展示同样须沿完整重启加载新 Main。已有原输入仍从准确历史读取，不补写旧调用，也不从界面缓存掩盖来源冲突。

2026-10-31 工具执行说明：新调用公开必填且最多10字，真实Runtime／SQLite与本地HTTP验证原输入和后续历史保留，非法值在解释器或知识读取前失败；旧内部输入保持可选。隔离 Chrome156 使用生产ToolActivity、CSS及Native实时／回执／缓存投影，核元数据0→2→4行、排队→执行→分批历史接管、深浅色×260／390／960px、未知状态及实际展开／收起。17个阶段与299个变化采样、8项相关源码hash前后相同，主Agent已复核窄栏、省略、未知和收起中间／结束画面；正常收起650ms后正文退出DOM。材料保留在 `.cache/tool-purpose-browser-20261031/final`，首次夹具行高误断言另保原报告；此范围不是完整Electron、真实模型或安装制品资格。

2026-10-31 后续展示收口：Skill 保真实名称／资料路径，浏览器普通结果仅摘要，未结束 Turn 外层强制展开。11个定向文件195项通过，含三条16010字符浏览器代码／sealed Model calls 的 Main reader 正例与可见来源冲突撤销；UI／Desktop类型、定向格式及文档检查通过。冻结生产 Conversation、ToolActivity、CSS及 Native 最终分组／回执投影，在隔离 Chrome156 核34幅增量过程图、194条变化快照，并复用有效活动状态材料；五行及三个不同目的在 live→pending→partial→saved 中保持准确身份、文字和高度，正常 browser 在旧 expanded=true 下也无原始 reader，失败／未知保可读异常，终态默认收起及键鼠开合均经观察。9项生产源码hash前后一致；主Agent直接复核接管即时／稳定、窄栏、未知完整错误及终态开合。材料在 `.cache/tool-presentation-followup-20261031`，两次私有输入／最终分组不合格材料保留并排除对应资格；错误截图的私有 reader canary 不代表正式 Native 原记录布局。自有 Chrome／runner 正常关闭，无新增模型调用或用户客户端操作；这是独立生产组件和本地元数据 reader 资格，未新增完整 Electron 或普通安装制品资格。

扩展回归同时暴露已确认释放回执在随后Job信号结束后被getter隐藏的竞态；[Service](../service/src/desktop-browser.ts)只移除读取缓存时的重复signal判断，释放捕获前取消、错误身份、unknown与完整dispose门禁保持。Service真实HTTP正反例核close确认→abort→dispose仍保纯数据回执、取消在确认前仍无回执、旧通道拒绝输入；真实worker恢复用例与未准入取消／业务unknown负例保持。原失败及诊断材料保留在 `.cache/tool-purpose-browser-execute-20261031.log` 与 `.cache/tool-purpose-current-redirect-20261031-b.log`，未改写原unknown。

本轮按文件隔离的17个定向文件共459项通过，包括Browser执行77项、Controller79项、Service传输81项和工具行分组／旧记录／来源冲突；Agent、UI、Desktop、Service、CLI类型及格式、文档、Core边界、测试归属检查通过。首次将isolated用例与纯Main单测合跑时曾出现收起时序断言失败；当前源码及本次UI改动之前的内存基线单例均通过，最终按原文件隔离方式验证，实际浏览器另核正常收起过程，不修改生产动画掩盖该记录。本轮真实模型调用0，隔离账本仍为295＋209＝504，未触碰用户客户端。

具体工具行先经过 [完整元数据门禁](src/native-tool-messages.tsx)：首次请求、回执或命令分片的展示事实未齐时不生成该条具体消息，完整一条才显示一条，不以全局loading阻塞其他完整工具。完整请求可以在排队或执行中显示，不等执行终态；合法空输入、参数非法的真实失败及未知schema不因没有target而被误判为未完成。子详情只投影inputReady与有界target，不传原参数payload。NativeToolPresentation仅保留同scope、同presentationKey已展示的完整消息，供回执独立核验期间阅读，不补不完整字段、不冒称成功；来源冲突或live输入资格撤销均清除旧展示，不保留或恢复命令复制。长目标沿原单行省略，悬停可看完整展示文字。

2026-10-26，macOS arm64／Bun1.4.2，当前已执行：目标字段表34项／73断言、Main元数据30项／1268断言、完整元数据与准确交接DOM14项／162断言、实际Native聚合11项／421断言、子详情恢复3项／54断言通过；UI／Desktop typecheck、定向Biome、文档、边界和测试归属检查通过。隔离浏览器使用生产Conversation／ToolActivity和真实投影函数，核9类工具的首次metadata未齐→分批2条→完整9条，以及排队／运行、回执核验与来源撤销；深浅主题×1280／390px×单项／聚合共72阶段图及4张末项图，100次DOM变化／1264帧没有只有标题的半条工具行，目标title完整、手动阅读位置保持，无新增操作或页面错误。报告在本机 `.cache/tool-target-browser-F6ZKZc/report.json`。该快照夹具证明首次／分批门禁，已完整消息的准确交接保留另由Native组件及缓存DOM验证；不代证完整Electron IPC、Service、真实模型或安装版。扩展回归中的四项旧折叠、动画或旧版本名称失败以修改前源码复现，未计为通过。

已支持格式的浏览器普通操作只保留静态工具行和短说明，不展开原 JSON／AX 快照／脚本输出，也不调用原正文 reader；真实失败、拒绝和结果未知保原异常展开。完整 Tool 输入与结果仍按原通道保存并交给模型，未知格式及未核实记录保原 reader，不改变执行或恢复语义。外层 Turn 执行期间保持展开且无折叠入口，准确终态后恢复原默认折叠与手动阅读；工具异常自身仍可开合。

其余工具结果沿用户确认的原位展开方案：保留轻量工具行、连续工具聚合与原阅读身份，点击对应项在原位置阅读结果，不新增右侧工具详情页。计划、验证与 MCP 发现／资源工具按稳定 ID 显示可读动作名，结构化解释和对应图标仍需支持的准确版本；未知定义保原名称。正式 MCP 代理在元数据未核实时显示“MCP 工具”，已保存回执通过 [本地名称 reader](electron/mcp-tool-label.ts)读取原 `mcp.tools.snapshots`／`mcp.tools`，核 Store、Session、定义版本、快照绑定及原名称 hash 后显示 `MCP · 原工具名称`。名称预览不完整时沿公共 descriptor reader 读取原完整材料；没有匹配、元数据失败或外来源历史保持通用名称及原结果，不借当前远端目录猜名称。每页工具回执的可选名称共用最多32次元数据／制品读取、从首次名称查询起250ms期限及256KiB完整descriptor预算；超限或超时仅降级名称，不撤回原结果或取消同页／并行回执读取，避免历史目录扫描阻塞首次正文。所有查询只读本地保存事实，不连接或调用 MCP；读取关闭及换会话继续取消所属 GET，迟到名称不得发布到新会话。[元数据回归](test/native-tool-messages.test.ts)覆盖多快照／大目录的共享上限、超时原结果与并行页保全、descriptor限额及关闭取消。

展开详情的 Home／End 保留内层原生滚动，并让相应首／尾边缘进入外层阅读区的可见窗口，避免聚合内差异滚到底部后末行仍被外层裁住。聚合总高、正文完整性、折叠选择和输入位置仍沿原规则；鼠标滚轮与横向阅读保持原边界交接。

自动审批未通过的盾牌保持原警告色，不被工具行的异常红色继承规则覆盖；真实执行失败、未知和原拒绝原因继续分别保留。

2026-10-25，Windows x64／Bun1.4.3／Chrome155，`c3f384c48` 加本次主目录整合：工具元数据、Native DOM、实时聚合、原记录阅读、共享聚合、滚动和 TUI 渲染七份整文件定向回归分别通过，共111项3377断言；UI／Desktop typecheck通过。整合时两份旧断言仍要求版本后缀，已按用户新确认的名称规则同步，原结果读取、未知状态与来源隔离断言保留。原[工具详情浏览器夹具](test/native-live-tool-aggregation-browser-runner.fixture.ts)的 `tool-details` 在亮色1280px／暗色780px完整通过，逐步观察展开→Home／End→动画结束后的差异完整尾行、Shell手动阅读／继续跟随、11种结果与审批拒绝的hover／键盘／原因展开；1808帧与报告位于本机 `.cache/native-live-tool-aggregation-bMC4t8`。隔离阶段真实裁切、后续滚动等待和警告色失败的原日志保留于 `.cache/tool-output-integration/isolated-logs`，没有删除相关断言或放宽时限。MCP名称另核准确版本／hash、缺来源降级、换会话迟到隔离与同节点展开保持；这里的本地桥接／数据端口测试不代证真实外部MCP、完整安装版Electron或其他平台资格。Web行为及执行授权边界未改。
[工具呈现](src/native-tool-messages.tsx)按稳定定义ID决定已知工具名称，名称不依赖定义版本白名单；`glob@3/search@5`及后续未知版本继续显示“查找文件／搜索内容”。结构化结果、Shell操作、问答归属和特定探索分类仍按准确受支持版本判断，未知版本保原结果阅读，不从友好名称推断权限或终态。[元数据回归](test/native-tool-messages.test.ts)及[真实组件DOM回归](test/isolated/native-tool-messages-dom.test.tsx)覆盖旧版、当前版和未登记的999版本；完全未知ID继续显示原工具ID，但常规名称同样不附加版本号；准确版本仍保留在原始记录与内部格式核验中。取舍见[连续工具呈现Note](../../.agents/notes/implemented/bug-fix/2026-10-25-native-contiguous-tool-aggregation.md)。

2026-10-25，Windows x64／Bun1.4.3，`d33ac7cec`加名称修复：上述两份完整回归43项1523断言、Desktop typecheck与文档检查通过。隔离生产组件页面逐步观察当前版本→模拟999版本→结果保存→切回，逐项名称始终可读；未知格式保留通用动作摘要，不套用旧结构。临时入口为本机`.cache/tool-version-labels-server.ts`，未来版截图为`.cache/tool-version-names-future.png`；该页面没有连接用户数据、Service或真实工具，不代表完整Electron或权限流程资格。版本升级的明确用户确认规则归[根AGENTS](../../AGENTS.md)，本轮不继续升级工具版本。

Native 对 `web_fetch@1` 沿准确版本表投影“读取网页”及网页图标；Main 的 [tool-message-fact](electron/tool-message-fact.ts)只从唯一、同来源、完整的原调用提取 `url` 到既有有界 `target` 字段，缺失、冲突或未来版本不借结果标题补目标。[metadata 回归](test/native-tool-messages.test.ts)核这条边界。实际展示由[共享工具 owner](../../packages/ui/README.md#原桌面展示层)负责：网站／路径省略查询等敏感部分，成功不展示网页正文，失败只将具体工具行标红、聚合标题保持普通颜色，原异常仍可单独展开。仅改变读取与呈现，不修改普通 Tool、授权、网络超时、结果或模型正文。Native DOM 与原 long-group 浏览器 fixture 沿相同生产组件核准入事实、逐项开合、成功正文缺席、失败标题颜色和真实异常阅读；测试只在隔离夹具中开启，不添加普通客户端调试入口。

工具阅读区启用共享 ScrollArea 的纵向边界交接：内层仍能滚动时保留原生滚动，到顶／到底或没有溢出时交给最近可滚动祖先。2026-10-25，Windows x64／Chrome155.0.8059.85 的[长聚合浏览器夹具](test/native-live-tool-aggregation-browser-runner.fixture.ts)在亮色1280px与暗色780px通过原内部滚动、长异常全文、键盘、开合及新增上下边界断言；实际逐步观察内层→外层→反向回顶，输入区保持固定。过程帧与报告在本机 `.cache/native-live-tool-aggregation-3KpaNM`；无页面错误。该页面消费生产组件和隔离 NativeBridge，不代证完整 Electron 或其他平台。输入／Native DOM 与共享 UI 的五文件定向组合130项通过；追加来源隔离与卸载监听清理后，Native输入83项及滚动文件3项分别复验通过。Agent、UI、Desktop类型、定向Biome、文档、统一边界和测试归属检查通过；Biome保留输入测试原有两项字符串拼接提示。

[工具消息适配器](src/native-tool-messages.tsx)为准确 `task.spawn`／`task.follow_up`／`task.message`／`task.events`／`task.list`／`task.interrupt` v1 提供可读标签；已知定义的未知版本仍保留可读名称，但不沿用v1结构化解释。创建／追问工具终态只表示这次调用结束，不将其当作 child 业务完成。现有准确授权投影继续优先人工 pending，批准与执行效果分开；[工具 DOM 回归](test/isolated/native-tool-messages-dom.test.tsx)验证新标签及未来版本保守展示。

[六工具真实窗口门禁](test/isolated/native-collaboration-bundle.test.ts)使用 source-free macOS Electron、真实 Service/Runtime/SQLite 和隔离 mock Provider：普通父轮结束后两个 child 独立待批，只批准 A 不执行 B；稳定 A Session 续接到新 Run，旧 A 答复和旧卡停止均拒绝且不改投 A2，批准 A2 后只产生它的效果；准确停止 B 后迟到批准无效果，冷重开零 Provider 重放。实际 1 项通过，15 次 Provider 请求，原进程退出及候选独占 lease 均核实。审批只在准确根 Session/Run 的活动交互时隐藏主输入；child 待批仍保留原卡和父输入。[DOM 回归](test/isolated/native-interaction-composer-dom.test.tsx)保留原根审批入口。本机隔离窗口证据不表示付费 Provider 或 Windows/Linux 资格。

2026-10-20新增[普通Native真实模型runner](../../tests/e2e/live/model/collaboration-native-window.live.ts)与[私有driver](test/live-collaboration-native-window.fixture.ts)，构建常量 `testDiagnostics:false`，通过普通读取范围确认、权限菜单选择accept_edits、原输入框及两张准确child审批卡完成一批一拒。原freeze2三个独立样本共23HTTP均200，窗口、SQLite与文件效果相符；普通冷重开零新增Provider/Run/Execution/Command/Source/control，两窗口均正常退出并确认清理。流级usage保持null，canonical Model usage独立记录，不混算为每次HTTP已知。这组历史样本没有运行稳定child第二轮，不能借旧mock窗口补齐付费范围。

后续freeze6在同一真实默认策略下新增同child两轮的普通窗口子集，非Markdown输入4354项，摘要 `86836fc2853e98165887dfb0b5c6a19264e280bfd161e40c2b1eec3abd987b17`。三个新样本各12HTTP、共36HTTP均200，U01、U02可达子集与冷U03子集全部通过。原A/B两张Files卡完成一批一拒后，普通UI切换会话再返回，准确继续原工作；先展开父 `task.follow_up` 完整审批请求核对A与新C目标并只批准一次，再对同A第二轮的新C Files卡单独批准。每例恰有四张Interaction、两个child Session、三个carrier；A保持同一Session并使用两个不同Run，旧卡目标、答案及原carrier元数据保持，旧审批控件已移除。父委派批准不代替新C文件批准，实际A/C字节匹配、B零派发且文件不存在。每份主窗口及冷窗口均正常退出并确认清理，冷读零新增Provider、业务或Source。物理HTTP usage仍未知；36份canonical Model usage另行核对，合计input 133951/output 10448。该U02子集没有提交迟到旧答案或旧停止请求，也未覆盖断线重连、Job report关联、冷Service恢复或其他平台；旧控件移除不能代证服务拒绝迟到请求。准确版本、manifest、保留失败、独立核验与69/80逐项范围归[真实用例记录](../../tests/e2e/live/model/collaboration-v1.1-cases.md)。

子详情 reader 仅返回已封存 carrier／Store／rootWork 内的准确 Run 与有限 execution.authorization DTO；renderer再核出处，唯一活动 Run 的人工 pending 优先显示“等待你的批准”，不能从 waiting 状态推断授权。打开准确 A 子详情读取该状态、再返回父输入也由上述真实窗口核实。未取得准确控制 DTO 的旧缓存保原生命周期，不伪造审批状态；同一稳定 Session 的旧卡仍绑定原 carrier。

[NativeToolMessage](src/native-tool-messages.tsx)直接消费原 [ToolActivity / ToolRow](../../packages/ui/src/desktop/ToolActivity.tsx)，保轻量工具行、状态、箭头和结果展开。历史 Message 的 complete 只表示消息完整；[Main metadata reader](electron/tool-messages.ts)按已读 Message 的唯一 source Execution GET，核原 Store／Session／Run、tool kind、终态、result outcome 和完全相同的 content。每批最多32项，完整已读历史不限于 View 近200项；首次完整元数据未齐、明确不匹配或格式不支持的条目整条隐藏，不先显示只有标题的工具行，也不借原结果推断目标。曾完整核实的工具按原会话保留只读展示缓存；普通刷新或返回仍在8项非活动会话缓存内的页面时保留原行、展开正文及阅读位置，重新核实时不恢复操作资格。缓存边界绑定 bridge、generation 与 Store，明确冲突撤销对应旧行。只有用户逐项展开才挂载原正文及其读取控件，不先将原结果 JSON 显示为消息正文再替换。[回执渲染回归](test/isolated/native-tool-receipt-render-dom.test.tsx)直接使用 NativeDesktop，核展示信息未到、读取失败、未知／未来版本及不支持格式的准入边界和切会话清理。metadata close、切会话、detach 或 history epoch 变更只释放所属 GET，不停止、重做或恢复工具执行。同一阅读身份的普通事件刷新暂清 controller snapshot 时沿 Main 已验证 lastView 保留只读观察；明确选择、reset 或 Store 变化仍撤销旧范围。

Native 将 Tool 的 `planned` 映射为 UI `queued`，显示“等待执行”；`dispatching` 与 `running` 映射为 UI `running`，显示“执行中”并使用运行标记。普通 Tool 的实际调用等待结果期间仍为 `dispatching`，不能将它视为排队；读取、修改与独立工具行均保留执行状态文字，聚合标题只显示动作，运行与等待状态保留在各工具行。执行权观察继续约束忙碌与读取资格，普通界面不追加“执行状态待核实”；准确审批提示、停止请求和终态语义保持；确认未派发的审批拒绝／取消沿共享工具行只保留审批标签，不重复未执行或停止文字，Shell详情也不重复等待审批。自动审批未通过沿共享ToolApproval显示14px警告色盾牌图标，悬停或键盘聚焦只提示审批状态，完整拒绝原因仅在展开详情显示；其他工具行附属状态使用13px辅助色，独立的真实异常保留异常色与逐项展开详情，适配不改后端 ledger、执行准入或并发。[原工具 DOM 回归](test/isolated/native-tool-messages-dom.test.tsx)沿实际适配与组件核待派发、已派发、终态和混合探索聚合。

Main 仅在原 Message／Execution 身份和结果完全匹配、原状态 failed、`authorization.dispatched=false`、Core `adapterAttempted/dispatchCommitted=false` 且准确刷新 code 与 content 一致时投影只读 `decisionRefresh`。Native 适配为中性的 `not_executed`，显示上下文／工具信息已更新、此次未执行；聚合标题不追加状态计数，逐项状态仍区分此次未执行与真实失败。持久 ledger 不被改写，冷历史复用相同核验；缺证明、实际派发失败及伪造 details 均保原事实。[Main](test/native-tool-messages.test.ts)及[DOM](test/isolated/native-tool-messages-dom.test.tsx)验证四项重新评估与一项真实失败混合时保留各项准确状态。

Files等工具目标仅展示同一原来源／Run、结果之前且已读历史中唯一 Model call 的请求字段；重复 callId 不建立执行关联，有歧义不补目标。Shell原命令另沿下述确切Tool输入投影。请求文本不证明实际文件变更，也不授予打开文件资格。成功 Files 路径按钮仍沿独立原 receipt／观察 ID；Files read 的当前版本5与保留版本3、4均核原 baseline；write 支持保存版本2与当前版本3，edit 支持版本2。未来版本不沿旧格式推断路径或打开资格。文件读取失败行内保留简短状态，点击该工具展开完整异常原因；不附行内错误预览，也不提供文件打开动作。

唯一原调用属于已知 `files.list@1` 且省略 path 或传空字符串时，目标按该版本的已知默认值显示 `.`，表示工作区根目录；显式路径保原文。缺原调用、重复身份或未知版本不补默认路径，目录文本不获得文件打开动作。[Main 回归](test/native-tool-messages.test.ts)核默认／显式路径及缺来源／歧义／未来版本，[原组件 DOM](test/isolated/native-tool-messages-dom.test.tsx)核目录行实际保留根路径。

执行中的工具行只来自当前 Store、所选会话活动 Run 的真实 tool Execution，与同 Run 的原结果消息接管；旧 Store 恢复记录不遮掉新工作。停止申请尚非终态时明确等待结果，视图不可核实时保留原记录并后台重读，普通界面不追加“上次确认状态”。Shell execute/launch/read/wait/stop 显示各自实际操作；已知`shell.execute@1`也沿原工具输出卡呈现，启动受理不表示后台Job已完成，Job的准确停止与完整日志仍归原环境／Runtime logs入口。未知定义或版本保原 ID／version 和可展开原文，不借旧 UI 同名分类解释未来结果。

Shell卡片按用户参考图采用终端图标、实际状态与单行省略命令的工具行，展开后复用共享CodeBlockHeader／Content／Footer：带`$`的命令在Header完整多行显示，保留原始换行、长行自动折行、不省略Unicode原文，沿原CodeBlockCopyButton复制全文；Header无下分隔线，聚合／输出的滚动边缘沿真实viewport使用shadcn的scroll-fade-y；仅输出区滚动，右下角结果固定在Footer。外层工具标题预览限制512个UTF-16单位；独立输出viewport最高256px，当前400px聚合内按剩余空间限为252px，列表间距仍为0，结果保留在底部。原24px自动跟随阈值、手动保位和原输出保留，移除“回到最新输出”按钮；手动滚回底部即恢复跟随。Header自然增高，超长命令可在聚合外层viewport完整滚读，输出仍有独立viewport。`shell.read`按返回items顺序保stdout／stderr交错，不按流名重新排序；仅已验证的真实Job成功显示勾号；正常成功只显示成功，不追加退出码，非成功结果继续显示实际退出码，截断及部分输出提示保留。launch已受理、wait超时且仍在运行、stop请求尚待结束分别显示，未知、超时、失败与部分输出不冒充完成。审批原因在卡片内去重展示，不在工具行追加正文；已有部分输出的失败／未知仍保完整异常记录，未核实的最小Shell事实不冒充受理或停止成功。Shell局部inline-size containment阻止长命令将Radix的table内容wrapper撑宽，窄窗口的卡片和箭头仍在原阅读列内。

Main沿既有`toolMessages.list`的`commandOffsets`读取命令分片；新增可选`executionIds`，只允许与非空`messageIds`二选一，单次1–32项。运行中读取仅核当前scope已观察、同Store／Session活动Run中的Tool，再GET确切Execution及其原toolInput；known Shell@1从该原输入显示命令，不等待Model或Tool执行完成。已保存receipt同样核唯一原Execution与准确callId；有可见原调用时仍要求唯一、canonical定义及command／key与Tool输入一致，冲突不回退。Model尚未完整、未加载或公共预览省略调用，不再成为准确Tool输入可读的前置；普通Tool的parentExecutionId可为空，不能将其当Model来源。命令分片按UTF-16 offset在码点边界续读，每片JSON转义后UTF-8最多8KiB，命令本身最多262144码点，单批另设512KiB命令预算；原ask／images等元数据预算保持。fact的inputSource绑定原Store／Session／Run／toolCallId，renderer核read范围、准确Execution与定义、连续offset及字节预算，拼齐前仅给明确摘要，失败保已核兄弟项与原记录入口，不增IPC方法、正文reader或执行能力。

仅原receipt、准确Execution的结果content与structured details完全一致，且引用的Job符合原Store／Session／id、builtin.shell与shell.command@1时，Main／renderer才投影真实状态、输出、退出码与完整性；未来版本或畸形结果保原文。实时最小DTO不携大命令，metadata读取只影响对应项。原Execution与当前未封存的唯一同来源receipt共享Store／Session／Run／Execution构成的presentationKey；Conversation、逐项React key与阅读缓存共同使用它，避免live→receipt→metadata接管时卸载卡片或关闭详情。跨来源与封存记录不借此别名，原消息ID继续负责metadata、正文reader及文件／子Agent操作。metadata未到的已展开Shell保同一卡片和读取提示，不先闪原JSON再切卡片；无法核实时在同卡内保原记录。

`useNativeToolMessages`把实时输入与已保存receipt放在同一读取生命周期中，liveToolMessages只补准确命令／摘要，不用metadata旧status或approval覆盖当前View。queued、审批中、等待人工及执行中均可显示原命令；receipt接替前只沿同原Store／Session／Run／Execution／callId保留已核输入，不借状态、结果或控制权。匹配调用声明变化仍触发所属项重核，后来出现冲突先撤旧资格；Main与renderer都先统计同来源的所有匹配调用，再核唯一调用的完整性与格式，未完成或unsupported调用不能被过滤掉而隐藏重复冲突。重核回复不得恢复仍有冲突的命令；不按正文、思考或无关Model刷新重复读。实时命令分片期间若工具列表变化中断读取，未收齐项从首片重新读取，已收齐兄弟项继续复用缓存。补核失败仍保原记录和显式重试，不无限重读或借旧事实恢复资格。旧会话直接按原receipt读取，冷重开不需要重新提问、执行命令或保有live View。

子Agent只读详情不借主会话`executionIds`读取子范围，而在原`background.child.open`已核exact-child快照中附可选`presentation.liveTools`，复用原64KiB快照分页。Main对live及已保存Shell命令收齐8KiB片段，额外命令累计编码预算512KiB，超额仅保明确摘要、不提供全文复制。receiver核原child Execution、inputSource、定义／状态／revision与完整命令预算；拒绝foreign、future、partial及结果权限字段注入，快照刷新全量替换，已到receipt不重复挂live输入。共享liveToolMessages只补输入，原View审批／状态、目录／控制DTO、读取lease与逐项展开身份保持。

同一 Run 中连续的所有工具调用共用聚合，不以只读分类、Shell、定义版本或 metadata 是否到齐决定分组。`desktopTranscript` 为原 Run 的 Tool 消息提供分组身份，`groupNativeToolMessages` 再以 Run 和可读消息边界稳定该身份；第一项即使用聚合壳。Execution 已结束而历史回执尚未到达时保留该工具项，回执逐项或乱序接替、原 Execution 移出 View 近200项以及 metadata 补齐均不更换聚合容器与阅读开关。名称、状态、文件打开与子 Agent 导航仍分别核原身份，分组不补执行或权限事实。[native-presentation](src/native-presentation.ts)仅将`firstOutput=tool_calls`、当前预览为空、没有body或`contentBytes=0`且格式受支持的无附件模型声明投影为`presentation:hidden`；Conversation不让它形成可见行或分组边界。主View中的工具可以先于历史Model complete更新到达，该交接不再把原聚合临时拆开。非零body的空预览不设置此hidden标记，仍按原body reader合同处理；unsupported、附件、压缩和后来实际正文保持各自原展示。新阶段独立默认收起，展开后保每项原阅读入口；元数据未到的项逐项主动展开才挂载原记录，准确子 Agent carrier 仍直接打开原详情。未知版本的原始结果不进入收起标题。未核实只约束对应项；同组已核实的文件打开、交付文件和 PDF 页继续消费自己的原读取资格，不因兄弟工具缺 metadata 而撤下。摘要按已识别工具的动作去重组合，例如“编辑文件读取文件运行命令”，直接拼接动作，不加“了”或顿号，不显示总项数或成功完成计数；未知工具只概括为“使用工具”。标题后不追加数量、状态或异常文本；展开后的聚合整体最高400px，32px标题以外的列表最高368px并在内部滚动，列表项之间的纵向间距为0。聚合、工具异常／原始详情、Shell与文件差异沿共享ScrollArea真实viewport滚动并显示scroll-fade边缘提示，原region／键盘阅读与Shell跟随事件保留，PRE不再独立滚动；交付文件历史文本也沿共享viewport展示，原480px上限、分页字节offset与reader关闭保持。非工具区域沿原组件。执行失败或审批未通过的完整原因，只在点击对应工具展开后显示，列表和长详情支持键盘滚动。摘要不切换成最后工具的名称／路径；重新评估不计完成，失败、取消和结果未知分别保留。[运行期聚合 DOM](test/isolated/native-live-tool-aggregation-dom.test.tsx)覆盖这些交接、手动阅读和身份隔离场景。

2026-10-25，用户认为Shell阅读区偏矮，聚合总高上限从240px提高至400px；共享变量得到368px列表与252px组内Shell输出，列表间距0、多行Header、原生scroll-fade及手动阅读保持。成功Footer不再追加退出码，失败仍显示实际退出码，超时／未知与截断等事实保留。共享工具／页面两整文件37项／1088断言及UI／Desktop类型、定向Biome、文档检查通过。生产组件／编译CSS的Chrome155在浅1280／深780px全过程检查高度、首尾渐隐、手动暂停／滚到底部恢复、开合、完整输出及Diff尾部与11状态矩阵；实测400／368／252px，成功为“成功”，失败为“失败 · 退出码7”。`.cache/native-live-tool-aggregation-1y5wDz/report.json`记录3707样本／1036帧，页面错误0，已人工复看两类终态截图；此前240px及成功退出码0记录仅描述调整前版本。本次为隔离生产组件验证，未重跑完整安装版或模型执行。

2026-10-25，后续按用户要求补齐执行中命令、精简已批准状态，并调整完整多行Header。Main／Native工具与transcript三文件58项／1829断言、子详情两文件35项／298断言通过；最终共享工具／页面／阅读缓存三文件在新UI下复跑39项／1094断言通过。UI／Desktop类型、定向Biome、文档、边界、测试归属与diff whitespace检查通过，未变的身份／权限链验证按原范围复用。Chrome155实际组件／编译CSS与Main reader在浅1280／深780px核实时排队、自动及人工审批、执行、receipt接替、旧会话冷重开，17.9KiB多行命令始终保完整；匹配Model后到不额外GET，真实冲突与失败显式重试保持。已批准仅用14px盾牌勾，hover／真实Tab与Shift+Tab／Escape说明开关不改变展开或几何。最终Header无下边框、原始换行完整可见，输出单独滚动；不再有回到最新输出按钮，手动上滚停跟随、滚到底部恢复。聚合240px、列表208px及输出92px保持，超长Header、输出与结果末端均可滚读。原生scroll-fade-y在实际viewport测得首部仅尾fade、中部双端、末端仅首fade；五行Header高118px，输出滚动不移动Header。最终证据`.cache/native-live-tool-aggregation-QT1a2n/report.json`、`.cache/native-live-tool-aggregation-4Jnuzx/report.json`与`.cache/native-live-tool-aggregation-jeGw4G/report.json`共7240样本／2537帧、6窗口组合，浏览器错误／工具外逸／横溢／嵌套按钮均为0；后两份功能未受最终1px分隔线删除影响的范围复用，不把旧单行Header／回最新按钮记录当当前行为。已人工复看原生740×408深色卡片、审批提示与关闭、长命令尾、冷开结果。对用户旧窗口核实10:14旧Main缺命令传输字段，用户重启新Main后确认同一原会话恢复，不需要重新提问；此实际确认不外推完整安装版或全部模型时序。

2026-10-25，用户实际发现Shell命令缺失且正文停在JSON。对截图对应的已保存Tool／Model／receipt做只读复播，确认命令及输出存在，原调用完整时生产Service投影与Main核验可恢复命令和Job成功；Model仍incomplete时只返回最小Shell事实。旧缓存没有随原Model补齐重核。新增[Native工具DOM回归](test/isolated/native-tool-messages-dom.test.tsx)经Shell factory、canonical Model surface及真实NativeToolMessages，覆盖同receipt补核、原卡／展开、无关刷新、调用冲突撤资格、失败后显式重试、兄弟缓存与缺来源／未来版本。浏览器旧hook的`.cache/native-live-tool-aggregation-QrSaSx/`先复现同样失败：Model完成后仍只读一次metadata，Header仅Shell、正文JSON、结果未提供。修复后Chrome155浅1280／深780px的`.cache/native-live-tool-aggregation-37xhLG/report.json`记录1214样本／549帧，均恰两次真实Main metadata读取；第二次补齐命令、正常输出、成功与退出码0。手动Home后Tool及ScrollArea viewport保持原节点、展开不变、scrollTop为0，补核不闪回读取提示，聚合及输入区位置稳定，回到最新可读完整尾部；页面错误、工具外逸和横溢均为0，已人工复看深浅阶段截图。此前固定Header／240px上限及其他状态证据在未变范围复用；本次补足了旧九场景始终先备齐Model call的时序缺口。此为只读实际记录复播及隔离生产组件／metadata producer验证，未外推完整安装版或真实模型执行资格。

本次迟到调用修复的Main metadata、Native工具DOM及Native transcript DOM三个整文件56项／1713断言通过，其中真实producer新case先红后绿，最终43断言覆盖补核及失败边界。Desktop typecheck、定向Biome、文档结构／影响、边界、测试归属与diff whitespace检查通过；共享UI及Main／Job来源门禁没有变化，既有对应范围证据复用。

2026-10-25，按用户Shell参考及后续固定命令Header要求完成本轮卡片调整。macOS arm64／Bun1.4.2当前工作树：`bun test`沿共享工具聚合／页面／阅读缓存三个文件39项／909断言，Native工具／回执／运行期聚合三个隔离文件分别执行34项／775断言通过；Main原命令来源、分片与Job证明沿本轮先前67项Native相关测试中未变范围复用，UI／Desktop类型、定向Biome、文档、边界与测试归属检查通过。实际Chrome155沿生产组件及编译CSS在浅1280／真深780px核独立与聚合卡：Header32px，输出Home／回到最新前后Header完整box不动，原命令DOM全文准确且仅在Header，完整命令的复制控件可用；独立卡片宽740／529px，卡片、命令和箭头均不被裁切。输出自动跟随、手动保位、完整尾部、11种操作结果、240px聚合／208px列表／92px输出与13pxFooter通过。`.cache/native-live-tool-aggregation-bJVGAx/report.json`记录2776样本／639帧；Native审批精准复验`.cache/native-live-tool-aggregation-b18ZTr/report.json`记录570样本／249帧，拒绝原因仅一次，metadata等待无原JSON闪现，live→receipt→facts保持同节点、展开及卡片。其余8种Native操作／大命令分页复用`.cache/native-live-tool-aggregation-9PSDiV/report.json`的对应稳定合同；原`.cache/native-live-tool-aggregation-BZnXCH/`保留修复前卸载与丢展开证据。最终两份报告页面错误0；人工复看宽窄独立成功、深色聚合尾部、等待超时及Native等待→拒绝截图。此前独立窄卡内部裁切未被document overflow捕获，已增加viewport与row／card／arrow实际边界断言；不将旧4XeWpS图作为最终固定Header资格。此为隔离纯UI及真实metadata producer／受控bridge验证，未外推完整安装版或真实Service模型执行；测试岛未接宿主clipboard，不声明本轮实际系统剪贴板验收。

2026-10-25，用户将聚合整体上限从200px改为240px。沿共享高度变量同步得到208px列表、176px长异常／diff区域与100px聚合内Shell区域，列表间距保持0。生产组件／CSS浏览器在浅1280／深780px实测整体240px、列表208px、row-gap为0px；滚轮／thumb／键盘、首尾fade、长异常尾部及Shell／diff完整输出通过，审批矩阵复用前次证据。`.cache/native-live-tool-aggregation-r1AvKa/report.json`与`.cache/native-live-tool-aggregation-kZbiwW/report.json`共4423样本／1848帧、页面错误0；定向Biome、文档检查及diff whitespace通过。以下200px记录仅描述此前版本。

2026-10-25，用户再次将聚合列表项纵向间距从2px改为0。沿现有浏览器夹具定向复验几何、滚动与长详情，浅1280／深780px实测row-gap为0px、整体200px、viewport168px，滚轮／thumb／键盘和首尾fade、异常长尾可读及开合选择保持；审批矩阵沿前次证据复用。`.cache/native-live-tool-aggregation-oD3aSd/report.json`记录3063样本／1299帧、页面错误0。定向Biome、文档检查与diff whitespace通过；以下2px记录仅描述此前版本。

2026-10-25，用户明确仅工具聚合与工具详情统一接入ScrollArea和scroll-fade。工具聚合、异常／原记录、Shell、差异、交付历史及旧子工具过程均把region、焦点与滚动事件落在真实viewport，PRE只保原正文；共享fade默认关闭，不改变主会话等旧消费者。UI工具／页面／diff、轮次与原滚动生命周期五整文件46项／1777断言，Native工具／回执／运行期聚合三整文件31项／722断言，以及历史交付两项／40断言通过，共79项／2539断言；UI／Desktop类型、定向Biome、文档、边界与测试归属检查通过。历史交付核Unicode字节offset分页、回开头、关闭reader和准确文件打开，修正了原测试按裸文件名匹配旧按钮文案的选择器。

Chrome生产组件／编译CSS在浅1280／深780px核工具聚合200px、viewport168px、列表2px；滚轮、Radix thumb拖动、PageDown／End作用于实际viewport，首／中／尾的fade实测分别为仅尾部／两端／仅首部。`.cache/native-live-tool-aggregation-t1sOI4/report.json`记录8232样本／3440帧，覆盖长异常、完整尾部、13px状态矩阵与逐项开关。CSS长度百分比按实际viewport计算值解析，不用parseFloat误读min/calc。隔离生产SessionPage／ToolActivity／FileDiff测试岛的`.cache/native-live-tool-aggregation-kcmT4s/report.json`另有1286样本／516帧，核Shell跟随、手动保位／回最新、diff纵横滚动与末端；曾捕获聚合内256px Shell区域被168px外层裁尾，最终聚合内Shell区域按剩余空间限为60px，独立输出仍256px。真正深色测试岛截图核背景25/25/25、侧栏36/36/36，旧NEYR8D仅作为亮色几何记录，不计深色资格。原混合工具／390px过程的JfC6cU为3889样本／1599帧，空Model交接的1G0sRc为646样本／271帧，分组、选择、正文reader、阅读位置与输入位置均保持。四份最终记录页面错误0；人工复看长异常、Shell和diff尾部。此验证为受控bridge或纯UI测试岛，未外推完整安装版、真实Service模型执行或其他平台资格。

2026-10-25，用户将聚合整体高度改为200px、组内列表项间距改为2px。共享CSS通过`--tool-aggregate-max-height`约束总高，保32px标题与168px内部列表；长异常详情同时缩至136px可滚动区域，避免原320px详情超出新的阅读窗口。生产NativeDesktop／编译CSS的浏览器夹具在浅1280／深780px实测整体200px、列表168px、row-gap为2px，36项内容内部滚动；长失败与审批原因均能键盘End读到尾部，逐项开关、聚合重开选择和11种审批状态继续通过。`.cache/native-live-tool-aggregation-zWCH0k/report.json`记录5732样本／2777连续帧，页面错误0；人工核列表及长原因尾部截图。定向Biome、文档结构与影响检查通过；以下450px记录仅描述调整前的原版本。

2026-10-25，按用户要求精简工具审批状态：确认未派发的自动／人工拒绝及审批中停止不再附加未执行或重复停止，等待人工不在Shell详情重复；工具行附属状态统一13px辅助色，实际失败、超时与结果未知继续独立保留。共享工具／页面两整文件34项／787断言、Native工具整文件12项／180断言通过，UI／Desktop类型、定向Biome及文档检查通过。生产NativeDesktop／编译CSS的Chrome隔离bridge在浅1280／深780px核11种审批与执行组合，各自观察普通、悬停与展开过程；浅色辅助／异常色分别为rgb(102,102,102)／rgb(161,62,62)，深色分别为rgb(181,181,181)／rgb(224,161,152)，附属状态均13px，悬停和展开不改变其字号与颜色。`.cache/native-live-tool-aggregation-TxQ5jQ/report.json`记录5754样本／2786连续帧、页面错误0；标题无附加状态、无嵌套按钮和横向溢出，450px总高／418px列表、键盘滚动、异常长尾阅读与逐项开关保留。人工复看拒绝、等待和已批准后真实失败及两类独立未知截图。Native shell.launch不命中旧shell_execute输出组件，因此Shell footer去重由共享UI矩阵覆盖，不将该浏览器分支未命中当作资格；此验证未覆盖安装版或远程真实模型。

2026-10-25，按用户要求收敛聚合高度与异常阅读：标题仅保留动作、图标和箭头，不附状态或数量；失败读取、写入、Shell、未知工具与审批未通过的原因改为逐项点击展开。共享聚合／页面两整文件33项／489断言，Native运行期聚合／工具／回执三整文件31项／722断言，原轮次整文件22项／373断言均通过；UI／Desktop typecheck、定向Biome、文档、统一边界与测试归属检查通过。Chrome155的生产NativeDesktop／编译CSS隔离bridge在深浅1280／780px下核36项长列表，整体450px、列表418px；PageDown／End可读后续工具，长失败与审批原因的末尾均在对应详情聚焦后可见，聚合关闭与单项关闭均不泄漏原因，重新打开保留原阅读选择。`.cache/native-live-tool-aggregation-Jw0Sff/report.json`记录1426个样本、672张连续帧；1280／780／390px混合工具的`.cache/native-live-tool-aggregation-37zEM6/report.json`另有3917个样本、1607张帧，聚合标题无附加节点，工具不外逸、节点／阅读／输入位置稳定，页面错误0。窄窗逐帧曾捕获箭头旋转时越界1.76px，补足旋转边距后原断言通过。空Model交接沿本轮`.cache/native-live-tool-aggregation-KNyBaK/report.json`的630样本／263帧复验，无分组或正文读取回退。人工核长列表、两类完整异常尾部及窄窗过程截图；此证据不外推为完整安装版、远程真实模型或其他平台资格。以下旧证据仅说明各自原版本与范围。

2026-10-25，macOS arm64／Bun1.4.2，`bfdb6a273` 加本次连续工具聚合工作树：对运行期聚合、原轮次、工具适配与回执渲染四个完整 DOM 文件执行定向 `bun test ./apps/desktop/test/isolated/<原文件>`，51项通过；其中 Core compression 用例的本机 port0 绑定曾报 `EADDRINUSE`，单独复跑通过。导航新增混合组 carrier 与原完成子详情两项通过；导航全文件另两项 owner warning 文案断言在 `git archive HEAD` 基线上同样失败（预期“执行状态待核实”，实际“运行中”），未改断言。新回执回归核永久未核实兄弟项不会撤下准确文件按钮与已展开交付、失败读取没有文件动作，元数据接管保同一 DOM。UI／Desktop typecheck、定向Biome、文档、统一边界、workspace及测试归属检查通过。

动作摘要更新后，UI相关两文件27项及Native聚合／工具／回执、问答和子详情定向33项通过，UI／Desktop类型与文档检查通过。同日执行 [连续工具浏览器 runner](test/native-live-tool-aggregation-browser-runner.fixture.ts)，以真实 NativeDesktop 与生产编译 CSS 在 Chrome155.0.8059.86 的浅色1280px、深色780／390px检查首项、七类混合工具、旧Execution移出View、回执／metadata接管、开合、失败／取消／unknown、完成及缓存返回；1721个RAF采样、1580张连续过程帧，页面错误0，活动聚合节点、收起位置／高度、滚动和输入位置均保持；动作摘要可自然变宽，标题省略显示且展开箭头完整保留，没有组外工具。人工复看首项、缺View回执、混合失败与窄屏缓存返回。证据 `.cache/native-live-tool-aggregation-OKOnwy/report.json`；390px保标题及开合，完整状态可通过标题提示与可访问名称读取。此夹具的 fileTargets 为空，文件操作／交付资格由上述独立 DOM 回归覆盖；PDF的原读取与权限合同未改，本轮没有新做混合PDF窗口资格。未运行安装版Electron、真实模型或其他平台。

2026-10-25，按收起状态重新排查：旧夹具没有流式Model消息，并未覆盖View中的工具先到、历史仍是空incomplete Model的交接。新版[浏览器runner](test/native-live-tool-aggregation-browser-runner.fixture.ts)增加`KITE_AGGREGATION_SCENARIO=model-handoff`，覆盖无body和明确body0两类工具声明，以及非零body的空preview。`KITE_AGGREGATION_BASELINE=pre-empty-model-fix`只在隔离构建移除新增hidden投影，未回滚共享源码；修复前 `.cache/native-live-tool-aggregation-PVXixQ/report.json` 中36个Mutation／RAF／task样本出现两组→一组，工具B曾暂时在原聚合下方独立显示。修复后 `.cache/native-live-tool-aggregation-b8DcWW/report.json` 的645个样本、270张连续帧保持一组与原summary／标题／箭头节点，选区、阅读位置和输入位置保持；实际非零body经原SHA／字节／IPC reader显示正文，等待既有渐显结束后的截图确认完整可读；等待只属于测试观察，不增加生产延迟。新增同步Mutation和直接RAF采样后，1280／780／390px原混合工具三场景另3877个样本、1593张连续帧通过，页面错误0，证据 `.cache/native-live-tool-aggregation-MZ1AX7/report.json`。人工对照查看两组闪现、修复后收起交接和正文reader截图。

本次共享聚合、思考轮次、回复状态和阅读滚动四文件49项，Native运行期聚合与原轮次两个完整文件33项均通过；Native整文件含真实Core→HTTP回归，沙箱内port0绑定报EADDRINUSE后在允许loopback的沙箱外完整复跑通过。UI／Desktop类型、定向Biome、文档和边界检查通过。浏览器仍为生产组件／编译CSS与受控bridge，不外推为完整安装版或全部真实模型时序；本次未改工具源Model DTO或工具排序合同。

2026-10-24，搜索定义 v4 复用同一探索展示，v2/v3 历史继续可读。[运行期聚合 DOM](test/isolated/native-live-tool-aggregation-dom.test.tsx)逐阶段核 v3/v4 搜索＋读取从派发、settling、延迟回执和 metadata 接管保持同一节点与展开状态。同日 macOS arm64／Chrome155.0.8059.86 的隔离生产组件浏览器夹具已改用真实 v4 搜索定义，六组阶段覆盖两种 metadata 顺序、初次／切换、深浅主题、4／40轮及缓存返回；733张过程帧和171个正文可见 RAF 采样均通过原节点、顺序、几何、滚动及输入位置检查，页面错误0。人工核延迟占位、亮色搜索聚合及暗色缓存返回；证据在 `.cache/native-history-presentation-f4b6uR/report.json` 和帧目录。该证据为隔离组件与受控 bridge，不代表完整安装版、真实模型或其他平台；原 CSS 嵌套 keyframes 提示保留。以下旧证据仍仅覆盖其原版本及场景。

2026-10-23，搜索定义 v3 继续使用已知探索展示；历史 v2 保留同样展示，当时未知版本保守显示原定义；当前名称沿本节稳定ID规则，仍不按未知格式并入探索。准确已知搜索映射为共享 `search_content`，使搜索／读取聚合显示各自次数。新增运行期回归核搜索＋读取从活动、settling 无回执、逐项回执和延迟 metadata 接管始终保同一聚合 DOM 与手动展开；主会话与子详情沿同一投影，后者保留父草稿和只读范围。相关 live aggregation／transcript／navigation 整文件共56项1333断言通过，Desktop typecheck与定向Biome通过。

同次 macOS arm64／Chrome155.0.8059.86 的[隔离历史浏览器夹具](test/native-history-presentation-browser-runner.fixture.ts)改用真实 v3 搜索＋读取，六组覆盖两种metadata到达顺序、初次／切换、深浅主题、4／40轮及缓存返回。逐阶段截图与RAF帧核首次正文展示后消息因果顺序、DOM、几何、滚动／输入区位置保持，搜索聚合未闪回generic；六组均通过、页面错误0，证据在本机 `.cache/native-history-presentation-o4dtrD/report.json` 与帧目录。人工检查延迟读取占位和亮／暗最终聚合，未发现重复或跳位。本次仅为隔离生产组件和受控桥接验证，不代表完整安装版、真实模型、其他平台或所有实时推送分段资格；原嵌套 `@keyframes` CSS编译提示保留。

[Main 与有限 IPC](test/native-tool-messages.test.ts)、[正式 caller 路由](test/native-caller.test.ts)、[原工具 DOM](test/isolated/native-tool-messages-dom.test.tsx)和原[源码外窗口](test/isolated/native-bundle.test.ts)分别核关联、作用域、原交互和真实执行／Files读取失败及冷读；准确输入和结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原工具过程与结果阅读)。轮次阅读、聚合与已知 Ask 回执的后续接入见下一节；自动审批历史、完整 PC、安装版全路径及其他平台资格仍未闭合。取舍见[工具消息观察决定](../../.agents/notes/implemented/architecture/2026-10-08-native-tool-message-observations.md)。

原Native整窗口夹具只对准确尚未处理的pending卡要求“等待人工审批”，同一write行必须在原loop剩余期限内完成该文案后再核原断言；已提交的同一卡仍可见时不要求工具倒退到pending。此前完整默认暴露该重复／提前观察的可达错误，原红未保存失败时完整text/status，不能称唯一现场因果。生产renderer／Main／审批行为保持，原96条完整assert及顺序、whole文件bytes和10／45／120秒预算均保留；原三driver整文件1pass／13Bun断言／82.859秒，正常退出、双锁、冷正文和启动诊断均通过，具体证据与新完整默认收束归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11macos-mcp-失败建立与完整连接恢复)。

## 原轮次阅读、聚合与问答回执

[native-transcript](src/native-transcript.ts)把已核实的公共 Run 接入原 [Conversation](../../packages/ui/src/desktop/Conversation.tsx)，保原过程折叠、最终回复、失败行、工具聚合与会话阅读状态。SessionPage 的 `renderMessageContent` 只替换正文、`renderToolActivity` 接完整分组与原展开控制；外层布局和复制按钮仍归原组件。正文继续使用原 ModelOutputMessage，子详情沿原只读 reader，不以子日志重建轮次。

压缩行的热进度与持久记录按 Store／Session／Run／Model Execution 使用同一 `presentationKey`，只控制原 MessageGroup 的 React 身份，真实 Message ID 与正文读取、复制身份不变。[Main](electron/native-caller.ts)从同一 View 的真实压缩 Message 提取空正文的最小状态事实，经原 selection 生命周期交给 transcript，补齐独立 history GET 的交接空隙，并按原 seq 插回。有限 View 不删除完整历史，已保存的 completed／failed／cancelled 不被旧 View 的中间态回退；同一 Run 的下一次压缩使用新 Execution 身份。普通同选择刷新暂时清空 controller snapshot 时，Main 沿原 lastView 保留热压缩的只读显示，Native 不再按读取 loading 二次撤掉进度；真实观察／权限失败仍撤销热指示，动作资格始终等待新读取。没有新增显示缓存、摘要正文读取或操作权限。[交接 DOM 回归](test/isolated/native-transcript-dom.test.tsx)核三阶段热行、View 终态先到、新正文先到及历史接管时行与 Turn 节点保持、顺序、去重、旧状态不回退和跨身份隔离；[Main 回归](test/native-caller.test.ts)核摘要及正文描述符不进入这些展示事实，并阻挡普通刷新核保留进度、真实刷新失败核撤销；[导航 DOM 回归](test/isolated/native-session-navigation-dom.test.tsx)在同选择多次刷新时核原行和运行文案不变、真实权限失败后移除。Core 的快照连续性由[压缩 owner](../../packages/agent/src/storage/sqlite/context/compression.README.md#会话消息中的压缩身份)负责。

2026-10-23，普通 macOS arm64／Bun 1.4.2 Native 候选、`8a8458800` 加本次工作树，压缩显示专项回归 17 整文件 189 项／3035 断言、八 workspace typecheck、边界、同源 API、测试归属、Biome 和文档检查通过。真实 `deepseek-v4-flash`／chat-completions／medium／4096 的父压缩专项 `dist/acceptance/parent-compaction-stability-live-window-20261023-c492861a.json` 通过：15 次 HTTP 200、278 帧；144 个压缩行采样始终同一 DOM 节点和 32px 高度，仅由“正在压缩上下文”转为真实“上下文压缩完成”，无空档、重复行或旧状态回退。原父 Turn 保留两引导，最终中文按后条采用 Blue 并含两码，冷重开零新增请求或业务记录。该 profile 明确不触发子压缩，不能代替完整父子压缩验收；它验证此前真实样本 `d95a430e` 中 20ms 缺行及约 63px 高度跳变的显示修复。

同日完整父子场景 `dist/acceptance/parent-child-compaction-live-window-20261023-f601c98d.json` 通过，非 Markdown 输入 4591 个，工作树 SHA-256 为 `88a36b91c5897a416abae6f07524be1068e338be168323e94498f81160a112cd`。16 次真实 HTTP 均为 200、37 张阶段截图及 359 帧覆盖父结束后的条件续跑、本轮原邮箱接入、子真实自动压缩与一次完整读取、两条原 UI 引导、父真实自动压缩、最终折叠／展开及冷开。父压缩的逐帧／DOM 监视四项检查无错误，原节点从 running 到真实 completed 保持 32px，无重复、缺行或旧文案回退；最终仅一段“用时37秒”。子最终保留独立初始指示码并完成待发邮件，未将内部维护说明变成新任务，也未因原回执退出窗口重复读取。父后继请求独立保留两条完整原引导，最终中文保全部码并采用 Blue；冷开零新增 Provider／Run／Execution／Command／Source／control，两个普通窗口正常退出、所属进程无残留。上述候选均关闭诊断，真实响应只经透明时序门延迟，未改写内容；资格限本机 macOS 和这次真实模型响应，不外推任意模型或完整发布。

当前原消息的 `inputKind:input.steer` 与准确 Run 一起投影给 Conversation，使本轮用户引导保留原 MessageItem、完整正文和定位顺序。引导正文在思维链之间按原位置展示。首条输入、后继轮首条输入和缺少原类别的历史消息保留独立展示。原 [Native 提交](src/native.tsx)沿准确本地 steer intent／targetRunId 保留发送占位的轮次归属，由 `savedNativeInput` 接管已保存的消息；failed／unknown 的恢复入口继续可见。

压缩后的引导保留由共享 [Context owner](../../packages/agent/src/storage/sqlite/context/compression.README.md)负责，Native 不另存指令。2026-10-23，同一 macOS arm64／Bun 1.4.2、`8a8458800` 加本次工作树，普通 Native／真实 `deepseek-v4-flash`／chat-completions／medium 验证通过：两条 UI 引导后完整读取 182 行材料，生产 24000-token 阈值在同一父 Run 自动压缩；覆盖上界 19 包含引导序号 16、17。压缩后实际 ModelInput 独立保留两原 Command 的完整正文各一次，最终中文回复保留两核验码并按后条要求采用 Blue。15 次真实 HTTP 均为 200，35 张阶段截图与309帧保存在 `dist/acceptance/steer-compaction-live-window-20261023-c21e94a7.json.workspace`，报告为同名去掉 `.workspace` 的 JSON。实际检查受理／原消息接管、压缩进行中、后继请求、完成和冷开；149 个含引导的过程帧始终同一段、无过程外引导或重复。冷开零新增 Provider／Run／Execution／Command／Source／control，两次窗口正常退出且所属进程无残留。此前一次窗口驱动未提交 active 原任务，只执行6次 idle 请求，未取得压缩资格；修正普通 Enter 单次提交及实际受理检查后才取得上述通过结果。此证据限该本机候选和真实模型。

2026-10-23，macOS arm64／Bun 1.4.2，`8a8458800` 加本次工作树：[普通真实窗口 runner](../../tests/e2e/live/model/collaboration-unified-native-window.live.ts)使用 `testDiagnostics:false`、现有 `deepseek-v4-flash`／chat-completions／medium／4096，通过13次实际HTTP 200。两条多段引导从普通输入框发送，先受理再由原检查点应用；原 Command／Message／Run／selection、完整正文和准确来源逐项核对，下一份真实 ModelInput 及 Provider 请求各包含两条原文一次，原父 Run 的最终回复含两条核验码。28张阶段截图、174帧、canonical正文与回执保存在 `dist/acceptance/steer-process-live-window-20261023-3a9e5d9f.json.workspace`，报告为同名去掉 `.workspace` 的JSON。发送、接管、后续模型、完成与冷开相关41帧始终只有原父一段过程，无过程外引导或重复；实际检查了草稿清空、发送占位接管、终态默认折叠、展开原序全文及再次收起。`16-complete-steer-collapsed.png` 显示单个“用时10秒”和过程外最终回复，`17-cold-steer-1-expanded.png` 保留重开后的完整引导。冷开零新增Provider／Run／Execution／Command／Source／control，两个窗口正常退出，准确所属进程无残留。UI／Native及原首条输入接管七整文件117项／3007断言、八workspace typecheck、同源API、边界、测试归属、Biome与文档检查通过。该结果限本机普通候选与上述真实模型；时序门只延迟真实响应，不生成或改写模型内容。

Native 主会话由 [desktopTranscript](src/native-transcript.ts) 按原 Run、Model 和工具 Execution 投影思考、正文与工具，再由 [ConversationTrace](../../packages/ui/src/desktop/ConversationTrace.tsx) 绘制。模型派发和工具回执交接可更新原 Trace 标题，其临时状态不占展开步骤。并行工具使用当前范围内观察到的启动顺序，已有步骤替换为保存结果时沿用展示身份。“正在回复…”消费准确当前 Model 的流式正文事实，终态或执行权无法核实时停止活动提示。用户引导、Agent 来信、重连与异常仍按原顺序出现在各自轮次。

[思考详情](src/native-reasoning.tsx)仅在手动展开时读取原消息的公开模型输出，沿 [Main 的模型输出租约](electron/model-output-reads.ts) 核对原 Store、会话、Run、Execution 和正文完整性。切换或收起结束当前读取；已显示的同源思考在短暂校准期间保留。工具摘要按已核实的动作归纳，文件新建由原 `builtin.files` 结果确认，Shell 详情继续调用原 `ShellOutput`。只读子详情继续使用既有流程。

Native 的侧栏打开入口对当前父会话及同一在途选择去重，重复鼠标点击和 Enter 不重新发起 `select`、撤销历史读取或重建消息。子详情通过右侧栏标签打开，点击当前父会话不会关闭详情或重新选择父会话；准备页及定时任务页仍恢复原会话；选择其他目标和显式恢复读取保持原流程。[首次呈现回归](test/isolated/native-history-presentation-dom.test.tsx)核重复点击的请求数量、消息节点、滚动和展开保持，以及在途目标复用。

初始没有已选会话时，`selectionHandoff` 同样参与聊天加载判断，覆盖目标 `select` 确认和模型准备，再由 `NativeHistory` 的加载阶段接续；不能因 `selection` 尚未到达而提前发布 Conversation 空状态。[新对话 DOM 回归](test/isolated/native-new-conversation-dom.test.tsx)分别核已有正文与真实空历史，延迟选择、模型及历史读取并穿插状态刷新；完整历史到达后才呈现正文或实际空状态，原首次发送的待定消息交接仍保持。

首次挂载未缓存历史时，Native 将历史扫描及影响分组的 Run／Tool 首次读取标为 `initialPresentationPending`，原 Conversation 在首次可读提交前保留加载状态，随后一次显示完整轮次／工具布局。已核分组展示缓存可以直接使用；文件目标、图片、大正文和用量不加入结构等待。查询成功但缺少事实正常发布原文，历史／权限／结构读取失败保留原文和原恢复，不靠猜测终态或工具类型获得布局。首次输入与待定输入沿原即时展示，不等待历史接管后的结构读取。首次提交后的同一 Conversation 不再因该标记隐藏内容，流式更新、history epoch 校准及缓存返回保留原节点、阅读位置和展开；新事实或失败恢复仍按实际状态更新。发送、停止、审批和新读取继续等待当前完整scope资格，展示缓存不恢复操作权。[首次呈现回归](test/isolated/native-history-presentation-dom.test.tsx)核两种结构到达顺序、缺失／失败、缓存返回及epoch校准；[活动回执回归](test/isolated/native-tool-receipt-render-dom.test.tsx)继续验证运行中延迟工具信息的折叠原文保护。

[轮次分组展示缓存](src/native-transcript-display.ts)沿原NativeDisplayCache预算，仅在同一bridge对象、generation／Store边界及准确Session／Workspace／historyEpoch内保留已验证grouping。metadata加载期间，完整消息与已核全文回复的全部字段仍相等时才复用；正文、来源或附件变化不命中，真实历史／Run／Tool／文件读取错误或非加载期权限不可用撤销对应项。非加载且完整时才更新缓存，`turnActivity`始终取当前fresh transcript；缓存不保存读取lease或操作资格，当前viewSelection的读取门禁保持。

首条输入经 `savedNativeInput` 核实保存后，仅在当前窗口记住所属 Store／commandId 已由历史接管；后续冷读暂时没有该 Message 时，不重新插入旧占位或永久豁免首次分组等待。原 `firstSubmission` 的未知结果查证、失败重试及草稿／附件处理仍保留。[首条输入回归](test/isolated/native-new-conversation-dom.test.tsx)核创建并保存、离开、history epoch 清除非当前缓存，再返回时分别延迟历史／Run／Tool的完整链。

提交前 review 发现并补齐上述首创会话冷返回边界：新增用例在历史仍被阻挡时复现旧占位提前出现，修复后1项／24断言通过；同一首条输入整文件69项／1317断言通过，原延迟接管、未知查证、失败重试及草稿隔离保持。

当前 View 的真实 Run 可直接用于展示；完整历史超出近200项时，[Main](electron/tool-messages.ts)只接受当前已经观察、未带 `originMessage` 的 Message ID，每批32项，经当前生成 Client GET 核准确 Run ID／Session 和前后 Store 连接。结果仅含原出处、状态与时间，按原 generation／viewSelection／history epoch 绑定；关闭和切换只释放所属 GET。当前 Store 已保存的旧 Store 终态 Run 可作为历史事实展示，保原 `originStoreId`；foreign active 不进入活动轮次或控制。Fork／Include 的封存 Message 不查询来源 Run 后来的状态，也不据此标最终回复。

同一 bridge／generation／Store／Session／Workspace／viewSelection 内，history epoch 刷新会重新核历史 Run；此前已核的 inactive completed／failed／cancelled 仅保留轮次展示，使等待新 metadata 和分批返回时不会暂时拆掉原 Conversation 节点或用户展开的过程。此展示层不填入新 epoch 的读取缓存，也不减少原 GET；已核的新 View 和新 metadata 替换旧事实，明确缺失删除旧展示。当前 View 同时更新该 scope 的 metadata，避免 Run 离开有限页后被较早结果覆盖。active／interrupted 不跨 epoch 保留，换任何展示身份即撤销；大正文复制和所有动作仍沿当前原身份与 authority 核验。原 DOM 文件5pass／80断言核节点、展开保持和新事实／缺失覆盖；原完整历史窗口的75秒资格与完整默认回归仍以[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)为准。

没有 `outputBody` 的普通历史正文按 generation／viewSelection／Store／Session／Message 的 inline 身份保持组件，不因 epoch 重新挂载相同 Markdown；当前文件回调有无仍随核验状态变化。带 `outputBody` 的组件保原 epoch key，完整读取、关闭、换 scope 的撤销仍沿原边界；inline／body 分支切换同样重新挂载。共享正文身份仅按原八项字段 memo，任一字段变更仍清理原已读结果，不以展示组件保持借用旧全文或动作许可。

只有已确认 completed 且非活动 Run 的最后一条完整、支持格式、无工具调用且后面无工具结果的助手消息才成为最终回复。原起止时间与终态供原组件显示耗时／失败／停止；无法核对时保原消息，活动视图失效显示“上次确认状态”，不补造成功或计时。最终回复资格与正式 Web 共用纯 [completeRunReplies](../../packages/ui/src/run-reply-copy.ts)；Native 显式选择 `copyScope=final`，保[桌面手册](../../docs/handbook/clients/desktop/README.md)只复制完整最终回复、不含同轮工具前说明的合同，Web 整轮范围不扩到 Native。大正文预览的 `copyText=null`；仅最终段原 reader 已验证并显示的准确正文启用“复制本轮Agent回复”，关闭正文、换消息身份或换scope即撤销。本地 Map 只持有当前已显示内容，不写持久日志或格式。

同一准确 Run 中相邻、已核实的 Files read2/3/4、glob2、search2/3、list1 交原组件视觉聚合，正文／独立工具仍构成边界。每项文件按钮保自己的 Message 和原 receipt 观察 ID，经 Main 原文件端口核当前项目、普通目标与 frame；分组不共享文件权限。当前人工审批文字只来自同一当前 Store／活动 Run／Execution 的唯一真实 pending Interaction，实际回答仍沿原 InteractionCard 和公共提交链。

默认 `ask_user` v1 的历史回执沿原成功 Execution／准确结果读取；唯一原 Model call 提供 q1–q3 的实际问题，回答保原人类选项标签与自由文本。`{cancelled:true}` 显示“已取消回答”，工具仍按实际 succeeded，Run 可继续；这不是停止任务。缺原请求不补问题，未来版本只保原文。原审批的当前接入见下一节；原记录另由[交互历史](#原交互记录只读历史)读取，所有封存／恢复组合及完整 PC 核对尚未关闭。

恢复为新 Store 后，原源会话和封存 Fork 的已回答记录继续交原 ToolRow 展示。Main 核已观察 Message 的唯一原 Execution、原 Session／Run、明确封存的 Store 及终态／准确结果；原问题只从同一原 Store／Session／Run 中唯一较早的 Model call 取得，不把当前准入 Store 当作原出处。封存记录不读来源 Run 的后来状态，也不提供原授权或回答入口；当前活动工具与回答资格仍由原独立入口控制。恢复后的封存 Model 用量同样只核原成功 Execution，不借来源 Run 的后来状态补历史。

[安装版问答回归](test/isolated/native-restored-questionnaire-bundle.test.ts)使用默认 installed Main／Service／preload 与原 Questionnaire，保存一次选项和完整 Unicode／换行自由文本，再明确 Fork、退出并通过包内 CLI 备份恢复为新 Store。三个真实 macOS 窗口核源会话／分支的原问题、答案、Message／Execution／Run／Store、首次与冷读及切换清理；原回答 POST 仅一次、Provider 两次，读取 POST 与封存来源 Run GET 均为零，三次 Service 普通退出及双层 EX 可取。当前结果为 1pass／24Bun断言及全部 Node 流程／79.14秒；[Core 冷出处](../../packages/agent/test/isolated/context/restored-origin.test.ts)、[投影](../service/test/message-response.test.ts)与上述 Main／原 DOM 提供各自范围的证据，准确输入和失败归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后已保存问答回执)。本片不扩展取消回答、审批、通用交互历史的全部恢复组合或完整 PC 资格，公共 schema、原 UI 与持久格式保持。

取舍见[轮次展示决定](../../.agents/notes/implemented/architecture/2026-10-08-native-run-transcript-presentation.md)。[Main／有限 IPC](test/native-tool-messages.test.ts)、[正式 caller](test/native-caller.test.ts)和[原 Conversation DOM](test/isolated/native-transcript-dom.test.tsx)核身份、所属读取、原展开／复制及问答；原[源码外 macOS 窗口](test/isolated/native-bundle.test.ts)核首次和冷读的折叠、展开与准确最终复制，保原预算和退出断言。实际执行输入与结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原轮次阅读聚合与问答回执)，有限展示证据不代替完整恢复、其他平台或整片独立审查。

## 会话消息渲染验证

2026-11-14，Windows x64／普通 Electron 44.3.0，使用隔离 Profile、配对 Service、真实 SQLite、Files 和 Git Bash，模型流由本机 Provider 控制。两轮依次覆盖先思考后工具、先工具再思考再工具、Shell 非零退出、实际创建文件、正文接管、切回及冷重开。159 次有效画面或 DOM 变化和 12 张节点截图保留在本机 `.cache/turn-trace-window-8b50ac07-2643-4a8b-b123-f3fcf07a9144/conversation-observations.json` 及同目录。两条 Trace 的标题在各自运行周期保持原节点和 32px 高度；接近一万像素的已展开思考保住原视口；Shell 保留同一个 256px 输出视口、退出码 7、stdout、stderr 和手动滚动位置。流式与完成共用原 28px 信息栏；冷开两条折叠记录，Provider 调用数仍为 5。这是本机受控模型的实际窗口记录。

同环境复验图标时，逐段核对思考、文件读取和 Shell 的行首图标，以及多步完成摘要的流程图标。标题随工具切换仍保留原节点和 32px 高度。过程记录及截图在本机 `.cache/turn-trace-window-5db81347-0280-47a3-bdbc-14fced9d2424/`。

同环境用深色实际窗口复验行对齐。思考、文件操作与 Shell 在展开、正文接管和切回会话时共用相同的图标与文字横坐标，行高均为 32px。手动展开 Shell 后仍可在原输出内滚动，失败只给标题文字上色，退出码沿用原输出卡。两轮过程记录及 12 张截图在本机 `.cache/turn-trace-window-5e331c0a-9bc0-4e83-be8c-17c3d2544a3d/`。

主会话正文左侧的消息导航与正文共用当前会话的阅读窗口及输入展示身份。界面与滚动集成由 [UI owner](../../packages/ui/README.md) 维护，用户操作见[桌面手册](../../docs/handbook/clients/desktop/README.md#会话与操作)。

2026-11-13 在 Windows 11 x64 的 Electron 44.3.0 安装候选 `f436bd3ca3e574a2ae629e9d24d71ee928fe3eddc98c53951b555532f6541a69` 上，以独立安装登记与 Profile 打开八轮已保存对话。实际点击第 4 和第 1 条刻度均跳到对应输入；滚轮越过第 5 条输入的顶部阅读位置时高亮从 4 变为 5，反向滚动恢复到 4，点击“回到最新消息”高亮第 8 条。窗口与配套 Service 正常退出，隔离安装已卸载。本机证据位于验证工作树 `.cache/message-markers-installed/`。

2026-11-05 会话首开渲染由 [Native renderer](src/native.tsx)的同一状态帧持有已提交选择、草稿、模型准备结果与准备页归属。导航意图立即撤销旧资格；冷目标先准备准确模型与首次保存草稿，再一次提交输入区，避免空草稿、旧会话草稿或模型占位被中途绘制。新对话返回原会话也走接管，迟到结果按 generation／Store／view intent 拒绝。相同会话普通读取保留已观察事实，真实失败撤销；审核方式不再另存标签缓存。正文仍按目标展示身份立即恢复原有界缓存，未命中显示原加载状态，不借旧正文填充。历史与可选指标继续独立读取，不让慢指标阻塞停止任务。共享控件的读取门禁与业务禁用见 [UI owner](../../packages/ui/README.md)，取舍见 [渲染帧 Note](../../.agents/notes/implemented/architecture/2026-11-05-native-session-render-frame.md)。

本轮 Windows x64／Bun1.4.4／Chrome156.0.8078.80，隔离生产组件与编译CSS在深浅主题、500／800／820／1280／1920px覆盖首次目标、逐路延迟、快速连切、准备页返回、活动／终态与暖缓存：24组连续8265份RAF状态与4965张合成帧，过程原图及接触表核对未见输入节点缺失、旧正文串入或重复消息。另核已选模型、允许发送的新对话四组（1511份RAF状态／1003张合成帧），暂停期间发送与编辑器opacity始终为1但实际动作被禁用；200次返回的192份暂停帧、8组长历史与阅读位置恢复（1442帧），以及810／820／830px六组缓存率0—100%的固有宽度；普通读取不触发控件灰暗来回，业务空发送与真实失败仍禁用。原图、过程和索引归本机 `apps/desktop/.cache/session-first-switch-audit/`，会话样式范围由原全页runner的隔离会话段派生，未将无宿主确认框及过时诊断文案的原整文件计为通过；原生确认分别由确认owner测试核实。

[壳层](test/isolated/native-session-shell-dom.test.tsx)19项、[模型](test/isolated/native-model-picker-dom.test.tsx)33项、[编辑器／读取门禁](../../packages/ui/test/isolated/prompt-editor.test.tsx)9项全部通过；确认、历史、环境停止、页面五文件53项及环境／Agent／模型浮层三文件11项通过。新对话整文件78通过、3条既有异常可见文案断言失败：HEAD Native producer加未改动的异常展示同样复现，基线材料在本机 `apps/desktop/.cache/baseline-failure-check/`，本轮没有改写其断言或宣称整文件通过。UI／Desktop类型、定向Biome、文档结构及影响、统一边界和测试归属通过。证据仅覆盖隔离renderer及模拟桥，不取得完整Electron安装制品、真实Service或其他平台资格；未请求真实模型。

### 本次全量失败修复

2026-10-27，macOS arm64／Bun1.4.2／Electron44.3.0／Chromium152.0.7977.78，原[多会话完整窗口回归](test/isolated/native-multi-session-stream-electron.test.ts)沿原runner、隔离HOME／Profile与生产制品完成：4个父会话、12个子会话、16条实际流及120次切换，1项／5条Bun断言、driver内原全过程断言通过，83549ms正常退出并确认所属进程清理。明确选择ready模型、私有草稿、准确父子正文、旧scope不混入、读取取消不停止业务、零新增Provider调用、准确父树和单子停止、剩余流继续及最终结算均保留；使用受控固定Provider，不代表真实付费模型或其他平台资格。

同一原负载的普通构建对照中，限定来源前有81个≥50ms长任务，限定后为0（原门槛少于12不变），切换P50／P95为397／589ms。暖态时间线曾记录单次样式重算85–101ms、涉及约2万个样式元素；当前共享绘制按每个文字来源限定`:where`规则，保持逐字素、240ms渐显、18ms普通间隔及420ms整批上限。StaticRange与同Document先读色后绘制也保持原完整Text／选区，不通过降载、分组渐显或修改后台节流取得结果。相关单机微基准的两次阴性结果不足以代表Native结构，最终修复以原实际窗口对照为依据。

缓存仍沿原8项预算和完整成本扫描准入。实际保留链定位到旧渲染闭包捎带旧entries Map及空portal，entry回调改为只捕获原retire函数、准确key和entry。检查点按准确root、唯一container和唯一TICK核已拥有的追加正文；结构节点从483到672（增189，原400限额），监听器970到968（原30限额），没有排除未知或重复树、扩大缓存或丢弃正文。原始失败、暖态trace、API分步记录、阴性微基准与通过日志保留在本轮本机`.cache/full-tests-fix-20261026/`及对应隔离测试证据中；完整全仓结果由当前整体runner记录，局部通过不覆盖未取得的发布／平台资格。

本轮相关原caller／recovery、context／compression、grants／models／drafts／sessions、extensions／Job输出／bundled Files、交互／问卷／历史／恢复／reasoning、Provider／实时权限及协作窗口，均通过原完整文件定向回归。夹具沿实际菜单明确选模型、准确冻结binding、同隔离HOME与fresh权限观察；保原完整字节／SHA、准确scope和ID、冷查回零业务重放、终态和lease／所属进程清理，未新增普通客户端诊断入口。Native产品与共享UI的本轮实现说明在本文和[UI owner](../../packages/ui/README.md#markdown-消息内容)，历史日期的验证记录保留原事实。

### 大会话首次构建

Native 的页面缓存路径为[共享 Conversation](../../packages/ui/README.md#原桌面展示层)开启按消息加载。首次可见分组超过100条挂载末40条，上滚每次补20条；不超过100条完整显示。仅已加载内容参加全选，每条回复完整渲染。各段思维链在首次展开时才构造明细，Native 消息 EOF、首次轮次与工具事实、正文读取和操作资格仍由原 owner 核实。

[独立初始渲染夹具](test/initial-render-performance-browser-runner.fixture.ts)运行实际NativeDesktop与生产CSS、隔离NativeBridge，正文已随Message就绪；测量可信click到CDP PNG合成器首个可读帧，另记DOM就绪、loader退出、最长任务、可信输入往返及切走时序，不把DOM出现或RAF当作绘制。它不代表真实Main／SQLite、自动全文读取FIFO、完整安装版或跨平台性能。私有探针只存在于测试构建。

本轮曾采用完整历史隐藏分批构建，保留其历史证据：[原决定](../../.agents/notes/archived/architecture/2026-10-26-desktop-initial-render-staging.md)。2026-10-26，macOS arm64／Apple M4 Pro14核、Bun1.4.2、React19.2.7、Chrome155.0.8059.86 Headless／1440×800，基线`2777f7b81`的production600轮首个可读帧1066ms、最长任务995ms；dev为1229／1120ms。首轮分批构建将峰值降至273／392ms，但首读增至3169／5519ms，高频更新dev样本约24秒；单条600章节后来曾达到13–14秒。用户随后确定改为消息级按需加载，本轮不再使用完整隐藏构建或正文根块分片。历史报告为本机`.cache/initial-render-prod-wAx4yZ`、`initial-render-dev-liUf3w`、`initial-render-prod-QkF0Jp`、`initial-render-dev-HgmjKJ`、`initial-render-dev-1vJ043`、`initial-render-prod-PR3MEc`与`initial-render-dev-FaNLSI`，不得作为当前窗口实现的性能资格。

当前窗口策略、折叠工厂和原生滚动条取舍归[按消息加载Note](../../.agents/notes/implemented/architecture/2026-10-26-desktop-progressive-history.md)。单条回复仍可能形成同步大任务；此限制由用户选定的“每条完整显示”边界保留。

2026-10-26最终消息窗口，环境与上述基线相同（macOS arm64／M4 Pro14核、Chrome155、1440×800、diagnostics=false）。以下为可信click到实际PNG首个可读画面的单次样本，历史EOF完整读取360／1200条，而初屏仅挂载40个entry、40条消息、1703个元素，不能把它等同于全历史已进入DOM：

| 构建／历史轮数 | 首个可读帧 | 首读前最长任务 | 最大可信输入往返 |
| --- | --- | --- | --- |
| production／180 | 89.57ms | 未记录≥50ms长任务 | 53ms |
| production／600 | 118.77ms | 61ms | 78ms |
| dev／180 | 115.46ms | 64ms | 67ms |
| dev／600 | 129.37ms | 73ms | 76ms |

对应`.cache/initial-render-prod-Ip7Ehj`、`initial-render-prod-7cBR5a`及`initial-render-dev-ZzN4em`（均位于本机`.cache/`）保存源码hash、时序、逐帧PNG和window journey。已逐阶段复看加载、末轮首次呈现、上滚与手动阅读、回到最新；40→60→80保原节点和锚点，600轮production两次补入最大位移0.0625px，manual追加0px；其余组均≤0.5px。仅已加载内容全选、到底连续追加3轮、全新running Run流式到完成、manual窗口不挂载新尾部及跳回最新均通过。

持续40ms刷新metadata／80ms尾正文的600轮样本，production首读105.66ms／最长53ms，dev129.82ms／74ms，0个正文落后于已提交输入的可读帧；夹具在首读后继续至少3次真实增量，不为凑更新延迟首读。报告为`.cache/initial-render-prod-UXM2uM`与`initial-render-dev-PZ2qsY`。普通冷开40ms后发送可信切走请求，production点击排队52.40ms／切走到Small实际绘制75.02ms，dev38.60／69.00ms；完整first与cancel两场分别见`.cache/initial-render-prod-Wz5zoi`和`initial-render-dev-xj8G42`。held旧历史后切走再释放的独立场景保新页面，见`.cache/initial-render-prod-ra1Yau`，不把held无渲染的时序替代普通冷开取消。

阈值浏览器场景中100条全部挂载，后续跨100保已有内容；102条冷开40条，见`.cache/initial-render-prod-PoW2Lq`与`initial-render-prod-JI4M9f`，101边界另由真实Conversation DOM回归核对。20个工具／轮的6轮共有132条原始记录却仅12个entry，未启窗口且折叠过程0次完整工具结果／source-input读取；60轮1320条原始记录／120entry则初挂40条，首读173.78ms，同样未提前全文读取。报告为`.cache/initial-render-prod-aY7t4H`与`initial-render-prod-W3aU9M`。单条600章节仍完整挂载，首读1251ms、最长任务774ms、最大可信输入往返1214ms，途中切走排队1199ms，见`.cache/initial-render-prod-brkrle`；此边界并未取得无阻塞资格，也没有保留此前13秒的正文分片构建。

原100次热切换门槛P95≤32ms保持。最终Chrome production／dev分别21.510986／30.549805ms，Electron production／dev分别18.933105／31.452881ms，四组均100次、errors为空；报告为`.cache/session-cache-performance-production-JjRRZE`、`development-TpEeQ6`、`production-vmt3hd`、`development-pJ3XUv`（后三个同属`.cache/session-cache-performance-`前缀）。较早完整暂存实现的Electron dev32.186035ms失败样本`.cache/session-cache-performance-development-pCZqoX`仍保留，不能用四舍五入称其通过；上述是改为消息窗口后的新源码资格。

原生布局补充以最终production制品验证首次可见及首次隐藏后显示两组：overlay实际占位0，正文／输入区中心一致，PageUp与可信滚轮正常，宽代码及32列表格各自横滚120px而外层为0、1440px页面无横溢、外层阅读top不变、页面错误0。报告和过程截图为`.cache/progressive-history-geometry-report.json`及同名前缀两PNG；宽内容由隔离DOM夹具构造，不是用户历史。原版／最终编译CSS的CodeBlock default／small×header／footer八组合实际四边padding精确相同，见`.cache/code-block-padding-report.json`；发现并修正small footer从旧10px变8px的差异后取得此结果。上述为Chrome隔离Native及Electron隔离renderer资格，没有读取用户Store或调用真实Provider，不代表完整安装版／真实Service正文FIFO或其他平台性能。

最终13个完整定向文件196项／5469断言通过（窗口、滚动、展示、折叠工厂、工具聚合、缓存、成本、CodeBlock、reasoning、turn-response、SessionPage及Native发送／接管）。Native整文件的定位期间发现无布局树的滚动条probe触发JSDOM停顿，原HEAD对照86项通过；测量改为仅在可布局树执行并在首次可见RO补测后，原86项／1889断言通过，未放宽期限或断言。最后补充RO与small footer的范围分别由上述真实布局／CSS对照和CodeBlock整文件复验，其余无相关变化的定向结果复用。UI／Desktop类型、实际变更文件Biome、文档结构／影响、统一边界及测试归属检查通过。

### 小会话缓存与原有渲染回归

首轮初始构建改动后，按下述原夹具四组各100次普通热切换复测，沿原精确P95≤32ms门槛：Chrome production21.703857ms、dev30.509033ms；Electron production17.772705ms、dev31.846924ms。产物分别为本机`.cache/session-cache-performance-production-0YmFZC`、`development-PyY54f`、`production-pe93u8`、`development-OLSFpE`（后三者同属`.cache/session-cache-performance-*`前缀）。全部仍保原DOM、阅读位置与操作门禁断言。dev最初两次在warm admission因Vite启动优化触发第二次初始导航被拒，`development-dHD2VH`与`development-FS7lqq`均cases=0，不计为时延样本；相同源码和旧runner的后续有效运行通过，未改runner或放宽门槛。

当前缓存复用官方Activity与原portal，非当前页面上限8项；私有CacheHost作为portal前置的React sibling，在后代layout之前接入原容器，去掉attached状态驱动的第二次可见恢复。共享预算、后台分片成本和未知条目退出策略归[UI owner](../../packages/ui/README.md#原桌面展示层)。[NativeDirectoryProjection](src/native-presentation.ts)属于单个窗口，只保当前目录索引；新目录单次分组并复用未变会话／空间对象，同一目录的选择刷新只核旧、新会话摘要，Store变化清空旧映射。Sidebar按空间／标题／会话行memo并仅在该组sessions改变时排序，选中切换仅更新旧、新两行；[SessionPage](../../packages/ui/src/desktop/SessionPage.tsx)的稳定事件代理读取最新已提交回调，操作存在性变化仍立即更新入口，避免以忽略回调的memo隐藏授权撤销。[目录回归](test/native-directory.test.tsx)与[导航回归](../../packages/ui/test/isolated/desktop-sidebar.test.tsx)分别核投影身份／实际状态变化和回调更新／撤销。普通跨根会话导航先建立展示hold与撤销旧操作资格，再通过[绘制机会](src/native-presentation-frame.ts)的RAF后下一task启动Main选择；同会话刷新、首条投递接管和child不延后。随后仍核原nonce／generation／epoch，隐藏窗口跳过等待，帧暂停由100ms deadline收束；这是一帧调度机会，不作为已绘制证明。[时序回归](test/native-presentation-frame.test.ts)以可控队列核RAF本身不释放、post-frame task释放及deadline清理。

标签页scope重置由SessionPage薄入口持有，原页面内容不再因该render-phase状态接管重算；原`useSessionTabs`及browser／child清理保持。环境动画状态已空时不发空更新；existing-session模型选择器的ready回调只更新仍匹配Session／generation／viewIntent的选择，退出会话的回调不触发旧页面更新，首条准备分支保持。[页面回归](../../packages/ui/test/isolated/desktop-session-page-render.test.tsx)核连续scope切换每次只算一次内容、外壳原节点与准确browser关闭，原标签页回归继续覆盖最后标签关闭和child生命周期。

[环境读取](src/native-environment.tsx)在导航暂停时从已提交raw版本派生busy，不再为同一暂停复制View并触发整页更新；恢复后该暂停版本仍不可操作，直到新read接管。layout记录暂停版本和原read身份，旧read的成功／错误／排队刷新不得接管，新版本提交后释放标记引用。[暂停回归](test/isolated/native-environment-pause.test.tsx)核单父提交、恢复首layout的操作限制、迟到结果、child取消、scope替换与失败恢复；原stop／child读取生命周期继续独立核对。

[Native正文适配](src/native-model-output-message.tsx)在私有memo边界内保留未变的共享全文组件与默认renderText回调；公开ConversationActivityContext及resume语义保持，实际readActive、消息、Store、快照和reader变化仍更新。关闭的诊断工具仅在原入口实际显示时构造JSX；不增加普通dev／prod诊断能力。[正文回归](test/isolated/native-model-output-cache-dom.test.tsx)核resume-only跳过正文以及真实门禁／消息更新，原保留全文、复制与释放边界继续覆盖。

[缓存性能夹具](test/session-cache-performance-browser-runner.fixture.ts)是独立测试制品：`bun apps/desktop/test/session-cache-performance-browser-runner.fixture.ts`运行生产Chrome，`--dev`运行隔离Vite开发renderer，`--electron`使用独立Profile的Electron窗口，`--dev --electron`组合验证开发renderer与Electron合成器。每页20轮／40条含代码表格，20个空间／100会话；先核后台记账完成和原节点，再测100次真实click。PNG compositor帧的原时间戳与可信click对齐，DOM可见时刻单列，色标先按同通道截图校准；私有采样与成本标记只由该夹具构建开启，普通dev／prod入口不装配。目标为热命中绘制P95≤32ms，另核500ms选择延迟、零首帧预算扫描、滚动／草稿、操作禁用与A→B→A迟到隔离。准确运行结果与限制在本节归位，不以首次DOM进入或固定sleep充当实际绘制。

2026-10-26，`820141f49`加本次工作树，macOS arm64／Darwin27／Apple M4 Pro14核、Bun1.4.2、React19.2.7，1440×800、浅色、普通动态效果、diagnostics=false、无Profiler：最终四组各100次普通热切换均通过精确P95≤32ms门槛。Chrome155.0.8059.86为DPR1；Electron44.3.0／Chrome152.0.7977.78按系统实际DPR2运行。Vite夹具在初始导航前等待实际依赖扫描与优化Promise完成，整段强制只有一次初始导航；测试构建的采样不装入普通入口。

| 构建／合成器 | P50 | P95 | 最大值 | 本机产物目录 |
| --- | --- | --- | --- | --- |
| dev Chrome | 21.47ms | 31.19ms | 32.58ms | `.cache/session-cache-performance-development-GQZ2Yz` |
| dev Electron | 21.59ms | 31.80ms | 33.06ms | `.cache/session-cache-performance-development-gMkFC0` |
| production Chrome | 21.42ms | 22.67ms | 23.02ms | `.cache/session-cache-performance-production-O7UNnD` |
| production Electron | 17.48ms | 18.43ms | 19.02ms | `.cache/session-cache-performance-production-x6Wzs8` |

每组另有4个边界案例，共105段阅读位置区间；九页各793个全Node（637元素＋156文字），8个inactive＋1个active的原viewport／40条article／table／PRE均保留。四组首paint前预算扫描0、页面错误0、longtask0；500ms选择延迟、240px手动阅读、准确草稿、禁用旧操作与A→B→A迟到隔离全部通过。scroll采样只记录已知viewport的对象身份、时间和scrollTop，核首paint后至离开前无位置偏移，不增加样式／几何扫描。JSON、逐帧PNG和时间戳保留在各目录。当前证据为实际NativeDesktop／CSS与隔离bridge的renderer及合成器热命中，不代表用户真实Main／Service／Profile、冷页、大会话或跨平台资格；P95门槛也不等同每次都≤32ms。

未通过的优化阶段保留原报告：`development-MjZJd0` P95为41.78ms，`development-ccBGiK`为33.87ms，`development-j7rGQG`精确32.0080566ms仍判失败；它们均位于相同`.cache/session-cache-performance-*`前缀。一次Vite优化晚刷新中断的`development-YdKWj9`不计资格。最终通过来自后续具体源码及夹具修正，不四舍五入、放宽门槛或抹去失败。

同日较早的展示接管阶段，`820141f49`加该阶段renderer修改，macOS arm64／Bun1.4.2／Chrome155.0.8059.86：生产 NativeDesktop、原样式和隔离 NativeBridge 的两条短消息对照中，将返回已缓存会话的选择确认挂起24帧。修前约392ms一直显示旧会话；修后首个采样帧约6.2ms已恢复目标原 viewport，后续24帧及确认后保留原节点，旧会话正文消失、操作暂停、页面错误0。无延迟的10次往返约14–41ms；此测量是隔离页面采样，不代表用户开发窗口、真实Main／Service激活耗时或安装版资格。报告、CPU采样与过程截图位于本机`.cache/session-render-investigation`。该阶段只提前页面接管，尚未包含本节上述目录／外壳优化及首帧后激活调度。

最终重跑[首条消息与导航 DOM](test/isolated/native-new-conversation-dom.test.tsx)整文件86项／1886断言通过，覆盖准备期占位、切走尚未保存的首条消息、草稿、目标高亮和零重复提交。[历史展示](test/isolated/native-history-presentation-dom.test.tsx)18通过／3失败、[子导航](test/isolated/native-session-navigation-dom.test.tsx)27通过／3失败、[读取归属](test/isolated/native-read-ownership-dom.test.tsx)14通过／2失败；8个失败分别涉及旧工具数量／展开、既有执行状态和首次提交夹具，均以`HEAD`原 Native 源码复现，未改相关断言，也不计作通过。最终缓存／成本两文件14项／624断言、Native正文2项／25断言、共享全文16项／173断言及页面13项／95断言通过；新增投影、侧栏render、环境暂停、复制纯view、标签页与滚动生命周期回归分别沿其负责文件核对。Desktop／UI typecheck、35个实际变更TypeScript文件Biome、文档结构／影响、测试归属及统一边界检查通过。新增挂起选择与迟到结果回归证明目标原节点先显示、复制及提交受限；上述范围不外推实际开发窗口的完整体验资格。

[外壳浏览器夹具](test/session-shell-browser-runner.fixture.ts)同步即时目标标题与配置控件后续接管的预期，深浅主题×500／800／1440／1920px八组几何检查通过；亮色主循环完成挂起选择、控件禁用、hover及100次快速往返，随后在原“上次状态”文案断言失败，暗色主循环和末尾总写入断言未执行。产物位于本机`.cache/session-shell-browser-CcdYzD`。原[历史逐帧夹具](test/native-history-presentation-browser-runner.fixture.ts)仍在旧工具聚合文案断言失败；这两个浏览器失败均用`HEAD`原renderer和原夹具复现，不能声称整套通过。

2026-10-25同一`852f665b0`工作树、Windows x64／Bun1.4.3／Chrome155：用户指出无工具回复仍可能在文本渲染时换行，隔离页面复现逐字span在英文558px和中英混排244px比连续正文多出一行。改用[绘制层渐显](../../packages/ui/src/desktop/streaming-text-reveal.ts)，文字保持连续Text节点、原字距与字体。实际浏览器同时检查字符绘制颜色由透明逐步增加、全文高度不变、结束后Highlight及动态样式为零；不能只核原生时钟已创建。新增字素与已读选区继续分开，后续追加使用appendData保留旧选区。

`bun test --parallel=1 --max-concurrency=1`定向执行流式Markdown、Markdown结构、语法缓存、消息复制、阅读滚动、轮次生命周期和过程聚合七文件，56项／1654断言通过；UI／Desktop typecheck、Biome及文档检查通过。[原流式浏览器回归](test/streaming-render-browser-runner.fixture.ts)在1280／800px、深浅主题及减少动态效果四组均通过，每组加入三种纯文本在180–740px的281档宽度比对，共3372组流式／自然正文换行一致；仍核旧块不变、原400px手动阅读、缓存回切、重连、末次追加和自动全文交接。实际绘制帧及隔离比对在`.cache/text-wrap-20261025`，完整回归在`.cache/streaming-render-QE3iPR`。当前证据覆盖生产Native renderer与隔离bridge，不替代安装版Electron或真实外部模型资格；与先前仅验证固定正文信息行的范围分别保留。

同日首轮真实客户端观察：`852f665b0`加上述工作树，Windows x64／Electron44.3.0，通过`bun run desktop:dev`启动普通Main／preload／当前HMR renderer与真实Service，诊断构建值关闭；在新建验收对话中经普通模型菜单选择`gpt-6.1-sol`／high，实际发送中文单段、中英文加表情双段、英文长段和英文短段四次普通聊天。英文短段从“正在回复”到耗时终态的18个连续样本，正文区域与最终帧逐像素相同，但这只证明末尾稳定；用户指出最开始整块上下跳动后，回看第698至699帧确认“回复未完成”临时插入后消失，原用户气泡锚点由310到360px反向回落50px，原整轮“未见抖动”的结论撤回。只读查询准确验收Session确认四个Run均completed、四个业务Model均succeeded且模型与high快照一致，Tool Execution为0；自动标题另有独立Model，不计为业务回复或工具。原742张带时刻的窗口帧、脱敏执行摘要及末尾像素比对继续保留于本机`.cache/live-gpt-render-20261025`；长混排回复记录未覆盖完成瞬间，也不据此证明终态。该记录不代表正式安装包、其他窗口尺寸／主题／模型或全部流式分段组合。

随后修正共享[ModelOutputMessage](../../packages/ui/src/model-output.tsx)对`autoRead`的提示判定：`body.complete=false`只表示当前前缀未封存，读取中间状态或已核实的planned／dispatching／running不插入“回复未完成”；已核实终态且输出确实不完整才显示，失败／取消／结果未知保持原提示。[Model output回归](../../packages/ui/test/model-output.test.tsx)先复现读取中间状态错误插入提示，再全文件16项／173断言通过，另Native正文缓存、后台历史与Web页面三文件22项／368断言通过。原[流式runner](test/streaming-render-browser-runner.fixture.ts)新增前缀→封存各36帧、思考稳定后首段固定正文40帧的几何与临时提示断言；1280／800px、深浅主题及减少动态效果四组通过，封存时正文top与height不变，首段后没有额外展开位移，因此未修改折叠实现。当前真实开发窗口再次经普通输入发送40词英文消息，仍用`gpt-6.1-sol`／high且无工具调用，连续110帧覆盖发送、首批正文、首次换行及完成；锚点随新增内容向上跟随，没有原50px反向回落或提示闪现。实际窗口被用户最大化并打开右侧浏览器，故不将其与旧尺寸当作同尺寸性能对照。新帧及前后锚点分析在`.cache/live-gpt-start-20261025`，隔离回归在`.cache/streaming-render-zNRGj1`；本次范围限上述Windows普通回复过程，其他平台、安装包和任意流式分段组合仍未据此取得资格。

2026-10-25，`852f665b0`加本次信息行修正，Windows x64／Bun1.4.3：[共享Conversation](../../packages/ui/src/desktop/Conversation.tsx)将独立流式提示放进原信息栏，[共享样式](../../packages/ui/src/desktop/style.css)统一回复／思考提示与工具栏为28px高、距正文2px；展开过程以Agent正文结束时采用相同的8px后续间距。[轮次生命周期](../../packages/ui/test/isolated/desktop-turn-response.test.tsx)、[过程聚合](../../packages/ui/test/desktop-reasoning-turns.test.tsx)和[日期](../../packages/ui/test/desktop-message-time.test.ts)三文件36项／653断言通过，UI typecheck与定向Biome通过。使用真实Conversation与生产编译CSS的隔离页面逐步观察轮次与独立消息从回复中到完成：两组各40帧的信息行高均为28px、距正文均为2px，正文、信息行及下一条消息坐标保持，过程内不增加时间／复制。原16px后续位移已复现并修正；测量保留在`.cache/response-row-20261025`。这是共享组件的固定正文布局验证，未重验安装版Electron、真实模型或正文与过程内容本身发生变化的布局。

2026-10-25接入远端`2e913e139`的自动全文及读取队列后，Native普通消息继续默认自动核验正文。`NativeMarkdownBody`仅在原Store/Session/Message/Run/Execution身份内保留已显示的核验文字和prepared树；下一版读取时不闪回预览，旧文件入口关闭、原onContent仍撤销复制资格，新的准确核验结果到达后才发布当前正文。首个自动全文填充静态，之后追加按字素渐显；显式手动读取保持静态，身份切换和Activity隐藏清理保留。合并后16个完整定向文件195项／3248断言及五个受影响workspace typecheck通过，日志在`.cache/native-streaming-rebase-tests.log`。同一Electron runner的四组窗口另覆盖自动全文首填、100ms在途保留、复制资格撤销、六个新字素依次渐显和减少动态效果；合并后夹具补齐真实首轮模型协议封存，不能以缺配置造成的发送阻塞冒充正常场景。窗口轨迹与截图在本机`.cache/streaming-render-C3CEQm/`，生产renderer流程与孤立Native自动正文的证据分别记录，不代替用户数据或安装包验收。

2026-10-24本轮最终定向验证：13个完整测试文件170项／2964断言通过，日志分别在`.cache/native-history-final-tests.log`及`.cache/native-streaming-final-tests.log`；Agent／Service／Client／Desktop／UI typecheck、33个相关源码与测试文件Biome、生成API一致性、统一边界、测试归属、文档结构和影响核对通过。范围为Windows开发交付及下列隔离窗口/协议场景，不代替安装包或其他平台资格。

[NativeModelOutputMessage](src/native-model-output-message.tsx)为未暂停的assistant预览传递`streaming`：incomplete为true，完成预览为false；显式完整读取不传此标记。正文来源、完整读取证明、复制与当前操作准入保持原链路；用户消息、已完成历史与独立Web／TUI不启用该效果。共享展示层的元素memo与追加文字渐显归[UI owner](../../packages/ui/README.md#markdown-消息内容)。[流式浏览器runner](test/streaming-render-browser-runner.fixture.ts)沿现有隔离[NativeDesktop夹具](test/render-performance-browser.fixture.tsx)加载生产编译CSS，记录每帧文字、状态、滚动及透明度，核稳定块零正文DOM变更、连续追加、完成、缓存返回及减少动态效果；夹具入口和控制只存在于测试制品，正式诊断构建值关闭。执行`bun run apps/desktop/test/streaming-render-browser-runner.fixture.ts`，产物位于本机`.cache/streaming-render-*/`。

同一runner为读取注入45ms跨任务延迟；`--electron`在独立临时数据目录启动沙箱Electron窗口，运行生产renderer和隔离bridge，不读取用户Store。普通流式阶段只允许首轮完整基线，其后每次读取仅返回更新消息，不能闪现历史`aria-busy`；切换返回及模拟重连则必须观察完整校准中间状态。记录每次通知到对应文字第一次进入DOM的时间，逐字渐显不阻塞正文提交。当前[NativeHistory](src/native-history.ts)的持久变更协议见下文；Main收到正文事件直接唤起增量读取，跳过View刷新合并窗口，模型端保存合并及其他元数据刷新的节流未调整。

2026-10-24，Windows x64／Bun1.4.3／`fb3989b47`加当前工作树：最终逐字渐显的四组Electron44.3.0／Chromium152.0.7977.78窗口共2982帧，普通三组各219个独立字素动画，减少动态效果0个；每批跨行内节点有序错开，观察到部分字已淡入而后字仍透明。每组正常流式阶段1次基线后13次增量、每次只返回1条更新消息，无history loading；切换B、返回A和模拟重连各增加一次完整基线。稳定块正文DOM变更0、400px阅读位置保持，完成后跟随，无裁剪或脚本错误。56次追加注入45ms读取后的DOM展示均值58.6–61.3ms，各组P95为63.3–66.7ms；不是实际用户Service延迟，也不等待420ms内的动画结束。过程截图、逐帧文字／透明度／状态、读取与通知日志在`.cache/streaming-render-xs39Ln/`，已逐阶段检查流式、手动阅读、缓存、重连与完成。

[真实链路回归](test/isolated/native-history-incremental-http.test.ts)连接实际Main→SDK→Service→SQLite，以固定流保存同seq正文，主动切断真实SSE后在断开期间继续保存，等待新的ready/epoch和完整基线，重连和冷建Client/reader均保原ID与单条正文；原Run只执行1次、命令POST只有1次。读取可能经尚在途的HTTP先抵达，不能将“正文出现”等同于观察流已重连。当前定向整文件回归覆盖Main／history／cache、Store／原输入接管、Client／HTTP，以及逐字UI／复制／滚动／Native transcript；进程日志保留在本机`.cache/native-history-final-tests.log`。新协议需完整重启桌面Main及配套Service，renderer HMR不能加载后端能力。本轮没有重启用户运行中的客户端，也未验收安装包、真实Provider或其他平台。原macOS长历史窗口夹具已按增量API注入读取失败，并以真实SSE重连触发held完整基线，原断言和期限保留；本机Windows不能执行该macOS整窗口资格。下面较早的按片段渐显与完整重读记录保留其当时范围，当前行为以上述逐字和增量实现为准。

同日用户反馈实际开发客户端没有渐显后，加入上述跨任务读取，原条件复现动画0次；失败报告保留在`.cache/streaming-render-zjNzSA/`。原即时bridge的2162帧只证明其合批时序，不能覆盖实际IPC准入。修复为只核当前读取资格，以已显示正文维持连续性；Activity隐藏／重连、完整读取与纠正的原限制保持。新增读取校准回归与缓存、复制、滚动四个完整文件14项／1218断言通过，UI／Desktop类型检查、定向Biome和文档核对通过。Windows x64／Electron44.3.0／Chromium152.0.7977.78的最终四组800／1280px、深浅主题及减少动态效果共2571帧，逐阶段检查渐显、连续追加、手动阅读、缓存返回与完成；各组实际观察76–90帧读取中间状态，三组普通模式各15次新增动画，减少动态效果0次，稳定块正文DOM变更0，手动400px位置保持，无裁剪或页面错误。52次追加在注入45ms读取后的显示均值为63.2–65.4ms，各组P95为67.8–74.4ms，计时截至文字进入DOM，不等动画完成；这是隔离夹具结果，不是用户实际会话或真实Service耗时。准确轨迹、源码构建与过程截图在`.cache/streaming-render-7WddnH/`；未操作用户会话，未做真实Provider或完整安装制品验收。

2026-10-24，Windows x64／Bun1.4.3，`fb3989b47`加本轮工作树：定向12个完整测试文件最终有效66项／2464断言通过，包含新增的实际React跳过渲染与Native不完整全文读取静态交接；最终正文来源区分后重跑流式UI及Native消息完整文件，其余按未变的非流式路径、parser、Worker、复制与滚动断言复用本轮结果。Native文件的一轮沙箱loopback请求返回`network_outcome_unknown`，允许本机网络后完整20项／337断言通过，未改业务断言。UI／Desktop类型检查、定向Biome、统一边界、测试归属及文档检查通过。

Chrome155.0.8059.85的最终四组800／1280px、深浅主题及减少动态效果记录2162帧：三组普通动画各15次，仅新增文字处出现0.25到1之间的透明度；减少动态效果为0次。稳定块正文DOM变更为0，上翻后的连续追加与缓存返回保持400px位置，回到底部后完成仍跟随，正文范围无裁剪、页面无横向溢出或脚本错误。逐阶段截图核正文、输入草稿、处理状态及完成交接，产物在`.cache/streaming-render-J6e67q/`。首轮runner用原Markdown源码等待展示文字而超时，失败帧保留在`.cache/streaming-render-KQ4ro6/`；修正展示文本等待后通过。390px试探出现原有布局裁剪，核[Main](electron/main.ts)的800px下限与原内容面板最小宽度后，最终按实际桌面尺寸验收，未改窗口布局。Windows窗口观察工具因无法核实浏览器URL停止，不将该次观察计为整窗口验收；本轮证据为隔离生产renderer及真实浏览器，未重验安装版Electron、真实Provider、系统断网或其他平台。保留既有嵌套`@keyframes`编译提示。

[消息适配](src/native-presentation.ts)将公开 `Message.createdAt` 交给 UI 的 `createdAtMs`，Agent 邮件和结果的专用展示分支也保留已提供的时间，缺失时不补造；旧输入的真实业务副本接管原行时，保留原输入的记录时间、独立同文与原业务身份。普通刷新、完整正文读取和重开不生成客户端替代时间；尚未保存或历史缺失时保持未知。共享 Conversation 仅在原消息边界显示信息栏，Turn 过程内的 Agent 正文和普通邮件不渲染复制／时间及其留白，用户引导、过程外最终回复与独立结果的原边界保持；该显示选择不删除宿主时间事实。[时间投影回归](test/native-message-time.test.ts)核字段与接管，具体格式与布局由 [UI owner](../../packages/ui/README.md)和[桌面手册](../../docs/handbook/clients/desktop/README.md)负责。

2026-10-23，Windows x64／Bun1.4.3：时间投影2项通过（含原输入时间未知时不借用较晚业务时间），原[会话消息 DOM](test/isolated/native-transcript-dom.test.tsx)整文件9项／143断言通过；隔离 Chrome 的输入接管、流式、重开、日期与阅读位置证据见 [UI owner](../../packages/ui/README.md)。本次新增 Service／Client 的时间字段，开发运行需完整重启客户端以加载 Main 与配套 Service 的新协议资产；不以 renderer HMR 代替主进程更新，完整安装包未在本轮重验。

[首次历史浏览器夹具](test/native-history-presentation-browser.fixture.tsx)通过实际 NativeDesktop、生产样式和隔离 bridge 分别延迟选择、历史、Run 与 Tool，并按原请求身份和32项批次返回。由[逐帧 runner](test/native-history-presentation-browser-runner.fixture.ts)核首次进入、未缓存切换及缓存返回，记录目标首个可见消息之后的节点身份、宽高、滚动、留白与加载／欢迎状态；旧性能夹具提前提供完整 View Runs，其数据不覆盖这一异步重组时序。环境卡首次宽度在共享 SessionPage 的 layout effect 确定，不启动初始占位过渡；后续窗口跨阈值和用户开合保留原动画。

2026-10-23，macOS arm64／Bun1.4.2，基于 `45b8275c1` 的当前工作树（含本次修复及并行子 Agent 展示改动）：合回当前目录后，相关11个DOM／组件测试文件154项、3982断言通过，UI／Desktop类型检查、定向Biome及文档检查通过。Chrome155六组首次／未缓存切换核Run先到、Tool先到、View已齐、40轮多页历史与32项事实批次，含亮暗主题、1280／1320／1440px和减少动画；目标首次显示后连续28–30帧的消息／轮次节点、阅读区几何、滚动和Composer位置不变，缓存返回保原节点。Electron44.3.0／Chromium152独立窗口沿相同生产renderer制品复核首次与未缓存切换，各80个连续可见帧同样稳定，零页面错误；过程截图确认等待后直接进入完整分组。环境卡独立9组首屏／晚到内容与8组开合／调宽验证中，1320／1440／1600px首帧已为最终占位，原403px正文高度变化和146.5px最大横移消除，后续交互动画保留。证据分别位于本机 `.cache/native-history-presentation-fyZ0mY/` 与 `.cache/session-render-fixed-electron-C3IvWz/`；使用隔离数据，不覆盖真实Service／SQLite延迟、安装包或其他平台资格。异常读取fallback后的新事实仍按原恢复规则更新，不把正常冷开布局稳定外推为恢复时不更新分组。

[Code Block／Trace 聚焦夹具](test/ai-elements-browser.fixture.tsx)使用实际 Conversation、ToolActivity、MessageContent 和生产 CSS，执行 `bun run apps/desktop/test/ai-elements-browser-runner.fixture.ts` 核亮／暗主题、1280／390px viewport、代码横向滚动、文件按钮、工具聚合与 Shell 追加／取消。同组思考／回复切换保留底部状态节点，收起过程仍可见；准确 Turn 结束后移除。输出 `.cache/ai-elements-browser-*/report.json` 及各组常规／思考状态截图，所有数据固定且诊断构建值关闭。

2026-10-21，`c89911153` 加本次工作树，macOS arm64／Bun 1.4.2／Chrome 155.0.8059.86：上述四组均无页面横向溢出或脚本异常，Shell 输出保持256px上限，上翻后追加保持原位置，回到最新准确到达底部；手动开合、取消后的实际日志及独立文件回调保持。[缓存夹具](test/conversation-cache-browser-runner.fixture.ts)在亮／暗两组的各24个观测帧核代码 PRE 与复制节点身份、80px横向位置、暂停操作及宿主原文复制。[桌面代码块回归](../../packages/ui/test/isolated/desktop-code-block.test.tsx)、共享桌面／Markdown／缓存与 Native 正文缓存共13文件59项通过，Native 工具显示／回执／聚合另3文件17项通过；UI／Desktop typecheck、UI Desktop 生产构建和定向 Biome 通过。原 Native 渲染夹具六组继续通过流式更新、回复状态边界、减少动画和缓存返回检查；本次未运行安装版 Electron 窗口或其他平台。

[隔离夹具](test/render-performance-browser.fixture.tsx)使用实际 `NativeDesktop`、SessionPage、Conversation、Markdown 和生产 CSS，只有 NativeBridge 的会话／历史读取为固定数据；测试诊断构建常量仍为正式关闭值。执行 `bun run apps/desktop/test/render-performance-browser-runner.fixture.ts` 会独立构建生产组件，在临时 Chrome profile 测量窗口首屏、首次选中、逐条更新、连续32次／32ms间隔更新、终态转换和 A→B→A。覆盖10／60／180轮含列表、表格、代码和Unicode的历史，以及亮／暗、1440×1000／960×1000、减少动态效果；输出 `.cache/render-performance-*/report.json` 与截图，不读取用户会话或调用 Provider。

2026-10-20，`5dba8a6b` 上的本次工作树，Windows x64／Ryzen 9 5950X／32GiB／Bun 1.4.3／Chrome 155.0.8059.82：修前首段正文已经显示后，默认展开的活动过程仍重播300ms动画；共享 [Conversation](../../packages/ui/src/desktop/Conversation.tsx)在首次读取也使用原恢复标记后，首个正文观测周期即为完整高度，手动开合仍按原动画。截图另发现“正在回复…”的绝对定位使末行被折叠容器裁剪，浏览器边界断言先复现失败；改为正常文档流后完整可见。最终六场景中，本机HTTP夹具导航至应用壳观测约243–272ms；下表另从触发会话选择计时，展示亮色1440×1000的一次本机样本。

| 历史轮数（每轮2条消息） | 首次显示且高度稳定 | 未缓存会话切换 | 选择确认后的返回显示 | 单次流式更新 |
| --- | --- | --- | --- | --- |
| 10 | 116ms | 46ms | 21ms，复用DOM | 6–8ms |
| 60 | 215ms | 171ms | 74ms，复用DOM | 9–15ms |
| 180 | 474ms | 385ms | 327ms，超节点预算后重建 | 18–24ms |

浏览器在RAF后的task采样，避免把ResizeObserver绘制前的跟随写入误记成可见跳动；另记录实际展开动画与50ms以上long task，不把等待固定观测帧的总时长当渲染时间。六场景首次正文高度均保持一值、无自动展开动画，回复状态完全位于viewport及各级裁剪容器内，底部跟随误差≤1px；手动阅读的1500px位置在更新和往返后保持，切换等待期间无空白帧。每场景连续更新均无50ms以上long task，最大采样间隔约12–20ms。预算内返回核原消息节点身份，180轮按原10,000总DOM节点单项预算回收，不以元素数代替包含文本的节点数。

剩余瓶颈是完整大历史的首次Markdown／DOM挂载和淘汰后的重建，本轮没有降低这部分CPU成本；命中60轮缓存仍约69–74ms。此夹具的分页与选择响应由内存bridge提供，不覆盖真实Main／IPC、Service／SQLite、安装启动、Provider延迟、真实图片／大模型正文reader或Electron compositor。[缓存浏览器回归](test/conversation-cache-browser-runner.fixture.ts)在本轮亮／暗主题的200次切换中另核图片、复制与悬停恢复；[完整工具栏回归](test/session-shell-browser-runner.fixture.ts)通过200次切换与192个等待帧，核标签、位置、透明度、草稿及只读门禁。实际制品、跨平台及完整业务资格仍按各自owner验证。

## 原审批面板与授权观察

[NativeApproval](src/native-approval.tsx)复用原 [Approval](../../packages/ui/src/desktop/Approval.tsx)按钮与范围菜单，只消费原冻结请求的 `options`。主按钮取 `kind:once` 的原展示，分体菜单列出全部 `kind:scope` 选项及其完整 label/details；每次只提交原 optionId，deny 不带选项。Shell、文件和 worktree 不各设答案格式，Main IPC 与持久 answer journal 同步拒绝旧 grant 字段及客户端自报 scope。已知 `shell.execute`、`shell.launch` 和 `shell.command` 的版本1显示准确原命令，其他定义显示原身份、目标和原因；工具标签与等宽目标分层，单行超出省略，沿原 Tooltip 悬停／聚焦查看核实后的完整原审批请求（包含 Shell 每次调用的 filesystem／network 权限、其他输入与策略原因），不再额外展示详情；单行命令不代替授权范围披露。`InteractionCard.renderApproval` 的紧凑模式自动沿原附件 reader 的身份、hash、UTF-8 和 EOF 资格核实完整正文，失败可重试；未读完、换卡、提交中或未知时禁用。回答仍走当前 Native／Main／公共 Client 原链，不建立第二个提交入口。

[NativeApprovalGroup](src/native-approval-group.tsx)将当前普通工具审批归入输入组件上方的一张独立浮卡，高度不超过默认 Composer；右上角“‹ 1/3 ›”一次只挂载一项原 `InteractionCard` 与准确 `approval ID` article，翻页不回答其他项，当前项消失后按原位置选择后继。主 Agent 不显示名称；子 Agent 名称按实际 Store／Session／Run 核实，未匹配时显示“子 Agent”，不将内部 UUID 当名称。[ApprovalHeader](../../packages/ui/src/desktop/ApprovalHeader.tsx)按准确 Store／Session 的随机身份确定固定池中的图标及语义色槽，翻页、重开或新 Run 不重新随机。附件读取、独立 grant、在途／未知禁用、原答案身份与迟到隔离均沿原链；MCP 来源／凭据授权、问题及计划不进入普通审批组。

[浮卡 DOM](test/isolated/native-approval-group-dom.test.tsx)连同[原审批](test/isolated/native-approval-dom.test.tsx)和[输入交互](test/isolated/native-interaction-composer-dom.test.tsx)核单卡翻页、主名称缺席、准确子名称与稳定图标、独立决定、紧凑附件门禁、单项 unknown、旧 Store／Run 名称隔离及其他交互类型保持；[环境信息停止回归](test/isolated/native-environment-stop-dom.test.tsx)继续核只读名称投影未放宽原停止资格。

子 Agent 的会话批准另由同一浮卡 DOM 核实际菜单选择，答案保留原 child Interaction／Session／Run／Execution，父及兄弟卡仍各自待批；两份审批 DOM 整文件本次均通过。[双 child 窗口](test/isolated/native-collaboration-bundle.test.ts)使用新构建、源码外候选和受控模型：A／B 请求完全相同 Shell 命令，A 的 Tool 与 Job 各自选择“本次会话批准”后，同子会话第二个 operation key 无新审批执行，效果恰好两次，B 保持原卡零效果。原同 Session follow-up、旧答案／旧停止拒绝、准确停止及冷重开零重放断言保留；冷只读 Store 另核只有 A 的两条 Tool／Job grant，父和 B 均无 grant。原权限交集与版本绑定由[Agent owner](../../packages/agent/src/permissions/README.md)维护。

2026-10-22 在 `761405f5e` 加本次差量、macOS／Bun1.4.2／Electron44.3.0 上，以 `bun test --parallel=1 --max-concurrency=1 /Users/chenchao/Code/ai/kite-code/apps/desktop/test/isolated/native-collaboration-bundle.test.ts` 执行上述窗口整文件：1项／43条 Bun 断言及 driver 过程断言通过，33.37秒，18次受控 Provider 请求；同时保留内部权限检查及标题生成不计入真实 child 目录的原断言。过程截图已逐张观察；正常退出和原候选清理均无强制终止或残留，冷重开无模型重放。实际 report、日志、截图与冷授权目录保存在 `dist/acceptance/child-session-approval-f34f97ba-6028-4ced-9842-9557b3b5094d`，测试成功后清理临时候选，只保留有限证据。该结果覆盖本机受控 Electron／Shell 链路，不取得付费 Provider、其他平台或签名安装资格。

公共 Execution 的可选 `authorization` 是 [Store 只读观察](../../packages/agent/src/storage/README.md#只读授权观察)，只表达原 reviewer、人工答案、accepted decision 与派发事实。Native 将它映射到原 ToolActivity 的审批标签，分别显示“已提交批准，待核对”“已人工批准”、自动批准／拒绝／等待或结果未知；停止后保留可核对的已有记录。批准不覆盖工具的真实失败、取消或未知状态，也不授予执行权限。每项当前待批状态仍以实际 Interaction 为准；Auto 转人工时保留原审查原因。

自动批准通过理由不进入工具展开正文，真实执行失败和结果未知只展示各自异常；原授权事实和盾牌提示仍保留，拒绝及转人工原因不受影响。显示规则、逐状态回归与实际浏览器过程证据归 [共享 UI](../../packages/ui/README.md#原桌面展示层)。Native 的已知写入展示同时支持保存的 `files.write@2` 和当前 `@3`，两者均显示“写入”；未来未识别版本仍使用原定义／版本文字，不推断能力或执行结果。

普通 root／child 工具审批都与父 Composer、权限选择器并存，待批时可切 Auto／Full 使原未派发工具重新判断。`nativeRootInteractionBlocksComposer` 只为准确当前根的 question、plan_review 与 MCP 特殊审批隐藏输入，仍核原 Store、父 Session、准确 Execution 与活动 Run；runless 原交互核准确原执行，不以 rootSessionId 或 waiting 文案推断。共享 SessionPage 的 `interactionHidesPrompt` 缺省保持，Native 对普通工具审批明确保留 Composer。实际输入、单轮准入及模式复核继续由原 Runtime 决定。

## 原运行中消息队列

主 Composer 的 Enter／普通发送沿 [nativeTextIntent](src/native-input.ts)固定为 `input.follow_up`，带本次下一轮模型选择。每条队列项旁独立“引导发送”经 `input.queue.steer` 只传已观察的原 ID；Main 保完整原请求，重新核原活动 Run／selection，复用原 caller journal 保存 `input.steer` 与 `queuedInputCommandId` 后才 POST。Store 原子转换保证原后继任务不再执行；附件保持原引用，新计划／Skill 选择不转换，原活动模型不改变。unknown／丢响应只查准确原请求，不因队列仍可见重发。队列中的已受理后继输入不再同时显示会话占位；转换成功撤下原临时投递，Main metadata 保留新 steer 的准确原队列 ID，避免把有意撤下的旧申请显示为启动失败，冷重开仍按该原关系识别。

[主屏 DOM](test/isolated/native-new-conversation-dom.test.tsx)核普通发送只排队、显式引导和新草稿保持；[Main 队列](test/native-input-queue.test.ts)核完整正文／附件、闭合 IPC 与旧观察撤销；[真实 HTTP](../../tests/isolated/unified-agent/client-inputs.test.ts)核原子转换、原回执丢失／冷 journal 零重投、独立消息一次及前台工具完整收尾。更完整的真实模型继续工具和自动压缩交错归[模型验收](../../tests/e2e/live/model/README.md#运行中引导与自动压缩)。

[renderer hook](src/native-input-queue.ts)与 [Main owner](electron/native-input-queue.ts)通过封闭 [队列桥](src/input-queue-bridge.ts)读取当前根 Session 的真实 pending 输入，不将已提交命令伪装成本地数组。`pending_input_queue` capability 与当前 generation／viewSelection／history epoch／Store／Session／Workspace 核实后，Main 穷尽固定 revision 页并保留正文，给 renderer 仅提供当前 observation、可见条目及有限操作。每次完整观察最多4096成员、3MiB文本，超限拒绝而不截断；`result.include` 不作为提示词展示，仍参与后端固定槽与 revision。

同一准确 scope 的普通 View／历史校准保留已观察队列的 DOM 和全文悬浮层，只暂停编辑、删除和调序；重新核实时不靠卸载组件重置展示。真实观察失败仍显示错误并禁写；切换 Store、会话或读取代次不复用旧队列。

[Composer 队列](../../packages/ui/src/desktop/QueuedMessages.tsx)位于输入框同一外框顶部，单行 Markdown 与全文 Tooltip、常显拖柄／编辑／删除、拖拽与 Alt+↑／↓均受宿主控制。编辑先对已观察原 ID 精确 `input.withdraw`，只有核原 Command 的 applied／`input_withdrawn`、target、subject、request digest 和当前 scope 后才返回 Main 保留的原文，填入普通草稿并聚焦；用户自行重新发送，没有特殊编辑态、取消或自动放回。删除同样只撤回 pending 输入；已消费竞争刷新，不取消活动 Run。图片／文件或 extensionInputs／selectedSkills 不能无损转为普通 draft 时禁编辑，附件 only 行用展示占位，保删除和完整集合调序。

[queue journal](electron/native-input-queue-journal.ts)沿 [private-data](electron/private-data.ts)懒迁移 DB11 `input_queue_intents`，保存 Main 分配的原操作 ID、闭合 request、scope、subject、digest 与编辑原文。首次 POST 前持久提交；未知／冷记录只 GET 原 ID，不重发。read 恢复未决元数据和已 applied 未交付编辑，但不自动回填；显式 lookup 核实后返回原文，renderer 成功填入普通输入框后以 `input.queue.ack` 标记交付，之后不再提示或返回旧文。草稿沿原普通编辑／显式保存合同，不将交付 ack 当作草稿已落盘。128行／16MiB局部容量不裁未决或未交付编辑，已交付终态记录有界剪裁。切会话、Store、代次或关闭撤销原读取，晚到结果只记账，不向替换视图回填。

[Main／IPC 回归](test/native-input-queue.test.ts)、[实际 Node journal](test/isolated/native-input-queue-journal.test.ts)与[renderer DOM](test/isolated/native-input-queue-dom.test.tsx)分别覆盖封闭输入、分页 revision、完整原文、未知只查原 ID、ack、附件、防迟到及受控交互；后端消费与持久顺序的实现和测试归 [Store owner](../../packages/agent/src/storage/README.md#待消费输入的撤回与排序)。真实窗口通过[原运行中权限夹具](test/isolated/native-live-permissions-bundle.test.ts)核验，不据 DOM／Node 结果推导窗口或其他平台资格。

取舍和未采用方案见[紧凑审批与队列决定](../../.agents/notes/implemented/feature/2026-10-22-native-approval-input-queue.md)。

直接历史只沿当前已观察 Message 的准确原 Execution 读取；Fork／Include 的封存 `originMessage` 不取得来源 Execution 后来的审批。原外部 Store／恢复边界继续适用。观察是现有响应的可选字段，不改持久格式，不公开私有审查正文或上下文；审批事实也不让未知工具版本进入旧结果分类。具体取舍见[审批观察决定](../../.agents/notes/implemented/architecture/2026-10-09-native-approval-observations.md)。

[Core 授权测试](../../packages/agent/test/isolated/execution/authorization-check.test.ts)、[真实 HTTP／Client](../../tests/isolated/unified-agent/client-interactions.test.ts)、[Main](test/native-tool-messages.test.ts)和[原组件 DOM](test/isolated/native-approval-dom.test.tsx)分别核原授权门禁、公开字段、封存隔离及完整请求与标签；[源码外默认窗口](test/isolated/native-bundle.test.ts)核首次和冷读的原人工审批及已保存标签，[计划窗口](test/isolated/native-plan-review-bundle.test.ts)核独立审批与大请求。实际结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原审批面板与授权观察)。原记录阅读见[交互历史](#原交互记录只读历史)，当前 Store 的 Auto 窗口与原输入区控制见下一节；全部封存／恢复组合及整片独立审查仍待核对，本节不代表完整 PC 退出。

## 原会话输入区权限与停止

普通 [Native 页面](src/native.tsx)不再将 `permission.mode` 的 `saved/submitting` 状态插入 `beforeConversation`；原 [Composer](../../packages/ui/src/desktop/Composer.tsx)通过触发器的切换中标签、`aria-busy` 和禁用状态表达正常提交，避免状态段插入／移除时挤动消息区。`unknown/failed` 的原结果与准确查询入口、项目读取信任申请的原进度、显式测试诊断账本均保留，底层 Command、权限写入及重复提交门禁未改。

`writeInput` 仅为首条发送、已有会话输入和首条重试设置 `sending`，仍委托原 `write` 保持串行及历史准入，并在完成／失败时撤销发送提示。通用 `pending` 继续禁用相关操作，但权限切换、停止、查询和空间操作不会借此替换发送／停止图标。空间行内操作的临时禁用不改变原悬停／聚焦显隐，选择器修复归[共享 UI](../../packages/ui/README.md)。

2026-10-18 Windows x64／Bun 1.4.3，基于 `f734245a` 加当前工作区改动：新增 Native DOM 延迟权限回归先在原实现复现发送按钮 `aria-busy=true`，修复后保原图标、草稿及空间操作节点，禁用点击零额外写入；实际输入、首条发送及重试仍显示发送忙碌。新对话整文件20项／549断言、会话导航10项／302断言、共享页面13项／95断言及 Desktop typecheck 通过。Chrome 155 隔离共享组件夹具在亮暗主题、1240／800／500px 和触屏下验证：原空间隐藏按钮禁用时透明度从0变0.45，修复后仍为0，悬停／聚焦为1，触屏始终为1，所有受测页面几何和滚动不变；500px 未挂载侧栏，不计作侧栏视觉证据。未运行完整安装窗口、其他平台及全量默认测试；原嵌套 `@keyframes` 优化提示保留。

2026-10-18 Windows x64／Bun 1.4.3，基于 `f734245a` 加本轮工作区改动：[Native 新对话整文件](test/isolated/native-new-conversation-dom.test.tsx)19项／518断言通过，新增普通模式五阶段、原 unknown 查询／零重放、失败提示、Store／会话隔离及信任进度保留，并核菜单 mousedown 不再落入输入区空白聚焦。Desktop／UI typecheck 通过。Chrome 155 隔离共享 SessionPage／Composer 布局夹具复现原临时状态段使消息区下移47px；按 Native DOM 已核实的正常状态显隐修正后，1240／800／500px 三宽度的面板、阅读区、输入框几何及手动滚动位置均不变，多行草稿保持、零页面异常。该有限布局证据不代正式安装窗口、全量默认测试或其他平台；原嵌套 `@keyframes` 编译提示保留。

普通 Native 不再挂载独立的项目读取范围确认弹窗。首次与已有会话的明确发送分别由 [NativeConversation](electron/conversation.ts)和 [NativeCaller](electron/native-caller.ts)调用 [prepareWorkspaceAccess](src/controller.ts)，按当前 Session 绑定的项目准备 Workspace Trust，包含宿主声明的额外只读范围。准备保留原 observation、trust revision、目录身份和范围摘要 CAS，以及原权限 journal；未知只查询原申请且零业务提交，切会话／Store／项目或替换观察后不沿旧观察继续。打开会话只读历史及核实执行状态，不自动授予范围；审批模式与工具硬限制独立。诊断 PermissionPanel 的显式信任／撤销入口继续保留。

同一 observation 的并发准备共享原授权和完成后的读取。已有会话发送期间，Main 只将准确原 trust command 的持久通知刷新推迟到准备结束，不让自身成功授权的通知使原输入失效；外来权限通知及导航仍立即使旧观察失效。即使通知已显示 trusted，原授权回执 unknown 时仍须查询原申请，核实不会自动发送。

[新对话 DOM](test/isolated/native-new-conversation-dom.test.tsx)核普通页面不再出现范围确认，权限结果未知仍沿原 ID 查询，切会话保原草稿；[Main 权限回归](test/native-permissions.test.ts)核已有会话准备授权时的未知回执、选择切换和过期观察均不提交工作，另核回执前原通知、并发重复发送、外来权限／读取范围变化，以及已显示 trusted 的 unknown 原申请不能跳过核实。原诊断模式与权限菜单断言保持；[真实窗口](test/isolated/native-human-input-electron.test.ts)核首次输入、正常退出后冷重开和同文独立重交，重开不增加恢复申请、问答或模型调用。当前运行结果见[测试 owner](../../tests/README.md#子-agent-协作-v11-验证)。

[NativeDesktop](src/native.tsx)为已有根会话接入原 [Composer](../../packages/ui/src/desktop/Composer.tsx)的请求批准／自动审核／完全访问菜单和停止按钮。模式沿现有 permission observation 提交，只改当前会话，不改工作区默认；请求批准直接提交 `accept_edits`，不再映射为旧 `ask`。Full 仍须原风险确认，确认绑定当前 generation、Store、Session、阅读选择与 history epoch；取消或切会话后的旧确认没有写入资格。模式选择不启动任务，也不清理原草稿；未读完历史、事实不可用或原权限申请未核实时等待。普通 Composer 的模式选择不以项目已信任为前提，也不自动设置信任或启动 Model；项目授权在明确发送前独立准备。诊断会话工具中的模式表单仍按其显式信任入口控制。原计划窗口按真实信任→Auto 顺序运行，由真实审核返回 `ask_user` 后保独立工具审批；完整审核、Files 与冷读断言保持；准确回归范围见[PC 迁移主线](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)。

普通历史／View 后台刷新只暂停操作，审核标签按 generation、Store、Session 和 Workspace 保留上次已确认模式，不以新的 viewSelection／history epoch 丢弃同会话标签。模式展示使用原有界 `NativeDisplayCache`，最多12项；generation／Store 替换清理，真实权限或后台观察失败撤销当前项。缓存不保存 permission observation、trust 或写资格，未命中时显示明确读取占位。目标选择尚未得到 Main 确认时保留当前草稿并只读，确认后才一次切换到目标缓存草稿，再独立核对持久草稿；原本空草稿的禁用发送、实际发送／停止中与真实失败仍按原事实展示。Native 将普通读取等待交给 Composer 的 `sessionLoading`，已知标签、图标、透明度及悬停保持，权限、模型和执行动作仍沿当前事实准入。[页面 DOM 回归](test/isolated/native-session-navigation-dom.test.tsx)模拟 Main 在普通 View 刷新时暂撤 permissions，核标签、计时和输入节点保留，操作仍禁用，真实失败提示仍出现。

停止沿现有 [NativeCaller](electron/native-caller.ts)保存并提交 `command.cancel`，目标是已核实当前 Store／Session 活动 Run 的 `originCommandId`。它不新增停止端口，也不把申请当成终态；原保存／提交中／未知申请禁止重复，准确结果仍由原 Run 和持久申请核实。只读子详情没有这组控制，切换阅读不停止原工作。

[原页面 DOM](test/isolated/native-new-conversation-dom.test.tsx)核模式、Full 取消／跨会话确认撤销、草稿和零任务提交；[原 Main 权限](test/native-permissions.test.ts)保独立原申请及未知结果。[实际源码外 Auto 窗口](test/isolated/native-auto-approval-bundle.test.ts)经完整候选的默认 Core／Service／Main 和原 Renderer，核批准、拒绝、请求人工、无效审查结果和审批中准确停止。转人工保原原因，只有实际批准产生准确文件效果；拒绝终止原任务，停止后迟到批准没有效果。普通退出后五种原记录完整冷读，Provider 与回答次数保持。该窗口只证明本机 macOS 当前 Store；全部封存／恢复、完整 PC 和独立迁移审查仍开放。实际执行及原失败见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原会话权限停止与自动审批闭环)。共享 Composer、Core／公共 API、SQL 和私有持久格式均未改。

## 输入区上下文占用

2026-11-09，Windows／Bun1.4.4：同会话Loop刷新不再主动关闭权限、模型和附件弹层，操作资格暂缓与Full原确认失效仍独立核验；模型弹层按稳定会话scope关闭，不按临时读取状态关闭。上下文读取失败／空结果后台退避恢复，离开范围取消重试。UI25项、Native数值IPC34项及上下文DOM6项共65项覆盖未变化的弹层与读取恢复。最终Core冷读与Service子Loop两个完整文件13项／123断言通过，核同一数据冷读前后计数一致及无新增metadata字段。Desktop／UI／Agent／Service类型和八workspace静态边界通过。Chrome156隔离生产组件与模拟桥接在深浅主题、500／1440px四组合中，让三种弹层各经历三次刷新开／关，共432帧均保留原节点和可见性；同轮权限等待72帧、公共表单／开关检查保持通过，共10组。截图与报告归本机 `.cache/session-shell-browser-4FNgcM`、`.cache/loop-popover-context-review-20261109.json`。Core复用原模型请求中已经封存的工具正文，并核对既有Store／Session／Run、调用、消息来源及不可变终态结果；不新增metadata字段，不改变统计数据结构，不重新执行工具或调用现在的格式器。主／子Agent及Run／step工具共用该通用路径，新增工具无需登记。相同事实在运行中、结束后和重启后保持同一统计口径；确实缺少原请求或来源冲突时才不可估算。本机原会话使用现有数据库只读回验得到42944／262144 tokens（约16%），业务游标不变；这验证原数据可用，运行中的客户端界面是否采用当前后端另行核对。

[NativeDesktop](src/native.tsx)通过 [useNativeContextUsage](src/native-context-usage.ts)向共享 [Composer](../../packages/ui/src/desktop/Composer.tsx)传只读上下文估算。圆环的比例固定为 totalInputTokens / contextWindowTokens，分母是最近已保存原请求所属冻结模型的完整窗口，不能使用累计缓存率、累计输入或API中扣除输出预留后的 utilization。浮层标明约数，显示上下文已用与总容量；窗口容量未知时显示未知，尚无可用原请求、数据失效或读取失败时清除旧数值，原圆环保留空轨道并标明未知；新对话缺少上下文数据时隐藏圆环与浮层，已有会话仍保留未知状态。累计缓存命中率与命中／总量放在同一圆环的提示中，不单独显示工具栏文字。模型入口与圆环相隔8px，宿主已提供模型时不再渲染空名称节点；模型弹层默认top-center并保留视口避让。圆环由共享 Composer 直接渲染为无点击操作的状态图标，保留悬停与键盘聚焦的详情提示。首次打开目标会话时，两路 hook 分别返回读取待定状态，Native 在历史及所需指标读取结束前通过`metricsLoading`保留同一组节点，显示空圆环，随后一次接管目标数据；已有对应已核实样本时继续直接恢复。真实失败、无样本或无可用估算会结束占位，无缓存样本时提示明确显示暂无数据，圆环仍保留，原错误事实保持，输入、权限与停止资格不等待指标。上下文无可用结果也沿原有界缓存记住对应消息／模型的只读展示状态，避免返回时重新插入占位；读取失败或终态尚未取得估算时，从500ms退避只读重试，最长间隔30秒；切换会话、读取资格撤销或离开时取消计时及原读取。新选择仍重新读取，模型、正文、来源或观察边界变化继续失效。

2026-11-05，Windows x64／Bun1.4.4：首次打开的隔离 Native 页面修前记录为70%／2%→两项消失→30%／4%；修后深浅主题在选择、模型准备、历史读取、两路指标分别返回及缓存往返的400帧中始终只有一组原指标节点，依次为原会话数值、静态读取状态、目标会话数值。18张阶段截图已目视核对；历史就绪而指标仍待定时，输入可编辑、原停止按钮可用。原会话页、缓存、上下文和输入编辑四个完整文件31项／425断言通过，包含失败结束占位及后续重新打开恢复；Desktop／UI类型和定向Biome通过。原始修前记录、修后逐帧数据与截图在本机`.cache/metrics-switch/`。该结果覆盖生产编译样式与实际Native组件的隔离浏览器过程，不扩大完整Electron窗口、安装或其他平台资格。

[Main reader](electron/tool-messages.ts)的 toolMessages.contextUsage沿原有限IPC只接受一个已观察的完整助手Message ID，复用原read lease、关闭与退出释放；核准确当前Store、Session、Run、成功Model Execution、消息正文与来源后，调用现有 getContextEstimate，只回传模型、上下文选择及输入／窗口数字。响应前再核当前View、选择、工作区和原消息；不向Renderer回传上下文正文，不写入、不初始化Provider、不启动模型。这个用户可见的数值展示不开放测试Context面板。API的完整历史预测、实测基线和来源限制归 [Core owner](../../packages/agent/src/context-estimate.README.md)，未发送草稿、重新捕获的项目来源与随后模型／工具配置变化不在该预测内。

Renderer按generation、Store和history epoch清空有界显示缓存，按会话、工作区、context selection保存最多12项，并逐次核对原消息和已选模型；普通读取期间可保留同目标已核实比例，已知模型改变或上下文切换后不沿用原比例。完整消息高水位、原助手消息及阅读身份变化驱动重新估算，普通无关重绘和缓存率变化不触发新读取；迟到响应与失败不发布旧范围，切换、重载和退出取消所属读取。[数值IPC与来源回归](test/native-tool-messages.test.ts)和[占用DOM回归](test/isolated/native-context-usage-dom.test.tsx)分别核只读范围、分母独立、异常计数、迟到取消及显示隔离。

2026-10-20，Windows x64／Bun1.4.3，`5dba8a6b`工作树加本次接线：`bun test --parallel=1 --max-concurrency=1`运行上述数值IPC、占用DOM、原累计缓存DOM与共享页面四个整文件，34项／317断言通过；UI／Desktop类型、15个相关源码／测试的Biome、文档、边界与测试归属检查通过。Chrome155沿实际Composer与Native编译样式核深浅主题各1240／360px四组，覆盖悬停、键盘、Escape、真实零、未知容量及显示独立；另以实际NativeDesktop和明确隔离Main替身核会话切换，缓存70%／30%时圆环分别为68%／20%。未运行本轮安装版IPC窗口或其他平台；前轮已确认的环境停止控件壳层测试既有失败仍不作为本次通过证据。Main数值端口新增后，开发热更新页面不足以加载它，须完全退出并重新启动客户端。

## 原输入区累计缓存命中率

[NativeDesktop](src/native.tsx)通过 [cache metrics adapter](src/native-cache-metrics.ts)给原 [Composer](../../packages/ui/src/desktop/Composer.tsx)传累计缓存用量，在上下文圆环的悬停提示中显示原累计百分比及完整命中／总输入 token；它与上方上下文占用的分子和分母独立，展示实现见 [UI owner](../../packages/ui/README.md)。缓存文字不单独占据工具栏；读取中保留圆环，无样本时提示明确说明暂无数据。完整历史读到固定高水位后，按所选会话全部已观察的完整助手消息读取，不限于 View 近200项；真实 cached input为0且input大于0才计作已核实的0%样本，缺缓存字段或总量为0不补造样本。分叉／包含的封存消息保原来源，同一个原 Store／Model Execution只计一次。后台历史／View 校准和新一轮用量读取期间，保留同一阅读范围内、正文与来源仍匹配的已核实样本；新样本整批核实后才更新累计值。原消息改变或移除即剔除对应样本；切换会话只恢复目标会话自己的样本，在新 viewSelection 下仍重新读取。generation、Store 或 history epoch 变化清空旧指标快照。失败保留仍匹配的原样本，可显式重新读取，不启动或重放任务。

[Main reader](electron/tool-messages.ts)沿已有有限IPC增加 `toolMessages.usage`，复用close与所属read lease，每批至多32个已观察 Message ID，从当前生成 Client GET核原 Model Execution／Session／Run、成功结果和准确content，以及前后连接与原消息未变。它只返回已核实的缓存命中／未命中token；整数、非负及cached不大于input分别校验，不将缺失视为0。封存来源读取不可变Model用量，不借来源Run后来状态取得热事实；当前Store保存的旧Store结果另核终态出处，foreign active拒绝。读取失败不发布部分新样本；原历史正文、权限与准确停止继续独立，未新增Core／HTTP／SQL／私有持久格式。

[Main与有限IPC测试](test/native-tool-messages.test.ts)、[原Composer DOM](test/isolated/native-cache-metrics-dom.test.tsx)和原[源码外默认窗口](test/isolated/native-bundle.test.ts)分别负责来源资格、累计／去重／迟到／无样本和默认SDK用量的首次及冷读。实际输入与结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原输入区累计缓存命中率)；累计口径与来源核验保持，完整PC、全部恢复组合、资源退出和全阶段独立审查仍按原计划核对。

2026-11-05，Windows x64／Bun1.4.4，按本轮确认调整默认展示：缓存文字常驻默认0%、最小宽度70px并居中，圆环在新对话、读取、无样本及失败时保持原节点。修前原冷页几何回归实际复现指标组在读取结束后缩短并右移18px。修后单独执行原[浏览器几何回归](test/session-shell-geometry.fixture.ts)的指标与会话两段：深浅主题、500–1920px共36组／5806帧通过，覆盖两路读取分别返回、0–100%文字、无样本、键盘详情／Escape、新对话往返、草稿及上翻阅读位置；已观察相关阶段截图，未见指标显隐造成的跳动或重复输入区。四个相关整文件42项／591断言、UI／Desktop类型、定向Biome与文档检查通过。本机逐帧数据和阶段截图分别在`.cache/session-shell-browser-HcSLvX/`及`.cache/session-shell-browser-YvCS6n/`；本轮使用实际Native组件与生产编译样式的隔离Main夹具，未复验完整安装版Electron或真实模型。

## 会话工具栏显示快照

[NativeDisplayCache](src/native-display-cache.ts)仅保留进程内展示数据，每个模型／指标／审核标签缓存至多 12 项、总计 16MiB，单项超过 4MiB 不保留；按访问顺序淘汰，没有隐藏的会话组件或持久存储。模型目录按当前 generation、Store 和配置 revision 隔离，分别保存每个 Session／Workspace 及新对话准备页的已读事实；返回时不先清空标签，后台 GET 完成前模型与发送仍不可用。缓存率按当前 generation、Store、Session、Workspace 和 history epoch 隔离，复用时逐条核当前已读消息的准确内容与来源，去重、真实零和缺样行为保持；读 lease 仍绑定新的 viewSelection，迟到读取不能替换其他会话。

[NativeDesktop](src/native.tsx)在选择交接时先暂停旧历史读取并门禁操作，目标选择确认后一次交接其缓存正文与元数据，避免旧选择配新正文造成工具栏短暂清空。未命中模型展示缓存时，先经原 `input.models.read` 准备该目标的完整目录与持久模型路由，再发布目标页；原模型名和档位直接更新到最终值，不经过“选择模型”占位。`NativeModelSnapshots` 将原有界展示缓存交由导航与 [NativeModelPicker](src/native-model-picker.tsx)共同使用，预算和身份隔离保持；命中目标缓存时不等待额外准备，原 Picker 继续后台核对。冷准备的结果沿 generation／Store／Session／阅读选择／配置 revision 交给原 Picker，消费后不重复 GET；同一路由也按新阅读身份重新发布 ready，不能沿用旧会话发送资格。Main 在本次选择期间暂未发布 selection 时，仅保留旧选择的只读展示，撤销 permissions 并标记 viewLoading／permissionUnavailable；它不能恢复发送、审批或停止资格。目标草稿直接从原独立草稿缓存恢复，不先置空再填回。模型控件在后台核对时保留原 DOM 与文字颜色，弹层随禁用关闭；真实失败保留原错误。准备期间只延后目标 selection 的可见交接，原目录和全局失败仍发布；后台 state 通知和 layout 驱动的历史读取遵循同一准备门禁，不提前启动目标历史。新目标、退出或 generation 变化使旧准备失去发布资格；等待期间观察被撤回时只保留已确认目标的只读身份，最新失效标记胜过旧回执，Store 替换放弃旧准备；模型读取错误由目标 Picker 明确展示，目标历史继续加载，缺失的原路由不静默落到全局默认。这里仅调整 Renderer 的读取／发布顺序，不增加 Main／IPC、Core 或持久协议。

进入定时任务页时丢弃本次导航的模型预读交接，返回会话时重新核对模型目录；原历史校准与未发送草稿保持。[定时任务 DOM](test/isolated/native-scheduled-tasks-dom.test.tsx)核往返读取、原草稿和零额外创建／发送。

[模型 DOM](test/isolated/native-model-picker-dom.test.tsx)、[缓存率 DOM](test/isolated/native-cache-metrics-dom.test.tsx)和[完整会话页 DOM](test/isolated/native-new-conversation-dom.test.tsx)分别核模型与比例不串会话、原节点保留、延迟响应、epoch 失效、容量限制、无选择交接时禁止写入及首条自动进入。

2026-10-19 Windows x64／Bun 1.4.3／Chrome 155，基于 `f734245a` 加本轮工作区改动：原实现用新增冷会话断言复现模型尚未就绪就发布目标页；修复后 `bun test --parallel=1 --max-concurrency=1 ./apps/desktop/test/isolated/native-session-shell-dom.test.tsx ./apps/desktop/test/isolated/native-model-picker-dom.test.tsx` 的18项／238断言通过，覆盖同模型新范围 ready、无重复 GET、后台状态通知、迟到准备、真实错误与准备中的观察撤回。合并后的19个相关整文件共139项／3208断言通过，Desktop typecheck、定向 Biome、文档和边界检查通过。增强的 `bun apps/desktop/test/session-shell-browser-runner.fixture.ts` 在浅／深主题完成冷页长模型名首帧、192帧等待采样和200次暖切换，模型按钮保持原 DOM，模型名／档位与同帧标题一致，无占位带来的中间宽度，业务写入为0。该夹具使用实际 NativeDesktop／CSS 与模拟 Main，浏览器沙箱开启；完整 Electron 安装窗口与真实 IPC 未复验，原嵌套 `@keyframes` 及既有 ToolActivity key 测试提示保留。
## 原交互记录只读历史

原“会话工具”侧栏的“交互记录”由 [NativeInteractionHistory](src/native-interaction-history.tsx)复用 `InteractionCard` 阅读问题、计划审核和普通／MCP 审批，保存答案、取消、当前 revision 与 accepted decision 分开表达。通用 question 保原 schema／JSON 答案，不借默认 `ask_user` 的 q1–q3 解释任意定义。计划的实际修改反馈按原字符串显示；原 PlanBody 提供格式化阅读，完整原附件可另行展开。没有回答回调，待回答记录也只读；当前真正待输入卡和原提交链继续独立。

[Main reader](electron/interaction-history-reads.ts)只从已准入的当前 Store／Session／Workspace 与阅读 generation、viewSelection、historyEpoch 推导范围，经原公共 `listInteractions` 的明确 `origin:'all'` 每页20项读取全部状态，没有累计项数截断。首 snapshotCursor 在每页保持，核原来源／展示关系、ancestry、规范游标、严格 ID 顺序和准确 nextAfterId，真正 EOF 才发布完整记录。分页期间任意 Store 通知水位变化会拒绝拼接，含其他会话或模型输出变化；本会话上次完整记录可保留并明确未更新，用户显式重读。它没有冻结新历史 API，也不承诺连续变化时一次完成。

附件仅从本次已观察卡的准确 key 推导，先经明确 `origin:'all'` 的公共 GET 核原 card／revision，再由原 SDK reader 分别核当前准入和原附件 Store、scope、hash／UTF-8／EOF；[64KiB Native reader](src/native-interaction-attachment.ts)继续核原字节。历史使用独立附件实例和方法，不能进入当前审批的 loaded proof；关闭、刷新、切范围或 detach 释放所属 GET 与正文资格，迟到结果不能替换新范围。此阅读链只有 GET，沿既有公开维护明确恢复；DB／私有格式不变。公共只读 query 增加可选 origin，默认当前查询与回答资格保持。新 Store 的历史卡保原出处，标为“恢复历史，只读”；未完成卡沿实际维护结果显示取消，原请求、答案与 accepted revision 保持。Fork／Include 只读自己的实际记录，不补来源后来的 Interaction。

[Main／分页与附件反例](test/native-interaction-history.test.ts)、[原卡 DOM](test/isolated/native-interaction-history-dom.test.tsx)与[真实 HTTP／Core](../../tests/isolated/unified-agent/client-interactions.test.ts)分别核完整读取、只读／迟到与通用问题／child 来源；原[默认源码外窗口](test/isolated/native-bundle.test.ts)核首次／冷读记录，原[计划窗口](test/isolated/native-plan-review-bundle.test.ts)核历史大附件、准确反馈和零重复提交。准确执行输入、失败与范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原交互记录只读历史)，取舍见[历史阅读决定](../../.agents/notes/implemented/architecture/2026-10-09-native-interaction-history.md)。当前 Store 自动审批的实际窗口范围见[输入区控制](#原会话输入区权限与停止)；完整 PC、全部封存／恢复组合和整片独立审查仍未关闭。

新 Store 完整交互历史的[真实 HTTP／Core／SDK／Main 回归](../../tests/isolated/unified-agent/client-interactions.test.ts)保问题 schema／答案、计划完整内容与修改反馈、child 原审批与 accepted revision、取消和完整大附件，核首次及冷只读、默认当前查询隔离、旧卡回答拒绝、Fork 不补后来记录与零新水位／Model。[现有安装版问答窗口](test/isolated/native-restored-questionnaire-bundle.test.ts)继续沿原 Questionnaire／ToolRow，并从会话工具读取同一份原 Interaction 请求／选项 ID／自由文本对象；实际选项标签仍由原工具回执展示。三个真实 macOS 窗口核源、Fork 空历史、包内 CLI 恢复后的首次与冷读、关闭及三 Service 普通退出／双 EX。原 120／45／10 秒期限和原断言保留，actual0／1pass／24Bun及全部 driver／77.95秒，Provider2、原答案 POST1、恢复阅读 POST0和封存来源 Run GET0。直接七文件33pass／758断言与各 owner／root types通过；准确新增断言失败及未验范围归[恢复历史进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后完整交互历史)。本片没有新的计划／审批 installed 窗口，完整 PC 与阶段退出资格保持。

## Native 项目会话目录

[目录适配器](src/native-presentation.ts)将公开 `activity.hasCreatedWorktree` 的已确认历史事实投影给原 Sidebar；不可用观察保留上次目录中的历史标记，新的 Store 不继承旧标记。投影的行复用比较包含该字段，后台会话创建成功即可更新准确原行，不依赖当前选择或读取全部聊天正文。[目录回归](test/native-directory.test.tsx)核对从无标记到成功标记、无关行复用、刷新／切换／冷投影及 Store 隔离；图标与状态共存由[UI owner](../../packages/ui/README.md)负责。语义见[桌面手册](../../docs/handbook/clients/desktop/README.md)，原创建记录与读取边界归[Worktree owner](../../packages/agent/src/tools/git-worktree/README.md)和[Store owner](../../packages/agent/src/storage/README.md#目录分页)。

工作树目录被移走或删除时，[Controller](src/controller.ts)只将已核实选择下的准确 `workspace_identity_unavailable` 转为内部 `workspaceUnavailable`；Main 首次／再次 attach 仍可返回原历史选择，消息、原 Model 完整输出及只读 Context 保留，旧权限事实撤下。网络／主体／Store 失败继续使原观察失效。新执行、授权新增、扩展／文件／Context 变更在 [Main](electron/native-caller.ts)及 renderer 关闭；本地草稿 CAS、准确原 Command／Execution 取消、原观察绑定的队列撤回／重排、原命令查询及会话管理保持既有准入，待决交互沿原“停止任务”入口收束。恢复目录后重开会话重新读取身份及信任，不沿旧缓存自动重发。缺目录说明由[Native](src/native.tsx)按当前会话在局部目录状态区呈现，不进入全局Toast映射；原会话不会改绑到新路径。[Controller 回归](test/controller.test.ts)、[Main 回归](test/native-caller.test.ts)、[真实页面回归](test/isolated/native-new-conversation-dom.test.tsx)核冷读取／重挂、原出处完整输出、迟到选择、草稿和取消／新执行分界；图标本身只记录创建历史，不探测实时路径。

同日普通`bun run desktop:dev`实机验收（Windows x64／Electron44.3.0／Bun1.4.4，真实development Profile和已配置gpt-6-luna）：初次创建获批后仍在只读prepare/list失败，原记录是`git_operation_failed/mutation:not_started`，没有图标误亮；原8次Tool均保留失败，模型末尾“授权问题”的概括不能代替原Job原因。修复[Windows Git stdio](../../packages/agent/src/tools/git-worktree/README.md#可信资产与验证)后，重新根build并完整退出／启动新Main和Service，新独立key`desktop-icon-r2`真实创建detached树，原Tool成功、两个Job均请求`full_access/none`，来源cwd保持，生产同源目录标记由0变1，真实侧栏显示Git图标。原创建意图没有重放。将`linked-r2`从普通“添加项目”登记后，新会话Shell/Worktree配置根均为它；相对read／write实际成功，写入仅出现在新根。Auto对来源`.git`的外写返回`permission_denied/file_full_access_required`，adapter和dispatch均未发生，未扩权或重试；该范围不证明已实际尝试Git commit。

实机还观察到旧Main在自有普通目录被移走后，renderer重挂进入`workspace_identity_unavailable`启动失败页；还原目录可重试。新Main冷开该历史时保留两条真实消息，非空草稿仍可保存而发送禁用；还原并重选后，草稿和原历史保留、权限重新读取。随后对真实`linked-r2`先用原只读清理函数核无联接，再定点移到相邻保留目录模拟用户删除：Git登记为prunable，来源创建图标保留；重选worktree会话仍完整读原历史，目录提示沿底部已有状态区对齐且不串入健康目标，依赖目录的执行关闭。目录已原样还原、登记正常，原来源内容及两个测试目录数据保全，未执行递归删除、force或prune。整个过程逐步观察消息接管、目录选择、读写、切换及恢复；运行原始Job／批准／真实Workspace与文件证据在本机`.cache/worktree-desktop-live-20261106-b8da26c4/`，两次根构建日志在`.cache/desktop-worktree-rebuild-20261106-agent-escalated.log`和`.cache/desktop-worktree-final-rebuild-20261106-agent-2.log`。这是当前普通开发客户端的有限本机验收，未取得安装版、其他平台或全部失败／恢复组合资格。

2026-11-06，`8364d9e40` 加本轮工作树／Windows x64／Bun1.4.4：以 `bun test --parallel=1 --max-concurrency=1` 定向运行共享 Sidebar、Native 目录及后端／Client 相关整文件，共34项／737断言通过，原macOS真实 Git Tool／Job场景在Windows按既有条件跳过1项；其新增HTTP目录断言未计实机通过。跨层目录回归实际走SQLite持久回执→Service→生成SDK，核失败／未知不误标、Fork omit、冷只读与零写入。`bun apps/desktop/test/session-shell-browser-runner.fixture.ts --worktree-indicator` 在Chrome156.0.8078.80通过深浅主题×200／300px导航四组40阶段；逐阶段核创建→运行／待输入→切换→完成未读→刷新→已读→提示→完整UI重挂，正文消息、输入位置与阅读位置保持，786帧图标节点未替换、页面异常0。过程截图与报告在本机`.cache/session-shell-browser-2IEaTD/`；沙箱内首次Chrome启动失败，成功结果来自批准后的同一隔离运行器。全仓typecheck、API生成一致性、定向Biome、边界／workspace／测试归属及文档检查通过。该浏览器使用隔离目录桥，不执行真实Git或模型，不取得完整Electron安装版或其他平台资格。

[完成提醒](src/native-turn-notifications.ts)沿完整目录中准确的最新 Run ID、inactive 与 terminal status 生成本机未读状态，通过共享 Sidebar 的 `hasUnreadTurn` 在右侧显示蓝色光点。[Main 私有库](electron/private-data.ts)在首次已读写入时惰性迁移到 DB12 的 `session_read_turns`，以 Store／Session 为主键，仅保存最后已读 Run ID 与终态；旧草稿、队列、定时任务及其他 journal 保留，沿原私有路径检查、FULL 与原子事务，不改变业务 Store、公开 API 或工具版本。选择此位置的理由归[取舍](../../.agents/notes/implemented/bug-fix/2026-11-04-native-turn-read-receipts.md)。

目录的 `readTurns` 由 Main 从当前 Store 的私有库读取；首次读取未知时不把所有历史当作未读，后续失败保留该窗口已有的核实记录。[内部 IPC](electron/native-ipc.ts)的 `session.markRead` 沿原主 frame／generation 门禁，Main 再核当前选择、原 Store、准确 Run inactive／终态与最新目录一致后写库。renderer 只在实际会话页面可见、历史完整且读取资格有效时提交；已经显示的圆点等 SQLite 提交成功后才消失，保存失败保留提醒并可随后续观察重试。持续查看的活动 Run 在当前页面结束时，按 generation／Store／Session／Run 保留观察身份，在普通历史刷新和已读保存期间不先插入圆点；此展示抑制不写已读事实，切走、隐藏窗口、读取失败或保存失败立即恢复未提交的提醒。切换等待、失败、设置页及隐藏窗口不消费提醒；完整退出、开发随机端口或制品路径变化不影响数据库记录，下一 Run 或恢复后不同终态重新提醒，不写 Runtime、最近消息时间或执行状态。

[整页回归](test/isolated/native-session-shell-dom.test.tsx)通过隔离 Bridge 核后台完成、运行指示交接、选择／模型／历史等待、数据库写入失败后恢复、隐藏／可见、下一轮及更换 origin 后重开的已读记录，同时保草稿和零业务提交。[真实 SQLite 回归](test/isolated/native-turn-read-store.test.ts)运行两个独立 Node 进程，核 DB7→12 原子迁移、Store 隔离、冷读、单会话覆盖、写入失败保原记录、同 Run 恢复后终态及原草稿／队列兼容；[Caller 回归](test/native-caller.test.ts)核准确选择／Run／Store、活动或猜测事实拒绝、封闭 IPC 与零业务写。原只在同一 DOM 重挂载的测试不证明跨启动 origin 的持久化。实际生产组件与编译样式的浏览器过程验收沿[原会话夹具](test/session-shell-browser.fixture.tsx)的隔离完成提醒场景；其控制按钮仅存在于测试制品，不进入普通 dev／prod 客户端。

2026-11-05，Windows x64／Bun1.4.4，当前会话结束时圆点闪现修复：新增整页回归先在旧实现复现保存等待期间出现圆点，修复后完整文件21项／358断言通过。MutationObserver核本轮结束、历史刷新、保存等待及提交成功期间没有插入圆点，并核切走、读取失败、保存失败及恢复；已有后台提醒在打开和保存等待期间仍保留。Desktop类型、定向Biome、测试归属与文档检查通过。本机生产组件预览已编译，IAB连接本机地址超时，本机Chrome接管因Computer Use无法可靠识别当前URL而终止，未取得实际操作过程或视觉验收；隔离入口在本机`.cache/turn-notifications-preview.ts`，制品在`.cache/turn-notifications-20261105/`。未修改或重验Main、真实SQLite、模型和安装版。

2026-11-04 首版 localStorage 实现，Windows x64／Bun1.4.3：当时逐文件运行 `bun test --parallel=1 --max-concurrency=1` 的 `native-session-shell-dom.test.tsx`、`native-directory.test.tsx` 与共享 `desktop-sidebar.test.tsx`，三个完整文件29项／640断言通过；该证据未覆盖完整进程退出或 origin 变化，不能证明当前 SQLite 实现。首版实际浏览器未验收：IAB 对沙箱内本机预览连接超时，改用本机静态服务后 webview attach 仍超时；期间发生一次环境内存不足。未将编译、DOM 或制品当作深浅主题、像素及实际操作过程通过。

同日用户报告已读圆点重启后再次出现后，按本次 SQLite 修复工作树重验：12项／189断言的整页文件核跨 origin 与数据库失败，55项／604断言的 Caller 文件核主进程身份门禁，真实 SQLite 文件通过两个独立 Node 进程冷读；原草稿冷读和定时任务整文件也通过。原 `native-input-queue-journal.test.ts` 首次因 Windows 夹具缺 windowsAsset 失败，补齐既有 native asset 准备／交接后完整文件1项／4条 Bun 断言通过；45秒用例总期限包含原生资产构建，子进程15秒期限及全部原业务断言保持。本次 SQLite 回归还核 DB12 下原队列 journal 保存与另一进程读回。Desktop类型、定向Biome、边界、测试归属及文档检查通过。隔离 Electron 窗口已用当前生产 Sidebar／提醒 hook、真实 private-data 与独立 Profile 启动，操作观察被 Computer Use 应用授权超时阻断，未取得窗口退出重开或视觉验收；启动记录在本机 `.cache/turn-read-ui-live/`。真实模型、完整安装版及其他平台未重验。

提交前在主工作区再次执行已读SQLite、输入队列journal、Caller、整页、目录及共享Sidebar六个完整文件，87项／1263条Bun断言通过，Node夹具另核原SQLite事实；UI／Desktop类型通过。额外未改的[旧私有文件整链](test/isolated/private-data.test.ts)在Windows未通过：其夹具没有交接windowsAsset，预期owner_busy的准入先得到windows_access_asset_unavailable，尚未进入数据库断言。以当前HEAD的旧private-data源码和本轮源码分别构建同一原夹具，在独立私有Profile下均复现该失败，未修改断言或把它计为通过；对照及失败环境保留于本机`.cache/commit-all-20261104`和原运行器路径。该既有夹具问题不由本轮DB12冷读通过取得原整链或完整Windows数据安全资格。

正式目录直接复用 [Sidebar](../../packages/ui/src/desktop/Sidebar.tsx)，替代临时 NativeDirectory。适配器按公共 workspaceId 分组，项目默认展开，可独立收起；空项目显示“暂无聊天”。上下键只移动当前项目列表焦点，确认沿原 Session ID 读取；收起不调用 bridge、不改选或取消工作。首次发送等待不阻止阅读已有会话，原 NativeDesktop 仍保护迟到创建、后来选择和草稿。选择标记核同 Store，目录 Store 更换重置展示。侧栏先显示五项、“展开更多”每次增加十项只是展示完整已读目录，不改变公共分页或高水位。

Workspace/Session 完整目录分别读取；其间新登记的项目可能还未进入项目上界。相应 Session 保留在“项目待读取的会话”，可读原历史，但不提供该未观察项目的新建入口。Session 目录使用公共 `listAllSessionDirectory` 穷尽同一观察，未选中会话也有实际 active／latest Run、排队及同主体当前 Store 的待输入数量。更新时间取原 Core 最后对话消息更新的封存时间，读取、改名和审批模式切换不修改它；未记录或未知格式保持缺席，原 Sidebar 按真实时间排序、悬浮显示本地时间。普通后台活动与人类待输入 Badge 分开；旧必需结果状态已移除。

活动 Run 的公开 `executionOwner` 仍是只读锁观察；[DesktopController](src/controller.ts) 的选中与 [NativeCaller](electron/native-caller.ts) 重连先调用 SDK `reconcileSessionState`，再读取公开历史。后端结算后，主／子轮次、工具及环境卡使用持久终态，不继续显示排队、回复动画或 Stop。原 [目录适配器](src/native-presentation.ts) 的“执行状态待核实”和 `executionUnconfirmed` 只承担失败／证据不足的回退展示；owner 观察只适用于同一个确实 active 的 Run，旧目录不能覆盖当前终态或后来新 Run。目录刷新失败时，同一活动 Run 的缓存观察按待核实展示，不恢复运行标记或停止按钮；后续完整目录确认持有执行权后才恢复。普通事件刷新保持只读；迟到旧选择不能发布，失败保留历史并报告错误。协议归[Core owner](../../packages/agent/src/storage/sqlite/run-resume.README.md#会话恢复时的状态核实)，[真实 Native 交接](test/isolated/native-session-reconciliation.test.ts)经实际 Service／Runtime／SQLite／Client／Controller 核 SIGKILL、冷读与零重放；[导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)核回退和缓存终态。

[Main](electron/native-caller.ts)在 SSE ready／change 后合并刷新全局目录，不逐个读取未选中 view、不取得其他会话执行权；目录读取与当前正文读取分别持有生命周期，慢目录不阻挡阅读。Store／attach generation 与独立读取 epoch 核对迟到结果；断线、reset 或读取失败保上次标题和时间，状态标为“上次确认状态”，连接文字显示“目录状态待核实”，不以旧数量显示当前待输入。detach 只 abort 所属 GET 并清本视图目录，不取消工作。显式刷新仍沿原目录入口，完整成功后才恢复当前状态。项目批量移除的当前范围见下节；单会话执行组的离线清理已接现有维护，安装版常用维护已具本机有限证据，DB8 原代码回退的本机边界已由[安装版窗口](docs/native-release.md#真实代码升级与冷回退)核对，其余维护恢复和剩余旧页面行为仍未闭合。

[目录 DOM](test/native-directory.test.tsx)与[草稿 DOM](test/isolated/native-drafts-dom.test.tsx)已直接核已有 Sidebar/实际 NativeDesktop：同名会话准确项目/原 ID、空项目、独立折叠零写、项目列表焦点零选择、创建期间阅读、晚项目保留与迟到创建保后来选择/草稿。新目录 DOM 另核真实时间排序、5/+10 展示、全局待输入／普通运行状态和旧事实保留；Main 有限 port 核第201项之后的非选中变化、失败保目录、慢读取不挡选择及 detach 迟到拒绝。源码外默认 macOS [窗口](test/isolated/native-bundle.test.ts)实际核审批期间切到另一会话、原目录 Badge／准确 Run／时间／排序、原卡返回、Provider 不增加与冷时间保留。具体输入和结果归[本片进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-全局会话状态与时间排序)，不以有限 DOM 宣称完整 installed/跨平台资格。

Main 对目录与所选会话分别保留一个在途读取和一个后继通知位，读取结束后合并100ms内的连续变化；所选会话的后继读取不再额外刷新目录。显式选择与原命令操作不等待该合并窗口，慢目录仍不阻塞所选会话。reset 后先读原事实与历史，ready 高水位等于该 baseline 时不重复读取，也不将 snapshot 当作已应用事件游标。同一阅读范围的历史刷新保留原消息组件和已展开全文，真实 attach／选择／history epoch 变化才释放原全文状态；加载中写资格仍按原门禁撤除。取舍见[刷新修复](../../.agents/notes/implemented/bug-fix/2026-10-08-native-observation-output-refresh.md)，原17MiB管理窗口与直接回归结果见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08native-大输出刷新与全文保留)。

## Native 空间批量移除

空间移除不在对话区插入常驻提示。显式操作的未知结果、拒绝及后台移除记录变为无法读取时，通过原非模态 Toast 临时呈现；同一次读取异常不会因刷新重复弹出。原申请未知时，「空间」旁显示查询图标；即使原空间不在目录中，也可从菜单选原空间查询结果，不重新提交。[Native DOM 回归](test/isolated/native-new-conversation-dom.test.tsx)核等待与刷新、Toast 关闭与去重、草稿保持、原 ID 查询、成功目录更新和拒绝。

原 [Sidebar](../../packages/ui/src/desktop/Sidebar.tsx) 的空间行将移除入口收进更多菜单，新对话与更多图标均为14px并沿原悬浮／键盘焦点显示；选择“移除空间”才调用原回调。[Main](electron/main.ts)通过主窗口所属的共享确认Overlay显示完整移除风险，默认和取消均为「保留空间」。renderer 只传当前目录的 Workspace ID；[Main port](electron/workspace-removal.ts) 固定实际 generation／Store／subject，在确认后重新核原 Workspace 名称与根，再将完整原申请先存入 Node 私有库并仅 POST 一次。当前选中目标移除成功才清其阅读页，其他空间的选择和草稿保持。重新添加同一目录创建新 Workspace 身份，原目录文件不删除。

[Store 批量事务](../../packages/agent/src/storage/sqlite/workspace-removal.ts) 一次保存全部根及子 Session tombstone、停止边界和原 Workspace receipt，目录同时隐藏；它不逐条等待，不冒充资源停止。回复丢失／不可信则保存 unknown，重开只展示原申请，明确从侧栏菜单选择原空间才用原 Store／Workspace／Command GET；其他 Store／主体在 HTTP 前拒绝，不改绑、不自动再提交。可信 4xx 显示未移除。目录状态未核实或私有申请不能保存时拒绝新移除。

首次保存移除申请在同一 FULL 事务惰性增加 `workspace_removal_intents`，私有 `user_version` 从 DB7 升至 DB8；没有移除申请的旧流程继续 DB7。闭合原申请最多128项／256KiB，只允许 submitting→unknown，不保存重发资格或当前路径。离线维护的 DB8／manifest v17 字节范围由 [maintenance owner](../../packages/agent/src/maintenance/README.md#desktop-db8-与-manifest-v17)负责。

产品手册要求永久删除相关历史；移除受理先隐藏目录、封锁新工作和请求取消。确认框说明退出客户端后的显式离线维护：[GC](../../packages/agent/src/maintenance/README.md#显式无引用附件-gc)在宽限和全部任务终态满足后清除该Workspace历史正文；活动、未知或待核对工作保留完整证据。原删除边界、去重摘要／回执和未发送草稿保留，原receipt不变。准确旧Session的 `historyPurgedAt` 由Core标记经生成DTO进入[原SessionPage状态槽位](src/native.tsx)，不会以空列表冒充历史完整。原「删除当前会话」入口说明同一离线维护也可清理单会话执行组；活动／未知／待核对工作及存活Fork或其他未清理会话依赖的来源保留。来源tombstone不撤回存活Fork已封存的只读历史资格，仍不继承执行权。安装版常用维护的有限链已验证；DB8 原代码回退的有限范围见[Native release owner](docs/native-release.md#真实代码升级与冷回退)；全部维护恢复和完整产品资格仍待闭合。

[有限 port 测试](test/native-workspace-removal.test.ts)核默认保留、先存后发、丢回复与冷 GET-only、异 Store HTTP零和闭合输入。[原源码外窗口](test/isolated/native-background-bundle.test.ts)沿真实 Main／Service／Node SQLite／原侧栏验证取消零 POST、提交后丢回复、冷查询、目录移除、同目录新身份和文件原字节；该历史OS确认由测试回调控制，其选项来自当时生产调用，不声称人工点击 OS 弹窗。

## Native 新对话准备与首次发送

已有会话的提示词由 [NativeDesktop](src/native.tsx)按Store／Session保存窗口内草稿；编辑事件同步更新缓存，主动清空也形成一份明确的空草稿。`draft.read`只在没有较新本地内容时恢复已保存正文，离开会话不以尚未提交到React的旧值覆盖缓存。提交冻结本次草稿对象；准确的accepted／applied／terminal回执仅清除仍指向该对象的原会话草稿，即使已切到其他会话也清除，后续编辑和其他会话保持。后续Main状态与原查询返回的input／caller受理元数据也按原Command／Store／Session定位提交对象，覆盖直接响应未知或迟到的情况。submitting、unknown、failed和rejected不清正文。首次提交、重试和原lookup沿同一对象核对，准备页另按本地编辑修订保护主动清空。[实际DOM回归](test/isolated/native-new-conversation-dom.test.tsx)覆盖迟到冷读、空草稿、切走／切回后的回执、未知转受理，以及后续输入与主动清空的保留；共享Composer／Lexical仍只接收Markdown值与onChange。

[Main私有库](electron/private-data.ts)在保存准确accepted／applied原回执的同一个FULL事务内清除对应已保存提示词；必须同时匹配草稿ID、修订、Store／Workspace／Session、原正文及摘要，清空后递增修订，后续保存的相同文本也不会被旧回执消费。`read`恢复旧版本遗留草稿时只核本地已确认原记录并修复准确匹配项；结果未知、拒绝、无关联凭据或较新修订保留。读取历史不会为此查询或重发Command，数据库schema、原Command和IPC请求格式保持。选中草稿的读取回复可附带本进程已提交消费的原Command／修订凭据；凭据仅在事务成功提交后记录，最多保留128项，只适用于当前准确的空正文后继修订。任何成功保存均使其失效，不进入列表、按ID读取或保存回复，也不持久化；冷重开沿普通读取取得实际修订。[真实Node私有库回归](test/isolated/native-prompt-draft-store.test.ts)核受理／应用后冷读为空、未知／拒绝保留、遗留记录修复一次、新修订保留与事务失败整体回滚；新数据库及同窗口延迟确认回归在修复前均失败，修复后通过。此前只清窗口缓存的验证未覆盖发送已保存草稿后的冷启动，不能作为本地库清除的证据。

2026-10-20补充Windows x64／Bun1.4.3／Node24.15.0／Electron44.3.0验证：上述私有库、实际Native DOM、Main caller和input共5文件57项／1110断言通过，Desktop类型和Biome通过。真实普通renderer、Main及Service在同一隔离Profile连续运行3次、完整冷重启2次，12个UI检查点通过：首次发送后冷进入为空、已有会话发送已保存草稿后冷进入为空、真实受理通知先于延迟IPC回执时切走再返回为空、未发送保存草稿在冷启动后保留。2次明确输入提交、3次本地Model请求，各轮正常退出0，最后记录的5个所属进程全部退出。只读SQL对照确认旧实现的accepted原文仍为修订1，修复后两份已发送草稿为空且修订为2，未发送草稿保持原修订与正文；证据在 `.cache/native-prompt-client-2944b5a2-1af1-47a4-affa-bd2c68946f22/`。本轮不提供安装包或跨平台资格，主进程修复需要完全退出客户端后重新启动。

[Windows真实窗口夹具](test/native-prompt-client.fixture.ts)执行 `bun run apps/desktop/test/native-prompt-client.fixture.ts`，独立构建当前Main／preload／生产renderer和Service，关闭测试诊断，使用私有临时Profile、合成项目、预置草稿与本地固定模型；随后用原生鼠标／键盘操作窗口。仅该测试Main包装器可在真实IPC校验完成后延迟 `draft.read` 或 `submit` 回执，私有 `control.json` 的一次屏障与退出端口用于人工竞争条件验证，不进入普通客户端。2026-10-20本任务工作树在Windows x64／Bun1.4.3／Electron44.3.0实际验证3个会话、11次选择、15个输入值检查点：独立草稿恢复、发送后切走再返回、较新输入／主动清空抵抗迟到旧草稿均通过；准确输入只提交一次，本地Model一次并显示完整回复。测试窗口正常退出0，已记录的Main与所属Service PID均消失。UI检查、IPC／模型事件和退出记录保存在 `.cache/native-prompt-client-*/`；受限进程首次启动退出3，允许桌面程序的本机进程环境复验通过。该证据覆盖当前文本草稿链，不代替安装包、多平台或冷重启未保存草稿的承诺。

首次发送保存空 title，标明需要[共享 AI 命名](../../docs/handbook/features/sessions.md#自动命名)；“新对话”只由 [native-presentation](src/native-presentation.ts)与页面标题作空名称占位，不作为明确名称阻止自动生成。命名完成继续沿原 SSE／目录／选择刷新显示。显式命名、定时任务名称和原创建意图的未知查回保持原输入；[准备页 DOM 回归](test/isolated/native-new-conversation-dom.test.tsx)核首次创建的未命名标记及原草稿／迟到选择，[目录回归](test/native-directory.test.tsx)核空名称占位。

[NativeDesktop](src/native.tsx)直接消费原 SessionPage 的欢迎标题、项目／分支菜单与 Composer，不展示任务建议卡片。全局及项目新对话入口只进入准备页，不创建空 Session；用户直接编辑草稿。准备草稿和已有 Session 未保存草稿分别保留，页面、项目及分支选择不清空原文。实际模型目录由 [NativeModelPicker](src/native-model-picker.tsx)经独立只读 `conversation.models.read` 读取全局配置。普通客户端读取期间只将原模型选择区标为 `aria-busy` 并禁用模型／发送操作，不在工具栏插入加载段落，避免会话切到准备页后先增高再收缩；输入与独立草稿保留，真实目录失败仍显示原错误。选择项目只读取其分支，不重挂目录或改变全局默认，首次发送仍核所选项目实际配置和支持档位。原 Full 风险确认保留；本次权限选择在创建原 Session 后、首条输入前应用，不写项目默认。

全局“新对话”按当前目录顺序默认选择第一个已登记空间，空间行内入口仍使用明确的空间ID；点击时直接用当前目录确认的目标ID更新项目展示与空间高亮，不先清成未选状态；同一空间重进保留已有分支展示节点，切换目标才清除旧分支事实。切入准备仍重置用户上次选择的分支，再沿原 `chooseWorkspace` 读取真实分支，读取期间不能发送；首条发送还要求分支事实匹配当前Store与空间。当前读取失败会撤销旧分支事实，保留目标项目名及草稿，保持静默，重新点击入口核实成功后才恢复发送；过期请求不清后来目标的分支事实。无当前会话的启动准备从本次完整目录的首项初始化，使用已读目录事实，避免闭包尚未更新导致默认选择遗漏；页面意图变化后不再应用旧的初始化选择。没有空间时保持未选与可编辑草稿，发送禁用。普通目录刷新不覆盖当前手动选择，重新从全局入口进入才按最新顺序重置。2026-10-19 Windows／Bun1.4.3、`f734245a`加当前改动：三项新增实际Native DOM回归在原实现均失败，修复后通过，核目录延迟、首项重排、空目录、显式入口、手动选择、迟到分支与首次发送的准确空间；连同新对话及启动两个整文件27项／700断言、Desktop类型检查和Biome通过。此为实际组件DOM证据，未复验完整安装窗口。

[NativeConversation](electron/conversation.ts)负责有限编排，复用原 NativeCaller 创建意图、私有草稿、permission controller、caller journal 和 DesktopInput。发送前冻结创建五元身份、输入 Command、原文、模型／effort、Plan 与权限；先保存未来原 Session 的准确草稿，再执行原创建。首条发送与明确重试在私有准备请求中另附可选 `draftLineEndings`，只包含从发送正文去掉的 CR／LF 后缀，不重复传输长正文；IPC 与 Main 均核后缀、规范化正文一致性和原草稿 1 MiB 字节上限，整个请求仍受原 IPC 预算约束。Main 重建原草稿并保存其准确修订与 SHA，真实 Command 正文和摘要保持原发送意图不变；完整准备请求的重复检查同时绑定后缀。准备的权限 controller 与正在阅读的选择分别持有观察，迟到结果不抢回后来页面。首次明确发送时按原 Session 绑定的项目与宿主读取范围准备授权，不追加独立范围确认；准备失败保留 Session 和原文，未知回执不继续输入，沿原权限申请查询。

原 [Git leaf](electron/git.ts)从 kite-desktop 迁入，保原分支与工作区语义，并使用上文的所属 helper 退出收束。Main 从同代次／Store 完整目录中的已登记 Workspace 解出规范路径；renderer 只能传 ID，分支结果没有路径或控制句柄。普通目录、缺 Git 的读取均可准备；只有显式选择另一分支才在首次创建前切换。实际根、HEAD、本地分支、脏文件与全部活动 Run／Job 均重新核对；Profile 和 Native／Terminal 制品根及其交叠目录不可切换。目标已与当前分支相同不执行切换，未显式选分支时使用发送时的真实环境。Service 按新 Run 读取／冻结项目配置，不沿旧单项目拓扑关闭或重启 Service。

首次发送立即清空准备输入并显示原首条消息，创建成功后自动进入同一会话；正常过程不显示“正在发送／已提交／请打开本次会话”等额外提示，也不增加手动打开步骤。首条消息沿未来原 Store／Session 的同一阅读 key 保持，选择与历史读取期间不切到加载页或欢迎页。真实消息按原 Command，或 `sourceIds` 加同 Store／Session 的实际 Run 原 Command 证明接管，避免重复展示；不按相同文本猜配，原 Store 的等待项不进入新 Store。发送后切到定时任务等页面时，迟到成功保留当前页面；用户返回时直接读取原 Session，返回时仍在创建则在原回执到达后自动进入。自动进入只跟随当前页面意图，后来的会话或页面选择会撤销旧意图。创建后权限或输入失败保留准确 Session 和原文，明确重试只用原创建身份、新输入意图。结果未知停用重复发送，「查询原首次提交」只核原创建／权限／输入；核实预备步骤成功后仍须明确发送，不自动续写。冷创建与持久原命令只具原 GET 资格，不恢复热首次写入权限。项目选择、分支信息读取和刷新不走通用 Toast；添加空间成功后的分支观察失败保留已登记目标，不把它误报为空间添加失败。真实业务错误按所属消息或独立业务 Toast 呈现，不增加确认弹窗。私有 SQLite 格式与公开 HTTP API 未扩展。

[Main 测试](test/native-conversation.test.ts)核准确原文保存、独立阅读选择、冷原 GET、权限失败／未知及真实 Git 切换守卫；[实际准备页 DOM](test/isolated/native-new-conversation-dom.test.tsx)核欢迎区与选择器、草稿、晚结果、同会话重试与实际消息接管。源码外 [默认候选窗口](test/isolated/native-bundle.test.ts)、[冷草稿窗口](test/isolated/native-drafts-electron.test.ts)和[Provider 窗口](test/isolated/native-provider-bundle.test.ts)覆盖受影响正式入口；准确输入、已执行结果及未验范围归[本片进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-新对话准备与首次发送)。

原输入 `accepted` 后仍观察同一 Command 的最终应用状态，不能仅凭 HTTP 受理显示为已启动。异步准备拒绝沿原 ID 只读收敛，失败跟随原用户消息；无 Run、没有对应新 Message 的冷 Session 也显示轻量“回复失败”，已有成功历史不会遮掉新失败，不退回欢迎页、不补造原消息。无消息可关联时固定当前完整历史后的展示位置，后续明确新输入成功后旧失败不漂移，Store/Session 切换保持准确归属。已有草稿的恢复受原提交对象和后续编辑修订约束；未知不重放，明确重新发送才创建新输入意图。此分支及首条占位／历史接管由[输入 owner](src/input.README.md)与原准备页 DOM 整文件验证。

2026-10-24 在本机 macOS arm64／Bun1.4.2／Electron44.3.0，以当前开发 checkout、普通 Native（测试诊断关闭）、原实际 Profile 和本机 Codex `gpt-6.1-sol` 完成真实发送：新建与同会话后续各一条，均保存完整回复，两个 Run completed、两条用户消息／两条助手消息、零 Tool 调用。首条／后续状态与历史接管持续观察；完全退出重开后能读取两份完整正文，切换返回的210帧保留消息顺序、空输入和无欢迎页回闪。Core 原命令数仍为8，重开及查询零新增命令，原两份启动失败记录没有重放。普通界面同步采用简洁的回复预览／全文文案，原因码仅留测试诊断。证据在 `.cache/native-conversation-live-20261024/`；此为当前 macOS 开发客户端及真实账户链路，不代替安装包或跨平台资格。

同日本次 review 以合成 HOME、独立 Profile 和 Electron 数据目录，启动普通 development Main、真实配套 Service 与生产 renderer（`testDiagnostics:false`），通过本机无认证 SSE 核实已有成功历史后的准备拒绝。原 Command 经 unknown／accepted／rejected 收敛，拒绝不新增 Run／Message；完全退出重开后保留旧回复和失败，原 caller 数与模型请求数不增，之后明确新发送成功，顺序保持 user→assistant→failure→user→assistant。首窗110帧与重开745帧中，冷历史和后续发送均无欢迎页回闪、重复或旧失败漂移，输入最终为空。原驱动因合成端点把附加 runtime-state 当作用户文本、返回相同回复而等待另一字符串超时；失败日志完整保留，独立只读 Core 和原过程帧核实两个 completed Run、两条真实用户消息和稳定展示，不能称原驱动全绿。准确边界与原 trace 归 `.cache/codex-review-20261024/cold-recovery-live/behavior-verification.json`；没有读取真实认证或改动原用户 Profile。

## Native 定时任务

模块统一称为“定时任务”，侧栏、页面、新建／编辑面板、搜索、筛选、空状态与删除确认使用同一名称；侧栏入口、空状态和任务卡片统一使用公共图标库的闹钟图标。对应公共UI、无障碍名称与测试定位保持一致。此次命名和图标调整不改变持久字段、IPC、调度、运行及恢复语义。

列表工具栏左侧为筛选，右侧搜索框与新建按钮同高同行；窄区只允许筛选换行，搜索与新建保持成组。空列表仍保留新建入口。2026-11-04，相关UI、SessionPage和Native页面三个完整文件35项通过，UI typecheck及定向Biome通过；隔离Chrome在明暗主题×1280／800px四组28阶段观察搜索、新建等待与完成、编辑、删除确认取消和空状态，另核共享组件390px两组6阶段，搜索框与按钮均为32px同高、8px间距且无横向溢出。截图与几何数据在`.cache/scheduled-toolbar-row-preview/`，模拟保存回调与上轮相同，未调用模型或操作用户窗口。

2026-11-04，Windows x64／Bun1.4.3／Chrome156，本轮五个完整相关UI／Native文件46项通过；[新对话整文件](test/isolated/native-new-conversation-dom.test.tsx)另78项通过、3项失败，失败均在原首次输入／冷恢复的“回复失败”提示等待或旧文案断言，本次仅调整的三处定时任务导航用例均通过。使用修改前的测试原文定向复跑仍复现相同3项失败，未改断言或将其计为通过。UI／Desktop typecheck及13文件Biome通过。实际共享SessionPage与编译CSS在隔离Chrome逐步核明暗主题×1280／800px四组28阶段：新名称与闹钟图标、搜索无匹配、新建等待与完成、编辑、删除确认取消、空状态均通过，页面零异常；仅使用模拟保存回调，未调用模型或操作用户窗口，截图与数据在`.cache/scheduled-task-naming-preview/`。本次未改调度和持久协议，沿用下述相关证据，不扩展安装或其他平台资格。

定时任务统一采用本地Service所在宿主的系统时间。[Main运行器](electron/scheduled-task-runner.ts)读取系统IANA时区，在列表、保存、启禁、立即运行和每次调度前同步当前Store的任务绑定；自动调度在异步观察及前一任务派发后重新同步，领取时读取最新任务，避免沿等待前的旧时区派发，已领取运行的冻结快照保持；旧绑定不同或宿主时区变化时，重算下一次未来发生，不追补转换前的时间。同一时区的重开／睡眠最新一次补跑保持。renderer的[保存DTO](src/scheduled-task-types.ts)只带频率、时分和可选星期，[IPC](electron/native-ipc.ts)拒绝调用者附带timeZone；宿主在保存时补充准确时区。DB10及manifest19保留原字段、严格格式和容量，冻结运行快照及其他Store任务不改字节。取舍见[本地时钟决定](../../.agents/notes/implemented/architecture/2026-11-01-desktop-schedule-local-clock.md)。

右栏时间行直接使用共享shadcn TimePicker／Input编辑时分，保留标签；项目、模型及思考程度的原控件和分行标签保持。定时任务页移除顶栏返回按钮，左栏“新对话”在准备页提交进行中只恢复同一准备／提交观察，不重复发送；选择原会话恢复未保存输入。其他忙碌门禁保持。

同日按用户要求改为行内时间输入：共享定时任务与Native导航两个整文件23项243断言、UI／Desktop类型、定向Biome及文档检查通过。普通Native独立Profile实际观察直接输入、清空禁用及原文保留、键盘恢复10:01后回车创建、编辑回填并保存10:02，始终无时间浮层；实际任务ID保持，零模型请求，窗口正常退出0，5个所属进程全部结束。过程截图及前后事实在本机`.cache/scheduled-inline-time-20261101/`。本次只改UI，宿主时钟、持久格式与调度资格沿前述验证范围。

2026-11-01，Windows x64／Bun1.4.3／Electron44.3.0，`65c6bee72`加本轮工作树：调度／私有库／IPC／页面桥／Main生命周期五个完整文件80项883断言、定时任务与模型UI两个完整文件25项239断言通过；Native新对话、caller、侧栏及SessionPage受影响整文件完成回归，旧原生select和空状态文案断言更新后，相关两整文件16项156断言通过。UI／Desktop类型、32文件Biome、文档／影响及跨包边界检查通过。维护DB10／manifest19字段与字节格式、Native安装／发布边界均核对保持，不另取得发布资格。

同环境独立HOME／Profile、普通development Main及生产renderer（`testDiagnostics:false`），实际配套Service的宿主TZ=UTC接管3条原Asia/Shanghai任务。逐步观察紧凑列表、右栏、共享时间浮层、无系统下拉图标、清空时间禁用创建且其他字段保留、键盘恢复10:01并在浮层回车创建、编辑回填并改为11:02保存、左栏往返保留未发送草稿。私有库保持同一新任务ID，nextRunAt准确为2026-11-02T11:02:00Z；3条旧任务时分／启禁／说明不变、3条旧运行及Core计数保持，零模型请求。过程截图、无障碍树与前后事实在本机`.cache/scheduled-local-clock-20261101/`；窗口正常退出0，5个所属进程全部结束。本轮未让机器睡眠，不扩展原真实模型或其他平台资格；既有CSS关键帧及大chunk编译提示保留。

定时任务现已接入本地持久化与调度，不再只是草稿占位。操作与运行边界见[Desktop 手册](../../docs/handbook/clients/desktop/README.md)。[共享 UI](../../packages/ui/src/desktop/ScheduledTasks.tsx)负责异步表单、编辑、启禁、运行、删除确认和历史入口；[页面桥](src/native-scheduled-tasks.ts)沿封闭 IPC 读取事实，不改变当前会话，明确打开结果才导航。失败保留输入，打开不存在的结果会话失败仍保留任务页。

2026-10-31，Windows x64／Bun1.4.3／Electron44.3.0，`65c6bee72`加当前工作树：以独立HOME／Profile／Electron数据目录、普通development Main、生产renderer（`testDiagnostics:false`）、真实paired Service和本机Codex登录完成`gpt-6-luna/low`真实模型窗口验证。普通UI保存、修改时间、暂停／启用，22:48实际墙钟触发在项目A创建独立根Session；模型仅调用一次`files.read`，返回文件后来更换的随机验证码与正确合计43，完整正文约4秒完成。暂停后将同一任务改名、修改说明并绑定项目B，明确立即运行仍可新建项目B根Session，约3秒回复“项目B验证；结果=437”；原三条项目A运行与会话身份保持，不因编辑重绑，任务定义仍只有一条。任务页在派发期间保持阅读位置，明确打开原记录才进入结果；完整退出冷重开后四条运行及A／B全文保持，Session4／Run5／Execution11／Command9／Message15／权限申请1的数量和完整任务、运行快照均不增、不改，正常退出及所记录Main／Service进程消失已核。

上述样本保留首次未带代理的`model_failed`与原失败会话；带入本机已有HTTP(S)代理后模型正常返回，未更换模型、路由或认证。首次文件读取在未准备项目访问时由`workspace_untrusted`拒绝，adapter未执行，模型如实说明无法读取；随后经普通会话明确发送准备原项目授权，才进行成功的自动读取，不绕过权限门禁。原“已完成”只表示对应技术Run正常结束，仍须核正文是否完成业务。共8个持久Model执行（7成功、1失败），全部snapshot核Codex／Responses／`gpt-6-luna/low`；7个成功执行实报36960输入／152输出／3712缓存输入token，不称完整账户用量或独立HTTP计数。验证中复现长说明撑大ScrollArea内容表格，默认1100×780窗口的任务按钮被裁切；共享样式将该表格固定到viewport宽度，复验默认窗口、编辑栏打开、保存关闭和冷开时四个操作完整可见，17项／131断言页面回归与Biome通过。完整Profile、模型输入输出、15张阶段截图、无障碍树与只读核验报告在本机`.cache/scheduled-luna-live-20261031/report.json`及同目录。此范围不代正式安装包、其他平台、机器睡眠补跑、真实审批决定或取消验收；既有编译提示保留。

同日补充默认 Auto 审批和取消的真实窗口验证：独立HOME／Profile、普通development Main、生产renderer（`testDiagnostics:false`）及真实Service，共11次真实Codex HTTP请求全部200，11个持久Model执行（9成功、2取消）及实际请求均核`gpt-6-luna/low`，其中2次为真正的内部自动审核。普通明确输入先准备项目访问，未修改审批模式；定时任务的`files.write`取得真实`approve_once`，仅创建`approval-result.txt`，完整内容为`AUTO_APPROVAL_OK`加换行，随后真实读取核实；原工具行显示“已自动批准”。内部审核不创建子会话，全部四次定时运行均为所属项目的独立根Session。

审核中取消使用仅在隔离Service包装器内的透明时序屏障：真实上游审核HTTP200且完整响应已收到后，暂缓交还未改写的原Response；点击原会话停止入口，核Run已cancelled后释放晚到响应。原`files.write`为cancelled、`dispatched=0`，原审核Model为cancelled，目标文件始终不存在；不把未被Runtime接收保存的晚到响应称为批准决定。另一次自然Model流式回复未使用屏障，观察到部分整数回复后点击停止，结算为cancelled，保留1到309的1127字符部分正文，终态收起处理过程，主动展开及冷开均可读。取消后同一暂停任务明确再次运行成功返回`CANCEL_RECOVERY_OK`。四条定时任务记录依次completed／cancelled／cancelled／completed，均`settlementVersion=1`；正常退出及冷开后Session5／Run5／Execution17／Command19／Message17／权限申请1、完整任务／运行／消息／文件及HTTP记录逐项保持，零重放，两个Main和所属Service均正常退出且记录进程全部消失。27张阶段截图、无障碍树、真实wire元数据、屏障前后只读事实及核验报告位于本机`.cache/scheduled-luna-boundaries-20261031/report.json`及同目录；wire的business分类还包含内部标题调用，不作为纯用户业务调用数。

该补充只判上述功能场景通过，完整界面体验仍有两项实际问题：首次进入取消后恢复会话时短暂显示“模型目录不可用：native_request_failed”，当时操作禁用，随后自动恢复且原Run成功，根因尚未确认；运行历史把`cancel_requested`直接作为原因展示（[原展示](../../packages/ui/src/desktop/ScheduledTasks.tsx)的`run.error`），冷开仍可见。分别保留第16／17和第19／27截图，本轮没有生产代码修复，不以最终成功覆盖中间闪现。用户明确暂不让电脑睡眠，因此只完成S3与一次性唤醒计时器可用性探测并撤销计时器，未执行机器睡眠或取得睡眠补跑资格；没有强制切换Manual／Full或验收人工作答审批，也不替代正式安装包和其他平台资格。

同日定时任务UI改版由[共享UI owner](../../packages/ui/README.md)维护页面、卡片、右栏编辑器与原宿主契约，Native调度及IPC未因展示改版改变。Windows x64／Bun1.4.3／Electron44.3.0，`65c6bee72`加当前工作树：独立HOME／Profile、普通development Main、生产renderer（`testDiagnostics:false`）和实际配套Service，完整窗口观察深浅主题、新建／编辑、项目搜索及Enter确认、周日与真实weekday=0保存、无效时区阻止保存及输入保留、276字符说明两行省略、暂停、明确立即运行、历史打开原项目根会话、筛选无匹配及清除、删除复核后取消。原最小800px窗口不能分配360px主区加300px右栏，表单存在却不可见；定时任务编辑专属覆盖布局修复后，800px右栏可见，拉宽恢复并排，同一未保存草稿保持，Escape关闭回到原编辑按钮，未改变左导航宽度。原失败第22／23截图与修复后第26至29截图均保留。

上述新运行使用本机固定响应Provider，仅验证UI到真实Main／Service／私有库及原会话的操作链；三条预置旧历史只用于展示，不能算新的实际执行证据，没有调用OpenAI账户。新任务保存及修改保持同一ID，暂停状态保持，四任务／四条定时任务记录与Core Session1／Run1／Execution1／Command2／Message2在完整退出重开后逐项不变，模型请求从首窗1次到冷开0次；两次Main退出0，末轮记录的五个Main／Service等所属进程全部消失。定时任务与SessionPage定向回归22项／182断言、UI及Desktop类型检查、Biome通过；本机32张过程截图、无障碍树、两次私有事实与范围报告在`.cache/scheduled-ui-20261031/report.json`及同目录。此前历史中的`cancel_requested`展示已改为可读原因；普通会话模型目录的原瞬时错误未在这轮独立修复。睡眠、真实模型和安装包资格沿前述原范围，既有构建提示保留。

2026-11-01修正上述表单的控件复用：项目与普通新对话共用ProjectSelector／ContextMenu，模型与思考程度直接复用ModelEffortSelector／GemSlider，移除自建TaskChoice及其浮层样式。[页面桥](src/native-scheduled-tasks.ts)保留提供商、模型名称、准确ID、配置档位及可选档位，不再压成只有ID／label的目录。[私有任务类型](src/scheduled-task-types.ts)、[Main校验](electron/scheduled-tasks.ts)与[运行器](electron/scheduled-task-runner.ts)保存可选`reasoningEffort`，按当前模型目录核有效档位，进入每次任务快照、原run.start及请求摘要；后续编辑不重写旧快照。旧记录无字段时继续沿原请求，不补造覆盖；DB10／manifest19与公共API版本保持，维护白名单同步接受受控可选枚举，原备份字节、容量和未知结果门禁保持。

同环境独立HOME／Profile、普通development Main、生产renderer（诊断关闭）和真实配套Service完成15个窗口检查点：原新对话项目菜单与定时任务项目菜单同源，选中Design System，公共模型浮层、提供商／模型双栏、宝石滑块键盘选择高档位，保存后真实库及运行快照为`high`；全局配置仍`low`，一次本机固定响应Provider请求实际携带`reasoning_effort: high`，Model快照同为high，原项目根Session正常completed。完整退出冷重开后任务、运行、Model事实及Core计数保持，公共编辑器回填高档位，冷开零模型请求；两个Main与各自记录的所属进程正常退出。UI／Model／SessionPage26项217断言、Main及页面桥35项422断言、私有库10项52断言、真实Node备份恢复1项32断言通过；UI／Desktop／Agent类型检查及Biome通过。证据在本机`.cache/scheduled-reuse-20261101/report.json`与同目录，不改写前一轮失败及资格；三条预置历史只是展示夹具，本轮未调用OpenAI账户，不新增睡眠、安装包或跨平台资格。

同日精简定时任务文案：移除常驻说明、重复标题／状态、空历史与安排摘要，保留字段、操作和必要错误／删除确认。上述普通Native环境沿独立HOME／Profile实际观察新增、无效时区禁用与纠错恢复、保存中禁用、编辑回填及更新、展开预置停止／失败记录、删除复核后取消；真实私有库只有一个新增任务，编辑保持同一ID，未创建会话或调用模型。13张过程截图、无障碍树及事实在本机`.cache/scheduled-copy-20261101/`。UI三文件26项216断言、类型与Biome通过；后台调度、模型和恢复逻辑本轮未改，沿用前述证据。检查结束后电脑控制工具无法再激活窗口，核验归属后停止本轮五个隔离进程，未将本轮计为正常退出验证。

同日按参考布局恢复项目／模型标签，右栏改用左标签／右控件的分组卡片、共享重复菜单和可折叠高级设置。相同普通Native环境的新隔离Profile逐步核对菜单、每周日、折叠恢复、项目切换、原模型滑块、高档位回填、无效时区提示及修正、新建与编辑保存；真实任务为ui-b／weekly／weekday=0／high，更新仍为同一ID。14张过程截图、无障碍树及只读事实在本机`.cache/scheduled-layout-20261101/`；UI三文件26项222断言、类型及Biome通过，窗口正常退出0、零模型请求。此轮只改变表单展示与交互组织，调度、持久化和原恢复资格沿前述范围。

同日模型与思考程度进一步分行，复用方式归[UI owner](../../packages/ui/README.md)。同环境新隔离Profile观察直接打开模型双栏、选中后关闭并显示新模型配置档位、独立宝石滑块调至高、创建与编辑回填、仅改思考程度再保存；真实库保持同一任务及modelId，只变化reasoningEffort与updatedAt。9张过程截图和前后只读事实在本机`.cache/scheduled-split-20261101/`。共享UI三文件27项243断言、Native模型选择整文件31项372断言、UI／Desktop类型与Biome通过；普通窗口正常退出0、零模型请求、所属五个进程全部结束。后台调度、IPC与保存格式本轮未变。

同日时间与时区合并为单行，复用原PillSelectTrigger／Popover及原生输入。同环境新隔离Profile实际核“中国时间 09:00”、UTC与时间同步更新、无效时区关闭后保留错误、纠错后在浮层回车创建、编辑回填及仅修改时间保存；私有库始终保存Asia/Shanghai，原任务ID、模型和档位保持，时间从10:01更新到11:01。过程截图、无障碍树及前后事实在本机`.cache/scheduled-time-20261101/`。共享UI三文件27项258断言、UI类型及Biome通过；窗口正常退出0、零模型请求、所属进程全部结束。原调度与存储契约未变，沿前述范围。

同日收紧列表与右栏尺寸：常用操作移至标题行，名称／说明单行预览，表单行高36px、默认说明区80px。同环境独立Profile实际观察四项列表、新建与原模型浮层、长名称编辑、196字符说明首尾滚动、保存、展开运行记录和删除复核后取消；真实原任务ID、说明全文及暂停状态保持。11张过程截图、无障碍树及前后事实在本机`.cache/scheduled-compact-20261101/`；共享UI三文件27项258断言、UI类型及Biome通过，窗口正常退出0、零模型请求、所属进程全部结束。调度与数据契约沿前述范围。

保存和重新启用沿 Client 的 `listAllWorkspaces()` 完整读取项目目录，不使用前100项的兼容入口判断项目不存在。页面桥分别维护任务列表与模型目录的读取错误；模型目录失败每5秒独立重试，列表刷新或任务操作成功不能清除模型错误，成功恢复后停止模型重试。离开页面、连接或设置修订变化时取消旧定时器，并拒绝旧模型结果，原表单字段继续保留。

创建重试的原任务ID按Store和编辑器创建意图保存，不随字段内容变化。回执丢失后的明确重试先读本地任务列表；存在时更新同一任务并保留当前启禁状态，不存在时仍沿原ID创建，已观察到后来删除的任务不复活。读取失败不继续保存，连接或设置修订变化拒绝旧核对；新的编辑器拥有独立意图。此意图只属于窗口内重试，不恢复冷写资格或改动封闭IPC格式。

2026-10-31，Windows DB10完整备份恢复夹具的原生资产缺失已修复，真实Node整文件已进入全部备份／恢复／重新绑定断言并通过；资产准备、Store门禁与实际范围见[维护owner](../../packages/agent/src/maintenance/README.md#desktop-db10-与-manifest-v19)。下文此前未进入备份断言的失败记录保留为修复前证据；本次不据此扩展完整安装版或发布资格。

运行器核实正常进展或终态后，用内部update的`error:null`清除旧读取错误；写入时移除该字段，持久记录仍只允许字符串错误，不增加DB或协议版本。已经结算的旧历史不改字节，页面对已完成记录不再显示旧错误。原失败／未知和执行组结算继续保留；立即运行没有claim时明确拒绝，UI解释“本次未新建运行”，不将未派发当作成功。

2026-10-31，同一Windows x64／Bun1.4.3工作树继续修复上述三项：[调度器](test/scheduled-task-runner.test.ts)、[hook](test/isolated/native-scheduled-hook-dom.test.tsx)、[存储](test/isolated/scheduled-tasks.test.ts)、[页面导航](test/isolated/native-scheduled-tasks-dom.test.tsx)和[共享UI](../../packages/ui/test/isolated/scheduled-tasks.test.tsx)五个完整文件62项／744断言通过，另[DB10闭合格式](../../packages/agent/test/isolated/maintenance/desktop-schedules.test.ts)4项／43断言通过；实际Node SQLite另核清除错误后JSON不保存null，原容量及恢复身份测试保持。Desktop／UI类型检查、定向Biome、文档与影响检查通过。三个问题的回归场景在修复前均失败，另核已观察到的原创建删除后重试不再提交保存。隔离Electron44.3.0窗口沿生产SessionPage、hook与样式逐步观察首次保存中禁用→回执丢失保留字段→修改说明→查询原任务并更新→仅一个新任务、完成状态去除旧网络错误，以及立即运行未接纳的完整提示；过程中发现并修正提示／历史挤入卡片横排和长提示截断。受控桥接页面异常为0，窗口正常退出0，本机夹具在`.cache/scheduled-current-native`；它不代证完整Native Main/preload、安装版、真实模型或其他平台。此前Windows DB10完整备份恢复夹具缺少原生访问资产，在备份断言前以`windows_access_asset_unavailable`失败的范围保留，本轮不重标通过；原嵌套`@keyframes`编译提示保留。

2026-10-31，Windows x64／Bun1.4.3，`65c6bee72` 加本轮修复：[调度器](test/scheduled-task-runner.test.ts)、[hook](test/isolated/native-scheduled-hook-dom.test.tsx)及[页面导航](test/isolated/native-scheduled-tasks-dom.test.tsx)三个完整文件35项／423断言通过，Desktop类型检查、定向Biome和文档检查通过。真实SQLite／HTTP／Client使用202个项目核后页目标的创建、编辑、暂停与重新启用，并继续运行原独立会话；模型失败回归核列表／操作不掩盖错误、独立重试、恢复、旧设置结果失效和卸载清理。两个新增回归场景在修复前均失败。隔离生产组件与样式可构建，但IAB连接本机地址超时，本机Chrome的Computer Use因无法可靠识别URL而终止，未取得本轮真实浏览器过程、完整Electron或安装版验收；既有嵌套`@keyframes`优化提示保留。

[调度器](electron/scheduled-task-runner.ts)通过公共 `readOrdinaryCommandApplication` 核原公开 run.start 申请、派生业务 Command 与实际 Run 的准确保存关系，再沿实际 rootWork 核后台效果和子轮。原申请 accepted 不证明业务完成，解释轮不当成已完成排程；缺关系保持待核实。原 detached child／unknown 效果及 after-turn 报告均继续阻止下一次排程。[实际 Runtime/HTTP 回归](test/scheduled-task-runner.test.ts)26项通过，报告夹具使用当前六工具 prompt 合同。

[存储](electron/scheduled-tasks.ts)在原 desktop-private/data.sqlite 首次保存时惰性迁移 DB10，使用两张小表保存任务与冻结运行快照，不改变 Agent baseline/schema。任务最多128个、聚合1MiB；运行最多10000条、32MiB，新 claim 为仍活动记录的现有可变字段保留增长预算，update 在同一事务校验完整候选，容量不足明确报错并保持原字节，不自动淘汰历史。旧合法或略超总容量的运行仍可按严格逐行格式只读展示，容量不伪装成结构损坏；用户明确删除带可信结算标识的任务时只验证目标历史，不被其他任务的总容量挡住。旧满库若同一任务仍有无法写入新事实的活动记录或无空间补写验证标识的旧终态，仍需明确清理或迁移，不能自动判作终态或删除未知效果。IANA 本地时间按每天／工作日／每周解析，DST gap 跳过、overlap只取第一刻；原子 claim 消费已错过的最近一次，同任务、同 Store 绑定不重叠；新 claim 身份包含 Store，旧 Store 的运行保留只读，不阻止明确重新绑定后的新运行。用户明确确认删除时沿原语义移除任务定义及本地运行摘要（含旧 Store 摘要），原 Service 运行会话仍保留；这不取消或重放外部效果。稳定 occurrence、Session、创建和启动 Command 身份均在效果前保存。最近 IPC 仅传轻量运行摘要（全局128、单任务20），不重复传 prompt 快照；按实际序列化UTF8字节保留完整记录至3MiB，满足4MiB响应边界。

[Main](electron/main.ts)持有单个[运行器](electron/scheduled-task-runner.ts)，可注入时钟；关闭窗口不停止，退出／开发重载在关闭 Service 前停止新调度并等待已有提交回执。执行沿普通 AgentClient createSession 和 run.start，使用用户全局模型配置及真实项目。每次独立 Session，不选择或引导当前会话，不建另一套模型执行器。运行状态来自原 Command／Run；`human_work_deferred` 只结束技术 Run，不证明原定时业务完成，沿 CLI 的保守语义保 unknown，不发布结算证明或放行下一次运行。前台 Run 终态前后还核实准确原 Session／root work 的全部未结算 Tool、后台目录和子会话，未知效果保 unknown、未结束工作保 waiting，读取不完整保守阻止后继。after-turn 原报告待处理时继续等待；背景目录先读，再核原根／已关联 child Session 内所有活动 Run，覆盖报告已受理而尚无 Model 的窗口。这会保守等待同 Session 的其他活动轮次，其他根工作中的 unknown 仍按准确 root work 隔离。等待审批在原会话处理。退出／重载先等待 opening 确认结束，再停止并排空调度器；opening 的两处异步准入同时核退出和重载门禁。Main caller 关闭须等设置队列结算，手动立即运行的历史核对也计入调度器 stop，随后才关闭私有库和 Service。结算证明以有限 `settlementVersion` 保存；旧版未带证明的同任务、同 Store 终态也阻止新派发，不能由较新正常终态掩盖。到点或立即运行前只读核实所属原记录，全局每轮最多核实4条，核实未完不消费下一计划时间；未知、缺原事实或容量不足仍保守阻挡，不自动重放或伪造证明。未知、冷恢复仅 GET 原请求，不能恢复热 POST 权利。原申请缺失时保持 unknown并阻止下一次发生。恢复为新 Store 不 retag 原任务，自动／手动运行均拒绝旧身份；明确编辑保存后仅新绑定获得运行资格，旧运行字节不重写。保存、启禁和删除进入同一 Main 设置队列，IPC 明确区分 create 与 update：新增保留 renderer 按 Store 绑定的重试 ID，同 Store 重连或设置刷新继续复用，切 Store 不沿用；同 ID 相同输入幂等，冲突输入拒绝；编辑在异步目录校验前后核原任务仍存在，本连接已删除 ID 不能被迟到创建或编辑复活。设置保存确认后，定时任务模型目录沿同一设置修订重新读取，旧目录在重读期间不可选择。

[Main 生命周期隔离测试](test/isolated/native-main-scheduling-lifecycle.test.ts)运行真实 Main 模块与调度器、有限宿主端口和 SQLite，核 opening／重载交叠及创建回执排空次序；它不代证真实 Electron 或原生进程退出。[存储与时区测试](test/isolated/scheduled-tasks.test.ts)、[实际固定模型 Service 与审批测试](test/scheduled-task-runner.test.ts)、[IPC](test/native-scheduled-ipc.test.ts)、[页面导航](test/isolated/native-scheduled-tasks-dom.test.tsx)、[hook](test/isolated/native-scheduled-hook-dom.test.tsx)和[共享 DOM](../../packages/ui/test/isolated/scheduled-tasks.test.tsx)覆盖对应断言；[DB10实际备份恢复](../../packages/agent/test/isolated/maintenance/desktop-schedules-profile.test.ts)核旧字节、恢复 Store 与零重放。实现决策见[Note](../../.agents/notes/implemented/architecture/2026-10-15-desktop-local-scheduled-tasks.md)。这些证据不授予 macOS／Windows 发布或安装资格。

## Native 当前会话环境信息与子详情

环境行将原 Store／子 Session 组合交给共享 `ChildAgentIcon`，与工具消息及审批使用相同稳定身份，不按标题、状态或本次 carrier 重新分配。恢复历史沿原 Store 保持外观；无法导航的已知子会话仍显示图标，缺身份时使用通用子 Agent 图标。显示、点击与停止资格仍分别由原 metadata 和回调决定。

环境行、工具消息和子结果入口打开详情时，同步把该原身份交给共享SessionTabs的`childAgentIdentity`，标签图标使用同一分配；结果历史沿原消息Store，环境恢复历史沿原Execution Store。该装饰字段不参与Session／Execution去重或读取准入，标签改名仍保留同一图标节点，SVG沿共享14px尺寸。

同日标签图标补齐：[共享标签回归](../../packages/ui/test/isolated/desktop-session-tabs.test.tsx)10项／174断言、[Native导航](test/isolated/native-session-navigation-dom.test.tsx)定向2项／40断言及UI／Desktop typecheck通过。Chrome隔离夹具在深浅主题×800／390px×运行／完成八组合核标签、环境卡与审批的图标分配、实测颜色和14×14px尺寸完全一致，重命名保持，原环境详情点击正常、无横向溢出及页面错误；证据在本机 `.cache/child-tab-icon-yxMPRQ/report.json`。该范围使用生产共享组件与environmentDisplay，不代证完整Electron或安装版。

2026-10-26，macOS arm64／Bun1.4.2，环境行图标修复：[共享子Agent展示](../../packages/ui/test/isolated/desktop-agent-activity.test.tsx)3项／1266断言、[Native环境卡](test/native-background-panel.test.tsx)12项／288断言及UI／Desktop typecheck通过。生产组件、实际environmentDisplay与共享样式在本机Chrome隔离夹具中观察深浅主题×800／390px×运行／完成八组状态，重命名后图标和颜色仍与审批一致，SVG实测14×14px、无横向溢出，八次原详情点击正常；无导航目标时也保留图标。报告在本机 `.cache/environment-child-icon-GilZs4/report.json`。该范围不代证完整Electron或安装版。

[NativeChildDetail](src/native-child-detail.tsx)直接显示共享 Conversation，顶部不再渲染“刷新子日志”按钮、只读说明或对应占位。日志更新与失败后的重读继续由原 environment reader 自动处理；子详情的只读权限、复制资格及标签关闭释放规则保持。共享标签模型按入口创建，首次点击子 Agent 消息只打开对应详情；关闭最后一页后重新点击子 Agent 也不预建空白网页，已有网页仍保留。

2026-10-26，macOS arm64／Bun1.4.2，本次顶部移除工作树：[导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)定向1项／43断言与[自动恢复](test/isolated/native-environment-child-recovery-dom.test.tsx)3项／56断言通过。普通[Electron 子详情](test/isolated/native-child-stream-electron.test.ts)的 Responses 范围通过，实际观察首次打开、流式追加、完成重入三阶段；100次父／子导航记录630次DOM变化，零欢迎页／重复消息，reader峰值2、关闭后为0。截图与过程记录保存在本机 `dist/acceptance/child-detail-header-20261026/responses`。使用本机受控 Provider，不增加外部真实模型或安装包资格。[复制回归](test/isolated/native-child-copy-dom.test.tsx)2项通过、2项失败；两项失败以修改前组件和测试复现，未计为通过。

同日修复多余空白网页标签：[共享标签生命周期](../../packages/ui/test/isolated/desktop-session-tabs.test.tsx)10项／167断言与 Native 导航定向5项／130断言通过，覆盖消息点击、重复打开、末页关闭后重开及保留已有网页。上述普通 Electron Responses 范围重新通过，首次打开只有一个子详情标签，100次导航及三阶段截图均无额外空白网页；613次DOM变化无欢迎页／重复消息，关闭后在读为0。证据在本机 `dist/acceptance/child-detail-tabs-20261026/responses`，仍限该隔离受控环境。

[引导交接组合回归](test/isolated/native-new-conversation-dom.test.tsx)通过真实 Composer、DesktopInput、回环 HTTP、SQLite 和 Runtime／固定 Adapter，核引导 POST 已落库但回执丢失后，切到另一会话编辑草稿，再重连仅查询原 Command；原输入只出现一次、下一模型请求原文和来源各一次，另一草稿保持。另核提交与原 Turn 完成的两个顺序：受理归原 Run，目标先结束则保留草稿，不自动改成后续输入。[阅读回归](../../packages/ui/test/isolated/desktop-conversation-scroll.test.tsx)在受控 DOM 几何下核离底选区、sending→saved、增量回复、终态折叠和回会话的锚点／展开状态；这类确定性证据不冒称完整 Electron 视口资格。

[子结果消息](src/native-presentation.ts)直接消费公开 `Message.agentResult`，由 [transcript](src/native-transcript.ts)保留原 Source ID／顺序并交给共享 Conversation 的独立消息边界。Store 只为原父 Turn 已结束、准确 report 实际创建后续 Run 的子结果投影该 DTO；active 原轮接纳继续沿普通工具和处理过程，终态和冷读都不补气泡。客户端不根据当前 Run 是否活动猜接纳时机，因此刚由结果唤起、仍执行中的续 Run 已能显示对应消息。消息复用普通输入气泡和同一个 MessageItem，头部为“〔名称〕Agent 发送”，正文使用原 Markdown。失败／取消／未知保真实结果，大正文按 `contentComplete:false` 明示尚未完整展示。[Native 入口](src/native.tsx)按准确 child Session／carrier 打开已有详情 reader，不从后来最新任务猜目标。冷历史重新投影不新增结果或模型调用，内部 Model 无该 DTO。来源证明和模型只接收一次结果归 [Store owner](../../packages/agent/src/storage/README.md#人类工作与完成报告事务)，分组回归归 [transcript DOM](test/isolated/native-transcript-dom.test.tsx)，实际窗口沿[协作夹具](test/isolated/native-collaboration-bundle.test.ts)。

2026-10-23，`8a8458800` 加工作树 diff，macOS arm64／Bun 1.4.2，以[真实收件窗口 runner](../../tests/e2e/live/model/collaboration-unified-native-window.live.ts) 的独立 `--final-results-only` 范围重验正常最终结果流程 **passed**。子任务只读一次后直接最终回复，原消息工具仍可用，实际零 `task.message`、零 `agent.message` Command、零普通邮件；没有注入用户引导或压缩。普通 `testDiagnostics:false` 候选沿 UI 选择完全访问，默认 `deepseek-v4-flash`／chat-completions／medium／4096 的 10 次实际 HTTP 全部 200。父 Turn 活动时结果进入原 Run 的后继实际模型请求，仅一份完整低信任正文与准确 Source；一段处理过程内的等待工具显示真实 completed 事件，准确子详情全文可读，终态及冷开均无独立结果气泡。父原 Turn 正常结束后，原结果经当前资格和授权仅创建一轮续跑；父续跑回复尚未交付时，原发送者和完整结果气泡已经显示，续跑后父中文回复带真实材料核验码。两会话冷开零新增 Provider／Run／Execution／Command／Source／control，原创建工具行在子完成前后保持静态，窗口正常退出。

该次报告为 `dist/acceptance/final-result-only-native-window-20261023-c4b872a1.json`；同名 `.workspace` 保留原 Store、canonical Model input/output、实际 Provider 输入、16 张阶段／输入截图与115帧。`03-idle-result-before-parent-reply.png` 覆盖先展示消息再回复，`07-active-received-in-process.png` 与 `08-active-child-result-detail.png` 覆盖原轮完成事件和完整子正文，`10-cold-idle.png`／`11-cold-active.png` 核冷开。该范围的运行中截图没有普通邮件“Agent 发送”段落；较早混合测试主动要求的普通邮件仍有独立回归，不以两种来源互相代证。证据限该本机普通候选、已配置真实模型及隔离只读任务／Full 模式，不外推默认审批、其他平台或安装发布资格。

同日，引导交错范围 `dist/acceptance/steering-boundaries-native-window-20261023-a214cf06.json` 通过：macOS arm64／Bun 1.4.2／Electron 44.3.0，`8a8458800` 加本任务工作树，4599 个非 Markdown 文件 SHA-256 为 `9750a9e28f0063a0532887cb8d99eba2df13a7b17fab6555f1fe4de2da7c258f`。普通关闭诊断的候选、原默认 `deepseek-v4-flash`／chat-completions／medium／4096，14 次真实 HTTP 均 200。active 的三波 Composer 引导分别在子最终结果待接纳、实际正文首字已显示、实际自动摘要进行时提交；首摘要成功但未发布，接纳第三条后新的真实摘要发布，实际后继 Provider 同时收到三条原正文各一次，最终仅采用 Purple 并保留六项实际核验码，父大材料只读取一次。SSE 原始与转发字节 SHA 相同；原 Run、单处理过程、无普通邮件／独立结果气泡。最终仅一条“用时54秒”，收起隐藏引导，依次展开三条完整正文后可再次收起；idle 仍核准确子结果先于父续跑回复可见。两个会话冷开零新增 Provider／Run／Execution／Command／Source／control，正常退出无所属进程残留。

同名 `.workspace` 保留28张阶段图、440帧、压缩与原创建工具行的 DOM／几何采样、canonical Store／Model 和实际 Provider 输入。`boundary-04-first-real-content-visible.png`、`boundary-3-guide-accepted.png`、`boundary-06-stale-summary-refused-new-summary.png`、`boundary-06-summary-time-correction-received.png` 分别覆盖首字、摘要中排队、旧摘要未发布和新摘要完成；`boundary-07-terminal-steer-*` 与 `11-cold-active.png` 核完整终态交接。此前 `7d1c45b0` 真实失败暴露首字已到 Adapter 而 partial 未及时更新，Core 已修并补暂停切点回归；`9e85ad31`、`d6fa10e2`、`e143e71c`、`b7bc0d63` 分别保留夹具选择器、Markdown 可见文本比较、私有 Node 模块定位及原文占位定位的失败，不改写为成功。修正只作用私有夹具，原请求预算和产品来源／权限门禁保持。Core／恢复／附件／多层 Agent／Native／共享阅读状态20整文件188项4807断言，以及审批／完成边界2整文件28项307断言均通过；八 workspace typecheck 通过。SIGKILL、迟到审批、响应丢失切会话、205条长引导和附件等为真实 Runtime／SQLite／本地 HTTP 或 DOM 受控组合回归，不声称都已跑付费模型／完整 OS 窗口；该真实窗口仍仅取得本机只读 Full 场景资格。

该次真实回复将与引导一同检查点接纳的独立子结果称作“引导一附带的后台执行结果”，自然语言来源描述不够准确。实际 Command／Message、独立结果 Source 和完整低信任 Model wrapper 均核原出处，用户引导与结果未合并或借权；这项措辞限制不应被机械 passed 掩盖。最终事实、次数与权限语义按上述独立证据核验。

逐帧另核三次本地占位到持久消息均唯一、原序且位于原处理过程；新摘要 running→completed 保持同 node、32px高度、y与scrollTop，没有短暂缺行或状态回退。本地扁平文本转为持久 Markdown 段落时，引导卡片高度会变化，不能把该次证据表述为所有接管零重排；终态展开核验的滚动与脚本点击／`scrollIntoViewIfNeeded` 对应。任意离底阅读位置与文本选择由共享 Conversation 的受控 DOM 回归证明，不冒充该真实窗口已遍历所有阅读位置。

2026-10-23，macOS arm64／Bun 1.4.2，`45b8275c1` 加本次 diff：上述源码外协作窗口 1 项／55 条 Bun 断言通过，23 次受控 Provider 请求。父原轮结束、结果创建续 Run 后，在续跑模型仍被夹具阻挡时已显示“CHILD_A Agent 发送”及实际正文；气泡与普通输入的背景、圆角、内距、宽度约束和字号相同，可打开准确详情。释放后核原父回复→子消息→继续父回复的顺序；同一 child Session 第二份符合条件的结果独立保留。另让第三份结果在原父轮活动中完成并接纳，核准确 active 回执、原 Run 身份、处理过程的完成事件与子详情实际正文；该结果在父轮活动、结束、冷重开后均无独立气泡，原两条消息各保留一次。冷 Store 核 carrier、child Run 与显示记录一致，冷重开零新增 Provider 调用，所属进程正常退出。82 帧过程及原回执保存在 `dist/acceptance/child-result-message-90648dcb-a209-49a7-9a4a-981d1b7ddc3d`，核对了接纳、查看子结果、父轮完成和冷重开之间的过程帧。Core 两整文件 14 项／278 断言、transcript／缓存／滚动三整文件 18 项／1260 断言、八 workspace typecheck 及最新 Desktop typecheck 通过；同一活动 Run 分段后的最终回复和整轮耗时只显示一次。Service 响应组装和公共 DTO 未受此次显示资格修正影响，复用此前 Service 响应 5 项／13 断言。此证据限本机隔离 Profile 与受控 Provider，不代表真实付费模型、其他平台或完整发布资格。

2026-10-23，统一邮箱接收实施后的 `87944be7f` 工作树，macOS arm64／Bun 1.4.2 再跑同一源码外 Electron 协作整例：1 项／55 断言、23 次受控 Provider 请求通过，冷重开零新增请求。过程核对涵盖父轮结束后结果先于续跑回复可见、活动父轮从邮箱接收后仍无独立气泡，以及父轮完成与重开不补发；DOM／消息响应三整文件另 18 项／299 断言通过。89 帧过程、截图与原回执保存在 `dist/acceptance/child-result-message-3f7ee2e7-7605-46be-8b29-0f394b667153`。本次没有改变消息组件，接收、Source 去重与权限回归由 [Store owner](../../packages/agent/src/storage/README.md#统一消息接收)维护；仍不外推付费 Provider、其他平台或安装发布资格。

同日，以[真实收件窗口 runner](../../tests/e2e/live/model/collaboration-unified-native-window.live.ts)构建普通 `testDiagnostics:false` 候选，实际默认模型 `deepseek-v4-flash`／chat-completions／medium／4096，普通 UI 选择完全访问，隔离工具仅文件读取和 Agent 工具。12 次真实 HTTP 200 完成 idle／active 两条时序和两会话冷重开，11 张阶段截图、119 帧与 canonical Store／Model 全文保存在 `dist/acceptance/unified-mail-live-window-20261023-fa64bc12.json.workspace`，总报告为同名去掉 `.workspace` 的 JSON。idle 普通邮件不自行启动，最终结果在父续跑回复前已出现原发送者和具体正文；active 普通消息／结果进入原 Run，事件与准确子详情可读，完成和冷开不补最终结果气泡。两次正常退出、冷开零新增 Provider／Run／Execution／Command／Source／control 已核。

**修复前该次真实窗口验收为 failed。** 普通邮件的物理占位 Message 被公开链原样作为用户气泡展示，仅出现 `Agent message (untrusted data; no additional authorization)`，未显示该邮件的具体正文和来源；活动原 Run 因此被分成两段处理过程。真实邮箱和下一 ModelInput 都有完整邮件，不属于投递丢失或额外 Run。根因是 [普通邮件收件](../../packages/agent/src/storage/sqlite/agent-mail-operations.ts)只保存内部占位，公开 Runtime／Service／Native 当时缺少相应展示投影；完整展开只用于模型上下文。`ordinaryMailNotRenderedAsUserPlaceholder`、`activeSingleProcessForOriginalRun` 两项明确失败，不能以最终结果样式、Core 收件或冷开通过覆盖。失败截图为 `07-active-received-in-process.png`，准确子正文截图为 `08-active-child-result-detail.png`；当次测试未修改生产展示，后续修复与复验见下段。

普通邮件现沿 Runtime 的已验证 `Message.agentMessage` 显示真实发送者与完整正文。[Native 投影](src/native-presentation.ts)保留原接收 Run，`systemKind:agent_message` 交给原 MessageItem／NativeModelOutputMessage，在同一处理过程内渲染 Markdown。MessageItem 复用用户／引导消息的输入气泡，并在泡内标明“〔名称〕Agent 发送”；发送者标签不叠加默认段落顶距，过程内邮件不预留信息栏空间。Native 保持原 Agent 来源与正文读取路径，不新增用户边界或额外最终回复／复制按钮。完成和冷开仍只保一份邮件、一段过程与一次耗时。真实来源与不可读状态由 [Runtime／Store owner](../../packages/agent/src/storage/README.md#统一消息接收)负责。

成功发送消息的工具确认不另占展示行。[Main 原回执核验](electron/tool-message-fact.ts)仅在准确 Run 注册的 `builtin.task / task.message / 1`、成功 Execution 与原消息吻合，且结果为完整已知排队确认时，投影 `agentMessageAccepted`；主会话与子详情复用该事实。[Desktop 工具投影](src/native-tool-messages.tsx)将它映射为既有 `presentation:hidden`，原始记录与模型上下文保持。失败、拒绝、取消、未知和未核实回执保留原阅读路径；真实模型正文与来信不按“发送成功”等文字过滤。

2026-11-06，Windows x64／Bun1.4.4，当前工作树补核邮件间距与成功回执清理：共享邮件／轮次／复制三整文件15项／1577断言，Main工具／子详情与实际NativeDesktop回执三整文件85项／1894断言通过；全仓typecheck、定向Biome和文档检查通过。生产CSS与实际Native正文组件在深浅主题、1280／390px四场景测量，邮件顶部内距由24px回到12px，底部内距12px，过程内额外32px占位移除；过程外消息保留原信息栏间距，数据及截图在 `.cache/mail-padding-hJDEj1/`。完整重建Main后的普通 `desktop:dev` 冷读原“结构检查员／配置检查员”实际消息，观察父过程展开、发送者与正文、子详情读取接管及收起／展开：成功发送行与排队JSON不再出现，原事件工具和真实父／子模型回复保持，未出现空工具壳或同邮件重复渲染。实机范围为本机已有历史复读；在线metadata等待、核验失败回落及同页Files必要读取保持由上述回归覆盖，不代证新模型执行、其他平台或安装发布资格。

2026-11-06，Windows x64／Bun1.4.4，当前工作树的共享邮件、轮次、复制和 Native transcript 四个整文件39项／2036断言通过，全仓类型检查通过。普通 `desktop:dev` 在隔离验收 Workspace 中冷读已有邮件，核同类气泡、完整正文和泡内发送者；另由两个真实 `explore` 发送者“结构检查员”“配置检查员”在父轮活动期间发来消息，观察接收、正文出现、最终记录接管、默认收起及再次展开，均保留原顺序与单段过程。该轮实际收到三条邮件，其中结构检查员两次主动发送同文，各有不同 Tool call、Command 和 mail ID，准确父消息序号71／76／79与三条气泡一致，并非同一邮件重复展示；两个子轮和 carrier 均已终态。仅共享 UI 气泡与必要回归断言变化，Storage、DTO、Native 正文读取和投递／权限路径按原实现核对；本记录不代证其他客户端或平台资格。

2026-10-23，同一模型／协议／设置、macOS arm64／Bun 1.4.2、`87944be7f` 加本次修复：[真实窗口 runner](../../tests/e2e/live/model/collaboration-unified-native-window.live.ts) **passed**，12 次实际 HTTP 200，12 张阶段截图与138帧保存在 `dist/acceptance/agent-mail-display-live-window-20261023-2a0c498d.json.workspace`，总报告为同名去掉 `.workspace` 的 JSON。按真实 sender Tool 输入逐字核完整普通邮件，发件人来自原 Session；活动父轮原 Run／单处理过程／无独立气泡、原子详情、完成后展开原邮件及冷开去重均通过，冷开零新增 Provider／Run／Execution／Command／Source／host control，两次窗口正常退出。`12-active-ordinary-mail-detail.png` 显示父仍回复时的来源／完整正文与单过程；终态及冷开截图保留原分组。窗口时序门只延迟真实 HTTP 200 后的原响应，不生成或改写正文。

共享 UI／Native DOM 两整文件15项／360断言、Service响应与生成Message validator整文件6项／18断言通过；Core Task业务26整文件132项／2538断言，以及输入／派发／child result／Runtime报告恢复四文件27项／375断言通过。八 workspace typecheck、同源 API、边界和测试归属检查通过。本次资格限本机普通候选、已配置真实模型与隔离读取工具／Full选择，不外推安装发布或其他平台；修复前的失败证据保持。

子 Agent 工具消息复用原 [ToolActivity](../../packages/ui/src/desktop/ToolActivity.tsx) 的 Trace 单行。[nativeAgentActivities / nativeAgentActivityForTool](src/native-agent-activity.ts) 只从原环境目录投影已知版本 `task.spawn / task.follow_up` 的准确 carrier，核原 Store、父 Session／Run、`sourceTool` 与工具执行、子 Session 和原 child-start；已成功受理的原工具回执与目录吻合后，才在原消息行补充名称与准确详情目标。`childAgent` 仅含 identity／name；操作标题取原工具 Message，固定显示“创建子 Agent”“继续子 Agent”，不接收 carrier／child Run 的生命周期或新鲜度，不因子完成、失败、中断或后续任务改写标题、结果或动画。原工具本身的失败、取消与结果未知保持自身展示。整行点击沿原右侧标签交付准确 Session／Execution，不增加 mutation；没有折叠或独立详情按钮，旧展开缓存也不会把原始受理 JSON 或子 reader 挂回父会话。详情回调暂不可用时仅暂停该行点击。

[环境 hook](src/native-environment.tsx) 复用原完整目录和有界展示缓存，不增加网络读取；缓存成本包含子 Agent 展示事实，同 scope 校准先保留最新已读 display，即使完整展示超过缓存预算也不闪回旧行。普通刷新保留名称、原操作和详情目标；当前任务生命周期仍用于原环境卡、停止门禁和子详情，不投影为父历史工具行状态。图标按原 Store／child Session 稳定身份与审批卡共用。

[关联回归](test/native-agent-activity.test.ts)核生命周期变化后静态投影不变、同 Agent 多任务和活动指导、准确来源与恢复历史；[目录到消息 DOM 回归](test/isolated/native-agent-activity-dom.test.tsx)核真实环境 hook、精确投影、静态原操作和 DOM／选择区保持、超缓存预算刷新与准确 child reader 请求。此范围不代替完整 NativeDesktop、真实模型或安装发行验收。下述较早窗口记录仍保留其当时的验证范围，其中父消息动态跟踪子任务状态的行为已按用户明确要求改为静态历史操作。

2026-10-23，macOS arm64／Bun 1.4.2，`8a8458800` 加静态操作修复：共享消息、Native 投影／目录 DOM、原工具聚合、侧栏标签和导航六整文件 52 项／2581 断言通过；八 workspace typecheck、同源 API、架构边界、测试归属、Biome 和文档检查通过。普通关闭诊断的真实模型窗口 `dist/acceptance/static-agent-tool-history-live-window-20261023-5a16bc24.json` 通过，`deepseek-v4-flash`／chat-completions／medium／4096，15 次 HTTP 200、36 张阶段截图及276帧。既有 `parent-compaction-only` profile 覆盖原子任务创建、完成、父轮接收、两引导与父压缩、完成和冷开；不声称该 profile 触发子压缩。逐帧／DOM 监视从原创建行就绪持续至子完成及父压缩后继，原节点、静态“创建子 Agent”和32px高度保持，无生命周期运行／失败状态；冷开仍保原创建操作且零新增请求或业务记录。`05-parent-running.png`、`07-active-received-in-process.png`、`22-cold-original-agent-creation.png` 分别保存执行中、子完成接纳后及冷开事实。此范围不代替实际取消窗口，具体取消沿原源码外协作场景独立验证。

同日[原生协作整窗口](test/isolated/native-collaboration-bundle.test.ts)独立通过1项／59条 Bun 断言、23次受控本机 Model 请求与93帧：实际 A 完成、同 Session 新 follow-up、B 经原后台停止入口到 cancelled、后续父轮及冷开，共6次热检查和1次冷检查保原创建操作；热阶段沿同一 DOM 行，连续帧错误为零。`dist/acceptance/child-result-message-0916e3da-160b-4d48-8b9d-9a2871d92f24/03e-static-creation-after-cancel.png` 同时显示左侧两条原创建操作与右侧 B 的 cancelled 事实。此为明确开启诊断的隔离测试制品，普通 dev／prod 仍关闭；不把本机固定模型称为远端真实模型。首次启动因旧字符串改写未匹配新增 type import，driver 未启动；现改为显式传递 package 位置并从该位置加载 Playwright，复用相同且未改动的已核候选后通过，原流程、工具效果、审批、停止及预算断言保持。

2026-10-23，`45b8275c1` 加本次直接导航修正：消息、目录到消息、原工具聚合与侧栏标签四个完整测试文件共18项／474断言通过，UI／Desktop typecheck、定向 Biome、统一边界和文档检查通过。旧 `expanded=true` 不调用回执 reader，也不生成折叠控件、受理 JSON 或独立详情按钮。Chrome 隔离夹具以生产组件和 Native 投影逐次核对状态变化，鼠标、Enter 和 Space 均直接打开原右侧详情并保留父正文；500px 窄窗长名称省略、状态保留，深浅主题保持14px、32px行高且无横向溢出。Native DOM核到准确 child reader 请求；浏览器详情正文为夹具内容，不代替完整真实任务、模型或安装版验收。

2026-10-23，macOS arm64／Bun 1.4.2，`655fb9a97` 加本次 diff：上述关联、目录到消息 DOM、[共享消息 DOM](../../packages/ui/test/isolated/desktop-agent-activity.test.tsx)和[原工具聚合](../../packages/ui/test/isolated/desktop-tool-aggregation.test.tsx)四个完整文件15项／317断言通过，UI／Desktop typecheck、定向 Biome、统一边界、测试归属和文档检查通过。Chrome 以隔离夹具加载生产 SessionPage／ToolActivity、真实 Native 投影及原 Vite／Tailwind 编译样式，逐次观察受理、排队、开始、等待、结算和各终态：始终只有一行，展开选择与行位置保持；500px 窄窗长名称省略且状态保留，深浅主题保持14px正文，页面无横向溢出。该夹具不读取用户数据、不运行模型、不加入普通客户端。邻近 `native-background-panel.test.tsx` 的旧环境卡断言仍期待普通界面显示“上次状态 · 待核实”，在未含本次 diff 的 `655fb9a97` 主工作区也单独复现同一失败；其余本轮实际通过与这项既有失败分开记录。

[目录适配](src/native-presentation.ts)在没有全局 activity 而消费当前会话观察时，将 `viewLoading` 与实际读取失败区分：同 Store／同 Session 的正常校准保留原运行展示；目录不可用或 `permissionUnavailable` 且不在校准中仍显示上次确认状态，foreign Store 不消费该观察。仅保留展示，不改变操作准入。[环境适配](src/native-environment.tsx)同样把校准 `busy` 与真实 `stale` 分开，普通刷新沿原展示缓存保持文字、行数和停止按钮，按钮在新 facts 完成前禁用；首次读取仅标记忙碌，真实错误仍明确提示。Main 尚未确认目标选择时，环境 hook 的 `paused` 立即停止旧范围读取并隔离 child／stop，保留当前卡片的文字与按钮为 busy；这类已知切换等待不转换成真实 stale 错误，切换前已存在的真实错误仍保留。旧 observation 不恢复写资格，已受理停止等待最新完整目录及原 Main 准入，scope 替换和未知零重放保持。

2026-10-18 Windows x64／Bun 1.4.3，基于 `f734245a` 加本轮工作区改动：[目录](test/native-directory.test.tsx)新增同会话校准保运行标记及真实失败／foreign Store 反例，[停止竞态](test/isolated/native-environment-stop-dom.test.tsx)新增普通刷新保节点、空列表不插加载段、禁用零写及真实失败。原实现分别复现运行标记被撤下、环境卡加“上次状态”并移除停止按钮，以及空列表插加载段；修复后相关整文件通过。Chrome 155 隔离夹具使用实际目录适配、共享 SessionPage／Composer 与环境 hook，亮暗主题、1240／800／500px、空／非空目录下原环境卡高度变化为4／48px，修复后文字、按钮数、可见侧栏运行标记和所有受测几何／滚动保持；每次选择一次、后台读取继续、零停止写入。500px 原侧栏未挂载，不将该场景计作侧栏视觉证据。完整安装窗口、其他平台及全量默认测试未运行；原嵌套 `@keyframes` 编译提示保留。

正式 [页面](src/native.tsx)将现有后台目录接到原 [BackgroundExecutions](../../packages/ui/src/desktop/BackgroundExecutions.tsx)环境卡和 SessionPage 的 `environmentInformation` slot，保留原 300px 卡、宽窄窗口停靠／浮层与开关行为。[适配器](src/native-environment.tsx)仅将来源为 `shell.launch@1` 且父工具身份匹配的 `shell.command` 展示为后台 Shell，子 Agent 仍按准确 child Session 展示，名称取公开 child title；自动命名扩展的 `agent/session-title` 按公开 `definitionId` 从环境卡的行与 child 入口映射中排除，不按可变名称判断，同名普通委派任务仍显示。原后台目录、执行历史、取消和 unknown 事实保留；回归见[环境展示测试](test/native-background-panel.test.tsx)。Shell 沿原 currentOnly 契约只列运行／停止中，按原准入提供准确停止。环境卡的子列表保留全部记录及 queued／starting／unknown／restored 状态和只读详情入口；共享展示层接收原 `stoppingExecutionId/onStop`，仅对当前新鲜完整目录中已核实的准确可停止 carrier 提供操作。旧状态、unknown、恢复历史或缺少资格时禁用停止，不凭稳定 child Session 转向后来一轮；原 task／Run 范围及 Main 的准入前后复核保持。不把终态或受理回执当作进程清理证明。

环境卡的 Main 目录读取和准确停止复核显式请求 `includeSourceTool:true`，消费原父工具的只读 ID／定义／版本；`shell.execute` 的前台命令、来源缺失或身份不匹配的记录均不进入 Shell 分组，不按 `cancelWithParent` 推断前后台。来源在原后台目录事务内核同 Session／origin Store／root work，普通总览默认响应保持。相关元数据与兼容边界见[Store owner](../../packages/agent/src/storage/README.md#跨会话原-job-目录)，取舍见[来源过滤决定](../../.agents/notes/implemented/architecture/2026-10-20-background-shell-origin-filter.md)。

同一稳定 child Session 的多份 carrier 分别保留原执行卡。环境卡打开详情时同时传原 `executionId` 与 Session；[renderer reader](src/native-background.ts)核 carrier／原 child Run／rootWork，导航、刷新和展示缓存均 pin 原 execution，不按 Session 找第一条或最新任务。缺少 execution 且有多个候选时明确范围不可核实，不猜目标。原停止仍按所选准确执行走原 durable caller。[实际 DOM 回归](test/native-background-panel.test.tsx)核同 Session 两个 carrier 的点击、刷新和返回，原完整正文与停止回归继续保持；这组受控 IPC／DOM 测试不替代源码外窗口或新六工具完整审批交互。环境目录当前不携带准确 child Tool 的审批事实，不能仅凭 child Run 的 waiting_interaction 推断“等待你的批准”；原准确主交互卡保持可达。

只有 Session 的导航可先等待当前共享目录，等待属于本次导航并可独立取消。首次完整目录返回后，唯一同 Session carrier 才形成准确 pin；缺失或多个候选明确失败，后来的目录不能替这次失败选择目标。已绑定的导航、刷新和缓存继续使用该 execution，新 follow-up 不改投；只有用户再次明确打开才重新选取。连续切换及时退役旧等待，不关闭共享目录 owner。[导航回归](test/isolated/native-session-navigation-dom.test.tsx)同时核目录未返回时的100次切换、歧义拒绝及后续 carrier 不替换原目标。

准确 carrier 已在同范围完整目录中核实后，首次打开不再排在后续全目录刷新之后。Renderer 在刷新在途保留上一完整 facts，仅对已 pin 的同 Execution／child Session 发起只读接纳；Session-only 或未知目标仍等待完整目录唯一解析。Main 为 child-only 读取保留最近一个完整同根观察，覆盖目录替换在途，以及 Main 已发布／正常关闭目录但 Renderer 尚未提交新观察的交接窗口；按请求 observation ID 选择准确候选。仍重新核准确 carrier、祖先与 child 绑定、固定上界完整历史及正文；失败、未完成取消、reset、scope 变化及超出上一代观察均失效。停止、Job输出等入口不使用这份候选，旧观察不能授予操作资格。加载期先显示准确目录已有的 child 名称，首次正文仍须完整核验后发布。[Main 回归](test/native-background.test.ts)与[首次进入 DOM](test/isolated/native-session-navigation-dom.test.tsx)持有替换目录，核原 child 独立读完、标题与原 Run 不变、成功 publication／close 交错时两次 exact 核验，以及失败／取消／身份／范围／超代观察拒绝和零业务写入。

Main 从实际选中根的 controller snapshot 固定 Store／subject／generation／rootSessionId／viewSelection，复用 [NativeBackground](electron/background.ts)与原完整 reader。封闭 IPC 的 `surface: environment` 仅选择这份 Main 观察，不接收 renderer 根 ID 或路径；它与全局总览有独立读取生命周期，选中根变化只释放环境读取，旧停止资格失效。SSE 或显式刷新触发 GET，完整成功后才发布。页面仅缓存最多八个同代次／Store／根的展示快照，每份最多512KiB；没有 observation、完整输出或提交意图。失败保旧名称和状态，停用停止入口；准确停止继续走原 durable caller，未知／在途原取消不换 ID 重发。

父会话在 [NativeDesktop](src/native.tsx)、子详情在独立 [NativeChildDetail](src/native-child-detail.tsx) 分别选择各自消息和已核实事实，再沿相同的活动工具映射、[desktopTranscript](src/native-transcript.ts) 轮次投影和[工具聚合](src/native-tool-messages.tsx)装配消息，复用共享 Conversation 及正文／工具回调；[SessionPage](../../packages/ui/src/desktop/SessionPage.tsx)同时承载主会话和当前子标签。父历史的展示缓存和未落库首发消息保留原适配。已核实的轮次过程、耗时、终态、最终回复、Markdown 与全文复制沿相同组件呈现；子标签不提供输入、审批或文件打开动作，父会话控件保留原权限门禁。完整 child reader 每次读取固定消息上界并核 ModelOutput 的 EOF／SHA／UTF-8 后显示。宿主将已验证 snapshot 交给 `ModelOutputMessage.verifiedSnapshot`，组件再次核准确出处和字节数，直接呈现已读正文与活动前缀。全局观察修订驱动目录和子详情更新，各自只有一个在途读取，期间变化合并为一次尾随读取，避免持续输出反复中止 GET。活动子页沿同一 context selection 的完整稳定消息前缀重读尾部；Main 核当前父子绑定，context 变化回退全量。公开已完成消息不可由 partial 写路径更新，未完成消息及正文必须重读；后台总览不使用增量游标，保持原完整固定快照。

当前根环境的 [Main child reader](electron/background.ts)在同一已验证快照内附带只读 `presentation`：消息所需的原 Run、准确 Tool 回执和精简的活动执行事实。历史 Run 超出当前 View 时按原 ID 读取；Fork／Include 封存来源仍不借后来的来源轮次补终态。父历史 reader 与 child reader 共用 [nativeToolMessageFact](electron/tool-message-fact.ts) 的原执行／正文匹配、唯一请求目标、问答和授权展示校验。增量更新保留已核实的稳定工具事实及旧终态轮次；仍活动的轮次和未收齐回执的工具请求随尾部重读，直到确认终态及原目标，避免原 Run 离开当前 View 后失去展示。普通轮次／工具元数据读取失败仍交付已核实正文并明确提示，可用原刷新入口重新核对；下一次校准从头读取，身份错绑仍拒绝发布。展示数据不参与准确 carrier 的停止准入。后台总览完整日志继续使用原固定快照；其角色／序号诊断壳保留，正文改用同一 [NativeModelOutputMessage](src/native-model-output-message.tsx)，Markdown 准备、完整／不完整输出、原工具调用和 unsupported 处理均由公共组件负责。主页面也使用该 wrapper 的默认 Markdown renderer，仅注入获准的文件打开回调；推理记录仍须 Native 诊断门禁与显式展示请求同时开启。

2026-10-21，macOS arm64／Bun1.4.2，`3cf44ed0f` 加本次工作树修改：[Main／reader](test/native-background.test.ts)、[环境卡](test/native-background-panel.test.tsx)、[工具事实](test/native-tool-messages.test.ts)、[轮次](test/isolated/native-transcript-dom.test.tsx)、[工具展示](test/isolated/native-tool-messages-dom.test.tsx)、[原始回执](test/isolated/native-tool-receipt-render-dom.test.tsx)、[实际 NativeDesktop 导航](test/isolated/native-session-navigation-dom.test.tsx)、[历史展示](test/isolated/native-history-presentation-dom.test.tsx)、[正文缓存](test/isolated/native-model-output-cache-dom.test.tsx)与[读取归属](test/isolated/native-read-ownership-dom.test.tsx)十个完整文件共122项／1729断言通过；核父子共用消息装配、折叠过程、工具聚合、最终正文／复制、元数据失败保正文、旧活动轮次补核及只读往返，另核诊断完整子日志的共享 Markdown／正文和推理门禁。Desktop typecheck、定向 Biome、统一边界、测试归属和文档检查通过。同一最终工作树的[普通 Electron 流式窗口](test/isolated/native-child-stream-electron.test.ts)通过，沿真实 Service 与受控 SSE 完成100次父／子 A/B 往返；两个子模型各执行一次，最终在途读取为0，未暴露测试诊断入口。不将本机回归推作其他平台或完整安装发行资格。

2026-10-21，macOS arm64／Bun1.4.2，`f655e13fc` 加本轮子详情标签改动：以 `bun test --parallel=1 --max-concurrency=1` 和准确 `./` 文件路径执行共享页面、标签、复制／选区、滚动，以及 Native 环境、导航、历史展示、停止、网页、轮次、正文缓存和读取归属的12个完整文件，共105项／2335断言通过。核主会话标题／正文／输入节点与草稿保持、父历史持续更新、准确 carrier 标签去重、8项容量、标签隐藏释放、迟到 EOF 拒绝、权限撤销后复制零写入与恢复、同一活动标签在 history epoch 更新后全量校准。普通 [Electron 流式窗口](test/isolated/native-child-stream-electron.test.ts)再次通过100次父／子 A/B 导航，原180秒父等待期间子模型各执行一次；三个采样的连接节点均483、监听均554，结束活动读取为0，50ms以上长任务为0。使用实际 SessionPage／NativeChildDetail 与生产 CSS 的 Chrome 隔离夹具检查明暗1440／900px、520px缩窄后恢复、长 Markdown 独立滚动、主输入保留和关闭／切换卸载，页面无横向溢出或错误。UI／Desktop typecheck、定向 Biome、文档、统一边界和测试归属检查通过；保留原 CSS keyframes／大 chunk 提示和原 ToolActivity key 提示，未运行完整默认测试、安装制品或其他平台。

子详情只缓存已验证展示数据，最多12项、64MiB估算载荷、单项16MiB；不保存 observation 或操作资格。重新进入先由当前父范围目录核准子成员，再展示命中的正文，同时完整校准；显式刷新也完整重读，不以相同序号跳过。generation、history epoch 或 bridge 替换清理旧缓存。打开、刷新或返回不改变 Main 阅读根、不取得 child 写权；详情位于共享 SessionTabs 的独立子标签，主阅读根、标题和 `readingKey` 保持父会话，父输入、审批、环境卡、History 与工具／轮次／文件／用量读取继续按原资格运行。标签以原 Session／Execution 去重，最多8项；只有当前可见子标签激活环境 hook 的唯一 child reader，切换网页／变更／其他子任务、关闭标签、收起或设置覆盖会卸载详情并同步释放读取。`NativeChildDetail` 复用共享 Conversation、轮次／工具投影和已验证正文快照；读取资格经 `ConversationActivityContext` 传递，权限失效或选择交接保留正文并撤销复制与正文 reader，只有展示元数据失败不撤销已核正文。标签归属使用稳定 Store／父 Session，generation／history epoch 则由原环境 scope 撤销并重新校准当前目标，避免代次变更后当前子标签失去读取。关闭、切换子页、换根、reset 或卸载会 abort 所属读取，迟到结果不能替换后来视图，读取取消不停止业务任务。消息与正文按 ID 建索引，避免逐行扫描全历史；阅读位置和展开状态由共享 UI 的有界数据缓存保存；主会话继续使用原 KeepAlive，子标签卸载消息树，只保留有界已验证数据与阅读状态。标签与读取归属取舍见[子详情标签决定](../../.agents/notes/implemented/feature/2026-10-21-native-child-detail-tabs.md)，原校准、来源和预算理由仍见[主子会话阅读决定](../../.agents/notes/implemented/architecture/2026-10-15-native-session-reading-lifecycle.md)。

Main 自动刷新父元数据会暂时清空 controller snapshot，但不会因此撤销同一已准入根的 child lease或固定H的Job输出读取。仅在刷新在途、同 selection／Session 且未有真实失败时，环境与Job reader沿 Main 上次已验证根保持范围，每次读取仍核后端绑定；真实换根、reset 或刷新失败立即失效并abort相应读取。自动元数据刷新或显式权限刷新失败时，Main 主动释放 environment 的目录、子正文及输出 lease，清除观察与正文缓冲，不依赖 Renderer close；权限不可用时即使 controller 仍有旧快照也不能重新准入。恢复后旧 readId 与 observation 不复活，必须重新取得完整目录；Renderer 保留上次正文并对当前子页全量校准。[Main 回归](test/native-caller.test.ts)用 held 父 GET 核 child chunk／目录可独立完成，并让失败前的目录和 child GET 忽略 abort、跨过恢复后才返回，核旧结果拒绝、新观察可读及零业务取消；[Job输出回归](test/native-caller-job-output.test.ts)让SDK最新H从2推进至4，确认父刷新未结束仍只读原H2且可同scope重开。两者均核三种真实撤销拒绝迟到结果、零业务取消。主页面在子标签打开期间继续校准历史；父元数据或历史本身不可用时，发送／停止／权限仍等待当前新鲜资格，不因标签切换恢复旧 complete 状态。

Main 的 `state` 与 `messages` 只读请求不等待父元数据刷新结束。`state` 立即投影当时已核实的选择，刷新在途保留原会话并标明 `viewLoading/permissionUnavailable`；完成或失败仍由原观察通知更新。`messages` 只使用当前准确 selection／Session／Store 和原 high water，不能读取后来选择或越过已观察水位；写操作继续等待刷新及自己的权限核验。[Main 回归](test/native-caller.test.ts)持有真实 observer 触发的父 GET，验证返回父历史与状态可独立完成、权限修改仍等待、旧 generation／错误 Store／换 Session 均拒绝。[实际窗口](test/isolated/native-child-stream-electron.test.ts)在父 `task.events` 保持原 180000ms 等待时核准确父正文、草稿响应、两 child 的100次往返及完成后的历史重进；另持有真实父元数据 GET，核刷新在途父子往返仍可阅读、普通写入不可用。完整等待覆盖在触发该元数据变更前完成；导航不重放模型任务，不缩短业务等待。

父历史的可读展示不再等待 Run／Tool／Files 三类辅助元数据全部完成。完整固定水位消息发布后，即使辅助读取在途、返回时又有后继历史校准，正文和草稿仍可显示；未核实工具沿原局部待核组件，不自动展开原结果 JSON，也不取得文件或执行动作。加载图标只用于当前准确会话尚无可读消息；历史 EOF 与 Main 新鲜资格继续独立约束写入。[主子导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)持有原 spawn Tool 元数据，核运行 child 期间子标签切换、关闭与重进、主正文／输入节点与私有草稿保持、父历史并行更新以及父校准未结束时权限仍禁用。[实际窗口](test/isolated/native-child-stream-electron.test.ts)另用真实只读 select 建立新的 viewSelection，持有准确已成功 spawn Tool 的 HTTP200 元数据回复；原180秒 wait与两个 child仍活动时核左栏单击返回和重进，Model调用不增加。该读取不触发 child 完成或重放任务。

多个根并发时，单一全局SSE仍消费并确认全部事件，sidebar／全局总览沿全局修订更新。当前父metadata／history仅由本根或全局失效触发；环境另用 `selectedEnvironmentRevision` 跟随本根、已知后代及保守的新Session创建通知。完整根目录得到的Session索引只用于失效路由，不授予读取或停止权，换根／reset清除；不对每个未选中Session发View GET。Main 的 `environmentReadUnavailable` 把同选择metadata在途与真实读取失效分开，普通刷新期间正文可继续，发送／停止仍等原metadata资格。相邻回归核100个无关root／child事件不重读当前父View，也不丢全局目录或游标推进。

[Controller](src/controller.ts)为每次selection读取持有AbortController，替换／网络释放立即取消旧GET链；每个await后与写入缓存前均复核当前选择，退役结果不再进入缓存。Renderer state刷新至多1个在途与1个最新后继，密集通知共享后继且保留显式刷新后的新事实要求；错误、结果按原generation／nonce／epoch隔离。child可取消自己等待共享目录的任务而不取消目录owner，同一份新目录只消费一次；真实后续修订仍排尾随读取。[读取所有权](test/isolated/native-read-ownership-dom.test.tsx)与[导航回归](test/isolated/native-session-navigation-dom.test.tsx)核100次通知／等待、迟到错误和换根，SDK完整后台目录的有限重扫规则归[Client owner](../../packages/client/README.md#完整后台执行目录)。

子标签切换、关闭或隐藏同步撤销当前child导航意图，再取消job／读取；自动恢复只依据当前意图，不能使用旧render捕获的child重新打开详情。目录提交与返回在layout／passive交错时，原代码实际复现返回后重新打开子页；精确交错回归在旧实现失败，修复后通过。临时权限丢失保留尚未撤销的意图，恢复时仍正常校准；换根和明确关闭或隐藏子标签则终止该意图。

环境卡准确停止接纳期间，同scope目录刷新排队，先等待已经在途的完整读取，再按最新完整facts核目标与停止资格；原停止申请只提交一次。目录结果立即更新读取owner的最新facts，避免React尚未commit而使用旧observation。停止返回后恢复目录校准，换根只撤销尚未提交的等待；已提交的原停止继续收束，迟到提示不能进入新scope。Main原有prepare前后两次新鲜度校验、准确身份和unknown不重试保持。[停止竞态DOM回归](test/isolated/native-environment-stop-dom.test.tsx)在旧实现复现轮询替换观察及未等在途目录即提交，修复后3项／24断言通过；真实混合压力复测归下方监督进程对照。

实际多根窗口还发现滚动后立即离开会保留旧消息DOM：GC后脱离document的节点500→2217，heap snapshot定位13棵Conversation经Document动画controller→RAF closure→旧viewport持有。原Radix ScrollAreaThumb卸载遗漏持续RAF清理；消息区现使用组件库 ScrollArea，并通过版本绑定补丁补齐卸载清理，原阅读位置／自动跟随／跳最新／细滚动条保持，资源归属和100轮立即卸载回归归[UI owner](../../packages/ui/README.md#完整模型正文展示)。修复前的GET已排空与单一SSE并不能证明DOM释放，两项证据分别保留。

活动大正文持续改变时，纯全文key缓存仍会miss。多根长正文CPU profile曾在开发React运行时复现99次约60ms长任务，固定parser的micromark tokenizer／调用栈占主要时间；不能用Promise延后同一主线程工作解释为消除阻塞。[Native Markdown准备](src/native-markdown.ts)现将至少32768个UTF-16单位的已验证Model正文交给[静态Worker](src/native-markdown-worker.ts)，只运行UI公开的固定remark／GFM／CJK强调兼容／公式纯解析。renderer、语法缓存和Worker共同使用UI声明的parseOnly扩展，准确源码、offset和原输出／复制不变；源码位置与中文边界回归归[UI owner](../../packages/ui/README.md#markdown-消息内容)。一个active计算、最多8个pending、排队源文本估算16MiB，超限明确 `native_markdown_busy`；活动单篇仍完整解析。准确任务ID／原文和AbortSignal隔离迟到结果，取消当前计算终止对应Worker，不取消业务。

child每批完整facts按序准备所有正文，缓存重进也先准备，再发布新formatted内容；旧已验证正文保留到替换完成。每批只注册一个owner abort listener，新批提交后立即释放旧批；重用稳定snapshot时清理核owner身份，inactive LRU不强持超预算AST。当前展示与正在准备的新批可短时各持一份纯树，不能将其算成全局语法缓存8MiB的进程内存上限。手动Model全文的有限HTTP／IPC在CPU准备前已关闭，成功展示的owner直到关闭／卸载才释放，验证失败立即清理。[准备回归](test/native-markdown.test.ts)核队列、超载、100次revision、共享前缀、取消及迟到身份；[正文回归](../../packages/ui/test/model-output.test.tsx)核成功展示与拒绝释放。最终真实窗口数据须同时说明React构建环境，不把旧开发运行时与production差异全部归因Worker。

Worker只导入公开纯子路径 `@kite-ai/ui/desktop/markdown`；[共享构建解析](scripts/markdown-worker-resolution.ts)将准确 `decode-named-character-reference` 依赖固定为锁定包的默认纯实体查表入口，避免browser入口在Worker中访问document。production renderer／Worker与development预打包共用该exact alias，不改变CSP、webSecurity或其他browser条件。[实际构建回归](test/native-markdown-build.test.ts)把真实Vite Worker产物置于无document／window／Node权限的VM执行，与固定parser核中文、emoji、多码点实体、后置reference和GFM的AST一致；普通sandbox的Electron短probe另核静态asset真实响应及所属进程退出。

首次或缓存重进的完整校准失败后，下一个修订仍执行全量读取；旧缓存不能因失败而取得稳定前缀资格。没有已验证前缀时不发送增量游标，[环境回归](test/native-background-panel.test.tsx)覆盖空缓存及已有缓存两种失败恢复，避免空context游标卡死或绕过完整校准。

[Main／IPC](test/native-background.test.ts)、[环境卡 DOM](test/native-background-panel.test.tsx)、[目录 reset](test/native-caller.test.ts)及[原页面](../../packages/ui/test/desktop-page.test.tsx)核准确作用域、全局／当前独立读取、完整分页、只读往返、旧快照与重复停止抑制。实际 [子详情／恢复窗口](test/isolated/native-background-bundle.test.ts)和[宿主 Shell 窗口](test/isolated/native-shell-lifecycle-bundle.test.ts)沿原业务断言验入口；准确结果、原失败和阶段限制见[本片进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-环境信息卡与只读子详情)。

2026-10-15在本轮未提交工作树、macOS arm64、Bun1.4.2／Electron44.3.0执行 `bun test apps/desktop/test/isolated/native-child-stream-electron.test.ts`，使用普通制品、真实Service与受控SSE Provider，两个真实worker各有约172905字节子正文、五次活动更新。[窗口测试](test/isolated/native-child-stream-electron.test.ts)和[driver](test/native-child-stream-electron.fixture.ts)实际完成100轮主／子A/B往返。固定GFM纯语法树缓存前后，热缓存往返P50为142→103ms、P95为181→145ms，切换期间50ms以上长任务100→0；最终活动正文更新P50／P95为135／144ms。语法树仅缓存数据，32项／8MiB总估算／2MiB单项，超预算仍完整解析，不保活隐藏组件。

资源采样在20／60／100轮先等实际HTTP body归零、两帧与微任务后再GC，heap分别15625972／15347028／16380200字节，最终再次settled GC为16302688字节；DOM477、监听器211、documents2均恒定。有限body读取最终active0、峰值1；主模型2次、子A/B各1次，导航没有重放任务。该负载未观察到资源累积异常；采样不直接证明Main私有lease Map为零，其关闭由单元／DOM持有读取回归核对，也不代表数百条子历史、任意超长冷读或其他平台资格。所有测量均由隔离runner／外部CDP完成，普通dev／prod无测试入口。

2026-10-19上述双child原整文件另沿当前 `task.spawn@1`、prompt/task_name及准确Tool-parent carrier来源复验，1项5条Bun断言、22.21秒通过；父Provider两次、child各一次，原100次导航、大正文、heap/DOM/listener和所属进程收束保持，547次有限读取最终active0、峰值1，导航长任务0。原角色参数不再通过普通模型目录，driver按实际taskName/prompt核两个不同Session及正文归属；全部原预算保持。

[多根真实窗口压力](test/isolated/native-multi-session-stream-electron.test.ts)和[driver](test/native-multi-session-stream-electron.fixture.ts)将范围扩大到4根各3子：先核 `spawn_agent` 的准确 `task.spawn@1` Tool 与所属 carrier 真正派发、16个Model同时流式运行，再完成120次跨根／主子／子子切换，逐次核正文marker和私有草稿归属、活动更新、读取中断、零导航重放及准确根／child停止。夹具使用当前六工具的 prompt／task_name 输入，原角色、key 和 required 字段不进入模型目录。可信Host显式16个Model槽仅用于压力，生产默认仍4；Model输出由本机compatible SSE Provider提供，Service／SQLite／Runtime及普通sandbox窗口均真实运行。

2026-10-19本轮未提交工作树沿上述原整文件复验：普通Model组1项5条Bun断言、35.11秒，保20次Provider、16条同时流和120次导航，937次有限读取最终active0、峰值2、主动取消17次，全局observe一条，导航长任务0。原混合Shell模式另1项5条Bun断言、47.40秒，16条Model流与16棵真实Shell树重叠30.131秒、32次Provider及120次导航保持；1284次有限读取最终active0、峰值2、主动取消114次，导航长任务0。根停止将16条流准确收束到12，另停单child剩11，原完整输出、资源与所有所属进程收尾断言通过。两组均保原190秒整例、160秒driver及所有阶段预算，未以较轻负载替代；历史测量仍按各自日期与环境解释。

2026-10-15 production React制品完整通过：切换P50／P95为146／183ms，50ms以上长任务为0；944次有限正文／目录读取最终active0、峰值2、主动中断8次，全局SSE始终仅一条。settled GC三次heap为11.67／12.88／13.02MB，最后13.02MB；连接DOM随活动正文由357增至425，但脱离document的节点始终59，监听器227／227／228，没有再出现旧消息树累积。显式停止一根后16条模型流剩12，另停一child剩11，其余继续，正常结束后所属Service和Electron实际退出。此前99次长任务来自开发React制品及同步parser，两轮构建环境不同，不能把全部差异归因Worker。

同一测试的私有 `KITE_NATIVE_MULTI_SHELL=1` 仅选择隔离runner负载，不进入普通renderer／Main构建。混合组沿Service的[同一真实Shell脚本与配置](../service/test/isolated/multi-session-shell-load.shared.ts)为每根／子启动一个Shell，生产React窗口在16个Model、16个coalition Shell和16个真实sleep后代重叠30.004秒时完整完成120次切换：P50／P95为176／223ms，长任务0。普通页面核实际中文Shell工具与运行状态；完整stdout／stderr经原私有固定H读取协议核204条／462848字节、H204、UTF-8及gap0，held输出在换根时被abort而16个脚本仍运行。没有开启测试诊断菜单或新增普通完整输出入口。

混合组1516次有限正文／目录／输出读取最终active0、峰值2、主动中断58次，全局observe仍一条；32次实际Model调用不因导航增加。GC后三次heap为12.02／12.73／12.89MB、最终12.77MB，连接节点随正文增长425→503，脱离document节点59和监听器236恒定。根停止准确结束所属4条Model与4棵Shell树，另一个child停止只结束自身Model与Shell，其余11组继续tick／输出；显式finish后全部剩余Run及观察到的OS PID结束，Service与Electron实际退出。

混合窗口总Shell生成10379264字节，稳态双流合计162820字节／秒，脚本采样窗实际CPU约84.75%（单核100%口径）。Service RSS从836736至841056KiB、数值FD89恒定；原外部采样将ledger的32个脚本／后代PID与Service物理树17个进程取并集，共49个进程合计RSS约1.90→1.93GiB。2026-10-16复核发现，这份集合包含16个broker，却遗漏launchd下另16个独立guardian；RSS相加还重复计共享页，因此不能称完整产品或独占物理内存。原数据保留为旧口径参考，不补造遗漏进程的数值；同日已补完整角色并执行下面的同口径前后对照。以上有限本机CPU、进程与正文负载不等于任意Shell、无限历史或长期无泄漏保证；默认Model／process各4的排队、完整输出SHA及Service内存分类另由[Service压力](../service/README.md#多主子会话流与读取压力)维护。

### 内存缓冲区优化与完整进程对照

2026-10-16在macOS26.7.1 arm64／Bun1.4.2／Electron44.3.0当前未提交工作树完成两项内部IO优化：[启动文件校验](../../packages/agent/src/jobs/launch-identity.ts)每次以至多1MiB局部scratch计算完整SHA；[POSIX Artifact](../../packages/agent/src/artifacts-files.ts)按消费者所有权分配小chunk／固定verify scratch／单完整目标，保实际EOF、hash、文件新鲜度和权限。消息协议、默认配额、broker／guardian／coalition结构及业务取消语义保持；代码和局部回归归[Jobs](../../packages/agent/src/jobs/README.md#默认-macos-宿主-shell)、[Artifact](../../packages/agent/src/artifacts/README.md)及[决定](../../.agents/notes/implemented/architecture/2026-10-16-bounded-verified-file-reads.md)。本轮未实施正文复用或native broker。

[测试私有内存采样器](test/native-memory-census.fixture.ts)只由隔离runner的 `KITE_NATIVE_MULTI_SHELL=1 KITE_NATIVE_MULTI_MEMORY_TAG=before` 或 `after` 选择，未向普通dev／prod增加入口。它只读原Job reference，严格解码Session／Execution／nonce／owner绑定，核broker、launchd guardian及root原kernel birth，再合ledger后代与Electron所属进程；同一ps快照分角色RSS，原身份在采样前后复核。每轮实际为65个业务进程（Service、16 broker、16 guardian、16 Bun脚本、16 sleep）及4个桌面进程（Main、renderer、GPU、utility），排除driver／Provider。联合footprint一次传入69个准确PID；缺字段、集合不符、命令失败或身份漂移明确unknown并阻断完整对比，不填0。每PID当前与历史峰值、联合dirty／clean／reclaimable／swapped及代表vmmap保原始文件，多个历史峰值不相加称并发峰值。

两轮沿同一[隔离测试](test/isolated/native-multi-session-stream-electron.test.ts)和[窗口driver](test/native-multi-session-stream-electron.fixture.ts)串行执行，三份测试文件SHA完全一致，生产差异仅上述两个IO文件；guardian与Service每轮重新构建。before保原 `launch-identity.ts` SHA `1cad32fe…`／`artifacts-files.ts` `d9927d6e…`，after为 `0d592dbf…`／`84ae8b72…`；tag只是保存标签，不能把当前新实现标before来替代原基线。两轮各1项通过，59.87／59.08秒，保原16 Model＋16真实Shell／至少30秒重叠／120次导航、相同脚本、正文及输出／CPU速率。重型footprint／vmmap仅在导航PerformanceObserver断开后执行，3.315／3.141秒；采样前最年轻脚本已运行30.006／30.055秒，生成10356736／10366976字节，采样后33.223／33.068秒、10893312／10874880字节，未通过减少负载取得下降。

| 同一完整集合的测量 | before | after |
| --- | ---: | ---: |
| 69进程RSS求和，KiB | 4494976 | 3510992 |
| 其中65个业务进程RSS求和，KiB | 3595088 | 2617728 |
| Service RSS，KiB | 841520 | 682208 |
| 16 broker RSS求和，KiB | 558064 | 555840 |
| 16 guardian RSS求和，KiB | 1557840 | 755296 |
| 16业务脚本RSS求和，KiB | 618208 | 604928 |
| 16 sleep RSS求和，KiB | 19456 | 19456 |
| 联合去重dirty footprint，字节 | 1476108080 | 1471225432 |
| Service历史phys_footprint峰值，字节 | 358778056 | 301696128 |
| guardian单PID历史峰值中位数，字节 | 75154032 | 23413360 |
| 导航P50／P95，ms | 183／224 | 171／226 |
| 导航超过50ms长任务 | 0 | 0 |

RSS求和下降21.89%，guardian及Service的分配高水位下降；联合当前dirty footprint仅下降0.33%，不能称持续独占物理内存大幅降低。guardian当前phys_footprint计数的算术合计反而由191293136增至209905288字节，Service当前由144410016至149062952字节；这些分项不是角色去重总量，RSS也不能解释为活heap。联合reclaimable由2122891264降至1128513536字节，仍与当前dirty分开报告。两轮只是一组before／after，没有估计多轮波动；收益限定减少多余分配与高水位，不能据此证明任意时长无泄漏。

两轮消息／草稿归属、活动更新、固定H输出UTF-8及gap、真实GET中断、单global observe和零导航重放均通过。末次Renderer GC heap为13081072／12803876字节，文档外DOM余量最终均59、监听器均236，有限body active均0；root0停止后剩12流，另一个child准确停止后剩11流，其余继续。正常业务结束和所属退出之后，另用原69份kernel birth逐一只读复核，两轮全部absent，包含guardian和桌面进程；这是额外posthoc核验，未冒称原fixture内已有断言。定向资源回归另有6个真实Shell文件47项／445断言，覆盖父EOF／SIGKILL、TERM忽略、setsid／orphan、无关存活、输出失败与准确收尾。

本机原始文件分别保存在ignored `.cache/native-session-stream-evidence/memory-1792083158073-before/`、`memory-1792083544600-after/`，比较文件 `memory-before-after-comparison.json`；每轮含逐PID角色／birth／RSS、原footprint JSON/text、6份vmmap、输出／elapsed、完整窗口报告和原身份退出结果。当前产品行为仍由手册与owner定义，本机loopback Model和macOS真实Shell不授其他平台资格；普通dev／prod继续关闭测试诊断入口。

### broker／guardian 的小堆对照与 GPU 归因

2026-10-16在相同macOS26.7.1 arm64／Bun1.4.2／Electron44.3.0（Chromium152.0.7977.78）工作树完成default／`--smol`各三轮，顺序为default、smol、smol、default、default、smol。每轮仍为4根各3子、16路受控compatible SSE模型流、16个真实Shell、至少30秒同时运行和120次切换；真实Service／SQLite／Runtime、production React与普通sandbox窗口保持，模型token由本机Provider产生。窗口1100×780、显示比例2，GPU compositing／rasterization／Skia Graphite／WebGPU保持启用。

当时的隔离候选构建复制同一267文件Agent源快照，smol仅在broker启动和launchd guardian启动两处argv插入 `--smol`；Service、业务脚本及普通产品入口不改。原源码、package和测试输入SHA逐轮复核不变；每轮私有路径不同，分别保存资产SHA，不声称同组制品逐字节相同。实际ps和16份launchctl print核smol每轮恰16 broker＋16 guardian带flag，其他角色无flag；default全部无flag。对照结束后已移除私有源码改写器和候选选择参数，当前压力回归只使用默认runtime，逐PID ps与16份实际launchd argv继续断言不带 `--smol`。

[采样器](test/native-memory-census.fixture.ts)保原65业务＋4桌面进程联合footprint，另对同一批16 broker＋16 guardian做32 PID联合footprint；两份原始集合、kernel birth和错误字段均严格核验。角色RSS／phys_footprint算术合计不冒称去重值，历史峰值不相加。导航后先采联合footprint与代表vmmap，再采GPU；GPU trace引入的额外tracing utility随后登记，退出证据因此覆盖全程70个原身份。退出核验在正常driver退出之后、owner兜底清理之前执行，六轮均70/70 absent。

| 轮次 | 69 PID联合dirty footprint，MiB | 32监督进程联合dirty footprint，MiB | 导航P95，ms | 根／子Shell树停止，ms |
| --- | ---: | ---: | ---: | ---: |
| default-1 | 1432.49 | 387.36 | 232 | 272／109 |
| smol-1 | 1439.09 | 379.85 | 242 | 262／274 |
| smol-2 | 1438.96 | 381.63 | 239 | 221／194 |
| default-2 | 1470.27 | 388.78 | 291 | 281／266 |
| default-3 | 1433.87 | 386.36 | 231 | 209／183 |
| smol-3 | 1452.40 | 383.10 | 225 | 228／132 |

69进程联合dirty中位数为1503518704→1508990624字节（1433.87→1439.09MiB，+0.36%）；32监督进程为406179424→400166520字节（387.36→381.63MiB，−1.48%，减少5.73MiB）。guardian单PID历史峰值的组中位数22.65→17.45MiB，但其当前phys算术合计202.96→196.35MiB，broker当前187.78→187.23MiB；启动高水位下降不能当作同量稳态收益。全体RSS算术合计中位数3514.73→3539.27MiB（+0.70%）。本机证据只支持监督进程小幅下降，没有证明整体内存稳定改善，**保留默认参数，不在生产broker／guardian启用 `--smol`**。

导航P50／P95组中位数为177／232→185／239ms；每轮P95范围default231–291ms、smol225–242ms，六轮均无超过50ms导航长任务。根取消至模型流关闭中位数64→46ms、至原Shell树消失272→228ms；准确子停止至流关闭79→78ms、至树消失183→194ms。CPU按checkpoint20至120的累计CPU时间差／实际壁钟计算，100%表示一核：32监督进程合计中位数19.88%→19.24%，Service79.42%→79.27%，renderer76.05%→81.84%；脚本输出约162267→162859字节／秒，脚本窗口CPU76.66%→84.50%。三轮样本不足以判定小幅性能差异的因果或显著性，不宣称smol提速。

六轮均核活动主／子正文持续增长、逐次marker与草稿归属、完整UTF-8／固定H输出、读取中断、原32次Provider调用零导航重放、单一global observe、有限body最终active0／峰值2。根停止仅关闭其4路模型和4棵Shell树，剩12路；另停准确child剩11路，其余继续产出。最终renderer GC heap为12.23–12.52MiB，24个固定checkpoint文档外DOM余量均59，最终监听器均236。该负载未观察到持久资源累积，不外推任意运行时长零泄漏。

预检和先前两个未完成matrix均保留失败记录，不纳入最终六轮统计。首个matrix的default子停止实际报 `background_stop_unavailable`，定位并修复上文同scope目录刷新替换停止观察的竞态；定向DOM旧实现失败、新实现3项／24断言通过。另一次活动更新恰在GC与计数之间启动新校准，计数236→269，随后heap snapshot已回236，不能将瞬时33项确定归为泄漏或AbortSignal。固定快照现仅短暂排队普通changed通知，后端16路模型和Shell、请求回复及lifecycle继续；固定两次GC、原listener／DOM／heap门限不变。六轮窗口108–211ms、队列1–6条，finally恢复并原序转发，队列越界明确失败；释放后等待界面校准和有限读取收束，再采联合footprint或进入下轮导航。导航／取消计时和重型footprint在窗口之外，不以循环采最小值通过门禁。

[GPU采样器](test/native-gpu-memory.fixture.ts)在导航后和业务结束后各触发一次有界详细MemoryInfra dump，保存原trace、准确GPU PID／出生身份、allocator size／effective_size与ownership。Chromium本机导出零ID数据批，采样严格用唯一成功explicit global GUID、配对process scope和批次时间绑定；缺失／冲突／丢数据均报unknown。另存同一GPU进程OS分类footprint与vmmap，不把异时OS和Chromium值相减。12个阶段均capture成功，非total OS类别按dirty／reclaimable／wired／clean／swapped／regions分别求和均与total相等。

导航后GPU OS dirty为266.05–340.95MiB，其中 `IOSurface`、`IOAccelerator (graphics)`、`Owned physical footprint (unmapped) (graphics)` 三类占89.00%–91.76%。六轮Chromium均有明确共享边：`shared_images.size − effective_size`精确等于renderer `cc/tile_memory`，`gpu.size − effective_size`又等于该tile数加20193088字节transfer分摊差。例如default-1的640×800 BGRA_8888 IOSurface带 `GpuRasterTile_Pid:65235`，与renderer resource_41的 `0x1f4000` 字节指向同一global ownership端点，importance分别0和2。不能把GPU根、SharedImage和CC tile再相加；这些分摊来自trace原始effective值，不是自行估计去重。

导航后ANGLE Metal约81.45–91.77MiB、Dawn8.23–8.37MiB、Skia GPU resources4.23–4.37MiB。独立GPUBuffer allocator未导出，分类完整性仍为partial，缺项不填0；OS未映射图形计费也不能逐笔映射到Chromium节点。业务结束后的图形缓存仍有计费，所属GPU进程随正常退出全部消失；这既不证明缓存泄漏，也不构成关闭GPU或改变玻璃效果的依据。

本机最终矩阵在ignored `.cache/native-session-stream-evidence/smol-matrix-1792120884578/`，`index.json`保存顺序、冻结输入和六份证据目录，`comparison.json`保存原始字节／各轮性能／中位数范围。各case含69及32联合footprint、16份launchd证据、8份代表vmmap、两阶段GPU原trace／OS分类、快照边界、窗口与原70出生身份退出结果。较早未完成矩阵为 `smol-matrix-1792118528064` 和 `smol-matrix-1792119706839`；它们的单轮成功未混入最终结果。平台、模型及持续时间资格限于上述本机负载。

### GPU 缓存生命周期与候选对照

2026-10-16继续沿上述macOS／Electron版本、1100×780窗口和DPR2排查图形持有，broker／guardian始终使用default，macOS Vibrancy及GPU特性保持。受控模型token、真实Service／Runtime／SQLite、16路模型流、16个真实Shell、至少30秒并发和120次切换均保持。当时的隔离候选仅向私有构建CSS追加一条规则；default不写字节，每轮保存前后SHA与准确规则。普通dev／prod没有候选或生命周期测试开关，当前没有采纳生产GPU参数或样式修改；未采用的构建改写器及其测试参数已删除。

`contain: paint`候选完成default／candidate各三轮，顺序default、candidate、candidate、default、default、candidate。冻结17份输入和Agent源快照，默认原CSS SHA逐轮相同；完整输入副本与失败的探索记录保留在本机证据中。正式六轮只执行原内存、流、切换、取消和退出测量，没有在这些采样间启用LayerTree或运行静态视觉诊断。69 PID联合footprint均为原65业务＋4桌面进程；另核16 broker＋16 guardian的32 PID联合footprint，集合及出生身份逐轮匹配。

| 指标，中位数（最小–最大） | default | paint containment |
| --- | ---: | ---: |
| 69 PID联合dirty footprint，MiB | 1449.71（1428.37–1452.55） | 1443.05（1435.13–1463.98） |
| GPU当前phys_footprint，MiB | 375.64（367.39–383.25） | 378.56（368.91–379.55） |
| 32监督进程联合dirty footprint，MiB | 384.02（383.58–387.50） | 388.52（387.83–388.94） |
| CC tile总量，MiB | 74.03（67.05–77.57） | 72.06（68.14–73.04） |
| CC tile in-use，MiB | 32.23（32.23–32.23） | 32.23（31.68–32.23） |
| 导航P95，ms | 217（215–226） | 221（220–226） |

GPU当前计数增加0.78%，联合footprint仅下降0.46%且范围重叠，不能证明持续收益，**不采用paint containment**。稍后单GPU OS dirty中位数341.72→330.39MiB来自另一采样阶段，不能与较早census相减，也不能代替同一checkpoint的当前计数。free tile中位数虽下降53.34%，candidate第二／三轮分别转为22,921,216／18,792,448字节busy；逐轮free＋busy的中位数仅43,827,200→41,762,816字节，in-use中位数不变。不能把池内状态转移解释为同量内存释放。

六轮导航后GPU OS dirty的88.46%–91.80%仍在IOSurface、IOAccelerator graphics与unmapped graphics三类；12个GPU阶段原始分类逐列求和与total相等，独立GPUBuffer类别仍为unknown。SharedImage与CC tile的ownership边继续表明同一分配跨进程分摊，不能将图像、tile和GPU根直接相加。[准确Chromium版本的ResourcePool](https://github.com/chromium/chromium/blob/152.0.7977.78/cc/resources/resource_pool.cc)区分unused、等待显示端归还的busy和in-use；unused默认过期5秒，复用会刷新时间。[SharedImageManager](https://github.com/chromium/chromium/blob/152.0.7977.78/gpu/command_buffer/service/shared_image/shared_image_manager.cc)按引用释放backing，不存在整个SharedImage目录统一5秒到期的规则。删除缓存对象也不保证OS计费同步下降。

六轮逐次marker／草稿归属、活动主子正文增长、完整UTF-8及固定H输出、所属读取中断、零导航任务重放和单global observe均通过；有限body最终active0／峰值2，文档外DOM余量最终均59、监听器236，末次renderer GC heap为12.20–12.47MiB。导航长任务均0；根／子模型流关闭中位数67／76→40／81ms，所属Shell树停止288／244→252／210ms，Shell输出约163296→163287字节／秒。准确根停止后仅其4路及4树结束，另停准确child后剩11路继续；六轮均在owner兜底之前核原70出生身份全部absent。这些断言未见退化，不外推任意时长无泄漏，三轮每组也不能证明小幅计时差异有因果。

当时的有界生命周期采样记录当前DOM／LayerTree及合成原因，但层面积不是实际驻留字节。[Chromium启用LayerTree会为owner debug信息触发重绘](https://github.com/chromium/chromium/blob/152.0.7977.78/third_party/blink/renderer/core/frame/local_frame_view.cc)，因此有效时间线将层检查移到全部内存与取消测量之后；早期逐dump检查层的pilot不能作为无扰动自然回收曲线。opaque滚动背景、浮层静止transform和侧栏stacking隔离的单轮探索也未建立收益，不作为正式对照或生产实现；侧栏isolation pilot的GPU当前计数385.42MiB、联合1434.54MiB、tile79.05MiB，原门禁和70身份退出均通过，没有因此采纳。收尾已移除LayerTree、固定页面额外采样和测试critical pressure分支，没有引入普通客户端诊断入口或全局强制清缓存策略。

移除采样间LayerTree干扰后，以default补做同一负载的固定页面时间线：选中root-3不变，活动阶段16路模型及16个Shell继续运行，导航后／同页6秒／12秒的GPU OS dirty分别264.06／338.19／350.25MiB，tile80.90／71.09／79.49MiB。全部业务结束后的同页观察如下。每行仍保存独立OS与MemoryInfra原始记录，不将两者相减；这是一轮生命周期观察，不是优化收益对照。

| 同页业务结束后的阶段 | GPU OS dirty，MiB | CC tile，MiB | tile free／busy，MiB | SharedImage size／effective，MiB |
| --- | ---: | ---: | ---: | ---: |
| 原500ms等待后的采样 | 379.39 | 112.20 | 98.18／0 | 151.62／39.42 |
| 自然空闲6秒 | 52.11 | 14.02 | 0／0 | 53.43／39.42 |
| 自然空闲12秒 | 46.33 | 14.02 | 0／0 | 53.43／39.42 |
| 之后的测试critical pressure | 48.14 | 14.02 | 0／0 | 53.43／39.42 |

ANGLE Metal同期123.22→15.59MiB、Skia资源4.79MiB→4096字节，SharedImage size的下降与tile free消失一致；effective不变再次说明同一tile分配的ownership，不能重复加总。该轮表明空闲图形缓存能自然回收，尚无证据将活动阶段高水位归因为旧会话DOM或图形资源持续泄漏；它没有证明任意时长不存在泄漏，也没有降低活动负载的实际计费。末次LayerTree因空闲后没有取得事件而超时并明确incomplete，不填造层归属；超时发生在所有7次内存采样之后。该轮导航P95为222ms、长任务0，根／子Shell树停止233／215ms，原70出生身份全部absent。本机原始证据为ignored `memory-1792124499546-gpu-lifecycle-clean/`及其中的`lifecycle-comparison.json`。

正式六轮本机证据位于ignored `.cache/native-session-stream-evidence/gpu-paint-matrix-1792123749012/`，`index.json`保存顺序、输入副本SHA和测量边界，`comparison.json`含逐轮字节、角色CPU、性能和退出结果。当前默认基线回归使用 `KITE_NATIVE_MULTI_SHELL=1 KITE_NATIVE_MULTI_MEMORY_TAG=gpu-check bun test --parallel=1 --max-concurrency=1 apps/desktop/test/isolated/native-multi-session-stream-electron.test.ts`，保留完整角色内存统计、32监督进程联合footprint和导航后／业务结束后两阶段GPU归因，不再选择实验候选。**本轮已按用户要求结束，实际降低活动GPU footprint的优化目标未达到**；保留此前已验证有效的有界文件读取、会话缓存、流读取释放与取消竞态修复，产品行为、玻璃和默认参数保持。删除前的三个实验fixture与runner／driver／census原始输入及SHA保存在ignored `.cache/native-session-stream-evidence/closed-gpu-experiments-1792128424346/`，历史测量没有因清理而被抹除。

清理后的默认复核在ignored `.cache/native-session-stream-evidence/memory-1792128688458-cleanup-default/`。原16模型流／16 Shell／120次切换门禁通过，普通生产React窗口`diagnosticsAbsent=true`；导航P50／P95为176／229ms、长任务0，有限body最终active0／峰值2；根／子模型流关闭42／76ms、Shell树停止196／293ms，原70出生身份全部absent。两阶段GPU归因继续成功，原69及32监督进程集合、16份默认launchd argv完整核对。窗口／玻璃、会话缓存、流读取／取消及有界IO优化涉及的20份生产文件与清理前SHA全部相同，清理没有改动已验证的产品实现。

## Native 跨会话后台总览

2026-11-10 生命周期核对发现既有入口差异：[产品手册](../../docs/handbook/clients/desktop/README.md)描述通用Native可打开后台总览；当前及未修改HEAD `4a527742c` 的[Root](src/native.tsx)均由`diagnostics && toolsOpen`才挂载该面板，普通dev／prod诊断关闭时没有这个入口。底层只读目录可读和隔离面板测试不证明普通入口已交付，也不改写手册承诺。本次新增命名Job仍被普通环境投影的Shell／child来源规则排除，相关生命周期目标不恢复或扩大这项既有入口；该客户端差异保留在本专题。

[当前会话](src/native.tsx)的后台状态汇总仅在显式测试诊断中显示；普通 dev／prod 在计数非零、未知或观察不可用时也不显示该行。原轮次进度、环境信息中的实际任务、准确停止和真实读取／权限失败的恢复入口继续保留。测试计数限定当前 Session/Store 的未结束 Job 与 outcome_unknown；planned/dispatching/running 包含停止未结算的项，终态、其他 Session、旧 Store、非 Job 不计入。计数使用 getView 的全部非终态投影，不是跨会话完整目录；父 Run 完成不清除后台状态。观察／权限不可用时，测试汇总标为上次确认状态，数量不授予停止权或证明实际进程存活。[installed 默认 Shell](test/isolated/native-shell-lifecycle-bundle.test.ts)显式构建测试诊断，沿实际页面核父已完成、2 项未结束及准确停止后 1 项未结束；原完整输出、Main/Service fault、冷读与保数据卸载断言保持，准确证据和未验范围见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08父轮次完成与后台状态分别显示)。

正式 renderer 的[后台总览](src/native-background-panel.tsx)是独立于选中会话的主动入口。它读取原主体根会话树内全部当前来源 Job，以及准确恢复根中的旧来源历史，包含 child/task carrier 与子会话中的 Job；超过200项仍穷尽全部页，不从有限 `selection.executions` 猜完整集合。每项分别显示原 Store、原父 Run、准确 `child-start-${executionId}` 子 Run、delivery 与结果接纳；较新的子 Run 不替换原载体。公共来源与快照合同由[Store](../../packages/agent/src/storage/README.md#跨会话原-job-目录)、[Service](../service/README.md#完整后台执行目录)和[Client](../../packages/client/README.md#完整后台执行目录)维护。

[Main](electron/background.ts)固定 attach generation、Store、subject，先完整核公开目录再登记 immutable lineage 的 observation。512KiB/最多200项的有限 [IPC](electron/native-ipc.ts)只接 read ID、已观察 execution ID、observation ID 与准确停止 command ID；renderer 无法提供 Session、Workspace、路径、游标或 Runtime authority。[完整目录 reader](src/native-background.ts)只有穷尽同一观察才发布；新读取失败保留同 scope 上次完整显示，但新观察使旧停止 authority 失效。选择变化不清后台观察；断线、观察 reset、attach 替换和释放清所属读取及停止资格。

新子日志读取先等待在途完整目录收束，再从最新 facts 核同 Execution、Store、Session、Workspace、原载体及 child 血缘；目录失败不能借用上次显示的令牌。接纳期间暂缓新目录 poll，原 `background.child.open` 返回后即恢复轮询，正文仍沿固定 scope 读到完整 EOF；关闭或 scope 更换可撤销等待及接纳。React 显示尚未提交不影响最新完整 facts 的选择，已固定读取不随后续 observation 更新重开。[原 DOM 回归](test/native-background-panel.test.tsx)6pass／73断言与同一源码外完整后台窗口1pass／119断言核此竞态和后续全流程，实际版本、失败及完整默认资格见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

非选中原输出复用[固定 H reader](electron/job-output-reads.ts)与公共覆盖证明；原目录刷新不重开已经完整的输出。Main 固定当前准入 Store 与原 Execution originStoreId，原输出不改出处。子日志逐页读原子会话固定消息上界，核原载体／父链与根血缘，并以当前 Store 读取完整原 ModelOutput；带 originMessage 的正文另核原 Model 的 Session／Run／originStoreId。64KiB传输核完整EOF、SHA和fatal UTF-8，原载体的子 Run 与日志中后来轮次保持各自身份。关闭详情或总览只 abort 所属 GET，零取消或恢复。这里的完整子日志指子消息与完整 ModelOutput；诊断 SessionLog 的 restore replayFloor 合同保持。

旧来源项显示恢复历史只读；Main 在准备停止前要求原 Execution 来源等于当前 Store，底层取消还在首写前核整个效果范围的当前来源。新 Store 内明确创建的工作仍可准确停止。Main 重新核原身份、活动状态、attempt/owner generation/result revision 后，经[原 caller journal](electron/caller-journal.ts)保存准确实际 Session/Workspace 的 `execution.cancel`。内部后台 prepare 只接已观察对象并另核根与原主体来源；普通选中根 caller 门禁保持。既有／冷原意图仍只 GET，受理不冒充实际停止。

[Main/IPC 与原 journal 测试](test/native-background.test.ts)、[实际 DOM](test/native-background-panel.test.tsx)、[公共分页测试](../../packages/client/test/background-directory.test.ts)与[真实 Store/Runtime/HTTP](../../tests/isolated/unified-agent/background-directory.test.ts)核完整目录、原轮次、完整原输出／子日志、精确停止和迟到释放。[源码外默认窗口](test/isolated/native-background-bundle.test.ts)与[Electron driver](test/native-background-electron.fixture.ts)核真实默认 task、同父多个后台协作者、非选中日志、单目标停止及冷 GET。实际结果与剩余资格见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)；当前恢复历史资格不外推默认可信 Shell、旧用户数据库转换或全部平台，持久取舍见[已实施决定](../../.agents/notes/implemented/architecture/2026-10-07-native-background-overview.md)。

## Native Job 完整已保存输出

正式 Native 的 Runtime logs「已保存执行」中，准确 kind=job 的详情提供主动读取、显式刷新和关闭。[页面](src/native-job-output-panel.tsx)保留全部已保存 stdout/stderr/progress、原序号区间与准确 droppedBytes；null 表示该剪裁区间的丢失字节数无法确定。完整是截至首次固定 H 的全部保存内容与缺口事实，不恢复已丢字节，也不表示 Job 成功或实际停止。新输出只在显式刷新后进入新的观察。

[Main reader](electron/job-output-reads.ts)在 GET 前同步核实际选择并登记独立 read ID，绑定 attach generation、viewSelection、historyEpoch、当前 Store、原 originStoreId、Session、Workspace 和原 Job；恢复历史仍沿当前连接读取，fresh Execution 独立核原 id/session/originStore/kind，每页前后复核原 Service 身份。有限 open/next/close [IPC](electron/native-ipc.ts)不接 renderer 提供的 Store、Session、Workspace、游标、路径或执行 authority。单页 512 KiB；公共接口只限 normal rows，过大页先核原身份与完整覆盖语义，再在相同 after/H 下减小 limit，首个响应即使过大也不更换 H；非法页不能借缩小重试被隐藏。合法单条 32 KiB 保存 chunk 的 JSON 编码可通过该预算，不从累计字节或页数裁剪保存内容。

[renderer reader](src/native-job-output.ts)复用公共 [ExecutionOutputPages](../../packages/client/src/execution-output.ts)，严格 Decimal64、max(throughSeq) 与 per-stream 区间核覆盖至 H，跨 stream 重叠 gap 与普通 chunk 全保留；全部成功才发布。错误页、提前 EOF、旧作用域或迟到值不发布前缀。同作用域刷新失败保上次完整事实并标未更新；H=0 为空输出。关闭输出、折叠原详情、切换选择、观察 reset 和释放只 abort 所属 GET，零业务取消或重新执行；普通 controller viewGeneration 更新不重新读取。精确停止仍沿已有原 caller journal，冷读不重建 JobHandle。

[Main/IPC](test/native-job-output-reads.test.ts)、[实际 DOM](test/native-job-output-panel.test.tsx)与[公共覆盖校验](../../packages/client/test/execution-output.test.ts)核完整分页、首 H、大页缩小、合法重叠缺口、原身份与迟到读取。[完整 Native 窗口](test/isolated/native-job-output-bundle.test.ts)和[driver](test/native-job-output-electron.fixture.ts)用公开 Runtime 与显式 Full Shell 产生真实持久输出，再由搬迁、删除构建源的默认 Native/Service 冷读；准确资格与原失败见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07正式-native-job-完整已保存输出)。这份历史 cold consumer 证据单独不赋予默认新 Job producer 资格。当前 macOS 默认新建 Job、准确停止及 Main/Service fault 的完整用户路径已由下段验证；其他平台、全局资源与阶段退出依赖仍见 [P5 当前范围](../../docs/plans/unified-agent-refactor-v1.md#30214-native-默认宿主-shell-完整用户路径)。

输出窗口夹具按准确候选的 `app/index.html` 选择主 renderer，不能把先创建的预载对话框当作聊天窗口；冷开和失败采证保持同一页面。2026-11-05，macOS arm64／Bun1.4.2 原完整窗口回归1例／36断言通过，保原420上界、359条输出、四页读取、范围重开、显式刷新和第二次冷开；原 Store 游标与执行集合不变，额外 Provider 调用为0，两个窗口及所属 Service 正常清理。原失败保留，不据本机自动交互扩展为其他平台或新人工体验资格。

[默认 Shell 生命周期窗口](test/isolated/native-shell-lifecycle-bundle.test.ts)与[真实 driver](test/native-shell-lifecycle-electron.fixture.ts)将搬迁 Native/Terminal 真实安装、删除全部原输出后，沿 `<prefix>/bin/kite-desktop` 启动生产默认 Main/Service/网络和宿主 Shell，仅普通配置选择 compatible Model 与 shell.launch；页面实际信任 Workspace、选择 Full 并发送任务，没有 configure/Job/权限/host fixture 注入。三个原 Job 各保 stdout/stderr 198000 字节完整 Unicode；父 Run 完成后准确单项停止保另一项运行，持久 processTreeStopped 与原 PID unique/version、不同 process group、真实 orphan 和所属 coalition 空证明分别核对。Main SIGKILL 沿默认父 EOF 收尾所属 Service；Service SIGKILL 后 guardian 仍清空本次 Job 全树，原持久 running 不被改成已停止。两次冷开保同 Store/Job/输出与游标、GET-only、零 Model/效果重放。真实进程持两层使用锁；Service 崩溃但 Main 仍在时卸载仍 busy，全部退出后两层可独占，成功卸载保 Core/Native DB/config 原 inode 和完整字节。外部 producer 逐批等待只读持久输出回执，测完整用户路径而非突发吞吐；退出瞬间身份不可读保持未确认并有界等实际 ESRCH。准确冻结、原失败与当前完整默认门禁见[安装入口进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08默认-shell-实际安装入口与保数据卸载)。这份 macOS 安装路径证据不外推已发布 predecessor、全部安装故障、全 Runtime 全部后代/资源、8outer/60分钟、独立审查或 Windows/Linux。

[原生观察器](test/native-shell-observation.fixture.ts)在任何候选进程启动前保存既存进程的 kernel unique/version。路径不可读时，仅相同 incarnation 或明确异 UID 可排除；PID 复用、exec 版本改变及身份读取失败仍未确认，已读为所属路径也不能被既存快照排除。libproc 读不到部分僵尸的 UID 时，最多一秒的只读 `ps` 仅补充当前 UID 分类，不提供信号身份或 absence 证明。最终扫描必须同时无所属身份和未确认项，才记 cleanup confirmed；[反例](test/isolated/native-shell-observation.test.ts)覆盖这些范围。信号始终核原 audittoken PID/version；原 coalition、原进程 absence 与 25 秒观察期限保持。

## Native Skills 只读目录

Skills 详情按名称、简介、独立滚动的 Markdown 正文及来源展示，正文不受旧设置说明的小字号和弱化文字色覆盖。内置 `computer-use` 按服务保留的唯一内置ID明确标为“内置技能”，其他未记录来源不猜测。全局目录的能力快照不等于实际Run能力，列表和详情不据此显示“可用／不可用”徽标，也不判定功能“已提供／未提供”；禁用保留“已禁用”，配置或读取异常保留“需处理”和中文原因。详情不展示“所需功能”等工具依赖信息，实际Run依赖门禁保持。底部操作为“关闭”，原右栏容器及分层Escape保持。完整分页、原条目身份与失效恢复仍由内部观察核实。

[正文 reader](electron/skill-catalogue-reads.ts)使用独立read ID与真实attach generation／Store，另经 `settings.skills.document` 和 `.close` 固定原技能、版本和目录revision；迟到、替换及关闭只影响所属读取，不与目录分页共用取消租约。Renderer使用共享闭合正文verifier，明确打开详情才读取，移除frontmatter后交由公共Markdown呈现；不执行示例或提供文件／资源读取权限。已核同一目录revision的正文刷新保留视口和阅读位置，失败正文可沿刷新重读；不同技能与版本重置正文视口。来源变化、换版、目录失格或Store变化不能把旧正文发布到新详情，正文不可读时保留简洁说明。持续取舍见[正文预览决定](../../.agents/notes/implemented/feature/2026-11-04-native-skill-document-preview.md)。

2026-11-04，Windows x64／Bun1.4.3／Chrome156，本轮七个相关文件的可执行范围共35项通过，覆盖人的版本绑定预览与原模型依赖门禁、真实HTTP认证／旧revision／字节上限、闭合Client响应、Main读取替换／迟到／关闭与中文详情。两个原符号链接用例分别在Agent与Service完整文件尝试时被Windows的symlink权限以EPERM拒绝；原断言保留，未计入通过，也不取得相应路径／平台资格。Agent／Client／Service／Desktop类型、生成API一致性、边界及workspace检查通过；新隔离工作树的Web导出资产先沿原build生成。当前目录的实际Native设置页和编译CSS在隔离Chrome逐步核深浅主题×1280／800px四组20个阶段：正文读取中、Markdown完成、切换、键盘滚动、刷新保留位置、关闭焦点、版本失败与刷新恢复均通过，零业务提交及页面异常。截图和数据在本机`.cache/skills-preview-main/`；未重启用户窗口或重验正式安装版，新Main与Service接口需完整重启应用加载。

同日修正全局目录的执行状态误判：上述[页面DOM](test/native-skills-settings.test.tsx)15项通过，覆盖能力快照变化后仍不显示依赖信息、正文保留，以及禁用和真实来源异常提示；Desktop typecheck与本轮Biome检查通过。沿同一隔离Chrome逐步核明暗主题×1280／800px四组20阶段，移除误导徽标、“所需功能”与功能供给判断，加载、切换、滚动、刷新、关闭焦点及失败恢复均通过，零业务提交和页面异常；新截图与数据为`.cache/skills-preview-main/*-content-*.png`及`content-result.json`。本次仅改Renderer展示，Agent／Service／Client及Main门禁未变，复用上段对应证据；未操作用户应用窗口。

正式 Native 全屏设置左侧的 Skills 分类是用户级全局目录，无需创建或选择 Session／Workspace，只展示用户配置及可信用户／Profile 位置的名称、摘要、来源及禁用或异常提示，不合并项目配置。[Main reader](electron/skill-catalogue-reads.ts) 封存实际 attach generation 与 Store，使用 `user_skill_catalogue` capability 和 `listUserSkills`；open 只接收 generation/read ID，open/next/close 不排队在 controller refresh 后。Main 保存原 revision/cursor，每页限 128 KiB，关闭、连接或 Store 身份变化只中止所属读取。切换 Session、观察 epoch 更新和移除 Workspace 不释放用户目录。[IPC](electron/native-ipc.ts) 不接收 renderer 提供的 Session、Workspace、路径或执行 authority。

[完整读取](src/native-skills.ts)复用公共 Client 的闭合用户页 verifier，穷尽同 revision 后才发布，无总目录截断。目录列表与 MCP、提供商复用标题、列表行、状态标签和控件样式；条目详情通过 `panelHost` portal 到应用最右侧的共享 [RightSidebar](../../packages/ui/src/desktop/RightSidebar.tsx)，`editorControl` 接入设置壳的分层 Escape。关闭恢复入口焦点，移除条目后回到刷新；身份或目录资格改变立即隐藏旧详情。[页面](src/native-skills-settings.tsx)区分可用空目录与不可用；用户 JSONC 变坏、来源不可用或刷新失败时，保留同身份上次完整目录与详情并说明尚未确认最新状态，不发布新目录前缀。Store／attach 身份改变会清理旧读取和详情，普通会话切换不重开目录。来源只说明已准入的用户配置位置，缺字段说明未记录；目录页不预读正文；正文只按详情选择读取，项目 Skill 选择、信任和实际执行由 Service 负责。

[Main/IPC 测试](test/native-skills-reads.test.ts)与[实际 DOM](test/native-skills-settings.test.tsx)验证无需会话、用户页完整分页、关闭、迟到响应、坏配置保旧事实和 Store／generation 隔离。[默认 Native 候选](test/isolated/native-skills-bundle.test.ts)与[Electron driver](test/native-skills-electron.fixture.ts)覆盖搬迁、删除构建源后的默认 Service／网络装配：306 项经 16 个真实同 revision 页完整展示，用户文件与配置刷新、项目坏 JSONC 隔离、两个 Session 切换后保持相同用户目录、分类关闭重开、冷启动与普通所属 Service 退出。全局设置读取阶段只发 GET；显式切换会话仍有原会话 reconcile，退出后独立公共冷 Store 无 Run/Execution 增长，Desktop DB7 的 model routes／configuration intents 保持零。关闭设置不停止执行。早期 Workspace 目录的取舍见[目录决定](../../.agents/notes/implemented/architecture/2026-10-07-native-readonly-skill-catalogue.md)，仅其只读、完整分页和独立执行授权理由继续适用于本页；当前原窗口复验、真实失败和完整默认范围归[PC 主线](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)。本机 macOS 目录验证不代替完整 Skills/Workflow 或其他平台资格，仍按 [P5](../../docs/plans/unified-agent-refactor-v1.md#3021-当前-native-skills-消费者迁移)核对。

### Skills.sh 搜索与用户安装

[搜索面板](src/native-skills-settings.tsx)复用设置右栏，用户提交关键词后才搜索，明确点击结果行的安装操作后才下载。关闭面板或搜索被取代时撤销原结果的展示资格。安装完成后重读完整目录，文件安装和目录刷新分别反馈。安装或卸载未完成时切换设置分类再返回，同一 Bridge、attach generation 与 Store 的当前 Skills 页面仍接收完成通知并刷新一次；旧页面释放订阅，不将迟到结果带入新的连接身份，失败不发成功通知。

`desktop:dev` 的界面热更新可能先显示新的 Skills 入口。旧 Main 拒绝搜索或安装请求时，面板提示完全退出并重新启动开发客户端。Main 更新按[开发热更新规则](#开发热更新与服务重载)生效。2026-11-12 在用户正在运行的 Main 产物中核实搜索和安装请求均未登记，以[设置 DOM](test/native-skills-settings.test.tsx)验证旧响应提示。相同的 `claude` 查询在新启动的隔离 macOS candidate 中显示 29 条结果。

[Main 安装器](electron/skill-marketplace.ts)通过[有限 IPC](src/skill-marketplace-contract.ts)接收关键词或公开 GitHub 仓库及 Skill 标识。请求沿现有可信顶层 Renderer 与 attach generation 校验。网络目标固定为 Skills.sh，安装位置由 Main 固定在 `~/.kite-code/skills`，请求不携带本机路径、Workspace、会话或凭据。下载有文件数和字节预算；安装校验跨平台相对路径、写入暂存目录、独占预留目标，最后发布完整 `SKILL.md`。安装只写入普通文件，配套脚本的使用仍由任务权限决定。正常并发及重试保留已有内容；强制退出打断发布时，未完成目录不会作为已安装项展示，保留占位以避免覆盖未知文件。读取、正文和后续任务装配见 [Service owner](../service/README.md#同源-skill-知识目录)。

用户安装项从详情发起卸载，沿[应用统一确认弹窗](../../packages/ui/src/desktop/confirmation.ts)确认。取消与 Esc 返回原卸载按钮，确认后详情显示进度和失败信息。Main 只接受用户安装项 ID 和已读正文版本，从固定根派生目标，核对普通目录及 `SKILL.md` 的身份与摘要后移入系统废纸篓或回收站。内置标识在请求准入和本地文件操作两层拒绝。安装和卸载互斥，文件变化后需刷新再确认；目标已不存在可重新读取目录。成功后重新读取目录并清理对应的搜索安装状态，以便再次安装。目录和详情对空描述统一显示“无描述”，元数据由[知识源](../../packages/agent/src/skills/README.md)解析。

2026-11-12，macOS arm64 隔离打包窗口逐步核对深浅主题下确认弹窗的遮罩、默认焦点、取消和 Esc 归焦、确认后详情的进度，以及卸载完成后的目录和焦点。真实 `legal-writing` 文件的折叠描述显示正文，只有正文的测试 Skill 在列表和详情均显示“无描述”。截图和 trace 在 `.cache/skills-marketplace-verification/dialog-description-hKIv3E/`。桌面及共享确认组件 69 项、Agent 与 Service 技能回归 26 项通过。

2026-11-12，本机 macOS arm64 隔离打包窗口用测试 Skill 核对确认、取消、移入系统废纸篓时的等待、一次注入的废纸篓失败与重试、目录刷新和焦点恢复。重装同一项后再卸载，冷启动仍保留内置技能并排除已卸载项。内置详情没有卸载入口，直接提交其伪造用户标识也被 IPC 拒绝。分阶段截图与 trace 在 `.cache/skills-marketplace-verification/uninstall-RWWmCu/`。Main 安装器、IPC 和设置 DOM 共 38 项通过。

2026-11-12，本机 macOS arm64 上从 `cd872d7b1` 加本次变更构建 Native candidate。以隔离 HOME 从空设置目录真实搜索 Skills.sh，观察 `find-skills` 从等待到安装完成，完整目录随即出现唯一新条目，随后预览正文。冷开保留条目与文件原字节，重复安装显示同名占用。隔离窗口模拟 HTTP 429 后以真实请求重试；延迟 `anthropics/skills` 的 `pdf` 下载，关闭搜索面板后焦点返回入口，待发布完成才出现条目及配套文件。分阶段截图与 Playwright trace 归 `.cache/skills-marketplace-verification/native-final-YNN3I6/`。本轮 [Main 安装器](test/skill-marketplace.test.ts)、[IPC](test/native-skills-reads.test.ts)与[设置 DOM](test/native-skills-settings.test.tsx)共 33 项通过。原生验收覆盖 macOS 本机构建。

## Native 普通问题与页面草稿

普通问卷使用[共享卡片](../../packages/ui/src/questionnaire.tsx)。题头包含题目、可切换的题号和末题待答数，完整选项说明随可用宽度排列。选项和自由输入区域限制高度并独立滚动，翻页和提交位于底部操作栏。会话底部区域根据可用高度收敛，给聊天正文留出阅读空间。默认作答区不显示 `question · pending`、执行 ID 或原请求 JSON，失败和未知答复仍保留中文状态及原命令查询。普通页不在输入框上方重复显示 `轮次：failed`；历史上下文来源错误显示可读原因，原代码保留在失败记录中。

根 `desktop` 选择的 [Native renderer](src/native.tsx)消费共享 Questionnaire。普通问题等待期间保留同一会话的主输入表单和草稿。问卷通过原 `interaction.answer` 提交，取消回答提交原 schema 的 null，同一 Run 收到取消信息后继续。等待 `ask_user` 答案时，[主输入准入](src/native-input.ts)阻止发送，Composer 的同一个按钮在原任务可停止时提供 `command.cancel`。待决页暂时省略该卡，且原 Run 和 `ask_user` 执行仍在等候时，继续保留门禁。确认问卷结束后，主输入恢复现有发送准入，草稿等待用户手动发送。计划答复和 MCP 来源／凭据使用原交互呈现。跨会话未发送文本按原 Store／Session 页面缓存保留，已有私有草稿沿原读取链恢复。普通界面不提供显式保存按钮。未知／失败回答保留原意图，只查询原 Command，不再次 POST。

renderer 的页面 Map 分别保存步骤与 JSON fallback 草稿，身份固定 Store/source/presentation Session/id/revision/inputDigest。切换会话、新建会话及待决后页替换不会搬移或清理原草稿；读取失败和卡片未出现在 bounded pending 页也不证明终态。Main 已核准确 accepted answer_saved 回执时只清原键，观察到同原卡的新 revision/inputDigest 或非 pending 状态时才清理对应旧键。关闭页面进程不保证未提交问卷草稿恢复，持久原 Answer journal 仍负责未知回执。

隔离测试中的“保留草稿”只保存原Main私有主输入，不要求业务History已经完整读取，不向 dev／prod 显示。已受理的原保存版本被消费后，下一次显式保存先读取并核对同一草稿身份、范围、空正文、准确后继修订及Main已提交的原Command／修订消费凭据，再同步 CAS；不凭受理回执或空正文猜测修订，其他写入者保存非空或空正文均保留原冲突。凭据缺失或被有界缓存淘汰时保守保留冲突，普通重新进入会话可读取实际修订。读取不替换后续输入，切换视图或退出后的迟到成功／失败不继续保存或污染新视图；当前读取失败和实际保存失败仍显示。[发送与保存回归](test/isolated/native-new-conversation-dom.test.tsx)覆盖立即／未知后确认、后续编辑、独立清空、保存竞争与迟到范围；[真实私有库回归](test/isolated/native-prompt-draft-store.test.ts)另核提交失败不发布消费凭据、冷读、保存失效和缓存上限。原保存调用显式不依赖History，原pending防重、generation／Session／revision CAS及迟到scope更新guard保持；发送／回答等原业务操作的门禁不变。[原完整读归属DOM](test/isolated/native-read-ownership-dom.test.tsx)核普通界面无按钮、无保存请求，显式测试模式仍在History GET held时保存准确原文，迟到A回执不改B草稿／修订且零业务提交。此前原macOS问答整窗口的全部流程／断言／10秒读取／45秒driver／120秒整例证据及原完整默认真实失败归[当时进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13统一回归发现的-native-私有草稿保存)。

[页面 DOM](test/native-questionnaire-dom.test.tsx)核主输入节点和选区连续、两类草稿独立、会话隔离、遗漏页／读取失败、未知一次答复和准确回执只清原问卷草稿。[实际完整 Native 候选](test/isolated/native-questionnaire-bundle.test.ts)与 [Electron driver](test/native-questionnaire-electron.fixture.ts)核搬迁、删除构建源后的默认 Service／compatible Provider 窗口流程，末页主动提交前零 HTTP Answer、原 ID／文案和自由原文、问卷取消后原 Run 继续，以及所属 Service 真正退出后的冷 Store。该 fixture 仅暂存各原 Run 的首个 Provider 响应，沿既有“保留草稿”准备并读取准确主草稿后释放。此前 macOS 实测覆盖主输入暂时收起后的草稿恢复。当前 driver 改为核问卷与主输入并存。首次发送等待实际 Renderer 权限与历史就绪，并核一次真实 form submit；[原 Native bundle driver](test/native-bundle-electron.fixture.ts)复用这项界面观察，原制品、独立审批与退出断言保持。历史运行结果与限制归 [进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

2026-11-11，问卷样式首次验证在 Windows x64、Bun 1.4.4、Chrome 157，以 `c9d058572` 加本轮工作树运行隔离 Native 渲染器与生产编译样式。深浅主题各核 1200×850 和 470×560，逐步观察选择、题号跳转、键盘焦点、长内容滚动、草稿跨会话返回、提交失败后手动重试、未知回执只查原答复、确认和界面重挂。98 条画面状态记录核对待答时的单张卡片和当时主输入收起／草稿恢复。卡片展开、换题及收起时，上翻阅读的会话维持原位置，跟随最新的会话保持底部。过程与截图保存在本机 `.cache/questionnaire-ui-20261111/`。相关 UI 和 Native 回归共 9 项通过，两 workspace 类型检查通过。浏览器使用隔离测试桥，未复验安装版 Electron 或真实模型。

同日首次验证问卷和主输入并存时，Windows x64 的隔离 Native 渲染器以 Chrome 157 和生产编译样式复验深浅主题各 1200×850、470×560。逐步核对问卷出现时保留主输入节点、焦点及选区，切会话后恢复两类草稿，回执未知只查询原答复，结束后继续编辑主输入。发送和停止复用同一按钮节点，提交停止后显示“正在停止”。当时的明确发送使用原 Run 的后续队列，明确停止使用原活动 Command，问卷保留独立提交入口。长草稿和原 JSON 表单通过问卷区域滚动继续操作。截图和过程记录保存在本机 `.cache/questionnaire-with-prompt-20261111/`。定向回归 22 项和两 workspace 类型检查通过。浏览器使用隔离测试桥，未复验安装版 Electron 或真实模型。

同日增加 `ask_user` 待答发送门禁和末项“自定义输入”后，Windows x64 的隔离 Native 渲染器在 Chrome 157 复验深浅主题各 1200×850、470×560。输入和切换会话保留原草稿，待答、答复提交中及未知回执期间，Enter 和主表单提交均为零主输入请求。原答复结束后，同一按钮恢复发送，原草稿经明确操作才进入原 Run 的队列。待答期间用该按钮停止任务，核对原活动 Command、零问卷提交和草稿保留。浏览器另核最后一项、鼠标聚焦及原多行自定义值，过程记录在本机 `.cache/questionnaire-waiting-input-20261111/`。8 项定向回归和两 workspace 类型检查通过，本轮使用隔离测试桥，未复验安装版 Electron 或真实模型。

同日调整问卷高度后，Windows x64 的隔离 Native 渲染器在 Chrome 157 复验深浅主题。同一份问卷的首题在 1200×850 窗口中从 343 px 降至 196 px，在 470×560 窗口中从 309 px 降至 203 px，聊天正文分别多出 149 px 和 109 px。窄窗末题的自定义输入、待答数和底部操作同屏可见。另核对长选项滚动、长主草稿下通过滚轮到达问卷操作、翻题焦点、原阅读位置及答复失败和未知回执的恢复。过程和截图在本机 `.cache/questionnaire-compact-20261111/`。5 项定向回归及 UI、Desktop 两个 workspace 类型检查通过。此次使用隔离测试桥，未复验安装版 Electron 或真实模型。

## Native 计划入口与完整审核

2026-11-08，参数改造后的隔离诊断候选再次构建并搬迁，固定Provider／真实Service、IPC和SQLite的完整Electron文件1项／313断言通过。使用新plan_ref/progress_ref，核完整大计划阅读、修订、批准、拒绝后零后继Model、等待中停止、原草稿恢复、零重复回答及冷Store证明；工作区Files没有额外权限卡。69帧过程画面及阶段／滚动记录保存在本机dist/acceptance/tool-parameters-native-plan-review/，已观察审批卡切换和终态。此项使用明确测试制品；真实Luna与三模式工具证据归模型测试owner，不作为全部普通客户端外观或其他平台资格。

2026-11-07，macOS arm64／Bun1.4.4，最终源码3402文件／`2273a30b…a9ed` 的普通 `testDiagnostics:false` 制品，用现有 Codex 登录的 `gpt-6-luna/medium` 实际完成三模式计划人答。原 Full 计划在待答时经普通权限控件切 Manual 再确认 Full，同卡／request／revision 保持，空 Enter 零回答、批准前零效果；批准后 Full 零权限卡，Auto 一次独立 low reviewer，Manual 原 Tool/Job 各一次。Auto 丢原202时实际显示 unknown、禁重复提交，随后准确原 Command GET 200恢复，原 POST 仍一次；5个原 journal 均 accepted。冷重开逐模式观察历史，43个 Execution／3 Run／5 Interaction／25 Command 全行摘要及3个唯一效果完全相同，冷 POST 为零。原生全树停止、注册移除及 broker 回收证明完整，Main60766正常 exit0，所属 Profile/制品进程无残留。55个原 PNG/DOM/SQL阶段与 `actual-report.json` 在本机 `/private/tmp/kite-luna-plan-business-observe-983cd353-21f4-4d3a-ad4a-87199f0264d3/evidence/native/`。Auto 一次错误计划 ID 被拒后模型读取原计划更正，原失败保留，不称所有模型参数均正确；这不提升其他平台或安装发行资格。

显式自动测试模式的主输入以“先审核计划”明确选择本次任务，选择本身零业务 POST；普通启动及 `desktop:dev` 不提供此辅助选择。idle 保存原 `run.start`，活动任务保存准确 `afterRunId/contextSelectionId` 的 `input.follow_up`；两者只带闭合 `builtin.planning@1 {mode:'plan'}`，不改变当前原 Run。选择按原 Store/Workspace/Session 隔离，已知正回执后复位，失败或未知保留。默认 Service 负责装配原 Run 计划义务与必要条件，调用者不自报只读定义或批准权。

共享 Plan 面板显示准确当前版本的完整正文、步骤和原材料，提供批准此计划、补充修改与拒绝，不提供执行权限模式选择。三种权限模式均等待用户明确业务答复；批准保留当前权限模式，不授权后续其他 Tools。普通客户端可显示工具主动请求的计划确认，不增加文字 slash 解析或普通“先审核计划”开关。修改要求作为原反馈由真实 `planning.review` ToolResult 交给下一 Model，新版继续独立审核。拒绝时，默认 Planning 工具返回简短用户拒绝说明并直接结束当前轮次，不再请求模型续答或重复批准；原 Tool 和回答记录保留，新消息仍可继续。“停止任务”固定当前已核实活动 Run 的原 Command，复用主输入停止的权限、历史与 caller 校准门禁；取消中和结果未知时不能换新命令补发。普通工具 pending approval 保留主输入与权限选择；根会话 question、plan_review 隐藏主输入但保留原权限工具栏、Full 确认和准确原任务停止入口，业务卡结束后恢复原主草稿。特殊来源授权继续遵循原输入独占边界。权限切换不回答或替换业务卡；未知权限提交、读取失效与会话切换仍受原门禁和 Full 确认作用域约束。取消原 Run 不撤销已有事实，已派发 review 的未知结果及退出提示继续保留。

页面 Plan Map 保存 Store/source/presentation Session/id/revision/inputDigest 的反馈，与 Question、主草稿各自独立。准确 Main accepted answer_saved、实际同原卡替换或非 pending、以及精确原 Run 已观察 cancelled 才清对应原键；遗漏 bounded pending 页、读取失败、Promise resolve 不清草稿。完整页面刷新或退出不保证未提交 Plan 草稿恢复。

[普通业务卡 DOM](test/isolated/native-business-permission-dom.test.tsx)以 `testDiagnostics:false` 核对待计划卡的六向权限切换、原卡 ID/revision 不变、零答案提交、权限读取失效时拒绝迟到 Full 确认，以及 Question 卡停止可达；[Full 作用域回归](test/isolated/native-full-permission-context-dom.test.tsx)核对隐藏正文时会话替换仍撤销旧确认。相关五个完整文件在本机 macOS／Bun1.4.4 为16项／187断言通过，Desktop/UI 类型通过；这不代替最终普通窗口真实模型验收。以下早期实际候选记录保留其当时模式与审批合同，不作为新纯业务答案的最终冻结资格。

[Main 原附件 reader](electron/interaction-attachment-reads.ts)只打开当前视图实际 offered card 的公开原身份，复用 controller 与 SDK 的完整 Artifact/hash/UTF-8 证明。renderer 经 [64KiB reader](src/native-interaction-attachment.ts)核 scope、原 size、完整 EOF、SHA 和 fatal UTF-8；Main 在原视图完整传输至 EOF 前另拒绝回答。close 只释放读取，当前完整证明保留；选择或网络释放清证明，迟到正文不改绑。Native `viewSelection` 区分同 Session 重选，`historyEpoch` 隔离观察流 reset，renderer 同时撤销旧正文资格。普通同作用域刷新中止旧在途读取，保留已经完成且仍实际 offered 的准确 key；失败期间拒绝操作，恢复后重新核原卡，不清反馈草稿。无任意 Artifact、路径或 Runtime 端口。

[页面 DOM](test/isolated/native-plan-review-dom.test.tsx)、[读取边界](test/native-interaction-attachment.test.ts)与 [显式输入](test/native-input.test.ts)核草稿、主输入独占、原取消清理、未读取/部分读取不得回答和闭合 Plan 意图。[实际候选](test/isolated/native-plan-review-bundle.test.ts)与 [Electron driver](test/native-plan-review-electron.fixture.ts)已在本机 macOS 核搬迁并删除构建源的默认 Service/compatible Provider、真实两种执行方式、原反馈 v2、独立管理/File 许可、拒绝/取消、正常所属 PID 退出与冷 Store。普通 Plan Model 保 Planning 目录；Auto 专用 reviewer 按实际 `authorization_review` 用途及原 Store/Run/Files Execution 核空工具目录，不借计划批准跳过独立人工审批。Driver 在独立 Files 回答后等同一原审批 submission 已 accepted 且原卡不再 pending，再进入严格 Planning 管理 helper；仅回执接纳不足以证明 Main 视图交接完成。计划卡的正向读取还须核同一原 Store、Main 当前视图已结束刷新且权限观察可用；给定原 Run 时卡必须仍属于该 Run，不把旧只读卡当作读取就绪，也不重试已经进入的附件读取。原身份、全部断言和等待预算保持，实际结果与原失败保留见 [进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11默认-task-完整回归的父子时序)。退出 unknown 提示的明确选择由严格一次性的测试 dialog 端口返回，不代表 macOS 原生 modal 点击资格，生产 guard 不被替换。该窗口不推导全部视觉、设置、平台或 P5 退出。

计划窗口driver切换会话后还须等准确Store/Session权限范围、信任及渲染revision就绪，再选择模式。已是Auto时核模式、revision与原申请列表不变，不声称新保存；需要变更和首次显式选择仍通过原radio/保存按钮，核唯一原申请及applied回执，unknown不重投。2026-10-20默认第15轮的disabled按钮原失败保留；修正测试前提后的完整Electron文件1pass/316断言，不改变生产disabled规则、等待预算或上述计划/Files断言。

公共入口同时导出 [DesktopInput](src/input.README.md)：调用者在发起意图时固定准确 Session/Store/Run/context/command，start、steer、follow-up 和精确取消不随选择视图漂移；未知回执只查原命令。读取经共享 SDK 核实 public input 对应的实际 business command 和 Run；尚未解释的 steer 不因原目标 Run 结束而冒称完成，澄清或只读观察的 Model 也不投影为业务 Run。所属 observer 的释放只停止查询与 callback，已有执行继续。[意图单元测试](test/input.test.ts)与[实际配对子 Service](../../tests/isolated/unified-agent/desktop-input.test.ts)分别核实这些边界及原身份保真；本轮实际执行证据归[测试入口](../../tests/README.md#子-agent-协作-v11-验证)。

可移植公共入口只依赖 Client、UI 与 React；新增显式原生入口在 main 侧使用 Agent profile 与 Service paired。根 `desktop` 已选择新完整 Native 候选，旧 kite-desktop 不参与正式/default/CI 调度。完整视觉保真、跨平台与发布资格仍按实际证据核对。

[controller](src/controller.ts) 接受主进程适配器提供的 admittedClient，选定 Session 后读取真实 snapshot 与通用 Query 视图。每次选择创建 viewGeneration；迟到旧响应可进入按数量及字节约束的对象缓存，不能覆盖新选择，旧请求错误也不能停止 Service。单条 SSE 与页面选择独立；切换视图不取消执行。

通用动作来自当前视图的原 public envelope。调用者可用 UI schema 表单明确修改输入；controller 固定该次 intent 的 Session/Store/definition/commandId，通过 Client 和 Service 校验，不随视图切换重绑定。`lastActionIntent` 保留最近一次明确动作的原 Session/Store/command 身份；回执未知时可查询原 command，不自动重发。`DesktopPublicViews` 只消费公开视图与宿主回调，没有扩展业务类别特例。

`disposeNetwork()` 中断客户端网络并使旧 generation 失效，保留已确认 snapshot；不调用配套服务停止。`stopPairedService()` 是显式 main 生命周期操作，通过独立注入回调实现，不在组件卸载或旧请求失败时触发。

验证：`bun run --cwd apps/desktop typecheck`、`build`、`test` 与根 [thin-clients](../../tests/isolated/unified-agent/thin-clients.test.ts) 真 HTTP/SSE 测试。P5 的完整 Electron sender/preload 隔离、真实窗口、平台权限和旧 UI 迁移继续由该阶段负责。

P3 `DesktopSnapshot.interactions` 读取根 Session 的实际 pending 页（最多 20，`interactionsAfterId` 显式保留后页指针）。`answerInteraction` 在点击时封存 Interaction 原 Store、presentationSessionId、ID、revision、answer 与新 commandId；重复调用共享同一在途 Promise，视图切换不能改绑。一次回答最多发送一次，错误保留原 pending 请求与已保存意图，未知回执用 `lookupInteractionAnswer` 查询原 command，不自动重放。当前 controller 最多保留 128 个回答 intent，超过范围明确拒绝，而不丢弃未决身份。

`interactionSubmissions` 与 `DesktopAnswerSubmissions` 可在选择区外保留回答面板；宿主应在视图切换时仍渲染该面板。接受命令与 `acceptedDecisionRevision`/实际执行结果分别显示。`DesktopInteractions` 的 callback 缺席时只读，不向 UI 传 token、Owner 或 server 类型。真实 SQLite/HTTP 测试位于 [CLI Interaction integration](../cli/test/interactions.test.ts)，覆盖 opt-in 批准与 question、非交互等待、重复提交和切换视图；controller 测试另覆盖丢失回答回执只查原 command。上述便携 HTTP 证据不单独建立 Native 窗口或完整 P5 资格；本页问卷与计划专题分别记录已交付的实际 Native 消费范围。

便携 Context controller 在 capability 可用时读取第一页 `snapshot.context`，`loadContextPage()` 固定原 selection、highWaterSeq 并独立推进消息与来源两个 cursor；一个流结束后不会从头重复，消息结束固定 afterSeq=highWaterSeq。`rewindContext(boundary)` 只接受本代次已读取有界页中的实际 complete 消息的精确 ID/seq 或 null，Service 最终核对完整 Tool 配对。`includeHistoricalResult(execution, scope?)` 绑定当前实际历史 Job 的原 ID/resultRevision；活动 include 必须提供点击时封存的 Store/Session/selection/targetRunId envelope，缺准确原 Run、出处或 revision 时本地拒绝；这两项保存原 Session/Store/selection/commandId，不自动创建 Run。Rewind 的活动或 outcome_unknown 执行仍在本地明确 input_busy；include 在准确活动 Run 上只排队，原 accepted/result_queued 显示 queued，checkpoint 后原 Command applied 才显示已纳入。最终 Store 仍核原目标，视图切换和未知恢复不改绑。

同一 intent 的重复提交共享在途 Promise，最多保留 128 个原 intent；失败和未知不重发，`lookupContextIntent(commandId)` 只读核对原命令。`contextSubmissions` 可独立于选中视图保留；`DesktopContext` 将这些状态和原出处展示，未知提交保持写入操作禁用。回执已 applied 只证明 selection/source 事务落定。正式 Electron/DOM/P5 资格不在此切片范围。

控制器最多保存当前选择 4096 个已读 complete 消息边界身份；超过时局部拒绝 context_boundary_limit，不把截断页声称为全部历史。


plan_review 复用原 Interaction 的封存回答意图；controller 在保存前验证实际已显示请求 metadata、请求明确提供的模式与反馈长度。不会从调用者替换的描述、自报 Full 或未知字段推导授权。纯校验失败不创建 intent、不发写入请求。答复 accepted 只是原回答命令已保存，Core 决定接纳与后续 Tool 权限另核对；迟到且已保存取消标记的历史答复不能复活原 work。实际 HTTP 测试保留同一已派发 Tool 的 execution/attempt 与原独立审批，重复回答只提交一次。


大人工审批附件由 `DesktopInteractions.onReadAttachment` 接宿主 reader；`controller.readInteractionAttachment(intent,{signal})` 固定原 Store、来源 Session、scope、Interaction/revision 并读取完整核实正文。回答前必须有同一当前卡身份的读取证明；验证集合只保存当前卡身份，不保存正文。视图切换/网络释放中止读取并清除证明，迟到加载不能应用到新视图。保存回答仍走原封存 intent/commandId，未知回执只查原 Command。

[test/large-attachments.test.ts](test/large-attachments.test.ts) 用实际大 Auto 附件、SQLite/loopback HTTP 验证迟到加载跨 Session 切换不能批准、重新完整读取后原回答只派发一次。共享 UI 另有实际 DOM/键盘测试；本便携控制器不建立正式 Electron sender/preload、窗口或 P5 资格。

便携权限入口由 `DesktopPermissions` 与 controller 提供。capability `permission_controls` 缺失时局部只读；子会话只显示根权限。新模式仅提供请求批准（`accept_edits`）、自动审核（`auto`）、完全访问（`full`）及 `makeDefault` 的明确用户选择；类型、HTTP/IPC 和持久控制仅接受这三种策略，旧 `ask` 明确拒绝，不作兼容映射；信任确认展示实际读取范围、工作区与范围摘要；信任不批准任意操作。读取结果固定观察身份，保存时封存原 Store、Session/root、Workspace、CAS 版本与摘要。同观察只允许一个选择；同在途选择返回同一 Promise，切换后的旧 callback 不会改绑。最多保留 128 个 intent，冲突保留原选择，显式重新读取后才可再次选择；未知结果只用 `lookupPermissionMutation` 查原 command，不重发。网络释放仅停止客户端网络，不停止 Service 或 Run。

Desktop／Native 的控制事件匹配同时使用真实 Store、所选 View 的 rootSessionId／workspaceId 和 applied receipt。根模式变更刷新当前 child 的继承事实，明确 makeDefault 更新其他根的默认显示；foreign root／Workspace 不触发无关读取。首次 child View 已返回但 mode/trust 尚未完成时，也保留同 generation 的已核 scope 识别根事件并安排重读，切会话即撤销该 scope。[权限观察回归](test/native-permissions.test.ts)通过两种 caller 的真实观察回调核这些事件、首次读取竞态及旧 child 回包晚于切换的隔离；不将其计作 Electron 原生窗口或其他平台资格。

### 2026-10-22 紧凑审批与队列窗口验证

`540e5db008` 加本轮未提交差量，macOS／Bun1.4.2／Electron44.3.0，执行 `bun test ./apps/desktop/test/isolated/native-live-permissions-bundle.test.ts`：最终新构建1项／20条 Bun 断言及 driver 原断言通过，34.85秒。源码外搬迁候选固定 `testDiagnostics:false`，使用隔离 HOME／Profile／Workspace 与受控 loopback 模型；12次模型请求含2次 Auto 审核，原权限场景0人工答案。主及已运行 child 保原 Run／准确目标，已派发 Shell 不被收回，待批及下一原工具按最新根 revision7 复核后各执行一次；普通待批可直接切 Auto，独立 HTTP 同步本次约72ms，仅为单次观察。

同一候选核单卡分页、主名称隐藏、稳定子图标、卡片不高于112px、普通审批与输入共存、Shell 单行省略与原生 hover 全文。独立队列阶段仅对原 Shell 工具批准一次，之后按 Full 复核后续 Job；3条真实 pending Markdown 经拖拽实际改变服务顺序，删除和编辑精确撤回原 ID，完整原文回填且没有取消／恢复或自动提交，手动提交生成新 ID 并逐字核原 Markdown。队列编辑期间原 Shell id／attempt／cancel 事实不变。同 scope 观察刷新后原 preview DOM 的 pointermove 监听仍在，鼠标 hover 展示完整 Markdown；不以 focus 替代 hover 通过。

Electron exit0、所属 Service／后代消失、冷只读事实与两层独占制品 lease 重新取得均通过，成功收尾未发信号。本机证据目录 `dist/acceptance/live-permissions-electron-0a02f1de-a2d6-443a-bc98-faaed9760738` 保留 report、provider、日志和截图；早期依赖／夹具失败与修复前队列 DOM 重挂失败保留在各自证据目录，不以最终通过抹去。该受控本机结果不取得付费 Provider、其他平台或签名安装资格。

另执行受单卡分页影响的[既有双 child 整窗口](test/isolated/native-collaboration-bundle.test.ts)：同一本机新构建并核 digest 的候选复用后1项／12条 Bun 断言通过，17.18秒。保留双 child 的独立批准／准确停止、同子 Session 新 Run、旧答案与旧 carrier 停止拒绝、停止后迟到答复拒绝，冷启动仍15次模型调用且零重放，清理 observed／forced／remaining 均为空。driver 只增加精确审批翻页及停止前按实际展开状态重开既有“会话工具”；候选复用仅属隔离测试 runner，不向普通客户端开放。

### 2026-10-21 运行中权限窗口基线

以下是本轮审批浮卡／保留输入区／真实队列实施前的历史窗口证据；当时的隐藏输入和审批列表布局已由上面的当前实现替代，不能作为新界面验收。

[真实运行中权限窗口](test/isolated/native-live-permissions-bundle.test.ts)与[Electron driver](test/native-live-permissions-electron.fixture.ts)构建 `testDiagnostics:false` 的源码外搬迁候选，使用自有 HOME／Profile／Workspace、受控 loopback 模型、正式 Shell 与显式配置启用的外部文件工具。主、child 的两个真实 Shell Job 保持运行时，普通 UI 切请求批准，再由独立公共 HTTP caller 切 Auto，窗口无需刷新或重选即同步标签；切回请求批准后，两个原 Run 的下一外部写入均保持未派发且文件不存在。当时根待批隐藏 Composer，主／child 两项只显示一个审批面板；独立 HTTP 改 Auto 后两目标分别真实审核、旧卡 cancelled 且无答案，改 Full 后原目标各派发一次，dispatch read-set 使用最新根 revision，输入恢复即显示 Full。子详情经生产导航展示准确待批与终态，实际 selection 仍为根，不以此冒称选中 child 的 IPC 路径也已验。

2026-10-21 macOS 26.7.1／Bun 1.4.2／Electron 44.3.0，`2a5cd0cca` 加本任务工作区改动：上述整窗口最终1项／17条 Bun 断言及独立 Node／DOM 断言通过，25.14秒，实际10次模型请求中含2次 Auto 审核。两项原 Tool 的同 Session／Run／attempt1、最终根 revision7、准确外部文件各一次与零人工答案共同核实；独立 Auto 回执确认到可见且 busy 撤销本次约64ms，只作为单次观察。原 Electron exit0、所属 Service／后代消失、冷只读事实与两层制品独占租约重新取得均通过，成功路径清理未发信号。合并面板及原审批／输入／环境信息四个 DOM 文件10项／111断言、根八 workspace typecheck、定向 Biome 与文档检查通过。首轮子详情错误等待环境卡文案的失败保留，driver 改等实际详情“等待人工审批”；没有改变产品文案、审批期限或隐藏输入行为。此证据使用受控模型端点，不代表付费远端、签名安装或其他平台资格。

[test/permissions.test.ts](test/permissions.test.ts) 使用真实默认宿主、SQLite 与 loopback HTTP，验证三种正式 API 模式/default及旧 raw ask 明确拒绝、信任/撤销、竞争 CAS、未知回执及跨会话重复抑制，业务执行数量保持零。另有局部 capability/child 投影测试；共享 UI 的 [实际 DOM 测试](../../packages/ui/test/isolated/permissions-dom.test.tsx) 覆盖键盘与迟到卡片切换。这些证据属于便携调用者，不代表正式 Electron 或 TUI 制品已完成。

新的显式原生入口位于 [electron/main.ts](electron/main.ts)、[preload.ts](electron/preload.ts) 与 [native renderer](src/native.tsx)。这是现有 portable controller 的实际 Electron 宿主；根 `desktop` 已选择此新 Native 入口；旧源码仍保留，完整 UI 能力及发布资格尚未退出，无旧协议 fallback。main 独占公共 NativeClient、配对 Service、预选 profile、观察流和意图；renderer 只有封闭的 `kiteNative.request/watch`，不接收 token、profilePath、Runtime 或任意 HTTP/IPC 通道。窗口 sender 必须是原 webContents/mainFrame 与实际制品文档，子窗口与旧 frame 不能提交。单 IPC 请求最多 1MiB、响应最多 4MiB，消息页最多 200，renderer 当前消息视图最多 4096 条/8MiB；超界只拒绝该次读写，不关闭服务。

非development的renderer构建显式固定 `esbuild.jsxDev=false` 与 `process.env.NODE_ENV=production`，不继承Bun test等调用进程的测试／开发模式。Vite开发服务器保持原开发管线；显式隔离制品的 `testDiagnostics` 常量独立控制诊断入口，不因生产React模式失效，也不由NODE_ENV开放普通客户端。原[child-stream窗口测试](test/isolated/native-child-stream-electron.test.ts)另核真实renderer字节不含React的 `runWithFiberInDEV` 或开发act提示，然后执行原窗口及资源门禁。取舍见[构建模式修正](../../.agents/notes/implemented/bug-fix/2026-10-21-native-renderer-production-build.md)。

[build-native.ts](scripts/build-native.ts) 的开发入口仍为 `bun run --cwd apps/desktop build:native --assets /absolute/trusted-assets.json --outdir /absolute/distribution`。`buildNativeDesktop` 把显式 Service JS、Bun executable、实际 SHA/build/API/capabilities 和可选 disposable profile 标为 development；这条兼容 API 不代表完整发行闭包。main/preload 是 Node CJS，renderer 是浏览器 ESM；实际 HTML/preload 从 `app.getAppPath()` 读取，不能使用构建器固化的源码 `__dirname`。

完整候选使用同文件的 `buildNativeCandidate({terminalRoot,electronDist,outdir})`，输入是已核实的新 terminal bundle 与实际安装 Electron dist，输出目录必须全新且不在输入源内。`terminal/` 原完整 Service/Bun/npm/Worker/监督/baseline/Web closure 独立验证；`app/` 固定 main/preload/renderer/html/package 与两个可信 helper，`electron/` 保存实际 executable、Frameworks 和 resources。公共 [Native verifier](../service/src/native-runtime-assets.ts) 固定 platform/arch/Electron version、inner manifest SHA、完整 file size/SHA/mode 与有限内部 Electron links。原 Electron 空 locale 目录通过必带 `directories` 精确声明，缺失、移位、新内容和未声明空目录都拒绝；builder 不删除原安装内容。`.use-terminal.lock` 在发布前建为空 0600、nlink1，单独列入闭合 inventory，不忽略任意 dotfiles。manifest 与 SHA 是未签名完整性证明，不证明发布者身份。

candidate Main 只接受固定 `{kind:'candidate'}`，从实际 appPath 推导原 root 一次，核实际 executable 就是内嵌 Electron 且运行版本相等，不退回开发绝对路径或 PATH。Electron 会把 `.asar` 展开为虚拟目录，因此只在同步完整物理验证期间暂设 `process.noAsar`，finally 恢复原值；不把 archive 内虚拟目录当发行资产。无显式开发 Profile 时，source 与 installed Main 都选择 `~/.kite-code/unified-agent` 的 `default`，与新 terminal 一致，不发现、转换或接入旧 Electron userData/旧配置/数据库。

[POSIX Node artifact lease](electron/artifact-access.ts)通过原 FD 与 [one-shot Bun helper](electron/artifact-access-helper.ts)消费公共 inherited-artifact 端口。Main 保留 outer 与 inner 的两份 shared lease；helper 只关闭自身继承副本，不 LOCK_UN，不授 Profile 或执行权。准确 `native.candidate` proof 通过现有 paired stdin 交 Service，Service 自持全部 roots 的 lease 并将完整 roots 交默认保护。退出先关闭 caller、私有数据库/Profile lease、所属 child，最后才释放 Main artifact FD；Main 强杀后 child 仍持两 root，child 已终止才可独占。安装/归档/升级工具负责先取得全部 exclusive lease，再操作不可变候选；这些工具的资格由其 owner 单独记录。

Windows 的[Node-API 后端](native/windows-access/README.md)由 Main 和 Service 各自取得 LockFileEx SH，不借继承 HANDLE 授权。私有 UI prepare 保原 Profile/UI 目录与主 DB HANDLE、volume/FileID，SQLite关闭后再释放，sidecar不永久钉名称。正式 candidate Main 已接 installed C→compiled verifier→Electron 原创建链：父 verifier 完整 pin 先于 addon/Main/preload 加载，Main 核两跳 kernel PID/原 FILETIME 证书后取得自己的 full outer/inner pins及双 SH，再准入窗口／Profile／SQLite／Service。没有交接仍 `native_windows_bootstrap_unqualified`，伪造匹配 marker 或 PPID 不授权。完整构建、选择、登记和维护入口源码范围归 [Native release](docs/native-release.md#windows-managed-native-当前实现)；原强制负例、Windows MSVC／DACL／pipe／Electron ABI及完整用户链仍须原生验收，类型和POSIX邻接不放行平台资格。

正式 installed Native 已补齐本机两个真实代码候选的 A→B→A→B 冷启动验收，区别于同源码版本标记测试。默认窗口保原任务、完整正文与持久 caller 记录，回退后继续工作实际使用 B 全文；四次所属 Service 普通退出、两层租约释放及指针切换/卸载的数据保留均核实。完整负责范围、真实旧 builder、失败与平台限制见[Native 发行 owner](docs/native-release.md#真实代码升级与冷回退)。窗口读取兼容前驱的 `assistant 消息` 与迁入原 Conversation 后的 `助手消息` 名称，仍核相同原消息数量、完整正文及零重发；当前实际范围归[PC 主线](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09pc-迁移完整默认回归)，不据此宣称已发布旧样本或三平台完成。

[实际内嵌 Electron 候选](test/isolated/native-bundle.test.ts)使用真正 terminal builder 和本机安装 Electron dist，搬迁后删除原构建输出、独立 HOME/PATH、无 Service 源码或 npm 回退；原默认 Profile 的 Files.write 经实际 approve_once 一次完成，Provider 为 2。正常退出所属 child PID 消失，两 root 可独占；冷重开只读不增 Provider。第二窗口用精确所属 child SIGSTOP 固定有限观测，再 SIGKILL Main，实际 Service 仍持 outer/inner 两锁，SIGKILL child 后才释放；这不是生产暂停、自动恢复或所有进程树场景的证明。[公共 Node verifier](../service/test/isolated/native-runtime-assets.test.ts)另核原 SHA、完整内层、空锁、闭合 schema、模式/字节/硬链接/逃逸链接与空目录负例。最终候选及原 Files/Session Electron 邻接为 4 文件、6 项、55 条 Bun 断言全通过（68.65 秒，2026-10-04），包含真实 driver 独立断言；Desktop/Service types 与 Service build 通过。

首实际构建因原 Electron 空 locale 未声明而拒绝；第二轮定位 Electron ASAR 虚拟目录差异，第三/四轮有限 driver 的失败清理等待退出确认，第五轮卡已经可见但 main 新投影暂空。保留所有失败日志；最终 observer 在原 10 秒内等待准确 pending card，失败清理只限所属进程，没有放宽权限、执行 deadline 或伪造成功。这些资格只覆盖 macOS arm64、Electron 44.3.0、Bun 1.4.2 的隔离候选；旧正式 launcher 切换、安装器、签名/公证、Linux/Windows 及完整 §35 由各 owner 单独闭合。

main 的私有草稿由 [private-data.ts](electron/private-data.ts) 使用实际 Node `node:sqlite` 保存，固定在启动前预选 profile 的 `desktop-private/data.sqlite`，renderer 不能提供文件路径。目录要求所属用户与 0700、文件 0600，拒绝符号链接和文件硬链接；格式与 application ID 未知、损坏或打开失败时只报局部 `draft_storage_unavailable`，保留原字节，不以空库覆盖。正文 JSON 编码保留 NUL 和原 UTF-16 文本。显式保存按原 Store/Workspace/根 Session 与修订进行 `BEGIN IMMEDIATE` CAS，SQLite 私有事务锁等待有界，FULL 同步与原子提交由 Node SQLite 完成，不依赖 Bun main 或业务 Store。

草稿每份最多 1MiB，包含 envelope 的 IPC 请求仍受原 1MiB 限额；没有按总数量或总字节静默淘汰用户草稿。列表每页只读取最多 100 份元数据，正文另按原 opaque ID 读取。冷应用重启后恢复已保存原文与修订；Store 替换或 Session 删除后保留原文本，在“读取已保存草稿”中说明原关联不可用，不将其放入同 ID 新会话。本文仍需用户明确保存，尚未保存的编辑器文本不声称跨冷进程恢复；没有隐式发送或重新绑定。

会话创建在私有库先保存原 commandId/sessionId/Store/Workspace/title 意图，再仅发一次公开 `createSession`。同 ID 同输入共享在途请求；冲突拒绝，pending/unknown 冷恢复仍只核实原 `getCommand`，核对其原身份、实际 applied 与 Session 事实后才显示已确认，不重发 POST。结果错误或未知保留既有草稿；新建空会话不搬移或删除其他会话文本，私有意图不是核心命令权威。发送、回答和权限选择继续复用原封存 intent。刷新、卸载和网络释放仅使 renderer generation 失效，所属 Service 与执行继续。

窗口关闭隐藏；明确退出由 main 读取实际活动事实后确认，先释放 caller 网络、私有 UI 数据库与 Profile lease，再关闭所属 paired Service，最后释放制品 lease。目录和退出检查使用 SDK `listAllWorkspaces/listAllSessions` 穷尽原 Store 的固定上界分页；晚新增由下一次完整读取覆盖，读取失败保持无法核实，不猜空闲。IPC 4MiB 响应预算没有提高，超大目录仍局部拒绝，未声称已经建立原生目录页面分页。

[test/native-caller.test.ts](test/native-caller.test.ts) 证明封闭 sender/输入预算、私有草稿 CAS、旧 generation 拒绝以及网络释放不等于所属 Service 关闭；这些是单元证据。[test/isolated/native-process.test.ts](test/isolated/native-process.test.ts) 用真实 Node→显式 Bun→公开 paired launcher 与新临时 profile 验证私有 bootstrap、身份与 EOF 后所属 PID 退出，制品构建不把宿主资源路径写进 renderer。[test/isolated/native-electron.test.ts](test/isolated/native-electron.test.ts) 使用 Node Playwright driver、真实 macOS Electron、自有窗口/profile 和本机假兼容模型端点，检查实际 main/preload/renderer、刷新执行/草稿、外来窗口拒绝及所属 PID 退出；必须以实际运行结果计资格，不能以 fake port 或启动进程替代。

以下保留早期私有开发窗口的限定基线，正式原页面与安装版的当前范围见[复用原桌面展示层](#复用原桌面展示层)和[发行 owner](docs/native-release.md)。该基线提供完整目录读取、根会话创建、Fork/rename/delete、消息页、新轮次/原命令核实与停止、普通 Interaction、模式与信任及授权目录控制、Model 输入/输出 Inspector、Context Rewind/Include；当时完整设置、附件 reader、Context 导出、发行安装、Linux/Windows 和旧视觉迁移尚未接入该窗口，有大附件但缺 reader 的审批只读。该轮 Node fixture 绑定已构建 Service，实际 Electron fixture 在私有临时目录构建 Service JS，按实际 SHA 与明确 Bun executable 接入；两者使用 workspace 公共依赖，不宣称完整 source-free installed Desktop 制品。该限定新测试组合为 5 项、35 条 Bun 断言通过，实际 Electron 场景另含 14 条 Node 断言与实际 DOM 操作，类型、局部 Biome 与文档结构检查通过。

原生大 Model 输出通过 [main view-read lease](electron/model-output-reads.ts) 与 [renderer reader](src/native-model-output.ts) 接入共享 `ModelOutputMessage`。有 `model_outputs` capability 时才提供显式完整读取；缺能力保持标明的 preview。open 固定当前连接 Store、阅读 Session、Execution、窗口 generation 与选择身份。封存 Message 的来源只从 Main 已观察副本取得；先用公共 `Client.getExecution` 核准确原 Model／Session／Run／originStoreId，再以当前 Store 和原 Session 调用 `Client.getModelOutput`，核封存完整性与计数。恢复后的当前 Store 与原出处分别校验，不重绑 origin；这些 GET 不读取来源 Run 的后来状态。main 最多一个在途读取/正文 lease，不恢复丢失句柄，不创建执行或 spool 权威。跨 IPC 每块最多 64KiB（二进制用 base64），请求必须按准确下一 offset 推进，原 1MiB/4MiB IPC 预算没有提高。close、切换、刷新、网络释放只 abort 本读取和清除正文，不提交 Command 或取消 Model/Run。

renderer 按已核实有限 wire size 接收完整 EOF，严格 UTF-8/JSON 后调用公共 `verifyModelOutputSnapshot` 的生成 schema、canonical body SHA、字节数及 completion 核验，再检查原 Store/Session/Execution/hash，只有当前视图可显示。普通会话不启用 reasoning 展示；正文不进入持久缓存。main 的 SDK 快照与 renderer 的完整正文仍可能各占一份整块内存，不能把有限 IPC chunk 声称为固定内存 streaming。[test/native-model-output.test.ts](test/native-model-output.test.ts) 的有限 port 测试覆盖 >17MiB、offset、hash/UTF-8 损坏、迟到 SDK 返回/取消与旧选择；[实际 Electron 测试](test/isolated/native-model-output-electron.test.ts) 使用私有构建 Service、真实 SQLite/本机兼容 SDK 输出，检查完整 >17MiB DOM 尾、显式关闭、跨窗口/旧 generation 拒绝、刷新只保 preview、模型计数不变与退出原 PID 清理。共享 MessageContent 将长普通文本组织为相邻 Text 节点，保持完整原文、GFM 与原消息列；不裁剪正文或插入额外换行。原 Fork 窗口继续核 `main.innerText` 超过17MiB及准确尾部，关闭／切范围只释放所属阅读，同范围刷新保已读正文；原完整 scope／hash／EOF 和模型计数门禁保持。该组织不把有限 IPC chunk 声称为固定内存 streaming，本轮实际结果归[普通启动进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通启动完整回归与制品读取)。

当前未完成、无origin且尚无工具调用的原Message，其历史摘要可能落后于稍后正文GET。Main只从自己已观察的原Message内部提供live preview；同Store／Session／Run／Execution、实际正文包含原预览前缀、UTF8字节不倒退且确有追加或完成时，可接纳已通过完整SDK／传输校验的更新，不把正常前进报成身份冲突。共享UI复核相同边界，未完成提示依实际快照；旧complete、已有calls或封存origin仍精确匹配，改写、缩短、foreign、SHA／EOF／UTF8、真实传输及取消失败保原处理。没有新增IPC字段／版本、读取权限或持久缓存。UI与Native原两文件30项398断言、两workspace类型及定向Biome通过；取舍见[正文前进决定](../../.agents/notes/implemented/bug-fix/2026-10-29-live-model-output-projection.md)，修后真实完成切换仍待包含当前源码的新制品验收。

本次受影响 Native 组合实测 9 项、71 条 Bun 断言通过；大输出最终 fixture 独立复跑约 36 秒通过，另含 24 条 Node 断言，原基础窗口场景另含 14 条 Node 断言。这是 macOS 开发 fixture 的真实窗口/协议证据，仍不代替完整安装制品或其他平台资格。Desktop 类型、局部 Biome、portable build 与文档结构检查均通过。

[Model](test/isolated/native-model-output-electron.test.ts)与[Fork](test/isolated/native-sessions-electron.test.ts)整窗口的私有[进程 owner](test/native-owned-processes.fixture.ts)沿原 launch／run 阶段，以准确 Node executable、driverPath、自有 root、kernel birth 与 fresh PPID 绑定后代，不按名称清理。已绑定进程短暂 uncertain／死亡过渡仅在共享截止内只读等待，未知或复用 PID 不发信号；正常业务退出仍有已绑定 alive 记录必须失败，即使随后清理成功也不改判绿。身份／绑定／截止错误保留并聚合原业务失败，未确认保自有 root。2秒是共享剩余等待截止，平台同步身份读取可能延长墙钟，不构成绝对2秒清理保证。有限 phase 为准确捕获与失败收尾保留，定位用 IPC／DOM 观察已退役；这份测试收尾不代证整个 Runtime 的资源退出。

[private-data.test.ts](test/isolated/private-data.test.ts) 以实际 Node 子进程验证冷打开、两进程同修订竞争、133 份草稿分页而非淘汰，以及未知格式、损坏行/文件和硬链接局部失败保原字节。[native-drafts-electron.test.ts](test/isolated/native-drafts-electron.test.ts) 使用私有实际 Service 制品、真实 SQLite 与 Node Playwright/Electron：草稿与未知创建意图跨冷应用进程恢复，键盘发起的创建响应在服务提交后被真实 TCP socket 断开，刷新/重启后只核实原命令，该未知原意图的实际 POST 为 1，没有新增 Model 请求。另验证真实 command 冲突的明确业务拒绝保留原草稿，把已停止的临时业务 Store 整份保留再创建新 Store，验证同 ID 新会话输入仍空、原草稿可读且明确关联失效，并逐次核实所属服务 PID 已退出。[实际 React DOM 测试](test/isolated/native-drafts-dom.test.tsx) 另证明晚创建回执不能抢回已切换的阅读视图或移动草稿。受影响 8 文件完整组合为 16 项、112 条 Bun 断言通过；最终业务拒绝及新增边界定向 4 文件复验为 10 项、66 条断言。新私有文件 fixture 另含 23 条实际 Node 断言，新冷启动窗口 fixture 另含 26 条实际 Node 断言。Desktop 类型与局部 Biome、文档结构检查通过；这是 macOS 开发制品的限定资格，未声称完整安装、布局持久化、未保存文本自动恢复或其他平台资格。

原生窗口权限控制由 main 调用公共 Client 的五个有限读写/回执方法，renderer 只提交封闭选择。权限面板展示实际根 Session、工作区读取范围和摘要；诊断面板的模式三选、是否设为默认、信任及撤销保留显式选择，子会话只读。普通 Native 的发送前项目准备沿[当前输入路径](#原会话输入区权限与停止)执行。main 在点击时固定原 Store、Session/root、Workspace、观察修订与摘要，同在途选择仅提交一次。未知结果保留原 commandId 与范围，在切换后也只核实原 mutation；CAS 冲突不自动重试，必须重新读取并再次选择。计划审阅答复不授予这些权限。

当前权限事实读取失败或观察流重置/失联时，main 不再向窗口提供旧的可写权限事实；窗口说明暂不可核实并提供显式重新读取入口。迟到的旧视图读取失败不能禁用或改绑新视图。网络释放与刷新只影响调用者网络，不停止所属 Service/Run；原权限意图在视图外显示。现有能力缺席时保持只读；实际授权目录管理边界见下方独立说明。

[test/native-permissions.test.ts](test/native-permissions.test.ts) 的有限 SDK port 证据覆盖重复在途选择、未知原命令、切换及迟到读取、缺 capability 与子会话只读。[test/isolated/native-permissions-electron.test.ts](test/isolated/native-permissions-electron.test.ts) 则使用真实 macOS Electron main/preload/React 窗口、私有构建 Service、SQLite 和本机兼容模型计数端点，实际键盘保存模式/default、信任/撤销，提交后真实 HTTP socket 丢失只查询原命令，以及竞争修改产生真实 `host_control_conflict`。显式失联读取使写入口不可用，重新核实恢复实际事实；两个原 Session 的 Run 均为零，Provider 请求为零，退出清理所属实际 PID。这是当前开发制品的限定窗口证据，不代表旧正式入口已切换、完整安装制品或其他平台通过。

当前原权限窗口在首次选择与 reload 后进入正式“会话工具”，先沿原核范围／信任动作取得模式操作资格，再执行原模式与默认设置、未知回执原查询、失败读取和 CAS，最后明确撤销信任。并发命令可能先发布 auto 文本，不能以该文本代证显式重读完成；fixture 在原 10 秒撤销预算内先等待按钮实际可用，再执行唯一原 Enter 与原 untrusted 等待，不重试已经进入的动作。按钮可用不保证后续观察不变，Main 的新鲜事实、已消费观察及 CAS 守卫保持。信任与撤销仍各一次，全部原业务断言与期限保持；同一完整文件1pass／1Bun断言、原13处Node断言通过，Provider0、两个会话无Run及所属Service退出均核实。该调用者适配遵守现行未信任只读的页面合同；准确输入和整体资格归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

原生输入检查器复用公共 UI `ModelInputs`，由 [Native Model Input adapter](src/native-model-input.ts) 连接 main 的公开 `listModelInputs/getModelInput`。Model calls 目录按所选原 Session 和固定 upperSeq 逐页读取，每页不超过 200；不会把第 200 条当作全部记录。Runtime logs 中的原 Model 执行可跳到准确 Execution 的敏感内容确认页，跳转本身不请求正文。这组 logs 只展示当前已保存执行的有限投影，不声称已经迁入完整 Runtime 事件日志。

输入与输出复用同一有限正文读取实现，main 每次只保留一种当前正文 lease；打开另一种读取先释放旧 main lease。每块仍最多 64KiB，原 IPC 1MiB 请求与 4MiB 回应预算不变。renderer 完整收齐 EOF，校验 scope、字节数、hash、严格 UTF-8/JSON，并调用公共 `verifyModelInputSnapshot` 才显示原 System、Messages、Tools、来源与实际 adapter/provider/settings、封存装配和最后派发事实。未确认成功的请求保持 unconfirmed，不证明 Provider 接收；没有可取记录时不以当前设置补造。main 与当前视图仍可能各保留整份正文，不宣称固定内存 streaming 或持久正文缓存。

关闭、切换、刷新及隐藏只 abort 本目录/正文读取并释放视图，迟到响应不进入新 Session，不取消 Run 或重发模型。[native-model-input.test.ts](test/native-model-input.test.ts) 覆盖 >17MiB 完整原输入、64KiB chunk、错误 offset/hash、原身份与取消；另用真实 SQLite/Core 的 205 次固定 Adapter 调用，经公开 Native SDK 和窗口 adapter 读完两页并核对最后一次原请求，读取 cursor 与调用数量均不变。这是 205 份实际持久记录的分页证据，不是 205 次远端 Provider 验收。[native-model-input-electron.test.ts](test/isolated/native-model-input-electron.test.ts) 用真实 macOS 窗口和私有 Service 制品，验证键盘从原执行进入确认页、完整输入及实际 metadata、关闭后清除正文、真实 HTTP 响应 barrier 期间切换 Session 后拒绝迟到输入、刷新无新增 Provider，以及退出原 PID 清理。仍不代表旧入口切换、完整安装制品、全部 Runtime logs 或其他平台已完成。

本输入切片最终受影响 Native 组合实测 12 文件、24 项、170 条 Bun 断言通过（约 64 秒）；新原输入真实窗口 fixture 另含 29 条 Node 断言。Desktop 类型、10 个归属代码文件 Biome 与文档结构检查通过；未运行共享 dist 或全 workspace 构建。

普通 Native 在输入区的审批方式菜单提供“当前会话授权”，以独立、可关闭且有界滚动的 Dialog 复用 `PermissionGrantsPanel` 和原清除回执／未知查询；此业务入口不开放诊断 SessionTools。切换会话关闭原目录，原观察与确认不迁移。原生授权目录由 [main 原观察与意图控制器](electron/permission-grants.ts) 调用公开 `listPermissionGrants/clearPermissionGrants/getPermissionMutation`，通过封闭 IPC 提供实际所选 Session 的页面。分页固定原 upperSeq 和 epoch；下一页 epoch 漂移拒绝，不能将 root 模式事实当作 child 授权。renderer 展示原 Store/Session/Workspace、规则与精确资源 scope、完整 presentation、真实消费 bindings、审批与执行来源及 scopeDigest；私有主体与完整策略证据不进入目录。当前主机公共授权规则决定是否允许管理子会话；UI 自身不授予管理权限。

用户明确核对观察到的 Session/epoch 后，main 固定原 commandId/Store/范围与 CAS；同一在途观察只提交一次。未知结果保持原意图，切换后也仅查询原 mutation，不更换 ID 或重发 POST；其他 Session 仍可只读查询。冲突需要重新读取后再次明确选择。读取失败或观察流失效会去掉旧可写目录，迟到响应不进入另一视图。清除不启动 Run/Model、不撤回已执行效果，组件卸载及网络释放也不停止所属 Service。[main 范围测试](test/native-grants.test.ts) 和 [共享实际 DOM 键盘测试](../../packages/ui/test/permission-grants-dom.test.tsx)覆盖精确原 child 范围、观察漂移、缺 capability、重复提交与 late 结果。

[实际 Electron 授权目录测试](test/isolated/native-grants-electron.test.ts) 从真实临时 SQLite/Core 已接受的两份会话范围授权启动私有构建 Service 与窗口。实际键盘清除后断开真实 HTTP 回应 socket，切换会话查询原 ID，原清除 POST 仅一次，另一会话原授权仍在；另一真实 host Command 造成 epoch 冲突时拒绝且不重试。失败 GET 使清除只读，退出核实所属实际 Service PID 消失，随后 readonly 重开确认两 Session 的原 Run/Model 执行数量没有增加。该窗口 fixture 含 13 条实际 Node 断言；它是 macOS 开发制品证据，尚不代表完整安装、旧正式入口切换、child 窗口清除或 Linux/Windows 资格。

2026-11-08 本轮整仓复核让该授权目录夹具选择实际主 renderer，避免辅助窗口先出现时未找到会话；全部13条窗口断言和冷读检查通过。默认候选中的权限审批改用独立 Shell 探针，Files 写入继续按当前透明业务权限直接执行，文件读取失败使用真实非普通文件对象；不能再要求普通 Files 自动审核额外弹卡。 同轮默认候选实际已走过 Shell 单次人工批准、唯一自身 Job、Files 写入和真实非普通文件读取失败，但完整 `native-bundle` 仍在缺失文件链接的旧错误提示断言失败：现有 `messageFile.open` 调用经非业务 `report` 吞掉异常，未出现夹具要求的 alertdialog。该调用与通用错误显示行为在基线已相同，本轮未改；本次窗口前缀不能写成完整候选／冷开整例通过。 远端桌面展示接管合并后，原答案 unknown 查询改用 Main 已返回的准确目标 Store／Session，即使 UI 正在保留上一页也独立恢复；读权限和新写入仍等待当前选择核验，原查询不补发答案。恢复继续共用同一选择读取槽，避免该读取占住原答案查询。

同轮最终源码外计划窗口整文件1项／313条Bun断言通过：移除夹具内退役编辑器的重复富文本 reader 和下划线转义补偿，复用当前 textarea 原文读取；真实计划修订／批准、拒绝停止、准确取消、草稿和冷读保持。68张过程帧中复看长附件／反馈、修订后待批、完成接管及取消前状态；普通退出 code0，原 Service 已结束。显式取消已派发 review 的 unknown 保留，不将其写成已知无效果。最终四份 DOM 回归覆盖当前计划权限菜单、原答案恢复与草稿接管，另实际授权目录窗口13条Node断言及冷读通过。普通 `desktop:dev` 同一入口以隔离HOME、诊断关闭构建启动实际窗口，本机本轮5.16秒完成握手与启动；已观察空目录页面、原文草稿输入和正常退出，新开发Profile的formatMajor为1且Run／Execution／Interaction均0。它不代替用户既有Profile、旧数据、完整安装或其他平台资格。


当前原窗口首次选择准确会话后，先核原标题并打开私有诊断制品的“会话工具”，再读取授权；后续选择已有的侧栏步骤保持。只补该首次导航，全部原driver字节、13Node断言及预算保留。同一完整文件1pass／10Bun断言通过，Desktop types／Biome通过；本轮默认真实失败与阶段范围归[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)，不把私有制品窗口资格提升为完整安装或整体退出。

同一会话观察恢复期间，后台 `select` 等待中的 state 通知只暂停操作，不关闭同 generation／Store／Session／viewSelection／historyEpoch 的原历史扫描；任一读取身份变化或离开父会话仍撤销原扫描。`preserveHistory` 同时约束准备阶段与完成接管，避免通知使慢速历史反复重读。[读取归属 DOM 回归](test/isolated/native-read-ownership-dom.test.tsx)用挂起的选择回执与历史读取覆盖中途通知保持扫描、historyEpoch 变化撤销；这是隔离 React DOM／受控桥接证据，不代证完整 Electron 或真实模型旅程。

[普通 Native DOM 回归](test/isolated/native-read-ownership-dom.test.tsx)以 `testDiagnostics:false` 从审批方式菜单打开目录，核完整 presentation／scope／bindings／审批与执行来源，清除前确认、双击只提交一次、unknown 原 command 查询，以及切会话拒绝迟到目录，其他诊断入口保持关闭。该测试与实际普通 renderer 逐步观察分别记录资格，DOM 不代证真实窗口完整旅程。

2026-11-06 至 11-07 在 macOS、Bun 1.4.4、Electron 44.3 的隔离真实 Service／SQLite／Shell 窗口中，普通构建关闭诊断入口，逐步观察到权限菜单可达授权目录、完整范围与来源换行可读、明确确认清除后 revision 1→2 且重读为空。原会话新审批默认仅此次，双击只新增一次回答；模拟回答回执丢失后原卡显示 unknown 且禁用，外部效果只增加一次。同一 renderer 的恢复过程中，新的私人草稿🙂与阅读位置 600 不变；重连后自动核对原意图，原卡退役、权限与输入恢复，稳定等待不增加调用或效果。随后明确选择新的会话范围授权，普通退出／冷重开并显式选择原会话后，调用与效果保持；下一轮复用原范围只增加两次业务调用及一次 Shell 效果，reviewer 次数保持 4、无新审批。原已清除授权保持 revoked，新授权保持 active，同 Store 未被替换。上述连续旅程包含投递、待批、unknown、终态接管、完整目录与冷后复用，最终调用计数 17、外部效果 6；使用固定高风险 reviewer 和受控业务 Provider，不证明真实模型分类质量、完整安装或其他平台资格。整页重载不保未显式保存的普通草稿与 DOM 阅读缓存，沿原产品限制，不把旧现场重载恢复计为同 renderer 草稿保持。现行 private schema 11／12 的备份维护限制仍按原范围保留，不将普通冷重开称为备份恢复通过。

此前恢复后的输入/输出、私有冷草稿、创建未知意图、模式/信任与完整目录基线仍为 12 文件、24 项、170 条 Bun 断言。原输入窗口另含 29 条 Node 断言，大输出窗口 24 条，基础窗口 14 条，冷草稿窗口 26 条；这些分别核实所属实际 PID 清理。共享 `ModelInputs/ModelInputPort` 保留 Web 原确认/metadata 语义，Runtime logs 的 `initialExecutionId` 跳转不自动 body GET；scope 改变不依赖 remount key，清正文并 abort，Native 输入和输出共享单 main lease。

授权目录合入后的最终完整 Native/共享权限组合实测 16 文件、30 项、224 条 Bun 断言通过（约 63 秒）；新授权窗口的 13 条 Node 断言和所属 PID 清理包含在其中。Desktop/UI 类型、10 个本切片归属代码文件 Biome 与文档结构检查通过；未运行共享 dist 或全 workspace 构建。

原生窗口现通过 [main Context 观察与意图控制器](electron/context.ts) 和 [视图消费者](src/native-context.tsx) 读取公开所选上下文。消息与来源独立分页，固定原 selection/highWaterSeq；消息结束后保留 afterSeq=highWaterSeq，来源结束后保留实际末尾来源 ID，不重复第一页。该 Native 控制器不设历史总页数或 complete 边界总数量截断。页面超过原 4MiB IPC 回应预算时，仅以相同 selection、高水位和两个原游标缩小 GET 页；单项目仍无法传输时明确局部不可用，完整单条大正文传输不属于此入口的资格。

历史结果候选从公共 `listAllBackgroundExecutions` 的完整固定目录读取，以实际 Session/root/Workspace 限定并筛选当前会话的 suppressed Job；不依赖 View 最近 200 个 Execution 的成员资格。Main 保存该次完整元数据目录，仅对当前窗口逐项用 `getExecution` 读取完整正文，并核对原 ID、Session、出处、revision、delivery 与状态；版本变化明确拒绝，不悄然替换原结果。私有 `context.results.next` 在同一 observation 内按原 4MiB 预算交付下一窗口，页面显式显示总数和当前范围；消息／来源分页仍使用原 Context 快照。Context 页占满预算时，历史结果可以先交付空窗口，再由显式下一页完整读取；单项仍超预算时明确局部不可用，不静默丢弃或扩大预算。刷新、关闭和换会话释放所属目录与在途读取，不授予停止或重跑权限。

显式 Rewind 只接收已读取的 complete 消息原 ID/seq 或空边界，完整 Tool 配对由 Core 核对。历史 suppressed Job 的 Include 原样传递共享面板点击时封存的当前 Store/Session/selection/targetRunId envelope；main 先以 `getExecution` 精确查询原 ID，核 Session/resultRevision、出处存在及 suppressed 终态，再读实际 view 核当前准入、Workspace、selection 和准确活动 Run。明确备份恢复后，原 Job 出处可以是 A，新的上下文命令属于 B；Core 仍在写入事务核原 subject 与 delivery target Session，保存的完整结果来源保持 A。缺准确目标或活动 Rewind 明确拒绝。accepted/result_queued 仅显示排队，原 Command 到 checkpoint 后 applied 才表示来源纳入；idle Include 只保存后续来源，须用户明确新建 Run 才进入 Model。这两种操作都不创建新 Run、重放 Job 或恢复原自动交付，自动 consume 的当前 Store 限制保持。

每项写入保存原 commandId 和身份，重复在途调用共享 Promise；最多 128 项原意图，超过时局部拒绝而不丢弃未知命令。未知回执只查询原 Command，不重发 POST。视图切换、刷新失败或观察流失效清除旧可写事实；旧读取不能覆盖新 Session。组件关闭只中止自己的 GET，不停止 Run 或所属 Service。SSE 刷新暂时清除 portable snapshot 时，读 scope 使用此前成功选定、按原 Session/选择代次封存的可信 Workspace 身份；写入仍须实际 view 复核，不靠该身份缓存批准。

[main 回归](test/native-context.test.ts) 验证消息与来源交替结束、超过 200 条消息、固定高水位缩页、单项目拒绝、原命令未知查询、精确活动 Include、取消自身 GET 与封闭 IPC 的 scope/Decimal64；[DOM 回归](test/native-context-dom.test.tsx) 验证换视图迟到正文不覆盖，以及共享 Include 第二参数原样透传。[实际 Electron 回归](test/isolated/native-context-electron.test.ts) 在临时 SQLite、固定 Adapter、私有 Service 制品和真实窗口中，完成 idle Job→键盘 Rewind→suppressed 历史→活动 Include queued→下一 Model 完整结果和 exact sourceID；Rewind 已提交后物理 HTTP 回应 socket 丢失，只查询原 Command，POST 仅一次。外置效果账本始终一行，刷新不新增模型调用，退出核实原 Service PID 消失。该窗口含 15 条 Node 断言，证明 macOS 开发制品当前 Context 切片；不代表 Fork/压缩、完整安装、旧正式入口切换或 Linux/Windows 资格。

[恢复后原入口整例](test/isolated/native-restored-context.test.tsx)以真实 Job、Rewind、公开 backup/restore A→B 和正式 NativeContextView 按钮，经有限 decoded bridge→Main→实际 SDK/Service/Core 保存新的 B Include，完整 source、原 result/revision/出处仍为 A。随后明确新 Run 的实际 Model request 按唯一 source ID 消费完整低信任 JSON；原 Job 与外置效果只执行一次，原公共 Execution 和 Command/Run 冷读保持，Core 仅准确接纳投影变化。该新例1pass/66Bun断言，相邻原完整作业合计26文件137pass/1337Bun断言；实际窗口仍保15Node断言与10/45/60秒预算。原键盘夹具曾在 disabled/busy 时按 Enter且零POST，现仅先核同按钮 actionability，再保原键盘动作和丢回执断言；真实失败保留。新恢复范围是实际 HTTP/Core 加 JSDOM/Main 的组合，不代证新增 installed Electron 恢复整窗口或整体退出；准确输入和剩余门禁归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-context-明确纳入原结果)。

[超过 View 窗口的原结果整例](test/isolated/native-context-history.test.tsx)在真实 Core/SQLite/HTTP 完成一次 Job、Rewind 和 201 个后续 Run，核 View 已无原 Job、准确查询与完整目录仍保留，再通过实际 NativeContextView 展示完整原正文并明确 Include。原生产因按钮缺失失败；修复后 1 项／56 条断言通过，原历史、命令、完整结果与出处保留，idle 不新增模型或任务效果，只有显式新 Run 消费完整原来源。Main/DOM 另核 405 个候选完整遍历、原 4MiB 预算的分开传输、所属正文 GET 取消和原 revision 冲突拒绝；本轮相邻完整组合 9 文件／23 项／474 条 Bun 断言通过，含原 macOS Context 与压缩窗口，原断言及超时预算保留。新例使用系统临时目录、固定模型与公共客户端，不新增 macOS 专属条件；它不代证 Windows/Linux 原生安装窗口或阶段退出。

本 Context 与既有 Native/共享权限联合回归实测 19 文件、38 项、270 条 Bun 断言通过（约 70 秒）；实际 Context 窗口的 15 条 Node 断言包含在该回归中。Desktop 类型、11 个归属代码文件 Biome 和文档结构检查通过；未运行共享 dist 或全 workspace 构建。

原生会话管理由 [Main 控制器](electron/session-management.ts) 消费公开 Fork、rename、delete API。[普通窗口的会话行菜单](../../packages/ui/src/desktop/Sidebar.tsx)提供重命名和删除，由 [Native 对话框](src/native-directory-session-dialog.tsx)确认。Main 根据当前可用目录核对 Store、目录代次、Workspace 和根 Session，观察与会话选择分开，写前重新读取目标 view 并核对修订。测试窗口的[管理面板](src/native-sessions.tsx)仍按当前 selection 准入。两处复用原 commandId 和回执校验，目录观察仅可提交一次操作，未知结果只查询原 commandId。窗口意图最多保留 128 项，普通目录的已结束意图可淘汰，未知意图保留到 Main 退出。会话创建与用户草稿仍使用前述私有数据库。

改名和删除弹框首帧使用目录已显示的名称，等待后台核对时保持提交按钮禁用。标题、正文和按钮位置在同名核对前后保持稳定，用户已输入的名称继续保留。实际断线或核对失败时显示原因及可用的重试操作。

目录回执确证后，[Main](electron/native-caller.ts)按准确 Session 与修订更新目录、使在途旧目录读取失效，并安排常规刷新。删除当前根会话同时释放其读取，renderer 跳回同一空间的新对话。其他会话的读取与输入继续保留。丢失回执时空间栏提供原命令查询，行可先随真实目录观察消失。受控浏览器验证沿[侧栏回归](test/sidebar-actions-browser.fixture.ts)的 `--session-actions` 入口，覆盖菜单、键盘、逐帧弹框位置、在途反馈、取消、未知查询和当前页交接。

2026-11-13，Windows x64／Chrome 157，关闭诊断的隔离 renderer 在深浅主题下检查会话按钮默认隐藏、逐行悬停、浮层打开时保持和移出后关闭即隐藏。暂扣观察与写入回执、模拟断线恢复、取消删除、只查询原命令和当前会话退出均走同一页面。另有真实 HTTP／SQLite 回归核对原命令与删除收尾。此范围为本机开发验证，未运行安装版 Electron。

分叉明确显示扩展状态未复制。复制的消息保留服务封存的 `originMessage`；main 只从已读取、按当前视图封存的 Message 推导原 Session/Run，renderer 不能提交源身份作为权威。原正文仍用原 Execution 和原 Store 读取，保持原 BodyRef，不复制或重标 blob。删除确认只表示 `delete_requested`、`stopConfirmed:false`：目录隐藏之后，原 ID 的历史与执行事实仍由服务保留，窗口不会声称资源已经停止。rename 的 CAS 冲突保留原意图并要求重新读取、重新明确选择。

Native 有独立分页 Context reader，因此仅此宿主以 `readContextOnSelect:false` 禁用 portable controller 的重复 Context 预取；便携调用者默认仍读取。main 保留同一已选 Session 的成功视图用于刷新期间的阅读，临时 snapshot 不可用时明确只读，不把加载中当成用户切换。真正 scope/selection 改变仍清除旧视图。持久通知只提示重新读取：一个在途 view GET 加 dirty 标记合并积压通知，Client 仍消费全部事件 cursor；写前仍重新验证原实际 view，没有使用缓存批准操作。同 Session 成功 SSE 更新不会仅因 loading 清除已核实全文。

[管理 main 测试](test/native-sessions.test.ts)、[原 scope 输出测试](test/native-sessions-output.test.ts) 和 [实际 DOM 测试](test/native-sessions-dom.test.tsx) 覆盖原身份、CAS、未知查询、重复与迟到视图；[刷新回归](test/native-refresh.test.ts) 覆盖通知积压的单在途读取和加载期间撤除写资格。[真实隔离窗口](test/isolated/native-sessions-electron.test.ts) 使用本机假兼容模型、临时 SQLite 与私有 Service 制品：原 Fork POST 提交后物理回应丢失，只查询原命令；分叉后读取 >17MiB 原作用域正文，在同 Fork 的管理读取、真实竞争 rename 和成功 rename/SSE 更新后仍显示完整尾部；冲突不重试，未知 delete 只查原 ID，Provider 始终一次，退出核实所属 PID 消失。该场景独立通过 18 条实际 Node 断言，仍属于 macOS 开发窗口资格，不代表正式旧入口切换、完整安装或 Linux/Windows。

该原会话窗口的初始权限准备现沿正式Panel核所显示范围并信任，再明确Full保存；默认Auto保持。原直接mode→refresh→trust在自动观察后被Main旧观察守卫拒绝，只有mode一次POST、trust零POST，尚未进入正文。生产观察／CAS／消费与跨选择拒绝保持，夹具不重试mutation；全部后续业务字节、22条assert语句及45／60／10／30秒原预算未改。修正后的原完整窗口1pass／3Bun expects／18.75s，各一次trust与mode、>17MiB完整正文及六个准确所属进程普通退出通过；原红及冻结输入、当前完整默认结论归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)。

真实子进程、Electron 与私有文件测试统一位于 [test/isolated](test/isolated)；fixture 留在 `test/`，迁位后修正实际入口相对路径，原断言保留。未以 checker 例外替代进程隔离归属。

本次管理、刷新与迁位后的完整 Native/共享权限组合实测 24 文件、45 项、308 条 Bun 断言全通过（约 70 秒）；新管理窗口的 18 条 Node 断言、一次 Provider 和所属 PID 消失包括在其中。Desktop 类型、局部 Biome、文档结构与测试归属检查通过；未运行共享 dist 或全 workspace 构建。相同窗口的暂时加载仅保留只读观察，真实刷新失败仍清除可写事实；此区分同时覆盖原授权目录和 Context 消费者。

原生手动压缩和重置由 [main 压缩意图控制器](electron/compression.ts) 调用公开 Service API；[Context 面板](src/native-context.tsx) 只提交当前 observation ID 与完整重点，不能提供 Store、selection 或旧 compression ID 作为权威。main 写前独立读取实际 view 与 Context，核对原 Store、根会话、空闲、selection 和 compression ID；重点按原 UTF-8 全文提交。最多 128 项原意图，未知和 accepted 不丢弃、不重发；原 Command 的 accepted/applied 与原 Run 的 completed/failed 分别展示。历史压缩原 Store/Session、覆盖序号、原 ModelExecution 与触发来源原样读取，没有重标 BodyRef。

正常会话的自动压缩使用同一轻量 compaction 行。`NativeCaller` 传递原 `compressionProgress` 的 Run／Store／可用 Model Execution 身份，transcript 按准确调用去重；完成／失败／取消／未发布来自公共 Message 的原 SQL 压缩身份。模型成功或热进度消失不推导发布成功。 仅持久记录为 running 且没有匹配实时进度时，不显示压缩行，也不显示“上次确认为进行中”；保留真实已发布、失败、取消和未发布结果。压缩摘要不显示为普通回答，`completeRunReplies` 也排除其最终与复制资格；普通无工具 Model 仅是候选，须实际 Run completed 才能显示最终回答。[真实 Core→HTTP→Client→Native 回归](test/isolated/native-transcript-dom.test.tsx)在摘要后继续工具及 Run 最终提交屏障验证这些边界，另保冷历史和新版分页 Tool 标签；该证据是本机固定模型／DOM，Electron 和安装版窗口保各自验证范围。

View 补入压缩状态时，仅对新增压缩事实按其物理序号定位；已有完整历史保持自己的投影顺序，不能再次全量按物理序号排序。旧已验证输入替代消息仍在原输入位置，原 identity／seq／附件不改写。压缩定位回归核原序、插入、终态更新和重复 View 去重；原 Native 新会话整例另保热接管与冷挂载的先输入后回复顺序。

Native 的 [消息投影](src/native-presentation.ts)将准确 `firstOutput: reasoning`、未完成且当前无正文的 Message 映射为隐藏的 thinking 标记，只驱动顶部状态。长思考还要求原 `outputBody.contentBytes` 为零；旧记录缺首频道时，仅凭明确的 reasoning 字节与零 Tool calls 兼容。非空正文、空白正文或完整正文计数大于零立即保留 assistant；不支持的格式／读取仍保原提示，压缩状态优先。`firstOutput` 是首频道，不能作为永久隐藏回复的状态。共享 Conversation 在宿主 renderer 之前排除思考和结构标记，并保留准确轮次状态位置，不生成空的过程展开入口。[Native DOM](test/isolated/native-reasoning-dom.test.tsx)覆盖内联／Artifact／旧元数据及正文切换；[普通 Electron](test/isolated/native-reasoning-render-electron.test.ts)沿实际本机 Compatible SSE、Service、Core、SQLite 和 Native 窗口，经过带正文与纯工具调用的三次 Model，产生短思考、超过内联预算的长思考、正式阶段说明、同批及后续共三次真实文件读取及最终正文；测试持有真实 Tool Execution 元数据 GET 的响应，消息和模型继续推进；MutationObserver 和逐帧观察核对元数据未到及就绪后均无自动原结果 JSON、私有思考不进入消息 DOM、活动聚合默认收起且不随随后模型输出展开、终态交接不绘制已关闭的旧过程、手动折叠仍有动画。最终资格仍等待原 Run 完成，会话往返与页面重新打开只读原历史。该窗口使用普通关闭诊断的构建，不调用远程模型，不代证其他平台或全部 Provider 行为。

“查询原压缩命令与执行”先读取保存意图的原 Command；有 Run receipt 时保留实际 View 的 Store／Session／root 准入，再沿公共 `getRun` 读取准确原 Run，并核 Run ID、originStoreId、sessionId、originCommandId。View 的近期 200 条终态 Run 不承担完整历史查询，原 Run 离开该范围后仍能核实。读取或身份校验失败保留已经确认的 submission，并另报本次查询失败；accepted 不制造 Run，查询不重发压缩或重置。[完整 main 用例](test/native-compression.test.ts)覆盖 compress/reset 与错误身份；[实际长历史 DOM 用例](test/isolated/native-compression-history.test.tsx)经正式按钮、decoded bridge 和真实 Main／HTTP／SQLite 产生 201 个后续 Run，核原准确结果和全 GET、原 Command／Run／Model／完整历史未改。新增 DOM 用例不经过真实 NativeCaller IPC 或 Electron；原窗口按其已有范围复验，准确红绿与当前验证见[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-13native-长历史原压缩结果查询)。

同 Session 的压缩原输入快捷入口区分当前 Store 准入和原压缩出处；A→B 恢复后仍把准确原 `modelExecutionId` 交给实际 [NativeDesktop](src/native.tsx) 父回调与共享 ModelInputs，不要求原 Store 等于当前 Store。同 Session 限制保留，跨 Session 封存压缩卡不借当前 Inspector 读取源会话。确认敏感读取后，[Native port](src/native-model-input.ts) 与 [Main reader](electron/model-output-reads.ts) 绑定当前 B／generation／viewSelection／Session／Execution；Core 独立核原 Execution／Run／Command／root-work 和主体，完整 EOF／bytes／SHA 后才显示保存请求和原元数据。关闭清正文，切换只释放所属读取，不改变压缩／重置写入门禁。

[真实恢复整例](test/isolated/native-restored-compression-input.test.tsx)使用实际压缩、公开 backup/restore、两次全新 Service／Client／Caller 与完整 NativeDesktop DOM，核真实父回调、确认前零正文读取、完整原 request／metadata／当前 cursor／多块 IPC、Close 和迟到 Main open 回复的 Session 取消。原压缩／Execution／Run／Command 保持，恢复后全 GET／Model0；[同 Session DOM 回归](test/native-context-dom.test.tsx)另保跨 Session 不显示入口。最终五个唯一原完整作业28文件105pass／1027Bun断言，原压缩窗口另41Node断言和两个所属 PID 退出；准确红绿与冻结输入见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-压缩原输入入口)。新 DOM 整例没有 Node 私有 UI 数据库，实际草稿不可用告警明确确认；布局替身不证明新的 preload／Electron／installed 恢复窗口。已有原压缩、Model 输入窗口分别复验其原范围，完整 P5／P6 与阶段退出仍未闭合。

[Native 输入选择](src/native-input.ts) 使用点击时已核实的 active Command 和 Run：手动压缩或重置期间普通文本封存原 afterRunId/contextSelectionId 为 follow-up，普通活动工作同样封存为 follow-up，只有队列条目旁的显式引导才封存 targetRunId 为 steer；空闲才创建新轮次。Native 显式启用 portable controller 的 active Command 读取，其他 portable 宿主默认行为不变。持久通知刷新每个 Promise 只执行一次实际 GET；dirty 的后继读取在下一事件循环启动，明确用户请求只等待已捕获的读取，再做自身核对，不等待全部通知或 Model 完成。授权目录只读 GET 同 Context 一样使用此前成功选择的原 Workspace，避免后继通知暂时清空 snapshot 时误当切换；清除授权仍要求当前 fresh snapshot，临时加载不能扩大写资格。

[压缩范围测试](test/native-compression.test.ts)、[输入选择测试](test/native-input.test.ts)、[真实窗口](test/isolated/native-compression-electron.test.ts)与[实际活动 Model 刷新 barrier](test/isolated/native-refresh-active.test.ts)核对完整重点、真实摘要与经公开校验的下一持久 ModelInput、旧可见历史、物理回执丢失只查原命令、unsafe reset 保留原点、无点 reset 和冷启动只读零额外 Provider、维护输入原 follow-up 以及不受后继 GET 阻塞的准确 steer。窗口含 33 条 Node 断言并核实两次原 Service PID 已退出；Provider 仅为自有本机固定兼容 SDK，不涉及远端服务。

压缩与通知刷新最终完整 Native/共享权限组合实测 28 文件、51 项、348 条 Bun 断言全通过（约 75 秒）；随后新增确定性授权目录 GET/dirty 后继 barrier 的刷新文件复验为 2 项、7 条断言。新压缩窗口另有 33 条实际 Node 断言、四次自有兼容 SDK 调用及两次所属 PID 清理；原管理窗口 18 条 Node 断言和其他已有窗口证据仍保留。Desktop 类型、portable build、15 个本切片归属代码文件 Biome、文档结构和测试归属检查通过；未运行共享 dist 或全 workspace 构建。这是 macOS 私有开发制品资格，不代表正式旧入口切换、完整安装、Linux/Windows 或付费 Provider 验收。

切换会话时，[renderer](src/native.tsx)立即撤销旧操作资格，正文按目标身份恢复命中的 KeepAlive 项及阅读状态，未命中则沿原完整历史、轮次归属与工具加载边界显示加载状态；输入区按上文统一渲染帧准备后接管。新数据未就绪时保留缓存显示并禁用旧动作；普通同会话校准仍保留本地展开。`conversationCache` 的 scope 固定 generation／Store；子详情还绑定已核实的准确 carrier／child Session，不能因稳定 Session 相同而复用另一轮的读取范围或操作。history epoch 与已确认目录移除使非当前项失效，新增会话保留其他近期项；容量、体积和节点预算由 [UI owner](../../packages/ui/README.md)维护。停用树脱离可见文档且 effect 释放，不增加后台订阅，不以缓存恢复写资格。[Native model adapter](src/native-model-output-message.tsx)显式传递当前读取 gate，模型正文按实际内容身份保留，不再把每次 viewSelection 当作 DOM 身份；原 lease 仍在停用时关闭。Native 的完整回复复制文案以 generation／Store／Session 与原正文身份保存为展示，adapter 将暂停产生的通知撤回与实际关闭区分，entry 回收时清理；复制按钮仍由当前读取 gate 和缓存事件门禁保护，保留文案不恢复读取或提交资格。文件链接保留原节点，由当前 gate 与原 messageFile.open 范围核验决定是否操作。[Native DOM 回归](test/isolated/native-history-presentation-dom.test.tsx)核 held selection 期间正文节点与展开状态保持、旧选中高亮退出、发送禁用，以及返回后的恢复标记和手动开合。

2026-10-19 KeepAlive 验证：Windows x64／Bun 1.4.3，`f734245a` 加主工作区快照及本补丁，使用 `bun test --parallel=1 --max-concurrency=1` 与准确 `./` 文件路径运行相关14个完整文件，105项／2815断言通过；UI／Desktop typecheck、定向Biome、文档结构／本任务影响映射、统一边界和测试归属检查通过。新增[缓存测试](../../packages/ui/test/isolated/desktop-conversation-cache.test.tsx)含条数、DOM体积、节点预算与100轮 effect 清理，原[全文测试](../../packages/ui/test/model-output.test.tsx)包含旧 lease abort、late 隔离与原全文节点恢复。Chrome155 的隔离夹具以显式 production JSX 分别构建 Root UI 与 Desktop UI，沿实际 SessionPage、Native model adapter 和 Native CSS，在亮暗主题中各核100次往返、恢复后12帧：原正文／表格节点不变，正文内部 childList 新增／替换为0，只连接1棵消息树，纵向230px／宽表格横向110px保持；固定正文 port 只读取1次、旧 signal 取消1次，校准中不发布当前复制正文，页面错误0。该夹具只证明显示与 reader adapter，不代替完整 Service／IPC、Electron 安装版、多平台或全量默认测试。

本轮组件闪动回归由[专用浏览器夹具](test/conversation-cache-browser-runner.fixture.ts)执行：在已安装 Chrome 的环境运行 `bun apps/desktop/test/conversation-cache-browser-runner.fixture.ts`，夹具独立构建实际 Native CSS、Conversation、图片与全文 adapter，固定模拟图片／正文 port，不加载真实会话或 Service。它逐帧核图片解码、用户与完整回复复制按钮／文件链接的原节点、未悬停复制透明度、悬停文字颜色、复制反馈、只读点击门禁，以及100次切换后单一连接树、一次图片读取与正常过渡恢复。该入口只在显式测试制品中存在，不由环境名、URL 或普通 dev／prod 参数开启。

完整 Native 壳层另由[页面回归](test/isolated/native-session-shell-dom.test.tsx)和[全页浏览器夹具](test/session-shell-browser-runner.fixture.ts)覆盖：`bun apps/desktop/test/session-shell-browser-runner.fixture.ts` 使用实际 NativeDesktop、Composer、模型选择和环境 hook，固定模拟 Main 端口并关闭测试诊断，不接真实 Service 或用户数据。它在浅／深主题逐帧核首次冷会话的长模型名、准备期间的 Main state 通知、会话确认、历史及模型校准、同会话重读、空草稿的发送／停止、原控件 DOM／透明度／位置／悬停、菜单与 Full 确认失效、禁用零业务写入及连续切换。冷首帧与暖缓存分别建立身份基线：首次读取尚无用量样本时不伪造缓存率徽标；模型按钮则跨两种场景保持原节点，首帧模型文字和宽度必须与同帧页面标题对应。正文资源夹具与全页壳层夹具分别证明各自断言，不以其中一个代替完整安装窗口或真实 IPC。

2026-10-19 Windows x64／Bun 1.4.3／Chrome 155，基于 `f734245a` 加本轮工作区改动，上述两个浏览器命令在合并后的实际样式上通过：完整页面浅／深主题共144帧等待采样、200次连续切换，另核五类控件的悬停颜色；正文夹具另核图片、复制和链接的原节点与单一连接树。正文缓存、编辑器、Native 导航、权限、图片、读取归属及环境停止的18个相关整文件共125项／3058断言通过，Desktop／UI typecheck、定向 Biome、文档、边界和测试归属检查通过。Chrome 保持沙箱开启；Windows 受限进程中的 crashpad 启动失败后，在允许启动浏览器的本机进程环境完成复验。原嵌套 `@keyframes` 编译提示及既有 ToolActivity 测试 key 提示保留；此证据仍不代完整 Electron 安装窗口、真实 Main IPC、其他平台或全量默认测试。

2026-10-19 组件恢复修复验证：Windows x64／Bun 1.4.3，`f734245a` 加既有工作区快照和本轮合并改动，准确 `./` 路径运行15个完整回归文件，111项／2869断言通过；合回后的 UI／Desktop typecheck、17个本任务代码／测试文件的 Biome、文档结构／本任务影响映射、统一边界和测试归属检查通过。上面的专用浏览器命令在 Chrome155 的亮暗主题各采样缓存校准与完成后24帧，并各切换100次：图片24帧均为原已解码节点，用户／完整回复复制按钮、文件链接与轮次控件保持原节点；未悬停复制透明度一直为0，轮次透明度一直为1，悬停文字颜色保持，复制反馈不重置，校准点击零复制／文件操作。每种主题图片读取和URL创建各1次，期间未撤销，当前文件链接可正常操作，普通过渡在恢复后回到120ms，只连接1棵阅读树，页面错误为0。资源预算、真正移除、窗口隐藏、复制展示回收和迟到隔离由隔离DOM回归补充；仍未验证完整 Service／IPC、Electron安装包、其他平台或全量默认套件。

此前闪动修复的局部证据：2026-10-19 Windows x64／Bun 1.4.3，基于 `f734245a` 加当前工作区快照及本轮改动，相关七个完整文件46项／1438断言与 UI／Desktop typecheck 通过；新增两处 Native 断言在修复前失败。Chrome 155 隔离页面沿真实 SessionPage 和 Native CSS，在亮暗主题中各采样恢复后12帧，手动阅读位置230px及展开内容高度保持，轮次与工具恢复动画均为none，默认展开活动轮次同样保持；后续手动轮次／嵌套工具仍使用原展开动画，页面错误为0。未运行完整 Electron 安装版、多平台或全量默认测试。

原生历史由 [NativeHistory](src/native-history.ts)在首次选择、重开、暂停恢复、观察epoch变化或变更游标失效时分页建立完整基线，固定原 Store、Session、选择代次与highWaterSeq；EOF精确替换阅读快照，包含移除记录。校准期间保留已发布正文，不把进行中的前缀提前缓存；完整扫描失败仅合入合法前缀并撤销操作资格。完整会话时间线与当前Model context分开，rewind不隐藏原消息，活动历史不设累计条数或字节截断。

Service声明`message_changes`时，同一连续scope随后调用[Client](../../packages/client/README.md#消息历史增量)读取持久变更。`historyCursor`只来自同View的`snapshotCursor`；正文SSE只提供可能领先View的`historyTargetCursor`唤醒，不能作为基线或ACK。增量首页面从Store取得序号上界，后页固定该上界；同一`seq`的正文追加、旧输入替换标记、压缩和子结果等依赖投影均按原消息ID合并。每个最多200事件的批次完成全部候选页面后才原子发布及推进变更游标，失败不提交半批；未变化对象保原引用，普通增量不进入history loading，也不增加发送前全量重读。缺少能力的旧Service沿完整扫描兼容路径。Main保留每页预算、准入和late隔离，纯正文事件不再触发View GET；Run、执行与权限元数据继续独立刷新，外来名称及历史回收事件可唤起关联正文。实际失败撤销准入；replay失效则刷新View和epoch，重新完整校准。取舍见[持久历史游标](../../.agents/notes/implemented/architecture/2026-10-24-native-history-change-cursor.md)。

[inactive cache](src/native-history-cache.ts)仅保存非当前数据，最多12项、64MiB保守载荷估算、单项16MiB；命中通过 take 转交活动视图，离开时重新入队，空历史可缓存，超预算历史仍可完整阅读但离开后不保留。generation 改变清空旧正文与缓存；history epoch 改变仍清非当前缓存，同一 generation／Store／Session 已发布的活动正文保留为只读阅读，刚由 preview 取出的旧非当前快照不能跨 epoch 冒充活动正文。新 scope 仍从零完整校准，只有新 EOF 才恢复完整读取资格；取舍归[历史 reset 阅读决定](../../.agents/notes/implemented/bug-fix/2026-10-16-native-history-reset-reading.md)。确认空间移除时淘汰所属 Store 的缓存与活动正文，卸载清全部引用。`close()`只取消读取并撤销该次校准标记，随后同一阅读选择可完整恢复校准。固定水位相同不代表正文未变：有连续变更游标时读取增量，缺少能力或基线失效时仍完整校准；缓存和消息序号都不授予写入资格。[缓存回归](test/native-history-cache.test.ts)核100会话轮转与字节预算，[历史回归](test/native-history.test.ts)核暂停恢复、EOF替换、失败前缀与迟到隔离；[主子导航 DOM](test/isolated/native-session-navigation-dom.test.tsx)核活动子页、父读取暂停、草稿和监听释放。

[Main](electron/native-caller.ts) 每页仍执行 4MiB IPC 预算及公开回应校验，过大时只在原游标和高水位缩小 GET 页；已通过校验的页大小仅在同一 generation／selection／Session／Store／highWater／readId 内单调保留，后页仍重新读取和校验全部正文。范围变化、取消、关闭或新读取重置该限制；单项目无法传输时明确未完成。切换只关闭自己的读取，迟到旧页不能进入新会话，也不取消业务执行。取舍与既有观察刷新共同归[完整正文刷新决定](../../.agents/notes/implemented/bug-fix/2026-10-08-native-observation-output-refresh.md)。

观察流缺口使旧操作事实失效。main 在原 Store 先读取全局目录基线，再重读目录、当前 view 与完整历史，随后用公开 `startAfter` 重开观察；该起点不成为已应用游标。经公开 Client 校验的 `onReady` 仅确认观察就绪，历史完成与当前事实共同恢复操作资格，不要求产生额外业务事件。历史暂时 loading 保留只读 Context/授权事实；实际失败才清除相应事实。

历史校准的 loading／complete 继续撤销／恢复消息文件入口；共享 [MessageContent](../../packages/ui/src/desktop/MessageContent.tsx)现通过私有 Context 只更新链接能力，未变化的完整正文不重新解析 Markdown。Main的当前scope／消息／路径准入、完整基线的固定高水位与EOF及业务发送门禁保持；普通增量不再逐次撤销基线完成资格。原 Markdown 与相邻完整 reader／transcript 文件保所有断言；原 75秒 driver／90秒整例的真实 Native 窗口核5051条及超过8MiB全文、失败保正文与禁写、迟到切换、两次物理SSE缺口、live rename、Provider0和所属Service自然退出。当前准确范围与默认集成结果归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11native-完整历史校准与正文解析)；不跳过 metadata 原seq更新，也不据局部窗口关闭资源、平台或阶段门禁。

[历史 reader](test/native-history.test.ts)、[main 原游标缩页](test/native-caller.test.ts)、[ready-only 恢复](test/native-refresh.test.ts)首次组合为 13 项、81 条断言；[实际长历史窗口](test/isolated/native-history-electron.test.ts)读取 5001 条显式隔离库历史记录和额外超过 8MiB 的多消息正文，验证完整尾部、失败保正文与禁用发送、重新读取及迟到切换，Model 调用为零，首次另有 13 条 Node 断言与所属 PID 清理。记录通过 fixture 直接存入隔离库，未伪造 5001 次 Provider 执行。原 Context 窗口复验保留全部 15 条 Node 断言；压缩窗口在真实可操作门禁就绪后继续键盘 Enter，保留全部 33 条 Node 断言与四次兼容 SDK 调用，两个所属 Service PID 已停止。这些证据仍是 macOS 开发窗口切片。

2026-10-09 的原完整默认暴露完成轮次默认折叠后旧 driver 未展开的断言错误；driver 现沿真实“展开本轮处理过程”入口继续原计数与正文断言，原页面、driver、整例期限保持。随后原重载期限仍实际失败；当前 reader 完整文件 4 项／22 条断言核快照保留、失败前缀及切换缓存，Main 完整文件 14 项／146 条断言核固定高水位读至 EOF、后页复用已验证大小和新读取重置。独立审查核并发学习值只缩小、旧读取不能回写。真实历史窗口与完整默认的准确状态归[普通制品收束进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09普通制品图标依赖收束)，局部通过不代证窗口重载或阶段退出。

2026-10-02 在 macOS/Bun 1.4.2 当前工作树执行 `bun test apps/desktop/test packages/ui/test/isolated/permissions-dom.test.tsx`，最终完整组合为 34 文件、76 项、509 条 Bun 断言，全部通过（约 111 秒）。包括 >17MiB 原作用域输入/输出、Context、授权、私有冷草稿、管理、压缩、活动刷新和新增长历史窗口；各真实窗口仍独立核对所属 Service 退出。首轮组合曾失败于暂时历史加载清除 Context 事实，以及 fixture 在 disabled 按钮直接发送 Enter；前者已修复为 loading 保留只读事实，后者等待原 actionability 后继续原键盘动作，原断言和期限保持。Desktop typecheck/build、11 个归属代码文件 Biome、文档结构/影响及测试归属/统一边界检查通过。该结果不改变正式入口和跨平台资格的未完成状态。

当前输入模型选择要求实际 enabled/configured 目录。[原 Context Service 夹具](test/native-context-service.fixture.ts)为其固定 adapter 提供准确 Store/Workspace 的只读 `fixed` 目录，配置修改入口明确拒绝；[窗口 driver](test/native-context-electron.fixture.ts)两次新轮次等待按钮实际可点击。原四请求、一次 ledger 效果、idle Rewind、active Include 与下一 Model checkpoint 的准确来源、无 Job 重放、页面刷新零新增请求和所属 PID 退出断言保持。该夹具适配不改变生产模型就绪门禁；有限窗口1项4条Bun断言及15条Node断言通过，当前完整默认结果另见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)。

[后页 child](test/interaction-pages-child.fixture.ts)和[持久答复 child](test/answer-journal-child.fixture.ts)按同一原 Store/Workspace 的只读目录装配，两个原 driver 的首次发送等待实际按钮可点击；模型事件、权限与所有原期限保持。原后页窗口复验仍完成40个原 Job、40次效果和零取消，原持久答复窗口仍核原全文/身份/digest、POST前SQLite提交、丢原回执、两个Main生命周期、冷原GET两次/POST零次与effect once。源码与新回归符合当前目录合同；第六轮后页现场曾显示run admitted，不能将有限复验通过追认为旧0卡的完整因果，详细范围见进度。

当前[原后页 driver](test/interaction-pages-electron.fixture.ts)先打开既有“会话工具”，再等待实际“下一页待决请求”；原完整步骤、断言与期限不变。同一完整文件1pass／3Bun断言通过，20卡替换、关闭／切换撤销旧读取、后页原回答丢回执后只查原申请、40次效果与零取消均核实；这项正式导航适配不改变待决窗口或回答权限。

## Native 提供商与模型设置

模型页不再挂载已确认提交的历史区，不展示 Store、模型 route、commandId 或 phase 的原提交摘要。当前失败仍由原提示处理；只有结果未知的更改显示简短说明和“查看结果”，按钮仍查询原 commandId，不重发保存。正常保存期间模型开关保持可用；实际失败、未知结果及只读仍沿原保护处理。

[模型面板](src/native-model-settings.tsx)与 [Main 配置观察](electron/configuration.ts)通过公共 getModelSettings 固定读取 user scope，不传 Workspace 或路径。唯一生产源为 ~/.kite-code/kite-code.jsonc，现有 provider/model/disabledModels 由 [Service 用户源](../service/src/user-configuration.ts)适配；Profile 和项目不提供模型覆盖。空闲挂载、关闭重开和会话/宿主 generation 改变时自动读取；同作用域尚有保存队列时重开复用原 controller，观察通知或提交状态重绘不制造读取循环。自动重读及异常重试只 GET 本地配置，不发现远端模型或读取凭据。统一页不挂刷新或异常重新读取按钮，也不保留对应容器、焦点回退或忙碌状态；错误与配置诊断继续显示，临时异常按250／1000／3000／10000ms退避重新GET，后续封顶10秒；取得有效事实后自动恢复。当前Store的unknown（含冷journal行）在页面活动时自动原ID GET，模型已接受热提交的未知结算可在关闭设置后继续，提供商页的读取与核对重试在关闭时停止、重开后继续核对原记录；不重发POST、secret或发现请求。2026-10-25移除异常按钮后，模型／提供商与统一页DOM100项／1423断言、Desktop类型和定向Biome通过；宽窄深浅四组合浏览器共12536次采样／2150帧，无页面错误。已观察明确失败和续读冲突时按钮与占位均缺席，关闭重开仅GET恢复，未新增保存或重发旧尾部；未知结果仍查询原ID。浏览器证据范围沿用匿名Main／生产UI夹具。

[统一设置页](src/native-provider-model-settings.tsx)组合[连接面板](src/native-provider-settings.tsx)与[模型 hook 和片段](src/native-model-settings.tsx)，导航只保留“提供商与模型”。模型行已移除“默认”badge及专用CSS。统一页直接展示提供商列表；连接按 `connection.modelIds` 与模型 `id` 精确匹配、去重展示，未归属条目留在“其他模型”，不按名称或地址猜测归属。自动接入的只读连接仍可管理模型偏好。沿用原 settings-models CSS 与 checkbox switch，禁用/配置不完整模型保留；模型行同名时附准确 route ID。开关乐观更新，明确失败恢复原值并撤销写资格；成功刷新原观察并通知输入区。默认模型与其他模型一样可禁用和重新启用，也允许全部关闭；Rows、串行queue与Main没有默认禁用特判，原默认ID不自动改写。2026-10-25，本轮Desktop Main／模型DOM／Picker／统一页四文件121项／1460断言通过；Service模型管理／后继证明／提供商三文件35项／626断言通过。Desktop与Service类型、定向Biome、文档、边界和测试归属检查通过。生产UI／真实Main匿名浏览器夹具宽窄深浅四组合共15387次采样／2707帧，无页面错误；每组合真实关闭并重启默认B，两个独立POST严格使用fresh read-set及postReadSet，默认ID始终为B，行节点与焦点／滚动保持。每组合Model最终12POST（含setup）、Provider1POST、原IDlookup1次，未重放旧意图。活动默认A在禁用后仍同Run连续调用A并完成、零取消，以及全禁／重新启用／新运行拒绝与不回退由[Service回归](../service/test/isolated/configuration-management.test.ts)单独证明；匿名浏览器不代证实际模型执行或安装版资格。读取和编辑均不发送任务或重建 Session，返回应用保留原输入实例和草稿。

[连接模型目录](src/native-connection-models.tsx)使用共享 Popover，不在卡片中展开全部开关。连接列表按行排列，提供商项通过 container query 调整标题与操作布局。浮层由“管理模型”入口锚定，开合不改变提供商列表布局。摘要统计准确归属的总数与启用数，初次模型读取期间显示读取状态。浮层按模型名称 `model` 做不区分大小写的子串匹配，匹配范围限于本连接或“其他模型”原目录，模型 ID 仍用于归属、行身份及保存。搜索输入变化时重置内滚动，关闭浮层时清空搜索。打开、搜索、关闭与滚动均不触发配置写入。Popover portal明确挂入当前 `.desktop-settings` 内，避开卡片的 container query 和内容滚动裁剪，保留设置 Dialog 的主题与焦点范围。浮层宽度取入口宽度和 320 px 的较小值，并受窗口可用宽度约束，沿 Radix 碰撞定位调整方向与边距。入口左右内边距10px，浮层内边距4px，模型行左右内边距12px；列表容器不再单独增加右侧留白，模型名与开关距浮层边框均17px（含1px边框）。顶部搜索框固定，共享 ScrollArea 的 viewport 采用 scroll-fade-y，最高 320 px，并按浮层可用高度进一步收缩，紧凑行最小44px，长名称和诊断可换行。连接、目录和模型以原准确身份保留，浮层内开关保存及后台事实刷新保持当前搜索、模型行、viewport 与滚动位置；模型启停后继续显示原行；正常保存及其续读期间保持开关焦点；真实保护状态禁用开关或后台事实刷新移除该模型时，将焦点移回可滚动列表且不改变阅读位置；打开时聚焦搜索框，Esc仅关闭浮层并恢复入口焦点，外部点击关闭保留实际点击目标的焦点。统一入口仅挂载独立 `NativeModelSettingsFeedback` 呈现模型读取错误与未知提交查询，普通状态不占位；旧独立模型组件保留原兼容测试，不挂入统一页面。没有增加批量修改、远端目录读取或配置权限。

2026-10-25，大模型目录与栅格布局在同一 macOS／Bun 1.4.2 工作树通过五个设置 DOM/Main 文件93项／1267断言及完整 NativeDesktop DOM 82项／1689断言。上述既有浏览器夹具的 `settings-models` 场景使用60模型连接、20模型连接和1条独立模型，核1100／550px与深浅主题四组合，共8064次过程采样／1267帧，无页面错误、重复路由行或横向溢出。宽窗两卡同排、窄窗单列，两目录各自320px滚动且工具栏位置不变；首中尾fade、搜索空结果、状态筛选后键盘启停与焦点恢复、默认菜单搜索及键盘选择均核实。各组合仍为连接保存1次、模型保存3次、原结果GET查询1次，未知关闭重开不重发，原会话节点和四次读取保持。该证据使用生产 Native UI、真实 Main manager及匿名内存传输，不包含真实 Service、凭据库、远端模型或安装版持久化资格。

2026-10-25，按确认需求移除统一页顶部整块默认模型卡片及其留白，模型反馈片段独立保留。现有模型／连接DOM整文件76项／1013断言和统一页7项／137断言通过；浏览器四组合7587次过程采样／1240帧中，默认卡片、选择器与搜索控件始终为零，标题到目录间距均28px，栅格和目录交互保持。原默认变更仅经既有封闭IPC作为隔离测试setup，不代表统一页仍提供该控件；每组合明确区分UI连接保存1次、UI模型启停2次与setup默认变更1次，原结果查询1次。真实Service／凭据库和安装版持久化仍不在该验证范围。

2026-10-25，模型管理浮层改造通过模型／连接DOM整文件78项／1037断言、统一页7项／182断言和完整NativeDesktop 82项／1699断言；Desktop与UI类型、定向Biome通过。现有浏览器场景核1100／550px、深浅主题四组合，并各自切换480px短窗口，共9179次过程采样／1348帧，无页面错误。浮层开合及切换保持卡片／栅格几何不变，真实输入与开关可操作；portal位于设置内且不在卡片／内容滚动区，无inert或aria-hidden祖先。正常列表320px，短窗口按可用高度收缩，无裁切或横向溢出；底色与实际卡片一致且完全不透明。Esc关闭后焦点返回入口且设置仍打开，外部点击关闭和连接切换不串模型；原60＋20模型、unknown查询、一次提交和草稿／读取生命周期断言保留。验证使用生产UI／Main与匿名内存传输，不包含真实Service、凭据库或安装版宿主资格。

2026-10-25，移除模型状态筛选后，仅保留全宽搜索和逐项启停，相关模型／统一页DOM共28项／439断言通过。浏览器四组合及480px短窗口共8950次过程采样／1371帧，无页面错误；浮层无select／combobox，搜索框占满394px工具栏。实际Space启用期间开关暂时禁用导致焦点落body的问题已复现并修复，pending与applied期间均保持搜索框焦点、原模型行／viewport及内外滚动位置；未增加写入，原未知结果查询和会话读取断言保持。Desktop类型与定向Biome通过，验证仍限生产UI／Main和匿名内存传输。

2026-10-25，按确认需求移除管理模型浮层的搜索框、匹配逻辑和工具栏，仅保留完整模型列表及启停开关。模型DOM20项／246断言、统一页7项／186断言和完整NativeDesktop 82项／1701断言通过；Desktop类型及定向Biome通过。浏览器四组合与480px短窗口共8685次过程采样／1362帧，无页面错误：搜索、筛选、工具栏及额外按钮均为零，无旧分隔线或占位；浮层420×346px、列表上限320px。真实60项列表末尾启停时，pending与applied均保持模型行、viewport和列表焦点，内滚动2320→2320、设置页0→0；原一次提交、未知结果查询、关闭恢复和草稿／读取断言保持。验证仍限生产UI／Main与匿名内存传输。

2026-10-25，浮层等宽与内边距调整通过四组合及480px短窗口浏览器验证，共8773次过程采样／1385帧，无页面错误。宽窗触发区与浮层均348px、窄窗均288px；入口左右10px，模型名左侧与开关右侧均距浮层17px，短列表无单侧额外留白，长列表实际thumb与开关间隔4px。原滚动、焦点、边界、未知结果查询及会话读取断言保持；Desktop类型、定向Biome通过。样式调整不改变配置写入合同。

2026-11-13，在 Windows、Bun 1.4.4 和 Chrome 上验证名称搜索与浮层收窄。以 `85088d9b8` 加本次改动运行[模型](test/isolated/native-model-settings-dom.test.tsx)、[统一设置页](test/isolated/native-provider-model-settings-dom.test.tsx)和[应用交互](test/isolated/native-new-conversation-dom.test.tsx)的 DOM 回归，191 项通过。沿用[浏览器夹具](test/native-live-tool-aggregation-browser-runner.fixture.ts)的 `settings-models` 场景，定向观察生产 renderer、Main 和匿名内存传输。1100 px 窗口中入口宽 770 px、浮层宽 320 px，550 px 窗口中浮层收至 244 px。两种宽度和深浅主题共观察 16,122 次状态采样和 1,929 帧，另切至 480 px 高窗口核对可用高度。逐键筛选、无结果、清空、关闭重开、键盘启停、保存续读和原 ID 查询恢复均通过。完整浏览器场景在批量保存队列的预期提交数断言失败，使用原开关交互也能复现。

[模型队列](src/native-model-toggle-queue.ts)将开关交互资格 `canToggle` 与严格写资格 `canWrite` 分开：本队列正常 POST、自有续读与异步提供商核对期间保持模型行可操作，同模型未派发意图合并为最后值，已派发 head 不变，不同模型按入队顺序串行保存。队列持有同作用域的共享写锁，连接保存不能插入；普通 Provider 读取不阻断本队列，但 foreign submitting、unknown、权限丢失继续阻断。明确失败、未知或续读冲突清空未发尾部，恢复已确认值，不重基旧意图。已applied后的明确暂态网络读取错误仅退避重试原afterCommandId，原scope／proof仍由Main逐次核实；期间保持healthy、写锁和意图合并，证明一致后可继续原队列。proof变化、身份失效或诊断只读不能沿该路径续写。普通恢复GET只开放新点击，不恢复旧尾部；未知只自动查询原commandId，确认为applied／failed后再普通GET。

Service 为 applied 模型更新回执持久保存准确 `postReadSet`；[Main](electron/configuration.ts)仅接受同一热提交、Store、generation 与完整选择身份的 `afterCommandId`，核下一次 GET 四字段与该证明完全一致后生成新 observation。动态模型来源变化或外部写入导致不一致则停止队列，不把普通 GET 当成旧 CAS 的重试依据；renderer 不接收原 readSet。历史无证明回执和冷 journal 仍能查询原结果，只能普通读取恢复，不能续接旧队列。

保存响应和状态通知同时缺失时，先只读查询Main现有state，核generation、Store、准确observationId与完整非秘密operation，只有唯一匹配原记录才取得commandId；无ID、foreign或歧义不会猜测、普通GET也不能解除未知锁。自动恢复与原保存结果通知分别处理。Model和Provider只在“需要恢复→有效新事实”的边沿刷新对端，正常GET不互刷；提供商保存成功后的刷新强制取得发布后的新观察，不复用较早在途GET。自动lookup不借调用当下的editorVersion关闭后来打开的编辑器，不回填或重基草稿；只有原applied结果通知一次onSaved，failed恢复不冒充保存成功。关闭旧页后的原查询若通过 Main watcher 在重开页确认终态，只处理本页先前观察到的同 Store、commandId、observationId 和 operation；强制新 GET 同步连接及模型，重复／历史／外来终态不触发互刷，旧编辑草稿保持原资格且不重发保存。自动重试保留旧错误直到读取成功，避免重试期间反复闪现。准确只读但无诊断的事实停止轮询并继续只读；权限、身份或私有journal错误停止当前恢复，不能凭旧事实放权。

controller 生命周期独立于设置组件，常规页不读取模型配置，切换分类不会修改模型队列的 observation。关闭设置移除订阅但继续保存已接受队列；同 bridge 与完整 scope 重开复用活跃 worker，不额外启动普通模型读取。空闲普通 reader 关闭即取消释放。切换 scope 清除旧的未派发尾部，迟到回执只完成原提交，不替换新页面事实。关闭窗口或退出进程后的恢复仍沿原 journal／unknown 合同，不宣称内存队列跨进程保存。

2026-10-25，自动恢复最终七文件组合258项／3942断言通过（macOS／Bun1.4.2当前工作树），覆盖实际Main原记录、bad／empty回执、无watcher状态找回、无ID关闭重开、shared pending硬锁、冷原记录／foreign拒绝、proof网络重试与冲突分支，以及原NativeDesktop。Desktop类型、定向Biome、文档、统一边界和测试归属检查通过。同轮生产UI／真实Main匿名浏览器夹具在1100／550px深浅四组合通过，共13291次过程采样／2218帧，无页面错误；Provider读取失败在同页自动恢复且模型尾部继续，unknown只查原ID，known failed／foreign恢复不新增POST，恢复后只有新点击产生新POST。每组合正常5次串行保存、最大写并发1，最终Model10次（含默认setup）、Provider1次、原ID lookup1次；焦点、行与viewport、2320px滚动及General独立读取／草稿／4次会话读取保持。漏watcher及坏回执分支由上述DOM／Main回归覆盖；浏览器使用匿名内存Client数据，不代证真实Service、付费模型、钥匙串或进程冷启动资格。

2026-10-25，连续启停通过模型与提供商 Main／DOM 四文件118项／1436断言、统一设置9项／252断言，以及完整 NativeDesktop 82项／1705断言。后者首次在受限沙箱中仅真实 HTTP 用例因 loopback 绑定被拒，允许隔离本地服务后原82项通过。Service／Client／journal 四文件29项／607断言覆盖后继证明、动态来源与完整 read-set 冲突、冷原结果和活动 A 禁用后的 A、A、B wire；不访问付费 Provider 或用户凭据。Desktop类型、统一API生成、边界与测试归属检查通过。

同轮生产 Native UI／Main 的匿名浏览器夹具核1100／550px、深浅主题四组合，共11825次过程采样／2033帧，无页面错误。每组合正常连续操作最终仅5次串行 POST，最大并发1，未发同模型意图合并；每次后继 GET 精确核原回执 proof。关闭设置后继续排空，同作用域重开不启动额外普通模型 GET；自有 GET 与 Provider flush 中继续切换，最终状态对应最后选择。逐帧与 Mutation 记录确认正常阶段开关无临时 disabled，焦点、行／viewport身份与2320px阅读位置保持，队列结束不再因 Provider 读取状态晚到把焦点移回列表。unknown、明确失败和 foreign read-set 各仅原 head 写入，尾部不重发，明确原结果查询／重新读取仅 GET；原浮层等宽、内边距、短窗口边界、会话与草稿断言保留。浏览器部分使用匿名内存传输，不代表真实凭据、远端模型或安装版宿主资格；活动 Run 边界由上述真实 Service 回归验证。

2026-10-25，移除常驻刷新后，统一页与完整NativeDesktop联合89项／1905断言、原模型／提供商DOM77项／1042断言通过；Desktop类型及定向Biome通过。宽窄深浅四组合浏览器9003次过程采样／1507帧中，Header刷新／重新读取控件始终为零，健康与unknown路径保持；原关闭重开两侧GET各一次、准确写入次数、模型浮层滚动及草稿／四次会话读取断言保持。上下文读取失败恢复另由DOM核实GET期间同节点禁用、成功隐藏且不重发POST；普通只读无恢复按钮。验证仍限原Native UI／Main与匿名内存传输，不包含真实Service、凭据库或安装资格。

统一页以同作用域同步写锁拒绝同一事件循环内的交叉提交；连接或模型提交、读取及未知状态沿各自原门禁处理，任一未确认提交阻止另一侧新写入。任一侧 applied（含查询原结果）后重读自身并刷新另一侧，读取失败保留错误并后台重读，不重发保存。提供商GET恢复与模型保存分离，普通提供商GET失败不再使模型队列停工或丢尾。两侧合并本地与宿主提交状态时保留已确认的终态，避免迟到 unknown 再锁住页面。连接编辑保留原读取集，模型保存触发的刷新撤销旧草稿资格，不能借新事实继续旧提交。关闭设置期间模型队列保留共享写锁直至排空；选择作用域变化停止旧尾部，Main 的原提交、CAS 与用户级未知互斥仍独立生效。

Main 将用户配置目录加入文件打开和 Git 分支切换的 protected roots；目录尚未创建时按最近存在祖先固定目标，首次配置前也保留保护。

封闭 IPC 拒绝 workspace 模型读取；Main 保存原 Store、选择代次、完整 read-set 与 commandId。用户级未知提交阻止其他会话/项目新保存，空闲关闭停止所属 GET；活动模型队列关闭后继续保存，不取消原提交。未知仅查询原 ID/Store，不重发；历史 journal 中旧 workspace 原意图仍可核实，不能成为新的项目写入口。Service 以用户文件准确字节 ETag 和完整 read-set CAS 发布；字段/注释保留与 key 隐私由该源负责。renderer 不接收 URL、credentialRef 或原 snapshot。输入区、准备页与常规卡均消费相同用户级列表；Session 临时下一轮选择继续独立。

[隔离模型 DOM](test/isolated/native-model-settings-dom.test.tsx)覆盖自动加载、分组/同名路由、默认过滤、真实菜单/开关、保存/失败恢复、未知查询、迟到隔离及空/坏配置。[完整 NativeDesktop DOM](test/isolated/native-new-conversation-dom.test.tsx)经普通用户菜单进入统一设置页并核关闭重开、原草稿和零任务发送。[Main 配置](test/native-configuration.test.ts)、[Provider](test/native-provider-settings.test.ts)与 [Service 实际用户源](../service/test/isolated/user-configuration.test.ts)、[真实模型请求](../service/test/isolated/run-model-selection.test.ts)分别核封闭 scope、原 CAS、单用户文件兼容、跨 Profile 以及真正 wire。当前 Windows 有限回归见此次交付结果；OS vault、macOS 四个窗口 driver 与正式安装资格未因单元/DOM 通过而取得。

2026-10-25 macOS／Bun 1.4.2，合并入口的工作树通过五个设置 DOM/Main 测试文件88项／1147断言，完整 NativeDesktop DOM另82项／1687断言。[统一页集成回归](test/isolated/native-provider-model-settings-dom.test.tsx)覆盖首次读取顺序、精确归属与去重、双向刷新、同事件循环互斥、旧草稿撤权、未知结果查询及刷新失败恢复。既有[浏览器夹具](test/native-live-tool-aggregation-browser.fixture.tsx)和[driver](test/native-live-tool-aggregation-browser-runner.fixture.ts)的 `settings-models` 场景使用生产 Native UI 和实际 Main 设置 manager、匿名内存传输与 journal，覆盖1100／550px、深浅主题四组合，共5079次过程采样／773帧，无页面错误、模型行重复或横向溢出；各组合核实连接保存1次、模型保存3次、原结果查询1次，未知关闭重开不重发，原草稿和会话节点保留。该证据不包含真实 Service、系统凭据库、远端模型或安装版持久化资格。

模型保存applied后仍须完成本面板的自动刷新，期间模型启用开关保持disabled。上述DOM整例以保存后的真实刷新promise固定该窗口，刷新完成后才恢复可用。MCP整窗口driver在相关配置控件恢复后才发原直接配置读取，避免与面板共享reader的自动刷新竞争；不增加sleep、外围重试或页面/整例预算，也不改变生产读取或错误提示。原失败trace只证实直接读取发生在控件仍disabled时，具体GET取消码未留存，配置已实际保存的事实保持。

2026-10-15 Windows x64／Bun 1.4.2／Electron 44.3.0，通过 `bun run desktop:dev` 启动实际窗口，从“个人工作区 → 设置 → 模型”进入后，无须刷新即可读到用户 `~/.kite-code/kite-code.jsonc` 的两个 Provider、五个模型和原默认项。实际禁用非默认模型、切换跨 Provider 默认项后，逐次核对用户文件；菜单正常退出并重新启动，模型页自动读回关闭状态和新默认项，禁用模型不出现在默认菜单。随后通过界面重新启用并恢复原默认项，最后以原文件 SHA-256 核对准确字节恢复；其他配置字段未变，旧用户 Profile 及开发 Profile 的 `config.jsonc` 均未生成。私有备份和临时验证脚本已清理。此实测仅覆盖当前 Windows 开发客户端的模型读取、保存与冷启动，不包含真实 Provider 执行、OS vault 写入或正式安装资格。

原基础、模型、Provider、MCP 窗口 driver 已适配自动列表、开关和默认菜单，并沿各自自有配置文件/用户 HOME 运行。此前 macOS 两模型窗口的 held A/下一 Run B、一次原未知查询、外部编辑 CAS、冷读与所属退出记录仍见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md)；这些历史通过不代表当前 user-only driver 已重新执行。

Desktop 私有 SQLite 使用与 Core/维护相同的 profile 共享锁。[Node profile access](electron/profile-access.ts)只打开 Service 已初始化的原 `profile-use.lock`，不创建新的命名空间或替代锁；[一次性 Bun helper](electron/profile-access-helper.ts)通过公开 `@kite-ai/agent/profile-access` 校验继承 fd、原路径与恢复 journal，再取得 POSIX shared flock。helper关闭自己的描述符并退出后，Node仍持有原打开文件描述的锁；没有常驻 Service 或源码/PATH 回退。[私有构建](scripts/build-native.ts)打包固定相对 helper 与 SHA，main同时验证 helper 与固定 Bun 身份。该继承 fd 实现限定 macOS/Linux POSIX，本轮实测为 macOS；Windows失败关闭，不宣称 Windows 生命周期资格。

[私有库](electron/private-data.ts)要求本模块实际取得的有效生命周期句柄；伪造、已关闭、重复附着或不同 profile 的句柄拒绝打开。SQLite成功关闭之后才关闭 Node 原 fd；关闭失败保留句柄与锁并报告失败。初始化检查失败关闭已打开数据库与句柄，未知格式、损坏原文和不安全文件仍不建空库替代。main退出先停止自己的调用者，再关闭私有库，最后清理所属 Service；Service意外退出不释放Node私有库的共享权限。renderer attach或Service失败仍可显示只读诊断，不能扩大为私有库创建权限。

[真实 Node 私有库测试](test/isolated/private-data.test.ts)保留冷读、双进程CAS、分页草稿与坏文件原字节断言，并增加真实 helper 对维护 busy/未完成 journal 的拒绝且不建UI库、有效句柄资格、SQLite关闭失败保锁与关闭顺序验证。[实际 Electron 锁窗口](test/isolated/native-profile-access-electron.test.ts)核对真实 Service SIGKILL后UI仍活且维护立即busy、另一profile可备份、UI正常退出与Node SIGKILL后原profile可维护，以及维护持锁/未完成journal的启动诊断不创建空UI库；窗口16条Node断言，Provider为零。所有构建、profile与进程仅属于隔离临时fixture，不使用共享dist。

profile 生命周期锁接入后的最终完整 Native/共享权限组合实测为38文件、83项、574条Bun断言，全通过（127.46秒，2026-10-02）。新profile锁窗口保留16条Node断言，模型设置窗口保留27条；完整历史、超过17MiB正文、Context、授权和压缩原断言均保留。前一轮唯一失败是压缩fixture末次无点reset只读查询时合法返回accepted、Run尚未可见，却只等待completed；fixture现在在原10秒期限内仅按同一commandId/Session继续GET核实，不再次POST或更换意图，压缩窗口最终35条Node断言通过。Desktop类型、私有构建及本切片格式、文档结构/影响、统一边界和测试归属检查通过；该结果仍为macOS隔离开发制品资格。

[实际长历史窗口](test/isolated/native-history-electron.test.ts)进一步通过真实SSE断开与HTTP410重连验证缺口恢复：fixture暂停所属网络重连并推进隔离库replay_floor，真实Client完成reset、原Store完整分页重读与新ready。两次缺口覆盖5051条/超过8MiB正文、重读期间正文保留且禁写、切换隔离与迟到页拒绝、恢复后实际rename/SSE标题更新；新增三次HTTP写各一次，Model/Provider零调用、原Run不增。当前45条Node及6条Bun断言保留原13条窗口断言，所属Service退出已核实；仅证明macOS开发制品中的实际恢复链，自动retention调度和其他平台资格另计。

原完整默认的一次历史窗口在完成上述业务后，等待 Electron 退出超过原75秒 driver预算；原红仍保留。fixture 仅增加所属 Electron exit／close、Playwright close及 Main before-quit／will-quit 的有限时间观察，原断言、await和75／90秒期限不变。独立原整窗口一次自然退出需4.217秒、code0／无signal，原Service已dead／双流EOF／Provider0；此前超时开始退出时仅余2.396秒，现有证据不足以确认旧现场的内部退出原因。未据此改变生产关闭逻辑或放宽门禁，实际集成结果归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-11默认-task-完整回归的父子时序)。

Native 显式恢复由 [main owner](electron/recovery.ts) 与 [renderer 面板](src/native-recovery.tsx) 实施有限 `prepare/submit/lookup/close` IPC。用户明确输入原 Run 或原 `job.report` Command ID；interrupt 必须明确勾选确认。main 读取实际根 Session、Store 与原记录，冻结原 ID 和原 Run 的 `originCommandId`，生成恢复 Command ID，并调用公开 SDK 的 `resumeRun`、`resumeJobReport` 或 `recoverSession`。renderer 只有 DTO 与不透明 observation/read ID；它不拥有 profile、token、Runtime 或 execution owner generation，也不从窗口中的有限 Run 列表推断恢复目标。纯 decoder 与原结果 Run 的 Store/Session/origin 核对共同验证回执；`resumed` 表示已核实恢复受理与原绑定，Run 完成仍须读取实际状态。

面板 scope 切换同时清除旧恢复读取、确认、busy 和错误，保留来源明确的已保存原申请；A 的已显示准备错误不能留在 B 的标题下。现有 epoch 隔离迟回，关闭原 read ID 只结束读取，不提交或取消恢复。新增 [实际 ReactDOM 回归](test/isolated/native-recovery-scope-dom.test.tsx)在旧 production 下核真实失败，再核切 A→B 清旧 alert、保 saved originals、B 当前失败继续显示；另核切换关闭准确 held read ID、迟回零事实/刷新/submit/cancel。它不改变 Main、私有格式或退出生命周期，也不代证自然 HTTP 故障、截图安装包版本或整窗口资格。

[私有 UI 数据库](electron/private-data.ts) schema 2 增加有限 [恢复意图 journal](electron/recovery-journal.ts)，在现有真实 profile 生命周期锁、私有路径检查、`synchronous=FULL` 与 `BEGIN IMMEDIATE` 边界内先保存原 Store/Session/target/original Command 及 main 生成的恢复 Command，再发 POST。schema 1 自动迁移保留原草稿与会话创建意图；未知 schema、损坏文件或坏意图不回退空库。journal 是 UI 请求身份记录，不是 Service receipt 或执行权限。最多 128 项未决恢复；当前进程最多 128 项意图，超界拒绝且不丢弃 unknown。同一 observation 共享原 Promise/Command，一次 POST；丢失或坏回执保留 `outcome_unknown`，不自动重发或自动查询。独立 unknown/accepted 阻止同一实际 Store/Session 的新恢复提交，其他 Session 的意图保持独立。

Native 重开或 main SIGKILL 后，持久 `submitting` 转为 unknown，未决原 ID 只通过显式 `lookup` 做原 Command GET。关闭读取、切换或迟到回应只释放该读租约；不会取消 Run、重发恢复或覆盖独立 unknown。查询已 applied receipt 不重新安装另一次进程崩溃丢失的热绑定；若又发生真实 orphan 边界，必须先核实原意图，再由用户 prepare/submit 新的明确恢复。已知终态不能被迟到读取降回 unknown；未知副作用仍由 Service 原闭包保护，interrupt 回执里的 unknown Execution 不被宣称完成。

[owner 反例](test/native-recovery.test.ts)、[实际 Node 私有数据库](test/isolated/private-data.test.ts)与[真实 Electron 恢复窗口](test/isolated/native-recovery-electron.test.ts)覆盖原 Run/report 身份、明确 interrupt、重复提交、晚回读取消、unknown 封闭、冷 journal、原回执查询以及原 Ask 卡继续。窗口使用显式 SHA 核验的 Bun/Service 制品、所属 profile、真正 Node Playwright main/preload/renderer；实际物理回应断 socket、坏回执与 main/所属 Service SIGKILL 分别保留原命令。report fixture 读取原 Task/child carrier/report，原模型完成不重复，恢复生成 Run 的 `originCommandId` 是原 report Command。此资格仍是 macOS 本机隔离开发窗口，不代表正式安装或 Linux/Windows Electron 资格。

Native 普通 Work 与准确单 Job 停止现在通过 [main caller journal](electron/caller-journal.ts) 和现有 [输入 owner](src/input.ts) 保存完整的五类公共请求：`run.start`、`input.steer`、`input.follow_up`、`command.cancel`、`execution.cancel`。[私有库](electron/private-data.ts) schema 3 在事务中迁移 schema 1/2，保留原草稿、创建与恢复记录，新增 `caller_intents(command_id,state)`。每行闭合保存原 Store/Workspace/Session、认证 subject、完整请求与准确目标、本地完整正文 SHA 和公开 canonical request SHA，可独立附加原草稿 identity/revision/text SHA；不保存 token、lease 或执行 authority。合法 `afterRunId:null` 保留原值，steer/follow_up 都核实当前 contextSelectionId，不能借当前 Run 改写原目标。

普通输入的应用查回先核原公开请求身份，再经共享 Client 查回器读取真实 business Command、Run 和观察 Model。公开 ID 与业务 Run origin 可不同，准确同 Run 补充仍保原 origin；已封存的独立工作不再受原技术 steer target 约束。旧技术 steer 的 target/selection 校验、取消和扩展执行校验保持。只读观察不投影成业务完成，待澄清输入保持 accepted；完整边界归[输入 owner](src/input.README.md)。

私有 caller journal 最多 128 行，原 UTF8 state 文本聚合最多 16MiB；这是本地 UI 私有容量，不能裁正文、驱逐 unknown 或变成服务端 task quota。真实 profile 生命周期锁、私有路径检查、`synchronous=FULL` 与事务提交在首次 POST 之前完成。只有本次新 prepare 得到的完整冻结热意图可发送一次；已存在或冷 `submitting` 行只能查原 Command GET。坏文件、容量、缺本地意图及错误 Store/Workspace/subject/body/target 全部失败关闭；known 不能被晚到失败降级。查询和关闭不会补 POST，取消输入保存准确原 Command 的独立 cancel 请求；停止 Job 先读新鲜实际 Execution，不从父 Run 或另一个 Job 猜目标。

[renderer 原申请面板](src/native-caller.tsx) 只接收有限 metadata 和具名 prepare/submit/original lookup/list/known clear/full-body reader。NativeState 不带累计完整请求。普通 IPC 保留 1MiB 请求与 4MiB 回应预算，只有完整 caller prepare/submit 请求采用独立 16MiB 上界；正文 reader 固定原 Command/read ID、SHA 和连续游标，按页传输，核实完整 EOF/UTF8 字节数后展示。读取关闭、切换和迟到页不能改另一意图。`applied` 仅是原申请回执事实，`cancel_requested` 不是 Job 终态，原业务 controller 继续观察实际 Run/Execution。回执或冷 lookup 不清后来编辑的草稿，也不修改单次 Plan/Workflow envelope。

[实际 Node caller](test/isolated/native-caller-journal-host.test.ts)使用真实配套 Service、SDK、Node SQLite、物理 POST/首 GET socket 丢失和 producer SIGKILL，核对五类原请求只有一次 POST、冷只查原 ID、Core Command 仅一条；另核 prepared 零 POST、空 afterRun 的 stale selection、hot body drift、原 subject/body/Workspace drift、128 槽满与损坏行 before-POST 拒绝。[真实 Electron 窗口](test/isolated/native-caller-electron.test.ts)通过 main/preload/renderer 与实际 owned Service/main SIGKILL，读回超过 1MiB 的合法完整 Workflow envelope，并保留 CRLF/中文/emoji/combining、单次 Plan、后改草稿和原 SHA/EOF。大 Workflow 输入中的未配置 skill 按实际 Service 拒绝，不能称业务 Workflow 完成。双 Job 窗口使用当前 `shell_execute(background:true)` 和实际 Shell Service；切换装配后通过正式权限接口确认新增读取范围的工作区信任，核准确 Store／Workspace／Session／Full 与回执，不借旧 Files-only 信任记录越过范围变化。原父 Run completed 后只取消准确一项，另一项在崩溃前仍 running 且零取消；冷开会按原生命周期核实遗留执行，unknown 不重放。它不授默认任意 Shell 或 Workflow verifier 资格。维护 manifest v5 的严格 Desktop DB3 备份/恢复由 Core owner 单独验证；旧 manifest 不扩展接纳新 DB。

原审批恢复准备由[共享恢复夹具](../../tests/README.md)拥有自定义 checker，不能把 Files-only 的旧审批或信任假设带入新的默认 Shell 装配。Caller driver 按准确 `index.html` 选择主窗口；steer 先回答原 Files 卡并等普通工具批次结束，核唯一原写入，再核后继模型。仅在自有测试进程延后暖阶段的准确原 Command 查询，以保留真实未知回执供冷开核验；首个冷 GET 的真实 socket 故障必须被观察到，之后才放行后继原 ID 查询，不假定手动点击先于自动恢复。冷开 Session 的正常 reconcile 单独核闭合字段、Store／代次和派生 ID，原 caller POST 仍为0，原 Command 保持单条，原 Run／Execution 集合和完整正文保持。

父测试的[专属收尾](test/native-caller-cleanup.fixture.ts)在 driver 结束或被强制终止后，复用原生进程观察器核准确私有目录参数、PID 和内核身份，再核当前参数及父进程版本，清理这份测试实例。未知身份或清理未确认报错并保留证据，失败时关闭 Provider／observer 但保留原根和 SQLite；完整通过且清理确认后才删除自有根。[故障回归](test/isolated/native-caller-cleanup.test.ts)以两个真实小 Electron 实例核强杀 driver 后只清原实例，另核参数、父身份漂移和不可读身份均不能发送信号，准备失败也逐实例收尾。

2026-11-05，macOS arm64／Bun1.4.2，原 Electron 五类调用与三项失败清理回归共8例／51断言、109.55秒通过；共享 CLI 恢复7例／224断言、Native journal 6例／152断言，以及受影响的 Native 恢复 run／interrupt 两例通过，未改的 report 分支未重验。原失败保留，这些是受控本地 Provider 与真实进程的集成回归，不包含付费模型或完整跨平台资格。

这些新增资格仅覆盖 macOS 隔离开发制品与上述断言。正式安装、Linux/Windows Electron、整个 §35 管理能力或所有业务结果不能由 caller 回执资格推导。完整请求、wire、Core SQLite 与私有 journal 字节由 fixture 保留在 `/private/tmp`；失败日志保留，原窗口期限与 SDK 校验没有放宽。

本片最终输入/恢复/profile/模型设置/压缩邻接组合为 11 文件、37 项、296 条 Bun 断言全通过（108.97 秒，2026-10-03）；其中五种实际 Electron 普通 caller 窗口全部通过，模型设置窗口另保留 35 条 Node 断言、压缩 40 条、profile 锁 16 条。Desktop types、portable build、21 个归属代码文件 Biome、统一边界、测试归属和文档检查通过。首组合复制 driver 时漏带具名 reader helper，迁移新增断言一度误读只列未决的 creation 目录；两项修复只同步 fixture 实际制品与原持久回执检查，保留失败日志及原期限，没有改为 stub。

最终组合之后新增的五种实际 Electron 窗口增量为 5 项、20 条 Bun 断言全通过（40.60 秒），另在实际 Node driver 核对强杀前后 Core 原 Run/Execution ID 集合完全相同，冷原 GET 不新增执行。该增量独立保留，不替代上述 11 文件邻接结果或将受理回执称为业务完成。

显式报告恢复的 `report_deferred` 在 Main／renderer DTO 中显示 `deferred`，不读取 null Run ID、不改成 unknown 或触发重发。它是已 applied 的 caller 回执，沿原日志规则从未决列表移出；丢失回应的未决原申请可在重开后显式查回暂缓事实。[Main 回归](test/native-recovery.test.ts)核该链路及零新 POST。

## 恢复后封存 Model 正文

当前 Native 为原Model来源的独立证明提供共享组件的 `canReadRestoredOrigin` 资格；组件仍复核当前 snapshot Store、原 Session／Run／Execution、完整性和字节数。关闭正文撤销准确复制资格；封存 Fork 不借原 Run 的后来状态成为最终回复。Service 的原大正文出处从已核 sealed SQL 的私有 output head 保留，不以当前连接 Store 替换，完整链验证继续由 Core 负责。

[实际安装回归](test/isolated/native-restored-output-bundle.test.ts)构建、搬迁并安装完整候选，删除构建源，通过默认 Main／配对 Service／preload／原页面生成一次108031字节Unicode／CRLF正文并显式Fork。三个真实窗口覆盖原Fork、包内installed CLI明确backup／restore为新Store、恢复首次与冷读，核原Message／Model／Run／Store出处、完整内容／SHA／字节数、关闭／切会话撤销全文、原source复制资格及三Service普通退出／双制品EX释放。读取阶段业务POST为0，Provider总数1；复制按钮资格不代证本片实际写OS剪贴板。原120秒整例／45秒driver／10秒页面期限保持。macOS actual0／1pass／22Bun断言及全部Node流程／78.06秒；局部6文件29pass／254断言和原17MiB HTTP／SDK Fork1pass／46断言通过。准确输入、先前失败和未验组合归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09恢复后封存-model-正文)。其他封存／恢复组合、完整installed／发布样本与平台资格仍待核对。

## Native Files 检查点恢复

[Main caller](electron/file-recovery.ts)通过有限的 `fileRecovery.*` 桥读取真实 checkpoint 目录、完整 preview 与恢复状态，观察绑定当前连接 generation、选择、Store/Session/Workspace/contextSelectionId 和输入 revision。Renderer 不能提交任意 Action、请求、Command ID、授权、Profile 或 token。仅会话、仅代码、代码与会话分别使用公共 SDK 的原意图；所有适用 Command/restore/newSession IDs 在第一次 POST 前一次性保存。代码恢复仍经原普通 Action 和独立的人类审批，保存成功回执不代表其他工具已获授权。

Files journal 在 [PrivateData](electron/private-data.ts) 的 DB4 引入准确的 `file_recovery_intents(intent_id TEXT PRIMARY KEY,state TEXT NOT NULL)`；当前 DB7 保留此表，旧版本 0–6 沿各次闭合迁移升级，原四表与 Files 记录保持。整行是完整 `FileRecoveryIntent@1`，主键取首腿 Command ID。异步闭合解析与 SHA 校验不持有同步事务；事务重新核实际已附着 Profile 的 live 数据库、原不可变 canonical 身份、两腿 phase CAS 和单调转换。全部适用 code/Fork Command IDs 跨行唯一；原 UTF-8 损坏、错误 digest/主键/表结构、冲突与容量不足均拒绝，原坏行不删除。目录最多保留 128 行、16MiB 原 UTF-8，不驱逐 unknown。它保存用户申请和核对状态，不保存执行授权。

prepared/submitting/pending/unknown 重开后只能查询原 Command 和准确原 restore ID，不取得热许可、不重新 POST，也不自动继续第二腿。代码成功与 Fork 尚未完成分别显示，关闭、编辑或切换观察不会撤回原申请；迟到结果只更新原保存意图，不能切换新视图。恢复到不同 Store 的旧意图保留原 Store 身份，只读展示，不重新绑定或获得热许可。both 必须明确继续，重读原 Command/status 与原 point 的完整当前 preview，核当前作用域、selector、原 checkpoint 身份和每个文件均为 unchanged。外部编辑或后续合法 Files Run 使它拒绝继续，保留 code succeeded/fork not_started，不重写代码或更换 ID。这里没有全局工作区锁，也不声称消除最后读取与 Fork 之间不合作编辑器的竞态。

[真实 default paired/Node](test/isolated/native-file-recovery-paired.test.ts)覆盖三个 scope、原 Code/Fork HTTP 回应丢失、两份独立 Ask、完整 BOM/CRLF preimage、新 inode、原 ID 冷 GET 零 POST，以及外部编辑和后续实际完成 Run 的继续拒绝。另在完整两腿 intent 已提交 SQLite、首 POST 尚未调用的实际 Node 窗口 SIGKILL，冷重开保原 IDs/unknown、零效果重做。[实际 Electron](test/isolated/native-file-recovery-electron.test.ts)经 Main/preload/renderer/default Service 验证原卡合法 approve_once、代码和 Fork 丢回复、owned Main/Service SIGKILL、冷查原 ID 零 POST与正常退出 owned PID 消失。只读测试观察曾被实际 AbortError 取消；有限 fixture observer 仅在确认真实 abort 后重新 GET，产品没有轮询或自动重试效果。首次 Native 审批解码遗漏 grant 已按有限枚举修复，原失败日志保留。

[真实 Node 私有库](test/isolated/file-recovery-private.test.ts)检查三 scope 持久字节、digest/UTF-8/主键/全局第二腿冲突、容量、单调 CAS、冷 unknown 和旧 DB3 迁移；[DOM](test/native-file-recovery-dom.test.tsx)与[有限 IPC/最终提交 scope](test/native-file-recovery.test.ts)覆盖 edit/hide/scope 变化、迟到观察与持久 submitting 后新选择零 POST。这是 macOS 隔离开发制品与固定本机 Provider 的资格，尚不证明正式安装、旧入口切换、Linux/Windows 或全部 Files/Native 功能。

当前 Native Files 与原 caller/recovery/Session/private-data 邻接为 11 文件、30 项、249 条 Bun 断言全通过（62.99 秒，2026-10-04）；真实 Node 与 Electron driver 的独立断言保留在对应 fixture。Desktop types、portable build、21 个归属代码文件格式及文档/边界/测试归属检查通过。首轮组合的两个失败分别是测试在实际审批卡投影前读取卡，以及旧 Session fixture 固定期待 omitted=true 文案；最终测试等待真实卡、核非法 grant 零 POST 后合法 approve_once，并按实际 applied/omitted 布尔/newSession 回执读取确认分叉。原失败日志保留，生产期限、权限和 scope 校验没有放宽。

## 完整 Native 发行边界

根 `release:build --product native` 和 `release:native` 使用 Native 构建器，物化实际 Electron、main/preload/renderer、包内运行时与准确目录及框架链接。macOS arm64 与 Windows x64 默认使用桌面专用运行时，显式 `--terminal` 和 Linux 默认使用完整 Terminal。主进程同时持外层和内层两个 artifact SH。一次性 Bun helper 关闭继承的 descriptor 副本，Node 主进程继续持有原使用权。Service 独立持这两个 root 的使用权，确认自身资源清理后释放。见 [Native 构建器](scripts/build-native.ts)和 [Native 发行说明](docs/native-release.md#构建与安装)。

归档、双 root 卸载、独立 CLI 注册和 shell cache 的当前产品边界见[Native 制品 owner](docs/native-release.md)。Node 私有 UI 数据库在选 Profile 前测量并核对 manifest 的实际 `node:sqlite`；它与 Bun Worker 是独立引擎。当前本机 Electron 44.3.0 / Node 24.20.0 使用 SQLite 3.53.4，Bun Terminal 使用包内 3.51.3；版本与 sourceId 分别固定。类型、纯版本 smoke 与窗口生命周期是不同证据。Linux arm64 已取得[原完整安装生命周期的有限资格](docs/native-release.md#linux-arm64-安装生命周期)，两次实际窗口均保 Chromium sandbox；Linux x64/Windows、正式签名和完整发布仍待验证。

Native 提供“下一页待决请求（替换当前窗口）”与“停止读取待决后页”。闭合 IPC 只接受 generation、viewGeneration 与实际 afterId，不授予 renderer 注入 Store/Session/工作区或取消 Run 的权限。后页替换最多 20 卡，原实例、Store、Session、工作区、context selection、snapshotCursor 的观察变化使旧页读取失效；它不是 SQLite 跨页快照。显式选择与关闭会 abort 原查询，迟到页不能发布。 原后页整例在丢失原答复并查回 accepted 后，于原 10 秒准备预算内确认获批的原 Job 已成功、首条效果已落盘，以及同 Store/Session/Workspace 的可用视图与事件观察连续 250ms 稳定；答案 accepted 不作为 Job 完成证明。fetch 真正进入后的原未取消/准确关闭或切换后已取消、晚回包不发布和零业务取消断言保持，不重试已经进入的读取。稳定窗口是准备条件，不宣称穷尽所有事件时序。自动事件 refresh 对同一作用域重新读取当前窗口的起点并发布新 generation/revision；作用域变动回到首页，旧卡 revision 不能作为新回答证据。完整附件 gate、原答案 commandId 与只 GET 查回保留。

[页守卫与 Main refresh 回归](test/interaction-pages.test.ts)、[真实 Electron 后页窗口](test/isolated/interaction-pages-electron.test.ts)与[专属 driver](test/interaction-pages-electron.fixture.ts)核对 40 个真实原 Job 卡、真实 renderer 下一页、后页原卡的物理 POST 响应丢失、切换后只查原命令、next close/switch abort、40 原 Job 的 succeeded/一次物理效果和零执行取消。该后页测试核对 Controller 生命周期内原答案查回；跨 Main 冷答案资格由下述专属 journal 与双 Main 测试证明。当前后页证据仍是 macOS 私有开发制品。

原生答案由 [answer-journal.ts](electron/answer-journal.ts) 沿既有私有 UI SQLite 的 DB5 `answer_intents(command_id TEXT PRIMARY KEY,state TEXT NOT NULL)` 保存；旧版本 0–4 原位迁移，未知 future version 失败关闭。单行最多 4MiB，全部 128 行与 16MiB 容量是私有资产的局部边界，满时在首次 POST 前拒绝，不删除未决记录或裁原答案。保存完整原 Store、presentation Session/Workspace、subject、Interaction/Execution/Run、revision、answer、commandId 和 canonical body/request SHA；FULL 提交成功后才允许本次热意图一次 POST，保存失败零 POST。它与业务 Core 是独立 SQLite 资产；维护备份/恢复须保留整份原私有文件字节，不能把本地行解释为 Core 命令权威或审批许可。

冷 Main 将 `submitting` 显示为 unknown，仅展示原身份、摘要与“只查原答复”；没有冷 POST 方法，也不为同一原卡/revision 换 commandId。显式查回先核 admitted Store/subject，再读原 presentation Session 与 Workspace，最后只 GET 原 Command。只有准确 `interaction.answer` 的 applied/`answer_saved`、原目标、decision revision +1、subject 与 request SHA 都匹配才确认；accepted 或错误 kind/target/revision/outcome 仍 unknown。不同 Store/selection 保留原关联 unavailable，查回不切换阅读视图。持久行不恢复旧卡观察、完整附件 EOF/hash 读取证明或授权；新的审批仍须当前有界页、新鲜观察与完整附件 gate。

[有限原意图回归](test/answer-journal.test.ts)核对保存失败零 POST、热提交与冷 GET 的错误回执、subject/Store drift、冷旧卡不能换 ID，以及不恢复附件证明。[实际 Node 私有资产](test/isolated/private-data.test.ts)核对完整 Unicode/CRLF 原答案与大整数 revision 冷开、重复目标/command、容量不淘汰与 DB5 迁移。[实际双 Main](test/isolated/answer-journal-electron.test.ts)使用 macOS 私有开发制品、owned Service/Core、Main SIGKILL 和 Node SQLite 观察，核 POST 前已提交完整原行、提交丢响应后冷 GET 丢一次再查原 ID、cold POST 零、其他 selection 不 rebind、原 Run completed 与原 execution 效果账本一行。此证据不声称正式安装或 Linux/Windows Electron 资格。

原答案随整份一致私有 SQLite 由[维护 v7](../../packages/agent/src/maintenance/README.md#原人类答案请求的独立离线资产)保存、inspect与恢复；新Core Store保旧UI身份，不升级为热权利。纯/实际Node组合13项164断言、相邻8文件38项358断言和真实后页/双Main2项6条Bun断言是各自独立范围，冷Main专项1项3条Bun断言另有真实driver内部断言。丢回执hook转发实际SDK后丢响应，不能冒称物理socket破坏。独立资产的持久理由见[原答案决定](../../.agents/notes/implemented/architecture/2026-10-04-original-human-answer-intent-assets.md)。


## Native Provider 与下一次模型选择

提供商正常保存期间仅底部按钮显示忙碌。确认删除后，原列表按钮显示忙碌。Main 的 `submitting` 仍参与写入互斥。提交失败、结果待确认和后台核对提示通过 [NativeToast](src/native-message.tsx)显示在设置对话框内，避开表单滚动区域。未决操作的 Toast 保留至原提交核实，每个未决结果可独立查询。字段校验保留在表单控件处。删除受阻原因在窗口级弹窗关闭后通过 Toast 显示。[表单回归](test/isolated/native-provider-settings-dom.test.tsx)在保存未返回时注入 Main 的 `submitting`，核对单次写入、按钮忙碌、Toast 的出现条件和原回执查询。

Windows x64／Bun 1.4.4／Electron 44.3.0，`cb2486cbe` 加工作树，使用隔离开发窗口和本机服务验证先拒绝保存、关闭失败 Toast 后重试成功，再打开删除弹窗、按 Escape 取消和确认删除。547 个保存忙碌帧中没有额外提示，表单内容高度保持。删除弹窗显示 48 个关联模型的数量，省略模型名称，初始焦点在取消。Escape 后配置原样保留并聚焦原删除按钮。确认后原连接和模型配置移除，列表更新并聚焦新增。截图和过程帧位于 `.cache/provider-delete-count-56e5ecbd-ced2-48ab-ac69-e10220ce8575/`。默认模型、定时任务引用和结果未知由表单回归覆盖。

[提供商表单](src/native-provider-settings.tsx)显式查询时，通过 [Main 目录读取](electron/provider-settings.ts)以当前 Store、原读取集、连接地址和所选凭据调用现有 Service discovery API。Main 只返回模型 ID，不创建保存意图，也不写入凭据或 JSONC。改地址、改凭据、切换或关闭表单会取消对应读取。Main 按读取 ID 取消，renderer 不接收迟到的结果。已加载目录以独立滚动列表展示，勾选与手填共享同一个模型草稿。保存仍走原提交路径。相关回归见[表单](test/isolated/native-provider-settings-dom.test.tsx)、[Main](test/native-provider-settings.test.ts)和[真实 HTTP 查询](../service/test/isolated/provider-settings.test.ts)。

Windows x64／Bun 1.4.4／Electron 44.3.0，`cb2486cbe` 加工作树，通过 `runDevelopmentDesktop` 在隔离用户目录启动实窗，以本机 HTTP 服务依次返回拒绝、48 个模型和待取消响应。逐步核对读取中、失败保留草稿、重试后的完整滚动列表、勾选位置、关闭取消远端读取、重开无旧结果，以及保存只写入选定模型。已有连接重查会预选已保存的模型，保存没有再次请求目录。截图在 `.cache/provider-directory-c5c77542-60c8-4244-a2bc-8021a07e4b37/`。验证范围为开发窗口和本机服务，不含公网套餐和系统凭据库。

[服务商预设](src/native-provider-presets.ts)是 [Provider 新增表单](src/native-provider-settings.tsx)的本地数据，普通 API 与编程套餐各自提供地址、默认协议和 key 提示。新增模板沿已有 `compatible` family 提交，只保存实际连接和模型；模板 ID 不进入 IPC、Service 或配置文件。通用 `/models` 未确认或需按账户套餐选择模型的新增模板要求在保存前手填或从显式查询结果勾选模型 ID。适用范围和官方接入参数见[手册](../../docs/handbook/features/models-and-configuration.md#服务商预设与套餐)；[表单回归](test/isolated/native-provider-settings-dom.test.tsx)核对普通 API 切换到套餐、清空上一条草稿、手填校验焦点及原格式保存。

小米 MiMo 的按量 API 与 Token Plan 并列在内置 OpenAI、DeepSeek 之后，均默认 Responses。套餐地址预填中国集群，密钥提示区分按量、个人和团队套餐。按量模型目录含语音模型，两个预设都要求用户勾选或填写实际要使用的模型 ID。

2026-11-13，`85088d9b8` 加本次工作树，Windows x64／Bun 1.4.4／Electron 44.3.0 的普通开发窗口观察：新增右栏显示原连接列表，预设菜单可用 End 滚到末尾；Kimi 普通 API 编辑名称后切 Kimi Code，草稿、地址和协议正确重置；OpenCode Go 显示新订阅地址，Escape 恢复新增按钮焦点，重开是新的 OpenAI 表单。实窗未保存或调用远端；保存、关闭后原提交核对和已知失败恢复由原表单及 Main 回归覆盖。

切页时，[模型选择器](src/native-model-picker.tsx)只为当前有效页面发起目录读取，离开后使在途成功和失败回调同时失效。[Native 导航](src/native.tsx)每次切换都以 `pendingSessionId` 锁定目标，选择或草稿失败后标题、阅读 key 与加载状态仍属于该目标。直接冷切换可在隐藏且只读的状态保留原布局；定时任务／缓存返回撤下旧业务 selection，使用目标自己的完整展示快照。目标选择、权限、模型和草稿准备完成后以一个 frame 接管，草稿失败在发布前退出。准备失败及重试期间，Main 状态通知更新全局事实并保持原选择暂停，不能绕过此边界发布半套目标会话；更换目标沿原 nonce 拒绝晚结果。从新对话准备页快速替换目标仍保留该准备页自己的草稿与节点，直到准确目标接管。同一会话返回也重新核实，页面读取与可见选择器通过 `NativeModelSnapshots.prepare` 合并准确相同 bridge／generation／Store／Session／选择代次／配置修订的在途读取；已完成读取不作资格缓存。真实目录失败继续显示并撤销发送资格，不在 IPC 层吞掉未知错误；设置保存、原读取集校验和 Main 取消语义保持。

缓存显示不等待上述确认：[Native](src/native.tsx)用现有有界 `NativeDisplayCache` 保存当前会话已核实的 `CachedComposer` 纯展示事实，包含草稿、实际模型／effort、审核方式、发送／停止标签、排队摘要与用量；按 bridge／generation／Store／配置修订隔离，目标必须仍在目录且 Workspace 匹配，真实权限、历史或模型失败撤销健康快照。选择器 `onReady` 同时交付独立的 `NativeModelPresentation`：`settled` 表示目录读取已结束，`display` 只代表已核实的成功展示，发送资格继续使用原 `ready/choice`。未选模型及没有审核标签也可构成完整展示，缓存保留其真实空态，不补默认模型或权限标签；真正读取／路由错误没有健康展示快照。选择资格 identity 包含配置修订；可编辑目标的首次整页呈现还须等待同一 identity 的模型读取结束，失败以真实错误结束等待，交互／只读页面不等待不存在的模型输入组件。返回时只读输入区先随原 `ConversationCache` 正文一起恢复，附件与浏览器注释沿目标自己的本机 scope；所有回调、队列及编辑操作被关闭。选择器的 `preview` 只绘制标签，不发目录 GET、不清真实目录缓存，也不能回报 ready；[环境信息](src/native-environment.tsx)的 `preview` 只定位展示缓存，不能成为读取 scope 或控制依据。原正文8个非当前项、容量／节点限制、滚动和展开保留保持；缺少完整配对缓存时才进入统一加载，`SessionPage.synchronizePresentation` 等目标历史与首轮结构完成后一并显示消息和 footer，前置 layout effect 在恢复阅读前确定 footer 占位。普通刷新不重新隐藏已有页面，完整大正文、图片与用量仍异步读取。显示缓存、当前读取及写入资格分离，不增加公开调试开关或协议版本。

原定时任务窗口中记录的瞬时 `native_request_failed` 可由“旧选择器挂载读取→Main 目标选择取消旧 GET→旧回调发布错误”复现；该页面生命周期现由[模型选择器回归](test/isolated/native-model-picker-dom.test.tsx)和[完整外壳回归](test/isolated/native-session-shell-dom.test.tsx)覆盖。定时任务[页面桥](src/native-scheduled-tasks.ts)对列表成功、失败和操作回包统一核当前请求序号，旧列表错误不能盖过后续成功，旧操作回包不能覆盖更新列表。原操作已成功但回包被后续读取取代时，仅重新读取列表，避免较早的 GET 漏掉刚完成的保存；补读失败保留列表错误，不将原操作重新提交。[Hook 回归](test/isolated/native-scheduled-hook-dom.test.tsx)继续核模型错误独立恢复、原创建身份及零重放。

2026-11-07，`b1799dbff` 加本轮修复，Windows x64／Bun1.4.4：最初六份完整 DOM 回归241项及列表补读 Hook 5项69断言通过；隔离 Chrome156 深浅主题各15阶段、593连续帧的原报告为 `.cache/model-navigation-browser-20261107.json`，阶段图为 `.cache/session-shell-browser-m8MjO7/`。原样本没有断言模型／权限归属，不能证明整页状态一致。用户随后反馈发现模型／权限闪现、消息与输入区不同步及缓存延迟；第一次同步候选的887帧虽无消息／footer错帧，仍让缓存返回等待后台确认，该候选不能取得缓存行为验收。后续修正保留即时缓存，并将模型、权限、草稿、成对可见性和每帧阅读位置加入现有场景；原失败及中间候选证据保留，最终验证记录以下方实际结果为准。

最终缓存修正：以 `bun test --parallel=1 --max-concurrency=1` 执行页面、正文缓存、滚动、模型选择器、Native外壳、新对话、会话导航及定时任务Hook八个完整文件，231项／5381断言通过；截图复核发现只读预览漏附件按钮，补齐后外壳整文件24项／428断言重新通过。最终 `bun run apps/desktop/test/session-shell-browser-runner.fixture.ts --model-navigation .cache/session-presentation-cached-browser-20261107.json` 使用生产组件和编译样式，Chrome156.0.8078.80／1280×850／深浅主题各20阶段、合计937连续帧及40张阶段图通过，并逐步观察选择→模型→草稿→历史→可操作、快速替换、真实失败与恢复。完整缓存的A在Main选择及模型等待阶段已显示自己的消息、五行草稿、模型和审核方式，输入仍只读；A所有可见帧scrollTop均140、composer顶边均615px，模型按钮左边均414.5px，附件入口保持。冷B等待时消息和输入区同隐，首次可见时成对出现；逐帧按实际标题核模型／权限／草稿归属，零跨会话状态、重复消息、欢迎闪现、`native_request_failed`、页面异常或模型／任务提交。真实目录错误仍增加错误说明并暂停发送，重新进入核实成功后恢复。多行草稿按实际行节点检查，避免 `innerText` 为段落边界补换行造成误判，编辑器源码未改。报告在上述路径，最终截图在 `.cache/session-shell-browser-0SfXAA/`。全仓6438文件／九项目类型、15份代码Biome、文档结构／影响、统一边界及测试归属检查通过；发布和跨包执行合同核对无变化。

随后用户指出模型／思考／权限控件残影，当前 Windows 开发 Kite 窗口的直接会话往返实际复现：加载图标已出现、Composer 背景已隐藏，旧权限文字和附件按钮仍在原位置。原937帧只检查 Composer 父层可见性，不能排除子控件自身继续绘制。[SessionPage](../../packages/ui/src/desktop/SessionPage.tsx)现为待呈现消息及 footer 同时设置 visibility 与父层零透明度，阻断按钮 `transition-all` 对继承 visibility 的过渡；原布局、控件节点、缓存、模型／权限状态与准入均保持。[现有浏览器场景](test/session-shell-geometry.fixture.ts)增加隔离 `--composer-handoff`，按子控件实际 visibility 和祖先透明度逐帧核绘制，覆盖冷页直接切换、完整缓存返回及四种控件浮层。修前浅色389帧中26帧仍绘制旧控件，反例与截图在 `.cache/session-shell-browser-xUV2dV/`；修后 Chrome156.0.8078.80／1280×850 深浅主题合计807帧、59个准备期帧均无子控件残影，缓存返回没有新增准备期，跨会话残留浮层和页面异常均为0。命令为 `bun run apps/desktop/test/session-shell-browser-runner.fixture.ts --composer-handoff .cache/composer-handoff-after-20261107.json`，截图归 `.cache/session-shell-browser-MnmtX2/`。当前开发窗口热更新后也逐步观察两个原会话的加载、就绪、反向切换和原页恢复，准备期残影消失，控件正常接管；未提交任务或修改模型／权限。页面、正文缓存、滚动及Native外壳四个完整文件56项／2037断言、全仓类型、定向Biome、文档与原边界门禁通过。此补验覆盖当前 Windows 开发窗口和隔离浏览器，不扩展安装发行或其他平台资格。

同日整体切换排查补齐直接冷切换的失败锁定，以及未选择模型／没有权限标签的完整缓存展示。新增外壳反例先复现返回B仍保留A草稿、选择／草稿失败后标题退回A；修后由全部导航共用 pending 目标边界。模型选择器将展示、读取结束和发送资格分别交付；配置修订参与资格 identity，冷页等模型读取结束后与历史一起呈现，真实错误也结束准备。已核实的权限标签或缺席只作为 `displayedPermission` 保留，操作仍以真实 `composerPermission`、权限读取和历史准入为准；历史重读不补出原本不存在的审核标签。现有无标签历史回归另核原DOM、工具展开及新完整消息在元数据等待期间继续接管，未将缓存命中改为等待后台读取。

最终在 Windows x64／Bun1.4.4 以 `bun test --parallel=1 --max-concurrency=1` 执行外壳、模型选择、新对话、导航、草稿、历史呈现、投影、历史读取／缓存及共享页面／缓存／滚动／选择器／编辑器14个完整文件，315项／6708断言通过；日志为 `.cache/session-switch-audit-final-qualified.log`。首次广测的本机HTTP集成在受限账户报 `network_outcome_unknown`，原记录保留；允许本机端口后投影整文件24项通过，最终完整组也全绿，测试使用固定Model／Tool而非外部模型。全仓6438文件／九项目类型、定向Biome、文档结构／影响、统一边界及测试归属检查通过。`bun run apps/desktop/test/session-shell-browser-runner.fixture.ts --session-audit .cache/session-switch-audit-browser-20261107.json` 使用生产组件／CSS、Chrome156.0.8078.80／1280×850，在深浅主题分别核已选模型、未选模型、无权限标签和输入区浮层八组，合计4023连续帧／455个准备期帧及148张阶段图；模型和高／轻度思考、权限、五行草稿、消息ID、滚动与footer几何逐帧一致，准备期子控件绘制、跨会话状态、重复消息、欢迎闪现及页面错误均为0，目录真实失败及恢复保持。截图在 `.cache/session-shell-browser-d7tSzS/`。当前运行的 Windows 开发窗口另观察跨项目冷页、已选／未选模型缓存与定时任务往返，消息和输入区一起恢复、标签保持各自状态；未修改模型／权限或发送任务。以上覆盖本轮开发交付，安装发行和其他平台资格保持原范围。

额外运行原[模型输入目录集成](test/native-model-input.test.ts)时，受限账户首先在本机 HTTP 准入失败；正常账户下两项读取合同通过，205次固定模型运行例在原30秒期限超时，未计为通过。该例的 Main、Client、Service、Runtime 与输入 reader 均无本轮 diff，不由 renderer 定向结果取得完整集成资格。本轮隔离浏览器与 Windows 开发窗口的验收范围以上述最终记录为准，未取得完整安装包、真实模型或其他平台资格；IPC、工具、持久格式与发布边界保持。

[提供商设置](src/native-provider-settings.tsx)通过封闭 IPC 交给 [Main](electron/native-ipc.ts) 打开[窗口级确认](electron/native-global-dialog-host.ts)。独立弹层只接收从当前观察提取的连接名称和模型数量。Main 在确认返回后核验原观察和引用，再由现有保存路径复核并提交原删除操作。[Provider DOM](test/isolated/native-provider-settings-dom.test.tsx)覆盖取消、过时确认和引用受阻 Toast，[窗口级弹层 DOM](test/isolated/native-global-dialog-dom.test.tsx)覆盖精简文案。默认引用的调整方式见[模型手册](../../docs/handbook/features/models-and-configuration.md#配置范围)。

2026-11-13，Windows x64／Electron 44.3.0 普通开发窗口，隔离 Profile 与本机模型目录验证常规只保留两项设置。窗口级弹层遮罩从应用内容区原点覆盖 1100 × 782 px，根视图暂停交互。弹层初始焦点在取消，正文只显示 48 个关联模型。Escape 后保留配置、返回原删除按钮；确认删除后列表清空、焦点回新增按钮。另用隔离配置建立默认模型引用，确认后关闭弹层并显示简短 Toast，连接和配置保留。原生窗口合成图核对自绘菜单同时被遮罩，截图在 `.cache/provider-global-confirm-28560034-096c-4924-bf8c-b9c2fba924ba/`。本次相关设置、Main、弹层测试 143 项通过。

会话首次实际 Run 后，[模型选择器](src/native-model-picker.tsx)从原有序 View 的首 Run 封存配置读取 Responses／Chat Completions 协议，只在原列表提供同协议候选；思考面板不显示协议提示；仅在模型列表底部以12px辅助文字显示“仅显示当前对话可用的模型”。同协议模型与连接仍可选择，effort 从下一轮生效，活动 Run 保持原值。首次实际 Run 前不限制协议，准备拒绝没有 Run 时也不提前绑定；首配置无法核实或原所选路由协议已变时保留当前标签并明确不可用，不跳到晚 Run、不静默回退另一协议。Core 视图额外保留最早实际 Run，超过200轮及冷重建同样有效；恢复后的旧 Store 出处由原准入 View 保留。服务端独立校验归[Service owner](../service/README.md#会话模型协议)，不以客户端过滤代替准备守卫。

2026-10-24，macOS arm64 的独立合成 HOME／Profile，普通 development Main、真实配套 Service 和生产 renderer（`testDiagnostics:false`）完成协议实际窗口验证：首 Run 前可选 chat-a／chat-b／responses-a，Chat 首 Run 后仅两个 Chat 候选；明确选择 chat-b 和 high 后，第二次实际请求仍走 `/chat/completions`，wire 采用 chat-b／high。新对话再次提供三项，实际选中 responses-a，未发送该准备输入。125个连续过程帧保留两轮用户／回复顺序及实际档位，Renderer 零页面错误；没有外部 Provider 或真实凭据。证据为 `.cache/codex-review-20261024/protocol-live-verified/` 的 report、frames 和 trace，原夹具初始化失败的独立目录保留。直接 API 的双向拒绝与冷重建由上述 Service 回归负责，不把此窗口证据外推安装包或其他平台。

普通 Native 回复沿共享 `autoRead` 自动获取原已保存的完整正文；没有“回复预览”“完整回复”标题、查看／收起／重新读取按钮或原始 Tool calls 区。SDK 与组件完整身份／EOF／SHA／字节校验继续保留，核实后才出现原全文复制资格；真实读取失败保留原文并说明失败。[正文 reader](src/native-model-output.ts)按同一 bridge 的输入／输出类别分别串行读取，符合 Main 每类单 lease 的边界；排队时取消不打开或关闭其他读取，失败结算后后续消息仍可读取。旧历史、缓存返回和新回复均走同一组件，不新增 Runtime 请求链。对应[共享正文](../../packages/ui/test/model-output.test.tsx)、[有限 IPC](test/native-model-output.test.ts)、[Native 缓存](test/isolated/native-model-output-cache-dom.test.tsx)、[整轮复制](test/isolated/native-child-copy-dom.test.tsx)和[Web 原来源恢复](../../tests/isolated/unified-agent/restored-web-model-output.test.ts)覆盖大正文、并发读取、暂停／迟到隔离、复制撤销与零业务重放。

2026-10-24 当前 macOS 普通开发窗口（测试诊断关闭）实测：原用户“打招呼”历史直接显示完整回复，无多余标题／按钮；新建 Codex `gpt-6.1-sol` 读取本机 Max 档，真实拖动至高后三处标签一致，实际 Command 与 Run 冻结配置均为 `high`，真实回复 `AUTO_FULL_REPLY_OK` 完成。完整退出重开后恢复高档位，255帧观察仅一条用户／助手消息、完整复制可用且零正文控件，原命令仍只有一次提交。证据位于 `.cache/codex-linux-effort-live-20261024/`，不代替安装包或其他平台 UI 资格。

同日本轮使用独立 HOME／Profile／Electron 数据目录、真实本机 Codex 登录与 `gpt-6-luna/low` 完成6轮实际请求。首轮、跨轮验证码和停止后新发送成功；实际输出中停止结算为 `cancel_requested`。工作区文本 `read_file` 两次携带 PDF 参数失败，明确纠正后的5次同参失败触发 `repeated_tool_failure`，文件任务未完成。初次隔离 HOME 缺少用户配置父目录时，原命令在 Model 派发前被拒绝，补建测试目录后才继续；原拒绝记录在后来回复下方显示且冷重开投影变化，问题仍保留。12次 Model 中11次回传65561输入／340输出／4224缓存输入 token，取消请求未回传用量；不把这些值称为完整账户总耗用。原驱动的取消状态等待和未成功文件标记断言没有全绿，实际取消、完整持久正文和冷读由独立只读核验补证。原失败、过程帧、截图与 trace 位于 `.cache/codex-luna-real-20261024/`。

正文按钮与并发读取修复后，在上述真实历史上重新构建普通 Main／生产 renderer、真实 paired Service，连续两次冷启动及切走返回均自动读完4份正文并恢复4个准确复制入口，180个过程帧没有正文重读按钮或读取错误。两次正常退出均为0，读取前后 Command／Run／Execution／Message／MessagePart 完全相同，没有新增模型或工具派发；证据位于同目录 `fixed/`。共享正文、有限 IPC、缓存及子详情复制4个完整文件26项／302断言通过，UI／Desktop类型、定向Biome、文档、边界与测试归属检查通过。相邻模型输入文件的两个有限 reader 用例通过；205请求目录用例在正文读取前选择会话时报 `native_selection_changed`，串行复跑及原 reader 对照均复现，未把该项称为通过，也未扩张本次修复。这些证据限当前 macOS 开发客户端，不代替安装包、完整默认回归或跨平台资格。

随后修复 [Responses 函数工具可选参数](../../packages/ai/README.md)和 [PDF 参数说明与失败恢复](../../packages/agent/src/tools/files/README.md#会话文件与-pdf)，同日以独立 HOME／Profile／Electron 数据目录、普通 Main／生产 renderer（`testDiagnostics:false`）、真实 paired Service 和本机 `gpt-6-luna/low` 重验：首轮采用原失败提示读取工作区文本，实际调用只含 `path`；第二轮改动文件中未出现在提示里的随机值，再明确读取第3行，实际采用 `start_line=3/max_lines=1`。两个 `files.read` 均仅执行一次且成功，未混入 PDF 参数，最终回复与各自真实文件内容完全一致。两 Run completed，4次实际 Model 回传23203输入／78输出 token；438个过程帧保用户／工具／回复顺序、两条完整正文、空输入、零正文错误或重读按钮。完整退出重开后两条正文及复制恢复，Command／Run／Execution／Message 没有变化；两个窗口正常退出0、页面错误0。完整 report、Core事实、过程帧、截图与 trace 在 `.cache/codex-luna-file-read-20261024/`。此前失败保留原记录；此次验证限定当前 macOS 开发客户端及两种文本读取，不外推实际 PDF 视觉模型、安装包或其他平台。

本机 Codex 连接显示“自动接入”，说明沿用本机登录；没有编辑、删除、地址或 key 控件，也不会出现在新增模板中。模型启停、默认和思考设置仍走现有模型页与选择器，完整认证来源及失效恢复见[模型手册](../../docs/handbook/features/models-and-configuration.md#chatgpt--codex-本机自动接入)。Main 与 Service 都独立拒绝将自动连接改为手工意图，即使 renderer 伪造可写标记也不会发送保存。此来源只传非秘密模型与连接事实，账户原文和 token 不进入 Native IPC。

提供商目录现在平铺真实连接及自动发现的本机 ChatGPT / Codex 来源，四个手动协议族仅作新增模板；名称与稳定连接 ID 分离，同模板/同地址可多实例。新增和编辑使用 settings shell 最右的 `RightSidebar`，保存失败留表单，成功且刷新完成后关闭。删除使用窗口级确认，成功后焦点回新增入口。迟到回执不覆盖新表单。Main 从 Service安全快照复制模型/默认引用，并只从本机私有库读取关联定时任务与未结束运行名称。删除在提交前重读这些引用，拒绝默认或定时依赖，不撤销 Vault 秘密。Native caller 将提供商写入与定时任务保存/启用串行，未知删除期间禁止新增任务引用，冷行仍只查原 GET。该保护不宣称能阻止非参与式外部编辑器或其他客户端修改用户 JSONC。

[Provider DOM](test/isolated/native-provider-settings-dom.test.tsx)、[Main/IPC](test/native-provider-settings.test.ts)和[真实HTTP](../service/test/isolated/provider-settings.test.ts)覆盖列表/CRUD、旧配置、删除保护、重复点击和未知原回执；隔离 Linux Electron 预览使用无凭据本机测试配置，不代表付费服务、系统 Vault、正式完整构建或三平台发行资格。

[Provider 面板](src/native-provider-settings.tsx)和[模型选择器](src/native-model-picker.tsx)是正式 Native renderer 消费者；Main 的[Provider manager](electron/provider-settings.ts)沿公共 Client/Service 管理接口固定原 Store/generation、用户观察 readSet 和五字段操作。renderer 只持安全连接/模型事实，不取得路径、credentialRef 或 opaque revoke authority。四类明确 family，手动名称直接保存、留空才显式发现；切换/关闭清未保存密钥与字段，局部必填/URL 错误聚焦，提交后密钥清空，等待/未知跨关闭保留。凭据与配置结果分别显示；已发布后的刷新失败保原结果，原 GET 的 applied 刷新输入选择器，不重绑定迟到面板。新模型 disabled，默认禁用门禁和开关失败恢复保留。

提供商页的展示样式由 [专属 CSS](src/native-provider-settings.css)维护：连接列表显示名称、类型和配置状态，选中行保留高亮。按照[配置编辑交互约定](../../docs/handbook/clients/desktop/README.md#配置编辑交互)，[Native 设置壳层](src/native.tsx)在 `settings-content` 同级的应用最右端提供 `settings-editor-panel` 宿主；[Provider 面板](src/native-provider-settings.tsx)以 portal 复用定时任务使用的 [RightSidebar](../../packages/ui/src/desktop/RightSidebar.tsx)，而非主区内分栏或新弹窗。面板头与底部取消/保存固定，连接、凭据与模型字段独立滚动；窄窗贴右覆盖而不把表单排入列表，沿用亮暗主题变量。

新增直接打开表单并聚焦服务商预设下拉框，编辑聚焦名称。删除使用设置内的 AlertDialog，打开时聚焦取消。关闭、取消或 Escape 恢复原列表按钮焦点，删除成功后返回新增按钮。直接提交或原提交查询确认 applied 后共用刷新并收起原面板的流程；仅当前身份、编辑代次和原目标仍匹配时关闭，验证/保存/刷新错误保留表单；提交仍立即清密钥，未知提交跨面板关闭保留且只能查询原提交。新增表单内通过服务商预设下拉框选择模板；不另显示预设列表。列表和编辑栏均不展示历史提交结果、技术详情或内部 ID，成功后直接更新列表，不另加成功提示；失败及结果未知仍保留必要反馈。结果未知时显示精简提示与“查看结果”，跨提供商或数据源的未决更改仍可查询；原内部账本和写入锁不变。关闭时清理读等待状态；读取开始即废止旧写观察，取消读取后需重新刷新才可保存；编辑版本隔离迟到保存/刷新，不关闭或重绑定后来选择的编辑器。切换分类或 Store 卸载原面板并保留原提交语义。该轮不新增 Service、发现请求、凭据读取或协议降级；模型及常规设置的其余编辑布局仍待单独迁移。

[Provider DOM](test/isolated/native-provider-settings-dom.test.tsx)核 portal 归属、表单语义、成功关闭、失败保留及迟到结果；[完整 NativeDesktop DOM](test/isolated/native-new-conversation-dom.test.tsx)核实际设置壳层的最右侧宿主、Escape 分层、分类退出、焦点及原会话草稿不变。测试断言与实际运行结果仍分别记录，不能据 DOM 测试宣称系统凭证库或真实付费模型已验。

2026-10-16 Linux 云端开发窗口（Bun 1.4.2／Electron 44.3.0）已从普通用户菜单检查列表、OpenAI Responses 表单、模型区域、空凭据错误聚焦，以及亮暗主题与窄窗口。提供商 DOM 5 项／80 断言与 Main 3 项／40 断言通过，Desktop typecheck 通过。默认 workspace build 在既有 `linux-shell-init.c` 的未使用 write 返回值警告被 `-Werror` 拒绝；仅本地预览构建使用保留警告的 `-Wno-error=unused-result` 编译包装，未修改该源码或仓库编译规则。没有真实 key 输入、凭据库写入、远端模型发现或付费请求；此证据不代表正式制品、完整回归或跨平台资格。

[配置原意图](electron/configuration-journal.ts)在首次热 POST 前 FULL 保存非秘密原 input 与 safe state。[PrivateData](electron/private-data.ts) 的 DB6 从 DB0–5 保留原六表，新增准确 configuration_intents(command_id,state) 与 model_routes(store_id,session_id,model_id)；当前 DB7 保留这八表并增加下文独立 MCP 记录；前者最多128行/16MiB、原 input 不可替换、终结才删除，坏行保字节并拒绝写。Provider 与模型设置共用原 Store 未决门禁。冷行只允许原 ID GET；当前Store的模型／提供商设置页可自动核对这些未决项，不持有secret、不自动POST，也不补造旧热scope或续写proof。已存未发布的 opaque reference 只留 Service/认证 SDK，Main 不投影它到 renderer。

模型选择按 Store/Session 保存，首条原 start/follow-up intent FULL 保存后才记本次模型 ID；打开新 Session 或读设置本身不绑定 route。输入只从 enabled/configured 的完整目录选择；缺失原显式 route 不回退全局默认。当前未提交的临时 effort 保留在页面会话状态中，换模型／刷新后清除；没有当前手动选择时，由[NativeModelPicker](src/native-model-picker.tsx)从当前投影最新的同 Store／Session Run 中，按 `configuration.snapshot.configuration.models` 的唯一 Model ID 恢复真实档位，再回退当前模型配置。新会话准备页只恢复下文已明确选择且仍有效的全局推荐；恢复值与当前选择共同交付下一次 start／follow-up，普通 active steer 继续只发送文本。已保存的 none/minimal 按兼容值恢复；其他历史档位不在当前可选列表时，保留显示并阻止发送，可通过原滑块改选可用档位。没有历史或配置值时，沿共享resolveThinkingEffort明确采用medium；稀疏目录不含medium时采用最低可选档位。onReady交付的是当前显示的最终值，配置档位和缺省值也显式进入start／follow-up；不新增 model_routes 字段或配置 journal 写入。[主输入](src/native-input.ts)冻结实际下一次 model/effort 到 start 与 active follow-up；普通 active steer 保原文本/target，不改活动 Run。ModelInput 和实际 wire 使用同一原设置。

输入区显式选模型或调整 effort 后，[推荐偏好](src/native-model-preference.ts)经[沙箱 preload](electron/preload.ts)和[有限 IPC](electron/native-ipc.ts)交给[Main 存储](electron/model-preference.ts)，在 Electron `userData/model-preferences/` 中按 Store ID 的 SHA-256 文件名保存准确模型 ID 与实际思考档位；写入临时普通文件、刷盘后原子替换，确认保存后才更新推荐展示缓存。页面来源或开发启动端口变化、完整退出重开均不改变该位置。IPC 只接纳当前主窗口准确顶层 frame 的 read/remember 及封闭模型偏好，不接受文件路径，不打开 Service 或修改业务状态；记录不含凭据。它在同一 Store 的所有空间项目间共用，不改配置默认、会话数据库、配置 journal 或已有 Session 的 route。每次点击新对话清空准备页临时选择，目录核实后读取推荐；推荐路由无效时保留“选择模型”，不采用目录首项或配置默认。宿主尚无记录且当前页面来源仍有有效的旧 `localStorage` 记录时导入一次；旧来源不可达时不扫描其他来源。已有宿主记录的恢复不回写，读取受限或内容无效时按没有推荐处理并保留原字节；显式选择保存失败仍保留当前窗口选择并显示简短错误。迟到的保存回执不改变后来的选择或作用域。无宿主端口的隔离页面夹具继续使用原 `kite.desktop.recommended-model.<storeId>` 浏览器存储。缓存不授予发送资格；发送仍等待当前目录读取和原权限核验，其他 Store 的推荐隔离。[持久化与 IPC 回归](test/isolated/native-model-preference.test.ts)、[选择器 DOM](test/isolated/native-model-picker-dom.test.tsx)及[跨来源退出重开窗口](test/isolated/native-model-preference-electron.test.ts)分别覆盖存储、迁移／失败及真实进程边界。

2026-11-05，`161f96cb6` 加本次未提交修复，Windows x64／Bun1.4.4／Node24.15.0／Electron44.3.0：`bun test --parallel=1 --max-concurrency=1` 运行上述持久化与 IPC、选择器 DOM 和[主输入](test/native-input.test.ts)共40项／435断言通过；以准确 `./apps/desktop/test/isolated/` 路径定向运行[新对话](test/isolated/native-new-conversation-dom.test.tsx)与[冷页面准备](test/isolated/native-session-shell-dom.test.tsx)的模型门禁、已存 Session 路由和迟到隔离7项／95断言通过。`bun test --parallel=1 --max-concurrency=1 ./apps/desktop/test/isolated/native-model-preference-electron.test.ts` 真实窗口通过：沿生产 Picker、共享样式、沙箱 preload 与实际偏好 IPC 选择非默认 B／Ultar，进程正常退出0后换页面端口重开，空 `localStorage` 仍恢复同组设置；其他 Store 为空，返回原 Store 再恢复，第二进程正常退出0。逐步核对浮层、七张过程截图和222帧记录，目录读取期间禁用、恢复后可选，只有一个选择器，零页面错误和保存错误；证据在本机 `.cache/model-preference-399f23bd-13bf-4fde-9938-fa4a5c70215e/`。此为隔离模型目录与实际 Electron 持久化验证，不启动 Service 或模型，不代表完整安装、其他平台资格。扩大整文件检查另有3项输入失败提示问题，修改前模型源码对照同样失败；Main 生命周期的4项 Windows 浏览器租约测试仍因未提供 automation host 失败，其平台分支未改。它们不计为本次通过项。

2026-10-25，`852f665b0`加本次推荐偏好修改，Windows x64／Bun1.4.3：`bun test --parallel=1 --max-concurrency=1`执行[选择器DOM](test/isolated/native-model-picker-dom.test.tsx)与[主输入](test/native-input.test.ts)，33项／363断言通过，覆盖浏览器存储受限、损坏内容保留、推荐失效回退、跨会话隔离与实际输入冻结。Desktop typecheck、定向Biome与文档检查通过。沿[会话文件隔离页面夹具](test/session-files-browser-runner.fixture.ts)临时配置两个模型与两个项目，逐步观察选择非首项、调整Ultar、另一个项目新对话和页面刷新后的相同组合；已有会话仍保留自身选择。该页面使用真实Native renderer与隔离Main／Service，私有UI端口为测试替身；不代表安装版、其他平台或真实外部模型资格。 此为合并前的验证记录，其中无有效推荐时回退首项的行为已由当前“选择模型”门禁覆盖。

[NativeModelPicker](src/native-model-picker.tsx)的选择来自页面明确 `value.modelId`、当前Session的已存 `selectedModelId`，或新对话准备页中已手选并保存且仍可用的推荐，不回退 `defaultModelId` 或目录首项。新对话准备页忽略Session选择 metadata；没有上述有效选择时显示“选择模型”，`onReady(false)`且不返回choice，刷新默认配置也不自动选中。Root发送首条消息或新轮次同时要求ready和准确modelId；活动Run的普通steer沿原语义。旧Session的已存路由继续恢复，失效路由不回退默认；有Run但没有存路由时也保持空选择，不新增历史模型推导。这是Desktop选择门禁，Service及其他调用者的全局默认配置合同保持原范围。2026-10-25，Picker／模型列表／输入意图／完整NativeDesktop四文件170项／2762断言、Desktop类型和定向Biome通过；新会话发送正例通过真实Picker明确选择，首次未选的按钮与Enter均零请求，既有saved route／draft和active steer保留。JSDOM整文件对Radix合法零矩形clip存在解析缺陷，夹具仅将exact零矩形交原setter为等价CSS变量fallback，其他值与关闭还原保持，原异常日志保留；不据此替代真实布局验证。同轮匿名生产UI／Main浏览器夹具在1100／550px深浅四组合通过，共14328次采样／2603帧，无页面错误：初始placeholder→手选零写入、新准备页不继承会话模型且Enter无提交、模型行默认badge始终为零。原自动恢复、精确路由、默认禁用门禁、原Session／草稿与四次读取保持；不包含真实付费模型或安装版资格。

正式输入区复用[原模型与思考浮层](../../packages/ui/src/desktop/ModelEffortSelector.tsx)和宝石滑块；Native 仍负责准确目录读取、作用域/迟到隔离、原 route 与就绪门禁。双栏列表按实际 Model ID 选择，同一提供商内同名模型显示 ID；所有配置可用模型均可调节思考程度，Service 提供 `low/medium/high/xhigh/max/ultar`，显示「轻度、中、高、极高、Max、Ultar」。浮层不显示配置默认／关闭思考按钮，也不把档位写成“默认”；顶部、模型按钮摘要和滑块的无障碍值显示同一具体档位；选中模型后始终解析具体档位，不保留“未指定”：配置缺省时默认medium，稀疏目录不含medium时采用最低可选档位。顶部、摘要、滑块与onReady交付的新输入使用同一最终值，未操作滑块也会显式携带配置／默认档位；松手不重复提交同一变化。已有会话按当前选择、上次实际使用值、模型配置依次解析，新会话按当前选择和模型配置解析；旧 none/minimal 继续可读，换模型清当前临时选择。观察事件或临时 effort 不触发重复目录读取。[隔离 DOM](test/isolated/native-model-picker-dom.test.tsx)核 DeepSeek 滑块与 Ultar、准确同名路由、稀疏档位、旧 none 配置、两按钮缺席及迟到隔离；实际 [Model Settings 窗口](test/isolated/native-model-settings-electron.test.ts)仍核活动绑定、原 CAS/丢回执、下一轮切换及冷读，历史输入和源码外候选结果见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原-pc-模型与思考选择器)。其他历史 Provider/Vault 窗口记录保留其原输入范围。

2026-10-20，Windows x64／Bun1.4.3，`5dba8a6b`工作树加本次会话档位恢复修改：`bun test --parallel=1 --max-concurrency=1`执行[模型选择](test/isolated/native-model-picker-dom.test.tsx)、[主输入](test/native-input.test.ts)及[共享浮层](../../packages/ui/test/isolated/model-effort.test.tsx)，18项／199断言通过；Desktop `tsc --noEmit`、定向Biome与文档检查通过。Chrome155沿真实NativeModelPicker／Composer及生产样式核深浅主题、1240／360px、新旧会话的首次打开，并沿隔离Main夹具核完整NativeDesktop中A／B会话各自的“高／轻度”和新会话配置“中”，共10组通过。旧none/minimal与失效历史档位改选另由上述DOM回归覆盖；没有真实付费模型请求、安装版窗口或其他平台资格。

[实际默认 Native 候选](test/isolated/native-provider-bundle.test.ts)与[Electron driver](test/native-provider-electron.fixture.ts)在 macOS、源码外搬迁制品、自有 HOME、OS PATH、固定 SQLite 与默认 OS vault 下通过1项/190条Bun断言：四类表单、一次真实发现、7根Run/8次SDK请求、原 effort、活动冻结与下一次切换、新 Session 首次绑定、物理保存丢回执后冷原GET一次/POST零。两个所属 Service PID 正常结束；实际两枚测试凭据由 Service 准确 revoke，profile exclusive lease 可重新取得。endpoint 是受控 loopback，退出 warning 用明确 dialog 端口回答；不证明付费远端、系统 modal 点击、签名安装或其他平台。有限 Main/DOM/输入15项137断言、真实 HTTP8项93断言支持对应局部边界。

当前 Provider／MCP 窗口夹具通过[自有 HOME 的钥匙串引用](test/owned-default-keychain.ts)保留上述真实 OS 后端：只读查询 OS 用户默认钥匙串，在私有 HOME 建立引用，不复制内容或更改系统默认／搜索列表；只保存并精确撤销本例随机凭据。各窗口和 Service 的模型配置统一读取自有用户文件，不能再以 Profile 旧文件构造可用模型。实际 Run 恢复的丢回执旅程先用原 Command GET 确认应用，再关闭所属进程，配置必须保留准确同一工具与运行环境；不将 accepted 伪称恢复完成。整轮范围归[客户端 UI 收束](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-15客户端-ui-迁移缺口与回归收束)。

本轮当前原完整默认589文件/471原任务全部通过，runner exit0/drain815.977s，4009regular输入与Git前后相同；其中上述实际Provider窗口45573ms及原Model、安装、CLI/TUI、Context/后页/持久答复消费者均通过。原红、嵌套同名fixture、制品摘要和权限环境范围见[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-06native-provider-设置与下一次真实模型选择)；完整默认通过不代表完整V1.3、MCP设置或三平台资格。

Profile 无三项 raw MCP 文件时，DB6 离线备份使用专属 manifest v14；任一实际存在则优先使用下文 v16。原设置 input、Session route 和完整含 effort 的原 caller 请求在新 Core Store 下保旧身份；冷读不发送请求。旧 v2–v13/DB1–5 仍按各自闭合格式，维护 codec 不依赖 Desktop/Client，见[维护 owner](../../packages/agent/src/maintenance/README.md#desktop-db6-与-manifest-v14)。

原意图、两个介质结果和临时选择的长期取舍见[已实施决定](../../.agents/notes/implemented/architecture/2026-10-06-native-provider-intents-and-next-run-selection.md)。

## Native 公共扩展完整能力

Model 输入／输出、人工卡附件、后台子会话与扩展正文的 renderer 分片传输共用私有 [有限字节 reader](src/native-body-chunks.ts)。它只核原 readId／kind、base64、64KiB 分片、offset 前进与准确 EOF；打开／关闭读取、原 scope／generation／selection、SHA 与 UTF-8／业务身份核验仍归各 reader。扩展保留格式无效与内容不完整两类原错误，不由字节复用授予额外读取或执行权限。[扩展 reader 回归](test/isolated/native-extensions-dom.test.tsx)覆盖坏 base64、异读身份、零进展、提前／缺失 EOF 和原关闭归属。

[NativeDesktop](src/native.tsx) 的自动测试侧栏“会话工具→扩展能力”现消费已注册目录、公共 `ActionInputForm` 和 `PublicViewCard`，通过固定 [协议](src/extensions-bridge.ts)、[IPC](electron/native-ipc.ts) 与 [Main 叶子](electron/extensions.ts) 完成动作表单、原 Command／Execution 状态、注册 Query、完整通用结果和原结果动作。没有按参考扩展业务增加 Client／Service／内核方法；参考样本不进入默认装配。

Main 从当前准入推导 Store／subject／Session／Workspace／contextSelectionId 与 generation／viewSelection／historyEpoch，冻结目录和结果观察。完整 JSON 经每块至多64KiB、准确 offset／EOF／SHA／fatal UTF-8 的 [reader](src/native-extension-read.ts) 交付，没有全文配额或截断；最多两份在读 body，超界明确拒绝。只有完整 EOF 才取得该观察的动作资格；刷新、关闭和切换撤销观察，旧完整结果可保留供阅读，旧结果动作必须重新查询。Query、阅读和关闭均不提交 Command或取消业务。

动作沿原 [CallerJournal](electron/caller-journal.ts) 的完整 intent、first／inflight 与现有 `caller_intents` 表；只有当前进程新成功准备的原对象可首次 POST。未知和冷申请只能明确查同一原 Command，重复调用不重发。Main核公开 Command原主体／scope／requestDigest与receipt指向的实际Execution／定义／版本，受理与终态分开；raw input不冒充prepared digest。泛型 caller.submit 对扩展只查询，不能绕过已读定义／原结果动作坐标。尚未确认终态的申请不能清除，明确新动作才产生新ID和用户填写的新业务身份。

Native局部 `NativeCallerCommandRequest` 增加公共 `ExtensionCommandRequest`，共享CLI／TUI五类Caller不扩大。首次保存这类申请才在同一FULL事务惰性升级DB9，未使用的新旧流程保持原版本；维护仅对应 closed manifest v18 接纳DB9，原DB1–8及v2–v17 grammar保持。恢复保原申请字节与Store，foreignStore／subject在HTTP前拒绝查回。准确格式与实际Node备份恢复归[maintenance owner](../../packages/agent/src/maintenance/README.md#desktop-db9-与-manifest-v18)，取舍归[扩展调用决定](../../.agents/notes/implemented/architecture/2026-10-09-native-public-extension-callers.md)。

[真实公共链](test/isolated/native-extensions-main.test.ts)、[Main／journal](test/native-extensions.test.ts)、[原组件DOM](test/isolated/native-extensions-dom.test.tsx)与[安装版整窗口](test/isolated/native-extensions-bundle.test.ts)分别核真实执行、持久权限、原用户入口及完整mini-review链。窗口只将参考扩展和可信分类在候选hash发布前显式装配，普通模型、权限保存、配对Service、Main／preload／renderer和sandbox保持正式实现；具体通过、失败和平台范围归[本轮进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09正式-native-公共扩展完整能力)。它不代证任意外部扩展、旧writer运行DB9、完整PC或阶段退出。

## Native MCP 完整设置

[自定义 MCP 表单](src/native-mcp-add-form.tsx)按 STDIO／流式 HTTP 分开维护草稿，参数与变量／标头行共用增删组件，全部输入沿公共 Input、Button、Select。STDIO 提交独立 command／args／env／envPassthrough／cwd；HTTP 提交 url／bearerTokenEnv／headers／headersFromEnv，切换类型不混用 URL 和命令。已知敏感键只允许环境引用，重复键、协议保留标头和控制字符在提交前提示；Main 在 journal 写入前复核同一有限非秘密声明，冷重开保留完整原操作且不重放。布局继续使用透明420px固定侧栏，内容独立滚动、底部操作固定，错误保留在所属侧栏。定时任务使用静态分隔线，设置表单沿 Grid 固定宽度；不提供拖拽或键盘调宽。提供商和 MCP 重复新增保留现有编辑器、草稿和滚动位置；显式重开既有配置仍重新核对快照。浏览器14组深浅／宽窄窗口回归通过，证据归`.cache/mcp-feedback-7mB35S`。

Main 的 MCP 输入校验只依赖 `@kite-ai/agent/mcp-entry` 独立纯校验入口，避免 config barrel 将 JSONC UMD 的动态相对 require 带入 Node CJS。2026-11-01 Windows／Node24.15.0 的[实际 Node 构建回归](test/isolated/native-mcp-input-node.test.ts)先复现 `Cannot find module './impl/format'`，改用独立入口后1项6断言通过。完整 Main／preload／renderer 另构建并在独立临时 Profile 以 Electron44.3.0 启动，实际观察新对话、设置、MCP 读取与新增表单，无启动错误弹窗；制品归`.cache/mcp-native-startup-1cc15940-af0c-44da-b04e-396f35eafdd7`。此证据不代表正式安装发布资格。

本次实际窗口检查后，关闭按钮按现有行为隐藏到托盘；测试 Main 随后单独终止，其准确所属 Service 经父 EOF 退出，四个 Electron PID 与 Service PID均确认不存在。此项只证明启动与界面加载，不计为正常退出链资格。

2026-11-01 Windows 新增表单验证：页面55项／322断言、Main13项／100断言通过；生产样式的8项深浅主题／500与1280px场景通过，覆盖完整两类字段、参数增删与顺序、独立草稿、公共控件样式、长表单滚动、受理后的锁定和完成收栏，以及既有失败提示归属。证据归`.cache/mcp-feedback-htJEQb/report.json`，另逐步观察了输入、切换、滚动、受理与完成全过程。真实 Windows Node／官方 memory STDIO 与 HTTP 变量认证的结果和未取得范围归[Service owner](../service/README.md#自定义-mcp-表单与启动配置)。

[MCP 反馈投影](src/native-mcp-feedback.ts)集中维护有限错误文案与确认失败的合并。同一 Store／来源的失败只保留一条当前摘要，新的确认成功不继续展示旧失败；主进程记录顺序与状态保持权威，本地回执只补尚未送达的 ID，不按 UUID 推断时间。关闭摘要只顺序清除其中准确的 confirmed failed 原 ID；未知、旧协议或不可关联记录不并入失败组，仍各自保留查询／取消资格。HTTP 提示使用 Service 从真实响应状态码投影的有限错误类别，网络与认证错误按已知事实给出下一步，不按域名覆盖实际错误；未知原因不编造状态码、不显示原始响应文本。

[服务菜单](src/native-mcp-components.tsx)只在 ready／connecting 显示“断开连接”；普通 failed 不显示断开。outcome_unknown、失效旧配置或仍持有旧目录 generation 时显示“清理连接”，继续提交原 disconnect 操作，配置损坏时的独立停止资格保留。失效配置的“重试连接”使用 reconnect，以先释放旧 owner 再建立当前连接，不反复提交会返回 connection_exists 的 connect。

2026-11-01 错误反馈与菜单调整：页面整文件53项317断言通过，核不同域名遵循相同 HTTP／网络错误、未知原因不按地址猜测、重复失败合并与批量关闭、成功后的旧反馈清理、未知原记录保持独立、普通失败没有断开入口及旧 owner 清理／重连。[失败浏览器场景](test/session-shell-geometry.fixture.ts)在深浅主题、500／1280px下4项通过，核提示位于内容下方，出现和关闭时标题及连接按钮保持原位；重复重试仅一条提示，关闭提示后旧失败不重新出现，关闭侧栏后错误不转移到列表或其他服务，重新打开所属服务仍可查看和关闭；菜单只有当前适用项。证据归`.cache/mcp-feedback-YHw3kf/report.json`。逐步观察核对重试前状态、收到404后的下方提示、重复重试及关闭后的恢复，并核侧栏关闭、服务切换、重新打开与关闭提示的全过程。新增表单校验提示位于内容之后、底部按钮之前的验证沿用前次结果。Desktop 类型、Biome与文档检查通过；Service 状态码分类、测试归属与边界未变，复用前次验证。Service 回归与现有 Windows Run／Job 超时的范围归[Service owner](../service/README.md#http-oauth-与原认证结果)，不将隔离 UI 数据作为远端协议或正式发行证据。

MCP 与 Skills 的目录行共用 [NativeSettingsListRow](src/native-settings-list-row.tsx)，在 [设置样式](src/native-provider-settings.css)集中维护主标签／摘要／状态／尾部操作的对齐、窄窗换行、透明选中态、左侧2×16px短标记和单条分隔线。来源按钮与尾部开关是并列控件，行与内部按钮保持透明，行本身拥有选中标记与分隔线，内部按钮无边框；不使用 MCP 独有的字符图标和列表布局。工具参数展开沿独立的工具条目样式，不复用目录导航行的边框与选中规则。

2026-11-01 列表与操作反馈调整后的 MCP／Skills 两整文件44项359断言通过；Desktop 类型、定向 Biome、文档与测试归属检查通过。生产样式的6项深浅主题／500、800、1280px场景核对两页透明选中态与短标记、原控件取消、无普通处理中记录卡、留白、字号、单分隔线及无横向溢出，工具展开行没有标题底边；证据归`.cache/mcp-polish-DTdWo4/report.json`。逐步操作确认主列表开关不打开详情，关闭详情恢复原行焦点，工具可展开阅读；启用前／中／后没有操作记录卡插入，登录取消沿原按钮提供。仅调整展示与组件复用，原全局身份、授权、连接和未决操作恢复契约保持，认证后端与正式发行资格沿用下面原范围。

普通设置不展示已确认成功／取消的提交历史、command/action/Store/Session/association 元数据或原 fact/认证/source DTO 的 JSON。真实失败继续给出可读提示并允许清除准确终态记录，热 pending 自动核对并可取消，未知／冷记录保留“查看结果”和必要取消；数据绑定、精确原申请查询与取消资格不变。连接、来源与认证详情只展示操作所需的可读字段，删除复核保留用户决定所需的名称、地址或启动命令。

MCP 列表行只展示服务摘要、连接状态和公共 Switch，点击服务进入默认420px的共享详情侧栏。新增表单直接提交校验后的有限操作，处理中锁定草稿；新增／删除即使先受理再完成，也只关闭对应且仍打开的同一侧栏，迟到回执不能关闭后来打开的其他详情；详情根据当前连接和登录资格只提供适用的主操作，ready 时自动只读加载工具。[展示组件](src/native-mcp-components.tsx)集中维护工具目录、参数展开和公共 DropdownMenu：连接维护、授权维护及删除按当前事实进入“更多”，删除／本机退出／远端撤销使用不同说明和确认，凭据有效期编辑按需展开。普通 hot submitting／pending 不生成操作记录卡；登录／连接的原按钮变为准确原申请的取消，新增沿原底栏取消，其他服务操作的取消收进“更多”，配置不可用时的必要取消仍留在恢复区。未知和失败仅用无底色的短行放在所属侧栏的主要内容之后、底部操作区之前，错误出现和关闭不挤动服务标题与连接按钮；确认失败只在所属侧栏打开时显示，关闭侧栏不清除原记录，也不转移到列表或其他服务；未决原操作在所属侧栏未打开时仍保留列表恢复入口。终态关闭调用原 clear，不重放业务操作。菜单 Portal 留在设置 Dialog 内，Escape 先关闭菜单，取消确认回到“更多”；关闭详情仍回到原服务行。读取失败使旧观察失效，不能据此编辑或自动读工具；切换来源、刷新观察与关闭侧栏继续隔离迟到工具响应。

[设置页](src/native-mcp-settings.tsx)和新的 [Main manager](electron/user-mcp-settings.ts)消费 `user_mcp_settings`。身份只有实际 Store、认证 subject 与连接 generation，不依赖 Session／Workspace、trust 或对话目录。两个全局页在空 Store 可直接读取，普通会话选择和当前工作区移除不释放其读租约；全局身份替换、页面关闭与连接结束仍废止迟到读取。MCP 只列 user source，页面无范围切换、项目批准或项目配置行。用户从统一列表管理来源、启停、认证与连接，在共享最右侧 [RightSidebar](../../packages/ui/src/desktop/RightSidebar.tsx)新增服务或阅读工具参数；参数只显示实际已取得的 descriptor，不调用远端工具。

新增仅收无凭据 HTTP URL 或绝对 stdio command，高级声明由配置 owner 管理。Main 固定 read-set 与本次原操作，renderer 仅提供有限操作和观察 ID。Service 全局 owner 有自己的 HostMutation 与真实资源生命周期，不借用 Session Action 或建立隐藏 Workspace／Session；它不执行工具。认证、连接与真正 Agent Run 的工具授权各自独立，401 不自动 Login 或重放 RPC。关闭详情清理未提交复核和工具读取，关闭分类只释放读取，不取消已提交全局操作；取消必须明确针对原 operation ID。

[MCP 页面](src/native-mcp-settings.tsx)对当前 Store 中仍由热 Main 确认的 `pending` 原操作每750ms只读核对一次，终态后刷新登录资格及连接事实；查询按稳定的原ID调度，每次仍在处理的回执也重新安排下一次核对，避免快速响应将 busy 切换合批后丢失后续计时。其他状态更新不反复推迟计时，关闭分类或身份替换撤销旧查询。`submitting`、`outcome_unknown`、不可关联和旧协议记录不参与自动查询，冷 Main 继续把未决记录投影为未知；这些记录只由“查看结果”核对，不重发操作。已确认的401要求登录、重新认证和超时回执映射为可读提示；登录完成仅更新认证状态，建立连接仍需用户明确操作。即时失败同样刷新事实，避免登录资格直到手动刷新才出现。

2026-11-01 的 MCP 产品界面调整由[页面回归](test/isolated/native-mcp-settings.test.tsx)28项194断言与 [Main 回归](test/isolated/native-user-mcp-main.test.ts)12项93断言核对：直接添加、状态主操作、上下文确认、原终态清除、连续 pending、未知结果、取消、读失败恢复及迟到工具隔离。[隔离桥](test/mcp-settings-bridge.fixture.ts)只使用内存状态，[生产样式浏览器场景](test/session-shell-geometry.fixture.ts)在 Windows Chrome 深浅主题、500／800／1280px 下完成6项 MCP 检查，覆盖登录进行中、取消／重试、完成后明确连接、自动工具读取、菜单边界、双击与 Escape；共享侧栏另外10项布局场景通过。证据分别位于`.cache/mcp-product-A7Cxds/report.json`和`.cache/mcp-product-UjTLED/report.json`，最终样式及异步新增／删除的处理中与收尾以前者为准；刷新失败恢复和迟到写入结果不关闭其他侧栏由页面 DOM 回归核对。逐步观察确认单次添加后列表与焦点恢复、热登录状态更新、独立连接和工具展示，无新的生产诊断入口。本轮不重复认证后端或系统浏览器资格，下面原生官方 OAuth 链路证据仍按原范围保留。

2026-11-01 Windows x64／Bun1.4.3／Electron44.3.0，独立development Native从空列表新增官方SDK1.29.0的`simpleStreamableHttp --oauth --oauth-strict`：401后自动开放登录，内嵌浏览器经官方演示AS自动授权、真实回跳和PKCE换码，默认OS Vault保存成功，再明确连接到ready并读取7项工具。fresh Vault实际读取1466字节UTF-8／2932字节UTF-16材料；修复前同案例在原生2560字节限制处publication unknown，原失败记录保留。当前Profile的Add／Login／Connect均applied，401原申请failed；Workspace／Session／Run均0。原生分段取舍及容量／故障断言归[配置 owner](../../packages/agent/src/config/README.md#同-vault-的-owned-oauth-材料)。页面／Main／配置及OAuth provider共六文件73项530断言、Agent／Desktop类型、相关Biome、文档、边界与测试归属检查通过。登录成功后旧认证提示的清理另由同组件的隔离生产样式页面逐步核对；原生链路与该呈现检查不合并成系统浏览器资格。有限原操作、fresh存在及服务端计数归`.cache/mcp-auth-windows-20261101/official-runtime-fixed/official-flow-summary.json`。最终Native正常退出0，fresh后端确认测试owned材料已删除，所属进程无残留，清理事实归同测试根的`cleanup.json`。官方示例仅将localhost示例URL改为127.0.0.1；隔离构建固定HTTP回环和测试开页交接，`testDiagnostics:false`，未修改生产HTTPS／默认opener、测试中无外部账号。不取得Windows系统默认Chrome全链、外部AS或正式安装资格。

原 [Session manager](electron/mcp-settings.ts)及旧闭合 codec 保留历史申请恢复。DB7 同一 `mcp_intents` 表接受显式 version 2 全局 request，保 Store／subject、完整非秘密 operation、read-set 和摘要，version 1 的 Session 请求格式保持。容量、FULL 保存、未知不淘汰与冷行无热 POST 权保持；冷启动不自动查询或重发，明确“查看结果”只按原 ID 读取。可确证 user 的旧未知操作继续阻断冲突修改，旧项目配置不进入全局列表；无法判定来源的历史连接只显示原结果查询通知，不伪装成用户配置。确证终态不被后来 pending／unknown 降级，写文件或停止结果不确定继续保留 unknown。

用户来源被外部删除或配置不可读时，已持有的全局连接仍有明确停止入口。Main 仅对已观察到的失效／不可写连接开放准确 disconnect，其他配置和认证操作继续拒绝；同一连接已未决的 stop 不能再提交。详情只显示必要的断开操作，保原 ID、Store／subject、持久意图和资源停止证明，不能借该例外新建连接或写配置。旧 `settings.mcp.*` renderer namespace 只保 lookup／clear／close，不能重新打开 Session／项目管理入口。

新的全局设置取舍见[用户级边界](../../.agents/notes/implemented/architecture/2026-10-24-user-global-extension-settings.md)。以下旧 Session 窗口记录只证明其注明的历史输入；它们不代证新的全局页面、认证身份或客户端过程。

[用户 Main 回归](test/isolated/native-user-mcp-main.test.ts)、[MCP DOM](test/isolated/native-mcp-settings.test.tsx)、[真实 Node 维护](../../packages/agent/test/isolated/maintenance/desktop-mcp.test.ts)与迁移后的[源码外 Native 窗口](test/isolated/native-mcp-bundle.test.ts)已验证新的全局链：空 Store 无会话可用，HTTP／stdio 增删启停及连接生命周期、工具说明全文与参数／连续分页、会话切换保未提交表单与全局读取、两次 Escape、已确认终态冷开保持，以及未知原 ID 显式查询不重 POST。冷 SQL 核全局操作使用 `config.user.write` HostMutation，零隐藏 Session、Run 或 `extension.invoke`，测试所属进程与合成凭据清理均确认。Skills 的独立窗口证据归其 owner 段落。该证据使用自有本机网络和候选；全局 OAuth 的受控协议测试不代替人工系统浏览器登录、外部账号或其他平台安装资格。

[MCP DOM](test/isolated/native-mcp-settings.test.tsx)、[Skills DOM](test/native-skills-settings.test.tsx)及 [设置壳 DOM](test/isolated/native-new-conversation-dom.test.tsx)覆盖右栏归属、关闭／焦点、输入验证、复核失效、迟到读取与原提交保持。局部 UI 验证不代表外部 MCP、真实凭据或跨平台安装资格。

[私有 MCP codec](electron/mcp-journal.ts)在 DB7 的 `mcp_intents(command_id,state)` FULL 保存完整非秘密原申请，独立128行/16MiB原字节上界，坏行保字节并拒绝写，未知不淘汰。首次提交前保存，冷/foreign 行不获得热 POST 许可；明确 Check 只查询原 ID，取消需准确原 Execution 的普通持久 caller 申请。已确认终态不被后来 pending/unknown GET 降级。来源发表成功但独立凭据清理失败/未知时保声明已保存与总体未确认，不能清除为成功。[DB7/manifest15 维护](../../packages/agent/src/maintenance/README.md#desktop-db7-与-manifest-v15)保独立 codec、历史 DB/manifest 白名单及原 Store 身份，恢复不自动 GET/POST。

Profile 无三项 raw MCP 文件时 DB7 创建 v15；`mcp.json`、`mcp-approvals.json`、`mcp-auth-bindings.json` 任一实际存在则创建 [v16](../../packages/agent/src/maintenance/README.md#profile-mcp-配置资产与-manifest-v16)，同时保留上述完整 UI 资产和三项原字节／absence／proof。恢复不读 Vault，项目配置仍在 Workspace；当前 source consumer 核新 Store 与物理 scope，旧项目批准和 credential binding 不获得新执行权，普通当前 Action／Question 才可新增决定。Native codec、冷读和原请求 grammar 保持。

[真实 Main/HTTP](test/isolated/native-mcp-main.test.ts)当前1项67断言，隔离夹具通过正式控制为准确Session/Workspace持久设置Full与信任，并核applied和当前revision；独立来源批准、凭据和只读边界保持；[源码外 Native 窗口](test/isolated/native-mcp-bundle.test.ts)本轮1项29条Bun断言，driver另核实际UI与协议：两范围 Add/Remove/Select、项目批准、真实默认OS引用的bind/revoke、stdio/HTTP独立审批与ready、248180字节Unicode descriptor及零新增RPC、refresh、reconnect oldStop、下一Model schema/独立Tool Ask/一次效果、DB7冷原GET一次/POST零。两个Service PID正常退出，准确测试凭据fresh backend absence及所属进程无残留均核实。候选使用构建前固定的测试loopback网络，不冒充生产网络、OAuth、外部账号或三平台资格。

2026-10-19上述原源码外窗口在当前输入下1项29条Bun断言37.84秒通过。审批driver按准确Store/presentation Session/卡ID/revision只操作一次，避免将已保存原答案的pending快照再次点击；新的revision仍可独立操作。正式原答案GET及双Main退出后的只读SQL共同核唯一applied答案、准确decisionRevision、两成功Model/一成功Tool和一次效果。原独立审批、完整descriptor、OS引用、两范围操作、冷GET/零POST与清理及预算保持；生产审批、缓存和权限逻辑未改，原失败证据归[测试owner](../../tests/README.md#子-agent-协作-v11-验证)。

macOS owned stdio 停止结果的新增观察字段已迁入[正式连接／重连／冷结果消费者](../../packages/agent/src/mcp/README.md#强制重连持久发布与原事实)，没有删除原字段或改写未知事实。普通建立失败仅在冻结原摘要、准确新建Job及可靠停止都成立时可由原Check确认失败，随后独立新申请；未知停止或旧无摘要结果仍unknown。原源码外窗口1pass／18断言证明旧连接停止后新连接、下一轮Model独立Tool审批与一次效果、两所属Service正常退出和冷原GET／零POST；本轮真实默认stdio补齐失败→原Query→新connect→完整descriptor→独立Tool Ask／一次效果。该新增Service测试不冒称已在Native窗口重新点击失败查回；取消／退出实现未变，复用原窗口并由本轮完整默认覆盖相邻消费者，准确范围归上述进度。

窗口Host只在已验证候选的shared lease内，使用packaged runtime/config的默认OS backend准备准确自有引用；helper沿正式paired Service的有限PATH/LANG环境，父测试与Native driver仍保隔离HOME。引用ID在put前保存，失败也可准确remove；独立新helper/backend核absence后才释放shared lease并复核exclusive权。不发现用户Kite配置、枚举其他Ref或修改系统keychain设置。

[人工浏览器资格](scripts/qualify-native-mcp-browser.ts)用独立临时Profile、自有HTTPS AS/MCP和构建前固定的公开证书，保持实际默认Chrome、默认OS backend与普通Ask。准备页到达后才启动原120秒OAuth callback期限；若出现浏览器证书提示，由用户处理，脚本不绕过提示或修改系统信任。这个显式人工入口不放入自动默认调度。

2026-10-07 在 macOS26.7.1 arm64、Chrome154.0.8037.98 上，原入口 actual0/58.396秒，最终 `qualification.json` 为 passed：真实document/navigation三次、PKCE/code exchange两次、refresh一次、remote revoke一次；Clear只删本地材料，取消原Login没有交换code。三次独立Service启动核默认Vault持久复用、冷原GET零POST，以及清除后再次重开absence；准确测试材料fresh backend absence、三Service正常退出和所属进程无残留均成立。该候选网络固定为自有loopback与测试证书，`productionDefaultNetwork:false`，不证明外部AS或账号。原证据、制品摘要和4089regular/Git保持见[进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-07native-mcp-chrome-与默认-vault-验收)。CUA仍未暴露Chrome控制，实际导航由正式默认opener发起并由原wire验证；没有用fetch callback替代浏览器，也未读取其他浏览器页面。


### 内部模型调用与子 Agent

自动审核 `authorization.check` 和标题生成 `session.title` 由 Agent 保存同会话内部 Model Execution，不创建子会话或子任务，后台目录自然不把它们投影为 child；没有为此增加 UI 隐藏规则。Native 继续共用主／子 Agent 的消息渲染，权限状态从 `execution.authorization.check` 读取，旧 `review` 观察仅兼容历史。实际检查与命名输入输出通过准确 Model Inspector 读取，不塞入父／子聊天。

2026-10-22 在 macOS 的源码外固定 Provider 候选 `6769bc903db51b96330acd05663123d3b80cee2aa4f9a3f0e03f6393394e5113` 上，[通用协作窗口](test/isolated/native-collaboration-bundle.test.ts)通过 1 例／35 断言，[自动审核窗口](test/isolated/native-auto-approval-bundle.test.ts)通过 1 例／95 断言。协作过程中的两次真实检查与标题请求未增加两个普通 child；冷 SQLite 共 3 个 Session，4 次权限检查和 1 次标题 Model 均无 Run、无 child 身份。原人工卡、同 Session 接续、旧答案隔离、准确停止和重开零重放均保留。协作的 46 帧过程、原回执及冷事实保存在 `dist/acceptance/child-internal-model-boundary-defdc067-44d2-4b3f-bcfd-79b17d458cd2`；审核证据在 `dist/acceptance/automatic-check-5b15266a-d57d-4393-8992-8287027a0ba8`。本机受控 Provider 结果不代表真实外部模型、其他平台或完整发布资格。
## 普通页面控制租约候选（2026-10-27，未发布）

统一代码执行入口与内置 `computer-use` 技能为已确认设计，尚未实现，后续按[实施方案](../../docs/plans/2026-10-28-browser-computer-use.md)接续。现有页面owner、租约/授权、输入互斥、撤权与未知结果不因模型入口收敛退役；本节保留已取得证据和历史失败。新方案不把旧原子工具升级清单作为最终默认入口，也不以设计文档代替最新停止修复的实机验收或文档归位。

普通网页统一使用会话标题栏已有的“标签页”图标开合，移除重复的“浏览器”文字按钮及其手动创建请求状态。Main范围核验与保留页恢复不变；自动发现准确Browser Job仍只揭示已有页面，不为缺失恢复页分配新页。全根异步Runtime回归改为从原标签页图标创建／重开，四场景120断言通过，涵盖同一page/incarnation恢复、A／B切换、人工回应、取消与一次通知；每场景确认不存在独立“浏览器”按钮。该验证为原内存传输／Electron替身，没有新实机或模型调用。

2026-10-28按用户实测反馈修正统一页面布局：原窄栏换行方案会在接管按钮、状态或错误增减时改变工具栏高度，`ResizeObserver` 再将变化的原生视口交给 Main；这给页面响应式重排提供了实际触发路径，不能把此前静态六组无重叠当作动态稳定性证明。[NativePane](src/native-browser-pane.tsx)现在仅在44px固定单行工具栏提供导航、短控制状态、注释及页面选项；授权／暂停／继续／停止、等待原因、未知／错误与查询归各自菜单，注释通过稳定toolbar host的Portal展示指向及备注编辑。内容surface仅保留稳定viewport和网页／冻结画面、引用选区；错误重试、重复注释header及表单不再插入已打开网页的内容区；新标签页尚未导航时仍以独立起始页显示原有工具。359px及以下将前进／后退收进页面选项，279px及以下也收纳刷新／停止，保留地址空间；菜单中的导航继续核同一控制权，Agent／交接中／unknown的地址只读。各菜单隐藏时关闭且不把焦点拉回旧标签，Portal备注提交不触发地址导航。菜单与页面相交时仍由原遮盖检测暂时隐藏Native View，关闭后按原bounds恢复，不移除该合成保护。此布局替代下文历史“窄栏换行”的实现说明，不改变租约、Action或unknown语义。

浏览器严格过程检查另复现了隐藏注释面板预先解码同一JPEG、随后打开却没有第二次load事件时未自动冻结的入口问题。[Panel](src/agent-browser-panel.tsx)改为由可见性、当前scope的新鲜观察和已解码的相同帧共同准入首次冻结；已经保留的冻结和备注不覆盖，明确退出后不会被下一次轮询重新拉回指向。这个修正不调用网页Action，也不把旧scope的解码状态当作新页面的引用资格。

同轮macOS／Bun1.4.2工作树逐文件运行[页面DOM](test/isolated/native-browser-pane-dom.test.tsx)、[控制DOM](test/isolated/native-browser-human-control-dom.test.tsx)、[注释DOM](test/isolated/agent-browser-dom.test.tsx)、[普通页根组件](test/isolated/agent-browser-native-dom.test.tsx)、[跨层mock](test/isolated/native-browser-unified-flow.test.tsx)、[全根异步Runtime](test/isolated/native-browser-async-root-runtime.test.tsx)及[共享标签页](../../packages/ui/test/isolated/desktop-session-tabs.test.tsx)，共51项／1088断言通过。新增真实Popover相交→`present(null)`→关闭恢复原bounds、跨状态viewport同节点、隐藏不回焦旧触发器和Portal表单不导航回归；注释补核hidden预解码后同img/src无第二次load仍自动冻结、草稿保留、显式退出不自动重入及旧scope解码拒绝。保留输入互斥、同页恢复、原Action去重、准入前拒绝／准入后迟到及unknown断言。UI／Desktop类型、定向Biome、统一边界与文档检查通过；全根异步测试仍有既有React act调度warning。本轮没有新增Native／真实Service／daemon／模型进程，历史实机失败、窄条和清理unknown继续保留，不以布局回归追认整体Native资格。

实际浏览器另加载生产NativePane／租约菜单／Panel与Vite／Tailwind编译CSS，在1100×780、DPR1下固定同scope与同JPEG／frame seq，逐步走已打开页面的授权、接管中、Agent、unknown、交还中、人工、长错误、stale，以及菜单、注释、图选编辑和返回。240／297／359／360／480／640／800px浅色与297px暗色共8组、6736帧，工具栏恒44px，同组viewport坐标与尺寸不变、横向溢出／控件相交／越界及页面错误均为0；各组发给Main替身的非null bounds只有一种，菜单／注释及明确错误仍正常产生null遮盖，关闭恢复相同bounds。内容区操作工具与状态文字计数为0；Agent／人工动作须实际存在且具备原准入，stale禁用；注释须有已解码图片并实际打开textarea，不能跳过后计绿。240／297px注释模式地址分别保留72／98px。原低优先级收纳规则被通用按钮display覆盖的830帧失败、自动冻结入口失败、跨scope夹具诊断和漏编辑覆盖的初测均保留，最终严格矩阵不混入它们；原始结果与压缩副本在本机`.cache/native-page-toolbar-geometry-20261028/final-geometry.json`及同目录。该结果只证明生产组件／CSS和只读内存bridge的过程，不代证真实WebContentsView合成、硬件输入或本轮Native实机复验；构建仍有既有嵌套keyframes优化warning。

用户随后提供的暗色实图暴露了上述夹具`tools=null`遗漏的真实空白页组合：原起始页section／h2整个移入Popover，产生大标题、留白和高对比边框。按用户明确的浏览器入口页结构，工具／变更恢复在未导航新标签页的内容区，不放入浏览器工具栏，也不新增标签栏入口；有URL后起始页工具完全移除，原viewport节点与尺寸保持。空白页没有页面错误时不显示空的页面选项或不可用注释图标；页面选项只含浏览器导航和错误详情，使用220px／4px内边距／32px竖向操作行。浏览器浮层明确使用低对比边色、12px圆角与13px正文，地址框为左对齐13px文字及8px圆角。Shared tools与默认Web起始页保留原section／h2兼容合同；回归分别核空白工具可点、起始页→网页移除工具、无标签栏变更入口及原bounds，不把此前已开页几何通过当作这一空白页视觉问题已经验收。

修正后另以真实SessionTabs／useSessionTabs→NativePane组合、当前生产CSS与只读内存bridge核起始页：297px暗色、240px浅色各90帧，实际点击起始页变更打开原标签／reader，再回网页标签导航，工具从内容区移除且不进入工具栏／页面菜单；viewport同节点、同坐标尺寸，工具栏44px且无横向溢出。297px暗色起始页与网页菜单已直接观察截图；菜单为220×106px、13px文字和8%白色边线，发现的暗色Portal按钮黑字另修为继承前景色，最终实测为rgb(237,237,237)，浅色为rgb(34,34,34)。截图使用390px视口／DPR2，只展示真实组件预览，不代称Native实机；当前结果、源夹具与原黑字失败图均保留在本机`.cache/native-browser-home-visual-20261028/`。没有为新窗口／模型追加资格。

当前隔离分支包含待审的[页面租约](electron/browser-lease.ts)、[Main页面registry](electron/browser-page-host.ts)、[私有通道](electron/browser-page-channel.ts)与[实际页装饰](electron/browser-decoration.ts)。普通WebContentsView仍是页面owner；明确页面授权后，原Browser Job只拥有daemon/provider和租约，不拥有共享renderer。确认租约后才显示蓝色内阴影，虚拟光标只来自实际派发的同页/同导航坐标，不显示Agent目标框。

这是部分接线：跨会话保留页恢复、Main原生输入屏障、普通页工具栏和冻结注释已有代码及mock。NativeDesktop不再创建独立Agent workspace；原Job只揭示准确恢复的普通网页Tab，该页内的指向注释只展示冻结快照，保留原prompt与独立注释卡。当前mock不证明最终Native合成、真实后台任务或模型资格；此前单页spike也不等于此实现通过。设计、剩余条件与替代范围见[提案](../../.agents/notes/proposed/architecture/2026-10-27-native-page-control-lease.md)。

保留页恢复使用私有的明确目标 `storeId/sessionId/generation/viewSelection`。根组件可先展示新会话的缓存正文，但必须等待 Main 选中确认才发恢复；Main 比较全部四字段，并连同空结果回传相同范围，renderer 再校验后才能合入普通 Tab。恢复期间禁止分配新页，迟到或错误范围不得消费新会话的恢复机会。[真实根组件 DOM 回归](test/isolated/native-browser-restore-root-dom.test.tsx)覆盖 Main 仍选 A 时先呈现 B、随后只恢复 B 的时序；这修复标题/页记录错绑，不宣称此前有输入越权或网页像素泄露。

截图候选使用固定上游0.39.4 annotation容器的USER CSS与同次JPEG hash/导航绑定的CSS尺寸映射；不替换上游脚本文本，不将旧box贴到新图。样式由[准确key owner](electron/browser-annotation-style.ts)在导航和交还时撤销，异步插入/删除的范围见下述回归；固定上游合同及DPR缩放尚未实机核实，不能声称已获得干净截图资格。


本阶段复核发现并修正两处接缝：acquire的storeId现在从Runtime保存的准确Job Execution读取，与Main页面scope共同核验，不能由renderer声称；响应逐块读取，超过512KiB即取消。跨Store拒绝和超限取消有内存回归，但尚无正式Native启动链实机资格。普通tab统一、输入互斥的真实Native资格等缺口仍阻止发布。

2026-10-27 待审v1修正了私有截图读取：准确human保留租约仍可截图，capture/captureMeta计入同一在途计数；unknown/撤销拒绝，导航或撤销后的迟到像素不返回，release等待排空。新增负例先在v0复现，再由[Main回归](test/isolated/native-browser-page-host.test.ts)验证；没有据此宣称公开链路发生跨会话泄露或取得真实Native资格。

当前输入互斥候选使用[一个Main持有的透明原生输入面](electron/browser-input-shield.ts)，不是网页DOM遮罩，也不依赖每次CDP调用时临时放行实体输入。它没有脚本/preload，sandbox开启，固定CSP无外部内容；只覆盖当前网页的原生bounds，保留工具栏/Tab/会话操作。该控制面额外占一个有界Main renderer，最多一个，不计作Job拥有的进程，也不增加可浏览页面/Browser Job限额；真实退出资格尚未取得。虚拟光标/蓝光仍在原页，pointer-events:none。焦点转移不能确认或屏障/页面renderer失效时转unknown并隐藏页，随后present也不能绕过失效屏障重新开放原页。准确交还后才移开屏障；恢复由用户现有Action发起。

[跨层mock](test/isolated/native-browser-unified-flow.test.tsx)使用实际NativePane/工具栏/SessionTabs hook、Main IPC、Main租约、NativeExtensions reader/journal边界与Service transport；底层Electron、daemon和网络为mock。3项80断言覆盖鼠标/键盘/滚动的模拟命中路由、在途操作排空、重复按钮、A后台派发、回A原页零重导航、停止后页面仍由Main拥有、unknown不交还、屏障失败、跨Store恢复拒绝、A-B-A迟到/超时读取与显式重查。另一个真实NativeDesktop根组件DOM回归核普通Tab揭示、无独立Agent页、冻结备注加入原草稿及跨会话隔离（1项26断言）。这些仍不是真实硬件输入、Electron合成或真实模型验收。

当前人工交接诊断切片通过原 `requestInteractionWithReceipt` 等待确切持久Question答复，再由受信宿主核原Tool/Run/acceptedDecisionRevision与交接后的browser generation，经 `invokeActionFromTool` 执行独立鉴权的原resume/close Action。答复不是权限许可，普通Action仍排队；没有修改Core/pump，也没有后台轮询派发Action。关闭/失联只取消原等待Tool，迟到答复沿原规则留作cancelled历史，不恢复页面。工具栏的等待人工继续/停止走同一 `interaction.answer` 和Main原答复journal，结果未知不重发。Runtime mock 8项68断言与工具栏DOM 4项19断言覆盖这些路径。

同scope的控制工具栏和只读备注通过[共享观察owner](src/agent-browser-observation-owner.ts)复用Main唯一catalogue，开关备注不会撤销仍有效的控制观察。不同scope切换时先停止旧owner，旧订阅的迟到清理不释放新catalogue；只读订阅不能借共享owner调用控制。根组件覆盖打开备注后一次接管、关闭重开及切会话，共享owner负例另核跨scope清理；没有放宽Main新鲜度或重发未知操作。

当前Service已改用[异步请求协调器](../../packages/agent/src/tools/browser/human-async.ts)。确认让出后Tool返回pending，原模型可继续无关工作；工具栏通过既有Main命令journal提交“继续并通知 Agent”的独立Action。它绑定请求revision和原Run/work/页面代次，只在控制确认后以真实响应Job经 `result.include` 通知该原Run一次。此结果引用含明确来源的user-role标记，不是用户手写内容。按钮不借原Tool的Question/nested权限；旧长等待仅保留诊断。原Run已结束或请求失效时禁止恢复并提示需要新指令，不自动创建后继任务。通知结果未知保持unknown、不重投；这些路径只有固定模型Runtime和DOM mock证据，尚未取得最终Native/真实模型资格。

主动接管/继续/停止仅通过受信定义显式声明的有限控制Action进入同一活动owner的串行控制响应通道，继续正常鉴权/新鲜度和日志。其它Action仍排原队列，控制Action不能启动新Job/Tool或请求新Question。该通用最小接缝归[Agent lifecycle](../../packages/agent/src/lifecycle.README.md)，不是所有Action并发。人工阶段当前Model `browser.snapshot` 仍被Controller拒绝；UI只读截图来自Main `capturePage`，无元素元数据，不等于模型DOM/性能能力。敏感字段和采样边界仍未独立实现。

异步候选后续P1修正已将实际响应Job取消、execute最终carrier状态与Controller恢复取消串联；不能拿prepare旧资格在取消后恢复页面，恢复已派发时准确交还不确认则unknown。逐await和补偿mock不代替最终Native资格；v4保存时单轮全根UI→Main→Service→Runtime异步验证因该阻断暂缓；随后新增下述贯通mock，不据此追认v3或授予实机资格。蓝光和鼠标move/press光标由Main私有派发进入原页固定隔离world装饰；后续已补下述type焦点接线，原生合成未验收，不把JSDOM的装饰存在当窗口效果。


[全根异步贯通回归](test/isolated/native-browser-async-root-runtime.test.tsx)运行真实NativeDesktop、普通网页工具栏、NativeExtensions／CallerJournal、Main IPC／页面host、Service desktop-browser transport、Browser Controller／协调器和Runtime／SQLite。只替换Electron、daemon/provider以及传输I/O；Main journal使用内存PrivateData，客户端薄适配进入真实Runtime，私有fetch/WS在内存连接原handler，不是实机端口或正式配对网络。测试驱动通过普通run.start intake提交一次任务，模型工具由固定provider产生；不覆盖Composer发起任务的整条输入链。

三场景核同页先授权→模型request_human成功返回pending→后续模型已开始无关工作→真实UI人工continue Action→一次关联结果→原任务重新snapshot再一次点击、Run completed和真实mock页面独立计数。人工阶段切B拒旧scope观察，回A以“浏览器”入口恢复同一page/incarnation，开关只读备注不撤控制catalogue；它不承诺自动展开侧栏。另核已接纳ACK丢失只lookup原Command、回应在B迟到不改变B且A继续后台完成、原Run取消后重开页面不允许旧请求继续。关闭只停止原daemon/租约，Main页仍存在；该清理计数仅替身资源，不是OS进程终态证明。

当时最终该文件3项86断言通过，Desktop types exit0；日志保留React act测试调度警告。首次夹具的过期消息序号、错误地址标签/清理方法及缺失模型协议元数据曾失败，原日志保留，已改为实际SQLite消息与一致模型配置。该阶段只增加测试和资格文档，v4生产源码不变。最终Native合成、真实硬件互斥、输入type焦点和真实模型资格当时仍缺，未启动新实机；后续焦点接线范围见下文。


2026-10-28一次获准的最多5分钟隔离实机尝试在03:43:11–03:44:03 UTC运行约52秒。Electron Main原PID/birth已登记，但测试包装脚本的`__dirname`被Bun固化为源码目录，错误加载Main路径，尚未执行正常Main/paired Service或创建测试网页；模拟模型请求和网页效果均0，所有浏览器交互/输入屏障/坐标/原生合成项目未运行。首次另一个不存在的可执行文件路径在posix_spawn前失败，无PID；原记录保留，不能算作成功启动。实际Main由所属句柄发送SIGTERM后退出143，准确原身份随后absent，模拟端口关闭；未取得辅助进程/renderer的完整观测，cleanup仍unknown，隔离数据保留，不推断完整Electron派生树退出。旧unknown目录身份和mtime未变，也未重开实例。

包装修正改用运行时`app.getAppPath()`；编译后纯内存两项测试复现旧路径错误并核正确app/Main绑定，无Electron/端口/模型启动。修正不授予实机资格；原正常Main/Service生产源码未为该失败修改。只读全机ps此前被系统权限拒绝，未换路线枚举或重试；后续只核本次准确创建PID/birth，不当作全机或后代清理证明。新的真实客户端验收仍须独立明确授权，不能沿本次实例名额自动重跑。

随后一次隔离实机在2026-10-28 12:05:52–12:05:59（上海时间）启动了普通Main、配套Service和本地无凭据网页。页面收到程序化点击，但文字注入未产生input事件，夹具在首次人工输入断言处停止；模型请求和网页业务效果均0，尚未进入租约、屏障或装饰验收。原报告保留于本机`.cache/local-live-v5-20261028/RESULT.json`。Main退出0、登记的owned子进程关闭、已观察Electron身份样本absent、本次监听端口关闭及两个WebContents销毁，只证明该报告明确覆盖的成员；不证明完整Electron后代树或daemon coalition。Browser Job未创建，隔离资料保留，前次unknown不被覆盖。修订后的程序化输入夹具等待准确焦点后仅注入一次；其与包装预检共4项9断言为纯内存测试，没有重开实机验证。

2026-10-28，`3c45bbb0c`加当前候选工作树／macOS arm64／Bun1.4.2：补齐[固定焦点读取](electron/browser-typing-cursor.ts)，在Input.insertText或按键派发前只取当前可编辑焦点的可见视口中心坐标，不读取字段内容、不改变焦点。读取计入原租约在途数，导航或撤销后的晚坐标拒绝，随后不派发输入；无有效位置则清旧光标。当前支持主文档及其开放Shadow DOM，iframe焦点不猜测内部位置。实际输入调用后才绘type光标；派发失败只清本次光标，旧失败不能清后继位置。

同轮样式owner按导航复用固定USER CSS，导航/交还等待准确key撤销，迟到插入也收口；清理失败保unknown，debugger仍尝试分离，不确认人工控制。原租约期限、页owner和Tool/Protocol版本保持。四个[租约](test/isolated/native-browser-control.test.ts)、[Main](test/isolated/native-browser-page-host.test.ts)、[焦点](test/isolated/native-browser-typing-cursor.test.ts)、[样式](test/isolated/browser-annotation-style.test.ts)回归27项149断言通过；[跨层mock](test/isolated/native-browser-unified-flow.test.tsx)3项84断言包含实际Main端口的type坐标与交还后样式清空；[共享transport](test/isolated/native-browser-shared-transport.test.ts)12项163断言和上述全根异步mock3项86断言通过，Desktop类型检查通过。全根测试仍有原React act调度警告。该代码阶段没有新实机/模型启动；最终Native合成、真实硬件输入互斥、固定上游截图/DPR和真实模型资格仍未取得，提案保持部分实施。

随后用户明确允许一次最多5分钟的新隔离Native验收。2026-10-28 12:37:30–12:37:45（上海时间），当前Main/生产renderer与真实配套Service在新Profile运行15.697秒；普通原生页确认焦点后收到一次程序化input，值为无凭据测试文字。点击“交给Agent”时实际按钮缺失，夹具停止并正常退出；受控模型请求0、Browser Job 0，没有进入租约、输入屏障、type装饰或人工交还资格。BrowserWindow截图已实际检查，应用外壳可见但没有原生网页像素，不能用其证明最终合成，也不能仅凭这张截图认定实际原生页为空白。报告和截图保留于本机`.cache/local-lease-20261028-1`，不覆盖前两次失败。

失败后定位[Main](electron/main.ts)首次接线：注册Native Browser IPC发生在renderer加载及首次attach之前，私有通道却由attach后的`openCaller`惰性创建，原条件把undefined永久捕获为automation。现注册直接绑定同一Main页面host，私有listener及Service继续沿原惰性生命周期创建；Windows继续不装配此能力。[Main生命周期回归](test/isolated/native-main-scheduling-lifecycle.test.ts)先复现注册时automation缺失，再核renderer读取尚未完成/Service尚未启动时host已绑定，后续配套Service取得同一私有通道；完整文件28项通过、3项Windows专用跳过、330断言，Desktop类型检查和定向Biome通过。该修复尚未启动第二个实机复验。

本次Main退出0，包含Main在内的12个已观察身份样本最终absent，7个已登记owned子进程均有关闭回执，两个WebContents销毁，本次mock/Main监听端口关闭；这仍只证明已观察范围，未独立枚举完整Electron派生树或daemon coalition。Browser Job未创建，隔离资料保留；三处旧unknown目录dev/inode/mtime保持。一次实例授权已消耗，修复后的Native租约/输入互斥/合成验收仍未执行；完整资格继续缺失。

用户再次明确允许一个同范围、最多5分钟的隔离实例。2026-10-28 12:45:59–12:46:45（上海时间），修复后的当前Main/生产renderer与配套Service在新Profile运行46.169秒。普通UI手选本地受控模型后，经Composer提交一次原任务；“交给Agent”实际出现，普通页程序化输入成功，准确所属CGWindowID的OS窗口截图显示实际原生网页像素，补正了上次仅用BrowserWindow.capturePage无法取得合成画面的取证范围。该结果只覆盖普通人工页与授权入口，不证明Agent蓝光/type光标或输入屏障。

本次Browser open返回starting引用，随后原Job已进入launch/导航路径，但首次snapshot最终失败为browser_control_not_owned，原Browser Job保持browser_startup_outcome_unknown。固定替身收到3次请求后按失败终止原Run，没有填入、业务按钮点击或人工继续操作。失败画面中的测试输入已随导航清空，计数仍为0；此可见结果不补造导航ACK。报告、原制品和过程画面保留于本机`.cache/local-lease-20261028-2`；旧失败不改写。Main退出0，13个已观察身份样本absent、7个登记owned子进程有关闭回执、3个WebContents销毁、本次监听端口关闭，三处旧unknown目录身份保持；准确Browser私有基目录只读核为空。后者与Main样本均不能代替独立daemon/coalition终态证据，原Job unknown继续保留。

失败后静态核固定上游0.39.4的单页事件合同，定位[Service适配](../service/src/desktop-browser.ts)省略sessionId而上游生命周期等待要求空字符串的差异；准确源码与修复范围归[Service owner](../service/README.md#native-单页控制租约候选)。受控生命周期回归先红两项，修复后完整14项181断言通过，全根异步mock补核备注层所属surface后为3项89断言，Service/Desktop类型检查通过。修复未在本次已结束实例中重放或另开实例验证；该次失败不能据此改称成功。

实际297px栏另观察到文字控制按钮被导航图标的固定28px规则挤压，与地址栏重叠。[Native样式](src/native-tailwind.css)现只给icon-sm按钮固定图标尺寸，文字按钮保原size，并允许窄栏换行；备注覆盖层由[NativePane](src/native-browser-pane.tsx)放入网页surface定位，不再以固定42px假定工具栏高度。生产Toolbar/样式在独立组件页经内置浏览器核297/800px×授权/Agent/人工六组，全部控件在边界内，无横向溢出或相交；截图和几何结果为上述目录的toolbar-layout-verification文件，备注层接线另由上述全根DOM核对。该组件检查没有启动新的Native/daemon/模型，也不代替最终Native阶段切换验收。修复后租约、输入互斥、type光标与交还清理的整链实机资格仍缺。

2026-10-28继续修复同一候选，未重开Native。[页面host](electron/browser-page-host.ts)的acquire/resume在等待attach后均重核本次准确租约及acquiring；失败或外部失效后的迟到成功不能返回lease或重挂监听，Main与UI发布一致保unknown。原resume失败曾停留acquiring、UI仍为human，acquire也曾接受失败后的晚成功，均先由纯port回归复现；修复后[Host完整回归](test/isolated/native-browser-page-host.test.ts)14项102断言通过。

[Main截图](electron/native-browser.ts)在读取metrics前绑定attachment代次、控制阶段、page incarnation、browserId、导航及本次截图序号，每个await后重核；截图和metadata不能用新导航标识包装旧视口，旧完成也不能覆盖较新的metadata。元数据读取继续核该绑定，导航/交还/unknown或恢复后拒迟到结果，保留原hash、CSS视口及DPR合同。另修装饰队列：旧isolated-world绘制失败后，仍执行其间排入的最新交还清除；无新更新不自行重试，永久失败不自旋。[截图与装饰回归](test/isolated/native-browser-capture.test.ts)16项65断言通过，包含正常DPR2、两处await失效、同public state下重接及旧完成覆盖保护。

同轮人工回应在恢复后资格读取/诊断写入异常时补偿准确租约，unknown显示不再被Run结束覆盖；实际因果与27项Runtime回归归[Browser owner](../../packages/agent/src/tools/browser/README.md#异步人工交接候选未发布)。上述全根异步mock3项89断言、共享transport14项181断言和Agent/Service/Desktop类型检查通过。本轮修复仍只有受控回归，未补齐最终Native输入互斥、光标与交还整链资格；此前全部失败及unknown保持原事实。

用户再次明确授权一个同范围、最多5分钟的隔离实例。2026-10-28 13:19:38–13:20:38（上海时间），当前源码重新构建的普通Main、生产renderer与配套Service在新Profile运行59.760秒；本地无凭据页和受控兼容模型替身之外没有外部模型或既有Profile/Cookie。实际观察普通人工输入→明确授权→open→snapshot→click聚焦→fill，同一WebContents id=2／PID54746保留，页面文字为`agent-ordinary-text`，业务点击计数仍为0。准确所属OS窗口截图实际显示蓝色内阴影与type光标，原页装饰是pointer-events:none；顶部原生屏障id=3可见，向该观测到的顶部View程序化投递点击、文字和滚轮后，原页输入计数/文字、鼠标事件数、业务点击和滚动均保持，原页没有获得WebContents焦点。该切片证明同页填写、实际合成和这条程序化屏障路径，不证明OS物理命中、键鼠/IME或完整交还互斥。报告、构建摘要及manual/agent过程截图保留于本机`.cache/local-lease-20261028-3`，旧实例未重放。

本次未通过完整验收：Agent画面观察的ACK在22秒夹具期限后约2.6秒到达，原脚本以`fixture_wait_timeout:false`停止；本地Bun替身默认10秒idle还使等待gate的模型请求失败并产生两次同内容请求，不能把它们算作人工Tool已执行。没有进入request_human、独立文件读取、人工继续或一次业务点击资格。失败退出时，原脚本等待正常Main drain 25秒后发出准确Main的SIGKILL，Main以137结束，原RESULT的cleanupConfirmed=false保留。随后只读SQLite核原Run为cancelled/service_shutdown，原Browser Job `82a89d4e-5b83-4382-9608-2c9c5ca4e960`为outcome_unknown/job_stop_unconfirmed，内含browser_stop_unconfirmed；后续COLD-READ记录13个已登记身份均absent，POST-STOP核Service已absent、没有再发信号。后续消失不能改写原Job unknown或补造完整daemon/coalition终态；本轮监听端口已关闭，原三处unknown目录身份保持。

夹具修正保存在同目录`run.fixed.ts`／`entry.fixed.ts`，原run.ts、构建和RESULT均不改写：观察等待改为受总预算限制的60秒，本地替身显式idleTimeout=255，正常退出等待至多60秒且服从原绝对截止；保留原子单次预约和285秒准确Main强制上限，已存在的启动标记继续禁止此目录再开实例。新观察字段准备记录输入框computed outline与annotation容器，未以CSS隐藏原生焦点。固定上游[click/fill](https://github.com/vercel-labs/agent-browser/blob/04ba5264dade678062c3cdcce0f4f293e748249f/cli/src/native/interaction.rs#L31)不会自动调用[独立highlight](https://github.com/vercel-labs/agent-browser/blob/04ba5264dade678062c3cdcce0f4f293e748249f/cli/src/native/interaction.rs#L876)，固定[annotation红框](https://github.com/vercel-labs/agent-browser/blob/04ba5264dade678062c3cdcce0f4f293e748249f/cli/src/native/screenshot.rs#L436)均在已隐藏容器中；因此橙色输入边缘更符合原生焦点视觉是有源码支持的推断，准确computed样式未在本次采集。修正版只通过语法检查，未再启动Native；原夹具无进程预检3项8断言通过。[Main完整mock](test/isolated/native-main-scheduling-lifecycle.test.ts)28项通过／3项Windows跳过／330断言（首次沙箱拒绝loopback监听，保留日志；获准相同mock端口后通过），[Native transport mock](../../packages/agent/test/isolated/browser/native.test.ts)1项通过、内部391断言及2条Bun断言，含挂起请求取消与迟到成功不复活。实际关闭合同等待资源完成、没有25秒硬退承诺，本轮没有据此更改生产退出逻辑或版本；完整人工交还及清理验收仍缺。

随后用户明确要求使用真实`gpt-6-luna`、低思考继续实机验证。在全新隔离HOME／Profile中，通过正式本机Codex自动接入，只给所属子进程指定原认证目录，不复制认证、不写用户偏好、不读取浏览器既有Profile/Cookie。普通模型选择界面准确选路由并以GemSlider Home选“轻度”，原Run冻结的adapter/provider/settings再核`codex/gpt-6-luna/responses/low`；本机原high偏好不改。协议选择也符合[官方Luna模型说明](https://developers.openai.com/api/docs/models/gpt-6-luna)中low工具调用使用Responses的范围。真实模型自行产生工具调用，驱动没有固定provider/gate或伪造通知；页面与文件仅含本机合成测试内容。

本轮准备／失败记录按本机`.cache/real-lease-luna-low-20261028-1`至`-6`分别保留，不互相覆盖：前两次在窗口／导航尚未就绪时过早读取，运行0.882／5.825秒、Main均退出0，外部Model和Browser Job均0；只读准备等待已补回归。第三次13.389秒有2次真实Model成功及1次取消，snapshot的`generation:"??"`被正式schema在派发前拒绝；省略未知generation的参数映射纯复现成功，未发现Responses转换缺陷。驱动曾在模型自纠前停止，后改为仅允许同Run处理明确的派发前参数失败，未知效果仍终止且不重投；原记录不改。

第四次13:46:23–13:48:13（上海时间）、109.805秒已取得填写／屏障／人工交还／人工输入／独立文件工作，但继续后立即切B尚未见响应Execution，约11秒后状态又为A，原轮以`a !== b`停止。私有响应意图`16766b30-d403-4497-bc22-c0c2ec2a1cdd`为unknown，Core对应命令为零，既不能补称受理，也不能仅据此证明曾POST。原选择变化没有准确select IPC取证，原因未定位。原Browser Job为job_stop_unconfirmed；夹具最终准确Main强停137，原cleanup=false保留。其已登记Service PID68333后来仍活，暴露原夹具只守Main的期限收口缺口；14:01:03按原birth核身份后SIGTERM／3秒后SIGKILL，准确身份absent，另存OWNED-SERVICE-STOP，不补造原Job或daemon整树confirmed。修正版夹具的285秒收口另覆盖准确仍活的已登记自有child，共用一次3秒grace；PID复用／身份不可得不发信号。该修正只有纯端口回归，未改生产退出策略。

第五次13:56:44–13:57:43、59.175秒完成真实核心操作链：同一原生页填写、蓝光/type光标与程序化顶部屏障；request_human成功pending后原Run读取独立文件；人工阶段debugger分离、屏障及装饰清除，测试输入恢复；继续Action实际准入后选B，原A收到一次关联结果、换新generation重新snapshot再业务点击一次，随后显式回A，原Run `c5f88378-d933-4e83-8152-b5d7166468ed` completed。同一页独立计数及本地服务跨导航effects均为1。14次Model全部succeeded且准确gpt-6-luna／low；中间旧generation snapshot安全拒绝，模型重新快照后才用新generation／seq16点击，没有重放未知效果。唯一respond_human Job与human_wait carrier／原请求／原Store／Session完整绑定，唯一applied result.include、receipt和显式result_ref吻合。原脚本只因将wire revision字符串`"1"`与SQLite整数1直接比较而保留acceptance=false；独立只读COLD-REVIEW九项全通过，并核原RESULT SHA前后不变，不能把原脚本改称成功。Native select IPC及UI点击只有显式A1→B2→A3，效果发生在B期间。UI停止原Browser Job后其cancelled／cancelled结果、准确close Action成功、Main debugger分离和装饰清除均核实；Main退出0、13个登记身份absent、自有监听端口关闭、三处旧unknown身份保持。完整daemon/coalition独立终态与物理键鼠／IME仍不由这些样本取得。

本轮还实际看到第五轮备注画面窄条，未以核心冷核覆盖它。当前生产AgentBrowserPanel／完整样式在297×617的离线组件中，以1×与2×源图连续66次采样未复现；随后第六次14:11:23–14:11:52、29.263秒仅用真实同型号low模型做open／snapshot／fill和备注捕帧诊断，不重复人工回应链。即时与700ms的原JPEG均297×617，DOM image/frame约299×621.15，准确OS窗口正常全栏；Main退出0、原Browser Job停止确认、13个登记身份absent，原始JPEG／hash／布局和阶段窗口已保存。该结果没有解释第五轮窄条触发条件，不能称已修复或完整备注资格；没有据此修改CSS或隐藏原生focus。实际computed outline为auto／rgb(229,151,0)、inlineStyle为空，补齐前述橙边的原生焦点证据。

新增[真实Caller选择回归](test/isolated/native-browser-action-selection.test.ts)2项22断言，以真实Caller／Extensions／Journal及内存端口分别核准备中切B的零Core提交、已准入迟到ACK保持B与旧activation拒绝；[全根异步mock](test/isolated/native-browser-async-root-runtime.test.tsx)现4项116断言，分开pre-POST拒绝与post-admission迟到ACK，原unknown／取消期望保留。Desktop类型检查通过。隔离夹具选择／配置／准备／安全参数失败13项36断言，revision及自有child期限收口5项14断言通过；修正版只保存为run.corrected，不重写已执行脚本或旧结果。以上为本次真实模型核心路径及诊断范围，方案仍未整体完成或取得发布资格。

2026-10-28首次使用入口修复候选：普通自然语言不再依赖预先手动arm才有机会进入同页控制。[Service授权适配](../service/src/desktop-browser-authorization.ts)在原browser.open调用operations.ensure之前发持久Question，准确展示Main保留的页面身份、目的网址与登录状态范围；接受信息须与原Tool/Run/Store及实际answered Interaction/revision吻合。Main的prepareGrant只预留原请求，零新页面／attach／导航；commit按同receipt一次生效，已有页固定incarnation/navigation/grantEpoch和选择stamp，缺页仅在接受后创建空白页。acquire验证原Tool父链许可且只消费固定页面；不会扫描另一个armed页替代。拒绝、取消、页面／选择变化和过期清理尚未消费的原许可；消费后由原Job的撤销路径负责。短请求不等待人工，提交ACK未知只inspect原requestId，不重问或重投。原手动授权仍可直接使用，工具及协议版本保持。

[Main授权回归](test/isolated/native-browser-grant.test.ts)、[真实Runtime授权回归](../service/test/isolated/desktop-browser-authorization-runtime.test.ts)和[Service回执反例](../service/test/isolated/desktop-browser-authorization.test.ts)分别检查固定页面、拒绝／取消、选择ABA、真实持久Question与父Job绑定、伪造回执和丢ACK零重投。此处Runtime使用固定模型、Main使用内存页，尚不代证修复后的真实Native／外部模型完整流程。此前首次未授权的grant_required被通用startup_failed及后续stale掩盖；Controller现只对确认无lease的启动前白名单保留原原因，准确closed generation仍返回原启动失败，foreign仍stale；导航已派发或清理未确认继续unknown。旧实机失败及unknown保留，不改写为本次成功。

修复后的首次真实模型尝试保留在本机`.cache/browser-complete-luna-low-20261028/attempt-003`：普通Native构建关闭testDiagnostics，隔离HOME/Profile，真实gpt-6-luna/Responses/low从普通自然语言触发原browser.open的具体新页Question。回答前原生页与Browser Job均为0；普通表单允许后，同一Tool创建唯一原父链Job。但新View仍为PID0/空URL，启动未完成，后续停止未确认，snapshot成为browser_stop_unconfirmed；本轮没有填写或业务点击，不算成功。此现象与新页只构造、未初始化空白文档的缺口吻合；进一步修复及新实机证明仍待完成，旧结果不改写。当前DOM实际可见、toolbar44px/viewport297×687，此失败与此前夹具误操作隐藏页分开记录；具体启动CDP轨迹尚未完整取得。

该attempt-003冷查确认2次模型均为gpt-6-luna/Responses/low；原Browser Job保持outcome_unknown/job_stop_unconfirmed。正常停止请求已销毁窗口网页，但Main在120秒内未确认退出，夹具按原PID/birth核实后终止Main；原Service亦经TERM/KILL后准确身份absent。原launchd标签最终113 absent、已观测guardian及准确私有目录absent；这不独立证明全coalition终止，也不把原unknown改成confirmed。旧三处unknown目录identity保持。此退出失败仍属当前实机问题，不能称正常清理通过。

新页初始化修复候选让已明确允许的新页面先加载本地about:blank并等待有效renderer/文档，再arm并让原Job导航；普通state.url保持空、起始页仍显示。已有但未导航的空页和手动armed空页在acquiring接入阶段复用同一初始化Promise；已有HTTP页面不额外导航。主frame的about:blank仅在该内部初始化窗口放行，初始化有5秒边界；期间取消／选择变化、页面被替换、超时或失败均不可接入，迟到成功不复活授权。并发相同receipt共用初始化，不多建页面。对应[registry回归](test/isolated/native-browser-grant-ipc.test.ts)验证这些Main适配边界；新真实模型完整复验仍未完成。

本机attempt-004使用获准空页初始化候选重新构建，真实gpt-6-luna/low在无页面时再次发正确Question；同一选择、16秒内的允许却在创建前被Main判expired，故空页初始化的修后实机仍未跑到。随后正式Question拒绝得到browser_page_grant_denied且保持零Job／页面；真实模型又用ask_user重复请求许可，该体验亦不合预期，工具说明已补明确拒绝／取消后停止原尝试，不用通用询问覆盖决定。Root按普通UI取消该轮。3次模型均为准确Responses/low；实例正常退出0，11个已观测PID/birth全absent、无强制尾清理、旧unknown保持。具体scope误判原因和修复继续由Main owner核对，不以零效果拒绝称浏览器主流程通过。

Main针对同选择刷新增设私有grantScope，只沿NativeCaller已保存且同selection代次的Store/Session身份核原许可；普通viewLoading期间不因缺少新权限投影误判换会话，真实backgroundUnavailable、权限读取失败、无scope、子会话或已删除会话继续拒绝。Renderer selectedScope的fresh写入检查保持，配置后的grantScope返回undefined不得回退。[Main生命周期回归](test/isolated/native-main-scheduling-lifecycle.test.ts)用真实NativeCaller/Controller/observer刷新链先复现误拒，再核同stamp提交、ABA及失败关闭；[IPC回归](test/isolated/native-browser-grant-ipc.test.ts)核无fallback。attempt-004未记录当时瞬态scope，故此为与实机现象吻合的可复现源码原因，修后实机仍待新实例验证。

本机attempt-005首次真实主流程已跑通：自然语言→具体新页Question（回答前0页/0Job）→原Tool/唯一Job→同页snapshot/fill；一次browser_stale_element在派发前拒绝后，真实模型重取snapshot再click，服务端独立计数1，最终Run completed。实际OS合成显示紧凑toolbar、蓝光与光标；Root之后的程序化Agent输入打到顶层shield且原页未获焦点，人工pause的Main release confirmed:true/detached:true。人工输入恢复夹具却在焦点确认前超时、没有派发文字，不算恢复通过。用户实际观察到页面内容持续缩小／放大，因此该轮体验失败，外框297×687稳定不覆盖此失败；36帧Agent及36帧人工CG快照的局部文字像素相同，也未捕到瞬时画面，不能据此否定现场观察。原Job随后普通UI停止confirmed，页面仍由Main保留；进程最终结果归该目录原RESULT，不覆盖旧unknown。

截图闪烁原因已核到准确上游版本：[Electron44.3.0 DEPS](https://github.com/electron/electron/blob/v44.3.0/DEPS#L3-L4)固定Chromium152.0.7977.78，该版[PageHandler](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/devtools/protocol/page_handler.cc#L1404-L1446)在clip存在时内部改变viewport scale/widget尺寸，截图回调才恢复，不必出现Emulation CDP方法。Main此前每次加clip.scale=scale/DPR，DPR2时临时缩半，已有的外框几何检查不足以观察该内部路径。[截图实现](electron/native-browser.ts)现剥离clip并捕获原viewport无损PNG，再在NativeImage内存中缩放及按原格式/quality编码；原导航／lease／capture序列／最终hash与CSS基准宽高检查保持。只避开缩放机制的[18项截图回归](test/isolated/native-browser-capture.test.ts)及类型检查已通过，新Native连续画面资格仍待完成。

本机attempt-006保留首次Question失败：允许后已初始化新空View，但factory仍用Renderer fresh selectedScope，loading期间scope空导致未向Host注册，Main明确返回grant_create_failed，Service inspect后显示expired，产生未用孤页。现私有create(id,原grant scope)将准确Store/Session传给工厂，并在同步未注册失败时仅清理本次空白allocation；公共Renderer创建的就绪检查不变。[真实Caller＋原工厂回归](test/isolated/native-browser-grant-ipc.test.ts)先复现上述失败及孤页，修后核同selection loading提交、唯一页面和restore。007仍须新实机验证，不以手动授权替代首次使用。

同一attempt-006的明确手动授权分支使用真实gpt-6-luna/low完成Unicode填写，0业务点击；初始3674帧的viewport/visualViewport保持297×687/scale1，用户现场确认静止时缩放已稳定。但用户再指出客户端resize会闪烁；21步程序化窗口缩放在Agent阶段21/21次page.hidden，交还人工、debugger detached后重复仍21/21 hidden，过程截图和JSON保留于原runtime/resize-agent与resize-human。原因是Main每个window.resize都调用全局hide，再由Renderer下帧present重新显示。修复候选改为resize仅同步屏障，不清active/Host.visible，真实window.hide/null/屏障失效仍隐藏；有效bounds同栈对齐page/shield。截图另核尺寸epoch及原像素≈CSS×DPR，拒绝晚到旧尺寸和异常硬拉伸，pure x/y移动不丢帧。[截图回归](test/isolated/native-browser-capture.test.ts)22项155断言通过，含12步连续resize可见性/边界和迟到图像。007实机连续resize与人工观察仍待完成，006失败不改写。

本机attempt-007由普通Main／生产renderer与配套Service、全新隔离Profile运行，50次Model全部为准确gpt-6-luna／Responses／low且succeeded；这是直接构建的普通客户端，不是desktop:dev路径。首次自然语言在0页面／0Job时发原持久Question，允许后唯一原父链Job完成同页填写和一次服务端独立业务点击。原工厂scope修复已跑到。21步Agent和21步人工连续窗口resize均保持页面可见，page／shield同bounds，Agent阶段实际setVisible轨迹没有false；旧006的21/21隐藏失败保留。用户对新窗口手动拖动反馈“暂未观察”，这不是物理live-resize的完整通过资格。初次侧栏入口仍有248→297宽度展开，稳定阶段与入口动画分开。

同一007的程序化输入覆盖实际顶层shield阻断文字／点击／滚轮、人工debugger分离后的文字恢复、继续原Job换generation、真实模型scroll100，以及相同滚轮在Agent阶段保持100／人工阶段回0。它不替代物理键鼠／IME资格。随后真实模型忽略无害网页指令注入，仅填写APPROVED-42并点击一次；实际404、脚本异常、302重定向、2500ms慢响应、DOM替换和target=_blank同页导航均有原Tool过程及独立站点效果，DOM替换业务点击为1。旧元素两次安全拒绝和一次截图暂不可用后重新观察继续，不能只看最终Run completed称中间没有异常。

007仍保留两项体验失败：明确拒绝后模型换key重复Question；真实B→A→B选择变化使原许可失效后模型也重新申请。两者均未绕过授权或创建Job，Root通过普通UI取消重复等待；B→A→B原允许在10分钟内提交，不能称真实TTL过期测试。后续Service候选增加同work拒绝／待定屏障，真实模型修后仍待新实例核实。

007网络中断案例的原navigate与Browser Job均为outcome_unknown，无自动重放；Main撤销与分离明确confirmed。页面先因load_failed隐藏，工具栏保留已启用的“页面状态与选项”，这早于撤销；本地部分响应只有doctype／title、没有body，黑空像素不证明renderer挂死。隐藏页capturePage使测试夹具串行命令等待，独立OS截图和冷读仍保存；它与产品原unknown分开。夹具停止状态读取超时后向准确原Main发TERM，Main正常退出0，15个登记出生身份均absent，所属精确label／guardian／目录检查结束，三处旧unknown身份不变；这不洗掉原Job unknown，也不等于独立完整coalition证明。错误菜单与人工改址恢复仍需新实机完成。原始证据和夹具错误全部保留于`.cache/browser-complete-luna-low-20261028/attempt-007`。


## 统一浏览器入口候选2026-10-28

### 浏览器加载失败页（2026-11-03）

2026-11-04继续核对全部“网页显示尚未确认”来源：`prepareDocument`中的文档等待返回false只退休本次展示，不再推断网页失败；Agent Host／CDP detach只按attachment及读者current取消Agent读，普通显示继续等原文档。`did-stop-loading`退休当前读者但保留同epoch后续就绪资格；已提交页在没有新DOM-ready时，可由一次隔离世界`document.readyState`读取确认，回调核原epoch、frame、页面、真实错误及完整帧，导航／失败／关闭后的迟到结果不接管。主动停止且尚无可显示文档时，私有显示状态`stopped`呈现中性“已停止加载”；原页面就绪后正常显示，不重试导航。真实非取消的主框架provisional／load failure统一直接发布有界引擎错误页，普通loading通知不能擦除原失败；进程退出继续保留原故障反馈。

| 提示来源 | 本轮核对后的触发边界 |
| --- | --- |
| 普通展示等待、停止、控制通道分离、Root／scope／几何变化 | 等待或退休，不写永久display failed；不设加载或首帧期限。16ms状态合并和100ms绘制机会回退只调度，不判失败 |
| Main原生呈现 | 准确Root／页面层缺失、真实原生调用、帧订阅／清理故障保留可读失败；不以DOM-ready、URL或旧帧代替完整帧准入 |
| Renderer的`browser_presentation_unavailable` | 仅展示revision无效／耗尽、草稿sessionStorage读取或写入失败等真实排序依据不可核实；该分支无倒计时，不降低原revision／owner检查 |
| 网页网络／证书／引擎超时、进程退出 | 沿各自真实错误展示，不借通用“尚未确认”覆盖准确失败；Agent初始化／输入屏障原5秒预算不通向普通网页展示失败分支，保持原控制安全边界 |

真实Electron对照还确认，提交前主动停止可由引擎报告`ERR_FAILED`而非`ERR_ABORTED`。Main只对已记录的准确原document generation把该通用取消及原loadURL拒绝归入主动停止；新导航、后退／前进和刷新清除这份停止依据，后继同URL的通用失败仍报错。具体网络／证书错误不因停止而被忽略，已有真实失败也不被停止清除。该状态仅为私有显示事实，不是执行成功、Agent操作资格或取消效果证明。

同机Windows x64／Bun1.4.3／Electron44.3.0，`9855b3c56`加前述Root修复及本轮全路径补丁：capture、document-ready、Pane DOM、bridge、navigation与PageHost六个完整文件309项／2497条Bun断言通过；原生整链另通过提交前／后主动停止、原页接管、新导航、网络失败／重试及既有表单、阅读位置、scope、隔离与销毁。Host/CDP分离和停止晚就绪三例先红后绿；隔离真实Main／PageHost／preload／生产Pane的修前后对照在Host、CDP detach及已提交慢页停止三处重现同文案，修后等待原页并接管，提交前停止为中性状态，真实ERR_EMPTY_RESPONSE只显示原错误页且明确重试恢复。两路最终录像全部六张联系表已核对中间状态与结果，未见修后误报或重复错误页；只覆盖测试窗口及有界编码样本，不授完整Service／模型、安装版、逐屏幕帧或其他平台资格。材料归本机`.cache/browser-display-path-audit-20261104`，保留早期夹具必需回调／样式作用域遗漏、旧提交前停止预期不符及修中ERR_FAILED反例。Desktop类型、定向Biome、边界、测试归属、文档结构／影响检查通过；公共工具／HTTP协议与引擎版本保持，既有Main需完全重启。本次`iteration_complete`覆盖上述全路径排查与修复。

2026-11-04补充：首帧准备时，Root暂时隐藏、尺寸未覆盖完整窗口，或等待中的页面frame／覆盖关系已经变化，只退休准确的paint并保留loading，不把这类展示失配写成永久display failed。Main监听真实Root `bounds-changed`，沿既有当前布局重新核文档、scope、Root、几何及完整原生帧；不轮询、不加倒计时、不刷新或重放导航。准确Root缺失、引擎／进程错误、真实帧订阅及清理故障仍保留失败。受控反例已证原Root仅差1像素就会产生用户所报“网页显示尚未确认，请刷新或重新输入地址”；这证明一条同文案误判路径，不据此认定用户现场的唯一原因。

本机Windows x64／Bun1.4.3／原版Electron44.3.0，基于`9855b3c56`加本轮修复：bridge、Pane DOM、document-ready与capture四个完整文件205项／1954断言通过；[原生整链](test/isolated/native-browser.test.ts)另通过超过旧12秒的慢页、真实Root失配／恢复、失败页、导航、原表单／阅读位置与隔离。私有Profile中修前／修后窗口对照复现同一句提示：修前布局恢复仍失败，显式刷新才恢复；修后持续loading，真实Root恢复后原页接管且导航仅一次。两路最终录像的全部四张联系表已核对加载→失败或原页→真实网络错误→明确重试恢复，未见修后误报或重复错误页；录像是有界编码样本，不授每屏幕帧或用户现场唯一根因资格。过程、旧夹具刷新后未再次释放阻塞脚本的首次超时及修正后材料保留在本机`.cache/browser-root-layout-qa-20261104`。Desktop类型、定向Biome、Core边界、测试归属及文档结构／影响检查通过；未改变Agent／Service／公共协议、引擎版本或安装发布资格，现有开发Main需完全退出后重启。

普通网页展示不设独立加载／首帧超时。`prepareDocument`直接等待现有引擎文档生命周期及准确当前完整原生帧，慢页继续loading；只有真实引擎加载失败、进程／订阅故障或已失效的展示上下文结束该等待。2026-11-03用户明确要求让引擎决定超时，已删除原12秒文档等待和2秒原生帧倒计时，不能再因这两个应用期限把仍可能成功的页面封为display failed。撤页、导航、隐藏、关闭、scope／Root／几何变化仍沿原AbortController退休准确等待和订阅，恢复Windows临时节流策略；不改Agent操作期限、控制权或截图证明。

本轮基于`c82f0efea`加普通展示期限修复，在独立依赖工作树执行`bun test --parallel=1 --max-concurrency=1 apps/desktop/test/native-browser-bridge.test.ts apps/desktop/test/isolated/native-browser-pane-dom.test.tsx apps/desktop/test/isolated/native-browser-capture.test.ts apps/desktop/test/isolated/browser-document-ready.test.ts`，203项1898断言通过；超过旧12秒／2秒的两项用例先红后绿，当前完整帧及撤销／迟到回调断言保留，Desktop类型、定向Biome、边界及测试归属通过。原版Electron44.3.0／Windows150%缩放的原生对照让服务端挂起阻塞脚本：旧Main在12秒后出现与用户相同提示，引擎完成后仍失败；新Main继续loading并显示原页。新[维护中整链driver](test/native-browser-driver.fixture.ts)覆盖该慢页、网络失败页、重试／历史、隔离与原表单／阅读位置恢复，正常退出0。一次标准测试入口在UI构建阶段报内存分配失败，未计通过；随后复用本工作树已经独立构建且源码未变的生产UI／preload，重建最新Main与同一维护中driver完成整链，不把构建失败解释为浏览器失败。

修后隔离窗口全过程录像137编码帧／约15.7秒，全部10张联系表已审看：起始页→标题先出现的慢页→跨旧阈值的loading→原生正文→真实ERR_EMPTY_RESPONSE失败页→百度正文，未见旧超时提示或重复失败页；请求10fps，不授逐屏幕帧／物理鼠标或OS原子合成资格。外部百度在本次宽窄与高窗口采样中正常加载，不据此认定复现了用户现场的全部条件。另核主动停止阻塞脚本：旧／新Main均由引擎停止事件得到“网页显示尚未确认”，并非此处删除的倒计时；这是当时保留的停止展示限制，已由本节2026-11-04全路径修复替代；旧反例继续保留，不以慢页通过覆盖。材料归本机`.cache/browser-engine-lifetime-3da4f431-8ee6-4c5f-b92d-112cb1eb0956`，旧构建失败与停止对照均保留。普通网页没有引擎／工具／协议升级，也未取得安装或新增跨平台资格；开发客户端需完整重启。

网络导航失败时，[Pane](src/native-browser-pane.tsx)在内容区显示[浏览器错误页](src/native-browser-error.tsx)：蓝色图标、站点标题、目标主机、可读排查建议、次要的单行原生错误名和“重新加载”。沿应用深浅主题和原工具栏，窄栏允许换行与区域内滚动；不把异常栈、日志或响应正文渲染为错误说明。DNS、断网、拒绝连接／中断、超时及证书／安全连接按[Main有界分类](electron/browser-load-failure.ts)提供建议，未分类失败使用通用建议；只保留格式核验的ERR_名称。分类依据固定[Chromium152 net errors](https://github.com/chromium/chromium/blob/152.0.7977.78/net/base/net_error_list.h)，普通HTTP 404等网站响应继续显示站点自己的内容，不因状态码自动换页。

Main仍保留准确原WebContents与失败历史，不往网页注入应用HTML、不导航到data页，也不把错误文档当成成功。原生失败按当前URL与可用主frame process/routing身份核对，过期、子frame及取消事件不接管当前状态；正常首文档完整原生帧门、Agent文档／导航与截图证明继续保留。“重新加载”沿原id和权限门禁显式派发，开始即清旧失败详情；Agent控制中按钮禁用。输入格式或协议被拒绝时保原页；真实显示故障、进程退出与菜单故障仍沿原局部反馈。失败分类是有界展示元数据，不改变Core／Tool、工具／协议版本、控制授权或TLS验证。

用户最初选择直接显示引擎结果，后明确以所附浏览器错误页为最终样式。原版Electron44.3.0对照中，连接拒绝生成空白chrome-error文档，站点404正文则保留；本机材料归.cache/engine-error-frame-e5f3a064-ee78-434a-8e3e-469e60cd18e9。当前采用Root错误页，未保留放行空错误文档的另一套显示路径。

2026-11-03，本机Windows x64／原版Electron44.3.0／150%缩放，基于`884b2c036`加当前浏览器工作树，执行`bun test --parallel=1 --max-concurrency=1 apps/desktop/test/native-browser-bridge.test.ts apps/desktop/test/isolated/native-browser-pane-dom.test.tsx apps/desktop/test/isolated/native-browser-capture.test.ts`，199项1877断言通过；原生整链`bun test --parallel=1 --max-concurrency=1 apps/desktop/test/isolated/native-browser.test.ts`通过。断言覆盖有限错误详情、迟到／子frame／取消事件、重试清理、Agent控制中禁用与接管恢复、保留原WebContents／历史、网站404正文和正常页恢复。整链之后仅增加非法kind类型拒绝及证书展示断言，合法状态与实际绘制路径未变，复用其运行证据。

隔离生产Main／preload／Pane的真实网络失败过程中，核对正常页→失败页→重试仍失败→后退→站点404→失败→重试恢复，审看宽／窄栏、深／浅主题四张原图及全部148编码帧；采集静态元素截图时录像出现短暂局部黑帧，另以相同流程关闭静态截图交叉采集，全部113编码帧未复现。两组均核对错误页单份、地址／工具栏、loading交接与恢复的原生正文；录像请求60fps不等于独立60fps或连续物理鼠标资格。材料归本机`.cache/browser-error-page-qa-54bd70c1-d838-4295-b201-7526e3f8d59c`和`.cache/browser-error-page-qa-986fb2c9-9071-4358-ac81-096740a8dd4c`，原生整链材料归`%TEMP%/kite-sidebar-browser-ad47b296-ada0-40f9-87fa-2ed712bd6937`。这是无Service／模型的隔离生产模块验证，未新增安装制品或其他平台资格；开发客户端须完整重启，Native制品需重新构建。

### 固定 Renderer 布局收敛（2026-11-02）

网页内容区在所有平台统一为直角；原生View沿Pane量测取得零圆角，不再单独保留macOS覆盖样式。

2026-11-03手动拖动右栏曾沿稳定布局的异步单在途校准，前一回执未返回时新宽度等待。[Pane](src/native-browser-pane.tsx)现在识别准确祖先Group直属分隔线的`data-separator="active"`，在ResizeObserver绘制前复用现有同步布局端口，逐次提交实际矩形并退休旧异步回调；停止拖动后恢复原异步合并。hover／focus及无关Group不触发同步，缺少同步端口保原兼容路径。Main仍核原scope、文档token、revision与几何；不预测鼠标坐标、不刷新或隐藏原页，不改工具／协议版本。此前087对“仅动画期间同步”的描述在此扩到实际拖动，动画路径本身不变。

Windows／44.3.0／150%缩放以真实Main、preload、生产SessionPage／Pane和无凭据loopback页核两次原生鼠标拖动，并沿现有Native夹具录制24步加宽、24步反向。选定同步候选的48步Native bounds均与DOM量测一致，同一timeOrigin、输入、scrollY700及可见阅读锚点421.0208435前后精确保持，导航一次。实际桌面合成录像124编码帧含61复制帧，全部边界条带7表及18／84原图已审看；本次采样未见原版网页落后方向、整页闪空或阅读锚点跳动，但有原生页先于Root的短暂边缘差，超出稳定3物理px间隔约-8／+7px，不授跨surface完全同帧资格。额外样式通知提前和无旧回执等待的立即异步候选没有更好画面证据，已退回所选同步实现。材料分别保留于本机`.cache/win-browser-live-{6a023c47-15a4-4bc4-ad5a-ca5d1c4e01b5,67632344-a915-4a87-8ac9-ea8d64fc3ea6,10dbed8f-03fd-4587-ad80-ba05b1cf063f,8e509ed6-cc67-4b17-85bb-f9ea1c6f19f6}`；首个窗口GDI全黑录像、两次真实静止鼠标与合成指针混入导致收栏的探针失败保留，不计画面通过。最终Pane45项310断言、原生整链通过；安装制品、其他平台和完整物理键鼠连续资格保持原范围，开发客户端需完整重启。

继续优化时以独立窗口视频捕获交叉核对GDI录像，确认上述边缘差仍能在另一捕获路径中看到，不能归为GDI单一路径的撕裂。[原生夹具](test/native-browser-electron.fixture.ts)已对齐正式Windows的32px覆盖标题栏、Mica／透明背景及默认Root节流策略；旧有框／不透明窗口的证据不扩大到该配置。最终源码48步双向拖动保留原文档、输入、scrollY700与阅读锚点，窗口录像64帧的全部6张边界联系表及36／43／49／63原尺寸条带已核：中间仍有Root与原生Page边缘错位，终态回齐，没有取得完全同帧资格。层隔离、paint containment、拖动时关闭Page节流、Main invalidate及绘制后任务提交候选未稳定消除问题，均未接入；绘制后提交反而重新出现网页落后。最终材料归本机`.cache/browser-compose-plain-a91c9646-b156-41fb-a473-7167b9b37a57`。正式窗口配置的原生整链、Desktop类型及Biome通过；另在实际窗口观察loading交接、双向原生拖动和收展，输入保留、导航一次，夹具正常退出0（`.cache/win-browser-live-feb642ed-8d63-488d-904d-a5e1eac2fad0`）。该轮只补齐验证配置与结论，当时尚未彻底解决Windows跨surface错位；本轮后续处理见下文，手册预期与安全边界未降低。

本轮继续排查Windows拖拽边缘：同版本44.3.0的Viz时序显示，Root可先向旧LocalSurfaceId提交新布局，而父合成帧仍等待新Root surface；Page原生几何和HTML分隔线因此不是同一提交来源。仅请求新Root surface、过滤旧surface激活的私有引擎对照仍有反例，未接入普通客户端；准确时序保留在本机`.cache/browser-surface-trace-ace26773-a779-493b-8533-0dca5c8615c0`，旧失败和前述录像结论不抹除。

当前[原生装饰](electron/browser-pane-frame.ts)仅在Windows用两个普通View绘制分隔线与拖拽中的把手，和准确原页沿Main唯一布局入口更新。Root从实际侧栏／把手量测有界位置、尺寸和主题RGBA，经原layout准入后才让出对应HTML绘制；线条按网页整数边缘向侧栏内部取整，避开DOM分隔线。静止hover／focus继续用原DOM把手，只有分隔线已进入active拖拽时才绘制原生把手，结束即撤下，避免原生View遮住下一次鼠标命中；DOM仍负责pointer capture、键盘及可访问性。没有增加WebContents、网页副本、截图交接或独立浏览器UI；撤下、失选、错误、隐藏及销毁清理准确当前装饰，旧回执不能影响继任。普通View细条不应用Electron小尺寸clip path，避免实际线条被裁空。元数据不含页面操作或控制权限，旧layout及其他平台保原路径，工具／协议版本未变。

2026-11-03，本机Windows x64／Electron44.3.0原版／150%缩放，正式窗口配置的冻结生产组件完成两组连续往返：5 CSS px步幅的48步录像60帧、15 CSS px步幅四段换向的48步录像62帧。主Agent审看全部11张边缘联系表及各组3张关键原尺寸条带，分隔线、拖拽把手与网页边缘未再捕获旧的跨帧拉开；两组像素间隔分别为1–3及1–4物理px，属于窄边缘与缩放取整范围，不把有损录像阈值当精确物理坐标。两组同一timeOrigin、输入、scrollY700及阅读锚点421.0208435前后保持，导航各一次。材料归本机`.cache/browser-native-frame-fd773f08-dbc6-491b-9fc6-f1fd6132df4b`与`.cache/browser-native-frame-stress-1343098c-4cd6-42ca-976a-46cae19a41e1`，录制与夹具正常退出0；两组为隔离测试驱动的连续输入与真实合成录像，不冒充连续物理鼠标过程。

另在真实可见窗口从把手连续执行三次物理鼠标往返、网页输入、收起重开、A/B切页，以及百度HTTPS首页加载和两次拖动，原表单保留、本地页导航一次，未再发生原生把手挡住下一次拖拽；实际鼠标工具只给出动作前后观察，不用它替代上述连续录像。材料归本机`.cache/win-browser-live-3bafd1a3-5bf9-4cea-b45a-a9b256d889d2`，正常退出0。此前常显原生把手的命中失败和小尺寸圆角裁空反例保留在`.cache/win-browser-live-2cfdde6c-d1b7-4269-87ba-bdd28f106da7`及`.cache/browser-native-frame-1df240ca-890c-4720-a318-85a595223c7b`，未计通过。原生整链覆盖键盘、导航／历史、窗口resize、scope隐藏恢复、原表单／阅读锚点、网页隔离及明确销毁，并明确检查Windows原生装饰已准入。本轮只解决所述Windows拖拽边缘与首帧、直角要求，不授整个Root所有内容跨surface原子提交、其他平台新资格或完整安装版资格；发布链与固定引擎保持，旧开发窗口需完整重启。

本轮Windows切口按`document-before-commit`完成限定`iteration_complete`：基于`884b2c036`加当前浏览器工作树，Main／Pane／Bridge184项1797断言通过，真实原生整链1项通过，Desktop typecheck、定向11文件Biome、边界、测试归属、文档结构与影响检查通过。后续颜色校验只加强拒绝稀疏数组并补回归，不改变已观察的合法RGBA、布局或绘制路径，因此复用上述真实画面与整链证据。已核Native发布说明，本轮没有引擎、资产或发布入口变化，不改其资格。手册、active与结构Note同步实际归属；本次仅解决Windows当前拖拽边缘切口，未暂存、提交或推送，隔离窗口与录制进程均已正常退出。

2026-11-03 Windows网页标题已更新而正文持续loading的回归有两处原因：量测强制嵌套Group贴满父Panel，忽略内容框6px margin及应用标题栏；布局修正后，Windows遮挡状态仍可能阻止Root下的首帧。Pane现在按实际内容容器与CSS margin校验完整Group，沿已有layout的left/right记录边距；旧DOM尺寸仍延后，不把任意残差当固定边距。Main接受自洽的嵌套边距，外层横向仍贴满窗口；仅Windows当前首帧准备临时关闭该页backgroundThrottling，成功、取消、失败或超时恢复原值。当前文档、Root覆盖、frame/token/scope/revision、几何与有界首帧订阅保持，不新增截图读取、重试导航或Agent授权。依赖与工具／协议版本未变，macOS绘制策略未改。

同机Windows／Electron44.3.0／150%缩放下，隔离真实Main、preload与生产Pane的297px窄栏已观察从loading交接到原生正文；本地表单在收起、展开及A/B切换后保持，真实HTTPS百度首页及刷新均显示。修前隐藏页与后继首帧超时材料保留于本机`.cache/win-browser-live-*`。现有[原生整链](test/isolated/native-browser.test.ts)已加入正式NativeWindowFrame，通过导航、历史、resize、scope隐藏／返回、表单与非零阅读锚点、隔离和明确销毁；滚动初始化先等实际绘制，阅读锚点容许1 CSS px取整，文档身份和输入仍精确核对。Main／Pane／Bridge179项1731断言通过，覆盖Windows边距、旧DOM尺寸、节流策略恢复与迟到帧。这是无Service／模型的隔离生产模块验证，未验证安装制品或授完整跨平台／连续像素同帧资格；已有macOS历史反例保持。开发客户端需完整重启，普通Native需重新构建才包含此修正。

2026-11-09，新外壳布局将6px留白移到最外层后，再次出现标题／地址正常而正文持续转圈。[Main](electron/native-browser.ts)的旧准入仍要求最外层左右边距不超过1px，将Pane已正确量测的新布局判成`browser_layout_stale`。现移除“外层必须贴窗”的旧假设，外层与嵌套层均沿已有layout保存实际CSS边距；当前窗口尺寸、每组分栏宽度合计、分隔线宽度、投影和实际viewport仍完整核对。原Root覆盖、首帧、scope／token／revision与输入屏障保持，未改工具／协议、Renderer量测或平台绘制策略。新增外层留白回归已在旧Main上实际复现不可见，修后保同页resize且不多读首帧；旧嵌套留白与混合／过期量测拒绝继续通过。既有开发窗口须完整重启，普通Native须重新构建。

同机Windows x64／Bun1.4.4／Electron44.3.0：Main147项1417断言、Pane49项348断言、Bridge18项247断言、Root11项92断言及真实隔离Electron整链1项1断言通过，共226项／2105断言。首次Pane整文件出现一次hidden祖先恢复断言失败，未改该文件；单例与后续整文件通过，原失败保留，不据重跑推定确定诱因。真实整链首次被后台空标签的`.native-browser-start`误挡，driver现只等待可见页占位消失；原生显示、准确页面／文档身份、导航、隔离、表单与阅读位置断言保持，完整重跑通过。逐阶段自有窗口采样直接核本地页加载、隐藏／恢复、键盘调宽、A/B切页及真末态七张画面；原页timeOrigin、表单值与scrollY420不变，两个网页各仅一次导航。真实百度297px初次显示→收起→原页恢复→350px调宽四张画面均已查看，同WebContents和timeOrigin保持，无刷新。材料归本机`.cache/browser-shell-sequential-20261109`及原整链输出目录；早期定时采样积压导致阶段标签滞后，保留于`.cache/browser-shell-visual-20261109`，不用于上述逐阶段结论。普通development已完整重启并握手就绪，但桌面观察helper持续active-request、重连无效，因此屏幕操作复验改为明确隔离测试制品，不将其写成原用户窗口全过程验收。聚合类型、定向Biome、边界、测试归属及文档门禁按本轮执行；未调用模型、不取得macOS／Linux新实机或完整发布资格。

**结构迁移和本轮macOS arm64缩放修正已落地；完整浏览器过程体验仍保留范围外历史反例。** [Pane](src/native-browser-pane.tsx)与共享 SessionTabs 在主 Renderer 绘制标签、地址、空标签、loading及错误；[Main](electron/native-browser.ts)持有准确原网页的创建、位置、显隐与销毁。[Root工厂](electron/native-root-window.ts)在所有平台使用完整窗口尺寸的显式Root，平台菜单、托盘、标题栏和材质分支保留。Windows已有上述局部验证，Linux实机及整体发行资格未取得。持久取舍归[结构Note](../../.agents/notes/implemented/architecture/2026-11-02-browser-fixed-renderer-layout.md)，剩余验收归[实施计划](../../docs/plans/2026-11-02-browser-renderer-layout.md)；Note的implemented只指结构决定。

2026-11-02按用户要求先提交`9b158c9ea`，既有pre-commit门禁通过，随后只继续缩放灰边与header双击绘制不同步两项。收展、设置返回及用户未遇到的Cmd+W空底保留原证据，不再作为本次收尾前置。以下077–083均为macOS arm64／固定Electron44.3.0的隔离诊断，当时未接入普通客户端；随后用户明确要求合并，当前接入与验证见下文。依赖及工具／协议版本不变，也不授发布资格。

077使用当前完整静态普通Renderer、诊断关闭和原始引擎，真实系统header双击及八段拖边。348次父画面聚合中，Root152次、Page142次采用比正确目标矩形小的旧surface；目标Root bounds始终等于父viewport，687个可关联end的生产尺寸均匹配目标。两路连续图像仍有内部灰L及分栏错位：Window审看358个前6.3秒动作样本及23个尾样本，Display审看332个前6.275秒样本及17个尾样本，必要原图排除固定Window录制画布裁边。未目视各自中段，trace时钟没有硬对齐电影PTS。准确映射、尺寸、原图与范围归本机`.cache/browser-native-clip-probe-20261031/resize-frame-policy-077/runs/baseline/review`。

078c由LLDB只启动本夹具的Main，不附加用户进程；核实际Framework UUID／加载字节及固定ABI，读取最终DFH-to-Layer参数与Main提交metadata。原版五次真正变尺寸的十个handoff均specified-zero、force未启用，五个对应父提交均显式零deadline、两个依赖、interaction=false；既有getter-to-default候选对应十个handoff均default，五个父提交均default lower bound=true、两个依赖、interaction=false。不能把零count加lower=true误作零deadline。两臂完成六次尺寸命令后按准确身份计划终止，`normalExit=false`，不是普通客户端正常退出或像素验收。078入口guard失败及078b自退出未确认的旧失败保留，078c没有改写它们。

079在输入准备guard失败，未进入缩放／录制；Node退出事件0后Main仍存活，最终精确TERM／KILL、kernel absence及137失败均保留。079b只修同一地址节点的实际稳定／焦点复核并增加自有进程watchdog，不禁动画或改产品。完整运行Main／Service均0、原页／表单／scroll保持，2065份source和制品无漂移、504条模型账本不增。273次父聚合的546个Root／Page目标全部选中正确新end且尺寸匹配，230次pending都在两个依赖激活后关闭；这闭合了默认等待在该完整resize路径的作用。但Display全部324个已导样本（0–6.291667秒与19.625–19.983333秒）及两张必要原图仍见还原灰L与拖边灰列，不能授完整修复。固定[Surface依赖准入](https://github.com/chromium/chromium/blob/152.0.7977.78/components/viz/service/surfaces/surface.cc)与[Mac resize policy](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/renderer_host/browser_compositor_view_mac.mm)解释对应路径，像素和聚合记录分开作证；原证据归`resize-default-policy-079b/runs/candidate/review`。

080仅Root实窗对照原版与单独`CATransactionV2`，两臂正常退出／kernel absence、冻结输入不变。该feature在实际44.3.0二进制及固定源码中默认关闭；新[GPU CA context重建](https://github.com/chromium/chromium/blob/152.0.7977.78/ui/accelerated_widget_mac/ca_layer_tree_coordinator.mm)与[Main同步路径](https://github.com/chromium/chromium/blob/152.0.7977.78/ui/accelerated_widget_mac/ca_transaction_observer.mm)同时受它影响。baseline Display344个、V2 Display328个动作／尾样本及各自原图均已审看；baseline仍有内部灰L／右灰带，V2放大仍有巨大灰L、还原边缘裁切，不能采用单开关候选。081默认等待加V2的完整客户端也正常退出，但新实验中两次zoom各41次Main／Root bounds持续推进，Root rAF持续而viewport及surface只在起终点更新，约330ms尺寸传播停滞；与V2在嵌套循环早退的源码相容，未直接记录runloop mode，不能称该分支调用已证。该回归只属于实验，不是普通客户端新增行为。当时082仅准备保留原Main同步与GPU新context的隔离补丁，其后实际结果见下文。

082随后已实际运行：独立新引擎副本继承默认surface等待，仅在`CATransactionCoordinator::Synchronize()`的测试guard及feature读取后转既有旧Main同步路径，全局`CATransactionV2`及GPU新context路径保持启用。实际加载字节、UUID与签名均核对；普通安装及旧062／081输入不变。完整静态客户端在5485ms内完成真实header放大／还原、八段拖边与必要回宽，Main／Service正常退出0、kernel absence、2065份source和制品无漂移、504条模型账本不增。两次zoom的Main／Root bounds各22／23步，Root／Page viewport各22／23次变化，首步后最大更新间隔17–18ms，未重现081约330ms停滞。182次父聚合的364个Root／Page条目全部使用准确目标end及尺寸，145个pending均在依赖激活后关闭；Main实际pre-commit／GotCAContextFrame／post-commit各141次。trace没有逐次context ID／fence，不把feature和固定源码推理冒称直接观测GPU重建。

082 Display全部42表、335个样本已由主Agent及独立复核审看：316个连续动作样本PTS0–6.391667秒，19个尾样本19.6–19.983333秒，另核放大7张原图0.6–0.708333秒、还原8张1.291667–1.416667秒及拖边2.125秒原图；本次未确认旧内部灰L、内右灰带或明显工具栏／网页边界错位。拖边细灰竖条原图是聊天真实scrollbar，窗口外卡片属于后方Codex，不计残影。中段未目视；Window录像已解码但未授完整审看，图片显示缩放、录像采样与未硬对齐trace／PTS均不证明逐像素无缝或物理同帧。此为同版本隔离候选的有限正向结果，普通客户端仍用原引擎，不能据此把产品缺口或完整修复标为通过。原始输入、引擎、trace及画面归本机`.cache/browser-native-clip-probe-20261031/resize-sync-patch-082`，审看索引归`runs/candidate/review/display-decoded`及原图目录；准备README为冻结输入，保留其运行前状态。

按用户要求重新核固定VS Code：其[Renderer像素对齐](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/contrib/browserView/electron-browser/features/webContentsViewRendererFeature.ts#L26-L43)让DOM和Main消费同一取整矩形，[Main layout](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/platform/browserView/electron-main/browserView.ts#L640-L665)直接setBounds，没有跨surface绘制回执。其[周期截图及隐藏](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/contrib/browserView/electron-browser/webContentsViewHost.ts#L136-L216)用于隐藏／覆盖占位，不是系统resize同步；模糊拖动样式只由设备仿真内部sash触发。普通窗口使用[主题实色背景](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/src/vs/platform/windows/electron-main/windows.ts#L123-L249)，固定[Electron目标43.8.3](https://github.com/microsoft/vscode/blob/1306698e328e5e531f5e632301d30020aa994eff/.npmrc#L1-L4)也与本仓库44.3.0不同，不能由其源码或外观推定本机相同引擎路径无缺口。Kite已有同步Root／Page投影、同值去重与原页保留；同矩形取整差异最多提供亚像素接缝的待验证假设，不解释大块灰L。

083将VS Code背景差异做原版44.3.0的Root-only对照：沿080原DOM、动作与原CG helper，baseline保持vibrancy及透明backing，opaque仅取消材质并将native／Root backing设为原DOM的`#e7f1ff`。两臂正常退出0、kernel absence、冻结输入无漂移、原文档／表单／scroll140保持。baseline拖边2.525秒原图仍见绿色内容边界右侧的窗内灰带；opaque还原1.641667秒原图中绿色右线、洋红底线及蓝角仍围住较小旧内容，外侧形成同色L。两臂全部86表、678个导出样本已审看：baseline为0–7秒355个动作样本及19.6–19.966667秒14个尾样本（最后一个仅见后方Codex，结束边界未硬对齐）；opaque为0–6.591667秒308个动作样本及19.575秒最后一个持帧，中段未目视。实色只改变缺口颜色，不能当同步修复，不改普通客户端材质。证据归本机`resize-vscode-material-083/runs/<arm>/review`；原图分别归`baseline/review/drag-original`与`opaque/review/restore-original`。当前普通链路的6项定向Root／Main／Pane／投影回归、86断言通过，只支持既有几何与身份边界，不能代替像素或产品接入验证。

用户随后要求“把优化后的代码合并过来”。当前[开发入口](../../scripts/development/unified-desktop.ts)和[Native builder](scripts/build-native.ts)共用[引擎准备](scripts/macos-electron-runtime.ts)，在每次专属或新候选的独立副本内应用[固定44.3.0 arm64补丁](patches/electron-44.3.0-macos-resize.patch)，原node_modules和已存在候选保持原字节。两处指令配套采用默认surface等待、既有Main同步及全局V2；签名前全payload复核、重签后校验和源分发复核均执行。[Main](electron/macos-electron-resize.ts)在ready前核实际加载Framework、构建摘要、固定payload与两处指令后才启用feature；未知输入、半补丁和明确disable冲突拒绝，不单独开V2。Windows／Linux／macOS非arm64沿原链路。构建与制品边界归[Native owner](docs/native-release.md#构建与安装)，持久取舍归[resize Note](../../.agents/notes/implemented/bug-fix/2026-11-02-macos-electron-resize.md)。

084冻结当前2070份源码输入，以生产helper准备引擎并将proof编入真实Main；私有observer不选择feature，实际记录Main在ready前从无覆盖选择CATransactionV2，加载的Framework完整SHA与082相同。5502ms内完成真实header放大／还原、八段拖边及回宽，准确原页、表单与阅读位置保持，source／artifact drift为0，504条模型账本不增。主Agent与独立复核均审看Display全部42表329样本：动作316帧PTS0–6.475秒、尾13帧19.6–19.983333秒，未确认旧内部灰L、右灰带或明显工具栏／Page边界错位；窄栏3.725／3.741667／3.833333秒原图另核无label裁切。中段未审看，Window已解码但未授完整审看，不宣称逐像素物理同帧。**084整轮失败仍保留**：Service退出0，Node exit事件0后Main未在系统消失，最终自有80秒watchdog TERM／KILL得到137；不能把Node事件当真实退出，也不能以像素结论覆盖此失败。该退出失败随后定位并修正，原证据仍归本机`resize-integrated-084/runs/candidate`，不改写为通过。

退出对照已排除报告读取及resize补丁：隐藏BaseWindow＋WCV的六臂app.quit及六臂app.exit均真实退出0；完整artifact在配对引擎的无report／configure／额外report三臂，以及原版无V2无report控制中均重现Node exit0后的Main留存。准确post-exit sample停在NSAlert原生modal loop，默认异常observer记录`TypeError: Object has been destroyed`，栈对应[Host](electron/native-global-dialog-host.ts)的closed dispose重新读取parent.contentView；同回调还会重取parent.webContents。当前创建时保存准确contentView／Root WebContents，注册和解绑共用引用，closed后不再取已失效的BaseWindow accessor。Root document reload不替换这两个对象，确认、输入和当前页门保持。cold／warm／active销毁回归先红后绿，Host最终9pass／111assert；真实开发入口最终7pass／141assert，32540ms，Service失败、ready、更新和自有进程absence均沿原期限通过。旧134是sandbox在JS前的无效启动，旧137和默认弹窗原栈保留，详细本机材料归`resize-integration-controls`。

086在该修正后重新冻结2070份源码，生产helper／Main准入不变，5559ms内完成同一真实header放大／还原、八段拖边及回宽，准确原页／表单／阅读保持。Main26320和Service26329实际退出0、kernel absence，未触发watchdog；source／artifact drift均0，504条模型账本未增加。Display已解码763帧并导出42表334样本：313个动作样本PTS0–6.466667秒、21个尾样本19.608333–19.991667秒。主Agent核放大、还原、拖边及尾部关键片段，独立复核全部42表；本轮未确认旧内部灰L、右灰带或明显工具栏／Page边界不同步。中段未审看，Window已解码但未授完整审看，不称物理同帧或跨平台无缝。原材料归本机`resize-integrated-086/runs/candidate`，只授本机本轮范围，不覆盖收展、设置返回及Cmd+W的历史反例。

本轮核心两文件回归5pass／25assert，含真实新副本重签、源不变、半补丁／payload漂移拒绝及实际加载路径；Main生命周期38pass／3skip／440assert、类型／格式及适用边界检查通过。最终完整Native候选实际构建和搬迁manifest均过；`native-bundle`原版与初始补丁版先在“Native bundled”会话按钮定位超时，退出修正后最新运行越过该处，在[旧夹具](test/native-bundle-electron.fixture.ts)使用BrowserWindow.getAllWindows()[0]读取background时得到undefined，当前主窗已为显式BaseWindow，完整测试仍失败，不计整包生命周期通过。`native-browser`先在first.visible失败；发现夹具固定Windows/Mica与macOS生产布局不符后，仅改[夹具HTML平台](test/native-browser-electron.fixture.ts)为真实生产同值，未放宽Pane／CSS或断言。重跑已越过原可见性和沙箱隔离，随后在窄栏“后退”按钮定位超时，完整测试仍失败；当前完整客户端原页可见与连续resize证据不覆盖这些夹具失败。

当前链路是同一Pane的DOM网页矩形／panel layout → 当前owner、pageToken、Root frame、revision及窗口几何校验 → Main唯一几何应用入口。原生resize投影与Renderer校准共用计算，向内取整、同值不写；稳定校准单个异步在途、完成后重测最新DOM。首次显示与隐藏后恢复同步提交，旧scope／Root／布局不能复活旧页。Pane保留同一owner的量测effect，pageToken或visible更新不再先cleanup撤页；同次React提交的失选tab撤下在提交末尾合并，准确目标同步准入成功后取消待发旧null。Main先放置准确目标再撤旧页；不存在目标明确拒绝，不能以ok:null当成功。覆盖、真正owner替换和卸载仍立即撤下并推进revision，旧异步校准不能复活。已高于Root的drawable页保持兄弟位置，新文档从Root下完成才升层，输入屏障独立在当前页上方。正常resize不隐藏网页。

2026-11-03左侧导航收起的不同步已定位为共享投影误用终态约束：navigation的maxSize已为0，DOM仍在180ms过渡，原计算把实际中间宽度夹为0，Pane因此延后发布，Main也拒绝同一量测。现在[共享投影](src/native-browser-bridge.ts)在窗口宽度未变化时沿实际panel分配重建网页矩形，预测不同窗口宽度时继续应用min/max/collapse。[Pane](src/native-browser-pane.tsx)仅在祖先分栏现有宽度动画期间，从ResizeObserver在Root绘制前经已有同步端口放置网页；其余稳定校准继续异步合并，同值去重，旧异步回调不能覆盖动画的新revision。Renderer与Main沿用同一计算、实际矩形一致性与原有身份检查；不关闭动画或隐藏／刷新网页。定向回归覆盖收起／展开中间值、高度单独变化、实际窗口改宽、连续发布、Main拒绝不一致bounds、动画同步与旧回调隔离、结束恢复异步和缺同步端口兼容。

087以同一固定44.3.0配套引擎、独立Profile及真实Main／preload／SessionPage／Pane运行无凭据loopback页，不启动Service或模型。修前共享投影与Pane两例准确先红；004对照的四次完整开合仅有起终两种原生宽度，中途反向一直停原宽。最终005保留页面网格、边线与阅读正文，深浅主题收起／展开分别推进23／22／22／22种原生宽度，60ms反向推进19种；每次均可见，同一WebContents2／主frame／timeOrigin、一次导航、输入及阅读锚点保持，最终scrollY950。六项相关生产输入hash无漂移，两路7秒原片正常结束，driver退出0，准确Main78031已不存在。首轮的滚动绝对值夹具断言与003的测试页标记语法失败保留；002与004过程为中间候选，不覆盖最终005。

最终Window全部23表／180个导出帧已审看，覆盖PTS0–2.691667秒连续动作和6.608333–7秒尾段；Display全部10表／80个导出帧由独立复核审看，覆盖其动作及末次4.758333秒持帧。网页不再整段停旧位置再跳终态，网格与正文连续跟随，未见整页灰空或内容残片；两路PTS不硬对齐，未导出的稳定中段不授逐帧目视资格。Display原尺寸D16／0.4秒、D18／0.433333秒和D44／1.141667秒仍见Root分隔与网页绿边之间约12–14物理像素的窄差，反向D60约-4像素；此为具体采样，不是全片峰值，动画期同步准入未取得跨surface物理同帧资格。这处单帧边缘差继续保留，不能把连续布局修正写成像素完全重合。006随后仅在私有副本的准确可见Page每次setBounds后追加invalidate，两路录制与原文档保持正常，但Display全部10表／76帧及原图仍有同型约12–14像素窄差；该额外重绘没有取得改善证据，已否决，不进入生产，当前源码仍为005。

最终Bridge／Pane54项478断言、Native异步整链与Root恢复9项460断言通过；Main113项1175断言按未变Main、共享投影和测试输入复用本轮已执行结果。Desktop类型、五份TS／TSX的Biome、Core边界、测试归属、文档结构／影响及diff空白核对通过。原异步整链的React act警告和构建既有嵌套keyframes警告保留，不改工具／协议、依赖或发布资格；原工作区其他改动保留，本轮未暂存、提交或推送。当前修正同时被Main和Renderer消费，完整重启开发应用后才同时生效。

2026-11-03右栏展开动画修正归[共享SessionPage](../../packages/ui/README.md#选中与重连的后端状态核实)：标题栏重开保留页、已有页请求恢复180ms缓出，首个提交先启用过渡，避免分隔线重新注册早于RAF改宽；scope恢复与减少动态效果保持直接布局。088在同一44.3.0配套引擎、独立Profile、真实Main／preload／Pane和loopback原页做源码前后对照，不启动Service或模型。旧SessionPage三次保留页打开均为0个中间宽度／0个运行中过渡样本；当前深浅主题标题栏、已有页请求及首次空页、普通详情各为20／21，减少动态为0／0，导航宽度保持。主Agent审看Window全部43表339帧（动作0–5.491667秒及7.616667–8秒尾），独立复核Display全部22表174帧（动作0–4.708333秒及7.916667秒尾），另核关键原图；展开连续，未见网页越出右栏、旧页闪回、重复工具栏或异常残片。原生页与Root边缘仍有短暂位置差，不授跨surface物理同帧资格；未导出的稳定中段不称逐帧目视。准确WebContents2／主frame／timeOrigin、一次导航、输入、scrollY950与阅读锚点在前后及最终均一致，八项源码hash无漂移，两臂driver与录像退出0，准确Main90899／90967均absent。UI相关回归65项999断言、UI／Desktop类型和定向Biome通过；原材料归本机`.cache/browser-native-clip-probe-20261031/right-sidebar-animation-088/{baseline,candidate}`，仅覆盖本次展开动画。

2026-11-03按用户要求移除浏览器刷新及状态交接的临时文字。[Pane](src/native-browser-pane.tsx)对`browser_page_scope_denied`不再生成“会话已变化／原页面操作未发送”提示；异步布局遇到同类过期拒绝时沿现有stale路径等待新的真实通知，不由自身渲染重试。页面选项与[控制菜单](src/native-browser-lease-controls.tsx)不再把`browser_menu_state_changed`显示成临时错误；[Popup](src/native-browser-menu.tsx)仍拒绝派发过期结果。真实加载失败、页面进程结束、显示失败、控制冲突和菜单故障继续使用原可读提示；Main的页面标识、scope和控制校验保持，未增加导航重试或新权限。

[Pane DOM](test/isolated/native-browser-pane-dom.test.tsx)、[人工控制DOM](test/isolated/native-browser-human-control-dom.test.tsx)和[Popup](test/isolated/native-browser-menu.test.tsx)共67项422断言通过，新增刷新操作／同步放置／异步校准拒绝不显示文字、等待新状态、原工具栏保持与零额外派发回归，并保留真实加载及菜单故障断言。090在同一macOS arm64／44.3.0配套引擎、独立Profile和loopback页中各执行一次受控显示拒绝与一次普通刷新：私有preload仅在Main已完成真实刷新后的首次放置后注入一次拒绝，不是自然竞态的原因实录。旧Renderer的118条Root帧／DOM变更样本中40条含旧提示，当前118条均无；两臂各5张Root过程图片另核，工具栏始终一个，准确WebContents2保持，服务端命中1→2→3，每次刷新只增加一次。两臂driver退出0，八项相关源码hash无漂移；原材料归本机`.cache/browser-native-clip-probe-20261031/browser-refresh-copy-090/root-frames/{baseline,candidate}`。原系统录像及额外不可达地址探针超时未计通过；Root图片不包含独立原生网页的最终合成像素，不授Native连续画面或自然竞态复现资格。此前089的8次自然刷新未复现旧提示，原记录保留。

Cmd+W父窗隐藏时推进visibilityEpoch与sizeEpoch，退休live展示、菜单和旧截图坐标证明；保留准确drawable原页child自身原生可见性，由已隐藏父窗遮住。Main立即发新token，隐藏Root仍用原布局端口维护当前显示意图，正向只保存intent、不授live呈现；切页、收栏、覆盖或卸载的null真正撤下。Root工厂在show／showInactive之前同步完整bounds并通知Main，只有隐藏期间新确认的准确对象、frame／文档、Root、scope、Host incarnation／导航和几何仍匹配，才建立新binding并先同步当前控制屏障。采用目标同步维护lastPresented，防隐藏时换B后立即Root reload错回A。未确认或失效则撤页；minimize及绕过该前置的system show不取得此优化。迟到hide／minimize不能撤当前可见页及shield，迟到show不能消耗当前隐藏intent。原观察owner仍按真实document.visibilityState退休，展示恢复不恢复旧freshness或lease。

已删除独立Chrome host／WebContentsView／preload／renderer、远端展示与动作ACK、Root物理裁左及CDP全窗逻辑metrics、呈现witness／nonce、关闭画布和普通切页／恢复截图缓存。Root构建入口保持原名；另产出固定应用确认专用的global-dialog HTML／Renderer／preload，不恢复旧Chrome。不保留双实现或公开开关。旧captureBrowserPresentation／capturePresentation和presentationKey显示API没有生产consumer，随旧链删除；真正注释仍由[AgentBrowserPanel](src/agent-browser-panel.tsx)的observer capture经[PageHost](electron/browser-page-host.ts)及准确原页port读取。模型截图独立captureId、导航、viewport／滚动、对象及控制证明保持；显示ready不授观察或输入资格。

首开为Root空标签 → 保原地址和loading → 准确网页提交主文档及DOM ready → 当前尺寸页在完整Root下绘制 → 当前完整原生帧后升层。045实机发现隐藏新页无capturePage surface，故使用beginFrameSubscription(false)＋invalidate，不复制或缓存截图；文档与首帧沿引擎／展示生命周期等待，不另设应用倒计时。核原对象、frame、文档、scope、几何、取消与迟到回调；provider先变、旧frame先回只撤自身绑定，不把原页污染为永久failed。已可绘制原文档在普通切页、收展、会话返回、窗口重开及Root重载时复用；native完整帧和几何仍不等于WindowServer像素已提交。

用户随后要求移除通用浮层隐藏策略。Pane已删除dialog/menu/popover/sheet相交扫描，不再把aria-hidden／inert当作视觉隐藏；Radix菜单对旁边内容设置aria-hidden不再撤下网页。真正hidden／display／visibility／opacity隐藏、明确visible、错误状态及owner退休继续校验。显式快照注释通过准确当前注释模式退出真实页，不再借通用DOM标记；返回后重新确认当前几何。原生页面菜单继续直接位于网页上方，普通DOM浮层跨原生层覆盖暂不迁移；整页设置仍因业务页面实际opacity0和显式不可见而撤页。没有截图轮询、模糊占位或固定视觉延时。页面、展示、Run／任务与控制租约分别退休；切页、会话、收起、后台及Cmd+W隐藏不刷新／销毁准确原页，真正X才关闭。Root重载先接Main清单按准确ID／token复用，Main重启不保其原文档。工具／协议版本、免审批、Loop、取消、输入互斥、普通失败交原Loop和未知不重放未改变。

全局应用确认使用同一自绘方案：[Main Host](electron/native-global-dialog-host.ts)拥有主窗口内专用global-dialog WebContentsView，[层序入口](electron/native-overlay-layer.ts)在每次网页或shield插入／升层后保持完整Root ＜ 当前Page ＜ 输入shield ＜ global-dialog Overlay。Overlay的HTML／body／root透明、尺寸覆盖全部content，只有共享遮罩和确认卡片绘制底色；不隐藏、刷新或替换准确网页。它与已删除的Chrome展示层不同，只渲染固定确认，不拥有浏览器工具栏、Service或浏览器控制。持久取舍归[应用确认层Note](../../.agents/notes/implemented/architecture/2026-11-02-native-global-dialog-layer.md)。Full与移除空间由[同一组件](../../packages/ui/src/desktop/FullPermissionConfirmationDialog.tsx)复用原危险确认CSS、主题和取消默认焦点；Full保固定中英文与两条风险，空间移除沿原中文完整文案。退出应用按用户最新要求保留原生message box；目录、文件打开／保存及系统权限选择仍走原系统入口，启动致命失败保留原系统提示兜底。

[Composer](../../packages/ui/src/desktop/Composer.tsx)的可选Full宿主port仍经[Native适配](src/native-full-permission-confirmation.ts)、Root [preload](electron/preload.ts)和[原Full IPC门禁](electron/native-full-permission-dialog.ts)核准确请求ID、语言、Root主frame／URL与可见父窗口。Host只接受[固定kind状态](src/native-global-dialog-bridge.ts)，专用[overlay preload](electron/global-dialog-preload.ts)只暴露watch／ready／presented／decide，按kind拒绝多余字段；空间名称限1–256字符并按React文本显示，不接受任意HTML、文案或Service调用。Root准确应用节点在确认期间inert，且只有Root拦截before-input／before-mouse事件；Page事件不可统一preventDefault，否则授权CDP鼠标也会被吞。人工鼠标由完整原生Overlay命中，人工键盘由浮层焦点与DOM模态约束；Page已获授权的CDP键鼠保留原控制门禁。冷启动和预热未ready时立即显示完整透明原生view，遮住人工输入空档。订阅后ready，提交并经过下一rAF才presented；只接受准确当前Overlay主frame的匹配ID决定，当前false不等待presented、true仍须presented。Dialog DOM可用后Esc取消，遮罩不确认，重复和迟到决定无效。窗口隐藏／最小化、Root导航／崩溃／销毁、Overlay失败、调用signal取消均退休确认；Full还核准确会话、权限、回调及已提交上下文。退出优先取消先前确认；确认失败保留服务，并交Root显示临时可读消息。焦点操作仅在父窗仍focused时执行，后台取消不重新激活客户端；回到前台时当前Overlay接回焦点，隐藏Overlay不参与Root激活目标选择。关闭后仅恢复仍存活、原主frame且可见的原焦点对象。Native Full缺port或失败不回退DOM框；无port的共享Web调用保留原确认。只有当前明确true才回到原Controller：已有会话沿原permission.mode和新鲜观察，新对话仅改本地偏好，空间移除与退出仍由原控制器核身份和执行，Overlay决定本身不产生业务授权。

Full确认的历史OS方向已撤：070在guard失败，071只验证OS sheet打开、按钮guard失败，072仅prepare未run，均不能记为通过。073改用自绘Overlay，完整静态制品冻结2065份source，source／artifact drift均为0；macOS真实主窗口三轮Full取消／Esc／启用进入UI，Root与Page实体mouse背景阻断3／3，12次Tab保持在框内，原WebContents／frame／表单／scroll保留，Main EXIT=0，模型调用累计504且本轮未增。Window39表307帧与Display33表261帧已实际审看，范围仅各自PTS 0–5秒及末尾约0.4秒稳定尾，未见撤页灰空、遮罩漏跨Page或旧框残片；5秒至尾段之间未目视，不称完整24秒逐帧验收。两路PTS独立，不硬对齐；准确默认焦点及背景输入由同轮runtime记录补证。073只授该冻结Full范围，不覆盖随后扩充的空间／退出框，也不覆盖toast错误、resize、收展或重开。

本轮UI／Overlay／preload最终回归27pass／248assert，Host最终8pass／84assert与Root factory 11pass／92assert，Main生命周期最终38pass／3skip／440assert；退出前立即取消旧确认、拒绝quitting期间新确认，以及失败通知抛错仍保留服务的回归先红后绿。Main测试仅localhost监听在sandbox遇到EPERM后单独提权运行通过。[NativeMessage](test/isolated/native-message-dom.test.tsx)7pass／67assert；[NativeNewConversation](test/isolated/native-new-conversation-dom.test.tsx)与[WindowActions](test/isolated/native-window-actions-dom.test.tsx)最终87pass／1933assert，核临时消息替代旧Dialog、可读文案、草稿保留及原提交恢复；[浏览器IPC回归](test/native-browser-bridge.test.ts)15pass／209assert。UI／Desktop类型、定向Biome与适用core／workspace／生成API／test ownership检查通过。[read ownership](test/isolated/native-read-ownership-dom.test.tsx)17／18通过，旧Agent预览入口第832行断言仍失败；[native-browser](test/isolated/native-browser.test.ts)最小实际夹具的一项first.visible断言也失败，原因未定位，不能称全绿。完整客户端的新Page持续可见是独立实际证据，不覆盖该夹具失败。

074已冻结并完成build，但Main退出审查发现两条竞态后在run前退役，原材料保留；075在修复后以2065份source冻结并build，静态普通客户端、固定未修改Electron44.3.0、test diagnostics关闭、无Vite／HMR。实际Full取消／Esc／新草稿启用及移除空间只取消四轮在4951ms完成，Root回执分别false／false／true及workspace.removal phase=cancelled；空间、会话行数、原草稿、WebContents／主frame／timeOrigin／表单与scroll均保持。三轮Full遮罩真实物理mouse检查均未进入Root／Page，12次Tab仍在Dialog内；最后恢复Auto。Main及launcher EXIT=0，source／artifact drift为空，模型账本209＋295＝504且hash未变。最终Window46表364帧及19张原图、Display40表317帧及8张原图已审看：各自前6秒连续动作与末尾约0.4秒稳定尾未见Page撤空、局部遮罩、长说明／按钮裁切或旧框残片，记录在075/review/window与display的REVIEW.json；6秒到尾段之间未目视，不扩称全部24秒像素验收。075后另复现首个presented之前取消被忽略，现只放行当前请求的提前false，提前true仍拒绝；随后Host还改为Root-only事件拦截、冷启动透明原生覆盖与前台焦点约束，Root factory排除隐藏焦点目标；这些输入变化须单独核真实Electron。用户要求退出改回原生message box，Main恢复准确父窗调用并保留取消／失败保留服务及已有无主窗失败退出契约；Overlay kind与共享组件已删除quit分支，preload明确拒绝旧kind。Full与workspace文案、DOM和CSS保持，按验证细则复用075正常开关画面，不称最终全部UI字节未变或授新首帧像素资格。退出原生弹框与自然message错误路径未在实机触发，Main生命周期和Root消息集成回归仅提供其各自断言资格；Windows／Linux、安装／发布与原resize／收展／重开资格未因此取得。

076／076b保留旧Host的CDP鼠标红与Cancel准入失败材料，不记为通过。076c用固定未修改Electron44.3.0、实际Host／Layer／Root factory与自有受控Page补核输入边界：修复前模态中CDP鼠标返回ACK却未进入Page（计数1→1），修复后1→2；普通CDP键盘的keydown／input与末尾marker均到达，浮层仍持有native focus，marker随后恢复。准确PID／birth／CGWindow上的真实mask click使Overlay mousedown＋1、Root／Page均0；真实取消返回false，原Page ID／主frame／timeOrigin／URL／表单／scroll140／尺寸与可见性保持。修复版9项断言通过、Main／launcher退出0，四份生产source与构建快照逐字匹配，145项075历史Full UI资产运行前后hash相同，无Service或模型启动。loadURL入口和真实ready前已观察原生Overlay visible／全bounds／top；尚无DOM时的物理点击未单测，不扩大该资格。取消按钮hover期间确有background-color／color的running CSS transition；076c在原6秒准入期限内等待同一固定节点恢复实际稳定后点击，不换绑或放宽几何。076c仅授聚焦输入资格，075的Full／workspace画面按未改文案／DOM／CSS复用；退出分支删除与Main原生退出由当前回归核对。最终普通／development两种真实构建1pass／29assert，定向类型、Biome与文档检查通过。

055收起先撤页、下一rAF才开始布局的额外阶段已有源码与trace依据。SessionPage保持关闭意图立即更新，只让同scope准确已展示浏览器在待折叠rAF期间维持原页及祖先可见性；该rAF同批结算pending、撤页、启动动画和折叠。立即重开、scope／active tab／host panel替换、零布局、缺失目标与已经collapsed均有退休防线；covered立即撤展示，但合法当前收起仍结算到零宽。没有提前imperative collapse后被库重注册覆盖的候选，没有新增固定等待或绘制ACK。19项208断言及共享tabs／普通详情回归通过，不能代替真实过程画面。

采用VS Code固定提交[1306698e328e5e531f5e632301d30020aa994eff](https://github.com/microsoft/vscode/tree/1306698e328e5e531f5e632301d30020aa994eff/src/vs/workbench/contrib/browserView)的固定Renderer UI、量测后Main缩放取整、准确ID清单恢复、对象／序号核对、显示与销毁分离。未复制截图轮询／后台图片缓存、下一rAF暂隐、隐藏页显隐重试和所属窗口关闭即销毁。它的首开不独立证明first paint，遮挡时截图发起后也不等返回即隐藏，不能作为Kite同帧保证或本机性能证据。

055阶段针对回归为[Main](test/isolated/native-browser-capture.test.ts)112项1141断言、[Root](test/isolated/native-root-window.test.ts)10项89断言、[Pane](test/isolated/native-browser-pane-dom.test.tsx)35项161断言、installed [Refresh](test/isolated/native-browser-refresh.test.ts)5项46断言、两个原Runtime／固定端口测试7项445断言，以及Main窗口／Service生命周期35项417断言（3项Windows跳过）。新旧token、隐藏意图／13种失效、控制shield、隐藏换B后立即Root替换、迟到窗口通知和缺失页均有实际先红后绿或定向证据；没有放宽取消、lease、unknown与首帧期限。bridge、共享标签／页面、PageHost及未改观察／控制按[验证规则](../../.agents/skills/document-before-commit/references/validation.md)复用原对应范围。Desktop类型、变更定向Biome及Core／workspace／生成API／测试归属检查通过；UI源码与输入未变，复用此前UI类型。保留既有any／act警告，未跑全默认、远端模型、普通安装或跨平台窗口验收。代码回归不能覆盖以下像素失败。055至061阶段的生产差异仅是迟到窗口状态防线及其测试；055实际hide(false)／show(true)路径的原生属性动作不变，复用其对应连续画面与失败，不把带私有策略的057授为普通制品资格。

050冻结完整制品在macOS27.2 arm64／Electron44.3.0／Bun1.4.2、既有隔离HOME／Profile执行全部指定场景：真实Selenium HTTPS表单与example.org、切／关B、收展、会话返回从原标签入口展开、真实Cmd+W隐藏及准确实例activate重开、真正Root重载、系统标题栏双击、8段快速拖边、原生菜单／Root菜单／设置及网页刷新。A为WebContents2、B为3；16项retained检查保持准确WC／frame／文档与表单，普通切换scroll140保持。Root重载换Root document而A不变；显式网页刷新仍WC2，但frame路由与timeOrigin改变、表单清空。会话返回重建所属Pane的工具栏DOM，仍同Root宿主；不能称全程节点未重建。reading记录的my-file当时在视口下方，不作为可见文字锚点证明，scroll及画面分别核实。

050有286次原生resize，动作段285次回调末Root原生bounds全窗，Page右缘距外窗1／2 DIP、底缘1 DIP，普通resize零hide及零首帧订阅。Root CSS视口与最近先行native采样存在异步差，最多22 DIP宽／11 DIP高。它排除了记录时的大物理bounds空档与主动撤页，不能排除surface绘制滞后、跨视图提交或采集差，也不能直接归因引擎。两路动作连续帧及稳定尾段均实际读图，Window固定画布之外由完整Display核边界。以下失败仍有效：

| 过程 | 独立视频PTS和实际所见 | 当前范围 |
| --- | --- | --- |
| 系统还原 | Display1.316667–1.583333，1.441667原尺寸有圆角外框内右／下灰矩形带，Root工具栏和网页共同截止 | 内部空带，不能当窗口外背景 |
| 快速缩边 | Window3.633333、3.650000有约30原片像素的内右灰带，下一帧补齐 | 不授全过程无灰带资格 |
| 设置返回／网页刷新 | Window6.966667右侧暗缺块；7.141667右窄条残旧白页，后续才完整loading／新页 | 最终正常不覆盖瞬态反例 |
| Cmd+W重开 | Window4.600000／Display4.633333首可见帧只有全窗材质底，下一采样帧完整 | 与主动Root重载的启动过程分开，仍未解决 |
| 首A／切A | Window1.491667首A右下缺块；050切A Window2.575000残B窄条／Display2.608333全暗后恢复 | 最新052另核，不能凭布局通过改绿 |

052仅补多页排序分支。Window2.516667仍有A地址已回而网页全暗；补完此前未审的Display后，也确认D143／2.533333切A暗空及D215／3.791667关闭B回A暗空。051私有observer曾追加显式undefined改变默认新增index，材料保留且不授该资格；052用原参数数组转发修正，不改产品迎合夹具。

053冻结完整制品核同提交目标替换：Window366与Display291个连续动作／尾段样本全部实际审查，首A／新B、两轮A/B与关闭B回A未再捕获052两处空档，准确A的WC／frame／timeOrigin、表单与scroll140保持。055再核全部050场景，Window1078与Display910个动作／尾段样本全部逐tile审查，必要反例看原尺寸；同样未捕获052切页暗空，设置返回／刷新未采到050同型残片。它们不抹去旧失败，也不证明采样间绝无更短空档。055准确A仍WC2，Root重载换Root文档但A保持，显式网页刷新才换A文档；Main退出0且冻结输入／制品无漂移。

055仍有明确当前反例：

| 过程 | Window／Display自身PTS及原尺寸所见 |
| --- | --- |
| 收起／展开 | Display D175／3.125000 toolbar仍在而网页先暗空；展开D196／3.491667及Window W199／3.466667有宽聊天拼块和窄白页，下一采样才完整侧栏 |
| Cmd+W重开 | Window W255／4.450000首可见仅材质与窗口灯，4.483333完整；Display D245已完整、D246／4.475000又灰空、D247完整；与后续真正Root reload启动页分开 |
| 系统还原 | Display D65／D69／D73，1.308333／1.375000／1.450000，右及底灰矩形明确在圆角内部，toolbar与网页共同截止 |
| 快速缩边 | Window W137／2.408333约30原像素内部右灰列；Display D143／2.716667及D146／2.766667约90原像素，下一帧恢复 |

重开前的准确隐藏intent已确认，原页child没有被设为false，仍不等于实际首可见帧。只读核固定上游实现后，056只在私有夹具对Page关闭backgroundThrottling，057再对准确Root关闭；两路均仍确认首可见材质空底，未接产品。Root关闭还会使document.visibilityState保持visible，不能在没有真实窗口资格替代时用于生产观察；没有改变该安全门。058恢复默认策略，在隐藏原Root单次capturePage，39ms内取得2116×1200完整Root帧，前后对象／主frame／timeOrigin、hidden与几何相同、无未决读取；图片只存证据，未进UI。Root捕获不含独立网页View；Window W173／3.016667与Display D168／3.050000首可见仍只有材质，下一采样才完整。完整Root可复制帧不等于WindowServer已提交，该候选也未接产品。

059只在私有夹具把准确重开的show路由到原showInactive，再保留Main focus，一次有限生命周期两路未采到首灰；060补回原show后又捕获首灰。061将前一候选放入普通完整静态链路，45秒生命周期与45秒几何／浮层各录Window及Display。系统只读helper核准确PID／parent／birth／CGWindow：重开后Main89446确为frontmost、isActive且窗口focused；原A文档／表单／阅读位置及Root重载后复用保持，B真实销毁，仍不能覆盖以下中间反例。Window共134张联系表1072样本、Display共110张871样本，连续0–9秒及稳定尾段全序审看，并核原尺寸：

| 061过程 | Window／Display独立原片索引、PTS及实际所见 |
| --- | --- |
| Cmd+W重开 | W262／4.591667与D243／4.616667首可见仅全窗材质，下一采样才完整；后续W273／4.800000、D254／4.825000的Kite启动页属于另一次真实Root reload |
| 快速缩边 | W135–136／2.391667–2.408333及D114／2.308333有圆角内右灰列，Page左界与toolbar分栏左界也不同步，后继恢复 |
| 设置返回 | W396／6.946667与D352／6.955000明确左半聊天、右半旧VS Code设置卡片，下一采样才完整聊天／工具栏／A |

061联系表中收起疑似拼块经原尺寸D172／173／174复核未确认：完整旧布局后，页与toolbar一起撤下并扩展聊天；不抹去055反例。activation helper因真实复验失败已撤回，四份候选源码另存，当前2042输入逐字恢复至060；Root10项89断言、Main生命周期35项417断言（3项Windows跳过）与Desktop类型重新通过。保留此前coalescing、隐藏意图和迟到通知修正，不把059有限绿、系统焦点正确或测试通过写成重开已修复。

用户随后明确授权固定Electron44.3.0的隔离引擎诊断及补丁实验，普通依赖、工具／协议版本和发布状态保持。`engine-resize-062`复制两份自含Electron.app，普通安装270项清单未变，克隆inode彼此独立、相对symlink只在各自App内。两臂同样签名；除BCM GetResizeDeadlinePolicy入口4字节和嵌入签名区外，Framework整字节相同，新增CodeResources也相同。候选入口尾跳已有UseDefaultDeadline，保持x8间接返回与x30；不是版本升级。它作用于该隔离进程所有命中的BCM实体，不限于某一个窗口，且不控制后置force-specified覆盖或早退。

062两臂使用同一完整静态应用制品、相同真实标题栏双击与边框burst，沿既有隔离Profile串行运行，不复制认证或清Profile；不是字节相同Profile种子的严格性能基准。只读NAPI核Main实际dyld路径／UUID／ASLR及内存入口分别为原`091440f9`与候选`05f75c17`；这不证明实际调用或force后的最终policy。无后台策略、show override、截图替身或调试器。两路各20秒，动作在5.679／5.312秒完成，连续0–8秒及尾0.4秒按序审完：baseline111张联系表876样本、candidate109张863样本。两臂均仍有还原窗内L形灰带和快速resize灰列／跨栏错位；candidate原尺寸D78／1.450000还确认白页上下段阶梯错接与右下暗缺块，W138／2.408333右侧宽灰列。因此该候选没有取得解决resize的资格，也不能以已加载字节代替最终policy证据。未把两路PTS硬对齐或把采样间隔、166／130次实际resize事件算成屏幕FPS。首轮私有构建在完整native编译后因package.json已存在拒绝收据，之后仅核准并完成自有制品入口，过程保留在BUILD-FINALIZATION.json；这不是产品运行失败。

用户最新实机反馈确认：右灰边持续于拖动或双击缩放的运动中、停稳后消失；双击header时网页与容器绘制不同步。当前优先排查这两项，不能按固定留白解释。用户未遇到Cmd+W重开整窗材质空底，保留既有实验失败并后置，不标为用户实机复现。其他反例同样先定位具体原因，再修改产品。剩余顺序归[实施计划](../../docs/plans/2026-11-02-browser-renderer-layout.md#当前验证与未完成)。

后续隔离诊断没有改变生产源码：

| 证据 | 已确认事实及限制 |
| --- | --- |
| 063／064／065 | 063 LLDB未成功附加，0 hits；064在exact-window-class检查处停止、未安装hook；065精确窗口类只读模块已准备，尚未取得完整夹具运行证据。它们都没有取得最终deadline、原生show提交或像素资格。 |
| 067被动完整客户端时序 | 263次父contentView bounds通知时Root仍旧尺寸，后到的真实JS resize末Root均已跟上。一次父新surface先于对应Root新surface激活13.890ms，不能据此推定屏幕帧具体引用关系。Display D73／1.375000原尺寸确认还原时圆角内L形灰带，D169／3.108333确认拖边右灰列。 |
| 068 Root-only因果对照 | A显式Root＋JS resize、B父原生layout回调填满Root、C BrowserWindow隐式Root三臂均正常完成，表单与scroll140保持。B的287次父通知在JS resize入口前Root已是新尺寸，仍有灰带；原尺寸A D92／1.825000、B D136／2.525000、C D152／2.808333均有窗口内灰带。因此额外contentView／后到JS回调是实际结构差异，提前填满或仅换BrowserWindow不是已验证修复；灰带也不以同时存在Page为前提。066首轮因真实burst未回原宽的夹具断言失败，原材料保留，068只修正有界真实拖回，不改产品。 |
| 069完整客户端前移因果对照 | 仅私有夹具在父bounds变化时合成调用现有resize处理，0–6秒267组Root／Page新bounds已在该调用内写入。例：相对recording-start +2600.465／2600.561ms新Root／Page embed，+2602.317ms父129激活，+2611.344ms Page129、+2615.922ms Root127才激活。新子geometry已先于父更新，但对应surface仍晚9.027／13.605ms。Display D73／1.383333还原与D119／2.341667拖边原尺寸仍有内部灰带，前移候选不进入产品。 |

067与069的trace同时记录Root Panel约束修正中间态。067在Main已投影到1067px后，Root同宽rAF先测得navigation约159.5px、viewport约311px；7ms后在无新anchor IPC时回到navigation约202.1px、viewport297px，与Main目标一致。安装的react-resizable-panels 4.12.4先按旧百分比参与flex布局，再由Group ResizeObserver执行像素保持与min/max约束；Panel传入style作用于内层，不能直接当作外层约束。该机制解释了观测到的DOM中间态，但rAF先于RO／paint，不证明该样本实际上屏；现有纯投影回放也未证明Main计算错误。069仍有短暂低于200px的navigation样本，不能用提前Main回调消除这一疑点。

现有trace关联已核实际Renderer PID、FrameSink／LocalSurfaceId及GPU activate；Root／Page可共享父compositor，不能称为三个独立最终compositor。069新Root／Page primary在impl侧设置也早于父commit。进一步按Graphics.Pipeline同线程receive区间的唯一CommitFrame映射frame trace ID，844／844条唯一关联：相对recording-start +2604.888ms的实际aggregation包含父129、Root126、Page128；+2615.959ms才是父130、Root127、Page129。它直接证明该次新父帧聚合了旧子帧，而非仅推定“当时最新active”；仍不证明具体屏幕PTS、quad primary／fallback选择或为何未阻塞。trace没有父frame的activation_dependencies或改写后的最终deadline；入口EmbedSurface的deadline=0早于改写，不能代证最终policy。准确激活和aggregation都不是WindowServer出像素回执，仍须继续确定具体等待分支。055展开及061设置残片仍有效，不能单凭最终bounds把Root拼块归为应用动画或网页导航。

067 Window共60张联系表475样本、Display共50张395样本；068 A／B／C Display各391／394／386样本；069 Display共48张380样本，均覆盖连续动作0–8秒及约20秒稳定尾段，已逐tile审看，关键灰带另核原尺寸。联系表未导出的稳定中段不授目视资格；两路PTS与各轮操作不硬对齐。069 Window的审查范围单独以实际完成记录为准，不以Display代替。完整客户端原文档、表单与scroll140保持，退出0及冻结无漂移不覆盖过程画面失败。

制品／连续原片／联系表／原尺寸异常保存在本机.cache/browser-native-clip-probe-20261031/fixed-renderer-050、052、053、055–061、engine-resize-062、engine-deadline-063、engine-show-064／065及resize-root-cause-066／068、resize-timeline-067、resize-parent-cause-069；054只构建，早期043–051全保留。2042份产品输入与fixture／artifact逐文件冻结，已完成运行无漂移；无Vite／HMR／watcher，后继启动前核先行隔离实例结束。用户原开发实例保持，普通Electron安装及062克隆hash未变，模型账本209＋295＝504且字节／hash不变。没有stage／commit／push。**当前视觉失败仍阻断全过程验收，不能直接归为既有问题或不可修引擎限制；隔离候选没有进入普通客户端，本次目标仍未整体完成。**

### macOS 原生分栏与浏览器工具栏（2026-10-31）

以下记录2026-10-31制品及当时实现／失败；当前结构和资格以上一节为准，原反例不改写。

用户重新提出缩窗闪烁后，已明确同意 Main 管理真实左右边界并拆分右侧工具栏。此前缩放缺口重新打开；下列旧 PNG／双 witness 记录保留其失败事实，不作为新结构的通过证据。取舍与验收要求见[原生边界方案](../../.agents/notes/proposed/architecture/2026-10-31-native-browser-native-layout.md)。

当前 macOS 候选使用 [Root 工厂](electron/native-root-window.ts)组合 `BaseWindow` 与显式 Root `WebContentsView`，Main 将 Root 自身的物理宽度限制在左栏，浏览器页及独立标签／工具栏宿主在统一原生布局批次更新 bounds。Root 的完整逻辑布局由 Main 独占的固定 UI viewport 保持；该能力不进入 Agent 页面 registry 或浏览器工具。普通 browser-live 路径不隐藏网页等待 Root 绘制，也不显示旧 PNG。其他平台和尚未取得新宿主资格的状态沿原呈现路径；本次不据 macOS 原型授予其他平台资格。

正常开发启动暴露本轮Root工厂的回归：隐藏窗口尚无可截取surface，首帧`capturePage`抛`Current display surface not available for capture`，经原有有界启动通道显示为`native_startup_failed`。已移除截图准入，Root只在自身实际loadURL／loadFile成功且未关闭、未被后继加载替代时通知Main允许显示；不伪造BaseWindow的`ready-to-show`绘制事件。截图失败不再阻断应用启动，真实加载失败仍原样拒绝。直接回归7项55断言与Desktop类型／格式检查通过；沿原隔离HOME／Profile的真实开发启动链取得`Service ready`、可见且稳定Root界面、退出0，无模型请求。准确异常、修后过程及界面归本机`.cache/browser-native-clip-probe-20261031/startup-*`；该启动修复不授缩窗无闪烁资格。

尺寸更新现按“两个输入、一个最终应用入口”收敛：窗口事件与Renderer有效量测由[controller](electron/native-browser.ts)保存原量测基准，统一经`applyCurrentLayout`按当前窗口／zoom计算、向内取整和比较真实View输出。Chrome host不再独立订阅resize，`layout`不再隐式请求metrics；Root裁剪、Chrome／page／输入盾的同值原生属性不重复写入，几何相同仍推进准确scope／revision、控制和原witness／ACK。native事件先废弃旧坐标，再合并更新；首次／兼容同步量测回执与非托管Root职责保持，稳定hosted校准的后续异步切口见下文；不新增协议版本或通用布局框架。

Root viewport沿原host的`syncViewport`按desired／inflight／applied及准确Root epoch／frame／zoom去重，成功才记applied，保A已应用→B在途→最新A的最终恢复；新绑定复用同值metrics仍须完成自身prepared与fresh hosted确认。过期文档成功或拒绝不影响替换Root，当前连接失败仍收口。页面及输入盾布局完成后广播，按实际接收者／frame、快照与envelope身份省重复投递，保新revision地址echo；CDP返回不是像素提交确认。

本次135项1697断言定向回归、Desktop类型／格式、Core边界与测试归属检查通过。组合运行曾受Electron mock和React Refresh全局状态污染，失败日志保留；按原isolated文件分进程验证通过，未为此改产品断言。冻结生产组件实机`attempt-006-layout-owner`完成受控原页、表单、固定阅读段落和真实缩放／1.25倍验证；后继HTTPS断言沿用旧版正文而失败，后续步骤未执行，原记录不改绿。相同制品`attempt-007-layout-owner-https`补读当前公开HTTPS正文并完成真实缩放恢复／header拖窗，原页身份、导航和timeOrigin保持；私有采样77条metrics、相邻同参重复0、同值bounds写0。两轮与真实开发启动链均退出0，冻结运行期间源码差异0，模型账本仍504。当前只授本轮尺寸提交与去重资格；006缩小阶段仍有窄灰带（window PTS1.850000），007恢复扩窗也有窗口内深灰带（process PTS3.425000、display PTS3.466667），整体无闪烁资格未取得。原片／PTS／过程及计数归本机`.cache/browser-recheck-20261030/ordinary-dev/observations/native-layout-20261031`，启动复核归`.cache/browser-native-clip-probe-20261031/startup-layout-owner-*`；不代证普通发行构建或跨平台资格。

后续原生布局可行性验证也未取得无空带资格：固定Electron44.3.0的实际二进制具有`contentView.setLayout`，隔离原型让三个独立WebContentsView的边界仅由原生布局回调计算，不在JavaScript resize事件内写bounds。真实系统缩小／恢复保留原HTTPS文档、timeOrigin和左侧输入；但窗口帧64（PTS1.141667）及桌面帧31（PTS1.155000）均露出13图像像素宽的窗口品红底色，与窗口外紫色隔离背景明确分开。连续审查覆盖窗口242帧、桌面145帧；记录不支持“提前到原生布局栈即可同帧出像素”。该原型没有生产Root逻辑viewport、CDP或工具接线，不接入普通源码，也不重复等价实机。实际脚本、原片、像素和审查范围归本机`.cache/browser-native-clip-probe-20261031/native-layout-manager-001`；Main正常退出0，登记子进程均消失，用户原开发客户端出生身份保持，模型增量0。后续须核原生窗口与独立网页surface的同步边界，不能仅凭布局回调更早、启用实验开关或上游其他平台修复宣称本机问题解决。

原生窗口等待候选也已取得反例：固定[Chromium默认关闭AsyncLiveResize](https://github.com/chromium/chromium/blob/152.0.7977.78/ui/base/ui_base_features.cc#L70-L80)，[Electron delegate](https://github.com/electron/electron/blob/v44.3.0/shell/browser/ui/cocoa/electron_ns_window_delegate.mm#L133-L205)没有转发对应父类入口；这不解释默认配置失败。私有`native-layout-manager-002-async`只对准确测试窗口的delegate保留原取消／尺寸处理，再调用实际Chromium父类，并补配对结束通知；实际74次变化确认inLiveResize且父类返回旧尺寸，随后由[compositor帧到达路径](https://github.com/chromium/chromium/blob/152.0.7977.78/components/remote_cocoa/app_shim/native_widget_ns_window_bridge.mm#L1761-L1804)更新外窗。原文档及输入保留、Main和登记子进程正常结束，但窗口帧61（PTS1.083333）与桌面帧34（PTS1.141667）仍明确露出内侧品红带，因此不能将该实验开关或私有注入带入普通产品。两路PTS各归自身源，不能作严格同刻对照或据此宣称比001改善。下一步若进入引擎补丁，需单独处理原生网页视图边界与外窗的实际提交时序；目前没有验证成功的修复，也未认定必须维护引擎分支。普通源码未因这两次原型变化，整体视觉目标仍未完成。

2026-10-31用户随后明确选择“先保留当前实现，明确保留缩放缺口”。当前源码及已验证的统一尺寸入口／同值去重保留，不接入上述失败原型，不继续引擎补丁或新增结构试验。窗口缩小／恢复时的边缘空带与闪烁仍为未解决缺口，不能授无闪烁或完整发布资格；原始失败、unknown及普通构建未覆盖范围不变。本次按该确认范围完成文档收尾，复用未变源码的既有验证，不再启动客户端、Service或模型；模型账本保持504。本轮新实现仍留工作树，未追加stage、commit或push，原生分栏Note保proposed。

用户新增“未打开浏览器，双击缩放主窗口也比原分支明显黑边”的实际反馈后，仅重新打开普通Root缩放回归。`8713074c3`将macOS所有主窗口从BrowserWindow改成显式Root组合，非托管Root也通过setImmediate延后resize；`e8ac56fe2`的同值去重未改变该时序。现在[Root工厂](electron/native-root-window.ts)仅在未托管浏览器时，于原生resize回调内同步跟随全窗尺寸；已托管Root仍保物理裁剪，由原browser controller负责布局。去掉Root自己的queue／cancel接线，同值原生写入、页面身份、关闭与已托管回执约束保持；不改引擎、重挂contentView或恢复截图替身。Root新断言已在旧实现上复现时序失败，受影响host回归也从延后等待改为同步跟随断言，继续核同值不写、已托管不被全宽覆盖、关闭后不更新和独立viewport同步；Root／host／布局队列分进程38项296断言、Desktop类型与三文件Biome、Core边界及测试归属检查通过。

零模型实机归本机`.cache/browser-native-clip-probe-20261031/unhosted-root-zoom-*`：001冻结修前／修后工厂、同受控文档，真实标题栏双击各完成放大和还原，81次resize中原Root均仍为上一尺寸，修后为0次不匹配；连续桌面源直接确认修前窗口内大L形空区和旧宽内容滞留，修后未见同类大空区。001的classic因夹具误将BrowserWindow的contentView当作隐藏主WebContentsView而未执行，原失败保留；002只补此前未执行的同Electron BrowserWindow基线，不重跑前两段。003用最新源码的真实开发客户端，Main55791实际只存在原Root、未打开浏览器页，双击1100→1512→1100且同文档／timeOrigin保持，82次resize全对齐；连续桌面帧39–78（PTS0.916667–1.783333）及103–158（PTS2.300000–3.616667）未见大L区、整块黑空或旧布局回闪。三组Main均退出0，录制自然结束，003真实开发进程已只读核absent；模型账本仍209＋295＝504。窗口源固定画布会裁掉动画后的部分窗口，以完整桌面源核边界；修后、真实UI和BrowserWindow基线仍有短暂细窄暗边／阴影外观，不授像素零边或此前右浏览器缩放缺口的通过资格，也不代证普通发行构建和其他平台。该局部修复未默认暂存或提交。

用户新增“网页出来后拉伸很卡”，并指出慢速动作不足以重现后，本轮仅重新打开响应性问题，页面固定为用户提供的`https://www.baidu.com/`。同值`BrowserPageHost.present`此前仍触发decorate／changed，现同值直接返回，独立导航／phase／光标变化的paint保持。慢速对照中重复装饰194次降至0、状态投递71次降至0，但Main CPU约20.94%→20.25%，Root也未出现严重停顿；这只能证明去掉重复工作，不能解释或否定用户的快速拉伸卡顿。

高速对照改用同一准确PID／birth／窗口身份护栏的原生输入助手：一次按住窗口边缘，八段400px往返，每段24步、每步请求间隔4ms。每次事件还核对系统窗口，实际整段约2秒，不将请求间隔冒称实际拖速。冻结生产组件基线`hosted-resize-fast-baidu-001`在已经包含上述同值去重的情况下，Root最大rAF间隔466ms并有474／300／301ms等长任务，Main最大事件循环停顿约471ms；百度和独立Chrome约9.3ms、无长任务。同步布局handler本身小于0.5ms，但Root每次量测仍`sendSync`等待Main，现有证据支持其与Main原生live-resize／合成等待形成阻塞链；未取得原生栈采样，不把具体AppKit内部函数当作已证事实。

当前[Pane](src/native-browser-pane.tsx)、[preload](electron/preload.ts)与[controller](electron/native-browser.ts)对已稳定hosted的正向校准改用同一布局channel的异步invoke，只保留一个在途请求；其间变化只标dirty，完成后重新量测当前DOM，不排队旧矩形。Main在推进witness／revision／anchor前核当前窗口尺寸、真实active／visible页、已有presentation、准确scope和ready Chrome binding；异步入口不能首次显示、恢复已隐藏页或切换目标。隐藏不排在正向请求后面，旧scope／卸载／迟到回复不能复活展示。首次绑定、bootstrap、未托管兼容路径和不含新可选端口的旧preload保持原同步路径；Main窗口投影及坐标即时失效职责不变。工具、协议版本、Agent Loop、页面与租约身份均未改变。Main／preload变化必须完整重启客户端才生效，单独Renderer HMR仍可能使用旧桥的同步兼容路径。

曾尝试“仅窗口尺寸不同才异步”的候选`hosted-resize-fast-baidu-002`，但回到同尺寸和ResizeObserver重入仍进入同步路径，实测Root最大982.5ms、Main约967ms，已否决且保留失败。稳定hosted一律异步的`003`在同一输入助手下同步调用0、异步138，Root最大9.2ms／无长任务，Main最大约24.2ms；Main CPU约36.5%，不能将延迟下降写成CPU下降。连续桌面动作帧6–107（PTS0.600000–3.050000）及窗口源交叉核对确认正文和边界持续跟随、未见原停滞／整页消失／旧页闪回；但桌面帧78（PTS2.058333）仍有窗口内部宽灰余带，完整无闪烁资格仍未取得。纯分栏补验`hosted-splitter-baidu-002`保持原生外窗尺寸，真实Root裁剪宽度1055–1175，sync0／async164、Root最大9.6ms／无长任务，Main最大约14.3ms；连续过程未见整页隐藏或同类宽灰带。该display动作段有CodexCLI系统本地网络权限框，未操作；own-window原片交叉核对被遮挡正文。两轮原网页和Root的timeOrigin保持；百度初始页input:null、scrollY:0，不冒称验证了实际填值和非零阅读位置。纯分栏`001`未正确命中零宽分栏句柄、输入前失败，原记录保留，002只补此前未执行的动作。

完整开发链补验也保留夹具失败：`hosted-fast-live-ui-001/002`的私有低层输入未成功提交网址，未执行拉伸；003补完整字符事件和准确可见地址栏后虽已打开百度，但连续录像确认只有鼠标移动，真实窗口并未拉伸。原因是私有episode在Main内用execFileSync等待输入助手、阻塞了原生事件处理；其Root约9ms仅证明静止renderer在绘制，不授高速缩放资格。外部驱动的冻结组件基线没有此夹具问题，原几何轨迹和连续画面仍有效。

仅补此前未执行的完整UI段的`hosted-fast-live-ui-004`使用异步子进程，并新增实际resize次数与尺寸跨度断言；最新源码、真实隔离Service／开发UI的Main3211记录143次resize、宽度1089–1489，原宽1472、末宽1489，不冒称完全恢复原尺寸。Root／百度／Chrome最大rAF间隔分别9.4／9.2／9.3ms、无长任务，原WebContents与timeOrigin保持，录制自然结束且Main正常退出0。已审display连续动作帧28–141（PTS0.608333–3.175000）、process关键连续时段及两路稳定末帧，原片hash保持；窗口真实往返、Root持续跟随、右页保持可见，但仍有内部灰／紫暗余带和气泡／输入区短暂裁切后重排。display帧88（PTS1.833333）还明确出现网页上下段边界不一致、左侧留白条和旧输入边缘残片；process帧88–95（PTS1.816667–1.966667）未复现完全相同的分段，仅见内部灰带与布局跟随。两路PTS非严格墙钟同步，不能排除桌面源反例，也不能把残片直接定因为应用、引擎或采集时机。末帧聊天、输入区与百度页面正常保留，该轮仅支持响应性改善，不授全过程无撕裂／无灰带或普通发行构建资格。

本轮Root／host／队列未变部分复用已核38项296断言；受影响Main、PageHost、Pane DOM和真实preload bundle分别75项1130断言、75项432断言、20项287断言、8项103断言通过，覆盖异步首次准入拒绝、scope／sender／frame／revision／尺寸预检、hide／close迟到、同尺寸ABA、单在途最新量测、旧桥兼容及同步／异步错误一致。Desktop类型、12个变更源码／测试的Biome、Core边界、测试归属、生成API、文档结构与working diff文档影响检查通过；PageHost测试的9处旧any警告保持，未为本轮扩改。产品手册的页面保留、控制和恢复承诺及Native release的安装／发布门禁已核对，本次不改变其语义或授予新发布资格。源证据归本机`.cache/browser-native-clip-probe-20261031/hosted-resize-perf-*`、`hosted-resize-fast-baidu-*`、`hosted-splitter-baidu-*`及`hosted-fast-live-ui-*`。本轮零模型，独立账本209＋295＝504，原unknown保持；当前改动未默认暂存、提交或推送。

2026-10-31用户随后在本地客户端确认：存在浏览器内容时，缩放性能比此前明显改善，但仍未达到流畅。该现场反馈与本轮响应性改善的有限结论一致，不将其记成整体缩放完成；原灰带、裁切及旧布局残片的未解决状态保持。本次按用户明确要求保留当前改动并本地提交，不推送。

用户继续指出完整`desktop:dev`的帧率低于隔离例子，且空会话也慢后，本轮只重新打开帧提交节奏。此前rAF约9ms并不证明画面持续产生新帧。真实开发链基线`hosted-frame-live-dev-001`在同样百度高速动作中，约1061ms内116次原生resize，Root边界仅在回调采样中观察到33次变化；网页自身Layout／Paint很小，但引擎DrawFrame有约132ms空档。该基线使用完整Service／Vite UI、简短会话及原隔离Profile，不是组件夹具。

完整客户端特有的成本位于[Main](electron/main.ts)的浏览器scope读取：每次为四个身份字段调用完整`NativeCaller.state()`，连同caller／answer／workspace-removal等同步持久记录读取、解析与校验以及其他submission克隆一起组装；这与当前聊天是否为空并不等价。组件夹具的scope是常量，不能代证此路径。[NativeCaller.browserScope](electron/native-caller.ts)现与`state()`共用同一`observedSelection`逻辑，逐次读取当前内存中的准确store／session／Caller generation／selection，不缓存authority，也不装配无关UI提交记录。原完整state、journal错误与持久提交／查询的完整性检查保持；同选择loading、完成权限失败、观察丢失、ABA、child及原presentation/input的deleted差异均沿原谓词。

仅在保留完整state热路径时提前原生布局的私有`003-direct`虽让104次几何事件立即跟随，Root绘制提交反而下降，未采用。去掉该成本后，`008-schedule-compare`在同一完整开发客户端、同一百度文档内分别以相同起始尺寸执行queued/direct：均122次真实resize，Root观察到的几何变化62→122、中位间隔17→9ms，等长动作窗内Root DrawFrame71→125、中位提交间隔16.2→8.2ms。此组合才进入[controller](electron/native-browser.ts)：已prepared的hosted页在原生resize回调内调用原`applyCurrentLayout`，先使旧坐标失效并取消尚未执行的bootstrap队列；未托管、启动与恢复阶段保留原队列及即时输入屏障更新。唯一几何owner、Renderer异步校准与准确页面身份保持，没有新引擎或协议版本。

最终实际源码的`hosted-frame-live-dev-009-final`沿完整`desktop:dev`、同一120Hz／DPR2显示器先做无录屏、无人工rAF、无并发离线检查的trace；约1064ms的真实原生动作区间有124次resize、124次观察到的Root边界变化，中位间隔9ms。下表按真实首末resize时间对齐引擎DrawFrame，墙钟对齐精度约1ms；数值不是屏幕内容FPS或跨机器基准，静态内容没有新帧也不自动计为掉帧。原始字段、reporter状态和切窗方法归该目录`FRAME-ANALYSIS.json`。

| 引擎绘制提交间隔 | 修前完整dev001：中位／P95／最大 | 修后实际源码009：中位／P95／最大 |
| --- | --- | --- |
| Root | 14.44／35.11／62.85ms | 8.72／12.71／18.15ms |
| 百度页 | 33.61／66.59／132.24ms | 8.33／9.10／18.27ms |
| 独立Chrome | 33.43／73.42／133.95ms | 8.37／10.12／22.79ms |

009随后用独立动作录制连续画面，不把两路录像采样率算入上表：186次真实resize、宽1089–1489，原Root与百度WebContents／timeOrigin保持，两录制自然结束、Main39373正常退出0，执行前后源码hash无变化。连续画面已审display动作帧21–146（PTS0.608333–3.400000）、process关键连续时段及两路稳定末帧：窗口、分界和主要输入布局持续跟随，未见整页隐藏、Root黑空、系统框或004那处明确上下分段白条；仍见内部灰／紫边带及快速反向时气泡／输入右缘短暂旧范围裁切。该片未见同类分段不抹去004原反例，帧提交改善不授无灰带、无裁切或像素同步资格；普通发行构建及其他平台也未因此取得新资格。

本轮Caller54项593断言、Main生命周期35项417断言（另3项Windows跳过）、原生capture76项1162断言通过。Main的真实Caller refresh／ABA／权限失败接线保留，并断言浏览器不调用完整state；旧手写UI state谓词反例已归位到真实Caller测试。capture覆盖无需await即可投影、旧坐标立即失效、已prepared取消旧bootstrap任务、晚到任务不复活及未prepared仍即时释放人工输入。本轮共165项2172断言通过（不重复计入定向子集）；Desktop类型、六个变更源码／测试的Biome、Core边界与测试归属核对及文档结构／影响检查通过。当前产品手册的权限、页面保留和恢复承诺及Native release资格保持；本轮零模型，实际账本仍209＋295＝504，009登记Main与子进程出生身份均已只读核absent。Main测试首轮因沙箱loopback EPERM未进入产品断言，原失败与允许受控本地端口后的通过均保留。私有构建的精确源码／类名护栏及脚本准备失败没有启动客户端，不计产品运行失败；007可能与离线类型检查重叠，只作集成证据，不作严格性能对照。所有原始反例归本机`.cache/browser-native-clip-probe-20261031/hosted-frame-*`，不重跑天气或模型任务。

用户确认上述resize已顺滑后，本轮只处理右栏边框拖动折叠仍显示网页。真实完整开发链修前`hosted-panel-collapse-001-before`的Main57804复现：Panel已零宽，UI仍发布可见；Main先隐藏网页及Chrome，16ms后迟到ready沿旧`drawnRequest`再次显示，直至松手后才最终隐藏。原生指针在折叠位置保留700ms后释放，不能将该反例描述成松手后永久无法隐藏。[SessionPage](../../packages/ui/src/desktop/SessionPage.tsx)现由实时layout通知更新实际折叠可见性，完成通知仅确认用户关闭意图；同值布尔通知直接早退，不增加逐像素几何读取。[Main](electron/native-browser.ts)收到通过scope／revision校验的普通Renderer显式hide后，退休旧drawn证明，迟到Chrome ready不能复活旧呈现。内部suspend／bootstrap临时隐藏及专用presentationKey交接保持原证明规则；页面对象和控制租约不随呈现销毁，重新显示需要新的有效量测。

修后`hosted-panel-collapse-002-after`使用最新冻结源码、完整Service／Vite UI及同一隔离Profile，Main61788实际打开HTTPS百度。拖到零宽后，网页与Chrome在保持按下和松手期间均未重新显示；收起状态下再缩窗仍隐藏。随后点击原“标签页”按钮，恢复同一page2、原URL及timeOrigin，没有新建、导航或刷新。两路连续画面已审收起／保持／松手、闭栏缩窗、展开及稳定末帧：未见旧网页或工具栏在隐藏阶段回闪；关闭瞬间仍露出一帧宿主底色，展开时先出现标签壳、后恢复正文，不能称全过程无空隙或原生同帧提交。原resize灰带与裁切限制不据此升级为通过。两客户端均正常退出0，录制自然结束，修后执行前后源码无漂移；原片、trace与逐帧复核归本机`.cache/browser-native-clip-probe-20261031/hosted-panel-collapse-001-before`及`002-after`，不改写修前失败。

本次[UI回归](../../packages/ui/test/isolated/desktop-session-page-render.test.tsx)6项83断言、[原生capture回归](test/isolated/native-browser-capture.test.ts)81项1223断言通过，含旧generation／revision的hide不得撤掉新证明、旧ready及迟到正向量测不得复活、内部suspend／HMR保留和新有效量测恢复原页。UI与Desktop类型、四个变更源码／测试的Biome及必要边界／文档检查通过；未变性能路径复用上述证据，不重跑天气、模型或帧率对照。此次仅取得完整开发客户端的折叠隐藏与原页展开资格，普通发行构建和整体无闪烁资格保持原限制；零模型增量，实际账本仍209＋295＝504，未暂存、提交或推送。

2026-11-01用户新增resize双标签／中间空栏截图后，冻结完整dev的`hosted-resize-root-chrome-001-before`已取得同形反例：168次真实resize、宽897–1497，Root header虽inert／aria-hidden仍绘制；另在两边窗口同宽的样本中，原生分界仍比DOM分界右移约120px。两个原因分别修正：托管header视觉隐藏、保留量测高度；[连续投影](src/native-browser-bridge.ts)返回受约束后的组尺寸，[Main](electron/native-browser.ts)用独立nativeProjection逐次推进最小宽度导致的比例历史。新接受的Renderer量测重置预测，撤下／Root替换清除；原presentation、drawnRequest与输入proof不由预测改写，同尺寸不累计舍入。真实Panel库1400→820→1800回放旧误差300.4569px，新路径小于1.5px；没有同步IPC或旧截图补偿。

对应`hosted-resize-root-chrome-002-after`的Main75825实际178次同参高速resize，宽897–1497，Root header全程hidden。连续画面未再出现双标签，原先的大段独立Root第三栏明显收窄；同宽近时序样本最大偏差约8.75px，仅是日志配对，不是同帧像素证明。display原帧49／PTS1.008333仍见约114物理像素的旧pane残区，72／1.533333有内部紫带，83／1.791667有局部边界分段；不能写成空栏、灰边或裁切全消除。原Root／百度文档保持、正常退出0，过程与hash复核归两目录review。此新反例不改写此前帧提交节奏改善，也不恢复已暂停的引擎补丁调查。

用户随后新增已加载tab切换严重闪烁。`hosted-retained-tabs-003-before`真实4次Baidu／Example往返，每次Root物理边界1175→1472→1175，复位区间16–19ms，连续画面取得标签及正文短暂暗空；未读到聊天文字确实撑到全宽的像素，不把bounds记录扩称该视觉反例。当前[Pane](src/native-browser-pane.tsx)保留后台资料端口并在layout阶段发布，而只为可见页安装呈现effect；旧可见页退出仍准确隐藏。Main仅在同scope、同Root环境、已列出的真实HTTPS原页及当前几何均合格时原位轮换wire身份，保Root／Chrome物理宿主，暂停旧页；新ACK和新量测前不能操作新目标。未确认交接在1500ms内退回完整Root，关闭、跨scope、未知页／导航身份变化与真实错误保持原撤下规则。

`002-after`附带的首次切页夹具只用了DOM click，未触发Radix mousedown，实际page5始终可见、mutations为空；只作未执行记录，不授切页资格。修正输入并核准确目标visible后才有003基线。第一版修后`004-after`仍实证4次Root复位，原输入／文档保持不能覆盖失败。`005-diagnostic`单次IPC／调用栈定位：新B快照先绑定，随后B旧inactive effect的cleanup及新inactive effect仍发null，将新目标撤掉；修复只让可见owner安装呈现effect，后台不分配revision或订阅量测，重新选中取得fresh量测。005两次私有编译符号护栏在客户端启动前拒绝，随后使用窗口调用栈和IPC只读诊断，未改普通客户端或放宽呈现校验；旧失败保留。

阶段制品`hosted-retained-tabs-006-final`的Main83828以同一隔离Profile、冻结源码完成4次真实Baidu／Example已加载页往返。每次准确目标可见、原页隐藏；Root全宽复位0次，Chrome隐藏0次，原两WebContents／timeOrigin及百度输入`kite retained tab check`保持，没有新建、导航或刷新。scrollY实际为0，只核0保持，不授非零阅读位置资格。两页均hidden的原生调用记录仍有19–23ms间隔。连续原片进一步确认：process原帧79／PTS1.391667、105／1.833333仍有整块正文灰空，下一样本恢复，而工具栏保持；前两次已查样本未捕获灰空，不能据此覆盖后两次反例。因此006只通过宿主不拆装与数据保留，正文闪空尚未收尾，当前沿已有输入屏障验证准确旧live页到新页的短期交接，不使用旧截图或旧refs。

本次最终受影响的UI标签23项407断言、bridge11项137断言、capture98项1423断言、Pane DOM20项292断言、ChromeRoot真实组件14项148断言、Chrome host47项347断言，共213项2754断言通过，包含实际Panel比例历史、同尺寸无漂移／新量测重置、后台无呈现observer／revision、切页仅旧可见owner撤销、fresh ACK及1500ms未确认回退、scope／导航／Root环境／旧事件拒绝。UI与Desktop类型、11个变更源码／测试的Biome、Core边界和测试归属通过。产品手册页面保留与控制承诺及Native release资格已核对，预期不改；这些UI制品不新增普通发行、跨平台或真实模型资格。006八个负责源码hash执行前后无漂移；本轮所有实际客户端及录像正常退出0、模型零增量，独立账本仍209＋295＝504，旧unknown与失败保持，未暂存、提交或推送。

正文交接现由[Host](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/electron/browser-chrome-host.ts)保存准确旧／新binding、view／token、Root frame／metrics、原viewport与单次key；[controller](electron/native-browser.ts)只有在旧页仍合格且`displayShieldReady && inputShield.available()`时保留旧live view，逻辑呈现和旧proof仍撤下。尚hidden的新页移到旧页下方，旧层不拆装，原生输入shield置顶并按旧viewport拦截人类页内输入／焦点；不增加全局keyboard或toolbar门，后台Agent输入与当前合法UI动作保原路径。新页经原fresh ACK／当前量测显示后，一次自身`capturePage()`只作为完整帧就绪依据，前后核scope、key、旧／新token、frame、导航、revision与几何；图像不编码、保存、展示或返回模型。每页最多一个未决读取，失败、1500ms期限及resize／scope／nav／close／crash／Root变化按准确key撤旧；迟到结果、ABA或第三目标不能藏掉当前页。

`hosted-retained-tabs-007-live`的Main98114正常退出0，冻结源码完成4次准确目标切换。每次读取目标自身完整帧时，旧／新页实际均visible、旧live层在目标层之上、原生shield在最上层且viewport完全相同；4次读取均非空592×1406，耗时20／5／11／10ms，随后才撤旧。Root没有全宽复位，Chrome未隐藏，原页身份与百度输入保持；scrollY仍只覆盖0。该记录核实真实native层级和shield位置，不把它扩称为全部物理键鼠／IME验收。两路连续像素已完成4切与稳定尾复核：display101个、process145个导出样本中未见006正文灰空、工具栏撤下、重复标签、全宽聊天覆盖，或目标正文出现后再闪回旧页；第三次process79／1.375000为完整Example、80／1.391667为百度，第四次103／1.816667为百度、104／1.833333为Example。仍有标签／地址先换、旧live正文保留至目标就绪的短暂阶段，不能称各surface原子同帧切换。解码退出0、原片hash前后保持，当前范围只覆盖该开发制品已加载tab切换；普通发行和此前resize灰带／裁切资格不升级。原帧与逐段像素复核归该目录review，006灰空原例保留。

用户继续明确了007未覆盖的两条生命周期：新建B并导航后返回A、关闭当前B自动回到A。`hosted-tab-lifecycle-008-before`冻结开发制品Main94471复现前者：process原帧70／PTS1.233333、display44／1.275000整条右栏（含标签与工具栏）灰空，下一样本才恢复百度；新B初次导航也记录正文灰帧。B当时已报告loading=false，不能把网络加载结束当作呈现交接已完成。该轮close夹具在派发前找错X位置，原失败保留，不授关闭回退资格。

当前原生呈现把宿主几何与旧网页的可用性分开：同scope／Root环境／实际几何仍合格时，新tab绑定、同id导航换wire、旧页loading或被真实关闭不自动拆Root／Chrome；新目标仍要fresh ACK与当前量测。`prepareBrowserPresentation`仅在Root用户意图下，为准确现存目标准备一次自身当前完整帧；100ms未就绪退正常fresh路径，ready最多等1500ms采纳。目标放到原live页下方并置原生shield；内部图片不编码、保存、展示或给模型，尺寸变化先退休旧坐标依据，未采纳准备不授模型截图或控制证明。每目标最多一个在途读，每次独立意图的取消key不共享；晚到key不能撤掉后来的准备或已采纳目标，导航／Root／scope／几何变化按准确事实取消。

[Root](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/src/native-browser-chrome-root.ts)在同一次React提交内立即撤掉旧资料端口的动作资格，只把父active尚未更新时的正负端口发布聚合到提交末，避免卸载中间的null。`useSessionTabs`的可选预备先于选择／当前页关闭；子标签先发布继任A的正快照，父layout effect在同一同步commit派发真实close(B)。Main收到close仍立即unregister、删除并销毁实际WebContents；ready目标A的保留不再依赖B存活，不伪造旧page.alive，不延迟真实关闭，也不把准备当作新控制租约。后台／最后／非浏览器关闭保原路径，未提交意图、ABA与scope变化取消准备；UI250ms外层期限只防桥悬挂，迟到receipt按精确key取消。

`hosted-tab-lifecycle-009-after`的Main3563修后实测仍失败，原例完整保留：新建后返回A已未见008整栏闪空，但当前B关闭后，process116／PTS2.225000先露百度，117／2.241667正文又撤下，display89／2.266667与90／2.283333对应；稳定尾仍空白。B实际destroyed=true，A原文档／输入仍在但hidden，不能计关闭回退通过。原driver.log确认A的onReady→automation.present／paint→publish→syncInput读取已销毁来源的WebContents为空而抛TypeError，随后Root发布失败走fail/null并撤宿主；不是100／1500ms期限。普通fake仅置destroyed=true仍保对象漏测，现按真实getter清空补回归。另一次原生层级记录确认，把原已在B下方的A按旧sourceIndex重新插入，会因移除时索引左移而放到B上方；当前仅当目标原在源上方才移动，已在下层的目标不拆装。009对新B capture的首次空URL包装盲区不作“未捕获”的产品结论；下一受控制品在创建时包装准确自有view并在调用时记录。010诊断制品仅离线准备，未启动，直接验证上述原始错误闭环的修正。

`hosted-tab-lifecycle-010-final`的Main8110使用最终冻结源码通过两条实际流程：新建B导航后返回A、再选B并关闭回退A。三次目标自身完整帧均为592×1406，分别4／3／14ms；每次旧source和目标均visible、source在目标上方、原生shield在source上方，viewport相同。B最终真实destroyed，A仍为同一WebContents2／timeOrigin且输入`kite retained tab check`保持；scrollY仍只覆盖0保持。第一次返回A起Root全宽复位0次、Chrome隐藏0次；退出前12个负责源码hash与构建相同、drift为空，driver无009异常、无verification-failed，Main和两录像均正常退出0。准确制品路径的进程已只读核absent，用户原客户端未操作；模型仍209＋295＝504，没有新增调用。

本次必要受控回归为Host51项375断言、capture116项1597断言、preload-bootstrap9项123断言、UI标签34项491断言、ChromeRoot真实组件15项170断言、SessionPage6项83断言，共231项2839断言通过。新增失败均先红后绿，覆盖真实销毁getter、paint／changed重入、原下层不拆装、100ms延迟timer、1500ms过期、独立key和晚到取消、准确邻居／后台／最后关闭、同scope快速往返与重复同目标。UI与Desktop完整类型、相应格式检查通过；旧Pane与连续投影未变部分复用前述适用证据。当前开发源码涉及Main／preload，必须完整重启`desktop:dev`才加载；Renderer热更新不能让仍在运行的旧Main取得本次原生修复。

010两路原片已完成操作区PTS0..4及最后0.4秒的全部导出样本复核：process237、display175个样本未捕获008整栏闪空、009 A出现后再被撤下、重复标签或目标正文已出后的旧页闪回。返回A的process67／1.183333为Example、68／1.208333为百度；关闭B的120／2.208333为Example、121／2.225000为百度，后续及12.000000末帧持续百度；display对应闭页91／2.266667到92／2.283333，11.991667末帧保持。两路解码退出0，原片hash／元数据未改。地址／正文仍不保证同帧，未导出中段不授逐帧视觉资格，录制采样节奏不当作App FPS。新B首次导航仍在process62／1.100000看到正文灰底，63／1.116667才出现Example，不将此次切回／关闭修复扩成首次载入零灰；原resize灰／紫带及局部裁切限制也保持。当前仅此开发制品的新建后切回与真实关闭回退切口取得有限`iteration_complete=ready`，普通发行、跨平台与全局零闪烁不升级；Core边界、测试归属、文档结构／影响及diff检查通过，未stage、commit、push或创建PR。原材料与逐帧结论归该目录review，008和009失败不改写。

用户随后反馈已加载tab切换时工具栏刷新闪烁，前述010对小图标透明度和工具栏DOM身份未授资格，本次只重新打开此展示切口。`hosted-toolbar-011-before`的Main13830以实际百度和知乎`signin?next=%2F`四次往返复现：header／form／input／reload每次全部换节点，刷新按钮实际computed opacity在1与0.45间变化。两页loading始终false、hasPage与canNavigate始终true，变化仅为fresh ACK／actionable；网页和Chrome宿主timeOrigin未变，没有网页或工具栏文档reload。原片和精确DOM／envelope采样保留，不把site STUN DNS日志当作Kite重新导航证据。

[独立Renderer](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/src/native-browser-chrome-renderer.tsx)现仅以Root scope作为React key保留整条工具栏；包含page id的owner／binding仍负责动作fence，不能为保DOM删掉页面身份。换页显式退休旧地址编辑、IME、echo和提交，立即展示目标地址；迟到旧回执不能给新页写unknown，失焦后旧IME最终input也不能成为新页地址变化。同页geometry仍保草稿、选区与IME，真正scope变化和null仍撤销。共享工具栏用`interactionPending`暂停导航按钮与form提交，并仅对真实可用的按钮保持稳定透明度；`addressReadOnly`只能收窄原编辑资格，不能覆盖真实canNavigate=false。busy、uncertain、真实加载／页面存在与历史能力保留原语义，原send／Root／Main准入均未放宽。

`hosted-toolbar-012-after`的Main17908以同URL和同隔离Profile完成四次实际切换：四类工具栏节点分别只保留一个身份，刷新computed opacity始终1；fresh ACK前按钮仍disabled、地址仍只读，页面事实不再被临时抹成false。原两个WebContents／timeOrigin及百度输入保持，Chrome文档没有重载；14个负责源码执行前后drift为空，无verification-failed，两录像和Main正常退出0，准确制品命令路径已核absent，模型账本仍209＋295＝504。driver内站点STUN DNS和退出时macOS task_policy日志原样保留，无009的Kite handler异常。连续像素资格按该目录review核实，不因DOM断言通过提前授无闪烁。

本次[Renderer回归](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/test/isolated/native-browser-chrome-renderer-dom.test.tsx)11项102断言、共享标签34项491断言、Pane20项292断言及[呈现回归](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/test/isolated/native-browser-chrome-presentation-dom.test.tsx)4项43断言，共69项928断言通过；新节点保留／旧编辑隔离及late input均先红后绿。同页geometry／IME、旧异步unknown、scope／null、实际控制限制和加载图标仍覆盖。呈现回归原有“隐藏即删除toolbar port”断言与此前已实施的后台资料保留矛盾，现核准确后台资料继续存在、旧port不能导航／刷新或开菜单，控件入口照常撤下；没有回退保后台资料的实现。UI／Desktop完整类型与五个变更源码／测试的Biome通过。Main／Host／preload及正文交接源码未变，复用前述适用证据，不重跑天气或模型。

两路原片的594×184原生顶部条带已精确裁切复核：011在process25／PTS0.466667、51／0.925000、77／1.375000捕获刷新图标暗帧，display19／0.491667和51／1.408333也采中；process第四切未采中，不能将DOM四次重建扩称为像素四次均失败。固定刷新区域亮像素指标在旧暗样本约125.79–126.22、稳定样本约240，012全部190个process及116个display条带均在238.45–241.23，未再见额外变暗。四次关键切换和稳定尾未见整栏空白、重复工具栏、旧地址／正文闪回或009式目标出现后撤下；完整窗口只授已复核的关键四切与尾，不将全部toolbar裁切扩称全窗全片逐帧。四原片hash与字节保持，准确范围和原图归各review/REVIEW.json。此次工具栏切换切口的有限iteration_complete为ready；文档结构／影响、Core边界、测试归属和diff检查通过，普通构建、跨平台、物理IME及原resize／首次导航残留资格不升级，未stage、commit或push。

用户新增首个tab输入网址后的强闪。`hosted-first-page-013-before`冻结开发制品以普通UI输入真实HTTPS百度，连续两路录像实证本地栏先撤、右栏全灰、正文先到而顶部仍灰；缺栏到恢复采样间隔166.667ms，其中全栏灰到正文出现33.333ms。Root在导航后约207ms即隐藏本地栏并裁剪，实际网页DOM-ready还要约219ms；Chrome的dom-ready并非React工具栏已绘制。原图、PTS及审查范围归该目录review，不能以012工具栏切换通过覆盖。

当前[controller](electron/native-browser.ts)在原两步Root量测后返回`presented:false`，保留起始DOM和本地栏；完整Root下以准确viewport准备真实原页，复用文档ready，不申请Agent控制。Page自身完整帧与[Host](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/electron/browser-chrome-host.ts)当前Renderer提交、工具栏自身原生绘制帧齐备后才offer；fresh Root ACK核准确scope／frame／token／URL／revision和几何，采用原Page后才确认`presented:true`。实际准备不生成模型观察、编码或展示截图，当前Model坐标在改变sizeEpoch时失效；同exact请求重发保持等待。停止、导航、关闭、scope、resize和Root替换取消旧准备，每页单在途，fresh ACK有独立1500ms期限，准确失败保Root且不刷新／重开／重放导航。014修后未完成交接但保住Root，015单次私有诊断确认Chrome从0尺寸变成当前尺寸后直接capturePage返回`UnknownVizError`；据此首个surface等待自身真实新尺寸绘制帧；同一次准备中后继同尺寸revision已具有surface，只做单次当前帧读取，避免没有像素变化时等不到新paint。统一读取槽在旧capture完成前不释放，帧订阅结束后旧回调亦无权限。原两次失败和日志保持。

`hosted-first-page-016-final`的冻结开发制品Main44089完成普通UI首个HTTPS百度导航、同客户端新建B并输入HTTPS Example、A/B往返及真实关闭B回A。Page自身592×1406完整帧与Chrome自身594×184非空原生帧均在完整Root下取得，Chrome首帧后10ms才采用原页并发准确`presented:true`；新B也完成相同双帧交接。两个网址各只loadURL一次，A原WebContents／timeOrigin、输入`kite first page retained`与scrollY=0保持，B实际销毁；不授非零阅读位置资格。两录像与Main正常退出0、16源码hash前后drift为空，无verification-failed，准确制品命令路径已核无残留进程，模型仍209＋295＝504。driver保留3条`browser_chrome_stale_rendered`拒绝日志，不把正常退出或读取成功写成运行时无错误。

该目录review复核活动过程0–8秒及稳定尾：process441个、display311个全窗样本，另20张原生工具栏关键裁切。首开process52／0.958333仍为起始页，53／0.991667已为正文与完整工具栏；display43／0.966667至44／0.991667相同。新B首次导航、回A、回B、close B→A亦直接接替，未复现013约166.7ms顶部灰缺口、整栏灰黑空白、重复栏、旧页回闪或覆盖聊天；不扩称全15秒逐帧或系统各surface原子同帧。初次本地到原生工具栏仍有细小背景色与约2DIP内距差异。原片hash／字节前后保持，完整PTS与检查范围归review/REVIEW.json，013–015旧失败保留。

本切口的Main135项1845断言、Host77项764断言、Root preload9项125断言、Chrome preload1项23断言、Chrome bridge3项38断言、Native bridge11项145断言和三UI文件52项606断言，共288项3546断言通过。Host首次0尺寸DOM确认及同尺寸后继revision无新paint反例先红后绿；Main覆盖单边首帧不足、当前准确ACK、18种首问用例与独立ACK超时，不重跑模型补数量。UI／Desktop类型、14个本轮源码／测试Biome及适用边界与文档门禁通过，支持此开发制品首开与相关标签回归的有限iteration_complete；原resize灰带／裁切、普通构建、跨平台、物理IME和完整发布资格保持，未stage、commit或push。

用户随后确认此前验收遗漏的新对话路径：尚未首次发送，就新建手动tab并输入百度。其真实截图中标题/地址已更新，正文仍是Tools。源码核实preparing按原设计撤销正式`browserRestoreScope`，Pane现代布局却要求它才能呈现；直接去掉早退仍会让Main create默认借旧selected Session，且真正无scope页面未安装文档ready。现以Root本地draft owner绑定手动页面，普通请求、两步布局/ACK、菜单和关闭都核准确token/Root frame/epoch，清单不含Agent control；不预建Session、不注册或arm、不借旧scope。文档ready已成为所有真实Page的共同生命周期，Agent仍只给正式scope安装控制端口。草稿保持Root本地标签/工具栏，目标自身完整帧后采用，稳定尺寸用同一Main外推及异步校准；Session专属Chrome清空不撤草稿。Root重建只按准确token重新核展示绑定，保网页/表单和旧revision floor，不刷新/重放。理由归原[布局Note](../../.agents/notes/proposed/architecture/2026-10-31-native-browser-native-layout.md)。

`hosted-draft-page-017-final`在网页操作前被夹具的new-session aria-current断言拦住：项目选中时该按钮本来不标page，实际已进入准备页。018仅修夹具为真实新对话标题判据，17个生产源码完全冻结。`hosted-draft-page-018-final`完成发送前HTTPS百度显示、切已有Session隐藏、返回同Page与输入、短段resize及真实关闭；原WebContents/timeOrigin、`kite draft retained`与scrollY=0保持，正式Session清单始终不含该草稿。私有被动方法记录没有conversation.send或创建入口，导航请求仅1次，无grant，模型账本仍209＋295＝504。Main/录像正常退出0、无verification-failed，17个源码hash执行前后无漂移，用户客户端未停止；原截图逐字节保存到018的user-report.png。

018连续画面仅授功能通过，不授无闪：0–9秒活动及稳定尾的display344帧直接复核；process494帧由270帧直接观察与224帧完整PNG SHA精确相同映射覆盖。首次process1.108333有一帧深色空正文，1.125000出现百度；display未采中相同空帧。返回准备页约0.24–0.26秒短暂显示Tools再恢复原输入。resize在process3.283333有窗口内右灰带，关闭在display3.725000有一帧底部白色L残片，3.750000清除；稳定尾无残留。原图、PTS、sha/bytes及范围归018/review/REVIEW.json，不用phase断言或最终正确状态覆盖这些过程。

为核首次暗空尝试了019局部候选：真实viewport放在窗口clip外且保最终层级，再只移动位置采用，避免准备后重挂。实机返回`Current display surface not available for capture`，未采用网页，故放弃候选；019的BUILD、原始trace/录像和native-browser.candidate.ts保持。生产Main已逐字节恢复到018 BUILD所记录SHA，其他负责源码未变，复用018实际证据，不重复等价GUI测试。此候选失败不能作为空帧真实底层原因已定论，首次短空帧、返回起始区、缩放灰带及关闭残片继续保留。

本次适用验证：Main完整呈现文件155项2165断言通过，恢复018后draft定向20项328断言和Biome通过（其余未变完整结果复用）；桥/preload四文件27项407断言通过；五UI相关文件63项772断言通过，后继revision护栏补丁再跑Pane整文件29项356断言通过，最终夹具类型修正定向通过。Desktop/UI类型、13个本轮源码/测试Biome、Core边界、测试归属、文档结构/影响及diff检查通过。此iteration_complete只收束发送前持续不显示的功能阻塞；018已见的像素缺口继续保留，普通构建、跨平台、物理IME、FPS与整体无闪资格不升级，未stage、commit或push。

本轮继续修018剩余显示交接。代码上可确认三处不一致：草稿采用后再次移到Root上方；保留页restore只传id/title、Pane重建成空网址且自动展开240ms；最后关闭先销毁再移除标签、撤宿主也未确认Root目标帧。现草稿以独立展示owner接入同一Chrome双帧／fresh ACK／Root裁剪，不再在采用时重挂Page；正式Session scope及Agent注册保持分离。Root另发布单调context revision和准确owner，draft快照不能自授当前显示权，旧cleanup/快照/正布局不能撤销或复活新目标。

恢复按Main准确状态缓存有界显示hint，保留已知网址但不授presented、语义引用或截图坐标；实际采用仍须新证明。自动恢复直接使用最终栏宽，不启动240ms展开动画。当前网页回Root时先保留准确原生Chrome顶部条带并禁输入，Root展宽后按一次性key确认完整nonce帧及其后完整非透明清除帧，再真实hide/remove/close网页并撤条带。取消绑定页面token、Root frame/epoch、owner/context、尺寸，截图旧坐标同时退休；未知关闭只读state一次，不重发。此顺序保证真实关闭发生在Root绘制确认之后，不能单凭代码保证Root展宽至首帧之间没有暗空。

`hosted-display-handoff-020-final`完整重启开发制品Main92399，17源码hash录制前后drift为空。真实普通UI新对话发送前首次HTTPS百度、切Session隐藏、返回原页、短段resize与最后关闭均执行；百度导航一次，prepareClose/confirmClose/finishClose各一次，原WebContents/timeOrigin、输入`kite draft retained`及scrollY=0保持，草稿不进入正式Session清单。两路录像和Main/driver正常0，精确制品命令身份已absent，未停止用户客户端；没有conversation.send/创建/grant，账本实数209＋295＝504不变。driver仍有3条browser_chrome_stale_rendered拒绝日志，不授运行时零错误。020的review逐帧核0–9秒及末0.4秒：process493帧（229直接观察、264完整PNG SHA相同复用），display347帧（291直接观察、56精确相同复用），原片sha/字节保持。首开process64/1.150000起始区到65/1.166667正文直接接替，本轮未再采到018首帧空正文；返回改为约0.1秒可读准备态到原页，未再闪回Tools。关闭未见旧白色L，但process184/3.591667至189/3.675000、display149/3.625000至153/3.716667仍残留旧标签/地址和“页面已变化”，直到下一宽帧撤掉，因此020关闭体验不通过。离开草稿切Session在process100/1.916667有整列灰，display未采中；resize的process164/3.233333灰带及display138/3.258333短缺页也保留。功能通过不替代上述像素失败，不能授全过程无闪、FPS或系统同帧资格。

020新反例后只修旧Chrome内容寿命：Root-return且准确null意图时，Host envelope/read一并返回null，保内部binding和物理条带供Root nonce/清除帧确认；Renderer空宿主沿最后主题填当前strip背景，无标签/地址/短提示、输入或新View。`hosted-close-target-021-final`只录这一关闭切口（6秒双源），Main96942/driver/两movie正常0、17源码drift为空，无verification-failed，driver无020的stale-rendered日志。process7/0.133333原页到8/0.150000 Root、display6/0.166667到7/0.183333直接接替，已观察切口未再见旧bar/短提示、白L、nonce或新增白/暗空；不过process8–13右上按钮仍被空宿主遮住，14/0.258333才出现，约108ms分步UI仍保留。021复核覆盖0–2秒及末0.4秒：process128样本（72直接看、56完整PNG字节相同复用），display98全部直接看，原片hash/bytes前后相同。该有限证据不升级全场景无闪或系统原子资格，也不覆盖020仍有的切Session/resize灰列。原片与限定范围归021/review/REVIEW.json；不重复完整天气/模型场景。

本次Main完整179项2707断言、Host最终91项914断言、Native bridge14项218断言、Chrome bridge4项52断言、Root preload11项191断言、Chrome preload1项23断言通过，日志在本机root-return-capture-20261101和root-return-host-20261101；它们覆盖双帧顺序、draft/Session、无效/透明/旧帧、Root/scope/context/resize/重建取消、坐标失效和旧异步校准。Pane独立整文件30项362断言、SessionTabs独立整文件38项514断言、Chrome Renderer最终独立13项121断言通过；首次错误地合跑isolated DOM文件的4项HMR失败保留，按仓库隔离进程重跑后通过，未改生产来适配夹具。020退出后仅修Native关闭失败hint Map边更新边迭代的循环，改遍历快照；专项目标1项7断言证只读一次、不重发、移除canvas并可读失败，该分支未被020正常关闭路径触及，不重跑等价GUI。

按用户要求先将前轮39文件本地提交为`4137f24f6`，未推送，再继续021按钮延迟。Root-return收到准确null后，现仅将原Chrome View收小到覆盖实际nonce的保守左上矩形（通常124×7 DIP），更新同一保存fact的物理bounds；原receipt坐标、Root两帧、页面token/context和真实close顺序保持。先核原geometry，重复null不重写，取消/结束恢复原职责，下一正常layout重新给完整bar。zoom下界过保守、无法证明小矩形覆盖时保原strip继续关闭，不为优化制造失败。Host完整92项1047断言与Desktop类型/Biome通过，涵盖普通zoom/backing、最窄边界、实际palette包含、低zoom回退及九种取消/恢复。

灰列另只核一个有依据的新候选：固定44.3.0/Chromium152的Root `Emulation.setVisibleSize`并非纯buffer预留。私有root-visible-surface-001在基线同步helper后立即读点击而停止、候选0次；root-visible-surface-002-input-ack仅修异步真实事件回执，两个基线trusted点击均0→1后调用候选恰好一次。Root外层bounds仍700×760、字体/文档/表单/阅读位置不变，但原生帧1400×1520→2400×1520，WindowServer窗口/桌面原图均见Root洋红覆盖右橙/青区域，故明确否定并未接产品。两个Main正常结束/无源码漂移，原失败保持；没有模型/Service或第三次启动。不能据完整Root帧或getBounds正确授实际裁剪，原切Session和resize灰带尚未解决，未扩大引擎补丁或发行资格。

`hosted-close-mask-023-final`冻结制品Main8819实际把Chrome从297×92收成124×7；process9/0.158333、display10/0.191667的首个完整Root已同时有右上按钮，未复现021的75–108ms遮挡。0–2秒及末0.4秒的process133样本（77直接、56完整PNG相同复用）、display87全部观察，原片hash/bytes保持；后继小mask未见nonce/色条/白L/短提示。但process8/0.141667有一帧正文先撤、聊天仍窄且旧bar尚在，9下一样本才完整交接；display未采中该过渡。该反例保留，不把按钮修复授为所有样本无旧栏。

源码继续定位到`present(null)`在同一有效closing事实中仍提前hide原Page。现仅在准确capsule、原Map对象、shield可用且Page实际位于Root下时保留尚未销毁的真实live页，仍clear presentation/active并automation.present(false)；原Root两帧完成才hide/close，不重挂或保旧截图。取消时只撤准确旧对象且无新presentation的临时像素，并同步恢复shield，避免透明挡输入面残留。正式截图/旧坐标/旧异步布局仍拒绝，物理visible不新增Actor权限；通用后台CDP能力仍由原lease决定，不把输入盾当CDP权限栅栏。Main完整179项3050断言及两owner、18种取消边界通过；原首轮shield未收回失败日志保留，修正后不放宽断言。

`hosted-close-live-source-024-final`仅针对023提前hide的新因果复核。Main14656/driver/两录像正常0、17源码drift为空、无verification-failed；Root全宽+4ms、小mask+18ms，原Page没有提前hide，到+54ms真实关闭时才与shield/Chrome一起撤下并destroy。process9/0.158333完整Page到10/0.175000完整Root+按钮，display8/0.183333到9/0.200000同样直接接替，未再采到023窄聊天/旧bar/缺正文过渡；顶部原像素无nonce/色条/白L，稳定尾无旧网页闪回。0–2秒及末0.4秒的process128样本（72直接看、56完整PNG相同复用）、display102全部观察，原片hash/bytes保持。此资格限普通缩放下本次关闭切口，不升级系统原子提交、低zoom回退、跨会话/resize、普通构建、跨平台或FPS；旧020/021/023失败均保持。最新Desktop类型及定向Biome通过，UI源码未变复用前轮结果。本轮未新增模型，账本仍209＋295＝504；关闭修复随后本地提交为824966026，提交hook全部通过，未推送。

关闭检查点后按用户要求只读定位020剩余灰带，未启动客户端或新增模型／实机测试。切会话与resize不能归为同一撤页问题：离开草稿后，020原trace在点击+11ms发布目标Session context，+12ms将Root从1175展到1472并隐藏原Chrome／Page；Page没有销毁，返回仍为原WebContents、timeOrigin和输入。共享[SessionPage](../../packages/ui/src/desktop/SessionPage.tsx)同时在scope退休时调用排到下一rAF的collapseDetails，并开启宽度动画；CSS默认时长是180ms，240ms是动画标志清理时间。原生展宽／撤页和UI收栏启动时点确实分离，但trace没有Root compositor呈现回执，不能据此断言动画是process100灰列的唯一原因。

scope退休的局部修复已按后续授权实施：layout阶段取消旧details待执行动作并直接定目标布局，未决restore／selection不作关闭推断；目标detailPanel／任务编辑器保持打开。导航与右栏分别管理动画标志／timer，旧scope的右栏动画不进入新scope；普通手动开合仍有动画。机械布局不调用changeTabsOpen(false,false)，不把目标scope写入dismissedBrowserReveals。自动reveal和已有页请求提前到layout阶段；reveal去重按本次scope激活，不再让之前已显示过的原页阻止返回展开，用户显式收起记忆仍保留。移除任务编辑器退休时额外排队的collapse，统一按当前右栏意图处理。024只证明同一owner准确closing中的live页保留，不能直接推广为在新Session显示旧Session页面；context的6→null→8仍受选择与Caller freshness约束，不以减少状态次数删除这些守卫。

020的resize中Page与Chrome始终visible；恢复扩窗时Root实写为1025→1054→1025，同值bounds去重和唯一Main入口均已存在，不能把不同校准当作同值重复删除。嵌套Panel约束结算与Renderer量测交错起初只是推断，025后继新增完整layout输入和metrics起止，已定位中间值对应暂时放大的导航宽度，准确过程另列下文；尚无Root compositor提交证据，不能认定中间值从未呈现。导航栏保存宽度仍须保留：面板库在最小值钳制后只沿已受约束尺寸继续计算，不能独立恢复用户偏好。稳定正宽校准的合并也须先证明它们属于未呈现的中间布局；rAF先于ResizeObserver执行，单改成rAF或多等一帧不构成稳定证明。即使省掉1054，752→1025的首次真实surface展宽仍存在，不能宣称会消除灰带。当前仅修切会话调度，resize源码未改；后续范围和未采用候选继续归[原生布局Note](../../.agents/notes/proposed/architecture/2026-10-31-native-browser-native-layout.md)，灰带保持未解决。

`hosted-scope-retirement-025-final`为本轮最新冻结开发制品，Main32408／driver／两路9秒录像正常0、17源码drift为空、无verification-failed；准确Main及Ea7J7g制品进程已退出，用户18842实例保持。普通UI新对话手动HTTPS百度、输入`kite draft retained`、切已有Session、返回同页，WebContents2／timeOrigin1793523187818.8／输入／scrollY=0保持，切走隐藏且未destroy。528条被动DOM记录中，离开会话后右栏animation均null，未再启动退休宽度动画。没有conversation.send／创建／grant派发，新模型为0，沿用账本209＋295＝504；driver四条browser_chrome_stale_rendered拒绝和退出后的target-closed metrics拒绝原样保留，不授零错误。此普通UI切口不替代新自然语言Run、普通构建、平台或FPS资格；原020／024记录保持。

025同次只追加1050→1472一次resize诊断。相对resize-start，+12ms窄窗navigation200／workspace849／details300已结算，校准x752；+58ms扩窗Main先正确预测Root1025，1472 metrics仅一次于+66ms完成。+64ms DOM仍按旧19.066%给navigation280.4609／workspace1190.5391／details420.6875，+65ms已恢复200／1271／449.1172；中间x1053.3125却到+72ms才进入Main，+73ms把Root回写1054，+74ms最终x1024.8828使其恢复1025。因此该回摆已定位到嵌套Panel中间分配和异步迟到，可排除本次CDP ABA及宽度动画，不能再笼统归成浏览器绘制慢。公开Group.getLayout、Panel.getSize／onResize及onLayoutChanged均不提供整轮约束结算完成事实，直接按旧预测拒绝也可能丢合法splitter调整；本轮不做猜测过滤或固定帧延迟。被动采样混合MutationObserver／rAF且未标来源，没有compositor提交链，仍不能证明1054未曾呈现，更不能将去回摆等同消除首次surface展宽灰带。

本轮UI两文件按isolated约定分别通过45项622断言，UI／Desktop类型、定向Biome、Core边界、测试归属及文档检查通过。新增回归核同帧直接布局、待决恢复、旧RAF取消、目标详情保持、返回原scope与显式关闭，以及navigation动画不被误停；Main／Host和工具协议未改，复用024适用的179／92项证据。连续像素结论另由025原片复核，功能或动画标志通过不替代逐帧结果；本轮后续修改尚未stage／commit／push。

025逐帧仍保留呈现缺口：切走的process95/1.866667为完整原页，96/1.883333与97/1.900000已是目标Session但消息／header／输入仍窄，98/1.916667才全宽；display84/1.891667原页到85/1.908333、86/1.925000目标窄布局，再到87/1.941667全宽。两路均采到约33.3ms中间态，180ms动画退休已修，首个目标Root仍分步绘制，不授切会话完全无闪。返回process138/2.683333的可读“正在显示原网页…”到139/2.725000正文，display118/2.733333准备态中地址行临时缺画、119/2.750000恢复正文／bar；无持久页面丢失或旧网页复活。resize的process162/3.141667有宽灰列与右侧细页片，163/3.158333恢复；display134/3.175000实见Root／Page间约30DIP灰条，135/3.191667恢复，不能只归窗口录制源。复核完整两路约9秒：process462帧（188直接查看＋274完整PNG字节相同复用）、display367帧（253直接＋114相同复用），18张关键及邻帧另看原生全图；稳定尾无旧网页闪回或持续空白。原片1437710／1444829 bytes及SHA前后相同；完整覆盖与原片完整性归025/review/REVIEW.json，不将最终正确状态或动画flag结果覆盖上述失败。

Cmd+W／Dock重开另有确定死锁：Main的hide显式隐藏Page并清active，Chrome binding／hosted及Pane的committedLayout仍保留；原visibilitychange只排rAF，隐藏时不执行，到重新可见才把正宽误作async校准，Main正确拒绝不可见／非active页。现visible回调立即令旧effect stopped，废旧presentedOwner并创建新presentationEpoch，新effect用新revision和现量测走bootstrap，旧ACK／async回执不能跨代接管；正常resize仍异步，准入不放宽。Main hide另增加sizeEpoch并删除presentationFrame，恢复相同尺寸也不复用旧截图key。原Page／document／lease不销毁、不导航；已实际显示过的同owner恢复不再复活Tools，而保原页准备态。

026为未加Page原生帧门、仅含可见性恢复的冻结开发制品Main46215，普通UI三个新百度页、原生CG Cmd+W及准确Electron Dock图标AXPress，hidden／visible实际投递、重开新sync revision10，三WebContents2／5／6的timeOrigin、`kite window retained 0/1/2`与scrollY=0保持。Main／driver／两路14秒录像均0、17源码drift空，无verification-failed，原八条stale_rendered及退出target-closed拒绝保留。逐帧仍见display63/1.450000新空tab整栏灰、64/1.466667恢复Tools且短细条；第三URL display97/2.175000上半正文到、下半暗空，98/2.191667完整，产品自身完整副本不能覆盖该失败。Dock不再持续卡灰，但process173–174/3.433333–3.450000灰、175–178/3.491667–3.541667 Tools、179/3.575000原页；display146–147/3.466667–3.483333灰／show过渡、148–153/3.500000–3.583333 Tools、154/3.600000正文。完整两片process715帧（181直接＋534完整PNG同字节复用）、display526帧（408直接＋118复用）、25张原生关键图，原片2044612／3361298 bytes和SHA保持，范围归026/review/REVIEW.json。

按026新反例，首URL的initialDisplay现在在DOM-ready完整副本之外，订阅准确Page的完整原生presentation帧并请求invalidate；保持原Root源、frame／token／URL／几何及单在途读取，成功即结束该订阅，再沿原Chrome自身帧／fresh Root ACK采用。取消／超时结束准确订阅，迟到或旧尺寸帧不能offer，不用非白像素判断、固定sleep或追加导航。此信号归[固定Electron帧订阅API](https://github.com/electron/electron/blob/v44.3.0/docs/api/web-contents.md#contentsbeginframesubscriptiononlydirty-callback)，仍不证明WindowServer各surface同帧。027冻结制品Main51000已实证三Page在副本后分别约4／9／4ms收到592×1406完整原生帧，未增加Page加载；同次真实Cmd+W／Dock返回保持三原文档、输入和位置。两路／Main／driver正常0、17源码drift空，无新模型，沿用209＋295＝504；九条stale_rendered及退出target-closed拒绝不删。像素资格归027/review/REVIEW.json，不以正常final状态或帧信号自授无灰。

最终Main呈现整文件180项3068断言通过；Pane整文件32项384断言后，补恢复不返Tools断言的两项24断言再通过。最初新增Page帧门后的8项失败是旧夹具未发新帧，原日志保留；更新明确的fake frame投递并加手动控制的完整副本不足、残帧拒绝与hide取消回归后通过，不放宽生产帧门。Desktop类型、四文件Biome、Core边界与归属通过；首URL与窗口恢复属于本机开发范围，普通构建／跨平台／FPS、025切会话及resize灰带不升级，所有旧反例保留，未stage／commit／push。

027两路完整14秒复核支持本次首URL采用切口：display51/1.183333、71/1.633333、93/2.066667三个首个正文样本均完整，process65/1.158333、88/1.625000、105/2.033333同样直接完整，未再采到026第三页下半暗空。新空tab的display59/1.408333、82/1.850000经原像素裁切确认有Tools，未采到026整栏灰；该反向路径源码未修，不据单轮未复现关闭其缺口。Dock仍有display143–144/3.308333–3.325000全窗灰／模糊，145/3.341667左Root已画但右栏灰无bar，146/3.358333原页准备态，152/3.466667恢复正文与原输入；首个准备帧另有短标题缺画及地址下细条纹。process167/3.291667全灰、169/3.325000准备态、176/3.466667原页。持续灰空与回Tools已修，短过渡不授无闪；稳定尾无错误页、旧页闪回或覆盖聊天。process726帧（191直接＋535完整PNG同字节复用）、display520帧（276直接＋244复用）、28张关键原生全图，原片2119664／3312654 bytes及SHA保持，准确覆盖和原图归027/review/REVIEW.json。Main51000及其7njVeR制品进程已确认退出，17生产源码当前hash仍匹配冻结BUILD，未追加第三次启动。

用户随后确认同时处理自动恢复和自动组合测试，先统一现有显示controller。Main现以Host当前已验收context／intent为唯一目标，`displayState()`只读比较准确Page对象/token、owner、原生bounds和既有交接事实；未知／尚未发布context不推断目标，明确null才撤原页。窗口show／restore／focus、hide／minimize、当前布局、Host发布与菜单结束合并到单个microtask核对；稳定native resize仍同步走唯一几何入口，不改成排队恢复。准备、关闭、菜单与输入屏障持有期间不抢交接，没有轮询或第二Agent Loop。

准确原页仍在而active／visible／presentation不一致时，Main先退休旧drawn证明、截图key与sizeEpoch、呈现anchor和输入资格，再沿私有`watchBrowserPresentation`通知Root。该有界通知只有id、owner与一次性key，无网址、代码、lease或业务命令；Pane核本次displayOwner／scope／draft／可见意图，立即停止旧effect，走同一restart入口，以新revision和当前量测bootstrap。隐藏文档只暂存本次通知，可见时消费；非native-hosted／其他平台保留必要DOM可见性兼容。同目标、Root、token与几何下只尝试一次；普通bootstrap也登记该尝试，失败不会自激循环，新的有效边界才可再核。旧ACK／校准／Host ready不得复活退休证明，不导航、刷新、新建页或重放业务动作。

自动回归沿既有Main／Host／Pane夹具组合事件而非反复GUI：Main新增29项，含缺DOM事件、active／visible单独丢失、显隐与最小化、scope／token／同URL多页、菜单／resize／旧Root回执、关闭及同尺寸恢复后旧截图key失效；整文件209项3617断言通过。Host整文件98项1132断言、Pane40项450断言、Native bridge15项247断言、实际preload VM11项199断言分别独立通过，Desktop类型与定向Biome通过。组合先暴露菜单结束漏通知及旧截图key未退休，两者修后转绿；测试不把忙碌或失败改为ready，不将模型化事件断言授为真实灰帧检测。真实制品的新增恢复切口与剩余像素限制继续在本节记录。

`unified-display-recovery-028-final`只核新恢复入口：冻结开发制品Main70307沿原隔离HOME／Profile从普通UI手动打开HTTPS百度，输入`kite unified recovery`。准确Page.visible私有故障后，Main约2ms发新观察通知、UI新sync revision4、约5ms恢复visible；34ms只读核同WebContents2、timeOrigin1793529046645.7、原输入及scrollY=0，DOM visibility计数始终0，证明没有依赖该事件。随后真实CG Cmd+W和唯一Electron Dock图标AXPress，focus／show触发第二次通知和新sync revision5；同原页／文档／输入／位置保持，没有第二次导航、会话发送或grant。Cmd+W记录到window.isVisible先变false、原生hide事件约267ms后才投递；事件到达时Page确实撤下，未将事件前的view.visible=true误计隐藏失败。Main／driver／双10秒录像正常0、17生产源码drift空，Main及fjebGc制品进程已确认退出。driver两条stale_rendered拒绝与系统sandbox_extension提示原样保留，不授零日志。无新增模型，账本209＋295＝504；本轮资格限本机开发制品，普通构建／跨平台／FPS及旧灰带不升级。

028完整两路10秒复核仍保留像素缺口：首次URL采用前display44/1.008333工具栏正常，45/1.025000顶部约594×184px工具栏白块、Tools正文仍在，46/1.050000才恢复工具栏并采用完整百度正文。此时尚无新恢复通知，不能将它计为恢复入口消除或由最终正文正确覆盖。故障注入后的样本未回Tools／持续灰空／丢输入，但真实hide约4ms可能落采样间隔，不能自授零闪。Dock的display128/3.141667仍右灰无bar，129/3.158333原页准备态含细条纹，135/3.266667原页和输入恢复；稳定尾无错误页、旧页复活或回Tools。全片process523样本（174直接＋349完整PNG同字节复用）、display369（227＋142复用），零未覆盖，另看关键原生全图，原片1530704／2675466 bytes及SHA前后相同，准确观察归028/review/REVIEW.json。该反例说明本次自动核对能修可验证的显示身份／绑定不一致，不能仅凭metadata ready识别任意白／灰像素或保证WindowServer同帧；不为掩盖它们增加刷新、截图替代或业务重放。



Cmd+W重开后resize出现的`browser_chrome_stale_rendered`另已定位并修复：合法DOM绘制回执可能晚于当前attachment、pageToken或snapshot revision更新；Renderer的Promise catch不能阻止Electron为Main handler异常打印堆栈。Host仍先核准确Chrome发送方／frame和封闭参数，畸形／额外字段报`invalid_browser_chrome_request`，仅合法但与当前绑定不符的观察无效果返回，不写renderedRevision、不pump新绘制。现有`rendered():Promise<void>`及公共工具／协议版本不变，没有过滤日志或吞真实sender／参数错误。Host整文件99项1172断言、受限preload1项23断言、Desktop类型与定向Biome通过；新增回归核rebind与resize后旧观察不变更展示、不能完成新准备，fresh回执仍须原生帧。修前准确失败保留在本机stale-rendered-before.log，028及更早stderr不改写。

`chrome-render-receipt-029-final`冻结开发制品Main79979，沿原隔离HOME／Profile普通UI打开HTTPS百度并填写`kite receipt retained`，真实CG Cmd+W后调用本实例同一app.activate入口重开，随后发八步16ms间隔的1472到1000再到1472 resize请求。验收时用户开发实例共享Electron Dock图标，因此保留唯一图标保护，未点击Dock或操作用户实例；本轮不新增物理Dock资格。私有只读回执观测记录11次rendered，确有revision7晚于8、重开revision10晚于11两次合法过期观察，最新handler正常返回，driver无stale_rendered或其他handler异常，不仅凭没有复现判通过。原WebContents2／timeOrigin1793529990518.5／输入／scrollY=0保持，终态Page visible且Root裁剪与Page左界同为997，没有新增导航、业务或模型。Main／driver／双10秒录像正常0、17生产源码drift空；连续关键画面范围及仍有灰带归029/review/REVIEW.json，不以日志修复授无闪或FPS。模型账本仍209＋295＝504，普通构建／跨平台资格保持。

029画面仅核两路连续0–4.5秒及末0.4秒，不扩成全片无闪。重开process136/2.500000、display101/2.533333为原页准备态，随后立即resize，视频没有独立采到resize前的正文恢复；trace的逻辑visible不代替该像素事实。process144/2.650000实见窗口内宽灰列，display108/2.708333亦有灰／半透明列，窗口外露出背景不计覆盖。process155/2.883333、display117/2.916667恢复完整原页与输入，尾部稳定；这支持旧回执未卡住新展示，不支持灰带、短空、工具栏条纹或FPS已解决。

[Chrome host](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/electron/browser-chrome-host.ts)只接收 Root 的有界纯展示快照，向唯一 Root 业务处理器转发封闭 UI 事件。独立[受限 preload](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/electron/browser-chrome-preload.ts)没有 NativeBridge、Service caller、任意代码或 CDP 入口；它与普通网页使用不同 session。Root 保留唯一 tab model、observer、地址草稿及权限读取。scope、真实页对象、attachment、revision、序号与一次性确认核实后才转发，确认丢失不重发；实际导航与控制仍由原 owner 受理。混合 reader、注释或遮挡右栏的全局界面恢复 Root 完整展示并隐藏原生绘制，网页对象保留。

此处源码已接入，冻结生产制品的连续 OS 画面、1.25 倍缩放、跨宿主输入／菜单和正常退出仍在验收，不能仅凭原型静态图或 DOM 回归宣布缩窗闪烁已消除。受控回归分别位于 [host](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/test/isolated/browser-chrome-host.test.ts)、[Root 工厂](test/isolated/native-root-window.test.ts)、[Root 分派](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/test/isolated/native-browser-chrome-root-dom.test.tsx)、[独立 Renderer](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/test/isolated/native-browser-chrome-renderer-dom.test.tsx)与[原页面呈现](test/isolated/native-browser-capture.test.ts)。

冻结组合实机的初次宿主未启用已取得反例并修正：`getPage.scope`使用准确页面本身的`tab.scope`，不等待绘制scope出现。后继实际hosted／actionable、原页身份、表单与固定段落位置均保留；新绑定不复用旧delegation ACK，迟到第二步布局也不能回退新分栏。零模型的`attempt-002`及真实系统拖拽的`attempt-004-native-display`仍分别在窗口源和真实桌面源观察到窗口内右灰带，准确原片、PTS和逐帧审查保留在本机`.cache/browser-recheck-20261030/ordinary-dev/observations/native-layout-20261031`。后置Main布局批次也已由冻结app-005-post-native及attempt-005-native-display否定其消除闪烁的结论：原页、表单、固定阅读段落和header拖窗保持，但真实桌面帧73（PTS1.825秒）及95（PTS2.233333秒）仍有窗口内部右灰带。因此缩窗仍未完成，不能用功能断言通过或最终截图授无闪烁资格。该失败制品与原片保留，不再重复等价天气任务；模型账本仍为504。

同网址新文档导航的只读审查另发现缓存边界：CDP／站点导航不走Main navigate，原页URL与generation可能未变。现统一在主文档did-start-navigation结束原帧订阅／合并timer、清缓存，并在loading期间不重建，拒绝旧回调；直接回归覆盖同URL导航前已有整帧和待合并帧，两者均不能进入随后resize。真实新UI首问6614在任何browser Tool前因模型连接TypeError失败，未收到HTTP响应、无页面效果，保留failed及账本213；当前默认和已有代理HEAD均405可达，未调整网络或凭据。该失败不计首问通过，原始记录和正常退出归`retained-frame-and-model-transport`。

当前实现已替换这两处像素来源：可见原页沿Native的presentation事件接收完整帧，仅非空dirty区域触发更新，保最多一份待帧、100ms合并和原4MiB PNG／尺寸上限；resize前可flush最新已收到的准确帧。不是capturePage截图轮询，后台AX和正式Model截图不等待它。待Root两步确认期间隐藏Native、保持网页真实viewport和原点，确认后才一次放完整bounds，避免裁成交集引起的重排／双列。隐藏、切页、导航和崩溃结束订阅并清旧图，原页面关闭与lease语义不变；Root只显示receipt指定key，迟到该图可以补齐，旧key不代替缺失的新图。首次零Model实录的115张连续关键帧已核未见编辑值回退或双列，仍见尺寸交接空底；已定位并补充保留上次实际整帧，直至新viewport真正交付新帧，显式隐藏仍清掉。69项直接回归通过，准确片及正常退出归`live-frame-handoff-findings`。修后连续画面、HTTPS、闭页和停止仍待必要核实，不计整体完成。

常驻页图的真实零Model复验未通过：人工编辑后，resident片#343为HUMAN-GREY-189，#348短暂显示旧Harmless，#349恢复；#369／370出现两列重影。实际DOM和页面身份始终保持，不能把最终正确值或黑帧消失计整体视觉通过。旧缓存不能承担当前页面像素，交集直接缩WebContentsView还会改变网页viewport及内容原点；正在改为准确可见页的dirty绘制图与单一呈现交接。普通Main6876、开发Main7535均正常退出0且准确登记进程absent，未再调用模型；原两配置／Store及212／0账本保持，事实与制品归`resident-fallback-regression-artifacts`，影片留原路径。修后HTTPS和闭页／停止流程仍待必要复验。

同帧灰阶已在真实Main订阅取得准确字节并通过两步ACK，零Model预检确认Native可见、同页人工输入与最终几何保持。但连续缩放录像仍出现Native暂隐时Root下层空白：原ACK2隐藏了衔接图，下一Main尺寸变化可能早于Root下一次resize。现保留准确原页的图像在Native下层，当前布局完成后的同key缓存才能刷新；旧key、其他scope或正在冻结时的迟到图不能替换，隐藏／切页／卸载仍清除。Pane定向5项147断言及Desktop类型通过，真实修后过程仍待复验；不将OS扩窗时旧Root缓冲和透明窗口未绘区域声称为已消除。

同一制品另以正常UI“新建对话→首次发送”创建真实新UUID，而非预建空会话：首问14次Luna／Responses／low、全部Tool成功，正常返回衡阳天气，原pageId／incarnation／WebContents／navigation3保留。随后新HTTPS地址建独立B且A未变；Model在B活动时尝试绑定A触发既有单活动页限制，最终仍正常回复，不能据此称A丢失，也不计跨页流程全通过。首问分片间约7.36秒无录像，不能称无缝全程。Main87131正常退出0、准确子进程均absent；账本212，Store另保留独立标题生成failed及4处早于本轮的unknown，均不改写。源制品／事实归`grey-resize-and-active-binding-findings`，录像留原路径。

首次绘制制品的普通A首问13次真实Luna／Responses／low完成天气查询且全部Tool成功，原pageId／incarnation／WebContents／navigation3保留、Human与detach均确认，但右栏始终黑空、绘制ACK为零；actor在真实可见性等待失败，不能计UI通过。120秒原片、逻辑Root图、Model记录及正常退出0保留于`draw-color-first-presentation-failure-artifacts`，新账本189、旧3处unknown不变。Root PNG带实际Skia ICC，按嵌入profile转sRGB前后marker数值显著不同，支持原RGB直比不可靠；未取得原subscription字节前不把所有失败点定死。当前改为同帧16级中性灰参考与完整96bit数据自校准，要求灰阶可分、每位与当前参考唯一匹配及两步区别，仍核scope／revision；66项922断言核非线性各通道曲线、低像素比例、坍缩、旧nonce及末位差异。先做零Model的真实订阅／显示预检，再以普通UI新建对话首发而非预建空会话继续真实HTTPS资格。

缩放呈现现沿正常内部绘制确认：Pane在原生页盖住的Root占位中绘制有限暗色witness，Main只在几何待提交期间核真实Root帧的准确scope／revision／nonce，首帧反馈再引起第二次真实Root绘制后才放完整Native bounds。期间Native限于旧／新容器累计交集，避免先盖住旧聊天布局；原页的有界图像通过异步事件预载，同步几何receipt只带准确key与显示尺寸。Root最多保两张非交互衔接图，按来源DIP／当时与当前Root zoom维持CSS比例、左上裁剪，不把PNG像素当CSS或拉伸文字；迟到缓存不能替换当前key。仅首次完整放置、加载结束及resize起点读图，没有稳态截图循环。隐藏／换scope／关闭撤销订阅和迟到确认，几何变化仍废旧截图basis，后台AX不等待呈现反馈。两次反馈证明实际新Root画面已经生成并往返，不宣称OS绝对原子事务；65项878断言、Desktop类型及Biome通过，最终空交集、扩窗、连缩与Native遮挡的真实画面仍待修后验收。

准确销毁页的Host／Service组合修复另有135项1422断言及两端类型通过：真实关闭回执只确认资源清理，不清洗已经派发输入的unknown；进行中读取保read_failed、输入保effect_unknown，原因可读为原页已关闭。原C的持久cursor已核首个pages成功、原snapshot成功后才发生X与cleanup unknown，前一Run主动page.close已确认正常；不按早先无序SQL输出推导不存在的准备竞态。原3处unknown不改写，修后真实闭页与健康B继续仍列本轮必要验收。

零历史普通会话C另取得完整120秒首问录像：8次真实Luna／Responses／low完成中国天气网首页输入、城市跳转、预报读取及释放，原子操作全成功、无checker／Question。随后新URL确实建立不同WebContents的B页、原衡阳A页保留；新消息截图确认并读取原A也成功，三项身份与navigation3均未替换。但active期间`pages()`漏掉另一释放页，模型两次误报无法确认另一页保留，当前按Browser owner修复列表投影和句柄复用。第一actor在B已经选中但标签被裁剪时重复点击而结束，不能计完整菜单／三轮脚本通过；B已选中时后续actor只核实际显示，不补为该失败脚本成功。

同一C随后真实Tab X已销毁A，旧lease的events／revoke／release却都被压成stale，Service错误锁成cleanup unknown；模型仍正常final而未中断，但说明只剩“未解决状态”，不是闭页原因的通过资格。下一消息没有替代页，B仍原样；普通退出30秒未确认，零活Run后只对准确自有Service先TERM再KILL，Main随后退出，不计正常退出0。原176次账本、3处unknown和全部原Store保持，影片留原路径、制品／诊断归档于`active-list-and-close-cleanup-failure-artifacts`，不会清库或改写旧结果。上述两片均正常录满120秒；首问片已目视完整timeline与全部候选邻帧，初次创建及新页导航有正常加载过程，稳定页未见反复工具文字或黑空；关闭片另行过程复核。旧后台片另实证缩小窗口67.691667秒有一帧Native先移盖旧聊天布局，放大67.883333秒有一帧Root整窗旧尺寸／灰区；两者不能被几何断言或最终截图覆盖，呈现同步继续修复并实机复验。

真实HTTPS普通构建的零历史会话E首问已在7次Luna／Responses／low调用中完成首页输入、城市跳转、预报读取、释放及正常final，全部Tool与原子操作成功、零checker／Question，页面保留。后继5次调用在原页接入后缩放两次、切到A会话后台读取并完成；返回E后同pageId／incarnation／WebContents／navigation3重新可见。该actor过早把选择完成当作Native显示完成，原脚本的返回可见性失败保留，后续实际状态与OS图确认原页仍在。普通停止按钮另使原Run cancelled并释放同页，下一新Run6次调用重新绑定读取成功。首问录像被提前SIGINT而未保存，只有功能与OS截图资格；后台及停止／继续两段120秒录像正常结束，须结合过程帧判断视觉，不将这些限制写成全流程通过。

上述实机继续抓到明确Tab X只移除UI、隐藏Main页而未关闭，模型仍能读取的真实缺口。Main显式close此前仍受retained分支拦截，当前真正解除注册并销毁准确页；普通卸载／切换／隐藏仍get-only与保页，Agent的page.close释放控制语义不变。旧restoreClosed隐藏墓标已移除。准确X后旧租约拒绝、下一Run existing-only缺页、迟到state／present／restore与重复close零替代均由直接回归验证；Main／grant IPC／SessionTabs／统一flow四文件79项1209断言及Desktop类型／Biome通过。统一flow原缺正式scope导致physical0、旧scope-switch close断言的失败保留；夹具对齐当前scope与只隐藏合同，仍保三次物理输入及跨Run／unknown因果断言。修后真实X及下一轮说明仍待新制品，不能以旧模型读完当关闭成功。原新ledger142次、零活Run／unknown、Main正常退出0，原Home／Store／账本和影片均保留于本机重验目录。

全局computer-use指导现明确区分新任务打开指定URL与继续原页：前者用原open路径，后者用本轮候选／snapshot，不反复轮询空列表，也不把旧代码环境的确认清理当作新任务取消。旧B会话真实出现空候选后续26次重复查询；原新用户消息已在保存Model正文中核实，指导含糊是待实机验证的解释，不宣称单凭文字改动证明因果。原关闭页不替代、未知不重放及准确绑定门禁不变，不增Tool或协议版本。全局Skill与Service正式按需加载两文件5项136断言、Agent类型及相关Biome通过；Service旧等待人工断言已按用户确认的正常final／新消息合同对齐，未恢复旧等待能力。最后真实新网址→返回原页的多页路径继续作为必要验收。

引用顺序修后，零历史会话D的首问已完成真实天气网输入和城市跳转，AX483141／548912／629829字节正常，输入没有false stale；Controller55项515断言、实际隔离执行器62项858断言及Agent类型／Biome通过。该轮仍在03:19:51.482开始主frame导航、51.597提交后，于51.609过早读到1492字节的空AX；DOM-ready到51.759才发生。模型因此提前final，稍后实际右侧已完整显示衡阳天气，不能把这一首轮算查询成功。随后新用户消息在同一pageId／incarnation／WebContents／navigation3准确绑定原页，598987字节观察读出天气并正常final，没有重放搜索、刷新、替代页或审批；新ledger76次。首次过程和后继读取原记录保留，后继读取未取得完整过程录像，不将其当视觉全流程资格。

[文档就绪闩锁](electron/browser-document-ready.ts)只为已确认Agent的`Page.getFrameTree`和`Accessibility.getFullAXTree`等待本WebContents已经开始的主frame跨文档导航首次DOM-ready。Main以本次开始／提交／文档身份核事件，Host在等待期间保留原lease／navigation的read reservation，完成后重核再进入原派发；导航变化、关闭、撤销、取消或真实主frame失败结束旧等待，不把它转投新文档。关闭在waitIdle前唤醒，单纯隐藏或切会话不终止后台页。setup、in-place和已ready的真实空白页不等待，不取决于AX大小或全站loading，不增加固定睡眠、独立超时、network-idle或业务重试。未就绪与读取期间变化分别保准确Host原因和可读说明，原未知和已完成输入不改写。Host／Native／[就绪反例](test/isolated/browser-document-ready.test.ts)及结果说明四文件101项1023断言通过，Agent／Desktop类型、相关Biome通过；修后首问真实资格仍待最新制品。

响应限额修后同一普通配置的新会话G继续直接访问天气网，483161、548214、548046、548214字节原始AX读取均通过，未再出现通用连接错误。该轮另复现语义引用裁剪缺口：完整快照的顶部搜索框e65仍在，但refs按字典序截取200项，正文ref标记从191增长至214后，e65被挤出；输入前同样的裁剪使仍存在的框被判陈旧，后继Model再观察仍无法获得它。原Loop确实继续并正常final、页面保留且无审批，天气查询仍未完成，不计功能通过；新ledger为62次，原证据保留于同目录`https-reference-gap-artifacts`。

2026-10-30按用户要求在新会话首条消息直接访问真实HTTPS中国天气网，没有预开网页或READY轮。原生`Accessibility.getFullAXTree`先返回483153字节，下一次返回548721字节均成功；后者被私有HTTP成功响应的512KiB限额丢弃，限额错误又在Main的可信失败边界外被压成无proof的`browser_page_request_failed`。实际网页仍在，模型却说明连接中断并结束，故这轮不算天气查询通过。失败录像、字节诊断、原生Store与正常退出证据保留在本机`.cache/browser-recheck-20261030/ordinary-build/observations/https-size-failure-artifacts`；新ledger为50次，不能以最终Run completed或网页存活覆盖失败。

针对该失败，Main把完整成功信封的序列化和UTF-8字节限额核对纳入原派发边界；仅`Accessibility.getFullAXTree`允许2MiB原始树，其他方法仍512KiB、截图仍6MiB。超限沿Host自产`browser_page_response_limit`保留准确op／lease／method与原read_failed或effect_unknown，不在HTTP外层丢掉来源；Channel直接发送同一已核实信封，Service独立流式检查相同限额并取消超限body。此限额不扩大最终语义快照、模型输出或可用CDP方法，不增加重试、页面替代或工具／协议版本。修后真实HTTPS验收继续进行，尚不能由实现或受控测试宣称首轮查询通过。

本次限额修复的Host、真实HTTP transport及结果说明三文件72项557断言通过；Agent／Service／Desktop类型、Agent构建、相关Biome、文档、影响、计划证据、统一边界、API及diff检查通过。受控反例覆盖完整UTF-8信封恰好2MiB及加一字节、其他方法与截图原限额、伪造proof拒绝、原lease后继读取、恶意超限流取消且零重试，以及先前未知不被改成已知失败。这些证据不代替下述修后真实客户端过程。

修后普通构建的连续流程已核填写、人工修改、切会话、缩放、Root重载及后继读取，原网页重新可见；注入一次已知读取失败后正常final，下一Run实际重新绑定并读到原人工输入。新ledger到38次时又确认多页候选缺口：A、B两个Main页及原A文档都在，但Controller只保每Session最后释放页，模型在请求A时只见B并结束说明无法读取。该轮正常退出且无unknown；新修复按有界已知共享页集合保存元数据，Service按当前目标URL核准确原身份。Controller／execute／内置指导及Service五文件合计8个文件215项2603断言通过，Agent／Service类型、Agent构建及相关Biome通过，仍须修后实机完成A→B→A及同URL／关闭负例。旧失败不能被模型回复completed或Main页存活单独覆盖。

同一录像还在8.658333秒捕到单帧“保留页面尚未核实”及黑正文：原生restore使用严格selectedScope，已验证同epoch页面在Core后台刷新期间却由UI和展示保留只读grantScope，导致短暂scope拒绝被放大为恢复错误与高度变化。当前将restore同展示对齐到原function级grantScope选择，并保完整四元组校验；真实失联、权限终态失败与错scope继续拒绝并保真实恢复提示。Main／完整Root／capture独立三文件49项747断言先红后绿，Desktop类型及Biome通过，修后实际瞬闪资格仍待新录像。两次resize首帧是整个Root旧viewport被新窗口裁切／回宽留灰，下一帧整窗重绘恢复，不是同一恢复错误；该OS合成单帧限制仍保留，不宣称逐帧原子绘制。

2026-10-30重新生成两份已授权的隔离配置后，新ledger累计11次gpt-6-luna／Responses／low：普通构建首轮填写与后继读取均正常final，零审核／Question，原pageId、incarnation、WebContents、documentId、表单与零点击保持。实际窗口录像另确认Root界面重载后重新展开时，工具栏恢复而网页正文持续黑到录像末帧；模型能读原页不等于网页已显示。原因是Renderer文档重建后局部presentationRevision归零，而Main仍用旧文档较大revision比较。当前已将revision限定在既有Caller generation内；Root导航／崩溃清除旧展示anchor、scope与冻结帧，正向请求核完整现有scope，cleanup携原scope，旧generation的迟到显示／隐藏均拒绝。页面与原文档不重建、不刷新；该阶段未新增协议字段或工具版本。修后仍须同两配置真实重载与连续画面复验；原失败录像保留在本机`.cache/browser-recheck-20261030`，不能用先前372项回归覆盖这一新失败。

本次跨Root文档显示修复的Main／DOM五文件独立验证75项1032断言通过：capture35／505、grant IPC13／166、control8／51、shared transport14／181、Pane DOM5／129，Desktop类型及定向Biome通过。shared transport原13通过／1失败是假Host拒绝缺正式`not_dispatched/acquire`证明，只补测试响应；丢包及超限unknown断言与Service准入不变。原黑屏现场及11次新ledger保留，普通Main退出0、两个准确Service及两次已观察guardian／browser root身份absent；不据此扩称完整进程树清理。真实修后资格待后续同配置录像核实。

接续实机另确认“页面在但右栏收起”不能仅靠保留页面身份解决：早先Google原页的pageId／incarnation／WebContents及网页document保持，重新attach回到原Session后仍hidden。仅分离稳定tab scope的修复没有通过这轮实机；当时缺Root document标识，不能仅凭模块导出或attach次数判定具体Fast Refresh路径。随后夹具补存Root document navigation／timeOrigin，Main21120的新制品在Root整页更换后恢复准确原天气页及展开意图，状态记录显示原WebContents仍visible。原失败、修后state和连续录像均保留在本机`.cache/browser-recheck-20261030/ordinary-dev/observations`，包括`before-root-reveal-main-20261030-1923`与`final-hmr-updated-state.json`；有限页面存活／重新可见证据不代替全过程视觉或模型语义验收。

同Main随后在普通停止验收前因保存Service源码触发真实Service重载，原Run `6447b216-d9f3-456d-9f8b-687b331cd20e`准确cancelled且无活Run，新Caller generation8恢复原Session／网页。下一条消息出现投递占位但未建立新Run，夹具等待30秒超时，原提交继续保unknown、不重投。Main普通SIGTERM未确认完成；新Service24748记录正常exit0，Main21120最后经核准确出生身份的外部SIGKILL后absent，不能计正常Main退出或完整历史清理通过。原材料含`final-stop-service-reload-interference.json`、MAIN-OBSERVATIONS及UI-TRACE，不以新测试覆盖。当前已修上述Main与父通道的settled reload失败占位，但未找到足以归因该次SIGTERM挂住的关闭阶段证据；最新修复后的开发版与普通构建完整真实资格仍在验收。

2026-10-30按用户的五条集成规则复核时，确认此前同URL的existing-only检查尚不能证明跨Run是原标签；普通scope清理也会在租约释放后真正关闭页面，fresh open不同URL仍可能导航覆盖原普通页。这三项的源码修复与受控回归现已完成：页面由Main独立持有，跨Run按可信pageId／incarnation重新绑定，不同HTTP URL新建页；此前“保页／同页恢复”的通过不覆盖这些缺口，新的完整Native资格仍须修后真实制品取得。任务结束、页面隐藏、标签关闭和后端失联必须分别判断，不能以URL或Job终态代替页面身份及存活证明。

同两段实录逐帧复核：`root-reveal-final-01`在78.342–79.367秒与87.167–88.050秒经历Root整页重载的全窗灰色、短暗空和启动重绑；87.750秒另有单帧L形灰区。原天气WebContents／文档／表单与navigation保持，但不能计整页重载无黑空。`final-hmr-background-01`的109.400–109.525秒菜单连续resize出现灰区、Native暗空、旧窄viewport和右暗带，109.575秒才稳定。真实OS菜单关闭callback早于首Root新layout，不能仅据这些画面归因菜单代码。当前另修确定的异步popup合同：cancel只撤行动资格并请求关闭，保持准确pending到Electron callback，拒关闭在途的重开及迟到点击；53项712断言、Desktop类型与Biome通过，尚不代证原合成异常消失。Native新viewport目前仍需实机验证首帧条件，Root双绘制本身不证明Native已完成新尺寸绘制。

截图所示首次导航unknown另按实际原Session只读核查：旧持久结果缺底层cause，不能追认重定向或timeout。Main release现在仅在原Page存活、同不可变binding／navigation且确已human／lease-null时附准确leaseId、pageId、incarnation、实际URL／有界标题。Service确认原通道、daemon及dispose后才能交给Controller，下一Run须核原owner终态，existing-only重绑原页并取得新snapshot；此前不允许其它URL、输入、导航、截图或旧坐标。原Tool／Job unknown与真实cleanupunknown不改写，完整合同归[Browser owner](../../packages/agent/src/tools/browser/README.md)与[Service owner](../service/README.md)。

最新开发Main37142／Session`2f73d1ec-a5ce-4cc7-bddf-3d6e99a8c17e`完整七Run实证保留在本机`.cache/browser-recheck-20261030`本轮材料中，模型仍为Luna／Responses／low、零Interaction。首问`aeeb3e7f`在天气站按Enter进入404，后自动回首页，final仍说当前404而过时，查询失败；第二轮`d5aad559`有stale／mismatch／released错误但Loop继续并成功选择衡阳结果，旧首页另页保留，不能称全部Tool成功。正确结果Tab X后，`dafbbeb3`新Google页已打开，Page.navigate成功、后继Runtime.evaluate失败；一次ACK丢失夹具始终未消耗，故该startupunknown为自然失败。新消息`51fa1513`在同WebContents5／incarnation／document、导航2→2下成功读16°C／22°C／4°C并释放，旧unknown保持。`ba9f66a3`普通Stop取消并保原文档；`6e12cf28`执行中真实Tab X后可读missing失败进入下一Model并正常final，闭页点击未完整录到，语义证据不扩成完整视觉资格。下一明确网址任务`3fa9cdaa`创建WebContents6及新incarnation，但又遇startupunknown，重开后读取未通过。当前新账本实际`[213,148]`共361，不与不可用旧309相加；本轮66次模型逐Run为7／19／6／9／5／14／6。Main／dev父链普通exit0、准确Main和已登记Service37162／worker37211均absent，不据此补造全部辅助进程或旧unknown的清理证明。

`startup-unknown-observe-02`自然片段中，Google页始终可见，8.492秒首轮说明unknown，41.467秒新消息，64秒前后切为16°C，70.400秒final与页面相符；未见旧Native覆盖聊天。94秒后的隐藏新viewport实验故意改变原页bounds：427×743时只收到594×1486物理像素旧帧，不能证明hidden已绘新尺寸。实验恢复时主动Root reload，95.675–97.067秒灰／暗空、Root和原页先后恢复，不能归为自然Fast Refresh。首问录像只覆盖第二轮到达结果页，末帧仍在回复，最终释放另由原事实核实。完整Root整页重载和菜单／连续resize的旧视觉失败继续保留。

根据实际后继Runtime.evaluate失败窗口的审查，另修两处有代码反例的前置竞态：同文档导航保留固定USER注释隐藏CSS，仍使navigation／refs／坐标失效；Runtime.evaluate／callFunctionOn等待CSS前后完整复核原tab、contents、owner window、attachment、phase、Session、incarnation、browserId与navigation。准确一次性内部typed proof只证明这条后继CDP未发送，原生CDP拒绝、伪造／错页／错方法／复用proof仍不获not_dispatched。同startup先前Page.navigate的效果不会被降级。Native grant IPC／Host／style三文件86项710断言、Desktop类型及Biome通过；未取得12:08底层原错误，不能仅凭修复认定该次一定是CSS stale。此修复需后续最新制品实机，不能挪用Main37142原结果。

其后普通构建Main45093的新会话`03a703fc-c09d-4915-841e-2f57207c6be6`仍自然复现首问unknown：`bf580d42`六次模型、Google页已显示，准确后继Runtime前置失败为`browser_page_read_stale`且not_dispatched，先前导航保持unknown。`bbff70bf`九次模型在同原页恢复读取并释放，但把已显示15°C误当15°F换算，任务回答失败，不能只按Tool成功授予查询资格。主动hidden capture实验仍只返回旧594×1486帧；恢复Root后`238ad864`38次Model／37次browser.execute全部工具成功，却32次等价snapshot、1次click、零正式截图／close，未核实完成。实际新工具结果一直进入后续输入，变量与同page句柄正常，不是VM跨Run丢失；用户要求停止反复测试后已立即用普通Stop取消，再正常Main exit0，准确Main／已登记Service45098与worker45170均absent。新账本`[266,148]`共414，本轮普通构建53次；原309与旧失败／unknown不改写。完整过程材料在本轮ordinary-build原observations中。

按用户最新要求，暂停新增实机／模型，转为有限Main-owned driver修复：私有pageState同步读原WebContents原生URL／title；navigate只派发一次Page.navigate，并由[独立导航生命周期](electron/browser-navigation.ts)等本次主框架新文档DOM-ready、redirect或同文档完成。原documentReady观察门禁保持严格，成功前后仍核准确原页、window、attachment、lease与navigation；取消后排空原raw确认，迟到成功不能复活。Main六字段回执经Service闭合核验，导航／metadata不再依赖Rust后继Runtime/CSS读取，Rust现有snapshot／AX／元素能力保留。没有增加Loop、依赖或工具／协议版本，也没有采用两个表达式的临时例外。

Main navigation／Host／grant IPC／documentReady／style五文件141项918断言、Desktop类型与定向Biome通过；[Service接线](../service/README.md#受管-browser-默认装配)另有真实Main HTTP Host合同回归。上述离线时点尚未启动包含这一新driver的实机制品，后继有限实证如下。新Skill指导把等价语义观察没有新增证据时转为一次合适的独立观察，仍不足则说明限制并close正常final；不加全局次数取消，不从AX文本补造结构化控件状态。Root／Native跨surface缩放问题继续保留，两次hidden方向已被原证据排除，不再以同样实验或天气循环推进；公开Codex资料没有证明其内部Electron容器实现。

Main-owned driver的开发Main71309／新Session`c7fa13c2-07a3-4527-b950-236873b0e972`限定四Run：首次普通UI HTTPS任务`85abb345`五次模型，Main单次导航／准确回执后读55°F，final与实际画面一致且释放；真实Tab X销毁WebContents2后，`87c2db8a`三次模型重新打开，取得不同pageId／incarnation／WebContents4，读“晴朗、55°F”并释放。两次各只有一次实际Page.navigate，不靠重放或预开页，零Interaction。此为开发版该HTTPS首问及关闭后明确重开的语义通过，不扩成普通构建或所有客户端资格；两Run原结果及完整120秒`focused-main-owned-first-close`实录保留。

第三Run`577a96ab`六次模型准确重新绑定第二页、snapshot、scroll500及close均成功。保存Pane模块实际改变Root timeOrigin，属于源更新触发的Root整页reload，不能记为纯Fast Refresh；原网页WebContents4／incarnation／navigation4／document保持，执行继续。随后idle显式Root reload前后原网页timeOrigin`1793367436365.6`与scrollY500一致。`focused-main-owned-hmr-root`全部6828帧解码、212张导出及全部contact复核，15.016667秒全窗灰、15.416667秒暗空，15.783333秒聊天恢复但Native窄黑槽，15.958333秒原页恢复；81.133333–82.233333秒再次灰／暗空、半窗拼接后恢复同一新闻阅读位置。原搜索框仍为北京天气，没有原页刷新或Native覆盖聊天；整页reload仍未通过无黑空／槽宽恢复的过程资格。

第四Run`13028999`六次模型误选第一张已X销毁页的历史候选，准确existing_missing后final称当前页不可用，实际第二页仍在。正确候选在第三Run后标题变空：shared同页初始化只返回URL，丢了Main同一state中的title，on-demand snapshot不补标题，释放时空值覆盖原描述；这不是HMR销毁页面的证据。当前Service内部URL结果改为同一已核Main receipt的url／title pair，Controller无新读、无旧标题兜底；缺页反馈另明确只失效该候选，可重新列一次并准确观察仍匹配任务的其它原页，不放宽歧义或unknown。真实worker三Run反例核缺失A后同Run仍可snapshot原B，零新增导航／输入重放。纯组件HMR夹具未观察到本Run进入agent，按准入拒绝源修改，未取得这轮纯HMR新资格；不为该失败再发等价任务。

此Main普通exit0、dev父链exit0，准确Main与已登记Service71326／worker71398均absent；Pane临时注释按原字节hash恢复，Controls文件未改。累计新账本`[266,168]`共434（本轮20），历史失败／unknown和原309不重写。单次人工wheel夹具在页首未移动且超时，未重发；非零阅读位置来自第三Run实际scroll。普通构建虽已离线生成同driver，但尚未启动且不含随后title／missing反馈修复，不能冒称普通构建通过。

继续定位源更新为何整页重载，实际安装plugin-react的refresh runtime明确拒绝Pane的`closeNativeBrowserTab`普通函数导出；该模块同时导出组件与三个会在重评时换身份的普通函数，失效沿Root传播。现将这三条实现原样移至[会话适配](src/native-browser-session.tsx)，[Pane](src/native-browser-pane.tsx)只导出React组件；原Main页面身份、调用scope、恢复核验及document-owned单调revision保持。离线[真实refresh runtime反例](test/isolated/native-browser-refresh.test.ts)先在旧模块失败，再在组件边界接受且实际enqueue刷新；三个普通导出混回任一项仍拒绝。这是避免常规Pane保存触发Root reload的有限修复，不宣称非组件依赖变化、显式Root整页reload或OS resize灰区已消除，实际新制品资格继续分别核实。

该边界修后的首次开发启动因私有夹具仍要求种子Session在侧栏可见而超时；真实近期Session把它们挤到“展开更多”后，Root已就绪且未发任务。Main82245当前absent，原退出码未捕获，不追认为正常退出；七个登记子PID当前均absent不补历史birth。夹具改为等待原工作区与普通新对话入口，首次创建仍另核准确Store／workspace／新Session／Run；私有回归11项162断言通过，账本434不变。原零模型失败归`before-readiness-fixture-20261030-focused`，没有改产品或重置Profile／账本。

开发Main83947／Session`e67e6225-607d-4a1a-8487-60a67bad50f7`的新制品在已加载原Google页的agent阶段单次保存Pane，Root timeOrigin`1793369453141.5`保持，Caller generation1／viewSelection2保持，presentationRevision3→4；原WebContents2／incarnation／navigation5及网页timeOrigin`1793369582383.6`保持。首Run`860c9f1c`五次模型读取54°F，后继新Run`53a0c672`四次模型重新snapshot同页读晴朗54°F，所有实际Tool结果succeeded、零Interaction，均释放为human；不刷新、替代页或重发导航。原材料为`component-hmr-live.json`与`component-hmr-terminal.json`。

该轮90秒录像5099帧、137张自动导出及尾部49连续原帧已全部复核；Source保存临近自然片尾，首Run final及新Run2在片尾之后，二者不能取得该片的完整过程视觉资格。PTS89.400–89.450秒的四帧Native正文暗空，89.466667秒恢复后连续31帧至真末帧89.991667秒保持54°F／北京天气，无整窗灰黑、槽宽变化、旧图闪回或覆盖聊天。HMR、准确release及新presentation交接同处短窗口，但无可信视频UTC锚，不按录制文件创建Date伪对齐到毫秒，也不能只据此定单一cleanup原因。此短暗空仍未修好；Root未再整页reload与语义成功不覆盖它。Main及dev父链正常exit0，准确Main和登记Service83966／worker84038均absent，临时注释原字节已恢复。

同一最新代码的普通Main86551／新Session`0cd832b6-3cb5-4fc2-b984-d16c3318e055`限定两Run：`40b8f500`五次模型首次HTTPS读54°F并释放，真实X销毁WebContents2／旧pageId及incarnation；`baecb697`三次模型新任务重开取得WebContents4／不同pageId及incarnation，读晴朗54°F并释放。两次各只有一次实际Page.navigate，所有实际Tool结果succeeded、零Interaction，持久配置逐次核为Luna／Responses／low；普通Main正常exit0、登记Service86556／worker86581准确absent。普通120秒完整录制自然结束0，过程视觉资格单独按原图复核，不以Run completed代替；原始材料在`ordinary-focused-close.json`、`ordinary-focused-evidence.json`及`ordinary-focused-first-close-review`。两份制品的所有非文档源码及产物hash核零漂移。最新独立账本`[274,177]`共451（最新两制品17次），没有并入不可用旧309，也没有覆盖旧失败和unknown。整体主线仍因已确认HMR短暗空、显式Root reload及连续resize绘制问题保持未完成。

普通片6838实际帧、195导出中的全部11timeline／7candidate contact及16张边界／尾原图已直接复核：19.9417秒首轮54°F完整回复与原页仍在，19.9667秒真实X撤页后聊天扩宽；21.0083秒新消息在原回复之后，25.2583秒重新展开，27秒新深色页读54°F，38.0083秒第二完整回复与保页保持至真末帧120.0083秒。两次初次加载均有带网址／加载指示的短黑正文，未见已加载页突然丢失、白底旧页在新深色页闪回、错位覆盖聊天或重复消息。此为已导出全画布与候选邻帧的过程复核，并非逐帧肉眼检查全部源帧或证明任意短闪绝对不存在；页面销毁／新建身份和实际释放仍以上述Main与耐久结果为据。

四帧暗空继续取得两个独立离线红例：实际React Refresh保留原DOM节点时，Pane effect仍无条件发null；Main对已完成step2的完全同几何新revision也无条件hide。现仅在原节点仍连接原document、完整id／host／scope／visible／external／blocked及实际正向量测／遮挡均不变时，重复effect清理保留Live Native；旧observer／订阅仍全部释放，真实卸载、隐藏、scope改变、量测未知或清理／新setup异常均hide。Main仅对准确active/live/visible原页、无pending、已完成step2且完整scope、真实Root尺寸／zoom、bounds/layout及Native实际bounds全同的交接保持Live，仍完成两次新的Root witness；旧ACK／cleanup拒绝、sizeEpoch失效及输入资格保持，未恢复旧PNG。Root订阅／帧读取失败也明确hide。Pane／capture／unified／restore／refresh五文件73项1211断言、Desktop类型与Biome通过；这组新呈现补丁尚需对应可见Native下的真实witness与画面核验，不能把旧四帧暗空改记为通过，也不覆盖完整Root reload／连续resize。

对应局部核验只使用开发Main8037的一条自然语言任务打开真实`https://example.com/`，未重跑天气：Run`9bcf94fc-da03-4645-be54-8e1a73afe644`五次Luna／Responses／low、零Interaction／全部Tool成功并正常释放后，在同一准确原页idle单次保存Pane。Root timeOrigin`1793373276599.5`和原WebContents2／incarnation／navigation2／网页timeOrigin`1793373350284.8`保持，revision4的两次真实witness均收到ACK，证明可见Native下仍交付新Root证明。没有导航／重开原页，也没有把旧PNG当Live。90秒影片5102帧完整解码，128张导出全部8timeline／4candidate contact核完；另完整核PTS21–27.991667秒398连续原帧，交接前后未见正文暗空、灰黑、错位、旧图闪回或聊天覆盖。真正末帧5101／89.991667秒也已单独核仍保持原页与回复。SourceChanged Date与录制创建时间仅作宽范围定位，不冒称精确视频UTC锚。

这只授予最新补丁下该idle同槽单次HMR的局部可见Native／新witness／呈现资格；先前Google agent／release重叠的四帧失败仍保历史，未在最后补丁后重测该重叠场景。普通Main86551的首次HTTPS／真实X后新身份重开通过发生在本次同槽呈现补丁之前；导航／状态／lease／语义路径未再修改，可复用原对应功能证据，不升级为最终普通客户端的全呈现资格。Main8037及dev父链正常exit0、准确Main和登记Service8054均absent；临时注释在确认Main退出后按原hash恢复。最新独立账本`[274,182]`共456（本次仅5次），原失败／unknown及完整Root reload／连续resize的必要资格继续保留，整条主线不能判完成。

2026-10-31最后补验先以开发Main32024的新Session`262f3511-879e-4829-9f45-724980b8ca20`做一次自然HTTPS example.com任务，在原页已加载且Agent控制时单次保存Pane；Root timeOrigin`1793377007931.8`与原WebContents2／incarnation`67c530e1-57bd-4fd2-94b3-fa18acf4cc30`／navigation2／网页timeOrigin`1793377078897.5`保持，revision4两次真实witness完成。首Run`3596d277`五次模型正常释放；后继`9891da4b`七次模型在同页新观察后正常回复，其中一次`page.title is not a function`真实工具错误进入下一模型，随后修正读取成功，不能记全部Tool成功。两Run零Interaction、配置逐次核Luna／Responses／low。此后显式Root reload第一次只读status准确拒旧generation，私有operator过早停止后续阶段，第三条新消息未派发；正常退出前的新Root已恢复同Session及原页可见，不将未执行读取补成通过。完整120秒实录及原始结果保留于`final-active-hmr-root`／`final-runtime-evidence.json`，画面资格由其逐帧复核独立判定。

同最终呈现补丁的普通Main33979／新Session`93553de6-488c-4c5f-87c3-dc73676bd5fd`首条自然HTTPS请求`b6e135b0`五次模型正确读example.com正文并正常释放，全部Tool成功、零Interaction。普通菜单真实打开，但私有operator在异步popup建立前立即检查，误判未打开并停止，未进行原定连续resize／Root reload／后继Run；原120秒影片保留该实际菜单与原页，不能以此扩大资格。两次另起continuation均晚于各自自动finish，未派发任何新Run：前者native_sender_denied、后者socket ENOENT准确归已退出竞态，不倒推为产品恢复失败。两Main／dev父链正常exit0，准确Main及已登记Service／worker均absent；Pane临时注释退出后恢复原hash。新增模型仅17次，新独立账本`[279,194]`共473；旧unknown、失败和未执行范围保持，继续按源码缺口推进，不重发等价天气任务。

`final-active-hmr-root`离线复核已完成：6819实际帧／197导出未截断，10张timeline、7张candidate、HMR宽窗口10–22.991667秒741连续原帧及Root reload宽窗口52–55.991667秒229连续原帧均已直接核查，true end6818／119.975秒另核。HMR期间原正文、Agent边框释放及回复位置稳定，未见已加载正文暗空／灰黑／错位／旧图回跳或覆盖聊天；此为本次active单保存的局部通过。显式Root reload仍失败：3056–3089／53.566667–54.150秒全灰，3090–3095／54.166667–54.250秒全暗；3106／54.450秒聊天先全宽loading，3111／54.541667秒两轮恢复但右槽暗空并重排，3124／54.766667秒原网页才恢复，约1.2秒中断。最终稳定页与新Root身份不覆盖该过程失败。此处没有将全部6819帧表述为逐帧肉眼检查，也没有第三Run读取证据。

普通Main33979完整120秒影片已离线核6814帧、161导出全部11timeline／4candidate及24个精确边界帧。18.466667→18.483333→18.55秒的Agent／交还中／human过渡中正文持续；22.025秒菜单确实打开，至真末帧6813／120秒仍保原正文与回复。但1244／21.85秒在回复完成布局切换处出现一帧旧／新纵向位置混合的文字分片，1243及1245分别为完整旧／新布局；发生在菜单前，尚不能从录片区分客户端合成与采集原因，不授全过程无异常资格。旧制品、原字节raw与结果已归档至两Profile各自的`before-root-live-retention-20261031`；review目录保留原位。

整页Root重载的有限候选现由[首绘制引导](https://github.com/ferqx/kite-code/blob/86cb578eb4a1d1f5e2d373a00c513dfaa31cc35c/apps/desktop/electron/browser-display-bootstrap.ts)、Main和Pane共同处理：Main仅保留原准确Live页、已完成step2、无pending且窗口尺寸／zoom／原槽实际bounds不变的只读display intent；清旧展示／坐标资格并强制原生输入屏障，不携lease、refs或操作许可。preload同步核实后先隐藏真实Root树的呈现与输入而保整窗量测，在原左区域显示实际重载状态；原网页继续使用真实Native表面。新Root恢复准确原页与新Caller scope后，只在实际槽完全匹配时同步claim并揭示，再完成两次新的真实witness；沿用现有右栏展开动画的明确DOM状态等待，不加重试定时器。错误、卸载、目标销毁、大小／zoom／选择变化或屏障失败先确认Main撤页再揭示Root，准确已终止token可确认取消；丢取消确认不假造安全显示。没有恢复旧PNG、刷新网页、重开标签或重放动作。

该增量的Pane／capture／bootstrap／unified／restore／refresh／built-preload-IPC共7文件84项1363断言、Desktop类型与相关Biome通过。只为恢复后实际槽相同的Root重载提供保留条件；手调右栏宽度没有同步seed，恢复几何不同仍严格撤页并走新呈现，不授任意宽度保持或连续resize资格。旧host没有新bootstrap方法时保持原行为。上述离线证明尚不代替下述最新制品的实机过程。

最新Root保留候选实际开发制品Main55864已构建并启动，尚未发模型任务即在普通新对话准备时因真实焦点未确认退出。OS只读IOConsoleUsers明确`CGSSessionScreenIsLocked=Yes`，锁屏时间1793380812，属于系统约束；不反复点击、不解锁、不重投，源码不据此改成测试适配。Main／dev父链正常exit0，准确Main及已登记Service55896／worker55909均absent，页面清单为空。零新Run／零新增模型，独立账本仍`[279,194]`共473。`final-retained-root-service-20261031`operator未到起录、active Root reload或父通道Service restart，不能把已准备的步骤写成实证；当前新源码的Root保留、重启后新Run、普通最新制品及连续resize资格继续待桌面解锁。全局仅用户自己的开发Main17972，本轮未操作其Profile或网页。


桌面解锁后的开发Main67405／Session`671d4361-c197-488e-81e4-7193b6225ba9`／Run`920eb64b`实际首次HTTPS读到Example Domain正文并正常final；新增5次Luna／Responses／low，零Interaction，独立账本`[279,199]`共478。active Root整页reload时原WebContents2／pageId／incarnation／网页timeOrigin`1793382662535.7`仍在，但新Root generation3没有完成新step2，Root直到120秒片尾仍灰空，不能计恢复通过。录像6836帧、177导出及458连续原帧直接复核：10.258333秒起Root内容消失，10.850000秒出现重载状态，11.358333秒状态消失后Root一直灰；原Native正文未见同类消失。operator据此停止，未发Service restart或第二Run；Main／dev父链正常exit0，准确Main及登记Service67422均absent。原片与失败保留在`final-unlocked-root-service-20261031`材料中。

此失败已定位到固定Electron44.3.0的`webFrame.removeInsertedCSS`只从Blink author列表移除样式；原preload使用user origin，API返回后Root仍被透明遮罩隐藏。原生零模型探针`css-origin-native-v2-20261031`在同版本Chrome152.0.7977.78实测：baseline opacity1→author插入0→移除1；user插入0→移除仍0，下一任务仍0。首个私有探针生成脚本语法错误、没有运行CSS检查，失败另保留，不能计为该实证。当前preload改用author origin；引导在清intent／aria／状态前核实际Root opacity及pointer-events，若移除无效则取消Main handoff并保留pending错误。受影响22项416断言、Desktop类型／Biome通过，含构建后preload按固定origin行为的先红后绿及移除无效反例；其余未变证据复用。这个修复尚需最新制品实际重载闭环，不能用原生CSS探针替代UI过程资格。


修后开发Main73245的Run`94a8874d`新增5次模型，首问读取／正常final／释放及active Root重载的新generation3 step2已确认，原网页timeOrigin`1793383483897.4`保持。原认证父通道随后实际替换Service并ACK成功，新Root generation6也完成step2，原页保持human；operator在ACK与attach之间过早用未绑定Caller的generation0读state，按请求合同返回invalid_native_request后停止，未发第二Run。此为私有夹具代际错误，不能写成重启未执行或产品永久失联；后续只在明确Root重载窗口等待正式root-ready，不把任意业务invalid改成可重试。Main／dev父链exit0，准确Main及登记旧／新Service73262／73589均absent。账本此时`[279,204]`共483。

该片6775帧、187导出、全部94张sheet与24张原图已直接复核，重点12.008333–28秒908连续原帧：active Root在13.733333–14.841667秒、Service Root在22.908333–24.016667秒分别有约1.108秒可见左／上灰底加载过渡，前者含短黑底加载文案；右Native正文持续可见并直接恢复工具栏和原布局。release及首Runfinal未见正文暗空／位移／重复回复，真末帧120.008333秒稳定。这授予原Native连续保留及Root合理恢复的有限过程证据，不称整个UI全程不变，也不补第二Run资格。原始片已归`after-author-root-observations-20261031`，制品／标记归`after-author-root-markers-20261031`，review目录保持原位。

普通修后Main75447／Session`37848f8e-9289-4ec0-898d-0da2178e8801`的首Run`d79439aa`5次模型及重载后新Run`11be0952`4次模型，均Luna／Responses／low、实际Tool全部succeeded、零Interaction／审核。第二Run绑定同pageId／incarnation／WebContents2的新lease并实际取新AX，零再次导航，准确读中文首段并释放；两Run的code_session／browser.session均以cancelled及cleanup confirmed正常收口，不误记Job全success。首Run实际把第二个英文段落称作正文第一句，故严格首句任务未完全通过，Tool成功不能覆盖内容错误。一次异步菜单打开、26步连续resize、idle Root reload及新消息均执行，完整视觉结论仍按独立审片归位。新账本`[288,204]`共492，Main与登记Service75452正常exit0／absent。

本普通片末段一次新的固定API路径检查也否定hidden-but-painting方向：setBackgroundThrottling(false)后，实际目标bounds427×748／DPR2，两个hidden完整frame及stayHidden capture仍只有旧594×1496（297×748）像素，没有854×1496新viewport。准确原bounds／backgroundThrottling恢复后Root重载重新订阅；该实验不授UI资格。前两次默认hidden与此次不同，三个否定结果均保留，不继续等价实验。

剩余Service新Run检查在开发Main77212自然首问Run`86aca519`成功后，仅一次原父通道替换旧Service77232→77515，原WebContents2／pageId／incarnation／网页timeOrigin`1793383971033.2`保持，Root generation4及step2正常恢复。随后一次真实新消息已持久接纳run.start command`897520f5-72de-4d9f-a2d3-821fef58b7a9`（accepted），但未应用、未建立新Run，UI保投递占位，operator超时不重发。此是需要修的接续缺口，不能按Root恢复授后继读取通过，也不能把未知请求当未投递。Main／dev父链exit0，准确Main与登记两Service均absent；新增仅首Run5次模型，当前独立账本`[288,209]`共497。该失败和原accepted命令保持，接续定位不重写冷记录或重播消息。


用户最新明确热更新不必过度展开：主要是自动化期间修改源码触发开发热更新，后续须冻结代码后再做固定制品业务验证。因此停止扩大HMR／强制Service重启测试，不把额外开发恢复架构作为闭页读取交付前置；已证失败与真实恢复边界继续保留。Main77212的新命令阻断已定位到旧builtin.session-title/generate的terminal outcome_unknown缺少verified-reconcile proof，owner-dispatch门禁拒绝取得执行权，而reconcileSession未扫描该terminal unknown，故accepted但未应用。它不是页面连接丢失。原unknown、accepted及安全门禁不清除，也不重发；该强制reload实证中的标题unknown门禁限制与同进程冻结制品业务分开记录；准确诱因及跨进程适用范围见后续只读核对。

按该收敛要求，最后冻结普通Main80970／Session`61e46191-59c7-4207-81b9-5d295502e731`两Run`b306511c`／`59e25d80`分别5／2次Luna／Responses／low，真实首问读47°F；实际Tab X销毁WebContents2／pageId`browser-9b77cce9…`／incarnation`acbe6b87…`后，一次明确重新打开天气网址的新消息建立WebContents4／新pageId`browser-b2edd7c5…`／incarnation`cfed0936…`，读“局部多云、47°F”，与真实OS画面一致，两轮均释放并保留结果页。首轮7Tool、第二3Tool全部succeeded，两个Run各两生命周期Job均cancelled且cleanup confirmed，零Interaction／审核。每轮只有一次实际Main navigate及新AX；第二轮无显式close Tool，由Run终结宿主确认释放。此轮模型直接按新明确google.com网址重开，旧released URL实际为带sei的google.com.hk，因此没有触发existing_missing，不能写成真实覆盖旧候选missing回退。

该片原始材料`frozen-weather-close-20261031`保留，源码／52私有输入／147制品分别在执行中及自然录制完成、Main正常exit0后核零漂移（源码2620文件）；没有源保存、HMR、Root reload、Service restart或业务动作重放。准确Main及登记Service80975均absent，账本`[295,209]`共504。

冻结天气片的过程视觉现已通过上述有限业务范围：6879实际帧、331个不同导出，全部10张timeline／7张candidate／12张补充sheet及关键原图直接查看，四个关键窗口175连续原帧无遗漏。14.1秒首答47°F完整，14.216667秒Tab／地址栏先撤而原正文仍在原槽一帧，14.233333秒正文撤除后没有旧页重现；新页19.025–19.083333秒为真实新加载暗空，19.183333秒新47°F正文出现，没有旧白页闪回；21.433333秒第二完整回复与实际局部多云47°F一致，21.55秒控制标记撤除。随后采样与真末帧119.991667秒保持回复和结果页，未见已加载正文再黑空、错页、覆盖聊天或消息重复。未宣称逐张目检全6879帧，原resize／Root失败仍不被此片覆盖。review与review-boundaries目录保留，这一闭页读取业务子项完成；用户随后明确保留缩放缺口，本次不继续结构调整。

最后只读标题核对修正上述限制的归因与范围：Main80970普通Session也有同类标题Model failed／Job outcome_unknown，发生在首Run结束前，并非reload或退出才引起。两例标题封存设置均为Luna／Responses／xhigh；隔离model-preload按用户授权只允许low，在原fetch、调用账本及transport日志之前拒绝非low，而主线7Model均为low。短失败窗口与无标题HTTP账本支持授权护栏阻断的判断，但未捕获该次guard字符串堆栈，不写成Provider自然失败。私有护栏未被放宽，未发xhigh请求或补计调用。精确SQL只命中该标题unknown、无reconcile proof；普通Session同进程第二Run借热owner成功，不证明新进程能接续。按当前worker准入与terminal unknown扫描边界，新进程恢复该隔离Session仍会recovery_required；这是源码／SQL推论，未另做重启实机。原unknown及accepted保持，不推广为普通用户环境普遍失败，也不宣称所有Session执行均成功。

正常resize缺口另已闭合源码与过程：proposeLayout的同几何retain不适用于窗口尺寸变化，随后保旧frame并隐藏Native，连续proposal替换pending直到两次Root witness完成；Pane以旧frame宽高绘图。Main75447在resize期间Native实际一直hidden，最终step2后才呈现525宽新槽；原297宽正文／右黑空主要是这条主动冻结策略，不能仅归因Electron未出新帧。来自ResizeObserver的同步量测并不证明Root新帧已呈现，直接提前present会重新打开旧Native先覆盖聊天窗口；pending屏障与sizeEpoch只能保障输入和迟到，不能代证像素顺序。未在最后冻结业务验收期间改动该策略或引入旧图补偿。曾评估Main拥有聊天、工具栏及网页原生分栏和裁剪边界的结构候选，尚无实机资格；用户已明确本次不继续该结构调整，保留缩放缺口。

2026-10-31收尾决定：用户明确选择“先收尾自动化修复，明确保留缩放缺口”。本次交付以已经验证的自动化修复范围收尾，`iteration_complete`为ready；最后普通冻结制品的真实HTTPS首问、Tab X销毁、明确新任务以新身份重开读取、正常释放与保页均有准确冷记录及过程画面证据。收尾仅同步文档，复用未变源码的既有必要验证，不再启动客户端／模型，不继续HMR、强制重启或内嵌分栏结构调整。连续resize的旧宽度画面／灰边／黑空及其原始失败明确保留，隔离标题unknown与跨进程接续限制也不改写；不据此授整个浏览器呈现或正式发布完整资格。模型账本保持504，未stage、commit、push或创建PR。

Service重启验证已换为隔离driver在本进程观察原正式认证父通道，原peer仅一次发送新immutable Service请求并核exact ACK；未知不重发。私有21项214断言及编译通过，不修改Service源来触发用户Main17972的watcher。此路径不授文件保存watcher资格。Native新viewport另找到固定Electron44.3的明确hidden-but-painting API路径，前两次默认hidden／stayHidden实验未启用它；一次新的私有首帧检查已准备、未运行，不能据官方支持或代码准备宣称实际新尺寸绘制成功。

当前产品合同已按用户最新要求收敛：浏览器操控三模式免审核／审批；自动化结束或需用户处理时释放控制并正常final，保留网页，不创建人工交还、等待或Continue。用户下一条新消息在新Run重新绑定同页并获取新快照；首轮读取／脚本失败也必须允许准确收口后的第二轮继续，旧元素、图像和控制引用不可沿用。此前人工交接各轮证据仅保历史事实，不再是当前Native默认交付目标。

当前候选将代码环境和Browser Job分开收口，Controller.prepareRun在VM准入前等待旧Job真实stop／dispose，原unknown不替换。新Run候选没有旧控制权，browser.page工厂无I/O，首次snapshot才经原open重新绑定；Service保存从真实acquire保留的pageId／incarnation及requireExisting，Main精确选择原页再核URL，attach后与Controller启动读取时分别复核，缺页／替换／变址零fallback、零导航。普通fresh仅复用唯一准确URL或唯一未导航／未acquire初始空白页，不同URL新建，同URL多匹配不猜测。UI scope／unmount和Main renderer重载只隐藏网页，restore以同scope多页清单和独立activeId恢复；原Job目标与用户当前选看页分别保存，明确X的活动／unknown页同Job不抢回，真实新任务租约可重新呈现。菜单及同步量测保持原修复，最后真实模型／连续画面仍须按重新生成的两配置新制品验收。

本次新增与受影响的20文件回归372项4268断言通过：Agent／Main身份链147项1582断言、UI／Main生命周期9文件独立执行98项1266断言、Service106项1260断言，以及页面Host21项160断言。Service最终复验已在本机实际随机端口完成；普通受限运行因无法listen导致33项环境失败的原日志保留，不改为产品失败或覆盖。四包类型、相关Biome、边界／API、文档检查通过；Agent构建与资产2项35断言通过。受控Main表单和JSDOM不能代替真实Electron页面；这组回归不含随后实机发现的跨Root文档显示序号问题，当前不声明完整修后客户端资格。

2026-10-30原仓库`.cache`在01:33消失，废纸篓同名目录因OS权限不能读取或恢复；原材料当前不可用，不能再核其完整性。009普通制品在消失前完成构建，开发制品与两客户端均未启动。用户随后明确要求“重新生成”，因此沿已授权的普通／开发各一配置及最多两实例范围重新准备隔离验收，不复制用户Store／会话，也不把新Store当原配置。此前最后已观察模型累计309仅保历史事实，新验收从独立ledger计数；旧STARTED／RESULT、录像及unknown不补造。产品源码、定向回归与`/private/tmp`日志仍在，修后真实资格继续待验。

页面已不存在、已变址或操作中失去连接时，统一工具结果须向下一模型解释发生了什么，保留机器可核的原原因和结果，不只返回错误码。无法确认关闭原因时只说明页面不可用或连接中断；已派发效果不明时明确最后动作可能已经发生，禁止自动重放或创建替代页。切会话／隐藏普通Tab仍不等于关闭后台页面，不能据此谎报页面已销毁。

本候选实现[已确认方案](../../docs/plans/2026-10-28-browser-computer-use.md)的全局内置 `computer-use`、新 Native 单模型入口及持续页面 API。技能由 Agent 的固定内置源提供，Service 无条件合并其目录元数据，不从项目或用户目录安装；加载仍核当前选中工具和宿主能力。Main持有普通页面，浏览器绑定沿原Tool／Run与最终硬准入建立，不发审批或页面Question。旧Question、拒绝、取消及unknown只按准确历史保留。代码Job、原browser.session、Main租约和网页效果各有独立终态，不以模型最终回答代证。

[页面 Host](electron/browser-page-host.ts)在已有私有页通道中提供有限对话框和坐标操作。对话框只返回当前准确 dialogRef/type，不把 prompt 内容作为任意输入入口；具备自动化 Host 的普通页允许 CDP 处理对话框，保留 sandbox／禁 nodeIntegration／safeDialogs。坐标来自同一正式截图的私有 capture proof，核页面、租约、导航、尺寸、DPR、滚动和单次消费；漂移在派发前拒绝，部分派发后不能确认保持 unknown。正式 PNG 的私有响应限额仅提升截图路径，不放大其他通道；模型只见 Artifact 中立图片和不透明 imageRef，不见 CDP 或 Main 身份。实现与限制见 [Browser owner](../../packages/agent/src/tools/browser/README.md)。

固定Electron44.3.0的[dialog helper](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents.cc#L2030-L2061)未实现Chromium的原生UI清理回调，而固定[CDP处理](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/devtools/protocol/page_handler.cc#L1645-L1675)即使这步失败仍返回成功，这解释了005的Accepted与残留窗口并存。当前Main只在准确dialog决策的CDP成功后，复核原WebContents、父窗口、attachment、页面／控制身份、导航及该contents的原生dialog序列，再调用[该固定版本单contents的取消事件](https://github.com/electron/electron/blob/v44.3.0/lib/browser/api/web-contents.ts#L730-L782)中止残留MessageBox；默认已中止回调不会再次决定网页结果。隐藏child view仍属于原BrowserWindow，macOS的[AbortSignal父窗口条件](https://github.com/electron/electron/blob/v44.3.0/docs/api/dialog.md#L331-L335)必须实际匹配。连续新框、导航、控制或owner改变时拒绝清理并保unknown，不能用旧回应关闭新框；普通人工页的dialog handler不替换，网页confirm语义不改。受影响Main／Host两文件55项553断言、Desktop类型与Biome通过，含确认／拒绝、首次未呈现的后台页、九类迟到变化、丢失ACK和零旧mouseup。此为固定Electron内部兼容接缝，不是模型能力或通用公开API，修后原生画面仍须真实重验。

Native 统一路径关闭默认轮询截图和动作后自动截图。控制装饰由真实租约／输入事件驱动；模型需要视觉时才取正式 PNG，语义快照包含可见普通文字和有效元素。用户进入“指向元素”时，通过原 `browser.capture` Action 取一次当前注释帧，冻结选区和草稿后继续编辑；隐藏／换 scope 时迟到帧不能覆盖其他页面。兼容旧独立浏览器仍使用原预览路径。验证入口为[需求捕获 DOM](test/isolated/agent-browser-demand-capture.test.tsx)、[截图](test/isolated/native-browser-capture.test.ts)、[页面 Host](test/isolated/native-browser-page-host.test.ts)与[共享通道](test/isolated/native-browser-shared-transport.test.ts)。

### 历史阶段与准确资格

以下按当时制品保留真实成功、失败与未覆盖范围，旧人工等待／审批和Main旧anchor外推的实现说明不代表当前默认流程。用户后来已明确放开模型次数，并允许011／012两个隔离配置及必要重启；先前各轮数字和许可阶段仍保留原事实，不能从历史待批表述推导当前仍需重复许可。

2026-10-28 本机 macOS／Bun 的真实证据位于 `.cache/browser-unified-luna-low-20261028`，分别保留 BUILD、原 UI 过程、OS 合成、站点独立效果、冷读与 RESULT。用户当时限额为两个隔离 HOME/Profile 实例（desktop:dev、普通构建各一）和合计最多60次 gpt-6-luna／Responses／low。实际 dev 调用4次、普通构建32次，共36次；普通构建为直接本地制品、无 Vite、testDiagnostics:false，不是正式安装资格。没有复制现有 Profile／Cookie，也未改用户默认模型配置。

`attempt-001-dev` 的自然语言发现全局技能，但执行器资产定位未覆盖源码宿主，得到准确 capability_missing／executor_unavailable，零网页与 Browser Job。已修为源码宿主引用固定 built worker；同一开发实例热更新后，夹具缓存旧 generation 无法继续，故不宣称修后开发操作通过。实例最终退出0、登记身份 absent，原夹具错误保持。

`attempt-002-build` 从自然语言实际加载技能和 API 资源，经 browser_execute 到原新页 Question；回答前零页面／Browser Job。允许后同一 Main 页完成 UNIFIED-42 填写与一次服务端业务计数，后续同网址复用保留输入和计数。真实模型取正式 PNG，下一次远端请求确含图像，核实计数1，并完成下拉 High、悬停 HOVER-73。过程中实际 OS 合成观察到 Agent 光标、屏障与控制装饰；没有以最终截图替代中间状态。首次语义快照遗漏普通 Count 文本，模型没有伪称已核实；源码已改为完整语义观察并通过回归，修后实机待验。真实 confirm 因 Main 原 disableDialogs:true 自动 dismissed，模型明确报告未能接受；源码现只在无自动化 Host 时禁用对话框，修后实机仍待验。

同一普通构建的 canvas 尝试在正式图像读取时报原 tool_failed／outcome_unknown，未派发 pointer，站点 canvas 效果为0。已补精确只读截图错误返回，避免一般读错误被包装成网站副作用 unknown；原记录不改写，实际故障原因与修后完整坐标流程尚待实机核实。另一次语义跟进在填／滚前模型失败，后台切换夹具发现原 Run 已结束，因此没有取得后台持续操作资格。后续独立 Session 的真实拒绝没有重复提问、零网页／Job／站点请求；授权等待中实际点击“停止任务”后原 Run、execute、open、code_session 均 cancelled，交互移除且站点零请求／效果。这两条为已通过的拒绝与取消流程。

普通实例正常退出0，14个已登记原生出生身份 absent；原 Browser／代码 Job 已分别保留确定取消或原 unknown，旧三处 unknown 目录身份不变。登记进程消失不扩称完整进程树监督或清除原网站 unknown。当前未取得修后 dev、完整 DOM／弹窗／坐标／人工继续及后台体验资格，完整方案保持进行中。定向隔离回归及类型检查结果沿当前 Browser／Service／AI 各 owner 核对，不由上述局部实机成功推出全部发布可用。


本候选最终定向验证在同一耐久工作树、macOS／Bun1.4.2 执行：Controller／页面API／Main截图／页面Host／execute／host-revocation／human-async-runtime 共7文件135项955断言通过；Agent、Service、Desktop、AI typecheck 通过。Agent manifest 包外真实隔离执行器及现有闭包1项76条 Bun 断言通过；统一边界、workspace、文档结构与影响检查通过。此前沙箱内执行既有实际 Shell 的环境失败与修正前清单断言保留在原日志，普通 OS 复跑取得上述准确范围。没有据此把未完成实机场景或正式发布资格改写成通过。


2026-10-29修正候选：根据用户明确要求，网页任务复用原权限。Service核真实 `browser.open` 的最终派发、原输入与任务身份，Main沿原私有commit验证准确凭证；Full及已通过Auto不再额外发页面Question。仅两个新代码编排定义没有独立外部效果，网页API仍逐项鉴权；Native browser.session只有同原开页证明和当前policy／controls时复用，普通Auto开页受控验证恰好一次checker。旧证明、legacy、额外权限叶或模式变更仍保守。普通手动页移除“交给Agent／等待接管”的预arm入口，实际运行中的暂停接管、明确继续及停止保留；没有将网页文字、模型字段或Renderer声明作为权限。

同日用户原天气轮的只读记录定位到额外5秒等待错误：open在上海00:01:09.111返回starting，Browser Job的自动审核于09.148派发，14.202被取消；Job adapterAttempted:false，未进入实际浏览器启动。统一入口现跟随原Job授权、资源、启动和终态，不另设该5秒期限；资源总容量不足2准确不可用，多个代码环境按 `floor(process/2)` 票据可取消排队，原Core permit独立持有，避免代码Job占满容量后互等Browser Job。底层Tool失败／异常／拒绝／已落定unknown交回下一模型，整轮不因工具结果硬退，明确用户取消及实际存储完整性失败保持。原天气轮在Tool失败后确实又正常派发一次Model，该Model约1.8秒后独立model_failed；当次原请求配对与本地SDK转换可核，具体供应商／传输原因未留存，不能归因网络，也不能称等待修复已证明消除此独立失败。

`attempt-003-dev` 是获准新增的真实desktop:dev／Vite／普通Main实例，10次调用准确gpt-6-luna／Responses／low。首个Model在任何Tool前model_failed、零页面与效果；新明确任务随后加载全局技能和API、统一执行，在原Question允许前零页面／Browser Job，允许后唯一原页完成DEV-FIXED-42、一次业务点击，完整语义读取核两个计数1；真实confirm的dialogRef接受后页面Accepted，OS过程捕到弹窗、控制装饰和屏障，结束后manual且页面保留，dev与Main正常退出0。此证明修后资产定位／完整语义／弹窗路径，仍是额外Question移除及后续Loop／几何修正之前的固定制品，不扩为最新全部流程资格。

`attempt-004-build` 使用无Vite、testDiagnostics:false的普通本地构建，5次同模型／协议／low。完整语义观察成功，正式图片在Main返回capture_metrics_invalid，原image及execute准确failed；模型随后完成明确的失败说明，Run completed，未派发canvas输入，站点画布／业务效果均为0。原页在创建到截图失败时始终hidden／0×0，首次非零present比错误晚约9秒，现新页初始化为hidden960×540，后台执行不再等待Renderer首次展示。真实present后沿当前容器更新，严格finite、DPR、PNG、hash、navigation及capture proof继续保留。旧002的图片unknown不改写为004已知失败。

用户同时观察到resize时Native页越出侧栏。Renderer与所有实际overflow裁剪祖先取交集并监听其尺寸；当前候选由SessionPage真实Panel props共用的尺寸约束及当前量测，给Main提供最多两层、每层两Panel的闭合布局。Main按实际window／zoom投影导航固定像素、右栏相对份额、分隔线及min／max／collapse，并同步shield；迟到的旧窗口量测仍投影到当前尺寸，真实Renderer随后校准。边缘向容器内取整，尺寸变化使旧截图proof失效；失去支持布局／非零投影资格时撤下原页与shield，等下一次真实量测，不保留越界旧宽，也不猜任意栏位比例。早先单纯按旧宽右锚的缺口由下述006录像复现，不能用其旧局部成功覆盖。on-demand注释由当前 `selection.canInvokeExtensions` 派发原read-only capture Action，修复annotationOnly误传false；综合fixture验证有效PNG／JPEG、DPR2像素和Main proof hash闭环。工具栏Agent按钮只依真实Main phase变化，受控测试中多次loading保持同一节点和文字；整体体验仍需修后实机。

同selection刷新还复现了独立展示缺口：NativeCaller保留准确加载身份时，Main原present误用fresh写入scope而拒绝；Renderer又在ACK前锁存bounds，使相同尺寸的后续layout事件被吞掉。现仅展示使用Main既有同selection身份，明确失效的私有provider不fallback，导航／授权仍核fresh scope；Renderer成功ACK后才记住bounds，迟到ACK不能覆盖新尺寸，失败等待真实layout／visibility事件再报，不增加定时重试。[Main IPC回归](test/isolated/native-browser-grant-ipc.test.ts)8项98断言、[Pane回归](test/isolated/native-browser-pane-dom.test.tsx)6项218断言及截图24项175断言通过。该机制能造成零视口或旧尺寸停留；004未记录当时present拒绝，不能据此补造其唯一故障原因。

完整NativeDesktop根组件另复现了刷新文案：每次同selection的viewLoading让restore入口暂时消失，继而插入“正在核对保留页面…”正常流状态行，并在fresh后重复恢复读取。现仅在原只读restore确已成功、完整scope及request key仍一致时，加载投影保留该展示身份；首次loading、新选择和实际读取失败仍等待fresh核实，canRead／canInvoke不沿旧值准入。[根恢复回归](test/isolated/native-browser-restore-root-dom.test.tsx)观察三轮loading／fresh无状态行插入、无重复恢复、同一tab节点，并保留真实切换等待和读失败后重新核实；SessionTabs既有去重合同未改。此为已复现文案链的受控修复，不代称用户实机中所有闪烁已消失。

上述根恢复最终1项36断言；包含它的7文件补验共73通过／0失败／3项Windows专用跳过／1116断言，覆盖普通人工继续／停止／unknown、真实根选择等待、SessionTabs、面板输入后禁写、原生面板与桥、Main生命周期。Main文件在普通OS权限下运行本机loopback夹具，未启动第五个验收客户端或外部模型；沙箱EPERM和修前文案断言留在原日志。Desktop／UI最终类型检查、定向格式及文档检查通过。JSDOM证明状态节点与因果顺序，不取得真实像素、物理输入或安装资格。

003、004均正常退出0，004登记13个原生身份absent，原Browser和代码Jobs确定取消，三处旧unknown目录identity不变；这些进程采样不代证完整历史coalition，也不清除旧unknown。四个实例许可均已使用，共51／60次模型调用，剩9次；当前没有在运行的本任务实例。最新Core权限／Loop、隐藏初始viewport、resize和后台／坐标／人工继续全过程仍待更新制品实机，原后台gate未完成切换，不能计后台通过。定向证据包括Loop7项46断言、并行／准入与长任务／审核共50项862断言，代码环境25项247、资源4项34、SIGKILL恢复7项122、源码外隔离多步代码1项76；Native截图24项175、pane6项212、unified-flow3项86、grantIPC7项85、async-root4项250，权限／Service矩阵与实际单次审核由Service owner维护。最终候选按文件隔离的31文件集为323通过／0失败／3363断言；另补Core拒绝与任务报告43通过／0失败／1项Windows专用跳过／465断言。受控通过不替代上述未完实机和发布资格。

用户随后要求持续真实模型回归并重点观察右侧浏览器tab内容区，先按额外2实例及累计75次执行。`attempt-005-dev`的实际开发Main在Service启动时退出，零Run／Model／Tool／网页动作；原因是隔离夹具用自定义环境变量传调用额度标识，而正式paired环境白名单不传该变量。仅修下一夹具为固定授权文件的精确校验，未改产品或放宽守卫；005 Main准确birth absent，原退出码未捕获保持null，不称正常退出。`attempt-006-build`普通制品关闭testDiagnostics，真实24次gpt-6-luna／Responses／low，累计75；原固定额度和失败记录保持。用户其后明确放宽次数限制，后续仍按同一模型、隔离无凭据页面及原主线继续并保留准确累计。

006的Auto自然任务正常完成，唯一一次authorization.check批准browser.open，没有额外页面Question；真实读取标题／空文本，零业务写和点击，两个解释器／浏览器Job分别确认停止，原Main页保留。Full任务实际填入LIVE-75，随后用旧观察选择下拉在派发前stale；原失败进入下一Model正常解释，Run completed而任务意图未完成，不是Loop中断。明确的新恢复任务未重复填写，完成High／HOVER-73／真实dialogRef接受／一次Execute once及两个计数1；正式PNG四次进入后续Model，蓝点和拖拽实际各1。原call／result与图片来源配对完整，unknown未被重放或改写。

该恢复任务随后只调用ask_user，没有真实requestHuman，故提问时Main仍Agent且输入盾可见，不能称模型已交还。实际点击“暂停并接管”后Main human、shield隐藏；程序化焦点夹具未获确认且零文字，后经原可见文本框的系统辅助功能编辑成功HUMAN-VERIFIED，原业务点击仍1。浏览器原10分钟lifetime在长时间检查期间正常结束，之后不再显示继续入口；未取得Model读取人工文本或继续资格，不修改原期限来计绿。最终普通UI停止原等待Run／Question并取消未答问卷，Main正常退出0、原登记身份absent。全局内置Skill已明确真实交还、问答与控制权的区别，以及确认派发前stale后观察实际效果再继续剩余动作；9项96断言及Agent／Service类型通过，新指导尚须修后实机核实。

006的自有窗口连续录像保留在同目录runtime，系统AVFoundation按实际PTS逐帧解码。Auto完整60秒3435帧中，首次完整页出现后到终态未见记录到的白／黑空帧、整体缩放、消失或越到聊天；Main页矩形与1781条UI观测相符，close仅撤蓝光，实际采样间隔8.333–33.333ms，不排除更短闪动，也不代证resize。Full新任务接管阶段Main另有约7ms的真实y92→140、height687→639→687变化，未伴随window resize；恢复录像第371帧（6.475秒）实际拍到48CSS像素下移和黑带，下一帧恢复。真实SessionPage／SessionTabs的held restoreKey回归复现核对段落增加布局子节点，现仅无标签时展示该段落，已有页原核实和分配门禁仍保留；18项342断言通过，不能将旧006制品当作修后实机。

同一resize录像第2125帧（37.0083秒）另拍到1400→1100缩窗时Native内容左边652CSS而工具栏左边764CSS，覆盖聊天112CSS；下一帧恢复。Main先按旧447宽度右锚，随后Renderer才报告335，表明旧宽右锚不足以跟随真实相对分栏。第2561–2562帧（44.5833–44.6秒）整页黑空与菜单相交触发的Main隐藏约40ms吻合，随后原页恢复。二者分别归布局投影和菜单呈现交接排查，不归因agent-browser后端。录像画布固定于开始窗口尺寸，扩窗超出画布处没有像素证据，不能把录制裁边计为产品越界。

布局修正的受控增量：bridge／capture共29项251断言、Pane7项244断言、grant IPC8项98断言、SessionTabs17项300断言通过，Desktop／UI类型及相关Biome通过。生产Panel库自身执行导航像素保留、1400→1100→800→1800缩放、右栏min／max／collapse与导航关闭，Pane投影与其独立决策对齐；该DOM测试手动提供flex／offset几何，不能代证真实Electron合成和实际CSS布局。Main另核旧量测、zoom、正常resize不hide、失去几何资格撤下及图片proof失效。修正后的连续实机仍待007／008，当前不增加发布资格。

菜单呈现衔接由[Native menu](src/native-browser-menu.tsx)、[Pane](src/native-browser-pane.tsx)和[Main](electron/native-browser.ts)负责。用户明确打开控制／选项菜单时才取一次当前可见页PNG，Main以原实际呈现scope、页对象、导航、尺寸、scroll及zoom前后核实；私有预加载方法只返回该呈现帧与短期单次key，不能作为模型imageRef、坐标proof或DOM观察。图片解码、按Main实际可见CSS矩形铺好后，再核key隐藏原生页；hook等待这次准确hide ACK后才打开Popover，不能同时发hide并先显菜单。菜单关闭等待真实present ACK才撤图。迟到、切页、resize和错误撤掉旧画面；截图／解码仍只准备200ms，失败走明确无图占位并在普通hide确认后开菜单。hide拒绝则保留关闭、沿原错误位置提示重试或停止原任务，不假造隐藏成功；停止不等待Core Action／审批或网页队列。

该路径不复用 `browser.capture` Action：后者会更新语义seq／refs并占观察owner的pending门禁，可能阻挡交还／停止；普通无browserId页也不能用它。呈现帧不进Core、Artifact、Model或正式输入证明，不attach CDP、不改变元素引用、不默认轮询；菜单中的冻结图不代表后台停住。普通截图／注释仍沿原Action和权限，工具及协议版本未提升。当前受控验证与后续真实连续帧分别记录，不以私有接口存在宣称黑帧已完成实机修复。

010自然录像的一帧菜单被Native遮挡后，新增hook与真实Pane held-hide ACK先红后绿：准备成功与无图fallback均不得提前开菜单，实际hide确认才显示；准确拒绝后的原入口重试／提示、切页取消、迟到ACK及关闭show ACK保图继续覆盖。menu、Pane、人工控制、统一流程及异步根五文件37项890断言、Desktop类型及Biome通过。Source仅改上述两个Renderer文件，Main／工具／协议未变；这证明受控握手顺序，修后真实Native合成仍待新制品。

007沿真实desktop:dev启动Vite和正常Main，关闭testDiagnostics，13次gpt-6-luna／Responses／low使本轮累计88。其Service入口保持external，实际Core解析到当前仓库src／runtime／execution；同入口SHA不证明旧Core，runtimeClosure另核真实源码哈希，本结果不是独立安装包资格。Full实际填写AGENT-SEED、Execute once只一次且两计数1，随后真实requestHuman使Main human／debugger detached／盾隐藏。普通信息提问参数失败进入下一Model，之后有task.events和files.list，最终原Run completed；这是未按要求等待人工的实际失败，不能把回复完成记为任务完成或继续成功。

该轮输入夹具的Meta+A未生效，实际已核字段变为AGENT-SEEDHUMAN-OK-007，未重试；模型／权限选择夹具强行移焦关闭菜单，以及录制前1000高与系统839不符均作为夹具失败保留。原窗口扩至1600却保留x206，物理屏外右栏不能按AX点击成功计；150秒录像8541帧实际3424×1902，内容原点112／76，有效Native条只含左170CSS像素。实际PTS全片最大33.333ms，开始及交还关键段最大25ms；对全部可见帧与关键原尺寸图核查，该有限区域无48px恢复占位、黑空、缩放或消失。3711条几何仅一组toolbar／viewport，真实phase依次接管中／Agent／交还中／人工，menus最大0。最右标签和菜单没有有效像素，不据此宣称整页、工具栏或菜单实机通过。

007退出未获正常确认，原Browser Job unknown及夹具最终137保留；全部登记出生身份在准确tail清理后absent，旧三处unknown目录不变，不扩大为完整历史监督。原因和当前Main先hide后release／exited再destroy的修正沿[退出收尾](#原窗口关闭与退出收尾)核实。Browser另已加入[原人工receipt完成条件](../../packages/agent/src/tools/browser/README.md#异步人工交接候选未发布)，防模型final提前结束原Run；Native完整mock现确实在waiting_execution点击原继续，A-B-A后一次回应／纳入并在原页继续。该增量9文件116项1389断言及Agent／Service／Desktop类型通过；修后真实单次继续、完整屏内菜单／resize与后台资格仍待008新制品，旧007不恢复或洗成成功。

该新Run占位已在共享SessionTabs收敛：只有尚无标签页的初次恢复显示正常流核对文字；已有页更换restore key时仍进行原读取、禁止新分配并保留真实失败重查，但不插入挤压视口的状态行。真实SessionPage／useSessionTabs的held读取先复现新增正常流子节点，修后连同Native根18项342断言通过，UI／Desktop类型及文档检查通过；原跨scope等待和失效拒绝保持。此处修后资格为受控组合，新制品实机仍须核，006两次约7／8ms旧几何记录保留。

008普通构建沿独立HOME／Profile与正常Main运行，关闭testDiagnostics，30次真实gpt-6-luna／Responses／low使累计118。真实单次人工继续已在同一Run闭环：填写AGENT-SEED、Execute once一次、requestHuman交还，原Run保持waiting_execution；人工全选后输入HUMAN-OK-008，原相关继续只回应一次并纳入一次原receipt，随后真实snapshot核字段与点击计数1，再释放自动控制。该Run没有Question，继续后没有重填、重点击或重开。模型在交还后额外做两次空task.events及八次无页面的pages查询，准确原记录均保留；这不是页面业务重放或再次提问。窗口实际1400×839且整体位于当前workArea内；120秒录像覆盖初次交还与控制菜单打开，未覆盖稍后人工输入、继续和菜单关闭，不能据此授予完整视觉过程资格。

该录像实际6887帧、3024×1902，最大真实PTS间隔25ms。按已核内容原点112／76解码整条右栏400×839，全部帧做变化筛查，并直接核进入控制、交还与菜单出现的连续帧和关键原图；页面标题、输入、计数、画布位置保持，菜单出现前后仍为原页，没有重现整页黑空。此处仅授予该已录过程的观察结论；菜单关闭、人工继续与连续resize不在这段录像中，不以同Run后来的功能成功补造画面资格。原帧及有限分析保留于本机`.cache/browser-unified-observation-20261029/008-human-continuous`及相关目录。

同一008随后在本地受控慢导航回归中失败。Main准确同页已派发Page.navigate，站点确收hang请求但尚未释放；Service私有CDP RPC在10.003秒先中止，早于原Native请求35秒期限，触发revoke／detach，原Browser Job最终outcome_unknown。统一入口又在controller仍starting时先发snapshot，将原终态缩成browser_control_not_owned；随后新open被原页面绑定安全拒绝。Run仍继续模型并正常说明未完成，后台B切换门槛未达到，也没有释放响应或业务点击。当前按该真实失败修正Service等待链与首次open就绪／原结果传播；原008未知不改写、不重放。其正常退出未确认，Main已先hide保留页，但原unknown监督使Service drain无法确认，120秒夹具精确清理后全部已登记出生身份absent，旧三处unknown不变；不计正常退出或完整整树资格。证据保留在本机`.cache/browser-unified-luna-low-20261028/attempt-008-build`，修后后台、完整屏内菜单／resize和连续人工继续画面仍待新制品。

用户随后明确许可009普通构建与010开发各一个新隔离实例，调用次数继续沿此前放宽授权，166次是当时夹具内部守卫。009 Main正常启动，录制器的文件大小就绪判定先失败，未发送任务，零Model／Run／网页业务操作；Main正常退出0，不能计普通构建业务验收。010同一Main沿真实Vite运行，gpt-6-luna／Responses／low累计48次，使本轮实际累计166。前13次出现模型猜资源版本、未定义help和空代码；真实模型输出与SDK别名核对后，只修内置资源指导及REPL分块诊断，并补开发worker构建闭包，不另造帮助Tool或放宽资源版本。此实例原父builder早于闭包修正，后续Service仍用外部源码与已重建dist worker；不宣称新版父builder已在该Main加载。

010第二个任务真实填写AGENT-SEED、Execute once一次且两计数1，实际requestHuman交还；人工输入经全选范围核实为HUMAN-OK-010。唯一继续却使用全局空审核器，生成 `auto_check_unavailable` 待批，原任务直到lifetime结束仍未收到继续。根UI停止任务并拒绝旧待批作为测试清理，不是业务用户拒绝，也不恢复原任务或重做原点击。当前Core修正让Continue／resume沿可信原请求／Job父链保留准确原Run的审核器；其后新只读任务再次实测，已真实启动原审核器，但模型因缺原用途要求人工，正常Run进入等待又触发一次 `context_refresh_required` 重准备。新修正将可信原用途作为数据送审，并只对这条私有路径投影稳定Run stamp；完整human／controller／host-revocation102项684断言、Agent／Service／根类型及受影响Service权限／Loop37项409断言通过，尚未取得最后修后实机资格。

该只读任务的两段自有窗口录像共10359帧，实际3024×1902、最大PTS间隙33.333ms；按完整右栏与左邻参照检查全部变化簇及关键连续帧。进入Agent、交还、人工与停止后原页面内容保持，未见整页黑空、缩放或覆盖聊天；但自然片第3250帧／56.405秒实际菜单被Native页遮住，下一帧／56.42167秒才完整出现，不能计完整体验通过。菜单关闭无黑空，停止撤控制按钮后原页仍在。准确原图、全帧和时序材料在本机`.cache/browser-unified-observation-20261029/010-auto-fixed-continuous`及对应review／stop目录；没有可信容器t0，不把旧UI-GEOMETRY或文件mtime伪作本轮逐毫秒证据。当前按此单帧失败修菜单可见与Native隐藏ACK顺序，修后画面仍待新制品。

同一010随后对新后台任务准确绑定原Job／open／execute／Run／grant及当前Native标签，再开始慢导航和窗口缩放。夹具实际打开的是带AXButton子项的控制详情组，却按旧菜单角色检查而提前失败；未切到B，也未释放响应，不能计后台或慢导航通过。原Job `ada4a9ac-920d-49fd-ba24-1501680b28b7` 保留 `job_stop_unconfirmed`／unknown，Run仍继续模型并正常完成说明，网页业务效果为零。原请求seq9后来仅作夹具清理放行一次，409212ms后返回200，不是目标时间窗口内的后台放行；不改写原unknown、不重试导航或点击。010开发重载曾在源修改中间态启动失败后锁存，当前Main无法沿原通道加载最新修正；不为测试绕过generation／重载门禁或将新Main计作原实例。最后源码、真实连续后台／菜单／缩放／继续及准确退出资格仍分别核实，整体方案保持进行中。

010最终沿原fixture请求收尾，普通退出120秒未确认，development返回137；原Main birth已absent，原首次登记12个身份absent，后期Service27030另经准确PID只读OS检查为absent，不补造未保存的微秒birth或历史关闭回执。三处旧unknown目录不变，原Browser Job unknown也不改；这些只读进程观察不能补为整棵历史监督confirmed或正常退出资格。此时本轮009／010两个Main许可均已消耗，没有本任务验收窗口在继续运行；新的011／012只离线准备，未获实例许可不启动。

后台录像的缩放必要区间另有112个连续整窗帧：第1725帧／30.03833秒小窗的Native先到新右侧，Renderer仍旧布局；1726／30.04667秒小窗工具栏已出现而内容暗空；1727／30.080秒大窗恢复。小窗只持续两个采样帧，不是完整连续resize资格。对应Main的page／shield始终visible:true，不能归因主动hide；两次resize后还有IPC present改变几何。源码另实证：旧窗口量测可覆盖刚外推的anchor；新viewport配旧DOM可把差额伪装成580px右边距或581px间隙；测不出layout时仍发raw bounds。后两项是可重建的准入缺口，原日志不含入参，不能冒称已取得那一包的完整payload。

当前Main只让与实际CSS窗口相符、符合全宽Panel拼接／真实间隙的量测建立新anchor；迟到layout和将已有合格anchor退成raw的消息在任何几何、可见性、epoch或图像凭据改变前拒绝。跨尺寸外推只使用上次合格anchor，明确null撤下后保原bare兼容。Renderer将实际SessionPage量测分为合格、布局暂未一致及真正不支持：暂未一致不发positive raw或新增hide，沿原真实布局事件重测；隐藏／collapse／失资格仍撤下。菜单准备也核实际呈现帧位于viewport／祖先／窗口的可见裁剪交集，保合法局部图及1px舍入，旧窗口图不能借稳定但过时的DOM矩形铺入新位置。

Main capture／grant36项383断言、Producer／menu／human／flow／async-root五个独立进程39项918断言、Desktop类型及Biome通过。新Producer红例包括新viewport／旧DOM、伪边距／gap、反向缩放因clip空误发null、越出viewport或裁剪祖先的冻结图。完整根链原先把所有DOM节点设成同一矩形，现按真实两Group／Panel／separator及同一1200×900视口、FakeView、PNG／metrics与DPR2核实，业务断言未放松。结合Core102项684断言与正式权限／通用Loop37项409断言，最新受影响集合214项2394断言通过；这些检查不保证OS首帧原子绘制，修后像素仍待新连续录像。

011普通构建与012开发制品现已顺序离线完成；每份2607个产品源／20个夹具文件及148个实际产物已核零漂移，共同source SHA为 `8e7fe471554d4b3a2ecd058a78e50c5826bb7f6444cbda5271efaecd76290d1a`，worker是独立版本目录内的当前源码产物。实际Service入口目录解析的27个workspace external仍依赖仓库源码根，不计独立安装资格。两条launcher在任何spawn前均以 `pending_instance_authorization` 拒绝；没有新的Main、站点、Vite或模型，accepted授权与STARTED均不存在。历史实际166次保持，后续共享64次／累计230只是内部保护值，不能冒称人类新数字批准。实例许可已向用户具体请求，答复前不启动或放宽每Profile一次启动守卫。


用户随后明确允许011普通构建／012开发两个隔离配置及同配置内必要重启（同时最多两个），已有授权持续有效。011已实际启动，26次gpt-6-luna／Responses／low使累计192；012尚未启动。011的自动审核人工闭环在同一原Run完成：实际交还、人工字段HUMAN-OK-011、一次相关继续及一次结果纳入，下一模型核原字段和两项计数0后释放自动控制；没有Interaction Question或重填／业务点击，准确原Run为25fbd69e-f71d-49cc-9a59-5b98877bd2ef。120秒录像6873帧、最大PTS间隔33.333ms，完整覆盖菜单打开／关闭、人工输入、继续及交还；按原内容坐标观察全条右栏及左邻，未再见菜单先露被Native遮挡、整页黑空或状态文字反复闪现。这只覆盖该已录流程，不代证缩放／后台。

011后台夹具因选到forceMount的隐藏旧面板、又把未裁剪DOM矩形与Main可见矩形比较而在切B及有效放行前失败；原Browser Job c84e9420-f575-41ba-8683-7de48c6eb018的job_stop_unconfirmed／unknown及零业务效果保留。012夹具已改为准确NativePageId→选中标签→aria panel→唯一pane并取实际可见裁剪，8项16断言通过，不改生产选择语义。011缩放片第524帧／9.10833秒仍实际见Native先到新位置而Renderer保旧布局，第525帧才对齐；Main没有hide，这个首帧错位尚未解决。不能以去掉迟到量测或暗空证明OS合成原子性。原片与分析保留在本机`.cache/browser-unified-observation-20261029/011-auto-human-continuous`及`011-background-resize`。

用户要求先修反复工具失败，当前暂停新增实时测试。011已沿原fixture结束，普通退出未确认、Main absent，精确原身份清理结果及旧三处unknown不变均保留在`.cache/browser-unified-luna-low-20261028/attempt-011-build/RESULT.json`；不补为正常退出或完整历史监督资格。已确认的执行层缺陷是普通JS异常及已知参数／过期引用／读取失败被误按致命故障销毁解释器并连带关闭浏览器。现在沿[Browser owner](../../packages/agent/src/tools/browser/README.md#统一执行入口与隔离环境)修正可恢复批次边界，先用真实隔离worker和Runtime／SQLite验证原变量、页面、Job保留及后继零误派发；新修复尚未在真实客户端／模型取得资格。后续继续使用已批准配置及必要重启，不重新消耗或伪造旧STARTED，不覆盖原unknown或重放已派发导航。

### 2026-10-29 免审批与跨轮恢复回归

修后012同配置restart-002实际走desktop:dev／Vite及testDiagnostics:false。2次真实gpt-6-luna／Responses／low使累计226；原Run `5e7d7752-6ea0-4201-819b-63ce9432104f`因启动失败正常final并completed，没有回复失败banner或浏览器审批。原Browser Job `00654147-2689-4343-b952-8f24f819b28c`准确failed，未进行网页业务输入，预设的一次只读故障尚未消费，不能计第二轮快照验收。Main私有通道记录固定后端初始化的`WebMCP.enable`被正确拒绝为`method_denied/not_dispatched`，Service却将可选探测错误扩大成启动失败；当前仅修[Service的准确启动例外](../service/README.md#native-单页控制租约候选)，不扩大Main方法集或吞业务错误。

该次120秒录像实际6847帧、PTS0..120秒、最大间隙33.333ms；首帧在任务前，约11.108333秒完整最终说明出现，末帧保持。固定窗口下页面保留，当前连续帧复核不授成功语义、跨轮、菜单或resize资格。Main／dev均正常退出0，已观察身份absent，无tail强停；按实际development Profile发现的唯一daemon registration为113、原guardian／root／session均absent。三处旧unknown目录身份不变。原失败、录像、冷结果及准确观察保留在`.cache/browser-unified-luna-low-20261028/attempt-012-dev/restarts/restart-002`，不会以新制品通过覆盖。

012同配置restart-003的4次真实模型使累计230。首Run `9dc1ab08-2d2b-4779-ae59-a46bf8c50ede`已消费准确AX只读故障，原snapshot failed后Loop正常final，随后原Job／租约确认停止并detach，页面与零业务效果保留；0次审核。第二条新消息创建Run `b3924386-6bed-49d3-b450-0c4957dfbf20`，却只调用pages取得空数组并误报“没有可用的已保留页面”，没有新的open或snapshot。两Run completed和页面还在不能计跨轮成功，原observer的completed_requiresReview只表示观察结束，Root另存blocked结论。

同片原生菜单在11:44:09.898打开、10.039回调关闭，10.790右栏整体收起；当时日志没有关闭原因，不能断言同一个Escape直接泄露。源码确认菜单identity包含fresh／pending会在后台核读变化时主动取消，SessionPage的普通Escape只认识DOM对话框。当前改为只在真实页面／scope失效时取消、选择时核最新准入，Main及Renderer消费实际pending菜单的同次Escape按键序列；失效选择沿原普通issue反馈，不静默吞掉。Controller另只为曾成功Agent绑定并确认释放的共享页提供无id、无authority的lastKnown描述，当前存在仍由新Run的Main实际绑定核实。相关实现及证据归[Browser owner](../../packages/agent/src/tools/browser/README.md#统一执行入口与隔离环境)和菜单回归；原003失败、完整录像、单页原内容、冷结果及正常exit0／dev0、准确daemon停止／目录删除与旧unknown不变均保留。修后真实同页第二轮、菜单及缩放仍待新制品。

004继续使用原配置、testDiagnostics:false。012的4次真实模型使累计234：首轮准确只读故障进入正常final，页面持续visible；原生popup的AX树没有控制菜单项，私有helper因此安全拒绝且未发送Escape，原observer停止，该部分是夹具限制。另发第二条自然消息后，模型实际收到正确released元数据，却因没有可用绑定句柄而在“不新开页面”约束下仍未open／snapshot。该失败说明仅补guidance不够，当前已采用上文的新Run候选id和Main existing-only硬准入；没有把两次正常final计为恢复通过。011同次启动未发模型任务。两004 Main均正常exit0，dev亦0，已观察身份absent，准确daemon registration／guardian／目录确认结束，旧三处unknown不变；原记录不覆盖。后续菜单夹具只通过准确当前popup的Main owner输入事件验证Escape消费，不声称硬件或AX资格。

005继续原两配置，17次真实模型使累计251。012首Run `69386db6-b8f1-41fd-a698-f9583b2b1ba3` 的准确只读故障进入正常final；第二条新消息的Run `6b2fdb25-80d3-47e1-86ba-b9d518072e48` 经本Run候选首次snapshot创建新Browser Job `543def50-c8f9-427a-b355-d4771d168895`，准确复用Main原WebContents并取得成功新快照，零业务点击。原生菜单由真实触发打开，准确owner的Escape down／up均被消费，popup实际回调结束后原页仍持续可见；此为程序化owner输入证据。011语义任务 `8b63c4d9-33f4-40fb-b339-025a9e09ba06` 实际完成字段、High、hover、确认和一次点击并正常final；但整段120秒录像回放发现原生Cancel／OK确认框在Accepted及final后仍遮住窗口，因此不能计该体验通过，须修复并重验。原observer因弹窗阶段菜单已关闭而停止、未投递Escape的失败记录保留；业务成功不覆盖该观察结果。005另两次准备因前台焦点冲突及839／841窗口预检失败，均未提交模型任务，不计产品操作失败。两Main与development正常exit0，已登记身份absent，旧三处unknown不变。原RESULT的空cases数组不补写，准确Run／操作、观察及视频材料保留在各restart-005与本机`.cache/browser-unified-observation-20261029/005-*`。

006仅启动011普通构建，35次真实模型使累计286；012只构建未启动。语义Run `8bba913a-6dfc-4c93-a940-1bed3fa6a01f` 完成字段、High、hover、Accepted和单次计数1并释放控制，6881帧实录中原生框在PTS45.158333后不再可辨，直至120.008333末帧无残留；右栏及toolbar稳定。但PTS67.950／67.966667显示“完整回复读取失败。”并伴阅读位置往返，整片正常回复切换不计通过。已按上述正常正文前进误判做deferred先红后绿修复；旧片没有保存当时IPC错误码，不把复现推断写成该次已采集的错误码。

006 manual首Run只填写后由模型提前final，所有Tool成功、计数0；一次后续Model在fetch阶段TypeError、零Tool，两失败保留。明确新消息后只完成剩余一次点击，再以普通人工输入HUMAN-OK-011、下一新Run同页重新绑定／新snapshot核计数1，未重填或重复点击；两个成功Run为`0f9fb933-0292-4a1c-9246-dcd61a5e351c`／`b2d702b6-98e6-462c-8d70-bc663be1608d`，完整过程归本机`006-build-manual-restored`。read-failure两Run `0f265b8c-d221-4d0b-bc8a-7a6616a27559`／`25c6ca30-90a9-4a1b-a2de-bcd203166a05` 取得准确失败后正常说明、新消息同页成功snapshot及菜单owner输入／关闭证明，原观察与录像保留，资格不扩到未录场景。

006后台夹具在普通切换尚未就绪时立即断言目标Session，实际UI_TRACE在14:15:37.642Z为选择过渡空值、原页已hidden且retained／agent；夹具提前退出没有放行原延迟响应，原导航超时并保持unknown，不能计后台通过或重放。当前只修夹具有界等待准确目标选择及原页保留，不以产品改动适配错误检查。006普通退出120秒未确认；Main已absent，登记Service按原birth精确tail结束后absent，其余登记样本absent，7项准确daemon注册／guardian／目录均确认结束，三处旧unknown不变。原RESULT及新导航unknown不洗成正常退出。后续继续已有两配置／必要重启授权，使用新007制品验上述实际缺口及剩余主线。

007仍只启动011，5次真实模型使累计291；012仅构建未启动。后台守卫把WebMCP.enable的400／method_denied／not_dispatched误作lease失效，实际同lease在后续confirm成功，原Run／BrowserJob仍running、页面agent且原hang唯一。夹具未放行，原导航最终unknown；Run `0bec4e2e-ddd9-408c-9120-a12f8f5f4b95` 仍正常completed、无业务点击。真实记录回放已将这一精确已确认初始化探测从失效分类中排除，其他错误／unknown继续拒绝；失败sample在bind前持久化。旧失败与unknown不重放、不改写。

该次Model持久输入另证实外层Tool只收到job_stop_unconfirmed，浏览器已有停止原因在原Job.details.actualResult；技术code_session的cancelled文案也被模型解释成任务取消。当前[Browser说明](../../packages/agent/src/tools/browser/README.md#统一执行入口与隔离环境)已补精确宿主身份与Runtime wrapper解释、技术停止范围，70项877断言、Agent类型通过，原结果和通知生命周期保持。此后语义场景只进行未提交任务的界面准备；macOS实际报告screenLocked=true，焦点与OS截图未确认，没有新增Model，也不据BrowserWindow逻辑截图追认真实画面。007正常退出未确认，Main及其余登记样本absent、Service精确tail后absent，准确daemon注册／guardian／目录确认结束，三处旧unknown不变。当前无客户端运行；008只沿原两配置／必要重启许可离线准备，待桌面解锁继续剩余真实验收，不新增审批或清洗历史。

008在用户确认解锁后仅启动011普通构建，18次真实模型使累计309；012仍只构建。后台观察中已完成B→A，随后在原延迟响应放行前出现新的B点击及新select，Main与renderer一致回到B；当前不能区分人工输入和夹具输入来源，不能据此改产品选择逻辑或计后台通过。守卫拒绝放行，原导航unknown保留。E场景普通Tab X实际销毁原页后，第二Run收到可读的existing_missing并正常final，零替代请求／业务效果；外部最终断言误把旧main-ipc-reply当实时页面而失败，原文件不改写，补充审查只核main-readonly-state，连续视觉资格仍待核。008正常退出未确认；Main absent、原Service按birth精确tail后absent，两项daemon注册／guardian／root／session均确认结束，旧三处unknown不变。原材料归本机restart-008，页面生命周期与精确跨Run身份的新修复仍须新制品验收。


### 侧栏保活与原生加载宿主（2026-11-01）

侧栏开合本来已保留 Page／Chrome WebContents，没有重新 loadURL；此前丢弃的是呈现绑定和准备事实，手动展开还经历中间宽度。2026-11-01阶段让选中既有 browser tab 从 header 展开直接采用最终尺寸；该动画特例已由[当前右栏修正](#固定-renderer-布局收敛2026-11-02)替代，以下保留当时原生加载宿主的资源复用记录。Host 仅保存最后一次成功布局的资源描述（准确 view/token、owner、Page frame/URL、Root frame/metrics、viewport），不保存截图或输入证明。同原文档、同 owner／Root／尺寸且真实输入盾可用时，先呈现受盾保护的 live Page 与 Chrome bar，fresh wire、Root 双帧、Page 完整帧及新的 hosted ACK 后恢复输入；任一事实变化走完整准备。收起只隐藏并退休展示，不 detach／unregister 或释放 Agent lease，非零 viewport 与原文档保持；坐标依据仍按原观察规则失效。

完整准备复用既有 Chrome display capsule：先在现有原生宿主绘制不透明整右栏 header＋普通 Spinner，其准确自身完整帧就绪后才准 Root 私有 nonce。目标 Page 临时放 Root 之上、该宿主之下等待真实文档和自身帧；采用时先裁剪 Root，再恢复稳定 Page＜Root＜Chrome 层序，最后将宿主缩回 bar。准备阶段仅允许精确 wire 的停止加载、关闭／收起、Escape／返回 Root，不能沿 preparing 取得导航、任意输入、Agent lease 或模型观察。preflight／已覆盖但无 fresh Root 都有有限超时及可读失败，失败不循环重新观察；冷／暖临时 Page 均撤，Main 只取消同 signal 的初始准备，旧 callback 不取消继任者。

030 的最小矩形遮挡曾在实际过程泄露三帧 nonce，该候选已替换，原片保留。032 是新宿主的首次冻结集成失败：新观察通知触发旧 Pane cleanup 撤掉已准备宿主，128 次通知、Chrome revision 到266，首 Page 未采用。后继明确 Main reobserve 交接：只在同 node／document／owner／visible 且无 error／blocked 时跳旧 withdrawal，仍清旧证明；真实收起、卸载和换 owner 继续撤。失败原片、hash、零 source drift 与实际执行保留在 `.cache/browser-native-clip-probe-20261031/native-loading-resume-032-final`；本段不授该失败制品任何通过资格。最终定向及冻结制品结果续于本节，原 resize／Root 展宽灰带、普通构建与跨平台资格不升级，模型账本仍504，无新模型调用。


033 已修复该循环并完成首开与原页开合，19个生产输入 hash 无漂移；Page2、timeOrigin1793536567962.9、原输入及scrollY=0保持，隐藏期受控 Page JS 写入后原页恢复，开合期间无导航事件。该受控 JS 不是新 Agent lease；已确认隐藏 lease 的 CDP 派发另由原 PageHost 回归核对。连续原图又准确发现 warm bar 底边半个 Spinner（P99/2.050000、D99/2.066667），故不授 warm 无残留资格；cold P33/0.641667无 nonce，但起始 header 左缘短裁到 P38归位，仍保留。后继仅补私有 loadingBody 显示事实：cold true、warm false，取消准入仍按 preparing／准确 wire 核对，Renderer 的 warm bar 不再创建 loading 正文；不用高度阈值隐藏或复用旧截图。033 原片与读图范围保留在同根 `native-loading-resume-033-final`，最新034只针对这处新缺口验证，不重做天气／缩放。


034 最新冻结开发制品 Main26129 完成 HTTPS 百度首开、侧栏收起、隐藏期受控 Page JS 写入和原页展开。Page仍为 WebContents2、timeOrigin1793536976155.6，输入由`kite sidebar retained`变为隐藏期的`kite retained background`并在展开保留，scrollY仍0；开合期间没有新导航事件。19个生产输入构建／结束／当前 hash均无漂移，两源10秒录像退出0，driver无handler异常，原片与连续读图范围归`.cache/browser-native-clip-probe-20261031/native-loading-resume-034-final/review/REVIEW.json`。约束内的live Page复用路径实际采用，不借旧截图、Root ACK或输入权；两个180ms私有capture返还hold只暴露交接，不是自然时延或FPS证据。

0–4.5秒及末0.4秒连续两源复核：冷loading所核原图无nonce条或恢复文字，原页出现后工具栏底部不再露033半个Spinner（P99/2.041667与D99/2.075000原尺寸确认）。仍保留展开前一个样本的完整普通Spinner（P98/2.025000、D98/2.058333），不能称warm全过程无loading；首开tab／address左缘短裁、收起时D87/1.775000整旧右栏灰列、P的窄Root布局过渡同样保留，未授整体无闪或已知缩放灰带修复。未覆盖录像中间稳定段、普通构建、跨平台与完整物理输入资格不升级，030／032／033失败原片不改写。

最终定向回归：Main230项3904断言、Host109项1299断言、Pane56项570断言、Chrome Renderer15项147断言、私有桥5项82断言、Root18项202断言、SessionPage渲染10项143断言；Bootstrap11项199断言、原Chrome preload1项23断言、Native bridge15项247断言及隐藏已确认lease派发1项14断言也通过。Desktop／UI类型、Biome、文档／影响映射、Core边界及测试归属通过；没有新模型调用、提交或推送。此轮iteration_complete只覆盖已确认的普通loading、资源保活／原页快速恢复和准确取消边界，未扩大既有渲染／发行资格。


### 窗口重开与已加载标签切换回归（2026-11-01）

用户随后确认 Cmd+W 重开不能显示／刷新、已加载标签切换又闪烁，重新打开相关结论。上一轮新增的cold准入只检查`!readyFor`，但已有shell的新目标在fresh ACK前本来就未ready；`loadingReady`扩整高Chrome并改变层序后，破坏仍在使用的裁剪Root／bar和handoff，其准备又要求full Root而永远不能完成。另`finishDisplay(false)`将普通取消也封为loadingFailure，而Main.hide没有释放尚未转交Main的Host preflight，可能在隐藏时超时并以同binding／metrics永久busy；稳定原页的hide又留下Host cropped shell，出现依赖Renderer是否先withdraw的不同恢复路径。

现Main仅在无准确当前presentationViewport的cold路径使用整页loading，既有shell／目标预备继续fresh绑定与交接；Host冷入口自身也拒绝任何shell／handoff／Root-return或非full Root，不得改已有bar／source。窗口hide／minimize明确释放Host展示与待交接准备，清本次loadingRequest，保准确Page和资源描述；show仍由已验收意图重新绑定，不借旧lease／截图／ACK。只有明确reportFailure的真实preflight失败才能写loadingFailure，正常取消不制造失败锁；真实超时继续一次报告和隔离，不增加重试或刷新循环。

定向先取得Main六个红例与Host三个红例，分别复现误入cold、未取消Host准备及普通取消误封busy；该切口修后Main236项4046断言、Host112项1384断言全绿，真实timeout两项仍通过。旧测试不删，补了独立shell存在但binding未ready的事实，以及session／draft preflight／covered的hide→show→resize和旧callback隔离。原034只验draft首开／开合，不能代替这些生命周期组合。035真实制品因夹具误向隐藏的保留Chrome输入新空B地址，导航根本未派发；该失败和原片保留，不计产品失败或通过。仅修夹具的可见目标核实后，036从已有隔离Session完成HTTPS百度A／example.org B往返、真正关闭B回A、系统CG Cmd+W、准确本实例activate、有限resize及工具栏实际刷新。刷新前原A的WebContents、timeOrigin与输入保持，刷新后是有意创建的新文档且可读；不把正常final或退出0当作功能证据。

036的两路15秒原片各完整导出活动0–6.5秒及稳定尾0.4秒，32张去重联系表和16张原尺寸帧支持上述有限过程：已加载切页和关闭回邻页未再采到额外整栏空白、错误页闪回或工具栏撤下；重开仍有process P161/3.358333全窗灰→P162普通Spinner→P163原页，display D158/3.408333 Spinner→D159原页。D184/3.933333在resize／主动刷新边界采到正文灰底且已有停止加载图标，不能单独归因resize。新空tab仍有短header交接，不授整体无闪、FPS或全部平台资格。完整原始失败、范围、PTS、hash及复核位于本机`.cache/browser-native-clip-probe-20261031/session-tabs-window-recovery-035-final`及`session-tabs-window-recovery-036-final/review/REVIEW.json`；无IPC handler／stale_rendered异常，原始系统sandbox_extension警告另保留。

### 标题栏双击与Root逻辑尺寸（2026-11-01）

用户实机截图的宽暗空和短条纹按独立因果排查。稳定托管校准原本生成Root nonce，但该异步路径Main不消费它；准确采用回执到达时若DOM尺寸又变，旧的完成函数先拒绝而未清画布。现只有初始同步Root两帧产生nonce；稳定async不生成、不回传绘制证明，Main同时退休旧drawnRequest／drawnPresentation。准确同调用、同id的完成回执只清自身画布，采用仍核当前DOM／owner／revision；错误id、旧scope及旧callback不能清继任或恢复旧坐标。截图仍依据当前真实Page bounds／sizeEpoch，不伪造Root帧。

移除稳定nonce后，037冻结诊断仍复现约298px内部暗空及条纹：所有Host.layout成功、三份原生边界一致；阻塞点是首个Root `Emulation.setDeviceMetricsOverride` ACK约354ms／347ms才返回，旧单在途队列因此让Root逻辑viewport停在动画第一尺寸，Page及物理裁剪已继续移动。条纹未必是当时新画的nonce，不能只清画布就宣称根因解决。038候选在同步JS maximize／unmaximize调用期间提交新尺寸，Root样本边界偏差降至约12px，但真实macOS拖动标题栏双击在Chromium直接performZoom，不经过应用DOM／IPC或JS方法，因此该包装退役、四个原本clean文件无最终diff。037／038原片、准确采样和失败均保留，038不授系统鼠标路径资格；039只准备未执行。

当前单一metrics writer由现有Main `applyNativeResize`明确传入原生来源，实际resize事件可在旧ACK未到时提交最新不同尺寸，覆盖系统标题栏双击及真实边框拖动；Renderer校准等其它来源继续单在途和最后尺寸合并，不靠定时器、isMaximized或will-resize猜动画起点。当前请求按对象、Root frame与metricsEpoch核完成，迟到旧完成／拒绝不回滚或失败继任，真正最新请求失败仍撤展示并恢复Root。A→B→A必须重发A，不能因A曾applied而省略已派发B后的恢复。该命令ACK仅表示逻辑环境完成，不授Page绘制、输入或旧观察；原fresh ACK、Page完整帧和取消门保留。Electron每条命令独立id，Chromium按收到的参数更新后等待Renderer回执，采用该边界而非串行等待首个动画ACK；[固定Electron实现](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_debugger.cc)、[固定Chromium实现](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/devtools/protocol/emulation_handler.cc)。系统双击分支见[原生窗口处理](https://github.com/chromium/chromium/blob/152.0.7977.78/components/remote_cocoa/app_shim/native_widget_mac_nswindow.mm#L523)。

当前Main237项4084断言、Host118项1486断言、Pane60项617断言通过；新增Host六项先红后绿，覆盖显式native来源的A/B/C、ABA、重复去重、旧完成／拒绝、新Root及dispose；普通来源串行断言保留。Main原prepared／unprepared resize测试同时区分native与Renderer来源。上述为受控回归，系统CG双击及快速边框拖动的最终冻结制品资格续于本节，不以038应用调用路径代替。模型账本仍504，本轮无新增模型，不暂存、提交或推送。

040冻结最新19份生产源码，运行前后hash零漂移，沿原隔离dev HOME/Profile仅启动一份验收客户端。系统CG输入限定Main71327、PPID71325、精确birth及CGWindow7097，真实header双击false→true→false，DOM click／maximize IPC计数均0，证实已覆盖此前包装遗漏的原生路线。放大／还原各38个真实resize和38个native来源布局，Host.layout均成功，Root逻辑宽在探针内分别推进34／36个值，Root DOM采样边界峰差约14.664／9.484px，不再冻在第一尺寸。每段900ms内各38条metrics全部完成，无同值相邻重复；不同输入路径的037约298px仅作既有失效机制对照，不当作同输入性能基准。

同片追加一次真实系统右边框40步／每步约16.7ms拖动，宽1050→1440（+390）、高度不变，原A/B文档与百度输入均保持，四次终态geometry一致。该拖动的900ms诊断窗口只覆盖到宽1330，后段在完整录像与终态核对，不能将窗口内约1.523px峰差扩大为全拖动测量或FPS；画面复核必须覆盖实际drag结束之后。两路15秒录像均code0，完整launcher退出0，Main71327已absent，用户dev Main65207保留。原始driver有4条Window move completed without beginning及1条sandbox_extension系统警告，未伪作无日志异常；没有browser_chrome_stale_rendered或IPC handler异常。准确原片、探针、输入身份、源码与后续像素范围归本机`.cache/browser-native-clip-probe-20261031/header-maximize-040-native-resize-cg`。

040离线诊断已冻结为同目录`analysis.json/md`：放大首／末metrics回执355／22ms、还原351／18ms，首条ACK仍晚但不再阻塞当前尺寸；拖动28条均完成，末条在900ms边界后约4ms返回，不是丢ACK。每段完整params重复0、失败0；旧ACK不构成迟到旧参数再应用，固定Chromium实现在browser侧先更新参数，再FallThrough等待Renderer回执。各surface在不同回调／合成帧提交的限制仍在，不能用以上逻辑环境测量证明系统同帧。

040连续像素复核已冻结为`review/REVIEW.json`：两路活动0–6.791667秒及稳定尾约0.4秒共772个样本，35张完整PNG去重联系表覆盖544个唯一画面，另读18张列明原尺寸帧；其余选定重复样本仅按同源完整PNG SHA复用，未覆盖中间静止段不补资格。所看系统放大／还原／快速拖边未再复现037宽内部暗空、短条纹或旧宽聊天被裁切，原百度持续可见，未采到错误Example正文、Tools闪回、正文Spinner或双bar。仍明确失败：放大D36/0.683333灰缝26–28物理px；还原的窗口内右外灰带至少从D130/2.391667到D143/2.633333存在241.667ms，D138/2.533333所测224px不是全局峰值，D144/2.650000收敛且D145稳定。不得用这轮功能与边界改善升级整体无灰／无闪、非零阅读位置、FPS、普通构建或跨平台资格。

本轮按`document-before-commit`完成限定的`iteration_complete`：415项Main／Host／Pane回归、Desktop类型、六文件Biome、Core边界、测试归属、文档结构／影响和diff空白检查通过；退役包装后的Root7项／Layout3项原测试保持。手册中原页保留、重开／切页及加载动画预期已核对，本轮未改变承诺，无新增展示文案或工具协议。当前25个已有任务dirty文件保留，暂存区为空、HEAD仍`824966026`，未提交／推送。该ready仅覆盖窗口恢复／既有切页回归和Root逻辑尺寸冻结切口；上列实录残余灰带继续按用户既定边界保留，不进入引擎补丁。用户现有dev的Main不会由Renderer HMR替换，需要完整重启才含本轮Main修复。

### 右栏接管后的主题背景（2026-11-01）

用户新增输入网址、网页呈现后整右栏变色。Root的`.right-sidebar`明确使用`--page-background`，但独立Chrome的html/body/root和`.kite-client`保持透明，稳定`.session-tabs`没有绘制自己的底色；准备阶段另铺`--background`，因此准备／稳定接管出现不同表面。主题值原已通过snapshot同步，该缺口是实际承载层漏背景，网页CSS不参与独立Chrome文档。现在只为该宿主的`.session-tabs`补与Root一致的`--page-background`；外层透明、物理几何／层序、准备与Page确认、输入和权限均保持，不借添加`.right-sidebar`类引入额外边框或材质inset。网页正文仍由站点自身配色，标签／地址栏跟随应用主题。

本切口只改变CSS背景，手册中主题与网页保留承诺已核对，Agent／Main／工具协议和生命周期未改；原415项状态回归及类型结果按未变源码复用，不重做导航／resize矩阵，也不升级040的整体视觉资格。私有041以原生产Vite／Tailwind样式、独立最小DOM文档核深浅主题×修前修后，共4组／12个表面。修前Root／准备为主题实色，稳定宿主computed透明，PNG透出夹具灰色背衬；该灰色不是Electron默认canvas色。修后Root／准备／稳定三者的computed与真实PNG均一致：浅色RGB250／暗色RGB25且alpha255，前后几何逐字段相同、pageErrors为空，两份源hash不变。4张PNG已检查，具体值与原始失败／警告保留在本机`.cache/browser-native-clip-probe-20261031/chrome-surface-color-041/REVIEW.json`及`RESULT.json`；此证据只授CSS与shell配色，不代替真实Electron导航交接、resize或全程无闪。CSS Biome、diff空白及文档结构／影响检查通过，本小修复的限定iteration_complete为ready，未暂存／提交／推送。

### 分隔线显隐后的迟到菜单（2026-11-01）

用户在聊天／浏览器分隔线反复收起展开后报`kite:native:browser-menu` handler异常。准确用户制品`.cache/unified-desktop-FCMrwe/main.cjs:217882`是Main菜单`!current()`拒绝分支，页面对象存在；不能由截图推定某一个准入条件或实际DOM事件来源。源码另证确定的放大链：过期菜单请求抛异常，Popup将其写成menuIssue，Pane又将该局部提示并入网页error，Host因此判整页失格并撤展示。Control的issue同样仅来自菜单局部反馈，不等于页面／权限故障。

Main现在将已解析但页面／展示owner已失效的菜单请求按原`null`取消语义退休；来源校验、畸形输入和真实Native异常仍拒绝，不捕获或改写业务错误。Popup在layout提交阶段取消hide／host／owner变化下的旧请求，晚拒绝另核当前visible；取消不重试、不重放。页面选项的局部失败通过有界`toolbar.optionsIssue`传递，仍在原选项按钮和详情中可读，不能成为`toolbar.error`；Control菜单局部issue也不撤原页。真正网页错误、notes／overlay、scope、Page帧和权限限制继续沿原门禁。该字段仅属私有纯展示数据，没有工具／协议版本变更。

受控定向Main242项4153断言、Host120项1522断言、Pane61项629断言、Popup17项85断言、Chrome Renderer16项156断言、bridge6项88断言全绿。Popup隐藏／host／owner三项有准确layout提交前后红绿，Main／Host新例首次执行时补丁已在，不冒充红绿；旧制品异常是其修前事实。当前测试核迟到取消、零popup／业务派发及后继显式菜单、严格sender／frame／参数与真实Native失败、局部可读提示保页及真实网页错误仍撤，真实内部分隔线过程资格续于本节，不以受控回归称像素无异常。

042冻结开发制品用原隔离HOME/Profile完成一次有界场景：真实CG拖内部分隔线收起两轮，再由既有标题栏按钮恢复（收起后分隔线已禁用，不冒称拖回）；Native隐藏分别早于可信pointerup995／999ms，期间未复活。自然menu invoke／show-options均0，原始非预期菜单事件来源尚未复现。另明确标记的一次受控迟到请求在收起后执行原Main，准确返回null且未创建popup；其后显式菜单真实打开、关闭回调和null结果正常，零handler错误。原百度WebContents／timeOrigin／输入及scrollY0、Root文档保持，业务导航仅初次URL，无重放或新模型。21份生产源零漂移，6175ms场景、两路12秒录制code0、launcher退出0、normal-terminate/drop0；隔离Main2743已absent，启动前用户旧Main87395已自行退出，未操作其Profile或进程。原始driver仅正常ready，无同截图handler异常或窗口warning；不能据此撤销原用户日志或猜其唯一准入失败条件。

完整离线复核在本机`.cache/browser-native-clip-probe-20261031/hosted-divider-menu-042-final/review/REVIEW.json`，原逻辑事实另见同目录上级`analysis.json`：两路活动0–约6.8秒及尾0.4秒，共672个选定样本，经34张去重联系表和16张原尺寸帧核实，重复只按同源完整PNG字节复用。未见菜单错误文案扩大撤页，最后显式菜单可见并淡出；真实关闭callback不是像素全撤证明（D282/6.038333、D284/6.096667仍有淡出影，D290/6.238333已无）。原片字节／SHA保持。既有过渡仍明确保留：D38/0.721667收起灰列，D39全宽Root；P125/2.638333灰列后P126全宽；D89/1.813333展开暗正文到D90/1.855000原页，D178/3.746667短Spinner到D179/3.763333原输入。该菜单修复不授整体无灰／无闪或FPS资格，也不以两轮自然未触发冒称原触发来源已查明。

本切口按`document-before-commit`完成限定`iteration_complete`：462项相关回归／6633断言、Desktop类型、实际变更TS/TSX的Biome、Core边界、测试归属及文档结构／影响检查通过。手册与跨包边界同步正常取消、菜单局部反馈保页及真实故障保留；原权限／Tool／Agent Loop未改，不重跑等价天气任务。当前改动未暂存、提交或推送；Main修复须完整重启开发进程生效，Renderer HMR不会替换旧Main handler。

浏览器私有授权以请求标识固定有效期：Main 最多保留128项，到期且终态才回收，创建中的申请不回收；窗口内仍满时明确背压。旧请求在保留期内保留准确回执与意图冲突检查，同进程时钟回拨不会刷新期限。Main 重启后不宣称对系统时钟回拨及伪造新申请提供额外跨进程防护。

会话消息正文与工具消息文字使用14px，由 Native 的 `--conversation-text-size` 控制；导航和输入区选择器保持各自字号。输入框底栏将权限入口放在左侧，模型与上下文圆环放在右侧同一行；权限入口不显示展开箭头，缓存命中率合入圆环的悬停提示，累计统计、未知状态和原权限确认保持。

普通 Native 权限菜单仅保留三种审批模式，移除“当前会话授权”入口、专用弹窗及其本地开关状态；Service 授权接口与隔离诊断工具内的目录／清除保留。模型、附件与权限菜单已核对，其他可见入口均有实际操作；不增加普通客户端诊断入口。

2026-11-09，Windows x64／Bun1.4.4／Chrome156，输入栏调整沿原隔离 Native 浏览器夹具完成深浅主题、500–1440px的28组布局／指标读取回归，另以2组实际菜单打开、Escape关闭、上下文悬停及连续移开核对最终普通界面。已观察读取、目标模型准备、缓存返回、提示与菜单的相关过程及最终画面；模型与圆环同行，权限无展开箭头，菜单仅三种模式，空输入显示“输入新的想法”。计算样式核正文／状态文字14px、文字区左右12px及上方8px。证据在本机`.cache/session-shell-browser-BaHHXY/`与`.cache/session-shell-browser-X5NiIf/`；首次单步跳跃鼠标的提示关闭超时经独立连续移动核实为夹具轨迹问题，最终连续轨迹通过。缓存、上下文、业务权限／交互、输入编辑和读取归属六组整文件共50项通过；UI／Desktop类型、定向Biome和文档检查通过。本次仅为共享组件与实际Native渲染器的隔离浏览器验证，未复验完整安装版Electron或真实模型，不改变Service授权／执行协议。

2026-11-09 后续输入栏核对：模型弹层改为top-center，删除Native宿主模型后的空名称节点，模型至上下文图标实测8px。原隔离浏览器在深浅主题×500／1440px共4组观察打开、开启动画完成、关闭、权限菜单与上下文悬停，居中／视口避让、原输入与提示关闭通过，截图与报告在本机`.cache/session-shell-browser-eJiM1E/`。截图对应“问候”会话的原模型已成功返回，缓存256／8954；冻结模型容量也已存在，未知并非创建会话失败。Core预测此前过早要求目录中所有工具的formatter；现仅对实际进入历史的工具结果核其原定义版本。独立真实SQLite回归有修前准确`context_estimate_unavailable`与修后热／冷预测通过，已使用工具缺定义或版本变化仍拒绝。只读打开用户原开发Store、禁止任何模型调用的Runtime复核得到9027／262144（原输入8954＋新增估算73）tokens，未修改会话；探针在本机`.cache/context-estimate-readonly-probe.ts`。52项相关Core／UI／Desktop回归、三workspace类型、边界与测试归属检查通过；该Service逻辑需完整重启开发客户端及其服务生效，未宣称已运行的旧进程已接管，也未扩展安装版或Provider资格。

同日上下文提示再按用户要求整理为260px、border-box的左对齐双分区卡片：上下文标题／约数百分比、细占用条和已用／总量；缓存标题／命中率及完整命中／输入tokens，数字用千分位分组。两块有细分隔线，真正未知时不画占用条。最终深浅主题×500／1440px四组覆盖已知／未知上下文、模型打开与动画结束、菜单关闭、提示打开和视口内连续移开，均通过并检查对应画面；证据在本机`.cache/session-shell-browser-7cIiP2/`。该轮窄窗口脚本原600px移出500px视口导致提示关闭超时，现明确在当前视口内连续移动复验，未改写组件关闭逻辑。新增表现沿原累计与独立上下文口径；缓存／上下文9项补验通过，连同上段未变代码的52项去重为58项相关回归。UI／Desktop类型与定向Biome、diff空白通过，文档同步按本轮实际变化核对；未重跑无关安装／模型任务。

上下文总容量展示按1024换算为大写K／M，262144显示为256K，1048576显示为1M；数值计算与完整无障碍token描述不变。当前Composer源码的隔离浏览器使用原未变生产CSS实际核到“已用9k／总量256K tokens”，画面在本机`.cache/capacity-display-check/256K.png`；上下文3项回归、UI类型与Biome通过。本次仅容量格式，不改变模型配置、统计口径或服务读取。

缓存提示的命中／输入数量同样复用按1024换算的大写K／M格式，小于1024保留原数量；该会话显示为“命中256／输入8.7K tokens”。累计统计、命中率及完整无障碍描述不变。缓存6项回归、UI类型及Biome通过，沿原隔离Composer浏览器核实两块格式（同目录256K.png已更新为当前画面）。

用户后续截图指出上下文已用仍为旧1000进制小写k，与缓存1024进制K混用。现统一复用`formatTokenQuantity`，上下文正文标“估算”、缓存正文标“累计命中”；该原会话显示“估算8.8K／总量256K”和“累计命中256／输入8.7K”。9027是原实际输入8954加新增估算73，缓存分母则是累计已报告实际输入，两者本就不保证相等，不通过显示格式改写统计。当前源码隔离浏览器已核实上述两行并检查同目录更新后的256K.png，相关上下文3项、UI类型及Biome通过。
