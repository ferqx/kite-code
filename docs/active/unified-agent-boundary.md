# 通用 Agent 新执行边界

新普通输入沿原 Command 直接进入当前主 Agent，不创建分类 Run、判定回复或派生输入；`input.steer/input.follow_up` 保持准确目标与队列规则。旧历史消息的 `humanInput` 只读证明沿 [SQL 输入 owner](../../packages/agent/src/storage/sqlite/inputs/README.md) → Service 同源 schema／生成 Client → [Native](../../apps/desktop/README.md#真实输入消息的唯一展示)交接。原 public/raw/processing/decision/business 与准确已应用 Message／Run 共同证明同一次输入，不以相同正文或 ID 前缀猜测；消息分页保原行和原序号。Native 仅在当前读取存在准确替代消息时合并处理副本，首次占位沿原公开提交 ID 交接，独立同文和未决输入保留。呈现证明不参与权限、业务准入或恢复授权。

待消费输入队列沿 [Store](../../packages/agent/src/storage/README.md#待消费输入的撤回与排序) → [Runtime](../../packages/agent/README.md#人类输入工作选择与可靠结果) → [Service](../../apps/service/README.md#待消费输入队列协议) → [Client](../../packages/client/README.md#待消费输入队列) → [Native](../../apps/desktop/README.md#原运行中消息队列)交接。持久 `pending_order` 与原不可变 `seq` 分开，真实消费使用前者；原 request、附件、digest 和历史出处不重写，`result.include` 保原槽。`pending_input_queue` 是单独能力，精确 `input.withdraw/input.reorder` 只变更原根、原主体尚未消费的合法集合，revision CAS 与单调变更计数阻止过期及 ABA；撤回不等于取消 Run／Execution。Main 只接受已观察 ID，不接 renderer 自报请求或 Store；首次写入前保存原意图，未知只查询同 ID。编辑已确认撤回后才交付普通 draft，交付 ack 前可显式查原操作取回原文，重开不重发、不恢复队列或自动覆盖草稿。事务、生成协议、私有DB11与实际验证分别由上述 owner 维护，UI 排序或持久 journal 都不签发新的执行或审批权。

用户直接图片沿 [Native](../../apps/desktop/README.md#markdown-与附件输入) → [Service](../../apps/service/README.md#图片输入协议) → [Agent](../../packages/agent/README.md#用户图片输入) → [AI](../../packages/ai/README.md#图片消息)交接。Native 的单一“添加文件”入口以实际 File 自动分流；沙箱 preload 仅从磁盘 File 解析路径，不接受字符串路径读取或隐式获取正文。Native 只暂存用户交付的受限字节；每次新输入最多 10 张图片，由窗口、Native 提交、HTTP 与 Agent 受理独立核实，旧历史不裁剪；普通文件选择以独立 `files` 名称／URI 元数据进入原 Command 和 Message，不改写正文，Runtime 只在模型历史组装时追加低权限路径文本，不把路径授给新 I/O 接口。HTTP 上传先核真实身份／作用域，原 Artifact 发布后才返回稳定引用；输入事务核全部元数据，模型历史完整读回原图，SQL 基线保持。图片只映射为 Chat Completions／Responses 的内联 Base64，不隐式获取远程 URL、不上传到公网存储或引入 Anthropic Messages；读取不取得执行权限。已发布正文沿既有备份／Fork／保留边界，未知 Command 只查原结果。公开能力 `input_images`、可选引用字段和生成协议由 Service owner 维护，Web 不增加写入入口。

状态：active

附件元数据随原普通 Command 和准确 Message 保存；补充及新轮次不改写正文或静默丢失图片／文件。旧 public/raw/decision/business 链只供历史兼容。附件路径和图片内容是低信任资料，不能产生停止或批准；Store／Session／subject、请求摘要及实际应用回执分别核验。稳定 child 的管理核真实直接父子和当前工具授权，后续普通父轮次可以接纳原 child 的具名结果；Source/consume/ack 保准确来源与目标，不以技术 rootWork 相等代替权限。

实际创建父续 Run 的 child 结果才投影为独立公共 Message，须沿原 Source／carrier／revision、consume 和 idle report 回执核对真实目标 Run 的创建来源；原 active 接纳后来结束也不补气泡，不能用 Run 当前活动状态猜历史时机。投影不另写普通消息造成模型双重接收，展示名称和正文不取得人类输入或执行授权；大型结果预览必须明确完整性。具体证明与分页由 [Store owner](../../packages/agent/src/storage/README.md#人类工作与完成报告事务)维护。

后台 Job 目录的来源观察沿 [Store](../../packages/agent/src/storage/README.md#跨会话原-job-目录) → [Service](../../apps/service/README.md#后台目录的来源投影) → [Client](../../packages/client/README.md) → [Native](../../apps/desktop/README.md#native-当前会话环境信息与子详情) 交接。`includeSourceTool:true` 只读取同原 Session／Store／root work 的直接父 Tool ID／定义／版本；默认响应保持原闭合结构，工具正文和授权材料不进入来源投影。来源缺失不推断后台身份，取消边不作为前后台标记。该观察不扩大读取或停止 authority，不改原 Job、取消和冷恢复边界。

自动权限检查沿 [权限 owner](../../packages/agent/src/permissions/README.md)与 Core 的 `authorization.check`／`authorizationCheck` 执行，记录一次原 Session 内的无 Run Model；它不创建或管理子 Agent。通用子 Agent 共用创建、执行、生命周期与渲染，`review` 等只作类别配置。内部检查与标题 Model 的 `runId:null` 由准确用途／父目标／原命令／Store／主体／root work 与封存请求证明认证，不向普通 runless Model 开放。Service 同源 schema、生成 Client 与 Inspector 保留可空 Run；后台 Job 目录仍只取真实 Job，因此自然不出现这些内部 Model 的 child 项。新完整检查结果和旧 `authorization.review` 原 proof 均保留读取，冷读不启动模型；[HTTP 回归](../../apps/service/test/isolated/authorization-review-history.test.ts)、[标题回归](../../packages/agent/test/isolated/execution/session-title-generation.test.ts)与[准备窗口分页](../../packages/agent/test/isolated/model-input/authorization-check-window.test.ts)分别核这些边界。

[模型工具投影](../../packages/agent/src/model-tools.README.md)在 Agent 的实际 `ModelAdapter` 边界完成：内部 ModelRequest／ToolCall 保留原定义 ID/version 和规范参数，leaf 的纯 `ToolDefinition.model` 仅描述公开名、声明字段映射与隐藏资格。完整模型调用先按本轮准确目录校验、转回内部参数，再进入原来源、权限、资源、计划、派发与终态链路；未知工具、坏参数和碰撞不得形成效果。声明字段可转 snake_case，任意业务 JSON 与动态 MCP 原 schema/arguments 不改写；baseline、操作 key 和去重身份保留。持久 `ToolCall.model` 只存原公开名称、精简字段路径及必要错误，后继模型历史不借当前定义重解释原调用；`metadata.context.toolSurface` 封存当时公开工具，公开 Inspector 使用该原快照并保持既有完整正文与 scope 核验。本次不提供旧会话工具消息兼容，不增加旧名 alias；原 Store/Runtime authority 不随命名变化。普通协作目录恰好为 `spawn_agent/send_agent_message/follow_up_agent/wait_agent_events/list_agents/interrupt_agent`。等待属于自身邮箱，使用 `after_seq/wait_ms`；有限分段等待不复用旧 task-ID wait-any 协议，旧名无模型 alias。隐藏旧定义只为实际内部调用及准确历史恢复保留，不从当前目录重解释旧记录。跨层实现归 [Execution](../../packages/agent/src/execution/index.ts)、[Model metadata](../../packages/agent/src/model-snapshot.ts)和上述 owner，具体验证以本轮实际测试范围为准。

同 Session 当前 selection／upperSeq 内已接纳的结果保留为普通会话的低信任历史，不按技术 rootWork 隔离后续输入，也不由可读历史取得旧执行授权。复用既有 automatic Source 的显式 Include 另按所选范围和冻结水位核应用证明；active 的 explicit 资格以真实检查点发布为界，不把 queued 当作采用，也不改写旧 Source 或旧自动报告接纳。Rewind fence、原配置、批准和执行权限独立保持，Service/Client 不从历史 Source 或展示状态推导新授权。完整读取、取消与快照合同归 [Context owner](../../packages/agent/src/storage/sqlite/context/README.md)，业务输入与选择归 [输入 owner](../../packages/agent/src/storage/sqlite/inputs/README.md)。

Extension 通过 `lifecycle.onRunStart/onRunEnd/onModelStart/onModelEnd` 观察原 Run/Model 事实；Model start 在派发准入 ACK 和取消复核后发布，Run start 在激活 ACK 后发布，end 以已提交终态为准。Model 使用实际冻结 Step 的注册，Run 使用原 Run 绑定。通知是有限冻结投影，不提供 SQL、owner、正文、Provider raw、operations 或资源句柄；权限、必要条件和完成 CAS 继续独立执行。有限观察队列可以丢通知，异常局部停用，不持 Run lease/permit、不参与执行成功或关闭判定。Run 终态与 Job 实际停止/资源释放保持分离；普通读取和重复原 Command 不重放，恢复只观察本次推进到的 Model 边界和新到达的 Run 终态，不补发原 Run start。需要可靠后续业务仍须登记原受控意图。当前接口、执行图、压力与真实 SQLite/恢复证据归[Agent 生命周期 owner](../../packages/agent/README.md#生命周期扩展)及[生命周期观察决定](../../.agents/notes/implemented/architecture/2026-10-18-settled-lifecycle-observers.md)。

Run 扩展通过 `lifecycle.beforeRun/beforeRunComplete` 在显式任务输入的启动前和正常完成前按注册顺序选择自身已注册的普通 Action，Core 复用原 Command、权限、namespace、取消和执行事实；内部 child 和自动 Job report 不进入这两个钩子，避免业务递归。Core 不内置标题规则。默认会话命名扩展由 Service 装配，只有真实正在执行的 `builtin.session-title/generate@1` Action 可以调用受限 `runInternalModel`，在原 Session 保存 `session.title` 的无 Run、无工具 Model Execution，不创建 child Session、Run、carrier 或聊天 Message。它复用原任务选中的模型与通用完整输出格式，使用独立 checkpoint，不改变主 Run 的模型检查点或上下文。 标题用途认证只证明真实来源，不能替代模型授权：原宿主当前控制与注入 ceiling、`resolveModel` 返回的 Model policy 继续相交，共享 Model 槽取得前及取得槽并核 checkpoint 后分别检查；原 inputDigest、controlReads 与非秘密授权快照进入最终 SQL 复核。标题复用 Session rename CAS、单次尝试和 10 秒取消；停止未确认保留原 partial 与 outcome_unknown，晚结果不能改名或覆盖未知终态。消息写入不隐式改名，客户端创建只提供空 title 标记；没有标题用途公共 DTO 或标题重放入口。当前接口与验证归[Agent owner](../../packages/agent/README.md#入口与职责)、[Service owner](../../apps/service/README.md#默认装配与业务规则归属)和[生命周期取舍](../../.agents/notes/implemented/architecture/2026-10-18-run-lifecycle-extension-actions.md)。

Windows daemon 的可信装配可借用本进程已经完成准入的原 live artifact owner，绑定 proof、entry、executable 与 build；借用未归还、关闭开始、复制或伪造均拒绝。新的实际进程仍独立取得锁/原文件 pin 并全量核验，不向 startup JSON、配置或 HTTP 增加借用能力。原 HANDLE 内容事实和批量私有复制不改变 Files 授权、维护 EX、精确取消或关闭未知保资源的合同。实现归 [Service owner](../../apps/service/README.md)和 [platform owner](../../packages/agent/src/platform/README.md)，取舍归[闭包成本决定](../../.agents/notes/implemented/bug-fix/2026-10-17-windows-bundle-admission-cost.md)。

Model 用量通过 [AI 中立事件](../../packages/ai/src/index.ts)的独立 `usage` 快照交接，完整 finish 与工具派发仍分别核实。[Agent Execution](../../packages/agent/src/execution/index.ts)在成功、失败、取消结果中保留已收输入／输出、缓存、推理、原服务端总数及 `usage.raw`；只保存响应中的用量叶子，不复制 headers、凭据或其他原响应。未收到、无效或旧记录未保存的测量保持未知，原始明细不生成授权或执行成功。TUI 同原请求优先显示实测输入，缺失才用本地估算；完整 Model 输入身份与冻结容量仍独立核实，累计统计不代替当前上下文。既有 JSON result 承载新增可选字段，SQL baseline 与公开 HTTP schema 保持。当前接口、限制和实测范围归 [AI](../../packages/ai/README.md)、[Agent](../../packages/agent/README.md)和 [CLI Host](../../apps/cli/README.md)。

Workspace Files 模型工具在 [Files owner](../../packages/agent/src/tools/files/README.md#模型工具路径)按可信固定根把项目内绝对路径转换为相对路径，转换发生在原 IO／检查点 capture 前；原调用及审批保存完整原参数。底层相对路径和原目录对象约束、独立外部文件授权保持。Native 仅对唯一原 `files.list@1` 调用的省略／空路径显示已知默认 `.`；缺来源／歧义／未来版本不补目标，显示文本不授予文件动作。

外部文件授权摘要、派发复查和读取 baseline 共用 [Files 原生身份](../../packages/agent/src/tools/files/README.md#绝对用户文件)；Windows 的 volume／128-bit FileID 不与 Node stat 身份混比。派发在实际已锚定的父目录对象上重核，目标或父对象替换继续拒绝；严格 owner／单链接、受保护路径、准确原参数和外部文件排除 Workspace 检查点的合同保持。

普通宿主默认选择外部只读 `files.read_path`，供文件引用和准确绝对路径任务使用；没有默认增加外部写入或编辑工具。此项只补齐 Model 工具目录，仍由原权限和原生对象边界决定准确目标能否读取，不扩工作区工具根或读取外部项目说明。最小嵌入配置与显式禁用保持，当前装配与验证归 [Service owner](../../apps/service/README.md#默认装配与业务规则归属)。

Files 的原生 I/O 沿 [Node-API owner](../../packages/agent/native/files/README.md)统一；cap-std 提供能力对象和读写，官方 SDK 补齐 Windows 原 HANDLE／完整 FileID／DACL／发布与关闭未知。Tool、Loop、检查点格式和授权接口不变；固定资产先核平台、CPU、ABI、hash 和无 symlink／单链接，缺失不回退。正式 Service 将 `filesNativeAssets()` 的加载器和整个 companion 加入普通／外部 Files 与恢复保护，包含 Full；位置不来自 Model／HTTP／JSONC。其他原生 owner 不随此切换。

客户端测试专用的调试入口、诊断展示和辅助控件只允许由隔离测试夹具或明确测试制品开启，dev 与 prod 客户端必须关闭。公开启动参数、环境变量、URL 或环境名不提供开启资格；TUI 普通入口拒绝 `--test-ui-diagnostics`，Native 的开发与正式 renderer 将测试常量固定为 false，组件传入 true 也不能覆盖该值。测试目录的入口可向可信 host 显式传 `testDiagnostics:true`，测试 Native 可单独构建诊断制品；共享 Desktop context 默认关闭，不再按 `NODE_ENV=development` 增加技术详情。测试诊断只控制展示，不改变公共请求、身份、原申请持久化、审批与取消权，也不跳过制品完整验证。普通界面仍保未知／失败／未确认清理、完整业务结果和用户明确的原内容检查；移植原 Ink 的纯 Header／Footer／面板不能恢复旧 provider 或执行 authority。负责实现归 [TUI](../../packages/ui/src/tui/README.md#原-ink-展示与明确测试诊断)与 [Desktop](../../apps/desktop/README.md#普通客户端与测试诊断)。

[Agent 权限模块](../../packages/agent/src/permissions/README.md)统一默认三策略、执行与 Workflow 共用的 builtin effect 分类、计划/Workflow/恢复审批约束、默认 Task 后续汇报许可，以及 Shell 命令分析、摘要和最终批准范围。Service 只装配可信事实与执行工厂、处理公开接口和身份；原 Loop/Execution 接口与审批生命周期保持。默认 after-turn 判定由 Agent 核原 role/source/root work、取消／删除和当前信任，Service 只提供可信读取；Planning 装配直接调用 Agent 工厂和原状态 reader，旧单次转发层退役。静态边界检查沿真实 export/barrel 拒绝权限模块反向依赖 Service，并拒绝 Service 自有解析依赖及原策略／范围／after-turn／Planning 工厂实现；Core／SQL 的激活、报告应用及最终 CAS 保独立 owner，正式制品仍须验证实际 Agent entry 与资产闭包。

Native 的明确普通输入在 Main 内按 Session 绑定的 Workspace 准备当前读取授权，不显示独立范围确认；准备使用原权限 observation、trust revision、目录身份和读取范围摘要 CAS，以及原权限 journal。未知或过期观察不继续输入，切换主体／Store／Session／项目不把旧申请改绑；打开历史和状态核实不自动授予范围，审批模式及工具硬上限独立。负责实现与回归归 [Desktop owner](../../apps/desktop/README.md#原会话输入区权限与停止)。

Native累计缓存用量沿已观察Message的原Model Execution只读取得：成功结果、准确原Session／Run／content、实际cached字段及token范围须核实；封存副本按原Store／Execution去重，不查询来源Run后来状态。恢复在当前Store的旧Store结果仅接纳终态出处，foreign active拒绝。有限IPC只收已观察Message ID与阅读scope，关闭／切会话只释放所属GET；用量不成为权限、执行状态或完整正文证明。组件继续复用原Composer，当前实现与证据归[Native owner](../../apps/desktop/README.md#原输入区累计缓存命中率)，Core／生成HTTP／持久格式保持。

必要业务义务通过[范围登记与最终 read-set 核对](../../packages/agent/src/storage/sqlite/requirements/README.md)实现。可信 initializer 在首个 Execution 前只创建当前 Run namespace 的不可变 executable 元数据；普通 Tool 追加义务，不得撤回已封存 refs。当前 boundary 和只读关联记录由 Core 提供，派发/完成事务核对准确原 Store、revision 和 related-record CAS，缺实现或未知判定值拒绝。普通 runless Tool/Job 从实际父封存 refs，准确重放和晚登记不改变旧快照；进程内评估与最终事务使用同一原引用，既有配置 lease 保持。嵌套 mutation 的最终检查沿原 Store/Session/root work 的真实父链核归属，不扩大外国或未知执行的资格。

原结果自动报告也保留这个边界：`applyJobReport` 在实际 source/carrier/afterTurn 应用事务中复制父 requirements 到新 report Run，不重新登记外国 Run refs。默认 Service 只通过实际原 report Command/receipt、source Execution、父 config、已知 result revision、root work 和主体关系读取原 Planning 批准；任意同 Session 新 Run 不获得例外。历史 receipt 的来源 digest 按原实际 Execution/批准 Run 重建，当前 inactive Run 的信息贡献保持 `approval:null`。各 owner 与真实资格见[Service](../../apps/service/README.md)和[Planning](../../packages/agent/src/business/planning/README.md)。

[自动 mutation 验证](../../packages/agent/src/business/planning/README.md)由可信装配明确选择真实版本及 effects，Core 只保留通用 mutation/completion governance 边界。派发前保存潜在验证事实，真实 Execution 结算与事实 revision 在同一短事务落定，文件路径/hash 列表分页读取，不转成每个文件一条不可撤回 RequirementRef。Model 完成候选通过同 Loop 的普通 `validation.auto_check` 与独立获准的真实 Files checker 验证；失败诊断作为低权限结果交给下一 Model 修复，未知或取消不自动继续。后序同 Store/Run、同路径的实际成功 mutation 可以将旧 hash 验证标为 superseded，仍保留旧事实，最后 mutation 必须实查；failed/unknown/cancelled 不因此解除义务。JSONC 不能授予这些 hooks 或隐式补选 checker。

Extension 的业务 Context 贡献只接收 scoped read projections，Core 检查 namespace 和有限格式，并强制以 user 数据呈现；来源没有累计数量额度。公开执行证明仅提供准确 identity、attempt、定义、参数摘要、结果 revision 和原来源 id/digest；信息 receipt 另行核实原 Interaction 的 accepted revision，不替代工具授权。配置文件、正文、展示卡和调用者自报证明不能生成这些权威事实。

文件变更阅读继续沿原 Message 的唯一 source Execution 和准确原 Run/Store/结果 revision，不以 tool call 名称或模型参数关联。普通 Files 可保存有版本的中立 `details.fileChange`，由实际已验证 preimage 与确认 postimage 生成；只限展示预算，不改完整文件或 Model 内容合同。Main 只给当前已读 scope 的成功 File receipt 建立有限观察，缺预览明确不可读；恢复检查点和当前磁盘不是历史 diff 的替代来源。编辑器跳转另核当前登记项目的物理根、目标普通文件和原 frame，不从历史来源继承另一 Workspace 的文件范围。当前实现与证据见 [Files owner](../../packages/agent/src/tools/files/README.md#逐操作文件变更预览)和 [Native owner](../../apps/desktop/README.md#原文件变更面板与编辑器)。Core、生成 HTTP schema 与私有 UI 数据格式均保持。

Native Files 恢复读取将当前 Store 准入与原 Run/Execution 出处分开：plain 原 Message 沿准确原 Run 核 Execution，sealed Fork 严格沿封存原 Session/Run/Store，不从当前 Run 补空来源。GET 原 Run 只核固定身份，不用其后来状态限制已有成功 Files；观察封存原定义、revision 和完整结果的固定摘要，detail/open 再核，同 revision 换绑也拒绝。普通 Markdown 只命名当前文件，有原 Run 时核出处，无 Run 的原用户消息仍沿当前准入的源 View 同项目和物理目标；不能据此取得文件贡献或执行权。完整原结果摘要不额外持久保存正文，实际恢复/冷读与安全范围归上述 Native owner。

Native 消息路径仍受当前已读 Message／viewSelection／history epoch 与登记 Workspace 约束，封闭应用枚举和项目内普通文件由 Main 复核；一般 Markdown 路径只命名当前文件，不生成 File receipt／贡献证明。真实 Files 的工具行路径另由原 Execution 定义与成功结果核实，旧完整历史不依赖有界 View 执行列表。原组件接入与配置默认摘要归 [Native owner](../../apps/desktop/README.md#原消息文件路径与常规摘要)，生成 API、Core 和私有存储格式保持。

Native 普通工具 metadata 由已读 Message 的唯一 source Execution 沿生成 Client GET 核原身份、tool kind、终态、outcome 与准确 content，不借 Message complete 或重复 callId 判成功。当前活动工具只取同 Store／会话／活动 Run 的已观察 Execution；停止申请与终态分开。请求目标仅作文本，不取得 Files receipt 或宿主动作；未知名称／版本不借旧 UI 分类解释。同一阅读身份的普通事件刷新沿 Main 已验证原视图保留 metadata／消息文件读取，明确选择、reset或Store变化仍撤销。所有所属读取沿当前 generation／viewSelection／history epoch 释放，限定产品行为与证据归 [Native owner](../../apps/desktop/README.md#原工具过程与结果阅读)。

Native 的原轮次 UI 消费准确公共 Run，不从 Message complete 推最终回复或终态。超出有界 View 的 Run metadata 只由当前已观察、未封存的 Message ID 分批32项经当前 Client GET，核原 Run／Session、Store 连接和阅读scope；已恢复在当前 Store 的 foreign terminal 保原出处仅供展示，foreign active 不取得活动或控制权。Fork／Include 的 `originMessage` 不查询来源 Run 后来的状态。默认 ask_user v1 回执须核原成功 Execution／准确结果，问题仅来自唯一原 Model call；信息取消独立于 Run。原 UI slots 只提供布局、聚合和阅读控制，完整回复复制只接受原 reader 当前已验证并显示的正文，不引入新 Core／HTTP／SQL／持久 UI 格式。实际范围归 [Native owner](../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。

Web 与 Native 共用 UI 纯回复资格投影，沿完整已读、同准确 Run／Session 的未封存助手消息核最终回复。Web 显式整轮正文范围按原 seq 合并普通正文，Native 显式最终段范围保桌面手册、排除同轮工具前说明；各自复制范围内非零 body-backed 段须由当前完整 reader 提供，不从预览、Tool 参数／结果或 child 补齐。Web 的有限 View 外 Run 仅经固定 Cookie GET `/browser/v1/sessions/:sessionId/runs/:runId` 和 `runs` capability 读取同 View 的安全 metadata，核 Session／Run／当前 Store，保合法恢复 origin；配置／token 不公开。关闭／隐藏／暂停／stale 撤销读取或复制资格，Fork／Include 不借来源 Run 后来的状态；没有新增 Core／SQL／执行权限或持久正文缓存。当前边界分别归 [Web owner](../../apps/web/README.md)与 [Native owner](../../apps/desktop/README.md#原轮次阅读聚合与问答回执)。

恢复后的普通 Fork Message 出处由 Core 的原 sealed SQL 与绑定 Command／Run 的固定 Store 证明，当前 Store 只承担准入。私有 `getMessageOrigin.originStoreId` 可缺省，明确绑定缺失拒绝；Service 不给无证明的普通预览补当前 Store。Native 原工具回执须有原 Execution Store、准确 Session／Run、终态及完整结果匹配；封存原请求还须同一原 Store，唯一已观察 Model call 才可提供问题。封存回执和 Model 用量不 GET 来源 Run 后来状态，原 UI 展示不提供回答或授权 authority。当前活动／控制入口仍独立核当前 Store 和实际 Run；公共 DTO、SQL／维护及私有 UI 格式保持。Core、投影与 installed 问答的准确范围归[Store owner](../../packages/agent/src/storage/README.md#原-message-的恢复出处)及上述 Native owner。

读取时机：修改新 Agent 的 Store/执行/模型接口、目标 HTTP schema、跨包依赖或过渡调用者时。

Native 原大Model正文将当前连接Store与封存出处分别核实。Service从真实sealed Message的私有output head保原Store；Main只接已观察Message的原Model／Session／Run／originStoreId，所属GET核准确Execution后再读Core完整snapshot，以当前Store验证原链、完整性与字节数。该资格不从renderer字段、来源Run后来状态或Store ID相等推导，不重绑origin、不补发旧工作。共享组件由具备原来源证明的Native和Web提供 `canReadRestoredOrigin`，缺省foreign限制保持。Web现有Cookie/Core reader在一致读事务核原Execution/Run/Command/rootWork/Model Message和private output head，Browser核当前准入及完整EOF/hash；页面仍核准确封存Session/Run/Execution/UTF-8长度与完整性，不从有限View猜来源或新增普通查询权限。Core／API schema／持久格式不变，准确范围归[Native owner](../../apps/desktop/README.md#恢复后封存-model-正文)及[Web owner](../../apps/web/README.md#原-model-输出全文)。

验证：`bun run test:unified-agent`、`bun run check:unified-agent-boundary`，实际运行范围见[实施证据](../plans/unified-agent-refactor-v1-progress.md)。

总体设计按[V1.3](../plans/unified-agent-refactor-v1.md)实施。当前根 formal/default/CI 调度已使用精确八个新 workspace；新链路不包装旧 Host/Kernel/State，不双写旧数据、不自动 fallback。旧源码与历史测试保留作参考，不进入正式产物或默认调度。各能力完整保真、平台与 §35 最终退役仍须实际证据，静态退出不代表总体完成。

单一 Loop 的完整 Model 工具批次沿现有资源并行调度，每项原输入、权限与决策来源独立核实。Run 结束与 lease release 等待全部已启动调用；后发持久化失败保原错误。显式接续复用非前缀的已结算结果，只有已声明的内部 continuation 可恢复监督，普通未知效果仍拒绝。当前实现与验证归[Agent owner](../../packages/agent/README.md#同一-step-的并行工具批次)。

[`ai`](../../packages/ai/README.md)拥有中立模型协议与独立 SDK 适配 leaf；[`agent`](../../packages/agent/README.md)拥有单一 Loop、具名 Store 操作、执行意图/派发/回执、精确取消与显式本地中断。普通扩展只得到受范围限制的调用身份、自有记录和有限 operations，不能写 SQL、owner 或 Runtime 完成事实。Store 是宿主边界，不能作为便利对象传入扩展。Action 不虚构模型 Run，Query 不触发模型、工具或恢复。

HTTP Change 的 `objectId` 读取契约与 Store 事件生产者一致：不透明通知标识上界385字符，覆盖128字符扩展 namespace、分隔符和256字符自有 key，包括点号、斜线和 Unicode。它不解释为路径或执行身份，普通 Store/Session/Command ID 约束不变。Service schema、生成 Client validator 与 OpenAPI 同源；[真实回归](../../apps/service/test/isolated/extension-changes.test.ts)核持久事件逐条抵达、ready 不 ACK、最终原水位 ACK、零 reset 与零额外执行。

SQLite Worker 持有唯一所属连接；业务事实和变化通知同事务。profile/Session 协调锁位于可替换 profile 外，取得 OS 锁后更新 owner generation，正常释放先复查并清空持久 owner。无损 64 位游标与消息顺序不使用 JS Number。未知外部效果不自动重放；失败取消请求不能停止未经授权的对象，真实存储故障只允许对本 owner 已核实句柄执行收缩性停止。

Run 仍活动且真实取消标记已保存时，公开 Run/view、Session 和后台目录由[Store 共用投影](../../packages/agent/src/storage/README.md#当前会话视图)一致返回 `cancelling`。Service 传递这一事实；取消受理与监督停止仍独立。正式 TUI 此时使用原 Run/selection 的公共 follow-up，后继启动继续由原事务与 Runtime 决定。

Store 在原条数与完整 frame 字节上限内投递，容量不足时调用方先等待，关键控制预留与 Worker 公平调度保持；等待后重核 owner/lease，不自动重投未知写入。关闭同步封门并排空此前调用。Operation 唤醒仍最多 64 个活动登记，容量等待使用原绝对期限、准确 abort 和关闭拒绝。具体容量与[验收](../../packages/agent/README.md#同一-step-的并行工具批次)归 Agent owner；生产者等待不代替整个 Runtime 的 RSS 或完整资源门禁。

正常空闲交接使用原 owner 的有限 dispatch 观察，核 Store、instance/generation、准确 Session 并与 acquire/release 共用组阻塞条件。旧空列表与释放之间新接受的本 Session 工作，没有未结算执行时沿同一 generation 继续；已取消工作有限释放后退出，其他 Session 保持原调度。真实 unknown/cold active 不借 accepted 新命令解除，观察不取得 owner 或恢复权。[Store owner](../../packages/agent/src/storage/README.md)与[确定性交接测试](../../packages/agent/test/isolated/execution/owner-handoff.test.ts)负责准确范围。

根与 child 使用同一个 Loop 与执行器，根执行组拥有一个 OS owner/generation；child 配置只能选择固定宿主绑定及父允许的工具。每 Run 的定义与来源封存，后台 operation 保留该绑定 lease 直到真实监督终止。Skills/MCP 内容不授予权限；默认 MCP 连接须在普通持久派发之后，不能在配置解析时提前启动。

可信 runless Action/Tool 的 child 仍核宿主精确角色、模型与实际父工具上限。MCP 空目录只有在真实无 Run 祖先、原 Command/准备摘要和 child carrier/manifest 闭合时，才保存 `parentRunId:null` 血缘供后代验证；它不生成 source read-set、连接或凭据许可。省略真实父 Run 不能制造这种血缘，非空来源与篡改证明继续拒绝。装配与准确拒绝证据归[Service owner](../../apps/service/README.md)。

长期执行不设主 Run 总期限、累计用量、来源数量、隐式 Shell 总超时或暂时性模型失败的次数额度。子 Run 仍在实际激活后 30 分钟取消；普通 Task 的并发位满只排队，期限不在排队时开始。公共重试上界以 `maxAttempts:null` 表达，Client schema 与 TUI 保实际 attempt 和原失败前驱。完整纯文本的 Provider 长度分段继续同一 Run，截断工具批次不派发，截断摘要不发布。默认 Service 在原 Loop 安全边界进行可重复自动压缩，已知失败不永久关闭后续压缩；存储／来源／取消／unknown 不由重试机制放宽。

原 Run 的冷恢复将持久意图、可替换 Model 尝试、已确认结果与进程监督分开。纯 Model 无派生效果时可关闭旧 running/failed 尝试并重试；压缩 pending 重建摘要、已发布点保持。所选父子树在同一 root lease 下准备全部绑定并原子交接，只有提前封存的可信 Tool continuation 可接回原操作；普通外部未知效果仍需核实。原 ID、结果、审批、子期限和五次失败 streak 保持。正常 Store 事务以闭合增量迁移维护恢复证明，首次冷读只核前沿/增量和必要来源；旧库一次升级及失效协议完整审计回退。全部迁移资产进入包内构建和 Service 文件保护，公开 HTTP 与 format major 1 保持；协议、真实强杀与成本边界归[恢复 owner](../../packages/agent/src/storage/sqlite/run-resume.README.md)。

唯一新增主动停止条件是模型顺序中同工具、相同 JSON 参数连续五次失败：Run-local 计数跨完成检查保存，显式安全接续沿原 Model/Tool ledger 重建，最终经准确 `run.cancel` 域停止当前 Run 和 attached 工作。Core 确认未派发且因上下文／能力刷新退回的调用只等待重新决策，既不增加也不清空失败序列；扩展自报的详情不能取得此豁免。热执行的内部结果与恢复历史／最后 checkpoint 均携准确 Core dispatch 事实并共用分类，未知派发事实保守计数；公开 ToolResult、HTTP 和持久格式不变。并行批次必须先结算所有已开始调用；物理完成顺序、压缩和新执行 owner 均不能重置计数或重放原工具。完整实现与定向证据归 [Agent owner](../../packages/agent/README.md)和[持续执行决定](../../.agents/notes/implemented/architecture/2026-10-15-long-running-agent-continuation.md)，不把本机定向结果推广为持续数周或完整平台资格。

单次 Skill 选择属于原 `run.start/input.follow_up` Command，不属于 daemon 启动状态。HTTP/Client 只传递有限数组并核 `run_skill_selection`；该能力来自 Runtime 的显式 resolver 支持声明。Core 保持请求摘要与幂等，只由 Service 解析当前可信目录。子配置继承真实父 Run 封存的准确配置 ID，名称不重新匹配，缺失父 marker 或目录项拒绝；Runtime 沿同原 Store/Session/rootWork 的有限实际执行链提供最近父 Run，不猜当前活动 Run。Skill 选择不增加工具、可信 root 或权限，冷历史与原回执只读不重新装配。 无祖先 Run 的 Action 在原派发 scope 捕获实际静态宿主绑定；后代仍按这个集合和原权限限制，不能回退到后来每 Run 配置中的更大工具目录。

可信 child fresh resolver 使用 Store 中的实际 Workspace 与父 Step 范围；父子权限为准确调用的交集，Ask 与 Review 同时适用时必须保留两份实际 proof。child 在 actual activation 持久固定 30 分钟期限，Root 无总期限；timer 与 SQL 最后派发核同一依据。attached 取消、已激活独立 child 与 detached Job 的域分别核实，迟到事实不授权新工作。原 operation key 的历史查回不重新装配或恢复执行。

[Task](../../packages/agent/src/extensions/task/README.md) 的目录按真实 carrier/Operation Command 查询有界摘要，固定 Decimal64 上界与每页最多 200 项，不拉取正文、不重新 ensure。精确 interrupt 在最终事务核原 Store、主体、直接 child、carrier 和当前 targetRunId，不能因旧 Run 结束就转向后来新 Run。wait-any 使用持久变化唤醒与真实目标事实，已存在审批或准确 child ancestry 下的卡片也可早醒；普通 operation wait 继续等待终态。

首次激活前已取消的稳定 child 只有在 Store 证明原 carrier 从未派发、原 `child.start` 已准确拒绝且 Session 没有真实前驱 Run 时，才由显式 `follow_up_agent` 创建新 carrier 和真实首次 `child.start`。私有证明随新命令封存，activation、邮件采用、冷恢复及跨层读取共用核验；原取消、Session 创建血缘与普通 Run 后继合同不改写。同工作原委派只作已取消背景，新指令优先；换工作不继承旧指令或邮件，旧 queued 引导不恢复。已派发、unknown、缺失或不符的来源不获新资格，不以空 Run 绑定绕过恢复门禁。准确机制与验证入口归 [Store owner](../../packages/agent/src/storage/README.md#子-agent-的首次激活复用)与 [Task owner](../../packages/agent/src/extensions/task/README.md#稳定身份准确命令和观察)。

QueueOnly 邮件以原 `agent.message` Command 和 sender Execution scope 的完整私有 Artifact 保存，sender 的实际成功结算与接收资格同事务提交；失败、取消、未知或未确认不形成成功邮件。idle send 零 Run/Model，普通后来人类工作不自动采用。显式 child follow-up 的原 ensure 事务封存邮件 seq 与成功 sender completed cursor 双上界，原 key 重试不能扩大集合；每页 50 封的实际接收最终核目标 Run/selection、carrier、主体、原 Store 和 stop/delete。邮件原未绑定 intent 不改写为新 targetRunId，保存准确 receivedRunId/selection；下一 Model 只按真实 receivedMessage/source proof 完整展开。Rewind 资格属于准确目标 Session selection，根选择变化不伪称 child 选择也改变。普通 child completion 将有限订阅与 idle 自动授权分开保存；同一父会话 active 接纳沿原活动 Run 权限，idle 续轮另核可信当前 afterTurn policy。nested 与 follow-up 保原 child deadline，report 不递归授权；冷缺绑定 needs_review/零 Provider。报告按准确结果键在同一事务选最终 Run、创建独立 Source、consume receipt 和 ack，多个完成可进入同一 R，不要求每个 report 都是 R.origin。提交后返回丢失只查回原 Run/Source。原 after_turn 旧历史与明确内部调用仍核其实际封存授权。

普通输入直接由原公共 Command 进入当前主 Agent；不生成独立 raw/归属决定/处理轮，也不按正文自动暂停、继续或改选工作。steer 在准确活动 Run 的安全边界应用，队列等准确前驱结束，新轮次使用当前显式模型配置。旧记录与明确控制只保兼容，旧 processing 恢复在 scope/恢复校验后且加载配置前拒绝。准确取消、停止、root stop、Rewind、unknown 和 fence 仍有效，具体归[输入 owner](../../packages/agent/src/storage/sqlite/inputs/README.md)。

用户输入与 Agent 通信由 Runtime 同一串行接收入口汇合，仍分别保留用户引导与低信任 inbox 的失效语义。新 `agent_completion` 将原唯一结果 Command 封存为 typed 邮箱项，经现有邮箱查询／接收／水位去重；原 Source、准入回执和父续 Run origin 保持，不另建影子队列或复制正文。活动轮接纳与 idle 续跑共用该收件入口，续跑仍核原配置、当前授权与用户队列优先；未标记旧报告和非 Agent Job 保留准确旧协议。具体事务与兼容边界归 [Store owner](../../packages/agent/src/storage/README.md#统一消息接收)。

普通收件的公开 `Message.agentMessage` 由 Runtime 核原邮箱回执、发送 Tool／主体／父子关系、接收 Message／Run／selection 和原 Artifact 后只读投影；system 展示携真实发送者及完整正文，未核实来源或正文明确不可读。Service／Client 同源 schema 只交付这些展示事实，Native 复用原过程和 MessageItem，保原 Run 分组，不创建额外输入、Source、轮次或授权。物理内部占位和模型上下文的低信任装配保持独立，邮件内容不能取得用户或工具执行身份。

首输入的本地标题兜底独立于业务准入。可信宿主在 public/raw 耐久保存后、解释修订捕获前，通过受限 metadata 接点复用标题模块的 rename CAS；它不成为新的业务生命周期、事件总线或执行许可，解释轮仍零业务 Action。原输入、初始控制、空历史、保留的注册锚点和手动改名均须可核。后续标题 AI 只沿准确 public/raw/decision/business 链，在实际业务正常完成前执行；元数据失败不改变原输入的业务结果。当前负责入口归[Agent](../../packages/agent/README.md)与[Service](../../apps/service/README.md)。

所属根当前 applied 权限模式通过持久 `permission.mode` revision 交给子孙策略、待审批/审核与资源等待、最终 SQL 派发；收紧和放宽均在原准确动作上重新判断，不共享兄弟/新轮批准，不因 Full 解除可信只读与工具硬上限。旧卡片追加失效事实而停用，原请求/答案保留；on* 通知不是可靠唤醒依据。当前权限读取失败阻挡新效果。协议与实际强杀/模式竞争证据归[授权契约](authorization.md#当前-v13-正式授权)及[权限 owner](../../packages/agent/src/permissions/README.md)。

可信 `readStepCapabilities` 在安全 Step 只选择缓存定义，Model 的实际工具版本与非秘密目录事实独立保存。旧未派发调用在目录变化后失效，下一模型请求同时更新 schema；已派发任务保留原 scope 和 lease。新版本 Tool 的自有 namespace 从准确成功 Model 的实际请求/绑定与原工作身份核实，不能靠调用者声明或替换旧 Run manifest 获得；真正执行仍走独立权限和最终派发事务。

MCP 的 resources/prompts、live-only `mcp.catalogue.refresh` 均是普通 Tool/Action，绑定准确原 connection Job/key/configDigest/generation，read/get 再核成功目录 Execution 与 descriptor digest。刷新不冷连接、不变更原 connection 记录；新 schema 在下一安全 Step 生效。runless 调用从真实 Session/Workspace 核当前 selected-server 后才委托外部权限，宽权限不能跳过来源范围。独立 `builtin.mcp.management` 的 `mcp.servers` Query 与 `mcp.server.select` Action 只管理 trusted programmatic registry 的选择；真实六字段 read-set/Workspace identity 与 HostMutation 保原未知回执。默认原始来源、项目批准与认证绑定按[来源提案](../../.agents/notes/proposed/architecture/2026-10-03-scoped-default-mcp-sources.md)继续实施，OAuth原认证合同归[认证边界](mcp-authentication.md)，Native完整设置由[Desktop owner](../../apps/desktop/README.md#native-mcp-完整设置)维护；完整浏览器/vault和平台资格仍按实际验收核对。

公开 HTTP DTO 的来源为[Service schema](../../apps/service/src/http/schema/index.ts)，生成到 Client 目录与 OpenAPI；领域/SQL记录通过明确投影连接，不能直接成为 renderer 契约。正式客户端切换完成前，HTTP/Client 的交付只覆盖证据记录的切片。新的连接必须核对启动前选择的目标与必需接口，Store 写身份仍在各自事务内核对。

完整后台目录沿公开 `BackgroundExecutionPage` 投影原主体根会话树与准确来源 Command；当前 Store 用于准入与快照，Execution／Command／Run 保持原 origin。旧来源只在原 root creator 已证明恢复的根内接纳，真实 source／root-work 与不可变 child-start／carrier／Workspace 血缘在分页前核实；多次恢复保期间各原 Store。私有 input/result/configuration 不进入 DTO。固定 Execution 分配上界与同一 Store change cursor，跨页变化整份重读，有限 `getView` 不承担完整目录。原父 Run 从实际执行父链定位，准确 child Run 从原 child-start Command 定位，不能改投当前 active Run。

Native 全局总览的[后台 Main](../../apps/desktop/electron/background.ts)登记完整公开观察，独立于选中会话；有限 IPC 只指定已观察原执行。停止前 fresh 核同原身份／代次／状态，内部 [caller prepare](../../apps/desktop/electron/caller-journal.ts)只为准确 `execution.cancel` 保存实际后代 Session、根、原主体和 Workspace，普通选中根门禁及冷 GET-only 合同保持。完整原输出复用固定 H，子日志核原载体和固定消息上界／完整 ModelOutput。close/reset只释放 GET，原 Task/Run/Job 的业务状态由 Service/Core 决定；当前源 Store与恢复为新Store的兼容范围分别按[owner](../../apps/desktop/README.md#native-跨会话后台总览)和[实施进度](../plans/unified-agent-refactor-v1-progress.md)核验。

TUI 当前 Session 的[后台 reader](../../packages/ui/src/tui/executions.ts)分别封存当前准入 Store 与快照中原 Job 的 origin/definition/version；恢复历史可读但停止资格仍要求当前出处。完整 child 正文沿实际 carrier/父链及原 Message/Model Execution/Run 证明出处，公共 snapshot 表示当前 Store，封存阅读不借来源 Run 后来的状态改写结果。发布前复核原身份、Model revision 与 child selection；关闭或切选择只释放所属 GET。正式 CLI host 接真实 getRun，公共 API/SQL/Artifact 合同未改变；当前消费者范围及实际恢复证据归[TUI owner](../../packages/ui/src/tui/README.md)和[进度](../plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-tui-后台任务完整读取)，不代替完整平台/维护或阶段退出。

Native Skills 目录只经 [Main 的有限 reader](../../apps/desktop/electron/skill-catalogue-reads.ts)和公开 `SkillCataloguePage`。Main 从实际选中 Session 固定 Workspace/Store 与视图代次，open 核原选择/观察代次后立即登记所属取消域，不排在另一个刷新之后；原 read ID 的 close/next 不能重绑或关闭后复活读取。Main 保留原 revision/cursor，每页 128KiB，renderer 复用公共闭合 verifier 并在穷尽全部页后发布，没有累计条目截断。有限 source 仅为配置位置分类，禁用项不因此读取文件，不传路径、正文或授权；目录和页面关闭不创建 Run、改变 SSE 水位或提交业务取消。实际交付与平台证据归 [Desktop owner](../../apps/desktop/README.md#native-skills-目录迁移)。

[本实例生命周期](../../packages/agent/src/lifecycle.README.md)以同步真实 busy 检查与封门实现 if_idle；status 采样不授权稍后的关闭。已受理准备、owner 接管、后台 operation 和未完成 cleanup 参与同一边界，重复关闭共用完成 Promise。只收束本实例真实拥有的工作，不因保存 command ID 就取消另一 Service 已接管的命令。普通 GET 不算执行 busy，但最终 Store 关闭等待原读取资源排空；Service 的窄 beforeResourceClose 回调先封最后业务资源入口再排空。未确认停止或清理失败保留原资源、profile 锁及诊断 HTTP，状态为 drain_failed，不伪造 completed。

长期运行与改动规范：累计已完成的会话、执行、消息和已关闭资源不能成为正常 Loop 的准入配额；同时活跃资源、单页、单批和实际未知结果可以有明确界限。正常竞争通过可取消的背压、分页或流式读取恢复进展，不能把部分扫描当全集，不能盲目重放已提交或未知效果。新功能、重构与升级必须核获取→等待→释放顺序，不新增全局锁来掩盖拥塞；短SQL事务和内部互斥不得跨 await 等待模型、用户或子资源，不持父许可等待获取子许可，清理不能互相等待。Session/Profile的OS所有权和执行permit按原实际寿命持有，不能以避免等待为由提前归还；确需同步时用运行证据核顺序、取消、关闭、异常释放和无循环等待。确认结束的热对象、许可和原生句柄及时回收，未知仍保准确 owner/generation 和证明。验收覆盖累计千次 child/reviewer、超过连接旧配额的完整关闭/重连、产物饱和恢复、精确取消、崩溃恢复和任务完成后的零新派发；加速回归不能代数天数周 soak。当前负责实现与证据归[Agent](../../packages/agent/README.md)、[Store](../../packages/agent/src/storage/README.md)、[MCP](../../packages/agent/src/mcp/README.md)和[Artifact](../../packages/agent/src/artifacts/README.md)。

独立 Native `/v1/lifecycle` 与 `/v1/lifecycle/shutdown` 用 lifecycleVersion 和原 profile/instance 核对目标，业务 API 不兼容或 Store 不可用不阻断有限诊断。无 Origin 的 bearer 请求才可进入，Browser gateway 不暴露；202 仅为受理，成功资源关闭及所属进程退出另行确认。公共 Lifecycle Client 丢回复后只查询原实例，不自动重发或改绑。成功 HTTP 关闭明确结束 runner 自己的父管道读取；普通网络退出仍不等于父死亡。理由见[原子关闭决定](../../.agents/notes/implemented/architecture/2026-10-02-atomic-service-shutdown.md)；正式 daemon 目标发现与 CLI 切换尚未由此完成。

耗时的纯校验不能占住Service事件循环：[MCP](../../packages/agent/src/mcp/README.md)按原scope／catalogue拥有完整schema编译和参数／结果校验Worker，[Workflow](../../packages/agent/src/business/skill-workflow/README.md)由显式Run binding拥有编译session，来源与能力事实仍每次完整重读。固定built Worker、校验和及原观察资产进入普通／外部Files与恢复保护，缺失或摘要不符拒绝，不回退TS源码或由配置替换。取消、目录失效与关闭须等原Worker实际退出，未知保原资源；计算缓存不缓存授权，不授效果重放。Files只读与Artifact全文校验按预算让出真实事件循环，原文件／目录句柄和活动票据持有到EOF或实际关闭；Runtime的二次正文摘要同样完整分片。短事务、原size/hash/scope与发布CAS保持，单次系统调用、连续分配和JSON展开不因此取得实时延迟保证。

[`client`](../../packages/client/README.md)只依赖生成 schema 和网络能力；[`ui`](../../packages/ui/README.md)消费公开投影、React 与便携展示控件，不知道参考扩展业务。SSE 的 ready/heartbeat 不推进 cursor；变化应用成功后确认，过滤范围的 checkpoint 只来自一致页。快照页不代表全局事件应用成功，切换 scope 需要相应水位。reset 后先冻结原 Store 的全局集合基线，再完整重读所需事实；SDK `startAfter` 仅设置重开 scan 起点，保留原 ACK，不将单对象 snapshotCursor 冒充全局应用。validated `onReady` 可确认流准入并等待应用准备，仍不 ACK；正常 EOF 且 ACK 尚未到达重读基线时沿原起点重开。原 Store 改变、读取失败或未完成时不解除对应写门禁，也不重发业务意图。

Native 会话浏览器属于用户操作的独立窗口能力，不经 Agent／Service 执行。Main 的封闭浏览器 IPC 只接受当前主窗口准确 mainFrame／renderer URL，地址和有限几何校验后创建最多8个隔离 WebContentsView。网页使用独立内存 session、无应用 preload、无 Node／webview／权限申请，不继承应用 Cookie、业务 IPC 或文件打开资格；顶层导航只支持 HTTP／HTTPS，仅资源类型为 WebSocket 的无凭据 ws／wss 请求可作为网页子资源通过；下载及外部协议导航仍拒绝。标签关闭、会话变化、root 导航／崩溃和窗口退出释放旧 view，显示 metadata 不构成 authority。当前实现、测试及平台限制见 [Desktop owner](../../apps/desktop/README.md#会话标签页与内置浏览器)，原 Files reader 继续核独立 scope。

正式 Native 已复用 [UI 的原桌面展示层](../../packages/ui/README.md#原桌面展示层)，SessionPage、侧栏、消息区、输入框、右侧栏与样式由纯展示 owner 维护；[Desktop adapter](../../apps/desktop/src/native-presentation.ts)只映射实际公共事实。有限宿主 slot 接原完整正文与写入回调，打开右侧工具不卸载消息区。旧 Host/Runtime/私有存储没有迁入此层。声明的 CSS export 必须解析到实际仓库资产，缺失、越界与旧目标仍拒绝；CSS 不作为 TypeScript 执行模块，实际编译资产闭包另由候选 manifest 和窗口验收证明。显式 UI 构建脚本属于 I/O 宿主，UI source 经 export/import 到达该脚本时仍按便携依赖检查；不存在整个 UI workspace 的 I/O 豁免。

原 PC 环境信息卡与只读 child 详情复用已有后台 reader／durable caller。全局总览与当前根环境各持独立 Main 观察；环境范围来自实际 controller snapshot，renderer 的有限 surface 不提供根／Session／路径。选中根变化释放环境 GET 和旧停止资格，全局观察保持；目录刷新不扩大已固定 child 日志读取范围。最近一份完整同根观察仅定位准确 child 的只读接纳候选，覆盖目录替换在途及 Main 发布／正常关闭后 Renderer 尚未提交的交接窗口；仍须两次重新核实际后端血缘。停止和输出仅用当前观察；失败、未完成取消、reset、scope 变化或超过上一代则撤销旧候选。展示缓存不持 observation 或原提交意图，子详情不改变 Main 阅读根、不恢复写权，准确 stop 与完整正文核验仍沿[Native owner](../../apps/desktop/README.md#native-当前会话环境信息与子详情)。observer reset 取消旧全局目录 GET 时，所有共同等待者得到明确观察失效，页面等待新状态；真实 GET 失败不被吞掉。

活动 Native child 阅读复用全局 change 失效信号，不建立第二条执行流。有限私有游标只描述同 context selection 中已验证的完整消息前缀；Main 重核当前父范围和子绑定，变化时全量回退，每次尾部仍有固定上界和完整 EOF／hash 核验。重进与显式刷新完整校准，缓存不能替代当前父目录对子成员的确认。主子切换只取消所属 GET／IPC lease并拒迟到发布，暂停隐藏父阅读，不提交取消任务；有界缓存只持展示数据、有限的已停用 DOM 和计入预算的已核验图片，不保留活跃订阅或操作资格；Native 的 [KeepAlive owner](../../apps/desktop/README.md)在重新准入前只读显示原树，公共 reader 由 Native adapter 显式控制当前读取与正文通知，不依赖独立 UI bundle 共享私有 Context。公开 Service／Core API 与持久格式保持。

多个根并发时，全局SSE和ACK保持完整，当前根失效路由与全局目录修订分开。Main已验证目录的后代Session索引仅选择需要重读的事实，不授读取或停止权；新Session创建保守重核当前环境，换根／reset清除。Controller替换选择时取消旧GET链，Renderer state仅有一个在途和一个最新后继，共享目录的child等待可独立取消。同选择metadata刷新不撤销既有只读范围，原metadata／EOF写门禁仍独立；完整后台目录持续变更最多3次扫描后明确失败，不无限保留读取。

Native在已验证Model正文发布前，可由静态Worker运行UI公开固定Markdown纯计算；不读取业务数据或获得网络、文件、执行权限。准确原文／任务身份、有限队列及当前display owner隔离计算，HTTP／IPC EOF资源在计算前释放；新formatted批完成前保留旧已验证正文。主线程继续原HTML／图片／链接安全处理，prepared树不能授正文读取或写入资格。超全局语法缓存预算的树只归活动展示批，inactive snapshot缓存不成为其长期owner；参数及实际窗口资格归[Native owner](../../apps/desktop/README.md#native-当前会话环境信息与子详情)。

正文取消信号从Runtime的中立Artifact端口传递到原reader/publisher，排队取消不查询Store；它不成为业务取消。Artifact保留8个活动操作并限制读取占用，正式票据数和已知排队载荷预算保持有界；额外调用等待共享容量，字节便利发布按原调用时语义私有封存，不持writer/目录句柄等待。close拒绝未入正式队列者并等待临时snapshot清理，排空此前已接纳工作；正常拥塞不取得Model或发布重放权。未知原生关闭保Profile authority并明确失败。引用授权、EOF／hash／size和不可变文件核实保持，参数、惰性source计量限制与真实压力证据分别归[Artifact](../../packages/agent/src/artifacts/README.md)及[Service](../../apps/service/README.md#多主子会话流与读取压力)。

Task carrier成功继续要求原child的attached效果域结算，child Model／Run已结束不代表排队或运行中的Shell已结束。Runtime在该边界用可信Store的准确owner／carrier快照与同事务cursor等待原变更，detached保持独立，最终成功／unknown仍由原SQLite事务复核。准确持久取消与本地读取／计算中断分别处理，不以信号本身伪造已停止，不重新执行Model或Shell；负责合同及修复验证归[Task](../../packages/agent/src/extensions/task/README.md)与[child Store](../../packages/agent/src/storage/sqlite/child/README.md)。

全局 PC 目录复用原 Sidebar 展示，公共 `session_directory_activity` 从同 Store／主体的只读事务提供准确 Run／pending 和最后已保存对话消息的更新时间。SDK 只有穷尽同 upper／snapshotCursor 后才发布，变化丢弃前缀、持续变化明确失败；没有新增 Store schema 或第二个运行索引。Native 全局读取与选中会话正文／草稿分别管理，SSE 只触发 GET，迟到读取按原 attach／Store／epoch 拒绝，失败保上次目录并标明。没有目录事实时不从当前选择推造其他会话状态，目录成功不 ACK 或授予执行／审批权；owner 见[Store](../../packages/agent/src/storage/README.md#目录分页)、[Client](../../packages/client/README.md#完整目录读取)与[Native](../../apps/desktop/README.md#native-项目会话目录)。

正式[Web目录](../../apps/web/README.md)也消费同一完整Browser摘要，按最后对话消息更新时间排序与分批展示，原Tooltip仅承载详情。未读数量／未知时间不补造，读取失败明确保上次事实；Refresh与可见性／已核bfcache恢复只触发GET。页面同步暂停标志、原signal和实际document可见性共同约束数据／错误发布，迟到读取不得更新暂停页；目录成功与所选会话Run执行继续分离。原身份便利reader的兼容用途保持，公共Core／生成API／Store格式没有变化。

Web 后台目录复用现有 `BackgroundExecutionQuery/Page`，仅增加 Cookie Gateway 的具名 GET `/browser/v1/background-executions`；Store 由已准入 Gateway 注入，浏览器不能提交 Store 或主体 authority。Browser 固定网络代次与完整目录水位，核执行、所属 Session／root／Workspace、原 Run 和实际 child 关系后发布；准确子会话链接只切换阅读。完整输出沿已有 Job reader 和固定上界覆盖校验，隐藏、暂停、关闭及切会话只释放所属读取。目录序号不冒充输出水位，成功终态不冒充清理确认，缺少公开事实时明确不可用；没有新增 Core schema、监督模型或执行操作。负责实现与验证归 [Web](../../apps/web/README.md)、[Client](../../packages/client/README.md)及 [Gateway](../../apps/service/README.md)。

原模型浮层接受宿主提供的准确 ID、名称与合法请求档位，再回调原选择；不根据 Provider 或模型能力标记隐藏思考调节。当前 Service 对所有配置可用模型提供 low/medium/high/xhigh/max/ultar 六档并透传，宿主稀疏列表只表示可编码的选择，远端效果由模型服务决定。Native catalogue、原作用域、Session route、临时 effort 与就绪判定仍归 Desktop，详见 [UI owner](../../packages/ui/README.md#原桌面展示层)及 [Native owner](../../apps/desktop/README.md#native-provider-与下一次模型选择)。展示重用不扩大公共管理或运行权限。

原安排任务页只有现行手册定义的字段草稿，Native 不提供不存在的保存、调度或通知回调。页面导航与原 Session 的读取/写入意图分别管理，晚创建回执不能抢占后来页面；返回原会话不以持久草稿覆盖未保存原文。负责实现与当前验收归 [Native owner](../../apps/desktop/README.md#native-安排任务草稿)，不增加 Service 能力或执行权限。

Native [新对话 Main](../../apps/desktop/electron/conversation.ts)只编排现有创建、私有草稿、permission controller、caller journal 与 input caller。全局准备模型只读观察独立于选中 Session，不授予 Settings 写权限；准备页选择 Workspace 只查询同代次／Store 已观察规范目录的 Git，有限结果不含路径或控制句柄。显式首次分支切换核实际根／HEAD／脏文件、全部活动工作和 trusted Main 的 Profile／制品保护根，不重启 Service。热首次链的原创建身份与新输入 Command 分别固定，权限 controller 不接管阅读选择；额外宿主 read scopes 仍需明确确认。私有原草稿在创建 POST 前保存，输入 journal 在输入 POST 前保存；未知创建／权限／输入仅原 GET，冷行不授予续写资格。UI 的等待消息按实际原 Command，或 sourceIds 加准确原 Run 证明接管，不从文本推导来源。公开 API、私有 SQLite 格式与运行授权保持。已保存草稿的消费与原回执同事务提交；选中草稿读取可带本进程有界、非持久的准确消费凭据，仅用于诊断保存的修订核对，不把其他写入者的空正文视作本次消费，也不授予命令执行权。负责行为和限定验证见 [Native owner](../../apps/desktop/README.md#native-新对话准备与首次发送)。

只读浏览器通过 [Service gateway](../../apps/service/src/development-web.ts)、独立 Cookie [BrowserClient](../../packages/client/src/browser.ts)与[Web](../../apps/web/README.md)连接。Native token、配置和文件路径停留在可信宿主；browser finite GET 不获得执行权限。page 还封存有限资产的完整 hash；page/instance/build/Store 变化拒绝原读取，Cookie 续期/关闭不改变 Runtime 生命周期。逐请求 `verifyConnection` 只核实原身份，不重置共享 Native 读取或 SSE。校验函数从唯一 HTTP schema 在构建时生成，浏览器保留禁止动态代码生成的 CSP。Web 当前按固定上界穷尽历史后核对一致 view，仅可见且实际 isActive 的选择会话轮询；最后快照与错误/过期状态分开，跨选择迟到响应不发布。按需 Context/output 使用原 selection 或准确 Session/Job 范围，不等于实际 Model 请求和完整 Runtime events。根开发 `web:dev` 已使用独立新 profile 与配对子进程；正式入口和完整 Web 页面资格仍按进度记录。

Native 的已保存 Job 读取只从当前实际 kind=job 详情进入；Main 在 GET 前核原观察并同步登记 read ID，fresh Execution 与每页前后 Service 身份分别复核。只读 lease 绑定原 Store/Session/Workspace/Execution、attach/viewSelection/historyEpoch，有限 IPC 页与自适应缩页仍保首次 H；公共 Client 纯覆盖规则由 Native/Web 共用，保持跨 stream gap 与普通内容全部可见，只有覆盖 H 才发布完整保存事实。关闭、折叠、切换、reset 和冷读不取得取消、恢复或重执行 authority。默认 macOS producer 已核真实普通 Job/全树停止及 cold 原输出零重放；这些消费者资格不外推其他平台或全局发布，实际负责与验证归 [Native owner](../../apps/desktop/README.md#native-job-完整已保存输出)。

[Model 输入检查器](../../packages/agent/src/model-body/README.md)按准确 Session/Execution 读取持久请求，目录为固定上界的 Decimal64 keyset，每页最多 200 项。Core 在一致读快照核对原 Store、Command/subject、Run、rootWork 与 child carrier；全文只从原 sealed input 或原 scope Artifact 展开，不取当前 Context、Tool catalogue 或 Provider 配置。每个新请求还封存 actual adapter/provider family、支持的 settings、实际 capability/version/digest 和来源顺序；最后派发的 authorization/controlReads 独立持久保存。兼容适配器的有限 reasoningEffort 传入实际 SDK Provider options，并以相同冻结值记录原 settings；未知值或不透明绑定在 I/O 前拒绝，远端支持资格仍独立验证。opaque、未记录或未来 metadata 明确 unavailable，不用现在配置补齐。Service/Browser 通过完整流传输，Client 核实 EOF、wire size/hash、原请求 canonical size/hash 和准确目标后才发布；大正文不受普通 JSON 便利预算裁剪。共享 UI ModelInputs 经公共 port 供 Web/Native 使用，用户确认后才读正文；日志导航只打开原 Execution 的确认，不隐式 GET。隐藏、关闭、未卸载的 Store/Session 选择变化均取消所属读取并清除正文。只有成功终态标记成功确认，其余持久请求不冒充 Provider 已接收。

[完整 Model 输出](../../packages/agent/src/model-output/README.md)以原 Execution scope 的不可变 linked segments 保存，单段有限且不反复写全部 growing prefix。成功提升原 partial Message 为完整消息；失败/取消保留不完整前缀，截断 Tool arguments 不成为实际调用。下一 Model 核原成功 Execution/Message 和完整链后取得全文；child 大结果由原父 carrier scope 的完整 Artifact 与原 source ID 返回，父不导入 child 历史。公开 `outputBody` 仅为有限摘要；Native/Browser 具名 readonly GET 提供原 snapshot，Client 完整核 EOF、wire/body hash、字节量、状态和身份。UI/Web 显式全文读取只在当前视图保留，关闭/隐藏/切换取消所属 GET。正式 TUI 的主会话/Fork 同样区分当前读取 Store 和原 Model 出处，沿公共 Core 来源证明核原 Session/Run/Execution 与 Message 输出摘要；Ctrl+O 完整读取同时保存正文和 reasoning，完成后的思考保持收起，已加载导出仍包含原文；切 Session/dispose 取消所属读取。普通 Web 对话按手册不展示 raw reasoning。

公共 `getView` 的 Run/Execution 显示投影使用同 Session 最近200个身份与全部未结束／原unknown身份的并集，去重并保原顺序；不以 lifetime前200项隐藏当前工作。它仍是有限历史与当前事实的投影，不充当完整历史目录，读取不会推进业务或恢复authority。完整Message与输出继续分别分页，当前类型和执行权没有新owner。负责合同与实际长会话证据见[Store owner](../../packages/agent/src/storage/README.md#当前会话视图)。

[Native Desktop](../../apps/desktop/README.md)的 Node main 持有预选 profile、配套 Service、公共 Native Client 与原意图，renderer 只有封闭有限 IPC。原 window/webContents/mainFrame/actual document、generation、CSP/sandbox 与请求预算本地核实。Main 只向同一个已完成真实准入的 paired Client 交接一次初次许可；消费、detach、网络释放或关闭撤销该许可，缓存 serverInfo 不替代后续身份核验。main 的 Model input/output GET 共用最多一个当前 body lease，通过不超过 64KiB IPC chunks 传同一公共 snapshot；renderer 使用公共 Client verifier 核完整结果。视图 detach、refresh 或读取取消不提交业务 cancel，不关闭所属 Service。私有草稿与未知创建 intent 在明确选定的 profile 下保存，发布前核原 Store/CAS/路径，冷重开只查询原创建回执，不第二 POST；损坏和硬链接保留原字节并拒绝。完整目录穷尽固定 upper，超过 200 项仍核每页身份。完整历史同样固定原 Store/Session/selection 与顺序上界，累计数量和字节不构成截断门槛；单 IPC 预算不足时缩小同一 cursor 页面。切换取消所属 GET，迟到页不发布；读取失败保留已有历史并撤销写操作资格。SSE reset 先保存原 Store 全局目录基线，再重读 view/history；startAfter 只定扫描起点，onReady 确认连接，二者都不推进 ACK。模式/trust 与授权目录清除已用真实窗口键盘、丢响应原查询和实际 CAS 核对；旧入口切换、其余完整管理、安装与平台资格仍按证据判断。

Native 的[单次 Plan 入口与审核](../../apps/desktop/README.md#native-计划入口与完整审核)只传原 Run 的闭合意图与准确 Interaction 回答；完整正文由原 card/Artifact identity、EOF/hash/UTF-8 和 Main 当前视图传输证明共同约束。普通同范围刷新仅保仍 actual offered 的已完成 key，真实重选或观察 epoch reset 同时撤销 Main/renderer 正文资格；原模式与反馈草稿另按原身份保留。Planning 的实际 ToolResult 传递原 revise/deny/approve 与反馈，信息回执不授予 Tool 权限、不替新版本审核。已派发 review 取消后的真实 unknown 保留，原 Run cancelled 不冒充该调用已知 cancelled；正常退出仍核未知提示与所属进程清理。实际 OS dialog、其余管理、平台与整体 P5 资格各自核对，不从组件或单窗推导。

显式 run/report/interrupt 的 caller journal 在首次 POST 前持久保存原请求：CLI/TUI 是私人有限 `ui/recovery.json@1`，Native 的 `recovery_intents` 保留原 v2 合同，当前私人 SQLite v3 另承载完整普通 caller intents。坏文件、满槽、坏身份或无 profile-use 时零 POST；冷 submitting/accepted 只查询原命令，不换 Store/Session、不自动驱逐或重发。UI/renderer 没有文件或执行权，关闭/切换仅释放读取。维护 closed manifest v5 白名单保存上述恢复 journal、准确 Desktop v1/v2/v3 一致副本及完整普通申请 callerIntents.v1；原 closed v2/v3/v4 reader 的字段和物理路径白名单各自保持，不能将 DB3 标为旧 schema；恢复新 Store 不重标旧申请。理由与实测限制见[持久恢复申请记录](../../.agents/notes/implemented/architecture/2026-10-03-durable-caller-recovery-intents.md)。原 Session 中断事务已用准确 private proof/full ModelOutput reader关闭未派发取消 Tool 的原历史；attempted/跨Store unknown仍保阻挡，同ID原receipt零重读/写入。真实同Session SDK/PTY与sealed/CAS/unknown关联107/1307通过，取舍见[修复记录](../../.agents/notes/implemented/bug-fix/2026-10-03-interruption-settles-original-tool-history.md)。

共享 TUI 的[恢复面板](../../packages/ui/src/tui/README.md)区分原生 Ctrl+C/Ctrl+L 批次与 literal bracketed paste；前者只取消所属读取并查原申请，后者不能触发恢复或查询。原 GET 取消后的迟到结果不发布；原 POST 结果仍按原身份保存，取消读取不撤销业务效果。不新增 HTTP、执行权限或 journal 结构，输入边界与有限 macOS 资格见[恢复输入决定](../../.agents/notes/implemented/bug-fix/2026-10-06-recovery-native-controls-and-literal-paste.md)。

Model 的来源请求集与完整来源在同一检查点冻结；单个 Tool 复核该原请求集加本次准确输入，整批累计请求只供后续 Model 和持久恢复。可信文件工厂可声明 `contextDiscovery=read_only`，仅允许原模型依据完全未变时接纳宿主新发现的低权限项目指令；扩展来源、自报 kind、未知工具及副作用不获得此例外。原 Model 仍保原来源，下一 Model 记录新指令及工具真实结果。Core-only 条件读集冲突只重新评估纯条件；有序输入取代及完成治理刷新按真实未派发证明继续同 Run，拒绝、已派发失败与 unknown 不被转成成功。实现与回归归[Agent owner](../../packages/agent/README.md)。

来源新鲜度由宿主采集真实决策输入。模型路径刷新后重新决定；Action 保留旧 attempt 后重新准备与重新授权。批准、资源许可与来源检查都不能代替最终具名事务中的取消、owner、版本和业务条件复核；FS 与 SQLite 的非原子边界不被描述为全局原子保证。

默认宿主的模式与工作区信任来自原 Store、用户主体及准确根 Session/Workspace 的持久控制事实。Native 管理接口只保存用户明确选择，按已观察 revision 执行 CAS；工作区目录与额外读取范围的身份由宿主重新计算，不能由 JSONC、Git 元数据或客户端路径替代。Session 当前模式和用户默认值分别保存；恢复后旧 Store 的控制行不获得当前派发权。原 `getSession` 只读取有限 Session 元数据，权限读取不拉取历史正文。默认每次授权携准确 mode/default/trust revision，派发事务用原 Command 主体复核；人类审批仍保留该读集，父子 AND 合并相同 kind/scope/revision，冲突读集拒绝派发，已提交的撤销不能在授权与 SQL 派发之间被忽略。在途效果按实际取消能力处理，撤销不改写此前成功事实。便携 Desktop/UI 与 CLI 控制回执保留用户原选择，未知只查原命令、不重发；组件释放不停止 Service。same_command 授权保存真实来源 Session/subject/Store/Workspace、definition/version、原 Interaction/决定版本与完整 input 或可信 command digest；当前 policy 必须继续提供该范围，最终 markDispatching 复核 grant epoch 与 mode/trust/必要条件读集。清除仅作用准确 Session，并保存原 mutation 回执；新授权也推进 epoch。默认 Shell digest 来自实际宿主环境/资产与命令，不由 Model/JSONC 提供。正式入口和平台资格仍按进度单独登记。

Interaction 只有实际发起 Session 的权威请求，父展示与回答引用同一 ID。展示根与 ancestry 来自 Store，HTTP 不接收内部接纳或自报主体。答案保存后仍须原 owner 接纳并在派发事务核对绑定；`requestInput` 的 question 只提供信息。有限原 schema 的 oneOf/anyOf 分支及准确非空白 pattern `\\S` 沿同一节点、深度与关键字预算，由 Core 校验实际 JSON 自身字段，其他正则仍拒绝；DOM/TUI 共用中立的有限原 schema 解析，无法完整保留约束时明确回退 JSON。默认问卷的闭合 object 与 const:null 只构成普通信息答案：null 由 leaf 返回取消信息，同一 Run 继续，不调用业务取消。Native 页面草稿按完整原身份保留，pending 页缺席不清理，仅准确 accepted 回执或观察到替代／终态清原键；所选 pending question 隐藏主输入并保留原主草稿，具体页面合同归[Native owner](../../apps/desktop/README.md#native-普通问题与页面草稿)。默认普通 [ask_user](../../packages/agent/src/tools/ask-user/README.md)由 leaf 解释原 ID／闭合自由对象为文案，Service 的根选择、child 排除和可信零效果事实不提供其他 Tool grant。选项标题不替代内部值，自定义输入不扩大 schema 或权限，完整答案仍沿原 interaction.answer；边界归[Interaction owner](../../packages/agent/src/storage/sqlite/interactions/README.md)。Artifact 的 Core 端口保持中立，实际内容授权、不可变发布和二进制交付分别由 leaf 与 Service/Client 负责；知道 hash 或 renderer 路径不能代替原 scope。

[完整 Model 正文](../../packages/agent/src/model-body/README.md)把 Tool summary 和原 Artifact 全文一起交给实际 Model；大请求、来源与 Auto 审核使用准确原 scope 的不可变正文和有限持久 header。Provider 前完整核实并展开，成功 Model 保存实际 inputBodyHash。最终 SQL 事务仅核 metadata/原绑定与真实执行 proof，不读取正文或调用 Provider。64KiB 路由阈值不裁剪任务或来源；Worker 有限队列和控制预留保持。Auto 专用 carrier 的 planned-parent 准入只能由具名 Store 方法提供，公开 snapshot 不生成豁免；审查是同 Loop 的一个无 Tool Model，文本自报引用不授予权限。审核历史只包含明确的语义消息字段，Provider 私有 continuation 不进入审核普通正文、后续审核历史或公开 Inspector；原私有请求仍在原 scope 完整验证，投影不替代原 carrier／payload 绑定证明。大请求的人工回退附件需要客户端实际完整加载资格，不能把引用展示当作已经审阅全文。

steer 定位原活动 Run 的安全检查点，follow-up 保留独立命令及原前驱；已派发调用不会因新输入而改写原决策。模型输入取当前上下文选择，分别穷尽消息与结果引用的固定上界分页。合法 pending delivery 仅由原执行 owner 在准备模型请求时消费，完成游标保存在执行事实中，不依赖可裁剪通知。idle 或只读查询不创建模型请求。Rewind 核实整个执行组，原子隔离旧 pending 并保留历史；显式 include 只增加准确原来源，不重跑、不恢复旧交付。子内部结果与父 carrier 结果保持各自 Session 范围，实际模型请求记录准确 source IDs。

Context 只读准入核当前 Store，`resultSources.originStoreId` 则保留真实原 Execution 的出处，离线恢复后两者可以不同。Core 在同一读事务核当前 Session／selection／高水位，再核来源的准确 Execution／revision／origin；TUI 与 Web 聚合沿这个合同保留完整结果，不重标来源或扩大执行权。原双游标、其他 Session、重复记录和选择／上界漂移守卫保持，真实恢复与消费者范围见 [CLI owner](../../apps/cli/README.md)和[Web owner](../../apps/web/README.md#按需只读诊断)。

正式 TUI 的 Context／Session 原申请查询消费已封存完整 intent，固定原 Store、Session、Command 与请求体，不依赖当前选择或首次 POST 回复缓存。UI 关闭、换选择或切会话只撤销该 GET 的读取和展示资格；公共 Client 的原 Command／维护 Run 身份校验保持。只读结果不触发 Fork 导航、删除后继或业务取消，也不授予跨 Store 执行权。当前入口、生命周期内记录与验证范围归 [TUI owner](../../packages/ui/src/tui/README.md)和[CLI owner](../../apps/cli/README.md)，不扩展公共 API、私有存储格式或冷启动发现承诺。

恢复后的显式 `result.include` 是当前 Store 的新上下文命令，原结果出处无需等于当前准入。正式 Native 从当前观察核准确已终态 suppressed Job、revision、Session／Workspace／selection 和活动目标；正式 TUI 核当前 snapshot/view 的 Store 与所选 Session、原 Execution/终态/revision 和准确 active Run。两者沿公共 Client 由 Core 写入事务核原 subject、delivery target Session；结果引用保原 Store，idle 只登记来源，活动受理仍等待原 checkpoint。它不改原 delivery、不重放 Job，自动 consume 的当前 origin／owner／selection／stop 限制保持。当前消费者和真实恢复范围分别归 [Native owner](../../apps/desktop/README.md)与[TUI owner](../../packages/ui/src/tui/README.md)。


活动结果 include 固定原 Store/selection/targetRunId/Execution/resultRevision，accepted/result_queued 只表示等待原 checkpoint。checkpoint 与 steer 同序原子保存完整 source/message/receipt，新 publication seq 使原冻结 upper 不获得后来隐藏来源；旧已派发 Model 不改写，未派发旧计划/审批失效，取消保持零纳入。任务 wait-any可因新输入早醒，普通 operation wait仍等终态；只读目录与来源不触发执行。

Fork的新`session.create`保存原selection/upper，历史不继承Run/Execution/owner/grant。SQL出处链核creator/subject/role/status/source/parts；公开originMessage和正文原scope保持。可信omit/copy/rebuild在构造时封存，最终同事务核namespace键集/revision/raw/origin/selection并发布Session/消息/回执。`readForkRecordSources`仍是要求live source stamps的records观察，不开放一般祖先Execution/Artifact。

显式`sourceReads:'declared'`可由纯rebuild规则声明有限actual execution/ref或已封存subset，Host自动核Tool实际Model闭包、全文/媒体EOF，Fork finalSQL核原完整group静止及metadata/ref proof。当前anchor的`openForkSourceProjection`只在callback生命周期内读精确原Execution/Run/Model/媒体与完整selected aliases，不依赖后来mutable source head，也不扩普通reader或授权。Action bindings由最终SQL自动复核，Ask后drift零adapter；业务完整snapshot与point资格归各leaf。预算和实际资格见[Fork owner](../../packages/agent/src/extensions/fork/README.md)及[实施取舍](../../.agents/notes/implemented/architecture/2026-10-03-sealed-readonly-fork-sources.md)。派生provenance普通CAS不能清除，不能取得原计划/义务/operation执行权；原Command GET不重跑规则。

Session rename/delete 为原 root creator 的 Decimal64 控制 CAS。原命令返回保存的提交快照，不用当前标题替换旧回执。删除同事务保存整组 tombstone、真实 deletedAt、停止边界，Runtime 只通知其实际拥有对象停止。`delete_requested/stopConfirmed:false` 保留未确认与 unknown，目录隐藏不等于物理清理或撤回外部效果。第二 Runtime 删除及 HTTP 丢回复见 Agent/Client 证据。Workspace 批量移除现一次事务核所有根主体并保存整组 tombstone、停止边界与现有 metadata 中闭合原 receipt；目录隐藏、迟到新工作拒绝，不逐条等待。Native 默认保留的原生确认后先持久保存原申请，仅 POST 一次；冷申请与 unknown 只具原 Store／主体／Workspace／Command GET 资格。空间和单会话执行组的正文清理沿显式离线维护，存活Fork及其他未清理会话的真实关系依赖保留来源；安装维护和完整恢复资格仍未闭合，负责实现与证据见[Store owner](../../packages/agent/src/storage/sqlite/session-management/README.md)和[Native owner](../../apps/desktop/README.md#native-空间批量移除)。

[原始 Session 导出](../../packages/agent/src/storage/sqlite/export/README.md)通过 begin/page/text/final verify 冻结同 Worker 的 root/主体/Store、全局 cursor、data_version 与 11 个 section 完整高水位/计数。每个短只读事务复核原 manifest；可观察提交、换 Worker、缺行、范围错误或取消均不发布完成标记，不持跨请求生产事务。未知内容与 provenance 保原文本；仅实际文本列 descriptor 提供准确 byte-range，不扫描 payload 推授权。SDK 核每页完整性与全文 EOF/hash，最后 Core proof 成功才发布 records/text completion；Artifact 仅保原 scope 引用，媒体核验、数据库备份和文件原子发布另由各自 owner 负责。

Context 压缩为单选可信算法 slot，通过同一 Loop 的记录 Model Execution 保存完整输入、覆盖范围与摘要出处；提交前原上下文仍有效。后续输入使用带原 source ID 的低权限摘要，原历史、Model/Artifact 引用和 contextSelectionId 不因压缩改标。人工完成与摘要 publication 同一最终事务；自动失败保留旧选择，未变化的输入不立即无限重试。重置须由原 slot 对完整展开输入明确预检，缺少或拒绝预检保留活动点并且零 Provider。slot 的实际摘要校验、目录 fingerprint、来源新鲜度、取消与必要条件仍在发布前核对，不把结构完整当作已知模型窗口安全。HTTP/Client 只保存原受理意图，真实终态查原 Run；未知回执不重发。默认 pure 算法和实际 SDK 子场景见[Service owner](../../apps/service/README.md)。

公共 Message 可带只读 `compression` 显示身份，仅由同 Session/Run 的准确 Model 与 snapshot 推导；已发布、失败、取消和未发布分开。压缩 Model 的完整正文不具最终回复资格，普通模型正文也不能先于实际 Run completed 取得最终回复资格。默认已知窗口使用总窗口 75% 水位，不能缩小或无继续空间的摘要以明确原 Run 失败收束；未知窗口维护点不成为 Provider 容量上限。

压缩覆盖不抹除真实用户及父到子任务输入的模型可见性。Core 在原 selection／高水位中按真实 Command／应用回执及 sealed Fork 出处保留人类原文；父到子初始任务和后续指示另核 sender Tool、carrier Job、真实父子／root 与原配置输入，保留 Agent 来源而不取得人类引导身份。模型顺序为摘要、已覆盖原输入原序、未覆盖尾部；私有 `retainedInputMessageIds` 不进入 HTTP／SelectedContext schema，也不表示授权。普通邮件、子回报与工具资料由摘要承接，旧终态输入仍受原历史授权边界约束。Core 与默认 Service 复用准确 Host 组装边界，不能仅凭裸 Source ID 排除或固定普通历史。缩减和窗口校验包含完整保留成本，不能静默裁剪原指示；来源与定向回归归[压缩 owner](../../packages/agent/src/storage/sqlite/context/compression.README.md)。

Native 原压缩／重置查询沿原 Command receipt 使用公共精确 Run reader；当前 View 只承担实际 scope 准入，有限近期 Run 目录的缺项不抹除原执行。调用者核原 Run／Store／Session／Command，原受理与执行状态分开，GET 失败不替换已核事实或触发新的执行；具体入口与验证归[Native owner](../../apps/desktop/README.md)。公共 API、Store 格式和原维护写入门禁保持。

Native 同 Session 的压缩原输入入口沿当前准入 Store 读取准确原 Model Execution，恢复前后的 Store ID 不必相等；原压缩卡出处和 Core 的原 Execution／Run／Command／root-work 主体证明保持。实际父回调只选择原调用，敏感确认后由既有完整 reader 核 EOF／bytes／SHA 和当前选择；关闭或切换释放所属读取。跨 Session 封存卡不扩大当前 Inspector scope，压缩／重置与旧来源执行门禁不由阅读放宽；当前行为和证据归[Native owner](../../apps/desktop/README.md)。

TUI 未提交文本由可信 CLI 宿主保存到所选 profile 的 `ui/tui.json`，共享 UI 仅通过有限 draft port 读写原身份文本。独立宿主 profile-use lease 持续至最后保存与UI关闭，Service死亡不释放；短写锁由 Agent/profile-access 固定用途提供。成功受理仅清除原编辑版本，CAS冲突/格式损坏保原磁盘与本地输入，正常退出保存失败保持编辑器。`/drafts`与`/draft <id>`只读原已保存记录，恢复后的旧Store草稿不重绑、不自动发送。

[TUI 已加载文本导出](../../packages/ui/src/tui/export.ts)冻结当前原 Store/Session 与展示正文；完整正文只使用已经验证加载的内容，未读正文保预览并标明不完整，不额外读取或执行。可信 CLI 宿主从已选择 profile 推导配置目录，以0600独占创建唯一 Markdown 文件，UI 不提供路径；迟到结果不发布到新会话。

共享 TUI 主 Composer 对普通文字加一个尾 CR 的合并 native 输入，先保存原草稿再沿原 Return 处理；候选按更新后的 token 核对，待完成文件引用不发送，第一次补全后仍需另一次提交。literal bracketed paste 独立保原 CRLF/Ctrl，不触发该提交；准确目标、stale/unknown 与持久申请仍由原 controller/host 门禁拥有。实现与有限实际 Ink/导出 PTY 范围由 [TUI owner](../../packages/ui/src/tui/README.md)维护。

[显式离线备份](../../packages/agent/src/maintenance/README.md)单独取得数据单元外稳定 profile-use 排他锁。Core与Desktop原DB/实际WAL完整配对复制至本次私有scratch，SQL只打开副本；每次复制及SQL前后核原配对presence、完整proof和实体，缺失副文件保持缺失，scratch不进入发布树。SQLite候选与引用媒体完整核验后才发布ready；v2另按独立时间采集原config字节和经闭合格式验证的Desktop UI一致副本，保原草稿/创建身份，不承诺跨介质同一瞬间原子。独立凭据vault、未采集宿主私有资产和协调锁不包含，配置原文自身可能含敏感内容，保持私有权限；TUI真实未提交文本亦按v1闭合JSON采集，保原Store/Workspace/Session、Decimal64和完整文本，不重绑旧草稿。源码/leaf与完整包备份已验证；Worker在释放profile使用锁前必须严格关闭SQLite及其缓存语句，普通close不足以证明数据库文件不再变化。私有副本不放宽关闭/排他边界，也不证明非合作外部writer被阻止；恢复与平台资格仍按实施进度记录。

Native 的 `configuration_management` 通过公共 Client 固定原 Store/generation、命令与 CAS，只发一次 mutation；丢回应和无效回执只按原 ID 查询。持久 HostMutation 仅投影安全 scope/workspace/ifMatch/opaque结果，不返回秘密或内部 request digest。无 Runtime 的诊断连接只允许用户配置读取并保留错误；Browser 不增加管理权。Native 模型面板由 main 冻结观察并固定 user scope，renderer 只有安全模型事实，专门模型设置 API 服务端验证启禁/default、有效配置及原读取集，普通 JSONC 保存仍允许暂时不可路由的期望配置。Native 写入消费者已在真实两模型窗口验证旧轮次A/下一轮次B、物理回执丢失一次POST/原GET、原读取集冲突与冷读零额外Model；main固定原scope/readSet，renderer不取得内部配置权威。后续完整 Native Provider/下一次模型能力已接公共四family设置与显式空名称发现，见[Native owner](../../apps/desktop/README.md#native-provider-与下一次模型选择)。发现只证明目标列表响应，不代表远端可执行资格。

显式恢复生成新 Store，旧origin与已完成receipt保留，备份中的未完成工作不得自动执行。切换全程持同一外部排他锁，先保存原目录再发布候选；未完成journal阻止普通入口建库。核实完成/回退必须匹配观察restoreId/digest及准确目录内容/Store，不能靠路径存在猜测。已交付publication和七个强杀窗口；新 Store 准入和封存原来源现分别校验，原 Model/Artifact/压缩/child/Fork/导出完整读取及新明确 Run 已经真实恢复复验；旧来源执行和新引用发布守卫保持。离线 CLI 直接调用维护 leaf，准确 Store 和明确数据回退确认不可省略，journal 核实另需原 ID/digest/decision；不启动 Service/Provider。配置/Desktop UI采集已由真实owner及携资产的强杀窗口验证；Node独立使用锁的真实窗口已核Service强杀后仍busy、所属UI退出/Node强杀后释放、其他profile不受影响；TUI原文资产及七个强杀窗口已纳入验证；显式GC持同一外置排他锁，核原Store与私有数据库副本；副本源证明结束后，单个SQL事务清理过宽限且无未结束／未知／待核对工作的已移除Workspace正文，保留原删除边界、Command去重／receipt与执行终态。空间外关系依赖拒绝，原通知正文删除同时提高replay floor；独立 `historyCollection@1` 经可选Session DTO说明清理，不改变原Workspace receipt。当前Core页与WAL收尾后，再清全量hash／实体核实的无引用过期附件；未结束和其他空间引用保留，私有草稿与项目文件不修改。DB8 原 Workspace 申请仅由 closed manifest v17 采集／恢复，不扩大旧 grammar。单会话root组也按相同宽限与终态规则清理，来源依赖保留向祖先传播，全部符合条件的删除链可同批清理；独立 `sessionHistoryCollection@1` 映射root清理时间，经既有DTO说明结果。当前namespace未删除，原历史祖先tombstone仍允许sealed只读，已清理来源拒绝；不继承执行权。安装版维护、引擎和平台资格继续闭合，不能据目录切换成功宣称完整恢复。[维护owner](../../packages/agent/src/maintenance/README.md)维护准确范围。

[私有UI使用锁](../../.agents/notes/implemented/architecture/2026-10-02-private-ui-profile-use-lock.md)由Node原fd持有，私有产物中的一次性Bun helper仅对继承fd取得shared flock并关闭自己的副本，不UNLOCK；不依赖Service生命周期。SQLiteclose成功后才释放，失败留锁；维护/journal拒绝不建空UI。当前macOS实际Node/Electron已验证，Linux未资格、Windows inherited-fd明确拒绝。


正式Terminal与开发daemon通过Service私有有限socket／Windows pipe交换bootstrap，业务与关闭仍用公共HTTP Client；不把native发现协议暴露为公共业务carrier。paired/daemon共用一次Store/Runtime装配，父EOF策略分别保持；目标子进程只读SQLite预检在旧实例停止前执行。Windows父launcher和实际Daemon各持自身完整candidate使用权，原native关闭未知保原owner／诊断并保活；实际边界与各平台待验范围归[Service owner](../../apps/service/README.md)，CLI惰性资产与原实例一次关闭归[CLI owner](../../apps/cli/README.md)。CLI run/resume与TUI的显式`--server`经私有宿主发现后固定原实例、profile与Workspace，连接失败不启动替代；共享close仅disposeNetwork，TUI独立草稿lease保持至UI退出。公共Client/UI不引入native发现依赖，Windows实际安装整链与完整平台／全部调用者迁移资格仍未完成；设计依据见[私有bootstrap Note](../../.agents/notes/implemented/architecture/2026-10-02-daemon-private-bootstrap.md)。

原shutdown后的PID/start暂时uncertain仅延续既有有界只读观察，成功仍需真实dead证明；持续不明、drain_failed及超时不授替代启动、强杀或endpoint清理权。最初发现、reservation与kernel身份分类保持，公共Lifecycle Client仍只一次POST；检查窗口含末次HTTP等待而非硬实时期限。真实Job消费者及受控观察反例归[CLI owner](../../apps/cli/README.md)与上述Note。


TUI 模型设置同样通过专门公共 API，固定 user scope 和原读取集，统一读写 ~/.kite-code/kite-code.jsonc，不按 Profile/Workspace 覆盖；UI 只得到有限 default/enabled/effort 操作及安全模型 metadata，不取得配置索引或凭据。effort 的有限 enum/null 纳入原 HostMutation marker 和幂等冲突校验；支持字段表示 compatible 适配器 wire 能力，不能推导远端模型支持。清除只影响所选 scope，保留配置 options 的既有整组覆盖语义；原 Run 冻结值不变。Native 当前有限启禁/default IPC 未因 HTTP 契约扩展而扩大。

已有根Session `job.report` 的显式冷恢复使用专门 `resumeJobReport` 和 `job.report.resume` 申请；不把读取、普通新Run resolver或adapter reconcile当作恢复。原父manifest、真实source/result、Store/subject/selection/取消与当前afterTurn授权在原子应用前复核。公开HTTP只传原report ID和新command ID，完整配置来自持久父Run及可信恢复resolver。`applyJobReport.started` 分辨本次新建与历史Run查回，只有前者进入唯一Loop；绑定资源通过实际Run及后代lease最终释放。外部Job reconcile使用下述独立受限恢复所有权与监督证据，不能通过此报告入口解除unknown执行限制。原绑定、幂等与资源释放取舍见[冷报告恢复Note](../../.agents/notes/implemented/architecture/2026-10-02-explicit-cold-job-report-recovery.md)。


显式 `job.reconcile` 在派发前封存的恢复manifest和原reference之上取得独立purpose的root OS lease；该lease不能用于普通owner写入。可信新核实授权与当前控制读集在查询前/归档时复核，原扩展/adapter/配置必须精确重建，缺失时局部拒绝。查询只追加带adapter_reconcile来源的Command证明，不改原Execution/resultRevision/旧Context引用，不调用start/observe或旧Run；pending旧delivery抑制以阻断日后隐式消费。只有准确原Job、Store、root和revision的已知结果+ended证明能解除该Job对普通owner的阻挡，其他unknown及独立Fork/Rewind门禁保持。原关联/恢复配置保留私有，公开请求和原始导出中的Command只含身份摘要；结果与证据仍按明确原作用域校验。[存储owner](../../packages/agent/src/storage/README.md)与[Runtime owner](../../packages/agent/README.md)维护实现和验证范围。

上述追加证明与历史引用取舍见[Job核实Note](../../.agents/notes/implemented/architecture/2026-10-02-append-only-job-reconciliation.md)；它与原报告冷恢复具有不同目的，不替代原报告绑定要求。


同 Store 活动根 Run 的显式 run.resume 仍使用独立准备 lease 与公开原身份，准确重建原配置后原子接管其实际 child 闭包，进入唯一 Loop。子权限、记录读取、取消、selection、generation 与组摘要均在交接前核验。外部 Job reconcile 的追加证明、旧审核 child 闭包和任意 runless 效果没有获得一般恢复资格；已结算权限检查只按准确原目标交接 fencing 与 proof，不重跑检查或生成新授权；具体[协议与限制](../../packages/agent/src/storage/sqlite/run-resume.README.md)由 owner 维护。

长 Run 不以累计来源请求或已完成 Execution 数量终止。新 Model 封存版本化 continuation，恢复来源请求和同工具失败 streak，当前 Tool 批次按原顺序结算；旧记录仍完整历史重建。首次 SQL 流式审计保持原摘要；同一 SQLite 未变化快照可复用，任意写入均使其失效，最终 CAS 和未知效果守卫不放宽。完整历史首次成本仍线性，独特来源和实际资源资格仍需分别测量，见[恢复 owner](../../packages/agent/src/storage/sqlite/run-resume.README.md)。

原检查点与初始化三态的理由仍见[原决定](../../.agents/notes/implemented/architecture/2026-10-02-durable-run-resume-checkpoints.md)，执行尝试、组监督及验证快照的扩展取舍见[当前决定](../../.agents/notes/implemented/architecture/2026-10-16-durable-continuations-and-group-recovery.md)；两者均不授予任意外部闭包重放资格。

原根执行组的显式 `session.recover(decision:"interrupt")` 也只接受原 Store/Session、申请 ID 与认证主体。Service 读取当前或同 ID 原持久请求的内部 generation，Core 的原 OS 锁及 Store fencing 保持唯一权威；HTTP/SDK 不接收或返回 owner lease/generation。公开 Command 查询投影与写回执一致，只保留准确原 ID 集、partial 和 Decimal64 水位。可能产生效果的调用保持 unknown，不因 applied 回执获得重放或普通 owner 资格；GET 只读。真实 Tool/Model 强杀、原 ledger、同 ID 与物理丢回执证据归[Service](../../apps/service/README.md#显式遗留执行组中断)与[Client](../../packages/client/README.md)。


宿主诊断由Service实际默认配置装配提供独立readonly source，process-service从Runtime参数拆出，通过闭合HostStatus HTTP/Client传递；不重建旧App Control/carrier。source与实际Shell资产检查共用真实校验；默认macOS可信host选择coalition/Seatbelt闭合tuple，Linux准确报告namespace／Bubblewrap及显式unqualified资格，显式POSIX仍报告group/none。诊断选择不冒称GET已执行全树验证，API注册不授授权。数据不可用仍可读安全身份，权限/信任只读当前主体的准确scope，缺权威局部unavailable。未绑定发行manifest保持production:null，未配置exporter保持禁用，不从buildId/JSONC推导。CLI状态保原Workspace信任检查，只有显式trust才独立mutation，诊断GET零业务写入；TUI保持HTTP与SSE独立状态和切换读取代次。当前scope归[Service](../../apps/service/README.md)、[Client](../../packages/client/README.md)、[CLI](../../apps/cli/README.md)与[TUI](../../packages/ui/src/tui/README.md)；正式制品资格仍由实际发布验证证明。

有限诊断与执行授权分离的理由、接口闭合成本和当前资格见[宿主诊断Note](../../.agents/notes/implemented/architecture/2026-10-02-host-diagnostics-from-assembly.md)。

Skill知识目录属于Service宿主：公共只读目录和实际Run装配共用配置ID、canonical目标、正文version/digest及能力检查。单条坏项不阻未选择它的任务，显式选择和父原继承失效必须局部拒绝，不能静默换成同名项或扩大目录。目录metadata闭合，不外泄路径/正文/凭据；完整分页按原Store/Workspace/主体/信任与完整内容revision，变更后拒绝续页而不拼混。读取不启动Provider、Run、MCP或脚本；TUI面板的读取成功不能清SSEunknown。知识目录和单Run selectedSkills不替代旧Workflow activation/inline/fork/output/verification，后者迁移状态继续按完整方案记录。

终端显示偏好由 CLI host 持有当前 profile 的 `ui/preferences.jsonc`，共享 UI 仅接收有限已确认值和单字段 CAS 保存 port。`/theme`、`/language` 不写 Service 配置、不提交业务 Command，不依赖 SSE freshness；更新呈现 context 保原 Session、草稿、审批和完整输出。原 profile shared authority 必须在读写发布时仍有效，文件由现有 configuration leaf 提供锁与原子发布；偏好原字节纳入维护备份。具体实现与失败行为由 [CLI owner](../../apps/cli/README.md#开发-tui-显示偏好) 负责。

Native 原启动页的进入条件只消费当前 attach generation 与已经核实的首屏完整目录，不成为执行授权。初始化的明确重试只替换旧观察，Main 原 detach 释放所属读取和选择；迟到旧代次不进入新页面。已进入后的断线保留原内容和草稿，未知业务提交仍按原命令核实，不因重试启动页获得重放或 Service 控制资格。共享 UI、Core、公开 API 与私有格式保持；当前范围与分层证据归[Native owner](../../apps/desktop/README.md#原启动页与初始化重试)。

Native 原主题属于窗口 Host。preload 的固定主题端口只传暗／亮／系统枚举，Main 在同一同步调用内核准确窗口、主 frame、renderer URL 和闭合 payload 后更新原外观引擎与底色；它没有 Store／Session／generation 或路径参数，不打开业务 caller，不取得服务或执行权。renderer 的本机偏好和 media 监听沿原 Hook，Main 的 updated 监听由窗口 closed 释放；业务观察和持久提交保持原边界。当前实现与实际 macOS 首次／冷读范围见[Native owner](../../apps/desktop/README.md#原主题与窗口背景联动)。

Native 原消息复制与标题栏缩放同属窗口 Host。preload 只提供固定文本复制／无参数缩放端口，Main 在宿主动作前核当前窗口、准确主 frame、renderer URL 和闭合 payload；复制保原 1 MiB UTF-8 上限，超限失败、不截断，缩放只按实际窗口状态切换。端口不取得 Store／Session／Service 或执行 authority，正文是否完整及当前可复制仍归原共享 UI／原 reader。失败不重发业务或丢弃草稿；实现与分层验证归[Native owner](../../apps/desktop/README.md#原消息复制与标题栏缩放)。

Windows 顶栏菜单同属窗口 Host。有限 IPC 只接受四个菜单枚举、窗口内整数位置与页面可操作标记，Main 在原准确窗口／主 frame／renderer URL 校验后按真实缩放打开原生下拉；该标记不授予业务权限。文件项及三个固定快捷键只返回既有页面动作，renderer 复核当前启动、mutation 与退出状态后调用原 controller。编辑与窗口角色不打开 Service caller；隐藏和退出继续沿原生命周期，设置、目录选择及登记仍由原业务端口授权。当前实现与 Windows 有限窗口验证归[Native owner](../../apps/desktop/README.md#windows-顶栏菜单)，Core、公开 API 与私有格式保持。

Native 明确退出的活动检查只读完整公共目录与 View；两秒超时仅撤销本次 GET，不能把未回答当无活动，也不撤销其他观察。普通窗口隐藏／激活不停止 Service。活动或未知时最多一次确认，空闲直接关闭界面；确认后 Main 在任何清理 await 前销毁原窗口，macOS 同时隐藏应用与 Dock，禁止激活或迟到启动重新展示。最后窗口关闭不提前结束原 Main；启动、在途重载与资源仍由原 owner 在后台收束，没有默认二十秒强杀。清理完成才退出0，清理失败沿准确 child 句柄处理并退出1，不追加提示。紧急退出不发现其他 PID，不给卸载或普通读取强杀资格。配对 launcher close 与实际退出状态分别核实，非零退出仍为失败；窗口消失不证明清理和取消成功，未知执行保持原事实，正常清理顺序和双层制品使用权不放宽；实现与有限故障／实际窗口范围见[Native owner](../../apps/desktop/README.md#原窗口关闭与退出收尾)。

Main 通过原固定 channel 的闭合生命周期通知撤销 renderer 旧读取的展示归属；它不增加业务请求或执行权。确认前暂停自动刷新，取消后沿同一 generation 恢复状态／目录／选择和原草稿读取，不重新 attach 或提交业务。确认前的展示撤销不提前 close／detach caller，也不消除真实当前错误或已提交 mutation 的未知回执；确认后窗口及其页面／browser view 销毁，原 caller 与 Service 仍由 Main 在后台沿原顺序关闭，不追加收尾提示。原 frame 身份与退出资源门禁保持。

Native 启动诊断只来自本次所属 Service 的闭合私有 stderr 帧，经 paired launcher 重建后由 Main 持有；通用错误不变造有效报告。保存沿两个无 payload 的固定 host IPC，renderer 不提供报告或路径，Main 只写系统对话框选定的新文件，等待后复核当前 frame／窗口／报告。重试清除前次资格，保存不打开业务 caller、不修改 Store、不获得执行或恢复 authority；当前实现与范围见[Native owner](../../apps/desktop/README.md#原启动诊断保存)和[Service owner](../../apps/service/README.md)。

默认 Service 的项目来源目标选择只接受原 Workspace 内路径；越界 Files 输入不触发外部项目说明读取，仍由 Files 原边界以普通 Tool 失败返回，原 Run 可以继续解释。根说明不可读或内部目标来源不安全仍失败关闭，不能把来源错误普遍降级为可忽略。实现与验证归 [Service owner](../../apps/service/README.md)及其 [拒绝回归](../../apps/service/test/isolated/assembly-file-denial.test.ts)，未扩大文件授权。

## 授权观察与执行资格

Native 的通用交互历史沿原公共只读页核相同 snapshotCursor、准确来源／展示关系和 EOF；明确 `origin=all` 只读该 Store 实际保存的恢复记录，默认当前查询与旧 origin 写入守卫保持；当前准入和原卡／附件出处分别核对，不补 Fork／Include 祖先后来的记录。它不建立新的原卡回答观察。完整历史附件与当前审批分别持有 reader／loaded proof，前者不能授权后者；关闭、刷新或切范围只释放所属读取。记录与受理、执行成功分开，当前接口的变化拒绝与恢复限制归 [Native owner](../../apps/desktop/README.md#原交互记录只读历史)。

公共 Execution 的可选 `authorization` 是同一读取内的有限原事实，分别保自动审查、人工答案保存／受理与派发；它不携私有请求、主体、owner、完整审查或上下文，不进入执行 grant。历史 observer 可忽略当前可变取消／上下文，但仍验证原身份、purpose、完整原输出和 Artifact proof；原授权默认路径继续核全部当前条件，见 [Store owner](../../packages/agent/src/storage/README.md#只读授权观察)。Native 复用原审批组件，附件资格和提交仍归原 InteractionCard／Client；封存 Message 不借来源 Execution 后来的审批补历史，准确客户端范围见 [Desktop owner](../../apps/desktop/README.md#原审批面板与授权观察)。

Native 原 Composer 的当前会话模式选择沿既有 permission observation；Full 确认以阅读身份撤销。停止沿原持久 Caller 的 `command.cancel`，只目标已核实当前活动 Run 的原开始 Command，未知申请保原身份；控制与只读授权标签分别拥有资格。当前职责与窗口范围见 [Native owner](../../apps/desktop/README.md#原会话输入区权限与停止)，没有新增执行端口或持久格式。

TUI 权限保存的原结果与显示归属分别持有：当前 Store 的 mode/grants 按原 Session、trust 按实际 Workspace，全范围未决项阻止新写；关闭、切会话或重开只撤销旧读取的展示资格，迟到结果仍归原意图。原查询以 map 已核事实为基线，同 ID 最新请求持有结果更新资格，网络未知不降级已核终态。此 map 仅当前 controller 生命周期，不成为权限 authority 或跨进程 journal；原完整观察/CAS和公共权限接口保持，当前实现与验证范围见 [TUI owner](../../packages/ui/src/tui/README.md)。

TUI 用户模型/effort 设置按准确 Store+user scope 保存和查询原意图，来源 Session 与本次展示归属分开，跨会话和 Workspace 保留原 ID 查询；未核实的用户模型写阻止竞争新写。modelRead/generation/原 panel 与原 ID 共同核展示，map 的最新同 ID 请求核结果更新；已核终态不因失联降级，活动 Run 仍用原配置。Model/Permission 仅复用原结果选择，scope、公共完整 read-set/CAS 与安全 marker 分别保持；没有新增 authority、持久格式或 Service 判断，当前完整行为归 [TUI owner](../../packages/ui/src/tui/README.md)。

## Skill Workflow 的执行边界

已有有条件 Workflow 使用 Agent 的[显式业务扩展](../../packages/agent/src/business/skill-workflow/README.md)。Core 只保存通用具版本 `extensionInputs` 原意图与 Command 摘要；Service 先验证支持、可信实际源、flags 与 payload，再读取凭据。初始化记录先于首次 Model；动态必要条件绑定对应 Extension 判定器，不能由全局业务 provider 错接或忽略。知识目录和 selectedSkills 不触发 activation。

完整指令和输入不塞进初始化 metadata record，activation 以原摘要绑定可信契约和原 Command。宿主冷重建后必须核同一输入，缺失或变化不能借进程内缓存获得资格。可信完整 Run 配置在 start、follow-up 和 child 路径一致保存，不为含来源正文的 child/follow-up 配置另加 1 MiB 上限；原消息、HTTP/IPC、metadata 与 Worker 队列限制分别保持。大配置仍参与完整 operation 摘要、子激活全等和冷恢复核对，没有 Skill 专用 SQL 分支。

不可变 anchor、CAS head 与 append-only attempts 由扩展 records 持有，fork 和脚本核验使用普通 operation/Execution。内部状态变化不改写原 Model sources；required 失败后的 repair 仍保留原 ceiling、最低审批与 source freshness。新尝试只能由准确原 failed proof 和实际 repair/replan carrier 创建，旧 complete/verify 的缺省始终指 attempt 1，不能指向新 head。child 的实际工具、Job 与原来源范围由可信父快照和原 opening Execution 限制，resolver 只读父 namespace 的完整投影自动进入最终 carrier/activation 事务 CAS；prompt 不提供权限。完整输出、原 result revision 与 configured verifier proof 均在最终完成条件中核对；失败/未知不自动重跑，Session fork 不复制旧 activation 权利。最低审批不能扩大原策略硬拒绝。

可信 Service 封存 versioned replan/waiver/compensation policy，JSONC/Skill/Model 不提供决定权。真实普通 question 的 request/accepted receipt 绑定原 Store、主体、Session/Run、anchor、requirement/Skill revision、head/attempt、完整 output digest 与原 verifier proof。waiver 另存 waived，原 verification 仍 failed；replan 另建 attempt。信息问题前后核实际 bound permissions/control reads，最终条件连同原决定记录一起核验。通用执行安全读取从原 Run 的持久 parent/child 闭包形成完整 revision、boolean 与准确 unconfirmed IDs；Host 只固定自身 Tool 排除项且遍历其后代，Job 不排除。实际 planned Job 的 satisfied dispatch/approval 可核自身与准确父工作，最终事务复算同一闭包；completion/waiver 与信息接纳仍要求无未清效果。普通无约束对话不因此新增全局义务。

完整人工审批 request 超过有限卡预算时，以准确原 Execution scope Artifact 交接原 input/policy/grants；卡复用既有完整附件协议。接受与最终授权核 hash、scope、完整原文和当前准确 policy，主体与原审批 binding 保持；相同正文的两次审批仍有独立 Execution 引用，不互借许可。CLI 原 work 的 runless verifier 卡从准确持久 parent Execution 闭包定位，不用当前 active Run 猜测。CLI/TUI 未知 answer 保留原答复 Command，恢复只 GET 原 ID，不能重复 POST 或改绑新会话。

手动调用目录以 `workflow=manual` 和实际 source 的 `skill_workflow_catalogue` 显式启用；原闭合知识 DTO 与 revision 保持原路径。投影与运行共用可信源编译和实际 Tool/Job/role facts，额外元数据不含指令、路径或凭据。读取不调用 Model、vault、MCP 或 Job，资格只说明当前手动空输入可用，不预订未来执行版本。Service 在提交时重新绑定实际源，不由客户端目录扩大权限。

终端把知识 `--skill` 与执行 `--activate-skill` 分开，TUI 动态名称仅从真实 compiled metadata 唯一匹配，固定命令优先。完整 `extensionInputs` 属于原 Command；idle 使用 start，active 显式激活使用原 afterRunId/contextSelection 的 follow-up。未知回执只按原 ID 查询，不重复 POST；目录、迟到回执与草稿清理始终绑定原 scope/version。具体目录与调用边界由 [Service](../../apps/service/README.md#同源-skill-知识目录)、[Client](../../packages/client/README.md)、[CLI](../../apps/cli/README.md)和 [TUI](../../packages/ui/src/tui/README.md)负责。

专用 profile `skill-workflow.jsonc` 默认关闭三项特性，纳入[维护原字节资产](../../packages/agent/src/maintenance/README.md)，不因恢复或缺文件自动启用。原 operation 等待超过有限观测窗口仍只查询原工作；没有隐藏重启器。声明补偿在原 Workspace 内契约、可信 policy 与实际 macOS confined 后端齐备时，使用独立 ordinary `skill.workflow.compensate@1`、原 accepted decision、一次 opening/operation 与 minimum:user 审批。完整原字节含二进制被封入只读副本，固定 Bun 在原 Workspace 执行，实际网络/fork/保护写拒绝；guardian 未确认仍保 unknown 和资产。compensated 不改 failed，也不替代新验证或准确 waiver。当前仅禁止子进程模式，完整恢复、正式入口和平台范围继续按[实施进度](../plans/unified-agent-refactor-v1-progress.md)闭合；取舍见[补偿记录](../../.agents/notes/implemented/architecture/2026-10-03-declared-workflow-compensation.md)。

macOS 默认宿主、显式普通 POSIX 与严格 confined 沿用原 guardian/held-root 的唯一 closing和准确 reap。默认 ProcessService 已装配宿主后端，以原 resource coalition/内核 task count/pidversion 信号另核完整 setsid/orphan 后代；普通 POSIX 只证明原组，confined 仍固定 deny-fork。最终已接受的 dispatchAuthorization 快照在原 Store 派发事务之后交给 Job.start，只供可信宿主选择执行范围，不代替 grant、控制读集或取消。完整合同与当前 arm64 实测归 [Jobs owner](../../packages/agent/src/jobs/README.md#默认-macos-宿主-shell)和[Service](../../apps/service/README.md#默认-shell-装配)。冷读取/unknown不取得旧执行能力。

Linux 默认 Shell、Workspace Skill verifier 与严格补偿现经正式 Service 选择[原 PID namespace 源码后端](../../packages/agent/src/jobs/README.md#linux-宿主与严格补偿源码)。每个 Job 消费自身定义的最终 scope，verifier 保原 Skill cwd 和独立授权 Workspace；冷 closed v2 不恢复 native 控制，清理未知继续保原 resource／binding lease。Profile Skill 来源投影、macOS verifier 全树迁移和 Linux 原生资格尚未闭合，实际跨包保护及平台门禁归[执行边界](execution-boundary.md#当前-v13-边界)与[平台范围](execution-platform-support.md#当前-v13-执行与发行)。Core／HTTP 公共业务合同及资源观测门禁保持。

## 新终端候选边界

`release:terminal` 将六个新 workspace、实际 npm 图、固定 Bun 和全部宿主资产封存在独立候选，完整 manifest 身份交给 CLIServiceArtifact 与客户端准入。安装发布 current/previous 指针，已经运行的 CLI/TUI/Service 固定原 candidate；独立 daemon 的 artifact lease 不依赖启动 CLI 存活。归档、目录持久化、卸载白名单与平台限制由[终端 owner](../../apps/cli/docs/terminal-release.md)完整维护。制品锁不取得 Profile 或业务权限；unsigned SHA 只证明完整性，真实沙箱、发布者身份及旧正式入口退役仍须原有资格。

Service 与 CLI 现在共用 [runtime-assets](../../apps/service/src/runtime-assets.ts) 的唯一完整 tree verifier。trusted launcher 的私有 pipe 只传闭合 candidate root/manifest SHA/kind；实际 Service 独立取得 shared lease、核 build/entrypoint/executable 后才将全 closure 作为默认 Files 的保护范围，Model/JSONC/HTTP 不能提供该证明。Runtime、Workspace FD、readers/stream 全部确认关闭才释放，失败保持原资源与 listener。实际 public builder→default native paired/daemon、CLI 父退出后 live busy/stop 后 free 的 1/23 资格归 [Service owner](../../apps/service/README.md)；不能只从 parent wrapper 正常存活推定 child 已保护完整资产。

## 完整申请与事件观察

正式Native公共扩展由固定Main／IPC及原共享表单／PublicView消费，冻结当前完整准入与阅读选择，完整EOF后才可调用已读定义或原结果动作。通用Query与阅读不提交Command；刷新、关闭及切换撤销动作观察，保旧完整结果只读。动作沿原caller首次持久意图与一次热权利，未知和冷记录仅查原Command，generic caller.submit不能绕过扩展观察；受理与准确Execution终态分开。只在Native局部union接公共ExtensionCommandRequest，CLI／TUI原五类不扩大。首次保存惰性DB9，closed manifest v18收集原caller表；旧DB1–8／v2–v17语法保持，新Store不retag或重放。实施与格式分别归[Native](../../apps/desktop/README.md#native-公共扩展完整能力)、[maintenance](../../packages/agent/src/maintenance/README.md#desktop-db9-与-manifest-v18)，持续理由归[决定](../../.agents/notes/implemented/architecture/2026-10-09-native-public-extension-callers.md)；完整阶段与旧writer资格按原退出门禁核对。

普通 CLI/TUI 的原五类 Work/精确取消先在 host 的 `ui/caller-intents.json@1`，Native 则在 Node 私人 SQLite v3 中封存完整闭合请求、原 Store/Workspace/Session/subject、精确目标、规范摘要与独立草稿版本。各自 128 槽/16MiB，完整 Plan/Workflow/UTF-8/CRLF body 不裁剪、不以 draft 或 hash 替代；首次 POST 权利仅属于成功 durable prepare 的当前进程 hot intent，任何既有或冷记录都只按原 Command GET 核实，不能重授该内存权利。缺元数据、错完整 intent、坏文件或容量不足不获得补发权。applied/cancel_requested 分别表示命令受理或取消请求，不能冒充 Run/Job 完成。维护 v5 只验证结构与实际文件 proof，不代替 Service 回执、不重算业务权威或重标恢复后的原 scope。CLI 实际独立 argv/main/shared、TUI PTY 和 Native Node/Electron/main+Service 强杀/丢回复的证据各自归 [caller 决定](../../.agents/notes/implemented/architecture/2026-10-03-complete-caller-command-intents.md)，一种客户端的通过不替代另一种。

当前CLI/TUI的同一Caller文件另接四种固定普通Auth invoke，原完整身份、durable prepare、冷GET与容量合同继续适用；Native五类DTO和DB不扩展。实际Caller资产含Auth时选择closed维护v13，旧v2–v12请求grammar及物理白名单保持。认证复用既有CredentialVault/Broker与实际WorkspaceSerialLocks，效果不进新journal；当前Source/read-set用于新申请，历史只核原C/E与finalization。完整边界归[MCP认证](mcp-authentication.md)及[维护owner](../../packages/agent/src/maintenance/README.md)，此处不把Auth saved、connection ready和Tool许可合成一个结果。

原五类Native caller的DB3合同继续保留在当前DB5中；人类答案使用独立 `answer_intents`，不扩展五类DTO。首次POST前FULL提交完整原scope/subject/Interaction/请求与canonical SHA，冷Main只有原GET；accurate interaction.answer applied/answer_saved、原target/decision revision+1/subject/requestSHA才能确认。旧附件证明和授权不随journal恢复。维护closed v7只接准确DB5的整份一致SQLite，独立行验证和新Store恢复保旧字节/身份，旧v2–v6白名单不扩大，coverage.profileComplete:false/vault排除保持。实现、实际双Main与离线资产证据归[原答案决定](../../.agents/notes/implemented/architecture/2026-10-04-original-human-answer-intent-assets.md)、[Desktop](../../apps/desktop/README.md)和[维护owner](../../packages/agent/src/maintenance/README.md#原人类答案请求的独立离线资产)。

MCP 选择另用 CLI host 私有 `ui/mcp-selection-intents.json@1`，普通五类 caller/答案/Files 格式不扩展。首次 POST 仅由短锁内冲突/容量/完整身份核验和原子发布后的 hot prepare 授权；保存或冷列表均只恢复未知意图。原 GET 核 subject、Store、Command/request、准确 Execution 与原 HostMutation，不依赖当前目录或物理 Workspace；fresh 写入仍核当前 scope/read-set。维护 closed v8 仅为实际存在的新文件扩展准确资产字段与物理白名单，旧 v2–v7 原合同保留；独立 Agent codec 验完整字节和内部身份，不恢复热权利或重绑恢复后的新 Store。真实冷 Host、键盘与 PTY、离线字节/cold Node 的证据分别归[CLI owner](../../apps/cli/README.md#tui-mcp-目录与配置选择)和[维护 owner](../../packages/agent/src/maintenance/README.md#mcp-选择意图的独立离线资产)，不相互替代平台或完整管理资格。

会话日志由 Store 的原 mutation transaction 写入有限私有 metadata；status/time 属于发生时，cursor 决定顺序。既有 ChangeEvent payload/public SSE shape 保持，未来或坏 envelope 不泄露私有 wrapper。只读页固定 actual upper，精确 root creator/Session/Store 与 Decimal64 保留边界，最多 200/512KiB；无 payload、配置、凭据或 owner。Service 绑定 trusted source，Native/Browser 各核原身份，Web 仅按需读并保 stale。Model 导航只核实际原 input/ref 的绑定，仍需原 typed reader 独立确认，不产生 grant。实现与分层真实证据归[Core 日志](../../packages/agent/src/storage/sqlite/session-logs.README.md)、[Service](../../apps/service/README.md#只读会话运行日志)、[Client](../../packages/client/README.md#固定上界的会话日志读取)和[Web](../../apps/web/README.md#按需-runtime-logs)。

Files完整原字节原语由独立[checkpoint leaf](../../packages/agent/src/business/file-checkpoints/README.md)捕获原Tool/Model/Run选择、完整preimage和实际postimage，当前Store观察与原Source保持各自身份。Files rebuild封存完整业务时间线与有限来源，selected aliases决定目标资格，未selected后像只作连续性证明；v2 restore/effect ledger记录真实新inode或confirmed missing，旧v1只读不回填。准确failed Job与完整空ledger共同证明的零效果失败保为no-op证据，pending/partial/unknown继续拒绝；任何一次性批准都不复制。默认两层Fork、code恢复后更早点、A→B、same-S selector及Web闭合只读都有实际资格。独立Action的人类Ask与通用[group/context/record/projection最终SQL](../../packages/agent/src/storage/README.md)不承诺跨文件/两leg原子；CLI/TUI/Native三种范围与组合unknown持久caller仍按已确认设计实施。

通用 Action 的 prepare 固定原完整 contextRevision 与 scoped records/missing/list；用户 Ask 后只能重新核当前 quiescence，不替换原上下文和读集。final dispatch SQL 先核实际 root/descendants safety 再核原 context，carrier 在 dispatching/running/unknown 持续封闭新效果。adapter 的合法写入消耗原 absence 后不再将其当最终提交前条件，child 则独立核当前权限/来源/必要条件。真实竞态及独立 unseen extension 证明分别归 [Store owner](../../packages/agent/src/storage/README.md)和[取舍](../../.agents/notes/implemented/architecture/2026-10-03-guarded-actions-pin-original-context-and-group.md)，不推导所有外部 IO 可原子化。

runless 后代只沿有限真实 Execution/Command 链继承原 provenance；准确封存的权限检查可观察其 planned target，但不取得原 Action collector/guard 或目标派发权。旧 `authorization.review` child 只作历史兼容：guarded 原 pin 对这类旧记录只排除本 Action 已完成且无额外工作的纯用途私有上下文，新增或漂移工作使排除失效。新检查和旧历史都继续核完整执行组、原上下文与最终批准证明，不能以后来静止状态洗掉原上下文。完整条件与实际负例由上述 Store owner 维护。

大权限检查输出的批准事实来自原完整 ModelOutput，Core 在同一 captured descriptor 验 EOF 后发布原 Model scope 的有限不可变答案凭据；final SQL 核完整 descriptor 摘要、该凭据登记、原请求与完成结果 digest 及准确目标绑定。小内联结果同样绑定原输入、成功 stop、空工具和完整原正文；未知或无效决定不能授权。旧审核 carrier／唯一 child Model 的 scope 与闭包证明仍按原格式只读核实，不迁造为新检查。私有 head 不进入公共 DTO，preview 不作为全文答案；冷只读不重新读 graph 或启动模型，独立人工 Ask 仍需原证明。跨包边界与实际负例归[输出 owner](../../packages/agent/src/model-output/README.md)及[Store owner](../../packages/agent/src/storage/README.md)。

## MCP 原 metadata 的跨包读取

只读详情由 Agent 的 `mcp.server.status` 提供准确原 connection Job、当前 holder／代次及已读取的能力数量；未知或代次不符保持 null，不发远端 list／connect。Service 的 `mcp.server.locations` 只按当前完整 Source/read-set 交付固定真实配置位置和摘要，不读取秘密或解释权限。CLI 完整分页读取 live catalogue，并核相同 Scope、来源、游标与唯一 key 后才发布；UI 只消费这些有限显示事实，详情不进入配置 CAS 或授权依据。具体字段和证据归 [Agent MCP](../../packages/agent/src/mcp/README.md)与[Service](../../apps/service/README.md)。

MCP adapter 同步 frozen metadata getter与原可执行 catalogue共享同一代次。真实connect/refresh Tool或Action保存准确原SDK Tool到自身publisher scope immutable chunks/manifest/pages/root，Worker只保有限pointer；Query封存原record/generation/indexDigest，不连接、发现、读vault或派发。publisher已保存结果与source value全等，原connection command/parent/inputDigest和新source key分别绑定，Artifact再核原scope/hash/size。不是以sourceRecordKey单独证明writer，也不重构私有bootstrap Job正文。

公共Client闭合32KiB Query并一次manifest后逐块核完整EOF/size/SHA、fatal UTF-8/JSON/schema，完整SDK字段及省略保留；currentStore负责admission，旧originStore负责Artifactmetadata，恢复不重标来源或恢复grant。TUI/CLI只接该公共Query/reader，以原Session/Workspace/read generation+ownAbort隔离迟到，页面/长字段不裁成complete前缀，metadata查看零业务POST/cancel。当前两Query使用现有整组安全观察器作主体准入；累计已完成Session/Message/Part完整流式核实，实际活跃或未确认安全域仍有界，不以截断历史授予读取。owner与有限实际证据见[MCP](../../packages/agent/src/mcp/README.md)、[Client](../../packages/client/README.md)、[TUI](../../packages/ui/src/tui/README.md)和[CLI](../../apps/cli/README.md#tui-mcp-目录与配置选择)。

## MCP 原连接申请与当前 live

显式连接仍是普通 `builtin.mcp/mcp.connect@1` 与实际独立connection Job，不因配置available、Command accepted或历史ready获得执行许可。有限 `mcp.connection@1` 沿当前Store/Session/subject的整组安全准入，只核准确原Action、operation Job与parent；原活跃/未确认安全域及Worker/result上限保持，累计完成历史不承担8192门槛。Action kind=job、namespaced definition与实际bare Job definition分别核版本、inputDigest、origin/ref/root-work。16KiB Display只投有限身份、phase、原ready和当前live/currentGeneration/created，warm复用保原Job，holder unavailable投null generation而保原ready，detached失败不宣称零效果。

UI只持可选connection port和原读取代次；Host用公开完整Workspace目录、实际canonical identity和原完整observed核新申请。独立 `ui/mcp-connection-intents.json@1` 只在durable prepare成功的热调用允许首次POST；冷或既有intent只原GET，Store+Session+Server未知冲突不借新key绕过。subject/Store不等在HTTP前拒绝，关闭/切scope只abort所属reader，晚到结果归原intent但不覆盖后来选择。maintenance v9保原资产bytes/身份/phase，旧v8闭合格式不扩，不恢复热权限。实际Query、Host、A→B原GET前拒绝、普通审批与源码外TUI范围见[Agent](../../packages/agent/src/mcp/README.md#原连接申请的有限事实)、[CLI](../../apps/cli/README.md#tui-mcp-显式连接与原申请)、[UI](../../packages/ui/src/tui/README.md#mcp-显式连接与原申请)和[maintenance](../../packages/agent/src/maintenance/README.md#mcp-连接申请的独立离线资产)。

## 未提交普通 Action 与同 owner 重调度

准确原Action的最终结果提交失败时，Command.applied只保原受理事实。Runtime每个accepted普通Command前由Store短事务观察原receipt主Execution仍planned/dispatching/running的真实身份，停止本Session普通派发并保accepted请求；重复同instance owner与后台onActivity不绕过。该观察不恢复owner、补result或重派原effect，不把合法detached Job当未提交Action，也不改变已持久terminal outcome_unknown的原恢复边界。原GET和owned关闭继续，合同与[真实故障测试](../../packages/agent/test/isolated/execution/action-result-boundary.test.ts)由[Store owner](../../packages/agent/src/storage/README.md#未提交普通-action-的串行边界)维护。

已登记根 Session 的合法 hot detached operation 持有原 owner 时，空命令列表继续保留有限 intake轮询；peer新接纳的同根Session Action仍由原 pump核上述守卫，再返回实际子操作引用。资源等待只延迟 Job启动，不借 intake推进放宽permit、generation或cold恢复。实现、确定性空轮询/peer顺序与本机实际Shell资格由[Runtime owner](../../packages/agent/README.md)维护，跨 child Session未据此取得新资格。

第八/九/十一轮与首次有限诊断曾在原30s用例期限内超时，需精确监督本次owned child退出。两条真实fixture改为直接await同一个原五秒waiter、再断言实际wait_timeout后通过，正常SQLite回复与owned close均确认；Runtime/SQLite生产、业务断言和期限保持。这个对照限定在两条fixture的pending Promise匹配入口，纯timer和Worker对照未复现，底层原因仍未知。真实失败、监督清理边界和复验保在总体进度。

## 当前发布与资格工具

根 `agent/tui/prod:tui` 固定完整新 Terminal，`desktop` 固定完整 Native，`server` 显式复用新默认 daemon/Web。八 workspace 的 build/typecheck 与统一默认计划共用同一发现源；root 仅有限脚本安全测试及新公开制品场景。静态守卫检查 root/workspace scripts、递归 aliases、CI run 与实际 import 闭包，包含四个标准/Native CLI/TUI entry；计算模块的 fixture 仍记 pending，不把静态检查当运行资格。

Terminal 与 Native 分别固定真实 Bun/Node SQLite，包内 selection 在 Store/maintenance/Worker 开库前生效；损坏选定资产不回退开发库。Windows ordinary Workspace 配置与 private Profile/协调/数据库角色分开，既有 ACL 不自动修复；实际 native Windows 仍待 CI 证据。三平台 workflow 保原检查名称、固定 Bun/action、源 head 与 clean-source 约束。平台诊断、bounded soak 和源码外制品通过均不等于完整 Shell/confinement、正式 soak 或发布者认证；formal verifier 保持拒绝缺资格。当前边界见[release control](release-control.md)、[Terminal owner](../../apps/cli/docs/terminal-release.md)与[Native owner](../../apps/desktop/docs/native-release.md)。


Native Provider/Model 的完整设置消费者由 Main 冻结原观察，热秘密只传一次公共 Provider POST；原非秘密申请先落 Desktop DB6，再允许本次提交，冷记录只显式原 GET。Service/Core composite marker 固定原 readSet/operation/身份，vault保存与JSONC发布分别保留已知/未知结果；stored-unpublished 的原 revoke handle 只向认证SDK开放，renderer不获该authority。新模型disabled，其他连接保留，完整目录不按512项裁切。输入区每Session的下一次model/页面临时effort经真实HTTP原命令进入冻结root快照和实际wire，active steer保持文本语义、child自选preset。Profile无三项raw MCP文件时DB6离线资产用专属manifest14，旧版本grammar不扩大，详见[Service owner](../../apps/service/README.md#native-provider-与下一次模型绑定)、[维护 owner](../../packages/agent/src/maintenance/README.md#desktop-db6-与-manifest-v14)。macOS默认OSvault/受控loopback真实Native窗口已验，尚不外推生产远端、MCP窗口或其他平台。


Native MCP 的 renderer通过固定IPC提交有限参数，Main固定真实观察、完整Source read-set和原Store/subject/Session/Workspace身份。来源、认证、连接与Tool授权分别核实；原非秘密申请在第一次POST前FULL保存，冷/foreign只读不重发，迟到GET不能把已确认终态降级。Profile无三项raw MCP文件时DB7使用manifest15，独立codec和原字节上界归[maintenance](../../packages/agent/src/maintenance/README.md#desktop-db7-与-manifest-v15)；实际任一raw文件存在则优先使用[manifest16](../../packages/agent/src/maintenance/README.md#profile-mcp-配置资产与-manifest-v16)，保原声明、决定、引用与UI资产，恢复后的来源准入仍核当前Store和物理scope。UI保存的意图不成为Core或Host权威。可信loopback/公开证书测试装配须在制品构建前固定并入摘要，不进入普通配置/环境，不放宽默认浏览器、Vault或权限。


终端原 Ink UI 在 `packages/ui/src/tui/ink` 保留纯展示算法，正式／开发宿主均只消费新 Client 事实。只读 planning progress、compression phase、Tool call/input、Files 文本预览与 point 日志时间补齐原界面所需来源；不引入 UI 权限规则、旧 Runtime、第二 Store 或派发 fallback。Source 与完整性仍由 Agent／Service／Client 核实，UI 聚合不授予执行或恢复资格。实现与验证范围归 [TUI owner](../../packages/ui/src/tui/README.md#原-ink-展示与明确测试诊断)。

`SessionView.session` 的可选 owner 实例／generation 来自同一原 Store 视图，普通 Session DTO 不扩。Host 绑定当前已认证 Service 实例供 UI 限定活动显示；不同 owner 只表示当前连接无法核实，原任务仍可能在另一执行者运行，不证明死亡或终态，不产生恢复、取消或派发权。缺字段旧消费者保原观察合同，当前正式消费者沿同源 Client decoder 使用事实；同 Scope 的历史／完整正文与原未知状态保持，见 [Service](../../apps/service/README.md#终端展示的新增只读字段)、[Client](../../packages/client/README.md#模型尝试与原工作身份)和上述 TUI owner。

## 三项 token 口径

Core 分离累计实际用量、最近请求实际输入与下一请求上下文预测。新增只读 Store usage 聚合只取本 Store／Session 原 Model 终态，覆盖缺失保留未知，读取不写入；不受有限 View 截断。跨包 `CompressionInput` 传实际工具及经 scope／路由核验的测量基线；纯投影在原输入被改写、移除或换工具时全量回退。已测输入与新增估算不会伪装成新的 Provider 统计或派发资格。Service、Client 与 TUI 的只读预测保准确原请求和 selection/upper，不捕获新来源、不初始化模型。完整接口与验证归[Core owner](../../packages/agent/src/context-estimate.README.md)。

Native普通输入区可经已有Tool Message read lease读取该预测的有限数值，入口为 toolMessages.contextUsage：只接一个当前已观察的完整原助手Message ID，核Store／Session／Run／Model、正文和当前context selection，响应只含模型及输入／窗口数字；切换、历史重置或退出取消所属读取，不开放测试Context正文面板或任何写权限。圆环按当前输入估算除以完整窗口绘制，不使用缓存命中率、累计输入或API的可用输入预算比例；模型切换和未知容量不能继承旧窗口。Main与Renderer边界及验证归[Native owner](../../apps/desktop/README.md#输入区上下文占用)。

## Desktop 本地定时任务

Desktop Main在应用存续期内触发本地定时任务，调度元数据属desktop-private DB10／closed manifest19；Agent业务执行仍只由普通Session创建与run.start拥有。每次新Session，运行前持久稳定原身份与完整快照，未知及冷恢复只查询原申请，不恢复POST权利；新Store不retag原任务，也不自动重放。权限、审批、Agent baseline与schema保持。精确实现和验证归[Desktop owner](../../apps/desktop/README.md#native-安排任务草稿)与[maintenance DB10合同](../../packages/agent/src/maintenance/README.md#desktop-db10-与-manifest-v19)。


### 显式模型协议与私有 continuation

默认宿主的 OpenAI/compatible 连接可显式选择 Responses；旧配置缺省仍为 Chat Completions。协议冻结在实际 Run 绑定与公开非秘密 metadata 中；定时任务继续复用同一选择和 Agent Loop，不另建模型执行器。Responses 由官方 SDK 传输，单次零内部重试、`store:false`，错误不回退其他协议。

加密推理状态与 SDK assistant parts 只作为不透明 continuation，沿已有私有 ModelOutput Artifact 链保存、恢复并传回匹配的 endpoint/provider/model/账户/header/路由绑定；它不授予工具执行权限，也不作为用户可见消息或 Inspector 正文。取消、流异常、截断工具批次及未完成压缩不提交可重放状态；非空纯文本 length 仍按长任务续接保存原文本段与其私有 continuation，由下一 Model Execution 继续。技术契约与测试见 [AI owner](../../packages/ai/README.md) 和 [ModelOutput owner](../../packages/agent/src/model-output/README.md)。

纯文本 length 后的可重试失败重新准备当前来源时，不得丢失原 Loop 续写指令或复用过期全量请求。临时尾项只在同原 Store/Run/工作/Command 的成功 length 输出与新历史唯一原正文核对后恢复，不增加权限。若当前已发布摘要准确覆盖原正文，则核同 selection 覆盖上界与原输出证明后退役尾项，只用新摘要，不回灌旧历史；错属或无法核对时拒绝继续。具体实现和回归归 [Agent owner](../../packages/agent/README.md)。

活动 Run 目录的 `executionOwner: held/unheld/unknown` 仍是只读锁观察，SQL 与锁观察各有时点；GET/SSE 不写状态。Native 选中或重连、TUI 明确选中和 CLI 继续已有会话时，独立调用受 capability 控制的会话核实接口；TUI 观察流重连只读校准，不重复核实写入。Core 按原 Store、主体、root、generation 复核整组并取得准确原 OS 排他锁后，原子 fence 并保存 owner 丢失状态：活动 Run 中断，已尝试 Model 失败，Tool／Job 效果不明保 unknown，原未派发工作和未被接纳的交互结束等待。已完成结果、答案与 accepted decision 保持。私有 checkpoint 保原安全恢复边界，公开读只见结算状态；显式接续仍须完整资格核验，核实本身零派发。普通新任务和后续输入也在 Runtime 中先校验准确原请求，再自动走相同核实与历史闭合；已落定回执不触发额外生命周期写入。客户端的可恢复读取和原申请查询在后台退避重试，不在会话消息外追加异常文字或临时核对操作；失败或证据不足保留原消息及后端准入限制，未知效果不成为成功或清理证明。完整协议与维护规则归[恢复 owner](../../packages/agent/src/storage/sqlite/run-resume.README.md#会话恢复时的状态核实)，取舍见[决定](../../.agents/notes/implemented/architecture/2026-10-22-session-state-reconciliation.md)。

配套 Service 的普通 launcher close 等待原 child 的真实 drain／退出；取消、原 Run／Execution／Job 终态与 owned 资源关闭先于成功退出，不再默认5秒强杀。SIGINT／SIGTERM 与父 EOF 汇入相同收尾；启动读取可取消，已开始的装配仍保到其真实关闭。明确 hard timeout／强退及准入失败回收只触及本次 child，不能提供终态或清理证明。Native Main 的信号／父通道事件与菜单异步决定按同一停止意图串行，不允许迟到“保留服务”撤销已开始的 drain。实际边界与回归归[Service owner](../../apps/service/README.md)、[Native owner](../../apps/desktop/README.md#原窗口关闭与退出收尾)和[正常退出决定](../../.agents/notes/implemented/bug-fix/2026-10-21-paired-graceful-exit.md)。

桌面Markdown扩展属于[UI派生展示](../../packages/ui/README.md#markdown-消息内容)：Native Worker只复用纯GFM／公式语法，renderer负责KaTeX排版、代码高亮及受限Mermaid绘图，不取得网络、文件或业务IPC权限。图表使用本地库、strict模式及SVG image，不挂载生成事件或放宽CSP；错误／超限保留原文。消息内标题／脚注跳转仅命中当前消息，图表暂停、缓存记账和窗口隐藏沿原Activity资源边界；完整正文身份、复制资格与业务恢复仍由原owner核验。
