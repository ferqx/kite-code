# Agent Note: Windows 受限 PowerShell 的请求批准归实际 Job

Status: implemented

## Problem

一次真实图片任务先后等待外层 Shell Tool 和内层 Job 的人工批准，累计约 319 秒。两张卡对应同一条附着 PowerShell 命令。实际 Job 派发后约 1.9 秒结算。另一轮遗留了尚未派发的 Job，桌面默认先显示该轮旧卡。

## Decision

请求批准模式下，由实际启动进程的受限 PowerShell Job 提交默认人工审批。经过自身硬限制核验的可信父 Tool 只获得调度资格，且当前策略须包含该 Job。派发仍检查准确命令、目录、范围、当前策略、审批回执和取消。独立策略和不属于该附着关系的工作各自判定。 [当前策略](../../../../packages/agent/src/permissions/README.md) · [产品手册](../../../../docs/handbook/features/tools-and-approvals.md)

## Alternatives considered

- 由 Job 继承已批准的父卡。这样需要封存并校验第二份原操作证明，还要复核两个审批身份之间的差异。把决定交给实际派发者可以直接使用已有的计划、回执与最终派发事务。
- 在桌面合并两笔待批操作的卡片。这样会改变可见卡数，却无法结算另一笔授权，也会使取消与恢复难以对应原操作。

## Consequences

人工等待只出现在拥有外部进程效果的原 Job。相同命令的下一次调用在新 Job 下独立校验。正在等待的旧批准仍按自己的身份处理。Auto 继续沿原风险证据，Full 继续沿有效模式核验。 [Auto 决定](2026-11-14-windows-shell-auto-read-and-approval.md) · [Full 决定](2026-11-18-powershell-full-uncertain-approval.md) · [真实受限进程对照](../../../../apps/service/test/isolated/windows-shell-auto.test.ts)
