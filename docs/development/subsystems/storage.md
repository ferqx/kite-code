# 持久化与恢复

先区分查询、业务事务、writer authority 和外部 effect。恢复依赖真实持久证据，不能靠重跑命令猜测结果。

## 深入顺序与协作

| 专题 | 负责说明 |
| --- | --- |
| [事务与数据](../../../packages/runtime-storage-sqlite/docs/transactions-and-state.md) | 事件、快照、Run、receipt |
| [Authority 与恢复](../../../packages/runtime-storage-sqlite/docs/authority-and-recovery.md) | generation、lease、unknown |
| [查询与 Artifact](../../../packages/runtime-storage-sqlite/docs/queries-and-artifacts.md) | 只读投影和私有数据 |
| [取消链路](../flows/cancellation-recovery.md) | 客户端到进程清理 |

从对应专题读取实际代码与测试。只有发生跨模块影响时扩读其他主题；准确约束见[契约目录](contracts.md)，不要在本页复制接口和不变量。
