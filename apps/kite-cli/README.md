# 重构前 CLI/TUI 与历史导入

当前终端owner为 [apps/cli](../cli/README.md)，正式命令为根 `agent`／`tui`，开发为 `cli:dev`／`tui:dev`；准确参数与Profile归[开发入口](../../docs/development/local-development.md)。本workspace保留旧实现及历史验证，下文旧App Server／Native client说明仅指重构前版本，不是现行产品合同。

旧package `build` 与 `src/index.ts`／CLI／TUI executable的普通直接执行已退役：加载旧依赖前输出 `legacy_terminal_entrypoint_retired`／2和当前命令。历史library导入仍转出原runCli／runTui对象，根和subpath相等、runCli异步／runTui同步；原方法在同目录[CLI implementation](src/cli/legacy-executable.ts)与[TUI implementation](src/tui/legacy-executable.tsx)。实现和原测试API保留不表示当前旧构建或旧Profile写入许可，也不闭合整个旧树／RSS／观测／平台／阶段。

实际普通调用／数据保全及source、bundle的导入胶水范围见[完整测试](../../tests/isolated/unified-agent/retired-application-entrypoints.test.ts)。原历史方法另有字节比对；port控制不冒称完整旧运行库或OS资格。以下专题保留其历史理由，当前行为以新owner与手册为准。

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
