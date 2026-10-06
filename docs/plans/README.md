# 开发计划

这里只列已经确认并适配当前架构、可以继续实施的仓库研发工作；候选需求与旧方案不混入当前入口。这些 Markdown 计划的交付状态由本次变更与验证判断，不使用产品运行时的 Plan/Task 状态作为研发完成依据。

## 正在实施

[通用 Agent 一体化重构与持续演进方案](unified-agent-refactor-v1.md)：以完整用户能力迁移、统一公共边界、正式旧路径退役和阶段退出为主线；执行目标与阶段边界见[总体进度](unified-agent-refactor-v1-progress.md#执行目标与阶段边界)。外部工具、真实 SQLite Worker、唯一 Loop 和两进程重启读取已有最小闭环。实际调用者切换、完整 T/E 场景与发行资格按[进度证据](unified-agent-refactor-v1-progress.md)及[能力映射](unified-agent-refactor-v1-capabilities.tsv)核对；总体尚未完成。

[通用 Native MCP 完整设置与原操作](unified-agent-native-mcp-settings.md)：已确认设计，实施中；正式 Native 的来源、认证、连接、原工具详情与实际系统浏览器/default OS vault 联合资格，保现行公共合同与冷零重发。

[客户端启动、服务生命周期与发布升级规范](daemon-upgrade-lifecycle.md)：阶段 1、2 已完成本机实现与验证，阶段 3 的发布门禁已接入；Linux/Windows hosted 资格仍待验证。覆盖默认 TUI/CLI 配套服务、共享 daemon 与 Web；未来桌面端仅规定接入边界。

[桌面客户端日常体验与发布资格](desktop-client.md)：Electron 本机开发和内部测试持续进行；按[日常体验方向](desktop-client.md#首轮验证后的日常体验方向)逐项核对功能覆盖、交互体验与正式发布条件。迁移前 Tauri 的本机验证仅作历史证据。

[kite 界面与协作体验](kite-client-experience.md)：Figma 主稿使用用户提供的 shadcn 组件文件，Kite 内容集中在客户端页面、交互原型和业务组件三个页面。当前 13 个原型状态和 8 个客户端状态复用已有组件；工具过程按需展开，审批处理后退出操作区。最新修订移除批注，主动添加项目即授权，子 Agent 沿用普通消息并显示回传主 Agent 的结果，资料与产出改为顶部按钮控制的右侧副层。产品要求、实施进展和后续验证边界由方案正文维护；设计完成不代表对应客户端能力已交付。

[后台 Agent 与 Shell 的会话协调方案](background-agent-shell-conversation-coordination.md)：阶段 A–C 与 D0–D3 的已交付路径及受控验收见方案和 owner 文档；真实 Provider、进程恢复及客户端的剩余资格按方案中的准确范围继续核对。[独立 Session Agent Note](../../.agents/notes/implemented/feature/2026-09-26-independent-agent-sessions-and-result-bridge.md)记录取舍，[旧单 Session Agent Note](../../.agents/notes/implemented/feature/2026-09-26-codex-style-agent-mailbox-and-followup-authority.md)的适用范围已收窄。

## 已实施方案的剩余资格

[会话存储兼容性与连续性 V1](session-store-compatibility-and-continuity.md)：本次约定的唯一正式入口、已验证格式转换、历史来源归并与原会话保留已实施；Linux 产品入口与 Windows 原生迁移资格仍待单独核对，不能据 macOS 和容器测试推定通过。历史用户库恢复与未来版本兼容分别判断。

## 待核实问题

[Backlog](backlog.md)保存需求、实际差异和必要历史链接。重新确认目标后再制定方案；旧方案全文不作为当前实现步骤。

设计状态与完成后的归位方式见[文档生命周期](../development/documentation.md#当前事实与设计状态)；执行时机由根 AGENTS 定义。
