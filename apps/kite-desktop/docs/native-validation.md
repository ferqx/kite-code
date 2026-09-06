# 阶段 0 原生验收

2026-09-07 在 macOS 26.6.2 / arm64、Xcode 26.6、Bun 1.4.0、Rust 1.98.1、Tauri 2.11.5 完成。宿主来自 `feat/tauri-desktop` 当前未提交构建；这是本机开发验收，不是正式签名、公证或跨平台发布资格。

## 制品与隔离

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
- macOS 默认 Quit 直接进入 Cocoa termination，不能仅靠 Tauri `ExitRequested` 覆盖。现在通过[本机退出适配](../src-tauri/src/macos.rs)将 `applicationShouldTerminate:` 路由回同一 Tauri 确认/清理流程；不新增第二套 Service lifecycle。确认框明确绑定并显示主窗口，真正完成清理后才允许退出事件循环。
- 项目切换清除旧选择；同项目重连重新建立所选会话订阅。已有会话加载有显式提示和 20 秒超时，失败时释放订阅。
- 工具取消/拒绝事件作为持久终态处理，迟到进度不能恢复“进行中”；没有正文的工具型模型响应不显示假的“正在思考”。

## 后续重复验证

准备和构建命令见 [desktop owner](../README.md)。重复原生验收需要用户授权的辅助功能、屏幕录制及自动化权限，并与用户串行使用测试窗口。只操作隔离应用；在发送键盘事件前确认焦点，英文 fixture 输入使用粘贴避免中文输入法候选影响。等实际状态或控件出现，不把一次 AX click 返回当作异步业务完成。

macOS Quit Apple event 在 termination 被拦截时可返回“用户已取消”错误；必须继续核实应用中的确认框和最终进程退出，不能单独用该 AppleScript 退出码判断验收失败。

升级 Tauri/tao/rfd 或调整 native delegate、窗口、IPC 与退出逻辑时，重新执行这些原生场景。只改展示时复用仍有效的服务证据，补充受影响的窗口验证。后续模型配置、问题/计划交互、完整恢复、大会话、正式安装升级、签名/公证与其他平台仍按[首版计划](../../../docs/plans/desktop-client.md)推进。
