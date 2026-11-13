# Agent Note: 统一仓库的 Node 工具链

Status: proposed

## Problem

Terminal 和桌面发行包已经自带 Node，源码启动、工作区构建、依赖安装和 CI 仍依赖 Bun。两套工具分别解析同一源码、安装图和测试，测试与用户实际运行环境不同。

## Proposal

当前十个工作区和正式工具统一使用固定 Node 26.13.1。pnpm 10.28.2 冻结安装并核对锁定的版本、peer 和补丁；esbuild 构建，TypeScript 检查，Node 的测试运行器按原所有权、隔离与清理约束执行。已发布的旧制品使用自己的运行时，保留升级、回滚、读旧 manifest 和原始证据的合同。相关决定见[随包 Node](../../implemented/architecture/2026-11-12-bundled-node-native-runtime.md)。

## Alternatives considered

- 发行版继续用 Node、开发和测试继续用 Bun：改动较小，但实际执行路径仍不一致，仓库仍需要安装第二种运行时。
- 同时删除旧格式与候选入口：会破坏已交付制品的读取与回滚，也失去复核旧证据所需的原始数据。

## Acceptance criteria

当前开发、构建、默认测试和 CI 不依赖系统 Bun。冻结安装保持已锁定的生产依赖和补丁。用 macOS 隔离目录核对新 Terminal 的启动、停止和实际 TUI；新版 DMG 复验旧版升级、启动、回滚、卸载和会话保全。普通测试与三平台正式资格各自保留准确结果。

## Risks

进程、文件句柄、测试 mock 和模块导入在两个运行时中的语义不同。核对真实 HTTP、PTY 和包外运行，保留失败及清理未知，不把 macOS 本机结果当作 Windows 或 Linux 资格。

2026-11-13，已实施的[Bun 工具链决定](../../implemented/architecture/2026-11-13-bun-build-node-runtime.md)取代本提案的 pnpm 安装、esbuild 产品构建与构建 CI 无 Bun 部分。固定 Node、冻结依赖、Node 默认测试及旧制品回滚的理由继续适用。快速单测用法和同机对照归[测试体系](../../../../tests/README.md#本机快速单测)。
