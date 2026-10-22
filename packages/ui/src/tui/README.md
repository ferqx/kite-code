# 独立终端消费者

## 原 Ink 展示与明确测试诊断

原真实终端场景经[统一 runner](../../../../scripts/run-unified-tui-system-tests.ts)逐整文件消费当前 UI／CLI Host／公共 Client／默认 Service。原参数与模型声明在[测试协议映射](../../../../tests/tui-system/harness/original-tool-contract.ts)准确转换，不生产旧 Runtime 事件或伪造结果；不导入历史 Store9/11／State26。原 Store9/11 旧格式转换不在 D08 范围；对应历史／维护旅程改验新 Store／Profile，State26 则保实际旧文件隔离反例。这是测试范围迁移，不是旧格式转换或兼容通过。完整执行证据及后置平台范围归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

短暂观察刷新保留同会话的可操作快照；明确重选会话时只查询保存的原未知请求，不重发。主屏的后继输入、后台任务和取消各自绑定原 Run，连续取消不会误取消已接受的下一任务。当前 Run 的已确认取消与历史 unknown 并列展示，不把旧未知改写为成功。审核选择在 native 键到达时更新，快速方向键／Enter 使用当前原卡的明确选择，原 revision、附件与重复提交门禁仍有效。

Host 从同 Scope 的公开 SessionView 取得原 owner，并提供当前已认证连接实例；[活动资格](controller.ts)只在有未终结记录时比较它们。不同实例显示当前连接无法核实、仍可能在另一执行者运行，停止 Working／Thinking 及工具／子任务活动动画，保完整正文与原状态；不声明 owner 死亡、任务已中断或取消已完成，不自动恢复。缺少这些可选事实的旧 Port 保原观察行为，已经完成的历史不因此标未知。

[子卡投影](execution-projection.tsx)识别准确注册的 `task.spawn`／`task.follow_up` v1 carrier，保留旧 `task`／`task.execute` 历史。无 preset 的新协作者不要求 role 参数；名称只作展示。稳定 child Session 的多轮历史分别通过 `child-start-${carrier.id}` 的唯一原 Run 关联，只显示同 Store／Session／Run／rootWork 的工具与审批，不将另一轮待审批展示在旧卡上；正在取消和已终态 carrier 不显示活动批准提示。准确人工 pending 优先显示“等待你的批准”。当前根会话准确活动 Run 的交互自动聚焦；child 卡通过 Ctrl+B 明确选择，Ctrl+B 后 Esc 返回父输入，原批准／问题答复仍绑定原卡和 revision。公开 Run 的 `carrierExecutionId` 沿准确启动／续接和封存报告父 Run 证明 report 后续轮；只把同 carrier／Store／rootWork 的步骤归入原卡，人工状态还须来自唯一活动 Run 的准确 authorization。旧 DTO 缺证明时保守不归入后续轮，不猜最新 Run；子完整日志仍按原只读入口可读。

[Ink 回归](../../test/tui/execution-ink-projection.test.tsx)实际验证新建／追问卡、同 Session 两轮步骤与审批隔离及等待文案；[80×24 PTY](../../test/isolated/tui/executions.test.ts)实际验证原准确 Job 停止、完整分页输出和父普通结束后的 child 日志。新增[六工具80×24 PTY](../../test/isolated/tui/collaboration.test.ts)在真实 Service/Runtime/SQLite 上通过正式按键核双 child 独立待批、父输入保持、准确批准 A、稳定 A Session 新 Run、旧卡停止不改投 A2、准确批准 A2 与停止 B。原8秒单等待预算保留；与原完整日志门禁组合2项通过。迟到旧答案的真实桥接与冷重开零重放归 Desktop 窗口门禁，不由投影单测替代。

当前审批卡中的Esc沿原 `controller.answer(card,'deny')` 拒绝准确卡片，不取消根工作；Ctrl+B目标选择中的Esc仍只返回父输入，全局Ctrl+C仍是明确停止。[真实模型普通PTY](../../../../tests/e2e/live/model/collaboration-tui-window.live.ts)发现并复现过Esc错误调用根cancel，修复后在同一冻结版本三个独立样本核两真实child一批一拒、仅被拒child的原工作取消、兄弟与父正常完成、效果一次及冷客户端零重放。[按键回归](../../test/tui/controller.test.tsx)另核原卡revision、重复Esc去重、same_command初始无选择、Deny+Enter对照及全局停止；原17文件范围137项/1094断言通过。精确模型、代码、原红与未测范围归[69/80执行记录](../../../../tests/e2e/live/model/collaboration-v1.1-cases.md)，不升级为全部TUI、冷后端或其他平台资格。

模型重试提示只消费同 Store／Session／Run／root work 的实际失败前驱与 `modelRetry` 元数据；`maxAttempts=null` 表示无本地次数上限，只显示实际 attempt，历史有限上界仍显示分母。没有消息正文的真实模型失败仍显示。活动思考的尾段在完整回答之前收束一次，原 Static 历史不因进度、输入或菜单刷新重复输出。已批准计划进度保留实际标题及步骤，真实 Files 效果和 Core CAS 收据才能完成步骤。

