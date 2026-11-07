# Plan 审阅与进度业务叶子

2026-11-07 本次差量验证：Planning 动态登记、Worktree 只读条件及进度三个整文件30项／323断言，Service per-run／child／successor三个整文件12项／202断言通过。信息接纳、SQL安全、Interaction及必要条件四个整文件53项／973断言通过。真实 `gpt-6-luna/medium` 的13场景经原 Service／HTTP／SQLite／native Shell 通过，15个实际 Run completed、原行与效果冷读相同、零 Provider 重放；详见[模型验证入口](../../../../../tests/e2e/live/model/README.md#计划业务人答与当前工具权限)。早期模型误用 shell_id 的 failed 保留，客户端实际过程与非本机平台资格由对应 owner 分列。

业务人答与工具权限分离的持久取舍见[设计决定](../../../../../.agents/notes/implemented/architecture/2026-11-07-extension-initiated-business-approval.md)。当前产品合同归[计划手册](../../../../../docs/handbook/features/planning-and-tasks.md)，客户端过程与平台资格按对应实际证据分列。

默认 Service 通过 [PlanFiles](files.ts)保存 `<profile>/files/<SHA256 Store>/<SHA256 Session>/plans/<SHA256 plan ID>/plan.md`。普通文件编辑由精确目标适配器通过已有 `invokeActionFromTool` 调用 `planning.write`；不扩展通用嵌套工具调度，也不全局放开写工具。原业务门禁与必要条件均重新核真实执行输入及准确目标，独立文件权限仍生效。

Planning 先持久保存 publication pending，再发布文件、不可变版本和 `plan.current` CAS，最后标记 committed；未完成时阻断批准和新效果。同一预期版本与内容可查回／完成原发布，不以重试提交不同正文。pending 恢复只验证原正文已完整发布；若文件又有外部修改，保持 pending 和实际字节，不自动覆盖或据此批准。已完成发布后的显式外部修改恢复可使用 `fileBase`，必须是刚读取的完整原生基线，null 仅创建缺失文件；保存新版本不继承旧批准。当前上下文明确 `fileState`，外部漂移可能先使旧模型来源失效，刷新后再读取、编辑。审阅前后及实际派发都核文件与原版本，迟到答案不能掩盖漂移。

文件已成功发布后，后续版本／指针记录即使以已知 CAS 冲突失败也保 `outcome_unknown`，明确已有发布、须核原操作与当前计划，不能当作未写入后重投。无文件发布的普通 CAS 拒绝保持原失败语义。Plan 文件适配器在委派写入完成后的读取失败、内容不符或取消同样保未知。[Plan 文件回归](../../../test/isolated/business/planning-files.test.ts)与[写后读取回归](../../../test/isolated/files/plan-file-feedback.test.ts)核真实已写字节、原竞争冲突与禁止重复写入说明。

同一会话切回此前的 Plan ID 时，从当前准入的 Planning 命名空间分页读取该 ID 的不可变正文，按数字版本选择不晚于当前版本的最新记录，并核对记录身份与正文摘要。沿准确旧文件登记核实际字节和完整原生基线，再发布新的全局版本；当前方案及目标旧文件的外部漂移在新 pending 之前拒绝。文件继续绑定原 Session／Plan ID，新 Store 恢复后保留原 Store 目录；不因文件存在接纳任意路径或继承旧批准。

Plan 原记录和历史审阅正文不随当前文件变化；恢复保留实际字节，不从旧记录覆盖新文件或恢复批准。新 Store 经独立权限设置后的实际读取与编辑证据归[维护 owner](../../maintenance/README.md#会话工作文件与-manifest-v20)，客户端与发布范围沿 [Desktop](../../../../../apps/desktop/README.md)及 [Terminal](../../../../../apps/cli/docs/terminal-release.md)分别核对。

2026-10-23，`ba34a2e6d` 加本次会话文件工作树、Windows x64／Bun1.4.3：[默认 Service 隔离回归](../../../../../apps/service/test/isolated/planning-configuration.test.ts)通过真实 SQLite、Artifact、文件工具及受控兼容 Provider 验证：v1 批准后，普通 `read_file`／`edit_file` 形成 v2，旧批准保留为历史，项目写入在 adapter 派发前被 `plan_approval_required` 拒绝；独立批准 v2 后实际写入与 progress 成功，共15断言。

同一回归在物理 Plan、不可变版本和 current 已保存后，精确注入首次 publication committed 的 SQL 写失败。原调用保持 unknown、publication 保持 pending，后续审阅不产生可答交互、项目写入零派发；显式同版本同内容重试完成原 publication，文件 inode／size／mtime 不变，独立审阅后才能执行。另分支在重试前修改实际文件，确认外部字节、pending 和原 unknown 均保留，不产生新版本或批准。该故障用例35断言通过，只证明同内容确认与外部变化保护，不宣称 pending 外部漂移可自动修复。

[Plan 文件回归](../../../test/isolated/business/planning-files.test.ts)通过真实 Runtime／SQLite 和原生文件引擎覆盖跨 200 项记录页及数字版本选择、旧 ID 复用、原 Command 重试、外部漂移，以及新正文已发布后的版本记录／committed 写失败、准确恢复和原 unknown 保持。上述默认 Service 回归另核 A→B→A 后原审核正文保持、旧批准不能派发写入、新版本独立审核后才能执行，以及新 Store 恢复后切回旧 ID 仍沿原文件路径。测试使用隔离数据与受控模型，不扩展客户端或发布资格。

模型工具保留 `read_plan`、`write_plan`、`request_plan_review`、`update_plan_progress`。五个 validation 工具、自动 mutation 检查、强制验证义务、checker 与 waiver 执行实现已退役；普通 Shell 测试与真实执行回执继续使用原权限和结果合同。历史记录格式和旧管理回执识别保留，不恢复执行入口。

模型入口由 `read_plan` 返回准确 `plan_ref/progress_ref`，write使用 `expected_plan_ref`（省略只允许无原计划的首次创建），review仅携plan_ref，update携plan_ref/progress_ref。引用定位原成功回执的版本／摘要与进度修订，不包含批准；进度另核当前真实Run，显式模型run_id拒绝。完成或补偿在公开Schema要求execution_id。file_base_ref只用于原计划文件的明确外部变化处理，null保缺失文件创建恢复。内部函数和用户Action的显式Run／版本／摘要合同保持，原记录CAS及批准核验继续执行。

`createPlanningValidation` 显式装配 ordinary Tools、用户 Actions、只读 Query、必要条件 evaluator 与 Run initializer。import 不读文件、不启动 Model/进程。默认未启用计划或 required 验证，普通对话可以直接完成；默认 Service 装配由 Service owner 接入，本叶子的存在不代表正式 UI/默认入口已迁移。

实现使用[公共扩展端口](../../extensions/index.ts)，没有 SQL、Provider、旧 Runtime 或第二 Loop。`requirePlan` 登记 dispatch/completion 义务；`requiredValidation` 登记 completion 义务。`initializeRequirements(input, policy?)` 由可信宿主调用：`policy.requirePlan=true` 仅对原 Run 单调加强，false 不削弱工厂已有要求；`readOnlyDefinitions` 仅接受宿主实际装配并确认只读的 `{kind:'tool',definitionId,definitionVersion}`，封存为准确 Run 的不可变集合，模型输入/JSONC/远端 annotation 不取得此接口。未批准时只允许 Model、原管理 Tools 与准确封存的只读 Tool 派发；只读父 Tool 的普通 Job/child 仍独立受计划门禁，Full 不能绕过。initializer 在首次执行前创建 `run/<actualRunId>/...` 不可变 executable 记录，再由 Core 封存准确 Session/Run/原 Store。关闭后续配置或缺少 evaluator 不能删除已登记要求。

每个 Run initializer 都封存 `run/<actualRunId>/planning.policy` 及宿主核实的只读定义；只有该原 Run 准确登记的 `plan.required` 才激活本地门禁。普通保存计划不触发人批。`planning.review` 在展示请求前沿原 `requirements.register` 单调登记实施门禁，拒绝或修改后仍不能派发实施效果。继承的父 requirement 继续由父作用域核验，不伪造为子 Run 自己的要求。

动态登记只允许当前 Tool continuation 在真实 Run/Execution/attempt/call/step、namespace 和新增原 Run ref 全部闭合时，重新捕获该 owner 原有同身份 `runtime_state` 的门禁状态。原持久 decision source、兄弟调用和没有新增 ref 的登记不能重绑；计划正文、文件与批准证明使用独立 `planning` 来源并保持准确匹配。[计划回归](../../../test/isolated/business/planning.test.ts)覆盖登记后的批准、拒绝与真实效果；来源变化仍须拒绝，不能靠多一次模型往返规避实现接缝。

通用 [createBusinessPermissionPolicy](../../permissions/constraints.ts) 将实际 `current` 与 Planning owner 的 `gate` 组合为 `builtin.business.permissions`。只有 current 提供执行范围；gate 只表达业务条件，不保存批准后的 mode ceiling。所有模式都要原计划人答；批准后工具沿当前实际权限。旧冻结 `builtin.planning.permissions` binding 不转换为新合同，旧 Run 的续作沿原配置匹配明确拒绝，原 request/answer/proof 只读保存。

## 计划与真实来源

`planning.write@1` 保存不可变正文版本及 CAS `plan.current`；`planning.read@1` 读取；`planning.review@1` 审阅准确 ID/version/digest，保存真实 accepted informational receipt。写入与审阅是两次独立调用。批准保存 `run/<actualRunId>/approval/<planId>/<version>` 不可变记录，核对原 accepted Interaction、批准 Execution 的实际 Run/Session/Store 与当前完整 plan digest；同 Session 后继 Run、旧版计划、旧答案或 runless 用户 Action 不能取得后继 Run 批准。不再写入无人消费的 `approval/<planId>/<version>` 副本；`approval.current/...` 仅用于上下文投影，不是派发 grant。批准不授予 Tool 权限，所有调用继续经过宿主 Permissions。正文、标题须非空、step IDs 唯一，不添加旧的 30,000 字/12 步/replan reason 长度产品限制；持久记录及公共 frame 的现有有限传输边界仍适用。

扩展的纯 `context.capture` 自动贡献当前计划与批准凭据的 canonical 数据，来源 ID 为 `builtin.planning:<session>:<plan>:<version>`，摘要覆盖完整当前计划和批准身份。贡献仅在记录指向的实际批准 Run 仍 active、同 Session、Run 专属证明与 accepted Interaction 全等时显示批准，否则 approval=null，不从 input 或模型猜目标。计划资料标为 `user/after_history`，不获得 system 权限。`sourcesFor` 是需要显式宿主组合时的同一贡献实现，不应再重复装配同一来源。

内部 `SourceRequest.runId` 由 Core 以实际当前 Run 覆盖。`captureModelContext` 核实际 Run／Session，再复用 `readPlanningState` 的原记录与批准证明，以 `user/runtime` 来源的 `plan_requirement` 提供准确批准要求与当前结果；`disabled/pending/approved` 是计划要求的状态，不定义 Agent 的运行阶段。准确当前版本和摘要已批准时，同一来源指导继续获批范围内工作，不再通过普通问题或再次 review 重复请求同一实施同意；实质新选择、目标、版本或摘要仍按各自规则处理。该指导不授予独立工具权限，不跳过最终核验。无 Run 的既有来源捕获只提供计划资料。动态观察与静态 Agent 合同分开，普通请求、压缩和展开复用[同一组装](../../model-context.ts)，不增加 grant 或替代最终 record read-set、审批与派发门禁。

历史 receipt 校验独立于当前信息贡献：`matchesPlanSource` 从实际 Execution 的原 Session/Store/Run（runless Job 沿既有限父链）读取当前完整计划与该原 Run 不可变 accepted 审批，复用同一纯 canonical payload 重建执行时来源 digest。原 Run 已完成不会让准确原 receipt 失效，但不会恢复 inactive Run 的普通批准贡献；新 Run 不沿用旧审批，plan/head/accepted proof 或封存执行来源变化仍拒绝。同 Session 派生报告继承原 plan.required ref 后不能借原 Run 的待审批 Model 管理豁免，最后 completion 重读完整原计划、审批、progress 和原 receipt；这些 record 继续进入最终事务 read-set CAS。

审阅 request 保留公共面板的 string version、准确 plan digest，不含 `allowedModes`。实际 canonical request 不超过现有 Interaction 32 KiB metadata 预算时继续 inline 完整 `content`；超过时只改变传输方式：完整 canonical plan 由公共 ArtifactWriter 发布到原 review Execution scope，request 的 `content` 明示正文在完整附件，`policy.review={kind:'artifact',complete:true,reference,...}` 保存准确原 scope ref、完整 size/hash/contentVersion、原 Store/Session/Run/Execution、plan digest 与 plan record revision，不截断或把字数变成业务上限。

这里的 `policy.review` 名称沿用既有 generic complete-Interaction attachment 消费协议，只是信息附件，不是授权 policy/grant。SDK `interactionAttachment/readInteractionAttachment`、CLI stdio、TUI、Desktop 与通用 UI 已有完整读取/hash/EOF 与未读取不得提交的公共接点；本叶子不修改客户端或另建 HTTP 路径。小计划 request 与回答保持原格式。

叶子在 `review.body/<actualExecutionId>` 保存不可变封存记录。request 前与接受答案后均通过原 scope 公共 reader 读取到完整 EOF，核 size、SHA-256、fatal UTF-8 与完整 canonical plan 全等；不能把 ref/hash 当已经阅读或当权限。原 accepted proof 仍须绑定同一精确 request 与实际 Run 批准 Execution。最后条件/`readPlanningState` 不取得物理文件或 SQL：重读完整原 plan 和 seal、核原记录 revision、原 scope、完整 hash/size、accepted Interaction 与 Run proof，收集最终 record read-set CAS。已接受的人类阅读事实不把外部文件修改与 SQL commit 冒称原子；物理正文损坏在实际读取边界拒绝，封存记录或 plan 在最后读后漂移则在 SQL 派发/完成事务拒绝。

完整 plan 仍保存在既有 record；当前没有单 record 业务正文限额，但 SQLite Worker 保留既有 queuedBytes/pending 资源准入（普通队列 14 MiB/224、关键队列 16 MiB/256），不因本叶子扩大。真实资格覆盖超过 300 KiB 的 UTF-8 与 JSON escaped 大正文写入、原 Artifact 完整审阅、批准状态和真实 step receipt 完成；不宣称超过既有队列/平台容量的无界传输。贡献中的批准摘要仍只保留 decision identity/answer，不再次复制审阅附件正文。

当前步骤进度由 `read_plan` 从原 `progress/<plan>/<version>` 记录读取；压缩后若进度已不在模型窗口，静态合同指导模型先核当前进度，再选择剩余步骤。进度不混入稳定的计划来源或批准摘要，避免同批步骤更新使普通后继工具刷新失败，也不使先前成功 receipt 随进度变化失效。[进度观察与批准事实](../../../test/isolated/business/planning-progress-view.test.ts)核准确要求、无阶段投影与进度变化后的稳定来源；[计划执行回归](../../../test/isolated/business/planning.test.ts)核同批普通工具及后续进度仍可引用原成功 receipt。该指导不等同于自动注入全部进度或保证模型永不遗忘。

`planning.update@1` 要求准确当前 ID/version/digest、Run、step 与 progress revision。完成步骤必须引用该 Run 真实成功 Tool/Job 的原 Store、attempt、定义版本、input digest、result revision，并匹配该执行真正捕获的当前计划来源 ID/digest。Model 文本、计划/验证管理 Tool、旧 Run 或旧计划成功回执不能替代。完成候选需要全部 step 完成、当前批准和原计划义务；Core 最终仍重新读取相关记录并事务复核。compensated 保存原 receipt 与补偿 receipt，不成为 passed 或完整计划完成。用户 `planning.write/review/update` Actions 共用业务函数但有独立 Command 身份；活跃 Run 的同 Session Action 按当前串行队列等待，不能假装它已并发修改当前工作。

`planning.review` 的批准与修改结果保留 `status`、原 `decision` 及存在时的完整 `feedback`，交给下一次 Model；批准不保存执行模式或派生局部权限上限。修改仍为 `not_approved`，Model 按反馈另调用 `planning.write`，新版本须独立准确审核，旧批准不随之移动。准确 accepted `deny` 返回简短中文拒绝说明，details 保原 `not_approved/deny/feedback`，由扩展主动给出通用 `control:{kind:'stop_work'}`。Core 保存原成功 Tool 及消息时，在同一事务复用原取消逻辑结束准确 root work；不再调用后继 Model、重复请求审批或执行计划。拒绝不保存批准、不自动增加版本，后续新消息独立处理。[实际 SQLite/Model 回归](../../../test/isolated/business/planning.test.ts)核原反馈驱动 v2、两版本批准前零写入、deny/空 revise 原值、非法 mode 新答案不被接纳，以及原 Run 证明和最终 CAS。已派发适配器在取消后没有可核结果时继续遵守 Core 的 `outcome_unknown` 合同，不因这条信息反馈路径改报 cancelled。

启用 completionGuidance 时，未批准草稿的提示 key 使用准确原 requirement 和 `plan.current` revision；同一事实的继续提示由 Core 按原完整投递事实去重。没有主动停止而原必要条件仍不满足时，Run 按原条件失败收尾，不自动批准或无限续答。准确计划拒绝先走上述停止合同，不再进入完成纠正；要求修改与新计划版本仍沿原入口处理。


Shell 检索在计划批准前仅接受宿主核实的单个字面只读命令（内置 rg、固定 ls、pwd），拒绝重定向、展开、包装器及 rg 外部执行钩子；实际执行改用固定资产并关闭 rg 配置。Tool 和其普通 Job 分别核原输入摘要与当前权限，不能把整个 Shell 定义标成只读。

`git_worktree` 是混合工具，不进入静态 readOnlyDefinitions。批准前的list由同一现有dispatch必要条件的可信Host回调动态核定：Planning先核真实Execution的Session/Run/attempt/定义和原input SHA，Service再核准确builtin.shell owner/version、原父Tool、封存与当前可信资产以及规范化list命令。仅dispatch的原计划可豁免，create/remove、completion和继承续接不获额外资格。[定向回归](../../../test/isolated/business/planning-git-worktree.test.ts)核正反边界，[Service真实链路](../../../../../apps/service/test/isolated/git-worktree-permissions.test.ts)核待批准计划下list成功而create变更前拒绝；普通Shell检索与原计划批准规则保持。
