# ADR-0050：会话导航的取消语义由客户端适配层决定

状态：accepted
日期：2026-07-29
关联：ADR-0048、ADR-0049

## 背景

TUI 同一时刻只有一个前台交互面。用户离开正在运行或等待审批的会话时，终端界面无法继续
承载该会话的流式输出和交互，因此“切换会话”自然表达为停止当前 turn。

未来图形客户端可以同时展示运行状态、后台进度和多个待处理交互。对这类客户端而言，切换
当前可见会话只是导航动作；如果 Core 把 foreground 或路由变化统一解释为取消，就会错误
丢失后台执行、pending interrupt 和可恢复状态。

## 决策

1. Core Runtime 只响应显式取消 action 或调用方发出的 durable `cancelRun`。它不得观察
   foreground、可见路由、选中会话或其他展示状态来推断取消。
2. 当前 TUI 在新建或切换会话时，把导航动作映射为用户取消：`SessionManager` 先对离开
   会话的活动 turn 调用 `cancelRun`，持久化未终结工具的 `tool.cancelled` 和
   `turn.aborted(cause=user)`，随后传播 AbortSignal 并切换前后台状态。
3. TUI 的会话 reducer 仍保存会话级 `pendingToolCalls` 投影，event-log replay 也必须重建
   它。这样取消事件、迟到但有效的已持久事件和恢复加载都能使用原工具名称与参数完成一致
   投影，不依赖当前可见会话。
4. 未来支持后台运行的客户端在切换可见会话时，必须保留离开会话的 Runtime 实例、活动
   Effect、事件订阅和 pending interrupt。只有用户点击停止、拒绝授权或提交其他显式取消
   动作时，才进入 ADR-0048 的 turn 取消流程。
5. 客户端可以采用不同导航策略，但必须在 App 适配层显式声明并测试；不得把任一客户端的
   导航习惯提升为 Core 的通用状态转换。

## 后果

- TUI 维持符合终端心智模型的“离开即停止”，不会留下不可见的后台审批或命令。
- 图形客户端可以安全实现后台会话、状态徽标和跨会话返回，不因页面切换丢失执行状态。
- Core 的取消事实仍只有一条持久化来源，live/replay 和不同客户端不会因可见性状态分叉。
- 新客户端必须自行决定导航与取消的映射，并为其生命周期和恢复行为提供集成测试。

## 备选方案

- 所有客户端切换会话都取消：拒绝。它把终端交互限制错误提升为 Runtime 语义，阻断后台
  会话能力。
- 所有客户端切换会话都保留运行：拒绝。当前 TUI 无法可靠承载离屏审批与持续输出，容易
  形成用户不可见的执行。
- Core 根据 foreground 自动取消：拒绝。展示状态不属于 Runtime 事实，也无法表达不同
  客户端的交互能力。

## 验证

- SessionManager 测试验证 TUI 切换活动会话时先调用 durable abort。
- Runtime 测试验证 completed/aborted turn 恢复后保持终态，只有 `turn.started` 才重新
  开放调度。
- TUI reducer 与 replay 测试验证 `pendingToolCalls` 按会话保存并能在后续 started/terminal
  事件到达时物化一致的工具块。
