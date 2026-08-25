# TUI 交互规范

本页是 `apps/kite` 的 owner-local current authority，覆盖 Overlay、输入焦点、状态行、Session 导航和用户交互投影。

## 单一交互表面

- Slash command 打开的帮助、模型、权限、推理深度、主题、语言、Session、MCP 与恢复页面共用一个 modal 边界。
- Modal 可见时隐藏主输入提示、Footer 状态栏和 slash suggestion，不允许两个交互表面同时取得键盘 authority。
- 页面只解释展示状态；route、selection、draft、controller command 与 Runtime facts 仍由宿主 owner 管理。
- First-run/setup 使用独立 `FirstRunShell`，不复用普通 Overlay lifecycle。

## Overlay 布局

`OverlayFrame` 唯一拥有标题、正文、可选消息和快捷键四区的外层节奏与水平 inset。页面根节点不得重复
`marginTop` 或 `paddingX`，不存在的消息不渲染占位空行。

- Summary、Section、List、ChoiceList、DetailList、Message、ImpactNotice、EmptyState 与 ShortcutBar 使用共享 primitive。
- 可选择列表把每个可操作行直接交给 ScrollList/VirtualList；heading 不参与编号或 selection。
- 搜索行、问题说明、warning callout 与首个选项之间固定保留一行；组内选项保持紧凑。
- 删除、禁用、重连、认证、配置写入、权限或恢复动作显示“将做什么/不会做什么”的影响边界。
- 危险确认默认选择取消；普通导航和只读查看不显示副作用提示。

## 审批、问答与方案审核

- Approval Overlay 只绑定 durable queue 当前 `activeApprovalId`；后台 pending record 不抢占 Footer 或键盘。
- Enter/Esc 携带 exact `interactionId` 与 generation；Enter 提交当前 grant，Esc 只拒绝当前焦点，迟到 action 为 no-op。
- Ctrl+C 取消整轮 queued/awaiting/authorized/running siblings，不能退化为 focused reject。
- 只有 canonical granted、batch-released、rejected 或对应交互终态能关闭界面；TUI 不本地伪造 acknowledgement。
- `ask_user` 单题把问题放入标题，多题使用 `n / total` meta；自定义输入留在原列表，已完成回答不得在恢复时重开。
- Plan review、MCP recovery/admission 与其他交互同样只由 canonical terminal event 清除。

## 选择器与 Session

- 模型 identity 是 `provider + model name`；不同 provider 的同名模型保持独立 key 和 route。
- `/model`、`/permissions`、`/effort`、`/theme`、`/language` 不接受选择参数，必须打开选择器并显式确认。
- `full` 是唯一 unrestricted interaction mode；restricted backend 不可兑现 scope 时 fail closed。
- Session 切换恢复各自模型 route、interaction mode、context 与 Runtime projection，不继承上一 Session 的瞬时状态。
- 历史 Session 先等待 Host readiness/recovery，再重新读取 persisted head 并提交 navigation；迟到 load 不覆盖新选择。

## 主输入与状态行

- `InputLine` 在首次 Ink effect flush 注册 `useInput` 后立即可编辑；注册前不显示假焦点，不使用固定延时作为门禁。
- 状态阶段单向推进 `Thinking → Working → Finishing`；进入 Working 后不因模型/工具交替回退。
- Retry、Approval、Input 与 Compaction 是覆盖态，不改变底层阶段。手动 compaction 使用消息区动画，自动 compaction 与当前 run 状态并存。
- 工具卡可乐观显示 running，但执行耗时从 durable `tool.started` 开始；迟到 started 不复活终态卡片。
- TUI 只根据结构化 terminal outcome、safeRetry 与 canonical events 决定完成/错误，不从本地化文本反推。

## 验证

`bun test apps/kite/test`、`bun run test:tui:system:core`、`bun run typecheck`。
