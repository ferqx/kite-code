# ADR-0019：MCP 配置收敛为用户与项目两个位置

状态：accepted
日期：2026-07-18
替代：ADR-0011 的三层可写作用域与路径决定

## 决策

默认 MCP 配置只写入两个规范位置：

- 用户级：`~/.kite-code/mcp.json`
- 项目级：`<workspace>/.kite-code/mcp.json`

同名 Server 的优先级固定为 `project > user`。项目级声明连接前仍需绑定 workspace、source、名称和配置摘要的本地批准；用户级声明不需要项目批准。

旧的 workspace hash 文件、`.mcp.json`、项目或用户 `kite-code.jsonc#mcpServers` 只读加载，优先级低于两个规范来源，并只能通过显式迁移进入新位置。所有 mutation 只允许写规范来源。显式授权的 `configPath` 保持独立。

## 理由

四级来源让 Current project 实际落入用户目录的 hash 路径，路径不可理解，覆盖关系也难以解释。两个真实路径与 Current project / All projects 一一对应，便于版本控制、审查、TUI 展示和排错。

## 后果

- TUI Current project 写项目规范文件，All projects 写用户规范文件。
- 新建项目文件默认 `0644`，用户文件默认 `0600`。
- 旧配置不会被静默复制、合并或删除。
- 项目配置变化继续使旧批准失效并 fail closed。
