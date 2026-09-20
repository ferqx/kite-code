# State、Event 与确定性转换

Kernel 负责从当前 State 和已确认 facts 决定下一状态，不执行 I/O。真实入口是 [kernel.ts](../src/kernel.ts) 的 decide，以及 [reducer.ts](../src/reducer.ts) 的 reduceAgentState；[state](../src/state.ts) 和 [events](../src/events.ts) 保存完整类型。

## 输入与结果

| 对象 | 生产者 | Kernel 的处理 |
| --- | --- | --- |
| KernelInput | Host 的命令/回执/fact 翻译 | 检查 Session、expectedRevision 与事件批次 |
| DecisionFacts | Host 构造的 JSON-safe facts | 使用注入的时间、identity、策略及 scheduler facts，不读取外界 |
| KernelEvent | 已封闭的业务事件 | 校验、规范化、按静态 reducer 转换 |
| KernelDecision | decide | applied、rejected、conflict 或 idempotent_replay |
| pendingEffects | scheduler | 供 Host 后续执行，不是在 reduce 时执行 |

`applied` 返回 events、envelopes、nextState 和 pendingEffects；`conflict` 指明当前 revision；拒绝和幂等重放都不能被调用者当成新的副作用执行许可。

已确认派发的 effect 返回时若 State revision 已被无关事实推进，Kernel 默认拒绝旧 lease。例外必须按 effect 类型显式证明：`task_read`、`task_wait`、`task_cancel` 仅在同一活动 Turn、原 `run_tools` lease 内的精确 Tool 仍为 running、Capability attempt 已确认且结果批次只包含该调用的 Capability／Tool 终态时，允许跨 background settlement revision 接纳。dispatch 前的 attempt、错误 Tool identity、已取消或已终态调用及其他事件仍拒绝；该规则只保存已经执行的结果，不授权重放工具。

## 转换过程

先验证当前写格式、输入 identity/revision 和 facts，再规范化事件并使用固定组合 reducer。Core 负责 intent、authorization、lease、lifecycle、completion；domain 负责 work、capability、context、interaction、recovery、verification。不同领域对同一事件的处理顺序由源码静态确定，不接受调用者注册第二 reducer。

Host 分配时间和 ID，Kernel 只校验与使用。重放同一已提交事件必须得到同一状态；不能在 reducer 中读取 clock、random、文件、Provider 或编译动态配置。

## 与持久化的交接

Kernel 返回的 nextState 尚不等于持久提交。Host/Storage 将事件、快照和相应运行事实在指定事务边界落盘，再执行 pending effect。页面不能跳过这一步直接从模型结果修改 Kernel 状态。

正常执行、历史读取和当前 writer 的格式边界不同；旧 State 解码不允许恢复旧执行路径，见[恢复与完成](completion-recovery.md)。

验证：[Kernel](../test/agent-kernel.test.ts)、[core reducers](../test/core-reducers.test.ts)、[codec](../test/codec.test.ts)。产品结果含义见[执行](../../../docs/handbook/features/execution.md)。
