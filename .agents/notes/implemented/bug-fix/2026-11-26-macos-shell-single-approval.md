# Agent Note: macOS 附着 Shell 的单次默认批准

Status: implemented

## Problem

在请求批准模式下，真实桌面用例先在 Shell Tool 出现批准，再在同一命令的附着 Job 出现第二张卡。仅在第一张选择“允许后续运行”或“允许此命令后续联网”不会覆盖原 Job；第二次执行又要求人工，和用户对精确命令复用的预期不符。

## Decision

macOS 正式宿主保留唯一的父 Tool 默认人工决定。仅本次与后续范围对该 Tool 按原合同生效；其唯一、准确附着的 Job 由可信 Shell 行为准备窄证明，Store 核原出处、父子输入、实际权限与原批准或未撤销的授权，再在最终派发核验。独立审批策略、分离运行和其他平台不借用这份证明。 [权限 owner](../../../../packages/agent/src/permissions/README.md) · [Shell owner](../../../../packages/agent/src/tools/shell.README.md)

## Alternatives considered

- 沿用受限 PowerShell 的 Job 唯一审批做法。当前 macOS Shell 的内层 Job 输入没有父工具的执行期限和生命周期信息，不能用内层摘要替代父工具完整命令授权。Windows 原行为仍适用其既有条件，见 [PowerShell 决定](2026-11-25-windows-powershell-job-approval.md)。
- 保留两张卡，通过文案说明分别授权。不会解决同一精确意图的重复确认。
- 仅在桌面隐藏或合并卡片。不能代替授权结算及最终派发检查，其他客户端也仍会遇到同一等待。

## Consequences

默认内层 Job 不额外保留一个缺少外层运行条件的同命令范围。执行边界不因卡片减少而改变；变化请求按实际现行权限重新评估。端到端测试使用真实本机 Service、隔离工作目录及实际 Shell Job，检查卡数、原决定、范围复用、拒绝零效果，而非只断言渲染。 [Service 回归](../../../../apps/service/test/isolated/shell-configuration.test.ts)
