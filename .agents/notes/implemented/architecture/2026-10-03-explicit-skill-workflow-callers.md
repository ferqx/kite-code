# Agent Note: 终端的显式 Workflow 意图与只读资格

Status: implemented

## Problem

既有 TUI 动态 `/<Skill 名称>` 和旧 CLI `--skill` 会请求用户 Workflow activation。通用入口已经交付的 `--skill` 则选择每 Run 可按需读取的知识；知识目录 available 不能证明 manual invocation、原输入 schema、真实功能开关或 fork/verifier 绑定可用。共享 Service 的客户端也不能用本机文件推断远端配置。

Skill 目录当前是闭合 DTO。直接给全部知识读取加字段会使旧 Client 拒绝原本可读的目录；把 Workflow 意图塞进活动 Run 的 steer 则会改变原 Run 的契约。丢回执和会话切换还可能导致重复启动或清错草稿。

## Decision

保留知识选择 `--skill`，增加明确 `--activate-skill`；TUI 恢复既有动态名称。两者使用真实 compiled name/ID 唯一匹配，原空对象 input 保持不变，任务文字仅作为 content。需要其他结构化输入的 Skill 明确拒绝，不猜测字段或自动打开 flags。

现有 SkillCatalogue 增加显式 `workflow=manual` 查询和独立 `skill_workflow_catalogue` capability。仅 opt-in 返回闭合 Workflow metadata，普通知识响应保持原 shape；capability 由实际 source 支持发布。目录与运行共享原可信来源编译及实际 Tool/Job/role facts，读取不选 Model、读 vault、连接 MCP 或创建执行。知识和 Workflow 状态独立；flags、完整 source revision、依赖与宿主绑定变化使对应分页 revision 失效。metadata 不含指令、路径或凭据，不预先授予执行权。

客户端一次冻结 commandId、原 Store/Session、content 与 `extensionInputs`。空闲任务使用 start，活动任务的显式激活使用绑定原 afterRunId/contextSelection 的 follow-up；普通输入保持现有 steer 行为。目录、提交和草稿归原 scope，迟到响应不能改新选择；unknown 只查原 Command，不再 POST。

## Alternatives considered

- 按 flags 让 `--skill` 在知识和执行之间自动切换：同一参数的副作用会随配置改变，且混淆已交付的知识选择。
- 用现有知识 available 或客户端本机 profile 推断 Workflow：缺少真实 manual/schema/能力绑定，在共享连接上也不是同一个配置来源。
- 新建一条独立目录发现与配置管线：会与运行准入分叉；复用现有目录、scope、分页和纯编译事实。
- 无条件扩展闭合响应：旧 Client 无法忽略新字段，因此采用明确 opt-in；不放宽现有响应对未知内容和敏感字段的校验。
- 活动 Run 直接 steer activation 或失败后重发：前者改变已封存义务，后者可能重复原任务；分别使用新 follow-up 意图和原 Command 查回。

## Consequences

终端调用者已接线：Service 目录与实际 Run 使用同源编译及绑定，Client 严格核 opt-in 全页与闭合状态；CLI argv 与实际配对/共享 Service、活动原 Run/new follow-up 和物理丢回执均已验证。TUI 有动态名称、原 scope/草稿 CAS、Ctrl+L 原 unknown 查回和实际 inline/fork PTY；目录失败在关闭面板时也显示原 scope 的有限原因。

完整 canonical compiled entries 回归修正两处可选 undefined，使知识、坏项与合法 Workflow 可同时落库；Core JSON、来源和权限门禁保持严格。最终冻结源码完整统一入口通过270个测试作业（parallel=87文件、isolated=253、exclusive=0），日志 `/private/tmp/kite-workflow-callers-unified-sixth-qualified.log`；根及26workspace build/types、API、边界、测试归属与格式通过。实际 Service/Client、CLI、TUI 与 paired/shared inline/fork 的具体断言及前五轮失败、修正和复验见[实施进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md)。旧 mock 和 PTY 前提修正保留原严格身份、期限、正文和零重放要求，不用局部通过抵消失败的整轮。

本决定只覆盖显式终端调用者，已交付[Workflow业务扩展](2026-10-02-skill-workflow-as-extension.md)继续负责原权限、输入和核验义务。repair/compensation/waiver、MCP管理、正式旧入口退役和其余恢复平台资格仍是完整V1.3的未完成范围。


## Risks

目录只是读取时的事实，不能预订后续文件版本或替代提交时的重新验证。公开知识响应仍闭合，新增投影只能显式请求；跨版本实例连接必须保留原准入检查。只读目录失败不得清除SSE未知状态，也不得阻断历史或其他会话的独立工作。
