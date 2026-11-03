# 子 Agent 协作

本模块只注册六个当前工具，没有旧 Task 工具、别名或执行兼容入口。产品行为归[执行手册](../../../../../docs/handbook/features/execution.md)，运行证据归[测试 owner](../../../test/isolated/business/task/README.md)。

| 模型名称 | 内部 ID | 行为 |
| --- | --- | --- |
| `spawn_agent` | `task.spawn` | 以 `prompt` 创建异步 child，可选 `task_name` 和可信 `preset` |
| `send_agent_message` | `task.message` | 给直接 child 或 parent 排队消息，不自行开新轮 |
| `follow_up_agent` | `task.follow_up` | 给 queued/running child 引导，或在 idle child 原 Session 开始明确新轮 |
| `wait_agent_events` | `task.events` | 观察事件摘要和游标，不取消 child 或接纳结果 |
| `list_agents` | `task.list` | 读取稳定协作者目录和完整来源，不改变执行或已读事实 |
| `interrupt_agent` | `task.interrupt` | 请求取消首次受理选中的准确 carrier |

六个定义均保持 v1。工厂为 `createTaskExtension({roles, defaultRole?, presets?})`；模型不能传内部 key、Run、selection、配置 ID、权限或 detached。`task_name` 只作显示，不参与身份、去重或授权。旧工具及 `role/resultDisposition/after_turn` 参数不再可用。

## 身份、权限和预设

`agent_id` 是稳定 child Session ID。同一协作者可以经历多轮工作；普通父轮次结束不取消已受理 child。每次 Tool invocation 派生受理身份，准确重试查询原持久回执，不重复创建工作或将迟到中断改投新轮。

角色来自可信宿主注册；默认通用 child，preset 只列实际开放项。默认 worker/code 可执行工作，explore/plan/review 只读分析。[roles.ts](roles.ts)核准确 extension owner、ID 与版本；未知定义、同名自定义工具、未来版本和写入不能借角色名称取得资格。描述帮助选择，不替代冻结定义、父子权限和当前工具交集。

三个文件检索工具已移除，只读角色可使用准确的 `shell.execute@1`／`shell.launch@1`。Service 逐次核真实参数，只允许固定 rg、ls、pwd 的单条字面检索；脚本、管道、重定向和扩大范围仍受角色权限拒绝。父 Full 不绕过子角色限制。[默认角色回归](../../../../../apps/service/test/isolated/default-task-roles.test.ts)核工具交集，[Service 检索回归](../../../../../apps/service/test/isolated/shell-search-configuration.test.ts)核实际 Shell 查询与拒写零效果。

根 ask_user 不下放；合法 Planning 工具由 Service 核原父冻结身份和当前注册后装配，显式禁用仍拒绝。child 有自己的会话文件上下文，不从父路径字符串继承可写目录或计划授权。实际效果仍核原 requirements、parent AND current permission 与准确取消边界。

## 后台工作、消息和引导

`applyAgentCommand` 在一个 Store 写事务内先查原 invocation 回执，再选择当前唯一 carrier，核 Store、主体、直接父子、来源和控制关系。运行中或 queued 的 follow-up 返回 `mode:steer`；queued 引导绑定原 carrier，在真正激活后进入模型。idle follow-up 通过原 ensureAgent 建唯一 successor，复用 Session 与配置。后续普通父轮次也可管理现有直接 child，技术工作出处不额外拒绝。

Host 准备 queued 引导后若最终事务发现目标已结束，返回 target_changed；重新观察后的新调用才能开始新轮。首次激活前取消且可证明未派发的 child 可复用 Session；原取消事实不改写，证明由[首次激活 owner](../../storage/sqlite/child-first-activation.ts)核验。旧 queued 引导不会转给新 carrier。

普通消息持久排队。活动 Run 在安全 checkpoint 接收准确邮件；idle 邮件保存 targetRunId:null，零新 Run／Model。明确 follow-up 按原 predecessor 和双水位接纳当时已确认邮件；同请求重试不扩大集合，晚确认或晚发送的邮件留队。完整正文以原 source IDs 进入模型，发送、接收和 prepared 是不同事实。