探索阶段仅在真实工具归属与 Thought 或连续工具调用模型均成立时消费过程旁白；独立问题、写操作和无 Thought 的单次读取保留原模型文字在交互／工具之前的顺序，未知或混合归属不能隐藏正文。待审批卡的命令与私人草稿使用原卡／revision 的独立 ComposerBuffer；打开 MCP、清理显示及刷新不回答、取消或重绑原审批。诊断模式只优先展示原结果已有的 Execution 身份及 toolsMetadata，完整字段不删减，普通结果展示不变。

真实子任务属于某个 Model 不构成隐藏该 Model 正文的条件；思考在前、任务旁白和完整回复按原来源顺序保留。已由准确 carrier 展示的 Tool 协议结果仍独立去重，原完整输出读取不变。纯展示滚动夹具沿当前公开 work／parent／runless carrier 事实及实际 Delegating 活动测试，不能从这些画面推定 Runtime 执行或完整资源资格。

无 Thinking 的单次只读调用保留原统计，阶段收束后补充普通工具卡结果；活动时保留原 StepRow，已有失败／取消卡不重复。卡片 node 与来源 version 使用同一个执行投影，不能只用 phase 摘要代替完整结果与引用版本。合法的 runless Shell carrier 只经唯一、准确的父 Tool 归到原 Run；同一调用来源用于消息顺序和结果去重，保留 Bash 后探索顺序，取消前驱的历史不会浮到后继输入之后。foreign 或多个 carrier 不推定归属，完整 Job 输出读取入口不变。MCP 原名称经同一 Scope／catalogue／definition／name hash 校验后同时提供运行预览和终态详情；已确认工具失败与传输后的未知效果分别保留，未知不自动续跑。

已核实的完整附件与历史共用单一 Static 输出队列，关闭审批卡仍继续输出后续回复。真实 producer 完成后，有界预览可按来源顺序封存；显式全文读取继续独立核 EOF、字节和原引用，后来完整正文变化沿原版本重建。Ctrl+L 查询原申请并刷新，显式 `/clear` 清理当前显示。提供 `same_command` 的审批要求先明确选择范围，初始空 Enter 不发送回答。

活动 Markdown 复用原增量解析缓存，由 [live-markdown](live-markdown.ts) 按原行偏移分出稳定段落和仍变化的尾段；稳定段落进入同一 Static 队列，完整来源变化才重建。已输出材料不因动态尾段暂时缩短而回放，reason-first 缓冲和真实工具归属仍决定正文顺序。Question 的完整材料保留原换行，输入窗口按实际内容列宽计算光标；只有 Question 明确使用完整宽度，其他 Overlay 的默认内边距保持。

原 `apps/kite-cli/src/tui` 的纯 UI 已迁入 [ink](ink/MarkdownBlock.tsx)：Markdown 的增量闭合缓存、代码语言框与高亮、表格边框和中英文宽度，用户原文背景块与 30 行首尾窗口，工具五行预览／Shell tail、文件 diff、Thinking 聚合、子任务树、ConcurrentSubAgent、计划步骤与压缩阶段。主题色板、语言目录、frame、选择行、搜索框和首次配置保留原展示算法；不导入旧 Runtime、provider、reducer 或旧客户端。

[index](index.tsx)负责完整主屏消费。普通界面把完成内容一次写入终端原生历史，第一项仍变化的内容及其后续行留在动态区；列宽／会话／语言等语义变化才替换展示代次。长问题的完整材料进入原生历史，底部保留有限选择和输入窗口；编辑和观察状态变化不重发材料。主 composer 使用原双横线、❯、ghost 补全、命令说明／别名和 40 行光标窗口。Tab／右键优先补到共同前缀，只补全不提交；Enter 按当前准确候选补全并提交一次，文件目录仍在读取时不提交。历史保留本范围最近 500 条，候选上下在边界停留，折叠粘贴 Esc 清输入；候选包括实际合格 Workflow 和当前完整 MCP prompt 目录。

[execution projection](execution-projection.tsx)只把已有公共事实转成原 renderer model。Tool input 来自同 Store／Session 的实际执行，或同 Run 唯一 callId／准确结果 sourceIds；正式短 builtin ID 须由冻结 Run 的 extension／definition／version 证明后才使用友好名称。MCP 代理名称只从同 Store／Session 的原 metadata snapshot／index 绑定与准确 definition/version 读取，再核 name hash；当前 Server label 还需 configDigest 匹配，历史使用 MCP 加真实工具名。只读聚合使用原冻结 `readOnlyDefinitions`；Shell 另需准确注册的 builtin/version、同 Scope／Run／原工作、唯一 carrier 和已保存终态结果中的呈现分类，不能从 UI 命令拼写或自定义 Tool 字段猜只读资格。分类由 Agent 的既有参数分析产生，只影响展示，不授文件或执行权限；取消、拒绝和未派发项不计已完成探索。并发使用同 Model 批次的 task／carrier 关系以及实际生命周期交叠。无证明者单列，失败、取消和 unknown 不折成成功。未知工具参数保留有界卡片预览及完整详情，Ctrl+E 可选中间卡片；准确 Job 才取得完整输出、child 阅读和停止入口。

