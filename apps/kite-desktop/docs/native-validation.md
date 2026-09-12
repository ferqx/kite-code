# 桌面原生验收

> **证据范围：**下列 2026-09-07 与 2026-09-11 结果来自已经退役的 Tauri 宿主，只保留为迁移前行为与 Service 证据。它们不证明当前 Electron 的 `.app`、preload/IPC、窗口、renderer 重接、退出或崩溃清理已经通过。当前 Electron 的独立制品身份、已通过场景与剩余验证见[本机迁移验收](#electron-本机迁移验收)。

## Tauri 历史验收

2026-09-07 在 macOS 26.6.2 / arm64、Xcode 26.6、Bun 1.4.0、Rust 1.98.1、Tauri 2.11.5 完成。宿主来自当时的 `feat/tauri-desktop` 未提交构建；这是旧宿主的本机开发验收，不是 Electron、正式签名、公证或跨平台发布资格。

## 阶段 0：制品与隔离

- 最终宿主 executable SHA-256：`d6ec4e4e7c7b1b6c487475c96b3d588f12fed7a6969d6ad0fbc74f77ca84d960`。
- 配套 Service candidate：`f67f0af5fc30c1d491f9139f`；Service SHA-256：`427945f6ef55133bc0b87321059883f41337b41f83e03b77bea40bda85ee3145`。
- GUI 进程使用专用临时 HOME，工作区、配置、信任、会话与 PID 文件均与用户数据隔离。模型使用已有 `createMockModelServer` 本机 HTTP fixture，没有调用外部 Provider。
- 最终 `.app` 复制到源码目录之外，工作目录为隔离 HOME，应用 PATH 仅为 `/usr/bin:/bin:/usr/sbin:/sbin`。实际子进程路径确认来自该副本的 `Contents/Resources/service/kite-service`，没有查找 Bun/Node 或源码入口。测试驱动和外部模型 fixture 使用 Bun，不属于应用运行依赖。
- 工具清理场景使用测试配置 `sandbox.enabled=false`，仍通过桌面上的单次审批启动命令；不把这个场景计作沙箱隔离或生产 effectful capability 资格。

## 已验证的原生行为

| 场景 | 操作与证据 |
| --- | --- |
| 首次打开项目 | 使用真实原生目录选择器输入隔离路径，核对连接后的 canonical path 与工作区信任面板；确认前不提交任务 |
| 流式任务 | 从真实输入框粘贴任务，点击发送；截图包含部分正文与“执行中”，模型 fixture 记录一次请求 |
| 关窗与重新激活 | 流式执行时点击 macOS 关闭按钮，宿主与 Service 继续存活；再次激活后显示完整正文与“已完成”，没有重复回答 |
| 主动取消 | 运行延迟模型任务，点击“停止任务”；显示“已取消”并保留已提交输入与先前结果 |
| 断开确认 | 确认框出现时连接仍在；“返回”保留连接，“停止并断开”释放自有 Service |
| 明确重连 | 重连原项目后恢复所选会话、历史和进程内草稿；fixture 请求计数不增加，没有重发任务或审批 |
| 跨项目切换 | 切到另一个空工作区后清除原选中会话、正文与当前输入框内容，显示新工作区的信任状态；会话目录仍按当前 profile 列出 |
| 正常退出 | Command-Q 和 macOS Quit Apple event 均进入绑定主窗口的确认；“返回”保留任务，“停止并退出”后宿主正常返回 0，Service 完成清理 |
| 模型执行中宿主崩溃 | 记录测试宿主与 Service PID，SIGKILL 仅作用于宿主；随后两者均不存在，读取历史没有重新发起模型请求 |
| 工具审批与进程树清理 | Shell 命令仅在测试工作区写入两个 PID 文件并启动 sleep；批准前文件不存在。点击“仅批准这一次”后记录真实 Service、执行包装器、Shell 与 sleep PID；SIGKILL 宿主后，约一秒后的查询确认这组 PID 全部不存在 |
| 崩溃后历史 | 新进程读取到 `approval.granted`、`tool.started`、`tool.cancelled` 与终态记录；原生界面显示工具取消，不再显示进行中；模型请求计数仍为一次 |
| 原生截图 | 通过系统屏幕录制权限，仅截取测试 Kite 窗口；浏览器预览未替代上述原生证据 |

审批/取消的终态仍以 Service 投影为准。冷读取的恢复提示与当前订阅投影可能处于不同加载时刻，不以一次文字截图覆盖后端恢复契约，也不将取消视作文件回滚。

Rust carrier 回归另以真实持续输出进程验证接收端停读时仍可通过 EOF 清理，无需等到强杀期限；分帧测试覆盖截断、非法 UTF-8 与超限输入。重复退出不能绕过清理的许可顺序同时经过代码核对。

## 本轮修复的原生差异

- `tauri-plugin-dialog` 将浏览器 `confirm` 替换为异步调用。原同步判断会把 Promise 当作批准，且缺少消息权限；现在使用显式 `confirm` API、精确消息权限并等待结果。
- macOS 默认 Quit 直接进入 Cocoa termination，不能仅靠 Tauri `ExitRequested` 覆盖。当时的本机退出适配将 `applicationShouldTerminate:` 路由回同一 Tauri 确认/清理流程；没有新增第二套 Service lifecycle。确认框明确绑定并显示主窗口，真正完成清理后才允许退出事件循环。旧源码已随宿主迁移删除，本段只描述历史修复。
- 项目切换清除旧选择；同项目重连重新建立所选会话订阅。已有会话加载有显式提示和 20 秒超时，失败时释放订阅。
- 工具取消/拒绝事件作为持久终态处理，迟到进度不能恢复“进行中”；没有正文的工具型模型响应不显示假的“正在思考”。

## 阶段 1：日常开发闭环

2026-09-07 在同一本机 macOS 环境完成新增功能验收，最终配套 Service candidate 为 `0a1dfe51f83ff1faa90c2ff4`。测试 `.app` 复制到源码目录外，使用隔离 HOME、两个临时项目和本机 HTTP 模型 fixture；只操作测试窗口，用户原有应用与配置保持不变。此前锁屏导致 AX 控件与屏幕捕获不可用，用户解锁后恢复；下列结果来自解锁后的实际原生窗口操作。

| 场景 | 操作与证据 |
| --- | --- |
| 配置与模型 | 原生设置面板保存 OpenAI-compatible 的测试 key、endpoint 和模型；非法 URL 显示错误，随后有效保存清除旧错误，密码输入清空。替换同名 Provider 的 endpoint 后重选当前模型，后续任务实际请求新 endpoint |
| 会话与项目草稿 | 两个会话分别输入不同草稿，切换后各自恢复；切换第二项目时目录和输入清空，返回原项目选择原会话恢复其草稿 |
| 问题 | 点击选项后服务收到对应 option id；自由回答原样返回。取消回答向模型返回取消结果，模型仍可继续并结束任务 |
| 实际修改与验证 | 通过原生窗口回答问题、写入 `sum.test.ts`、单次批准 `bun test sum.test.ts 2>&1`；真实测试输出为 1 pass、0 fail，任务完成，已有用户文件不变 |
| 结果阅读 | 展开文件操作，核对路径、写入内容和工具测试输出；展示与服务持久投影一致 |
| 外部编辑器 | 在结果面板选择 VS Code，真实编辑器打开 `sum.test.ts`，其 AXDocument 与测试工作区文件 URL 一致。TextEdit 只确认启动分发成功，未取得文档窗口；Zed 未安装，这两项不计作实际编辑器验收 |
| 冷启动继续 | 正常退出测试应用后重新打开并选择项目，历史仍包含写入、测试和完成结果；继续前 fixture 请求数不增加，提交新消息后原会话继续成功 |
| 计划反馈与批准 | 阅读完整计划，提交修改要求后展示第二版正文与新增验证步骤；点击 Accept Edits，服务收到第二版身份与执行模式，计划随后完成。另一个计划通过取消结束；Auto 模式本轮未单独点击验收 |

外部 Provider 证据独立记录：同日使用既有 DeepSeek 配置的 `deepseek-v4-flash`，经真实 App Server 协议在隔离工作区完成文件写入、批准执行 Bun 测试并得到 `1 pass`；重启服务读取到相同历史，再继续原会话成功。测试配置和凭据副本在结束后清理，原用户配置未修改。此项证明外部 Provider 与服务链路，原生 UI 场景使用本机 fixture，不能合并表述为原生窗口调用 DeepSeek。

本轮同时修复三处实际差异：Abort 订阅与断开并发时吞住清理阶段的 unsubscribe 拒绝；设置成功后清除此前的失败提示；替换 Provider 配置后重选当前模型也刷新既有 runtime 使用的配置。对应回归覆盖真实 App Server 的快速切换、项目隔离、配置替换和后续模型执行，没有新增重放队列或第二套配置 authority。

阶段 1 完成本机 macOS 日常开发闭环。正式安装升级、签名/公证、原生凭据库、长会话、多客户端竞争和其他平台仍属于阶段 2；本轮不授予这些发布资格。

## 阶段 2：本机稳定性与升级验收

2026-09-07 在同一 macOS 环境继续验证。最终候选为 `ac88d3d770a048b436c774ed`，宿主 SHA-256 为 `38d4e1a4d07d87d29e69243e9a3edc41e204820e4e7e0f37a0d9130cd11e81f3`，包内 Service SHA-256 为 `cae063b7940e101000247e607121d96dcce8abfbc01cd1cc3e3c548eb681f784`。应用、TUI 安装、HOME 和模型 fixture 均为隔离测试副本。

| 场景 | 操作与证据 |
| --- | --- |
| 手动替换应用与数据保留 | 先用阶段 1 候选建立会话，正常退出并确认宿主/服务已结束；替换同一测试 Applications 路径的 `.app`，保留 HOME 和项目。新应用读取原对话，不增加模型请求，随后成功继续原会话；配置和既有文件 SHA-256 不变。此项没有模拟下载 quarantine、DMG 或正式签名升级 |
| 大会话 | 实际配套服务生成 20 轮、200 条 source record、合计 3,011,507 字节 transcript。真实原生窗口加载全部 20 段长回答，逐段核对长度和结束标记，截图确认正文滚动与输入区域；该验证使用 `4075b1194de722a85c0cac23`，最终候选仅追加 TUI 依赖修复 |
| 桌面与 TUI 竞争 | 同一最终候选、canonical profile 与既有 Session。桌面任务显示执行中时，实际安装的 TUI 提交第二条任务，显示 `Runtime command rejected: runtime_busy`；fixture 请求计数保持 23，未产生第二次模型请求，随后从桌面取消原任务 |
| 缺失服务 | 删除独立故障测试 `.app` 副本中的服务，通过真实目录选择器打开项目；显示“配套服务缺失。”并保持离线，没有创建 profile |
| 损坏服务 | 给同一故障副本服务追加一个字节后再次打开项目；显示“服务制品校验失败，请重新安装。”，未启动服务或创建 profile |
| 提交结果未知 | [回归](../test/resilience.test.ts)通过实际 App Server 执行文件副作用后丢失回执，检查重连没有第二次写入；该项是服务/适配层证据，未计作新的原生窗口故障注入 |
| 通道压力 | Rust 真实持续输出进程在接收端停读时仍能通过 EOF 退出；同一 carrier 的有界分帧及关闭回归通过 |
| 原生凭据 | [平台 smoke](../../../tests/qualification/mcp-keyring-platform-smoke.test.ts)在源码和使用发布编译函数生成的 standalone 程序中完成隔离 key 的写入、读取与删除。编译程序删除源入口、仅使用系统 PATH 后仍通过；尚未验证正式签名桌面包下的完整 MCP 授权流程 |

实际安装的 TUI 会话选择器最初因依赖导出调用 `jsxDEV` 在生产 React 下崩溃。现在使用锁定的单行依赖补丁调用生产 JSX runtime，并以编译后的列表渲染回归及上述实际 `/resume` 验证；不增加构建兼容层。大历史改为固定 source sequence 的有界分页，继续由 History owner 读取、Runtime Client 汇总，无额外持久缓存。

当前本机没有有效代码签名身份。正式签名、公证、下载后 Gatekeeper、签名包的凭据加载以及正式分发升级仍未授予资格；Provider API key 继续由现有配置 owner 保存，不将 MCP keyring smoke 表述为 Provider 密钥迁移。

补充 MCP 控制链验证：使用随机 bearer 测试项、真实 OS HOME（仅供系统 Keychain 定位）、显式隔离的 config/runtime root 与本地 HTTP fixture，源码 App Server 两次启动均发现 1 个工具，fixture 共收到 12 次携带正确凭据的请求，控制快照不包含凭据明文。每轮结束删除该测试项并确认读取为空。最初将 OS HOME 也改成临时目录时，源码 Service 无法找到原 OS Keychain 中的测试项；这不构成打包缺陷。

最终包内 Service 随后通过自身 OAuth 凭据生命周期验证：同一候选 `ac88d3d770a048b436c774ed`，应用目录外的测试驱动通过 App Control 发起 login，系统浏览器打开本机模拟授权页，回调核对 state，token endpoint 核对 PKCE verifier。Service 自己将随机 token 保存到原生 Keychain；关闭后重新启动同一包内 executable，自动恢复 authenticated 并再次发现 1 个工具。两次启动合计 12 次携带正确凭据的请求，仅 1 次授权、1 次 token 交换，控制快照不含 token。测试结束删除对应的随机凭据项并确认读取为空。该项验证使用仅系统 PATH、真实 OS HOME 及显式隔离的 config/runtime root，不使用真实外部账号，也不依赖另装 Bun 来运行 Service。

另一个程序预先创建的 bearer 测试项在包内 executable 读取时未完成系统授权，这个跨程序导入场景仍未验证，不能据自身 OAuth 成功推断已有凭据可无提示迁移。上述 MCP 场景均使用开发配置 `sandbox.enabled=false`，不授予[正式执行平台](../../../docs/active/execution-platform-support.md)的 MCP 网络资格。


## Tauri 证据的重复条件

准备和构建命令见 [desktop owner](../README.md)。重复原生验收需要用户授权的辅助功能、屏幕录制及自动化权限，并与用户串行使用测试窗口。只操作隔离应用；在发送键盘事件前确认焦点，英文 fixture 输入使用粘贴避免中文输入法候选影响。等实际状态或控件出现，不把一次 AX click 返回当作异步业务完成。

macOS Quit Apple event 在 termination 被拦截时可返回“用户已取消”错误；必须继续核实应用中的确认框和最终进程退出，不能单独用该 AppleScript 退出码判断验收失败。

历史 Tauri 分支若升级 Tauri/tao/rfd 或调整 native delegate、窗口、IPC 与退出逻辑，需重新执行这些原生场景。当前 Electron 实现不能通过重跑旧宿主测试取得资格。只改展示时可复用仍有效的 Service 证据，但必须补充受影响的 Electron 窗口验证。

## Electron 本机迁移验收

2026-09-12 在 macOS 26.6.2 / arm64、Bun 1.4.0、Electron 44.3.0 完成当前开发包的自动原生验收。构建输出为 `apps/kite-desktop/out/kite-darwin-arm64/kite.app`；[窗口 smoke](../scripts/native-smoke.ts)将整个应用复制到源码目录之外的随机临时目录后启动，运行不依赖 checkout、另装 Bun 或 PATH 中的 Service。

本次制品身份：

- 配套 candidate：`70e2e25ef6717b23d8740398`。
- Electron main SHA-256：`701aa440628aed337af7ff5d200e5e07690bdda62c2edd8383324941ec393413`。
- `app.asar` SHA-256：`a0572b8510b05684354d6502b8e3b46fecbc5be7bca4e206f182a8ed22609441`。
- 包内 Service SHA-256：`43a90598aa92b48d6f1b19b708f95cb7ad879b128dc0dc004c7ed4af9d394966`。

macOS 的 `app.getPath('home')` 不受 shell HOME 覆盖，packaged Electron 也不执行普通 `-r` 启动隔离脚本。因此窗口 smoke 使用 `--inspect-brk` 在生产入口执行前暂停，通过测试调试器设置临时 home、appData 和 userData 后恢复；这些设置没有写入产品，也没有增加测试环境开关。测试工作区、配置和本机模型服务均隔离，目录选择与确认框的返回值由测试调试器代答，不调用真实外部 Provider，不验证用户点击系统对话框的过程。

| 实际验证 | 结果与边界 |
| --- | --- |
| `bun run test:desktop:native` | 真实 Electron host + compiled Service 完成 exact initialize、首屏目录、流中 detach/reattach、旧 receive 取消、复用 RPC id 的代次隔离、持久历史、活动执行 EOF 清理及后继 Service 读取。一次冷样本为 1193ms，后续样本 219ms；均只覆盖摘要校验至初始目录，不是系统点击至窗口绘制计时，也不承诺所有启动小于 300ms |
| `bun run test:desktop:window` | 源码外 `.app` 完成真实 preload/IPC、添加项目与信任、本机模型流式、运行中关窗隐藏与重新激活、刷新后递增 connection generation 并继续展示同一回复；model fixture 未发生任务重放 |
| renderer 权限 | 实际窗口的 sandbox/contextIsolation 均为 true，nodeIntegration 为 false；页面只有具名 bridge，没有 `require` 或 `process`。封闭参数、主 frame 身份和路径边界另由 host 专项测试验证 |
| 退出 | 取消退出保留窗口与连接，确认退出等待自有 Service 收尾并以 0 退出。原生消息框由 fixture 代答，其 UI 与辅助功能操作尚未人工验收 |
| 标题栏与显示 | OS 级单窗口截图确认 52px header 内的交通灯与 kite 标识互不重叠；展开与收起态保留 80px 控件区，交通灯位置为 x=13/y=19；真实 bridge 最大化和还原通过。截图输出为 `out/electron-native-window.png` 与 renderer 截图 `out/electron-native-smoke.png` |
| host 压力与错误 | 桌面 54 项测试通过；其中真实子进程验证无人读取的满输出队列仍能通过 EOF 正常退出，非法 UTF-8/超限帧会关闭自有服务；项目/Git/editor/manifest 的拒绝路径由对应 host 测试覆盖 |

构建集成修复了 Bun 将源码 `__dirname` 固化到安装包、导致 preload 缺失的问题，当前从 `app.getAppPath()` 定位打包资源。标题栏修正了 Tauri 的偏移量在 Electron 中造成的交通灯／标识重叠。正式包只包含构建代码、页面资源与配套服务，不包含开发依赖和 source maps。

当前仍未重做系统中文输入法、用户操作目录／消息对话框、实际鼠标拖拽和标题栏双击、快速拉伸、外部编辑器及完整系统认证的人工验收；本轮也没有取得 Electron 主进程崩溃下工具进程树的 OS 级资格。它们不能从 DOM、主进程方法或 Tauri 历史证据推断。正式签名、公证、下载后 Gatekeeper、签名包升级、自动更新与其他平台不在本轮资格范围内。

### 开发窗口白屏修复

2026-09-12 补验 Vite 开发入口：原 CSP 的 `default-src self` 阻止 React Refresh 内联初始化，导致开发页面无法挂载。Electron 现在只在开发模式的 `script-src` 中允许内联脚本，打包模式仍限定自身脚本。在隔离 home/appData 的真实 Electron 开发窗口中，首次加载与刷新均显示新对话页面，具名 preload bridge 可用，React Refresh 初始化函数存在，页面及控制台错误为零。此项是开发入口证据，不更新上文已记录安装包的制品身份。


### 会话缓存合并复验

2026-09-12 将缓存实现适配至 `el` 的 Electron bridge、工作台及首次创建／阅读分离流程后，重新打包并运行[原生窗口 smoke](../scripts/native-smoke.ts)。本次 `app.asar` SHA-256 为 `40179359dfcf004afda2309b41adecc087d83f37414f557d29075c5ac95140f9`，Electron main 为 `c7fe76f7042ccb4a4bcaf9528ee45cbf0da7cdadee460e9bfc61c32d41026c8f`；配套 Service 沿用 candidate `70e2e25ef6717b23d8740398`。以上更新仅对应本次制品，前文摘要保留为换型验收时的记录。

源码外的实际 `.app` 使用真实 preload、封闭 IPC 与配套 Service 建立两个会话。测试调试器只延迟其中一次 history page 响应 2 秒：切回首个会话后，两次 animation frame 探针在 9.5ms 读到已缓存的用户／助手正文，未出现整页加载；旧草稿恢复且可以继续编辑，发送保持禁用，校准完成后恢复。延迟位于通过身份与参数校验后的 IPC 返回边界，不改变产品 bridge，也未给 renderer 开放额外能力。这个单次短会话样本不是 500 消息／30 次 p95 资格，不能替代[换型前的性能记录](history-and-recovery.md#缓存性能验证)。

同次 smoke 继续通过沙箱／contextIsolation、隐藏恢复、流式刷新重接、标题栏最大化与还原、取消退出和确认退出；模型请求未重放。原生目录选择与确认框仍由 fixture 代答，人工系统输入法等既有边界不变。[校准回归](../test/session-calibration.test.ts)另验证：当前缓存校准期间，明确发送到新创建会话的请求仍保持原目标，而当前阅读会话不能提前发送或审批。
