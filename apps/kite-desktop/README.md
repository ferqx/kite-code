# kite-desktop

> 实施中：[会话存储兼容性与连续性 V1](../../docs/plans/session-store-compatibility-and-continuity.md)已统一正式数据入口，并验证 macOS 已知格式的自动整理、历史来源归并和原会话保留。未知格式保留原数据，不切换空库；完整方案与未验证平台的边界以计划中的最新验收记录为准。


本 workspace 是 Electron 桌面 presentation 与本机宿主 owner：React/shadcn UI 在沙箱 renderer 中运行，Electron 主进程提供受限本机能力，业务执行继续由独立 Kite Runtime Host 承担。迁移实现与本机自动原生验收已完成，制品身份和验证边界见[原生验收](docs/native-validation.md#electron-本机迁移验收)。

迁移前的 Tauri 版本曾完成[首版计划](../../docs/plans/desktop-client.md)中的本机 macOS 接入、日常开发闭环与稳定性验收；这些结果只保留为当时版本的历史证据，不能作为 Electron 制品、窗口或生命周期资格。当前仍以本机开发和内部测试为主，正式签名、公证及分发资格延后。

后续研发以 Codex 功能和日常交互体验为对标目标，需求基线与逐项核对入口见[日常体验方向](../../docs/plans/desktop-client.md#首轮验证后的日常体验方向)；当前实现职责与限制仍以下文为准。

本 workspace 对应产品名 **kite**。通用工作、shadcn/ui 及覆盖空间、会话、交互、结果、子代理、设置和恢复的整体 Figma 目标稿见[界面与协作体验](../../docs/plans/kite-client-experience.md)。renderer、Electron 窗口和当前开发包均使用 kite 展示名；包名与执行边界不因设计命名自动变化。

## 边界

主页面与 Web 共用[共享 React 页面](../../packages/kite-client-ui/README.md)，桌面入口提供已授权操作及原生宿主适配。[Vite](vite.config.ts)与[样式入口](src/tailwind.css)编译共享 shadcn/ui 控件使用的 Tailwind utilities，主题沿用共享变量。

[左侧列表与右侧会话首阶段](../../docs/plans/kite-client-experience.md#第一阶段左侧列表与右侧会话)已交付 React 展示与交互；组成、UI 状态、导航和验证边界见[两栏会话界面](docs/conversation-ui.md)。

[新对话、项目与分支](docs/new-conversation.md)说明全局准备页、首次发送创建会话、已打开项目列表和立即生效的本地分支选择；共享 UI 只呈现选择数据，原生宿主负责目录与 Git。

- [React 入口](src/main.tsx)装配[App](src/App.tsx)，[客户端适配](src/client.ts)消费 Runtime Client、App Control 与 History；[投影](src/presentation.ts)按请求身份保留累计正文与持久终态。
- [具名 bridge](src/bridge.ts)定义 renderer 可见的完整 API；[preload](electron/preload.ts)只通过 `contextBridge` 暴露冻结的 `window.kiteDesktop`，[IPC owner](electron/ipc.ts)逐通道核实主窗口 frame 与封闭参数。复制消息通过最大 1 MiB 的纯文本通道交给 Electron 主进程写入系统剪贴板，不依赖打包页的 Web Clipboard API。renderer 不取得 `ipcRenderer`、任意 channel、Node 或 Electron 对象。
- [桌面 transport](src/transport.ts)每次 IPC 只拉取一个有界 Runtime frame；[Electron 宿主](electron/host.ts)只启动构建时固定、运行时校验过的配套服务，[stdio 进程](electron/runtime/service-process.ts)使用单消费者和 16 帧有界输出队列。
- [页面重接](electron/runtime/renderer-connection.ts)保留同一 Service protocol peer，页面刷新或 renderer 进程退出只 detach 旧代次；新页面恢复订阅和历史，不清理运行中的任务。传输代次与 UI 导航恢复见[新对话 owner](docs/new-conversation.md#页面刷新与连接恢复)。
- renderer 只导入 `kite-local-runtime/client/protocol` 的环境无关组合，不使用 Node/Bun、Host、Store 或 Web REST。
- 关闭窗口隐藏主窗口；明确退出由 [Electron lifecycle](electron/main.ts)要求确认并关闭自有服务 stdin，等待 Service 清理。失败与副作用未知保持可见，不影响其他客户端。

## 开发与验证

界面开发采用 [HTML 预览优先的迭代流程](docs/conversation-ui.md#html-预览优先的界面迭代)，先在浏览器中调整实际组件，再按变更范围验证原生能力。

环境需要 Bun 和 macOS；Electron 与官方 `@electron/packager` 已由 workspace 依赖锁定，不需要 Rust、Cargo 或 Tauri 开发依赖。开发用配套服务也不从 PATH 寻找服务或连接 daemon。

1. 仓库根执行 `bun install`。
2. `bun run --cwd apps/kite-desktop dev` 先绑定 Vite 开发端口 1420，再从当前工作树自动构建并校验配套 Runtime Host，把该 Host 的精确 identity 编译进 Electron main/preload，最后启动 Electron 开发窗口。端口占用时立即给出中文排查提示，不执行构建、不启动新窗口；可用 `lsof -nP -iTCP:1420 -sTCP:LISTEN` 查看占用者，在原开发终端按 Ctrl+C 退出后重试。构建失败或窗口退出时关闭本次 Vite 服务。
3. 只需单独刷新配套服务时可执行 `bun run --cwd apps/kite-desktop prepare:service`；可在脚本后提供已验证 candidate archive，复用 release owner 的构建/校验和服务 identity。
4. `bun run --cwd apps/kite-desktop build:desktop` 依次构建 renderer、Electron host，并用官方 Electron Packager 生成当前 macOS arm64 制品 `apps/kite-desktop/out/kite-darwin-arm64/kite.app`。

开发窗口的 CSP 允许 Vite 注入的 React Refresh 内联初始化脚本；打包窗口的 `script-src` 只允许自身资源。修改开发加载方式后须验证真实 Electron 开发窗口的首次渲染和刷新，打包窗口 smoke 不覆盖 Vite 注入路径。

`build` 只执行 Vite renderer 构建，用于 workspace 默认构建。`build:electron` 要求已有 `service/desktop.json`，将其中经过验证的 candidate ID、服务摘要、expected server version 与环境白名单编入 `dist-electron/main.cjs`；运行时不会信任被替换的资源清单。`dev` 绑定开发端口后调用 `prepare:service`，避免 renderer 热更新与旧 Host 协议混用；`prepare:service` 复用 release owner 构建或验证 candidate，只把配套 `kite-service` 与 `desktop.json` 提取到 `apps/kite-desktop/service`。服务使用当前 OS 用户的 `.kite-code` 配置；开发包与打包版均由 [Electron host](electron/host.ts) 将 canonical config root 作为 runtimeRoot，不再按 checkout 或 Store epoch 自动分库；自动验证必须传入隔离 home/workspace，不能改动开发者已有信任与凭据。

检查：`bun run --cwd apps/kite-desktop typecheck`、`test`、`build` 和 `build:electron`。准备服务后运行 `bun run test:desktop:native`；构建应用后运行 `bun run test:desktop:window`，后者需要本机图形会话，使用源码外隔离应用和本机模型 fixture。全局类型与边界检查包含 renderer 与 Electron owner。原生窗口、preload、安装、隐藏、重接、退出和崩溃清理需要独立真实 Electron 场景，单元测试、DOM 预览与构建通过不替代它们。

## 当前限制

配置读写、模型选择、信任、新建/历史会话、输入/流式结果、取消、单次工具审批/拒绝、问题回答与计划审核已接入。[变更阅读与外部编辑器](docs/results-and-editor.md)使用成功文件工具记录；迁移前的 Tauri 版本曾在本机 macOS 确认 VS Code 实际打开，Electron 版本仍需重做该原生验收。自动更新和非 macOS 发布未交付。扩展/验证交互明确提示限制并允许取消，不自动应答。目录使用现有 Runtime list_sessions（服务最多 1,000 条），按工作区摘要过滤；选择时再次核实归属。助手正文支持 Markdown，工具过程按需展开；点击会话直接加载消息，无标题搜索或二次确认；独立子代理详情和运行中输入队列尚未接入。

最新[项目进入与资料副层设计](../../docs/plans/kite-client-experience.md#workspace设置与恢复)已接入用户主动添加／选择项目即授权，由现有 Service 信任接口记录；普通重连不自动授权，关联外部目录仍单独确认。子代理已沿用正文样式；独立详情与交接回执仍待真实数据支持。文件工具记录已通过右侧副层呈现，不扩展为完整资料工作区。

Provider 设置经现有 Native `write_provider_api_key` 接口写入用户配置文件，API key 不放入 DesktopView 或浏览器持久存储，提交时清空输入。结果未知时查询配置且不自动重放；模型选择使用 App Control revision CAS。macOS standalone Service 已嵌入现有 MCP 原生 keyring 模块，其源码与编译程序的隔离读写删除 smoke 通过；迁移前的 Tauri 包内 Service 还完成了本机模拟 OAuth、Keychain 保存与重启后认证恢复。Provider 配置写入仍遵循原配置 owner，不因此改为 keyring 存储。真实 DeepSeek 的服务协议闭环属于宿主无关 Service 证据；Electron 窗口中的模型与扩展流程仍按原生验收记录中的剩余范围验证。用户行为与验证限制见[桌面手册](../../docs/handbook/clients/desktop/README.md)。


## 本次验证与剩余项

[设置面板](src/Settings.tsx)包含模型、默认编辑器及 [MCP／Skills](docs/extensions.md)分类，扩展调用沿已有 App Control；新入口的外部认证与原生资格需按该专题单独核对。[设置面板](src/Settings.tsx)和[问题/计划面板](src/Interaction.tsx)消费现有 connection。计划正文由 Service 投影，缺失或截断时只允许反馈/取消。选择并验证目标目录后，仅替换逻辑连接、授权上下文和订阅；同一配套 Service 继续管理其他空间任务，切换空间不再确认停止全服务。取消选择时保留原连接。

[凭据结果测试](test/models.test.ts)覆盖拒绝、未知结果及不重放；Service 的[计划正文测试](../kite-service/test/runtime-plan-review.test.ts)覆盖正文、脱敏、限额与身份漂移。[导航集成测试](test/navigation.test.ts)通过实际 App Server 验证项目目录隔离、允许外项目历史读取，按持久 workspace identity 与授权路由执行、快速切换时忽略旧响应与断开清理。[开发闭环测试](test/development.test.ts)验证代码写入、测试输出、重启历史和继续会话。协议证据与原生窗口证据分别记录；迁移前阶段 1 的本机 macOS 日常开发闭环仍是 Tauri 历史证据，Electron 当前的独立服务与原生窗口自动验收见下文。

[原生验收](docs/native-validation.md)保留 2026-09-07 Tauri 版本在本机 macOS 的制品、隔离条件、真实窗口与生命周期证据，并另列宿主无关的 Service 证据。这些历史结果不作为 Electron 资格；同一记录现已登记 Electron 44.3.0 独立包的准确身份、隔离原生验收与剩余人工验证。

当前 [Electron lifecycle](electron/main.ts)在关窗时隐藏主窗口；明确退出使用主进程 `before-quit` 确认，并在 Service 清理完成后再次退出。空间切换不关闭 Service；明确退出仍由原生异步消息框确认。标题栏非交互区由 CSS drag region 交给 Electron，双击才调用封闭的最大化切换。窗口、preload、重接、退出和崩溃清理需重复真实 Electron 场景，不能用单元测试或浏览器预览替代。

会话切换/重连保持订阅代次边界；跨项目清除旧选中状态，加载会话显示提示并在 20 秒后有界失败。`tool.cancelled`/`tool.rejected` 在历史与实时投影中均为终态，迟到进度不能覆盖。其余范围见首版计划。

阶段 2 的[大历史回归](test/history.test.ts)通过真实 App Server 写入 20 轮、每轮约 32 KiB 回答，重启后完整分页恢复且每帧不超过 1 MiB；[丢失回执回归](test/resilience.test.ts)在文件已写入后丢弃 start_turn 回执，确认连接 ready 失效、结果未知提示和重连无重放。大会话渲染、与安装版 TUI 的同会话竞争、损坏制品拒绝及手动替换应用后的数据保留目前只有 Tauri 版本的历史原生证据；Electron 与 host 无关的 Service 回归分别记录，正式签名分发升级另行验收。

历史目录、无项目启动、跨空间阅读与有界自动重接见[历史与恢复](docs/history-and-recovery.md)。

恢复错误通过共享 Runtime 契约传递；现有错误弹窗的“检查恢复”调用只读摘要及 CAS 恢复命令，成功后清除旧准入缓存并重新校准，保留草稿且不发送。丢回执查询原命令的持久结果，查询失败仍显示未知。相关验证见[UI 测试](test/isolated/ui.test.tsx)、[Service 跨空间回归](../kite-service/test/isolated/app-server-process.test.ts)。

Git 分支切换保留关闭与重连以重新构建配置、MCP 与 sandbox owner；在执行前确认整个配套 Service 没有活动任务，防止重载取消其他空间任务。按空间重建依赖尚未实现，不能把保留 Service 的普通空间切换逻辑直接用于 Git 环境变更。

Store 启动失败通过 Service stderr 的有限结构化诊断传到初始化错误：仅接收错误码和 schema 数字，原始 stderr 不进入界面。握手前退出显示具体 Store 错误或退出码；握手成功后仍采用正常断连处理。原生三场景验收运行 `bun run scripts/startup-store-smoke.ts`，覆盖新目录、已有历史重启、拒绝不兼容数据库且字节不变。
