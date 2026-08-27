# Builtin Runtime

## 定位

`@kite-ai/builtin-runtime` 是 Kite-specific capability、模型、工具、MCP、Sandbox、Subagent 与 Verification 语义 owner。

## 拥有职责

- 通过 `createBuiltinRuntimeModules()` 注册唯一 Builtin operation owner 与 executor。
- 从一个 frozen SPI snapshot 投影 parser、schema、description、availability、effects、traits 与 revision。
- 实现具体 filesystem、git、model、planning、sandbox、MCP、Skill、Subagent 和 Verification mechanism。

## 不拥有职责

- 不依赖 Kernel、Host、SQLite 或 App。
- 不持久化 Kernel State，不决定 authorization，不创建第二 dispatcher。
- 不把 `mcp:dynamic_tool` 或 `builtin:ask_user` 暴露为普通模型工具。

## 允许依赖

只允许 workspace 依赖 `@kite-ai/runtime-contract` 与 `@kite-ai/runtime-spi`；外部依赖只服务具体 Builtin mechanism。

## 公开入口

根入口只负责 module composition 和跨域 capability；filesystem、git、mcp、model、planning、sandbox、skills、subagent、verification 使用已声明 subpath。

## 关键不变量

- 当前 snapshot 固定包含 20 个 model-visible tools 和 8 个 internal operations。
- App/Host/catalog/executor 必须使用同一个 snapshot。
- 任何 terminal uncertainty 不转换为成功或 fallback。
- Skill activation 默认生成高熵 identity；Runtime command planner 可以注入经过有界字符集校验的、
  不含用户内容的确定性 `activationId`，使同一逻辑 command 的重试保持同一 activation identity。
  无效注入在 activation 建立前 fail closed，不能回退生成另一个 identity 后继续执行。
- linked worktree 的外部 Git metadata 不因 Workspace 内存在 `.git` gitfile 自动获得文件系统授权；只有标准
  `<primary>/.git/worktrees/<id>`、`commondir` 与 reciprocal `gitdir` backlink 完整一致时，Sandbox 才向
  Seatbelt/bubblewrap投影唯一common `.git`只读根。任意外部gitfile、symlink、broken backlink或alternates均不授权。

## 测试

`bun test packages/builtin-runtime/test`

## 文档影响

模块局部变化更新本 README；授权、Model、MCP 或 Tool Pipeline 跨包语义同时更新对应 `docs/active/` authority。
