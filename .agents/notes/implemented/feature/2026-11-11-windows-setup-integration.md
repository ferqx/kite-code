# Agent Note: Windows 桌面安装和卸载集成

Status: implemented

## Problem

离线安装器每次把已解包的候选再复制一次，安装结束时还需移除原树。旧开始菜单直接启动控制台前门。已有安装目录、桌面快捷方式和 Windows 卸载入口需要归同一套安装流程管理。

## Decision

[Windows 安装 owner](../../../../scripts/release/windows-native-install.ts)在选择锁内验证目标卷的解包目录，按同卷移动发布，并在写入 active 前验证正式位置。相同内嵌候选由归档摘要和已安装候选共同校验后复用。[系统集成](../../../../scripts/release/windows-setup/shell-integration.cc)优先读取当前用户登记，并用旧开始菜单快捷方式识别此前已安装的目录。安装器按用户选择更新桌面快捷方式。

[GUI 程序](../../../../scripts/release/windows-setup/setup.cc)位于 managed Native 根的旁边。它为桌面快捷方式调用原安装前门，也接受 Windows 卸载命令。卸载从已安装候选按摘要暂存运行时，沿原锁、文件核对和卸载逻辑移除程序，随后清理所属快捷方式和登记。

## Alternatives considered

- 解包后再复制能隔离不同卷上的文件，但安装解包目录本身位于目标卷且在同一选择 owner 内。采用一次移动可省去整树复制及解包树删除。
- 更新已装控制台前门会牵涉旧 bootstrap marker 和候选的绑定关系。GUI 程序启动原前门，继续使用已验证的引导链。
- 持久安装另一个完整运行时会增加体积，并给卸载维护引入第二份运行时。用已安装版本的 Bun 和受验证的短期暂存完成卸载。

## Consequences

安装器和普通归档安装共享候选发布。Windows 登记和快捷方式由安装器维护，managed Native 卸载继续保留 Profile。用户操作与验证范围见 [Native owner](../../../../apps/desktop/docs/native-release.md#构建与安装)。目录策略沿[目录选择决定](2026-11-11-windows-setup-location.md)。

离线安装器当前使用[桌面专用布局](2026-11-12-windows-desktop-only-installer.md)。本记录保留早期 GUID 辅助目录和卸载运行时暂存的依据，现行安装器读取旧登记以完成替换。
