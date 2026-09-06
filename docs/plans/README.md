# 开发计划

这里只列已经确认并适配当前架构、可以继续实施的仓库研发工作；候选需求与旧方案不混入当前入口。这些 Markdown 计划的交付状态由本次变更与验证判断，不使用产品运行时的 Plan/Task 状态作为研发完成依据。

## 正在实施

[客户端启动、服务生命周期与发布升级规范](daemon-upgrade-lifecycle.md)：阶段 1、2 已完成本机实现与验证，阶段 3 的发布门禁已接入；Linux/Windows hosted 资格仍待验证。覆盖默认 TUI/CLI 配套服务、共享 daemon 与 Web；未来桌面端仅规定接入边界。

[桌面客户端首版](desktop-client.md)：阶段 0 已完成，Tauri/React、环境无关 Client、受限 IPC、Rust stdio 服务和 macOS `.app` 已通过本机原生验收，包括关窗、退出、历史恢复和工具进程树崩溃清理。后续完成日常开发闭环和发布验证。

## 待核实问题

[Backlog](backlog.md)保存需求、实际差异和必要历史链接。重新确认目标后再制定方案；旧方案全文不作为当前实现步骤。

设计状态与完成后的归位方式见[文档生命周期](../development/documentation.md#当前事实与设计状态)；执行时机由根 AGENTS 定义。
