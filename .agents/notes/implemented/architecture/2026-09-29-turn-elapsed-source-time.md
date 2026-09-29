# Agent Note: Turn 耗时使用持久事件时间

Status: implemented

## Problem

Desktop 的轮次状态需要在执行中和结束后展示耗时。同一个 Run 可跨多个 Turn，客户端接收通知与读取历史的时刻也会受断线、重放和调度影响；这些时间不能代表单个 Turn 的实际起止。

## Decision

将 `turn.started` 纳入封闭的 client-safe 事件集，并沿持久 State 事件的 `occurredAt` 把源时间送到实时 durable notification 与 History record。Desktop 只用同一精确 `turnId` 的 `turn.started` 和 `turn.terminal` 源时间计算耗时。活动 Turn 有起点时以当前时间更新已用时间；完成态仅在两个端点都可信且顺序有效时固定显示。旧历史缺失时间时保持无耗时展示。

## Alternatives considered

- 使用 Run 起止时间：一个 Run 可以包含多个 Turn，结果会把等待、续轮或后续执行计入错误轮次。
- 使用客户端首次接收与重放时间：断线重连和历史读取会改变这些时刻，实时视图与恢复视图无法一致。
- 为旧历史补推断时间：缺失精确起止事实，推断值看似准确却无法核验。

## Consequences

Runtime Contract、Service、Protocol 与 Client 共同传递可选的规范化时间字段；这些字段只用于展示，不改变执行或结算权威。新写入的持久事件可显示准确轮次耗时，旧记录及缺失端点保持兼容。对应行为由 Runtime 实时／历史边界测试、Desktop 投影测试与共享会话测试验证；[产品行为](../../../../docs/handbook/clients/desktop/README.md)和[Desktop owner 文档](../../../../apps/kite-desktop/docs/conversation-ui.md)记录当前展示规则。
