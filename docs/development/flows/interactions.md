# 审批、问题与计划交互

原 Execution 创建待人交互，Service/Client 交付有限事实，UI 只提交原 Interaction 的答案。权限模式、普通问答、计划审阅及 MCP 认证分别沿各 owner 的受控操作处理。

实现与局部验证：[权限](../../../packages/agent/src/permissions/README.md)、[普通问题](../../../packages/agent/src/tools/ask-user/README.md)、[计划](../../../packages/agent/src/business/planning/README.md)、[TUI](../../../packages/ui/src/tui/README.md)、[Desktop](../../../apps/desktop/README.md)。

答案必须绑定原 Store/Session/Run/Interaction 和实际 revision，迟到答复不能继续后来工作。模式改变须经原持久控制与最终派发复核，界面移除卡片不表示批准。写入未知只查原申请；取消、unknown 和必要条件不能被交互显示覆盖。

共同约束以[当前八 workspace 边界](../../active/unified-agent-boundary.md)及对应 owner 为准。定向测试、真实客户端过程和平台资格分别说明，不从源码存在或最终截图推定完整行为通过。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/flows/interactions.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
