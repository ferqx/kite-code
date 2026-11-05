# Agent Note: 只读任务指导与继承的执行权限

Status: implemented

## Problem

只读子角色的 Shell 准入曾复用有限只读分类，只允许单条字面量 rg／ls／pwd。合法的 `cat source.txt && rg ...` 因语法形状被拒，实际查询未完成。该设计混淆了三件事：角色应完成什么任务、哪些准确调用需要审批、进程最终拥有哪些系统能力。继续扩大命令表无法完整判断脚本、hooks 与后代的效果，也容易把普通能力描述器变成角色专属执行规则。

## Decision

用户确认参考已有成熟实现并采用最小调整后，移除只读子角色专属的 Shell 命令硬门禁。explore／plan／review 继续收窄工具集合，并通过既有 Sources 捕获链接收可信只读任务指导；原指导及角色文本进入可选私有配置快照，恢复只按原内容捕获，旧快照缺字段不补造指导。

Shell 继承父会话当前审批模式、父子权限交集和普通平台沙箱。有限 safeRead 仅提供普通免审事实，未证明只读的调用进入原模式判断。Auto 在需要审核时分别评估实际动作风险和准确任务授权；请求批准与 Full 保持各自含义，不添加覆盖三种模式的角色语义审核器。主会话 Planning、工具交集、硬拒绝、受保护资源和最终派发证明仍独立生效。

角色只读属于任务约束，不提供独立的技术禁写／禁网保证。模型违反任务时，请求批准模式可能允许工作区写入，Full 可能允许普通外部写入；不能把角色名、提示词或单次遵循任务的样本称为强隔离。角色专属 OS 上限仍[不采用](../../rejected/architecture/2026-11-03-shell-readonly-role-os-ceiling.md)，本决定只替代该旧记录中“保留命令门禁”的部分。

## Alternatives considered

- 扩大只读命令白名单：仍混淆免审分类与角色准入，无法穷举任意脚本效果。
- 所有模式都强制角色语义审核：新增一套权限机制，改变 Full 的含义，并不提供 OS 隔离保证。
- 新增角色专属 OS 禁写／禁网：属于额外平台保证，本轮明确不实施。
- 只删除门禁、不传角色任务：父模型选择角色的说明不能保证实际子模型收到只读要求，因此保留并验证可信 Source 注入。

## Consequences

[角色 owner](../../../../packages/agent/src/extensions/task/README.md)、[权限 owner](../../../../packages/agent/src/permissions/README.md)、[Service owner](../../../../apps/service/README.md#默认-shell-装配)和[授权契约](../../../../docs/active/authorization.md#当前-v13-正式授权)记录当前职责。三模式原生执行、Auto 的准确 Tool／Job 审核和拒绝零效果由[Shell 回归](../../../../apps/service/test/isolated/shell-configuration.test.ts)验证；[指导输入回归](../../../../apps/service/test/isolated/child-readonly-guidance.test.ts)核真实五类子模型输入、原 Source 冻结与独立 host Source 恢复分支。该恢复分支不等同于完整 child Run 冷恢复；既有外层角色封套不被恢复入口识别的问题未在本轮修复。

真实模型的正常委派、复合查询和正文注入样本归[原审批验收入口](../../../../tests/e2e/live/model/README.md#审批策略与原生-shell-执行)。受控适配器故意写入的反例证明普通权限边界，不代表真实模型会违反任务；真实模型遵循任务的样本也不能反推后端禁止写入。既有拒绝反馈改动继续把真正 Gate 产生的可公开原因交给下一模型，私有适配器错误不因此公开。
