# Agent Note: 桌面客户端采用 Tauri 并复用现有 App Server

Status: implemented
Archived: 2026-09-27

## Problem
桌面端需要提供本地任务执行、交互和结果检查。现有 Web 明确只读；现有 Runtime Client 与载体解耦，而 Native composition 含 Node/Bun 依赖。用户认可首版产品与阶段方向，并明确选择先采用 Tauri 技术栈。

## Decision
采用 Tauri 2、Rust 宿主与 React/TypeScript 界面。Rust 拥有原生资源及配套 App Server 子进程，执行和持久状态沿用现有 Service、Host、Kernel 与 Store owner。桌面端复用同包服务配对与退出契约，不增加另一套 daemon 管理。

优先验证在桌面客户端适配层复用纯 TypeScript Runtime Client，经受限 Tauri IPC 和 Rust stdio 载体连接服务；具体组合与导出位置由真实接入验证收敛。Rust 不重写领域状态机，不为运行 typed client 额外加入中转进程。

这项 Tauri 方向随后曾在本机实现与验收，后来由 [Agent Note 0184](../../implemented/feature/2026-09-12-electron-desktop-runtime-host.md) 的 Electron 宿主决定替代；本记录仅保留当时的取舍。首版范围、生命周期、验收和待验证事项完整维护在[桌面端计划](../../../../docs/plans/desktop-client.md)；实施后的当前事实归回相应 owner。

## Alternatives considered
- Electron：可提供 Node 宿主，但用户选择 Tauri；不维护两套桌面框架。
- 将 Web 放入桌面窗口：可复用展示，但只读 REST 不能承担完整任务执行与审批。
- Rust 重写 Runtime 或 Client：会重复现有协议与状态语义，缺少当前需求依据。
- 新增 TypeScript 中转服务：增加进程与生命周期成本，先验证已有环境无关 client 与 Rust 载体的直接组合。

## Consequences
需要维护 Rust 宿主与 IPC 边界，并验证各平台 WebView、原生资源、sidecar 打包及退出行为。不能把纯客户端 browser 构建通过等同于 Native composition 可直接在 WebView 使用。Tauri 壳的体积不代表包含执行服务后的完整安装体积。

## Historical relationships

**Decision makers**: @chenchao
