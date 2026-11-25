# Windows 桌面发行制品与 VS Code 对齐

2026-11-25 确认按全新 Windows 安装包设计。首轮覆盖当前用户 Windows x64 安装器、ZIP、首装和新格式版本之间的更新与回退。旧安装程序及其目录布局不属于迁移范围。

## 对照制品

通过微软更新服务定位 VS Code 1.148.0、提交 `661626d0e72f97806550790a98fb87116c9db825`。实查官方 Windows x64 ZIP 的中央目录，共 3970 项，根层直接包含 `Code.exe`、`bin/`、`tools/`、`appx/`、`policies/` 与 `661626d0e7/`。该版本目录包含 Electron 运行库、`locales/` 和 `resources/app/product.json`。中央目录记录 3193 项为 Deflate，777 项为存储。此检查只读取目录，正文文件摘要由实际制品验证负责。对应源码用 Inno Setup 构建 User Setup，配置 LZMA 固实压缩，并以长提交标识前 10 位命名版本化资源目录。 [微软发行 ZIP](https://vscode.download.prss.microsoft.com/dbazure/download/stable/661626d0e72f97806550790a98fb87116c9db825/VSCode-win32-x64-1.148.0.zip) · [同版本安装脚本](https://github.com/microsoft/vscode/blob/661626d0e72f97806550790a98fb87116c9db825/build/win32/code.iss) · [Windows 构建脚本](https://github.com/microsoft/vscode/blob/661626d0e72f97806550790a98fb87116c9db825/build/gulpfile.vscode.win32.ts)

## Kite 制品约定

| 发布面 | 验收约定 |
| --- | --- |
| User Setup | `KiteUserSetup-x64-<版本>.exe` 由 Inno Setup 编译，使用 `Compression=lzma` 与 `SolidCompression=yes`。应用名为 Kite，默认安装到用户程序目录 `%LOCALAPPDATA%\Programs\Kite`。 |
| ZIP | `Kite-win32-x64-<版本>.zip` 使用 Deflate，根目录直接展开产品文件。解压后从稳定入口启动，ZIP 用户手动更新。下载 ZIP 与安装器均离线运行，运行所需的 Bun 和 Electron 随制品提供。 |
| 目录骨架 | 产品根放 `Kite.exe`、命令入口 `bin/` 与随包维护工具 `tools/`。10 位版本目录内放 Electron 运行库、`locales/` 和 `resources/app/`。编译后的桌面应用位于该版本的应用资源目录，Kite 专有的运行时文件随版本封装。产品没有相应能力时不制造 `appx/`、`policies/` 等空目录。 |
| 构建与校验 | 同一次 Windows 桌面构建产生一份候选树，ZIP 和 Inno Setup 从同一份树打包。短目录名用于定位，可信加载继续核对完整制品身份和字节。预检拒绝同一安装位置的短标识歧义。对外入口是 ZIP 和 Setup EXE，构建中间件按原 owner 管理。 |

VS Code 构建同时配置了版本化 Electron 资源和可执行文件产品版本字符串，不能只将现有 Kite 目录改名。Windows 构建需先确定根启动器与版本目录之间的装配关系，然后更新 Native 清单、入口和路径校验。若实现需要改变受管制品协议版本，按仓库规则明确该项升级。 [VS Code Electron 构建](https://github.com/microsoft/vscode/blob/661626d0e72f97806550790a98fb87116c9db825/build/lib/electron.ts) · [当前 Kite 发行实现](../../apps/desktop/docs/native-release.md#构建与安装)

## 实施顺序

1. 对齐当前用户新装的默认根。使用 Windows 的用户程序目录 Known Folder，验证目录尚未创建的用户能完成首装和卸载。
2. 实现 Windows 版本化候选树和根入口。以真实启动验证资源加载、Service 启动、完整性校验和候选使用锁。普通 ZIP 解压目录的权限必须独立验证。
3. 从同一候选构建 Inno User Setup 和 ZIP。分别验证 EXE 直接安装、ZIP 解压后直接启动、归档文件名、根层级和版本目录，与对照制品的角色逐项比对。使用 Kite 自有的界面、图标和安装登记。
4. 使用两个新格式制品验证升级和回退。准备新版时保持原入口可用，验证新版后切换，再清理旧候选。验证登记前中断、登记后清理中断、占用、失败诊断和卸载。旧安装程序无需迁移。 [安装流程与恢复细节](../../.agents/notes/proposed/architecture/2026-11-25-windows-desktop-setup-flow.md)

验证事实同步至 [Windows 桌面手册](../handbook/clients/desktop/README.md)、[Native 发行 owner](../../apps/desktop/docs/native-release.md)和 [发布约束](../active/release-control.md)。目录对照与静态清单检查只证明制品形状。ZIP 可启动、EXE 首装、更新与回退分别以 Windows 实机行为确认。
