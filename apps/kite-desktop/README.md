# kite-desktop

Tauri 桌面 presentation 与本机宿主 owner。已完成[阶段 0](../../docs/plans/desktop-client.md)的本机接入与原生验收，后续日常开发功能及正式发布资格仍在实施。

## 边界

- [React 入口](src/main.tsx)和[客户端适配](src/client.ts)消费 Runtime Client、App Control 与 History；[投影](src/presentation.ts)按请求身份保留累计正文与持久终态。
- [桌面 transport](src/transport.ts)经受限 IPC 接入 [Rust 宿主](src-tauri/src/main.rs)，宿主仅启动同包校验过的服务；[stdio 进程](src-tauri/src/process.rs)使用单消费者和有界输出队列。
- renderer 只导入 `kite-local-runtime/client/protocol` 的环境无关组合，不使用 Node/Bun、Host、Store 或 Web REST。
- 关闭窗口隐藏主窗口；明确退出要求确认并先关闭自有服务 stdin，等待 Service 清理。失败与副作用未知保持可见，不影响其他客户端。

## 开发与验证

环境需要 Bun、Rust 与对应系统 Tauri 开发依赖，macOS 需要 Xcode。开发用编译服务也不从 PATH 寻找服务或连接 daemon。

1. 仓库根执行 `bun install`。
2. 执行 `bun run --cwd apps/kite-desktop prepare:service`；可在脚本后提供已验证 candidate archive，复用 release owner 的构建/校验和服务 identity。
3. `bun run --cwd apps/kite-desktop dev` 启动开发窗口；`build:desktop` 构建 macOS `.app`。

`build` 只构建前端，用于 workspace 默认构建；原生构建与签名资格独立核实。服务使用当前 OS 用户的 `.kite-code` 配置；debug 采用现有 checkout digest 的 source profile，打包版使用用户 canonical profile 保存持久数据；自动验证必须传入隔离 home/workspace，不能改动开发者已有信任与凭据。

检查：`bun run --cwd apps/kite-desktop typecheck`、`test`、`build`，以及 `cargo test --manifest-path apps/kite-desktop/src-tauri/Cargo.toml`。全局类型与边界检查包含此 workspace。原生窗口、安装、隐藏输出和崩溃清理需要独立真实场景，前端测试不替代它们。

## 当前限制

配置读取、信任、新建/历史会话、输入/流式结果、取消及精确单次工具审批/拒绝已接入。问题/计划等其余交互、设置写入、变更查看、自动更新和非 macOS 发布仍未交付。未支持的交互明确提示限制并允许取消，不自动应答。阶段 0 按当前 profile 显示最近 100 个会话，跨项目目录归属体验由阶段 1 完善；正文以纯文本渲染。

服务来自现有 standalone candidate，其原生凭据库不可用限制仍然存在；不以桌面壳构建成功宣称模型配置或凭据 onboarding 已完成。用户行为与验证限制同步[桌面手册](../../docs/handbook/clients/desktop/README.md)；后续剩余设计继续由计划维护。


## 本次验证与剩余项

[原生验收](docs/native-validation.md)记录 2026-09-07 本机 macOS 的制品、隔离条件、真实窗口、流式、关窗、重连、确认退出和工具进程树崩溃清理证据。最终 `.app` 已在源码目录之外、仅系统 PATH 下启动并读取历史。该证据不覆盖正式发布、其他平台或外部 Provider。

当前 [macOS 退出适配](src-tauri/src/macos.rs)将 Cocoa termination 路由到单一确认/清理流程，native 交互权限由用户在系统设置中授权。renderer 的断开确认使用显式异步 dialog API，只开放消息对话框权限。原生 delegate 与传输变化需重复对应场景，不用 Rust 单元测试或浏览器预览替代。

会话切换/重连保持订阅代次边界；跨项目清除旧选中状态，加载会话显示提示并在 20 秒后有界失败。`tool.cancelled`/`tool.rejected` 在历史与实时投影中均为终态，迟到进度不能覆盖。其余范围见首版计划。
