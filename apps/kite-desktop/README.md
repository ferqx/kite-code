# 重构前 Desktop 实现与历史验证

当前桌面 owner 为 [apps/desktop](../desktop/README.md)，运行入口归[本地开发](../../docs/development/local-development.md)。本 workspace 保留旧实现、威胁模型和已保存制品的历史验证；下方历史正文中的“当前”只指重构前版本，不表示现行八 workspace 的产品合同或数据写入许可。

## 当前命令与退役范围

旧 `dev`、`dev:web`、`build`、`build:desktop`、`prepare:service`、`build:electron` 及原直接开发／Electron构建／打包／服务准备脚本现均返回 `legacy_desktop_entrypoint_retired`／退出码2。它们在旧archive读取、Profile打开、构建或服务启动前拒绝，并给出仓库根的当前命令：

- `bun run release:build --product native` 构建完整新Native候选。
- `bun run desktop` 核验并启动该候选。
- `bun run test:desktop:native` 执行当前隔离窗口／进程／Files验证。
- `bun run release:native --help` 查归档、安装、版本选择与卸载。

原Vite热更新是历史开发能力，当前制品启动不冒称热更新迁移。已保存旧制品、显式历史验收和源码仍保留各自出处，源码可从退役前 `c6bb667b` 追溯；不能用这些记录替代当前三平台资格。整个旧authority删除、RSS／观测与阶段退出保持未闭合。实际六个命令和四个直接脚本的拒绝／原数据保全见[完整调用者测试](../../tests/isolated/unified-agent/retired-desktop-entrypoints.test.ts)。

## 历史实现说明

设置入口由 [App](src/App.tsx) 以全屏覆盖层呈现；[Settings](src/Settings.tsx) 负责分类、搜索、常规编辑器选择与已有模型／扩展操作，[桌面样式](src/tailwind.css)负责固定宽度的设置侧栏、模型分组横向列表及双栏布局，并沿用共享浅色主题变量与基础字号。模型页将默认模型选择独立展示，复用共享 shadcn 下拉菜单按提供商分组选择并标记当前项；默认选择、模型启停、手动刷新和提供商保存沿用 App 的操作互斥与错误处理；App 保存前台／后台操作状态，设置页保留当前操作的局部反馈，不触发全局控件禁用。关闭重开设置后仍显示后台操作未完成并拦截新的配置操作；保留页面、滚动位置和焦点。启停开关在等待期间保持用户选择的位置，失败后回到服务确认的快照；保存中的提供商输入只读，表单不卸载，分组列出模型数量与提供商状态，以开关管理启用状态，并在窄窗口调整排列。模型页通过 App Control 的版本保护操作切换启用状态和默认模型；会话输入区只展示已启用模型。提供商配置复用共享 `RightSidebar` 在设置页右侧展开，关闭后焦点返回原操作；切换提供商时重新创建对应表单，清空上一提供商的密钥、地址与模型草稿。设置侧栏不订阅会话侧栏的拖拽宽度。没有 Runtime 配置接口的参考图开关不进入页面状态。MCP 与 Skills 的设置行为及验证边界见[扩展设置](docs/extensions.md)。

> 实施中：[会话存储兼容性与连续性 V1](../../docs/plans/session-store-compatibility-and-continuity.md)已统一正式数据入口，并验证 macOS 已知格式的自动整理、历史来源归并和原会话保留。未知格式保留原数据，不切换空库；完整方案与未验证平台的边界以计划中的最新验收记录为准。


