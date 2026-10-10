# Agent Note: 原 PC 文件变更沿准确工具回执迁入

Status: implemented

## Problem

原桌面有逐操作文件变更和外部编辑器入口，新 Native 已复用 SessionPage，但未连接 FileChanges 与 editor leaf。新 Files 的 Model 结果只含路径和 baseline；按当前磁盘生成差异会将独立后改误记为历史操作。仅按同名 tool call 关联不能区分不同 Run；恢复检查点保首 preimage/末 postimage，也不能表示每次中间修改。用户要求移植原 kite-desktop，并以 PC/macOS 主线交付，不能从零重新设计 UI 或恢复旧 Runtime 闭包。

## Decision

迁入原共同前后缀行差异与 macOS editor leaf，继续使用原 FileChanges/FileDiff、SessionPage 与 RightSidebar。Files 在最后基线核对保存真实 preimage，确认发布内容和 FD inode 后保存中立 version1 预览；Tool 版本2与原 Model content 保持，预览仅进入通用 result.details。65536 UTF-8 byte 展示预算不变成文件 IO、Model 或 Artifact 正文上限。未知发布/捕获状态不发布成功预览，旧 receipt 缺差异明确不可读。

Native Main 沿已读 Message 的唯一 source Execution，核原 Store/Session/Run、定义、succeeded 状态、resultRevision 与准确内容；Fork 只沿封存来源读取。renderer 只取得有限观察 ID，展开才读正文，文件按钮只传观察 ID 和封闭 editor 枚举。打开前再次核当前登记 Workspace、原物理根 dev/inode、普通文件、受保护范围与原 renderer frame。原来源项目不同或不能确认时保阅读，不取得当前项目打开入口。固定 `/usr/bin/open` 和独立 argv 保原宿主语义，不引入通用 shell/任意应用 bridge。

恢复历史的当前 Store 只承担准入，原 Files 必须由真实原 Run 与唯一 source Execution 的 Session/Run/出处证明；plain 与 sealed 分别沿原消息和严格封存 originMessage，不把旧出处重标为当前 Store，不借当前 Run 补空来源，也不要求原整 Run 成功才可读已有成功工具。观察 ID 封存原 Run/Command、Execution 定义、revision 和完整结果 SHA-256；详情/打开重核，拒绝同 revision 换绑。固定摘要保整结果变化检测，避免在身份状态中再次持久复制 Files.read 内联正文。普通 Markdown 有原 Run 时核固定身份，无 Run 的原用户路径仍由已观察 Message、当前准入的源 View 同 Workspace 与物理目标约束；它只命名当前文件，不授执行或贡献身份。真实默认 Files、公开恢复及两冷 Node 消费者的准确红绿和有限范围见[恢复文件进度](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-10恢复后-native-文件历史与当前文件入口)。

两个侧栏入口切换时关闭原 host 面板，并按用途区分 RightSidebar 组件身份，避免保留旧 Tabs 选择；栏宽只跟随当前右栏总体开关，不在 host 面板关闭时误折叠接续的文件面板。Native 内容拥有 GET，关闭即卸载；旧纯展示内容的保留规则不扩大为隐藏读取。

消息中的普通 Markdown 文件路径继续迁入原 MessageContent 回调，经当前已读 Message、独立 viewSelection/history epoch 和登记 Workspace 绑定，允许有限 UTF-8 路径与封闭编辑器枚举；Main 不接受 renderer 的根或应用名，复核项目内普通目标、保护目录、源 Workspace 和派发前 frame。这只命名当前文件，不形成工具成功或历史贡献证明。真实 Files read/write/edit 的消息行另沿准确原 Execution/结果资格取得观察 ID，完整历史不依赖 View 近200项；双消费者扫描同一完整原结果保持观察 ID，实际 scope/root/结果/来源变化才替换。正文 slot 只改变同一预览或已验证全文的展示，原 EOF/身份/字节/关闭门禁保持。

原常规卡显示准确作用域配置默认，不复用临时会话选择或活动 Model 快照；消息切换和设置关闭只释放各自 GET。新对话准备页沿已有用户配置读取，所选主会话沿当前项目配置读取；没有增加私有存储或恢复格式。

## Alternatives considered

- 重新读取当前文件或 Git diff：没有原操作前像，独立编辑与后续修改会污染历史；未采用。
- 用恢复检查点生成差异：首/末快照不能表达每次中间操作；恢复与贡献阅读的身份范围不同；未采用。
- 从模型参数/工具名推断路径和 diff：不能证明实际派发与成功，也不能排除同名 call 或 MCP 伪相似输出；未采用。
- 给 Message 增加另一套 Execution 关联或专用文件字段：已有通用 sourceIds/result.details 可准确关联，不需要重复身份字段或格式升级；未采用。
- File receipt 按钮接受 renderer 任意根、路径和应用名：会替换已确认操作的目标且不能复核观察来源；该入口继续沿有限 ID 和现有固定应用 leaf 处理。
- 新建面板/编辑器 UI 或继续依赖旧 Runtime workspace：违背已确认的原 PC 复用目标，并产生另一条执行链；直接迁入原组件与中立 leaf。

## Consequences

成功操作分别保留。预览可能截断，编辑器打开当前磁盘内容，二者不冒充当前 Git diff 或完整 Agent 贡献。完整文本操作仍受真实平台表示和内存能力约束，本决定不声明 RSS/全局资源资格。全部 Core/生成 HTTP schema、UI 私有格式和维护资产不变；没有旧用户数据迁移、隐式重放或 Shell/MCP 文件变更猜测。

当前完整合同与测试归 [Files owner](../../../../packages/agent/src/tools/files/README.md#逐操作文件变更预览)、[Native owner](../../../../apps/desktop/README.md#原文件变更面板与编辑器)和[实际阶段证据](../../../../docs/plans/unified-agent-refactor-v1-progress.md#2026-10-08原文件变更与编辑器入口迁入)。端口 callback 和窗口按钮不证明 OS 编辑器窗口实际打开，跨平台、安装版全路径和完整 V1.3 仍按原退出条件核对。
