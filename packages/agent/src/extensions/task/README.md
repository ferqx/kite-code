# 子 Agent 协作

本模块只注册六个当前工具，没有旧 Task 工具、别名或执行兼容入口。产品行为归[执行手册](../../../../../docs/handbook/features/execution.md)，运行证据归[测试 owner](../../../test/isolated/business/task/README.md)。

| 模型名称 | 内部 ID | 行为 |
| --- | --- | --- |
| `spawn_agent` | `task.spawn` | 以 `prompt` 创建异步 child，可选 `task_name` 和可信 `preset` |
| `send_agent_message` | `task.message` | 给直接 child 或 parent 排队消息，不自行开新轮 |
| `follow_up_agent` | `task.follow_up` | 给 queued/running child 引导，或在 idle child 原 Session 开始明确新轮 |
| `wait_agent_events` | `task.events` | 仅主 Agent 观察自身邮箱的事件摘要和游标，不取消 child 或接纳结果 |
| `list_agents` | `task.list` | 读取稳定协作者目录和完整来源，不改变执行或已读事实 |
| `interrupt_agent` | `task.interrupt` | 请求取消首次受理选中的准确 carrier |

六个定义均保持 v1。工厂为 `createTaskExtension({roles, defaultRole?, presets?})`；模型不能传内部 key、Run、selection、配置 ID、权限或 detached。`task_name` 只作显示，不参与身份、去重或授权。旧工具及 `role/resultDisposition/after_turn` 参数不再可用。

## 身份、权限和预设

`agent_id` 是稳定 child Session ID。spawn 和 follow-up 返回准确 carrier 的 `work_ref`；运行中引导返回原工作引用，idle 新轮返回新引用。interrupt 可传 `work_ref`，原 Store 写事务同时核当前 carrier；旧轮引用不能中断后来的工作。同一协作者可以经历多轮工作；普通父轮次结束不取消已受理 child。每次 Tool invocation 派生受理身份，准确重试查询原持久回执，不重复创建工作或将迟到中断改投新轮。

`work_ref` 是原 carrier Execution ID 的无损短表示，不重复编码 child、Command、key 等可抄错字段。通用 Host 从原 `operation.agent` Command 与原 Store Operation 记录核得 `PublicExecution.operationRef`，再由现有 `readAgent` 核直接父子及控制权；不查“最新工作”、不纠正相近 ID。引用核验全部只读，失败返回 `invalid_work_reference`；写命令在该阶段明确 `accepted:false`，不会把尚未调用的命令误称为接纳未知。实际受理后的丢回执仍保持未知。

角色来自可信宿主注册；新默认只有 `general`、`explore`，`preset` 省略或显式 `general` 等价，旧 `worker/code/plan/review` 不作为新默认目录别名。通用协作者的具体实现、测试、规划或审查职责由父任务正文说明；`explore` 保持只读任务指导与收缩工具集合。父子默认共享工作区，没有 fresh／fork 参数或新的任务模板。[roles.ts](roles.ts)核准确 extension owner、ID 与版本；未知定义、同名自定义工具、未来版本和写入不能借角色名称取得资格。描述帮助选择，不替代冻结定义、父子权限和当前工具交集。

委派正文须保留完成子任务所需的准确目标、字段或标识符、内容转换、一次性效果与 fallback 条件；不能用“按用户要求”代替子模型未收到的正文。父级按原任务比对实际关键交付，已有原文和回执直接比较，只有影响结论的缺口才补读取。成功读到文件、child 正常结束或自报完成不等于内容满足要求；审批事实只在决定允许分支时核对，不为收尾机械追加历史读取或报告。

三个文件检索工具已移除，分析角色通过准确的 `shell.execute@1`／`shell.launch@1` 查询。只读要求作为可信任务指导进入 `explore` 的模型输入，并随原配置快照冻结；工具集合继续收窄，Shell 则继承父会话当前权限策略和沙箱。`cat`、复合命令和管道不因角色身份被固定命令表拒绝，仍按实际内容走普通权限链。只读角色不提供独立的 Shell 禁写／禁网保证，Full 下只读属于模型须遵循的任务约束。[默认角色回归](../../../../../apps/service/test/isolated/default-task-roles.test.ts)核工具交集，[指导输入回归](../../../../../apps/service/test/isolated/child-readonly-guidance.test.ts)核实际子模型输入，[Service 检索回归](../../../../../apps/service/test/isolated/shell-search-configuration.test.ts)核继承的三模式执行。

