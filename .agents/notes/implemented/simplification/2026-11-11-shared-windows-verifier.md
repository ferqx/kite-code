# Agent Note: Windows Terminal 与 Native 共享校验器

Status: implemented

## Problem

Windows x64 的 Native 已包含完整 Terminal 候选。两个校验入口过去分别编译为 Bun standalone，制品同时存放普通 `bun.exe`、Terminal 校验器和 Native 校验器。三份可执行文件的 Bun 代码段字节一致，两个校验器需要的区别是受各自安装入口约束的校验流程。

## Decision

[Terminal 构建](../../../../scripts/release/terminal-bundle.ts)编译一次，产出 `windows-frontdoor/terminal-verifier.exe` 和绑定其 SHA-256 的 `windows-frontdoor/native-verifier.sha256`。这两项与普通 Bun 一起进入原 Terminal 清单。共享程序根据固定的实际映像名进入相应校验流程，各流程继续独立核对 prefix、已安装前门、候选全量文件、环境和使用权。Native 流程继续核 C 的实际创建证书，并为 Electron 提供原第二跳证书。

[Native 构建](../../../../scripts/release/windows-native-build.ts)从已核 Terminal 取同一校验器的长度和摘要来绑定 C 前门。[首次安装](../../../../scripts/release/windows-native-install.ts)从对应候选复制完整字节到 `bin/native-verifier.exe`，先验证稳定前门再发布 active。旧候选的 `app/native-verifier.exe` 仍是有效来源，旧 Terminal 作为 Native 构建输入时使用独立编译。安装后切换版本继续复用首次候选的 bootstrap 文件和 version 2 marker。

## Alternatives considered

- 分别编译两个校验器会把相同 Bun 运行时封进两份文件。共享编译后仍可用固定安装映像名保留原两条校验路径。
- 让普通 `bun.exe` 同时承担校验入口需要更改当前固定启动参数或引入预加载前的模式切换，并影响旧稳定前门调用新候选的路径。保留候选业务 Bun 与启动前校验器的现有职责。
- 用文件链接合并已安装路径与候选路径会破坏 Windows 原对象的单链接和独立所有权合同。每个安装 prefix 复制自己的稳定前门，归档保留一份共享校验器。

- 发行归档使用 [Zstandard 长距离匹配](../../../../scripts/release/archive-compression.ts)压缩两类 Bun 可执行文件中的共同字节。选择标准的 `.tar.zst`，以便解包仍能按原 tar 路径、SHA、完整库存及解压上限校验。标准归档格式也能压缩许可证、ICU 数据等重复字节，安装继续得到每个原路径上的独立普通文件。
## Consequences

新版 Native 归档中的 Bun 可执行文件有两份，分别用于业务运行和两种安装前门共用的校验。新布局的首次安装由当前发布工具物化。运行中的旧安装和新版安装继续通过固定的候选选择、升级和回退机制。实际验证及平台范围归 [Terminal owner](../../../../apps/cli/docs/terminal-release.md#windows-managed-terminal-当前实现) 和 [Native owner](../../../../apps/desktop/docs/native-release.md#windows-managed-native-当前实现)。[原对象保护决定](../bug-fix/2026-10-17-windows-original-object-sharing.md)约束校验器和候选的文件身份与生命周期。
