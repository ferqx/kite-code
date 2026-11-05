# Agent Browser：受控代码入口与受监督网页操作

本模块的[扩展入口](index.ts)、[统一执行工具](execute.ts)、[Controller](controller.ts)和[原生适配](native.ts)将固定的 `agent-browser@0.39.4`（Apache-2.0，源码 `04ba5264dade678062c3cdcce0f4f293e748249f`）接入现有 Agent Extension／Tool／Job／Query／Action 边界。Agent 仍使用原 Loop 和权限策略；浏览器不启动另一套模型决策循环。Native 共享页继续由 Main 持有，Job 取得准确页面租约；网页不获得 Runtime／IPC／本机文件权限。

## 范围与可用性

- Native 新 Run 的模型入口由 Service 选择 `browser.execute`，沿[内置 computer-use 技能](../../skills/builtin.ts)指导页面选择、准确控制绑定、观察、操作、核实与释放；浏览器不进入审批，技能不签发控制身份。默认目录、显式旧配置与冻结恢复选择归[Service owner](../../../../../apps/service/README.md#受管-browser-默认装配)。CLI/TUI 的独立浏览器兼容路径保留。
- 兼容 `browser.open` 仍创建受原 Operations 管理的 `browser.session` Job，返回受理身份而不是伪造启动完成。只接受 HTTP(S)，不接受凭据 URL、可执行路径、任意 CLI 参数、脚本、CDP 地址或登录状态路径。
- 兼容 `browser.snapshot` 获取该 Session 已拥有浏览器的当前 generation／seq／元素引用；`browser.navigate`、`browser.click`、`browser.fill`、`browser.scroll` 操作准确目标，`browser.close` 请求关闭。统一入口在宿主内生成这些内部身份，不要求模型维护代次、seq 或幂等 key。
- 原生适配支持 Linux x64／arm64、Bun 下的 PID namespace，以及 macOS x64／arm64、Bun 下的独占 launchd resource coalition。Linux 需要 bubblewrap 和原生 init；macOS 复用固定 stdio guardian 资产，以独立 Browser 身份运行。独立浏览器路径还需系统 Chrome／Chromium 和宿主预查；Native 共享页复用 Main 的 Electron 页面。Windows 仍明确 unavailable，不降级为只杀命令行或进程组。Linux 实现与 macOS 本轮实测分别取得各自范围的证据，不相互代证。
- 独立浏览器默认仅定位固定版本的已安装原生包、受支持系统 Chrome／Chromium 和原进程监督资产。缺失不使应用启动崩溃，也不自动下载浏览器、运行 npx 或开启外部调试端口。可信 Service 可禁用本能力；JSONC 不能供应运行时路径、策略或原始参数。

## 统一执行入口与隔离环境

失败批次保留失败前已有的受限 console output 和原子 Tool 的准确执行身份／状态，模型可以区分已完成动作、失败动作及未执行部分；后续失败不撤销前面的效果。实际 executor 抛错／关闭也通过私有有限错误 carrier 保留原输出，只接受可信 carrier，不复制任意异常 message／cause 或仿造 output。已派发 native 失败保留安全 transport cause，并继续为 `outcome_unknown`，不能据停止代码环境推定网站效果已知。评价错误仍保原 evaluation 类别及反馈，界面与协议版本不变。[执行回归](../../../test/isolated/browser/execute.test.ts)、[executor](../../../test/isolated/browser/executor.test.ts)及[controller](../../../test/isolated/browser/controller.test.ts)核失败前输出进入下一 Model、一次原派发与私有异常负例。

[browser.execute](execute.ts) 的新模型调用接受 `{code,description}`；`description` 是最多10个Unicode字符、非空白的本次动作短句，用于工具行展示，原样随调用保存，不传入代码解释器、不作为结果或控制权证明。内部 schema 保持该字段可选，旧 `{code}` 输入与封存记录不补写，工具版本仍为1。在同一 Store／Session／Run 的热环境中保留顶层 await、变量和页面句柄；同 Run 的批次排队，共用一个 `browser.code_session` Job。Core 提供冻结的总 `resourceCapacity`；总 process 容量小于2时在创建环境／Job前准确 unavailable。代码环境按该 Core 对象共享最多 `floor(process/2)` 张准入票据，创建前可取消等待；同 Run 复用，代码进程真实关闭及原 host 调用达到终态后释放。未确认代码关闭或在途清理保票，不借用或假释放原 Core process permit，也不把已结束的网站业务 unknown 变成跨会话新 fence。环境不能从冷记录重建或重放代码。`browser.open()` 返回宿主签发的 opaque page；`browser.pages()`只为当前Session已在Agent控制下的页面提供可用id。曾成功绑定的Native共享页在确认释放后另可返回`state:released/bindingRequired:true/lastKnown:true`、有界旧URL／标题及本Run当前VM新签发的不透明候选id。它没有旧租约／元素引用，不证明当前存在；列出候选及`browser.page(id)`工厂均不做I/O。新任务首次snapshot才沿原open子调用取得新绑定并实际观察，Controller只从可信transport的真实acquire保留私有pageId／incarnation；Main用这对身份寻找原存活页，URL仅作附加校验，不按可见性或相同网址改投另一标签。缺页、替换或变址直接失败，不新建、导航或刷新；私有身份不进入Model页列表或句柄。绑定前的其它页面方法拒绝派发；旧Run候选也失效。空列表只说明当前没有控制句柄或已知释放描述，不能推断用户浏览标签已经消失。元素引用由宿主映射到原目标与观察 seq，导航、重新观察、接管及代次变化使旧引用失效。按键、选择、悬停、等待、对话框和有限坐标操作由[页面 API 适配](page-api.ts)调用固定后端，没有任意 selector／页面脚本／CDP／Cookie 接口。

已确认释放的共享页元数据按真实pageId／incarnation分别保留，每Session最多8页、最多128个Session；它不保存控制租约，不查询Main库存，不证明页面当前仍存在。新Run候选按目标规范URL选择，不能固定取列表第一项。A后打开B仍须能列出A并沿原identity重新绑定；同URL有多个已知identity时在派发前明确歧义，不以最近释放页或当前可见页替代。旧Controller单页接口保持兼容，unknown及同Run释放门禁仍由原状态负责。

Main对准确existing-only准入确认`browser_page_existing_missing`，且Service已确认原未消费意图终态／取消后，Service才可经Controller私有`invalidateMissingReleasedPage`按原Session／pageId／incarnation退役该条released元数据；不触碰其它页面、旧Run释放门禁或原结果。该失败仍交回模型，不在原调用内重试创建。当前用户任务明确要求打开已知URL、且不依赖原页表单／导航状态时，模型可在后续独立`browser.open(url)`沿普通准入创建新身份，再取新snapshot。原页面真实缺失不恢复其旧状态，也不授权重复已完成或unknown操作；mismatch、连接不可用、未确认清理和原业务unknown均不触发此退役。失败的无控制候选同时从当前解释器句柄表移除，旧句柄准确stale，不能借前批已拒绝的Promise使下一批误停解释器；新明确open仍执行完整宿主准入。

该错误只涉及所选候选；结果说明与内置知识允许重列一次pages，对唯一匹配当前任务的其它候选取得新snapshot，不凭顺序／最近／可见性猜测。真实隔离worker三Run反例核缺失A后的原B仍可在同Run绑定，B原identity及表单值保留，没有额外导航、替代页或输入重放。没有唯一匹配、同URL歧义、原unknown与清理未确认的限制不变；该合同不证明模型每次会选对候选。

普通fresh open仅复用唯一准确URL目标，多个相同URL且没有原页身份时明确歧义；不同URL创建新页，不能通过后续navigate覆盖原用户页。唯一从未导航、从未取得租约的初始空白标签可用于初始化。明确page.navigate继续导航当前准确页，页面上限不变。Browser Job、代码环境与Main网页分别拥有生命周期；控制释放不销毁Main页面，UI隐藏／卸载不释放该页面所有权。

导航、观察、输入和截图逐项沿原 `operations.ensure` 派发独立child Tool，保留真实effects、准确页面／任务／控制权、取消和结果核实；固定内置浏览器定义在三种模式下免审核／审批。批次结果保存原 Command／Execution 与 outcome；请求开始前即登记待清理 Operation。首次打开立即保留原Browser Job ref，未取得绑定句柄或Job仍等资源时可取消准确申请，不能在失败后迟到启动；绑定成功后的显式读取失败不再当作整个打开失败。每批代码在执行前耐久登记原 Execution 意图，重入原未解决批次只返回 unknown。拒绝、失败、取消或未知效果停止后继操作，代码 catch 不能重新获得派发权；中断后的结果从原 child 执行回填，不能用通用 abort 覆盖真实 unknown。

原browser.open返回starting后，统一入口等待准确Job准入、同browserId和导航完成的agent状态，然后直接交付opaque page，不强制隐藏的首次snapshot。首次观察由调用方显式请求，失败只结束该批；Root取消／未完成打开仍清理准确原申请，原Job失败或unknown保原ref与结果，不缩成通用not_ready。真实启动继续使用原transport期限，无额外5秒句柄期限。

首次导航已派发但未确认时仍为原`browser_startup_outcome_unknown`，不因Main已显示网页、代码环境退出或进程清理成功改写。原Job终态的`details.startup.phase:navigation`准确标记这条失败分支；仅对可信`BrowserTransportError`保留有界机器码`cause`与原`dispatched`，通用异常、任意适配器原文和长消息不进入诊断。该字段帮助分辨导航等待与页面准入问题，不判定页面已关闭、不消除原unknown或授权重新打开。

首次Native导航unknown与真实清理unknown分开判定：Controller在可信transport.ready时先私下保留Main acquire的准确pageId／incarnation，不等导航ACK，也不提前宣称agent。原Job必须先确认stop及dispose；`releasedSharedPage`仅在这些清理完成后提供Main release的被动实际URL／标题及原identity。Controller严格比对ready早存身份，只为首次导航未确认、从未进入agent／派发业务输入的原页保存pending恢复描述；释放确认时已取消仍无此回执，已确认缓存则不因后续Job signal结束被getter撤销，完整dispose后只读交付；原Run还须沿完整owner身份核为completed／failed／cancelled且非active，新Run才能激活。原Job／Tool及view的unknown不改写，Core原资源完整性不放宽。

Native的导航／URL／标题结果现交给持有准确WebContents的Main，由Service沿原transport映射为既有success/data；不通过固定daemon导航后的Runtime metadata辅助读取。Main原始Page.navigate只派发一次，真实就绪和完整原页回执另核，未知不重放。Native preview capture前后metadata也经可信`attachment.readPageState`共用Main原生事实，原capture集合、取消、期限和cleanup门禁继续生效，callback不进入daemon或模型。独立浏览器没有这个回调，保持原固定后端行为；现有snapshot／AX／元素处理与Controller原引用失效不变。当前接线与离线／实机资格分别归[Service](../../../../../apps/service/README.md)和[Desktop](../../../../../apps/desktop/README.md)。

共享Native同页初始化的内部url结果同时保留同次Main receipt的title，沿Controller既有消费者避免空初值覆盖已释放页描述。当前title为空仍保空，不拿旧标题或其它页填补，不增加额外读取或公开API；on-demand snapshot／scroll本身不负责刷新标题。Controller反例覆盖新非空／合法空标题及URL／identity漂移拒绝。

该候选额外标记`observationRequired:true`，URL是Main释放时实际地址，可能已重定向；它仍不是当前存在证明。恢复未激活或首次新snapshot未成功时，其它URL的open（包括原unknown请求URL）在Service远端意图前和Controller Job backstop拒绝为`browser_page_recovery_required`。只允许沿现有existing-only合同重新绑定准确原identity／actualURL，不能新建、刷新或重发导航；相同URL的其它已知页仍按原歧义拒绝，不特殊优先或改投。Controller在新snapshot成功前另拒绝输入、导航、截图及旧坐标，返回可读`browser_page_observation_required`；snapshot失败或再次释放不清掉门禁。新snapshot成功后仅按当前新任务恢复正常操作，不追认旧导航或重放其业务效果。业务输入unknown、进入agent后的导航unknown、独立浏览器、真实cleanupunknown、未取得准确release metadata或原Run未终态均无此恢复路径。原恢复候选后来确认缺失也不借普通missing退役清除其原unknown fence；旧历史缺少身份或回执不能补造新证据。

Native默认不装配request_human／human_wait／respond_human／Resume及人工完成条件。自动化完成或需人工时page.close释放控制并正常final、保留网页，用户下一条新消息用新Run重新绑定同页并显式snapshot；不创建人工等待、不轮询pages／task.events。旧显式standalone及历史人工记录仅按原兼容和安全收口边界保留。准确注册的builtin.browser@1能力由可信分类携带免审批标记，Service和Workflow投影保留真实effects，不伪装safeRead，不创建页面Question。旧asking／refusal／unknown不会转成新grant。默认装配与原证据归[Service owner](../../../../../apps/service/README.md#受管-browser-默认装配)。

全局API资源现准确说明pages同时投影活动句柄与其他released候选，但每个任务仍只绑定一页。真实HTTPS新URL流程中，Model为核实另一保留页而直接snapshot候选，收到browser_page_already_open后误称无法确认原页；Main实际保留了两页。该已知拒绝现说明当前任务已有绑定、候选未取得控制，不能推断页面丢失或关闭。技能指导完成当前页、close释放并正常final；下一用户消息才以新任务重新绑定，不把close当同任务切页，也不要求审批／人工交还或Continue。结果说明只改文字，不改原outcome、dispatch、操作或未知结果，未增加API、工具或协议版本。

[执行器 leaf](executor/index.ts) 当前仅提供 macOS Seatbelt 后端。生成代码运行在独立的固定 Bun worker 中；REPL 是语言设施，安全边界是 OS sandbox。固定策略拒绝网络和 fork，不授予 Workspace、Profile 或任意文件写入；系统读取只限 `/System/Library`、`/usr/lib`、`/usr/share` 等明确运行依赖与准确 Bun／worker 资产，不放行整个 `/System`。环境只接收必要的隔离 HOME／TMPDIR 和时区，没有宿主凭据。子进程通过有界 NDJSON 请求宿主 API，宿主不信任 worker 自报的完成、序号或方法。缺资产、平台或隔离条件时准确 unavailable，不回退普通进程、Shell、Node vm 或 Worker 线程。

普通脚本异常和宿主确认的调用前参数／引用错误、已落定的 child Tool 失败，只封住当前批次，不自动销毁已取得的页面及解释器。宿主仅在原调用链结算、pending／waiting归零且原进程经内核确认SSTOP后返回可恢复失败；沿宿主私有错误身份分类，不信任worker报出的错误文字。下一批保留变量及同一Browser Job，仍核准确控制范围，并须重新观察、核对先前实际效果后只做剩余步骤；没有自动重放。首次打开尚未取得绑定句柄仍清理原申请；取消／控制释放／结果未知及进程故障分别收口，预算或协议故障先停止并隔离代码环境，Browser Job保有自己的任务与监督责任，原unknown不改写。代码的catch及已排队调用不能越过本批失败闩锁。

worker用私有求值来源隔离批次：旧timer／Promise不能借后续批次身份调用浏览器API或归入其输出／诊断。旧JS回调仍可能在下一次恢复进程时运行并改变共享变量；此机制不是清空回调队列或安全沙箱证明。真正的权限与暂停边界仍在宿主及OS。私有done.pending只可否决复用，不能证明宿主调用结算或原进程已停止；工具及协议版本保持原值。UTF8代码大小在环境／批次准入前核对，过长中文输入不会关闭已有环境。

统一入口的单次snapshot返回值另按实际UTF8 JSON字节限制为48KiB，留出Host结果和worker最终值帧的原预算；正文、URL／标题及元素过大时保有界前缀与完整可容纳元素，准确标记truncated，仅为实际交付的元素登记opaque ref。普通小快照保持原内容。不能按字符数估计长中文、转义字符或emoji的消息大小，也不提高执行器帧／输出限额。内置资源只指导使用elements中的宿主ref，快照文本的后端eN标记不是页面方法参数；示例只返回相关文本及少量元素，避免完整日志超过单批输出预算。

当前单批代码最多 16 KiB、32 次 API 和 16 KiB 文本输出；默认运行预算 15 秒，可信上限 30 秒。宿主核原 root 的身份与内核 CPU 时间；API 等待及批次返回前以原 audit token 暂停该进程并确认内核 SSTOP，下一批准入后才恢复。Host等待不消耗已暂停代码的wall预算，运行死循环仍受预算及硬停止约束；伪造 done 不能让代码在批次之间继续执行。原 guardian 的环境累计 stdout／stderr 64 KiB 限额继续适用。这些限制不承诺代码进程或浏览器总内存的硬配额。

固定 Bun REPL 的顶层 await 拒绝可能分块写入诊断流。worker 在首个诊断块立即封住该批 API 派发，只收集当前事件循环内最多 2 KiB，再提取最多 512 UTF-8 字节的标准错误类型与消息；ANSI、代码帧、栈和任意拒绝对象不进入模型。无法提取时使用固定 `browser_executor_evaluation_failed`，不把不完整的 `Uncaught:` 当成完整原因；原结果帧和协议版本不变。[真实隔离执行器回归](../../../test/isolated/browser/executor.test.ts)核分块拒绝、后续批次恢复与隔离边界，整个文件19项111断言通过，不代替客户端流程。

`browser.code_session` 复用原 process slot、Job 取消与绑定保留；独立 Bun 由[原 Darwin owner](darwin-owner.ts)及同一 stdio guardian／coalition 监督，不新增 Agent Loop 或进程监督引擎。代码环境close只终止VM及当前在途子调用，不取消已绑定Browser Job。Browser Job通过受信Runtime来源沿有限父链绑定原Run，自己监督原任务结束／取消并准确stop／dispose；预览间隔不延迟该监督，on-demand不因此增加捕获。新Run在任何VM／process准入前调用Controller.prepareRun，等待旧终态Job的真实stop／dispose再复核，避免旧lease／引用和容量2自等待；原unknown拒绝替换。明确close／用户接管后，同Run不能重新acquire，新消息的新Run才可复用同页；纯VM故障不等于页面释放。代码停止不能把原网页unknown改成成功，也不靠只读onRunEnd补造资源释放。Main 原页面是否保留及真实租约状态归[Desktop owner](../../../../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)。

PNG 与 JPEG 采集共用在途 capture 集合；关闭证明等待截图读取、文件关闭和删除完成，取消后不交付迟到图片，文件关闭未知继续拒绝释放资源。

正式视觉观察使用 `page.screenshot()`：内部 `browser.image` 取得 PNG 并发布原 child Artifact，外层执行器读取准确来源、重新发布到自身 Execution scope，经[原 Tool 图片校验](../../tool-images.ts)返回 `artifactRefs/modelImages`。文字路径、Base64 和 UI JPEG 预览不算模型视觉输入；图像宽高、CSS viewport、导航基准及 Main 的 capture proof 单独核实，有限坐标操作只接受准确图像引用。`ModelMessage.images` 与 Responses／Chat Completions 的 wire 配对继续归[AI owner](../../../../ai/README.md#图片消息)，不新增用户 Command、批准或 Run。

2026-10-28 macOS／Bun 的[包外制品回归](../../../../../tests/isolated/unified-agent/built-package.test.ts)实际按 manifest 构建全部入口，从源码外导入 locator 并用包内 worker／guardian 启动隔离执行器；两批顶层 await 保留 var／let／const 与页面句柄，受限宿主在一次代码调用内只收到准确的 open／snapshot／fill／snapshot／click／snapshot，第二批仍保留变量与句柄。直接读取合成外部文件被 OS 拒绝，实际 close 返回 confirmed:true；整个文件1项76条 Bun 断言通过，另有真实 Runtime 单批开页／观察／填写／验证／关闭回归核每项独立原权限与父执行来源。此证据没有客户端 Main 或外部模型，不代替修后 Native 流程。

已保存的网页 Tool 失败、异常或未知只结束该代码批次的依赖动作，作为原结果交给 Agent Loop，允许后续模型说明；不因工具异常取消整轮，也不自动重放未知效果。代码 JS 的 catch 不能越过已锁存的 blocked 结果。解释完成不解决原网站 unknown，原 Browser Job 的资源及监督继续独立保留；全工具的底层边界见[Agent owner](../../../README.md#同一-step-的并行工具批次)。

统一入口的[失败说明](result-explanation.ts)只转换最终ToolResult的展示内容：页面缺失／变址、失效引用、读取失败、控制连接丢失、响应数据超限或前次清理未确认，先向下一Model说明含义，再保留简短诊断码；原outcome、Operations、派发事实、原结果和机器原因均不变。只有固定宿主结果envelope可供分类，不从网页正文、脚本错误文字或任意嵌套对象推断关闭原因。响应超限明确本次结果无法在限额内返回，不据此推断页面关闭或连接中断，不抹掉先前操作的结果。无法确认的连接错误只说明可能关闭／不可用／连接中断；unknown明确最后动作可能已完成，禁止重放、换key重试或自动创建替代页。缺失／变址的existing-only绑定保持零新建、零刷新、零导航。VM准入前遇原cleanup unknown也保留其可信原因与unknown，作为原ToolResult交给Loop说明，不能通过格式化解开安全fence。

Main对准确已销毁原页签发的`browser_page_closed`另明确说明原页已关闭、原句柄不能继续读取或控制，不推断由谁关闭，也不撤销已完成动作或授权替代页。进行中读取或输入的Host原boundary仍分别保read_failed或effect_unknown；后者继续保未知与禁止重放。显示层不把正向资源清理回执当业务成功，也不从任意嵌套网页文字制造关闭结论。结果说明文件25项198断言通过，核failed／unknown原结果、Operations与派发事实均不变；完整真实闭页流程归Desktop owner。

首次绑定／导航尚未确认就失联，也沿原startup unknown向下一模型说明；文档未就绪的观察说明仍在加载或导航未完成，读取期间目标／控制变化明确旧引用不可用，不把两者误写成连接中断或先前输入没有执行。对话框决定可能已生效但原生清理未确认时，不把旧dialogRef扩成新框的处理权。Runtime原Job被包装为job_stop_unconfirmed时，宿主从Core原Execution核实browser.session@1、内置扩展及准确ref／execution身份，才在固定actualResult信封中读取已有browser_stop_unconfirmed并给说明；原wrapper码、结果和修订保留，不重建已经丢失的启动原因。旧无身份信封不补造来源。技术browser.code_session的cancelled只表示代码环境清理，文案明确用户是否取消与网页结果应沿原Task／Browser operation核实，不由技术停止推定。真实隔离worker／Runtime／SQLite与固定模型的相关集合70项877断言通过，核两Run缺页／变址、在途输入、首次导航失联及真实Runtime停止包装的下一Model可读说明、原结果／修订不变与零替代／重放；此处没有在线模型或真实Native窗口，不代替Desktop关闭过程验收。

## 权威与生命周期

`browser.pages()`在当前页受控时仍同时列出其他已知释放页；当前页复用准确browserId／generation对应的句柄和refs，其他条目只有惰性existing-only候选权限。Controller仅在列表投影按完整pageId／incarnation排除当前页的旧描述，不按URL合并同址不同页，不改变内部歧义或unknown判断。当前页加最多8个释放候选共享原48KiB UTF-8值预算；候选在另一页仍受控时不能派发绑定，原单页控制与新Run再绑定要求不变。真实HTTPS的A／B原页均保留、active列表却漏掉另一页的实测反例，已由64项889断言的真实worker文件及56项526断言的Controller文件覆盖；这不是Main关页，修后在线结果仍归Desktop owner。

全局computer-use指导区分新工作打开指定URL和继续原页：新目标走原`browser.open`，不等待不存在的释放候选；原页继续走新候选与首次snapshot。空列表不说明手动页已消失，不以重复轮询代替任务，也不允许绕过已知缺页或cleanup unknown门禁。该分支澄清只影响指导正文，准确目标绑定、Tool定义／协议、旧结果和权限均不变。

普通Tool／Action仍沿原派发事务，浏览器免审批不解除硬能力或准确控制边界；Session范围来自Host上下文，不来自页面或 renderer。`browser.session` 持有实际进程、资源许可与 Run binding；退出和取消必须有监督证据。关闭面板、切换会话、隐藏窗口只停止观察，不关闭后台任务。onRunEnd 不承担资源清理。

`browser.open` 通过原 `operations.ensure` 绑定准确 key／URL 和 Job 申请；其余 Tool 与人工 Action 通过原记录 CAS 绑定输入摘要，先耐久写入 pending，再发出操作。相同 key 的完成结果可重读，遗留 pending 或输入冲突不能再次派发。上游请求 id 不是幂等键。发送后丢失响应、超时或取消不能当成未执行，更不能自动换 key 重试。关闭浏览器只能证明进程停止，不能撤销网站已经收到的提交。

上游 `pause` 并不停止执行，CLI 退出也不意味着 daemon／Chrome 结束。本模块不将二者当成停止证明；人工接管先禁止新的模型动作并更换 generation，等待准确在途边界后重新获取页面状态。未确认清理保持 unknown，由原 Runtime 保留资源而不是假释放。

## 右侧观察与人工操作

`browser.view` 只读返回 `application/vnd.kite.browser-view+json`：不透明浏览器身份、generation、控制 seq、状态、URL／标题、有限最新 JPEG 与有限元素标注。它不启动、导航或恢复浏览器，不向 renderer 暴露 socket、CDP／WebSocket 端口或宿主认证材料；页面像素和文字本身不保证已脱敏。Native 沿现有受范围校验的 Extension 查询及 Command 流读取／提交；没有新增绕过审批的输入通道。

统一 Native 执行链由 Service 核准确 `browser.execute → browser.open → browser.session` 来源后选择 `on-demand`：普通观察请求上游 `snapshot interactive:false`，保留正文和元素的完整语义快照路径，并明确字符串／元素截断；它不等于任意 DOM、隐藏字段或全量页面脚本读出。refs全量校验后按快照中真实ref的首次出现顺序保留至多200个元素，合法但未在正文出现的ref稳定排序补尾；正文里没有对应refs项的标记不产生可操作引用。输入前用同一有界顺序重新核当前ref的语义身份，不因refs对象字典顺序及后续节点增长随机丢掉顶部目标；真实身份变化仍拒绝。正文65536字符、统一入口48KiB及其它输出预算保持。该路径不启动旧 300ms 自动捕获，也不在每次操作后同时取 DOM 和图；实时控制装饰由 Main 的控制／输入状态维护。需要冻结备注或正式图片时才执行对应捕获，`browser.view` 的 frame 可以为空。

旧 `preview` 路径继续使用有界、单路、最新 JPEG 观察，不记录持续视频，也不保存每一帧历史。frame.seq 与元素／控制 seq 不同：纯像素变化不应让同一有效元素永久失效；页面导航、元素语义／几何变化和观察失败必须使旧引用失效。Native 隐藏、遮盖、卸载时停止 UI 轮询并释放读取句柄；已有命令的结果未知仍查原 Command，不能重发。

旧受管预览面板的人工导航、点击、填写和滚动仍使用准确 browserId／generation／元素 seq 的普通 Action；Native 共享页交还后的普通输入由 Main 页面 owner 处理。点选备注是选择标注引用，不会把选取动作传给网页点击。用户说明连同页面、元素、帧来源进入当前 Session 的受控聊天草稿；页面文字仍是不可信内容，不产生授权。现阶段不是完整桌面远程控制或 Office 控制器，也不声称具备系统鼠标接管。

## 填写内容与隐私

Tool元数据区分浏览器身份与一次输入意图的key。`generation`是不透明值，首次快照可省略未知generation，由Host取得准确所属值并等待原启动；不猜数字或starting状态。不同读取或改变输入需要独立key，同key保原结果或冲突。未知网站操作仍不能用新key重试；此说明补充未改变校验、去重、Tool版本或协议。

`browser.fill` 和人工 `browser.input` 的 `fill` 都是普通 Tool／Action 输入，填写值会进入原 Command／Execution 的耐久会话历史；它不是仅留在网页内的秘密输入。临时独立 Profile、私有 socket 或不保留逐帧视频，都不能使这条路径成为凭据安全通道。当前不支持用它填写密码、验证码、API key 或其他凭据；Native 面板在填写入口显示同一警告。没有按字段类型自动识别或删除秘密的保证，不能因网页使用 password 字段而推定输入不留存。

页面 URL／标题、元素名称和快照也可能含敏感资料；它们是低信任工具结果或明确选择的聊天引用，不产生授权，不另复制到运营观测。聊天引用只进入当前草稿，用户发送后才沿普通消息保存。页面登录状态不导入用户日常浏览器，也不提供恢复登录状态文件的入口。

## 原生适配边界

版本固定的内部 foreground daemon 与私有 NDJSON 通道在此 leaf 内适配，不向 Agent 暴露。它与普通 CLI 自动后台启动不可混用，否则上游可能重启 daemon 并改变所有权。每次启动使用自有私有目录、确定版本／会话身份和完整树停止证据，不能依赖 PID 文件或原根进程退出推测 Chrome 子孙已停止。

Linux PID namespace 与 macOS coalition 都是进程所有权机制，不等于网页文件系统安全沙箱；上游在部分 root／container／CI 情形会自动关闭 Chrome sandbox，原生预查拒绝这些宿主或无法核实的系统信息，不静默放宽。原生环境是固定白名单，不继承宿主认证、插件、CDP 或任意 `AGENT_BROWSER_*` 配置。每次启动独立 0700 目录，将 HOME、TMP、XDG、Profile 和下载定位到该目录；完整停止、句柄关闭和原目录身份确认后才删除，清理未知保留原 owner／目录及名额。

macOS 的 [owner](darwin-owner.ts)复用同包已构建的 stdio guardian，通过独立 `--browser-owner` 分支、`com.kitecode.browser.<UUID>` 注册与本次 nonce 保持 Browser 身份；没有 MCP Session、MCP Tool 或额外模型循环。Service 的直接子进程只做 broker，改变 cwd 与 launchd 启动仅发生在它内部。新 guardian 必须核独占 coalition 初始 task count=1；就绪核 broker／guardian／daemon 的准确 PID、birth、父身份及 coalition unique ID／pidversion。Darwin 的 `session_info.backgroundPid` 匹配真实 foreground daemon 的宿主 PID，Linux 仍匹配 namespace localPid。终态须原 daemon 实际 exit/reap、准确 coalition 清空、guardian 真实消失且其 exit 保持 null、原注册移除、broker exit0/reap 与双流 EOF／FD关闭；注册缺失本身不证明树停止。启动失败或清理不确定继续保留 owner、目录与名额，不以晚成功覆盖 unknown。取消期间第一个合法 ready 仍须严格验证并保存原身份，以便校验随后终态；public ready 保持拒绝，不派发业务请求。损坏／截断控制帧、终态后额外帧与伪造 guardian reap 都使结果 sticky unknown；取消超时已发布 unknown 后的迟到证据不使其恢复。独立故障回归覆盖这些边界。共享 broker 的 guardian 通道须唯一完整 terminal、有效 UTF-8、所有先前回调完成、EOF及通道关闭后才发布终态；terminal 后2秒仍缺 EOF／close 即失败并保留原资源。复用取舍见[记录](../../../../../.agents/notes/implemented/architecture/2026-10-27-darwin-browser-owned-coalition.md)。

[Darwin 目录扫描](darwin-storage.ts)使用持有父 FD 的 `fdopendir/readdir/fstatat(AT_SYMLINK_NOFOLLOW)`，仅以 `openat(O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`进入子目录并核 dev/ino。不使用 `/dev/fd` 或绝对路径重开来模拟 Linux `/proc/self/fd`。逐项预算、32层、4096项、256MiB与500ms停止门槛保持，定期让出事件循环；关闭失败保留原句柄和动态库并使清理 sticky unknown。它是采样停止保护，不是硬配额。[真实 Darwin 回归](../../../test/isolated/browser/darwin-storage.test.ts)核 symlink、inode替换、容量及关闭未知；Linux 仍保原扫描路径。

[原生实现](native.ts)的当前限制如下，均不构成 OS 磁盘／内存硬配额：

| 对象 | 当前实现 |
| --- | --- |
| 原生同时准入 | 同一进程最多 2 个；未确认清理不归还名额。Controller 每 Session 只持有一个浏览器。 |
| 生命周期 | 10 分钟后请求整树停止；daemon 配置 5 分钟空闲超时。期限不代替实际退出证明。 |
| 私有目录 | 约每秒采样；超过 256 MiB、4096 项、32 层或单次扫描 500 ms 时请求停止，不跟随子项 symlink。采样间隔及停止期间可超限。 |
| 原生通道 | 单路请求；默认请求 128 KiB／响应 512 KiB，可信注入上限分别 256 KiB／2 MiB。启动默认 10 秒、请求默认 35 秒，可信上限分别 60／120 秒；发送后超时保持未知。 |
| 预览 | 最新单帧 JPEG 最大 96 KiB（Base64 128 KiB）、尺寸不超过 1920×1080，最多 200 个标注；实际启动 viewport 为 960×540。捕获失败清空帧并使引用失效。 |
| 其他输出 | stdout／stderr 合计超过 64 KiB 请求停止；可访问性快照最多返回 65536 个字符串 code unit，并明确 `truncated`。 |

Chrome 仅设置 32 MiB disk cache／8 MiB media cache 参数，不承诺浏览器总 RSS、CPU 或硬盘占用的硬上限。固定上游 daemon **没有禁用自动站点下载**，配置的下载目标是私有目录，受上述采样停止保护而非硬隔离配额；没有 download Tool 不等于禁下载。

## 验证与尚未取得资格

2026-10-29工具可靠性修复的最新真实隔离worker／Runtime整文件为41项414断言通过；未变的执行器27项137断言及通用Loop16项133断言结果复用，共84项684断言，无跳过。覆盖已知脚本／参数／旧引用／读取失败后同解释器及原Browser Job继续、捕获异常与排队零误派发、未知原结果、超时／取消、旧异步来源、UTF8代码准入，以及65536字中文加转义／emoji／长元数据的快照直接作为最终值仍有界。它不启动Native窗口或付费模型；修后实时资格仍待核实。

[统一入口 Runtime／SQLite 回归](../../../test/isolated/browser/execute.test.ts)覆盖同 Run 持久环境、并行模型批次顺序、原 child Operation 权限与 provenance、拒绝／旧引用／unknown 的后继零派发、初次观察失败与资源排队取消、Run 结束和取消收口，以及正式 PNG 的外层 scope 和下一模型请求。[执行器 OS 回归](../../../test/isolated/browser/executor.test.ts)使用隔离本机 Bun／Seatbelt，核持久变量、死循环／取消、原身份暂停、伪造帧、跨 scope、文件与同 inode Data 路径拒绝、本地 TCP／Unix 正对照及父进程强杀；它不启动 Chrome、Native UI 或付费模型。两类证据不能代替当前源码的实机或发布资格；普通客户端、模型、窗口与既有失败／unknown 的准确状态只在上述 Desktop owner 维护。

[Controller 回归](../../../test/isolated/browser/controller.test.ts)与[真实 Runtime／SQLite 回归](../../../test/isolated/browser/runtime.test.ts)断言无副作用 Query、原 Job 生命周期、同 key 去重、外部 scope／旧 generation 拒绝、人工接管竞争、未知结果及清理保留。[原生协议回归](../../../test/isolated/browser/native.test.ts)使用替身进程监督和内存 socket，核版本／会话绑定、消息限额、沙箱拒绝、目录采样和未知清理；[资产回归](../../../test/isolated/browser/assets.test.ts)核固定依赖与包内资产。测试存在及断言范围不等于本次执行通过。

[扫描故障注入](../../../test/isolated/browser/native-resources.test.ts)用独立子进程的替身句柄核 ENOENT 竞态、EACCES／打开失败、目录与文件关闭结果未知、扫描停滞后的停止与资源保留。原生协议替身另核不支持平台在创建资源前拒绝、分片 UTF-8、损坏／多余响应、派发前连接失败与派发后写入失败的区别，以及迟到就绪／成功不能复活已取消操作。加速定时器只验证决策与状态，不证明真实 OS 时限、硬配额或平台实现。Desktop 替身回归核多轮接管、换会话后迟到回调、迟到帧和丢失成功响应后仅查询原命令；不将这些测试视为实机资格。 [A→B→A 联动回归](../../../../../apps/desktop/test/isolated/agent-browser-session-runtime.test.ts)连接真实 Runtime／SQLite、NativeExtensions 与 Observer，仅替换模型、浏览器 transport 和桥接端口；A 的导航尚在派发时切到 B，不取消 A 的操作或 Job，A 在后台完成后回到同一 browserId 读取原结果，且无重复启动／派发。

[Service owner](../../../../../apps/service/README.md#受管-browser-默认装配)维护默认目录、禁用硬上限、恢复配置摘要与私有目录保护；[Native owner](../../../../../apps/desktop/README.md#agent-浏览器观察与人工操作)维护同一 Main 观察身份、隐藏与卸载、选择备注和准确命令结果查询。

原云端阶段没有取得真实 Chrome／Electron 资格。2026-10-27 的 macOS 27.0.1／arm64、Bun1.4.2／Node22.21.1 本机隔离恢复基准为 `982db30e2cb692a0a499e20f0f6fffbc7ea35b16`（tree `72beb60ca455dc6d6580fb6524e074994bc2c62f`）。原实现先实测为 `browser_native_platform_unavailable`；随后增加上述 Darwin 接线。当前 Browser／Service／Desktop 的14个定向整文件57项、419个外层断言通过；Agent／Service／Desktop类型检查、Agent完整构建通过。原生Linux替身在Darwin上的短 canonical 临时目录及 proc-fd 模拟只修测试执行条件，不授予Linux原生资格。

本机真实 Runtime／SQLite／Desktop observer／Chrome 已沿本地无凭据页验证打开、快照、接管、选择备注、点击、普通填写、下滚／上滚、交还和显式关闭（44断言）。A导航等待本地页面时切B，A后台完成后回到同一browserId，只有一次启动与一次目标导航。真实取消、准确daemon强杀后恢复及Service退出另83断言通过；独立libproc读取观察到的daemon／Chrome／helper均属原coalition，参数无 `--no-sandbox`，最终核完整树、注册、FD与会话子目录清理。空的受保护基目录可以保留。首次Documents资产布局的guardian认证超时保unknown；后来一次Chrome launch超时取得confirmed整树清理；两次原始失败均保留，不重写为成功或重放未知输入。

Browser 目的的父进程正常退出（broker stdin EOF）及准确父进程 SIGKILL 另做真实 Chrome 验证：由一次 ps 父链快照取得有限的 broker／guardian／daemon／Chrome 后代 PID/birth，后续独立核对这些已观察成员消失及准确 launchd 注册缺失。这不是原 coalition 全部成员的独立终态枚举证明；实现实际调用 coalition stop，与该有限观测分开陈述。原 Runtime 已死亡，不能补造终态回执；两次会话目录保留，未由外部观察冒充 Runtime 已确认释放。

共享guardian／Service／启动失败三个整文件最新18项220断言通过。MCP双会话孙进程存活断言此前两次失败，后续诊断与完整新文件通过；恢复提交的原guardian／launchd完整文件8项132断言也通过；另在同一原测试文件路径核未修改基线也是8项132断言通过，结束后原测试字节已恢复。原失败未删除、未降低断言，其间歇原因尚未定位，不能据最终通过断言原失败与改动无关。上述结果仍不证明Linux原生、Windows或正式安装制品；客户端真实模型与窗口的独立范围归[Desktop owner](../../../../../apps/desktop/README.md#agent-浏览器观察与人工操作)。没有真实账号网页登录、外部表单或凭据填写。

上述44／83断言、父死亡以及真实窗口／gpt-6-luna通过均发生在最后控制校验加严与共享内层EOF修正之前。截至v1审查包保存时，最终代码只取得mock／静态检查证据，真实复验尚未执行：一次过严broker字段检查安全拒绝后原Job保unknown，原准确guardian／daemon／coalition／label绑定未保存，目录保留；字段已纠正，但随后新实机启动被自动审批拒绝且没有重试。当前查不到原broker及Browser注册不能补造历史整树confirmed。共享内层修正对Shell／MCP也只取得fake通道回归，没有把此前间歇失败归因于本次发现。

随后用户明确允许保留旧unknown并另开一个受限实例，2026-10-27 05:33 UTC以v1包一致的owner／native／guardian／broker源码重新构建私有guardian（SHA256 `ccc9c031d76f02b9fc00035dee7d346582f78608f61143e836defb75d2fe21ee`），仅一个真实Browser owner完成ready、本地无凭据页、可访问性快照及960×540标注帧、准确原signal取消、完整terminal及dispose。原daemon exit/reap、guardian exit=null且absent、原coalition taskCount=1、原注册移除、broker exit0/reap、FD关闭均confirmed；17个运行时采样身份随后absent，准确label print113，会话子目录清空，旧unknown目录身份保持。采样是非原子观测，完整树证明仍来自原guardian的coalition终态。正式35秒请求／10分钟生命预算未改变。此最小native闭环没有Runtime／模型／Desktop；追加的“切B期间A继续自主调用后续工具”要求在此实例关闭后才收到，未另开owner，当时最终v1窗口／模型A-B验收仍缺，共享Shell／MCP也未重新实机运行。

2026-10-27 05:53 UTC另按后续明确授权，以同一v1源码和重新构建guardian进行一个新受限真实Native窗口／gpt-6-luna后台轮。A慢导航在途时05:53:33.830选B，并在61次aria-current采样中一直保持B，至Run于05:53:49.907 completed、05:53:50.031在B观察确认。切换后模型新发fill、click、down/up scroll和最终snapshot共5个Tool，全成功；服务端独立记录填写值、一次点击、scrollY500→0，页面初始及慢导航各一次，一个Browser Job／owner，无后台取消或重启。最终回复含KITE_FINAL_BACKGROUND_DONE。

同轮切换前一次snapshot使用browser_id及generation=??，被invalid_tool_arguments在派发前拒绝，模型正确修正后读取成功。driver把“全轮每个Tool都成功”作为总断言，因该已知失败退出1，未执行回A辅助画面或UI结束按钮；不将整脚本称为通过。只读独立校验确认用户要求的后台新动作／真实页面效果／任务完成主条件。随后Service正常关闭沿准确原Job取得cancel stopped、terminal supervision=ended及dispose；冷Job回执确认owned process-tree cleanup，17个采样身份absent、准确label113、目录为空，旧unknown未动。没有为补辅助步骤重开或重发模型。
## Native 共享页面候选

[Native attachment](native.ts)只接受受信装配提供的短期单页loopback连接，公共Tool不接收CDP URL、target或Profile；固定provider接现有页面，不启动独立Chrome。Job拥有daemon/provider与租约，不拥有Main的共享renderer。原监督/未知保留/预算继续适用；[Controller](controller.ts)在确认handoff/resume前不更改控制权，共享页不重置viewport。默认非Native的独立Browser owner路径保持。新增[Controller回归](../../../test/isolated/browser/controller.test.ts)与[native假进程回归](../../../test/isolated/browser/native.test.ts)仅证明各自断言，不证明最终Native产品；部分交付边界见[Desktop owner](../../../../../apps/desktop/README.md#普通页面控制租约候选2026-10-27未发布)。

## 异步人工交接候选（未发布）

本节保留旧显式standalone协调器、历史记录和当时的失败原因；Native默认已按用户2026-10-29要求撤下这套人工等待／Continue流程。下文2026-10-28各阶段证据不代表当前默认装配，浏览器固定能力现均免审核／审批；旧记录仍不得改写、恢复来源或未知效果不得放宽。

旧显式装配使用[Browser人工请求协调器](human-async.ts)：`browser.request_human` 先确认让出页面，再将准确的Tool/Run、Store、主体、原work/selection、human generation和最多10分钟的有效期写入扩展记录，返回 `pending requestId`。原模型可继续不依赖网页的工作；人工模式拒绝网页操作和Model snapshot。`browser.human_wait` 只持有有限响应结果和原配置绑定，不持有页面、daemon或新的进程；原 `browser.session` 仍拥有这些资源。注册失败不自动抢回人工控制。旧[长等待实现](human.ts)只供已有诊断回归，不是当前Native Service装配。

007真实开发客户端进一步复现：模型已真实交还，但额外信息提问失败后正常final使原Run completed，人工继续因此失去接收方。当前在返回pending前写入不可变 `run/<actualRun>/browser-human/<originalToolId>` completion obligation；Browser自定义conditions核原Job、Tool／browser.execute祖先和原Run／selection／resultRevision接纳。模型可说明等待并结束本次生成，原Run保持waiting_execution，不需要另发问卷或工具轮询。Job已成功终态但原 `result.include` 尚未被接纳时仍等待，防止自动消费提前派发Model；该自定义kind不进入Task的operation_result自动结果路径。实际相关continue／stop通知接纳后，才在同Run请求下一Model。失败、取消、过期或未知准确结束等待，不假造人工回答。

用户的“继续并通知 Agent”调用独立鉴权的 `browser.respond_human` Action；模型或nested Tool不能冒充它。回应核准确请求revision、原活动Run/work/selection、主体和页面代次，明确恢复或停止后，使用该真实响应Job的终态经既有 `result.include` 一次投递到原Run。此API生成有原Command/sourceIds的user-role结果引用标记，说明所附结果是untrusted context，不是用户手写消息，也不是伪造 `input.steer` 或协作 `after_turn`。重复/过期/换Run/取消不恢复；原Run结束时不自动新建任务，UI提示需要新指令。冷启动不恢复热请求、Job或旧授权，仍需准确历史状态与新的明确操作。

010真实Auto继续曾错误回退到人工审批：Service只在原Run配置中提供自动审核器，而独立Action原来使用全局空审核器。[私有来源封印](../../execution/host-control.ts)让旧显式回应从准确人工请求取得原Run，`browser.resume` 从Controller持有的原Browser Job逐层核open／可选execute祖先；[Runtime](../../runtime.ts)保留准确活动Run的配置租约，[Host](../../extensions/host.ts)仍使用原Action定义、当前硬权限和派发read set。当前浏览器审批豁免不再运行该审核器；缺失、取消、过期、换页或换selection的来源仍拒绝，也不能借同Session的新Run。真实派发后的有限转换补偿不因移除审核而省略。

修后010实际调用到原审核器，又暴露用途只有不透明ID，以及正常 `running → waiting_execution` 被整份PublicRun stamp判旧。当前准确原任务正文、原人工请求原因与本次只恢复控制／通知的效果进入既有 `target.source`，明确仅是上下文数据，后续网页操作仍独立鉴权；不强制审核allow。只有私有可信continuation对其准确原Run的读stamp投影身份与isActive，仍返回原PublicRun，其他Action完整stamp不变；Runtime每个边界继续核取消、结束、work、selection、Job和记录CAS。先红后绿核真实checker实际收到用途、审核中正常进入等待时一个Action／一次审核，以及来源拒绝、无限事件等待唤醒和原unknown补偿；完整human／controller／host-revocation共102项684断言通过。修后真实客户端资格另由Desktop owner记录，旧失败不改成通过。

该门禁沿既有Core必要条件：Host登记nested Tool的要求时使用可信原父链，不接受模型自报Run；Runtime／Store等待也核真实父链及不可变记录，不按当前active Run猜归属。终态receipt可等其准确接纳，原change cursor、取消和期限负责唤醒，没有第二Loop、新公共字段或Tool／Protocol版本。9文件独立回归116项1389断言及Agent／Service／Desktop类型通过，含无Question自然final、direct／nested、terminal/include屏障、错误scope／revision／selection、单次continue／stop，以及原Task自动结果与Native waiting_execution按钮链；这些仍为受控模型／端口，修后真实客户端另核。

[Runtime/SQLite因果回归](../../../test/isolated/browser/human-async-runtime.test.ts)使用固定模型和内存transport，覆盖pending返回、后续模型调用已开始无关工作、人工回应在该工作仍等待时完成、下一模型实际收到一次关联结果、重复与nested冒充拒绝、已结束/其它Run/取消、主动接管及普通Action仍串行。通知明确失去准入时只交还本次恢复的准确租约；通知ACK未知保留unknown，不重投或把请求标已通知。请求Job的实际取消signal同步撤销请求资格；execute在每个异步准备边界及最终carrier读取后重核当前请求/期限/代次/取消和准确Job状态，派发前不再使用prepare旧快照。Controller将响应signal传到真实resume，重新观察结束前不公布Agent控制；恢复已在途或已完成后取消，仅对本次准确租约做一次交还，交还ACK未知保unknown、不重放。最终carrier读取在Runtime可信完整Execution上核cancelRequestedAt，不能拿不含该字段的PublicExecution误判。新增逐await取消、恢复ACK在途/恢复后取消、补偿未知、过期及页面关闭负例仅证明这些mock边界。有限响应Action的通用调度/关闭合同归[Agent lifecycle](../../lifecycle.README.md)。这些是mock资格，不是最终Native或真实模型验收。

人工阶段UI私有 `capturePage` 仅有有界像素与空annotations，不能宣称已有严格只读DOM/性能观察；上游标注截图会临时注入DOM。未来观察仍须明确方法/字段/范围/速率预算及敏感输入暂停，禁止直接开放任意JS、DOMSnapshot、AX或console全量内容。

2026-10-28续修：恢复成功后的Run/Session/work资格读取异常，现在先对本次准确租约执行一次补偿交还，再写诊断状态；记录写入失败不能阻止交还。已知通知准入失败同样收口，补偿不确认保unknown。通知提交结果未知仍不交还或重发；inclusion已提交但resolved记录回执丢失时，回应Action保unknown，不再次恢复或通知。当前热请求的unknown标记优先于Run结束/期限展示，避免把实际未知控制状态改称“已过期、由你控制”；该标记不替代持久回执，冷启动继续不恢复热请求或授权。

上述Runtime/SQLite回归在修复前分别复现恢复后读取失败没有补偿，以及Run结束后unknown被expired覆盖；新增存储失败、补偿未知、通知已知/未知、resolved回执丢失和重复回应负例后，完整文件27项160断言通过。该阶段无新Native/daemon/真实模型，未改变result.include来源、有限控制Action权限或Tool/Protocol版本。

[Native全根回归](../../../../../apps/desktop/test/isolated/native-browser-async-root-runtime.test.tsx)现已按新合同贯通普通页面绑定、真实Main CallerJournal／Extension IPC、Service租约、同一Runtime与固定provider：原Run释放并正常final，新消息新Run复用同页、新Job／租约与快照后仅一次点击；ACK丢失、准入后切B的迟到回执、准入前切B拒绝及原Run取消仍在同一链路核实。Electron/daemon/传输I/O为内存替身，run.start由测试驱动走正常intake，不是正式Native/真实模型或Composer整条输入链资格；准确范围归[Desktop候选](../../../../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)。

2026-10-28另以真实gpt-6-luna／low、普通Composer和隔离Native取得上述异步核心路径的实机切片：请求pending后原模型读取独立文件，人工继续Action实际准入后在B期间完成一次关联结果投递、新generation快照及一次业务点击，原A Run完成，原Browser Job正常停止；准确过程、模型快照、通知revision的wire字符串／SQLite整数冷核和仍缺的备注／硬件／资源资格由上述Desktop owner维护。新增全根回归分别验证提交前切走的零POST拒绝与已准入迟到ACK的B保持，不能把前者当作成功回应；原失败及unknown保留，Tool／Protocol版本和权限合同不变。

Native宿主在原browser.open的operations.ensure前使用prepareOpen绑定准确任务与页面，不发页面Question；硬拒绝、取消和unknown直接结束原Tool准入，ensure失败由cancelOpen清理原未消费绑定。普通受管浏览器不装配该Native接缝，公开工具输入和版本不变。[准入回归](../../../test/isolated/browser/open-admission.test.ts)保留宿主接缝等待期间零Job、原intent继续、取消与未知清理；实际页面回执父链归[Service](../../../../../apps/service/src/desktop-browser-authorization.ts)。Controller只认准确受信Host的派发证据：acquire调用前拒绝可证明无lease；已派发导航或可能效果的未知回执不能据错误文本改成确定无副作用。准确启动失败generation在live／closed查询中保留原码，foreign仍stale。
