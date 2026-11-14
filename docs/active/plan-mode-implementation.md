# Plan Mode 当前实现

状态：active

读取时机：修改计划模式、准确计划文件、方案审核、步骤回执、计划恢复或客户端计划交互时。

验证：`bun test packages/agent/test/isolated/business/planning.test.ts packages/agent/test/isolated/business/planning-files.test.ts packages/agent/test/isolated/business/planning-progress-view.test.ts apps/service/test/isolated/planning-configuration.test.ts`、`bun run typecheck`。这些是当前验证入口；实际通过与失败范围按本次运行结果保留，文件存在不代表全部场景或平台已取得资格。

产品定义见[计划与任务](../handbook/features/planning-and-tasks.md)与[工具和审批](../handbook/features/tools-and-approvals.md)，客户端操作见[TUI 计划指南](../handbook/clients/tui/guides/planning.md)。实现由 [Planning owner](../../packages/agent/src/business/planning/README.md)、[Service 装配](../../apps/service/README.md)及[现行八 workspace 边界](unified-agent-boundary.md)负责。

## 计划模式与独立权限

Planning 是计划模式，不是 Agent 的运行阶段。当前 Agent 没有由方案批准驱动的 `planning/building` 阶段切换。请求批准、Auto、Full 是工具权限模式；要求先审阅方案是原 Run 的独立义务，两者不能互相替代。批准计划只满足准确计划的审阅要求，不授予 Shell、文件或子 Agent 的工具权限；Full 也不能绕过仍未满足的计划批准要求。

当前 Run 的计划要求由 Service 可信配置和原输入意图初始化为 `plan.required`。Model 上下文提供实际 Run 的计划批准事实及当前准确计划，不把 `disabled/pending/approved` 解释为 Agent 阶段或新授权。派发前仍由真实记录、原批准、独立 Permissions 与最终读集事务核验，不能依赖模型文字、摘要或客户端显示决定权限。

尚未获得所需计划批准时，只允许当前宿主核实的只读分析、计划管理以及准确计划文件修改。准确 Plan 文件的允许编辑由专用适配器保存为新 Planning 版本，不扩大为任意文件写入；其他文件、Shell 和子任务效果仍受原约束。子 Agent 按真实父委派继承计划义务和权限交集，不能用父计划批准替代自己的工具许可。

## 计划、批准与步骤事实

`read_plan`、`write_plan`、`request_plan_review`、`update_plan_progress` 通过同一 Planning owner 管理原记录。正文、标题与步骤身份按当前工具合同校验，不恢复退役的固定字数、步骤数量或 PlanDocument 版本门槛。

`planning.write` 保存不可变计划版本并以 CAS 更新 `plan.current`；默认宿主另保存准确 `plan.md`。保存不是批准。审核绑定准确 plan ID、version、digest、原 Run 和 accepted Interaction；修改正文或结构后保存新版本，旧批准保留为历史。后继 Run、Fork、恢复后的新任务或相同计划 ID 不能借旧批准派发新效果。

`planning.update` 保存独立 progress revision。步骤完成必须引用该 Run 真实成功 Tool／Job 的原 Store、attempt、定义版本、input digest 与 result revision，并核它执行时捕获的准确计划来源；自报成功、未知效果、旧 Run 或旧计划回执不能替代。完成阶段重新读取完整计划、批准、progress 和原 receipt，最终事务核验后才可完成原 Run。

进度不混入稳定计划来源或批准摘要，避免自己的进度更新使普通工具批次失效，也不让先前成功回执随进度变化失效。压缩后的原用户要求和有效父委派仍按原来源保留；已完成步骤与失败原因按现有证据恢复。模型进度不可见时应先 `read_plan`，缺少原调用或结果时只能通过已有读取工具和保留的准确引用恢复；引用也丢失时应报告证据不足，不能靠重跑原操作找回结果。历史可读不等于重新执行、批准或恢复许可。

## 文件异常、反馈与客户端

准确计划文件与持久记录不同步、发布未完成或外部修改时，阻断新的执行效果。文件已经发布后发生记录或读取错误必须保留原结果未知与实际字节，不得宣称未写入后重投。恢复继续核原命令、准确版本、当前文件和原独立权限；普通查询不重放操作。

方案审核的原 `approve/revise/deny`、实际 mode 和完整反馈交回后继 Model。提出修改或拒绝不保存批准，也不自动创造另一任务；新的准确版本仍需独立审核。用户停止原 Run、工具被拒绝及普通问答各自沿当前 Loop 和回执合同处理，不能恢复旧客户端以本地阶段或状态文字推断取消、完成或权限的行为。

TUI、Native 和 Web 的实际操作入口与能力差异由各自手册负责。查看历史、客户端选择计划意图、显示旧方案或重新打开会话，都不能生成批准或回放效果。

## 历史机制

删除前的 Kernel Task、事件 reducer、PlanDocument V2、旧 `update_plan`、阶段 ceiling、专用验证工具和固定 completion guard 不定义当前实现。相关历史理由保留在[原计划生命周期](../../.agents/notes/implemented/process/2026-07-02-plan-lifecycle.md)及[旧 Shell 审批队列决定](../../.agents/notes/implemented/bug-fix/2026-08-25-shell-sandbox-durable-approval-queue.md)；它们仍有价值的准确身份、未知结果、数据保护与独立授权要求由上文和当前 owner 承接，不能据旧事件或旧 TUI 行为恢复另一套执行阶段或审批规则。