本 workspace 是 Electron 桌面 presentation 与本机宿主 owner：React/shadcn UI 在沙箱 renderer 中运行，Electron 主进程提供受限本机能力，业务执行继续由独立 Kite Runtime Host 承担。迁移实现与本机自动原生验收已完成，制品身份和验证边界见[原生验收](docs/native-validation.md#electron-本机迁移验收)。

迁移前的 Tauri 版本曾完成[原生验收记录](docs/native-validation.md)中的本机 macOS 接入、日常开发闭环与稳定性验收；这些结果只保留为当时版本的历史证据，不能作为 Electron 制品、窗口或生命周期资格。当前仍以本机开发和内部测试为主，正式签名、公证及分发资格延后。

后续研发以 Codex 功能和日常交互体验为对标目标，需求基线与逐项核对入口见[日常体验方向](../../docs/plans/desktop-client.md#首轮验证后的日常体验方向)；当前实现职责与限制仍以下文为准。

本 workspace 对应产品名 **kite**。通用工作、shadcn/ui 及覆盖空间、会话、交互、结果、子代理、设置和恢复的整体 Figma 目标稿见[界面与协作体验](../../docs/plans/kite-client-experience.md)。renderer、Electron 窗口和当前开发包均使用 kite 展示名；包名与执行边界不因设计命名自动变化。

## 边界

主页面与 Web 共用[共享 React 页面](../../packages/kite-client-ui/README.md)，桌面入口提供已授权操作及原生宿主适配。[Vite](vite.config.ts)与[样式入口](src/tailwind.css)编译共享 shadcn/ui 控件使用的 Tailwind utilities，主题沿用共享变量。

[左侧列表与右侧会话首阶段](../../docs/plans/kite-client-experience.md#第一阶段左侧列表与右侧会话)已交付 React 展示与交互；组成、UI 状态、导航和验证边界见[两栏会话界面](docs/conversation-ui.md)。

[新对话、项目与分支](docs/new-conversation.md)说明全局准备页、首次发送创建会话、已打开项目列表和立即生效的本地分支选择；共享 UI 只呈现选择数据，原生宿主负责目录与 Git。

- [React 入口](src/main.tsx)装配[App](src/App.tsx)，[客户端适配](src/client.ts)消费 Runtime Client、App Control 与 History；[投影](src/presentation.ts)按请求身份保留累计正文与持久终态。 App 仅从已选父会话的准确 `currentRun.waitingReason` 向共享页面传递临时 required 子 Agent 等待提示；消息本身与最终答复身份仍由投影和 Turn 终态决定。
- [具名 bridge](src/bridge.ts)定义 renderer 可见的完整 API；[preload](electron/preload.ts)只通过 `contextBridge` 暴露冻结的 `window.kiteDesktop`，[IPC owner](electron/ipc.ts)逐通道核实主窗口 frame 与封闭参数。复制消息通过最大 1 MiB 的纯文本通道交给 Electron 主进程写入系统剪贴板，不依赖打包页的 Web Clipboard API。renderer 不取得 `ipcRenderer`、任意 channel、Node 或 Electron 对象。
- [桌面 transport](src/transport.ts)每次 IPC 只拉取一个有界 Runtime frame；[Electron 宿主](electron/host.ts)只启动构建时固定、运行时校验过的配套服务，[stdio 进程](electron/runtime/service-process.ts)使用单消费者和 16 帧有界输出队列。
- [页面重接](electron/runtime/renderer-connection.ts)保留同一 Service protocol peer，页面刷新或 renderer 进程退出只 detach 旧代次；新页面恢复订阅和历史，不清理运行中的任务。传输代次与 UI 导航恢复见[新对话 owner](docs/new-conversation.md#页面刷新与连接恢复)。
- renderer 只导入 `kite-local-runtime/client/protocol` 的环境无关组合，不使用 Node/Bun、Host、Store 或 Web REST。
- 关闭窗口隐藏主窗口；明确退出前由 [Electron lifecycle](electron/main.ts)查询完整会话目录，仅有运行或等待中的会话任务时要求确认。继续退出或空闲直接退出都会先关闭自有服务 stdin 并等待 Service 清理；清理失败或超过 20 秒时提供紧急退出，紧急路径不等待 Host 锁，尝试终止本应用拥有的 Service。查询无法完整确认时保守提示；失败与副作用未知保持可见，不影响其他客户端。

## 历史开发与验证

重构前开发链曾先绑定Vite 1420，再通过 `prepare-desktop-service.ts` 验证旧OSS candidate，将旧Host identity编入Main／preload并启动Electron；打包链另复制旧service resource到 `.app`。这些普通调用者现已退役，不能再按旧步骤从当前checkout运行。原开发CSP／React Refresh、打包CSP、准确配对、隔离HOME以及退出所属进程的理由仍指导其历史分析，当前负责实现见[新Native owner](../desktop/README.md)。

本目录 `typecheck`、`test`、`test:native:window`、`test:native:store-upgrade` 和明确opt-in历史模型脚本只属旧实现／已保存旧制品验证；不进入当前默认或当前平台发行资格。旧完整源码和验证出处仍可追溯退役前 `c6bb667b`，原记录中的断言和失败不因命令退役而改写。现行正式生命周期、版本切换、保数据卸载与维护恢复沿新Native／Terminal前门执行，实际平台范围和剩余门禁归[发布边界](../../docs/active/release-control.md)。

## 当前限制

配置读写、模型选择、信任、新建/历史会话、输入/流式结果、取消、单次工具审批/拒绝、问题回答与计划审核已接入。[变更阅读与外部编辑器](docs/results-and-editor.md)使用成功文件工具记录；迁移前的 Tauri 版本曾在本机 macOS 确认 VS Code 实际打开，Electron 版本仍需重做该原生验收。自动更新和非 macOS 发布未交付。扩展/验证交互明确提示限制并允许取消，不自动应答。目录使用现有 Runtime list_sessions（服务最多 1,000 条），按工作区摘要过滤；选择时再次核实归属。助手正文支持 Markdown，工具过程按需展开；点击会话直接加载消息，无标题搜索或二次确认。独立子 Agent 的只读详情可从当前父会话的环境信息卡片打开，不能作为平级会话直接进入；没有匹配独立子会话的旧后台记录只显示状态。已读主会话重进或当前页断线重接时，环境卡片保留上一份已确认的展示摘要并静默核对新状态；上一状态明确标记且不能用于停止操作，具体失效边界见[历史与恢复](docs/history-and-recovery.md)。运行中纯文本引导可追加到同一 Run，但后继消息队列尚未接入。

最新[项目进入与资料副层设计](../../docs/plans/kite-client-experience.md#workspace设置与恢复)已接入用户主动添加／选择项目即授权，由现有 Service 信任接口记录；普通重连不自动授权，关联外部目录仍单独确认。子代理已沿用正文样式；有匹配子会话时独立只读详情可用，交接回执仍待真实数据支持。文件工具记录已通过右侧副层呈现，不扩展为完整资料工作区。

Provider 设置经现有 Native `write_provider_api_key` 接口写入用户配置文件，API key 不放入 DesktopView 或浏览器持久存储，提交时清空输入。结果未知时查询配置且不自动重放；模型选择使用 App Control revision CAS。macOS standalone Service 已嵌入现有 MCP 原生 keyring 模块，其源码与编译程序的隔离读写删除 smoke 通过；迁移前的 Tauri 包内 Service 还完成了本机模拟 OAuth、Keychain 保存与重启后认证恢复。Provider 配置写入仍遵循原配置 owner，不因此改为 keyring 存储。真实 DeepSeek 已在隔离的 Electron 窗口中完成两子会话运行时的子详情往返与跨会话切换定向验证；Provider 设置、扩展及其他原生流程的证据边界见[原生验收](docs/native-validation.md)。用户行为与验证限制见[桌面手册](../../docs/handbook/clients/desktop/README.md)。


## 本次验证与剩余项

[设置面板](src/Settings.tsx)包含模型、默认编辑器及 [MCP／Skills](docs/extensions.md)分类，扩展调用沿已有 App Control；新入口的外部认证与原生资格需按该专题单独核对。[设置面板](src/Settings.tsx)和[问题/计划面板](src/Interaction.tsx)消费现有 connection。计划正文由 Service 投影，缺失或截断时只允许反馈/取消。选择并验证目标目录后，仅替换逻辑连接、授权上下文和订阅；同一配套 Service 继续管理其他空间任务，切换空间不再确认停止全服务。取消选择时保留原连接。

[凭据结果测试](test/models.test.ts)覆盖拒绝、未知结果及不重放；Service 的[计划正文测试](../kite-service/test/runtime-plan-review.test.ts)覆盖正文、脱敏、限额与身份漂移。[导航集成测试](test/navigation.test.ts)通过实际 App Server 验证项目目录隔离、允许外项目历史读取，按持久 workspace identity 与授权路由执行、快速切换时忽略旧响应与断开清理。[开发闭环测试](test/development.test.ts)验证代码写入、测试输出、重启历史和继续会话。协议证据与原生窗口证据分别记录；迁移前阶段 1 的本机 macOS 日常开发闭环仍是 Tauri 历史证据，Electron 当前的独立服务与原生窗口自动验收见下文。

[原生验收](docs/native-validation.md)保留 2026-09-07 Tauri 版本在本机 macOS 的制品、隔离条件、真实窗口与生命周期证据，并另列宿主无关的 Service 证据。这些历史结果不作为 Electron 资格；同一记录现已登记 Electron 44.3.0 独立包的准确身份、隔离原生验收与剩余人工验证。

当前 [Electron lifecycle](electron/main.ts)在关窗时隐藏主窗口；明确退出由主进程 `before-quit` 发起完整会话任务检查，只在存在运行或等待中的任务时显示原生异步确认框，空闲时直接清理退出；无法完整检查时保守显示确认。正常清理完成后再次退出；清理失败或等待超过 20 秒时仍有紧急退出路径，第二次明确退出也可触发该路径。空间切换不关闭 Service。标题栏非交互区由 CSS drag region 交给 Electron，双击才调用封闭的最大化切换。窗口、preload、重接、退出和崩溃清理需重复真实 Electron 场景，不能用单元测试或浏览器预览替代。

会话切换/重连保持订阅代次边界；跨项目清除旧选中状态，加载会话显示提示并在 20 秒后有界失败。`tool.cancelled`/`tool.rejected` 在历史与实时投影中均为终态，迟到进度不能覆盖。其余范围见[日常体验与发布资格计划](../../docs/plans/desktop-client.md)。

阶段 2 的[大历史回归](test/history.test.ts)通过真实 App Server 写入 20 轮、每轮约 32 KiB 回答，重启后完整分页恢复且每帧不超过 1 MiB；[丢失回执回归](test/resilience.test.ts)在文件已写入后丢弃 start_turn 回执，确认连接 ready 失效、结果未知提示和重连无重放。大会话渲染、与安装版 TUI 的同会话竞争、损坏制品拒绝及手动替换应用后的数据保留目前只有 Tauri 版本的历史原生证据；Electron 与 host 无关的 Service 回归分别记录，正式签名分发升级另行验收。

历史目录、无项目启动、跨空间阅读与有界自动重接见[历史与恢复](docs/history-and-recovery.md)。

侧栏空间标题右侧可经原生目录选择器添加项目；空间行移除经默认保留的原生确认后，由 Service 按空间持久身份停止和删除会话，全部历史清空后 Desktop 才移除本机项目登记。流程与失败边界见[历史与恢复](docs/history-and-recovery.md)，目录登记和预选新对话见[新对话、项目与分支](docs/new-conversation.md)。

恢复错误通过共享 Runtime 契约传递；现有错误弹窗的“检查恢复”调用只读摘要及 CAS 恢复命令，成功后清除旧准入缓存并重新校准，保留草稿且不发送。丢回执查询原命令的持久结果，查询失败仍显示未知。相关验证见[UI 测试](test/isolated/ui.test.tsx)、[Service 跨空间回归](../kite-service/test/isolated/exclusive/app-server-process.test.ts)。

Git 分支切换保留关闭与重连以重新构建配置、MCP 与 sandbox owner；在执行前确认整个配套 Service 没有活动任务，防止重载取消其他空间任务。按空间重建依赖尚未实现，不能把保留 Service 的普通空间切换逻辑直接用于 Git 环境变更。

Store 启动失败通过 Service stderr 的有限结构化诊断传到初始化错误：仅接收错误码和 schema 数字，原始 stderr 不进入界面。握手前退出显示具体 Store 错误或退出码；握手成功后仍采用正常断连处理。原生三场景验收运行 `bun run scripts/startup-store-smoke.ts`，覆盖新目录、已有历史重启、拒绝不兼容数据库且字节不变。
