# Interaction Store owner

会话内 `same_command` 的原卡选择、精准 scope、单次批准区别与清除线性化由 [permission-grants owner](../permission-grants.README.md) 维护；计划审核和问题仍只提供信息，不建立工具 grant。

`requestInteraction` 在真实 Execution/attempt 上保存唯一权威请求。Session/Run、原主体、展示根和 ancestry 从实际执行组关系派生，调用者不能声明父会话或内部权限。定义、完整最终 inputDigest、policyRevision、原 source 与完整必要 refs 封存；仅 approval 是 planned 阶段的派发批准；question 与 plan_review 是真实 dispatching/running 执行发起的信息请求，不能由尚未派发的 Tool 冒充已运行请求。请求 JSON 单份最多 32 KiB、2048 节点/16 层；一个展示根最多 64 pending 请求。Run 可在同事务进入 waiting_interaction。

`answerInteraction` 仅接受准确 presentation 根、interactionId/revision 与原主体。公共 child 入口拒绝；一张子审批卡就是原 Interaction 的投影，没有第二个批准状态。expectedStoreId 在查重前核实。答案与 applied Command 回执和父/子事件同事务提交，同 ID/答案幂等，不同答案冲突。取消先提交时，迟到答案可保存为历史 cancelled 决定，但不能接纳或派发。答案回执仅表示 answer_saved。

`acceptInteractionDecision` 使用真正 root owner，核实原 Execution/attempt、owner generation、原 Store、适用取消/删除边界、来源 freshness 和当前必要记录来源/revision。仅 approval 要求 dispatch 阶段必要 evaluator 的 satisfied/waived；question 与 plan_review 不要求尚待批准的计划已满足，允许 requirements:[]，但仍核实封存 refs 与当前记录 revision/origin 未变。接纳标记是同一 Interaction 的 acceptedDecisionRevision；重复接纳无新增事件。仅 approval 决定在原 Execution 绑定该引用；同一已批准 Tool 可再请求信息，不覆盖已有 approvalBinding。Run 的全部待办已接纳后才能从 waiting_interaction 回 running。父前台正常完成不撤销既有 detached child。

`markDispatching` 对有审批绑定的 Execution 强制核实该 Interaction 当前 answered、准确 accepted revision、approve 决定、原 definition/input/source/refs 与 authorization.revision 等于封存 policyRevision。单独 allowed:true 无法绕过请求，旧答案不能复制给新参数/attempt。question 与 plan_review 都只提供信息，不建立授权 binding；它们的 accepted ID 不能传给 markDispatching 当作另一执行的许可。计划 approve/deny/revise 和 mode 是原业务记录的输入，由业务 evaluator 另行解释保存，不能替代 HostPolicy 或必要完成条件。Core 仍负责当前权限判断、用户选择的计划 mode、工具执行和真实结果；Store 不另建 Workflow Loop。

question 可带 `request.schema`，其有限 JSON schema 支持 type/properties/required/additionalProperties/items/enum/const、oneOf/anyOf、数值及长度/数组上下界、title/description，最多 256 schema 节点/12 层。组合须为非空数组，每个分支计入同一预算并递归核对白名单；原 Ajv 继续分别执行恰好一项或至少一项匹配，不把选项文案代替 const/enum 原值。pattern 仅接受准确 `\\S`，用于默认普通问题的非空白字符串约束，在保存前拒绝空白并保持原卡 pending/revision；单字符类别扫描不开放任意正则。$ref、其他 pattern、format、allOf 和未知关键字仍拒绝，避免外部 I/O 和无界正则；答案短事务按原 schema 检验。所有答案最多 32 KiB；plan_review 可带有界 feedback/mode。无 schema 的问题答案保持 bounded JSON。

Ajv 使用 `ownProperties:true`，必填与属性校验只读取实际 JSON 自身字段，继承的 constructor/toString 不满足 required；明确自身同名字段仍按原值检验。当前 Ajv 编译器排除 properties 中的 `__proto__`，因此 schema 准入明确拒绝该自身属性和 required 中的同名键，包括组合分支内的声明；不能发布一张缺字段会通过、真实字段反而无法回答的卡。此有限拒绝与选项组合的取舍见[普通问题原 schema 与答案](../../../../../../.agents/notes/implemented/architecture/2026-10-06-original-question-schema-forms.md)。

get/listInteractions 纯查询、同快照、有界 ID keyset，真实 child 和准确展示 root 可读取同一事实。分页不会将整个 group 历史塞入事件。普通重开不自动执行；Worker 丢失后已保存答案可读，显式 recovery 仍按原恢复承诺收束未派发调用并 fence，不能借批准自动接管。恢复/取消保留原 answer/source/input。

真实 SQLite tests 位于 test/isolated/storage/interactions.test.ts，覆盖双卡分页、根投影/child direct answer 拒绝、父先完成 detached child、同答案命令幂等、request/answer 触发器回滚、cancel-before-answer、Worker 重开与恢复 fencing、参数/来源/policy/计划变化、必要 refs 缺评估与 stale revision、信息请求在未满足必要计划时仍可接纳但最终派发/完成保持拒绝、信息接纳不覆盖已批准 Tool 绑定、计划信息迟到取消历史、question schema、INT64 revision overflow 整体回滚和接纳重试零事件。此叶子不访问旧用户数据，不调用模型或执行工具。

完整人工审批的原展示请求超过卡片的 32 KiB、2048 节点或 16 层预算时，可信 Core sealer 将完整 `{policy,grants,commandDigest?,definitionId,definitionVersion,input}` canonical JSON 发布为原 Execution scope 的不可变 Artifact。卡片保留定义、原 inputDigest、原 grant 选项和完整正文摘要，并复用已有 `policy.review:{kind:'artifact',complete:true,reference}` 公共附件协议；不是正文前缀或另一种批准。每个原 Execution 的附件 ID 独立，同内容不会借另一 Execution 的引用取得读取资格。原 Execution.input、Interaction.inputDigest、policy revision、source、required refs、答案命令和 accepted revision 保持原身份。

可信 private verifier 在实际接纳和最终授权路径核原 Artifact 登记、scope、完整 hash/size、严格 UTF-8/JSON 和当前准确 input/定义/人工 policy；同 revision 更换人工 policy 也不能复用旧正文。读取或完整性失败零 adapter 效果；原卡预算和有限 SQL/Worker 传输保持，未配置 Artifact 的宿主明确不可提供这条大正文路径。批准后仍由原 Interaction/权限/来源/必要条件的最终事务判定派发，附件全文与普通人类信息回答都不扩大执行权限。

[完整人工卡测试](../../../../test/isolated/execution/approval-body.test.ts)使用真实 SQLite、原 scope Artifact 与固定 Model，核超过 240 KiB 的原 input、70 KiB policy 的完整末尾、独立重复调用附件、准确原卡回答、同 revision policy 漂移及正文损坏零效果。实际客户端复用完整附件读取协议，其各自展示/回答资格由客户端 owner 记录；这些 Core 断言不代表三平台或完整 V1.3 资格。
