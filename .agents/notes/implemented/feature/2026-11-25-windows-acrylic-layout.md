# Agent Note: Windows 版本共用外框与原生玻璃适配

Status: implemented

## Problem

既有桌面布局把外框、留白与 Mica 一同启用。Windows 10 和较早的 Windows 11 无法使用 Electron 的 Mica，因而同时缺少玻璃和会话工作区的 6px 外沿。用户要求 Windows 10 与 Windows 11 的布局一致，并在支持的系统上保留玻璃透明效果。

## Decision

Windows 的 6px 外沿、32px 独立顶栏和三栏共用外框由平台样式决定。Windows 11 22H2 起沿用 Electron Mica。build 17763 至 22620 由已验证的 Windows 原生模块为同进程的主窗口应用 DWM Acrylic。普通窗口保留现有系统边框和调宽能力。系统配置禁止透明、不可开材质或调用失败时，原生背景和 Root 回退到实色。Main 保有窗口句柄和系统材质决策。[原共同外框记录](../bug-fix/2026-10-20-session-content-frame.md)继续定义三栏边界及内部分隔线取舍。

## Alternatives considered

- 全部使用 Electron 的 Mica 或 Acrylic 选项。两项都依赖 Windows 11 22H2 起支持的背景接口。
- 引入 Windows App SDK `DesktopAcrylicController`。需要新的本机部署依赖和合成目标整合，超出既有 Electron 窗口的兼容适配。
- 使用 Electron 的 `transparent: true`。它会关闭 Windows 厚窗口框，Windows 11 隔离窗口对照中出现最大化还原后宽度偏移。维持普通窗口并通过系统扩大玻璃客户区，保留原生缩放路径。

## Consequences

通过运行时动态查找旧版本 DWM 的 accent policy 接口获得 Acrylic，效果依赖系统对该兼容路径的实现。接口不可用时沿用实色窗口和相同工作区几何。本轮的 Windows 11 原生窗口对照与渲染几何验证见 [Desktop owner](../../../../apps/desktop/README.md#windows-原生-mica)，Windows 10 原生合成与安装制品的实机资格待验证。

2026-11-28 的 [Windows 工作区布局](./2026-11-28-windows-flush-workspace.md)替代共同圆角外框和顶栏材质的展示规则。三个分支共用几何、左栏继续按系统选择材质，原系统能力检查和回退路径保持有效。
