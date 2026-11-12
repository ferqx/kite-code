# Agent Note: Windows 集成终端 Shell 绑定到新会话

Status: implemented

## Problem

同一台 Windows 设备可同时使用 Git Bash 与 Windows PowerShell 5.1。桌面用户需要在常规设置中选择新会话的解释器。既有会话的上下文可能依赖原命令方言，正在运行的命令也有各自的监督、权限和结果记录。

## Decision

Windows 桌面配套 Service 保存当前 Store 的枚举偏好。新建和 Fork 在创建事务内从该偏好确定实际解释器，作为根会话的私有绑定保存。重试创建沿原回执，子任务与继续对话沿根会话。已存在的无绑定会话保留自动选择基线。绑定是有限解释器身份，实际执行资产及权限仍由相应 Run 和 Job 核验。

常规设置只在 Windows 桌面提供入口。自动保留[原发现顺序](2026-11-12-windows-desktop-powershell-fallback.md)。用户明确选定的解释器不可用时，该会话无可用 Shell，已绑定命令不会被另一方言解释。

## Alternatives considered

- 应用重启后切换。Service 仍只会准备一个解释器，用户要求新会话立即生效。
- 每轮读取全局偏好。相同会话的后续或排队工作会突然切换命令语法，子任务也无法沿用原环境。
- 让 renderer 在新建请求中携带解释器。恢复及重试将依赖 renderer 的本地状态，创建原子性和会话归属难以保证。

## Consequences

两种方言可在同一 Service 进程的不同会话运行。设置保存和会话绑定由同一 Store 确认，界面读取实际保存状态。原生运行及已验收范围见 [Windows Shell 沙箱](../../../../docs/active/windows-shell-sandbox.md)，设置与创建验证归 [Desktop owner](../../../../apps/desktop/README.md)和 [Service owner](../../../../apps/service/README.md#默认-shell-装配)。
