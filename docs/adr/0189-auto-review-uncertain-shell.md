# ADR-0189：Auto 模式由审批模型先判断副作用不确定的 Shell

状态：accepted

日期：2026-09-17

决策者：用户直接指令

相关：ADR-0160、[授权规则](../active/authorization.md)、[工具与审批](../handbook/features/tools-and-approvals.md)

## 背景

ADR-0160 将无法证明只读或完整副作用的 Shell 固定路由到人工审批，包括 Auto 模式。实际会话中的 `unzip -p` 读取工作簿部件因此直接请求了两次人工审批，自动审批模型未参与。用户确认 Auto 模式下此类待审批操作应先经过审批模型。

## 决策

1. Shell Policy 继续把此类命令编译为 `uncertainEffects`、`requiresApproval=true`，保留原有 sealed sandbox scope，不因模型批准扩大网络、文件系统或 Full authority。
2. Auto 模式中的 `uncertainEffects` 走现有自动审查队列，由审批模型批准单次执行、拒绝或请求人工审批。此前审查触发熔断也不得使新的 Shell 命令跳过模型；模型调用故障或无效响应才升级人工。
3. Accept Edits 与 Full 模式仍对该类命令请求 exact 人工审批。明确的 hard deny、执行能力和沙箱门禁，以及显式要求用户批准的独立工具策略继续在自动审查之前生效。
4. 自动审查的批准仅签发 `approve_once`；执行、持久化、恢复和审批身份沿用现有链路，不新增授权状态或第二套审批机制。
5. 审批模型批准后，同一 exact invocation 不再接受普通模式和风险规则的二次审批；身份、取消、必需能力及真实执行故障检查仍有效。

本决策部分替代 ADR-0160 中“Auto reviewer 不得替代真人确认”的结论，其余 Shell 分类、硬拒绝和沙箱约束仍有效。
