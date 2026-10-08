# Agent Note: 原审批界面沿只读授权事实迁入

Status: implemented

## Problem

原 PC Approval 已有拒绝、仅本次批准和同会话相同命令的范围菜单。统一客户端已有准确 pending Interaction 与提交链，但工具历史缺有限审批事实。工具成功、答案保存、Core 接受决定与原派发分别发生，不能互相推导；停止或后续上下文变化也不能让原批准记录消失。直接公开私有授权证明会泄露输入、主体和上下文，并混淆历史阅读与当前执行资格。

## Decision

Native 继续使用原 Approval／ToolActivity。InteractionCard 提供有限 renderApproval slot，仍拥有完整附件读取、身份／hash／EOF 与回答资格；Native 仅适配准确请求和实际允许的 grants，回答继续沿现有 Main／公共 Client。保存、受理、拒绝、取消、自动审查及未知分别映射到原展示状态，工具结果保持原事实。

Execution 的可选 authorization 从现有 SQL 记录推导，未增加持久列或写操作。自动审查沿实际 dispatch binding 的原 carrier，缺 binding 时仅接受唯一 purpose 候选；人工 accepted 核原 Interaction revision 与 Execution decision binding。公共字段仅含原 ID、有限状态／决定／原因、原答案 revision 与派发标记，不含私有原请求、主体、owner、审查全文或上下文。

只读 observer 显式选择历史模式：仍验证原 Store／Session／Run／attempt／定义／输入／purpose、完整模型结果与 Artifact proof，仅不以当前可变取消和重新计算的当前 decision context 否定原决定。原 fact 调用默认保全部当前授权检查，执行路径不使用观察字段作 grant。Fork／Include 的封存 Message 不取得来源 Execution 后来的审批；未知工具版本不借审批事实进入旧结果分类。

原记录的完整只读分页和独立附件阅读由[后续交互历史决定](2026-10-09-native-interaction-history.md)接入；本篇的授权事实、原 proof 与执行资格分离理由继续适用。

已有根会话继续复用原 Composer 权限菜单／Full 风险确认，沿现有 permission observation 只改该会话；Native 原菜单和提交回调在未信任工作区时拒绝修改，确认随准确阅读身份变化撤销。原停止按钮沿既有持久 Caller，以当前准确活动 Run 的原开始 Command 提交 command.cancel；读取标签、保存申请与终态仍分别核实。Auto 转人工保原 reviewer 原因，不能因存在人工卡丢掉此前审查事实；这些控制没有新增公开端口或存储格式。

本决定部分接续[原轮次决定](2026-10-08-native-run-transcript-presentation.md)与[工具观察决定](2026-10-08-native-tool-message-observations.md)：更新审批表单和有限直接历史观察；原唯一来源、完整结果、32项scope、sealed／foreign、轮次与复制理由继续适用。当前实现和测试范围归 [Desktop owner](../../../../apps/desktop/README.md#原审批面板与授权观察)与 [Store owner](../../../../packages/agent/src/storage/README.md#只读授权观察)。

## Alternatives considered

- 从工具成功推批准，或从答案保存推已派发：几个事实没有等价关系；公开原 accepted binding 和实际 dispatched，分别展示。
- 将私有授权 payload／快照原样公开：暴露请求、主体与上下文，也把读取接口变成授权素材；使用有限派生观察。
- 用当前 getAuthorizationReview 授权资格读取全部旧决定：停止与后来上下文变化会使真实旧记录不可读；仅 observer 采用历史模式，执行资格保持原默认严格路径。
- 重做审批表单或建立另一条回答提交链：原组件与当前 InteractionCard 已分别拥有交互和资格；用有限 slot 接入，保原范围菜单与准确提交。

## Consequences

原 UI 可在正式 Native 复用，历史批准与当前执行权分开。生成 Execution 响应增加可选字段，Core、Service、Client 和 Native 需要同步此投影，但 DB／私有格式和执行状态机保持。每次读取仍核原 proof，不引入第二份持久缓存；歧义或破坏的原证据不补审批结论。

Core 原门禁、真实 HTTP／Client、Main 封存隔离、原表单 DOM 与 macOS 首次／冷读窗口分别提供本片证据，准确失败与通过归[进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-09原审批面板与授权观察)。当前 Store 的原交互记录已沿后续决定接入；原会话权限／停止及 Auto 批准、拒绝、转人工、无效结果与停止后迟到批准现已核实际首次／冷读窗口，准确范围见[输入区控制](../../../../apps/desktop/README.md#原会话输入区权限与停止)。全部封存／恢复组合、完整 PC 和整片独立审查仍未关闭；本决定不提升其他平台或全阶段退出。
