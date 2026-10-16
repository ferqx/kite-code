# Agent Note: Task 等待 child Run 后的附着效果结算

Status: implemented

## Problem

用户要求多个主／子Agent并发执行真实Shell，并在饱和、切换与中断时保持准确完成和资源收束。实际默认4个Model／process槽的混合测试中，child Model可以先于它已经创建的Shell结束；Shell此时仍排队或运行。原Task observer只等child Run返回便提交成功，Store正确抛出 `child_execution_unsettled`，但后台Job Promise拒绝后没有新的结算观察，carrier永久running、父required等待不结束。提高到16个槽的一轮通过不能替代默认饱和路径。

## Decision

保留最终Store成功门禁。Task observer在原child Run结束后，用 `inspectChildSettlement` 读取准确Store／root owner／carrier下的原child活动Run、Model／Tool和attached Job，连同同一短事务的cursor返回。Runtime使用现有ChangeWaits等待并重新核实，排队Job不被遗漏，detached保持独立；不持SQLite事务、不重发Model、不重新启动Shell。unknown仍由原最终附着域转换处理。

等待中准确carrier的持久取消事实使结果为cancelled，保留已经completed的child Run原事实；只发生本地中断而没有持久取消时返回unknown，不能以signal编造停止。末端 `finishExecution` 仍核准确原效果域和unknown，不用观察快照替代事务安全边界。

## Alternatives considered

1. child Run结束即成功或吞掉 `child_execution_unsettled`：会提前交付仍有附着效果的任务，或保留原永久running，未采用。
2. 在通用UnifiedExecution提交terminal后专门重试并新增异步取消状态机：能复用同一错误，但扩大所有Job的终态路径，未采用；等待属于准确Task原效果域，放在其observer更窄。
3. 等待所有Job或扫描完整历史：会错误阻塞独立detached执行且增加无关读取，未采用。只读快照与原成功门禁使用同一Session和附着条件。
4. 增大默认process配额或测试超时：不能消除Model先结束的合法调度，且会掩盖默认饱和缺口，未采用。

## Consequences

附着长任务存续时，原Task和其child容量保留到准确结算，这是原成功合同的实现。等待不占Model槽，没有额外执行流或公开HTTP能力；同事务cursor避免在读取与注册等待之间漏掉最后一次完成事件。有限查询和等待仍须受原owner、取消和关闭约束。

[定向回归](../../../../packages/agent/test/isolated/business/task/attached-job-settlement.test.ts)在旧代码稳定复现attached超时，新代码覆盖自然收束、detached、精确取消、旧cursor变化与close drain。当前完整合同由[Task owner](../../../../packages/agent/src/extensions/task/README.md)及[child Store owner](../../../../packages/agent/src/storage/sqlite/child/README.md)维护，真实默认4／可信16的Model＋Shell压力证据归[Service owner](../../../../apps/service/README.md#多主子会话流与读取压力)。
