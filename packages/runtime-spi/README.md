# Runtime SPI

## 定位

`@kite-ai/runtime-spi` 是 Runtime module 的私有编译期 port，不是公共 Plugin ABI 或同进程安全沙箱。

## 拥有职责

- 定义 capability、execution、model context、normalizer、adapter 与 module lifecycle port。
- 提供同步注册、重复检测和冻结的 `RuntimeModuleRegistry` snapshot。
- 定义 filesystem、sandbox、MCP、Subagent、Verification 与 Tool Pipeline 的中立接口。

## 不拥有职责

- 不包含 Builtin schema、Kernel State、Host Session、Store 或 App composition。
- 不允许 hot swap、全局 hook bus 或任意 state mutation。

## 允许依赖

只允许依赖 `@kite-ai/runtime-contract`。

## 公开入口

导出根入口和 `@kite-ai/runtime-spi/model`；不允许未声明 deep import。

## 关键不变量

- 注册同步完成并冻结；Host 负责有界启动和逆序释放。
- 所有 consumer 使用同一个 frozen snapshot，不创建第二 registry。
- schema/protocol 数字只是 metadata。

## 测试

`bun test packages/runtime-spi/test`

## 文档影响

模块局部变化更新本 README；跨包能力或执行语义同时更新 [Runtime 架构](../../docs/active/six-concept-runtime-architecture.md)。
