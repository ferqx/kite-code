# Runtime Contract

## 定位

`@kite-ai/runtime-contract` 是 Kite Runtime 的私有、进程内客户端边界。它只暴露 JSON-safe 的 command、query、subscription、notification 与 presentation 数据。

## 拥有职责

- 定义 Session command、query、receipt、notification 和 projection。
- 固定 command identity、expected revision、幂等回放与冲突语义。
- 为未来 transport adapter 提供中立数据边界。

## 不拥有职责

- 不包含 Kernel State、Host lifecycle、Provider handle、SQLite 类型或 TUI block。
- 不执行命令、不持久化、不分配 identity。
- 当前不是公共 SDK 或网络协议兼容承诺。

## 允许依赖

本 package 没有 workspace 或运行时依赖。

## 公开入口

只导出 package 根入口 `@kite-ai/runtime-contract`；`src/index.ts` 仅组合分域 contract。

## 关键不变量

- 所有客户端数据保持普通 JSON-safe 数据。
- command 必须携带唯一 `commandId`；Session mutation 使用 revision fencing。
- Contract 不泄漏具体执行、存储或展示 authority。

## 测试

`bun test packages/runtime-contract/test`

## 文档影响

模块局部变化更新本 README；跨包 Session 或客户端语义同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
