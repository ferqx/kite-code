# 通用 Agent

`@kite-ai/agent` 正在按 [V1.3](../../docs/plans/unified-agent-refactor-v1.md)实施。当前支持显式装配模型、外部工具、Action/Query、一个默认 Loop 与具名 Store；[Service](../../apps/service/README.md)、[Client](../client/README.md)和[通用 UI](../ui/README.md)已通过真实 HTTP/SSE 联验。正式 Terminal 已消费通用 TUI；完整客户端迁移和正式旧路径退役仍按门禁核对。已完成范围和未运行场景见[实施证据](../../docs/plans/unified-agent-refactor-v1-progress.md)。

公共当前会话视图保留最近的有限 Run/Execution 历史及原未结束／未知工作，长会话不会因最早200项投影而丢失当前 Run或较早的 live Job。查询只反映原事实，不改变取消和恢复资格；精确范围与真实长会话验收由[Store owner](src/storage/README.md#当前会话视图)维护。

## 入口与职责

- [根入口](src/index.ts)：`createRuntime`，import 不打开资源。Runtime 的短命令受理与异步运行分开；模型和工具等待不占控制入口。
- [扩展入口](src/extensions/index.ts)：具版本 Tool/Action/Query、JSON schema、公开内容 envelope 与有限操作。扩展只获得当前 Session、自有 namespace 的记录 CAS、公开 Run/Execution 和受控子工具；不取得 SQL、owner 或完整运行状态。
- [普通问题入口](src/tools/ask-user/README.md)：`@kite-ai/agent/ask-user` 的纯工厂通过原 `requestInput` 提供 1–3 题、原选项和自由回答，并将原答案解释为模型与历史文案；默认选择及 child 禁用归 Service。
- [计划与 receipt 验证入口](src/business/planning/README.md)：显式业务工厂、真实用户计划审阅、来源绑定的步骤回执、required 判定和准确 waiver；共享扩展端口与唯一 Loop。完整文件/Artifact/命令/MCP 验证及自动修复继续按该 owner 范围实施。
- [Store 端口](src/storage/port.ts)：宿主使用的具名查询和事务；[记录](src/storage/types.ts)保存业务事实，非完整内存 State。
- [上下文选择与结果](src/storage/sqlite/context/README.md)：当前选择、完整历史和准确结果引用分开保存；双游标读取固定同一选择与顺序上界。
- [Profile 入口](src/profile.ts)：`selectProfile({dataRoot, profile})` 只读确定规范 data-root、逻辑名称与稳定 `profileAccessKey`，供 launcher 在启动前固定目标；import 与选择均不创建目录、取得锁或打开数据库。
- [离线维护入口](src/maintenance/README.md)：显式备份／恢复、DB9公共扩展申请的v18及DB8原Workspace申请的v17资产，以及持准确Store排他权的空间／单会话历史与无引用附件GC；维护自身连接／句柄关闭未确认时保原资源、临时目录及Profile排他权至实际宿主退出，安装维护和完整平台资格按实施进度记录。
- [Profile 使用权入口](src/platform/README.md)：`@kite-ai/agent/profile-access` 供 Bun 宿主显式取得共享使用权，可信一次性 helper 可取得继承 fd 的同一锁；纯 Node 身份入口不引入 FFI 或 acquire。
- [制品使用权入口](src/artifact-access.ts)：显式候选 shared/exclusive OS 使用锁，import 不 acquire，不授予 Profile/Store/执行权限；终端安装器与运行中的宿主共享此协议。
- [资源入口](src/resources.ts)：`createWorkspaceSerialLocks(profile)` 显式建立同 profile/Workspace 的共享 OS 串行键后端，宿主注入 Runtime；import 不打开资源，普通扩展不取得锁对象。
- [进程只读观察入口](src/process-observation.ts)：可信宿主在实际启动后显式读取原 PID 的 PPID、微秒出生和 kernel 状态；import 不加载 native 库，冷 decoder 不观察当前进程。观察不授予 spawn、信号、后代枚举或所有权，具体交接由 Shell／MCP／Service OAuth owner 保存。
- [SQLite 入口](src/sqlite.ts)：显式打开新 profile、一个专用 Worker；具体字段和事务由[基线迁移](src/storage/migrations/0001-baseline.sql)、[具名操作](src/storage/sqlite/operations.ts)维护。
- [Store 目录](src/storage/README.md)：原 Store 与实际 root 创建主体的有限 keyset 分页；Workspace 保持认证 profile 范围，空 Workspace 不依赖 Session 才可见。
- [唯一 Loop](src/loop.ts)：只使用模型/输入/执行契约；工具参数只有在完整模型响应保存后才能派发。
- [来源入口](src/sources.ts)：宿主显式配置的项目指令适配器，根 import 不读取文件。按可信目标链读取 AGENTS.md/CLAUDE.md 的实际内容摘要，相关新增、修改、删除进入派发前复核。
- [文件入口](src/files.ts)与[普通文件 Tools](src/tools/files/README.md)：显式 Workspace 的目录 FD、完整内容基线与精确修改；行读取、glob、查询分页保留明确范围。大正文使用完整 Artifact，显式分页继续保留选择范围。
- [Artifact 入口](src/artifacts/README.md)：不可变文件先发布，再事务登记原 Store、主体、Session 与准确授权 scope；相同 hash 不授予其他 scope 读取资格。
- [完整 Model 正文与实际输入检查](src/model-body/README.md)：原产物正文与大 Model/Auto 请求以准确 scope 的不可变 Artifact 交接，Provider 前完整展开并核实 hash；只读原 Execution 请求及固定上界调用目录不捕获现在来源、不初始化 Provider，Worker 仍使用有限传输。
- [完整 Model 输出](src/model-output/README.md)：原 Execution linked segments 的完整 EOF、历史展开与 child 正文；私有 reviewer 另封存有限答案凭据，最终 Store 只核原 descriptor 和不可变登记，不以 preview 代替全文。
- [Task 入口](src/extensions/task/README.md)与[Shell Tools](src/tools/shell.README.md)：可信角色和原 Job 的普通控制工具，使用同一受控 operations；容量、输入与实际执行资格由 owner 记录。
- [Web Fetch 入口](src/tools/web-fetch/README.md)：普通 `web_fetch` Tool、逐跳资源准入与真实 DNS/socket 绑定，惰性使用已构建的无执行能力解析 Worker；大正文保留完整 Artifact。
- [配置入口](src/config/README.md)：JSONC 评论保留与短锁 CAS、分层解析、脱敏封存、opaque credential refs 和惰性 OS backend。默认 Service 的每 Run 解析由 Service owner 负责。
- [Skills](src/skills/README.md)与[MCP](src/mcp/README.md)：摘要发现、按需正文/资源与具有版本的普通 Tool 快照；leaf import 不连接远端或启动进程。
- [Skill Workflow](src/business/skill-workflow/README.md)：有条件 activation、inline/fork、严格输出和普通核验 Job；业务记录及必要条件归扩展，沿用唯一 Loop 与实际父子权限。

未提交普通Action的结果不以Command.applied视为完成；同Session后续普通派发须继续核原receipt主Execution。准确Store/owner观察、合法detached Job与未提交Action的区分，以及真实最终提交故障测试归[Store owner](src/storage/README.md#未提交普通-action-的串行边界)。

MCP强制重连的建立失败收尾由[MCP leaf](src/mcp/README.md#强制重连持久发布与原事实)沿原operation有界等待真实Job终态，再核完整停止证明。运行中新holder的发布失败继续隔离；超时或迟到结算不追改原unknown，通用Execution与Query合同保持。

## 当前执行与恢复边界

创建与命令写入核对原 `expectedStoreId`，同一 ID/语义返回原事实，内容冲突拒绝。统一执行先保存意图和派发依据，再调用真实适配器；权限、取消与必要依据在派发边界复查。已派发工具没有可核实结果时保留 `outcome_unknown`，不以普通异常推断没有外部效果。模型不完整响应不能启动工具。

`run.start` 与公开 `input.follow_up` 的可选 `selectedSkills` 保存原有限数组并进入请求摘要，Core 不解析名称或读取 Skill 文件。宿主须同时提供 `resolveRunConfiguration` 和显式 `supportsSelectedSkills:true`；未支持时原 Command 持久拒绝，零 resolver/Model/Tool，历史同 ID 仍先核原摘要。省略与空数组是不同意图，活动 steer 不能改变此项。默认 Service 的目录解析、子任务实际 ID 继承与快照由 [Service owner](../../apps/service/README.md)负责。

同两种命令的 `extensionInputs` 是通用 `{extensionId,definitionVersion,input}` 原始意图数组，保留顺序、重复项以及省略与空数组的区别；Core 不解析扩展 payload。只有 resolver 与 `supportsExtensionInputs:true` 同时存在才支持，否则原 Command 持久拒绝且零 resolver/Model。活动 steer 不支持此字段。宿主负责具体版本与输入验证，initializer 在首次 Model 前只创建必要元数据，动态 requirement 自动绑定注册 Extension 的判定器；缺实现不能降为普通提示。

启动器用 `@kite-ai/agent/profile` 的 `selectProfile` 固定预期身份；SQLite 打开复用同一解析，再校验私有目录、no-follow 路径并取得协调锁。尚不存在的 data-root 从现存祖先规范化，profile 数据单元替换不改变外部协调键。选择结果不授予读写或锁权限。

新数据使用显式 `dataRoot/profile` 下的 `core.db`，不会发现或导入旧 Kite 文件。协调锁位于数据单元外，Session 的 OS 锁先于持久 owner generation；正常释放复查命令与活动工作。空列表读取后、实际释放前新接受的准确 Session 命令，在原执行组没有未结算工作时由同一 generation 继续处理；有限宿主观察与 acquire/release 共用阻塞条件，不赋予恢复权，详见[Store owner 边界](src/storage/README.md)。普通重启读取原业务结果；遗留在途/未知工作限制相关执行，不自动接管或重跑。SQLite 内容、回执和变化通知在同一事务提交，网络观察不参与完成条件。

`cancelCommand` 与 `cancelWork` 在短事务中核对原主体、Session 和准确目标；取消从指定 Command/Run/Execution 的实际执行 seed 沿 attached 边传播，父终态不隐藏活跃后代，detached sibling 不被局部取消扩大。普通 Tool 的 execution cancel 不标记其共享 Run Command。Session 全量停止写持久根工作边界阻止迟到因果派发，后来明确新顶层工作仍可开始；foreground-only 停止只覆盖当前 Run 与 attached 后代。受理回执为 `cancel_requested`，不冒充停止确认，也不覆盖真实终态。

接收实例最多保留 256 个待派发 Session，以 250ms 起测间隔等待正常 owner 交接；本 owner 从持久 Command/Execution 观察精确取消，再停止自己的对应句柄。取得安全派发边界失败后停止该 Session 的自动轮询，Command 查询显示带本实例身份的局部 `dispatchFailure`，不改写持久完成事实，也不隐式恢复或重放；其他 Session 可继续，准确取消仍可用。冻结 owner 不被抢占，网络订阅释放不参与这条路径。Worker 按控制/正文/查询加权调度，预留控制容量；可选 `onTiming` 观察实际排队、SQL 和 COMMIT，观察异常不能影响提交。

已登记的根 Session 仍有本实例 hot operation 时，空 accepted 列表不删除其轮询登记；peer Service 后接纳的准确根 Session Command 继续交给原 owner 的 pump。后台 Job 等待 process/Workspace permit 不阻止主 Action 返回，但不允许第二 Job提前启动。原 generation、未提交 Action、cold/unknown和关闭守卫仍在现有派发路径核实；不扫描全 profile，也未取得跨 child Session 的新 intake 资格。[确定性交接测试](test/isolated/execution/owner-handoff.test.ts)在首个命令前安装真实空控制轮询屏障，核两个 Store/Runtime、原 owner 排他锁、同 generation、planned Job和各启动一次；当前 5 tests / 36 assertions，原[真实 Shell Service](../../tests/isolated/unified-agent/shell-service.test.ts)四场景 / 51 assertions通过。取舍与原 idle 交接边界见[同一 Note](../../.agents/notes/implemented/bug-fix/2026-10-03-idle-owner-intake-keeps-original-generation.md)。

受控 Job 先按稳定 operation key 原子登记 Command 与 planned Execution，applied 回执只表示创建，实际 handle 由 `markRunning` 保存。普通 Tool 的 namespace 从原 Run 或准确成功 Model 的实际定义绑定核实；后者还核对 Model 请求中的工具版本、同 Store/Session/rootWork 和原 Run，受控无 Run 子操作核对有限父执行链。namespace 资格不替代实际工具授权。Job 继承来源、根工作和必要业务约束。attached/detached 只改变局部父取消边，根工作停止与删除仍有效。终态与目标 Session/contextSelection 的 pending 或 suppressed 投递事实同事务保存，不自动续轮或调用模型。

Job.start 的可选只读 `dispatchAuthorization` 来自资源等待后的最终 decision，仅在原 `markDispatching` 事务接受权限与 controlReads 后交付。Core 克隆 revision/namespace/version/data；人工批准和自动批准保留原 decision snapshot，包括实际 childPermissions 的父子交集树。它是通过派发边界的宿主执行范围元数据，不是新 grant，不覆盖硬门禁或取消。默认 macOS Shell 消费全部原策略的交集；Core 不认识 Shell mode/路径含义。

本地子 Agent 通过固定宿主 `childConfigurations` 与普通 `operations.ensure({request:{kind:'agent',configurationId,input}})` 登记。Store 原子创建 child Session、Command 与 carrier Job，Core 取得每父 Run 的有界子许可后激活 child Run，复用同一个 `executeRun/defaultLoop`。父 Tool 等待子工作不持有模型槽；嵌套子工作各有直接子许可，不设置隐藏回合上限。子 Tools/Jobs/namespace 不得超过实际父 Step 允许范围，准确调用执行父子 policy 交集；Ask 与 Review 同时适用时保留双 proof。可信 fresh resolver 使用真实 Store Workspace，新 carrier 重新解析绑定；其 `records.forExtension(id).get(key)` 只读实际父 Session 已绑定 namespace，Host 自动封存有限完整投影 digest/read-set，在 carrier 创建及 child activation 的原事务复核，缺失读取也参与 CAS。getter 随 resolver 结束关闭，不交给 Model/HTTP；空读集不为 runless 工作虚构祖先 Run。同原 key 的冷热查回不重新解析或启动。后台 Job 真正结束后才释放原 binding lease。后台 child 完成前保留根执行组 OS owner；精确取消按 attached 关系传播，根停止仍阻止迟到后代。真实 child SIGKILL 恢复保留原 scope、partial、执行身份与未知效果，不自动重新调用模型或工具。

可信宿主的 `readRunExtensionRecord({sessionId,runId,extensionId,key})` 只观测准确当前 Store、实际 Run manifest 所含 namespace 的原记录，拒绝外部 origin/fork provenance；返回 clone/freeze。它属于 Runtime 的普通只读资源生命周期，不取得执行 owner、不初始化 Provider，也不增加 HTTP 或 Model 能力。Service 可由原 immutable activation anchor 读取最低审批，不能用模型输入或有限当前视图猜权限。

Task 使用创建前的真实容量预留，满容量不新增 child Session。`task` 和 `followup_task` 默认在 carrier 的 ensure 事务登记原父 Run 的 required 结果义务；明确 background 才只保留后台事实。已知失败或取消可以被原父 Run 如实接纳，unknown 只给一次状态诊断，不能满足完成义务。等待复用中央变化水位与 `waiting_execution`，不反复调用 Model；普通单目标 `operations.wait` 保留终态等待，新输入在该 Tool 返回后的安全边界应用。受控 `send_message` 与 follow-up 只作用于原直接 child、Run 和 selection；公开 HTTP 不能借此向任意 child 写输入。详细交付及邮箱/after_turn 边界由 Task owner 维护。

child 在实际激活时持久保存 `deadlineAt=startedAt+1_800_000`，根 Run 的 `deadlineAt=null`。Runtime 计时器与 SQL 最后派发使用同一固定期限，到期按真实 Run 提交取消并停止 attached 域；已激活独立 child 与 detached Job 保持自己的适用域。迟到 partial、终态或 unknown 可以保存，不能启动新工作。没有公开短期限或累计 token/Tool/attempt 额度。期限 owner 与真实持续等待证据见[child README](test/isolated/child/README.md)。

审批与问题的权威事实由[Interaction 事务](src/storage/sqlite/interactions/README.md)保存。宿主权限判断可返回 `approval`，Core 在获取 Tool/Job 资源前登记准确参数、定义版本、policy revision、来源和必要 refs；等待不持有该执行资源。超过有限卡预算的完整人工请求由可信 sealer 发布到准确原 Execution scope Artifact，有限卡复用 `policy.review` 完整附件协议；接受及最终授权均核原内容与当前准确 policy/input，卡预算不扩大，正文不截断。根入口回答保存同一请求的答案，实际 owner 复核当前权限和新鲜度后接纳，`markDispatching` 还要求准确决定引用。子请求从真实 ancestry 派生根展示投影，公开 child 入口不能直接回答。拒绝只取消该请求的原工作身份；批准、接纳和执行是不同事实。`ToolContext.requestInput` 登记当前已派发 attempt 的有界问题，使用实际每 Run permission binding 与 control-read stamp，schema 校验和接纳后返回信息，不获得其他执行权限；等待期间 stamp 漂移拒绝接受，迟到答案保留历史而不复活取消的工作。

宿主也可显式注入 `authorizationReview: {id, version, modelId, model}`，并让纯权限分类返回 `review: {request}`。Core 在目标资源前建立专用持久 `authorization.review` carrier 和 child Session，复用唯一 Loop、共享 Model 槽位；该用途不占普通子 Agent 数量许可，真实工具目录、扩展、业务必要义务和额外来源均为空。审查最多一次实际 Model 调用，只接受闭合 `approve_once/reject/ask_user` 与非空 reason。SQL 从原目标保存输入、来源、策略版本、attempt、定义、Store、主体、根工作及真实原命令请求；Tool 决策的 `decisionContext` 只从同 Session/Store/根工作的实际成功 Model 输入派生，包含已应用的 steer 正文和准确来源身份，Action 无该 Model 依据时为 null。最终派发再核实唯一成功 Model、完成 child 和成功 carrier，文字中的自报引用不能授予权限。拒绝结束该请求的原工作；失败、不可核实或 ask_user 回退真实人工审批。资源持有阶段只读已有审查或已接纳人工决定，不创建审查或卡片等待。已有冷 carrier 只供观察，不自动重启 Model；取消沿准确 attached 关系传播。完整审核请求以[Model 正文交接](src/model-body/README.md)封存与展开，不再用 900 KiB 总量拒绝；成功 Model 的实际 `result.modelInputBodyHash` 与原 carrier 绑定共同进入最终 proof。大请求的真实人工回退卡保存完整原请求附件，客户端完整加载资格仍需分别验证。默认 Service SDK 装配已有[真实测试](../../apps/service/test/isolated/auto-configuration.test.ts)，付费 Provider 窗口与其他平台资格单独记录。

[输入事务](src/storage/sqlite/inputs/README.md)区分准确活动 Run 的 `input.steer` 与独立 `input.follow_up`。Core 在安全检查点按持久顺序应用 steer，尚未派发的旧模型、工具和审批保存 `superseded_by_user_input` 与准确的工具响应配对；已派发调用保留原参数、来源和真实结果。最终派发与 Run 完成事务复查 pending 输入，完成附近到达的 steer 仍继续同一个 Run。follow-up 保留自己的命令和原 afterRun 关系，不因后来工作或原 Run 取消而换目标；单独取消未应用输入不会生成消息。公开 child 输入目前仍限制在宿主受控路径，完整业务追加消息继续按方案实施。

模型请求使用当前选择的完整消息与结果来源，按两个独立游标穷尽固定上界，不从屏幕历史或通知推断输入。每次准备模型请求前，原 owner 按真实完成游标分页消费合法 pending Job；消费引用、delivery 与内部回执同事务保存。完成游标保存在执行事实中，裁剪通知后仍可查；已派发模型不被后来结果改写，idle 结果不触发模型。child 同 Loop 消费自己的内部结果，根上下文只消费 carrier 的公开终态。结果以低信任 `user` 数据和准确、唯一的 source ID 呈现，保留原 execution/revision/Store。

空闲根 Session 的 Rewind 核实整个执行组及完整消息/工具配对，保留原历史并原子抑制旧 pending；当前选择只保留所选旧前缀及后续新消息，重复回退不会恢复已排除分支。已消费且保留在选择范围内的结果继续使用原 source ID。显式 include 保存新的选入意图及原结果出处，不重跑工具、不恢复 suppressed delivery、不启动模型；活动 Run 的新 include 当前返回 `input_busy`。完整 Fork、压缩、自动续轮及活动输入整合继续按进度表推进。

无模型 Action 使用 `runId=null` 的受控 Job，子工具仍经过同一个 UnifiedExecution。普通子 Tool 的未结算事实阻止父 Action 成功；已创建的 Job 由独立执行身份继续监督，父 Action 可以保存启动调用的真实结果。可执行扩展记录首次保存时由宿主记录原 Store 来源；同 operation key 的绑定包含定义、参数、主体和父取消关系。恢复来源缺失或不可核实时拒绝新增执行。Query 只得到只读投影，查询不会调用模型或启动恢复。 Action 在实际派发 scope 捕获宿主已注册的不可变 tools/jobs/extensions 与原权限、必要条件及审查绑定；后代沿原 scope 使用同一集合，并通过 Runtime 资源租约保持到所属监督终止。真正无祖先 Run 的 child 可使用可信角色，但仍须满足这组父能力，不能从每 Run 配置增加 Action 未注册的工具。

模型来源变化时旧工具不派发，唯一 Loop 的下一次请求看到刷新后的实际指令。无模型 Action 的旧未派发 freshness attempt 先结算，最多重新准备一次并重新授权新的执行 ID，原 Command 输入与旧来源保持不变；`preparingNextAttempt` 回执随事务提交，等待者不能把旧 attempt 的失败当作原命令最终完成。再变化或重新准备失败保留明确失败/需核实。文件系统复查与 SQLite、外部 I/O 不是原子事务。

`resolveRunConfiguration` 在新 Run 激活前解析实际模型与工具选择，原子保存脱敏配置和准确 Tool 版本；旧 Run 继续使用自己的绑定。宿主可返回每 Run 的 `extensions/sources/dispose`，Core 复制并冻结 schema、资源声明及定义集合；模型目录、自有 namespace 和子操作使用同一绑定。后台 Job 保留该绑定 lease，最后一个真实任务结束后才释放资源，新 Run 的定义或来源不会替换旧任务。未知或重复选择在模型调用前局部拒绝，并释放失败准入的资源。权限请求明确区分 model/tool/job，模型权限不会因同名 Tool 被复用。普通 Tool 的 progress 合并为一个待写点，以 100ms 起测间隔写入，单点最多 32 KiB；终态前排空。观察写入失败记录在真实结果中，不把已知效果改写为未知或再次执行。

宿主可选 `readStepCapabilities` 只读取已存在的目录缓存。每个 Model 安全边界固定额外 extensions、所选 tools 和最多 64 KiB 的非秘密 snapshot；全局注册由 Runtime 加入，调用者不能重复它们。实际 Model 保存准确 `toolBindings` 与 `capabilitySnapshot`，不会重写初始 Run manifest。审批或资源等待期间目录变更使尚未派发的旧调用明确 `capability_refresh_required`，下一 Model 重新选择；模型准入的有限刷新也同时重建 tools。已派发 Job 的 scope、来源和实现保持原绑定。定义版本负责标识实现，宿主负责让整个 Run 的 disposer 保留所有在途 Step 注册资源；Query/历史读取不调用该回调，回调不能建立连接或执行工具。

Core 只依赖中立 `ArtifactContentStore` 端口；Tool/Action 以当前 execution 与稳定 key 发布，Query/prepare 只能读取原 subject/scope。终态声明的 Artifact refs 必须再次核实实际 Store、scope 和元数据；效果发生后伪造引用保留未知结果。真实内容下载由 Service/Client 的二进制协议负责，不通过 renderer 路径或 hash 自授权。

显式 `resumeRun` 接续仍活动的同 Store 根 Run，支持原 `run.start/input.follow_up` 的三个持久边界：原 Model 派发前、完整 Model 的工具序列、完成判定。只读 `verifyRunResume` 核原身份和安全状态，再通过独立 `RunResumeLease` 封存检查点；准确重建原配置并复核选择、取消与 generation 后，才转成普通 owner，进入同一个 `executeRun/defaultLoop`。HTTP 的 generation 由 Service 内部派生，Core 可信入口仍要求准确 CAS。原 planned Model 使用完整封存请求，原 planned Tool 保留执行身份与审批，已完成调用跳过；完整无工具回复进入完成门禁，不重复询问 Model。原 Model 输入/输出及大正文都从原作用域完整核验，不用预览重建参数。

Run 保存 `initializationState:unstarted/started/completed` 和原 `contextSelectionId`；完成初始化即使没有 requirements 也不重跑，冷 started 阶段不能重放任意回调。可能已经派发的未决工作、child、runless 闭包、部分 Model 与无法精确重建的配置明确拒绝。独立 `run.resume` Command 保存 accepted/null 或 applied 的有限回执，同 ID 不重复解析或派发；普通调度与恢复清扫不把该申请当作新任务。准备期取消和关闭在交接前复核，清理失败保留资源与 Store，不报告假关闭。真实强杀、完整 80KiB 正文、原审批、当前输入和清理反例见 [Runtime 接续测试](test/isolated/recovery/run-resume-runtime.test.ts)与 [Store 事务测试](test/isolated/recovery/run-resume-store.test.ts)；此范围不代表任意旧执行可恢复。

显式 `recoverSession(decision='interrupt')` 取得原 Session OS 锁并 fencing，原子中断遗留 Run、保留 partial 和原执行来源。可证明未派发的同 Store 计划取消；可能产生效果的工具/Job 保持 `outcome_unknown`，不会重做启动。该入口不返回普通执行 owner，未知仍限制该 Session；其他 Session 可继续。已有持久根报告的显式冷恢复由 `resumeJobReport` 和专门 `resolveRecoveryRunConfiguration` 负责，详细资格与生命周期见 [Task owner](src/extensions/task/README.md#task-的-after_turn)。外部 adapter 的显式核实见下方“显式 Job 外部核实”；原适配器必须提供可靠查询能力。离线备份恢复由 maintenance owner 单独负责。

Job 输出与终态分开保存：单 chunk 32 KiB，内容的 JSON 编码与固定行开销共用 1 MiB 保留预算；每 stream 至多一个合并丢失区间。生产方主动丢弃只关闭该 stream 的保留尾部，其他 stream 仍可使用剩余总预算；任何丢失与总预算耗尽分别记录。独立 64 位高水位不依赖输出行是否保留。每页先确定最多 200 条正常行的上界，再合入与该页相交的至多三条 gap；裁剪区间返回准确 `throughSeq` 和无法精确归属时的 null 字节量。跨 stream 的 gap 可以重叠并包含别的 stream 正常行，消费方保留各条事实并以本页最大 `throughSeq` 推进。纯读取不写回截断结果，终态不受输出预算限制。

当前资源支持 Runtime/Session 单串行键与单类别槽位。显式 Workspace 后端用稳定 profile 协调区覆盖同 profile、同 Workspace 身份、同 key 的多个 Service；未注入后端时 Workspace 请求仍明确拒绝，不宣称不同 profile 对同一磁盘目录全局互斥。后端等待数与字节有界，取消移除候补；close 拒绝新申请、取消候补并等待活动许可正常释放，期间保留 profile 使用锁，不提前释放执行许可。持有资源的 Action 不能再嵌套获取子操作许可，明确返回不支持。Shell、child、Interaction、输入与结果选择已通过所列本机切片；完整权限/计划/Context、默认 MCP、备份维护、全量客户端与三平台发行资格继续按进度表推进。

Runtime/Session 的 [串行资源 owner](src/execution/resources.ts)只保留仍有 holder 或 waiter 的原 Semaphore。最后许可归还或没有取得许可的取消结束后，核空闲和 Map 中的原对象身份再删除键；handoff 继续保留预留许可，迟到重复 release 不能删除同 key 的新 owner。serial→slot 获取和逆序释放保持，未确认 Job 仍保留其原 permit。

[真实串行资源回归](test/isolated/resources/serial.test.ts)沿公共 Runtime／SQLite 完成普通 Tool 的完整结果、第二 Run 取消后的原 unknown 事实和冷只读原 View／metadata／cursor，另用同一原 owner 核排队取消、独立键、handoff、旧 release 与新 owner。空闲索引归还不代表原 RSS 或整个 Runtime 资源资格。

必要义务由[requirements owner](src/storage/sqlite/requirements/README.md)负责持久登记。普通 Tool 只能在自己的 namespace 和实际 Run 追加 refs；可信 initializer 在首个 Execution 前使用 `forExtension().records.create` 建立有界的不可变元数据，再由 Store 封存原来源。首个计划执行即关闭该创建窗口。派发与完成读取持久的当前 refs；后台 Job 保留创建时快照及原 permissions/conditions lease。原 Store seal、准确记录 revision 与 satisfied/waived 判定是必要条件，未封存或缺实现不能靠兼容路径放行。

`NecessaryConditions` 获得准确当前 boundary 和有限的 `forRequirement` 只读范围。关联 executable 记录的读取或缺失自动形成 CAS read-set，最终事务核对原 namespace、Session、revision 和 Store；业务判定文字不能代替这些事实。公开 Execution 证明包含原身份、attempt、定义、input digest、result revision 和实际决策来源的 id/digest，不包含 owner 或来源正文。已接纳的 question/plan_review 可返回准确原 receipt，并可从同 Session 的只读 Interaction 核实；信息决定不能充当 Tool approval。

`Extension.context.capture` 只接收本 namespace 的只读投影，来源 ID 必须属于该 Extension；Core 强制将其作为 `user` 数据加入实际模型输入。显式宿主项目指令仍保留自身放置位置。来源身份、格式和数量在 Model I/O 前检查，大正文通过准确 scope Artifact 完整交接，传输阈值不裁剪实际来源；变化使旧 Tool 决策失效，下一 Model 才取得新来源。Query 和普通历史读取不会调用贡献回调、模型或工具。

## 验证

可信宿主的有限 Runtime 生命周期入口见[lifecycle owner](src/lifecycle.README.md)：同步实际 busy 检查与 `if_idle` 封门、原实例取消/drain、同一关闭完成 Promise，以及 Service 在最终资源关闭前的排空回调。纯观察不制造 busy；未确认 Job 或清理失败保留真实 handle/permit 与 Store/profile 资源，不宣称成功退出。该入口不实现 daemon 发现或第二个任务管理器。

[真实两进程闭环](../../tests/isolated/unified-agent/persistence.test.ts)将外部计数工具编译到临时独立目录，执行后关闭进程，新进程只读查同一结果且计数不增。固定模型与无害计数器不调用付费 Provider。存储测试位于[test](test)，架构检查通过 `bun run check:unified-agent-boundary`。

[独立未见 label-station](../../tests/isolated/unified-agent/evolution-unseen-sample.test.ts)以公开 `extensions`、Runtime、SQLite/Store 入口注册普通 Tool/Action/Query，自有 resource 和 namespace CAS 回执，不修改 Loop/Session/schema/router。源码外真实通用 UI 点击、HTTP、受控 Tool 两次效果、读回与再次操作1项67断言通过，Action/Tool 拒绝均零效果、Model/Run为零；12个列明核心/公开基线 hash 保持原值。独立包声明依赖，测试使用已安装 npm 模块而非新 npm 安装；本机有限 E01/E02/E03/E14 的 Evolution Record、原 ID 和未验证范围归[当前进度](../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-04mcp-冷原申请备份-v8-与未见扩展样本)，不把它作为全部演进或发行资格。

[授权审查回归](test/isolated/execution/authorization-review.test.ts)使用真实 SQLite 与固定模型核实单次批准、无效输出/失败人工回退、策略及来源变化零效果、精准取消、资源内禁止等待、单子 Agent 槽位内审查和冷 planned 事实只读；冷读取证明不自动派发，不代替真实进程强杀恢复资格。

真实强杀探针和显式中断测试位于[test/isolated/recovery](test/isolated/recovery)，来源与重新准备位于[test/isolated/context](test/isolated/context)。跨平台、实际安装制品、外部 adapter 核实窗口与完整客户端资格分开记录；局部测试通过不代表整个重构已完成。

[完整包制品回归](../../tests/isolated/unified-agent/built-package.test.ts)按实际manifest同次构建当前24个公开入口及其运行资产，准确核全部key→built路径；新增 `sqlite-engine` 提供宿主固定引擎选择，`windows-path-security`提供惰性Windows私有路径leaf，不由本机import推导Windows syscall资格。源码树外实际运行Worker/SQL、Shell、文件、Skills、MCP guardian、默认web_fetch解析Worker与完整Artifact及Service/Client认证读取；外部npm复用已安装模块，不代表独立安装或三平台发行。新增 ask-user 入口后本轮1项63断言通过，含公开Workflow编译器、输出schema、原skill-workflow.jsonc字节/摘要和准确无Desktop manifest v5的备份恢复。自建stdio生命周期先核default恰有一个同id再显式替换，其他default extensions保留；重复定义拒绝不放宽。原child20s/test30s期限、全部源外消费者与guardian无源码fallback保持。旧21入口/54断言只属于当时窗口，相关红日志保留。

此前加入 maintenance 的18入口1/48与 profile-access 的19入口1/49只证明当时范围，包含v2原配置字节/摘要、原媒体/Store出处和新Store核对，零额外业务执行。源文件变化按Worker严格关闭SQLite缓存语句修复；恢复后 Artifact 读取曾混用当前 Store 与原来源，现分别校验当前 Store 准入、完整原执行链与原引用。当前源码外包继续通过实际 HTTP/Client 在新 Store 读取原 Artifact 全文，保留原 Store/hash/字节，冷读取零 Model。


持久 mode/trust 权限决定使用有限 `controlReads`，不能只在宿主 authorize 时读取。真实 original subject、root Session、Workspace 和当前 Store 由 Execution/Command 派生，最终 markDispatching 同事务核对 session mode、user default 和 workspace trust 的准确 revision；审批和自动 review 返回必须保留这些 proof。批准后撤销或更新会在 adapter 前拒绝，不能由 human approval 擦除撤销资格。`getSession` 提供有限只读 Session 查询，权限范围读取不需拉取完整历史。事务入口与 journal 说明见[宿主控制 owner](src/storage/sqlite/host-mutations-README.md)。

公共入口在 manifest 的同一次 Bun build 中使用 `--splitting` 共享领域类定义。SQLite leaf 从 Worker 回执重建的 `AgentError` 必须与根入口、storage 入口相同，否则 Service 的实际类判定会把 `command_conflict` 错投影为通用 503。完整包测试从源码树外核构造器身份、真实 Worker 错误和 HTTP 409，并继续实际执行 Worker、Shell/MCP guardian、Web parser 与备份，验证共享 chunk 后资产定位仍正确。此构建修复不以错误对象自报 code 放宽识别，也不代替正式发行资格。


## 显式 Job 外部核实

`reconcileJob({expectedStoreId,commandId,subjectId,sessionId,executionId,expectedResultRevision})` 以根 Session 为公开范围，取得独立、固定原 Job 的恢复 lease 后查询原适配器。`JobDefinition.recovery` 声明非秘密恢复配置与版本，Core 在实际派发前封存 adapter/extension/schema/resources/配置；缺原关联、缺 manifest 或原实现不能复现时局部不可核实，不调用 start。静态注册定义可精确比对，动态定义只能由专门 `resolveRecoveryJobConfiguration` 恢复；该工厂不替代普通 Run resolver，也不创建模型。

可信 `authorizeJobReconcile` 默认缺省拒绝，在恢复工厂前及实际查询前核当前权利；它批准的是新核实命令，不复用旧 Interaction、grant 或旧 Job 的派发批准。适配器只获得原关联与只读原执行身份/input，不获得 operations 或执行能力。结果分别说明实际业务事实及原外部任务监督是否结束；查询失败、仍运行或未知不能当作未执行。

核实追加独立 `job.reconcile` Command，原 Execution 的 status/result/resultRevision 和已有 Context 引用不改写。只有准确原 revision 的已知结果与 ended 监督证明共同成立，才解除这个 Job 对普通 owner 的阻挡；其他 unknown、Fork/Rewind 的独立门禁保持。旧 pending delivery 标为 suppressed/explicit_reconciliation，防止下一轮自动消费旧未知结果；已消费历史保留，不启动旧 after_turn。重复原命令只读回执，查询中或崩溃遗留 accepted 不自动再次查询，也不进入普通 Run 调度。精确取消新核实命令会中止它自己的查询等待；原 Job 的取消历史不因此改变。

Store 的锁与事务见[存储 owner](src/storage/README.md)。[Runtime 实测](test/isolated/recovery/job-reconcile-runtime.test.ts)与[真实强杀子进程](test/isolated/recovery/job-reconcile-crash-child.ts)分别验证冷 ledger 查询、权限/版本/关闭反例和实际崩溃；不代表 Shell/MCP 已具备冷核实或任意 Run 恢复完成。

## 宿主观察资产与文件恢复原语

[维护 owner](src/maintenance/README.md)保留 strict manifest v5 的完整 ordinary caller 文件与准确 Desktop DB3；实际包含独立 `ui/file-recovery-intents.json@1` 或 Desktop DB4 时使用 closed v6。DB4 只在原四表上增加准确 `file_recovery_intents(intent_id,state)`，所有旧格式的字段、SQL 和物理白名单保持原契约。ordinary caller 的原 PK/scope/subject/phase/draft、完整 body/request SHA 和文件恢复两 leg 的准确 Core SHA/全局 Command 唯一分别验证；内部坏结构或非法 UTF8 不能由重算外层 proof 掩盖。恢复生成新 Store 保完整原请求、point、Plan/draft、scope 与各自 phase，不取得热 permit、不自动 POST。本机当前新资产 4/67、完整六文件维护 51/677 分别通过，包含真实 Node DB4 冷读零 HTTP 与既有实际 SIGKILL 窗口；详细证据见 owner。`profileComplete:false`、跨介质非瞬时原子、凭据/vault 排除与完整平台/安装资格的边界保留。

准确 Desktop DB5 的整份一致人类答案资产使用 closed v7。实际存在独立 MCP 选择 journal 时使用 closed v8，继承原资产并新增准确 `mcpSelectionIntents`；Agent 自有 codec 独立核完整原请求、Store/subject/read-set、两 SHA、phase 与128/16MiB，不依赖 CLI/UI/Client。恢复保原完整字节与身份，冷 reader foreign Store 零 HTTP，不授予 POST/readproof。新资产4项99断言、当前完整维护8文件59项850断言通过，包含 DB5/v8 和旧版本邻接；真实 Port 的同 Profile 冷 receipt 查回由 CLI owner 另验，Node 纯 codec reader 不替代它。完整契约见[原 MCP 资产 owner](src/maintenance/README.md#mcp-选择意图的独立离线资产)。

[会话日志](src/storage/sqlite/session-logs.README.md)由现有 change_event 的私有有限 envelope 记录当时 metadata，原公开 payload/SSE 不变。`@kite-ai/agent/storage` 提供有限 `readSessionLogs`，精确原主体和 Store/Session，固定 Decimal64 上界；observer AbortSignal 不进入 Worker，也不取消业务。实际原 Model 导航只验证现有 immutable binding，不读取全文或授予权限；Core 最后 subject 三文件 14/231 与原邻接/恢复媒体证据分开记录，HTTP/SDK/UI 各由其 owner 提供消费资格。

[Files](src/tools/files/README.md)公开可信完整`readBytes/restore/remove`，保原Workspace、finite maxBytes与发布后unknown。独立[checkpoint leaf](src/business/file-checkpoints/README.md)捕获原preimage/Model消费边界，跨Fork保存完整业务snapshot并通过通用private readonly来源核未选后像；restore v2保存实际新inode与逐文件effect ledger，旧v1只读不回填。Core不识别Files ID，仅提供通用group/context/records/projection最终SQL约束和actual Run派生的[原selection观察](src/storage/sqlite/context/README.md)。默认跨Fork、A→B和同Session selector变化、Web有限只读均有实际资格；CLI/TUI/Native三个恢复范围与组合unknown caller继续实施，不能用底层手动组合替代产品交付。
