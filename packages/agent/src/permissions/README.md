# 权限策略与 Shell 授权

2026-11-07 先前单次执行确认差量：[确认](../../test/isolated/execution/execution-confirmation.test.ts)、[嵌套委托](../../test/isolated/extensions/nested-actions.test.ts)、[Auto等待](../../test/isolated/execution/auto-policy-waits.test.ts)、[计时](../../test/isolated/execution/authorization-timing.test.ts)及[运行中模式](../../test/isolated/execution/live-permission-mode.test.ts)五个整文件57项／405断言通过。默认 FileRestore 与信息回归25项／316断言通过；最后仅排队 Job 的成功父状态与 ToolContext 祖先事实透传变化，不进入 FileRestore 自身 Action 的证明分支，按差量复用其1项／80断言。证据核三模式 owner 人批、独立策略不支持时零卡、有限步骤及一次消费、跨 scope 拒借、取消、硬拒绝、原 SQL 篡改、真实单槽排队与两层持槽 failfast。不新增表、Store 方法、执行循环或版本。

统一新版授权使用[工具行为注册](../tool-behavior.ts)、[结构化范围合同](../permission-grants.ts)和通用审核回执；当前接纳、消费与撤销合同归[grant owner](../storage/sqlite/permission-grants.README.md)，用户行为归[授权手册](../../../../docs/handbook/features/tools-and-approvals.md)。Shell、Files、Worktree 的领域范围由工具 owner 提供，权限、Interaction 和通用 SQL 不根据工具名计算范围。

`createPermissionPolicy` 先读取并校验本次 policy，再将隔离副本作为可选第二参数传给 `describeCapability`；旧单参描述器兼容。描述器据此判断当前模式，不二次读取宿主偏好，修改副本也不能改变本次模式、能力集合、信任或 controlReads。Planning 审批前只做无模式的能力分类，该元数据读取不生成领域范围候选。业务条件由 Planning owner 提供，`createBusinessPermissionPolicy` 只组合 `current` 与 `gate`；批准不产生模式 ceiling。范围候选直接合成原真实权限参与方的全部稳定策略绑定，不另构造一份随后丢弃的完整权限决定；已经 allowed 的参与方和独立 checker 仍保留。接口与回归见[策略](index.ts)、[约束](constraints.ts)、[副本隔离测试](../../test/isolated/permissions/policy.test.ts)和[业务门禁组合测试](../../test/isolated/permissions/constraints.test.ts)。

Shell 的模型启动入口统一为 `shell_execute`，顶层 filesystem/network 由[共享输入解析](../shell-input.ts)解释为独立请求，省略默认工作区写入／离线；原 Job 仍使用既有 command/permissions 合同。新 description 只用于展示，从风险模型输入移除，命令摘要与批准复用不使用它；完整原 Tool 输入及派发完整性摘要不删字段。前后台使用同一路径，background:true 纳入执行语义摘要，默认前台与旧 shell.launch 摘要保持原算法。运行时派生 key 不参与命令权限摘要，新调用仍有独立执行身份。工具集合、父子交集、最终范围、硬限制及超时规则保持。

默认 `explore` 的只读要求由可信任务指导和收窄工具集合表达，允许原权限内必要的临时脚本和探索产物，保持业务源码、配置和数据不变。当前版本同身份续作和冷恢复仍核原冻结指导与工具。Shell 继承父会话当前模式、权限交集和普通沙箱，不增加角色专属命令表或 OS 禁写。有限 safeRead 只决定普通策略免审，不等于角色允许列表。新默认 Auto 只审 Shell 高危效果，不核任务合规；请求批准和 Full 沿各自普通策略，原 Planning 业务门禁、硬拒绝和最终派发证明保持。

[Task 分类](task-request.ts)只细化当前准确可信角色，默认目录为 `general／explore`；不为升级前旧角色或退役 carrier 提供后备分类。Service 的[权限装配](../../../../apps/service/src/permission-configuration.ts)使用当前注册定义，完整父子 Tool／Job 身份、当前 mode／trust／allowlist 与最终派发证明保持独立核验。当前版本续作和冷恢复仍核真实 carrier 与冻结配置，历史记录或同名角色不授予执行资格；默认装配与验证范围归 [Service owner](../../../../apps/service/README.md)。

实际工具定义对象与准确 kind/id/version 绑定可信行为，由宿主静态装配。行为选择 `autoReview:check/none`，可提供 `prepareReview/interpretReview`、有限 grant 候选和准确自身 Job 的证明；Run 封存 contractRef/configurationDigest，不序列化回调。`authorizeChild` 由实际父 Tool 的登记行为选择；Worktree owner 核完整已封存决策后调用原窄 Store 证明桥，Interaction 不再按 Shell Job 名选择领域算法，无登记时仍走原普通审批。硬拒绝、真实注册、工作区信任和独立人工 ceiling 仍先行；缺少可选行为沿普通单次或显式自定义 checker 合同处理。普通 Extension/MCP 描述、配置文本与模型输入不能登记可信规则。

可信行为还可声明 `executionConfirmation`：原 Execution 在 planned、未取得资源时发布一次 owner 人卡，准确绑定原调用及最多16个封闭内部 Job。`Permissions.consumesExecutionConfirmation` 仅消费本方软挑战；默认策略和业务／AND／父子组合逐方核实。原本 allowed 仍需 owner 人答；硬拒绝不建卡，未支持的独立挑战在建卡前失败，内部新增不支持条件也不发第二张卡。批准后跳过本次重复人卡／默认 reviewer，不建立 grant。准确证明及一次消费由[最终 SQL](../storage/sqlite/interaction-operations.ts)重核，信息回执不进入此路径。真实 FileRestore owner 由[Service](../../../../apps/service/src/file-checkpoint-configuration.ts)注册，通用 constraints 不再按恢复工具名称强制审批。

AND 与真实子 Agent 组合按本次返回的完整 `PermissionDecision` 对象保存各原策略决定，供本方消费 hook 核验；不以可选、可能复用的 `snapshot` 对象充当来源键。没有 snapshot 的合法策略仍可消费自己的挑战；并发授权复用 snapshot 也不能覆盖另一调用的独立 checker。聚合与封存仍使用原隔离副本，传给 hook 的是其原策略决定。[策略交错](../../test/isolated/permissions/grant-policy.test.ts)、[真实并发调用](../../test/isolated/execution/confirmation-policy-interleaving.test.ts)及[真实子 Agent](../../test/isolated/child/execution-confirmation.test.ts)覆盖这条边界。

