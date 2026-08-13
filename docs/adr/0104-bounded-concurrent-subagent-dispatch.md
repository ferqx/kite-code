# ADR-0104：有界并发 Subagent 派发

状态：accepted

日期：2026-08-13

决策者：github:@ferqx

相关：ADR-0049、ADR-0102、ADR-0103

取代：ADR-0049 中将 `task` 固定为并行批次屏障的部分，以及当前文档中的 Subagent 全局串行规则

## 背景

模型一次响应可以声明多个彼此独立的 `task` 调用，Resource Runtime 也已经定义
`maxConcurrentSubagents`、writer ceiling 和每个 child 独立的累计预算 reservation。但 Scheduler
仍把 `task` 固定为独占屏障，Prompt 还要求模型逐个派发。这使多个独立调查、审查或不相交实现任务
必须顺序等待，已有并发预算只限制理论上的活动数量，不能产生实际并发收益。

Runtime 只有一个当前审批交互。若直接并发而不治理暂停，两个 child 同时请求审批会让后一个覆盖
前一个，造成已持久化 continuation 无法继续。因此并发调度和审批排队必须作为同一决策实现。

## 决策

1. 模型应把同一轮中有价值、相互独立的 delegated tasks 作为多个 sibling `task` call 一起发出。
   依赖前序结果的任务必须串行；并发 `code` child 必须具有不相交的写入范围。
2. Scheduler 只把连续、属于同一 active task 与同一 model message、尚未暂停且经当前 Policy
   判断为 allowed/无需审批的 `task` 调用组成批次。单批硬上限为 4；共享
   `maxConcurrentSubagents`、`maxConcurrentWriters` 与累计预算可以进一步缩小实际派发集合。
3. Executor 为批内每个 child 并发进入同一 Tool Controller/SubAgentRunner 链。每个调用保持独立
   ID、事件、continuation、resource reservation 和 terminal outcome；Kernel 仍串行归纳事件，模型
   上下文仍按 assistant 声明顺序投影 Tool Result。
4. Parent task 需要预审批、已暂停恢复、跨 model message/task 边界或遇到非 task barrier 时不组批。
   Runtime 不解析 task 文本来证明依赖或写范围；Prompt/Tool contract 负责要求模型只并发真正独立的
   工作，现有 Policy、sandbox、project-instruction guard 与 writer budget 继续兜底实际副作用。
5. 多个并发 child 同时暂停时，只呈现第一个审批交互。其他 continuation 仍先持久化，再通过
   `subagent.approval_deferred` 回到队列；当前 child 的审批与恢复收敛后，Controller 从原 snapshot
   重新呈现下一个审批，不重启 child 模型，也不丢弃已完成步骤。snapshot 必须保留原始人工或
   auto-review 路由，历史缺失值按人工审批处理；重新呈现本身不计作新的 Sub-agent reservation，
   真正获批恢复时才创建新的 parent attempt。
6. 取消信号、deadline、Recovery Journal、CompletionGuard 和 Verification 继续覆盖整个父 Runtime。
   并发不授予额外权限、预算、嵌套深度或外部效果重放权。

## 备选方案

- 保持全部 Subagent 串行：拒绝。它让 child 隔离只增加延迟，无法利用已有并发预算。
- 不设上限地并发全部 `task`：拒绝。Provider、writer、审批与累计预算会失去有界治理。
- 只并发只读 role：拒绝作为硬编码规则。是否可执行应由当前 ToolSpec effects、phase、authorization
  与 Policy 决定；在 full mode 中不相交的 code sibling 也可以合法并发。
- 同时展示多个审批：拒绝。当前 Runtime/TUI 只有一个 canonical interaction slot，改成多审批 UI
  会扩大持久化、恢复与取消协议；本决策采用 durable FIFO 式逐个呈现。

## 后果

- 独立调查与审查可以在一次模型响应后真实并发执行，单批最多 4 个，生产预算通常会进一步限流。
- 并发 code child 可能产生逻辑冲突，因此模型契约明确要求不相交写范围；Runtime writer ceiling 和
  既有文件/项目指令保护仍是强制边界。
- child 动态触发审批时可能从并发阶段转为顺序交互，但 continuation 已保存，已完成工作不会重跑。
- Runtime scheduling policy digest 随新增的 `parallelSubagent` 条款变化。

## 回滚

删除 Scheduler 的 task batch 分支并恢复 Prompt/Tool contract 的逐个派发规则；保留
`subagent.approval_deferred` 的 replay/reducer 兼容，直到所有含该事件的会话都超过支持窗口。
