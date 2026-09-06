# kite-cli

## 定位

终端 presentation owner，提供 TUI、headless CLI、客户端偏好和 Native client adapter。

产品行为见[TUI 手册](../../docs/handbook/clients/tui/README.md)，不从另一客户端推导交互。

## 职责与边界

TUI/CLI 只消费 Native typed client 与 App Control，不组合 Host、Store、Kernel 或 Builtin。默认 parent-owned stdio App Server；显式 daemon 使用 --server。会话持久身份不由窗口或连接拥有。语言、主题等客户端偏好独立于服务配置。

## 修改入口

- [src/tui/index.tsx](src/tui/index.tsx)
- [src/tui/App.tsx](src/tui/App.tsx)
- [src/cli/index.ts](src/cli/index.ts)
- [src/service-mode/adapter.ts](src/service-mode/adapter.ts)

## 实现专题

- [审批与交互投影](docs/approvals-and-interactions.md)
- [输入、队列与命令](docs/input-and-commands.md)
- [TUI 消息投影与终态](docs/message-projection.md)
- [Runtime Application client boundary](docs/runtime-application.md)
- [Runtime carrier client boundary](docs/runtime-server-carrier.md)
- [Managed local Runtime mode](docs/service-mode.md)
- [TUI 会话导航与历史](docs/session-navigation.md)
- [TUI 流式正文、Thought 与工具](docs/streaming-presentation.md)
- [终端输出与 RenderEpoch](docs/terminal-output.md)
- [TUI 本地化规范](docs/tui-localization.md)
- [TUI 系统测试规范](docs/tui-system-testing.md)

## 验证与文档影响

`bun test apps/kite-cli/test`；影响终端展示时运行相关 PTY scenarios。CLI 参数与拒绝列表须同时核对，帮助文字不能替代实际执行路径。

用户行为更新对应手册；局部技术变化更新本地专题；跨包变化同时核对[App Server](../../docs/active/app-server-local-runtime.md)与[API 契约](../../docs/active/agent-api-contract.md)。行为不变时记录核对依据，不制造文档修改。
