# 依赖方向与职责边界

包边界用来防止职责渗透，不要求读者先记住所有包名。以下清点基于根目录 [workspace 配置](../../../package.json)的 `apps/*`、`packages/*`，覆盖当前 4 个 app、14 个 package。manifest 中的 workspace 依赖是静态依赖；表中的调用/消费例链接到实际源码引用，只证明该处关系，不等于运行时所有路径均已执行。准确的完整 exports 和依赖仍以各 workspace manifest 为准。

| 职责 | 模块 | 禁止越界 |
| --- | --- | --- |
| 纯业务决策 | agent-kernel | 无 workspace、I/O 或 TUI 依赖 |
| 通用执行协调 | runtime-host | 不解释具体 Tool/Prompt，不持有 SQLite driver |
| 具体能力语义 | builtin-runtime | 不直接依赖 Host/Kernel/App 实现 |
| 注入接口 | runtime-spi | 不引入 Provider concrete handle 到 Kernel facts |
| 持久适配 | runtime-storage-sqlite | 不替 Kernel 决定业务恢复或自动重放 |
| 中立 Runtime 结构 | runtime-contract | 不执行命令、不持有 UI 或 Store |
| 严格 wire | runtime-protocol | 不创建 transport、不提供业务 authority |
| Runtime 访问 | runtime-client / runtime-server | 通过注入边界协作，不互相依赖 concrete implementation |
| Native 与控制 | kite-local-runtime / kite-app-contract | 不为 TUI 暴露 raw Repository/Store |
| Browser API | agent-api-contract / agent-api-client | browser-safe，客户端不能引入 Native/Service |
| 组装 | kite-service | 负责具体依赖与公开入口的组合 |
| 展示 | kite-cli / kite-web / kite-desktop | 不组合第二个 Kernel/Host/Store；desktop renderer 只通过环境无关协议组合与受限 IPC 接入原生宿主 |

## 从功能找模块，从模块反查功能

每行的 manifest 可核对静态依赖与导出；源码链接给出代表性的实际消费点。没有 package export 的 Web/Desktop 由 app 入口装配，不能据此推断它们被其他 workspace 作为库调用。功能承诺与客户端范围以链接的手册为准，workspace README 负责机制和局部验证。

