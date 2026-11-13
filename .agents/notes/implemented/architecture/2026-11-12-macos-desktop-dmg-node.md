# Agent Note: macOS 桌面 DMG 使用随包 Node

Status: implemented

## Problem

已迁移的完整 Native ZIP 使用随包 Node，Finder 拖放 DMG 的桌面专用候选仍带 Bun。桌面用户需要能在未安装运行时的机器上复制、启动、替换、回滚和卸载应用。

## Decision

复用[完整 Native 的 Node 分发与 SQLite 绑定](2026-11-12-bundled-node-native-runtime.md)，保留 [DMG 的 Finder 安装与桌面专用布局](../feature/2026-11-12-macos-drag-dmg.md)。新 DMG 只接受 macOS arm64 桌面专用 Node 候选，Service 从包内 Node 启动。签署 Node-API 绑定后才构建嵌入它的 Worker，其余原生文件在计算清单前签署。旧 Bun 候选保留原解析和运行路径。

## Alternatives considered

- 复用完整 Node ZIP 的候选会把 CLI、TUI 和 `node_modules` 放回桌面 DMG。
- 让 Electron 自带的 Node 执行 Service 会更改独立 Service 的私有管道和退出边界；沿用随包 Node 使两个 macOS 发行路径共用 Service 入口。

## Consequences

桌面专用候选的 Service 依赖由 `terminal/code/package.json` 的私有模块映射加载。网页提取依赖的 CSS 数据在构建时编入包内，运行时无需访问构建机文件。Node 和 SQLite 的身份由内层清单绑定，Electron 使用相同清单定位并核对它所加载的 Node-API 文件锁绑定。

回滚由 Finder 复制旧应用完成，旧应用从自己的制品启动。桌面 DMG 不附带管理式 ZIP 的维护命令。实际 Finder 与宿主运行时隔离的验证见 [Native 发行说明](../../../../apps/desktop/docs/native-release.md#macos-dmg)。

本机验收使用 ad-hoc 制品。公开发行继续要求 Developer ID 和公证制品复验。
