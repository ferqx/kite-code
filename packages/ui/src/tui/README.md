# 独立终端消费者

## 原 Ink 展示与明确测试诊断

原 `apps/kite-cli/src/tui` 的纯 UI 已迁入 [ink](ink/MarkdownBlock.tsx)：Markdown 的增量闭合缓存、代码语言框与高亮、表格边框和中英文宽度，用户原文背景块与 30 行首尾窗口，工具五行预览／Shell tail、文件 diff、Thinking 聚合、子任务树、ConcurrentSubAgent、计划步骤与压缩阶段。主题色板、语言目录、frame、选择行、搜索框和首次配置保留原展示算法；不导入旧 Runtime、provider、reducer 或旧客户端。

[index](index.tsx)负责完整主屏消费。普通界面把完成内容一次写入终端原生历史，第一项仍变化的内容及其后续行留在动态区；列宽／会话／语言等语义变化才替换展示代次。长问题的完整材料进入原生历史，底部保留有限选择和输入窗口；编辑和观察状态变化不重发材料。主 composer 使用原双横线、❯、ghost 补全、命令说明／别名和 40 行光标窗口。Tab／首次 Enter 只补全，下一次 Enter 才提交；候选包括实际合格 Workflow 和当前完整 MCP prompt 目录。

[execution projection](execution-projection.tsx)只把已有公共事实转成原 renderer model。Tool input 来自同 Store／Session 的实际执行，或同 Run 唯一 callId／准确结果 sourceIds；正式短 builtin ID 须由冻结 Run 的 extension／definition／version 证明后才使用友好名称。MCP 代理名称只从同 Store／Session 的原 metadata snapshot／index 绑定与准确 definition/version 读取，再核 name hash；当前 Server label 还需 configDigest 匹配，历史使用 MCP 加真实工具名。只读聚合使用原冻结 `readOnlyDefinitions`，并发使用同 Model 批次的 task／carrier 关系以及实际生命周期交叠。无证明者单列，失败、取消和 unknown 不折成成功。未知工具参数保留有界卡片预览及完整详情，Ctrl+E 可选中间卡片；准确 Job 才取得完整输出、child 阅读和停止入口。

宿主在原 refresh 中读取准确活动 Model 前缀、已验证 child views、有限 Shell tail、已批准计划及真实压缩阶段，没有独立轮询器。正常完成 Model 的全文和必要交互附件自动使用现有完整 reader；保留原 Store／Session／Run／Execution、UTF-8、EOF/hash 与未完整读取不得答复的门禁。失败可以 Ctrl+O／Ctrl+A 明确重读，未来或不支持的格式不猜正文。思考正文可 Ctrl+T 展开，完整读取只读、不派发 Tool。

[首次配置](onboarding-panel.tsx)沿原 Trust／Provider／Connection／Manual Model 流程接新的 [onboarding port](onboarding.ts)。没有可用默认时可配置 Provider，也可用原 enabled/default CAS 选已有模型。秘密仅在遮罩输入和一次热 POST 内，unknown 只 GET 原 mutation；输入、配置和身份校验仍由新 Service／Agent 完成。

模型、权限、会话、Files、MCP、Skills、语言、主题、帮助与交互面板使用原纯 frame／行布局，完整目录及描述保留。原 CAS、独立确认、来源绑定、原 ID 查询和局部取消不变。Question Tab 在选项与自定义编辑间切换；可选的纯输入题仍用 Tab 跳过，混合题用 Alt+S；多步骤 Esc 返回，第一步 Esc 精确取消原 Question Execution。计划意图和权限仍独立，Shift+Tab 只切换下一草稿 planning，不改活动 Run。

`TuiSession({testDiagnostics:true})` 或明确测试参数才显示 ID／协议 JSON／回执诊断；development 默认使用普通界面。诊断模式保留手动全文／附件读取，便于核原门禁；正常界面保留真实失败、未知、部分内容与取消未确认。两种模式使用同一新 Client／Service／Agent 业务链。

