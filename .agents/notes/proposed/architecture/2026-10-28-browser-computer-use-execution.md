# Agent Note: 浏览器技能与统一受控代码执行入口

Status: proposed

## Problem

模型逐项选择独立浏览器Tool并维护generation、seq与意图key，放大了协议字段混淆和交互往返；仅增加技能文字不能提供持续执行、图像返回或可靠停止。已有Native页必须仍由Main持有，不能为了简化模型接口把用户登录资料或任意调试能力交给生成代码。

## Proposal

用户2026-10-28确认后续采用产品内置 `computer-use` 技能、一个统一受控执行入口、持续任务环境及页面句柄/Browser API。具体产品行为、阶段、owner与验收只在[实施方案](../../../../docs/plans/2026-10-28-browser-computer-use.md)完整维护；当前已在耐久工作树实现候选，完整实机资格未完成；准确实现与证据沿各 owner 核对，不作为完整交付证明。

本决定部分替代[普通页租约提案](2026-10-27-native-page-control-lease.md)中以多个独立模型Tool为后续默认入口、以及不补代码执行能力的方向。旧提案的Main页面owner、准确授权、输入互斥、原Job/Runtime归属、撤权/交还与unknown约束仍适用。此前具体工具升级许可仅覆盖原清单，不自动扩成新协议或任意权限许可。

技能提供工作规范，执行器提供受限代码运行和观察，Browser API提供能力，宿主强制权限及生命周期。执行器不另建模型循环，也不在可信Main/Service进程内运行生成代码。图片复用现有中立工具图片及两种协议适配，wire载体不生成用户授权；第一阶段使用当前PNG工具Artifact合同。

`agent-browser` 是内部可替换后端，第一阶段复用已有能力，不与技能接口绑定，也不因入口收敛立即删除独立浏览器兼容路径。实时控制、模型观察与用户注释分别调度，避免以持续截图维持控制展示。

## Alternatives considered

1. 只增加技能、继续要求模型逐个调用原browser Tool：不能解决持续句柄、字段混淆与批次往返，未作为最终默认入口。
2. 升级原8个Tool并增加6个常驻原子Tool：该具体清单曾获批准，可保留兼容价值；用户后续确认统一入口，因此不把增加模型工具数量作为交付目标。
3. 技能反复通过任意Shell执行浏览器CLI：不能形成所需受控句柄、正式图像来源和一致撤权边界，未采用。
4. 直接在Main/Service或Node vm内eval模型代码：缺真实隔离且接近页面/凭据信任域，未采用。
5. 立即删除agent-browser并重写所有Main浏览器语义：现有快照、元素、等待及事件能力仍有复用价值，成本与等价性未验证，暂不采用。

## Acceptance criteria

按实施方案验证普通自然语言首次授权、实际技能/统一入口使用、持续同页操作、跨协议正式图像、批次隔离与取消、人工接管/继续、真实效果及未知保留。原模型/页面/进程失败分别记实，不以入口存在或局部mock通过宣称整体验收。

## Risks

本次新增最小 browser executor leaf：macOS Seatbelt 限制的独立 Bun 进程，原 Darwin guardian 核准确所有权，宿主 API 等待期间暂停原进程并停止消耗代码预算；node:repl 仅提供持续语法环境，不作为隔离边界。未加入通用 I/O，也不把进程退出当成网页效果撤销。选择增加 leaf 的原因是仓库没有满足此合同的既有持续 JS 执行器。简化入口不能抹去操作来源、防重放或旧目标校验；旧句柄不许自动重绑定。单页后端替换、模型视觉资格、真实输入/进程监督和平台发行各有独立边界，具体限制沿负责owner与原证据维护。


## Current implementation and limits

2026-10-30用户补充Renderer热更新丢失快照及手动关闭后新页面已打开却不能读取的现场。当前将网页、展示附着、Caller、Run与观察分别核实：document持有展示revision，同Main的Caller共用单调generation；重附着只保存准确会话展示意图，重新走select取得事实。没有采用刷新／重开网页来恢复展示，因为那会丢失表单和阅读位置；没有清除Main旧revision门禁，因为迟到cleanup仍须拒绝。可信确认准确原页缺失并结算原意图后，只退役该被动候选；后续明确任务及URL可另开新身份，不在原失败批内自动重试。连接未知或地址／身份不符不能当作已确认缺页。新现场的原导航unknown不追认，新增有界启动原因只记录后续原失败能够证明的阶段，不补造丢失的历史cause。实际实现与修后资格归Desktop／Browser／Service owner，整体仍为proposed。

全局技能元数据始终由 Service 内置源提供，正文／资源按原选中能力门禁加载；不依赖本地目录安装。`browser.execute@1` 经原 Operations 派发原子依赖，`browser.code_session@1` 负责真实执行器及所属 Run 收口。新默认 Native 模型只见一个浏览器执行入口，旧显式工具和冻结记录保留；正式 PNG 复用既有 modelImages 和两种协议。选择采用宿主签发的不透明页面／元素／截图句柄，避免让模型维护内部代次和操作键，但仍保存每项原 Tool 的执行来源及 unknown。

