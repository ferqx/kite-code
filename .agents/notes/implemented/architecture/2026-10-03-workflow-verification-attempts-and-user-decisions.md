# Agent Note: Workflow 的核验尝试与准确用户决定

Status: implemented

## Problem

既有 required Verification 失败后应通过普通模型、工具和权限链修复；已允许的用户可以选择 replan 或准确 waiver，compensation 成功也不等于核验通过。原 Workflow 只保存一次不可变 closed/output 与 verification，重复核验只查原结果，无法登记修复后的输出或新尝试。Planning 的 waiver 属于另一 namespace 和要求，不能解除 Workflow 义务。

原已关闭但 required 核验失败的 frame 释放后续 dispatch ceiling；直接复用它执行 repair 会丢失原 Skill 的来源和能力范围。模型输入中的 actor 或理由也不能证明真实用户接受。V1.3 §7.3/W16/R04 要求保留原失败证据、准确主体/要求版本/Run/Execution/reason/time，并禁止 waiver 绕过未知副作用或底层权限；这属于既有有限治理，不是新的 Workflow 平台。

## Decision

Workflow 业务 namespace 持有不可变 activation anchor、append-only output/verification attempts，以及有限 CAS current head。每次 attempt 的原 Skill revision、输入、输出 digest、父 Tool/Job、operation key 和真实 result revision 均准确封存；重读同 attempt 只查询原 operation，不启动第二次 Job。repair/replan 建立明确新 attempt，不覆盖旧 closed output、失败或未知。

required 已失败但未准确 waiver 的 frame 保持原 capability ceiling、最低审批和 source freshness。正常修复使用唯一普通 Loop 的 Model/Tool/Job，不注册第二调度器或隐藏 Provider；不把 contract execution.maxAttempts 当整个 Run 的新增累计额度。fork 修复仍通过普通 child carrier 取得真实新结果，不能让手填输出替代原 child proof。重新打开、完成和核验须绑定当前 attempt/head，迟到的旧调用不能关闭或验证后来尝试。

普通 question/requestInteractionWithReceipt 请求真实用户决定；waiver 或 replan 需要 trim 后非空理由/指令。请求与持久 proof 精确绑定原 Store、Session、Run、activation/anchor、Skill revision、requirement revision、当前 head、输出 digest、原核验 Execution/resultRevision及真实 accepted interaction/decision revision。用户主体由该原 Interaction 的持久 subject 事实证明，业务不得接受模型自报主体；记录保存决定时间及原 proof。等待期间 head、source、权限或取消变化拒绝旧答案。

waiver 是否可请求由可信宿主装配的有限 policy 明确决定；默认开发宿主延续既有显式用户 waiver，JSONC/Skill/Model 不能配置此 policy。准确 waiver 另存 waived，不改原 verification 为 passed；只解除该目标 completion obligation，不能解除 output schema、源码身份、Tool 权限或未核实外部执行。当前不支持的 verifier、未知 Job 或来源失效不借自动 repair/waiver 盲重跑。

本切片闭合 attempts、普通 repair、真实 replan/waiver，以及其默认宿主和普通客户端 Interaction 调用。声明 compensation 保持完整 V1.3 的独立紧接工作：仅真实用户选择、原声明脚本、同一普通 Job、实际网络关闭/隔离与原来源/资产复核；在满足这些条件前不提供虚构可执行选项，不把当前 Shell 监督冒称沙箱。

## 有限实现契约

不可变 anchor 仍是原 requirement 引用；每个尝试使用原 anchor 下的 `attempts/<正整数>` 独立记录与 operation key，有限 head 以原 revision 做 CAS。初次尝试为 1；原 complete/verify/reference 未提供 attempt 时仅指初次尝试，不能借缺省值绑定后来的 head。新 `repair_skill@1` 与 `decide_skill_verification@1` 必须给出原 activation 与准确 attempt 期望，业务重读实际 anchor/head，不接受模型自报 Skill、proof 或 actor。

普通 repair 新建尝试并返回原完整输入、指令与输出 schema；fork 的 repair/replan 通过该准确新 carrier Tool 和新 child operation 取得新结果。用户决定使用一个闭合普通 question：`decision` 为可信 policy 允许的 replan/waive，`detail` 是必填字符串，业务再核 trim 非空。waiver 保存不可变独立 proof，head 只指向真实 proof；replan 保存原非空指令后新建尝试，不覆盖旧失败。原尝试重复读取不能启动第二 Job。

可信 factory 的 `userDecisions` 只由宿主提供版本、是否允许 replan/waiver，默认 Service 封存明确允许值；整个 policy 进入原 Run 配置与恢复比较。verifier prepare 和普通 Job 的闭合输入增加准确 attempt 与 output digest，start 重新验证完整 output digest、原 Skill/script/source/资产；这不是重试器或 head 授权。

普通信息接受使用实际每 Run 的 permission binding；通用 gate 在问题前后复核原 Tool 的权限 facts、完整分类 stamp 及 control reads，等待期间的版本、同版本分类或 control-read 漂移拒绝接受。新增的业务决定不以 `information-1` 充当权限证明，也不使普通回答成为工具授权。

waiver 的未知副作用检查须覆盖实际原 Run、parent Execution 和真实 child group 中的外部执行，不只查 verifier/fork。通用 scope 固定的只读 execution-safety fact 与 Host 收集的最终事务 read-set 已实现；缺事实或不能完整证明安全时拒绝决定，不因此阻断无约束普通对话。只有 condition 自该实际 scope 读取的 fact 才能进入事务核验，业务或模型不能自报安全。