| 模块与职责 | 关联功能 / 客户端 | 导出或入口、调用/消费例与 owner |
| --- | --- | --- |
| `kite-cli`：TUI 与 headless CLI 展示、命令入口 | [TUI](../../handbook/clients/tui/README.md)、[CLI](../../handbook/cli/README.md) | [manifest](../../../apps/kite-cli/package.json) 导出 `.`, `./cli`, `./tui`；[TUI executable](../../../apps/kite-cli/src/tui/executable.tsx)、[Runtime Client 消费](../../../apps/kite-cli/src/service-mode/tui-client.ts)；[owner](../../../apps/kite-cli/README.md) |
| `kite-web`：浏览器只读视图与 REST 接入 | [Web](../../handbook/clients/web/README.md) | [manifest](../../../apps/kite-web/package.json) 无库导出；[入口](../../../apps/kite-web/src/main.tsx)、[共享页面消费](../../../apps/kite-web/src/app/app.tsx)、[API client 消费](../../../apps/kite-web/src/transport/client.ts)；[owner](../../../apps/kite-web/README.md) |
| `kite-desktop`：Electron renderer 与本机宿主 | [Desktop（开发验证）](../../handbook/clients/desktop/README.md) | [manifest](../../../apps/kite-desktop/package.json) 无库导出；[renderer 入口](../../../apps/kite-desktop/src/main.tsx)、[共享页面消费](../../../apps/kite-desktop/src/App.tsx)、[Runtime Client 消费](../../../apps/kite-desktop/src/client.ts)；[owner](../../../apps/kite-desktop/README.md) |
| `kite-service`：App Server 与具体依赖组装 | [Server](../../handbook/server/README.md)、[执行](../../handbook/features/execution.md) | [manifest](../../../apps/kite-service/package.json) 导出 `.`；[执行入口](../../../apps/kite-service/src/executable.ts)、[依赖组装](../../../apps/kite-service/src/bootstrap.ts)；[owner](../../../apps/kite-service/README.md) |
| `agent-kernel`：确定性状态转移 | [执行](../../handbook/features/execution.md)、[恢复](../../handbook/features/recovery.md) | [manifest](../../../packages/agent-kernel/package.json) 导出 `.`；[Host reducer 消费](../../../packages/runtime-host/src/kernel-adapter/state-reducer.ts)；[owner](../../../packages/agent-kernel/README.md) |
| `runtime-contract`：进程内 command、query、event 与 presentation 数据 | [执行](../../handbook/features/execution.md)、[会话](../../handbook/features/sessions.md) | [manifest](../../../packages/runtime-contract/package.json) 导出 `.`；[Client 消费](../../../packages/runtime-client/src/client.ts)；[owner](../../../packages/runtime-contract/README.md) |
| `runtime-spi`：模型、工具等 Runtime module 注入端口 | [模型](../../handbook/features/models-and-configuration.md)、[工具](../../handbook/features/tools-and-approvals.md) | [manifest](../../../packages/runtime-spi/package.json) 导出 `.`、`./model`；[builtin module 消费](../../../packages/builtin-runtime/src/verification/runtime-module.ts)；[owner](../../../packages/runtime-spi/README.md) |
| `runtime-host`：Session 执行权威、生命周期、Kernel 适配 | [执行](../../handbook/features/execution.md)、[恢复](../../handbook/features/recovery.md) | [manifest](../../../packages/runtime-host/package.json) 导出根与 `observability`、`storage`、`kernel-adapter`；[Service 组装](../../../apps/kite-service/src/bootstrap.ts)；[owner](../../../packages/runtime-host/README.md) |
| `builtin-runtime`：模型、工具、MCP、Sandbox 等具体语义 | [模型](../../handbook/features/models-and-configuration.md)、[扩展](../../handbook/features/extensions.md)、[工具](../../handbook/features/tools-and-approvals.md) | [manifest](../../../packages/builtin-runtime/package.json) 导出根与能力子路径；[Service 组装](../../../apps/kite-service/src/bootstrap.ts)；[owner](../../../packages/builtin-runtime/README.md) |
| `runtime-storage-sqlite`：Host storage port 的 SQLite 适配 | [会话](../../handbook/features/sessions.md)、[恢复](../../handbook/features/recovery.md) | [manifest](../../../packages/runtime-storage-sqlite/package.json) 导出 `.`；[当前 App Server storage composition 消费](../../../apps/kite-service/src/bootstrap.ts)；[owner](../../../packages/runtime-storage-sqlite/README.md) |
| `runtime-protocol`：严格 JSON-RPC wire codec | [执行](../../handbook/features/execution.md)、[会话](../../handbook/features/sessions.md) | [manifest](../../../packages/runtime-protocol/package.json) 导出 `.`；[Server 消费](../../../packages/runtime-server/src/server.ts)；[owner](../../../packages/runtime-protocol/README.md) |
| `runtime-client`：TUI、CLI、Desktop 的 Runtime Client | [TUI](../../handbook/clients/tui/README.md)、[CLI](../../handbook/cli/README.md)、[Desktop](../../handbook/clients/desktop/README.md) | [manifest](../../../packages/runtime-client/package.json) 导出 `.`；[TUI 消费](../../../apps/kite-cli/src/service-mode/tui-client.ts)、[Desktop 消费](../../../apps/kite-desktop/src/client.ts)；[owner](../../../packages/runtime-client/README.md) |
| `runtime-server`：transport-neutral Runtime gateway | [Server](../../handbook/server/README.md) | [manifest](../../../packages/runtime-server/package.json) 导出 `.`；[stdio carrier 消费](../../../apps/kite-service/src/carrier/runtime-server-stdio.ts)；[owner](../../../packages/runtime-server/README.md) |
| `kite-app-contract`：本机 App Control DTO | [TUI](../../handbook/clients/tui/README.md)、[Desktop](../../handbook/clients/desktop/README.md) | [manifest](../../../packages/kite-app-contract/package.json) 导出根与 `worker-controller`；[CLI 消费](../../../apps/kite-cli/src/service-mode/adapter.ts)、[Desktop 消费](../../../apps/kite-desktop/src/client.ts)；[owner](../../../packages/kite-app-contract/README.md) |
| `kite-local-runtime`：本机 transport、配置与协调 | [Server](../../handbook/server/README.md)、[会话](../../handbook/features/sessions.md) | [manifest](../../../packages/kite-local-runtime/package.json) 仅导出 `client`、`config`、`coordinator`、`service` 等子路径；[Service 消费](../../../apps/kite-service/src/bootstrap.ts)、[CLI 消费](../../../apps/kite-cli/src/service-mode/adapter.ts)；[owner](../../../packages/kite-local-runtime/README.md) |
| `agent-api-contract`：浏览器安全的 Public REST wire | [Web](../../handbook/clients/web/README.md) | [manifest](../../../packages/agent-api-contract/package.json) 导出 `.`；[Service route 消费](../../../apps/kite-service/src/agent-api/read-adapter.ts)、[Web 消费](../../../apps/kite-web/src/transport/client.ts)；[owner](../../../packages/agent-api-contract/README.md) |
| `agent-api-client`：浏览器 typed HTTP request/response client | [Web](../../handbook/clients/web/README.md) | [manifest](../../../packages/agent-api-client/package.json) 导出 `.`；[Web transport 消费](../../../apps/kite-web/src/transport/client.ts)；[owner](../../../packages/agent-api-client/README.md) |
| `kite-client-ui`：Web/Desktop 共享 React 会话页面 | [Web](../../handbook/clients/web/README.md)、[Desktop](../../handbook/clients/desktop/README.md) | [manifest](../../../packages/kite-client-ui/package.json) 导出 `.` 与 `style.css`；[Web 消费](../../../apps/kite-web/src/app/app.tsx)、[Desktop 消费](../../../apps/kite-desktop/src/App.tsx)；[owner](../../../packages/kite-client-ui/README.md) |