宿主在原 refresh 中读取准确活动 Model 前缀、已验证 child views、有限 Shell tail、已批准计划及真实压缩阶段，没有独立轮询器。正常完成 Model 的全文和必要交互附件自动使用现有完整 reader；保留原 Store／Session／Run／Execution、UTF-8、EOF/hash 与未完整读取不得答复的门禁。失败可以 Ctrl+O／Ctrl+A 明确重读，未来或不支持的格式不猜正文。完整思考保持收起，完整 reader 同时保留正文与 reasoning 供已加载导出使用；读取只读、不派发 Tool。

Ctrl+A 只为当前原卡确实要求的附件发起重读；Controller 也在调用宿主 reader 前要求存在原附件信封。无附件的普通问题不发读取、不产生 `attachment_missing`，步骤与草稿保持；真实附件读取失败仍保留原错误并阻止答复。[问答键盘回归](../../test/tui/questions.test.tsx)同时覆盖普通问卷零读取及原必读附件门禁，[Controller 回归](../../test/tui/controller.test.tsx)继续核读失败后的零答复。

[首次配置](onboarding-panel.tsx)沿原 Trust／Provider／Connection／Manual Model 流程接新的 [onboarding port](onboarding.ts)。没有可用默认时可配置 Provider，也可用原 enabled/default CAS 选已有模型。秘密仅在遮罩输入和一次热 POST 内，unknown 只 GET 原 mutation；输入、配置和身份校验仍由新 Service／Agent 完成。

模型、权限、会话、Files、MCP、Skills、语言、主题、帮助与交互面板使用原纯 frame／行布局，完整目录及描述保留。模型与 effort 使用原单 Enter 选择；权限、MCP 变更及恢复继续保留各自必要确认，CAS、来源绑定与原 ID 查询不变。Question Tab 在选项与自定义编辑间切换；可选的纯输入题仍用 Tab 跳过，混合题用 Alt+S；多步骤 Esc 返回，第一步 Esc 精确取消原 Question Execution。计划意图和权限仍独立，Shift+Tab 只切换下一草稿 planning，不改活动 Run。

Ctrl+P 在运行、审批及 Question 草稿中直接打开权限面板，不解释或清空原答案的 slash 文本；Esc 返回原卡、步骤与缓冲。默认问卷的权限提示并入原 Alt+A 行，保留 80×24 的题号和选项高度。[权限回归](../../test/tui/permissions.test.tsx)核实际控制事件、主／子 scope、default／trust、选择中收到根变更、旧读晚回与原保存结果；[问卷回归](../../test/tui/questions.test.tsx)核实际按键切模式、原步骤／字面正文与准确答案身份。

Host 在 SSE ready、合法 `host_control.changed` 及首次／跨 Session 选择后重新读取准确权限，关闭面板时也更新状态显示。背景读取和面板保存使用独立读取身份及共同事实代次，不能让事件抢走在途原 POST／GET 的结果；晚回包不覆盖新 Session 或更新的事实。相同 controls 的刷新保留未提交确认，mode/default/trust 或 grants revision 真正变化才撤下原确认；读取失败移除不可核实的权限事实，后台成功或失败不覆盖其他操作的当前错误。事件只触发只读查询，不生成控制写入、Answer 或 Run。

混合选项题的自定义输入沿同一 `ComposerBuffer.row` 与实际宽度判断上下键：文本内部保留视觉行移动，首行向上／末行向下继续选项导航，空输入也能离开；切换不清空原草稿，不提交 Answer。纯输入题保持原上下编辑。Question footer 在自定义输入时仍提供方向键导航提示。[问答键盘回归](../../test/tui/questions.test.tsx)核空白／已输入自定义、Unicode 多行及窄行换行、Tab 往返和准确最终答案，实际 Host 问答旅程归 [CLI PTY](../../../../apps/cli/test/isolated/tui-question-pty.test.ts)。

Question 的取消 caller 向 Host 提供当前卡的准确 ID／revision／presentation 范围，Host 重新核原 pending Question 与 Execution 后才准备同一持久 `execution.cancel`。普通 Job 停止仍保 Job 专属核验；错卡、错 Scope、已终结或无法核实不取得 POST 资格。纯 `ask_user` 的实际原执行取消结果允许同 Run 继续，不能将其他 Tool 的 abort 或未知副作用当成问答取消成功。

