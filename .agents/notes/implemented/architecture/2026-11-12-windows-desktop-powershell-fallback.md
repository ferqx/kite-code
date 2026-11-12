# Agent Note: Windows 桌面缺少 Git Bash 时使用系统 PowerShell

Status: implemented

## Problem

Windows 桌面即使在普通目录运行文件检索，也会因为启动时找不到 Git Bash 而失去 Shell。Git 工作树依赖 Git，普通文件读取、查找和命令执行没有这个依赖。已有用户继续需要完整 Git Bash 的命令兼容性。

## Decision

桌面 Service 在启动时优先固定完整 Git Bash。只有发现阶段确认缺少该入口时才定位系统 Windows PowerShell 5.1，并将选择的方言交给模型。每条命令固定原解释器、资产、工作目录和权限，已派发命令留在原 Job。Service 和原生 Runner 在同一制品同步使用内部 V7，沿用现有模型工具和持久记录。

PowerShell 使用独立 AST 分析、受限令牌、目录 ACL 和 Job Object。已知联网与外部写入分别要求对应范围。无法确定效果时申请本次人工批准，已识别且无法纳入原 Job 的委托在准入阶段拒绝。当前离线范围沿 Windows 环境约束，系统级断网作为单独的 AppContainer 兼容与隔离工作。

## Alternatives considered

- 找不到 Git 后直接运行未受管 PowerShell。会丢失当前目录写入和后代进程边界，所以 PowerShell 直接进入原生 Runner，并使用与方言匹配的审批分析。
- 首版要求系统级断网。它需要单独核验 AppContainer 与 PowerShell 的兼容性，首版保留已确认的 Windows 网络环境语义。

## Consequences

无 Git 的 Windows 桌面仍有普通 Shell 和内置 rg。Git 相关能力按 Git 自身可用性装配。支持两个方言意味着测试覆盖启动选择、已解析路径、独立授权范围以及原 Job 的取消和清理。当前实现和实测范围见 [Windows Shell 沙箱](../../../../docs/active/windows-shell-sandbox.md)与[桌面安装](../../../../apps/desktop/docs/native-release.md)。

本决定在桌面选择和 Runner 协议上部分替代[工具退役决定](2026-11-02-tool-surface-retirement.md)中的旧 V6 描述。原无账户令牌、完整 Git Bash、独立文件与联网范围和既有工具退役继续适用。

[按会话选择 Shell](2026-11-12-windows-desktop-shell-preference.md)取代全桌面 Service 固定一个解释器的选择方式。启动时的自动发现顺序、两种后端的安全边界和 Runner V7 继续适用。

Git Bash 的随附命令和运行时资产取舍见[使用 Git Bash 随附命令](../simplification/2026-11-12-use-git-bash-utilities.md)。
