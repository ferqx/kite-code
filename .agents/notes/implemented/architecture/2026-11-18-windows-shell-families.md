# Agent Note: Windows Shell 类型与已安装版本分开

Status: implemented

## Problem

用户确认 Windows 设置只显示 PowerShell 和 Git Shell，默认优先 Git Shell。当前实现将系统 PowerShell 与 PowerShell 7 当成两个独立后端，发现过程中命中首个可用候选即返回，不能保证选到本机最高可用版本。按版本号分散的选择还会让普通命令的权限、进程和输出行为难以协调。

## Decision

- 设置只提供 PowerShell 与 Git Shell 两类，默认沿 Git 优先、不可用时选已核验 PowerShell 的现有可用环境发现。Git Shell 使用本机 Git for Windows 运行时，不固定 Git 或 Bash 版本。
- PowerShell 枚举本机安装登记、系统程序目录和受信任 PATH 候选，实际启动固定探测读取版本和解析器位置，核实运行资产后比较全部可用候选，选择最高实际版本。不可用候选不能遮挡其余安装，探测清理未知仍停止。数字版本按数值比较，同版本正式版高于预发布版。
- Shell 与宿主解析器固定使用同一安装。实际版本／edition 作为环境事实交给模型，不按固定版本分叉审批或 Job 生命周期；只有 CLR 与独立运行时所需的资产布局继续按真实安装描述处理。
- 旧 `auto`／`powershell-7` 偏好、会话和协议字段兼容读取，不删除历史格式信息；新设置与新绑定归为两类。已派发 Job 和冻结 Run 不改解释器，旧恢复仍核资产与配置。新 PowerShell 装配重新发现最高可用安装。
- 不升级工具／原生协议版本，不增加 CLI 专属规则，不安装解释器或修改系统设置。

本决定部分替代[按会话选择 Shell](2026-11-12-windows-desktop-shell-preference.md)和[缺少 Git 时回退](2026-11-12-windows-desktop-powershell-fallback.md)中的独立版本选项、首个候选和系统版本优先规则。原类型绑定、创建原子性、命令固定资产、可信安装来源、权限及 Job 清理理由继续适用；新装配可更新同一 PowerShell 类型的实际版本，不改变已冻结执行。

## Alternatives considered

- 保留独立的 5.1／7 选项。与用户确认的两类设置不符，未来安装版本还会继续扩大枚举。
- 按路径顺序选第一个可执行文件。候选顺序不等于真实版本顺序，无法满足最高可用版本。
- 删除旧偏好和会话枚举。会丢失已保存记录的解释与恢复边界，因此只停止新界面提供这些选项，保留兼容读取。

## Consequences

发现和资产校验可能增加装配耗时，必须合并同次在途发现并完整关闭探测进程。新安装选择可能改变新 Run 的配置摘要，不能静默替换已冻结执行。历史字段继续存在只是兼容，不应再次成为客户端版本选项。

Windows x64 本机同时核验系统 5.1.26100.10066 与独立运行时 7.6.9，最高选择为后者。数值／预发布排序、设置与存储兼容、原生策略、模型入口和 Native IPC 定向回归共 97 项／1228 断言通过；Windows Job 的 8 项／139 断言另核 UTF-8、范围、准备取消、后代停止、宿主退出与清理。真实 Native 开发窗口使用本地受控 Provider 执行四个 Run／Job，覆盖 Git 默认、选择 PowerShell 后的新会话、原 Git 会话继续、测试 PATH 移除独立运行时后冷开执行系统版本；设置、模型及输出版本一致，清理与进程树停止确认。完整当前行为和范围归 [Service owner](../../../../apps/service/README.md#默认-shell-装配)、[Shell owner](../../../../packages/agent/src/jobs/README.md#windows-桌面-powershell-回退)与 [Desktop owner](../../../../apps/desktop/README.md#windows-集成终端-shell)。

版本变化的合成装配回归还覆盖未来 8.1.0 与不可用状态；这不等于在本机安装或运行 PowerShell 8。未以本轮受控 Provider 证明远程模型效果、任意用户安装或正式发行资格。
