# Agent Note: Windows 桌面专用安装包

Status: implemented

## Problem

旧离线安装器随桌面嵌入了完整终端制品。已安装树同时包含原始 Bun 和两份带 Bun 的校验器，还暴露了带 GUID 的卸载辅助目录。卸载在同一批原文件上重复遍历。实际 Windows 启动遇到过 Crashpad 注册错误写入程序目录的情况，导致完整库存拒绝。

## Decision

[运行时构建](../../../../scripts/release/terminal-bundle.ts)从锁定的生产依赖构建桌面配套服务。[Windows 桌面链接器](../../../../scripts/release/windows-desktop-runtime.ts)保留工作区共享 chunk 和原资源相对位置，链接工作区产物并打包剩余 JS 依赖。原生绑定按 Windows x64 明确选取，字体、CMap 和 WASM 随消费它们的能力交付。新候选的清单禁止 `node_modules`，旧候选沿原布局核验以支持替换。C 前门通过内置摘要核对固定 JS 校验器和唯一的 Bun，并保留原两跳创建证书。

Bun 的拆分文件可使用从共享文件导入的 `__require`，静态导入扫描无法找到这类调用。桌面构建在编译器解析依赖时将外部模块名指向制品内的私有映射，映射表随同代码封存，构建后只验证引用。这样共享文件和调用者能解析到同一模块。仓库父目录上的开发依赖曾掩盖未解析的调用。正式安装验证使用仓库外、没有祖先 `node_modules` 的目录，观察实际桌面与配套 Service 的启动和退出。

[安装入口](../../../../scripts/release/windows-setup/install.ts)让所选目录提供固定的 GUI 程序和 `resources`。替换时在独立程序槽验证新版，并用原卸载所有者移除经核旧树。重复安装同一候选只复核现有树。协调目录保留并使用 Windows 的隐藏属性。旧 Windows 登记和快捷方式的发现依据见[原安装集成](2026-11-11-windows-setup-integration.md)。

[卸载端口](../../../../packages/agent/src/platform/windows-installation-removal.ts)从原 DELETE 句柄读取摘要，移除前复核闭合库存和路径身份。完整性验证允许原卸载所有者移除已识别的 Crashpad 注册错误日志。桌面校验器启动 Electron 前清理继承的 Crashpad 环境。

占用交互沿用 Windows 安装器常见的检测、退出提示及重试／取消。VS Code 的安装脚本使用应用运行检测，Inno Setup 定义了安装和卸载遇到运行实例的退出提示。Kite 用已有的候选使用锁识别运行或退出中的应用，用 Windows 共享错误识别其他文件占用。卸载只重试移除前的占用失败，其他错误传递有长度和字符限制的代码。 [VS Code 安装脚本](https://github.com/microsoft/vscode/blob/main/build/win32/code.iss) [Inno Setup AppMutex](https://jrsoftware.org/ishelp/topic_setup_appmutex.htm)

卸载完成窗口关闭后才发起启动器清理。原启动器移入同卷私有目录，清理进程用 PID 和创建时间等待原进程退出，再删除移走的启动器。安装位置可供下一次安装直接使用。

## Alternatives considered

- 将完整终端制品改名会继续交付额外入口和重复的运行时。
- 在桌面上继续使用独立编译校验器需要另一份 Bun。让 C 前门固定并核验 JS 脚本可延续原进程证书。
- 递归按路径删除更简单，但无法沿同一已校验对象确认卸载，也会降低链接和目录替换的保护。

## Consequences

本地服务的 JS 由同一套 Bun 运行，原生文件和二进制资源由清单独立核验。已安装版本只保留当前桌面候选，升级期间使用独立暂存空间。用户资料仍由安装树外的 Profile 管理。构建入口与验证范围见 [Native owner](../../../../apps/desktop/docs/native-release.md#构建与安装)。
