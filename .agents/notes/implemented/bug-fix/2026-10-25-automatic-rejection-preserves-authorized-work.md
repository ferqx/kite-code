# Agent Note: 自动审核拒绝不取消原授权任务

Status: implemented

## Problem

只读的“了解项目”任务中，模型误提出向项目配置写入占位内容。自动审核正确拒绝该写入且目标未派发，但 InteractionGate 同时取消了原 Command，并复用了人工拒绝的 `approval_denied`，导致整轮停止，模型没有机会完成原只读分析。拒绝原因虽保存在 details，却没有进入下一模型的工具结果正文。

[人工拒绝决定](2026-09-04-approval-rejection-terminates-tool-batch.md)明确只改变用户亲自拒绝工具审批的语义，其第5条单独保留自动审查与策略拒绝的边界。本次用户要求修复任务被错误阻塞，不授权被拒绝的写入。

## Decision

- 自动 checker 的明确 reject 不提交 `cancelCommand`，通过内部 `AuthorizationCheckRejectedError` 保存普通 `permission_denied`；准确拒绝记录、未派发状态与零 adapter 事实保持。
- Tool 执行仅在准确内部类型且未调用 adapter、未提交派发时生成可读拒绝正文，将原因和未执行事实按原 call ID 交回模型。只允许继续原授权任务，不能换工具或路径绕过同一拒绝。
- 后续调用仍分别通过原策略、审核、来源与最终派发核验；默认按 Model 顺序准入的兄弟只能在前项准确结算后继续。相同参数的连续失败仍受原五次失败规则约束。
- 人工 deny、真实取消、unknown、已开始调用清理和保存失败保持原停止规则。Action／Job保原闭合错误结果，不改MCP未启动证明或恢复权利。
- trusted Agent contract 明确理解、解释、检查和审查不授权修改项目；未要求保存时直接回复，不为探索创建占位或报告。该指引不授予权限，也不保证模型永不误调用。

## Alternatives considered

- 自动放行这类写入：会把只读任务扩成文件修改，拒绝。
- 只移除 Loop 的致命分支：原 Command 已在审核分支耐久取消，无法纠正原状态转移。
- 只改为权限错误码：后续模型仍看不到具体拒绝原因，不能据准确反馈纠正路径。
- 根据用户文字关键词动态隐藏写工具：会建立另一套任务分类和权限猜测，没有采用。

## Consequences

自动审核拒绝后，原任务可以完成合法部分；被拒绝的调用仍失败且未执行。既有人为取消和已保存终态不被改写，旧任务不自动恢复或重放。没有新增 HTTP、SQL或公开 ToolResult 状态。

## Verification

[自动审核回归](../../../../packages/agent/test/isolated/execution/authorization-check.test.ts)核原因交回、零I/O、独立后续审核、准入顺序、重复拒绝上限与同原Command零重放；[默认Service权限回归](../../../../apps/service/test/isolated/permission-configuration.test.ts)以真实默认装配、compatible SDK、SQLite和Files核占位写入被拒后继续读取并交付答复。当前结果与平台限制归[权限owner](../../../../packages/agent/src/permissions/README.md)和[Service owner](../../../../apps/service/README.md)。
