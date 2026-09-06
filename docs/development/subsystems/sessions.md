# 会话与执行协调

会话是持久业务对象，连接、客户端导航与后台执行分别有 owner。先确定问题是提交、历史读取、执行归属还是展示，再进入模块。

## 深入顺序与协作

| 专题 | 负责说明 |
| --- | --- |
| [任务提交与终态](../flows/task-execution.md) | 从 command 到 commit 和 execution |
| [会话加载与展示](../flows/session-history.md) | 从 navigation 到 history 与 projector |
| [Host 命令](../../../packages/runtime-host/docs/commands-mailbox.md) | 幂等、mailbox、回执 |
| [Service 组合](../../../apps/kite-service/docs/composition-and-execution.md) | 注入依赖与应用控制 |

从对应专题读取实际代码与测试。只有发生跨模块影响时扩读其他主题；准确约束见[契约目录](contracts.md)，不要在本页复制接口和不变量。