`general` 的模型工具来自父当前选中集合，继续去除根专属创建、邮箱等待和 `ask_user`。`explore` 在原准确只读绑定外增加 `builtin.task/task.message@1`、`builtin.shell/shell.stop@1`、`builtin.web/web_fetch@1`；每项仍需当前父集合及准确定义支持，不补 `task.list/follow_up/interrupt`，Skills 和 MCP 继承策略保持。消息成功入队即返回原回执，不再等待收件确认，也不自行续轮；子 Agent 的模型目录和实际内置调用入口均不开放 `task.events@1`，主 Agent 保留观察能力。内部静态注册不授予子模型调用资格。Shell 停止须核原句柄与真实终态，网页继续受联网权限约束。

当前版本同一协作者的续作与冷恢复保留 role／Model、冻结工具集合和原 Source。[Runtime](../../runtime.ts)重读并核准确 carrier、Store、直接父子及根会话关系，再向 [Service](../../../../../apps/service/src/child-configuration.ts)提供原配置；调用者不能伪造这份宿主输入。当前父工具收窄、来源变化或配置不能准确绑定时明确拒绝，不回退其他角色、模型或较宽工具，未知效果不重跑。

已完成 Model 的待执行工具批次恢复时，Runtime 逐字比较原工具目录、能力快照和指纹，并核原 Source；owner、版本、schema 或说明变化均不能通过声明转换放行。原 Model 请求和已保存效果不改写、不重放。[真实冷恢复回归](../../../test/isolated/recovery/child-message-resume.test.ts)核当前版本的原 Model、审批与唯一效果，以及目录和快照漂移拒绝。

子 Agent 不提供升级前旧角色目录、旧 Task factory 或工具声明的兼容重建。已完成历史保留原身份、正文和结果，可只读查看；不能据此要求旧 Run 或子任务跨版本继续执行，也不把它们自动改成新角色。当前完整父子 Tool／Job 身份仍比较 description、schema、resources 等，不因 owner／版本相同而放宽。

当前协作者的明确 follow-up 产生新的 MCP 因果 lineage，仍须由真实新父 Run／Execution 派生；仅该新轮比较时排除顶层 `inheritance`，原选中 server、scope、scopeDigest 和 readSet 必须相等，实际 Source／执行仍核完整持久 lineage。冷恢复原轮不使用该例外。完整装配归[Service owner](../../../../../apps/service/README.md)。

根 ask_user 不下放，只有主 Agent 可以新建直接子 Agent。Core 的子模型目录按真实 Session 去除准确内置 `task.spawn@1`；模型目录和新建准入分别核验，内部工具注册不授予创建权限。Host 在原回执查询之后、准备新配置之前核持久会话关系，子会话通过普通 `operations.ensure` 申请新 Agent 时明确拒绝。该限制独立于三种审批模式，静态配置或自定义工具不能扩大创建层级；普通 Tool→自身 Job 不受影响。精确原回执和直接协作者的消息、观察、停止与续作沿原路径处理，不把新建限制加到共用配置 resolver。原因与取舍见[单层委派决定](../../../../../.agents/notes/implemented/bug-fix/2026-11-05-single-level-agent-delegation.md)，回归归[Core](../../../test/isolated/child/single-level.test.ts)及[Service](../../../../../apps/service/test/isolated/child-single-level.test.ts)。合法 Planning 工具仍由 Service 核原父冻结身份和当前注册后装配，显式禁用仍拒绝。child 有自己的会话文件上下文，不从父路径字符串继承可写目录或计划授权。实际效果仍核原 requirements、parent AND current permission 与准确取消边界。

## 后台工作、消息和引导

`applyAgentCommand` 在一个 Store 写事务内先查原 invocation 回执，再选择当前唯一 carrier，核 Store、主体、直接父子、来源和控制关系。运行中或 queued 的 follow-up 返回 `mode:steer`；queued 引导绑定原 carrier，在真正激活后进入模型。idle follow-up 通过原 ensureAgent 建唯一 successor，复用 Session 与配置。后续普通父轮次也可管理现有直接 child，技术工作出处不额外拒绝。

Host 准备 queued 引导后若最终事务发现目标已结束，返回 target_changed；重新观察后的新调用才能开始新轮。首次激活前取消且可证明未派发的 child 可复用 Session；原取消事实不改写，证明由[首次激活 owner](../../storage/sqlite/child-first-activation.ts)核验。旧 queued 引导不会转给新 carrier。