静态依赖以“导入者 → 被导入者”表示：`kite-service` → `runtime-host` → `agent-kernel`；Service 同时组装 builtin、storage 与 server。Client 与 Server 都消费 protocol/contract，由 Service 的 carrier 和 client adapter 在运行时连接；这项进程交接见[运行拓扑](topology.md)和[任务链路](../flows/task-execution.md)，不能从 manifest 的箭头直接推断调用发生。Web 的 REST 关系见[Web 查询](../flows/web-queries.md)；共享 `kite-client-ui` 是静态组件消费，不持有执行 authority。

本表核对了所有 workspace 的 manifest 与上述代表性源码引用；没有逐一追踪每条导出、所有内部 import 和所有运行分支。运行时交接、状态和恢复的证据应继续从对应链路及 owner 文档深入，不能把本表当作全项目运行审计。

## 跨边界修改

新增输入或事件时，先确定 producer 和 consumer，再核对 schema/codec、projection、调用与测试。不能用宽泛继承、any、动态代理或复制内部类型绕过边界。

同一事实经不同投影进入 TUI/Web，展示差异不应扩大后台权限。需要新增机制时先检查现有 port 和事务 owner，避免平行 registry、queue 或 writer。

规范见[Runtime 跨包架构](../../active/six-concept-runtime-architecture.md)。验证入口：[runtime package gate](../../../scripts/check-runtime-packages.ts)、[API package gate](../../../scripts/check-agent-api-packages.ts)、[core boundary](../../../scripts/check-core-boundary.ts)。