原 renderer／panel 与必要来源测试见 [Ink renderer](../../test/tui/ink-renderers.test.tsx)、[主屏集成](../../test/tui/ink-main-integration.test.tsx)、[source projection](../../test/tui/execution-ink-projection.test.tsx)、[scrollback](../../test/tui/scrollback.test.tsx)。实际终端和跨平台资格归 [CLI owner](../../../../apps/cli/README.md)及[当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，不从复制组件推导阶段退出。

## MCP 安全目录与原选择意图

[MCP 保留目录](mcp-directory-panel.tsx)通过现有 `mcp.prompts`／`mcp.resources` Query 阅读原 list Record 的完整 descriptor、digest 与连接 binding；分页、详情、返回与取消均只读。冷连接标 historical，不把目录当成完整 get/read 正文。`/mcp__<server>__<prompt>` 沿[纯注册表](mcp-prompts.ts)只接完整目录中唯一、live、准确当前 configDigest／真实名称的候选，选择前再读并核实；与原 `INJECT_MCP_PROMPT` 一样只增加当前会话本地用户显示块，不创建 Run、连接或远端 RPC。


列表与Server详情提供独立“Saved tool snapshots”，冷或removed Server的历史不依赖当前目录成功。[tools state](mcp-tools.ts)及[panel](mcp-tools-panel.tsx)按原snapshot/generation/indexDigest逐页选择工具；名称预览标示未完整，description/inputSchema/outputSchema及其他原字段在公共reader完整EOF/hash后展示，有限10行viewport仍可Home/End、上下/左右到尾部。长Server ID的snapshot行先显示原generation，选择身份仍为完整record key。

controller固定原Session/Workspace/read generation及独立Abort；返回/关闭/切scope/迟到只释放所属reader，零业务Command/Model/cancel。分页非null next必须严格超过原afterKey，合法filtered空页仍可前进；失败或错binding没有complete。Port的三个metadata方法可选，旧consumer维持原能力；实际CLI Host全部实现。[新Ink/viewport反例](../../test/tui/mcp-tools.test.tsx)与原15MCP及Host组合25/550/0，核后页工具、Unicode长尾、长Server ID、错generation、闭合cursor、取消/迟回零business；真实HTTP/Artifact及源码外PTY由相应owner证明。

`/mcp` 保留固定命令优先级、无参数文法与可见 Select。独立 [MCP port](mcp.ts)只接固定安全 Query、Server选择提交及原结果lookup；[panel](mcp-panel.tsx)完整浏览32项有界目录，上下/Enter打开详情、选择用户或项目启停，再独立Enter确认。刷新和原结果查询来自可见选项，不恢复字母业务键；Esc/Ctrl+C只停止所属读取，原Run/审批不取消。有限源ID和状态可见，raw command/URL/env/header/credential/read-set hash不渲染。

controller固定读取代次及原Store/Session/Workspace/identity/read-set，过期/只读/未准入时零提交。最多128个intent，不驱逐unknown；未知user写入阻止跨Workspace冲突、当前Workspace未知阻止本scope新写，CAS失败不换版本重投。host 私有 journal 恢复的意图先按未知显示，不恢复 readproof 或 POST 权利。列表与详情都提供同 Session 的保存原 ID，不依赖目录成功或 Server 存在；上下/Enter 仅选择，再显式选择原结果查询才 GET。accepted只等待，unknown只查原命令；关闭或换Session的迟到结果保原Map，不污染当前显示。严格decoder拒未来字段、错数组/长度/hash/enum；同scope读取失败保最后事实标unknown，GET成功不清SSE stale。

[Ink/controller测试](../../test/tui/mcp.test.tsx)当前15项501断言通过，包含空目录和失败目录中真实上下键选择第二个保存原 ID、再显式原查询且零 submit；较早数组 enum coercion 的严格字符串反例保留。普通Action/HostMutation效果、durable prepare 与冷 GET 由[CLI host](../../../../apps/cli/README.md#tui-mcp-目录与配置选择)负责；当前源码的实际 PTY 1项21断言另核 active Run/审批/草稿不被管理面板取消。[冷重开真实 TUI](../../../../apps/cli/test/isolated/tui-mcp-cold-pty.test.ts)另以真实80×24键盘在空目录选择第二原 ID，明确原查询后核原回执、冷轮零 POST，当前1项44断言只证明 macOS paired 正常退出后的重新打开；不混称独立 SIGKILL/物理丢响应资格。完整认证、重连、增删和三平台/安装资格仍按整体进度核对，不将有限启停当完整MCP中心。持久取舍及原Select理由见[scoped MCP提案](../../../../.agents/notes/proposed/architecture/2026-10-03-scoped-default-mcp-sources.md#当前-tui-的有限-server-选择)。

## MCP 项目来源与原决定申请

[Source DTO](mcp-source.ts)通过可选 `TuiMcpPort.source` 独立提供完整安全快照、原intent及有限fact，不导入Runtime、SQL或FS。[Source panel](mcp-source-panel.tsx)从空或失败的管理目录仍可进入，25项本地分页和原ID列表不借管理32项上限。有效workspace source binding/transport可Review，未准入、已拒绝、禁用及已准入均可申请，用户/程序源不获项目审批入口；独立确认只submit原申请后返回待决卡，不预答Question、不连接或授Tool权限。

[专用Question识别](mcp-source-question.ts)只接准确Source Action@1、pending question、原Execution/Store/S及request.kind。schema须闭合object/additionalProperties:false/required decision enum三值，choices同顺序string。[输入层](index.tsx)沿完整interactionKey隔离原Store/source/presentation/id/revision，初始unset；上下显式approved/rejected/cancel，空Enter零Answer。revision/scope清旧选择；该Question的Esc仅清选择/草稿，Ctrl+C再closePanel，均不业务取消；其他Question和credential分支保持。

controller的SourceReader沿Abort、generation、原S/W、panel及原Command ID阻止迟到覆盖。原ID按同Workspace可跨Session或显示foreign Store，选择零GET、明确Check原S/Command才lookup；关闭/返回/切scope只结束所属读取。新申请冲突只核当前Store+Workspace+Server，unknown/pending不因换S解除。迟到submit结果更新原记录，不能覆盖后来选中的ID。cold journal终态只显示unknown；saved/failed/cancelled文案还要求有限fact匹配准确Store/S/Command/server/phase，pending只表示等待。

[Source controller/Ink](../../test/tui/mcp-source.test.tsx)当前24项132断言通过，原四controller/MCP/connection/Tools邻接63项873断言通过；固定文案沿[presentation](presentation.tsx)翻译，原Server metadata不翻译。当前证据涵盖明确选择/空Enter、schema/revision/presentation反例、同W跨S/foreign记录、removed/failed目录、迟到及关闭读取，不新增真实HTTP、PTY或异常清理资格；真实Host与源码外keyboard由[CLI owner](../../../../apps/cli/README.md#tui-mcp-项目来源决定与原申请)和[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)分别维护。

## MCP 显式连接与原申请

[独立 connection 类型](mcp-connection.ts)经可选 `TuiMcpPort.connection` 接线；UI只持确认、原意图与有限事实，不导入Agent runtime、SQL或宿主私有配置。当前有效目录中已admitted/selected/available的Server才有“Request connection”，先选操作再独立Enter核准确Server/source/transport/Session。controller把准确observed snapshot传给host，原Command和key各生成一次；列表/选择/确认第一步均不提交。普通Action和实际connection Job许可分别由Service决定。

独立Map、读取代次与Abort区分当前选中申请和所有保存申请。空/failed/removed目录仍提供同Session原ID；上下/Enter仅选择，独立“Check original connection”才GET。热提交晚到结果保存原Map，但不能覆盖后选ID、关闭面板或后来会话；lookup切换/关闭只abort所属reader。pending/unknown阻止同Store+Session+Server的新冲突，冷list按unknown恢复而不恢复热POST权或当前live证明，未知不删除。

显示原catalogue ready、当前live/currentGeneration与created/reused各自事实。accepted不显示ready，warm复用不称新建，冷ready不称当前live；错误或无法核验保持unknown。原Select和Tools菜单位置保留，新选项在同一五行viewport完整导航，无字母业务快捷键。关闭/Esc/Ctrl+C不取消已提交工作、原Run或审批。

[新connection controller/Ink](../../test/tui/mcp-connection.test.tsx)、原15Select、7Tools与7preferences组合当前38项699断言通过，覆盖确认、原ID零GET、明确查回、空失败目录、迟到及读取隔离。MCP与Tools固定提示沿[presentation catalog](presentation.tsx)翻译；Server ID、availability/reason、工具名称、描述及完整Schema JSON保持原文。[Tools中文键盘测试](../../test/tui/mcp-tools.test.tsx)实际切换语言、跨工具页及End至Unicode尾部，保持原metadata字节与已发布对象，切语言无新增reader或业务调用；英文源码外PTY不作为中文现场证明。真实普通审批、journal及源码外80×24暖/冷/共享detach资格归[CLI](../../../../apps/cli/README.md#tui-mcp-显式连接与原申请)。此切片提供显式新申请与warm复用，认证、强制重连、完整增删和三平台仍按整体进度核对。

## MCP HTTP 认证与原申请

[Auth DTO](mcp-auth.ts)与[panel](mcp-auth-panel.tsx)通过可选TuiPort.mcpAuth接当前HTTP Source和原Caller。完整fresh Source/read-set只用于新Review/独立Enter确认，Login/Refresh/Clear/Revoke均普通申请；UI不持Vault、网络、callback或热POST权。仅显示safe backend/presence/有限状态及原IDs，authenticated提示另行重连，不将Command.applied显示成功。

复用原Caller map/journal和execution.cancel。冷原ID/选择零GET，明确Check才caller.lookup+原结果Query；空/failed/removed Source仍保历史。unknown阻同scope冲突，不淘汰记录。Abort/generation/原Store/S/W/selected ID隔离Reader，迟到提交只保存原记录；关闭/Ctrl+C/切S不取消业务，取消需核准确原Execution再独立确认。

[Auth Ink](../../test/tui/mcp-auth.test.tsx)实际英文/中文Review/Confirm、冷第二ID→Check、语言切换零新增prepare/submit及原机器ID保真。[源码外80×24 Auth PTY](../../../../apps/cli/test/isolated/tui-mcp-auth-pty.test.ts)另核五次真实键盘Review/Confirm及Source/physical Workspace移除后的冷第二原ID→明确Check；普通Ask由observer SDK回答。Host、实际wire与资格范围归[CLI](../../../../apps/cli/README.md#tui-mcp-http-认证与原申请)，准确结果见[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。Ink和受控PTY不代替真实浏览器或OS Vault资格。

## MCP 强制重连与原申请

[独立 DTO](mcp-reconnection.ts)、[state](mcp-reconnection-state.ts)与[panel](mcp-reconnection-panel.tsx)通过可选 `TuiMcpPort.reconnection`接线。准确原 connection/R有限fact确认live后，Review调用host重新观察完整target和当前replacement；确认页独立Enter才产生本次原Command/key。UI不持Core ticket、transport、文件、vault或热POST权，原Action和新Job仍分别使用普通审批。

controller按原scope、selected ID、Abort和generation隔离读取，热submit迟到只更新原Map，不覆盖后选ID或后来Session。同Session原ID列表在空、失败、removed目录仍可进入；只选择零GET，明确Check才lookup。冷记录保持unknown；事实匹配原Store/S/Command/inputDigest及closed protocol后才显示ready/failed，旧停止、原ready代次和当前live/currentGeneration独立，合法当前代次可以高于原ready代次。

实际CLI事件刷新用 `select(sessionId, { preserveReconnectionReview: true })`，仅健康的同Session历史刷新保留准确原Review对象，不重观察或提交。显式选择、Session/Workspace变化、observation unavailable和失败历史快照仍使旧Review失效；失效时Abort既有在途Review/原查回Reader，迟到回复即使忽略Abort也不发布旧确认；随后恢复ready不复活它。健康后台刷新保留在途读取状态。独立Confirm继续核当前carrier及Host的完整fresh target/source/read-set，Scope关闭只释放Reader。[回归](../../test/tui/mcp-reconnection.test.tsx)实际27项165断言；当前全TUI24文件234项1968断言，均限对应测试范围。

未知原申请阻同Store+S+Server冲突，不淘汰128条或换key绕过。Esc/Ctrl+C关闭重连子面板后返回父MCP，再关闭父面板回Main；待决卡继续，完成普通回答前不要求New Run composer出现。physical Workspace移除后父面板标题为unavailable，原结果读取仍可用。Scope关闭不取消R/Run/Job或原审批，固定文案沿presentation三locale，metadata和原身份保持。

[Ink/controller测试](../../test/tui/mcp-reconnection.test.tsx)覆盖独立确认、select零GET、冷/foreign/scope/late/unknown、ready/currentGeneration反例和上述后台刷新边界。真实Host、journal、源码外80×24和收尾资格分别归[CLI owner](../../../../apps/cli/README.md#tui-mcp-强制重连与原申请)及[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)，不由UI fixture推导HTTP、完整默认或三平台。

## MCP 来源条目增删与原申请

[独立 DTO/port](mcp-source-mutation.ts)与[panel](mcp-source-mutation-panel.tsx)通过 `TuiMcpPort.sourceMutation`接固定 Source 操作。父面板“Source entry changes”在空目录或目录失败时仍可进入。Add 逐步编辑自己的 name/value buffer，选择 HTTP/STDIO 与 user/workspace；不调用 Composer、Workflow、模型或通用 raw patch。空 Enter、非法 URL/command 保原 draft；Review 可上下/Home/End 滚动，Enter 进入独立 Confirm，第二个 Enter 才 submit。普通 Action 审批和 project Source 批准仍分别走原交互。

Remove 先让Host以原scope/serverId/raw digest/read-set读取安全preview，Review/Confirm显示user fallback或无fallback。确认变更准确声明；自有OAuth本地清理、共享凭据保留和原连接未停止分别提示。UI不持文件、Vault、token、OS锁、Mutation authority或热POST权；saved只证明声明发布，可选credentialCleanup单独显示not-needed/completed/failed/unknown。

controller 隔离原 scope/generation/Abort/selected Command。来源目录与 preview/原申请查回使用各自有界 Reader；选择或查回原 ID 不取消目录读取，各自的 Reading 状态直到所属读取结束。同 Session 历史刷新保留这两种在途状态；关闭、切 Session/Workspace 取消两者，刷新目录只取消旧目录 Reader，忽略其迟到事实。原 ID 列表包含跨 Session 的相关 user/project来源意图；选择只切本地记录，明确 Check 才 lookup。cold/foreign 和不完整原事实保持 outcome_unknown；late submit 只回原 Map，不覆盖后来 Session 或所选原 ID。Esc 回表单步骤或父面板，Ctrl+C 只结束所属读取，已提交工作与普通审批继续。原 phase、ID、reason、来源 JSON、URL 和 command 保持原文；固定自有提示沿 [presentation catalog](presentation.tsx)提供三 locale。

[真实 Ink/controller 测试](../../test/tui/mcp-source-mutation.test.tsx)覆盖逐键编辑、空值零 submit、独立 Review/Confirm、fallback、原选择零 lookup、late/scope 和已关闭读取；HTTP、持久 journal、物理丢回复、源码外 PTY 与正常资源关闭分别由[CLI owner](../../../../apps/cli/README.md#tui-mcp-来源条目增删与原申请)和[总体进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)提供实际证据。本地 UI 断言不代替 Service publication、OS vault、异常 cleanup、完整管理或三平台资格。