父级发现原范围内可纠正的具体剩余工作时，可对同一 child 明确 follow-up，传准确差异与待修部分，保留已成功效果和一次性限制，不重启整项任务。idle 普通消息仍只排队；需继续工作才明确 follow-up。本次当前工作和完整结果核验后即可正常结束；真实拒绝、未知效果和缺授权时保留实际未完成事实。此指导不新增自动续作循环、完成闸门或业务格式校验器。

普通消息持久排队。活动 Run 在安全 checkpoint 接收准确邮件；idle 邮件保存 targetRunId:null，零新 Run／Model。明确 follow-up 按原 predecessor 和双水位接纳当时已确认邮件；同请求重试不扩大集合，晚确认或晚发送的邮件留队。完整正文以原 source IDs 进入模型，发送、接收和 prepared 是不同事实。

子 Agent 的 [Worktree Tool](../../tools/git-worktree/README.md)在原创建稳定成功后，用同一通用持久消息操作通知 parent，正文带准确路径、HEAD、分支及原 Tool/Job 出处。父收到后向原任务中需要路径的直接 child 转发；运行中用现有消息，idle 且确需续作时用 follow-up。就绪邮件不同于整项 child 完成，不等整项任务结束才发送；入队不表示父已读，也不自动全员广播。`general` 指导说明使用准确路径，通知不改变 cwd 或编辑范围，多个可写 child 的原并行能力保持。

child Run 结束后，carrier 仍须等待该 child 范围的 Model、Tool 和 attached Job，包含排队 Job；detached Job 保持独立。inspectChildSettlement 在短读事务内取得 pending 与 change cursor，Runtime 用原 ChangeWaits 等待，不持 SQLite 事务或额外模型槽。最终 settlement 再核准确事实，unknown 不冒充停止或成功。后台 Shell 继续使用独立 Job 生命周期，不依赖 Task 结果义务。

## 完成通知与观察

spawn 和 idle follow-up 封存 agent_completion 订阅，不建立旧 required-result 义务。父活动时结果沿当前邮箱接纳；父 idle 时只有可信 AfterTurnPolicy 允许，才可从原配置启动通知轮。通知资格与自动执行授权分开，未知结果、停止、选择变化和当前权限仍检查。没有显式 after_turn 意图或旧报告回退执行。

accepted/state/mode 是受理时事实，不是完成证明。`wait_agent_events({work_refs?,cursor?,wait_ms?})` 返回 `next_cursor`；游标只封装原邮箱位置，过滤无关事件也继续推进。没有目标且未显式等待时立即取快照；准确活动目标默认最多观察30000ms，目标已结束或没有活动工作时立即返回，显式0始终只取快照。timeout 保位置且不停止 child，游标缺口返回 cursor_expired 和恢复边界。事件附原工作的 work_ref，观察不消费结果或标记已读。 无目标的显式等待沿固定目录上界分页检查全部协作者，发现活动工作即停止扫描，不能把前100项均 idle 当作全体完成。[Host 分页回归](../../../test/isolated/extensions/agent-events-pagination.test.ts)覆盖第101项仍运行及全体 idle 的分支。

list_agents 按首次创建 Command 的不可变 seq 每个 Session 只列一次；follow-up 不移动锚点。过滤先整体核归属，Decimal64 上界固定分页；完整职责、最近引导和结果通过受验证正文或当前 Tool scope Artifact 交付。当前工作状态的 `work_ref` 与最近终态结果的 `last_result_work_ref` 分别展示，不能把上一轮结果当作当前轮完成。公开目录使用 cursor，内部固定上界和 Decimal64 顺序保持。游标以完整规范 scope 的 SHA-256 摘要绑定原 Store／Session、查询与过滤条件，不再把整组过滤 ID 重复编码到游标；最大200项过滤的回归游标为108字符，生产与读取均拒绝超过4096字符的游标。它不授予权限，原读者仍核实际范围与位置。

错误只公开有限 code/message/next_action。写命令 accepted:true/false/null 区分有证明、明确未受理和不可核实；未知不自动换身份重放。只读取消不误报回执未知。需要父／人类答复的 child 发送完整问题后交回待决结果，列明已完成／未完成事实；父级取得答复后可用原协作者续作。

公开错误的 message 按准确类别说明参数、游标、目标、权限、恢复或回执问题，并把 accepted:false 的明确未受理与 accepted:null 的可能已受理分别说清；next_action 的原机器值保持，观察取消不声称整个子任务已停止。[协作表面回归](../../../test/isolated/business/task/collaboration-surface.test.ts)核真实受理边界的原因进入下一模型、一次受理尝试及私有异常不外泄。

