# Agent Note: 单次计划意图以原 Run 义务和批准版本执行

Status: proposed

## Problem

新通用 Planning 已有 ordinary Tool、真实计划审阅与完成证据，但默认工厂仅有 trusted 全局 requirePlan，TUI `/plan` 或 Shift+Tab 的单次意图尚未接入。仅改变 UI 提示、沿用 Full 或复用同 Session 的旧批准都不能证明当前任务先规划再执行。现有 SourceRequest 不含 Run 身份，不能从模型输入猜测当前批准权。

## Proposal

原 `run.start/input.follow_up` 的通用 extensionInputs 可显式携 `builtin.planning@1` 的闭合 `{mode:'plan'}` 意图。Service 分发已知扩展输入，保持 Core 的原 Command 摘要与幂等；规划与 Workflow 的 envelope 独立，未知/重复/坏输入在凭据和 Provider 前拒绝。单次意图加强原 Run 义务，不改变 Agent 类别、Loop、基础 schema 或后续普通对话。

Planning initializer 允许 trusted host 对本 Run 单调设置 requirePlan，并封存来自实际已装配 safe-read Tool 的准确 kind/id/version。Model、Skill、JSONC 和远端 annotations 不能提供这个集合。未批准时仅 Model、原 Planning 管理工具和这些准确只读定义可派发；Job、child、Shell、写入或未知效果不因 Full 越过计划。现有 trusted requiredValidation/automaticValidation 和硬拒绝继续保持。

新批准使用 run-specific immutable key，绑定原计划 ID/version/digest、实际 review Execution 的原 Store/Session/Run 和 accepted Interaction proof。旧 Session 级批准保只读，不满足后继 Run。有限 readPlanningState helper 复用原 proof 验证并只投影 pending 或 auto/accept_edits；它不返回 grant，最终 necessary condition 连同全部 record read-set 在实际事务重核。计划完成仍须真实 step receipt 和 required 验证，模型自报完成不构成证据。

选定计划执行方式是当前 Permissions 之外的上界，Service 组合当前硬能力、信任、撤权、审批与 review，不把计划批准借给 Tool/Job。Full 在计划前仍被精确只读义务限制，批准后仍遵守选择方式与独立最低审批。原单次意图、只读定义和可信策略进入安全 snapshot；冷重建在 vault 前核完整相等，不能沿最新默认偷换旧计划。

SourceRequest 维持现有公共契约。上下文贡献保完整当前计划；批准摘要只有实际批准 Run 仍 active、同 Session 且 run-specific proof 可核才出现，否则为 null。它只提供信息，不推断来源输入或成为当前 Run 权限。TUI draft selector 本身零业务 POST，提交后固定原 Store/Session/Command 与闭合意图；切换、断线和未知只查原申请。`/plan <task>` 使用同一链。

## Alternatives considered

- 新增 planning Agent/Run 类别：拒绝，业务只加强 existing Extension requirement。
- 切换 UI 提示却未提交意图：拒绝，无法证明真实 Run 有规划门禁。
- 把 readonly 或执行方式交给模型声明：拒绝，能力元数据由实际宿主登记，决定来自真实用户 proof。
- 同 Session 旧批准自动供新 Run 使用：拒绝，执行来源与工作身份不同。
- 计划批准替代 Tool 许可：拒绝，当前权限、撤权与独立 Job 审批继续分别核验。
- 为贡献添加猜测的 Run 字段：拒绝，当前公共请求没有该事实，使用实际批准 Run 的信息资格而非伪造 authority。

## Current implementation

原 Run initializer/proof/helper、Service 闭合输入分发与计划方式上界、TUI 三种单次入口均已实施。child 上界读取实际原 parent Run 而非创建新的 child 意图，Core 既有必要条件引用仍在最后事务核原 head/proof；Full、当前 Ask/trust 与独立 Tool/carrier 批准分别验证。大计划通过原 review Execution Artifact 与不可变 seal 绑定完整 canonical 正文，hash/UTF8/原 scope/计划 version 与原 accepted request 在接纳前后核实，不增旧正文/步骤 quota；缺失、字节/版本/record revision 漂移均零批准。