Question 的可编辑状态取自 Controller 保存的准确原 Answer，匹配 Store／presentation Session／Interaction ID／revision；提交中、unknown 和保存已确认但卡片尚未更新时冻结原选项、正文与步骤，保 Ctrl+L 原查询、会话目录及整轮取消。明确未提交和 rejected 可编辑重试，不把另一卡的回执套到当前卡。新空草稿不立即报长度错误，原不合格提交、Unicode 长度和零 POST 门禁仍适用；问卷使用专用“提交回答”文案。失败 `ask_user` 保实际参数错误及原代码，并说明该调用未创建问卷，后续合法调用保持独立状态。

Files 目录 Enter 只读预览并进入范围确认，默认 both，次序为 both／session／code；确认页 Enter 才申请，数字键只选范围。独立 diff reader 的 Enter 不提交或重读目录。继承的恢复点标题按唯一原 message 出处绑定，不猜当前位置。完整“代码和会话”成功后，Controller 仍需 Host 的只读完成证明、准确原 intent／Scope 和读取代次才切换新会话、关闭面板并显示实际恢复数量；preview 数量或历史成功不足以代替当前证明。关闭、切范围和迟到结果不污染后来会话，代码审批及第二步继续仍需各自明确操作，详见[恢复指南](../../../../docs/handbook/clients/tui/guides/cancellation-and-recovery.md)。

仅测试 fixture 或可信 host 显式传入 `TuiSession({testDiagnostics:true})` 才显示 ID／协议 JSON／回执诊断；development 和正式启动均拒绝 `--test-ui-diagnostics`，环境变量不会启用诊断。诊断模式保留手动全文／附件读取，便于核原门禁；正常界面在所属消息／执行记录中保留真实失败、未知、部分内容与取消未确认；连接观察、队列读取和提交回执异常不再通过消息区外横幅、Error 行或 Ctrl+L 临时提示显示。观察与原申请只读核对自动退避重试，切范围或关闭时停止，不重放已尝试写入。两种模式使用同一新 Client／Service／Agent 业务链。

