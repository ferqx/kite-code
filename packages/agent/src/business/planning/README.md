# Plan 审阅与进度业务叶子

默认 Service 通过 [PlanFiles](files.ts)保存 `<profile>/files/<SHA256 Store>/<SHA256 Session>/plans/<SHA256 plan ID>/plan.md`。普通文件编辑由精确目标适配器通过已有 `invokeActionFromTool` 调用 `planning.write`；不扩展通用嵌套工具调度，也不全局放开写工具。原 Plan ceiling 与必要条件均重新核真实执行输入及准确目标，独立文件权限仍生效。

Planning 先持久保存 publication pending，再发布文件、不可变版本和 `plan.current` CAS，最后标记 committed；未完成时阻断批准和新效果。同一预期版本与内容可查回／完成原发布，不以重试提交不同正文。pending 恢复只验证原正文已完整发布；若文件又有外部修改，保持 pending 和实际字节，不自动覆盖或据此批准。已完成发布后的显式外部修改恢复可使用 `fileBase`，必须是刚读取的完整原生基线，null 仅创建缺失文件；保存新版本不继承旧批准。当前上下文明确 `fileState`，外部漂移可能先使旧模型来源失效，刷新后再读取、编辑。审阅前后及实际派发都核文件与原版本，迟到答案不能掩盖漂移。

同一会话切回此前的 Plan ID 时，从当前准入的 Planning 命名空间分页读取该 ID 的不可变正文，按数字版本选择不晚于当前版本的最新记录，并核对记录身份与正文摘要。沿准确旧文件登记核实际字节和完整原生基线，再发布新的全局版本；当前方案及目标旧文件的外部漂移在新 pending 之前拒绝。文件继续绑定原 Session／Plan ID，新 Store 恢复后保留原 Store 目录；不因文件存在接纳任意路径或继承旧批准。

