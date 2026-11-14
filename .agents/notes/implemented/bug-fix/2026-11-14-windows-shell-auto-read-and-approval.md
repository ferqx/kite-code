# Agent Note: Windows Shell 的只读冷启动与一次性 Auto 审批

Status: implemented

## Problem

Windows Auto 将无法静态确认效果的 PowerShell 调用直接转人工。同一工具和它启动的内部 Job 各有一次权限检查，可能重复显示审批。Git Bash 的部分常用文件和 Git 查询也会被风险审核拦住。首次以可写范围派发会传播工作区 ACL，即使命令只读取文件。

## Decision

两种后端复用有限语法和固定工具身份识别常见只读操作，并使用原生 read_only 范围。独立 Git 查询使用固定 Git，禁用可选锁、延迟取对象和外部 diff／textconv，并把原 Job 的活动进程上限设为解释器加一个 Git。Windows 可写准备保留持久账本恢复，在同一次传播前只发布必要的未完成状态。

通过准入的 PowerShell 和 Git Bash 调用使用同一 Auto 风险合同。无法静态确认效果时，提供实际命令与可取得的直接入口快照。普通风险自动执行，高风险请求一次人工确认，严重风险拒绝。Tool 和它实际派发的准确自身 Job 复用原风险审核或人答。派发仍检查当前范围、目录和已审核入口。

这部分取代了 [PowerShell 回退](../architecture/2026-11-12-windows-desktop-powershell-fallback.md)在 Auto 中将未知效果直接转人工的决定。原系统委托拒绝、受限执行及其他审批模式继续适用。

## Alternatives considered

- 仅把常用命令名称列为免审。名称无法证明参数、解析出的程序和外部助手的实际效果，因此使用有限语法、固定程序及原生范围。
- 对未知 PowerShell 保留直接人工路径，再在原 Tool 和自身 Job 之间复用一次决定。这样可以消除重复弹窗，却仍会在缺少静态结论时拦下普通风险。复用已有的风险审核保留原材料与准确父子证明。
- 删除内部 Job 的权限检查。原 Job 需要独立核当前 scope、控制、取消与最终派发，因此保留检查并继承已接受的准确父决定。
- 延后或省略首次可写 ACL 传播。既有文件的继承准备和取消恢复需要完整传播，采用只读绕过可写准备并减少重复账本写入。

## Consequences

只读命令无需等待工作区可写账本。首次真实写入仍承担随目录规模增长的传播成本。要求外部助手的 Git 配置可能产生 Git 原生错误，固定的 Git 查询不会改写配置和仓库。单一字面量 PowerShell 脚本入口复用严格的工作区文件读取与启动前复核，动态依赖留在已有风险事实的覆盖范围之外。独立调用没有继承单次人工决定的资格。原风险分类、运行时验真、协议与恢复的理由见 [Shell 风险事实](../architecture/2026-11-04-shell-risk-review-facts.md)与[当前 Windows 执行边界](../../../../docs/active/windows-shell-sandbox.md)。

[Windows 原生 Service 回归](../../../../apps/service/test/isolated/windows-shell-auto.test.ts)验证两个后端使用真实 Runner 的只读结果、普通风险执行、高风险一次批准或拒绝，以及严重风险拒绝。