原 renderer／panel 与必要来源测试见 [Ink renderer](../../test/tui/ink-renderers.test.tsx)、[主屏集成](../../test/tui/ink-main-integration.test.tsx)、[source projection](../../test/tui/execution-ink-projection.test.tsx)、[scrollback](../../test/tui/scrollback.test.tsx)。实际终端和跨平台资格归 [CLI owner](../../../../apps/cli/README.md)及[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，不从复制组件推导阶段退出。

缺失工作区的已保存会话可以由 Host 明确准入 `workspace_missing` observer；主屏保留已读消息而不追加只读恢复横幅，首次配置不把它当 Trust 或 Model ready，新会话 readiness 保持 false。原主要选择器、模型、设置和 MCP 根面板的 Ctrl+C 先请求原整轮取消，不回答隐藏审批；Source Question 与新增原申请／执行／MCP 子 reader 的 Ctrl+C 只关闭所属读取，当前 Workflow 纯读取也保持局部取消。执行和配置权限继续由 Host／Agent 保持，界面标记不是授权。

[subagent-layout](subagent-layout.ts)按当前动态尾部、真实 child 步数和终端行数分配原步骤／子项预算；实际单 child 与 concurrent group 都接入预算，先折叠并显示最新摘要再进行有限裁切。`child-session-panel` 的详情用原 Markdown renderer 和 ScrollList 保持长代码、表格与 resize 阅读；Files 卡片接核实后的真实逐行变更，原路径、版本、基线和 UTF-8 门禁保留。

Footer Context 独立消费同 Store／Session／Run 的准确 Model 输入统计，`reportedInputTokens` 存在时优先使用（包括 0），缺失时回退完整原请求估算。当前活动模型或准确下一模型 ID 匹配才显示占比；Context 面板分别标明服务端返回和本地估算，并保留最近已核原请求。累计用量只用于原 usage／cache，不代替容量；无明确冻结窗口时不猜百分比。[Chrome](../../test/tui/chrome.test.tsx)和[实际面板按键](../../test/tui/local-controls.test.tsx)核实测／回退、0及空闲换模型不串占比。可选下一模型目录暂缺时，Header 只保留同范围最近已核原模型显示，nextModelName／nextEffort 仍未知；不把显示来源的暂失当作历史 scope 变化清空原生滚动，也不借原模型取得下一模型容量。[Error boundary](error-boundary.tsx)把渲染失败转为普通错误页和 Enter／Esc 退出，诊断调用栈只在显式测试模式显示；Host 观察实际 Ink 结束并拥有清理。

## MCP 安全目录与原选择意图

[MCP 保留目录](mcp-directory-panel.tsx)通过现有 `mcp.prompts`／`mcp.resources` Query 阅读原 list Record 的完整 descriptor、digest 与连接 binding；分页、详情、返回与取消均只读。冷连接标 historical，不把目录当成完整 get/read 正文。`/mcp__<server>__<prompt>` 沿[纯注册表](mcp-prompts.ts)只接完整目录中唯一、live、准确当前 configDigest／真实名称的候选，选择前再读并核实；与原 `INJECT_MCP_PROMPT` 一样只增加当前会话本地用户显示块，不创建 Run、连接或远端 RPC。


列表与Server详情提供独立“Saved tool snapshots”，冷或removed Server的历史不依赖当前目录成功。[tools state](mcp-tools.ts)及[panel](mcp-tools-panel.tsx)按原snapshot/generation/indexDigest逐页选择工具；名称预览标示未完整，description/inputSchema/outputSchema及其他原字段在公共reader完整EOF/hash后展示，有限10行viewport仍可Home/End、上下/左右到尾部。长Server ID的snapshot行先显示原generation，选择身份仍为完整record key。

controller固定原Session/Workspace/read generation及独立Abort；返回/关闭/切scope/迟到只释放所属reader，零业务Command/Model/cancel。分页非null next必须严格超过原afterKey，合法filtered空页仍可前进；失败或错binding没有complete。Port的三个metadata方法可选，旧consumer维持原能力；实际CLI Host全部实现。[新Ink/viewport反例](../../test/tui/mcp-tools.test.tsx)与原15MCP及Host组合25/550/0，核后页工具、Unicode长尾、长Server ID、错generation、闭合cursor、取消/迟回零business；真实HTTP/Artifact及源码外PTY由相应owner证明。

`/mcp` 保留固定命令优先级、无参数文法与可见 Select。独立 [MCP port](mcp.ts)只接固定安全 Query、Server选择提交及原结果lookup；[panel](mcp-panel.tsx)完整浏览安全管理目录与已穷尽分页的 live 工具目录，上下/Enter打开详情、选择用户或项目启停，再独立Enter确认。刷新和原结果查询来自可见选项，不恢复字母业务键；Esc 返回或关闭，根面板 Ctrl+C 请求原整轮取消，新增子 reader 的 Ctrl+C 只关闭读取。详情显示真实连接状态、合格工具／资源／提示词数量及固定配置位置，未读取数量保持未知；raw command/URL/env/header/credential/read-set hash 不渲染。

controller固定读取代次及原Store/Session/Workspace/identity/read-set，过期/只读/未准入时零提交。最多128个intent，不驱逐unknown；未知user写入阻止跨Workspace冲突、当前Workspace未知阻止本scope新写，CAS失败不换版本重投。host 私有 journal 恢复的意图先按未知显示，不恢复 readproof 或 POST 权利。列表与详情都提供同 Session 的保存原 ID，不依赖目录成功或 Server 存在；上下/Enter 仅选择，再显式选择原结果查询才 GET。accepted只等待，unknown只查原命令；关闭或换Session的迟到结果保原Map，不污染当前显示。严格decoder拒未来字段、错数组/长度/hash/enum；同scope读取失败保最后事实标unknown，GET成功不清SSE stale。

[Ink/controller测试](../../test/tui/mcp.test.tsx)当前15项501断言通过，包含空目录和失败目录中真实上下键选择第二个保存原 ID、再显式原查询且零 submit；较早数组 enum coercion 的严格字符串反例保留。普通Action/HostMutation效果、durable prepare 与冷 GET 由[CLI host](../../../../apps/cli/README.md#tui-mcp-目录与配置选择)负责；当前源码的实际 PTY 1项21断言另核 active Run/审批/草稿不被管理面板取消。[冷重开真实 TUI](../../../../apps/cli/test/isolated/tui-mcp-cold-pty.test.ts)另以真实80×24键盘在空目录选择第二原 ID，明确原查询后核原回执、冷轮零 POST，当前1项44断言只证明 macOS paired 正常退出后的重新打开；不混称独立 SIGKILL/物理丢响应资格。完整认证、重连、增删和三平台/安装资格仍按整体进度核对，不将有限启停当完整MCP中心。持久取舍及原Select理由见[scoped MCP提案](../../../../.agents/notes/proposed/architecture/2026-10-03-scoped-default-mcp-sources.md#当前-tui-的有限-server-选择)。

## MCP 项目来源与原决定申请

[Source DTO](mcp-source.ts)通过可选 `TuiMcpPort.source` 独立提供完整安全快照、原intent及有限fact，不导入Runtime、SQL或FS。[Source panel](mcp-source-panel.tsx)从空或失败的管理目录仍可进入，25项本地分页和原ID列表不借管理32项上限。有效workspace source binding/transport可Review，未准入、已拒绝、禁用及已准入均可申请，用户/程序源不获项目审批入口；独立确认只submit原申请后返回待决卡，不预答Question、不连接或授Tool权限。

[专用Question识别](mcp-source-question.ts)只接准确Source Action@1、pending question、原Execution/Store/S及request.kind。schema须闭合object/additionalProperties:false/required decision enum三值，choices同顺序string。[输入层](index.tsx)沿完整interactionKey隔离原Store/source/presentation/id/revision，初始unset；上下显式approved/rejected/cancel，空Enter零Answer。revision/scope清旧选择；该Question的Esc仅清选择/草稿，Ctrl+C再closePanel，均不业务取消；其他Question和credential分支保持。

controller的SourceReader沿Abort、generation、原S/W、panel及原Command ID阻止迟到覆盖。Source面板打开后由自己的完整读取维护观察；后台管理目录的认证补充读取不得替换该观察或清空已进入的Review。面板关闭时管理目录仍可发布完整Source事实，独立刷新及Session/Store变化继续使旧审批观察失效。原ID按同Workspace可跨Session或显示foreign Store，选择零GET、明确Check原S/Command才lookup；关闭/返回/切scope只结束所属读取。新申请冲突只核当前Store+Workspace+Server，unknown/pending不因换S解除。迟到submit结果更新原记录，不能覆盖后来选中的ID。cold journal终态只显示unknown；saved/failed/cancelled文案还要求有限fact匹配准确Store/S/Command/server/phase，pending只表示等待。

[Source controller/Ink](../../test/tui/mcp-source.test.tsx)当前27项152断言通过，原四controller/MCP/connection/Tools邻接63项873断言通过；固定文案沿[presentation](presentation.tsx)翻译，原Server metadata不翻译。当前证据涵盖明确选择/空Enter、schema/revision/presentation反例、同W跨S/foreign记录、removed/failed目录、迟到及关闭读取，不新增真实HTTP、PTY或异常清理资格；真实Host与源码外keyboard由[CLI owner](../../../../apps/cli/README.md#tui-mcp-项目来源决定与原申请)和[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)分别维护。

## MCP 显式连接与原申请

[独立 connection 类型](mcp-connection.ts)经可选 `TuiMcpPort.connection` 接线；UI只持确认、原意图与有限事实，不导入Agent runtime、SQL或宿主私有配置。当前有效目录中已admitted/selected/available的Server才有“Request connection”，先选操作再独立Enter核准确Server/source/transport/Session。controller把准确observed snapshot传给host，原Command和key各生成一次；列表/选择/确认第一步均不提交。普通Action和实际connection Job许可分别由Service决定。

独立Map、读取代次与Abort区分当前选中申请和所有保存申请。空/failed/removed目录仍提供同Session原ID；上下/Enter仅选择，独立“Check original connection”才GET。热提交晚到结果保存原Map，但不能覆盖后选ID、关闭面板或后来会话；lookup切换/关闭只abort所属reader。pending/unknown阻止同Store+Session+Server的新冲突，冷list按unknown恢复而不恢复热POST权或当前live证明，未知不删除。

显示原catalogue ready、当前live/currentGeneration与created/reused各自事实。accepted不显示ready，warm复用不称新建，冷ready不称当前live；错误或无法核验保持unknown。原Select和Tools菜单位置保留，新选项在同一五行viewport完整导航，无字母业务快捷键。关闭/Esc/Ctrl+C不取消已提交工作、原Run或审批。

[新connection controller/Ink](../../test/tui/mcp-connection.test.tsx)、原15Select、7Tools与7preferences组合当前38项699断言通过，覆盖确认、原ID零GET、明确查回、空失败目录、迟到及读取隔离。MCP与Tools固定提示沿[presentation catalog](presentation.tsx)翻译；Server ID、availability/reason、工具名称、描述及完整Schema JSON保持原文。[Tools中文键盘测试](../../test/tui/mcp-tools.test.tsx)实际切换语言、跨工具页及End至Unicode尾部，保持原metadata字节与已发布对象，切语言无新增reader或业务调用；英文源码外PTY不作为中文现场证明。真实普通审批、journal及源码外80×24暖/冷/共享detach资格归[CLI](../../../../apps/cli/README.md#tui-mcp-显式连接与原申请)。此切片提供显式新申请与warm复用，认证、强制重连、完整增删和三平台仍按整体进度核对。

## MCP HTTP 认证与原申请

Run 中的真实认证需要调用正式普通 Login Action，父 Tool 与 nested Action 在 Store 中绑定相同 root work、Actor 和取消边；这不替代独立认证审批。认证断言和实际 HTTP 范围由[原认证整文件](../../../../tests/tui-system/scenarios/mcp-authentication.test.ts)及[嵌套 Action](../../../../packages/agent/test/isolated/extensions/nested-actions.test.ts)覆盖。

[Auth DTO](mcp-auth.ts)与[panel](mcp-auth-panel.tsx)通过可选TuiPort.mcpAuth接当前HTTP Source和原Caller。完整fresh Source/read-set只用于新Review/独立Enter确认，Login/Refresh/Clear/Revoke均普通申请；UI不持Vault、网络、callback或热POST权。仅显示safe backend/presence/有限状态及原IDs，authenticated提示另行重连，不将Command.applied显示成功。

复用原Caller map/journal和execution.cancel。冷原ID/选择零GET，明确Check才caller.lookup+原结果Query；空/failed/removed Source仍保历史。unknown阻同scope冲突，不淘汰记录。Abort/generation/原Store/S/W/selected ID隔离Reader，迟到提交只保存原记录；关闭/Ctrl+C/切S不取消业务，取消需核准确原Execution再独立确认。

[Auth Ink](../../test/tui/mcp-auth.test.tsx)实际英文/中文Review/Confirm、冷第二ID→Check、语言切换零新增prepare/submit及原机器ID保真。[源码外80×24 Auth PTY](../../../../apps/cli/test/isolated/tui-mcp-auth-pty.test.ts)另核五次真实键盘Review/Confirm及Source/physical Workspace移除后的冷第二原ID→明确Check；普通Ask由observer SDK回答。Host、实际wire与资格范围归[CLI](../../../../apps/cli/README.md#tui-mcp-http-认证与原申请)，准确结果见[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。Ink和受控PTY不代替真实浏览器或OS Vault资格。

## MCP 强制重连与原申请

[独立 DTO](mcp-reconnection.ts)、[state](mcp-reconnection-state.ts)与[panel](mcp-reconnection-panel.tsx)通过可选 `TuiMcpPort.reconnection`接线。准确原 connection/R有限fact确认live后，Review调用host重新观察完整target和当前replacement；确认页独立Enter才产生本次原Command/key。UI不持Core ticket、transport、文件、vault或热POST权，原Action和新Job仍分别使用普通审批。

controller按原scope、selected ID、Abort和generation隔离读取，热submit迟到只更新原Map，不覆盖后选ID或后来Session。同Session原ID列表在空、失败、removed目录仍可进入；只选择零GET，明确Check才lookup。冷记录保持unknown；事实匹配原Store/S/Command/inputDigest及closed protocol后才显示ready/failed，旧停止、原ready代次和当前live/currentGeneration独立，合法当前代次可以高于原ready代次。

实际CLI事件刷新用 `select(sessionId, { preserveReconnectionReview: true })`，仅健康的同Session历史刷新保留准确原Review对象，不重观察或提交。显式选择、Session/Workspace变化、observation unavailable和失败历史快照仍使旧Review失效；失效时Abort既有在途Review/原查回Reader，迟到回复即使忽略Abort也不发布旧确认；随后恢复ready不复活它。健康后台刷新保留在途读取状态。独立Confirm继续核当前carrier及Host的完整fresh target/source/read-set，Scope关闭只释放Reader。[回归](../../test/tui/mcp-reconnection.test.tsx)实际27项165断言；当前全TUI24文件234项1968断言，均限对应测试范围。

未知原申请阻同Store+S+Server冲突，不淘汰128条或换key绕过。Esc/Ctrl+C 关闭重连子面板后返回父 MCP；父面板 Esc 只返回 Main，Ctrl+C 则请求原整轮取消；关闭子面板后待决卡继续，完成普通回答前不要求New Run composer出现。physical Workspace移除后父面板标题为unavailable，原结果读取仍可用。Scope关闭不取消R/Run/Job或原审批，固定文案沿presentation三locale，metadata和原身份保持。

[Ink/controller测试](../../test/tui/mcp-reconnection.test.tsx)覆盖独立确认、select零GET、冷/foreign/scope/late/unknown、ready/currentGeneration反例和上述后台刷新边界。真实Host、journal、源码外80×24和收尾资格分别归[CLI owner](../../../../apps/cli/README.md#tui-mcp-强制重连与原申请)及[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，不由UI fixture推导HTTP、完整默认或三平台。

## MCP 来源条目增删与原申请

[独立 DTO/port](mcp-source-mutation.ts)与[panel](mcp-source-mutation-panel.tsx)通过 `TuiMcpPort.sourceMutation`接固定 Source 操作。父面板“Source entry changes”在空目录或目录失败时仍可进入。Add 逐步编辑自己的 name/value buffer，选择 HTTP/STDIO 与 user/workspace；不调用 Composer、Workflow、模型或通用 raw patch。空 Enter、非法 URL/command 保原 draft；Review 可上下/Home/End 滚动，Enter 进入独立 Confirm，第二个 Enter 才 submit。普通 Action 审批和 project Source 批准仍分别走原交互。

Remove 先让Host以原scope/serverId/raw digest/read-set读取安全preview，Review/Confirm显示user fallback或无fallback。确认变更准确声明；自有OAuth本地清理、共享凭据保留和原连接未停止分别提示。UI不持文件、Vault、token、OS锁、Mutation authority或热POST权；saved只证明声明发布，可选credentialCleanup单独显示not-needed/completed/failed/unknown。

controller 隔离原 scope/generation/Abort/selected Command。来源目录与 preview/原申请查回使用各自有界 Reader；选择或查回原 ID 不取消目录读取，各自的 Reading 状态直到所属读取结束。同 Session 历史刷新保留这两种在途状态；关闭、切 Session/Workspace 取消两者，刷新目录只取消旧目录 Reader，忽略其迟到事实。原 ID 列表包含跨 Session 的相关 user/project来源意图；选择只切本地记录，明确 Check 才 lookup。cold/foreign 和不完整原事实保持 outcome_unknown；late submit 只回原 Map，不覆盖后来 Session 或所选原 ID。Esc 回表单步骤或父面板，Ctrl+C 只结束所属读取，已提交工作与普通审批继续。原 phase、ID、reason、来源 JSON、URL 和 command 保持原文；固定自有提示沿 [presentation catalog](presentation.tsx)提供三 locale。

[真实 Ink/controller 测试](../../test/tui/mcp-source-mutation.test.tsx)覆盖逐键编辑、空值零 submit、独立 Review/Confirm、fallback、原选择零 lookup、late/scope 和已关闭读取；HTTP、持久 journal、物理丢回复、源码外 PTY 与正常资源关闭分别由[CLI owner](../../../../apps/cli/README.md#tui-mcp-来源条目增删与原申请)和[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)提供实际证据。本地 UI 断言不代替 Service publication、OS vault、异常 cleanup、完整管理或三平台资格。

自动 MCP 目录观察只调用可选目录专用 `readDirectory`，没有该端口时不代用显式 Auth reader。不具真实 loginAllowed 的目标不取得凭据状态，未知仍未知；打开 Auth、Remove 和查询原请求分别保原独立行为。

取消反馈可以来自同 Scope、准确当前活动 Run 目标的真实已准备 caller 请求；它明确表示请求中，不补服务端 accepted 或 terminal。unknown、排队和后继目标不显示该活动反馈，子任务活动不会遮掉当前取消请求；原远端状态及实际清理仍独立核对。

后台详情读取同时选中准确原 Execution，目录中的其他 Tool／Job 不会遮住已读取的原输出或子会话。超长纯文本段落在进入 Ink 测量前按同一换行语义拆行，保留完整字符及 Unicode 边界；其他 Markdown 路径、原正文、完整读取与导出不变。完成正文留在终端原生历史，后续折叠和状态更新不要求重新打印原全文。

[MarkdownBlock](ink/MarkdownBlock.tsx) 的根布局以实际 `maxWidth` 限制整个正文列，短段落和行内格式也受约束，避免 Static 的无界测量把超宽行交给终端自行折行而丢失续行缩进。完整消息与流式分组继续使用各自原正文；原宽度变化、表格和代码布局保持。[普通主屏回归](../../test/tui/ink-main-integration.test.tsx)核中文、行内格式和完整字符，实际 80×24 正常入口的缩进与原字节持久化由 [CLI Ink Host](../../../../apps/cli/test/isolated/tui-ink-host.test.ts)核对。

`TuiMessage` 只为消息提示、正文及完整读取提示应用回复缩进，Thought 独立使用原 `ToolSummaryBlock` 的指示器留位，避免重复两列。普通 Thinking 的活动／结束标题与正文保持同列，原工具步骤缩进、时长来源和诊断布局保留；上述主屏与真实 CLI 回归同时核对标题列位置。

文件恢复的原请求观察更新当前详情和同一 canonical 原请求的已保存目录行，已确认成功不会仍显示旧 pending；其他请求保持原状态。此同步只消费已核回执，不提交恢复、不继续另一段，也不切换仅恢复代码的原会话。

尾部结果折叠在原键到达时更新同 Scope 的显示状态，连续 Enter 不依赖上一帧闭包；仅改变阅读状态，完整正文与原执行事实保持。按用户确认移除 Ctrl+T 入口及其显示状态，帮助和测试诊断不再提示该快捷键；完整 reader 和 serializer 仍核实、保存并导出原 reasoning。

模型端口的 `/model`、`/effort` 与首次配置统一使用 user scope；用户配置的来源与落盘由 Service 负责。跨项目会话保留独立读取/草稿，未核实的用户模型 mutation 阻止竞争新写；关闭面板仅释放读取。重复确认由 controller 的用户申请状态统一校验，pending/unknown 的重复按键保留核实原请求的提示，K 仅查询同一 ID；[模型测试](../../test/tui/models.test.tsx)覆盖真实面板按键与仍在等待回执的原请求。

原菜单命令保留忽略尾随文字的兼容行为；它们不从文字选择另一 Session、导出路径或扩大范围，显式管理命令仍校验参数。[命令测试](../../test/tui/management.test.tsx)与[导出测试](../../test/tui/export.test.ts)分别核这一解析边界和原完整正文／零额外读取。[真实 Thought 场景](../../../../tests/tui-system/scenarios/thought-lifecycle.test.ts)在下一次实际 Model 请求等待画面观察后才返回最终回答，核实活动搜索参数和结束后的复数摘要；同步点只属于本机 Provider 夹具，不增加生产展示延迟或放宽原观察预算。

`environment.context` 只表示最近已核实的原请求输入及其独立本地估算，`nextContext` 表示当前已保存上下文的下一请求预测，`usage` 为实际消费与统计覆盖。底部优先显示明确标为估算的下一请求数量；`/context` 同时区分三者，实际输入缺失明确不可用。错误 scope、空闲换模型或推理档位改变不把旧预测归给新选择；没有新增客户端测试入口。口径归 [Core](../../../agent/src/context-estimate.README.md)。
