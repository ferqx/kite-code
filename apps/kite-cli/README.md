# 保留的旧 CLI/TUI 源码

2026-10-26 用户确认：新架构模块全部保留，旧架构只保留本目录，其余旧模块删除。本目录不在根八 workspace 中；其 Runtime/Service/contract 依赖已经删除，因此不再提供可运行的历史 library、build 或启动闭包。

当前终端 owner 为 [apps/cli](../cli/README.md)，正式命令为根 `agent`／`tui`，开发命令为 `cli:dev`／`tui:dev`，准确参数与 Profile 见[本地开发](../../docs/development/local-development.md)。本目录保留实现供阅读与对照，不得把源码存在或旧测试当作当前产品资格。

下文专题描述删除前的旧实现及设计理由。原运行库、导入胶水和历史测试均可从[删除前 revision](https://github.com/ferqx/kite-code/tree/d5407cfe4319c5a84d530f63b1d0a0123218ad34/apps/kite-cli)追溯；不恢复旧 writer、自动迁移或 fallback。完整取舍归[旧模块删除决定](../../.agents/notes/implemented/architecture/2026-10-26-remove-legacy-modules-retain-kite-cli.md)。

## 历史定位

终端 presentation owner，提供 TUI、headless CLI、客户端偏好和 Native client adapter。

产品行为见[TUI 手册](../../docs/handbook/clients/tui/README.md)，不从另一客户端推导交互。

## 历史职责与边界

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

本目录测试与专题只保留删除前断言及设计材料；运行依赖已移除，不能再使用 `bun test apps/kite-cli/test` 声称当前验证通过。当前终端验证由 `apps/cli`、`packages/ui` 与统一 TUI 系统测试负责。

用户行为更新对应手册；局部技术变化更新本地专题；跨包变化同时核对[App Server](../../docs/active/app-server-local-runtime.md)与[API 契约](../../docs/active/agent-api-contract.md)。行为不变时记录核对依据，不制造文档修改。
