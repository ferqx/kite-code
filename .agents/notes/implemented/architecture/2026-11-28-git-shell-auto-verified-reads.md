# Agent Note: Git Shell 在自动审核后使用受限工作区执行

Status: implemented

## Problem

Windows Git Shell 的 Auto 审核批准 `date +%A` 后仍弹出逐次确认。原 Job 将命令按原装 Git Bash 的当前用户文件与网络权限启动。用户要求可核实的读取和普通工作区写入通过审核后直接运行，高风险调用仍要确认。

## Decision

默认工作区范围内，Auto 审核通过的普通调用派发到从该会话 Git 安装准备的受限副本。Bash 字面量检查器核实的读取使用只读范围，日期查询固定该安装的 `date.exe` 和验证后的参数。其他命令使用工作区写入约束，单次授权绑定命令和实际范围。派发复核原安装、兼容库、副本和最终权限。受限准备或执行失败时结束原调用。

原装 Git Bash 的放行仍需完整文件及联网权限。高风险审批和严重风险拒绝仍由实际 Job 处理；同意高风险调用只授予本次声明并获准的执行范围。

## Alternatives considered

- 直接用原装解释器和受限令牌。实际 `date +%A` 在解释器初始化时以 Windows 错误 `0xC0000142` 退出。
- 用普通风险结论放行原装进程。风险结论无法收窄 Windows 用户令牌，原装进程仍可访问用户的文件和网络。

## Consequences

首个满足条件的 Git Shell 调用需要准备并核验受限运行时。后续派发可复用副本，但仍核验原始安装、执行文件、权限与命令范围。规则与验证见 [Shell owner](../../../../packages/agent/src/jobs/README.md#默认-windows-git-bash)和 [Windows 执行边界](../../../../docs/active/windows-shell-sandbox.md)。
