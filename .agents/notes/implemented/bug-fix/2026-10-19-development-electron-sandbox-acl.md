# Agent Note: Windows 开发 Electron 的受限范围沙箱权限准备

Status: implemented

## Problem

本机 `npm run desktop:dev` 完成构建后，Electron 44.3.0 的 GPU／renderer 在页面加载前以 `0x80000003` 退出。官方压缩包与安装文件字节一致；独立空页面和新 Profile 也复现。只给实际 Electron 发行资源补齐受限应用包读取／执行权限后，同一沙箱窗口正常。依赖重装会生成新目录，单次手工修复无法保证后续开发启动。

用户明确要求启动前自动检查并修复，仅调整 Electron 运行目录权限，保留沙箱、项目及用户数据权限。[当前产品约定](../../../../docs/handbook/clients/desktop/README.md)和[开发 owner](../../../../apps/desktop/README.md)据此定义适用范围；与正式 Native 的[原对象保护决定](2026-10-17-windows-original-object-sharing.md)不冲突，不修改其安装或运行 ACL 策略。

## Decision

仅由显式 [desktop 开发宿主](../../../../scripts/development/unified-desktop.ts)调用 [Windows 权限准备](../../../../scripts/development/windows-electron-permissions.ts)。核已安装 electron 包、实际 EXE 及 `dist/version`，固定祖先和完整目录清单中的物理对象，在写入前拒绝 reparse entry、硬链接和适用的 `S-1-15-2-2` 拒绝 ACE。固定句柄不共享 DELETE，避免检查后目录或文件被替换再经路径写入 ACL。

只在权限不足的现有对象上追加 `S-1-15-2-2` 非继承 ReadAndExecute ACE。保留所有者、原规则、继承设置和文件字节；不向父目录授权、不递归传播新规则、不修改 Profile 或项目、不提权。每次启动重新定位并检查，已有权限不写入。失败以有限错误码停止启动，保留原拒绝规则。帮助、参数和缺 built Service 的原前置拒绝保持；非 Windows 不做 ACL I/O。

PowerShell 使用固定代码及 JSON stdin，通过绝对系统程序执行；路径不进入命令插值或执行策略设置。ACL 直接使用 .NET API，避免依赖调用者 PowerShell 模块加载状态。该准备没有增加普通客户端测试诊断入口。

## Alternatives considered

- 保持手工 `icacls` 修复：已验证能恢复，但每次重装需重复，且递归授权容易跟随链接、扩大范围。
- 关闭 Chromium 沙箱：隔离夹具已验证可绕过崩溃，但违背用户要求并降低运行隔离，未用于开发或正式入口。
- 禁用 GPU：独立夹具仍无法加载，不解决受限 renderer 读取问题。
- 修改整个 `node_modules`、项目或用户 Profile 权限：超出所需范围及授权，会破坏原私有资源契约。
- 在 dist 根添加可继承 RX：先前单次修复有效；自动准备采用逐项非继承增量，使授权严格限制在检查过的物理对象。

## Consequences

其他受限应用包也能读取这份公开 Electron 发行资源，没有新增写入权限。启动增加一次本地 Windows 权限扫描；链接安装、硬链接缓存或策略显式拒绝时需要先修复依赖安装布局／权限，入口不自行覆盖。不是自动重装依赖或系统工具的机制。

2026-10-19 Windows x64／Bun 1.4.3／Electron 44.3.0：从已校验官方 ZIP 全新解压，沙箱开启时复现 GPU 崩溃；自动补齐 76 项后 renderer 正常加载，实际 preload 报告 sandboxed／contextIsolated 均 true，重复检查零修复。[隔离测试](../../../../tests/isolated/unified-agent/development-electron-permissions.test.ts)核真实 ACL、原规则／继承／数据保全、重装与幂等、链接和拒绝规则；帮助与原开发入口测试保持。此结果不授予其他 Electron 版本、平台或正式 Native 发布资格。相关上游证据为 [Electron #51761](https://github.com/electron/electron/issues/51761) 和 [#52098](https://github.com/electron/electron/issues/52098)。
