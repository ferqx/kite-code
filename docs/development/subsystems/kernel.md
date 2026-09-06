# Kernel 状态与调度

Kernel 对明确 facts 作纯决策，不执行 I/O。新行为必须落到正确 domain 与 reducer，并由现有 Host/Storage 边界执行和提交。

## 深入顺序与协作

| 专题 | 负责说明 |
| --- | --- |
| [状态转换](../../../packages/agent-kernel/docs/state-transitions.md) | State/Event、decide/reduce |
| [调度授权](../../../packages/agent-kernel/docs/scheduling-authorization.md) | traits、资源冲突与交互 |
| [完成恢复](../../../packages/agent-kernel/docs/completion-recovery.md) | 证据、unknown、重放 |

从对应专题读取实际代码与测试。只有发生跨模块影响时扩读其他主题；准确约束见[契约目录](contracts.md)，不要在本页复制接口和不变量。
