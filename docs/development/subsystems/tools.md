# 工具与扩展

工具声明、发现、绑定、授权、执行和验证不是同一阶段。新增能力应保持 parser、effect、policy facts、执行器与结果一致。

## 深入顺序与协作

| 专题 | 负责说明 |
| --- | --- |
| [工具流水线](../../../packages/builtin-runtime/docs/tool-pipeline.md) | 规范参数到结果 |
| [文件与 Shell](../../../packages/builtin-runtime/docs/filesystem-shell.md) | 目标、沙箱、副作用 |
| [扩展与验证](../../../packages/builtin-runtime/docs/extensions-and-verification.md) | MCP、Skill、Subagent、证据 |
| [SPI](../../../packages/runtime-spi/docs/modules-and-ports.md) | 注入 port 与 frozen registry |

从对应专题读取实际代码与测试。只有发生跨模块影响时扩读其他主题；准确约束见[契约目录](contracts.md)，不要在本页复制接口和不变量。