child Run 结束后，carrier 仍须等待该 child 范围的 Model、Tool 和 attached Job，包含排队 Job；detached Job 保持独立。inspectChildSettlement 在短读事务内取得 pending 与 change cursor，Runtime 用原 ChangeWaits 等待，不持 SQLite 事务或额外模型槽。最终 settlement 再核准确事实，unknown 不冒充停止或成功。后台 Shell 继续使用独立 Job 生命周期，不依赖 Task 结果义务。

## 完成通知与观察

spawn 和 idle follow-up 封存 agent_completion 订阅，不建立旧 required-result 义务。父活动时结果沿当前邮箱接纳；父 idle 时只有可信 AfterTurnPolicy 允许，才可从原配置启动通知轮。通知资格与自动执行授权分开，未知结果、停止、选择变化和当前权限仍检查。没有显式 after_turn 意图或旧报告回退执行。

accepted/state/mode 是受理时事实，不是完成证明。wait_agent_events 的 seq/next_seq 是观察位置；省略 wait_ms 使用可取消的有限分段等待，显式 0 只取快照。timeout 保位置且不停止 child，游标缺口返回 cursor_expired 和恢复边界。观察不会消费结果或标记已读。

list_agents 按首次创建 Command 的不可变 seq 每个 Session 只列一次；follow-up 不移动锚点。过滤先整体核归属，Decimal64 上界固定分页；完整职责、最近引导和结果通过受验证正文或当前 Tool scope Artifact 交付。当前工作状态与最近终态结果分别展示，不能把上一轮结果当作当前轮完成。

错误只公开有限 code/message/next_action。写命令 accepted:true/false/null 区分有证明、明确未受理和不可核实；未知不自动换身份重放。只读取消不误报回执未知。需要父／人类答复的 child 只进行一次明确有限观察，没有答复时如实交付待决结果。

成功结果及历史可安全读取的失败结果可包含宿主从准确 Tool 回执封存的 details.evidence。失败不撤销此前成功的工具；原失败原因和状态保留，失败结果不采用半成品助手回答作为完成报告。失败历史不可读时只缺失预览，不推断零动作；取消和未知路径不增加历史读取。工具统计、来源版本和有界原文供父级核验，child 总结不能替换事实；接纳成功也不证明结论正确。完整正文和独立核查仍由原 Source、Artifact 与权限合同保障。

## 实现与验证边界

本 leaf 使用普通受控 Operation。公开 Extension 的 ensure/wait/readAgent/sendAgentInput、邮箱和 wait-any 是通用扩展合同，继续服务当前工具及第三方扩展；它们不是旧 Task 兼容层。通用 Requirement／Planning 审批也保留。旧 Task records/conditions、resultRequirement、专用 mandatory-result 等待、status-only 结算及客户端 Required results 状态均已移除。

旧 resultRequirement 参数在 Host／Store 明确拒绝，不会忽略旧义务后悄悄开始工作。持久取舍及旧决定的部分替代归[退役决定](../../../../../.agents/notes/implemented/architecture/2026-11-02-retire-legacy-task.md)。

[六工具](../../../test/isolated/business/task/collaboration-surface.test.ts)、[邮件](../../../test/isolated/business/task/mailbox.test.ts)、[idle 接纳](../../../test/isolated/business/task/mail-adoption.test.ts)、[问题与引导](../../../test/isolated/business/task/question-loop.test.ts)、[attached Job](../../../test/isolated/business/task/attached-job-settlement.test.ts)和[执行组恢复](../../../test/isolated/recovery/run-resume-group-runtime.test.ts)分别核实际 Core／SQLite／模型输入和失败边界。旧 Task 测试夹具已删除，不能用历史工具测试替代当前接口验收。工具、存储与 native runner 版本未因本次移除升级。
