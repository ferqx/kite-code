# ADR-0009：项目 MCP transport 必须获得绑定配置摘要的本地批准

状态：accepted
日期：2026-07-15

## 背景

Kite Code 会从用户配置和 workspace 控制的文件加载 MCP Server 声明。项目声明可以在 TUI 启动期间创建本地进程或访问远程 endpoint，而此时用户尚未审阅该确切配置。Annotation trust 是独立的 Runtime Policy，不能表达执行项目配置的许可。

## 决策

workspace 中来自 `.kite-code/kite-code.jsonc` 或 `.mcp.json` 的每个有效 MCP Server，都必须获得绑定 canonical workspace、source、Server 名称和 canonical raw-config SHA-256 digest 的本地用户决定。Pending、rejected、invalid 或 Approval Store 不可读的条目在 transport 创建前被移除；高优先级项目条目被阻止时，不回退到同名用户条目。

批准记录位于用户 Kite Code 目录，以仅用户可读写权限原子写入。Source 变化产生新 digest 并使旧决定失效。批准只允许创建 transport：项目配置不能授予 annotation trust、降低 Tool effect 或 minimum approval，也不能放宽 retry policy。批准状态属于 MCP control plane，不写入任务 Runtime Event。

该安全门禁不受 feature flag 控制。显式 config path 保持测试和非默认集成的调用方授权输入语义；生产 TUI 使用 source-aware 默认发现。

## 影响

新发现的项目 MCP Server 不再自动连接。TUI 必须提供脱敏审批投影和显式 approve/reject 操作。Approval Store 损坏或不可用时，项目来源 fail closed，用户来源保持现有行为。

配置目录除 normalized connection config 外，必须保留 provenance、shadowing、diagnostic 和 raw canonical input。测试必须证明被阻止条目从未创建 stdio 或 HTTP transport。

## 回滚

UI 与 catalog 实现可以替换，但回滚必须保留与本决策等价的 transport 前置条件。恢复项目 MCP 声明的自动执行不是允许的回滚方式。