[Browser owner](../../../../packages/agent/src/tools/browser/README.md)、[Skills owner](../../../../packages/agent/src/skills/README.md)、[Service owner](../../../../apps/service/README.md#受管-browser-默认装配)与 [Desktop owner](../../../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)维护当前实现、测试和未完成资格。普通构建已取得部分真实技能／统一入口／正式图像／拒绝取消证据，dev 资产定位、完整语义文字、Main 弹窗和截图错误分类在首次实机后有修复，仍需修后实机。Status 保持 proposed，不能因受控回归或部分成功自动迁移 implemented。


## 2026-10-29 clarification

用户明确要求工具异常不能中断Agent Loop，并质疑Auto／Full再次确认、无任务接管入口及resize／后台展示。当前owner据此让页面接管复用原工具最终派发与当前策略证明，Full和已批准Auto没有额外Question；不再把旧提案的手动预arm或独立页面问题作为必要产品入口，Main页面owner、准确目标、已有登录范围、硬上限及未知保留继续适用。两个新代码定义属于无外部效果的隔离编排，实际网页API逐项核权；精确同意图browser.session复用须当前policy／controls一致，legacy和旧证明保持保守。底层工具结果决定见[工具异常与Loop](../../implemented/architecture/2026-10-29-tool-results-preserve-agent-loop.md)。

代码与Browser各占真实process permit，总容量不足2直接不可用；按同一Core容量对象的leaf票据限制活跃代码环境为floor(process/2)，避免多Session互占代码槽后自等待。它不假释放原permit，不因已结束的网站unknown另建全局fence。后台新页需在Renderer首次呈现前具有有效viewport；显示与resize按真实容器及Main尺寸proof更新。最新修正仍需更新制品实机，整体Note保持proposed，不以局部回归／旧客户端成功改写为全部implemented。

## 2026-10-29 呈现交接增量

006连续录像分别证实恢复文案挤高48CSS像素、缩窗沿用旧宽覆盖聊天112CSS像素，以及菜单相交隐藏整页约40ms。前者由有标签时不再占位处理；缩放按SessionPage同一Panel变量提供真实约束与量测，Main只投影当前支持的两层右侧两Panel布局。旧固定宽度右锚无法保持相对分栏，不能继续作为完整修复。无限制通用布局引擎没有当前需求依据，未采用；失去投影资格撤下旧页，等真实Renderer校准。

菜单考虑过复用browser.capture Action，但该Action会更新seq／refs并进入观察pending门禁，可能阻挡交还／停止，且无browserId的普通页不能调用。采用Main当前已实际呈现页的一次私有PNG，原scope／导航／尺寸／scroll／zoom核前后与隐藏commit；它只衔接菜单画面，不成为模型图像、坐标proof、权限或第二次语义观察。默认轮询会增加耦合和读取消耗，因此仍不采用。解码并按实际可见矩形铺好后再隐藏，关闭show ACK后撤图；超时明确占位但菜单及可信停止不等Core队列。代价是菜单打开期间展示冻结画面，后台仍能继续，已同步桌面手册。

该增量沿[Desktop owner](../../../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)维护当前实现与测试。菜单6文件65项928断言、Desktop类型通过；布局生产库决策对照仍用受控DOM几何。修后真实开发／普通构建连续画面尚待验，整体Status不因这些增量自动变为implemented。

## 2026-10-29 人工等待与退出的实机修正

007在真实requestHuman交还后，额外信息提问失败但Loop继续，模型最终正常final让原Run提前completed。这证明技能文字不能独自保持人工等待，也不能用无关问卷代替相关的继续通知。当前Browser在返回pending前登记原Run不可变browser_human_receipt义务，自定义completion条件只在原Job的实际相关result.include被原Run／selection／resultRevision接纳后满足；Job已终态不代表原Run已消费。模型可继续独立获准工作，没有其他工作只需说明等待，宿主保持waiting_execution。

真实考虑过同步阻塞requestHuman：会取消原异步独立工作的行为，未采用；增加通用resultRequirement inclusion标志与Job声明会扩大公共合同，未采用；直接用operation_result会被通用自动消费在实际通知前抢跑，未采用。最终仅复用既有必要条件与可信父链登记／等待，Core不识别Browser业务kind来授予权限，不增第二Loop或工具／协议版本。直接与nested无Question final、terminal／include屏障、单次continue／stop、错误scope及Native实际waiting_execution按钮链共116项1389断言通过，三包类型通过；真实单次相关回应仍待后续制品。

同一007退出时先销毁页，后原租约release报stale，监督正确保unknown而正常退出失败。已按[退出决定](../../implemented/bug-fix/2026-10-22-single-confirmation-exit.md)保立即关闭可见界面，但原窗口／page host／租约留到Service释放及exited确认再destroy；不能把任意stale冒充已释放。Main受控顺序先红后绿，后续实际退出另验。007原unknown与夹具强杀137不改，旧记录不恢复成新任务；整体方案仍为proposed。

## 2026-10-29 原启动等待与结果传播

008实际原页面已收到导航，而Service给每条私有RPC固定10秒使其先于Native原35秒请求期限中断；随后的撤销未确认保unknown。统一入口又把controller出现的starting身份当作已就绪，提前snapshot并用not_owned覆盖原Job事实。现在CDP仅沿准确attachment的owner信号与原请求期限，管理RPC仍10秒；缺owner派发前拒绝。统一入口每轮先核原Job终态，只在同browserId的agent阶段派首观察，首次观察竞争及取消后仍读原ref/result。没有增加期限、自动重开或重放。

保留通用短HTTP期限会提前制造unknown，未采用；简单延长所有RPC会放宽管理边界，未采用；仅等browserId出现也无法证明导航就绪，已由准确状态与原Job替代。原unknown及清理监督不放宽，HTTP中止或debugger detach不算网页成功。Service新loopback和原共享transport共19项217断言，Browser execute、人类等待与页面API共93项706断言通过；008实际单次相关继续已成立，但完整修后后台及视觉过程仍待新制品，整体Status保持proposed。当前事实归Service、Browser及Desktop owner。

## 2026-10-29 Auto继续的来源与用途

010真实Auto继续暴露独立Action使用全局空审核器，而正式Service的审核器只存在于原Run配置。不能让Continue假装缩权免审，也不能为方便在全局另选一个模型或借同Session的新Run；当前仅由私有封印原请求／Controller持有的Job，核完整open／可选execute父链，保留准确原活动Run的冻结审核器与配置租约。原Action定义、权限、当前controls、派发read set和所有来源／取消检查继续执行。审核期继承原请求／Run的取消，真实派发后由原有限转换收口，防止请求自身失败时取消必要补偿及unknown落盘。

进一步实机证实仅补审核器仍不足：真实模型只见不透明ID而要求人工；原Run正常进入waiting_execution又因整份PublicRun stamp改变而重复审核。当前在既有target.source绑定原任务正文、人工请求原因和本次恢复控制／通知的实际效果，明确只作数据不授予权限，不替模型强制allow。仅这条可信continuation的准确Run准备读stamp投影实际依赖的身份和isActive，返回PublicRun不变，Runtime仍核原work／selection／取消／结束，记录和Job证明不减。全面忽略进度或放宽所有Action鲜度会削弱无关路径，未采用；保留完整进度stamp则会把正常等待制造成审批失效，同样未采用。

完整human、controller与host-revocation102项684断言通过，包含真实审核输入用途、审核期间进入等待只审一次、无限事件等待被原结果唤醒，以及所有原失败／unknown补偿反例。最后修正仍待新客户端实机；旧010失败、后续后台夹具未切B／未放行及原unknown保持，整体Note不迁为implemented。当前实现及证据归Browser与Desktop owner。

## 2026-10-29 菜单可见须晚于准确hide ACK

010完整可见录像第3250帧／56.405秒又证实：冻结图虽然已准备，Popover与Native hide同时开始仍让菜单先露一帧，被上层网页遮住，下一帧才完整显示。这不是截图缺失或元素语义刷新，不能只凭最终画面通过，也不能靠延长盲等待掩盖。

当前保留原200ms截图／解码边界，Pane先按原图和实际矩形铺好、给绘制机会，再请求准确hide；hook只在该ACK后显示菜单。无图fallback也须普通hide确认；拒绝保菜单关闭及原错误提示，原入口可重试，停止仍走原链。关闭继续等show ACK撤图。只改Renderer私有端口的完成握手，不增Main能力、Core轮询、工具或协议版本；代价是菜单显现要等真实短IPC确认，不能以未核隐藏冒充可见。

held ACK成功／无图两条红例与真实Pane链已先红后绿，含拒绝重试、切页取消、迟到ACK及原人工控制／统一根五文件37项890断言通过，Desktop类型通过；原录像的一帧失败保留，修后真实Native合成仍待新制品，整体Status保持proposed。

## 2026-10-29 新量测准入与旧合格anchor外推分离

010快速缩放的112个连续帧又记录Native先移动、Renderer旧布局，继而一帧暗空；该段Main一直visible:true。源码与真实project函数另重建出新viewport配旧DOM可通过原自校验：差额被当作580px右边距或581px间隙，layout缺失又可直接发raw矩形，晚到IPC因此能替换Main刚投影正确的anchor。原日志没保存那包完整入参，像素先后和可重建缺口分别记实，不冒称已逐字取得该payload。

决定只允许同当前CSS窗口、真实全宽Group／Panel拼接与0..1px handle（含1px舍入）的新量测建立anchor；原合格anchor只供Main同步resize外推。把旧调用跨尺寸再投影并登记为新anchor会混入旧比例，未保留；无layout回退会丢资格，也拒绝直接降级。明确null撤下后原bare路径兼容，拒绝前不改bounds、visible、epoch、正式图像或菜单key。没有通过盲延时、默认截图轮询或隐藏页面掩盖这次错帧。

Renderer对真实SessionPage区分合格／暂不一致／不支持；暂不一致既不发旧正矩形，也不把反向缩放时暂空clip发成null，沿现有真实布局事件重测，真正隐藏／collapse／失资格仍撤下。菜单冻结图复用原可见裁剪交集复核，保局部图和1px容差，越界使用原无图提示。

Main36项383断言、Producer及真实几何根链39项918断言通过；根链原全节点同Rect夹具被真实Group／Panel／separator、统一视口／PNG／metrics替代，业务断言保持。当前受影响集合214项2394断言通过，但这不证明首次Main窗口resize与OS／Renderer原子绘制；1725–1727旧失败仍保留，最后视觉资格待新制品连续录像，整体Note仍proposed。


## 2026-10-29 可恢复批次与致命环境故障分离

用户要求先解决频繁工具失败再实时测试。真实失败与底层路径共同说明：原Host API拒绝及worker done.error都会直接关闭执行器，外层再取消Browser Job。普通TypeError、参数／旧引用和已知读取错误因此扩大为页面终止；通用Agent Loop能继续说明不能证明浏览器任务可继续。仅在Loop吞异常、自动重放代码或只修改假执行器测试都不能解决此问题。

当前选择私有结果区分可恢复批次：Host认定的调用前校验或已落定failed child锁住本批后继派发，解释器退出该求值后，仍须准确Host链结算、pending／waiting为零和原进程内核SSTOP，才允许保留变量及同一页面供下一批观察。原结果文字不能自授恢复资格；worker done.pending仅否决。首次open未完成、取消、交还、unknown、预算／协议／暂停／清理或记录完整性故障保留原准确收尾，不用通用错误覆盖原unknown。代码UTF8大小先于环境准入核对，合法中文字符数不等于字节预算。

生成代码捕获异常及Promise.all排队不能恢复本批派发权。仅靠全局batch变量会使旧timer／Promise借用下一批，故worker以私有AsyncLocalStorage封存求值来源和输出归属；它不停止所有旧回调，也不阻止它们改共享JS变量，不能冒充OS隔离。真实安全边界仍是原Seatbelt、Host权限与内核暂停。没有改变公共工具、协议版本、Loop或浏览器后端；代价是只允许宿主有明确证据的失败复用，其他失败继续保守关闭。当前先做真实worker／Runtime恢复及拒绝、未知、取消、预算、旧回调的离线回归，修后实机资格另核，整体Note仍proposed。


同轮另确认正常中文快照的字符限额可大于执行器UTF8消息预算。选择在统一snapshot返回处按实际JSON字节有界裁剪并标记truncated，值最多48KiB，为Host结果和自动最终值的原消息封装留量；只登记已返回元素的引用。提高协议／输出限额会扩大无关执行预算，只将超长读取变为可恢复错误又会让同一正常页始终不可读，均未采用。小快照保持原样，截断会减少一次可见正文／元素，真实worker已核长中文、转义／emoji／元数据及后续同页继续；它不改变原网页作用或将截断内容当作完整页面。


## 2026-10-29 用户收敛为免审批与正常final

用户在完整流程审计后明确选择：浏览器操控不经过自动审核或用户审批；自动化完成或需要人工处理时释放控制、保留页面并正常回复，用户处理后再发新消息，不维持人工交还／等待／Continue。原文中人工预约与completion obligation的理由只保旧显式／历史兼容范围，不再指导Native新任务。继续修补原等待调度或只靠技能阻止轮询均未采用；当前直接移除Native新装配的人工Tool／Job／Action／conditions，按新Run边界恢复准确页面。

审批豁免只由固定注册builtin.browser@1可信分类和policy精确核验，真实effects不改成read；Service／Workflow投影同步。实际能力、精确任务／页面／控制代次、取消、主体与unknown仍是硬边界。旧Question、拒绝和unknown不改写或转成新grant；这一选择减少正常浏览器往返和技术审核空结果造成人工等待的路径，不移除宿主隔离或操作来源。

用户另报首轮失败后下一条消息snapshot_failed。当前拆分VM与BrowserJob生命期，后者自行监督原Run；prepareRun在新VM／process准入前等待旧终态Job真实stop／dispose，不能依赖300ms tick或用户打字间隔。明确释放本Run不再重新acquire，新Run才能复用同页；纯VM故障不等于页面释放。open不再将隐藏的首次snapshot合入绑定成功，显式read失败保原页面／Job；新Run／新lease／新opaque refs逐层失效旧引用，原效果unknown继续保守保留。离线真实worker／SQLite已核失败后无人工close即新消息恢复；当前Note整体仍proposed，原生菜单／布局与最终客户端模型资格另核。


## 2026-10-29 可选初始化探测与业务失败闩锁

012同配置restart-002真实dev以两个主模型请求复现：Main在固定后端初始化时正确拒绝WebMCP.enable为method_denied／not_dispatched，Service却把该可选拒绝锁成整个launch失败，预设读取故障尚未消费。原Job failed、零业务效果、Loop正常final及正常退出事实保留，不能称完成跨轮恢复验收。固定0.39.4源码enable_domains_direct明确忽略该探测失败；真实固定daemon与内存Main随后也验证拒绝后launch成功、原页url可读及confirmed stop／dispose。

选择只在精确launch(headless:true,engine:chrome,webmcp:false)作用域，允许空参WebMCP.enable的准确Host not_dispatched／method_denied诊断不污染整条业务失败闩锁；CDP仍向后端返回原拒绝，Main方法集不扩大。没有全局忽略unsupported、按错误字符串推定未派发或放行任意后继请求。runIfWaitingForDebugger虽也被上游忽略失败，但可能恢复页面脚本，不纳入该例外；业务、失效绑定、错误proof、未配对和网络未知继续锁住后继派发并保原unknown。该取舍沿现有私有请求状态，无新公共协议或Tool版本；最终修后两客户端资格仍按实际新制品核验。


## 2026-10-29 释放描述与原生菜单输入边界

012 restart-003实际首轮已知读取失败后正常final并准确释放，第二消息却因pages只列受控句柄而返回空数组，被模型误认为原页消失；没有第二次open／snapshot，不能以两Run completed计恢复成功。选择在现有Controller记录里，仅为真实shared page曾成功Agent绑定且已确认closed的对象保留有界lastKnown URL／标题。描述明确无id、bindingRequired且不证明当前存在；新消息仍须显式open，由Main核真实页面并取得新lease／refs，不自动恢复或给旧引用续权。原closedViews的128项界保持，standalone、未成功、unknown和其它Session不提供描述；同Run释放fence不变。这样修正控制句柄与网页存在混淆，不新增页面inventory、I/O、通用队列或公共协议版本。

同轮菜单回调关闭后右栏收起，原日志不能证明同Escape直接泄露。源码显示volatile fresh／pending会使原生popup在核读中提前取消，而根Escape只认识DOM dialog。选择将popup生命周期绑定真实页面／scope，选择时仍核最新enabled；实际pending popup的Escape在Main和Renderer消费同一down／repeat／up序列，pointer／scope取消不吞下一次普通Escape。失效选择必须给原普通issue反馈，不能无声丢掉。没有延时掩盖、禁全局Escape、生产调试出口或扩大动作准入。当前先核真实worker／Runtime与菜单根回归，再统一新制品实机；旧失败与未知不覆盖。


## 2026-10-29 绑定候选与既有页硬准入

004真实新消息已收到无id的released描述，但模型在“不新开页面”约束下仍拒绝open、没有第二次snapshot。上一节仅用guidance消除歧义的选择因此部分被替代：releasedPage内部元数据资格及无旧权限的理由保留，模型入口改为当前VM新签发的opaque候选id。pages与browser.page工厂不做I/O、不恢复旧租约，首次snapshot才经原open子调用创建新绑定并真实观察；pending其它操作在派发前拒绝。候选只在当前Run环境有效，不是旧id或网页当前存在证明。

为让“不新开／刷新”成为宿主保证，Service只在来源和最终派发证明通过后，为首次Saved匹配Controller的已释放URL并耐久封存requireExisting:true；旧无标记记录不被回写或升级，inspect不能翻转。Main在prepare／commit／acquire核同Store／Session的准确Page对象、id、incarnation、导航代次和URL，缺失／变址直接拒绝，不进入创建、导航或刷新路径。新URL普通打开能力保持；共享页候选只请求既有页，不能fallback新页。该私有收紧不增加公开Tool输入、工具版本或worker方法，也不自动续旧Run。真实worker／Runtime、正式Service＋真实Main grant与缺失／变址负例是必要门禁，最后客户端资格仍按修后制品核。


## 2026-10-30 页面生命周期与原页身份

用户实际观察原页面容易丢失，并要求逐项核对tab映射、目标固定、任务隔离、重连核权与调试目标范围。当前源码审计确认两条真实丢状态路径：scope／unmount沿统一close通道在release后销毁页；fresh不同URL选择唯一可见页后再navigate覆盖原内容。此外上节同URLexisting-only只证明本次选中页地址相同，不能证明它是上Run原Tab。本节部分替代上节以URL确定跨Run原页的选择，保留候选无authority、首次snapshot才绑定、零替代／刷新／重放及新引用的理由。

选择Main持有网页独立于UI观察、Run、租约及daemon；scope变化／renderer重载只隐藏，明确Tab X和实际窗口disposal才走关闭，active／unknown的原关闭限制保持。私有restore交付全部scope-owned活页与activeId，避免保住页面却因只恢复一页使其他标签不可达；同Job已隐藏页不自动抢回，新消息真实新租约可重新呈现。普通fresh open只复用唯一准确URL或唯一从未导航／取得租约的初始空白标签；不同URL新建，明确navigate才改变当前页。

跨Run的原页身份只从真实acquire回执取pageId＋incarnation，经transport／Controller的私有released描述和Service原Saved传给Main。URL仅附加校验，隐藏原页与可见同URL另一页不能交换；缺页、替换、变址或缺可信身份明确失败，零fallback。新VM不透明candidate、browserId／generation及元素／图片引用仍重新签发，Main身份不交给Model。连接建立不授控制，原代理命令逐次核lease及page；保留fail-closed，不新增自动重连／重放引擎。

未采用仅延迟close或放宽URL匹配，因为前者仍把页面寿命寄托于观察时机，后者会把另一标签的表单当成原现场。未采用所有页面永久可见或自动选中恢复页，因为会抢占其他会话；也不靠新增恢复按钮或审批流程补内部owner错误。代价是私有多页恢复清单及精确身份链需要闭合边界测试，旧无身份记录不补造新的热authority。当前按Agent／Service／Main回归与两现有隔离配置的真实模型／连续画面分别验收，整体方案仍进行中。

## 固定 Electron 对话框收口

005实机在CDP已接受confirm、页面Accepted及模型final后，原生Cancel／OK窗口仍遮窗至120秒。固定Electron44.3.0的dialog helper缺Chromium HandleJavaScriptDialog清UI实现，而固定CDP在先完成网页回调后并不按该清理返回值拒绝成功。当前采用Main单WebContents的固定内部cancel事件，在原决策已成功、父窗口／attachment／页面控制身份／导航／原生dialog代次仍匹配时中止残留MessageBox；默认已abort回调跳过网页响应，不重复决定confirm。连续新框或scope变化拒绝清理并保unknown。源码与macOS父窗口条件归[Desktop owner](../../../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)。

未采用disableDialogs，因为会直接改变confirm的业务结果；未替换网页confirm、全局dialog或Electron默认handler。单页内部事件没有dialogId，故不能把迟到回包扩成关闭后续新框的许可。该兼容接缝的受控回归与修后真实窗口过程分别验收，不以CDP成功或网页Accepted代证原生窗口已关闭。


## 2026-10-30 Root文档显示代次

重新生成隔离配置后的真实录像表明，原Page、WebContents、document及人工输入均保留，模型后继读取成功，但Root界面重载后展开的网页内容持续黑。局部Renderer显示序号会随文档重建归零；Main按页面长期保留的高序号拒绝新量测，因此页面存活、任务成功和显示恢复必须独立核实。

选择沿现有可信Caller generation分组比较presentationRevision，Root导航／崩溃仅清旧展示anchor、scope与冻结帧，不销毁网页或刷新内容。正向显示核既有完整scope；effect cleanup携该effect原scope，Main允许同generation旧selection清理所属页，但拒旧generation迟到的显示／隐藏。Main根装配在Root替换时沿Caller.detach递增generation并清选中范围，不用页面字段自授新文档身份。单独重置revision未被采用，因为旧文档高序号cleanup仍可能覆盖新显示；不新增独立epoch协议或恢复按钮。当前修复以定向Main／DOM反例及同两隔离配置的真实连续画面分别验收，旧黑屏失败与整体进行中资格保留。


## 2026-10-30 多页释放候选

真实普通构建在A保留表单后打开B，Main保住两张原页，但后继请求A时Model只得到B候选并结束说明不可用。原closedViews以Session为key，仅记最后Job收口；它适合继续承担Run／unknown门禁，却不足以表示多张仍需继续的已知页。仅强化提示不能让未提供的A候选重新出现。

选择独立有界的已确认释放共享页元数据集合，每Session最多8页、最多128Session，只按可信pageId／incarnation去重。它不保存热控制、不查询浏览器库存，也不证明当前存在；首次snapshot仍沿原open与Main准确绑定验证。公开列表只给新Run不透明候选和旧URL／标题，按规范URL选择唯一候选。Service首次Saved也按该目标URL查询原identity，不借最近B代A；同URL多个已知identity在派发前明确歧义。原closedViews与未知屏障保持，旧Controller单页兼容，不新增Tool输入、协议版本或自动恢复／重放。此取舍部分替代仅保最后released描述的范围，原身份、缺页零替代及无I/O候选理由继续适用。


## 2026-10-30 同epoch恢复查询

真实逐帧录像捕到新Job普通刷新期间一帧恢复错误与黑正文。UI已验证的同epoch页面和Main展示使用只读grantScope保留身份，但Main restore仍读严格selectedScope，Core viewLoading窗口令其暂时无值，错误被UI诚实呈现后又立即恢复。选择让被动restore沿既有function级grantScope入口并核完整四元组，不把临时后台读取扩成权限丢失；函数存在但拒绝时不得fallback，真实不可用、权限终态失败及错epoch仍保原恢复提示。没有修改写入／控制准入、吞一般错误或增加延时。另见resize首帧整Root旧viewport的一帧合成滞后，保为OS绘制资格限制，不据此重写几何协议。


## 2026-10-30 真实HTTPS原始观察响应限额

新会话直接打开中国天气网，原生AX树483153字节成功，随后548721字节也读取成功，却在Main HTTP外层默认512KiB限额被丢弃；未在Host可信失败边界内抛出的page_response_limit又被替换成通用页面／连接失败。实际页面仍在，模型却误报连接中断。这是响应容量与原因保留的真实缺口，不能归因审批或靠模型重试解决。

选择仅给Accessibility.getFullAXTree原始HTTP成功信封2MiB容量，其余512KiB及截图6MiB保持，Service独立流式限制与超限取消保持。Host在原dispatch boundary内一次序列化并核完整UTF-8信封，超限由Host自产browser_page_response_limit，沿准确op／lease／method保存原read_failed或effect_unknown；Channel只发送该已核实串，不再在边界外重新分类。纯结果说明明确超限，不据此判断页已关闭或连接已断，不回写先前操作或unknown。最后48KiB语义快照、Native最终回复、模型输出及CDP允许方法不扩大，没有自动重试、替代页、工具或协议升级。真实HTTPS修后过程与资格继续归Desktop owner，旧失败完整保留。


## 2026-10-30 有界语义引用的页面顺序

真实天气网通过AX响应限额后，仍有输入前false stale：完整快照顶部搜索框e65未消失，但refs字典序前200项不随正文顺序，节点增长可把e65挤出重新核对集合，后继公开快照也失去该可操作引用。仅重复读取不能保证恢复，不能简单增大输出预算掩盖问题。

选择先全量校验原refs，再按快照中可匹配真实refs的标记首次出现顺序排列，合法但未在正文出现的refs稳定排序补尾，最后保留原200项；缺refs的正文标记不铸造引用。公开快照与输入前身份核对使用同一转换，仍核原role／name、generation与seq。原正文65536字符、统一执行值48KiB及输出预算不变，既有unknown与旧引用拒绝不放宽。该修复属于原快照／引用合同，不新增选择器、Tool参数、协议版本或页面重放；真实HTTPS与过程资格归Desktop owner，失败原件保留。


## 2026-10-30 导航后首次文档就绪

真实首问在Enter已成功导航后，于URL commit与DOM-ready之间150ms窗口取到空AX，模型提前final；稍后原页已显示完整天气。下一Run准确绑定同pageId／incarnation／WebContents并读出天气，证明不是页面丢失或站点恒为空。选择只让已确认Agent的Page.getFrameTree和Accessibility.getFullAXTree等已开始的准确主frame跨文档首次DOM-ready，避免先取旧frame再读新文档；不按AX大小重试、不重放按键。

Native局部事件闩锁跟踪开始／提交／当前文档，Host等待时保原lease／navigation的read reservation，完成后同栈重核并派发。关闭／撤销在waitIdle前唤醒等待，后继导航不替旧请求接续；隐藏或切会话保后台页面。setup/in-place/已ready空页沿原路；失败或取消交回原Loop，原因可读且不改变旧效果。沿原请求期限和取消，不另叠加HTTP／资源idle期限；旧URL或无新文档身份的迟到abort不毒化当前导航。工具／协议、权限、语义输出预算与业务生命周期不变，真实过程资格仍归Desktop owner。


## 2026-10-30 明确关闭与后续消息指导

真实HTTPS自动化中点Tab X，UI移除了标签，Main却仍保原WebContents、模型继续读完。原因是明确close仍走retained的hide分支。当前只有明确用户X强制解除注册并关闭准确页；普通unmount、切会话、收侧栏仍保页，Agent page.close仍只释放控制。此处替代旧restoreClosed只隐藏墓标的范围，保留后台观察不取消任务的理由；get-only迟到state/present/restore和重复close不创建替代页，旧租约和新Run缺页走原可读失败。

另有后续明确打开URL的真实Model反复轮询空候选，旧指导笼统把later message都描述为原页继续。当前仅把新URL工作走open与原页继续走候选/snapshot分开，并说明旧技术代码环境确认清理不取消新请求；这是指导含糊的修正，非对模型内因的确定证明。原已知缺页、unknown和cleanup fence不放宽，不新增自动重试、Tool/协议版本或元数据发现I/O。产品预期仍以手册的明确关闭及准确新目标规则为准，实机资格由Desktop owner继续核实。


## 2026-10-30 受控页与保留页的列表投影

真实HTTPS首问完成后，A页与新打开的B页在Main都保留，模型却在控制B时只看到B、返回A后又只看到A，并分别误报另一页无法确认。Controller已持有两页释放元数据，缺陷位于统一执行入口把active与released列表做成互斥分支；这不是页面已销毁的证据。

选择统一投影准确active handle及其他惰性释放候选，重复pages复用原browserId／generation句柄与refs，避免观察本身制造新控制对象。只有Controller私有完整pageId／incarnation相等才能去掉active的旧释放描述，不按URL合并同址不同页，不暴露私有身份。其他候选仍须新Run绑定且首次snapshot成功，单active页限制在子open派发前拒绝并保原页可继续；内部歧义、unknown与同Run释放门禁不变。最多active1加released8共享原48KiB UTF-8值预算，不增加工具／协议版本或发现I/O。真实worker与Controller直接回归覆盖双向A/B、稳定引用、零派发拒绝、同址不同incarnation和长元数据边界；在线与连续画面资格仍归Desktop owner。


## 2026-10-30 已销毁原页的清理证明

真实Tab X已销毁准确原WebContents，但Host注销时删除原lease后只剩stale错误；事件读取、revoke和release都失败，Service将已毁页误按cleanup unknown，普通退出也因原监督收尾未确认而挂起。原模型实际仍按Loop正常final，问题是关闭原因与资源证明缺失，不能把普通stale文本直接当成功来消除unknown。持久cursor另确认前一Run主动page.close已正常清理；无序SQL输出曾误导排查，不据此增加并无证据的Controller／prepareRun竞态改动。

选择在原Host内保留最多128条准确注销lease记录，原port实际不可用、原lease／pageId／incarnation匹配且原在途收束后，既有清理操作才签发page_destroyed正向回执；该记录不能恢复任何控制或页面能力。Service仍核原daemon／连接／在途关闭，完整回执才确认资源结束；没有原证明、错身份、仅注销未销毁、记录逐出或既有unknown保持失败／未知。准确已毁页可细化browser_page_closed原因，仍保原派发前／读取失败／未知边界，不把已派发动作降为未派发，不改写原业务结果。Agent只增加可读展示，不推断关闭者、不替代原页、不放宽unknown或旧引用门禁，也不升级工具／协议。当前直接回归和真实修后过程资格由相应Owner分别维护。


## 2026-10-30 Native呈现等待真实Root绘制

真实录像的缩小首帧先移动Native到新位置，Root仍显示旧聊天布局，造成盖住聊天；放大另有整窗旧surface与灰区，二者分别保留证据。这补充[原同epoch恢复决策](#2026-10-30-同epoch恢复查询)中仅保留OS绘制资格限制的范围：DOM量测加sendSync只证明布局已算，不能证明Root画面已提交，原几何／scope准入仍适用。

选择只在新的合格几何期间使用正常内部绘制witness：Main核真实Root帧的准确nonce，第一次反馈让Renderer生成第二次不同witness画面，再核后发布完整Native几何，避免与第一张新Root生成同回合抢先移动。pending期间Native只取累计安全交集；原页有限像素经异步事件预载，几何同步receipt仅返回准确图key与CSS显示尺寸。Root最多两张图，按来源DIP与Root zoom维持比例并裁剪，避免整张缩放造成字体跳动；旧scope／nonce／缓存无权替换当前显示。页图只在初次完整放置、加载与resize起点读取，不增加稳态截图循环，不把衔接像素作为Model图像或坐标权限。

隐藏、切换、关闭和失效generation会取消订阅；正常后台Agent不等待Root绘制，既有截图basis仍随实际几何失效。这是本轮受影响的内部呈现接缝，不新增调试控件、公开开关或工具／协议版本，不以固定延时、双rAF或缩放后的bitmap尺寸当绘制证明。两次真实Root反馈仍不是OS呈现事务或跨平台绝对零帧保证；65项直接回归及类型不代替最终真实窗口的空交集、扩窗、连续缩放和原比例交接资格，结果沿[Desktop owner](../../../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)维护。


## 2026-10-30 绘制证明的颜色管理校准

首个双反馈制品在真实普通客户端未取得任何ACK，Native页持续隐藏；后台Agent首问所有Tool成功、原页保留并正常final，图形失败没有中断Loop。实际Root PNG含Skia ICC，将其按嵌入profile转sRGB后，marker值才回到CSS设计级；固定Electron FrameSubscriber构造bitmap时未保来源color_space，也不能仅传sRGB参数补造丢失的来源。以上支持颜色一致性假设有缺口，原subscription字节仍须在有限诊断中核实，不用脚本通过掩盖实际黑空。

选择把[原Root绘制接缝](#2026-10-30-native呈现等待真实root绘制)的固定RGB直比替换为同帧16级中性灰参考加全部24hex／96bits数据。参考必须严格可分，每个data只可唯一对应当帧参考，保1量化误差而不放大固定RGB容差；低物理像素比例按同一几何放大tile，避免采样跨色块。scope／revision／两次真实反馈、旧nonce拒绝、安全交集、原比例衔接与既有截图权限均不变。不增加模型调用、I/O权限、工具／协议版本或一般截图轮询；先用实际窗口与订阅作零Model预检，再继续真实HTTPS及UI首发。原失败、账本189与旧3处unknown保留，正常退出0不等于图形资格。


## 2026-10-30 保留原生层下的准确页图

真实零模型预检已取得同帧灰阶字节和两步ACK，原生网页可见；连续逐帧观察仍在下一Main尺寸变化早于Root resize时发现单帧页体空洞。原ACK2把衔接图隐藏，Main随后因尺寸不匹配或安全交集为空隐藏Native，旧Root此时已无页图。保留最新准确页图在Native下层，只有同一已完成witness的缓存才能刷新；正冻结时与旧key的迟到图不能替换，切页、scope变化与隐藏卸载仍清除。页面仍由Main原WebContents持有，图像不承担控制、存在性、完成状态或Model坐标权限。

此取舍仅修有录像和日志支撑的Native/Root空洞，不把OS扩窗时旧Root缓冲及透明窗口未绘区域作为已消除的缺陷。5项Pane回归、类型及格式通过，实际人工输入/滚动内容是否在缩放时短暂回退仍须同配置实录核实；过程与剩余资格归[Desktop owner](../../../../apps/desktop/README.md#统一浏览器入口候选2026-10-28)。

## 2026-10-30 首次导航未知与原页新观察

真实反馈中，用户关闭旧标签后，新Google天气页已经可见，但首次导航确认丢失；后续消息又因previous_cleanup_unconfirmed无法读取。原现场持久结果缺少底层cause，不能追认重定向、连接或timeout为已证实原因。当前给原navigation分支保存有界可信机器诊断，旧结果不补造。

选择分开业务结果与资源清理：仅首次Native导航未确认且从未进入agent时，在准确原transport真正stop／dispose、Main释放同pageId／incarnation并报告实际URL、原owner全链与Run终态均核实后，允许新Run重新观察原页。释放回执是被动候选，仍须existing-only重核并取得新snapshot；此前其它URL、输入、导航、截图及旧坐标均拒绝。快照失败或再次释放不清此门禁。旧Tool／Job unknown不改写，业务输入unknown、agent后导航unknown和真实cleanupunknown继续fence。

不采用“页面看起来已打开便认定成功”、自动重开／刷新、以新key重发原导航、通用unknown恢复或复制旧截图；这些做法会混淆页面身份与业务副作用。旧历史没有准确回执时无法补造本次热证明。实现和实机资格沿[Browser owner](../../../../packages/agent/src/tools/browser/README.md)、[Service owner](../../../../apps/service/README.md)及[Desktop owner](../../../../apps/desktop/README.md)维护。

最新自然复现又确认了后继Runtime.evaluate失败，但原底层错误仍未取得。源码反例显示同文档导航会清掉仍在安装的固定CSS，并且CSS等待后没有完整原控制身份检查。选择同文档保留这条USER CSS、继续失效navigation／refs／坐标；异步前置等待后必须重核准确原页与租约，再发送Runtime CDP。只有Main内部一次性、同page／method的typed proof可标记该后继未派发，真实CDP拒绝与先前导航unknown保持。不采用按错误文字降级、自动重试原navigate或借CSS成功当页面控制证明。

## 2026-10-30 Native导航与状态归准确Main owner

新普通构建首问仍在页面实际打开后因CSS前置等待中的导航变化返回`browser_page_read_stale`；固定0.39.4的navigate在Page.navigate及生命周期等待后，还要通过Runtime.evaluate读取location.href、document.title。继续为这两条表达式增加特例，会把Main已经持有的原生页面事实绑在另一套导航／JS状态上。用户进一步要求停止反复实机试错，抓重点，必要时换方案并参考Codex。

采用有限Native driver切口：原统一Browser API、技能、隔离代码环境和单Agent Loop保持；Service把Native navigate／url／title交给私有Main-owned请求，Rust继续承担已有snapshot／AX／元素能力。Main对准确原WebContents直接读原生URL／title；导航先建立一次性主框架生命周期owner，再仅派发一次Page.navigate，等本次新文档DOM-ready或准确同文档完成，最终重核原页、租约、attachment及navigation。状态回执闭合原leaseId、pageId、incarnation、navigation、url、title；初始about:blank仅可作为状态，导航仍限无凭据HTTP(S)。

原观察documentReady门禁继续拒绝跨文档，不能拿它充当允许本次导航推进的等待。真正派发前才可确认not_dispatched，派发后取消、超时、销毁、改租约或丢确认保unknown；取消后排空原始CDP确认，迟到成功不能复活。Service沿同nativeResult互斥、inflight和原请求期限收口，close先取消自己的owned HTTP等待再排空，不销毁借用网页。Native capture的前后metadata也通过同一可信Main回调读取，避免内部url／title私有调用绕回Rust；原capture集合负责排空。旧unknown、真实cleanupunknown与新Run首次snapshot门禁均不改写。

此处部分替代Native启动导航和metadata绕固定daemon的实现，不是全后端重写；standalone兼容路径及现有资产版本保持。公开参考只支持[稳定tab／驱动引用责任与资源所有权](https://developers.openai.com/api/docs/guides/tools-computer-use-sdk-drivers)和[Codex可操作共享内置浏览器](https://learn.chatgpt.com/docs/browser?surface=app)，没有披露其内部Electron布局或恢复算法，不能声称复制了Codex实现，也不引入SDK的新Loop或审批规则。

另据真实38次模型核验循环，当前Run变量、同页绑定和新工具结果传递均正常；固定snapshot refs仅输出role／name，state只在AX文本中。当前补通用指导：等价语义观察不再增加证据时转正式截图等合适观察，仍不足便报告限制、close并正常回复。不从name／文本正则补造可决定派发的disabled等状态，不加全局失败次数取消。Root与Native多surface的缩放合成缺口仍属独立呈现问题，两次hidden实验未取得新尺寸帧，不继续叠加该方向或用最终截图追认通过。

后继开发制品首次HTTPS及真实X后重开均取得正确正文并释放；随后原页继续时标题却丢失。同页初始化仅消费url结果，Service丢弃了同一Main receipt的title，on-demand snapshot与scroll不补标题，终态又用空初值覆盖候选。选择只让共享Native内部url结果携同一次已核Main receipt的url／title pair，沿Controller现有消费者保存当前描述；不加三次URL／title／URL读取，不借URL相等声称没有ABA，不用旧候选标题兜底，真实空标题保持为空。此处没有修改公开API／schema／版本或standalone。

真实后继模型还误选了更早被X销毁的候选并把单页缺失描述成当前网页已消失；准确原页实际仍在。原惰性候选不是存在性证明，选择在确证missing后精确退役单候选，并明确可重列一次、仅重新观察另一唯一匹配当前任务的原页。没有全局库存I/O、自动选择最近／可见页、同URL猜测或缺页后的业务重放；原unknown及真实清理屏障保持。真实隔离worker三Run反例覆盖准确A缺失后原B的fresh snapshot与零额外导航，不能据此声称真实模型必定选对。

## 2026-10-30 Pane组件的Fast Refresh边界

真实开发制品保存Pane时Root timeOrigin改变，并出现约一秒灰／暗空与重绑槽宽恢复；原网页、非零阅读位置和执行Run仍保留。当前安装plugin-react的实际refresh runtime进一步确认，Pane的普通函数导出`closeNativeBrowserTab`身份变化使组件边界拒绝，另外两个普通导出也有同一反例。这里不是页面destroy、Service restart或纯组件HMR，不能仅把观测变空解释为原页面不存在。

选择将三个普通Session adapter原样移到独立模块，让Pane仅导出React组件；Root直接用该组件，close／restore回调沿原适配，不从组件模块重新导出普通函数。原恢复scope核验、document-owned单调presentationRevision、Caller generation、模型refs及坐标规则均不改。实际runtime反例核旧mixed export拒绝、新组件边界接受并enqueue refresh，而非仅检查文件后缀或函数名；真实连续画面和新Run观察另行核实。

此取舍只避免该常规组件保存传播成Root整页reload，不强制所有模块更新可Fast Refresh，也不隐藏显式reload、Main／Service重启或真实页面关闭。它不引入BaseWindow迁移、新权限、Loop、协议或像素缓存状态；Root／Native跨surface的显式reload与缩放绘制问题继续归Desktop owner，不以最终页面正确覆盖过程失败。

## 2026-10-30 同一合格Live槽的effect交接

实际组件HMR保持Root／目标文档但仍捕到四帧Native正文暗空。两个离线红例分别确认：React实际保留同DOM时，effect cleanup仍发null；Main完全同几何的新revision仍无条件hide。单改任一入口不足，也不能只凭DOM存在或拿新step1覆盖旧状态后自证合格。

选择按实际槽寿命收窄重复effect的清理：捕获原DOM与document，最新完整依赖、正向几何和遮挡仍与最后值一致时保留Live，旧订阅／observer照常清掉；真卸载、换节点／scope、隐藏、几何变化或未知一律hide。新setup或清理失败也补偿hide，不留下没有观察者维护的表面，不依赖mounted位、HMR flag或计时器。

Main只以旧的完整step2证明和当前实际Native边界判断同一槽：active／live／visible、没有pending、完整scope／generation／viewSelection、Root实际尺寸／zoom、bounds/layout及Native实际bounds均一致，才在新revision的两步真实witness期间保持Live；新证明仍必需，错误订阅／帧读取、变化或不确定继续hide。原sizeEpoch、坐标依据失效、输入互斥和旧ACK拒绝保留。没有恢复旧截图或迁移容器；离线证明不能替代可见Native时Root是否实际交付新witness及全过程画面，资格归Desktop owner。

## 2026-10-31 整页Root重建只保留准确Live显示候选

真实Root重载虽保网页文档，仍因主动hide及新树先全宽后恢复右栏而中断正文约1.2秒。单纯keepVisible会让旧Native盖新聊天；缩窄Root或padding会破坏整窗量测，旧截图不能代替活页。选择有限的display intent：Main只在原Live、完成step2且实际几何、窗口、zoom与页面身份完整不变时保留真实Native，撤旧展示及坐标资格并强制输入屏障。同步preload在首绘制前隐藏新Root的呈现与输入，保持其真实整窗布局，加载状态仅占原左区域；这份候选没有lease、refs或操作权。

新Root恢复真实会话与准确页面后，沿现有右栏动画的DOM状态等实际量测收敛，只有原槽匹配才同步claim、揭示已提交树并完成新generation的两步witness。取消、卸载、页面或范围变化、屏障失败和几何变化先由Main撤页，再确认揭示；已终止的准确token可确认取消，丢ACK不声称成功。旧host缺新方法保持原行为。没有timer恢复、PNG还原、网页刷新、新标签或业务重放。

此处没有重建任意手调的右栏宽度；新实际槽不同会严格fallback，也不解决Native新viewport首帧或OS跨surface原子性。BaseWindow本身不提供该原子保证，当前不为这一有限切口迁移窗口架构。受控红例和真实制品的资格分别归Desktop owner，整篇提案仍未完整交付。


2026-10-31固定Electron首绘制遮罩取舍：真实active Root重载Main67405保住原Native文档但Root持续透明，原生探针进一步证实44.3.0／Chrome152中webFrame插入的user-origin样式不能被当前removeInsertedCSS移除，author则可。preload因此明确使用author origin，并在取消遮罩后核实际Root opacity／pointer-events；移除无效不能清本地intent或伪称可见，而须取消Main展示交接并保pending错误。该修正不升级Electron／协议，不刷新原网页，也不恢复旧截图。固定C++来源与精确实机资格见Desktop owner；原Root失败不被离线反例或原生探针覆盖。
