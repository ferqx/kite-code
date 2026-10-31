# Agent Note: 普通 Native 页面上的 Agent 控制租约

Status: proposed

2026-10-28接续：模型默认入口、技能组织与持续代码执行方向现由[统一执行入口决定](2026-10-28-browser-computer-use-execution.md)和[实施方案](../../../../docs/plans/2026-10-28-browser-computer-use.md)部分取代。本文的Main页面owner、准确页面授权、输入互斥、原Runtime/Job、撤权及unknown边界仍适用；下文旧原子Tool升级表和“不新建REPL”属于此前方案范围，不能据此否定新确认的最小受控执行能力。此前具体工具升级已在原任务获批，仅按原清单保留，不要求把所有原子Tool作为新默认模型入口交付。

## Problem

普通WebContentsView与原Agent受管Chrome是两个owner。用户要求同一普通浏览器页面被Agent控制，控制时出现虚拟光标与全页蓝色内阴影，而不是另一个浏览器页或Agent目标高亮。移动登录资料、接管任意target或把共享renderer伪装成Job的独占进程，都不能满足这个要求。

## Proposal

Main继续拥有最多8个普通页面、真实输入、历史和内存session。用户明确授权准确页面与当前Store/Session后，原Runtime Browser Job通过配套私有通道取得短期租约；scope来自Main已核实选择和实际Job context，不来自网页。acquiring不显示Agent蓝光，确认后才进入agent；撤销须等通道关闭、daemon监督结束、在途排空与Main debugger分离。unknown保留，不以晚成功洗掉。人工阶段保留预约，恢复更换租约身份，并保持原10分钟Job期限。

固定provider只连接该页的短期loopback入口。普通renderer没有endpoint/token、任意CDP target/URL/JS设置。没有整应用调试端口，没有新的模型循环或Core业务表，Tool/Protocol版本保持。Job只拥有daemon/provider与租约，Native页面退出和renderer资格独立。

固定装饰代码在实际页的独立world中绘制pointer-events:none的光标与蓝色内阴影；位置来自已实际派发的有效页/nav坐标，无目标框、随机路径或持续磁盘轨迹。蓝光只反映Main确认的控制租约，不能用来授权操作。网页可干扰DOM，因此呈现也不作为安全证明。

