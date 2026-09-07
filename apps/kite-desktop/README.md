# kite-desktop

Tauri 桌面 presentation 与本机宿主 owner。已完成[首版计划](../../docs/plans/desktop-client.md)中本机 macOS 的接入、日常开发闭环与稳定性验收；用户当前以本机开发和内部测试为主，正式签名、公证及分发资格延后。

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

配置读写、模型选择、信任、新建/历史会话、输入/流式结果、取消、单次工具审批/拒绝、问题回答与计划审核已接入。[变更阅读与外部编辑器](docs/results-and-editor.md)使用成功文件工具记录，本机 macOS 已通过 VS Code 实际文件打开验收。自动更新和非 macOS 发布未交付。扩展/验证交互明确提示限制并允许取消，不自动应答。目录使用现有 Runtime list_sessions（服务最多 1,000 条），按工作区摘要过滤；选择时再次核实归属。正文以纯文本渲染。

Provider 设置经现有 Native write_provider_api_key 接口写入用户配置文件，API key 不放入 DesktopView 或浏览器持久存储，提交时清空输入。结果未知时查询配置且不自动重放；模型选择使用 App Control revision CAS。macOS standalone 构建已嵌入现有 MCP 原生 keyring 模块，其源码与编译程序的隔离读写删除 smoke 通过，最终包内 Service 也完成本机模拟 OAuth、Keychain 保存与重启后认证恢复；Provider 配置写入仍遵循原配置 owner，不因此改为 keyring 存储。真实 DeepSeek 的服务协议闭环与使用本机模型 fixture 的新增面板原生验收均已完成。用户行为与验证限制见[桌面手册](../../docs/handbook/clients/desktop/README.md)。


## 本次验证与剩余项

[设置面板](src/Settings.tsx)和[问题/计划面板](src/Interaction.tsx)消费现有 connection。计划正文由 Service 投影，缺失或截断时只允许反馈/取消。项目切换确认后等待旧服务清理，再选择目录；取消选择后可重连原项目。当前保留保守的空闲切换确认。

[凭据结果测试](test/models.test.ts)覆盖拒绝、未知结果及不重放；Service 的[计划正文测试](../kite-service/test/runtime-plan-review.test.ts)覆盖正文、脱敏、限额与身份漂移。[导航集成测试](test/navigation.test.ts)通过实际 App Server 验证项目目录隔离、拒绝外项目会话、快速切换时忽略旧响应与断开清理。[开发闭环测试](test/development.test.ts)验证代码写入、测试输出、重启历史和继续会话。协议证据与原生窗口证据分别记录；阶段 1 已完成本机 macOS 日常开发闭环。

[原生验收](docs/native-validation.md)记录 2026-09-07 本机 macOS 的制品、隔离条件、真实窗口、流式、关窗、重连、确认退出和工具进程树崩溃清理证据。最终 `.app` 已在源码目录之外、仅系统 PATH 下启动并读取历史。同一记录另列阶段 1 的配置、问题/计划、草稿、实际修改与测试、VS Code 跳转和冷启动继续证据，以及独立的外部 Provider 服务验证；不扩大为正式发布或其他平台资格。

当前 [macOS 退出适配](src-tauri/src/macos.rs)将 Cocoa termination 路由到单一确认/清理流程，native 交互权限由用户在系统设置中授权。renderer 的断开确认使用显式异步 dialog API，只开放消息对话框权限。原生 delegate 与传输变化需重复对应场景，不用 Rust 单元测试或浏览器预览替代。

会话切换/重连保持订阅代次边界；跨项目清除旧选中状态，加载会话显示提示并在 20 秒后有界失败。`tool.cancelled`/`tool.rejected` 在历史与实时投影中均为终态，迟到进度不能覆盖。其余范围见首版计划。

阶段 2 的[大历史回归](test/history.test.ts)通过真实 App Server 写入 20 轮、每轮约 32 KiB 回答，重启后完整分页恢复且每帧不超过 1 MiB；[丢失回执回归](test/resilience.test.ts)在文件已写入后丢弃 start_turn 回执，确认连接 ready 失效、结果未知提示和重连无重放。实际原生窗口已验证大会话渲染、与安装版 TUI 的同会话竞争、损坏制品拒绝及未签名应用手动替换的数据保留，详见原生验收；正式签名分发升级另行验收。