Plan 原记录和历史审阅正文不随当前文件变化；恢复保留实际字节，不从旧记录覆盖新文件或恢复批准。新 Store 经独立权限设置后的实际读取与编辑证据归[维护 owner](../../maintenance/README.md#会话工作文件与-manifest-v20)，客户端与发布范围沿 [Desktop](../../../../../apps/desktop/README.md)及 [Terminal](../../../../../apps/cli/docs/terminal-release.md)分别核对。

2026-10-23，`ba34a2e6d` 加本次会话文件工作树、Windows x64／Bun1.4.3：[默认 Service 隔离回归](../../../../../apps/service/test/isolated/planning-configuration.test.ts)通过真实 SQLite、Artifact、文件工具及受控兼容 Provider 验证：v1 批准后，普通 `read_file`／`edit_file` 形成 v2，旧批准保留为历史，项目写入在 adapter 派发前被 `plan_approval_required` 拒绝；独立批准 v2 后实际写入与 progress 成功，共15断言。

同一回归在物理 Plan、不可变版本和 current 已保存后，精确注入首次 publication committed 的 SQL 写失败。原调用保持 unknown、publication 保持 pending，后续审阅不产生可答交互、项目写入零派发；显式同版本同内容重试完成原 publication，文件 inode／size／mtime 不变，独立审阅后才能执行。另分支在重试前修改实际文件，确认外部字节、pending 和原 unknown 均保留，不产生新版本或批准。该故障用例35断言通过，只证明同内容确认与外部变化保护，不宣称 pending 外部漂移可自动修复。

[Plan 文件回归](../../../test/isolated/business/planning-files.test.ts)通过真实 Runtime／SQLite 和原生文件引擎覆盖跨 200 项记录页及数字版本选择、旧 ID 复用、原 Command 重试、外部漂移，以及新正文已发布后的版本记录／committed 写失败、准确恢复和原 unknown 保持。上述默认 Service 回归另核 A→B→A 后原审核正文保持、旧批准不能派发写入、新版本独立审核后才能执行，以及新 Store 恢复后切回旧 ID 仍沿原文件路径。测试使用隔离数据与受控模型，不扩展客户端或发布资格。

模型工具保留 `read_plan`、`write_plan`、`request_plan_review`、`update_plan_progress`。五个 validation 工具、自动 mutation 检查、强制验证义务、checker 与 waiver 执行实现已退役；普通 Shell 测试与真实执行回执继续使用原权限和结果合同。历史记录格式和旧管理回执识别保留，不恢复执行入口。

`createPlanningValidation` 显式装配 ordinary Tools、用户 Actions、只读 Query、必要条件 evaluator 与 Run initializer。import 不读文件、不启动 Model/进程。默认未启用计划或 required 验证，普通对话可以直接完成；默认 Service 装配由 Service owner 接入，本叶子的存在不代表正式 UI/默认入口已迁移。

实现使用[公共扩展端口](../../extensions/index.ts)，没有 SQL、Provider、旧 Runtime 或第二 Loop。`requirePlan` 登记 dispatch/completion 义务；`requiredValidation` 登记 completion 义务。`initializeRequirements(input, policy?)` 由可信宿主调用：`policy.requirePlan=true` 仅对原 Run 单调加强，false 不削弱工厂已有要求；`readOnlyDefinitions` 仅接受宿主实际装配并确认只读的 `{kind:'tool',definitionId,definitionVersion}`，封存为准确 Run 的不可变集合，模型输入/JSONC/远端 annotation 不取得此接口。未批准时只允许 Model、原管理 Tools 与准确封存的只读 Tool 派发；只读父 Tool 的普通 Job/child 仍独立受计划门禁，Full 不能绕过。initializer 在首次执行前创建 `run/<actualRunId>/...` 不可变 executable 记录，再由 Core 封存准确 Session/Run/原 Store。关闭后续配置或缺少 evaluator 不能删除已登记要求。

## 计划与真实来源

`planning.write@1` 保存不可变正文版本及 CAS `plan.current`；`planning.read@1` 读取；`planning.review@1` 审阅准确 ID/version/digest，保存真实 accepted informational receipt 与 `auto`/`accept_edits` 执行方式。写入与审阅是两次独立调用。批准保存 `run/<actualRunId>/approval/<planId>/<version>` 不可变记录，核对原 accepted Interaction、批准 Execution 的实际 Run/Session/Store 与当前完整 plan digest；同 Session 后继 Run、旧版计划、旧答案或 runless 用户 Action 不能取得后继 Run 批准。旧 `approval/<planId>/<version>` 历史保持只读，新的 `approval.current/...` 仅用于上下文投影，不是派发 grant。批准不授予 Tool 权限，所有调用继续经过宿主 Permissions。正文、标题须非空、step IDs 唯一，不添加旧的 30,000 字/12 步/replan reason 长度产品限制；持久记录及公共 frame 的现有有限传输边界仍适用。

扩展的纯 `context.capture` 自动贡献当前计划与批准凭据的 canonical 数据，来源 ID 为 `builtin.planning:<session>:<plan>:<version>`，摘要覆盖完整当前计划和批准身份。贡献仅在记录指向的实际批准 Run 仍 active、同 Session、Run 专属证明与 accepted Interaction 全等时显示批准，否则 approval=null，不从 input 或模型猜目标。计划资料标为 `user/after_history`，不获得 system 权限。`sourcesFor` 是需要显式宿主组合时的同一贡献实现，不应再重复装配同一来源。

内部 `SourceRequest.runId` 由 Core 以实际当前 Run 覆盖。`captureModelContext` 核实际 Run／Session，再复用 `readPlanningState` 的原记录与批准证明，贡献一个 `user/runtime` 来源：pending 显示 planning，未启用或已批准显示 building；完整原 state 与来源摘要保留。无 Run 的既有来源捕获只提供计划资料，不补造当前 phase。动态观察与静态 Agent 合同分开，普通请求、压缩和展开复用[同一组装](../../model-context.ts)，不增加 grant 或替代最终 record read-set、审批与派发门禁。

历史 receipt 校验独立于当前信息贡献：`matchesPlanSource` 从实际 Execution 的原 Session/Store/Run（runless Job 沿既有限父链）读取当前完整计划与该原 Run 不可变 accepted 审批，复用同一纯 canonical payload 重建执行时来源 digest。原 Run 已完成不会让准确原 receipt 失效，但不会恢复 inactive Run 的普通批准贡献；新 Run 不沿用旧审批，plan/head/accepted proof 或封存执行来源变化仍拒绝。同 Session 派生报告继承原 plan.required ref 后不能借原 Run 的待审批 Model 管理豁免，最后 completion 重读完整原计划、审批、progress 和原 receipt；这些 record 继续进入最终事务 read-set CAS。

审阅 request 保留公共面板的 string version、准确 plan digest 与允许的 `allowedModes`。实际 canonical request 不超过现有 Interaction 32 KiB metadata 预算时继续 inline 完整 `content`；超过时只改变传输方式：完整 canonical plan 由公共 ArtifactWriter 发布到原 review Execution scope，request 的 `content` 明示正文在完整附件，`policy.review={kind:'artifact',complete:true,reference,...}` 保存准确原 scope ref、完整 size/hash/contentVersion、原 Store/Session/Run/Execution、plan digest 与 plan record revision，不截断或把字数变成业务上限。

这里的 `policy.review` 名称沿用既有 generic complete-Interaction attachment 消费协议，只是信息附件，不是授权 policy/grant。SDK `interactionAttachment/readInteractionAttachment`、CLI stdio、TUI、Desktop 与通用 UI 已有完整读取/hash/EOF 与未读取不得提交的公共接点；本叶子不修改客户端或另建 HTTP 路径。小计划 request 与回答保持原格式。

叶子在 `review.body/<actualExecutionId>` 保存不可变封存记录。request 前与接受答案后均通过原 scope 公共 reader 读取到完整 EOF，核 size、SHA-256、fatal UTF-8 与完整 canonical plan 全等；不能把 ref/hash 当已经阅读或当权限。原 accepted proof 仍须绑定同一精确 request 与实际 Run 批准 Execution。最后条件/`readPlanningState` 不取得物理文件或 SQL：重读完整原 plan 和 seal、核原记录 revision、原 scope、完整 hash/size、accepted Interaction 与 Run proof，收集最终 record read-set CAS。已接受的人类阅读事实不把外部文件修改与 SQL commit 冒称原子；物理正文损坏在实际读取边界拒绝，封存记录或 plan 在最后读后漂移则在 SQL 派发/完成事务拒绝。

完整 plan 仍保存在既有 record；当前没有单 record 业务正文限额，但 SQLite Worker 保留既有 queuedBytes/pending 资源准入（普通队列 14 MiB/224、关键队列 16 MiB/256），不因本叶子扩大。真实资格覆盖超过 300 KiB 的 UTF-8 与 JSON escaped 大正文写入、原 Artifact 完整审阅、批准状态和真实 step receipt 完成；不宣称超过既有队列/平台容量的无界传输。贡献中的批准摘要仍只保留 decision identity/answer，不再次复制审阅附件正文。

`planning.update@1` 要求准确当前 ID/version/digest、Run、step 与 progress revision。完成步骤必须引用该 Run 真实成功 Tool/Job 的原 Store、attempt、定义版本、input digest、result revision，并匹配该执行真正捕获的当前计划来源 ID/digest。Model 文本、计划/验证管理 Tool、旧 Run 或旧计划成功回执不能替代。完成候选需要全部 step 完成、当前批准和原计划义务；Core 最终仍重新读取相关记录并事务复核。compensated 保存原 receipt 与补偿 receipt，不成为 passed 或完整计划完成。用户 `planning.write/review/update` Actions 共用业务函数但有独立 Command 身份；活跃 Run 的同 Session Action 按当前串行队列等待，不能假装它已并发修改当前工作。

`planning.review` 的实际 ToolResult 保留 `status`，并把合法原 `approve/revise/deny` 的 `decision` 与存在时的完整原 `feedback` 交给下一次 Model 请求；批准另带原执行方式。修改或拒绝仍为 `not_approved`，不保存批准、不自动增加版本或取消原 Run。Model 根据原修改要求另调用 `planning.write`，新版本仍须独立准确审核，旧批准不随之移动。[实际 SQLite/Model 回归](../../../test/isolated/business/planning.test.ts)核原反馈驱动 v2、两版本批准前零写入、deny/空 revise 原值、非法 mode 不授予批准，以及原 Run 证明和最终 CAS。已派发适配器在取消后没有可核结果时继续遵守 Core 的 `outcome_unknown` 合同，不因这条信息反馈路径改报 cancelled。


Shell 检索在计划批准前仅接受宿主核实的单个字面只读命令（内置 rg、固定 ls、pwd），拒绝重定向、展开、包装器及 rg 外部执行钩子；实际执行改用固定资产并关闭 rg 配置。Tool 和其普通 Job 分别核原输入摘要与当前权限，不能把整个 Shell 定义标成只读。
