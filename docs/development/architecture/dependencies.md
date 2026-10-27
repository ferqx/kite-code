# 依赖方向与职责边界

根 [package.json](../../../package.json)精确声明八个 workspace。`apps/kite-cli` 只保留无运行依赖闭包的历史源码，其余旧模块已经删除；不得从旧目录名恢复执行路径。

| 模块 | 当前职责 | 负责说明 |
| --- | --- | --- |
| `packages/ai` | 中立模型消息与流、显式 SDK adapter | [AI](../../../packages/ai/README.md) |
| `packages/agent` | 唯一 Loop、Run/Execution/Job、权限、业务扩展与 Store/I/O leaves | [Agent](../../../packages/agent/README.md) |
| `packages/client` | 公开 HTTP/SSE、生成协议、原身份及未知回执读取 | [Client](../../../packages/client/README.md) |
| `packages/ui` | 便携展示、公共表单、TUI 与 Desktop 组件 | [UI](../../../packages/ui/README.md) |
| `apps/service` | 可信装配、HTTP/SSE、paired/daemon 与只读 Gateway | [Service](../../../apps/service/README.md) |
| `apps/cli` | 薄 CLI/TUI 调用者、持久原意图与显式开发宿主 | [CLI/TUI](../../../apps/cli/README.md) |
| `apps/desktop` | 可移植调用者、Electron main/preload/renderer | [Desktop](../../../apps/desktop/README.md) |
| `apps/web` | 浏览器只读页面、敏感内容二次确认 | [Web](../../../apps/web/README.md) |

AI 不依赖 Agent 或客户端。Agent 通过明确的中立模型与受控执行契约工作；Service 注入模型、工具、权限、平台和配置。Client 通过生成的公开协议访问 Service；UI 只消费有限展示事实，不解释授权或拥有 Store。CLI/Desktop 的可信宿主可以组合配套进程与资产，业务操作继续经公共 Client，renderer 与浏览器不直接导入 I/O owner。

新增跨包字段先确定 producer、schema/生成物与 consumer，再核对实际调用、身份、取消和未知结果。判别联合应按 `kind` 等字段收窄，不使用 `any`、动态代理或复制内部类型绕过边界。工具定义或协议版本升级仍须取得用户对具体升级的明确确认。

[源代码边界](../../../scripts/check-unified-agent-boundary.ts)与[workspace 守卫](../../../scripts/check-unified-workspaces.ts)核静态边界和正式闭包；它们不能代替真实运行、客户端全过程或平台发布资格。当前共同约束归[八 workspace 边界](../../active/unified-agent-boundary.md)。

旧 Host/Kernel/SPI 实现的[历史说明](https://github.com/ferqx/kite-code/blob/d5407cfe4319c5a84d530f63b1d0a0123218ad34/docs/development/architecture/dependencies.md)只供删除前设计与证据追溯，不能恢复为当前 owner 或运行入口。