当前后端与Native输入屏障/显式接管/跨会话恢复已有待审代码和跨层mock；普通tab根组件/冻结注释与持久人工Question诊断已有mock；pending requestId异步回复与主动接管已有真实Runtime/SQLite mock，真实Native输入互斥资格仍待完成。主路径与资格归[Desktop owner](../../../../apps/desktop/README.md#普通页面控制租约候选2026-10-27未发布)。原[侧栏隔离决定](../../implemented/architecture/2026-10-20-sidebar-browser-isolation.md)的页面隔离、无preload、内存session与界限仍有效，其“切会话销毁所有网页”将只在统一接线后按租约保留范围调整，尚未整体替代。

首次使用不能仅依靠测试预arm。当前增量候选把具体页面／登录状态授权放在原browser.open Tool的持久Question中、创建Job之前；Main先保留原目标与选择stamp，明确允许后commit许可，原Job核父链一次消费。缺页在接受后才创建空白页；拒绝、取消和迟到回答不自动接管。提交丢ACK只inspect原requestId，未知保留；记录使用executable绑定原Store并排除fork来源。已有手动授权仍直接固定原页使用，Tool／Protocol版本不变。产品范围与当前替身验证归Desktop owner；整篇仍为部分实施的proposed，不以此增量宣称发布资格。 获准的新页面还须先完成本地空白文档初始化，已有未导航空页在acquiring复用同一Promise；只构造WebContentsView不足以保证固定provider需要的renderer/DOM。已有HTTP页面不额外导航，未授权前不初始化；实际故障和新资格分别保留在owner证据。 原Question身份可沿NativeCaller同一次selection的只读刷新缓存继续核对；这不提供renderer写入就绪资格。私有grantScope独立保留真实失联、权限失败、ABA、子会话和删除守卫，避免把普通刷新缺少新权限投影误判为选择丢失。

可见共享页的截图不得通过CDP clip.scale改变真实widget。固定Chromium实现会临时emulate/SetSize后才恢复，外框稳定不足以证明无缩放闪烁；现候选使用原viewport无损像素，再在NativeImage内存中缩放、编码一次，保留CSS基准与最终字节hash。仅把scale改1仍无法保证大viewport裁缩时不重现。用户实机观察的005闪烁和旧unknown继续保留，新连续过程验收单独核实。 连续窗口resize也不能逐次hide再等renderer显示，否则产生独立白帧；Main只同步屏障并依实际bounds连续更新，真实隐藏／遮挡守卫保持。尺寸变化须失效旧截图基准，纯位置移动可保留；工厂创建必须使用原grant scope，不能在已允许后重新依赖renderer瞬时fresh投影。

## Alternatives considered

1. 保留两个浏览器而改标签名：不能控制同一页面，已排除。
2. 将受管Chrome从单Job改成长寿命浏览器：需要补原生人工输入、IME、历史与多页，改动更大，也不能迁移旧用户页，未选。
3. 在普通网页内容区追加控制按钮或让工具栏随状态换行：用户实测接管后页面宽度闪烁，动态工具行会改变 Main 接收的原生视口。现按用户明确要求把授权、租约、异常和注释编辑统一收进单行工具栏菜单；已打开页面的内容区只呈现网页或冻结画面；未导航的新标签页仍在下方内容区保留原工具入口，不把工作区变更混入浏览器工具栏，保持原生视口几何。弹出菜单仍沿原遮盖判断临时隐藏相交的 Native View，不能以消除抖动为由去掉覆盖保护。
4. Main开放整应用调试端口或让renderer提供CDP URL：扩大target与账户范围，已排除。
5. 让Job拥有共享renderer进程树：与真实page owner冲突，已排除。

首次使用曾考虑在acquire的HTTP请求中直接等待用户，但Service/Main各有10秒／15秒短请求期限，长等待会把回答丢失误作启动失败。采用Tool前置持久Question，使等待归原执行、拒绝前零Job／daemon；Main私有prepare/commit/inspect承载准确意图而不是新业务表。也排除把自然语言、普通Tool批准或空白页当作页面同意，因为这些都没有具体页面及登录状态范围；只保底层错误码也不能让已终结原Job接着继续。

## Acceptance criteria

- 默认普通页保持原owner/历史/输入；只有明确页面授权后的原Job可以接入，跨页/旧代次/未经授权导航或撤销unknown拒绝。
- 隐藏/切会话不取消原Job或改变目标；后续UI要能恢复同一受租约tab。
- 实际派发才绘光标，导航/失败/交还清除；无目标框，覆盖层不抢焦点、不截输入，不靠外层CSS假装覆盖原生View。
- 原daemon停止、FD关闭、租约撤销与renderer所有权分别验证，不能以Main/CLI退出代替整树证明。
- mock/纯内存/静态UI与真实Native/真实模型资格分开。当前本机spike证明限定单页可读/输入/点击和其清理，不证明完整候选实现。

## Risks

截图候选依赖固定上游annotation容器和同次JPEG hash/视口元数据，需独立审查；不得改写上游脚本字符串或复用旧图box。本阶段修正了acquire的实际Service Store绑定与流式响应上限，相关内存回归不等于正式Native启动链资格。当前已使用真实gpt-6-luna／low取得同页填写、蓝光/type光标、程序化屏障、人工交还／继续、B期间原任务完成及正常停止的核心实机切片；真实硬件输入互斥、完整备注取证及整体发布资格仍缺。已准入后切会话与准备期间切走分别验证，后者必须安全拒绝，不能以按钮点击补造受理。旧选择变化、备注窄条与清理unknown仍未由新切片洗掉，当前不能宣称产品整体已交付或可发布。本提案本身不授权新实机实例、读取既有Cookie/Profile、提交或推送。

待审v1补充：截图和metadata是租约下的在途只读操作，交还等待它们排空，状态/导航变化拒绝迟到帧。关闭必须等待完整控制权转换，并对已知迟到的新租约执行撤销；丢失回执不可用旧租约补造confirmed。三种停止入口共用同一幂等关闭结果，不让迟到ready创建的资源脱离该收口。该修正尚未完成本提案其余UI与输入互斥条件。

用户18:07明确异步交接方向后，旧长Tool等待只保留诊断。当前候选在确认交还后登记有限扩展请求和无页面/进程的响应Job，立即返回pending。人工独立Action核原主体/work/Run/selection/页面及revision；真实Job终态通过现有result.include一次入原活动Run，生成有准确来源的user-role结果引用标记，不冒充手写用户消息或after_turn。原Run结束不自动复活，UI提示明确新指令。为活动Runtime下可用的交接，仅新增可信定义显式选择的有限控制响应通道，原owner不变且同owner控制串行，禁止新工作/Question，普通命令仍串行；不重构Loop或添加Browser Core表。未知通知不重投，准确失去通知准入则交还本次恢复的租约。人类操作期间Model默认仍无网页操作权；只读观察也必须有限方法/字段/范围/预算，敏感输入阶段可暂停，不能把任意debugger CDP当只读权限。

异步候选v3独审复现prepare后取消响应Job却仍resume的竞态。修正把Job的实际signal同步映射到请求撤销，并在execute各await及最终完整carrier检查后再准入副作用；Controller在resume/观察期间保pausing，取消已派发恢复时只做一次准确交还，失败保持unknown，不能仅拒通知后留下Agent控制。这不是对旧v3资格的追认，原失败日志与包保留；全根UI异步验收当时为处理该阻断暂停；v5随后新增贯通mock，不授予真实Native资格。

后续全根mock复用真正的NativeDesktop/Main CallerJournal/页面IPC、Service transport、Browser协调器与Runtime/SQLite，仅Electron/daemon/provider及I/O传输替身。三场景覆盖pending后独立工作、明确继续和一次result.include、旧观察拒绝、迟到回执停留B时A完成、取消后旧请求不可恢复、备注catalogue共用；重新快照在点击前，最终页面独立计数1。真实硬件与原生合成仍未执行，提案保持部分实施；本阶段没有新生产改动、实机、模型或发布授权。

2026-10-28续实施已补Main固定焦点坐标读取与type装饰、失败光标按本次身份清理，以及annotation样式准确key的异步撤销。焦点查询计入原租约在途并在返回后重核控制/导航；没有有效焦点不复用旧位置，iframe内部位置不猜测。交还等样式撤销和debugger分离，清理失败保unknown。实现与mock证据归上述Desktop owner；该代码阶段没有新实机/模型启动，最终输入互斥、原生合成、上游截图/DPR和真实模型资格仍缺，不改变proposed状态。此前第二次实机在租约前的程序化文字输入失败也已归位，不覆盖第一次unknown或推导完整后代清理。

后续一次独立获准实例在12:37（上海时间）运行15.697秒，普通原生页程序化输入成功，但未出现授权按钮；受控模型和Browser Job均0。确认原因是Main在私有通道惰性创建前注册IPC、永久捕获空automation，现改为绑定已存在的Main host；Main回归已先复现再通过，修复尚无新实机证据。实际窗口截图不包含原生网页像素，原生合成仍未取得资格；具体失败、有限资源关闭及保留的unknown归Desktop owner。该次实例已退出，未借其授权重开。

再获准的一次12:45实例已证实首次授权入口修复和普通原生页实际OS窗口合成，但原Job首次导航未确认，保持startup_outcome_unknown，未进入填写/人工交还验收。后续静态核固定上游单页空sessionId合同并修正Service事件归一，受控回归先红后绿；采用准确空标识而非开放任意target或修改上游代码。实际窄栏控件溢出也已修正并获组件浏览器几何验证。准确失败、修复和有限清理范围归Desktop/Service owner；未重放原操作、未再启动Native，该轮原Job unknown与旧unknown均保留，提案仍部分实施。

持续修复阶段补齐三类异步失败收口：Main接入等待后重核准确租约，截图读取前固定页面/导航/attachment并在各await后复核，装饰旧绘制失败仍消费其间更新；人工继续后资格读取异常须先补偿准确租约，不能让诊断写入成为交还前置。通知已提交或提交未知继续保持零重投，unknown不被Run结束/期限显示覆盖。代码与纯回归证据分属上述Desktop及Browser owner；本阶段没有新增Native/daemon/真实模型，也不追认此前失败实例，提案继续部分实施。

随后单独获准的13:19实例在59.760秒内取得上述同页填写、蓝光/type光标的实际OS窗口合成及程序化屏障证据；夹具观察ACK超时、本地替身idle超时和过短的正常退出等待阻断了人工交还阶段，原Browser Job最终job_stop_unconfirmed保持unknown。仅修正隔离夹具等待与取证，未据此增加生产硬退或隐藏原生焦点，也未重开实例。实际过程、原失败、后续只读进程消失与未取得资格完整归Desktop owner；不以部分切片或mock追认完整验收，提案仍为proposed。

用户随后明确要求使用真实gpt-6-luna、低思考实机验证。新隔离制品沿正式Codex Responses绑定，以普通UI选准确路由／轻度，原Run模型快照确认low；未复制认证或读取既有浏览器资料。最终59.175秒核心轮取得一次准确人工关联结果、B期间新快照及一次效果、原Run completed和Browser Job已确认停止；原脚本的revision类型误报由独立只读证据核实，原RESULT不改。另29.263秒最小Native捕帧诊断的备注即时／700ms布局正常，但不能解释前轮窄条。阶段前失败、未准入响应unknown、选择变化及Service超时收口均保留在Desktop owner；新增两层纯回归区分pre-POST拒绝和post-admission迟到ACK，不据未复现的异常修改生产逻辑。提案继续部分实施。


## 后续实施范围（2026-10-28 用户补充）

先完成普通自然语言从无页、空白页、已有未授权页进入原持久授权，以及真实错误保留和宿主停止／交还；停止、人工接管不能等待普通业务审核或由模型再调用一次工具。原页面、租约、Run和daemon终态分别保存，旧job_stop_unconfirmed与动作unknown不因Main退出而改写。随后在现有Runtime／Operations／Skill发现与持续执行能力上建立统一浏览器操控技能，不另建Agent循环、授权系统或持久执行引擎。

模型接口以稳定页面句柄、准确元素引用与按需观察为目标，内部代次、幂等和通道由宿主封装；旧引用不得映射到新目标，未知副作用不得重发。实时展示、语义决策与冻结注释分开调度，不默认300ms持续带标注截图来维持可见页面、蓝光或光标。视觉观察须以正式modelImages送入模型，不能把UI预览当视觉输入。按键、原生下拉、悬停、对话框／弹窗与有限坐标按代表性流程补齐，原始CDP、脚本、文件和凭据不因此开放。

技能按目标／后端渐进加载，复用准确已有标签；用户不需了解Job、generation、seq或key。技能负责指导，宿主强制授权、取消、输入互斥与结果查询。工具定义／协议升级先整理具体兼容影响并取得用户对该升级的明确确认，当前未批准任何具体版本递增。实机按普通desktop:dev自然语言入口使用gpt-6-luna低思考，直接构建的普通客户端证据单独标注；所有实例隔离Profile、无凭据本地页、旧失败和unknown保留。当前仍为proposed的部分实施，必要增量、文档和验收完成后再按实际范围收尾。


## 待用户确认的模型工具合同升级（未实施）

为把内部控制字段交给宿主，并补正式视觉输入／代表性控件能力，拟升级现有8个browser Tool到version 2；模型名称保持browser_open、browser_snapshot等，不把版本号拼入名称。现version 1定义、历史输入／结果与格式识别继续保留，显式旧配置和既有记录不自动重写；新默认选择在确认和验证后使用v2。仅内部实现、技能接线、宿主撤权和截图调度不以此为由升级版本。

| Tool | v2模型输入与结果要点 |
| --- | --- |
| browser.open | url、可选准确page句柄；宿主生成原意图身份，返回稳定page。缺页仍先原持久Question，准确已有有效许可可复用。 |
| browser.navigate | page、url。旧页面元素引用全部失效。 |
| browser.snapshot | page、mode=dom或image（默认dom）。dom给准确语义状态与不透明元素ref；image通过原ToolResult.modelImages给正式图像，并返回imageRef、图像尺寸、CSS视口及坐标变换。不会默认两者都取。 |
| browser.click / browser.fill | page、ref及填写value。ref由宿主绑定原页、文档、控制代次、观察与实际元素；模型不再手填generation／seq／key。 |
| browser.scroll | page、direction、amount；内部原执行和幂等身份由宿主保存。 |
| browser.request_human | page、reason；仍使用原持久人工协调器，明确交还后再观察，模型不能自行恢复。 |
| browser.close | page；结束自动化与交还，原Native页面默认保留，未知效果／清理不伪造成功。 |

另拟新增version 1的6个有限Tool：browser.pages只列当前授权作用域Main已有页面元数据与句柄；browser.press使用有限按键／组合；browser.select操作准确ref的原生select选项；browser.hover作用于准确ref；browser.dialog仅处理当前宿主签发dialogRef的accept／dismiss及非凭据prompt文字；browser.pointer以当前imageRef的图像像素坐标执行有限click／drag，宿主核CSS变换和当前视口基准，变化即拒绝。没有任意selector／JavaScript／CDP／Cookie／文件接口；敏感业务许可独立保留，不由页面内容或技能授予。

持续多次调用复用现有Browser Job与Main页，不新建REPL／脚本执行引擎；本次不增加通用批处理语言。任何兼容迁移先由既有装配、工具发现和版本选择实现；精确多页在旧租约仍活动时不隐式改投其他页面。以上具体工具定义升级待用户明确确认，确认前仅实现现有合同内的阻断修复与技能接入。
