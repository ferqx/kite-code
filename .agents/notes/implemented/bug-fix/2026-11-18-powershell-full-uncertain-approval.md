# Agent Note: PowerShell 静态未知不覆盖 Full 模式

Status: implemented

## Problem

Windows 的真实 PPT 复测中，PowerShell 7 的有效模式为 Full，但 7 个命令产生了 14 张人工审批卡，分别归属外层 Tool 和实际 Job。条件、函数和原生命令调用被静态分析标为不确定后，Shell 将其转换成跨模式的独立人工要求。Git Bash 的同模式调用没有这类卡。该行为与 Full 不走常规逐项审批的产品定义冲突。

## Decision

只在 PowerShell 的能力细化中排除 Full 的静态未知转人工分支。保留 `unknown` 效果和原命令摘要；不改变通用权限层处理显式 `requiresApproval` 的语义。请求批准模式继续保本次人工审批，Auto 继续风险审核。没有当前模式的纯能力描述保持原行为。

Tool 和 Job 都执行自己的当前权限检查。有效 Full 在两层均可通过原普通策略，无须新增批准复用或跳过 Job 检查。父子模式交集、业务门禁、显式独立人工要求、语法错误、系统委托拒绝、受保护目标和原生执行边界保持。没有 CLI 名称例外、协议升级或客户端改动。

本决定部分取代 [PowerShell 回退](../architecture/2026-11-12-windows-desktop-powershell-fallback.md)的首版未知转人工规则；[Windows Auto 审批](2026-11-14-windows-shell-auto-read-and-approval.md)的风险审核和准确父子复用继续适用。当前实现与验证归 [权限 owner](../../../../packages/agent/src/permissions/README.md)和[Windows 执行边界](../../../../docs/active/windows-shell-sandbox.md)。

## Alternatives considered

- 让通用 Full 分支无条件忽略 `requiresApproval`。这会同时解除文件恢复等可信 owner 的独立人工要求，超出本次目标。
- 为 Tool 和 Job 复用本次人工批准。它只能减少第二张卡，仍会在 Full 下错误要求第一张卡；本次保留原分层核验，只纠正强制标记的适用模式。

## Consequences

PowerShell 5.1 和本机 PowerShell 7 的普通复杂调用遵循有效 Full。静态分析不因此获得对程序实际效果的证明，`unknown` 仍参与原材料与派发摘要。后续收紧为请求批准或 Auto 时重新沿当前模式检查，不把曾经的 Full 当成后续调用的许可。

[模式回归](../../../../packages/agent/test/isolated/permissions/powershell-command-policy.test.ts)覆盖两种版本、Tool／Job、三种模式及语法错误／系统委托／系统目录删除拒绝。[通用权限回归](../../../../packages/agent/test/isolated/permissions/policy.test.ts)保留显式独立人审在 Full 中仍生效的断言；[运行中模式回归](../../../../packages/agent/test/isolated/execution/live-permission-mode.test.ts)覆盖模式刷新、父子交集与旧许可失效。三种后端的 Native 窗口零工具审批、原生进程清理及补充测试的修复前对照结果归 [权限 owner](../../../../packages/agent/src/permissions/README.md)，不宣称完整 Auto 套件或真实模型复测资格。
