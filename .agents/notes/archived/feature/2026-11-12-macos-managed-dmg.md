# Agent Note: macOS DMG 复用受管 Native 安装

Status: implemented
Archived: 2026-11-12

## Problem

macOS Native 已能从完整归档安装。磁盘映像还需要提供 Finder 中可打开的安装器、稳定的应用入口，以及更新和卸载时可证明的数据边界。

## Decision

DMG 包含一个 AppKit 安装器和一份完整 Native 候选。安装器以固定摘要准入随包 Bun 和 worker，worker 在私有可写目录准备候选，再使用现有 Native 安装、版本选择和卸载。个人 Applications 中的应用入口与受管程序树分别发布，卸载前核实应用入口身份和所有候选的独占使用权。原 Profile、Electron 用户数据和工作区保持在程序树外。

## Alternatives considered

- Finder 拖放整个自包含应用。替换和移到废纸篓会绕过既有版本选择和运行占用检查，无法沿用当前受管卸载边界。
- 直接从只读卷安装 Native 目录。源候选的双使用锁需要可写位置，因此先复制到私有暂存目录并校验。
- 在 DMG 中另带 Bun 和归档。物理候选自身已带可校验的 Bun，保留单份运行时可以同时供安装器和已安装服务使用。

## Consequences

安装和更新使用同一稳定应用入口。已运行的旧候选保留原使用权，重开时读取更新后的选择。卸载入口留在 DMG，拒绝删除未知同名应用和仍有使用者的候选。构建与本机验收归 [Native 发行 owner](../../../../apps/desktop/docs/native-release.md#macos-dmg)，公开签名及公证归 [发布边界](../../../../docs/active/release-control.md)。

该预览由 [Finder 拖拽方案](../../implemented/feature/2026-11-12-macos-drag-dmg.md) 接替。已经安装的预览程序仍由当时交付的 DMG 卸载。
