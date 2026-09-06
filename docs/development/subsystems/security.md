# 授权、沙箱与用户交互

权限模式、精确授权、工作区信任、平台可用能力分别限制执行。UI 只能提交用户意图，不能凭显示状态创造授权。

## 深入顺序与协作

| 专题 | 负责说明 |
| --- | --- |
| [交互链路](../flows/interactions.md) | queue、决定、commit、继续 |
| [Kernel 授权](../../../packages/agent-kernel/docs/scheduling-authorization.md) | 策略和调度 |
| [TUI 交互](../../../apps/kite-cli/docs/approvals-and-interactions.md) | 焦点、提交失败、迟到决定 |
| [沙箱机制](../../../packages/builtin-runtime/docs/filesystem-shell.md) | 实际执行能力 |

从对应专题读取实际代码与测试。只有发生跨模块影响时扩读其他主题；准确约束见[契约目录](contracts.md)，不要在本页复制接口和不变量。