确认声明只在当前策略未硬拒绝时准备；已接纳的人答事实在同一活跃 Execution 的资源排队与模式刷新中保留，不再次调用 owner 声明。每次派发仍重新读取当前策略、逐方核挑战并核原卡和实际展示材料，不能把这项事实当成缓存权限。2026-11-07 本轮 apply 审查后的九个相关整文件97项／1022断言通过，覆盖硬拒绝时零声明、同次声明变化、真实单槽排队时切换模式及有限 Job；当前真实模型资格另归[模型验证](../../../../tests/e2e/live/model/README.md#计划业务人答与当前工具权限)。

[Shell 事实](shell-risk-facts.ts)复用原字面 argv 解析；仅匹配实际冻结 bundled rg 身份、已支持参数及可核实环境时输出 option/value 消费关系、独立终止符与配置的 preprocessor。未知语法、同名程序和 ambient 配置保持 unavailable，保完整 raw 命令，不推成无 hook。直接入口仅从工作区严格普通文件读取、受原保护路径约束，单入口最多64KiB；外部、链接、超限或无法读取的正文明确缺失。语法事实不读取脚本危险程度，同 argv 的低危／高危脚本事实相同；正文 hash 另参与 fingerprint。输入不递归扫描依赖，也不为取证执行命令。

[风险合同](../shell-risk-review.ts)只接收完整 operation、实际 cwd／scope 和 material，不读取任务／计划／委派／历史模型窗口。模型严格输出 risk／reason，Shell owner 的可信解释器映射 ordinary→approve_once、high→ask_user、critical→reject，原始风险文本与派生决定分别保真。已识别的私钥、认证 token、密码或会话凭据外发优先归 critical，不能落入 high 的非凭据私有数据上传；公钥不等于私密凭据。只有缺少未知程序正文而没有其他具体高危迹象时为 ordinary；已知删除目标或外发载荷的重要不确定性为 high。已识别的本地文件外发在缺少载荷正文且没有非敏感证据时仍属载荷未核明，不要求另证私密性质；这不等于只有未知程序正文、且未识别外发效果的 ordinary 例外。普通本地窄写、接收 GET 及能力上限标签本身不构成高危。critical 不能借人工 interaction 绕过。输入准备、JSON／finish、完整输出和材料绑定失败分别保原技术错误，不冒充风险拒绝。

Auto 材料指纹进入原 operation key 和批准证据。脚本正文完整不证明动态依赖完整，因此脚本及其他未确定程序不扩大跨独立调用缓存；当前准确 Tool→自身 Job 仍可沿实际模型／人工／有效 grant 依据避免重复审核。grant 只在新默认 Auto 的准确父链及当前有效授权下继承，不改变手动模式原分层合同。Job 启动仅对真实材料批准标记及本 Job 已捕获入口做 hash／对象身份复核，变化在启动前失败；该检查不能消除最终 OS 打开前所有竞态。timeout 及其自身 Job 继承不伪造材料批准，不增加超时专属范围或该材料限制。

AND 合成后若领域解释器未被共同选择，沿独立 generic checker 的合同检查；注册工具原有领域材料限制仍保留，不能因此取得跨调用 `reused_approval` 资格。准确 Auto 父链与明确超时继续按各自原证明核验，不用风险解释器替代独立 checker。

会话文件不放开整个 Profile。[输入文件适配器](../tools/input-files.ts)仅允许所选消息引用的准确原件读取；[输出适配器](../tools/session-outputs.ts)仅允许当前会话的登记文件或准确输出目录中的 create-only 新文件；[方案适配器](../tools/plan-files.ts)只接受 Planning 当前登记的准确目标。各适配器在原授权与派发链核全部父子 policy leaves、能力定义／版本、原输入及目标 revision，仍保真实工作区信任、取消和 native 身份核验。Plan 模式的草稿写例外仅限可信宿主识别的当前方案目的；普通项目／输出写入不享受例外，文件存在和 Markdown 中的“已批准”也不授执行权。

有效 Full 下，原 `write_file`／`edit_file` 可直接操作普通外部绝对目标。[Full 文件适配器](../tools/full-access-files.ts)将其描述为 external 效果，并在执行时核最终接纳证明的全部权限叶：Full、Workspace 信任、准确 Tool 能力和本次目标 revision 缺一不可。父子权限／Planning 业务门禁、实际工具集合、Profile／运行资产保护及原生 no-follow、owner、CAS 检查保持；准备后目标绑定变化拒绝，发布后无法确认仍为 unknown，不重放。Full 对可安全编辑的外部读取返回完整 baseline，其他可读目标继续只读；baseline 不签发写权限，外部文件不纳入 Workspace checkpoint。适配与故障回归见[外部 Files 测试](../../test/isolated/files/full-access-files.test.ts)。

默认产品策略声明可信 `toolDispatchOrder: model`，由 Agent 冻结为 Run 的批次准入顺序；审批等待不能让后续免审工具提前派发，人工明确拒绝取消真实未开始兄弟。实际 dispatch 后仍可并发执行；子权限与 planning 包装保该标记，Service 只透传装配，自定义 Permissions 未声明时保通用独立并行能力。拒绝、未知结果和已知参数／策略失败各保准确终态，在原批次结算后交回下一 Model，不能把局部止效当成用户取消 Run。

准确注册的builtin.browser@1操作由可信[builtinCapability](capabilities.ts)提供approvalExempt标记，policy再次核固定Tool／Job／Action定义与版本；三种模式均不生成check或approval。真实network／process／unknown／input效果保留，allowed注册、hardAllowed、工作区信任和现有硬约束仍先核，任意前缀、伪造扩展或未来版本不能借此免审。Service的实际Tool／Job及Workflow投影也保该标记和minimumApproval:none，不用伪装read复用审核。页面／任务／控制代次、取消与未知不重放继续在原派发链核实。

已配置审核器的空／无效答案或传输失败保存为原check失败。InteractionGate在准确绑定核对后将不可用结果结算为未派发的执行技术失败，Tool、Action 与 Job 均返回可读原因，交给原调用者，不生成额外审批；Tool 结果继续交给下一 Model。有效ask_user、明确reject和真正未配置审核器的既有fallback分别处理。浏览器本身不调用该审核器。

产品 Auto 策略默认给正常已注册、选中且通过硬权限检查的调用设置超时继续合同，不按工具名称另设放行名单。审核超时默认放行语义审核，由工具原有执行策略兜底；Shell 的文件和网络请求仍逐维取原父子／宿主上限交集，不额外收窄超时范围。未显式请求仍为 `workspace_write/none`，显式 `full_access/internet` 可在原策略下执行。准确记录 `timeout_continue`，不伪造模型批准，也不缓存为批准；独立人工、硬拒绝、保护资源、取消和未知效果限制保持。自定义 Permissions 明确只要求检查、未声明超时继续时，Core 不推断它具有产品 Auto 的默认放行语义。仅靠模型和语义审核表达的业务要求不因此取得沙箱保证。

[交集选项](auto-check.ts)按有限范围字段比较超时继续能力，不按 JSON 属性顺序区分相同范围；任一策略缺省或范围不同仍不继承。配置和 Runtime 宿主绑定共用[审核期限上限](../execution/authorization-timing.ts)，在启动审核前拒绝定时器无法兑现的期限，实际范围见[配置手册](../../../../docs/handbook/features/models-and-configuration.md#生效与限制)。

已拒绝的准确原调用不能通过迟到输出或其超时变成批准；本次不引入跨工具业务效果等价的硬拒绝索引。新调用的超时继续可能执行与先前语义拒绝类似的效果，原拒绝记录仍保留，模型仍不得借换工具绕过拒绝。Cache 的拒绝上下文只负责失效旧批准，不等于新增任务级 deny；这些语义规则不能误称为工具沙箱已强制保证。

新审核请求由 Runtime 在封存前加入独立 system 指引，[authorization-check-feedback](../execution/authorization-check-feedback.ts)明确区分技术失败和真实拒绝：原用户请求是任务范围证据，不能覆盖现行 policy；先前 checker 不可用、缺少先前批准和失败次数不能单独成为 reject／ask_user 的依据。后续准确调用独立审核，真实用户或策略拒绝仍须遵守。技术失败正文说明未执行、未形成批准或拒绝以及已知原因；details.authorizationCheck 保存准确检查 executionId 和有限 failureCode，只映射已知 Core 错误，不复制私有 adapter 消息或不完整输出。已封存检查的原请求、instructions、摘要、输出和结果不改写，冷读取不重新审核。[主回归](../../test/isolated/execution/authorization-check.test.ts)核技术失败后独立批准／拒绝、嵌套 Job 的同类失败、零未授权效果和 Loop 正常完成；[反馈回归](../../test/isolated/execution/authorization-check-feedback.test.ts)核私有正文与未知错误码不外泄。受控模型测试核实请求和执行边界，不保证任意真实模型始终作出正确语义判断。

显式自定义任务授权的 `reviewInput:task_authorization` 合同启用[新审核输入投影](../authorization-check-input.ts)。[SQL材料构造](../storage/sqlite/authorization-check-context.ts)从准确任务和实际祖先链的已生效输入保留原任务、纠正与委派原文，按冻结Run读取角色指导，提供计划正文、准确拒绝及同一操作的有限执行事实；不能按消息role猜用户授权，也不依赖当前压缩窗口。可信`actor`明确当前Session、所属业务Run及root／parent关系；每条原输入的`recipientRelation`只标收到该输入的主体相对当前执行者的位置。内部Job沿原已核父链回溯业务Run，不凭空生成Run归属。可信审核指导按原文语义区分父级局部、child和全体参与者限制：关系标签不授予权限，同一用户明确委派给child的操作不因父级局部禁令被误判；父专属授权不能借给child，委派不能扩大用户授权，统一禁令、只读、角色和硬策略仍适用。业务完整messages、助手计划、无关工具输出与重复任务不再送入该模型。完整原payload、decision source和原模型输入仍封存并参与绑定；新版封存后只读原输入，不用当前规则重解释，自定义无此host合同的审核保留原材料。root与当前业务起始输入必须均可核实，后台报告回溯原业务输入；材料不完整时回原完整窗口，不假称完整。执行事实列表不是全任务业务效果索引，缺项不证明未执行；原autoContext、取消、权限及最终派发核验保持。此关系说明不进入独立Shell风险最小材料，不增加历史读取分支。

模型可见投影以 `policy.appliesToExecutionId` 绑定当前准确目标，父子约束以 `contributions[].contributor/constraints` 表达策略来源，避免把原 `scope:parent` 误读为父执行者。实际执行者仍取可信 `authorizationContext.actor`，原任务、纠正、委派与范围说明完整保留；不从自然语言生成额外的已授权标记。原 `request.policies[].scope`、完整 revision 和控制读集继续封存，实际父子交集、硬拒绝与最终派发仍由程序核验。owner 自备审核材料原样透传，材料不完整的自定义 checker 保留原窗口；投影不新增读取、模型调用、排队或等待。通用指引只判当前操作的授权与效果，不把未交付完的业务产物自动变成审批前置，用户明确内容限制和写入条件仍适用。显式自定义 checker 仍需通用指引中的 Shell 能力与语法说明，不能因默认 Shell 已使用独立风险合同而直接删除；真实模型差量与失败样本归[模型验证](../../../../tests/e2e/live/model/README.md#当前-v1-扩展验证8秒默认)。

人工拒绝从已核绑定的 `answered/deny`、原失败的 `approval_denied` 与未派发事实识别，不要求仅用于消费批准的 `accepted` 标记。待答、取消、效果未知、已派发或绑定不匹配的记录不冒充拒绝。此材料仍只服务显式自定义任务授权审核，不加入默认 Shell 风险模型的业务上下文。

显式自定义任务授权合同的[相关读取材料](../storage/sqlite/authorization-check-reads.ts)只选择当前Session、同任务、准确内置Files读结果，且路径须被原任务或当前操作字面引用；保最新已读baseline及其真实分页，不按文件正文递归扩候选。选择首次封存时已完成的读取，不以执行意图的创建次序代替完成次序；内置Shell冻结的工作区实际根可对应原工作区相对路径，未知cwd不推导同根。原选段Artifact复用既有subject／scope／完整性校验，展开后走原request body封存。同一原检查的读取与先前效果观察保持首次封存快照，后续读取或效果结算不重开审核；任务、来源、现行权限与准确目标仍严格核验。无法重建新版绑定时明确恢复失败，不推断旧缺省值。材料是低信任历史数据，不是当前磁盘状态、当前Model接收证明或新授权；Shell stdout、无baseline外部读与不兼容附件不自动补入。

system要求 `reason` 一句、最多30词，Shell 输出为 `risk/reason` 并由工具解释器派生通用决定，显式自定义 checker 的默认格式为 `decision/reason`，不为长度新增评分或批准值。模型接口硬上限由Service按实际支持装配；Core将真实 `finishReason:length` 保存为 `authorization_check_output_limit`，即使已有完整批准JSON仍不生成批准，准确技术原因交原调用及下一Model。该技术失败不冒充超时默认放行或明确拒绝。

内部审核与普通模型调用一致，仅保留 SDK 已去敏的 `ModelAttemptError` 三类固定原因：服务不可用、连接失败和流不完整。准确原因从原 checker 结果进入 Tool 的可读正文和 `failureCode`，再以原 call／source 身份完整交给下一模型，不再统一降成 `model_failed`。任意私有异常及伪造 name／message 仍使用通用失败，不复制 cause、Provider 正文或凭据；此修复不增加审核重试或人工审批。主回归的真实 SDK／内存 HTTP200 `response.failed` 整链用例核上述传播、单次请求与零效果，三类受控失败和伪造负例另核原正文完整保留；模型呈现同时补上 Core 已核未派发及本次 Tool 无作用事实，避免把已知未执行误述为效果未知。

显式自定义任务授权合同 system 指引明确 Shell 的 `executionScope` 是进程可用能力上限，`workspace_write/none` 是默认且最小范围，参数没有 `read_only`；普通 Shell 的 `process/unknown/record_write` 是保守能力标签，不能单独证明命令实际修改工作区。与任务一致的只读复合查询不能仅因默认范围、这些标签、`&&` 或管道而被拒绝或转人工。审核仍检查完整命令、重定向、替换、执行 hooks、脚本、目标及传出数据；真实越权写入、破坏、泄露和额外 `full_access/internet` 请求继续按任务与现行策略处理。只读免审由 [shell-search](shell-search.ts) 共用解析／重写结果识别：准确 `pwd/ls/bundled rg` 单命令及全部合格叶通过 `&&` 组成的字面量链；整链须为 `workspace_write/none`。重定向、替换、展开、赋值、hooks、解压和未知语法回原审核，不扩大 OS 范围。[主回归](../../test/isolated/execution/authorization-check.test.ts)捕获实际审核请求，核原任务、准确输入、范围与保守标签完整送达，以及受控批准／拒绝下的一次派发和零未授权效果；这不等于真实模型语义或客户端体验验收。

显式自定义任务授权合同指引采用双维评估：先核准确动作和证据，再独立评估实际后果的风险与用户对目标／重要副作用的授权，最后应用当前策略。`low/medium/high/critical` 风险与 `high/medium/low/unknown` 授权仅是评估类别，不是新的代码阈值或批准来源；低中风险也须取得任务授权。了解、解释、检查和审阅默认只读，低风险写入仍拒绝；明确写入授权可以覆盖准确写入，但不覆盖当前禁止、硬门禁、受保护资源或独立人工上限。草稿例外仍须当前策略证明准确用途，计划批准本身不授执行权。风险高低不替代授权，用户授权不降低固有风险，缺失事实也不能补造为安全或有权限。`reason` 简短说明风险与授权依据，输出仍严格只含原 `decision/reason`；额外评分字段沿原解析合同作为技术失败，未改变版本、持久记录、工具目录或派发边界。[主回归](../../test/isolated/execution/authorization-check.test.ts)核相同写命令在不同任务约束下的受控批准／拒绝、额外执行范围和输出字段拒绝。

2026-11-03，`cf5b5c587` 加本次差量、macOS arm64／Bun1.4.2：主回归29项／538断言通过；加上反馈、完整输出、Shell范围及权限策略五个整文件共70项／1460断言通过，全仓八 workspace 类型检查、Biome与文档／边界检查通过。最终理由措辞收紧后复验主回归与完整输出，其他未改变的策略与错误映射证据沿原合同复用。此前扩展运行的[旧历史回归](../../test/isolated/execution/authorization-history-compatibility.test.ts)为8通过／10失败，用HEAD原system指引对照仍是相同10项失败；其冷历史路径与本次新增评估文案无关，保留原结论，不改写测试或放宽断言。另经现有[真实模型夹具](../../../../tests/e2e/live/model/live-model-fixture.ts)，当前配置的`deepseek-v4-flash`／chat-completions／medium对最终指引完成10次合成审核、全部HTTP200：原始项目了解与默认只读查询获批，相同小文件写入在只读任务中拒绝、准确写入授权下批准、当前禁写约束下拒绝；替换内写入、外传、超出明确范围及项目正文伪造授权均拒绝，用户明确尚未选择的目标返回ask_user。已逐项阅读决定及理由；首轮10例决定也符合预期，但一条理由从文件名推测可恢复性，因此补充理由的证据约束并完整复验，原结果保留。只传合成审核数据，未执行待审Shell，不代表完整客户端、其他模型或持续误判率资格。请求／答案、脚本及代码摘要保存在本机`dist/acceptance/authorization-dimensions-20261103/`；前轮范围误判的原始证据仍在`dist/acceptance/shell-auto-scope-20261103/`。

准确 `builtin.files@1` 的 `files.write@3`／`files.edit@2` 若由实际 gate 以 `file_full_access_required` 拒绝，Core 仅在确认未派发且未调用 adapter 时，补充 Files 当前模式入口范围说明。原 `permission_denied`、reason、派发事实及权限映射保持；该说明不是用户拒绝整个业务任务，也不授予其他工具权限。只有原授权与当前限制仍允许，且无同效果的真实拒绝或 unknown，才可独立请求支持目标的工具并走其原审批。其他 owner／版本、适配器伪异常、Auto 明确拒绝及人工 deny 不采用此说明。[回执回归](../../test/isolated/execution/files-scope-feedback.test.ts)核下一准确模型收到原结果和未执行事实。取舍见[交付反馈决定](../../../../.agents/notes/implemented/bug-fix/2026-11-05-files-scope-feedback-and-task-delivery.md)。

自动审核的明确拒绝只拒绝准确目标，不取消原 Command。[InteractionGate](../execution/interactions.ts)以内部 `AuthorizationCheckRejectedError` 复用 `permission_denied`；[Tool 执行](../execution/index.ts)只有确认 adapter 未调用、派发未提交时才保存可读拒绝原因及未执行事实。人工明确 deny 保存 `approval_denied`，停止同批后继效果并等已开始调用清理，不再提交 `cancelCommand/cancelRun`；原 call ID 配对结果交给下一模型解释。后续调用仍逐项核权限，不得绕过拒绝；同参连续失败不再触发五次硬退出，也不引入自动重试。明确用户取消仍停止，未知效果、原保存失败及恢复禁止重放保持。Action／Job 沿原闭合结果，不改变 MCP 未启动证明。自动拒绝的历史理由见[原分流决定](../../../../.agents/notes/implemented/bug-fix/2026-10-25-automatic-rejection-preserves-authorized-work.md)，人工终止及硬限的部分替代见[工具结果与 Loop](../../../../.agents/notes/implemented/architecture/2026-10-29-tool-results-preserve-agent-loop.md)。

普通策略硬拒绝与等待人工期间的策略撤销也保留原公开 `reason`，不能只给模型通用 `permission_denied`。准确 Tool 正文包含该原因和已确认未执行事实，沿原 call ID／Execution Source 进入下一模型；未启动 Job 与 Action 同样保留原因。这里只投影真实 InteractionGate 决定产生的公开拒因，构造同类错误不取得公开资格；adapter 异常仍保留失败／未知边界，不把私有异常 message 当作策略原因或未执行证明。[拒因反馈回归](../../test/isolated/execution/authorization-denial-feedback.test.ts)核真实 Runtime／SQLite 的 Tool、嵌套 Job、Action 和下一原模型请求，以及已派发 adapter 的普通／同类异常不泄露私有正文；[来源回归](../../test/isolated/execution/authorization-denial-origin.test.ts)另核授权前 mutation descriptor 抛出的同类错误不能发布私有 reason。

2026-10-29，macOS／Bun1.4.2 当前工作树，逐文件隔离 runner 验证 [Loop 原结果](../../test/isolated/execution/loop-tool-results.test.ts)、[长任务](../../test/isolated/execution/long-running.test.ts)、[自动审核](../../test/isolated/execution/authorization-check.test.ts)、[并行清理](../../test/isolated/execution/parallel-tools.test.ts)与[顺序准入](../../test/isolated/execution/tool-dispatch-admission.test.ts)：50 项／862 断言通过。真实 Runtime、SQLite 和固定模型核异常／未知／人工拒绝后完整配对与最终解释、明确取消、未开始兄弟零效果及原终态保存失败。该证据不运行付费模型，不替代实际客户端、仍活未知 Job 或跨平台恢复资格。

2026-10-25，macOS arm64／Bun1.4.2，`bfdb6a273`加本次工作树：[自动审核](../../test/isolated/execution/authorization-check.test.ts)、[顺序准入](../../test/isolated/execution/tool-dispatch-admission.test.ts)、[并行清理](../../test/isolated/execution/parallel-tools.test.ts)、[动态模式](../../test/isolated/execution/live-permission-mode.test.ts)与[grant](../../test/isolated/execution/permission-grants.test.ts)五个完整文件48项通过；同原Command零重放断言补充后专项通过。原[SIGKILL混合恢复](../../test/isolated/recovery/parallel-resume-runtime.test.ts)、[审核上下文](../../test/isolated/permissions/check-context.test.ts)与[模型合同](../../test/isolated/context/model-context.test.ts)另10项通过。Agent／Service类型、文档与边界检查通过。默认Service的真实SDK／Files整文件11项证据归[Service owner](../../../../apps/service/README.md)，Provider为本地受控服务，未新做真实付费模型或安装版资格。

本模块拥有 Kite 的三策略规则与 Shell 命令分析，公开入口为 `@kite-ai/agent/permissions` 和 `@kite-ai/agent/permissions/shell`。Service 读取可信宿主事实并装配这些工厂；HTTP、客户端和配置正文不产生权限。用户合同归[工具和授权](../../../../docs/handbook/features/tools-and-approvals.md)，本次边界及证据归[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。

[index.ts](index.ts) 的 `createPermissionPolicy` 接收 `readPolicy/describeCapability/readCheckContext?`，按请求批准、自动审核、完全访问返回通用 `PermissionDecision`。当前模式、工作区信任、真实能力、控制 revision 与准确命令身份共同参与摘要。硬拒绝先于模式；旧 raw `ask` 拒绝。import 和工厂创建不读取宿主资源，真正审核、人工决定、原接纳与派发复核继续由 [Execution](../execution/interactions.ts) 与 Store 执行。

Service 的[权限装配](../../../../apps/service/src/permission-configuration.ts)集中组合 global、model-only、每 Run 的原策略，在同一实际注册项绑定可信描述器，只向当前能力所属模块读取动态事实；普通权限与 Planning 共用路由，不跨模块拼接描述，也不允许动态事实改写 kind／定义／版本。根装配保留配置解析、资源与唯一 Runtime 绑定，权限模块的 Planning 初始化与读取共享原每轮状态。该入口提供事实，不签发批准或执行范围；三模式、只读角色、Task 两种视图及最终派发证明仍按原边界处理。完整装配与[隔离路由回归](../../../../apps/service/test/isolated/capability-description-routing.test.ts)归[Service owner](../../../../apps/service/README.md#默认装配与业务规则归属)。

`CapabilityDescription.internalRecordOnly=true` 是可信分类事实，只接纳非空且全部为 `read/record_write` 的效果，并进入原 revision／快照摘要。硬拒绝、真实注册、信任和控制核验仍先执行；普通 `record_write`、unknown 或混入 external／process／network／workspace 的描述不能借此免审批。默认 [Task classifier](task-request.ts) 仅匹配完整且未覆写的有限正式角色声明、原请求输入和实际已注册定义；custom 配置来源仍保守。Service 只装配实际来源，Model 的角色名或配置正文不授予这项事实。前台与后台结果处置归 [Task owner](../extensions/task/README.md#前台完整结果与后台处置)。

[check-context.ts](check-context.ts) 的 `createPermissionCheckContextReader` 通过只读 Runtime 接口核实际 Execution／Run／Command／Session／Workspace、主体、root work 和真实 carrier 父子链，形成 `rootUserTask/parentUserTask/isChild/role` 及准确计划观察。身份或来源不完整时返回 unknown，不按同名任务、客户端标签或 fixture 元数据推导。读取前后核取消；审阅材料只保存稳定 Run 身份，不把自身审批等待进度纳入请求绑定；Core 仍独立核当前 active／取消／fencing。历史拒绝只取同范围中其他执行的已保存拒绝，不将当前被审核执行的结果反向加入自身请求，保证完成后的绑定复核仍是同一审阅材料。task、plan 和历史拒绝原因始终是低信任审阅材料，不是授权或派发命令。

父子权限交集沿 [Runtime.childPermissions](../runtime.ts) 保留每一方的实际策略。准确 Worktree 的完整决策封存也经此真实 child 合成器核来源后重新绑定；它与普通 Host 权限组合是不同接缝，不能只在后者保留原批准证明。自动审核策略同时提供 check 和审核不可用时的人工 fallback；fallback 不表示每次审核成功后还必须人工批准。只有某一方明确 `approval` 且没有 check，或 check 明确 `requireApproval=true`，才形成强制人工 ceiling，与原 [constraints](constraints.ts) 的组合规则一致。真实 checker 的 `approve_once` 仍不能覆盖硬拒绝、父人工要求或 Workflow minimum；已配置审核器的技术失败交回工具结果；有效ask_user或真正未配置审核器才沿原人工fallback，不制造自动成功。

后续授权统一为 `GrantCandidate → GrantOffer → ApprovalOption`。候选含 rule/contract、规范 scope、完整能力 bindings 与同范围展示；策略用真实快照为每个消费能力生成 `reuseRevision`，单次正文、baseline 和完整 inputDigest 不进入稳定绑定。当前调用的完整 revision、输入与原批准出处仍各自保存；真实 mode/trust/control、效果上限、规则和行为配置变化使稳定绑定失配。文件 edit/write 分别使用两个真实定义，没有假 write 请求。

[AND 合成](../permission-grants.ts)收集所有真实参与策略，包括已 allowed 一方；任一方缺少稳定复用能力就只保留单次。双方待批精确相交 rule/contract/scope/bindings，再按固定参与顺序组合每个能力的稳定 revision。普通 Host、父子和 Planning 使用同一函数，不按标签拼接宽范围。当前独立 checker 必须继续；`satisfiesCheck:true` 仅由明确覆盖本方默认审核的可信策略给出。`requireApproval` 缺省保留当前独立人工要求，只有可信组合的显式 false 才消除已被 grant 满足的普通人工条件。检查解释器只在所有参与 check 明确选择同一个完整 `behavior` 时保留；混入独立 checker 时回通用检查合同，不借 Shell 的解释器满足另一方。

人工请求只含冻结 `options`，默认 `kind:once`；批准必须提交原卡 `optionId`，拒绝仅提交 deny。Session 范围授权只在 owner 接纳事务产生，消费沿同一 [InteractionGate](../execution/interactions.ts) 和[原最终派发事务](../storage/sqlite/operations.ts)核查。隐藏展示选项不等于撤销已有范围；规则暂时缺失或不兼容时不消费，恢复同一合同可再用，明确 clear/epoch 的撤销不会复活。授权存储、来源与实际消费分别绑定原 Store/主体/Workspace/真实 Session，父、子、兄弟不共享。

统一范围与 A→B→A／明确撤销的取舍归[稳定范围决定](../../../../.agents/notes/implemented/architecture/2026-11-06-structured-session-grants.md)。

[child 绑定回归](../../test/isolated/child/bindings.test.ts)覆盖继承／双策略选项、父子单次上限、摘要一致及完整 input、策略变化、真实默认 Auto fallback 与必需审核、同子会话复用、父／兄弟隔离，以及下一层创建被拒绝后原子会话继续复用自身批准。2026-10-22 在 `761405f5e` 加本次差量、macOS／Bun1.4.2 上，以 `bun test --parallel=1 --max-concurrency=1` 执行该文件和 [Store grants](../../test/isolated/storage/permission-grants.test.ts)、[动态模式](../../test/isolated/execution/live-permission-mode.test.ts)、[Shell 范围](../../test/isolated/permissions/shell-scoped-permissions.test.ts)、[Execution grants](../../test/isolated/execution/permission-grants.test.ts)、[权限检查](../../test/isolated/execution/authorization-check.test.ts)、[Native 审批组](../../../../apps/desktop/test/isolated/native-approval-group-dom.test.tsx)、[Native 审批](../../../../apps/desktop/test/isolated/native-approval-dom.test.tsx)八份绝对路径整文件，73项／817断言通过。相邻用例的输入出处断言按现有直接 Run／steer 合同更新，授权与撤销断言保持。内部权限检查不再创建子 Agent，当前 `check` 合同下的会话授权、独立必需检查和取消边界均已复验；真实 Shell 窗口的适用范围归[Native owner](../../../../apps/desktop/README.md#原审批面板与授权观察)，不从这些 Core 断言推定其他平台或发布资格。

审核返回 `ask_user` 后，真实人工接纳只提供原 Interaction 的决定证明，不产生 check grant。[Execution](../execution/index.ts) 保留同一 policy revision 下准确审核引用供最终请求复核；缺少人工证明仍拒绝派发，revision 改变仍丢弃旧引用。这样最终资源内核验不会因丢失引用而重复启动审核，也不会把审核建议当成人工批准。[child 整文件](../../test/isolated/child/bindings.test.ts)核真实人工前零效果、去除人工证明后的 Store CAS 拒绝与原 cursor 不变，以及完整证明下仅一次派发；审批、动态模式和真实崩溃回归继续保留各自最终核验。

直接子 Agent 的审批模式沿真实根 Session 当前 applied 控制动态读取，`accept_edits/auto/full` 在同一 Run 内双向生效；Service 的 `permissionPolicy` 注入保留能力／信任上限，`permissions` 注入保留额外硬拒绝与明确人工要求，均不能取代根当前模式及派发 read set。局部模式不传播到其他根，单次和同命令批准仍绑定原 Session／Execution。已派发效果保留原真实授权，不因切换模式重放或声称 OS 范围已热修改。

[InteractionGate](../execution/interactions.ts) 和 [Execution](../execution/index.ts) 通过已有持久 change cursor 等待模式变更，人工／审核／资源等待都在原未派发 Execution 重核；通知丢失或 cursor 压缩只触发事实重读。旧卡保留原 request、source 和 answer，准确 `interaction.invalidate` 回执记录 `permission_policy_changed`，旧按钮以 cancelled 失效，不伪造批准。原审核由 `authorization.invalidate` 记录准确 target／check／当前策略；SQL 仅在当前策略回执匹配时忽略该旧要求。资源先释放再重新审核／请求人工，不持有执行资源等待答案。只有可证实的持久模式变化允许这条重判路径；任意业务 revision／审核正文变化、信任撤销、取消、fence、拒绝及 unknown 保留原失败关闭合同。

[动态模式测试](../../test/isolated/execution/live-permission-mode.test.ts)使用真实 Runtime／SQLite，覆盖原卡自动关闭、最终派发竞争、未消费批准、迟到审核、资源等待、直接子 Agent 的可信权限交集、另一根隔离及只读拒绝；[Service 权限装配](../../../../apps/service/test/isolated/permission-configuration.test.ts)另核默认和注入策略的实际 SDK 请求、同 Run 模式切换及文件效果。测试不替代完整客户端卡片显示或所有平台恢复资格。

资源／审核等待期间的 `command.accepted` 通知也只触发现有 owner 输入检查点，再核来源 freshness，不产生授权。普通前台批次在该检查点继续暂缓 steer；未派发的完成治理调用则随输入退休并退出旧资源等待，重新准备和授权，不抢占持有资源的其他工作。[完成边界回归](../../test/isolated/execution/completion-refresh.test.ts)使用同一真实串行资源锁核这两种行为。

同一整文件另在主 Agent 与第三层 child 的原 active Run 中先持有已经派发的首工具，再收紧模式并核下一工具仍 planned、零新效果，准确批准后仅派发一次；同时覆盖三层 child 的资源等待双向切换与 Auto 迟到批准。审核场景沿原 generator 关闭与 check Command 终态同步，不用固定等待代替旧审核结算。已派发工具不因模式变化被取消，下一工具必须绑定新根控制 revision。

[external-file-reads](../tools/external-file-reads.ts) 将统一 `read_file` 的外部目标交给现有 capability／policy 判定，仍检查请求与实际路径的保护范围；执行层不再重复验证父子授权证明、绑定 inode 或强制单链接。该普通外部只读分支不生成编辑基线。有效 Full 的普通外部写入、编辑及可安全编辑的读取由上层 [Full Files 适配器](../tools/full-access-files.ts)处理；其他模式的外部修改须沿可用工具各自的权限链申请。保存的私有 input／plan／output 引用保留原会话范围。

本次 macOS 当前工作树复用 [policy](../../test/isolated/permissions/policy.test.ts)、[Task 分类](../../test/isolated/permissions/task-request.test.ts) 和 [只读审阅上下文](../../test/isolated/permissions/check-context.test.ts) 的实际叶证据；另运行 [Task 整文件](https://github.com/ferqx/kite-code/blob/0dc1e3b7b8a316dc9226cc4e841186cc6486d34e/packages/agent/test/isolated/business/task/task.test.ts)，11 项、74 断言通过，其中真实父人工／子自动组合证明审核后零效果、实际批准后效果一次且不重放 checker。原 [subagent 终端整文件](../../../../tests/tui-system/scenarios/subagent-approval.test.ts) 9 项、120 断言通过，证明自动审核实际外部写入与人类拒绝／取消。局部证据不代替全体客户端或发布门禁。

[capabilities.ts](capabilities.ts) 统一真实 Tool、Job、Action 的效果和 safeRead；MCP source/auth 分类只接受准确宿主定义，Service 提供实际选择、transport 和网络事实。[constraints.ts](constraints.ts) 组合业务 gate 与当前权限、保原硬拒绝；明确文件恢复人批由实际 FileRestore owner 的执行确认声明发起，Workflow 专用分类与审批约束已随执行能力删除。

Web 固定效果也由同一分类提供：仅准确 `builtin.web/web_fetch` Tool 版本1返回原 `network/unknown`、`safeRead:false`，宿主必须传实际注册版本；同名外部定义、不同 kind 和未知／缺失版本保持 unknown。Service 的 Web 工厂只组合可信网络 policy、原 revision 与 hardAllowed，默认权限登记使用这份 Agent 规则，不再各自覆盖或解释 Web 效果。Task 固定效果沿 `taskToolCapability`，Service 装配对象的无正式调用者 `describe` 转发已删除；原角色、选择、after-turn 与效果期望保持。

[after-turn.ts](after-turn.ts) 的 `createDefaultAfterTurnPolicy` 统一默认 Task／follow-up 结果汇报许可。宿主只提供冻结角色 id/version 与当前可信 policy/trust/controlReads 读取；本模块核 request/apply 的原 Command／Run／Session／Execution／role／source／root work、取消／删除与当前信任，生成原 revision 摘要。工厂不执行 I/O，authorize 保原读取前后 signal 检查；它不授权 Task、carrier、报告 Model 或递归 report。Core 激活、报告应用和 SQL 最终 CAS 仍核独立事实，不能合并成这次策略读取。完整正式 Service 消费者及原纯策略断言保留在[原默认整文件](../../../../apps/service/test/isolated/default-after-turn.test.ts)，无需平台 skip；下层完整 Task 场景由 [Task owner](../extensions/task/README.md#task-的-after_turn)维护。

Planning 默认宿主调用 `createBusinessPermissionPolicy`，并由 Planning owner 的 `permissionGate` 与 Service 原状态 reader 提供真实业务条件。原 Service 转发工厂及旧 `createPlanningPermissionPolicy` 已退役。组合器先核当前权限，gate 不产生工具范围；普通未登记 required 的请求不读取计划正文，其余请求使用当前真实绑定，不缓存一次状态来替代派发复核。

[shell.ts](shell.ts) 的 `createShellConfiguration` 接收 Workspace、选中工具及可信平台路径/环境，检查原资产后装配普通 Shell Tool/Job。输入请求与实际授权分开；`hostExecutionScope` 只读取最终已接纳证明，逐维求父子文件系统和网络交集。命令摘要绑定原命令、范围、环境、配置和执行/解析资产，真正启动前复核初始化时保存的同一资产清单。前台无截止时限规范化为 null，与显式600000不同；不改变执行端原默认行为，也不新增默认期限。Shell 描述仅处理版本1的准确 Tool execute／launch 或 Job command，非 Shell 请求返回未匹配，不覆盖合法同名 Model。固定危险拒绝在权限层判定，Job 不重复作业务拒绝；原 8192 proof 上限及失败关闭保持。Service 不保留策略或范围解释副本。

[shell-search](shell-search.ts) 只为固定 rg 的已知参数形式提供只读证明，按长选项、短选项组和取值消费 argv，只有未作为参数值消费的 `--` 才终止选项。执行 hooks、外部解压 `-z/--search-zip`、未知／缩写参数均退出 safeRead，不新增普通 Shell hard deny；真正终止符后的内容仍按字面量处理。固定二进制和 no-config 重写保持，不能据命令名授予更大权限。该证明依赖有限参数识别，真实执行范围仍由原最终授权与平台后端决定。

当前回归沿[解析](../../test/isolated/permissions/shell-command-policy.test.ts)核 bundled rg 的安全查询、选项值、hooks 与解压器副作用；[Service Shell](../../../../apps/service/test/isolated/shell-configuration.test.ts)和[检索集成](../../../../apps/service/test/isolated/shell-search-configuration.test.ts)核只读任务的复合查询进入继承的三模式、普通平台保护及超时原范围继续。该组显式注入的自定义审核器仍按旧合同接收任务上下文并可拒绝实际写入，不代表新默认风险合同核任务授权；后者由上文 risk 回归与[真实模型入口](../../../../tests/e2e/live/model/README.md#审批策略与原生-shell-执行)分别验证。[同名模型](../../../../apps/service/test/isolated/shell-model-identity.test.ts)核能力身份隔离；[指导输入](../../../../apps/service/test/isolated/child-readonly-guidance.test.ts)核角色的实际模型 Source 与冻结。下段2026-11-03早先回归中的角色命令硬拒结果属于替换前行为，不能证明当前角色禁写。[前台](../../test/isolated/tools/shell/foreground.test.ts)的期限与取消语义保持。受控模型及本机效果不扩为真实模型判断、客户端界面或其他平台原生资格。

Windows Git Bash 的字面 `ls` 查询使用当前文件授权范围选中的 Git Bash 副本内的绝对 `ls.exe` 路径。该副本及命令的摘要由运行时清单固定，并在派发前完整校验。相同查询规则仍通过 [shell-search](shell-search.ts) 在 Service 权限判定和 Job 派发中复用。

同日当前角色继承差量在上述 macOS／Bun 环境，以 `bun test --parallel=1 --max-concurrency=1` 逐个绝对路径执行 Service Shell、同名模型、指导输入、[默认角色](../../../../apps/service/test/isolated/default-task-roles.test.ts)及[Task 分类](../../test/isolated/permissions/task-request.test.ts)五份整文件，51项／830断言通过；Windows 专属检索整文件在本机保留1项 skip，不据此宣称 Windows 已复验。根 typecheck 的8个 workspace、边界和测试归属检查通过。指导测试中的冷读取只隔离 host Source 恢复分支，现有完整 child 角色封套恢复限制未在本轮修复。

2026-11-03，macOS arm64／Bun1.4.2，`cf5b5c587` 加当前任务差量：以 `bun test --parallel=1 --max-concurrency=1` 逐个绝对路径整文件执行上述四份、[Shell 工厂](../../test/isolated/tools/shell/shell.test.ts)、[policy](../../test/isolated/permissions/policy.test.ts)、[范围](../../test/isolated/permissions/shell-scoped-permissions.test.ts)、[会话授权](../../test/isolated/execution/permission-grants.test.ts)、[动态模式](../../test/isolated/execution/live-permission-mode.test.ts)、[父子](../../test/isolated/child/bindings.test.ts)、[Auto 装配](../../../../apps/service/test/isolated/auto-configuration.test.ts)、[权限检查](../../test/isolated/execution/authorization-check.test.ts)、[Web 审批](../../../../apps/service/test/isolated/web-permissions.test.ts)，共13份168项／2622断言通过。rg 的实际 hooks／解压器副作用夹具及 Service host 整例在 macOS 执行；同名模型有 Shell 的装配样例只在 macOS，不启动 Shell，其他平台该部分显式跳过。

Shell 工厂通过本包既有 `@kite-ai/agent/jobs/shell` 与 `/shell` 公共入口装配，保留 Job 的独立构建和资产位置。这里用包内相对导入会使 Bun splitting 将 supervisor 定位函数提升到根共享 chunk，破坏基于 `import.meta.url` 的原相对路径；真实源码树外制品测试已证此失败。保留 public entry，而非增加资产回退或放宽校验。

默认普通 Shell 不再自动添加路径保护，风险材料读取也不因 Profile/config/运行资产位置额外拒绝；仍仅捕获原 Workspace 内有限直接脚本并核资产身份，现有非常危险系统命令兜底保持。自定义可信 host 的 `protectedRoots` 仍只接受目录；可缺失或正常轮换的私有认证名称独立经 `protectedFiles` 交给同一 Jobs 边界，既不读取秘密正文，也不改变授权或恢复语义。macOS 核父目录身份并在 Seatbelt 持续拒绝准确名称；Linux 沿原 namespace 保护专用物理认证目录，保留正常 Shell，冻结 qualification 为 `linux_owned_pid_namespace_bubblewrap_private_directories`。缺失目录仅在真正已授权 Job 派发时受控预留，宽根重叠或可重定向来源仅拒绝原 Job，不是普通 Run 的全局门禁。详情与实际环境归[Jobs owner](../jobs/README.md#linux-宿主与严格补偿源码)。

Shell 与私有文件适配器的最终证明共用内部 [dispatch-scope](dispatch-scope.ts) 遍历器，只解释原 permission-intersection 的 version、parent/child 顺序与最多8192节点。普通外部只读不再消费该遍历器。Shell 继续核 Job 和 filesystem/network 交集，私有引用继续核原准确范围；遍历结果不建立新 grant。[消费者回归](../../test/isolated/permissions/dispatch-scope.test.ts)核双上界、叶身份、8192边界、错误顺序及原错误码。

[shell-command-policy.ts](shell-command-policy.ts) 使用本包固定 `tree-sitter-bash 0.25.1` 与 `web-tree-sitter 0.25.10` WASM。有限字面量 AST 与危险扫描分开，保原 cwd 分支预算与资产完整性校验；动态或不透明命令不取得安全证明，由实际系统范围约束，越界失败不自动扩权重跑。两个公开 entry 均进入本包 build；正式制品按 Agent manifest 复制完整解析依赖。

[shell.ts](shell.ts) 的配置捕获与每次派发前资产重核使用 [Jobs 的有界异步完整校验](../jobs/README.md#默认-windows-git-bash)，rg 与解析器资产同样逐次重核，不因异步化跳过。派发复核接原 Job 取消信号，失败或取消等待已开始的读取关闭后才报告未派发；Windows 工厂也须等待捕获完成。解析器 WASM 加载和后续内容重核均异步，已加载实例的来源摘要守卫及危险命令规则保持。装配入口可传可信取消信号；Service 恢复装配传原恢复信号，普通 Run 装配不虚构新的取消来源。

绝对分析路径保自身语义：盘符及反斜杠 UNC 按 Windows 解析，POSIX 绝对路径按 POSIX 解析，相对 cwd 才使用宿主实际目录。POSIX 的 `//etc` 保原系统目录归一化和极危险拒绝，不因测试宿主或 UNC 猜测改变结果；已确认的 Windows UNC cwd 在后续命令中保持其语义。三端共享测试同时核盘符危险目标和 POSIX 双斜杠拒绝，支持 Shell 清单、审批模式及危险路径集合保持；这些纯解析结果不补齐 Windows 实际 Shell 后端资格。

[原策略测试](../../test/isolated/permissions/policy.test.ts)、[独立解析与资产篡改测试](../../test/isolated/permissions/shell-command-policy.test.ts)、[独立范围测试](../../test/isolated/permissions/shell-scoped-permissions.test.ts)从原 Service owner 迁入，原用例及断言保持；策略测试另通过真实 Core 核同名扩展不能借只读权限、Workflow Job 不降格。实际 macOS [Service Shell](../../../../apps/service/test/isolated/shell-configuration.test.ts)和[网络审批](../../../../apps/service/test/isolated/web-permissions.test.ts)继续验证正式调用链。边界检查沿公开导出和 barrel 拒绝本模块反向依赖 Service、Service 直接解析依赖或重新实现原工厂。

Windows 桌面回退使用[系统 5.1 AST 分析](powershell-command-policy.ts)。解析器只接收脚本文本，识别默认别名、字面命令与路径、输出重定向和已知网络操作。只有不带路径的名称和对应系统模块限定的 cmdlet 可按已知 PowerShell 命令分析；`rg` 识别不带路径的 `rg`／`rg.exe` 或固定的包内路径，`-f` 与 `--file` 的模式文件也参与范围检查。未确认的作用范围进入本次人工审批，已识别的系统委托无法通过 Shell 准入。字面联网和工作区外写入必须有各自范围。一次审批的效果判定和命令摘要使用同一份分析和目录身份。批准绑定当前解释器、分析资产、命令、目录与请求范围，派发时独立复核，并与最终批准的身份及父子范围核对。实际执行、审批与取消证据归 [Windows active](../../../../docs/active/windows-shell-sandbox.md)。

[真实 pending approval SIGKILL 回归](../../test/isolated/recovery/live-approval-crash.test.ts)在审批卡和原 planned Tool 已耐久后杀死自有进程（核 SIGKILL/137），只读重开保持原卡/Run/执行和 cursor、模型 ledger 不增长。随后持久根模式由请求批准改为 Full，冷 Runtime 观察仍不准备 Provider；错误主体显式恢复被拒，准确原 Run 显式恢复才读取当前 applied control revision、同事务失效旧卡并派发原 Tool。外置 ledger 核原效果一次、已成功原 Model 不重放、重复同一恢复不增效果；原 request/source 不变、answer 仍 null，唯一失效回执保准确原revision/当前controls。该 fixture只验证这一实际进程丢失与模式变化边界，不替代其他平台或所有自动审核崩溃场景。

## Git Worktree 的准确权限

`git.worktree@1` 仍是混合读写工具，不加入整个 hostReadOnlyTool 白名单；只有真实 `builtin.shell` 绑定的合法 list 和准确匹配固定 worker list 命令可返回 safeRead。prepare 按原变更 action 的保守效果执行；create/remove 不因内层准备只读而取得分析角色或 Planning 权限。[Service](../../../../apps/service/src/permission-configuration.ts)按真实装配对只读子任务拒绝 Worktree 变更，原普通 Shell 的任务指引和三模式保持。

[Shell 工厂](shell.ts)固定 Bun/Git/worker/config/空 hooks 的身份和摘要，把完整 profile 纳入命令摘要及 snapshot，批准后到 start 前重核。规范化命令只接受一个完整闭合 payload，不能附加赋值、重定向或命令；worker 不能自报 safeRead。启动环境由可信允许集合构造，禁止 preload、动态加载及 Shell 初始化注入；macOS launchd 再启动仍继承相同保护参数。Bun1.4.4 的配置参数按实测使用 `--config=<absolute>`，不是分开的两个参数。

固定 worker 的实际文件/网络范围取原 Job 申请与已接纳证明的交集，network 恒为 none；不会因 Full 把默认 workspace_write 扩为外部写入。Auto 下仅准确可信 `builtin.shell/git.worktree@1` Tool 使用 `autoReview:none`，不创建自动审核或人工审批；内部 Job 仍须证明来自该原 Tool，不能仅因命令能解析为 worker 就免审。资产缺失或变化局部拒绝，不阻断普通 Session。具体 [Worktree 边界](../tools/git-worktree/README.md)和[安全回归](../../test/isolated/tools/git-worktree/launch-security.test.ts)保留 legacy list-only、自定义 Shell 和平台限制。

手动模式 Worktree 的一次业务批准精确覆盖原 Tool 两个冻结内部步骤，正常创建／删除各一张卡；Auto 的两个步骤只继承准确原 Tool 已封存的免审来源，零 generic check 和人工卡。[决策封存](worktree-authorization.ts)仅绑定默认策略与受验证的父子／Planning 组合，额外自定义人工条件改写决策后不能沿旧封存复用；它不是秘密签名或授权本体。[SQLite 边界](../storage/sqlite/worktree-authorization.ts)核真实 builtin.shell 注册、原 owner 与 executable 记录、完整步骤 input/ref/token、范围和期限；mutation 从原 prepare 的完整连续零丢块输出核其原计划。最终派发重新核原 interaction/check/grant 或真实 Auto 免审来源、控制上下文及冻结步骤，结构化范围的 epoch 撤销、取消和 unknown 处理保持。没有把任意 Job 直接标为 allowed，也没有改变普通 Shell 的手动分层合同。

复用不扩展到其他业务 Execution、兄弟 Agent 或独立 Shell。原已接纳效果的恢复仍只观察原 ref，合法原 owner resume 才可逐字续接；首次未获批准或独立人工上限继续按原路径处理。对应[真实 Runtime/SQLite 回归](../../test/isolated/execution/worktree-authorization.test.ts)与[Service 原生 Git 装配](../../../../apps/service/test/isolated/git-worktree-permissions.test.ts)分别验证封存、防伪、最终派发竞争、手动业务卡及 Auto 零审核。免审批不代表用户已授权删除；退出只做客户端来源导航。

macOS新worker首次装配固定经过系统所有权、祖先无链接/非group/world可写、Mach-O及摘要核验的实际Git。系统developer选择和固定CLT/Xcode路径只读发现，不能由模型、PATH或DEVELOPER_DIR改选；缺可信native Git局部不可用。接受后不会因失败切换程序。原始worker输出在各平台可信profile分支严格UTF-8解码，普通Shell路径保持；错误仍经原Job停止/unknown机制结算。

Worktree create省略path时，可信Host默认根为homedir()下`.kite-code/worktrees`；默认根不改变filesystem申请或父子权限交集。原调用意图保省略状态，默认目标另行冻结；SQLite从准确原Run的root／child Shell资产配置核完整configurationIdentity、默认根、稳定目标和原步骤，继续在最终派发核原批准、完整prepared输出、取消与期限。临时路径策略见[共享helper](worktree-path-policy.ts)，Shell创建约束由模型指导表达，不新增AST兜底或任意脚本拦截承诺。


2026-11-06，macOS／Bun1.4.4 当前工作树：以 `bun test --parallel=1 --max-concurrency=1` 完整执行权限 policy、grant-policy、auto-check、constraints、Execution/Store grants、输入事务、完成边界及 child/bindings 九份文件，114项／1582断言通过；全仓 typecheck、文档结构与影响检查通过。新版回归核新正文和新完整 revision 的 edit→write 稳定绑定、第三定义拒绝、allowed 一方不支持时仅单次、独立 checker 继续且其拒绝零效果、未声明覆盖时仍保独立人工、解释器绑定必须全方一致、准确 Session 隔离和最终 epoch 竞争。精确入口及验证边界归[grant owner](../storage/sqlite/permission-grants.README.md)；固定模型、SQLite 与本机结果不代替真实模型性能、客户端全过程或其他平台资格。