原结果报告的新 Run 在实际 source/carrier/afterTurn 应用事务继承父 requirements；initializer 不重新登记外国 Run refs或产生新 Plan/Workflow 意图。默认 Service 的有限历史 helper 核实际原 report Command/receipt、source Execution、carrier result revision、父 config/root work/主体，才沿原批准执行方式约束报告；任意同 Session 新 Run不获得例外。Planning 历史 receipt 的来源 digest 从原实际 Execution及原批准Run重建，与当前信息贡献共用纯 payload；当前 inactive Run 仍贡献 approval:null。把 current contribution直接当历史 receipt摘要会令原合法任务完成后无法报告，取消 report 原义务或重用旧批准则会扩大权限，因此保留两种明确读资格。

当前真实证据为 Planning/Artifact及关联业务三文件50/454（原49/447与历史receipt1/7）、默认Task/Planning相关九文件48/747（含全部默认报告11例）、TUI文件/Plan十九文件119/1063（四个80×24 Plan窗口、约143KB原Artifact、排队/跨Session草稿、原answer POST/firstGET损失）。各 owner维护实际路径与边界。Root原SQL报告继承独立Store测试12/102，当前关联恢复组合另验。proposed保留：客户端强杀后的普通Work/Planning申请intent持久查回、全部正式消费者与平台资格未完整交付；本片进程内unknown原GET不代替这些接受标准。早期report initializer/null-parent权限/head漂移调用Provider/历史来源失配及中途装配失败日志分别保留。

Native 正式入口现沿同一闭合意图提供“先审核计划”：空闲 start 与 active follow-up 各固定原身份，选择本身零 POST。共享面板显示准确版本全文与步骤，原反馈由真实 ToolResult 进入下一 Model，新版重新审核；Auto/Accept Edits 仍各受独立 Tool 权限约束。页面草稿按原六元身份保存，只在准确回执、原卡替换/终态或实际原 Run cancelled 时清对应键；不把 bounded 页遗漏、Promise resolve 或读失败当作清理证明。

Native 完整附件复用公开 SDK 原 scope/EOF/SHA/UTF-8 证明，Main 另核完整传输才允许回答。单靠 renderer 自报已读不足以保护真实入口；普通同作用域刷新保仍 offered 的已完成证明，在途读取仍中止，真正 selection/reset 则撤销证明和旧正文资格，反馈草稿保留。当前 [Native owner](../../../../apps/desktop/README.md#native-计划入口与完整审核)与 [当前进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)记录实际页面/边界反例、独立审查、搬迁无构建源候选及正常 Service 退出后的原 Store 冷读。该本机窗口已核原反馈 v2、两种方式、独立许可、拒绝与原 Run 取消；已尝试 review 的未知结果保持，测试 dialog 响应不证明系统 modal 点击。提案仍为 proposed：完整普通 Work/Planning 跨进程 intent 查回、全部正式消费者与平台标准未全交付。

## Acceptance criteria

真实 SQLite/固定 Model/默认 Service/公共Client核单次初始化先于首个Model、准确只读分析、批准前写/Job/child零效果、Full不能绕过、旧Run批准/错版本/摘要/来源不复用。实际批准后按选择方式执行独立审批，真实 step/required evidence 完成。审批与最终条件之间的 head/record/control 变化零旧派发；冷 snapshot不等零vault/Model。无意图普通对话保持。真实80×24 TUI `/plan`/Shift+Tab、原完整plan review/修改、unknown原GET、切换与取消读取零额外POST，之后才能记录客户端资格。

## Risks

完整大计划 Artifact 链已取得上述原 scope/hash/UTF8/seal 实测；单消息和实际 Worker/存储资源边界仍须成立，不能靠此提案新增旧字数或步骤 quota、删除产品全文承诺。current Permissions 与选择模式组合不能丢 control read-set、hard denial 或独立 review/approval。公共贡献是信息，最终实际事务 proof 才负责执行资格。正式 TUI 与 Native 已沿新入口消费上述单次意图；完整跨进程申请查回、Shell/MCP 自动验证及其他平台资格仍未全验收。

当前业务合同归 [Planning owner](../../../../packages/agent/src/business/planning/README.md)，宿主接线归 [Service owner](../../../../apps/service/README.md)，产品预期归 [TUI 计划](../../../../docs/handbook/clients/tui/guides/planning.md)与[共享计划语义](../../../../docs/handbook/features/planning-and-tasks.md)。
