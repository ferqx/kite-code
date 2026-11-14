# Agent Note: Bun 安装、打包与快速单测，Node 运行与验收

Status: implemented

## Problem

开发需要缩短单测反馈时间，同时要识别测试执行器和打包器对生产行为的影响。发行制品须由包内运行时启动，用户可在只有系统工具的环境使用。

## Decision

本机 `bun run build` 和 `bun run test:fast` 直接从 Bun 启动。构建脚本在自身进程里调用 `Bun.build()`，`test:fast --node` 复跑同一组单测。默认测试、运行时回归和正式制品测试在 Node 下执行。本机和 CI 用固定的 Bun 1.4.4 按同一份 `bun.lock` 隔离安装依赖。开发构建、Desktop 的 Service 重载与发行候选共用打包配置，服务端输出选 Node 目标。Node 启动的构建和校验脚本通过子进程调用同版 Bun 编译器，保留发行的导入转换和产物检查。桌面 renderer 使用 Vite／Tailwind，原生组件沿用各平台工具链。发行运行时遵循[随包 Node 决定](2026-11-12-bundled-node-native-runtime.md)。

## Alternatives considered

- 正式测试也用 Bun。反馈更快，但运行时、模块加载和进程语义的差异会漏过 Node 专属问题。
- 按[统一 Node 工具链的原提案](../../proposed/architecture/2026-11-13-node-toolchain.md)继续用 esbuild 构建产品。构建端依赖更少，但无法采用这次选择的 Bun 打包；仅开发采用 Bun 又会在同一源码上引入另一套产物。
- 保留 pnpm 安装及其已核对的依赖图。Bun 已是构建输入，继续保留 pnpm 会让开发机和 CI 多维护一个包管理器。迁回 Bun 时校验锁定版本、摘要、补丁和物理依赖边。

## Consequences

仓库只有一份当前安装锁，发行构建核对 Bun 在仓库内隔离安装的实际依赖和补丁。旧版制品回滚使用旧版自带的运行时。开发命令、同机快测对照和当前平台证据分别归[本地开发](../../../../docs/development/local-development.md)、[测试体系](../../../../tests/README.md#本机快速单测)和[发行约束](../../../../docs/active/release-control.md#当前发行与源身份)。
