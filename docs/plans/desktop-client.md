# 桌面客户端日常体验与发布资格

状态：Electron 本机开发和内部测试持续进行；日常体验目标与正式发布资格仍待逐项验收。已交付事实与验证归位 desktop owner。

当前宿主为 Electron。架构、构建和本机验证以[desktop owner](../../apps/kite-desktop/README.md)、[原生验收](../../apps/kite-desktop/docs/native-validation.md#electron-本机迁移验收)及[桌面手册](../handbook/clients/desktop/README.md)为准；本计划仅维护未完成的体验目标和发布资格。

## 首轮验证后的日常体验方向

2026-09-07 用户确认初始首轮验证完毕，后续进入日常体验开发，并要求客户端功能与日常交互体验对标 Codex。当前工作对象为桌面客户端；首版验收范围是起点，首版中暂缓的功能不构成后续对标的永久上限。正式发布仍按既有安排延后。

用户进一步确认桌面产品名为 **kite**，**kite-code** 为 TUI 名称；桌面覆盖代码与日常其他工作，采用 shadcn/ui，并改善子代理可见性和大量任务的浏览。具体需求、Figma 稿件和已确认交互集中维护在[kite 界面与协作体验](kite-client-experience.md)。

对标同时检查功能覆盖与完成同一任务的操作体验：入口是否容易找到、输入是否顺手、过程与结果是否清晰、任务切换是否连续、等待或失败时是否知道下一步。首轮验证通过不能代表这些体验已经达到目标。

以下为后续核对顺序与需求基线，具体交互和实现方案按场景逐项收敛，尚未声明功能对齐完成：

| 优先核对场景 | 对标目标与核对内容 | 当前证据入口 |
| --- | --- | --- |
| 输入与阅读 | 发送/换行、中文输入法、焦点与快捷键、上下文添加、Markdown 与代码块、复制、流式阅读与滚动 | 当前正文使用共享 Markdown 会话页面；实现与限制见[会话界面 owner](../../apps/kite-desktop/docs/conversation-ui.md)和[桌面手册](../handbook/clients/desktop/README.md) |
| 项目与会话 | 新建和继续、快速切换、搜索、重命名、归档、置顶、未读和任务状态、草稿保留 | 主界面已有基础会话导航；跨重启草稿仍是[手册限制](../handbook/clients/desktop/README.md) |
| 执行与交互 | 工具过程折叠、等待/完成/失败反馈、运行中补充要求、停止、审批、问题与计划审核 | [客户端 owner](../../apps/kite-desktop/README.md)已有基础执行与交互；新增控制行为先核实服务契约 |
| 检查开发结果 | 文件与代码差异阅读、定位与评论、编辑器跳转、终端及 Git 工作流 | [结果 owner](../../apps/kite-desktop/docs/results-and-editor.md)当前展示文件工具记录；完整工作区 diff 与任务修改归属须分别核实 |
| 模型、设置与扩展 | 设置入口与生效反馈、模型切换、Skills/MCP 的发现与使用 | 当前配置与能力见桌面 owner；复用现有配置和扩展 owner |
| 持续工作 | 重启继续、后台状态与通知、多任务和 worktree、自动化、远程能力 | 当前生命周期与历史见桌面手册；按本地日常收益与现有服务边界确定后续实施顺序 |

整体目标与实施边界已经归入[界面与协作体验](kite-client-experience.md)。后续实施按以下顺序推进，每一阶段先核实生产数据与控制契约，再实现对应画板，不从视觉样例反推服务能力：

1. 保持 Current 行为完整：项目与信任、Provider/模型、会话、流式过程、审批、问题、计划审阅、停止、重连、历史和文件工具结果。
2. 完成高频 Next 体验：任务搜索与预览、富文本输入与阅读、持久草稿、后台状态、统一执行详情和验证证据。
3. 接入结果工作区：分别核实文件记录、工作区变化、Git diff、Terminal 与 Review 的 producer、归属和失败行为。
4. 完成 Subagent 桌面协作：摘要、详情、等待依赖、失败影响、取消与交接均消费 Runtime 真值。
5. 补齐恢复与扩展管理：把断线、重试失败和恢复同步作为会话消息呈现，并补齐上下文连续性、MCP、Skills 与连接诊断；Vision 的跨项目、远程和自动化另行取得需求与运行证据。

参考核对日期为 2026-09-07：[Codex 官方功能入口](https://developers.openai.com/codex/app/features)与[官方命令和快捷键](https://developers.openai.com/codex/app/commands)。两者当前重定向至 OpenAI 的共享文档；其中会话管理、导航、模型选择、文件和审阅入口可作为核对线索。共享页面中的 ChatGPT 专属项不直接算作 Codex 功能，具体版本、平台、可用条件和操作细节在对应迭代中核实。上表包含 Kite 的体验验收要求，不表示每一项已取得 Codex 的实测证据。

每项迭代记录 Codex 参考行为、Kite 当前行为及证据、目标行为和验收场景；区分缺少能力与已有能力的体验缺陷。桌面 presentation 的局部改进沿现有 owner 实施；涉及服务、状态、持久化或权限时再补充实际受影响契约，不预建通用框架。验收覆盖正常操作及相关切换、失败、取消和恢复场景；原生交互使用真实桌面证据，接口或组件测试只证明其覆盖部分。已交付行为同步手册与 owner。

required 子 Agent 等待展示已实施；当前行为见[桌面手册](../handbook/clients/desktop/README.md)和[会话界面 owner](../../apps/kite-desktop/docs/conversation-ui.md#消息与交互)，打包 Electron 的定向证据见[原生验收](../../apps/kite-desktop/docs/native-validation.md)。

## 迁移前首版记录

Tauri/Rust 宿主曾完成 macOS 阶段 0–2 的本机接入、交互和稳定性验收，随后被 Electron 替代。原始选型理由保留在[归档 Agent Note](../../.agents/notes/archived/feature/2026-09-06-tauri-desktop-client.md)，当时的原生结果和限制保留在[原生验收记录](../../apps/kite-desktop/docs/native-validation.md)。这些结果不授予 Electron 制品、签名包或其他平台资格；当前客户端行为由桌面手册与 owner 文档说明。迁移前方案正文由 Git 历史追溯，不再作为实施步骤。

## 正式发布待验（当前）

用户确认暂不急于正式发布，当前以本机开发和内部测试为主。Electron 制品仍须分别验证签名、公证、下载后 Gatekeeper、正式分发升级与回退、签名包的 MCP 原生凭据流程，以及目标平台的安装、执行和生命周期。没有 Apple 签名身份不阻塞未签名开发测试，但不能以本机未签名包或迁移前 Tauri 包的结果替代正式资格。

发布方案须按当前 Electron 宿主和配套 Service 制品核实签名顺序、manifest 摘要、所需 hardened runtime 权限和升级后 Store 兼容；不能沿用历史 Tauri 打包步骤。已交付的本机行为、尚未覆盖的原生场景与测试条件见[桌面 owner](../../apps/kite-desktop/README.md)和[原生验收](../../apps/kite-desktop/docs/native-validation.md)。
