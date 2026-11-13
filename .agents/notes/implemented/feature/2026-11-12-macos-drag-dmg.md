# Agent Note: macOS DMG 使用 Finder 拖拽安装

Status: implemented

## Problem

用户希望从 macOS DMG 的 Finder 窗口直接拖入应用，并通过 Finder 完成替换和移到废纸篓，同时保留用户数据。

## Decision

DMG 放置可独立运行的 `Kite Desktop.app` 和指向 `/Applications` 的快捷方式。桌面专用 Native 候选随应用一起复制，启动时仍验证包内清单，并使用原 Native 运行锁。Profile、Electron 用户数据和工作区保留在应用包外。

复用 [Windows 桌面专用构建的模块链接方式](2026-11-12-windows-desktop-only-installer.md)，用私有模块映射加载桌面服务依赖，并随包保留 macOS arm64 原生绑定和运行资源。构建与嵌入运行时清单拒绝 `node_modules` 和独立 CLI/TUI/Terminal Web 入口。已有完整候选仍可由原 Native 验证器读取，Finder 可用新候选直接替换旧 `.app`。

[随包 Node 决定](../architecture/2026-11-12-macos-desktop-dmg-node.md)更新桌面专用 Service 的运行时与签名顺序。Finder 布局和应用包外的数据边界沿用本决定。

安装包的最低 macOS 版本来自打包后的 arm64 Mach-O 部署目标。SQLite 动态库等构建输入可以要求比 Electron 更新的系统版本，应用元数据必须反映随包交付的实际运行时。

使用 Developer ID 构建时，签署嵌入的原生代码后才写入对应清单，再签署外层应用和 DMG。系统签名会改变程序文件的字节，按这一顺序可以同时保留包内校验和系统签名。Apple 公证票据附加到外层映像后，构建计算用于交付的 DMG 摘要。

## Alternatives considered

- [独立安装器预览](../../archived/feature/2026-11-12-macos-managed-dmg.md) 可以管理运行中的候选和版本选择，需要额外安装交互。用户选择了 Finder 拖拽流程。
- 把外层应用用作首次启动的安装器会在应用包外创建另一份程序树，移到废纸篓后仍留下程序文件。候选留在应用包中便于 Finder 整体替换或移除。
- 首版拖拽式 DMG 复用完整 Terminal，随桌面交付了 CLI/TUI 和生产 `node_modules`。直接删除依赖目录会使桌面服务的模块解析和清单校验失败。桌面专用构建在链接阶段确定所需模块和本平台资源。

## Consequences

替换和移到废纸篓前需退出应用。Finder 负责文件操作，原使用锁继续供 Native 运行时使用。此前装过独立安装器预览的用户可先用原安装器卸载。构建及验收证据归 [Native 发行 owner](../../../../apps/desktop/docs/native-release.md#macos-dmg)。
