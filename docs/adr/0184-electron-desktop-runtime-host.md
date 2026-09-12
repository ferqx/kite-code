# ADR-0184：Electron 客户端与独立 Runtime Host

状态：accepted
日期：2026-09-12

## 背景

用户明确将桌面客户端从 Tauri 改为 Electron，并保留 React/shadcn UI 与独立 Kite Runtime Host。已有会话页面、Runtime Client 和配套 stdio Service 能承担这一分离，不需要改变执行协议或存储 authority。

## 决定

Electron 主进程接替 Rust 宿主的窗口、本机能力和配套服务生命周期。隔离且启用沙箱的 renderer 只使用具名 preload bridge，主进程核实 IPC 来源和参数；页面仍消费环境无关协议组合。

Runtime Host 继续作为经过制品与身份校验的 `kite-service` 独立子进程运行，负责业务执行、审批、存储及子进程清理。Electron 不嵌入 Runtime、发现 daemon 或添加新的数据库／身份体系。页面重接由主进程持有的服务 peer 维持，关闭窗口隐藏，明确退出走自有服务 EOF 清理。

共享 React/shadcn UI 继续服务桌面与只读 Web。宿主迁移不扩大 Web 权限，不改变会话和执行语义。开发版使用既有 source profile，打包版使用 canonical profile；应用 ID 和已打开项目文件沿用。

## 影响与证据

Tauri 与 Rust 不再是桌面开发依赖。Bun/Vite 构建和 Electron Packager 生成 macOS 应用。此前 Tauri 原生验收仅保留历史含义，Electron 的制品、窗口、生命周期和发布资格分别验证。当前实现与验证边界由[桌面 owner](../../apps/kite-desktop/README.md)维护。
