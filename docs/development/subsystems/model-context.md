# 模型与上下文

模型输入由已提交状态、项目指导、工具声明和预算共同构造，不等于客户端屏幕。配置、调用、私有证据与展示有各自交接点。

## 深入顺序与协作

| 专题 | 负责说明 |
| --- | --- |
| [模型工具循环](../flows/model-tool-cycle.md) | 输入、调用、解析与后续工作 |
| [Builtin 模型](../../../packages/builtin-runtime/docs/model-and-context.md) | surface、attempt、压缩 |
| [Service 配置](../../../apps/kite-service/src/config/index.ts) | 当前配置解析与生效 |
| [模型契约](../../active/model-provider-boundary.md) | Provider 与调用边界 |

从对应专题读取实际代码与测试。只有发生跨模块影响时扩读其他主题；准确约束见[契约目录](contracts.md)，不要在本页复制接口和不变量。
