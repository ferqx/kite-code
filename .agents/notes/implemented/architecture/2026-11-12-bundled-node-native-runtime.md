# Agent Note: Service、Agent 与发行制品统一使用随包 Node

Status: implemented

## Problem

macOS 的完整 Native 候选通过 Bun 启动配套 Service、内含 Terminal 和一部分系统助手，安装维护也依赖 Bun。桌面本身已有 Electron Node。已确认的目标是让用户从发行制品完成安装、启动、升级、回滚和卸载，运行时由同一份候选提供。

## Decision

macOS arm64 Native 保留 Electron Main 和独立 Service 进程。候选包含一份经固定摘要校验的 Node 26.13.1，供 Service、安装维护、校验和内含 Terminal 使用。配套启动使用私有 stdin、stdout 就绪回执和 EOF 收尾。2026-11-13，这一选择扩展到新 Terminal、完整 Native 和桌面专用候选。Service 用 Node HTTP、WebSocket 与 Undici，Agent 子进程与 Worker 使用同一个独立运行时。源码工具链见 [Bun 安装、打包与快速单测](2026-11-13-bun-build-node-runtime.md)。Native 与 Terminal 的清单绑定运行时、SQLite 引擎和可执行资产。安装 ZIP 保留相对链接和权限，安装入口调用同候选 Node。

## Alternatives considered

- Electron Utility Process 能复用 Electron 内置 Node。它仅能配置 stdout 和 stderr，采用它需要改配套 stdin 的退出机制，还需单独实现安装维护执行入口。
- 桌面 Node 与 Service Bun 能复用现有服务。安装、校验和运行仍会需要 Bun，无法达到这次发行目标。
- Node 内置 SQLite 可以少交付一个库，但它的 Database API 不提供 Store 的 NOFOLLOW 打开标志，也不能指定已审查的 SQLite 动态库。继续使用 Node-API 适配器，保留原文件身份、扩展错误码和 engine sourceId 核验。

## Consequences

- 新制品的运行时目录是 `terminal/runtime/node` 和 `LICENSE.node`。Node-API 绑定使用候选内原有 SQLite 3.51.3 动态库。Profile／制品锁仍绑定原文件描述符。
- 新维护入口能验证旧 Bun 清单，按整套候选升级和回滚。旧版本启动使用自己的运行时。独立 Terminal 登记需能读当前 Native 候选的清单。
- macOS 可继续用已审查动态库；Linux／Windows 从固定 SQLite 3.53.4 源码构建随包库。Windows 新完整候选的 C 前门校验 Node SEA verifier 和 Node-API 插件。旧 Bun managed prefix 的原前门无法切换到 Node，发布前明确拒绝并保留原选择。桌面专用 Setup 按原整树替换合同。Windows／Linux 的原生发行资格和 macOS Developer ID 签名公证未覆盖。

## Verification

2026-11-12 在 macOS arm64 使用实际 ZIP，Native 候选 `a4172696bdaf7335921406955046f55987881b211139eb2c793ec6d1f511d616`。隔离环境阻止调用宿主 Node/Bun 和读仓库，核对了 ZIP、首次安装、旧 Bun 版升级、回滚重启、Terminal 登记和保数据卸载。配套 Service 核对真实 Store、SSE 中断和 stdin EOF 后原进程退出。桌面实测使用独立 HOME、系统 PATH 和 Chromium 自身沙箱，观察首屏加载到可用及包内 Node Service 原进程退出。真实 TUI 在外层执行隔离下观察启动到工作区信任提示及 Ctrl+Q 收尾。

2026-11-13 本机 Node 26.13.1 的实际 Terminal 安装、模型、TUI、Worktree、daemon 和卸载，以及 Finder 旧 DMG 升级与回滚记录，见[终端发行](../../../../apps/cli/docs/terminal-release.md#构建与操作)与[桌面 DMG](../../../../apps/desktop/docs/native-release.md#macos-dmg)。Windows PE 和 SEA 的静态验证不替代原生启动。

相关决定见 [SQLite 引擎](2026-10-04-selected-sqlite-engine-and-worker-identity.md)、[Terminal 制品生命周期](2026-10-02-terminal-bundle-lifetime.md)和 [Windows 桌面安装器](../feature/2026-11-12-windows-desktop-only-installer.md)。

[桌面专用 DMG](2026-11-12-macos-desktop-dmg-node.md)复用 Node 归档和 Service 入口，保留独立的 Finder 生命周期及桌面专用制品清单。