通用事实使用 `ReadContext/ConditionReadContext.readRunExecutionSafety(runId)`，返回固定原 Store/Session/Run、canonical scope digest 与 `unconfirmed`；Store 闭包查询核实际 Run 与 parent/child group，不依赖当前视图窗口。排除项由 host 的准确正在执行 Tool boundary 注入，仍遍历其后代。Host 自动收集 `executionSafetyReads`，最终 Store 事务以准确自身 boundary 复算原事实；evaluator 不能自行选择排除项。该 seam 不识别 Workflow，也不给无该约束的 Run 新增全局完成条件。

可信 `resolveChildRunConfiguration` 接收只读 `records.forExtension(id).get(key)`，allowlist 来自实际最近父 Run 已绑定扩展；原 Store、Session、subject、取消与读取 freshness 均由宿主固定。只给可信 resolver，不给 Model/HTTP，不提供写入或任意 scope。Service 由此核真实 anchor/head/attempt 的 opening carrier，避免从模型 `activation_id` 借子角色 authority。

原 Interaction 已保存并强核 subject，业务以准确接受引用证明主体，不补造主体字段。决定记录的 `recordedAt` 是可信时钟给出的业务采用时间；当前存储没有原回答/接受时间，不能把它描述为用户回答的精确时间。

## Alternatives considered

- 覆盖旧 closed/output/verification：丢失失败证据并允许迟到结果覆盖新工作；保留 append-only attempt 和准确 current head。
- 同 operation key 自动重试：可能重做未知副作用，也不能区分新输出；同 attempt 查询，明确新 attempt 才有新 key。
- 直接调用 Planning waiver：namespace、requirement、输出和 checker 身份均不同，不能证明目标 Workflow 的用户决定。
- 模型声明 actor:user 或通过原回答文字猜 waiver：不是 Core 接受的事实；复核真实原 Interaction 与 accepted decision revision。
- 增加 Workflow Core 状态机或新 Interaction kind：现有 records、operations、conditions 与普通 question 已有足够边界；业务状态留在扩展。
- 沿 closed frame 的原放宽执行路径 repair：会绕过原 Skill ceiling/source；未满足 required 期间保留原约束。

## Consequences

修复和 replan 保留旧失败、完整输出和所有准确操作；每次明确新尝试有独立 operation key，读取原尝试不会启动第二个 Job。final condition 的 record read-set 同时包含原 anchor/head/opening、旧失败、真实用户决定与准确 proof。Service 的 fresh child 配置读取完整 opening facts，Core 在 carrier 创建及 activation 最终事务再核；空读集不为原 runless Action→Tool→child→grandchild 虚构祖先 Run。

CLI 的原 work observer 对 runless verifier Job 使用持久 parent Execution 闭包，分别呈现其独立审批；TUI/CLI 原答复丢回执只查询冻结的原 Command，准确 kind/Store/Session/receipt 不符保持 unknown，不重复 POST。cancel 与 unknown answer 具有各自原身份；切换或刷新不能把旧答案重新应用到新卡。

大人工审批沿用准确 Execution scope 的不可变完整正文协议，有限卡仍使用既有 policy.review 附件入口。完整 input、policy 与 grants 在接受及最终授权前重新核对；相同正文的两个审批仍保留各自原 Execution 引用，不复制许可。正文阈值只决定传输路径，不是内容配额。取舍与原 Model/Auto 正文一致，见[不可变正文决定](2026-10-01-immutable-model-body-and-review-proof.md)。

真实 SQLite/固定 Model 的 Workflow 与监督 verifier 组合 69 tests/402 assertions 通过，包括失败→repair→passed、真实 replan/waiver、原失败不改、错误 target/proof 各字段、模型伪造主体、等待来源/权限/取消变化，以及独立审批实际等待31秒跨观测窗口后仅一次原 Job。默认 Service 的 inline/fork、配置policy及选择组合21/311与严格decision key/fork复验3/95通过；真正两次子Model及脚本Job保原8KiB输入和6KiB输出，最低用户审批独立。

Core 9file组合63/536、原完整model-body8/53及Agent types通过，核最终 child read-set、安全闭包、实际信息权限与完整人工正文；错原scope、同policy revision变化和附件损坏均零效果。CLI/TUI真实question frozen组合7/150、恢复stdio29/152和TUI9file63/528通过，包含80×24实际键盘、原SQLite acceptedDecisionRevision与一次POST/两次原GET。Workflow的回执丢失是在真实HTTP提交后丢弃消费回执；同组合普通question首例另以relay物理断开socket，不冒称所有Workflow例都作了TCP物理断线。

当前冻结完整统一第四轮通过，日志为/private/tmp/kite-workflow-decisions-unified-fourth-qualified.log，runner记录parallel=88/isolated=262/exclusive=0；26workspace build/full typecheck、API/边界/ownership、文档及全scope impact均通过。前三轮失败分别是旧fork PTY新增字段、真实owner空列表交接竞态和MCP fixture累积unknown后串跑否定；前两项已准确修复，第三项保真实unknown阻挡并隔离各否定场景，不放宽派发。owner修复与scope、已确认结果差异各有确定性证据。准确日志、强制检查和本次iteration_complete由[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)维护。新Goal仍active，不代表完整V1.3完成。

本决定不交付声明compensation、完整MCP管理/OAuth、正式旧入口退役或跨平台发行。补偿必须先取得真实网络关闭和文件/进程隔离，当前监督不构成沙箱。CLI待决读取仍仅首100项，Native便携调用者尚未完整消费nextAfterId；TUI已沿分页读完，但本轮没有新增超过100张同根卡片的真实资格。原根Run与Job报告的冷恢复已有独立Core/HTTP证据，完整正式调用者和其余支持范围继续按方案闭合。执行安全读取的有限4096项范围不可核实时拒绝资格，不转成新Run累计额度。recordedAt仍只是业务采用时间，原Interaction的实际主体/accepted引用才是用户决定出处。