创建或明确续作前的配置准备失败不等于受理回执丢失。Host 仅在准备失败、排除取消与清理未确认，并再次核对准确身份没有已受理回执后，提供内部可信的准备失败标记；模型得到 `accepted:false`／`preparation_failed` 和有限英文原因，说明本次没有启动新工作或投递新引导，既有协作者仍可能独立运行或完成。并发同身份已受理时返回原引用／回执；回执读取失败、身份不符、清理未确认或受理后异常仍保留原未知／恢复语义，不按异常 code 猜测未受理，也不换身份重放。[准备失败回归](../../../test/isolated/business/task/preparation-failure.test.ts)核创建和续作的实际下一模型输入、并发唯一受理、持久受理后丢响应、既有子结果保真和私有异常隔离。保留的通用 `sendAgentInput` 扩展接口继续沿自己的原回执合同，不由当前六工具的错误说明推导新恢复资格。

禁止子会话新建的可信拒绝公开为 `permission_denied`／`ask_parent_to_delegate`，英文说明只有主 Agent 可以创建协作者，不引导切换角色或审批模式重试。只有内部未受理资格与准确原因同时命中才使用该说明；任意同码 Store 异常不提供此证明。[创建拒绝反馈](../../../test/isolated/business/task/creation-denied-feedback.test.ts)核原 call/source 进入下一模型及同码后置异常继续未知。

成功结果及历史可安全读取的失败结果可包含宿主从准确 Tool 回执封存的 details.evidence。失败不撤销此前成功的工具；原失败原因和状态保留，失败结果不采用半成品助手回答作为完成报告。失败历史不可读时只缺失预览，不推断零动作；取消和未知路径不增加历史读取。工具统计、来源版本和有界原文供父级核验，child 总结不能替换事实；接纳成功也不证明结论正确。完整正文和独立核查仍由原 Source、Artifact 与权限合同保障。

实际冻结的内置 Shell 注册及原 Tool→Job 归属匹配时，预览另附命令、请求权限、真实 Job 状态／退出码和有限 stdout／stderr。实际执行范围仅在已有派发记录提供时呈现；请求范围不冒充实际范围，缺输出不表示零输出，截断和省略明确标记。原 Tool／Job 若保存了审核决定、人类答案接纳或策略依据，只附其有限状态／决定／依据类型，不复制风险理由、私有证明或任务授权结论；没有这些事实时省略，不能从已派发、Full 或超时继续伪造模型批准。它与文件观察共用有界预览预算，不公开进程私有信息，也不推断任务合规、服务是否监听或业务已完成。[执行记录宿主接口](../../business/execution-evidence/README.md)保留，但不再向父模型提供独立回执检索工具；`list_agents` 继续提供完整报告正文，不代替这些宿主证据。

## 实现与验证边界

本 leaf 使用普通受控 Operation。公开 Extension 的 ensure/wait/readAgent/sendAgentInput、邮箱和 wait-any 是通用扩展合同，继续服务当前工具及第三方扩展；它们不是旧 Task 兼容层。通用 Requirement／Planning 审批也保留。旧 Task records/conditions、resultRequirement、专用 mandatory-result 等待、status-only 结算及客户端 Required results 状态均已移除。

旧 resultRequirement 参数在 Host／Store 明确拒绝，不会忽略旧义务后悄悄开始工作。持久取舍及旧决定的部分替代归[退役决定](../../../../../.agents/notes/implemented/architecture/2026-11-02-retire-legacy-task.md)。

[六工具](../../../test/isolated/business/task/collaboration-surface.test.ts)、[邮件](../../../test/isolated/business/task/mailbox.test.ts)、[idle 接纳](../../../test/isolated/business/task/mail-adoption.test.ts)、[问题与引导](../../../test/isolated/business/task/question-loop.test.ts)、[attached Job](../../../test/isolated/business/task/attached-job-settlement.test.ts)和[执行组恢复](../../../test/isolated/recovery/run-resume-group-runtime.test.ts)分别核实际 Core／SQLite／模型输入和失败边界。旧 Task 测试夹具已删除，不能用历史工具测试替代当前接口验收。工具、存储与 native runner 版本未因本次移除升级。

根临时 effort 与子配置的实际跨轮边界及普通 Desktop 的失败修复、续作、取消恢复观察归[Service owner](../../../../../apps/service/README.md)。受控回归不代替真实模型任务质量或其他平台发布资格。

`general` 的模型指导要求工作树创建只走 git_worktree，不以 Shell 或脚本兜底；省略 path 使用持久默认根，创建不迁移 cwd，也不新增编辑权限。`explore` 可使用该工具的 list；Service 在实际授权入口拒绝其 create/remove。
